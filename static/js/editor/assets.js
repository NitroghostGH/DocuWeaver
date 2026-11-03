/**
 * DocuWeaver Canvas Editor - Assets Module
 * 
 * Handles asset rendering, coordinate conversions, and asset management.
 * 
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Coordinate Conversions ====================
    //
    // Asset coordinates are in the project's unit: degrees (x = longitude,
    // y = latitude) or metres (x = easting, y = northing). In every unit y
    // increases to the north, while canvas y increases downwards, so offsets
    // are flipped on the way to the canvas.
    //
    // The overlay is anchored on the reference asset's ORIGINAL (imported)
    // coordinates, which sit at (refPixelX, refPixelY). Its adjusted position
    // can change later, and anchoring on that would drag every other asset
    // along with it.

    function isDegreeUnit() {
        return ['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit);
    }

    /** Field label for a coordinate axis in the project's unit, e.g. "Longitude (°)". */
    function coordAxisLabel(axis) {
        if (isDegreeUnit()) return axis === 'x' ? 'Longitude (°)' : 'Latitude (°)';
        if (PROJECT_DATA.coord_unit === 'gda94_mga') return axis === 'x' ? 'Easting (m)' : 'Northing (m)';
        return axis === 'x' ? 'X (m)' : 'Y (m)';
    }

    /** A coordinate pair for display: "153.032145°, -27.471234°" or "512.30 m, 840.12 m". */
    function formatCoordPair(x, y) {
        if (isDegreeUnit()) return `${x.toFixed(6)}°, ${y.toFixed(6)}°`;
        return `${x.toFixed(2)} m, ${y.toFixed(2)} m`;
    }

    /** Put the project's coordinate unit into every label and input that shows coordinates. */
    function updateCoordinateLabels() {
        document.querySelectorAll('[data-coord-label]').forEach(el => {
            const [prefix, axis] = el.dataset.coordLabel.split(':');
            el.textContent = `${prefix} ${coordAxisLabel(axis)}`.trim();
        });
        // A 0.01 step is 1 km in degrees.
        const step = isDegreeUnit() ? '0.000001' : '0.001';
        ['asset-adj-x', 'asset-adj-y'].forEach(id => {
            const input = document.getElementById(id);
            if (input) input.step = step;
        });
    }

    /**
     * Metres per degree of latitude and of longitude at a latitude, on the
     * WGS84 ellipsoid (GDA94's GRS80 differs by well under a millimetre).
     * A single 111,320 m/deg for both axes stretches north-south distances,
     * by 0.46% at 27.5 degrees south.
     */
    function metresPerDegree(latDeg) {
        const p = latDeg * Math.PI / 180;
        return {
            lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
            lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p)
        };
    }

    /**
     * Convert a coordinate offset to a canvas-oriented metre offset
     * (x to the east, y to the SOUTH). refY is the latitude the offset is
     * measured from (degree units only).
     */
    function coordOffsetToMeters(dx, dy, refY) {
        if (isDegreeUnit()) {
            const m = metresPerDegree(refY || 0);
            return { x: dx * m.lon, y: -dy * m.lat };
        }
        return { x: dx, y: -dy };
    }

    /**
     * Inverse of coordOffsetToMeters.
     */
    function metersToCoordOffset(mx, my, refY) {
        if (isDegreeUnit()) {
            const m = metresPerDegree(refY || 0);
            return { x: m.lon !== 0 ? mx / m.lon : 0, y: -my / m.lat };
        }
        return { x: mx, y: -my };
    }

    function referenceAsset() {
        if (!state.refAssetId) return null;
        return state.assets.find(a => a.asset_id === state.refAssetId) || null;
    }

    /**
     * Convert asset coordinates to pixel coordinates on the canvas.
     */
    function assetMeterToPixel(meterX, meterY) {
        const ppm = PROJECT_DATA.pixels_per_meter;
        if (!ppm || !isFinite(ppm) || ppm <= 0) {
            console.warn('assetMeterToPixel: invalid pixels_per_meter:', ppm);
            return { x: 0, y: 0 };
        }

        const refAsset = referenceAsset();
        if (refAsset) {
            const dm = coordOffsetToMeters(meterX - refAsset.original_x, meterY - refAsset.original_y,
                                           refAsset.original_y);

            const rad = state.assetRotationDeg * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const rotX = dm.x * cos - dm.y * sin;
            const rotY = dm.x * sin + dm.y * cos;

            return {
                x: state.refPixelX + rotX * ppm,
                y: state.refPixelY + rotY * ppm
            };
        }

        const dm = coordOffsetToMeters(meterX, meterY, meterY);
        return {
            x: PROJECT_DATA.origin_x + (dm.x * ppm),
            y: PROJECT_DATA.origin_y + (dm.y * ppm)
        };
    }

    /**
     * Convert pixel coordinates back to asset coordinates.
     */
    function pixelToAssetMeter(pixelX, pixelY) {
        const ppm = PROJECT_DATA.pixels_per_meter;
        if (!ppm || !isFinite(ppm) || ppm <= 0) {
            console.warn('pixelToAssetMeter: invalid pixels_per_meter:', ppm);
            return { x: 0, y: 0 };
        }

        const refAsset = referenceAsset();
        if (refAsset) {
            const dpx = pixelX - state.refPixelX;
            const dpy = pixelY - state.refPixelY;

            const rad = -state.assetRotationDeg * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const rotDpx = dpx * cos - dpy * sin;
            const rotDpy = dpx * sin + dpy * cos;

            const dCoord = metersToCoordOffset(rotDpx / ppm, rotDpy / ppm, refAsset.original_y);

            return {
                x: refAsset.original_x + dCoord.x,
                y: refAsset.original_y + dCoord.y
            };
        }

        const mx = (pixelX - PROJECT_DATA.origin_x) / ppm;
        const my = (pixelY - PROJECT_DATA.origin_y) / ppm;
        return metersToCoordOffset(mx, my, 0);
    }

    /**
     * The reference pixel to store when the user clicks (clickX, clickY) as
     * the drawn location of the asset with this asset_id. The anchor is the
     * asset's original coordinates, so an asset that has already been
     * adjusted is anchored at the click minus its adjustment.
     */
    function referencePixelForClick(assetId, clickX, clickY) {
        const asset = state.assets.find(a => a.asset_id === assetId);
        if (!asset || (asset.current_x === asset.original_x && asset.current_y === asset.original_y)) {
            return { x: clickX, y: clickY };
        }
        const saved = { id: state.refAssetId, x: state.refPixelX, y: state.refPixelY };
        state.refAssetId = assetId;
        state.refPixelX = clickX;
        state.refPixelY = clickY;
        const drawn = assetMeterToPixel(asset.current_x, asset.current_y);
        state.refAssetId = saved.id;
        state.refPixelX = saved.x;
        state.refPixelY = saved.y;
        return { x: 2 * clickX - drawn.x, y: 2 * clickY - drawn.y };
    }

    // ==================== Asset Rendering ====================
    
    function renderAssetsOnCanvas() {
        const canvas = state.canvas;

        // Remove markers from an earlier render, or every reload adds a copy.
        canvas.getObjects().filter(obj => obj.assetData).forEach(obj => canvas.remove(obj));

        if (!state.refAssetId || (state.refPixelX === 0 && state.refPixelY === 0)) {
            return;
        }

        const scale = markerScale();
        state.assets.forEach(asset => {
            const pos = assetMeterToPixel(asset.current_x, asset.current_y);
            const assetObj = createAssetShape(asset, pos.x, pos.y);
            assetObj.assetData = asset;
            assetObj.set({ scaleX: scale, scaleY: scale });
            assetObj.visible = typeof isItemShown === 'function' ? isItemShown(asset, 'asset') : asset.visible !== false;
            canvas.add(assetObj);
        });

        if (typeof applyRenderingHierarchy === 'function') applyRenderingHierarchy();
        canvas.requestRenderAll();
    }

    /**
     * Move the existing markers to their computed positions, for changes that
     * don't change the markers themselves (asset rotation). Much cheaper than
     * rebuilding every group on each slider step.
     */
    function repositionAssets() {
        state.canvas.getObjects().forEach(obj => {
            if (!obj.assetData) return;
            const pos = assetMeterToPixel(obj.assetData.current_x, obj.assetData.current_y);
            obj.set({ left: pos.x, top: pos.y });
            obj.setCoords();
        });
        state.canvas.requestRenderAll();
    }

    // ==================== Marker size and labels ====================

    // Markers are drawn in canvas pixels, so zoomed out to a whole drawing
    // set (10% or less) they shrank to specks. Below 100% zoom they are
    // scaled up to keep their on-screen size; zoomed in they grow as before.
    function markerScale() {
        const zoom = state.currentZoomLevel || 1;
        return zoom >= 1 ? 1 : 1 / zoom;
    }

    let markerScaleFrame = null;
    function updateMarkerScale() {
        if (markerScaleFrame || !state.canvas) return;
        markerScaleFrame = requestAnimationFrame(() => {
            markerScaleFrame = null;
            const scale = markerScale();
            state.canvas.getObjects().forEach(obj => {
                if (obj.assetData && obj.scaleX !== scale) {
                    obj.set({ scaleX: scale, scaleY: scale });
                    obj.setCoords();
                }
            });
            state.canvas.requestRenderAll();
        });
    }

    /**
     * Label text style for the current theme. The halo (a stroke painted
     * under the fill) keeps labels readable over linework and map tiles; in
     * dark mode the sheets are negatives, so the text is light.
     */
    function assetLabelStyle() {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        return {
            fontSize: 10,
            fontFamily: getComputedStyle(document.body).fontFamily || 'sans-serif',
            fill: dark ? '#f2f2f2' : '#000',
            stroke: dark ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.9)',
            strokeWidth: 3,
            paintFirst: 'stroke'
        };
    }

    function createAssetShape(asset, x, y) {
        const type = asset.asset_type_data;
        const color = type ? type.color : '#FF0000';
        const size = type ? type.size : 20;
        const shape = (type && type.custom_icon) ? 'custom' : (type ? type.icon_shape : 'circle');

        let obj;

        switch(shape) {
            case 'circle':
                obj = new fabric.Circle({
                    radius: size / 2,
                    fill: color,
                    stroke: '#000',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center'
                });
                break;
            case 'square':
                obj = new fabric.Rect({
                    width: size,
                    height: size,
                    fill: color,
                    stroke: '#000',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center'
                });
                break;
            case 'triangle':
                obj = new fabric.Triangle({
                    width: size,
                    height: size,
                    fill: color,
                    stroke: '#000',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center'
                });
                break;
            case 'diamond':
                obj = new fabric.Rect({
                    width: size * 0.7,
                    height: size * 0.7,
                    fill: color,
                    stroke: '#000',
                    strokeWidth: 1,
                    angle: 45,
                    originX: 'center',
                    originY: 'center'
                });
                break;
            case 'star':
                const points = createStarPoints(0, 0, 5, size / 2, size / 4);
                obj = new fabric.Polygon(points, {
                    fill: color,
                    stroke: '#000',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center'
                });
                break;
            case 'custom':
                obj = new fabric.Circle({
                    radius: size / 2,
                    fill: color,
                    stroke: '#000',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center'
                });
                if (type && type.custom_icon) {
                    loadCustomAssetIcon(obj, asset, type.custom_icon, size);
                }
                break;
            default:
                obj = new fabric.Circle({
                    radius: size / 2,
                    fill: color,
                    stroke: '#000',
                    strokeWidth: 1,
                    originX: 'center',
                    originY: 'center'
                });
        }

        obj.set({ left: x, top: y });

        const label = new fabric.Text(asset.name || asset.asset_id, Object.assign(assetLabelStyle(), {
            left: x + size / 2 + 3,
            top: y,
            originY: 'center'
        }));

        return makeAssetGroup([obj, label], x, y);
    }

    /**
     * Group a marker symbol (centred on x, y) with its label. The group's
     * origin is moved onto the symbol centre, so group.left/top are the
     * asset's position: drawing, dragging and saving all use them as-is.
     * With the default top-left origin, placing the group at (x, y) drew the
     * symbol half its size down and to the right of the true point.
     */
    function makeAssetGroup(objects, x, y) {
        const interactive = state.currentMode === 'select';
        const group = new fabric.Group(objects, {
            selectable: interactive,
            evented: interactive,
            hasControls: false,
            hasBorders: true,
            lockScalingX: true,
            lockScalingY: true,
            lockRotation: true,
            cornerSize: 0
        });
        group.set({
            originX: (x - group.left) / group.width,
            originY: (y - group.top) / group.height,
            left: x,
            top: y
        });
        group.setCoords();

        group.setControlsVisibility({
            tl: false, tr: false, bl: false, br: false,
            ml: false, mt: false, mr: false, mb: false,
            mtr: false
        });

        return group;
    }
    
    function loadCustomAssetIcon(placeholder, asset, iconUrl, targetSize) {
        setTimeout(() => {
            fabric.Image.fromURL(iconUrl, function(img) {
                if (!img || !img.width) return;
                
                const scale = targetSize / Math.max(img.width, img.height);
                img.set({
                    scaleX: scale,
                    scaleY: scale,
                    originX: 'center',
                    originY: 'center'
                });
                
                const oldGroup = placeholder.group;
                if (oldGroup && state.canvas.getObjects().includes(oldGroup)) {
                    // left/top are the symbol centre (see makeAssetGroup)
                    const x = oldGroup.left;
                    const y = oldGroup.top;
                    img.set({ left: x, top: y });

                    const newLabel = new fabric.Text(asset.name || asset.asset_id, Object.assign(assetLabelStyle(), {
                        left: x + targetSize / 2 + 3,
                        top: y,
                        originY: 'center'
                    }));

                    const newGroup = makeAssetGroup([img, newLabel], x, y);
                    newGroup.assetData = oldGroup.assetData;
                    newGroup.visible = oldGroup.visible;
                    newGroup.set({ scaleX: oldGroup.scaleX, scaleY: oldGroup.scaleY });
                    const index = state.canvas.getObjects().indexOf(oldGroup);
                    state.canvas.remove(oldGroup);
                    state.canvas.insertAt(newGroup, index);
                    state.canvas.requestRenderAll();
                }
            }, { crossOrigin: 'anonymous' });
        }, 0);
    }
    
    function createStarPoints(cx, cy, spikes, outerRadius, innerRadius) {
        const points = [];
        const step = Math.PI / spikes;

        for (let i = 0; i < 2 * spikes; i++) {
            const radius = i % 2 === 0 ? outerRadius : innerRadius;
            const angle = i * step - Math.PI / 2;
            points.push({
                x: cx + Math.cos(angle) * radius,
                y: cy + Math.sin(angle) * radius
            });
        }

        return points;
    }
    
    // ==================== Asset Selection ====================
    
    function selectAsset(assetId) {
        const canvas = state.canvas;
        state.selectedAsset = state.assets.find(a => a.id === assetId);
        window.selectedAsset = state.selectedAsset;
        state.selectedSheet = null;
        window.selectedSheet = null;

        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) obj.shadow = null;
            if (obj.assetData && obj.assetData.id === assetId) {
                canvas.setActiveObject(obj);
            }
        });

        if (typeof openRightSidebar === 'function') openRightSidebar();
        document.getElementById('no-selection').style.display = 'none';
        document.getElementById('sheet-properties').style.display = 'none';
        document.getElementById('asset-properties').style.display = 'block';

        document.getElementById('asset-id').value = state.selectedAsset.asset_id;
        document.getElementById('asset-name').value = state.selectedAsset.name || '';
        document.getElementById('asset-orig-x').value = state.selectedAsset.original_x;
        document.getElementById('asset-orig-y').value = state.selectedAsset.original_y;
        document.getElementById('asset-adj-x').value = state.selectedAsset.current_x;
        document.getElementById('asset-adj-y').value = state.selectedAsset.current_y;
        updateCoordinateLabels();
        
        if (typeof showTab === 'function') {
            showTab('properties');
        }
    }
    
    // ==================== Asset Adjustment ====================
    // The Adjusted X/Y fields in the properties panel hold the selected asset's
    // position in project coordinates. Dragging the asset on the canvas updates
    // them (updateAssetPositionFromCanvas) and then saves (canvas_init.js calls
    // saveAssetAdjustment on object:modified). Typing in them moves the marker
    // (updateAssetPosition) until "Save Adjustment" is clicked.

    function findAssetObject(assetId) {
        return state.canvas.getObjects().find(obj => obj.assetData && obj.assetData.id === assetId);
    }

    function formatAssetCoord(value) {
        // 8 decimals of a degree and 3 decimals of a metre are both about 1 mm.
        return value.toFixed(isDegreeUnit() ? 8 : 3);
    }

    function updateAssetPositionFromCanvas(obj) {
        if (!obj || !obj.assetData) return;
        if (!state.selectedAsset || state.selectedAsset.id !== obj.assetData.id) return;

        const pos = pixelToAssetMeter(obj.left, obj.top);
        document.getElementById('asset-adj-x').value = formatAssetCoord(pos.x);
        document.getElementById('asset-adj-y').value = formatAssetCoord(pos.y);
    }

    function updateAssetPosition() {
        const asset = state.selectedAsset;
        if (!asset) return;

        const x = parseFloat(document.getElementById('asset-adj-x').value);
        const y = parseFloat(document.getElementById('asset-adj-y').value);
        const obj = findAssetObject(asset.id);
        if (!isFinite(x) || !isFinite(y) || !obj) return;

        const pos = assetMeterToPixel(x, y);
        obj.set({ left: pos.x, top: pos.y });
        obj.setCoords();
        state.canvas.requestRenderAll();
    }

    async function saveAssetAdjustment() {
        const asset = state.selectedAsset;
        if (!asset) return;

        const x = parseFloat(document.getElementById('asset-adj-x').value);
        const y = parseFloat(document.getElementById('asset-adj-y').value);
        if (!isFinite(x) || !isFinite(y)) {
            DW.showToast('Adjusted X and Y must be numbers', 'warning');
            return;
        }
        const notesEl = document.getElementById('asset-notes');

        try {
            const response = await fetch(`/api/assets/${asset.id}/adjust/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ x, y, notes: notesEl ? notesEl.value : '' })
            });
            if (!response.ok) throw new Error(await DW.responseError(response));

            const updated = await response.json();
            const index = state.assets.findIndex(a => a.id === updated.id);
            if (index >= 0) state.assets[index] = updated;
            if (notesEl) notesEl.value = '';
            if (typeof saveUndoState === 'function') {
                saveUndoState('assetAdjust', { assetId: asset.id, previousX: asset.current_x, previousY: asset.current_y });
            }

            // Redraw from the saved coordinates. Removing the old marker clears
            // the selection, so re-select the asset if it's still the one shown.
            const stillSelected = state.selectedAsset && state.selectedAsset.id === updated.id;
            refreshAssets();
            if (stillSelected) selectAsset(updated.id);

            DW.showToast('Asset adjustment saved', 'success');
        } catch (error) {
            console.error('Error saving asset adjustment:', error);
            DW.showToast('Could not save the adjustment: ' + error.message, 'error');
            refreshAssets();
        }
    }

    // ==================== Asset Visibility ====================

    /** The eye on an asset. Saved, so it stays hidden after a reload. */
    async function toggleAssetVisibility(assetId, visible) {
        const asset = state.assets.find(a => a.id === assetId);
        if (!asset) return false;
        const previous = asset.visible;
        asset.visible = visible;
        if (typeof applyVisibility === 'function') applyVisibility();
        try {
            const response = await fetch(`/api/assets/${assetId}/`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': DW.getCSRFToken() },
                body: JSON.stringify({ visible })
            });
            if (!response.ok) throw new Error(await DW.responseError(response));
            return true;
        } catch (error) {
            asset.visible = previous;
            if (typeof applyVisibility === 'function') applyVisibility();
            if (typeof renderAssetGroupList === 'function') renderAssetGroupList();
            DW.showToast('Could not save the asset visibility: ' + error.message, 'error');
            return false;
        }
    }

    function refreshAssets() {
        renderAssetsOnCanvas();
    }
    
    function clearAssetsFromCanvas() {
        const canvas = state.canvas;
        const assetObjs = canvas.getObjects().filter(obj => obj.assetData);
        assetObjs.forEach(obj => canvas.remove(obj));
    }
    
    // ==================== Asset List Rendering ====================
    
    function renderAssetList() {
        const assetSearchLeft = document.getElementById('asset-search-left');
        if (assetSearchLeft) {
            const newSearch = assetSearchLeft.cloneNode(true);
            assetSearchLeft.parentNode.replaceChild(newSearch, assetSearchLeft);
            newSearch.addEventListener('input', function(e) {
                filterFolderItems(e.target.value, 'asset');
            });
        }

        const linkSearchEl = document.getElementById('link-search');
        if (linkSearchEl) {
            const newLinkSearch = linkSearchEl.cloneNode(true);
            linkSearchEl.parentNode.replaceChild(newLinkSearch, linkSearchEl);
            newLinkSearch.addEventListener('input', function(e) {
                filterFolderItems(e.target.value, 'link');
            });
        }
    }
    
    function filterFolderItems(query, type) {
        const q = (query || '').toLowerCase();
        const container = type === 'asset' 
            ? document.getElementById('asset-groups-list') 
            : document.getElementById('link-groups-list');
        if (!container) return;

        container.querySelectorAll('.folder-item-entry').forEach((item) => {
            const itemId = item.dataset.itemId;
            const itemType = item.dataset.itemType;
            if (itemType !== type) return;

            let itemData;
            if (type === 'asset') {
                itemData = state.assets.find(a => a.id == itemId);
                if (!itemData) return;
                const matches = !q || 
                    (itemData.asset_id && itemData.asset_id.toLowerCase().includes(q)) ||
                    (itemData.name && itemData.name.toLowerCase().includes(q));
                item.style.display = matches ? '' : 'none';
            } else {
                itemData = state.links.find(l => l.id == itemId);
                if (!itemData) return;
                const matches = !q || 
                    (itemData.link_id && itemData.link_id.toLowerCase().includes(q)) ||
                    (itemData.name && itemData.name.toLowerCase().includes(q)) ||
                    (itemData.link_type && itemData.link_type.toLowerCase().includes(q));
                item.style.display = matches ? '' : 'none';
            }
        });

        container.querySelectorAll('.folder-item, .ungrouped-folder').forEach((folder) => {
            const visibleItems = folder.querySelectorAll('.folder-item-entry:not([style*="display: none"])');
            const childFolders = folder.querySelectorAll('.folder-item');
            if (q && visibleItems.length === 0 && childFolders.length === 0) {
                folder.style.display = 'none';
            } else {
                folder.style.display = '';
            }
        });
    }
    
    // ==================== Public API ====================
    
    DW.assets = {
        coordOffsetToMeters,
        metersToCoordOffset,
        metresPerDegree,
        assetMeterToPixel,
        pixelToAssetMeter,
        referencePixelForClick,
        renderAssetsOnCanvas,
        repositionAssets,
        updateMarkerScale,
        assetLabelStyle,
        coordAxisLabel,
        formatCoordPair,
        updateCoordinateLabels,
        isDegreeUnit,
        createAssetShape,
        createStarPoints,
        selectAsset,
        updateAssetPositionFromCanvas,
        updateAssetPosition,
        saveAssetAdjustment,
        toggleAssetVisibility,
        refreshAssets,
        clearAssetsFromCanvas,
        renderAssetList,
        filterFolderItems
    };
    
    // Expose globally for backward compatibility
    window.coordOffsetToMeters = coordOffsetToMeters;
    window.metersToCoordOffset = metersToCoordOffset;
    window.assetMeterToPixel = assetMeterToPixel;
    window.pixelToAssetMeter = pixelToAssetMeter;
    window.referencePixelForClick = referencePixelForClick;
    window.renderAssetsOnCanvas = renderAssetsOnCanvas;
    window.repositionAssets = repositionAssets;
    window.updateMarkerScale = updateMarkerScale;
    window.formatCoordPair = formatCoordPair;
    window.updateCoordinateLabels = updateCoordinateLabels;
    window.createAssetShape = createAssetShape;
    window.createStarPoints = createStarPoints;
    window.selectAsset = selectAsset;
    window.updateAssetPositionFromCanvas = updateAssetPositionFromCanvas;
    window.updateAssetPosition = updateAssetPosition;
    window.saveAssetAdjustment = saveAssetAdjustment;
    window.toggleAssetVisibility = toggleAssetVisibility;
    window.refreshAssets = refreshAssets;
    window.clearAssetsFromCanvas = clearAssetsFromCanvas;
    window.renderAssetList = renderAssetList;
    window.filterFolderItems = filterFolderItems;
    window.filterAssetList = (query) => filterFolderItems(query, 'asset');
    window.filterLinkList = (query) => filterFolderItems(query, 'link');
    
})();
