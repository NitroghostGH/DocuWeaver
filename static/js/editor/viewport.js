/**
 * DocuWeaver Canvas Editor - Viewport Module
 * 
 * Handles zoom, pan, rotation, and viewport state persistence.
 * 
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // Debounce timers
    let rotationSaveTimeout = null;
    let viewportSaveTimeout = null;

    // Throttle for cursor position updates
    let lastCursorUpdate = 0;
    const CURSOR_THROTTLE_MS = 50; // ~20fps for cursor display
    
    // ==================== Zoom Functions ====================
    
    /**
     * Zoom in toward the center of the canvas viewport
     */
    function zoomIn() {
        const canvas = state.canvas;
        const center = canvas.getVpCenter();
        zoomToPoint(center, state.currentZoomLevel * 1.2);
    }
    
    /**
     * Zoom out from the center of the canvas viewport
     */
    function zoomOut() {
        const canvas = state.canvas;
        const center = canvas.getVpCenter();
        zoomToPoint(center, state.currentZoomLevel / 1.2);
    }
    
    /**
     * Zoom to a specific point on the canvas
     * @param {Object} point - The point to zoom toward {x, y} in canvas coordinates
     * @param {number} newZoom - The target zoom level
     */
    function zoomToPoint(point, newZoom) {
        const canvas = state.canvas;
        if (!canvas) return;
        
        // Clamp zoom level
        let zoom = newZoom;
        if (zoom > 5) zoom = 5;
        if (zoom < 0.1) zoom = 0.1;
        
        // Debug logging removed for performance
        
        // If no rotation, use Fabric's native method which is proven to work
        if (state.viewportRotation === 0) {
            const fabricPoint = new fabric.Point(point.x, point.y);
            canvas.zoomToPoint(fabricPoint, zoom);
            
            // Update state
            state.currentZoomLevel = zoom;
            window.currentZoomLevel = zoom;
            
            updateZoomDisplay();
            
            if (typeof debouncedSaveViewportState === 'function') {
                debouncedSaveViewportState();
            }
            return;
        }
        
        // For rotated viewports, we need custom handling
        const angleRad = state.viewportRotation * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        // Get the current viewport transform
        const vpt = canvas.viewportTransform;
        const oldZoom = state.currentZoomLevel;
        
        // The point in canvas space that we want to keep stationary
        const canvasX = point.x;
        const canvasY = point.y;
        
        // Transform this point to screen space with current transform
        const screenX = canvasX * vpt[0] + canvasY * vpt[2] + vpt[4];
        const screenY = canvasX * vpt[1] + canvasY * vpt[3] + vpt[5];
        
        
        // Now update the zoom in the transform matrix (keeping rotation)
        vpt[0] = cos * zoom;
        vpt[1] = sin * zoom;
        vpt[2] = -sin * zoom;
        vpt[3] = cos * zoom;
        
        // Calculate where that same canvas point would appear on screen with new zoom
        // but without adjusting translation yet
        const newScreenX = canvasX * vpt[0] + canvasY * vpt[2] + vpt[4];
        const newScreenY = canvasX * vpt[1] + canvasY * vpt[3] + vpt[5];
        
        
        // Calculate the offset needed to keep the point at the same screen position
        const offsetX = screenX - newScreenX;
        const offsetY = screenY - newScreenY;
        
        
        // Apply the offset
        vpt[4] += offsetX;
        vpt[5] += offsetY;
        
        // Update state
        state.currentZoomLevel = zoom;
        window.currentZoomLevel = zoom;
        
        // Apply the transform
        canvas.setViewportTransform(vpt);
        canvas.requestRenderAll();
        
        updateZoomDisplay();
        
        if (typeof debouncedSaveViewportState === 'function') {
            debouncedSaveViewportState();
        }
    }
    
    /**
     * Zoom to a specific point in screen/viewport coordinates
     * @param {Object} screenPoint - The point to zoom toward {x, y} in screen pixels
     * @param {number} newZoom - The target zoom level
     */
    function zoomToScreenPoint(screenPoint, newZoom) {
        const canvas = state.canvas;
        if (!canvas) return;
        
        // Clamp zoom level
        let zoom = newZoom;
        if (zoom > 5) zoom = 5;
        if (zoom < 0.1) zoom = 0.1;
        
        // Get the current viewport transform (make a copy)
        const vpt = canvas.viewportTransform.slice();
        const oldZoom = state.currentZoomLevel;
        
        // The screen point that should remain stationary (in screen/DOM coordinates)
        const screenX = screenPoint.x;
        const screenY = screenPoint.y;
        
        // Calculate which canvas point is currently at this screen position
        // Using inverse transform: canvas = inverse(vpt) * screen
        // For a 2x3 matrix [a,b,c,d,e,f]: inverse multiplies by 1/det where det = ad-bc
        const det = vpt[0] * vpt[3] - vpt[1] * vpt[2];
        if (Math.abs(det) < 0.000001) return; // Avoid division by zero
        
        // Apply inverse transform to get canvas coordinates
        const canvasX = (vpt[3] * (screenX - vpt[4]) - vpt[2] * (screenY - vpt[5])) / det;
        const canvasY = (vpt[0] * (screenY - vpt[5]) - vpt[1] * (screenX - vpt[4])) / det;
        
        // Calculate zoom ratio
        const zoomRatio = zoom / oldZoom;
        
        // Scale the rotation+zoom part of the matrix
        vpt[0] *= zoomRatio;
        vpt[1] *= zoomRatio;
        vpt[2] *= zoomRatio;
        vpt[3] *= zoomRatio;
        
        // Calculate where that canvas point would now appear in screen space
        const newScreenX = canvasX * vpt[0] + canvasY * vpt[2] + vpt[4];
        const newScreenY = canvasX * vpt[1] + canvasY * vpt[3] + vpt[5];
        
        // Adjust translation to keep the canvas point at the original screen position
        vpt[4] += (screenX - newScreenX);
        vpt[5] += (screenY - newScreenY);
        
        // Update state
        state.currentZoomLevel = zoom;
        window.currentZoomLevel = zoom;
        
        // Apply the transform
        canvas.setViewportTransform(vpt);
        canvas.requestRenderAll();
        
        updateZoomDisplay();
        
        if (typeof debouncedSaveViewportState === 'function') {
            debouncedSaveViewportState();
        }
    }
    
    /**
     * Set zoom while preserving the current viewport rotation
     */
    function setZoomPreservingRotation(zoom) {
        const canvas = state.canvas;
        if (!canvas) return;
        
        state.currentZoomLevel = zoom;
        window.currentZoomLevel = zoom; // Legacy sync
        
        const angleRad = state.viewportRotation * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        const vpt = canvas.viewportTransform;
        
        // Apply zoom with rotation
        vpt[0] = cos * zoom;
        vpt[1] = sin * zoom;
        vpt[2] = -sin * zoom;
        vpt[3] = cos * zoom;
        
        canvas.setViewportTransform(vpt);
        canvas.requestRenderAll();
    }

    function zoomFit() {
        const canvas = state.canvas;
        const objects = canvas.getObjects().filter(obj => obj.sheetData);
        
        if (objects.length === 0) return;
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        objects.forEach(obj => {
            const bounds = obj.getBoundingRect(true, true);
            minX = Math.min(minX, bounds.left);
            minY = Math.min(minY, bounds.top);
            maxX = Math.max(maxX, bounds.left + bounds.width);
            maxY = Math.max(maxY, bounds.top + bounds.height);
        });
        
        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;
        
        if (contentWidth < 1 || contentHeight < 1) return;
        
        const zoomX = canvas.width / contentWidth * 0.9;
        const zoomY = canvas.height / contentHeight * 0.9;
        const zoom = Math.min(zoomX, zoomY, 1);
        
        setZoomPreservingRotation(zoom);
        canvas.absolutePan({
            x: minX * zoom - (canvas.width - contentWidth * zoom) / 2,
            y: minY * zoom - (canvas.height - contentHeight * zoom) / 2
        });
        applyViewportRotation();
        updateZoomDisplay();
    }
    
    function bringToScale() {
        const canvas = state.canvas;
        const objects = canvas.getObjects().filter(obj => obj.sheetData);
        
        if (objects.length === 0) {
            DW.showToast('No sheets to fit', 'warning');
            return;
        }
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        objects.forEach(obj => {
            const bounds = obj.getBoundingRect(true, true);
            minX = Math.min(minX, bounds.left);
            minY = Math.min(minY, bounds.top);
            maxX = Math.max(maxX, bounds.left + bounds.width);
            maxY = Math.max(maxY, bounds.top + bounds.height);
        });
        
        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;
        
        if (contentWidth < 1 || contentHeight < 1) return;
        
        const zoomX = canvas.width / contentWidth * 0.85;
        const zoomY = canvas.height / contentHeight * 0.85;
        let zoom = Math.min(zoomX, zoomY, 2);
        
        setZoomPreservingRotation(zoom);
        
        canvas.absolutePan({
            x: minX * zoom - (canvas.width - contentWidth * zoom) / 2,
            y: minY * zoom - (canvas.height - contentHeight * zoom) / 2
        });
        
        applyViewportRotation();
        updateZoomDisplay();
        debouncedSaveViewportState();
        
        console.log('Brought to scale: zoom =', zoom.toFixed(2));
    }
    
    function resetView() {
        setZoomPreservingRotation(1);
        state.canvas.absolutePan({ x: 0, y: 0 });
        applyViewportRotation();
        updateZoomDisplay();
        debouncedSaveViewportState();
    }
    
    function updateZoomDisplay() {
        const zoom = Math.round(state.currentZoomLevel * 100);
        const zoomLevel = document.getElementById('zoom-level');
        const zoomDisplay = document.getElementById('zoom-display');
        
        if (zoomLevel) zoomLevel.textContent = zoom;
        if (zoomDisplay) zoomDisplay.textContent = zoom + '%';
    }
    
    // ==================== Rotation Functions ====================
    
    /**
     * Set viewport rotation to a specific angle
     */
    function setViewportRotation(degrees) {
        state.viewportRotation = ((degrees % 360) + 360) % 360;
        window.viewportRotation = state.viewportRotation; // Legacy sync
        
        applyViewportRotation();
        updateRotationDisplay();
        debouncedSaveRotation();
    }
    
    /**
     * Rotate by a delta amount
     */
    function rotateViewportBy(delta) {
        setViewportRotation(state.viewportRotation + delta);
    }
    
    /**
     * Match the selected sheet's rotation
     */
    function matchSheetRotation() {
        if (!state.selectedSheet) {
            DW.showToast('Select a sheet first', 'warning');
            return;
        }
        setViewportRotation(-state.selectedSheet.rotation);
        console.log('View rotated to match sheet:', state.selectedSheet.name);
    }
    
    /**
     * Reset rotation to 0
     */
    function resetViewportRotation() {
        setViewportRotation(0);
    }
    
    /**
     * Apply the current viewport rotation to the canvas
     */
    function applyViewportRotation() {
        const canvas = state.canvas;
        if (!canvas) return;
        
        const angleRad = state.viewportRotation * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        const vpt = canvas.viewportTransform;
        const currentZoom = state.currentZoomLevel;
        
        const panX = vpt[4];
        const panY = vpt[5];
        
        vpt[0] = cos * currentZoom;
        vpt[1] = sin * currentZoom;
        vpt[2] = -sin * currentZoom;
        vpt[3] = cos * currentZoom;
        vpt[4] = panX;
        vpt[5] = panY;
        
        canvas.setViewportTransform(vpt);
        canvas.requestRenderAll();
        
        // Refresh OSM tiles for new viewport
        if (typeof debouncedRefreshOSM === 'function') {
            debouncedRefreshOSM();
        }
    }
    
    function updateRotationDisplay() {
        const displayAngle = Math.round(state.viewportRotation);
        const rotationLevel = document.getElementById('rotation-level');
        const rotationInput = document.getElementById('viewport-rotation');
        
        if (rotationLevel) rotationLevel.textContent = displayAngle;
        if (rotationInput) rotationInput.value = displayAngle;
    }
    
    function debouncedSaveRotation() {
        if (rotationSaveTimeout) clearTimeout(rotationSaveTimeout);
        rotationSaveTimeout = setTimeout(saveViewportRotation, 500);
    }
    
    async function saveViewportRotation() {
        try {
            await fetch(`/api/projects/${PROJECT_ID}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ canvas_rotation: state.viewportRotation })
            });
        } catch (error) {
            console.error('Error saving rotation:', error);
        }
    }
    
    // ==================== Viewport State Persistence ====================
    
    function saveViewportState() {
        const canvas = state.canvas;
        if (!canvas || typeof PROJECT_ID === 'undefined') return;
        
        const vpt = canvas.viewportTransform;
        const viewState = {
            zoom: state.currentZoomLevel,
            panX: vpt[4],
            panY: vpt[5],
            rotation: state.viewportRotation,
            timestamp: Date.now()
        };
        
        const key = `docuweaver-viewport-${PROJECT_ID}`;
        localStorage.setItem(key, JSON.stringify(viewState));
    }
    
    function restoreViewportState() {
        const canvas = state.canvas;
        if (!canvas || typeof PROJECT_ID === 'undefined') return false;
        
        const key = `docuweaver-viewport-${PROJECT_ID}`;
        const saved = localStorage.getItem(key);
        
        if (saved) {
            try {
                const viewState = JSON.parse(saved);
                
                // Restore zoom
                state.currentZoomLevel = viewState.zoom || 1;
                window.currentZoomLevel = state.currentZoomLevel;
                
                // Restore rotation
                state.viewportRotation = viewState.rotation || 0;
                window.viewportRotation = state.viewportRotation;
                
                // Apply rotation first
                applyViewportRotation();
                
                // Apply pan
                const vpt = canvas.viewportTransform;
                vpt[4] = viewState.panX || 0;
                vpt[5] = viewState.panY || 0;
                canvas.setViewportTransform(vpt);
                
                updateZoomDisplay();
                updateRotationDisplay();
                
                console.log('Viewport restored:', viewState);
                return true;
            } catch (e) {
                console.error('Error restoring viewport:', e);
            }
        }
        
        return false;
    }
    
    function debouncedSaveViewportState() {
        if (viewportSaveTimeout) clearTimeout(viewportSaveTimeout);
        viewportSaveTimeout = setTimeout(saveViewportState, 300);
    }
    
    function hookViewStateSaving() {
        const canvas = state.canvas;
        if (!canvas) return;
        
        canvas.on('mouse:up', function() {
            debouncedSaveViewportState();
        });
    }
    
    // ==================== Cursor Position ====================
    
    function updateCursorPosition(opt) {
        const now = performance.now();
        if (now - lastCursorUpdate < CURSOR_THROTTLE_MS) return;
        lastCursorUpdate = now;

        const cursorEl = document.getElementById('cursor-position');
        if (!cursorEl) return;

        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        const ppm = PROJECT_DATA.pixels_per_meter;

        if (!ppm || !isFinite(ppm) || ppm <= 0) {
            cursorEl.textContent = `${pointer.x.toFixed(0)}px, ${pointer.y.toFixed(0)}px`;
            return;
        }

        if (typeof pixelToAssetMeter === 'function') {
            const pos = pixelToAssetMeter(pointer.x, pointer.y);
            cursorEl.textContent = `${pos.x.toFixed(2)}m, ${pos.y.toFixed(2)}m`;
        }
    }
    
    // ==================== Public API ====================
    
    DW.viewport = {
        zoomIn,
        zoomOut,
        zoomToPoint,
        zoomToScreenPoint,
        zoomFit,
        bringToScale,
        resetView,
        setZoomPreservingRotation,
        updateZoomDisplay,
        setViewportRotation,
        rotateViewportBy,
        matchSheetRotation,
        resetViewportRotation,
        applyViewportRotation,
        updateRotationDisplay,
        saveViewportState,
        restoreViewportState,
        debouncedSaveViewportState,
        hookViewStateSaving,
        updateCursorPosition
    };
    
    // Expose globally for backward compatibility
    window.zoomIn = zoomIn;
    window.zoomOut = zoomOut;
    window.zoomToPoint = zoomToPoint;
    window.zoomToScreenPoint = zoomToScreenPoint;
    window.zoomFit = zoomFit;
    window.bringToScale = bringToScale;
    window.resetView = resetView;
    window.setZoomPreservingRotation = setZoomPreservingRotation;
    window.updateZoomDisplay = updateZoomDisplay;
    window.setViewportRotation = setViewportRotation;
    window.rotateViewportBy = rotateViewportBy;
    window.matchSheetRotation = matchSheetRotation;
    window.resetViewportRotation = resetViewportRotation;
    window.applyViewportRotation = applyViewportRotation;
    window.updateRotationDisplay = updateRotationDisplay;
    window.saveViewportState = saveViewportState;
    window.restoreViewportState = restoreViewportState;
    window.debouncedSaveViewportState = debouncedSaveViewportState;
    window.hookViewStateSaving = hookViewStateSaving;
    window.updateCursorPosition = updateCursorPosition;
    
    // Save before unload
    window.addEventListener('beforeunload', saveViewportState);
    
    console.log('DocuWeaver viewport module loaded');
})();
