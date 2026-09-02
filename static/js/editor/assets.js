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
    
    /**
     * Convert coordinate offsets to meter offsets.
     * For degrees: uses equirectangular approximation.
     */
    function coordOffsetToMeters(dx, dy, refY) {
        const isDegrees = ['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit);
        if (isDegrees) {
            const centerLatRad = (refY || 0) * Math.PI / 180;
            return {
                x: dx * 111320 * Math.cos(centerLatRad),
                y: -(dy * 111320)
            };
        }
        return { x: dx, y: dy };
    }
    
    /**
     * Convert meter offsets back to coordinate offsets.
     */
    function metersToCoordOffset(mx, my, refY) {
        const isDegrees = ['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit);
        if (isDegrees) {
            const centerLatRad = (refY || 0) * Math.PI / 180;
            const cosLat = Math.cos(centerLatRad);
            return {
                x: cosLat !== 0 ? mx / (111320 * cosLat) : 0,
                y: -(my / 111320)
            };
        }
        return { x: mx, y: my };
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

        if (state.refAssetId) {
            const refAsset = state.assets.find(a => a.asset_id === state.refAssetId);
            if (refAsset) {
                const refCoordX = refAsset.current_x;
                const refCoordY = refAsset.current_y;

                const dCoordX = meterX - refCoordX;
                const dCoordY = meterY - refCoordY;

                const dm = coordOffsetToMeters(dCoordX, dCoordY, refCoordY);

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

        if (state.refAssetId) {
            const refAsset = state.assets.find(a => a.asset_id === state.refAssetId);
            if (refAsset) {
                const dpx = pixelX - state.refPixelX;
                const dpy = pixelY - state.refPixelY;

                const rad = -state.assetRotationDeg * Math.PI / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const rotDpx = dpx * cos - dpy * sin;
                const rotDpy = dpx * sin + dpy * cos;

                const dmx = rotDpx / ppm;
                const dmy = rotDpy / ppm;

                const dCoord = metersToCoordOffset(dmx, dmy, refAsset.current_y);

                return {
                    x: refAsset.current_x + dCoord.x,
                    y: refAsset.current_y + dCoord.y
                };
            }
        }
        
        const mx = (pixelX - PROJECT_DATA.origin_x) / ppm;
        const my = (pixelY - PROJECT_DATA.origin_y) / ppm;
        const coord = metersToCoordOffset(mx, my, 0);
        return { x: coord.x, y: coord.y };
    }
    
    // ==================== Asset Rendering ====================
    
    function renderAssetsOnCanvas() {
        const canvas = state.canvas;
        
        if (!state.refAssetId || (state.refPixelX === 0 && state.refPixelY === 0)) {
            return;
        }

        state.assets.forEach(asset => {
            if (asset.layer_group && state.groupVisibility[asset.layer_group] === false) {
                return;
            }

            const pos = assetMeterToPixel(asset.current_x, asset.current_y);
            const assetObj = createAssetShape(asset, pos.x, pos.y);
            assetObj.assetData = asset;
            canvas.add(assetObj);
        });

        canvas.renderAll();
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

        obj.set({
            left: x,
            top: y,
            selectable: true,
            hasControls: false
        });

        const label = new fabric.Text(asset.name || asset.asset_id, {
            fontSize: 10,
            fill: '#000',
            left: x + size / 2 + 3,
            top: y - 5,
            selectable: false
        });

        const group = new fabric.Group([obj, label], {
            left: x,
            top: y,
            selectable: true,
            hasControls: false,
            hasBorders: true,
            lockScalingX: true,
            lockScalingY: true,
            lockRotation: true,
            cornerSize: 0
        });
        
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
                if (oldGroup) {
                    const groupLeft = oldGroup.left;
                    const groupTop = oldGroup.top;
                    
                    const newLabel = new fabric.Text(asset.name || asset.asset_id, {
                        fontSize: 10,
                        fill: '#000',
                        originX: 'left',
                        originY: 'center'
                    });
                    
                    const newGroup = new fabric.Group([img, newLabel], {
                        left: groupLeft,
                        top: groupTop,
                        selectable: true,
                        hasControls: false,
                        hasBorders: true,
                        lockScalingX: true,
                        lockScalingY: true,
                        lockRotation: true,
                        cornerSize: 0
                    });
                    
                    newGroup.setControlsVisibility({
                        tl: false, tr: false, bl: false, br: false,
                        ml: false, mt: false, mr: false, mb: false,
                        mtr: false
                    });
                    
                    newGroup.assetData = oldGroup.assetData;
                    state.canvas.remove(oldGroup);
                    state.canvas.add(newGroup);
                    state.canvas.renderAll();
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

        document.getElementById('no-selection').style.display = 'none';
        document.getElementById('sheet-properties').style.display = 'none';
        document.getElementById('asset-properties').style.display = 'block';

        document.getElementById('asset-id').value = state.selectedAsset.asset_id;
        document.getElementById('asset-name').value = state.selectedAsset.name || '';
        document.getElementById('asset-orig-x').value = state.selectedAsset.original_x;
        document.getElementById('asset-orig-y').value = state.selectedAsset.original_y;
        document.getElementById('asset-adj-x').value = state.selectedAsset.adjusted_x || state.selectedAsset.original_x;
        document.getElementById('asset-adj-y').value = state.selectedAsset.adjusted_y || state.selectedAsset.original_y;
        
        if (typeof showTab === 'function') {
            showTab('properties');
        }
    }
    
    // ==================== Asset Visibility ====================
    
    function toggleAssetVisibility(assetId, visible) {
        const asset = state.assets.find(a => a.id === assetId);
        if (asset) {
            asset.visible = visible;
        }
        state.canvas.getObjects().forEach(obj => {
            if (obj.assetData && obj.assetData.id === assetId) {
                obj.visible = visible;
            }
        });
        state.canvas.renderAll();
    }
    
    function refreshAssets() {
        const canvas = state.canvas;
        const toRemove = canvas.getObjects().filter(obj => obj.assetData);
        toRemove.forEach(obj => canvas.remove(obj));
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
        assetMeterToPixel,
        pixelToAssetMeter,
        renderAssetsOnCanvas,
        createAssetShape,
        createStarPoints,
        selectAsset,
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
    window.renderAssetsOnCanvas = renderAssetsOnCanvas;
    window.createAssetShape = createAssetShape;
    window.createStarPoints = createStarPoints;
    window.selectAsset = selectAsset;
    window.toggleAssetVisibility = toggleAssetVisibility;
    window.refreshAssets = refreshAssets;
    window.clearAssetsFromCanvas = clearAssetsFromCanvas;
    window.renderAssetList = renderAssetList;
    window.filterFolderItems = filterFolderItems;
    window.filterAssetList = (query) => filterFolderItems(query, 'asset');
    window.filterLinkList = (query) => filterFolderItems(query, 'link');
    
    console.log('DocuWeaver assets module loaded');
})();
