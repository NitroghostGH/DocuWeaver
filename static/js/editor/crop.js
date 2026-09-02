/**
 * DocuWeaver Canvas Editor - Crop/Cut Tool
 *
 * Handles sheet cutting, polygon clipping, flip/clear operations,
 * and the cut stats overlay.
 *
 * Depends on: namespace.js, undo.js (saveUndoState)
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    // ==================== Cut Stats Overlay ====================

    function updateCutStats(startPt, endPt) {
        const canvas = state.canvas;
        const dx = endPt.x - startPt.x;
        const dy = endPt.y - startPt.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angleDeg = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;

        const label = `${angleDeg.toFixed(1)}\u00b0  ${Math.round(length)}px`;
        const midX = (startPt.x + endPt.x) / 2;
        const midY = (startPt.y + endPt.y) / 2;

        if (!state.cutStatsLabel) {
            state.cutStatsLabel = new fabric.Text(label, {
                left: midX,
                top: midY - 20,
                fontSize: 13,
                fill: '#ffffff',
                backgroundColor: 'rgba(0,0,0,0.7)',
                fontFamily: 'monospace',
                padding: 4,
                selectable: false,
                evented: false
            });
            canvas.add(state.cutStatsLabel);
        } else {
            state.cutStatsLabel.set({ text: label, left: midX, top: midY - 20 });
        }
        canvas.bringToFront(state.cutStatsLabel);
    }

    function removeCutStats() {
        if (state.cutStatsLabel) {
            state.canvas.remove(state.cutStatsLabel);
            state.cutStatsLabel = null;
        }
    }

    // ==================== Point-in-Visible-Area ====================

    function isPointInVisibleArea(obj, pointer) {
        if (!obj._clipPolygon) return true;

        // Convert pointer to object-local coordinates
        const point = new fabric.Point(pointer.x, pointer.y);
        const invertedMatrix = fabric.util.invertTransform(obj.calcTransformMatrix());
        const localPoint = fabric.util.transformPoint(point, invertedMatrix);

        // Ray-casting point-in-polygon test
        var inside = false;
        var poly = obj._clipPolygon;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            var xi = poly[i].x, yi = poly[i].y;
            var xj = poly[j].x, yj = poly[j].y;
            if (((yi > localPoint.y) !== (yj > localPoint.y)) &&
                (localPoint.x < (xj - xi) * (localPoint.y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    // ==================== Crop Tool Handlers ====================

    function handleCropClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);

        // Find sheet under click - try multiple methods for reliability
        let clickedSheetObj = null;

        // Method 1: Use opt.target if available
        if (opt.target && opt.target.sheetData) {
            clickedSheetObj = opt.target;
        }

        // Method 2: Use findTarget with event
        if (!clickedSheetObj) {
            const foundObj = canvas.findTarget(opt.e, true);
            if (foundObj && foundObj.sheetData) {
                clickedSheetObj = foundObj;
            }
        }

        // Method 3: Use getBoundingRect for proper rotation handling
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

        // Method 4: Check if point is in visible area (not clipped)
        if (clickedSheetObj && clickedSheetObj._clipPolygon) {
            if (!isPointInVisibleArea(clickedSheetObj, pointer)) {
                const clippedSheet = clickedSheetObj;
                clickedSheetObj = null;
                canvas.getObjects().forEach(obj => {
                    if (obj.sheetData && obj !== clippedSheet) {
                        const bounds = obj.getBoundingRect();
                        if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                            pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                            if (!obj._clipPolygon || isPointInVisibleArea(obj, pointer)) {
                                clickedSheetObj = obj;
                            }
                        }
                    }
                });
            }
        }

        if (!state.isCropping) {
            if (!clickedSheetObj) {
                console.log('Cut line must start on a sheet');
                return;
            }

            state.targetSheetObj = clickedSheetObj;
            if (typeof selectSheet === 'function') {
                selectSheet(state.targetSheetObj.sheetData.id);
            }
            state.isCropping = true;
            state.cutLineStart = pointer;

            // Draw the cut line
            state.cutLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
                stroke: '#ff0000',
                strokeWidth: 1,
                strokeUniform: true,
                selectable: false,
                evented: false
            });
            canvas.add(state.cutLine);
            canvas.bringToFront(state.cutLine);
            canvas.renderAll();
        }
    }

    function handleCropMove(opt) {
        if (!state.isCropping || !state.cutLine || !state.cutLineStart) return;

        const pointer = state.canvas.getPointer(opt.e);
        state.cutLine.set({ x2: pointer.x, y2: pointer.y });
        updateCutStats(state.cutLineStart, pointer);
        state.canvas.renderAll();
    }

    function handleCropEnd(opt) {
        if (!state.isCropping || !state.cutLine || !state.cutLineStart || !state.targetSheetObj) return;

        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);

        // Calculate line length
        const dx = pointer.x - state.cutLineStart.x;
        const dy = pointer.y - state.cutLineStart.y;
        const lineLength = Math.sqrt(dx * dx + dy * dy);

        if (lineLength > 20) {
            applyCutMask(state.targetSheetObj, state.cutLineStart, pointer);
        }

        // Clean up
        canvas.remove(state.cutLine);
        state.cutLine = null;
        state.cutLineStart = null;
        state.targetSheetObj = null;
        state.isCropping = false;
        removeCutStats();
    }

    // ==================== Cut Mask Application ====================

    function applyCutMask(sheetObj, p1, p2) {
        const sheetId = sheetObj.sheetData.id;

        // Save undo state
        const previousCuts = state.sheetCutData[sheetId]
            ? JSON.parse(JSON.stringify(state.sheetCutData[sheetId]))
            : null;
        if (typeof saveUndoState === 'function') {
            saveUndoState('cut', {
                sheetId: sheetId,
                previousCutData: previousCuts
            });
        }

        // Convert canvas-space to sheet-local coordinates
        const invertedMatrix = fabric.util.invertTransform(sheetObj.calcTransformMatrix());
        const localP1 = fabric.util.transformPoint(new fabric.Point(p1.x, p1.y), invertedMatrix);
        const localP2 = fabric.util.transformPoint(new fabric.Point(p2.x, p2.y), invertedMatrix);

        const newCut = {
            p1: { x: localP1.x, y: localP1.y },
            p2: { x: localP2.x, y: localP2.y },
            flipped: false
        };

        if (!state.sheetCutData[sheetId]) {
            state.sheetCutData[sheetId] = [];
        }
        state.sheetCutData[sheetId].push(newCut);

        applyAllCuts(sheetObj, state.sheetCutData[sheetId]);
        saveCutData(sheetId, state.sheetCutData[sheetId]);
        console.log('Cut added to sheet:', sheetObj.sheetData.name,
                    'Total cuts:', state.sheetCutData[sheetId].length);
    }

    // ==================== Polygon Clipping ====================

    /**
     * Sutherland-Hodgman polygon clipping: clips polygon against one half-plane.
     * Points on the LEFT side of edgeP1->edgeP2 are kept.
     */
    function clipPolygonByEdge(subjectPolygon, edgeP1, edgeP2) {
        if (subjectPolygon.length === 0) return [];

        const output = [];
        const edgeDx = edgeP2.x - edgeP1.x;
        const edgeDy = edgeP2.y - edgeP1.y;

        function cross(point) {
            return edgeDx * (point.y - edgeP1.y) - edgeDy * (point.x - edgeP1.x);
        }

        function intersection(a, b) {
            const ca = cross(a);
            const cb = cross(b);
            const denom = ca - cb;
            if (Math.abs(denom) < 1e-10) {
                return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            }
            const t = ca / denom;
            return {
                x: a.x + t * (b.x - a.x),
                y: a.y + t * (b.y - a.y)
            };
        }

        for (let i = 0; i < subjectPolygon.length; i++) {
            const current = subjectPolygon[i];
            const next = subjectPolygon[(i + 1) % subjectPolygon.length];
            const currentInside = cross(current) >= 0;
            const nextInside = cross(next) >= 0;

            if (currentInside) {
                output.push(current);
                if (!nextInside) {
                    output.push(intersection(current, next));
                }
            } else if (nextInside) {
                output.push(intersection(current, next));
            }
        }

        return output;
    }

    /**
     * Compute the intersection of multiple half-plane cuts into a single polygon.
     */
    function computeMultiCutPolygon(sheetObj, cuts) {
        const imgWidth = sheetObj.width;
        const imgHeight = sheetObj.height;
        const padding = Math.max(imgWidth, imgHeight) * 0.6;

        // Start with a rectangle covering the full image in local coords
        let polygon = [
            { x: -imgWidth / 2 - padding, y: -imgHeight / 2 - padding },
            { x:  imgWidth / 2 + padding, y: -imgHeight / 2 - padding },
            { x:  imgWidth / 2 + padding, y:  imgHeight / 2 + padding },
            { x: -imgWidth / 2 - padding, y:  imgHeight / 2 + padding }
        ];

        for (const cut of cuts) {
            const localP1 = { x: cut.p1.x, y: cut.p1.y };
            const localP2 = { x: cut.p2.x, y: cut.p2.y };

            const dx = localP2.x - localP1.x;
            const dy = localP2.y - localP1.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len === 0) continue;

            let px = -dy / len;
            let py =  dx / len;

            const midX = (localP1.x + localP2.x) / 2;
            const midY = (localP1.y + localP2.y) / 2;
            const dotProduct = (0 - midX) * px + (0 - midY) * py;
            if (dotProduct < 0) {
                px = -px;
                py = -py;
            }

            if (cut.flipped) {
                px = -px;
                py = -py;
            }

            const leftPx = -dy / len;
            const leftPy =  dx / len;
            const isLeftSide = (px * leftPx + py * leftPy) > 0;

            let edgeP1, edgeP2;
            if (isLeftSide) {
                edgeP1 = localP1;
                edgeP2 = localP2;
            } else {
                edgeP1 = localP2;
                edgeP2 = localP1;
            }

            polygon = clipPolygonByEdge(polygon, edgeP1, edgeP2);
            if (polygon.length === 0) return null;
        }

        return polygon.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    }

    /**
     * Apply all cuts for a sheet, computing the composite clip polygon.
     * Uses native Canvas 2D clip() instead of Fabric.js clipPath.
     */
    function applyAllCuts(sheetObj, cuts) {
        const canvas = state.canvas;

        if (!cuts || cuts.length === 0) {
            sheetObj._clipPolygon = null;
            sheetObj.clipPath = null;
            if (sheetObj._originalRender) {
                sheetObj._render = sheetObj._originalRender;
                delete sheetObj._originalRender;
            }
            sheetObj.objectCaching = true;
            sheetObj.dirty = true;
            canvas.renderAll();
            return;
        }

        const polygon = computeMultiCutPolygon(sheetObj, cuts);

        if (!polygon || polygon.length < 3) {
            console.warn('All cuts clip away the entire sheet');
            sheetObj._clipPolygon = null;
            sheetObj.clipPath = null;
            sheetObj.dirty = true;
            canvas.renderAll();
            return;
        }

        sheetObj._clipPolygon = polygon;
        sheetObj.clipPath = null;

        if (!sheetObj._originalRender) {
            sheetObj._originalRender = sheetObj._render;
        }
        sheetObj._render = function(ctx) {
            if (this._clipPolygon && this._clipPolygon.length >= 3 && !this._showUncut) {
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(this._clipPolygon[0].x, this._clipPolygon[0].y);
                for (var i = 1; i < this._clipPolygon.length; i++) {
                    ctx.lineTo(this._clipPolygon[i].x, this._clipPolygon[i].y);
                }
                ctx.closePath();
                ctx.clip();
            }
            this._originalRender(ctx);
            if (this._clipPolygon && !this._showUncut) {
                ctx.restore();
            }
        };

        sheetObj.objectCaching = false;
        sheetObj.dirty = true;
        canvas.renderAll();
        if (typeof updateContextTools === 'function') {
            updateContextTools();
        }
    }

    /**
     * Backward-compatible wrapper for single-cut callers.
     */
    function applyCutMaskWithDirection(sheetObj, p1, p2, flipped) {
        applyAllCuts(sheetObj, [{ p1, p2, flipped }]);
    }

    // ==================== Cut Data Persistence ====================

    async function saveCutData(sheetId, cuts) {
        try {
            const response = await fetch(`/api/sheets/${sheetId}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    cuts_json: cuts
                })
            });
            if (response.ok) {
                console.log('Cut data saved, count:', cuts.length);
            }
        } catch (error) {
            console.error('Error saving cut data:', error);
        }
    }

    // ==================== Cut Management ====================

    function clearSheetCut(sheetId) {
        const canvas = state.canvas;
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData && obj.sheetData.id === sheetId) {
                obj.clipPath = null;
                obj._clipPolygon = null;
                if (obj._originalRender) {
                    obj._render = obj._originalRender;
                    delete obj._originalRender;
                }
                obj.objectCaching = true;
                obj.dirty = true;
                canvas.renderAll();
            }
        });
    }

    function clearSelectedSheetCut() {
        if (!state.selectedSheet) {
            console.log('No sheet selected for clearing cut');
            return;
        }

        const existingCuts = state.sheetCutData[state.selectedSheet.id];
        if (existingCuts && existingCuts.length > 0) {
            if (typeof saveUndoState === 'function') {
                saveUndoState('clearCut', {
                    sheetId: state.selectedSheet.id,
                    cutData: JSON.parse(JSON.stringify(existingCuts))
                });
            }
        }

        clearSheetCut(state.selectedSheet.id);
        delete state.sheetCutData[state.selectedSheet.id];

        saveCutData(state.selectedSheet.id, []);
        console.log('All cuts cleared from sheet:', state.selectedSheet.name);
        if (typeof updateContextTools === 'function') {
            updateContextTools();
        }
    }

    function flipSelectedSheetCut() {
        if (!state.selectedSheet) {
            console.log('No sheet selected for flip');
            return;
        }

        const cuts = state.sheetCutData[state.selectedSheet.id];
        if (!cuts || cuts.length === 0) {
            console.log('No cut data to flip');
            return;
        }

        const sheetObj = state.canvas.getObjects().find(obj =>
            obj.sheetData && obj.sheetData.id === state.selectedSheet.id
        );
        if (!sheetObj) return;

        const lastCut = cuts[cuts.length - 1];
        lastCut.flipped = !lastCut.flipped;

        applyAllCuts(sheetObj, cuts);
        saveCutData(state.selectedSheet.id, cuts);
    }

    function toggleShowUncut() {
        if (!state.selectedSheet) return;

        const canvas = state.canvas;
        const sheetId = state.selectedSheet.id;
        const sheetObj = canvas.getObjects().find(obj =>
            obj.sheetData && obj.sheetData.id === sheetId
        );
        if (!sheetObj || !sheetObj._clipPolygon) return;

        if (state.showUncutSheetId === sheetId) {
            state.showUncutSheetId = null;
            sheetObj._showUncut = false;
        } else {
            if (state.showUncutSheetId !== null) {
                const prevObj = canvas.getObjects().find(obj =>
                    obj.sheetData && obj.sheetData.id === state.showUncutSheetId
                );
                if (prevObj) {
                    prevObj._showUncut = false;
                    prevObj.dirty = true;
                }
            }
            state.showUncutSheetId = sheetId;
            sheetObj._showUncut = true;
        }
        sheetObj.dirty = true;
        canvas.renderAll();
        if (typeof updateContextTools === 'function') {
            updateContextTools();
        }
    }

    // ==================== Public API ====================

    DW.crop = {
        updateCutStats,
        removeCutStats,
        isPointInVisibleArea,
        handleCropClick,
        handleCropMove,
        handleCropEnd,
        applyCutMask,
        clipPolygonByEdge,
        computeMultiCutPolygon,
        applyAllCuts,
        applyCutMaskWithDirection,
        saveCutData,
        clearSheetCut,
        clearSelectedSheetCut,
        flipSelectedSheetCut,
        toggleShowUncut
    };

    // Backward compatibility
    window.updateCutStats = updateCutStats;
    window.removeCutStats = removeCutStats;
    window.isPointInVisibleArea = isPointInVisibleArea;
    window.handleCropClick = handleCropClick;
    window.handleCropMove = handleCropMove;
    window.handleCropEnd = handleCropEnd;
    window.applyCutMask = applyCutMask;
    window.clipPolygonByEdge = clipPolygonByEdge;
    window.computeMultiCutPolygon = computeMultiCutPolygon;
    window.applyAllCuts = applyAllCuts;
    window.applyCutMaskWithDirection = applyCutMaskWithDirection;
    window.saveCutData = saveCutData;
    window.clearSheetCut = clearSheetCut;
    window.clearSelectedSheetCut = clearSelectedSheetCut;
    window.flipSelectedSheetCut = flipSelectedSheetCut;
    window.toggleShowUncut = toggleShowUncut;

    console.log('DocuWeaver crop module loaded');
})();
