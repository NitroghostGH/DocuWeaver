/**
 * DocuWeaver Canvas Editor - Calibration & Asset Verification
 *
 * Handles scale calibration, origin setting, and the asset verify panel
 * for aligning imported assets to the canvas.
 *
 * Depends on: namespace.js, tools.js (setMode), assets.js (refreshAssets)
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    // ==================== Scale Calibration ====================

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
            const dx = state.calibrationPoints[1].x - state.calibrationPoints[0].x;
            const dy = state.calibrationPoints[1].y - state.calibrationPoints[0].y;
            const pixelDistance = Math.sqrt(dx * dx + dy * dy);

            document.getElementById('pixel-distance').value = pixelDistance.toFixed(2);
            document.getElementById('calibrateModal').style.display = 'block';
        }
    }

    async function applyCalibration() {
        const canvas = state.canvas;
        const pixelDistance = parseFloat(document.getElementById('pixel-distance').value);
        const realDistance = parseFloat(document.getElementById('real-distance').value);

        if (!realDistance || realDistance <= 0) {
            alert('Please enter a valid real-world distance');
            return;
        }

        try {
            const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    pixel_distance: pixelDistance,
                    real_distance: realDistance
                })
            });

            const result = await response.json();
            PROJECT_DATA.pixels_per_meter = result.pixels_per_meter;
            PROJECT_DATA.scale_calibrated = true;

            // Clear calibration markers
            const calibMarkers = canvas.getObjects().filter(obj => obj.calibrationMarker);
            calibMarkers.forEach(obj => canvas.remove(obj));

            state.calibrationPoints = [];
            hideCalibrateModal();
            if (typeof setMode === 'function') setMode('pan');

            // Refresh assets with new scale
            if (typeof refreshAssets === 'function') refreshAssets();

        } catch (error) {
            console.error('Calibration error:', error);
            alert('Error applying calibration');
        }
    }

    function hideCalibrateModal() {
        document.getElementById('calibrateModal').style.display = 'none';
    }

    // ==================== Origin Setting ====================

    async function handleOriginClick(opt) {
        const pointer = state.canvas.getPointer(opt.e);

        try {
            const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    origin_x: pointer.x,
                    origin_y: pointer.y
                })
            });

            const result = await response.json();
            PROJECT_DATA.origin_x = result.origin_x;
            PROJECT_DATA.origin_y = result.origin_y;

            drawOriginMarker(pointer.x, pointer.y);

            if (typeof setMode === 'function') setMode('pan');
            if (typeof refreshAssets === 'function') refreshAssets();

        } catch (error) {
            console.error('Origin setting error:', error);
        }
    }

    function drawOriginMarker(x, y) {
        const canvas = state.canvas;

        // Remove existing origin marker
        const originMarkers = canvas.getObjects().filter(obj => obj.originMarker);
        originMarkers.forEach(obj => canvas.remove(obj));

        const marker = new fabric.Group([
            new fabric.Line([x - 20, y, x + 20, y], { stroke: '#0000FF', strokeWidth: 2 }),
            new fabric.Line([x, y - 20, x, y + 20], { stroke: '#0000FF', strokeWidth: 2 }),
            new fabric.Circle({ radius: 8, fill: 'transparent', stroke: '#0000FF', strokeWidth: 2, left: x, top: y, originX: 'center', originY: 'center' })
        ], { selectable: false, originMarker: true });

        canvas.add(marker);
        canvas.renderAll();
    }

    // ==================== Asset Verification Panel ====================

    function toggleVerifyPanel() {
        const panel = document.getElementById('verify-panel');
        const isVisible = panel.style.display !== 'none';

        if (isVisible) {
            panel.style.display = 'none';
            if (typeof setMode === 'function') setMode('pan');
            return;
        }

        if (state.assets.length === 0) {
            alert('No assets imported yet. Import a CSV first.');
            return;
        }

        // Show/hide scale calibration warning
        const scaleWarning = document.getElementById('verify-scale-warning');
        scaleWarning.style.display = PROJECT_DATA.scale_calibrated ? 'none' : 'block';

        // Auto-detect coordinate unit from asset values
        if (PROJECT_DATA.coord_unit === 'meters' && state.assets.length > 0) {
            const looksLikeDegrees = state.assets.every(a =>
                Math.abs(a.current_x) <= 180 && Math.abs(a.current_y) <= 90
            );
            if (looksLikeDegrees) {
                PROJECT_DATA.coord_unit = 'degrees';
                debouncedSaveAssetCalibration();
            }
        }

        // Set coord unit dropdown
        document.getElementById('verify-coord-unit').value = PROJECT_DATA.coord_unit || 'meters';

        // Populate the asset dropdown
        const select = document.getElementById('verify-asset-select');
        select.innerHTML = '<option value="">-- Select --</option>';
        state.assets.forEach(asset => {
            const opt = document.createElement('option');
            opt.value = asset.asset_id;
            opt.textContent = asset.asset_id + (asset.name ? ' - ' + asset.name : '');
            select.appendChild(opt);
        });

        // Pre-select current reference if set
        if (state.refAssetId) {
            select.value = state.refAssetId;
            updateVerifyRefInfo();
        }

        // Set rotation sliders
        document.getElementById('verify-rotation-slider').value = state.assetRotationDeg;
        document.getElementById('verify-rotation-input').value = state.assetRotationDeg;

        collapseVerifyAssetList();
        panel.style.display = 'block';
        if (typeof setMode === 'function') setMode('verify-asset');
    }

    function filterVerifyAssetSelect(query) {
        const select = document.getElementById('verify-asset-select');
        const q = query.toLowerCase();
        let visibleCount = 0;
        for (const opt of select.options) {
            if (!opt.value) continue;
            const visible = opt.textContent.toLowerCase().includes(q);
            opt.style.display = visible ? '' : 'none';
            if (visible) visibleCount++;
        }
        const rows = Math.min(Math.max(visibleCount, 2), 15);
        select.size = rows;
        select.style.height = (rows * 1.6) + 'em';
    }

    function expandVerifyAssetList() {
        const select = document.getElementById('verify-asset-select');
        let visibleCount = 0;
        for (const opt of select.options) {
            if (!opt.value) continue;
            if (opt.style.display !== 'none') visibleCount++;
        }
        const rows = Math.min(Math.max(visibleCount, 2), 15);
        select.size = rows;
        select.style.height = (rows * 1.6) + 'em';
    }

    function collapseVerifyAssetList() {
        const select = document.getElementById('verify-asset-select');
        select.size = 1;
        select.style.height = '2em';
    }

    function onVerifyAssetSelected() {
        const select = document.getElementById('verify-asset-select');
        if (select.value) {
            collapseVerifyAssetList();
        }
        updateVerifyRefInfo();
    }

    function updateVerifyRefInfo() {
        const select = document.getElementById('verify-asset-select');
        const infoDiv = document.getElementById('verify-ref-info');
        const coordsSpan = document.getElementById('verify-ref-coords');
        const placedSpan = document.getElementById('verify-ref-placed');

        if (select.value) {
            const asset = state.assets.find(a => a.asset_id === select.value);
            if (asset) {
                infoDiv.style.display = 'block';
                coordsSpan.textContent = `(${asset.current_x.toFixed(2)}m, ${asset.current_y.toFixed(2)}m)`;
                if (state.refAssetId === select.value && (state.refPixelX !== 0 || state.refPixelY !== 0)) {
                    placedSpan.textContent = `Reference placed at pixel (${state.refPixelX.toFixed(0)}, ${state.refPixelY.toFixed(0)})`;
                    placedSpan.style.color = 'var(--border-layer-selected, #28a745)';
                } else {
                    placedSpan.textContent = 'Click on the drawing to set the reference location';
                    placedSpan.style.color = 'var(--text-muted, #6c757d)';
                }
            }
        } else {
            infoDiv.style.display = 'none';
        }
    }

    function handleVerifyClick(opt) {
        const select = document.getElementById('verify-asset-select');
        if (!select.value) {
            alert('Please select a reference asset first.');
            return;
        }

        const pointer = state.canvas.getPointer(opt.e);
        state.refAssetId = select.value;
        state.refPixelX = pointer.x;
        state.refPixelY = pointer.y;

        drawVerifyRefMarker(pointer.x, pointer.y);

        const placedSpan = document.getElementById('verify-ref-placed');
        placedSpan.textContent = `Reference placed at pixel (${state.refPixelX.toFixed(0)}, ${state.refPixelY.toFixed(0)})`;
        placedSpan.style.color = 'var(--border-layer-selected, #28a745)';

        if (typeof refreshAssets === 'function') refreshAssets();
    }

    function drawVerifyRefMarker(x, y) {
        const canvas = state.canvas;

        if (state.verifyRefMarker) {
            canvas.remove(state.verifyRefMarker);
        }

        state.verifyRefMarker = new fabric.Group([
            new fabric.Line([x - 15, y, x + 15, y], { stroke: '#e74c3c', strokeWidth: 2 }),
            new fabric.Line([x, y - 15, x, y + 15], { stroke: '#e74c3c', strokeWidth: 2 }),
            new fabric.Circle({ radius: 10, fill: 'transparent', stroke: '#e74c3c', strokeWidth: 2, left: x, top: y, originX: 'center', originY: 'center' }),
            new fabric.Circle({ radius: 3, fill: '#e74c3c', left: x, top: y, originX: 'center', originY: 'center' })
        ], { selectable: false, evented: false, verifyMarker: true });

        canvas.add(state.verifyRefMarker);
        canvas.bringToFront(state.verifyRefMarker);
        canvas.renderAll();
    }

    // ==================== Rotation & Calibration Saving ====================

    function onVerifyRotationChange(deg) {
        state.assetRotationDeg = deg;
        document.getElementById('verify-rotation-slider').value = deg;
        document.getElementById('verify-rotation-input').value = deg;
        document.getElementById('asset-rotation-slider').value = deg;
        document.getElementById('asset-rotation-input').value = deg;

        if (state.refAssetId && (state.refPixelX !== 0 || state.refPixelY !== 0)) {
            if (typeof refreshAssets === 'function') refreshAssets();
        }
    }

    function setAssetRotation(deg) {
        state.assetRotationDeg = deg;
        document.getElementById('asset-rotation-slider').value = deg;
        document.getElementById('asset-rotation-input').value = deg;
        document.getElementById('verify-rotation-slider').value = deg;
        document.getElementById('verify-rotation-input').value = deg;

        if (state.refAssetId) {
            if (typeof refreshAssets === 'function') refreshAssets();
        }

        debouncedSaveAssetCalibration();
    }

    function debouncedSaveAssetCalibration() {
        if (state.assetCalibrationSaveTimeout) {
            clearTimeout(state.assetCalibrationSaveTimeout);
        }
        state.assetCalibrationSaveTimeout = setTimeout(saveAssetCalibration, 500);
    }

    async function saveAssetCalibration() {
        try {
            const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    asset_rotation: state.assetRotationDeg,
                    ref_asset_id: state.refAssetId,
                    ref_pixel_x: state.refPixelX,
                    ref_pixel_y: state.refPixelY,
                    coord_unit: PROJECT_DATA.coord_unit
                })
            });

            if (response.ok) {
                const result = await response.json();
                PROJECT_DATA.asset_rotation = result.asset_rotation;
                PROJECT_DATA.ref_asset_id = result.ref_asset_id;
                PROJECT_DATA.ref_pixel_x = result.ref_pixel_x;
                PROJECT_DATA.ref_pixel_y = result.ref_pixel_y;
                PROJECT_DATA.coord_unit = result.coord_unit;
                console.log('Asset calibration saved');
            }
        } catch (error) {
            console.error('Error saving asset calibration:', error);
        }
    }

    function onCoordUnitChange(value) {
        PROJECT_DATA.coord_unit = value;
        if (state.refAssetId && (state.refPixelX !== 0 || state.refPixelY !== 0)) {
            if (typeof refreshAssets === 'function') refreshAssets();
        }
        debouncedSaveAssetCalibration();
    }

    async function applyVerification() {
        const select = document.getElementById('verify-asset-select');
        if (!select.value) {
            alert('Please select a reference asset.');
            return;
        }

        if (state.refPixelX === 0 && state.refPixelY === 0) {
            alert('Please click on the drawing to set the reference location.');
            return;
        }

        state.refAssetId = select.value;

        await saveAssetCalibration();

        document.getElementById('verify-panel').style.display = 'none';
        if (typeof setMode === 'function') setMode('pan');
        if (typeof refreshAssets === 'function') refreshAssets();

        console.log('Asset verification applied: ref=' + state.refAssetId +
            ', pixel=(' + state.refPixelX.toFixed(0) + ',' + state.refPixelY.toFixed(0) + ')' +
            ', rotation=' + state.assetRotationDeg + '\u00b0');
    }

    // ==================== Public API ====================

    DW.calibration = {
        handleCalibrationClick,
        applyCalibration,
        hideCalibrateModal,
        handleOriginClick,
        drawOriginMarker,
        toggleVerifyPanel,
        filterVerifyAssetSelect,
        expandVerifyAssetList,
        collapseVerifyAssetList,
        onVerifyAssetSelected,
        updateVerifyRefInfo,
        handleVerifyClick,
        drawVerifyRefMarker,
        onVerifyRotationChange,
        setAssetRotation,
        debouncedSaveAssetCalibration,
        saveAssetCalibration,
        onCoordUnitChange,
        applyVerification
    };

    // Backward compatibility
    window.handleCalibrationClick = handleCalibrationClick;
    window.applyCalibration = applyCalibration;
    window.hideCalibrateModal = hideCalibrateModal;
    window.handleOriginClick = handleOriginClick;
    window.drawOriginMarker = drawOriginMarker;
    window.toggleVerifyPanel = toggleVerifyPanel;
    window.filterVerifyAssetSelect = filterVerifyAssetSelect;
    window.expandVerifyAssetList = expandVerifyAssetList;
    window.collapseVerifyAssetList = collapseVerifyAssetList;
    window.onVerifyAssetSelected = onVerifyAssetSelected;
    window.updateVerifyRefInfo = updateVerifyRefInfo;
    window.handleVerifyClick = handleVerifyClick;
    window.drawVerifyRefMarker = drawVerifyRefMarker;
    window.onVerifyRotationChange = onVerifyRotationChange;
    window.setAssetRotation = setAssetRotation;
    window.debouncedSaveAssetCalibration = debouncedSaveAssetCalibration;
    window.saveAssetCalibration = saveAssetCalibration;
    window.onCoordUnitChange = onCoordUnitChange;
    window.applyVerification = applyVerification;

    console.log('DocuWeaver calibration module loaded');
})();
