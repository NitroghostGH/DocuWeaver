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
    
    function renderSheetsOnCanvas() {
        const canvas = state.canvas;
        const sheets = state.sheets;

        // Remove existing sheet objects to prevent duplicates on reload
        const existingSheetObjs = canvas.getObjects().filter(obj => obj.sheetData);
        existingSheetObjs.forEach(obj => canvas.remove(obj));

        const sheetsToLoad = sheets.filter(s => s.rendered_image_url).length;
        let sheetsLoaded = 0;

        sheets.forEach((sheet, index) => {
            if (sheet.rendered_image_url) {
                fabric.Image.fromURL(sheet.rendered_image_url, function(img) {
                    let left = sheet.offset_x;
                    let top = sheet.offset_y;
                    if (left === 0 && top === 0 && index > 0) {
                        left = index * 50;
                        top = index * 50;
                    }

                    img.set({
                        left: left,
                        top: top,
                        angle: sheet.rotation,
                        selectable: state.currentMode === 'select',
                        evented: true,
                        hasControls: false,
                        hasBorders: false,
                        lockScalingX: true,
                        lockScalingY: true,
                        lockUniScaling: true,
                        lockRotation: false,
                    });
                    img.sheetData = sheet;
                    canvas.add(img);

                    // Apply PDF inversion if active
                    if (state.isPdfInverted) {
                        if (!img.filters) img.filters = [];
                        img.filters.push(new fabric.Image.filters.Invert());
                        if (typeof applyFiltersPreservingSize === 'function') {
                            applyFiltersPreservingSize(img);
                        } else {
                            img.applyFilters();
                        }
                    }

                    // Restore cut masks
                    if (sheet.cuts_json && sheet.cuts_json.length > 0) {
                        state.sheetCutData[sheet.id] = sheet.cuts_json;
                        if (typeof applyAllCuts === 'function') {
                            applyAllCuts(img, sheet.cuts_json);
                        }
                    }

                    sheetsLoaded++;

                    if (sheetsLoaded === sheetsToLoad) {
                        reorderSheetsByZIndex();
                    }

                    canvas.renderAll();
                }, { crossOrigin: 'anonymous' });
            }
        });
    }
    
    function reorderSheetsByZIndex() {
        const canvas = state.canvas;
        const sheetObjects = canvas.getObjects().filter(obj => obj.sheetData);

        if (sheetObjects.length === 0) return;

        sheetObjects.sort((a, b) => a.sheetData.z_index - b.sheetData.z_index);

        for (let i = sheetObjects.length - 1; i >= 0; i--) {
            canvas.sendToBack(sheetObjects[i]);
        }

        if (typeof bringMeasurementsToFront === 'function') {
            bringMeasurementsToFront();
        }

        canvas.renderAll();
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
    
    function toggleSheetVisibility(sheetId, visible) {
        state.canvas.getObjects().forEach(obj => {
            if (obj.sheetData && obj.sheetData.id === sheetId) {
                obj.visible = visible;
            }
        });
        state.canvas.renderAll();
    }
    
    // ==================== Sheet Updates ====================
    
    async function updateSheetProperty(property, value, reload = true) {
        if (!state.selectedSheet) return;

        const data = {};
        data[property] = value;

        try {
            const response = await fetch(`/api/sheets/${state.selectedSheet.id}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify(data)
            });

            if (response.ok && reload) {
                const updated = await response.json();
                const index = state.sheets.findIndex(s => s.id === state.selectedSheet.id);
                state.sheets[index] = updated;
                state.selectedSheet = updated;
                window.selectedSheet = updated;

                updateSheetOnCanvas(state.selectedSheet.id, property, value);
            }
        } catch (error) {
            console.error('Error updating sheet:', error);
        }
    }
    
    function updateSheetOnCanvas(sheetId, property, value) {
        const canvas = state.canvas;
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData && obj.sheetData.id === sheetId) {
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
                        const zIndex = parseInt(value);
                        if (zIndex > 0) {
                            canvas.bringToFront(obj);
                        } else {
                            canvas.sendToBack(obj);
                        }
                        break;
                }
                obj.setCoords();
                canvas.renderAll();
            }
        });
    }
    
    async function saveSheetRotation(sheetId, angle) {
        try {
            const response = await fetch(`/api/sheets/${sheetId}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ rotation: angle })
            });

            if (response.ok) {
                const updated = await response.json();
                const index = state.sheets.findIndex(s => s.id === sheetId);
                if (index >= 0) {
                    state.sheets[index] = updated;
                    if (state.selectedSheet && state.selectedSheet.id === sheetId) {
                        state.selectedSheet = updated;
                        window.selectedSheet = updated;
                        document.getElementById('sheet-rotation').value = updated.rotation;
                    }
                }
            }
        } catch (error) {
            console.error('Error saving sheet rotation:', error);
        }
    }

    async function saveSheetPosition(sheetId, x, y) {
        try {
            const response = await fetch(`/api/sheets/${sheetId}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ offset_x: x, offset_y: y })
            });

            if (response.ok) {
                const updated = await response.json();
                const index = state.sheets.findIndex(s => s.id === sheetId);
                if (index >= 0) {
                    state.sheets[index] = updated;
                    if (state.selectedSheet && state.selectedSheet.id === sheetId) {
                        state.selectedSheet = updated;
                        window.selectedSheet = updated;
                        document.getElementById('sheet-offset-x').value = updated.offset_x;
                        document.getElementById('sheet-offset-y').value = updated.offset_y;
                    }
                }
            }
        } catch (error) {
            console.error('Error saving sheet position:', error);
        }
    }
    
    // ==================== Sheet Deletion ====================
    
    async function deleteSelectedSheet() {
        if (!state.selectedSheet) {
            console.log('No sheet selected for deletion');
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
                var index = state.sheets.findIndex(function(s) { return s.id === sheet.id; });
                if (index >= 0) {
                    state.sheets[index] = updated;
                    state.selectedSheet = updated;
                    window.selectedSheet = updated;
                }

                // Re-render just this sheet on canvas
                var canvas = state.canvas;
                var oldObj = canvas.getObjects().find(function(obj) {
                    return obj.sheetData && obj.sheetData.id === sheet.id;
                });

                if (oldObj && updated.rendered_image_url) {
                    fabric.Image.fromURL(updated.rendered_image_url + '?t=' + Date.now(), function(img) {
                        img.set({
                            left: oldObj.left,
                            top: oldObj.top,
                            angle: oldObj.angle,
                            selectable: oldObj.selectable,
                            evented: true,
                            hasControls: false,
                            hasBorders: false,
                            lockScalingX: true,
                            lockScalingY: true,
                            lockUniScaling: true,
                            lockRotation: false,
                        });
                        img.sheetData = updated;

                        canvas.remove(oldObj);
                        canvas.add(img);

                        if (state.isPdfInverted) {
                            if (!img.filters) img.filters = [];
                            img.filters.push(new fabric.Image.filters.Invert());
                            if (typeof applyFiltersPreservingSize === 'function') {
                                applyFiltersPreservingSize(img);
                            } else {
                                img.applyFilters();
                            }
                        }

                        if (updated.cuts_json && updated.cuts_json.length > 0) {
                            state.sheetCutData[updated.id] = updated.cuts_json;
                            if (typeof applyAllCuts === 'function') {
                                applyAllCuts(img, updated.cuts_json);
                            }
                        }

                        reorderSheetsByZIndex();
                        canvas.renderAll();
                    }, { crossOrigin: 'anonymous' });
                }

                DW.showToast('PDF layers updated', 'success');
            } else {
                DW.showToast('Failed to update layers', 'error');
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
        updateSheetProperty,
        updateSheetOnCanvas,
        saveSheetRotation,
        saveSheetPosition,
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
    window.saveSheetRotation = saveSheetRotation;
    window.saveSheetPosition = saveSheetPosition;
    window.deleteSelectedSheet = deleteSelectedSheet;
    window.deleteSheet = deleteSheet;
    window.renderPdfLayersUI = renderPdfLayersUI;
    window.toggleAllPdfLayers = toggleAllPdfLayers;
    
    console.log('DocuWeaver sheets module loaded');
})();
