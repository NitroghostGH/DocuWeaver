/**
 * DocuWeaver Canvas Editor - Tools Module
 * 
 * Handles tool modes and the select and measure click handlers. The other
 * tools' canvas events go straight to their own modules from canvas_init.js:
 * crop.js (cuts), split.js, and calibration.js (scale, origin, verify).
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
        
        // A scale pick never carries over into or out of the Scale tool
        if (typeof clearCalibrationPick === 'function') clearCalibrationPick();
        
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
            // Assets only take mouse events in select mode. Otherwise a pan
            // drag that starts on a marker moved it and saved an adjustment,
            // and measure clicks on a marker selected it.
            if (obj.isSavedMeasurement || obj.assetData) {
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
    
    // ==================== Measure Tool ====================
    
    function handleMeasureClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        
        MeasurementTool.addPoint(pointer.x, pointer.y);
    }
    
    // ==================== Public API ====================
    
    DW.tools = {
        setMode,
        handleSelectClick,
        handleMeasureClick
    };
    
    // Expose setMode globally for backward compatibility
    window.setMode = setMode;
    
})();
