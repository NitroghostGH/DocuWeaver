/**
 * Modular Measurement Tool for Canvas Editor
 * Handles single lines, chain measurements, and measurement set management
 * 
 * API:
 * - MeasurementTool.init(canvas) - Initialize the tool
 * - MeasurementTool.startMeasurement(mode) - Start a new measurement
 * - MeasurementTool.endMeasurement() - End current measurement
 * - MeasurementTool.clearCurrent() - Clear current measurement
 * - MeasurementTool.saveCurrent(name) - Save current measurement to server
 * - MeasurementTool.loadSaved() - Load saved measurements from server
 * - MeasurementTool.toggleVisibility(id) - Toggle visibility of saved measurement
 * - MeasurementTool.delete(id) - Delete a saved measurement
 * - MeasurementTool.getCurrentPoints() - Get current measurement points
 * - MeasurementTool.getSavedMeasurements() - Get all saved measurements
 * - MeasurementTool.setConfigType(typeName) - Set current measurement config type
 * - MeasurementTool.getConfigTypes() - Get all defined config types
 * - MeasurementTool.updateConfig(settings) - Update current config
 */

const MeasurementTool = (() => {
    // Private state
    let canvas = null;
    let currentPoints = [];
    let currentMode = null;  // 'single' or 'chain'
    let currentOverlays = [];
    let previewLine = null;
    let previewLabel = null;
    let savedMeasurements = [];
    let projectId = null;
    let currentConfigType = 'default';  // Active config type name

    // Default Configuration
    const defaultConfig = {
        markerRadius: 4,
        markerColor: '#00bcd4',
        markerStroke: '#ffffff',
        markerStrokeWidth: 1,
        lineColor: '#00bcd4',
        lineStrokeWidth: 1.5,
        lineStyle: 'dashed',  // 'solid', 'dashed', 'dotted'
        lineDashArray: [8, 4],
        previewLineColor: '#00bcd4',
        previewLineStrokeWidth: 1,
        previewLineDashArray: [4, 4],
        previewLineOpacity: 0.6,
        labelFontSize: 12,
        labelColor: '#ffffff',
        labelBgColor: 'rgba(0, 188, 212, 0.85)',
        previewLabelFontSize: 11,
        previewLabelBgColor: 'rgba(0, 188, 212, 0.5)',
        fontFamily: 'monospace',
        labelPadding: 3,
        minSegmentLength: 2,  // Minimum pixels for a segment
        showAngle: true,      // Show angle on labels
        showDistance: true,   // Show distance on labels
        labelScale: 1.0       // Scale factor for label size (for monitor size adjustment)
    };

    // Active configuration (can be modified)
    let config = { ...defaultConfig };

    // Measurement config types (presets)
    let configTypes = {
        'default': {
            name: 'Default',
            config: { ...defaultConfig }
        },
        'typeA': {
            name: 'Type A - Red Solid',
            config: {
                ...defaultConfig,
                lineColor: '#e74c3c',
                markerColor: '#e74c3c',
                previewLineColor: '#e74c3c',
                labelBgColor: 'rgba(231, 76, 60, 0.85)',
                previewLabelBgColor: 'rgba(231, 76, 60, 0.5)',
                lineStyle: 'solid',
                lineDashArray: [],
                lineStrokeWidth: 2
            }
        },
        'typeB': {
            name: 'Type B - Green Dotted',
            config: {
                ...defaultConfig,
                lineColor: '#27ae60',
                markerColor: '#27ae60',
                previewLineColor: '#27ae60',
                labelBgColor: 'rgba(39, 174, 96, 0.85)',
                previewLabelBgColor: 'rgba(39, 174, 96, 0.5)',
                lineStyle: 'dotted',
                lineDashArray: [2, 4],
                lineStrokeWidth: 2
            }
        }
    };

    // Load saved config types from localStorage
    function loadConfigTypes() {
        try {
            const saved = localStorage.getItem('measurementConfigTypes');
            if (saved) {
                const parsed = JSON.parse(saved);
                // Merge with defaults, keeping user-defined types
                configTypes = { ...configTypes, ...parsed };
            }
        } catch (e) {
            console.warn('Could not load measurement config types:', e);
        }
    }

    // Save config types to localStorage
    function saveConfigTypes() {
        try {
            localStorage.setItem('measurementConfigTypes', JSON.stringify(configTypes));
        } catch (e) {
            console.warn('Could not save measurement config types:', e);
        }
    }

    // ==================== Config Management ====================

    /**
     * Set the current measurement config type
     */
    function setConfigType(typeName) {
        if (configTypes[typeName]) {
            currentConfigType = typeName;
            config = { ...defaultConfig, ...configTypes[typeName].config };
            console.log(`Switched to measurement config: ${typeName}`);
            return true;
        }
        console.warn(`Unknown config type: ${typeName}`);
        return false;
    }

    /**
     * Update current config with new settings
     */
    function updateConfig(newSettings) {
        config = { ...config, ...newSettings };
        // Also update the current config type if it exists
        if (configTypes[currentConfigType]) {
            configTypes[currentConfigType].config = { ...configTypes[currentConfigType].config, ...newSettings };
            saveConfigTypes();
        }
    }

    /**
     * Create or update a config type
     */
    function saveConfigType(typeName, displayName, configSettings) {
        configTypes[typeName] = {
            name: displayName,
            config: { ...defaultConfig, ...configSettings }
        };
        saveConfigTypes();
        return true;
    }

    /**
     * Delete a config type (cannot delete 'default')
     */
    function deleteConfigType(typeName) {
        if (typeName === 'default') return false;
        if (configTypes[typeName]) {
            delete configTypes[typeName];
            saveConfigTypes();
            if (currentConfigType === typeName) {
                setConfigType('default');
            }
            return true;
        }
        return false;
    }

    /**
     * Get all config types
     */
    function getConfigTypes() {
        return { ...configTypes };
    }

    /**
     * Get current config type name
     */
    function getCurrentConfigType() {
        return currentConfigType;
    }

    /**
     * Get line dash array based on style name
     */
    function getLineDashArray(style, strokeWidth = 2) {
        switch (style) {
            case 'solid': return [];
            case 'dashed': return [strokeWidth * 4, strokeWidth * 2];
            case 'dotted': return [strokeWidth, strokeWidth * 2];
            case 'dashdot': return [strokeWidth * 4, strokeWidth * 2, strokeWidth, strokeWidth * 2];
            default: return [strokeWidth * 4, strokeWidth * 2];
        }
    }

    // ==================== Notification System ====================
    
    function showNotification(message, type = 'info') {
        // Try to use the global notification system first
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
        } else {
            // Fallback: simple console logging
            const logFn = type === 'error' ? console.error : console.log;
            logFn(`[${type.toUpperCase()}] ${message}`);
        }
    }

    // ==================== Initialization ====================

    function init(canvasInstance, projectIdParam) {
        canvas = canvasInstance;
        projectId = projectIdParam;
        loadConfigTypes();  // Load saved config types
        console.log('MeasurementTool initialized');
    }

    /**
     * Get the effective scale factor for labels based on zoom level.
     * Labels scale inversely with zoom so they remain readable at any zoom.
     */
    function getZoomScaleFactor() {
        if (!canvas) return 1;
        const zoom = canvas.getZoom ? canvas.getZoom() : (window.currentZoomLevel || 1);
        // Inverse scale: at zoom 0.5, labels are 2x larger; at zoom 2, labels are 0.5x
        // Clamp to reasonable bounds
        const inverseZoom = 1 / Math.max(0.1, Math.min(zoom, 5));
        // Apply a base multiplier (1.5x) for better readability, then clamp
        return Math.max(0.75, Math.min(inverseZoom * 1.5, 6));
    }

    // ==================== Measurement Tracking ====================

    function startMeasurement(mode) {
        if (!['single', 'chain'].includes(mode)) {
            console.error('Invalid measurement mode:', mode);
            return;
        }
        currentMode = mode;
        currentPoints = [];
        currentOverlays = [];
        previewLine = null;
        previewLabel = null;
        console.log(`Started ${mode} measurement`);
    }

    function endMeasurement() {
        // Keep current measurement but stop accepting new points
        // Preview line should disappear on move
        removePreview();
        currentMode = null;
        console.log('Measurement ended');
    }

    function clearCurrent() {
        currentOverlays.forEach(obj => {
            if (canvas) canvas.remove(obj);
        });
        currentOverlays = [];
        currentPoints = [];
        previewLine = null;
        previewLabel = null;
        currentMode = null;
        if (canvas) {
            bringMeasurementsToFront();
            canvas.renderAll();
        }
    }

    // ==================== Point Addition & Rendering ====================

    function addPoint(x, y) {
        // Auto-start in single mode if not started
        if (!currentMode) {
            console.log('MeasurementTool: auto-starting in single mode');
            startMeasurement('single');
        }
        
        // In single mode with 2 points, auto-clear FIRST before adding new point
        if (currentMode === 'single' && currentPoints.length >= 2) {
            console.log('Single mode: auto-clearing after 2 points');
            clearCurrent();
            startMeasurement('single');
            // Now add the point as the first point of the new measurement
        }

        // Skip zero-length segments
        if (currentPoints.length > 0) {
            const last = currentPoints[currentPoints.length - 1];
            const dx = x - last.x;
            const dy = y - last.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < config.minSegmentLength) {
                return false;
            }
        }

        currentPoints.push({ x, y });

        // Draw point marker
        const marker = new fabric.Circle({
            radius: config.markerRadius,
            fill: config.markerColor,
            stroke: config.markerStroke,
            strokeWidth: config.markerStrokeWidth,
            left: x,
            top: y,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
            isMeasurement: true
        });
        canvas.add(marker);
        canvas.bringToFront(marker);
        currentOverlays.push(marker);

        const n = currentPoints.length;
        if (n >= 2) {
            const p1 = currentPoints[n - 2];
            const p2 = currentPoints[n - 1];

            // Get line dash array based on style
            const lineDash = config.lineStyle === 'solid' ? [] : 
                             getLineDashArray(config.lineStyle, config.lineStrokeWidth);

            // Draw segment line
            const segLine = new fabric.Line([p1.x, p1.y, p2.x, p2.y], {
                stroke: config.lineColor,
                strokeWidth: config.lineStrokeWidth,
                strokeUniform: true,
                strokeDashArray: lineDash,
                selectable: false,
                evented: false,
                isMeasurement: true
            });
            canvas.add(segLine);
            canvas.bringToFront(segLine);
            currentOverlays.push(segLine);

            // Draw segment label with distance and angle
            const zoomScale = getZoomScaleFactor();
            const scaledFontSize = Math.round(config.labelFontSize * config.labelScale * zoomScale);
            const scaledMarkerRadius = Math.round(config.markerRadius * zoomScale);
            const scaledStrokeWidth = Math.max(1, config.lineStrokeWidth * zoomScale * 0.5);
            const midX = (p1.x + p2.x) / 2;
            const midY = (p1.y + p2.y) / 2;
            const segLabel = new fabric.Text(formatMeasurementLabel(p1, p2), {
                left: midX,
                top: midY - (scaledFontSize + 6),
                fontSize: scaledFontSize,
                fill: config.labelColor,
                backgroundColor: config.labelBgColor,
                fontFamily: config.fontFamily,
                padding: config.labelPadding,
                selectable: false,
                evented: false,
                isMeasurement: true
            });
            canvas.add(segLabel);
            canvas.bringToFront(segLabel);
            currentOverlays.push(segLabel);
        }

        removePreview();
        updatePanel();
        canvas.renderAll();

        return true;
    }

    function handleMouseMove(pointerX, pointerY) {
        if (currentPoints.length === 0) return;
        if (currentMode === 'single' && currentPoints.length >= 2) return;
        if (!canvas) return;

        const lastPt = currentPoints[currentPoints.length - 1];
        const pointerPt = { x: pointerX, y: pointerY };

        // Update or create preview line
        const previewDash = config.lineStyle === 'solid' ? [4, 4] : 
                            getLineDashArray(config.lineStyle, config.previewLineStrokeWidth);
        if (!previewLine) {
            previewLine = new fabric.Line(
                [lastPt.x, lastPt.y, pointerX, pointerY],
                {
                    stroke: config.previewLineColor,
                    strokeWidth: config.previewLineStrokeWidth,
                    strokeUniform: true,
                    strokeDashArray: previewDash,
                    opacity: config.previewLineOpacity,
                    selectable: false,
                    evented: false,
                    isMeasurement: true
                }
            );
            canvas.add(previewLine);
            canvas.bringToFront(previewLine);
        } else {
            previewLine.set({ x1: lastPt.x, y1: lastPt.y, x2: pointerX, y2: pointerY });
        }

        // Update or create preview label with distance and angle
        const label = formatMeasurementLabel(lastPt, pointerPt);
        const zoomScale = getZoomScaleFactor();
        const scaledPreviewFontSize = Math.round(config.previewLabelFontSize * config.labelScale * zoomScale);
        const midX = (lastPt.x + pointerX) / 2;
        const midY = (lastPt.y + pointerY) / 2;

        if (!previewLabel) {
            previewLabel = new fabric.Text(label, {
                left: midX,
                top: midY - (scaledPreviewFontSize + 6),
                fontSize: scaledPreviewFontSize,
                fill: config.labelColor,
                backgroundColor: config.previewLabelBgColor,
                fontFamily: config.fontFamily,
                padding: config.labelPadding,
                selectable: false,
                evented: false,
                isMeasurement: true
            });
            canvas.add(previewLabel);
            canvas.bringToFront(previewLabel);
        } else {
            previewLabel.set({ 
                text: label, 
                left: midX, 
                top: midY - (scaledPreviewFontSize + 6),
                fontSize: scaledPreviewFontSize
            });
        }
        
        // Use requestRenderAll for better performance (batches renders)
        canvas.requestRenderAll();
    }

    function removePreview() {
        if (!canvas) return;
        if (previewLine) {
            canvas.remove(previewLine);
            previewLine = null;
        }
        if (previewLabel) {
            canvas.remove(previewLabel);
            previewLabel = null;
        }
    }

    // ==================== Distance & Angle Calculations ====================

    function calcDistance(p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const pixelDist = Math.sqrt(dx * dx + dy * dy);
        
        // Use global PROJECT_DATA if available
        if (typeof PROJECT_DATA !== 'undefined') {
            const ppm = PROJECT_DATA.pixels_per_meter;
            if (PROJECT_DATA.scale_calibrated && ppm && isFinite(ppm) && ppm > 0) {
                return { pixels: pixelDist, meters: pixelDist / ppm, calibrated: true };
            }
        }
        return { pixels: pixelDist, meters: null, calibrated: false };
    }

    /**
     * Calculate angle between two points (in degrees from horizontal)
     */
    function calcAngle(p1, p2) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        // Note: Canvas Y increases downward, so we negate dy for standard angle
        let angle = Math.atan2(-dy, dx) * (180 / Math.PI);
        // Normalize to 0-360 range
        if (angle < 0) angle += 360;
        return angle;
    }

    function formatDistance(dist) {
        if (dist.calibrated) {
            if (dist.meters >= 1000) return `${(dist.meters / 1000).toFixed(2)} km`;
            if (dist.meters >= 1) return `${dist.meters.toFixed(2)} m`;
            return `${(dist.meters * 100).toFixed(1)} cm`;
        }
        return `${Math.round(dist.pixels)} px`;
    }

    /**
     * Format measurement label with distance and optionally angle
     */
    function formatMeasurementLabel(p1, p2) {
        const dist = calcDistance(p1, p2);
        const parts = [];
        
        if (config.showDistance) {
            parts.push(formatDistance(dist));
        }
        
        if (config.showAngle) {
            const angle = calcAngle(p1, p2);
            parts.push(`${angle.toFixed(1)}°`);
        }
        
        return parts.join(' | ') || formatDistance(dist);
    }

    function getTotalDistance() {
        if (currentPoints.length < 2) {
            return { pixels: 0, meters: null, calibrated: false };
        }

        let totalPixels = 0;
        let totalMeters = 0;
        let allCalibrated = true;

        for (let i = 1; i < currentPoints.length; i++) {
            const dist = calcDistance(currentPoints[i - 1], currentPoints[i]);
            totalPixels += dist.pixels;
            if (dist.calibrated) {
                totalMeters += dist.meters;
            } else {
                allCalibrated = false;
            }
        }

        return {
            pixels: totalPixels,
            meters: allCalibrated ? totalMeters : null,
            calibrated: allCalibrated
        };
    }

    // ==================== Panel Updates ====================

    function updatePanel() {
        const segmentList = document.getElementById('measure-segments');
        const totalEl = document.getElementById('measure-total');
        const straightEl = document.getElementById('measure-straight');
        const straightRow = document.getElementById('measure-straight-row');

        if (!segmentList) return;

        segmentList.innerHTML = '';

        if (currentPoints.length < 2) {
            if (totalEl) totalEl.textContent = '--';
            if (straightEl) straightEl.textContent = '--';
            if (straightRow) straightRow.style.display = 'none';
            return;
        }

        // List all segments
        for (let i = 1; i < currentPoints.length; i++) {
            const dist = calcDistance(currentPoints[i - 1], currentPoints[i]);
            const li = document.createElement('div');
            li.style.cssText = 'padding: 0.2rem 0; font-size: 0.8rem; border-bottom: 1px solid var(--border-light, #e0e0e0); display: flex; justify-content: space-between;';
            li.innerHTML = `<span>Seg ${i}</span><span>${formatDistance(dist)}</span>`;
            segmentList.appendChild(li);
        }

        // Total distance
        const totalDist = getTotalDistance();
        if (totalEl) totalEl.textContent = formatDistance(totalDist);

        // Straight-line distance (chain mode with 3+ points)
        if (currentMode === 'chain' && currentPoints.length >= 3) {
            if (straightRow) straightRow.style.display = 'flex';
            const straightDist = calcDistance(currentPoints[0], currentPoints[currentPoints.length - 1]);
            if (straightEl) straightEl.textContent = formatDistance(straightDist);
        } else {
            if (straightRow) straightRow.style.display = 'none';
        }
    }

    // ==================== Saving & Loading ====================

    async function saveCurrent(name, layerGroupId = null) {
        if (currentPoints.length === 0) {
            console.error('No measurement points to save');
            return false;
        }

        if (!name || !name.trim()) {
            return false;
        }

        // Store the mode before we potentially change it
        const mode = currentMode || 'single'; // Default to 'single' if mode is null

        const totalDist = getTotalDistance();
        
        // Build style info to store with measurement
        const styleInfo = {
            configType: currentConfigType,
            lineStyle: config.lineStyle,
            lineStrokeWidth: config.lineStrokeWidth,
            showAngle: config.showAngle,
            showDistance: config.showDistance,
            labelScale: config.labelScale
        };
        
        const data = {
            name: name.trim(),
            measurement_type: mode,
            points: currentPoints,
            color: config.lineColor,
            total_distance_pixels: totalDist.pixels,
            total_distance_meters: totalDist.meters,
            style_info: styleInfo  // Store style configuration
        };

        // Add layer_group if provided (null means Ungrouped)
        if (layerGroupId !== undefined) {
            data.layer_group = layerGroupId;
        }

        console.log('Saving measurement:', data);

        try {
            const response = await fetch(`/api/projects/${projectId}/measurement-sets/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCSRFToken()
                },
                body: JSON.stringify(data)
            });

            console.log('Save response status:', response.status);

            if (response.ok) {
                const saved = await response.json();
                console.log('Measurement saved successfully:', saved);
                savedMeasurements.push(saved);
                clearCurrent();
                updatePanel();
                renderSaved();
                showNotification(`Measurement "${name}" saved!`, 'success');
                return true;
            } else {
                let errorMsg = 'Failed to save measurement';
                try {
                    const errData = await response.json();
                    console.error('API error response:', errData);
                    errorMsg = errData.error || errData.detail || JSON.stringify(errData);
                } catch (e) {
                    console.error('Could not parse error response:', e);
                    errorMsg = `HTTP ${response.status}: ${response.statusText}`;
                }
                showNotification(errorMsg, 'error');
                return false;
            }
        } catch (err) {
            console.error('Error saving measurement:', err);
            showNotification('Error saving measurement', 'error');
            return false;
        }
    }

    async function loadSaved() {
        try {
            const response = await fetch(`/api/projects/${projectId}/measurement-sets/`);
            if (response.ok) {
                savedMeasurements = await response.json();
                renderSaved();
                return true;
            }
        } catch (err) {
            console.error('Error loading measurement sets:', err);
        }
        return false;
    }

    async function toggleVisibility(id, visible) {
        try {
            const response = await fetch(`/api/measurement-sets/${id}/toggle-visibility/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCSRFToken()
                },
                body: JSON.stringify({ visible })
            });

            if (response.ok) {
                const result = await response.json();
                // Update the local measurement set with the server response
                const ms = savedMeasurements.find(m => m.id === id);
                if (ms) {
                    ms.visible = result.visible;
                }
                // Re-render the canvas to show/hide the measurement
                renderSaved();
                return true;
            }
        } catch (err) {
            console.error('Error toggling measurement visibility:', err);
        }
        return false;
    }

    async function deleteById(id, name) {
        if (!confirm(`Delete measurement "${name}"?`)) return false;

        try {
            const response = await fetch(`/api/measurement-sets/${id}/`, {
                method: 'DELETE',
                headers: {
                    'X-CSRFToken': getCSRFToken()
                }
            });

            if (response.ok) {
                savedMeasurements = savedMeasurements.filter(m => m.id !== id);
                renderSaved();
                // Refresh sidebar list if function is available
                if (typeof renderMeasurementGroupList === 'function') {
                    await renderMeasurementGroupList();
                }
                // Show success notification if available
                if (typeof showToast === 'function') {
                    showToast(`Measurement "${name}" deleted`, 'success');
                }
                return true;
            }
        } catch (err) {
            console.error('Error deleting measurement:', err);
            if (typeof showToast === 'function') {
                showToast('Error deleting measurement', 'error');
            }
        }
        return false;
    }

    // ==================== Rendering Saved Measurements ====================

    function renderSaved() {
        // Clear existing saved measurements from canvas
        const savedOverlays = canvas.getObjects().filter(obj => obj.isSavedMeasurement);
        savedOverlays.forEach(obj => canvas.remove(obj));

        // Draw each visible saved measurement
        savedMeasurements.filter(ms => ms.visible).forEach(ms => {
            if (!ms.points || ms.points.length === 0) return;

            const color = ms.color || config.lineColor;
            const points = ms.points;
            const groupObjects = [];

            // Draw lines
            if (points.length >= 2) {
                for (let i = 0; i < points.length - 1; i++) {
                    const line = new fabric.Line(
                        [points[i].x, points[i].y, points[i + 1].x, points[i + 1].y],
                        {
                            stroke: color,
                            strokeWidth: 2,
                            strokeDashArray: [5, 5],
                            selectable: false,
                            evented: false
                        }
                    );
                    groupObjects.push(line);
                }
            }

            // Draw point markers
            points.forEach((pt, idx) => {
                const marker = new fabric.Circle({
                    left: pt.x,
                    top: pt.y,
                    radius: 4,
                    fill: color,
                    stroke: '#fff',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center',
                    selectable: false,
                    evented: false
                });
                groupObjects.push(marker);
            });

            // Create a group for all objects in this measurement set
            // This makes the entire measurement selectable as one unit
            if (groupObjects.length > 0) {
                // Only make measurements selectable/evented when canvas selection is enabled (select mode)
                const isSelectMode = canvas.selection === true;
                const measurementGroup = new fabric.Group(groupObjects, {
                    selectable: isSelectMode,
                    evented: isSelectMode,
                    hasControls: false,
                    hasBorders: true,
                    lockMovementX: true,
                    lockMovementY: true,
                    lockRotation: true,
                    lockScalingX: true,
                    lockScalingY: true,
                    hoverCursor: isSelectMode ? 'pointer' : 'default',
                    isSavedMeasurement: true,
                    measurementSetId: ms.id,
                    measurementName: ms.name
                });
                canvas.add(measurementGroup);
            }
        });

        bringMeasurementsToFront();
        canvas.renderAll();
    }

    // ==================== Canvas Utilities ====================

    function bringMeasurementsToFront() {
        // Use rendering hierarchy instead of always bringing to front
        if (typeof applyRenderingHierarchy === 'function') {
            applyRenderingHierarchy();
        } else {
            // Fallback to old behavior if hierarchy system not available
            const measurements = canvas.getObjects().filter(obj =>
                obj.isMeasurement || obj.isMeasurementGroup || obj.isSavedMeasurement
            );
            measurements.forEach(m => canvas.bringToFront(m));
        }
    }

    // ==================== Getters ====================

    function getCurrentPoints() {
        return [...currentPoints];  // Return copy
    }

    function getCurrentMode() {
        return currentMode;
    }

    function getSavedMeasurements() {
        return [...savedMeasurements];  // Return copy
    }

    function getTotalDistanceFormatted() {
        return formatDistance(getTotalDistance());
    }

    // ==================== Public API ====================

    return {
        init,
        startMeasurement,
        endMeasurement,
        clearCurrent,
        addPoint,
        handleMouseMove,
        removePreview,
        saveCurrent,
        loadSaved,
        toggleVisibility,
        delete: deleteById,
        renderSaved,
        getCurrentPoints,
        getCurrentMode,
        getSavedMeasurements,
        getTotalDistance,
        getTotalDistanceFormatted,
        updatePanel,
        bringMeasurementsToFront,
        // Config management
        getConfig: () => ({ ...config }),
        updateConfig,
        setConfigType,
        getConfigTypes,
        getCurrentConfigType,
        saveConfigType,
        deleteConfigType,
        getLineDashArray
    };
})();
