/**
 * DocuWeaver Canvas Editor - Sheets Module
 * 
 * Handles sheet rendering, selection, manipulation, and persistence.
 * 
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Sheet Rendering ====================

    // Bumped on every full redraw. An image that finishes loading after a
    // newer redraw started is dropped, or a quick second loadProjectData()
    // would leave two copies of a sheet.
    let renderGeneration = 0;

    /**
     * Set up a loaded sheet image: position, interaction, dark-mode filter,
     * cut masks and visibility. Used for the first draw, after a PDF layer
     * change and after a split.
     */
    function setupSheetImage(img, sheet) {
        const isSelectMode = state.currentMode === 'select';
        const isCropOrSplitMode = state.currentMode === 'crop' || state.currentMode === 'split';
        img.set({
            left: sheet.offset_x,
            top: sheet.offset_y,
            angle: sheet.rotation,
            selectable: isSelectMode,
            evented: isSelectMode || isCropOrSplitMode,
            hoverCursor: isCropOrSplitMode ? 'crosshair' : 'move',
            hasControls: false,
            hasBorders: false,
            lockScalingX: true,
            lockScalingY: true,
            lockUniScaling: true,
            lockRotation: false,
        });
        img.sheetData = sheet;
        if (state.isPdfInverted && typeof setSheetInversion === 'function') {
            setSheetInversion(img, true);
        }
        if (sheet.cuts_json && sheet.cuts_json.length > 0) {
            state.sheetCutData[sheet.id] = sheet.cuts_json;
            if (typeof applyAllCuts === 'function') applyAllCuts(img, sheet.cuts_json);
        }
        img.visible = typeof isItemShown === 'function' ? isItemShown(sheet, 'sheet') : sheet.visible !== false;
        return img;
    }

    function renderSheetsOnCanvas() {
        const canvas = state.canvas;
        const generation = ++renderGeneration;

        // Remove existing sheet objects to prevent duplicates on reload
        canvas.getObjects().filter(obj => obj.sheetData).forEach(obj => canvas.remove(obj));

        // Draw exactly where each sheet is saved. New sheets get a cascaded
        // offset from the server (SheetListCreate).
        state.sheets.filter(s => s.rendered_image_url).forEach(sheet => {
            fabric.Image.fromURL(sheet.rendered_image_url, function(img, isError) {
                if (generation !== renderGeneration) return;
                if (isError || !img.getElement()) {
                    DW.showToast(`Could not load the image of sheet "${sheet.name}"`, 'error');
                    return;
                }
                canvas.add(setupSheetImage(img, sheet));
                // Stacking follows Z-index, not the order the images arrive in.
                if (typeof applyRenderingHierarchy === 'function') applyRenderingHierarchy();
            }, { crossOrigin: 'anonymous' });
        });
    }

    function reorderSheetsByZIndex() {
        if (typeof applyRenderingHierarchy === 'function') applyRenderingHierarchy();
    }

    /** Point the canvas object and the shared state at a sheet saved by the server. */
    function replaceSheetData(updated) {
        const index = state.sheets.findIndex(s => s.id === updated.id);
        if (index >= 0) state.sheets[index] = updated;
        if (state.selectedSheet && state.selectedSheet.id === updated.id) {
            state.selectedSheet = updated;
            window.selectedSheet = updated;
        }
        const obj = state.canvas.getObjects().find(o => o.sheetData && o.sheetData.id === updated.id);
        if (obj) obj.sheetData = updated;
    }

    function renderSheetLayers() {
        if (typeof renderSheetGroupList === 'function') {
            renderSheetGroupList();
        }
    }
    
    // ==================== Sheet Selection ====================
    
    function selectSheet(sheetId) {
        const canvas = state.canvas;
        
        // Reset show-uncut if switching sheets
        if (state.showUncutSheetId !== null && state.showUncutSheetId !== sheetId) {
            const prevObj = canvas.getObjects().find(obj =>
                obj.sheetData && obj.sheetData.id === state.showUncutSheetId
            );
            if (prevObj) {
                prevObj._showUncut = false;
                prevObj.dirty = true;
            }
            state.showUncutSheetId = null;
        }

        state.selectedSheet = state.sheets.find(s => s.id === sheetId);
        window.selectedSheet = state.selectedSheet;
        state.selectedAsset = null;
        window.selectedAsset = null;

        // Highlight with glow shadow
        const selectionShadow = new fabric.Shadow({
            color: 'rgba(52, 152, 219, 0.7)',
            blur: 20,
            offsetX: 0,
            offsetY: 0,
        });
        
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) {
                if (obj.sheetData.id === sheetId) {
                    obj.shadow = selectionShadow;
                    if (state.currentMode === 'select' && canvas.getActiveObject() !== obj) {
                        canvas.setActiveObject(obj);
                    }
                } else {
                    obj.shadow = null;
                }
            }
        });
        canvas.renderAll();

        // Update UI
        document.querySelectorAll('.layer-item').forEach(item => {
            item.classList.toggle('selected', parseInt(item.dataset.sheetId) === sheetId);
        });

        if (typeof openRightSidebar === 'function') openRightSidebar();
        document.getElementById('no-selection').style.display = 'none';
        document.getElementById('sheet-properties').style.display = 'block';
        document.getElementById('asset-properties').style.display = 'none';

        document.getElementById('sheet-name').value = state.selectedSheet.name;
        document.getElementById('sheet-offset-x').value = state.selectedSheet.offset_x;
        document.getElementById('sheet-offset-y').value = state.selectedSheet.offset_y;
        document.getElementById('sheet-rotation').value = state.selectedSheet.rotation;
        document.getElementById('sheet-zindex').value = state.selectedSheet.z_index;
        
        renderPdfLayersUI(state.selectedSheet);

        if (typeof updateContextTools === 'function') {
            updateContextTools();
        }
    }
    
    // ==================== Sheet Visibility ====================

    /** The eye on a sheet. Saved, so it stays hidden after a reload. */
    async function toggleSheetVisibility(sheetId, visible) {
        const sheet = state.sheets.find(s => s.id === sheetId);
        if (!sheet) return false;
        const previous = sheet.visible;
        sheet.visible = visible;
        if (typeof applyVisibility === 'function') applyVisibility();
        try {
            const response = await fetch(`/api/sheets/${sheetId}/`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': DW.getCSRFToken() },
                body: JSON.stringify({ visible })
            });
            if (!response.ok) throw new Error(await DW.responseError(response));
            return true;
        } catch (error) {
            sheet.visible = previous;
            if (typeof applyVisibility === 'function') applyVisibility();
            renderSheetLayers();
            DW.showToast('Could not save the sheet visibility: ' + error.message, 'error');
            return false;
        }
    }

    // ==================== Sheet Updates ====================

    const SHEET_NUMBER_FIELDS = ['offset_x', 'offset_y', 'rotation', 'z_index'];

    /**
     * Save one field typed in the sheet properties panel. Undo restores the
     * previous value. The panel is reset to the saved value on an error.
     */
    async function updateSheetProperty(property, value, recordUndo = true) {
        const sheet = state.selectedSheet;
        if (!sheet) return;

        if (SHEET_NUMBER_FIELDS.includes(property)) {
            value = property === 'z_index' ? parseInt(value, 10) : parseFloat(value);
            if (!isFinite(value)) {
                DW.showToast('Enter a number', 'warning');
                selectSheet(sheet.id);
                return;
            }
        }
        const previous = sheet[property];
        if (previous === value) return;

        try {
            const response = await fetch(`/api/sheets/${sheet.id}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ [property]: value })
            });
            if (!response.ok) throw new Error(await DW.responseError(response));

            const updated = await response.json();
            replaceSheetData(updated);
            updateSheetOnCanvas(updated.id, property, updated[property]);
            if (recordUndo && typeof saveUndoState === 'function') {
                saveUndoState('sheetProperty', { sheetId: updated.id, property, previous });
            }
            if (property === 'name') renderSheetLayers();
        } catch (error) {
            DW.showToast('Could not save the sheet: ' + error.message, 'error');
            if (state.selectedSheet && state.selectedSheet.id === sheet.id) selectSheet(sheet.id);
        }
    }

    function updateSheetOnCanvas(sheetId, property, value) {
        const canvas = state.canvas;
        const obj = canvas.getObjects().find(o => o.sheetData && o.sheetData.id === sheetId);
        if (!obj) return;
        switch (property) {
            case 'rotation':
                obj.set('angle', parseFloat(value));
                break;
            case 'offset_x':
                obj.set('left', parseFloat(value));
                break;
            case 'offset_y':
                obj.set('top', parseFloat(value));
                break;
            case 'z_index':
                // Sheets stay below links, assets and measurements; Z-index
                // only orders sheets among themselves.
                if (typeof applyRenderingHierarchy === 'function') applyRenderingHierarchy();
                break;
        }
        obj.setCoords();
        canvas.requestRenderAll();
    }

    // ==================== Canvas → Server Sync ====================

    /**
     * Save a sheet's position and/or rotation after it was moved or rotated on
     * the canvas (called by canvas_init.js handleObjectModified). Only changed
     * fields are sent, in a single PATCH: two concurrent PATCHes can lose an
     * update, because the server writes back every field of the sheet.
     */
    async function saveSheetTransformFromCanvas(obj) {
        if (!obj || !obj.sheetData) return;
        const sheetId = obj.sheetData.id;
        const sheet = state.sheets.find(s => s.id === sheetId);

        const data = {};
        if (!sheet || sheet.offset_x !== obj.left || sheet.offset_y !== obj.top) {
            data.offset_x = obj.left;
            data.offset_y = obj.top;
        }
        if (!sheet || sheet.rotation !== obj.angle) {
            data.rotation = obj.angle;
        }
        if (Object.keys(data).length === 0) return;

        try {
            const response = await fetch(`/api/sheets/${sheetId}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify(data)
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const updated = await response.json();
            replaceSheetData(updated);
            if (state.selectedSheet && state.selectedSheet.id === sheetId) {
                document.getElementById('sheet-offset-x').value = updated.offset_x;
                document.getElementById('sheet-offset-y').value = updated.offset_y;
                document.getElementById('sheet-rotation').value = updated.rotation;
            }
        } catch (error) {
            console.error('Error saving sheet position:', error);
            DW.showToast('Could not save the sheet position', 'error');
        }
    }
    
    // ==================== Sheet Deletion ====================
    
    async function deleteSelectedSheet() {
        if (!state.selectedSheet) {
            return;
        }

        const sheetName = state.selectedSheet.name;
        if (!confirm(`Are you sure you want to delete "${sheetName}"? This cannot be undone.`)) {
            return;
        }

        try {
            const response = await fetch(`/api/sheets/${state.selectedSheet.id}/`, {
                method: 'DELETE',
                headers: {
                    'X-CSRFToken': DW.getCSRFToken()
                }
            });

            if (response.ok || response.status === 204) {
                state.canvas.getObjects().forEach(obj => {
                    if (obj.sheetData && obj.sheetData.id === state.selectedSheet.id) {
                        state.canvas.remove(obj);
                    }
                });
                state.canvas.renderAll();

                const index = state.sheets.findIndex(s => s.id === state.selectedSheet.id);
                if (index >= 0) {
                    state.sheets.splice(index, 1);
                }

                delete state.sheetCutData[state.selectedSheet.id];

                if (typeof clearSelection === 'function') {
                    clearSelection();
                }
                renderSheetLayers();

                DW.showToast(`Sheet "${sheetName}" deleted`, 'success');
                return true;
            } else {
                const error = await response.json();
                DW.showToast('Error deleting sheet: ' + JSON.stringify(error), 'error');
                return false;
            }
        } catch (error) {
            console.error('Error deleting sheet:', error);
            DW.showToast('Error deleting sheet', 'error');
            return false;
        }
    }

    async function deleteSheet(sheetId, sheetName) {
        if (!confirm(`Delete sheet "${sheetName}"? This cannot be undone.`)) return false;

        try {
            const response = await fetch(`/api/sheets/${sheetId}/`, {
                method: 'DELETE',
                headers: { 'X-CSRFToken': DW.getCSRFToken() }
            });

            if (response.ok || response.status === 204) {
                state.canvas.getObjects().forEach(obj => {
                    if (obj.sheetData && obj.sheetData.id === sheetId) {
                        state.canvas.remove(obj);
                    }
                });
                state.canvas.renderAll();

                const index = state.sheets.findIndex(s => s.id === sheetId);
                if (index >= 0) {
                    state.sheets.splice(index, 1);
                }

                delete state.sheetCutData[sheetId];

                if (state.selectedSheet && state.selectedSheet.id === sheetId) {
                    if (typeof clearSelection === 'function') {
                        clearSelection();
                    }
                }
                
                renderSheetLayers();
                if (typeof renderSheetGroupList === 'function') {
                    renderSheetGroupList();
                }
                
                DW.showToast(`Sheet "${sheetName}" deleted`, 'success');
                return true;
            } else {
                DW.showToast('Failed to delete sheet', 'error');
                return false;
            }
        } catch (error) {
            console.error('Error deleting sheet:', error);
            DW.showToast('Error deleting sheet', 'error');
            return false;
        }
    }
    
    // ==================== PDF Layer Control ====================

    function renderPdfLayersUI(sheet) {
        var section = document.getElementById('pdf-layers-section');
        var container = document.getElementById('pdf-layers-list');
        if (!section || !container) return;

        if (!sheet.pdf_layers || sheet.pdf_layers.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'block';
        container.innerHTML = '';

        // If visible_layers is empty, all layers are visible
        var visibleSet = new Set(
            sheet.visible_layers && sheet.visible_layers.length > 0
                ? sheet.visible_layers
                : sheet.pdf_layers.map(function(l) { return l.xref; })
        );

        sheet.pdf_layers.forEach(function(layer) {
            var div = document.createElement('div');
            div.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0;';

            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = visibleSet.has(layer.xref);
            cb.dataset.xref = layer.xref;
            cb.addEventListener('change', function() {
                applyPdfLayerChanges(sheet);
            });

            var label = document.createElement('span');
            label.textContent = layer.name;
            label.style.fontSize = '0.85rem';

            div.appendChild(cb);
            div.appendChild(label);
            container.appendChild(div);
        });
    }

    async function applyPdfLayerChanges(sheet) {
        var container = document.getElementById('pdf-layers-list');
        if (!container) return;

        var checkboxes = container.querySelectorAll('input[type="checkbox"]');
        var visibleLayers = [];
        checkboxes.forEach(function(cb) {
            if (cb.checked) {
                visibleLayers.push(parseInt(cb.dataset.xref));
            }
        });
        // An empty list means "all layers visible" to the server. xref 0 is
        // never a layer, so [0] shows the page with every layer hidden.
        if (visibleLayers.length === 0) {
            visibleLayers.push(0);
        }

        try {
            var response = await fetch('/api/sheets/' + sheet.id + '/layers/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ visible_layers: visibleLayers })
            });

            if (response.ok) {
                var updated = await response.json();
                replaceSheetData(updated);

                // Re-render just this sheet on canvas
                var canvas = state.canvas;
                var oldObj = canvas.getObjects().find(function(obj) {
                    return obj.sheetData && obj.sheetData.id === sheet.id;
                });

                if (oldObj && updated.rendered_image_url) {
                    fabric.Image.fromURL(updated.rendered_image_url + '?t=' + Date.now(), function(img, isError) {
                        if (isError || !img.getElement()) return;
                        // Keep the position on screen, which may not be saved yet.
                        setupSheetImage(img, Object.assign({}, updated, {
                            offset_x: oldObj.left, offset_y: oldObj.top, rotation: oldObj.angle
                        }));
                        img.sheetData = updated;
                        canvas.remove(oldObj);
                        canvas.add(img);
                        if (typeof applyRenderingHierarchy === 'function') applyRenderingHierarchy();
                    }, { crossOrigin: 'anonymous' });
                }

                DW.showToast('PDF layers updated', 'success');
            } else {
                DW.showToast('Could not change the layers: ' + await DW.responseError(response), 'error');
                renderPdfLayersUI(sheet);
            }
        } catch (error) {
            console.error('Error updating PDF layers:', error);
            DW.showToast('Error updating layers', 'error');
        }
    }

    function toggleAllPdfLayers(on) {
        var container = document.getElementById('pdf-layers-list');
        if (!container || !state.selectedSheet) return;

        container.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
            cb.checked = on;
        });
        applyPdfLayerChanges(state.selectedSheet);
    }

    // ==================== Public API ====================
    
    DW.sheets = {
        renderSheetsOnCanvas,
        reorderSheetsByZIndex,
        renderSheetLayers,
        selectSheet,
        toggleSheetVisibility,
        setupSheetImage,
        replaceSheetData,
        updateSheetProperty,
        updateSheetOnCanvas,
        saveSheetTransformFromCanvas,
        deleteSelectedSheet,
        deleteSheet,
        renderPdfLayersUI,
        applyPdfLayerChanges,
        toggleAllPdfLayers
    };

    // Expose globally for backward compatibility
    window.renderSheetsOnCanvas = renderSheetsOnCanvas;
    window.reorderSheetsByZIndex = reorderSheetsByZIndex;
    window.renderSheetLayers = renderSheetLayers;
    window.selectSheet = selectSheet;
    window.toggleSheetVisibility = toggleSheetVisibility;
    window.updateSheetProperty = updateSheetProperty;
    window.updateSheetOnCanvas = updateSheetOnCanvas;
    window.setupSheetImage = setupSheetImage;
    window.replaceSheetData = replaceSheetData;
    window.saveSheetTransformFromCanvas = saveSheetTransformFromCanvas;
    window.deleteSelectedSheet = deleteSelectedSheet;
    window.deleteSheet = deleteSheet;
    window.renderPdfLayersUI = renderPdfLayersUI;
    window.toggleAllPdfLayers = toggleAllPdfLayers;
    
})();
