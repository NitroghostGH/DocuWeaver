/**
 * DocuWeaver Canvas Editor - Measurements Module
 * 
 * Measurement panel, save dialog, selection and the style (config) modal.
 * Drawing, saving, loading and showing measurements is MeasurementTool
 * (static/js/measurement_tool.js), which holds the list of saved ones.
 * 
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Measurement Calculations ====================
    
    // ==================== Measurement Tool UI ====================
    
    function bringMeasurementsToFront() {
        // Use rendering hierarchy instead of always bringing to front
        if (typeof applyRenderingHierarchy === 'function') {
            applyRenderingHierarchy();
        } else {
            // Fallback to old behavior if hierarchy system not available
            const canvas = state.canvas;
            const measurements = canvas.getObjects().filter(obj => 
                obj.isMeasurement || obj.isMeasurementGroup || obj.isSavedMeasurement
            );
            measurements.forEach(m => canvas.bringToFront(m));
        }
    }
    
    function clearMeasurements() {
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.clearCurrent();
            MeasurementTool.updatePanel();
        }
    }

    function toggleMeasureMode(mode) {
        // Clear existing measurement FIRST before switching modes
        clearMeasurements();
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.clearCurrent();
        }
        
        state.measureMode = mode;
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.startMeasurement(mode);
        }
    }
    
    function toggleMeasurePanel() {
        const section = document.getElementById('measure-section');
        const isVisible = section && section.style.display !== 'none';
        
        if (isVisible) {
            if (section) section.style.display = 'none';
            clearMeasurements();
            if (typeof MeasurementTool !== 'undefined') {
                MeasurementTool.clearCurrent();
            }
            if (typeof setMode === 'function') {
                setMode('pan');
            }
            return;
        }
        
        if (section) section.style.display = 'block';
        if (typeof MeasurementTool !== 'undefined') {
            MeasurementTool.startMeasurement(state.measureMode);
        }
        if (typeof setMode === 'function') {
            setMode('measure');
        }
    }
    
    // ==================== Measurement Sets ====================
    
    function saveMeasurementPrompt() {
        showSaveMeasurementModal();
    }
    
    function showSaveMeasurementModal() {
        const modal = document.getElementById('saveMeasurementModal');
        const folderSelect = document.getElementById('measurement-folder');
        const nameInput = document.getElementById('measurement-name');
        
        if (!modal) return;
        
        if (typeof MeasurementTool === 'undefined' ||
            MeasurementTool.getCurrentPoints().length < 2) {
            DW.showToast('Measure something first: click at least two points', 'warning');
            return;
        }

        folderSelect.innerHTML = '<option value="">Ungrouped</option>';

        // Top-level folders come back with their subfolders nested.
        function addFolderOptions(groups, depth) {
            groups.forEach(g => {
                if (g.group_type !== 'measurement') return;
                const opt = document.createElement('option');
                opt.value = g.id;
                opt.textContent = '\u00A0\u00A0'.repeat(depth) + g.name;
                folderSelect.appendChild(opt);
                addFolderOptions(g.child_groups || [], depth + 1);
            });
        }
        addFolderOptions(state.measurementGroups || [], 0);

        nameInput.value = '';
        modal.style.display = 'flex';
        nameInput.focus();
    }

    async function submitSaveMeasurement(e) {
        e.preventDefault();
        const name = document.getElementById('measurement-name').value.trim();
        const folderId = document.getElementById('measurement-folder').value;
        if (!name || typeof MeasurementTool === 'undefined') return;

        const saved = await MeasurementTool.saveCurrent(name, folderId ? parseInt(folderId, 10) : null);
        if (saved) {
            hideSaveMeasurementModal();
            if (typeof renderMeasurementGroupList === 'function') {
                await renderMeasurementGroupList();
            }
        }
    }

    const saveMeasurementForm = document.getElementById('saveMeasurementForm');
    if (saveMeasurementForm) {
        saveMeasurementForm.addEventListener('submit', submitSaveMeasurement);
    }
    
    function hideSaveMeasurementModal() {
        const modal = document.getElementById('saveMeasurementModal');
        if (modal) modal.style.display = 'none';
    }
    
    // ==================== Measurement Config Modal ====================
    
    function showMeasurementConfigModal() {
        const modal = document.getElementById('measurementConfigModal');
        if (!modal) return;
        
        if (typeof MeasurementTool === 'undefined') return;
        
        const config = MeasurementTool.getConfig();
        
        // Populate display settings
        document.getElementById('config-show-distance').checked = config.showDistance !== false;
        document.getElementById('config-show-angle').checked = config.showAngle !== false;
        document.getElementById('config-label-scale').value = config.labelScale || 1;
        document.getElementById('config-scale-value').textContent = (config.labelScale || 1).toFixed(1);
        
        // Populate line style settings
        document.getElementById('config-line-style').value = config.lineStyle || 'dashed';
        document.getElementById('config-line-thickness').value = config.lineStrokeWidth || 1.5;
        document.getElementById('config-thickness-value').textContent = config.lineStrokeWidth || 1.5;
        document.getElementById('config-line-color').value = config.lineColor || '#00bcd4';
        document.getElementById('config-line-color-hex').value = config.lineColor || '#00bcd4';
        
        if (document.getElementById('config-marker-size')) {
            document.getElementById('config-marker-size').value = config.markerSize || 4;
            document.getElementById('config-marker-value').textContent = config.markerSize || 4;
        }
        
        refreshConfigTypesList();
        switchConfigTab('style');
        
        modal.style.display = 'flex';
    }
    
    function hideMeasurementConfigModal() {
        const modal = document.getElementById('measurementConfigModal');
        if (modal) modal.style.display = 'none';
    }
    
    function switchConfigTab(tabName) {
        document.querySelectorAll('.config-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });
        
        document.querySelectorAll('.config-tab-content').forEach(panel => {
            const isActive = panel.id === `config-tab-${tabName}`;
            panel.style.display = isActive ? 'block' : 'none';
        });
    }
    
    // Alias for HTML compatibility
    function switchMeasureConfigTab(tabName) {
        switchConfigTab(tabName);
    }
    
    function saveMeasurementConfig() {
        if (typeof MeasurementTool === 'undefined') return;
        
        const lineStyle = document.getElementById('config-line-style').value || 'dashed';
        const lineThickness = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
        const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
        
        const config = {
            showDistance: document.getElementById('config-show-distance').checked,
            showAngle: document.getElementById('config-show-angle').checked,
            labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
            lineStyle: lineStyle,
            lineStrokeWidth: lineThickness,
            lineColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerSize: markerSize,
            previewLineColor: document.getElementById('config-line-color').value || '#00bcd4'
        };
        
        config.lineDashArray = MeasurementTool.getLineDashArray(config.lineStyle, config.lineStrokeWidth);
        
        MeasurementTool.updateConfig(config);
        hideMeasurementConfigModal();
        updateConfigPreviewBar();

    }
    
    function onMeasureConfigTypeChange(value) {
        if (typeof MeasurementTool === 'undefined') return;
        MeasurementTool.setConfigType(value);
        updateConfigPreviewBar();
    }

    function populateConfigTypeSelect() {
        const select = document.getElementById('measure-config-type');
        if (!select || typeof MeasurementTool === 'undefined') return;

        const configTypes = MeasurementTool.getConfigTypes();
        const currentType = MeasurementTool.getCurrentConfigType();
        select.innerHTML = '';

        Object.entries(configTypes).forEach(([key, ct]) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = ct.name || key;
            if (key === currentType) option.selected = true;
            select.appendChild(option);
        });

        updateConfigPreviewBar();
    }

    function updateConfigPreviewBar() {
        const preview = document.getElementById('measure-config-preview');
        if (!preview || typeof MeasurementTool === 'undefined') return;

        const config = MeasurementTool.getConfig();
        const lineColor = config.lineColor || '#00bcd4';
        const lineStyle = config.lineStyle || 'dashed';

        if (lineStyle === 'dashed') {
            preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 5px, transparent 5px, transparent 10px)`;
        } else if (lineStyle === 'dotted') {
            preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 2px, transparent 2px, transparent 5px)`;
        } else {
            preview.style.background = lineColor;
        }
    }

    function refreshConfigTypesList() {
        const container = document.getElementById('config-presets-list');
        if (!container || typeof MeasurementTool === 'undefined') return;
        
        const configTypes = MeasurementTool.getConfigTypes();
        const currentType = MeasurementTool.getCurrentConfigType();
        container.innerHTML = '';
        
        Object.entries(configTypes).forEach(([key, ct]) => {
            const item = document.createElement('div');
            item.className = 'config-type-item';
            if (key === currentType) {
                item.classList.add('active');
            }
            
            const cfg = ct.config || {};
            item.innerHTML = `
                <span class="config-type-name">${ct.name || key}</span>
                <div class="config-type-actions">
                    <button type="button" class="btn-apply" onclick="applyConfigType('${key}')">Apply</button>
                    <button type="button" class="btn-edit" onclick="editConfigType('${key}')">Edit</button>
                    ${key !== 'default' ? `<button type="button" class="btn-delete-config" onclick="deleteConfigTypeHandler('${key}')">×</button>` : ''}
                </div>
            `;
            
            const preview = document.createElement('span');
            preview.className = 'config-type-preview';
            const lineColor = cfg.lineColor || '#00bcd4';
            const lineStyle = cfg.lineStyle || 'dashed';
            
            // Set background based on line style
            if (lineStyle === 'solid') {
                preview.style.backgroundColor = lineColor;
            } else if (lineStyle === 'dashed') {
                preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 5px, transparent 5px, transparent 10px)`;
            } else if (lineStyle === 'dotted') {
                preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 2px, transparent 2px, transparent 5px)`;
            } else if (lineStyle === 'dashdot') {
                preview.style.background = `repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 5px, transparent 5px, transparent 7px, ${lineColor} 7px, ${lineColor} 9px, transparent 9px, transparent 16px)`;
            } else {
                preview.style.backgroundColor = lineColor;
            }
            
            item.querySelector('.config-type-name').prepend(preview);
            
            container.appendChild(item);
        });
    }
    
    function applyConfigType(name) {
        if (typeof MeasurementTool === 'undefined') return;
        
        MeasurementTool.setConfigType(name);
        
        const config = MeasurementTool.getConfig();
        document.getElementById('config-show-distance').checked = config.showDistance !== false;
        document.getElementById('config-show-angle').checked = config.showAngle !== false;
        document.getElementById('config-label-scale').value = config.labelScale || 1;
        document.getElementById('config-scale-value').textContent = (config.labelScale || 1).toFixed(1);
        document.getElementById('config-line-style').value = config.lineStyle || 'dashed';
        document.getElementById('config-line-thickness').value = config.lineStrokeWidth || 1.5;
        document.getElementById('config-thickness-value').textContent = config.lineStrokeWidth || 1.5;
        document.getElementById('config-line-color').value = config.lineColor || '#00bcd4';
        document.getElementById('config-line-color-hex').value = config.lineColor || '#00bcd4';
        if (document.getElementById('config-marker-size')) {
            document.getElementById('config-marker-size').value = config.markerSize || 4;
            document.getElementById('config-marker-value').textContent = config.markerSize || 4;
        }
        
        refreshConfigTypesList();
        populateConfigTypeSelect();
    }
    
    function addNewConfigType() {
        if (typeof MeasurementTool === 'undefined') return;
        
        const nameInput = document.getElementById('config-new-preset-name');
        const name = nameInput ? nameInput.value.trim() : prompt('Enter name for new measurement type:');
        if (!name) return;
        
        const key = name.toLowerCase().replace(/\s+/g, '_');
        
        const lineStyle = document.getElementById('config-line-style').value || 'dashed';
        const lineStrokeWidth = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
        const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
        
        const settings = {
            showDistance: document.getElementById('config-show-distance').checked,
            showAngle: document.getElementById('config-show-angle').checked,
            labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
            lineStyle: lineStyle,
            lineStrokeWidth: lineStrokeWidth,
            lineColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerSize: markerSize,
            previewLineColor: document.getElementById('config-line-color').value || '#00bcd4',
            lineDashArray: MeasurementTool.getLineDashArray(lineStyle, lineStrokeWidth)
        };
        
        const existingTypes = MeasurementTool.getConfigTypes();
        if (existingTypes[key]) {
            alert('A config type with that name already exists.');
            return;
        }
        
        MeasurementTool.saveConfigType(key, name, settings);
        refreshConfigTypesList();
        if (nameInput) nameInput.value = '';
    }
    
    function editConfigType(key) {
        applyConfigType(key);
        switchConfigTab('style');
        window._editingConfigType = key;
        
        const configTypes = typeof MeasurementTool !== 'undefined' ? MeasurementTool.getConfigTypes() : {};
        const displayName = configTypes[key]?.name || key;
        
        const saveBtn = document.querySelector('#measurementConfigModal .btn-save');
        if (saveBtn) {
            saveBtn.textContent = `Update "${displayName}"`;
            saveBtn.onclick = function() {
                saveAndUpdateConfigType();
            };
        }
    }
    
    function saveAndUpdateConfigType() {
        if (typeof MeasurementTool === 'undefined') return;
        
        const key = window._editingConfigType;
        if (key) {
            const configTypes = MeasurementTool.getConfigTypes();
            const displayName = configTypes[key]?.name || key;
            
            const lineStyle = document.getElementById('config-line-style').value || 'dashed';
            const lineStrokeWidth = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
            const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
            
            const settings = {
                showDistance: document.getElementById('config-show-distance').checked,
                showAngle: document.getElementById('config-show-angle').checked,
                labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
                lineStyle: lineStyle,
                lineStrokeWidth: lineStrokeWidth,
                lineColor: document.getElementById('config-line-color').value || '#00bcd4',
                markerColor: document.getElementById('config-line-color').value || '#00bcd4',
                markerSize: markerSize,
                previewLineColor: document.getElementById('config-line-color').value || '#00bcd4',
                lineDashArray: MeasurementTool.getLineDashArray(lineStyle, lineStrokeWidth)
            };
            
            MeasurementTool.saveConfigType(key, displayName, settings);
            refreshConfigTypesList();
        }
        
        window._editingConfigType = null;
        const saveBtn = document.querySelector('#measurementConfigModal .btn-save');
        if (saveBtn) {
            saveBtn.textContent = 'Save Settings';
            saveBtn.onclick = saveMeasurementConfig;
        }
        
        saveMeasurementConfig();
    }
    
    function deleteConfigTypeHandler(key) {
        if (typeof MeasurementTool === 'undefined') return;
        
        const configTypes = MeasurementTool.getConfigTypes();
        const displayName = configTypes[key]?.name || key;
        
        if (!confirm(`Delete measurement type "${displayName}"?`)) return;
        
        MeasurementTool.deleteConfigType(key);
        refreshConfigTypesList();
    }

    // ==================== Measurement Selection ====================
    // In select mode a saved measurement can be clicked on the canvas
    // (canvas_init.js handleSelectionCreated → selectMeasurement); Delete or
    // Backspace then removes it (canvas_init.js → deleteSelectedMeasurement).
    // main.js clearSelection resets state.selectedMeasurementId and the highlight.

    /** Select a saved measurement, from the canvas or from the sidebar. */
    function selectMeasurement(msId) {
        state.selectedMeasurementId = msId;
        const ms = MeasurementTool.getSavedMeasurements().find(m => m.id === msId);
        const group = state.canvas.getObjects().find(o => o.isSavedMeasurement && o.measurementSetId === msId);
        if (group && group.visible && state.canvas.getActiveObject() !== group) {
            state.canvas.setActiveObject(group);
            state.canvas.requestRenderAll();
        }
        if (ms) {
            DW.showToast(`Selected: ${ms.name || 'Measurement'}` +
                (state.currentMode === 'select' ? ' - press Delete to remove' : ''), 'info');
        }
        highlightMeasurementInSidebar(msId);
    }

    function highlightMeasurementInSidebar(msId) {
        document.querySelectorAll('.folder-item-entry.selected-measurement').forEach(el => {
            el.classList.remove('selected-measurement');
        });
        const itemEl = document.querySelector(
            `.folder-item-entry[data-item-id="${msId}"][data-item-type="measurement"]`
        );
        if (itemEl) {
            itemEl.classList.add('selected-measurement');
            itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    async function deleteSelectedMeasurement() {
        const msId = state.selectedMeasurementId;
        if (!msId) return;
        const ms = MeasurementTool.getSavedMeasurements().find(m => m.id === msId);
        if (!ms) return;

        // MeasurementTool.delete asks for confirmation, redraws the canvas and
        // shows the result toast.
        const deleted = await MeasurementTool.delete(msId, ms.name || 'Unnamed');
        if (deleted) {
            state.selectedMeasurementId = null;
            state.canvas.discardActiveObject();
            state.canvas.requestRenderAll();
            if (typeof renderLayerGroupsUI === 'function') renderLayerGroupsUI();
        }
    }

    // ==================== Public API ====================

    DW.measurements = {
        selectMeasurement,
        highlightMeasurementInSidebar,
        deleteSelectedMeasurement,
        bringMeasurementsToFront,
        clearMeasurements,
        toggleMeasureMode,
        toggleMeasurePanel,
        saveMeasurementPrompt,
        showSaveMeasurementModal,
        hideSaveMeasurementModal,
        showMeasurementConfigModal,
        hideMeasurementConfigModal,
        switchConfigTab,
        switchMeasureConfigTab,
        saveMeasurementConfig,
        refreshConfigTypesList,
        applyConfigType,
        addNewConfigType,
        editConfigType,
        saveAndUpdateConfigType,
        deleteConfigTypeHandler,
        onMeasureConfigTypeChange,
        populateConfigTypeSelect,
        updateConfigPreviewBar
    };
    
    // Expose globally for backward compatibility
    window.bringMeasurementsToFront = bringMeasurementsToFront;
    window.clearMeasurements = clearMeasurements;
    window.toggleMeasureMode = toggleMeasureMode;
    window.toggleMeasurePanel = toggleMeasurePanel;
    window.saveMeasurementPrompt = saveMeasurementPrompt;
    window.showSaveMeasurementModal = showSaveMeasurementModal;
    window.hideSaveMeasurementModal = hideSaveMeasurementModal;
    window.showMeasurementConfigModal = showMeasurementConfigModal;
    window.hideMeasurementConfigModal = hideMeasurementConfigModal;
    window.switchConfigTab = switchConfigTab;
    window.switchMeasureConfigTab = switchMeasureConfigTab;
    window.saveMeasurementConfig = saveMeasurementConfig;
    window.refreshConfigTypesList = refreshConfigTypesList;
    window.applyConfigType = applyConfigType;
    window.addNewConfigType = addNewConfigType;
    window.editConfigType = editConfigType;
    window.saveAndUpdateConfigType = saveAndUpdateConfigType;
    window.deleteConfigTypeHandler = deleteConfigTypeHandler;
    window.onMeasureConfigTypeChange = onMeasureConfigTypeChange;
    window.populateConfigTypeSelect = populateConfigTypeSelect;
    window.updateConfigPreviewBar = updateConfigPreviewBar;
    window.selectMeasurement = selectMeasurement;
    window.highlightMeasurementInSidebar = highlightMeasurementInSidebar;
    window.deleteSelectedMeasurement = deleteSelectedMeasurement;

})();
