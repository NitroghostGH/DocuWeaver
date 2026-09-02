/**
 * DocuWeaver Canvas Editor - Split Tool
 *
 * Splits a sheet into two independent pieces via a drawn line.
 *
 * Depends on: namespace.js, crop.js (applyAllCuts, updateCutStats, removeCutStats),
 *             sheets.js (renderSheetLayers, selectSheet), main.js (applyFiltersPreservingSize)
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    function handleSplitClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);

        // Find sheet under click - same methods as crop
        let clickedSheetObj = null;

        if (opt.target && opt.target.sheetData) {
            clickedSheetObj = opt.target;
        }

        if (!clickedSheetObj) {
            const foundObj = canvas.findTarget(opt.e, true);
            if (foundObj && foundObj.sheetData) {
                clickedSheetObj = foundObj;
            }
        }

        if (!clickedSheetObj) {
            canvas.getObjects().forEach(obj => {
                if (obj.sheetData) {
                    const bounds = obj.getBoundingRect();
                    if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                        pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                        clickedSheetObj = obj;
                    }
                }
            });
        }

        if (!state.isSplitting) {
            if (!clickedSheetObj) {
                console.log('Split line must start on a sheet');
                return;
            }

            state.splitTargetSheet = clickedSheetObj;
            if (typeof selectSheet === 'function') {
                selectSheet(state.splitTargetSheet.sheetData.id);
            }
            state.isSplitting = true;
            state.splitLineStart = pointer;

            // Draw the split line (green, different from cut)
            state.splitLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
                stroke: '#00ff00',
                strokeWidth: 1,
                strokeUniform: true,
                selectable: false,
                evented: false
            });
            canvas.add(state.splitLine);
            canvas.bringToFront(state.splitLine);
            canvas.renderAll();
        }
    }

    function handleSplitMove(opt) {
        if (!state.isSplitting || !state.splitLine || !state.splitLineStart) return;

        const pointer = state.canvas.getPointer(opt.e);
        state.splitLine.set({ x2: pointer.x, y2: pointer.y });
        if (typeof updateCutStats === 'function') {
            updateCutStats(state.splitLineStart, pointer);
        }
        state.canvas.renderAll();
    }

    async function handleSplitEnd(opt) {
        if (!state.isSplitting || !state.splitLine || !state.splitLineStart || !state.splitTargetSheet) return;

        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);

        const dx = pointer.x - state.splitLineStart.x;
        const dy = pointer.y - state.splitLineStart.y;
        const lineLength = Math.sqrt(dx * dx + dy * dy);

        if (lineLength > 20) {
            const invertedMatrix = fabric.util.invertTransform(state.splitTargetSheet.calcTransformMatrix());
            const localP1 = fabric.util.transformPoint(
                new fabric.Point(state.splitLineStart.x, state.splitLineStart.y), invertedMatrix
            );
            const localP2 = fabric.util.transformPoint(
                new fabric.Point(pointer.x, pointer.y), invertedMatrix
            );

            try {
                const response = await fetch(`/api/sheets/${state.splitTargetSheet.sheetData.id}/split/`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRFToken': DW.getCSRFToken()
                    },
                    body: JSON.stringify({
                        p1: { x: localP1.x, y: localP1.y },
                        p2: { x: localP2.x, y: localP2.y }
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    console.log('Sheet split successfully:', result);

                    // Append cut to original sheet's existing cuts
                    const originalId = state.splitTargetSheet.sheetData.id;
                    if (!state.sheetCutData[originalId]) {
                        state.sheetCutData[originalId] = [];
                    }
                    state.sheetCutData[originalId].push({
                        p1: { x: localP1.x, y: localP1.y },
                        p2: { x: localP2.x, y: localP2.y },
                        flipped: false
                    });
                    if (typeof applyAllCuts === 'function') {
                        applyAllCuts(state.splitTargetSheet, state.sheetCutData[originalId]);
                    }

                    // Add new sheet to local data and sidebar
                    const newSheet = result.new_sheet;
                    state.sheets.push(newSheet);
                    if (typeof renderSheetLayers === 'function') {
                        renderSheetLayers();
                    }

                    // Load the new sheet onto canvas
                    if (newSheet.rendered_image_url) {
                        fabric.Image.fromURL(newSheet.rendered_image_url, function(img) {
                            img.set({
                                left: newSheet.offset_x,
                                top: newSheet.offset_y,
                                angle: newSheet.rotation,
                                selectable: state.currentMode === 'select',
                                evented: true,
                                hasControls: false,
                                hasBorders: false,
                                lockScalingX: true,
                                lockScalingY: true,
                                lockUniScaling: true,
                                lockRotation: false,
                            });
                            img.sheetData = newSheet;
                            canvas.add(img);

                            // Apply PDF inversion FIRST
                            if (state.isPdfInverted) {
                                if (!img.filters) img.filters = [];
                                img.filters.push(new fabric.Image.filters.Invert());
                                if (typeof applyFiltersPreservingSize === 'function') {
                                    applyFiltersPreservingSize(img);
                                }
                            }

                            // Apply opposite cut from server response
                            const newCuts = newSheet.cuts_json || [];
                            if (newCuts.length > 0) {
                                state.sheetCutData[newSheet.id] = newCuts;
                                if (typeof applyAllCuts === 'function') {
                                    applyAllCuts(img, newCuts);
                                }
                            }

                            canvas.renderAll();
                        }, { crossOrigin: 'anonymous' });
                    }

                    alert('Sheet split successfully! The new sheet shows the opposite side.');
                } else {
                    const error = await response.json();
                    alert('Error splitting sheet: ' + JSON.stringify(error));
                }
            } catch (error) {
                console.error('Error splitting sheet:', error);
                alert('Error splitting sheet');
            }
        }

        // Clean up
        canvas.remove(state.splitLine);
        state.splitLine = null;
        state.splitLineStart = null;
        state.splitTargetSheet = null;
        state.isSplitting = false;
        if (typeof removeCutStats === 'function') {
            removeCutStats();
        }
    }

    // ==================== Public API ====================

    DW.split = {
        handleSplitClick,
        handleSplitMove,
        handleSplitEnd
    };

    // Backward compatibility
    window.handleSplitClick = handleSplitClick;
    window.handleSplitMove = handleSplitMove;
    window.handleSplitEnd = handleSplitEnd;

    console.log('DocuWeaver split module loaded');
})();
