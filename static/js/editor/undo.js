/**
 * DocuWeaver Canvas Editor - Undo System
 *
 * Manages undo stack for sheet transforms and cut operations.
 *
 * Depends on: namespace.js, crop.js (applyAllCuts, saveCutData)
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    /**
     * Save state for undo functionality
     * @param {string} actionType - Type of action: 'transform', 'cut', 'clearCut'
     * @param {object} data - State data to save
     */
    function saveUndoState(actionType, data) {
        state.undoStack.push({
            type: actionType,
            timestamp: Date.now(),
            data: JSON.parse(JSON.stringify(data))  // Deep clone
        });

        // Limit stack size
        if (state.undoStack.length > state.MAX_UNDO_STEPS) {
            state.undoStack.shift();
        }

        console.log('Undo state saved:', actionType, data);
    }

    /**
     * Undo the last action
     */
    async function undo() {
        if (state.undoStack.length === 0) {
            console.log('Nothing to undo');
            return;
        }

        const lastAction = state.undoStack.pop();
        console.log('Undoing action:', lastAction.type, lastAction.data);

        switch (lastAction.type) {
            case 'transform':
                await undoTransform(lastAction.data);
                break;
            case 'cut':
                await undoCut(lastAction.data);
                break;
            case 'clearCut':
                await undoClearCut(lastAction.data);
                break;
        }
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
            await fetch(`/api/sheets/${sheetId}/`, {
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
        undo
    };

    // Backward compatibility
    window.saveUndoState = saveUndoState;
    window.undo = undo;

    console.log('DocuWeaver undo module loaded');
})();
