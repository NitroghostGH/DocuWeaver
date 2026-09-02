/**
 * DocuWeaver Canvas Editor - Tools Module
 * 
 * Handles tool modes and tool-specific click/move/end handlers.
 * Includes: pan, select, crop, split, calibrate, origin, verify-asset, measure
 * 
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Mode Management ====================
    
    /**
     * Set the current tool mode
     */
    function setMode(mode) {
        const canvas = state.canvas;
        console.log('setMode:', mode, '(was:', state.currentMode + ')');
        
        // Clean up measurement overlays when leaving measure mode
        if (state.currentMode === 'measure' && mode !== 'measure') {
            if (typeof clearMeasurements === 'function') {
                clearMeasurements();
            }
        }
        
        state.currentMode = mode;
        window.currentMode = mode; // Legacy sync
        
        // Toggle measure panel visibility
        const measureSection = document.getElementById('measure-section');
        if (measureSection) {
            measureSection.style.display = (mode === 'measure') ? 'block' : 'none';
        }
        
        // Move measurement layer section to top when in measure mode
        if (mode === 'measure' && typeof moveMeasurementSectionToTop === 'function') {
            moveMeasurementSectionToTop();
        }
        
        // Auto-deselect when leaving select mode
        if (mode !== 'select' && typeof clearSelection === 'function') {
            clearSelection();
        }
        
        // Update button states
        document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        document.querySelectorAll('.ftool-btn[data-mode]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === mode);
        });
        
        // Update cursor and selectability
        const isSelectMode = (mode === 'select');
        const isCropOrSplitMode = (mode === 'crop' || mode === 'split');
        
        switch (mode) {
            case 'pan':
                canvas.defaultCursor = 'grab';
                canvas.selection = false;
                break;
            case 'select':
                canvas.defaultCursor = 'default';
                canvas.selection = true;
                break;
            case 'crop':
            case 'split':
            case 'calibrate':
            case 'origin':
            case 'verify-asset':
            case 'measure':
                canvas.defaultCursor = 'crosshair';
                canvas.selection = false;
                break;
        }
        
        // Reset calibration points when entering calibrate mode
        if (mode === 'calibrate') {
            state.calibrationPoints = [];
        }
        
        // Start measurement tool when entering measure mode
        if (mode === 'measure' && typeof MeasurementTool !== 'undefined') {
            MeasurementTool.startMeasurement(state.measureMode || 'single');
            if (typeof populateConfigTypeSelect === 'function') {
                populateConfigTypeSelect();
            }
        }
        
        // Update object selectability
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) {
                obj.selectable = isSelectMode;
                obj.evented = isSelectMode || isCropOrSplitMode;
                obj.hoverCursor = isCropOrSplitMode ? 'crosshair' : 'move';
            }
            if (obj.isSavedMeasurement) {
                obj.selectable = isSelectMode;
                obj.evented = isSelectMode;
            }
        });

        canvas.requestRenderAll();
        
        // Update mode display
        const modeDisplay = document.getElementById('current-mode');
        if (modeDisplay) {
            modeDisplay.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
        }
    }
    
    // ==================== Select Tool ====================
    
    function handleSelectClick(opt) {
        const target = opt.target;
        
        if (target) {
            if (target.sheetData && typeof selectSheet === 'function') {
                selectSheet(target.sheetData.id);
            } else if (target.assetData && typeof selectAsset === 'function') {
                selectAsset(target.assetData.id);
            } else if (target.linkData && typeof selectLink === 'function') {
                selectLink(target.linkData.id);
            }
        } else if (typeof clearSelection === 'function') {
            clearSelection();
        }
    }
    
    // ==================== Crop Tool ====================
    
    function handleCropClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        // Find sheet under click
        let clickedSheetObj = findSheetAtPoint(opt, pointer);
        
        if (!state.isCropping) {
            // Start crop line
            if (clickedSheetObj) {
                state.isCropping = true;
                state.targetSheetObj = clickedSheetObj;
                state.cutLineStart = pointer;
                
                state.cutLine = new fabric.Line(
                    [pointer.x, pointer.y, pointer.x, pointer.y],
                    {
                        stroke: '#e74c3c',
                        strokeWidth: 2,
                        strokeDashArray: [5, 5],
                        selectable: false,
                        evented: false
                    }
                );
                canvas.add(state.cutLine);
            }
        }
    }
    
    function handleCropMove(opt) {
        if (!state.isCropping || !state.cutLine || !state.cutLineStart) return;
        
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        state.cutLine.set({ x2: pointer.x, y2: pointer.y });
        
        if (typeof updateCutStats === 'function') {
            updateCutStats(state.cutLineStart, pointer);
        }
        
        canvas.renderAll();
    }
    
    function handleCropEnd(opt) {
        if (!state.isCropping || !state.cutLine || !state.cutLineStart || !state.targetSheetObj) return;
        
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        // Calculate line length
        const dx = pointer.x - state.cutLineStart.x;
        const dy = pointer.y - state.cutLineStart.y;
        const lineLength = Math.sqrt(dx * dx + dy * dy);
        
        if (lineLength > 20 && typeof applyCutMask === 'function') {
            applyCutMask(state.targetSheetObj, state.cutLineStart, pointer);
        }
        
        // Clean up
        canvas.remove(state.cutLine);
        state.cutLine = null;
        state.cutLineStart = null;
        state.targetSheetObj = null;
        state.isCropping = false;
        
        if (typeof removeCutStats === 'function') {
            removeCutStats();
        }
    }
    
    // ==================== Split Tool ====================
    
    function handleSplitClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        // Find sheet under click
        let clickedSheetObj = findSheetAtPoint(opt, pointer);
        
        if (!state.isSplitting) {
            if (clickedSheetObj) {
                state.isSplitting = true;
                state.splitTargetSheet = clickedSheetObj;
                state.splitLineStart = pointer;
                
                state.splitLine = new fabric.Line(
                    [pointer.x, pointer.y, pointer.x, pointer.y],
                    {
                        stroke: '#9b59b6',
                        strokeWidth: 3,
                        strokeDashArray: [8, 4],
                        selectable: false,
                        evented: false
                    }
                );
                canvas.add(state.splitLine);
            }
        }
    }
    
    function handleSplitMove(opt) {
        if (!state.isSplitting || !state.splitLine || !state.splitLineStart) return;
        
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        state.splitLine.set({ x2: pointer.x, y2: pointer.y });
        
        if (typeof updateCutStats === 'function') {
            updateCutStats(state.splitLineStart, pointer);
        }
        
        canvas.renderAll();
    }
    
    async function handleSplitEnd(opt) {
        if (!state.isSplitting || !state.splitLine || !state.splitLineStart || !state.splitTargetSheet) return;
        
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        // Calculate line length
        const dx = pointer.x - state.splitLineStart.x;
        const dy = pointer.y - state.splitLineStart.y;
        const lineLength = Math.sqrt(dx * dx + dy * dy);
        
        if (lineLength > 20 && typeof performSheetSplit === 'function') {
            await performSheetSplit(state.splitTargetSheet, state.splitLineStart, pointer);
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
    
    // ==================== Calibration Tool ====================
    
    function handleCalibrationClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        state.calibrationPoints.push({ x: pointer.x, y: pointer.y });
        
        // Draw calibration point marker
        const marker = new fabric.Circle({
            radius: 5,
            fill: '#FF0000',
            left: pointer.x,
            top: pointer.y,
            originX: 'center',
            originY: 'center',
            selectable: false,
            calibrationMarker: true
        });
        canvas.add(marker);
        
        if (state.calibrationPoints.length === 2) {
            // Calculate pixel distance between points
            const p1 = state.calibrationPoints[0];
            const p2 = state.calibrationPoints[1];
            const pixelDist = Math.sqrt(
                Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2)
            );
            
            document.getElementById('pixel-distance').value = pixelDist.toFixed(2);
            document.getElementById('calibrateModal').style.display = 'block';
        }
    }
    
    // ==================== Origin Tool ====================
    
    async function handleOriginClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        try {
            const response = await fetch(`/api/projects/${PROJECT_ID}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    origin_x: pointer.x,
                    origin_y: pointer.y
                })
            });
            
            if (response.ok) {
                PROJECT_DATA.origin_x = pointer.x;
                PROJECT_DATA.origin_y = pointer.y;
                
                if (typeof drawOriginMarker === 'function') {
                    drawOriginMarker(pointer.x, pointer.y);
                }
                
                DW.showToast('Origin set successfully', 'success');
                setMode('pan');
            }
        } catch (error) {
            console.error('Error setting origin:', error);
            DW.showToast('Failed to set origin', 'error');
        }
    }
    
    // ==================== Verify Asset Tool ====================
    
    function handleVerifyClick(opt) {
        const canvas = state.canvas;
        const select = document.getElementById('verify-asset-select');
        
        if (!select.value) {
            DW.showToast('Please select an asset first', 'warning');
            return;
        }
        
        const pointer = canvas.getPointer(opt.e);
        state.refAssetId = select.value;
        state.refPixelX = pointer.x;
        state.refPixelY = pointer.y;
        
        // Sync to legacy globals
        window.refAssetId = state.refAssetId;
        window.refPixelX = state.refPixelX;
        window.refPixelY = state.refPixelY;
        
        if (typeof drawVerifyRefMarker === 'function') {
            drawVerifyRefMarker(pointer.x, pointer.y);
        }
        
        // Update info display
        const placedSpan = document.getElementById('verify-ref-placed');
        if (placedSpan) {
            placedSpan.textContent = `Reference placed at pixel (${state.refPixelX.toFixed(0)}, ${state.refPixelY.toFixed(0)})`;
            placedSpan.style.color = 'var(--border-layer-selected, #28a745)';
        }
        
        // Refresh assets
        if (typeof refreshAssets === 'function') {
            refreshAssets();
        }
    }
    
    // ==================== Measure Tool ====================
    
    function handleMeasureClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        MeasurementTool.addPoint(pointer.x, pointer.y);
    }
    
    // ==================== Helper Functions ====================
    
    /**
     * Find sheet at a given point, trying multiple methods
     */
    function findSheetAtPoint(opt, pointer) {
        const canvas = state.canvas;
        let clickedSheetObj = null;
        
        // Method 1: Use opt.target if available
        if (opt.target && opt.target.sheetData) {
            clickedSheetObj = opt.target;
        }
        
        // Method 2: Use findTarget
        if (!clickedSheetObj) {
            const target = canvas.findTarget(opt.e, true);
            if (target && target.sheetData) {
                clickedSheetObj = target;
            }
        }
        
        // Method 3: Manual bounding rect check
        if (!clickedSheetObj) {
            const sheetObjects = canvas.getObjects().filter(obj => obj.sheetData);
            for (const obj of sheetObjects) {
                const bounds = obj.getBoundingRect(true, true);
                if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                    pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                    clickedSheetObj = obj;
                    break;
                }
            }
        }
        
        // Method 4: Check if point is in visible area (not clipped)
        if (clickedSheetObj && clickedSheetObj._clipPolygon) {
            if (typeof isPointInVisibleArea === 'function' && 
                !isPointInVisibleArea(clickedSheetObj, pointer)) {
                clickedSheetObj = null;
            }
        }
        
        return clickedSheetObj;
    }
    
    // ==================== Public API ====================
    
    DW.tools = {
        setMode,
        handleSelectClick,
        handleCropClick,
        handleCropMove,
        handleCropEnd,
        handleSplitClick,
        handleSplitMove,
        handleSplitEnd,
        handleCalibrationClick,
        handleOriginClick,
        handleVerifyClick,
        handleMeasureClick
    };
    
    // Expose setMode globally for backward compatibility
    window.setMode = setMode;
    
    console.log('DocuWeaver tools module loaded');
})();
