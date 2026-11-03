/**
 * DocuWeaver Canvas Editor - OpenStreetMap Module
 * 
 * Handles OSM tile layer rendering, caching, and management.
 * 
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // OSM-specific state (initialized from DW.state or here)
    let osmRefreshTimeout = null;
    
    // ==================== Coordinate Conversions ====================
    
    /**
     * Convert lat/lon to Web Mercator coordinates (EPSG:3857).
     */
    function latLonToWebMercator(lat, lon) {
        const R = 6378137;
        const x = R * lon * Math.PI / 180;
        const latRad = lat * Math.PI / 180;
        const y = R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
        return { x, y };
    }
    
    /**
     * Convert Web Mercator coordinates back to lat/lon.
     */
    function webMercatorToLatLon(x, y) {
        const R = 6378137;
        const lon = (x / R) * 180 / Math.PI;
        const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
        return { lat, lon };
    }
    
    /**
     * Calculate the appropriate OSM zoom level based on pixels_per_meter and canvas zoom.
     */
    function calculateOSMZoom() {
        const ppm = PROJECT_DATA.pixels_per_meter;
        if (!ppm || ppm <= 0) return 15;
        
        const effectiveMetersPerPixel = 1 / (ppm * state.currentZoomLevel);
        const zoom = Math.log2(156543.03 / effectiveMetersPerPixel);
        
        return Math.max(10, Math.min(19, Math.round(zoom)));
    }
    
    /**
     * Get tile coordinates for a given lat/lon at a specific zoom level.
     */
    function latLonToTile(lat, lon, zoom) {
        const n = Math.pow(2, zoom);
        lat = Math.max(-85.0511, Math.min(85.0511, lat));
        lon = Math.max(-180, Math.min(180, lon));
        
        const x = Math.floor((lon + 180) / 360 * n);
        const latRad = lat * Math.PI / 180;
        const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
        
        return { 
            x: Math.max(0, Math.min(n - 1, x)),
            y: Math.max(0, Math.min(n - 1, y))
        };
    }
    
    /**
     * Get lat/lon bounds for a tile.
     */
    function tileToBounds(tileX, tileY, zoom) {
        const n = Math.pow(2, zoom);
        const lonMin = tileX / n * 360 - 180;
        const lonMax = (tileX + 1) / n * 360 - 180;
        
        const latRadMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + 1) / n)));
        const latRadMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n)));
        const latMin = latRadMin * 180 / Math.PI;
        const latMax = latRadMax * 180 / Math.PI;
        
        return { latMin, latMax, lonMin, lonMax };
    }
    
    // ==================== Tile Cache Management ====================
    
    function getOSMCacheKey(tileX, tileY, zoom, isDarkMode) {
        return `osm_tile_${zoom}_${tileX}_${tileY}_${isDarkMode ? 'dark' : 'light'}`;
    }
    
    function getOSMTileFromCache(tileX, tileY, zoom, isDarkMode) {
        const key = getOSMCacheKey(tileX, tileY, zoom, isDarkMode);
        if (state.osmTileCache[key]) {
            state.osmTileCacheStats.hits++;
            return state.osmTileCache[key];
        }
        state.osmTileCacheStats.misses++;
        return null;
    }
    
    function storeOSMTileInCache(tileX, tileY, zoom, isDarkMode, dataUrl) {
        const key = getOSMCacheKey(tileX, tileY, zoom, isDarkMode);
        const estimatedSize = dataUrl.length;
        
        if (state.osmTileCacheStats.currentSize + estimatedSize > state.osmTileCacheStats.maxSize) {
            pruneOSMTileCache(estimatedSize);
        }
        
        state.osmTileCache[key] = dataUrl;
        state.osmTileCacheStats.currentSize += estimatedSize;
    }
    
    function pruneOSMTileCache(requiredSpace) {
        
        const cacheKeys = Object.keys(state.osmTileCache);
        let freedSpace = 0;
        let deletedCount = 0;
        
        for (let i = 0; i < cacheKeys.length && freedSpace < requiredSpace; i++) {
            const key = cacheKeys[i];
            const dataUrl = state.osmTileCache[key];
            const tileSize = dataUrl.length;
            
            delete state.osmTileCache[key];
            state.osmTileCacheStats.currentSize -= tileSize;
            freedSpace += tileSize;
            deletedCount++;
        }
        
    }
    
    function clearOSMTileCache() {
        state.osmTileCache = {};
        state.osmTileCacheStats.currentSize = 0;
        state.osmTileCacheStats.hits = 0;
        state.osmTileCacheStats.misses = 0;
    }
    
    function getOSMCacheStats() {
        const hitRate = state.osmTileCacheStats.hits + state.osmTileCacheStats.misses > 0 
            ? (state.osmTileCacheStats.hits / (state.osmTileCacheStats.hits + state.osmTileCacheStats.misses) * 100).toFixed(1)
            : 0;
        
        return {
            size: `${(state.osmTileCacheStats.currentSize / 1024 / 1024).toFixed(2)} MB / ${(state.osmTileCacheStats.maxSize / 1024 / 1024).toFixed(1)} MB`,
            tiles: Object.keys(state.osmTileCache).length,
            hits: state.osmTileCacheStats.hits,
            misses: state.osmTileCacheStats.misses,
            hitRate: `${hitRate}%`
        };
    }
    
    // ==================== OSM Layer Rendering ====================
    
    function renderOSMLayer() {
        renderOSMLayerAtZoom(null);
    }
    
    function renderOSMLayerAtZoom(forcedZoom) {
        if (!state.osmEnabled || !state.refAssetId) {
            return;
        }
        
        const isDegrees = ['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit);
        if (!isDegrees) {
            return;
        }

        const canvas = state.canvas;
        const zoom = forcedZoom !== null ? forcedZoom : calculateOSMZoom();
        
        // Get canvas viewport bounds
        const vpt = canvas.viewportTransform;
        const canvasWidth = canvas.getWidth();
        const canvasHeight = canvas.getHeight();
        
        // Transform screen corners to world coordinates
        const invVpt = fabric.util.invertTransform(vpt);
        const topLeftCanvas = fabric.util.transformPoint({ x: 0, y: 0 }, invVpt);
        const topRightCanvas = fabric.util.transformPoint({ x: canvasWidth, y: 0 }, invVpt);
        const bottomLeftCanvas = fabric.util.transformPoint({ x: 0, y: canvasHeight }, invVpt);
        const bottomRightCanvas = fabric.util.transformPoint({ x: canvasWidth, y: canvasHeight }, invVpt);
        
        // Convert to lat/lon
        const topLeft = pixelToAssetMeter(topLeftCanvas.x, topLeftCanvas.y);
        const topRight = pixelToAssetMeter(topRightCanvas.x, topRightCanvas.y);
        const bottomLeft = pixelToAssetMeter(bottomLeftCanvas.x, bottomLeftCanvas.y);
        const bottomRight = pixelToAssetMeter(bottomRightCanvas.x, bottomRightCanvas.y);
        
        const allLons = [topLeft.x, topRight.x, bottomLeft.x, bottomRight.x];
        const allLats = [topLeft.y, topRight.y, bottomLeft.y, bottomRight.y];
        const minLon = Math.min(...allLons);
        const maxLon = Math.max(...allLons);
        const minLat = Math.min(...allLats);
        const maxLat = Math.max(...allLats);
        
        // Validate coordinates
        if (!isFinite(minLon) || !isFinite(maxLon) || 
            !isFinite(minLat) || !isFinite(maxLat) ||
            Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 ||
            Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) {
            console.error('Invalid lat/lon coordinates for OSM');
            return;
        }
        
        // Get tile range
        const tileTL_noPad = latLonToTile(maxLat, minLon, zoom);
        const tileBR_noPad = latLonToTile(minLat, maxLon, zoom);
        
        const baseTileCount = (tileBR_noPad.x - tileTL_noPad.x + 1) * (tileBR_noPad.y - tileTL_noPad.y + 1);
        
        // Calculate padding
        const isRotated = Math.abs(state.viewportRotation % 90) > 0.5;
        const rotationPaddingMultiplier = isRotated ? 1.5 : 1;
        let tilePadding = baseTileCount > 80 ? 0 : (baseTileCount > 40 ? 1 : 2);
        tilePadding = Math.ceil(tilePadding * rotationPaddingMultiplier);
        
        const tileTL = {
            x: Math.max(0, tileTL_noPad.x - tilePadding),
            y: Math.max(0, tileTL_noPad.y - tilePadding)
        };
        const tileBR = {
            x: Math.min(Math.pow(2, zoom) - 1, tileBR_noPad.x + tilePadding),
            y: Math.min(Math.pow(2, zoom) - 1, tileBR_noPad.y + tilePadding)
        };
        
        const tileCount = (tileBR.x - tileTL.x + 1) * (tileBR.y - tileTL.y + 1);
        
        // Limit tiles
        const maxTiles = 150;
        if (tileCount > maxTiles) {
            const reducedZoom = zoom - 1;
            if (reducedZoom >= 10) {
                console.warn(`Too many tiles (${tileCount}), reducing to zoom ${reducedZoom}`);
                renderOSMLayerAtZoom(reducedZoom);
                return;
            }
            console.error(`Viewport too large for OSM rendering`);
            return;
        }
        
        // Track needed tiles
        const neededTiles = new Set();
        for (let tileX = tileTL.x; tileX <= tileBR.x; tileX++) {
            for (let tileY = tileTL.y; tileY <= tileBR.y; tileY++) {
                neededTiles.add(`${tileX}_${tileY}_${zoom}`);
            }
        }
        
        // Remove tiles that don't match current theme
        state.osmLoadedTiles.forEach((tileObj, tileKey) => {
            if (tileObj.darkMode !== state.osmDarkMode) {
                canvas.remove(tileObj.tile);
                state.osmTiles = state.osmTiles.filter(t => t !== tileObj.tile);
                state.osmLoadedTiles.delete(tileKey);
            }
        });
        
        // Handle zoom changes
        const zoomChanged = state.osmCurrentZoom !== null && state.osmCurrentZoom !== zoom;
        if (zoomChanged) {
            state.osmLoadedTiles.forEach((tileObj, tileKey) => {
                if (!neededTiles.has(tileKey)) {
                    tileObj.pendingDelete = true;
                }
            });
        } else {
            state.osmLoadedTiles.forEach((tileObj, tileKey) => {
                if (!neededTiles.has(tileKey)) {
                    canvas.remove(tileObj.tile);
                    state.osmTiles = state.osmTiles.filter(t => t !== tileObj.tile);
                    state.osmLoadedTiles.delete(tileKey);
                }
            });
        }
        
        state.osmCurrentZoom = zoom;
        
        // Load new tiles. A tile still on its way isn't requested again: it
        // used to be added twice, and the copies' opacity stacked.
        let tilesLoading = 0;
        for (let tileX = tileTL.x; tileX <= tileBR.x; tileX++) {
            for (let tileY = tileTL.y; tileY <= tileBR.y; tileY++) {
                const tileKey = `${tileX}_${tileY}_${zoom}`;
                if (!state.osmLoadedTiles.has(tileKey) && !state.osmPendingTiles.has(tileKey)) {
                    loadOSMTile(tileX, tileY, zoom);
                    tilesLoading++;
                }
            }
        }
        
        // Cleanup old tiles after new ones load
        if (zoomChanged && tilesLoading > 0) {
            setTimeout(() => {
                state.osmLoadedTiles.forEach((tileObj, tileKey) => {
                    if (tileObj.pendingDelete) {
                        canvas.remove(tileObj.tile);
                        state.osmTiles = state.osmTiles.filter(t => t !== tileObj.tile);
                        state.osmLoadedTiles.delete(tileKey);
                    }
                });
                canvas.requestRenderAll();
            }, 200);
        }
    }
    
    // Bumped when the layer is cleared, so tiles requested before that are
    // dropped when they arrive.
    let osmGeneration = 0;

    function tileStillWanted(generation, zoom, darkMode) {
        return generation === osmGeneration && state.osmEnabled &&
            state.osmCurrentZoom === zoom && state.osmDarkMode === darkMode;
    }

    function loadOSMTile(tileX, tileY, zoom) {
        const tileKey = `${tileX}_${tileY}_${zoom}`;
        const darkMode = state.osmDarkMode;
        const generation = osmGeneration;
        const url = darkMode
            ? `https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/${zoom}/${tileX}/${tileY}.png`
            : `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`;

        state.osmPendingTiles.add(tileKey);
        const done = () => state.osmPendingTiles.delete(tileKey);

        const cachedDataUrl = getOSMTileFromCache(tileX, tileY, zoom, darkMode);
        if (cachedDataUrl) {
            addOSMTileToCanvas(cachedDataUrl, tileX, tileY, zoom, darkMode, generation, done);
            return;
        }

        fabric.Image.fromURL(url, function(img, isError) {
            if (isError || !img.getElement()) {
                done();
                return;
            }
            // Convert to data URL for caching
            const canvasTemp = document.createElement('canvas');
            canvasTemp.width = img.width;
            canvasTemp.height = img.height;
            canvasTemp.getContext('2d').drawImage(img.getElement(), 0, 0);
            const dataUrl = canvasTemp.toDataURL('image/png');

            storeOSMTileInCache(tileX, tileY, zoom, darkMode, dataUrl);
            addOSMTileToCanvas(dataUrl, tileX, tileY, zoom, darkMode, generation, done);
        }, { crossOrigin: 'anonymous' });
    }

    function addOSMTileToCanvas(dataUrl, tileX, tileY, zoom, darkMode, generation, done) {
        const canvas = state.canvas;
        const bounds = tileToBounds(tileX, tileY, zoom);

        // Convert corners to pixel coordinates
        const topLeft = assetMeterToPixel(bounds.lonMin, bounds.latMax);
        const topRight = assetMeterToPixel(bounds.lonMax, bounds.latMax);
        const bottomLeft = assetMeterToPixel(bounds.lonMin, bounds.latMin);
        const bottomRight = assetMeterToPixel(bounds.lonMax, bounds.latMin);

        const centerX = (topLeft.x + topRight.x + bottomLeft.x + bottomRight.x) / 4;
        const centerY = (topLeft.y + topRight.y + bottomLeft.y + bottomRight.y) / 4;

        const width = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
        const height = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);
        const angle = Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x) * 180 / Math.PI;

        fabric.Image.fromURL(dataUrl, function(img, isError) {
            done();
            if (isError || !img.getElement() || !tileStillWanted(generation, zoom, darkMode)) return;
            const tileKey = `${tileX}_${tileY}_${zoom}`;
            if (state.osmLoadedTiles.has(tileKey)) return;

            img.set({
                left: centerX,
                top: centerY,
                originX: 'center',
                originY: 'center',
                scaleX: width / 256,
                scaleY: height / 256,
                angle: angle,
                opacity: state.osmOpacity,
                selectable: false,
                evented: false,
                isOSMTile: true,
                osmDarkMode: darkMode,
                tileInfo: { x: tileX, y: tileY, zoom: zoom }
            });

            // The basemap is always the bottom layer. Inserting it there
            // directly replaces re-sorting the whole canvas for every tile.
            canvas.insertAt(img, 0);
            state.osmTiles.push(img);
            state.osmLoadedTiles.set(tileKey, { tile: img, zoom: zoom, darkMode: darkMode });
            canvas.requestRenderAll();
        }, { crossOrigin: 'anonymous' });
    }

    function clearOSMLayer() {
        const canvas = state.canvas;
        osmGeneration++;
        state.osmTiles.forEach(tile => canvas.remove(tile));
        state.osmTiles = [];
        state.osmLoadedTiles.clear();
        state.osmPendingTiles.clear();
        state.osmCurrentZoom = null;
    }
    
    /** Re-place the map after the overlay transform changed (scale, reference, rotation, unit). */
    function refreshOSMPlacement() {
        if (!state.osmEnabled) return;
        clearOSMLayer();
        renderOSMLayer();
    }

    function debouncedRefreshOSM() {
        if (!state.osmEnabled) return;
        
        if (osmRefreshTimeout) {
            clearTimeout(osmRefreshTimeout);
        }
        osmRefreshTimeout = setTimeout(() => {
            renderOSMLayer();
        }, 300);
    }
    
    function toggleOSMLayer() {
        state.osmEnabled = !state.osmEnabled;
        window.osmEnabled = state.osmEnabled;
        
        // Save OSM preference to localStorage for persistence
        try {
            localStorage.setItem('docuweaver-osm-enabled', state.osmEnabled ? 'true' : 'false');
        } catch (e) {
            console.warn('Could not save OSM preference to localStorage:', e);
        }
        
        if (state.osmEnabled) {
            if (!['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit)) {
                DW.showToast('The map needs latitude/longitude coordinates (Verify Assets > coordinate system)', 'warning', 5000);
            } else if (!state.refAssetId) {
                DW.showToast('Place a reference asset first (Verify Assets), so the map can be positioned', 'warning', 5000);
            }
            renderOSMLayer();
        } else {
            clearOSMLayer();
        }
        state.canvas.requestRenderAll();
        
        const btn = document.getElementById('osm-toggle-btn');
        if (btn) {
            btn.style.background = state.osmEnabled ? 'var(--bg-tool-btn-active)' : 'var(--bg-tool-btn)';
            btn.style.color = state.osmEnabled ? '#ffffff' : 'inherit';
        }
        
        saveOSMSettings();
    }
    
    let osmSaveTimeout = null;

    function updateOSMOpacity(opacity) {
        state.osmOpacity = parseFloat(opacity);
        window.osmOpacity = state.osmOpacity;

        state.osmTiles.forEach(tile => tile.set('opacity', state.osmOpacity));
        state.canvas.requestRenderAll();
        // The slider fires on every step; save once it settles.
        clearTimeout(osmSaveTimeout);
        osmSaveTimeout = setTimeout(saveOSMSettings, 400);
    }

    async function saveOSMSettings() {
        try {
            const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    osm_enabled: state.osmEnabled,
                    osm_opacity: state.osmOpacity
                })
            });
            if (!response.ok) throw new Error(await DW.responseError(response));
            const result = await response.json();
            PROJECT_DATA.osm_enabled = result.osm_enabled;
            PROJECT_DATA.osm_opacity = result.osm_opacity;
        } catch (error) {
            console.error('Error saving OSM settings:', error);
            DW.showToast('Could not save the map settings: ' + error.message, 'error');
        }
    }

    // ==================== Public API ====================
    
    DW.osm = {
        latLonToWebMercator,
        webMercatorToLatLon,
        calculateOSMZoom,
        latLonToTile,
        tileToBounds,
        getOSMCacheStats,
        clearOSMTileCache,
        renderOSMLayer,
        renderOSMLayerAtZoom,
        clearOSMLayer,
        refreshOSMPlacement,
        debouncedRefreshOSM,
        toggleOSMLayer,
        updateOSMOpacity,
        saveOSMSettings
    };
    
    // Expose globally for backward compatibility
    window.latLonToWebMercator = latLonToWebMercator;
    window.webMercatorToLatLon = webMercatorToLatLon;
    window.calculateOSMZoom = calculateOSMZoom;
    window.latLonToTile = latLonToTile;
    window.tileToBounds = tileToBounds;
    window.getOSMCacheStats = getOSMCacheStats;
    window.clearOSMTileCache = clearOSMTileCache;
    window.renderOSMLayer = renderOSMLayer;
    window.renderOSMLayerAtZoom = renderOSMLayerAtZoom;
    window.clearOSMLayer = clearOSMLayer;
    window.refreshOSMPlacement = refreshOSMPlacement;
    window.debouncedRefreshOSM = debouncedRefreshOSM;
    window.toggleOSMLayer = toggleOSMLayer;
    window.updateOSMOpacity = updateOSMOpacity;
    window.saveOSMSettings = saveOSMSettings;
    
})();
