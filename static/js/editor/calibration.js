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

    function isDegreeUnit() {
        return ['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit);
    }

    // ==================== Scale Calibration ====================

    // A pick shorter than this (in canvas pixels) can't give a usable scale;
    // two clicks on one spot used to save 0 px/m and stack every asset on
    // the reference point.
    const MIN_CALIBRATION_PIXELS = 5;

    function handleCalibrationClick(opt) {
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);

        // A third click after a cancelled pick starts a new one.
        if (state.calibrationPoints.length >= 2) clearCalibrationPick();

        if (state.calibrationPoints.length === 1) {
            const first = state.calibrationPoints[0];
            if (Math.hypot(pointer.x - first.x, pointer.y - first.y) < MIN_CALIBRATION_PIXELS) {
                DW.showToast('Click the second point further from the first', 'warning');
                return;
            }
        }
        state.calibrationPoints.push({ x: pointer.x, y: pointer.y });

        canvas.add(new fabric.Circle({
            radius: 5,
            fill: '#FF0000',
            left: pointer.x,
            top: pointer.y,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
            calibrationMarker: true
        }));

        if (state.calibrationPoints.length === 2) {
            const [p1, p2] = state.calibrationPoints;
            const pixelDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            document.getElementById('pixel-distance').value = pixelDistance.toFixed(2);
            document.getElementById('real-distance').value = '';
            document.getElementById('calibrateModal').style.display = 'block';
            document.getElementById('real-distance').focus();
        }
    }

    function clearCalibrationPick() {
        const canvas = state.canvas;
        canvas.getObjects().filter(obj => obj.calibrationMarker).forEach(obj => canvas.remove(obj));
        state.calibrationPoints = [];
        canvas.requestRenderAll();
    }

    async function applyCalibration() {
        const pixelDistance = parseFloat(document.getElementById('pixel-distance').value);
        const realDistance = parseFloat(document.getElementById('real-distance').value);

        if (!isFinite(realDistance) || realDistance <= 0) {
            alert('Enter the real-world distance between the two points, in metres.');
            return;
        }
        if (!isFinite(pixelDistance) || pixelDistance < MIN_CALIBRATION_PIXELS) {
            alert('The two points are too close together. Cancel and pick them again.');
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
            if (!response.ok) throw new Error(await DW.responseError(response));

            const result = await response.json();
            PROJECT_DATA.pixels_per_meter = result.pixels_per_meter;
            PROJECT_DATA.scale_calibrated = result.scale_calibrated;

            hideCalibrateModal();
            if (typeof setMode === 'function') setMode('pan');
            if (typeof refreshAssets === 'function') refreshAssets();
            if (typeof renderLinksOnCanvas === 'function') renderLinksOnCanvas();
            if (typeof refreshOSMPlacement === 'function') refreshOSMPlacement();
            DW.showToast(`Scale set: ${result.pixels_per_meter.toFixed(3)} px/m`, 'success');
        } catch (error) {
            console.error('Calibration error:', error);
            alert('Could not save the scale: ' + error.message);
        }
    }

    /** Close the scale dialog. The picked points go too, so the next click starts over. */
    function hideCalibrateModal() {
        document.getElementById('calibrateModal').style.display = 'none';
        clearCalibrationPick();
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

            if (!response.ok) throw new Error(await DW.responseError(response));
            const result = await response.json();
            PROJECT_DATA.origin_x = result.origin_x;
            PROJECT_DATA.origin_y = result.origin_y;

            drawOriginMarker(pointer.x, pointer.y);

            if (typeof setMode === 'function') setMode('pan');
            if (typeof refreshAssets === 'function') refreshAssets();
            DW.showToast('Origin set', 'success');
        } catch (error) {
            console.error('Origin setting error:', error);
            DW.showToast('Could not set the origin: ' + error.message, 'error');
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

        // Coordinates that all fit in +-180/+-90 are probably degrees, but a
        // small local metre grid fits too, so only suggest it. (This used to
        // switch the project to degrees and save it.)
        const unitHint = document.getElementById('verify-unit-hint');
        if (unitHint) {
            const looksLikeDegrees = !isDegreeUnit() && state.assets.every(a =>
                Math.abs(a.original_x) <= 180 && Math.abs(a.original_y) <= 90);
            unitHint.style.display = looksLikeDegrees ? 'block' : 'none';
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
                coordsSpan.textContent = typeof formatCoordPair === 'function'
                    ? formatCoordPair(asset.original_x, asset.original_y)
                    : `${asset.original_x}, ${asset.original_y}`;
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
        const anchor = (typeof referencePixelForClick === 'function')
            ? referencePixelForClick(select.value, pointer.x, pointer.y)
            : pointer;
        state.refAssetId = select.value;
        state.refPixelX = anchor.x;
        state.refPixelY = anchor.y;
        window.refAssetId = state.refAssetId;
        window.refPixelX = state.refPixelX;
        window.refPixelY = state.refPixelY;

        drawVerifyRefMarker(pointer.x, pointer.y);

        const placedSpan = document.getElementById('verify-ref-placed');
        placedSpan.textContent = `Reference placed at pixel (${pointer.x.toFixed(0)}, ${pointer.y.toFixed(0)})`;
        placedSpan.style.color = 'var(--border-layer-selected, #28a745)';

        if (typeof refreshAssets === 'function') refreshAssets();
        if (typeof renderLinksOnCanvas === 'function') renderLinksOnCanvas();
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

    /**
     * Asset rotation from either slider or number box. Markers are moved in
     * place (once per animation frame); links and OSM tiles are redrawn and
     * the setting saved once the slider stops.
     */
    let rotationFrame = null;
    let rotationSettle = null;

    function applyAssetRotation(deg, save) {
        deg = Number(deg);
        if (!isFinite(deg)) return;
        state.assetRotationDeg = deg;
        window.assetRotationDeg = deg;
        ['verify-rotation-slider', 'verify-rotation-input', 'asset-rotation-slider', 'asset-rotation-input'].forEach(id => {
            const el = document.getElementById(id);
            if (el && document.activeElement !== el) el.value = deg;
        });

        if (state.refAssetId && (state.refPixelX !== 0 || state.refPixelY !== 0) && !rotationFrame) {
            rotationFrame = requestAnimationFrame(() => {
                rotationFrame = null;
                if (typeof repositionAssets === 'function') repositionAssets();
            });
        }
        clearTimeout(rotationSettle);
        rotationSettle = setTimeout(() => {
            if (typeof renderLinksOnCanvas === 'function') renderLinksOnCanvas();
            if (typeof refreshOSMPlacement === 'function') refreshOSMPlacement();
        }, 250);
        if (save) debouncedSaveAssetCalibration();
    }

    // The Verify panel's rotation is saved with "Apply & Plot All".
    function onVerifyRotationChange(deg) {
        applyAssetRotation(deg, false);
    }

    function setAssetRotation(deg) {
        applyAssetRotation(deg, true);
    }

    function debouncedSaveAssetCalibration() {
        if (state.assetCalibrationSaveTimeout) {
            clearTimeout(state.assetCalibrationSaveTimeout);
        }
        state.assetCalibrationSaveTimeout = setTimeout(saveAssetCalibration, 500);
    }

    async function saveAssetCalibration() {
        const data = {
            asset_rotation: state.assetRotationDeg,
            coord_unit: PROJECT_DATA.coord_unit
        };
        // No reference yet: changing the unit or rotation first is fine,
        // and an empty id used to be refused with a 400 nobody saw.
        if (state.refAssetId) {
            data.ref_asset_id = state.refAssetId;
            data.ref_pixel_x = state.refPixelX;
            data.ref_pixel_y = state.refPixelY;
        }
        try {
            const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify(data)
            });
            if (!response.ok) throw new Error(await DW.responseError(response));

            const result = await response.json();
            PROJECT_DATA.asset_rotation = result.asset_rotation;
            PROJECT_DATA.ref_asset_id = result.ref_asset_id;
            PROJECT_DATA.ref_pixel_x = result.ref_pixel_x;
            PROJECT_DATA.ref_pixel_y = result.ref_pixel_y;
            PROJECT_DATA.coord_unit = result.coord_unit;
            return true;
        } catch (error) {
            console.error('Error saving asset calibration:', error);
            DW.showToast('Could not save the coordinate settings: ' + error.message, 'error');
            return false;
        }
    }

    function onCoordUnitChange(value) {
        PROJECT_DATA.coord_unit = value;
        const unitHint = document.getElementById('verify-unit-hint');
        if (unitHint) unitHint.style.display = 'none';
        if (typeof updateCoordinateLabels === 'function') updateCoordinateLabels();
        updateVerifyRefInfo();
        if (state.refAssetId && (state.refPixelX !== 0 || state.refPixelY !== 0)) {
            if (typeof refreshAssets === 'function') refreshAssets();
            if (typeof renderLinksOnCanvas === 'function') renderLinksOnCanvas();
            if (typeof refreshOSMPlacement === 'function') refreshOSMPlacement();
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

        if (!await saveAssetCalibration()) return;

        document.getElementById('verify-panel').style.display = 'none';
        if (typeof setMode === 'function') setMode('pan');
        if (typeof refreshAssets === 'function') refreshAssets();
        if (typeof renderLinksOnCanvas === 'function') renderLinksOnCanvas();
        if (typeof refreshOSMPlacement === 'function') refreshOSMPlacement();
        DW.showToast('Assets plotted from the reference point', 'success');
    }

    // ==================== Public API ====================

    DW.calibration = {
        handleCalibrationClick,
        clearCalibrationPick,
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
    window.clearCalibrationPick = clearCalibrationPick;
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

})();
