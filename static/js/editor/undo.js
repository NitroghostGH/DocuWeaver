/**
 * DocuWeaver Canvas Editor - Undo System
 *
 * Manages the undo stack (Ctrl+Z).
 *
 * Depends on: namespace.js, crop.js (applyAllCuts, saveCutData)
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    // Ctrl+Z undoes, newest first: sheet moves and rotations, typed sheet
    // properties, cuts (add, flip, clear) and asset adjustments. An action
    // that can't be undone (a split) clears the history, so Ctrl+Z never
    // reaches past it to an older, unrelated change.

    let historyStoppedBecause = null;

    /**
     * Record an action for undo.
     * @param {string} actionType - 'transform', 'sheetProperty', 'cut', 'clearCut' or 'assetAdjust'
     * @param {object} data - What undo needs to restore
     */
    function saveUndoState(actionType, data) {
        state.undoStack.push({
            type: actionType,
            timestamp: Date.now(),
            data: JSON.parse(JSON.stringify(data))  // Deep clone
        });
        historyStoppedBecause = null;

        if (state.undoStack.length > state.MAX_UNDO_STEPS) {
            state.undoStack.shift();
        }
    }

    /** Forget the undo history after an action that can't be undone. */
    function clearUndoHistory(reason) {
        state.undoStack.length = 0;
        historyStoppedBecause = reason || null;
    }

    const UNDO_LABELS = {
        transform: 'sheet move',
        sheetProperty: 'sheet change',
        cut: 'cut',
        clearCut: 'clear cuts',
        assetAdjust: 'asset adjustment'
    };

    /**
     * Undo the last action
     */
    async function undo() {
        if (state.undoStack.length === 0) {
            DW.showToast(historyStoppedBecause
                ? `Nothing to undo since ${historyStoppedBecause}`
                : 'Nothing to undo', 'info');
            return;
        }

        const lastAction = state.undoStack.pop();
        try {
            switch (lastAction.type) {
                case 'transform':
                    await undoTransform(lastAction.data);
                    break;
                case 'sheetProperty':
                    await undoSheetProperty(lastAction.data);
                    break;
                case 'cut':
                    await undoCut(lastAction.data);
                    break;
                case 'clearCut':
                    await undoClearCut(lastAction.data);
                    break;
                case 'assetAdjust':
                    await undoAssetAdjust(lastAction.data);
                    break;
            }
            DW.showToast(`Undone: ${UNDO_LABELS[lastAction.type] || lastAction.type}`, 'success', 1500);
        } catch (error) {
            console.error('Undo failed:', error);
            DW.showToast('Could not undo: ' + error.message, 'error');
        }
    }

    async function undoSheetProperty(data) {
        const { sheetId, property, previous } = data;
        if (typeof selectSheet === 'function' &&
            (!state.selectedSheet || state.selectedSheet.id !== sheetId)) {
            selectSheet(sheetId);
        }
        if (typeof updateSheetProperty === 'function') {
            await updateSheetProperty(property, previous, false);
        }
        if (typeof selectSheet === 'function' && state.selectedSheet && state.selectedSheet.id === sheetId) {
            selectSheet(sheetId);
        }
    }

    async function undoAssetAdjust(data) {
        const { assetId, previousX, previousY } = data;
        const response = await fetch(`/api/assets/${assetId}/adjust/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': DW.getCSRFToken()
            },
            body: JSON.stringify({ x: previousX, y: previousY, notes: 'Undo' })
        });
        if (!response.ok) throw new Error(await DW.responseError(response));
        const updated = await response.json();
        const index = state.assets.findIndex(a => a.id === updated.id);
        if (index >= 0) state.assets[index] = updated;
        const wasSelected = state.selectedAsset && state.selectedAsset.id === updated.id;
        if (typeof refreshAssets === 'function') refreshAssets();
        if (wasSelected && typeof selectAsset === 'function') selectAsset(updated.id);
    }

    /**
     * Undo a sheet transform action (combined move + rotate)
     */
    async function undoTransform(data) {
        const { sheetId, previousX, previousY, previousRotation } = data;
        const canvas = state.canvas;

        const sheetObj = canvas.getObjects().find(obj =>
            obj.sheetData && obj.sheetData.id === sheetId
        );

        if (sheetObj) {
            sheetObj.set({
                left: previousX,
                top: previousY,
                angle: previousRotation
            });
            sheetObj.setCoords();
            canvas.renderAll();

            // Update local data
            const index = state.sheets.findIndex(s => s.id === sheetId);
            if (index >= 0) {
                state.sheets[index].offset_x = previousX;
                state.sheets[index].offset_y = previousY;
                state.sheets[index].rotation = previousRotation;
            }

            // Update properties panel if selected
            if (state.selectedSheet && state.selectedSheet.id === sheetId) {
                document.getElementById('sheet-offset-x').value = previousX;
                document.getElementById('sheet-offset-y').value = previousY;
                document.getElementById('sheet-rotation').value = previousRotation.toFixed(1);
                state.selectedSheet.offset_x = previousX;
                state.selectedSheet.offset_y = previousY;
                state.selectedSheet.rotation = previousRotation;
            }

            // Save to server
            const response = await fetch(`/api/sheets/${sheetId}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    offset_x: previousX,
                    offset_y: previousY,
                    rotation: previousRotation
                })
            });
            if (!response.ok) throw new Error(await DW.responseError(response));
            if (typeof replaceSheetData === 'function') replaceSheetData(await response.json());
        }
    }

    /**
     * Undo a cut action (remove the cut)
     */
    async function undoCut(data) {
        const { sheetId, previousCutData } = data;
        const canvas = state.canvas;

        const sheetObj = canvas.getObjects().find(obj =>
            obj.sheetData && obj.sheetData.id === sheetId
        );

        if (sheetObj) {
            if (previousCutData && previousCutData.length > 0) {
                state.sheetCutData[sheetId] = previousCutData;
                if (typeof applyAllCuts === 'function') {
                    applyAllCuts(sheetObj, previousCutData);
                }
            } else {
                sheetObj.clipPath = null;
                sheetObj._clipPolygon = null;
                if (sheetObj._originalRender) {
                    sheetObj._render = sheetObj._originalRender;
                    delete sheetObj._originalRender;
                }
                delete state.sheetCutData[sheetId];
                sheetObj.objectCaching = true;
                sheetObj.dirty = true;
                canvas.renderAll();
            }

            if (typeof saveCutData === 'function') {
                await saveCutData(sheetId, previousCutData || []);
            }
        }
    }

    /**
     * Undo a clear cut action (restore the cut)
     */
    async function undoClearCut(data) {
        const { sheetId, cutData } = data;

        if (!cutData || cutData.length === 0) return;

        const canvas = state.canvas;
        const sheetObj = canvas.getObjects().find(obj =>
            obj.sheetData && obj.sheetData.id === sheetId
        );

        if (sheetObj) {
            state.sheetCutData[sheetId] = cutData;
            if (typeof applyAllCuts === 'function') {
                applyAllCuts(sheetObj, cutData);
            }
            if (typeof saveCutData === 'function') {
                await saveCutData(sheetId, cutData);
            }
        }
    }

    // ==================== Public API ====================

    DW.undo = {
        saveUndoState,
        clearUndoHistory,
        undo
    };

    // Backward compatibility
    window.saveUndoState = saveUndoState;
    window.clearUndoHistory = clearUndoHistory;
    window.undo = undo;

})();
