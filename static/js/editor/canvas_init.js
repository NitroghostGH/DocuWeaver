/**
 * DocuWeaver Canvas Editor - Canvas Initialization Module
 * 
 * Handles canvas creation, Fabric.js setup, and basic event handlers.
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Canvas Initialization ====================
    
    /**
     * Initialize the Fabric.js canvas
     */
    function initCanvas() {
        const container = document.getElementById('canvas-container');
        const containerRect = container.getBoundingClientRect();
        
        // Create canvas element
        const canvasEl = document.createElement('canvas');
        canvasEl.id = 'main-canvas';
        container.appendChild(canvasEl);
        
        // Initialize Fabric canvas
        state.canvas = new fabric.Canvas('main-canvas', {
            width: containerRect.width,
            height: containerRect.height,
            backgroundColor: '#e0e0e0',
            selection: false
        });
        
        // Sync to legacy global
        window.canvas = state.canvas;
        
        // Force Canvas2D filter backend instead of WebGL
        // WebGL has a 2048px tileSize that breaks large images
        fabric.filterBackend = new fabric.Canvas2dFilterBackend();
        
        // Apply custom viewport culling for rotation support
        applyViewportCullingFix();
        
        // Override getZoom to work with rotation
        state.canvas.getZoom = function() {
            return state.currentZoomLevel;
        };
        
        // Setup event handlers
        setupCanvasEvents();
        setupKeyboardShortcuts();
        
        // Initialize MeasurementTool
        if (typeof MeasurementTool !== 'undefined' && typeof PROJECT_ID !== 'undefined') {
            MeasurementTool.init(state.canvas, PROJECT_ID);
        }
        
        // Handle window resize
        window.addEventListener('resize', function() {
            const rect = container.getBoundingClientRect();
            state.canvas.setDimensions({ width: rect.width, height: rect.height });
            state.canvas.renderAll();
        });
        
        console.log('Canvas initialized');
    }
    
    /**
     * Fix viewport culling for rotated canvas
     * Fabric.js default culling breaks with rotation
     */
    function applyViewportCullingFix() {
        fabric.Object.prototype.isOnScreen = function(calculateCoords) {
            // Always render important object types
            if (this.sheetData || this.isOSMTile || this.isLinkObject ||
                this.isMeasurement || this.isMeasurementGroup || this.isSavedMeasurement) {
                return true;
            }

            const canvasEl = this.canvas;
            if (!canvasEl) return true;

            // Use aCoords (already calculated by Fabric) when available, avoiding expensive getBoundingRect
            const coords = this.aCoords;
            if (coords) {
                const bufferX = canvasEl.width * 0.5;
                const bufferY = canvasEl.height * 0.5;

                // Get screen-space bounds from aCoords
                const vpt = canvasEl.viewportTransform;
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const key in coords) {
                    const pt = coords[key];
                    const sx = pt.x * vpt[0] + pt.y * vpt[2] + vpt[4];
                    const sy = pt.x * vpt[1] + pt.y * vpt[3] + vpt[5];
                    if (sx < minX) minX = sx;
                    if (sy < minY) minY = sy;
                    if (sx > maxX) maxX = sx;
                    if (sy > maxY) maxY = sy;
                }

                return !(maxX < -bufferX ||
                        minX > canvasEl.width + bufferX ||
                        maxY < -bufferY ||
                        minY > canvasEl.height + bufferY);
            }

            // Fallback for objects without aCoords
            const objBounds = this.getBoundingRect(true, true);
            if (!objBounds) return true;

            const bufferX = canvasEl.width * 0.5;
            const bufferY = canvasEl.height * 0.5;

            return !(objBounds.left + objBounds.width < -bufferX ||
                    objBounds.left > canvasEl.width + bufferX ||
                    objBounds.top + objBounds.height < -bufferY ||
                    objBounds.top > canvasEl.height + bufferY);
        };
    }
    
    // ==================== Canvas Events ====================
    
    let isPanning = false;
    let isMiddleClickPanning = false;
    let lastPosX, lastPosY;
    let interactionStartState = null;
    let lastMeasureMoveTime = 0;
    const MEASURE_MOVE_THROTTLE_MS = 32; // ~30fps for measurement preview
    
    function setupCanvasEvents() {
        const canvas = state.canvas;
        
        canvas.on('mouse:down', handleMouseDown);
        canvas.on('mouse:move', handleMouseMove);
        canvas.on('mouse:up', handleMouseUp);
        canvas.on('mouse:wheel', handleMouseWheel);
        canvas.on('object:moving', handleObjectMoving);
        canvas.on('object:modified', handleObjectModified);
        canvas.on('object:rotating', handleObjectRotating);
        canvas.on('selection:created', handleSelectionCreated);
        canvas.on('selection:updated', handleSelectionUpdated);
        canvas.on('selection:cleared', handleSelectionCleared);
        
        // Right-click context menu for measurement
        canvas.upperCanvasEl.addEventListener('contextmenu', handleContextMenu);
    }
    
    function handleMouseDown(opt) {
        const evt = opt.e;
        const canvas = state.canvas;
        
        // Capture state for undo
        const target = opt.target;
        if (target && target.sheetData && state.currentMode === 'select') {
            interactionStartState = {
                sheetId: target.sheetData.id,
                left: target.left,
                top: target.top,
                angle: target.angle
            };
        }
        
        // Middle click - end chain measurement or pan
        if (evt.button === 1) {
            evt.preventDefault();
            if (state.currentMode === 'measure' && MeasurementTool.getCurrentMode() === 'chain') {
                MeasurementTool.endMeasurement();
                return;
            }
            isMiddleClickPanning = true;
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
            canvas.defaultCursor = 'grabbing';
            return;
        }
        
        // Mode-specific handling
        switch (state.currentMode) {
            case 'pan':
                isPanning = true;
                lastPosX = evt.clientX;
                lastPosY = evt.clientY;
                canvas.defaultCursor = 'grabbing';
                break;
            case 'select':
                DW.tools.handleSelectClick(opt);
                break;
            case 'crop':
                DW.tools.handleCropClick(opt);
                break;
            case 'split':
                DW.tools.handleSplitClick(opt);
                break;
            case 'calibrate':
                DW.tools.handleCalibrationClick(opt);
                break;
            case 'origin':
                DW.tools.handleOriginClick(opt);
                break;
            case 'verify-asset':
                DW.tools.handleVerifyClick(opt);
                break;
            case 'measure':
                DW.tools.handleMeasureClick(opt);
                break;
        }
    }
    
    function handleMouseMove(opt) {
        const evt = opt.e;
        const canvas = state.canvas;
        
        // Update cursor position display
        if (typeof updateCursorPosition === 'function') {
            updateCursorPosition(opt);
        }
        
        // Middle-click panning
        if (isMiddleClickPanning) {
            const vpt = canvas.viewportTransform;
            vpt[4] += evt.clientX - lastPosX;
            vpt[5] += evt.clientY - lastPosY;
            canvas.requestRenderAll();
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
            return;
        }
        
        // Mode-specific handling
        if (state.currentMode === 'pan' && isPanning) {
            const vpt = canvas.viewportTransform;
            vpt[4] += evt.clientX - lastPosX;
            vpt[5] += evt.clientY - lastPosY;
            canvas.requestRenderAll();
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
        } else if (state.currentMode === 'crop' && state.isCropping) {
            DW.tools.handleCropMove(opt);
        } else if (state.currentMode === 'split' && state.isSplitting) {
            DW.tools.handleSplitMove(opt);
        } else if (state.currentMode === 'measure') {
            const now = performance.now();
            if (now - lastMeasureMoveTime >= MEASURE_MOVE_THROTTLE_MS) {
                lastMeasureMoveTime = now;
                const pointer = canvas.getPointer(evt);
                MeasurementTool.handleMouseMove(pointer.x, pointer.y);
            }
        }
    }
    
    function handleMouseUp(opt) {
        const evt = opt.e;
        const canvas = state.canvas;
        
        // Middle-click release
        if (evt.button === 1) {
            isMiddleClickPanning = false;
            canvas.defaultCursor = state.currentMode === 'pan' ? 'grab' : 'default';
            if (typeof debouncedRefreshOSM === 'function') debouncedRefreshOSM();
            if (typeof debouncedSaveViewportState === 'function') debouncedSaveViewportState();
            return;
        }
        
        // Pan release
        if (state.currentMode === 'pan' && isPanning) {
            isPanning = false;
            canvas.defaultCursor = 'grab';
            if (typeof debouncedRefreshOSM === 'function') debouncedRefreshOSM();
            if (typeof debouncedSaveViewportState === 'function') debouncedSaveViewportState();
        } else if (state.currentMode === 'crop') {
            DW.tools.handleCropEnd(opt);
        } else if (state.currentMode === 'split') {
            DW.tools.handleSplitEnd(opt);
        }
    }
    
    function handleMouseWheel(opt) {
        const evt = opt.e;
        evt.preventDefault();
        evt.stopPropagation();
        
        const canvas = state.canvas;
        const delta = evt.deltaY;
        let zoom = state.currentZoomLevel;
        
        zoom *= 0.999 ** delta;
        if (zoom > 5) zoom = 5;
        if (zoom < 0.1) zoom = 0.1;
        
        // Get mouse position relative to canvas element (in screen/DOM pixels)
        const rect = canvas.upperCanvasEl.getBoundingClientRect();
        const screenPoint = {
            x: evt.clientX - rect.left,
            y: evt.clientY - rect.top
        };
        
        
        if (typeof zoomToScreenPoint === 'function') {
            zoomToScreenPoint(screenPoint, zoom);
        } else if (typeof zoomToPoint === 'function') {
            // Fallback to old method
            const pointer = canvas.getPointer(evt);
            zoomToPoint(pointer, zoom);
        } else if (typeof setZoomPreservingRotation === 'function') {
            setZoomPreservingRotation(zoom);
            if (typeof updateZoomDisplay === 'function') updateZoomDisplay();
        } else {
            state.currentZoomLevel = zoom;
        }
        
        if (typeof debouncedRefreshOSM === 'function') debouncedRefreshOSM();
        if (typeof debouncedSaveViewportState === 'function') debouncedSaveViewportState();
    }
    
    function handleObjectMoving(opt) {
        const obj = opt.target;
        if (obj && obj.assetData) {
            if (typeof updateAssetPositionFromCanvas === 'function') {
                updateAssetPositionFromCanvas(obj);
            }
        }
    }
    
    function handleObjectModified(opt) {
        const obj = opt.target;
        if (!obj) return;
        
        // Save undo state
        if (interactionStartState && obj.sheetData && 
            obj.sheetData.id === interactionStartState.sheetId) {
            
            const hasMoved = obj.left !== interactionStartState.left || 
                            obj.top !== interactionStartState.top;
            const hasRotated = obj.angle !== interactionStartState.angle;
            
            if (hasMoved || hasRotated) {
                if (typeof saveUndoState === 'function') {
                    saveUndoState('transform', {
                        sheetId: interactionStartState.sheetId,
                        previousX: interactionStartState.left,
                        previousY: interactionStartState.top,
                        previousRotation: interactionStartState.angle
                    });
                }
            }
            interactionStartState = null;
        }
        
        // Save changes
        if (obj.sheetData) {
            if (typeof updateSheetPositionFromCanvas === 'function') {
                updateSheetPositionFromCanvas(obj);
            }
            if (typeof updateSheetRotationFromCanvas === 'function') {
                updateSheetRotationFromCanvas(obj);
            }
        } else if (obj.assetData) {
            if (typeof saveAssetAdjustment === 'function') {
                saveAssetAdjustment();
            }
        }
    }
    
    function handleObjectRotating(opt) {
        const obj = opt.target;
        if (obj && obj.sheetData && state.selectedSheet && 
            state.selectedSheet.id === obj.sheetData.id) {
            document.getElementById('sheet-rotation').value = obj.angle.toFixed(1);
        }
    }
    
    function handleSelectionCreated(opt) {
        const target = opt.selected ? opt.selected[0] : null;
        if (target) {
            if (target.sheetData) {
                if (typeof selectSheet === 'function') {
                    selectSheet(target.sheetData.id);
                }
            } else if (target.assetData) {
                if (typeof selectAsset === 'function') {
                    selectAsset(target.assetData.id);
                }
            } else if (target.measurementSetId) {
                if (typeof selectMeasurement === 'function') {
                    selectMeasurement(target.measurementSetId);
                }
            }
        }
    }
    
    function handleSelectionUpdated(opt) {
        handleSelectionCreated(opt);
    }
    
    function handleSelectionCleared() {
        if (typeof clearSelection === 'function') {
            clearSelection();
        }
    }
    
    function handleContextMenu(e) {
        if (state.currentMode === 'measure' && MeasurementTool.getCurrentMode() === 'chain') {
            e.preventDefault();
            MeasurementTool.endMeasurement();
        }
    }
    
    // ==================== Keyboard Shortcuts ====================
    
    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', function(e) {
            // Skip if typing in an input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }
            
            switch (e.key.toLowerCase()) {
                case 'escape':
                    if (state.currentMode === 'measure') {
                        MeasurementTool.clearCurrent();
                    }
                    if (typeof setMode === 'function') setMode('pan');
                    break;
                case 'delete':
                case 'backspace':
                    if (state.selectedMeasurementId && state.currentMode === 'select') {
                        e.preventDefault();
                        if (typeof deleteSelectedMeasurement === 'function') {
                            deleteSelectedMeasurement();
                        }
                    }
                    break;
                case 'z':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        if (typeof undo === 'function') undo();
                    }
                    break;
                case 'p':
                    if (typeof setMode === 'function') setMode('pan');
                    break;
                case 's':
                    if (typeof setMode === 'function') setMode('select');
                    break;
                case 'm':
                    if (typeof setMode === 'function') setMode('measure');
                    break;
                case '=':
                case '+':
                    if (typeof zoomIn === 'function') zoomIn();
                    break;
                case '-':
                    if (typeof zoomOut === 'function') zoomOut();
                    break;
            }
        });
    }
    
    // ==================== Public API ====================
    
    DW.canvas = {
        init: initCanvas,
        setupEvents: setupCanvasEvents,
        setupKeyboardShortcuts: setupKeyboardShortcuts
    };
    
    // Auto-initialize if DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            // Don't auto-init - let main.js control initialization order
        });
    }
    
    console.log('DocuWeaver canvas module loaded');
})();
