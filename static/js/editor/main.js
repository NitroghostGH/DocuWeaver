/**
 * DocuWeaver Canvas Editor - Main Entry Point
 * 
 * Orchestrates initialization of all editor modules.
 * This file should be loaded last after all other modules.
 * 
 * Depends on: All other modules
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Data Loading ====================
    
    async function loadProjectData() {
        try {
            const [sheetsResp, assetsResp, linksResp] = await Promise.all([
                fetch(`/api/projects/${PROJECT_ID}/sheets/`),
                fetch(`/api/projects/${PROJECT_ID}/assets/`),
                fetch(`/api/projects/${PROJECT_ID}/links/`)
            ]);

            // Lists sort the way people number things (V2 before V10).
            // Sheets keep Z-index order first: it is also the stacking order.
            const byName = DW.naturalCompare;
            if (sheetsResp.ok) {
                state.sheets = (await sheetsResp.json()).sort((a, b) =>
                    ((Number(a.z_index) || 0) - (Number(b.z_index) || 0)) || byName(a.name, b.name));
                window.sheets = state.sheets;
            }
            if (assetsResp.ok) {
                state.assets = (await assetsResp.json()).sort((a, b) => byName(a.asset_id, b.asset_id));
                window.assets = state.assets;
            }
            if (linksResp.ok) {
                state.links = (await linksResp.json()).sort((a, b) => byName(a.link_id, b.link_id));
                window.links = state.links;
            }
            if (typeof updateCoordinateLabels === 'function') updateCoordinateLabels();

            // Render data on canvas
            renderSheetsOnCanvas();
            renderAssetsOnCanvas();
            renderLinksOnCanvas();
            
            // Render sidebar lists
            renderSheetLayers();
            renderAssetList();
            if (typeof renderLinkList === 'function') {
                renderLinkList();
            }
            
            // Render layer groups UI (folders)
            if (typeof renderLayerGroupsUI === 'function') {
                renderLayerGroupsUI();
            }

            // Import batch panels (asset and link CSV imports)
            if (typeof renderImportBatches === 'function') {
                renderImportBatches();
            }
            if (typeof renderLinkImportBatches === 'function') {
                renderLinkImportBatches();
            }
            
            // Saved measurements (MeasurementTool holds the list)
            if (typeof MeasurementTool !== 'undefined') {
                MeasurementTool.renderSaved();
            }

            // Apply rendering hierarchy to order layer types correctly on canvas
            applyRenderingHierarchy();
            if (typeof applyVisibility === 'function') applyVisibility();
            
            // Load OSM if enabled
            if (state.osmEnabled && state.refAssetId) {
                renderOSMLayer();
            }

        } catch (error) {
            console.error('Error loading project data:', error);
            DW.showToast('Could not load the project: ' + error.message, 'error');
        }
    }
    
    // Note: loadLayerGroups is defined in layers.js and exported to window.loadLayerGroups
    // It loads groups by type (asset, link, sheet, measurement) and calls renderLayerGroupsUI
    
    // ==================== Theme ====================

    const CANVAS_BACKGROUND = { light: '#e0e0e0', dark: '#2a2a2a' };

    function isDarkTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark';
    }

    function applyCanvasTheme() {
        if (!state.canvas) return;
        state.canvas.backgroundColor = isDarkTheme() ? CANVAS_BACKGROUND.dark : CANVAS_BACKGROUND.light;
        state.canvas.requestRenderAll();
    }

    // ==================== Filter Utilities ====================

    function applyFiltersPreservingSize(img) {
        img.applyFilters();
        img._filterScalingX = 1;
        img._filterScalingY = 1;
    }

    // Dark mode shows a sheet as a negative with its hues kept: an invert
    // followed by a 180 degree hue rotation, folded into one colour matrix
    // (the hue rotation H keeps greys, so H(1 - c) = 1 - Hc). White paper turns
    // black and black linework white, while a blue main stays blue and red
    // markup stays red. A plain invert turned blue into yellow and red into cyan.
    const DARK_SHEET_MATRIX = [
        1 / 3, -2 / 3, -2 / 3, 0, 1,
        -2 / 3, 1 / 3, -2 / 3, 0, 1,
        -2 / 3, -2 / 3, 1 / 3, 0, 1,
        0, 0, 0, 1, 0
    ];

    function setSheetInversion(img, inverted) {
        const filters = (img.filters || []).filter(f => !f.isDarkSheetFilter && f.type !== 'Invert');
        if (inverted) {
            const filter = new fabric.Image.filters.ColorMatrix({ matrix: DARK_SHEET_MATRIX });
            filter.isDarkSheetFilter = true;
            filters.push(filter);
        }
        const changed = filters.length !== (img.filters || []).length;
        img.filters = filters;
        if (changed || inverted) {
            applyFiltersPreservingSize(img);
            img.dirty = true;
        }
    }

    function applyPdfInversion() {
        if (!state.canvas) return;
        state.canvas.getObjects().filter(obj => obj.sheetData).forEach(img => {
            setSheetInversion(img, state.isPdfInverted);
        });
        // Labels are drawn for the current theme (see assetLabelStyle).
        if (typeof refreshAssets === 'function') refreshAssets();
        state.canvas.requestRenderAll();
    }

    // ==================== Selection Management ====================
    
    let _clearingSelection = false;
    
    function clearSelection() {
        if (_clearingSelection) return;
        _clearingSelection = true;

        const canvas = state.canvas;

        if (state.showUncutSheetId !== null) {
            const prevObj = canvas.getObjects().find(obj =>
                obj.sheetData && obj.sheetData.id === state.showUncutSheetId
            );
            if (prevObj) {
                prevObj._showUncut = false;
                prevObj.dirty = true;
            }
            state.showUncutSheetId = null;
        }

        state.selectedSheet = null;
        state.selectedAsset = null;
        window.selectedSheet = null;
        window.selectedAsset = null;
        
        canvas.discardActiveObject();

        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) obj.shadow = null;
        });
        canvas.renderAll();
        _clearingSelection = false;

        state.selectedMeasurementId = null;
        document.querySelectorAll('.folder-item-entry.selected-measurement').forEach(el => {
            el.classList.remove('selected-measurement');
        });

        document.querySelectorAll('.layer-item').forEach(item => {
            item.classList.remove('selected');
        });

        document.getElementById('no-selection').style.display = 'block';
        document.getElementById('sheet-properties').style.display = 'none';
        document.getElementById('asset-properties').style.display = 'none';
        
        if (typeof updateContextTools === 'function') {
            updateContextTools();
        }
    }
    
    function updateContextTools() {
        const hasSheet = !!state.selectedSheet;
        const hasCut = hasSheet && state.sheetCutData[state.selectedSheet.id] && 
                       state.sheetCutData[state.selectedSheet.id].length > 0;

        const flipBtn = document.getElementById('ftool-flip');
        const clearCutBtn = document.getElementById('ftool-clear-cut');
        const showUncutBtn = document.getElementById('ftool-show-uncut');

        if (flipBtn) flipBtn.style.display = hasSheet ? 'flex' : 'none';
        if (clearCutBtn) clearCutBtn.style.display = hasSheet ? 'flex' : 'none';
        if (showUncutBtn) showUncutBtn.style.display = (hasSheet && hasCut) ? 'flex' : 'none';

        if (showUncutBtn) {
            showUncutBtn.classList.toggle('active', 
                state.showUncutSheetId === (state.selectedSheet && state.selectedSheet.id));
        }
    }
    
    // ==================== Group Visibility ====================
    
    function toggleLayerGroup(groupName) {
        const body = document.getElementById(groupName + '-group-body');
        const chevron = document.getElementById(groupName + '-chevron');
        if (body) body.classList.toggle('collapsed');
        if (chevron) chevron.classList.toggle('collapsed');
    }
    
    /**
     * The eye on a whole section (sheets, assets, links, measurements, or
     * 'unified' for everything). Kept per browser, like the section order;
     * applyVisibility does the hiding.
     */
    function toggleGroupVisibility(groupName, visible) {
        state.hiddenSections[groupName] = !visible;
        DW.storage.set(`docuweaver-hidden-sections-${PROJECT_ID}`, state.hiddenSections);
        if (typeof applyVisibility === 'function') applyVisibility();
    }

    function restoreSectionVisibility() {
        state.hiddenSections = DW.storage.get(`docuweaver-hidden-sections-${PROJECT_ID}`, {}) || {};
        Object.keys(state.hiddenSections).forEach(name => {
            const cb = document.getElementById(`${name}-group-vis`);
            if (cb) cb.checked = !state.hiddenSections[name];
        });
    }

    // ==================== Initialization ====================
    
    async function initEditor() {
        // Copy PROJECT_DATA calibration values into state
        if (typeof PROJECT_DATA !== 'undefined') {
            state.refAssetId = PROJECT_DATA.ref_asset_id || '';
            state.refPixelX = PROJECT_DATA.ref_pixel_x || 0;
            state.refPixelY = PROJECT_DATA.ref_pixel_y || 0;
            state.assetRotationDeg = PROJECT_DATA.asset_rotation || 0;
            state.osmEnabled = PROJECT_DATA.osm_enabled || false;
            state.osmOpacity = PROJECT_DATA.osm_opacity || 0.7;

            // Sync to legacy globals
            window.refAssetId = state.refAssetId;
            window.refPixelX = state.refPixelX;
            window.refPixelY = state.refPixelY;
            window.assetRotationDeg = state.assetRotationDeg;
        }

        // Initialize canvas
        if (typeof DW.canvas !== 'undefined' && DW.canvas.init) {
            DW.canvas.init();
        }

        // Theme, and the per-browser view settings the first draw needs
        state.isPdfInverted = isDarkTheme();
        state.osmDarkMode = state.isPdfInverted;
        applyCanvasTheme();
        loadRenderingHierarchy();
        restoreSectionVisibility();
        if (typeof restoreBatchVisibility === 'function') restoreBatchVisibility();

        // Folders first: drawing needs their visibility
        await loadLayerGroups();

        // Restore the view before drawing, so OSM tiles load for this view
        if (typeof restoreViewportState === 'function') {
            restoreViewportState();
        }

        await loadProjectData();

        if (typeof hookViewStateSaving === 'function') {
            hookViewStateSaving();
        }
    }

    // ==================== Rendering Hierarchy ====================

    function loadRenderingHierarchy() {
        const saved = DW.storage.get(`docuweaver-rendering-hierarchy-${PROJECT_ID}`, null);
        const known = ['sheets', 'links', 'assets', 'measurements'];
        if (Array.isArray(saved) && saved.length === known.length && known.every(t => saved.includes(t))) {
            state.renderingHierarchy = saved;
        }
    }

    function saveRenderingHierarchy() {
        DW.storage.set(`docuweaver-rendering-hierarchy-${PROJECT_ID}`, state.renderingHierarchy);
    }

    /**
     * Put the canvas objects in drawing order: OSM tiles at the bottom, then
     * the layer types in renderingHierarchy order, then anything else (the
     * measurement being drawn, tool markers). Sheets are ordered by Z-index,
     * and sheets with the same Z-index keep the order of the sheet list, so
     * the stack is the same on every load whatever order the images arrive in.
     *
     * The order is built once and written back, instead of moveTo per object
     * (each moveTo is a splice of the whole list).
     */
    function applyRenderingHierarchy() {
        const canvas = state.canvas;
        if (!canvas) return;

        const objectsByType = { osm: [], sheets: [], links: [], assets: [], measurements: [], other: [] };

        canvas.getObjects().forEach(obj => {
            if (obj.isOSMTile) {
                objectsByType.osm.push(obj);
            } else if (obj.sheetData) {
                objectsByType.sheets.push(obj);
            } else if (obj.isLinkObject) {
                objectsByType.links.push(obj);
            } else if (obj.assetData) {
                objectsByType.assets.push(obj);
            } else if (obj.isSavedMeasurement) {
                objectsByType.measurements.push(obj);
            } else {
                objectsByType.other.push(obj);
            }
        });

        const listIndex = new Map(state.sheets.map((sheet, i) => [sheet.id, i]));
        const zIndex = obj => {
            const sheet = state.sheets[listIndex.get(obj.sheetData.id)] || obj.sheetData;
            return Number(sheet.z_index) || 0;
        };
        objectsByType.sheets.sort((a, b) =>
            (zIndex(a) - zIndex(b)) ||
            ((listIndex.get(a.sheetData.id) ?? 0) - (listIndex.get(b.sheetData.id) ?? 0)));

        const ordered = [...objectsByType.osm];
        state.renderingHierarchy.forEach(layerType => {
            (objectsByType[layerType] || []).forEach(obj => ordered.push(obj));
        });
        objectsByType.other.forEach(obj => ordered.push(obj));

        const objects = canvas._objects;
        objects.length = 0;
        ordered.forEach(obj => objects.push(obj));
        canvas.requestRenderAll();
    }

    function showRenderingHierarchyModal() {
        const modal = document.getElementById('renderingHierarchyModal');
        if (!modal) return;
        
        // Populate current order
        const listContainer = document.getElementById('hierarchy-list');
        if (!listContainer) return;
        
        listContainer.innerHTML = '';
        
        const labels = {
            sheets: '📄 Sheets',
            links: '🔗 Links',
            assets: '📍 Assets',
            measurements: '📐 Measurements'
        };
        
        // Reverse the array for display so top of list = top on canvas
        const displayOrder = [...state.renderingHierarchy].reverse();
        
        displayOrder.forEach((layerType, index) => {
            const item = document.createElement('div');
            item.className = 'hierarchy-item';
            item.dataset.layerType = layerType;
            item.draggable = true;
            
            item.innerHTML = `
                <span class="drag-handle">⋮⋮</span>
                <span class="layer-label">${labels[layerType]}</span>
                <span class="layer-order">${index === 0 ? 'Top' : index === displayOrder.length - 1 ? 'Bottom' : ''}</span>
            `;
            
            // Drag and drop handlers
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', layerType);
                item.classList.add('dragging');
            });
            
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
            });
            
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                const dragging = listContainer.querySelector('.dragging');
                if (dragging && dragging !== item) {
                    const rect = item.getBoundingClientRect();
                    const midpoint = rect.top + rect.height / 2;
                    if (e.clientY < midpoint) {
                        listContainer.insertBefore(dragging, item);
                    } else {
                        listContainer.insertBefore(dragging, item.nextSibling);
                    }
                }
            });
            
            listContainer.appendChild(item);
        });
        
        modal.style.display = 'flex';
    }
    
    function hideRenderingHierarchyModal() {
        const modal = document.getElementById('renderingHierarchyModal');
        if (modal) modal.style.display = 'none';
    }
    
    function applyHierarchyChanges() {
        const listContainer = document.getElementById('hierarchy-list');
        if (!listContainer) return;
        
        // Read new order from DOM (top to bottom in UI)
        const newOrder = [];
        listContainer.querySelectorAll('.hierarchy-item').forEach(item => {
            newOrder.push(item.dataset.layerType);
        });
        
        // Reverse it back to storage format (bottom to top)
        state.renderingHierarchy = newOrder.reverse();
        saveRenderingHierarchy();
        applyRenderingHierarchy();
        hideRenderingHierarchyModal();
    }
    
    // ==================== Public API ====================
    
    DW.main = {
        loadProjectData,
        applyCanvasTheme,
        applyFiltersPreservingSize,
        applyPdfInversion,
        clearSelection,
        updateContextTools,
        toggleLayerGroup,
        toggleGroupVisibility,
        restoreSectionVisibility,
        setSheetInversion,
        isDarkTheme,
        loadRenderingHierarchy,
        saveRenderingHierarchy,
        applyRenderingHierarchy,
        showRenderingHierarchyModal,
        hideRenderingHierarchyModal,
        applyHierarchyChanges,
        initEditor
    };
    
    // Expose globally for backward compatibility
    window.loadProjectData = loadProjectData;
    // Note: loadLayerGroups is exported by layers.js
    window.applyCanvasTheme = applyCanvasTheme;
    window.applyFiltersPreservingSize = applyFiltersPreservingSize;
    window.applyPdfInversion = applyPdfInversion;
    window.clearSelection = clearSelection;
    window.updateContextTools = updateContextTools;
    window.toggleLayerGroup = toggleLayerGroup;
    window.toggleGroupVisibility = toggleGroupVisibility;
    window.setSheetInversion = setSheetInversion;
    window.showRenderingHierarchyModal = showRenderingHierarchyModal;
    window.hideRenderingHierarchyModal = hideRenderingHierarchyModal;
    window.applyHierarchyChanges = applyHierarchyChanges;
    window.applyRenderingHierarchy = applyRenderingHierarchy;
    
    // Auto-initialize on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', function() {
        // Check if we should auto-init (look for canvas container)
        if (document.getElementById('canvas-container')) {
            initEditor();
        }
    });
    
})();
