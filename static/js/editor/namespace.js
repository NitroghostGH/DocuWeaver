/**
 * DocuWeaver Canvas Editor - Global Namespace
 * 
 * This file establishes the shared namespace and state for all editor modules.
 * MUST be loaded first before any other editor modules.
 * 
 * Module Loading Order:
 * 1. namespace.js (this file) - Shared state and utilities
 * 2. canvas_init.js - Canvas initialization and events
 * 3. tools.js - Tool modes (pan, select, crop, split, calibrate, measure)
 * 4. sheets.js - Sheet rendering and manipulation
 * 5. assets.js - Asset rendering and manipulation  
 * 6. links.js - Link layer rendering
 * 7. osm.js - OpenStreetMap tile layer
 * 8. layers.js - Layer groups and folder management
 * 9. measurements.js - Measurement tool and config
 * 10. viewport.js - Zoom, pan, rotation
 * 11. modals.js - Modal dialogs and forms
 * 12. main.js - Initialization and event binding
 */

// Create the global namespace
window.DocuWeaver = window.DocuWeaver || {};

// ==================== Fabric.js Patch ====================
// Fix 'alphabetical' textBaseline bug - MUST run before any Fabric.js code
(function() {
    const originalTextBaselineSetter = Object.getOwnPropertyDescriptor(
        CanvasRenderingContext2D.prototype, 'textBaseline'
    );
    if (originalTextBaselineSetter && originalTextBaselineSetter.set) {
        Object.defineProperty(CanvasRenderingContext2D.prototype, 'textBaseline', {
            set: function(value) {
                if (value === 'alphabetical') {
                    value = 'alphabetic';
                }
                originalTextBaselineSetter.set.call(this, value);
            },
            get: originalTextBaselineSetter.get
        });
    }
})();

// ==================== Shared State ====================
// All modules access state through DocuWeaver.state

DocuWeaver.state = {
    // Canvas instance
    canvas: null,
    
    // Mode state
    currentMode: 'pan',
    selectedSheet: null,
    selectedAsset: null,
    selectedMeasurementId: null,
    
    // Data arrays
    sheets: [],
    assets: [],
    links: [],
    linksVisible: true,
    
    // Calibration
    calibrationPoints: [],
    
    // Crop/Cut tool state
    cropRect: null,
    cropStart: null,
    isCropping: false,
    sheetCutData: {},
    cutStatsLabel: null,
    showUncutSheetId: null,
    
    // Viewport state
    viewportRotation: 0,
    currentZoomLevel: 1,
    
    // Asset layer calibration
    assetRotationDeg: 0,
    refAssetId: '',
    refPixelX: 0,
    refPixelY: 0,
    verifyRefMarker: null,
    
    // Measurement state
    measurePoints: [],
    measureMode: 'single',
    measureOverlays: [],
    measurePreviewLine: null,
    measurePreviewLabel: null,
    
    // PDF inversion
    isPdfInverted: false,
    
    // Rendering hierarchy (order in which layer types are rendered)
    // Default order: sheets (bottom), links, assets, measurements (top)
    renderingHierarchy: ['sheets', 'links', 'assets', 'measurements'],
    
    // Layer groups
    assetGroups: [],
    linkGroups: [],
    sheetGroups: [],
    measurementGroups: [],
    measurementSets: [],
    groupVisibility: {},
    draggedItem: null,
    
    // OSM layer
    osmTiles: [],
    osmEnabled: false,
    osmOpacity: 0.7,
    osmZIndex: 0,
    osmRefreshTimeout: null,
    osmDarkMode: false,
    osmCurrentZoom: null,
    osmLoadedTiles: new Map(),
    osmTileCache: {},
    osmTileCacheStats: {
        maxSize: 20 * 1024 * 1024,
        currentSize: 0,
        hits: 0,
        misses: 0
    },
    
    // Undo system
    undoStack: [],
    MAX_UNDO_STEPS: 50,
    
    // Split tool state
    splitLine: null,
    splitLineStart: null,
    splitTargetSheet: null,
    isSplitting: false,
    
    // Cut line state
    cutLine: null,
    cutLineStart: null,
    targetSheetObj: null
};

// ==================== Utility Functions ====================

/**
 * Get CSRF token from cookies (required for Django)
 */
DocuWeaver.getCSRFToken = function() {
    const name = 'csrftoken';
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
};

/**
 * Show toast notification
 */
DocuWeaver.showToast = function(message, type = 'info', duration = 3000) {
    const toast = document.getElementById('notification-toast');
    if (!toast) return;
    
    toast.textContent = message;
    toast.className = `notification-toast show ${type}`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
};

/**
 * Shorthand for getting canvas
 */
DocuWeaver.getCanvas = function() {
    return DocuWeaver.state.canvas;
};

// ==================== Legacy Compatibility ====================
// These global variables and functions ensure backward compatibility
// with existing code that hasn't been migrated yet

// Expose state variables globally for legacy code
window.canvas = null;  // Will be set by canvas_init.js
window.getCSRFToken = DocuWeaver.getCSRFToken;
window.showToast = DocuWeaver.showToast;

// Sync legacy globals with state (called after state changes)
DocuWeaver.syncLegacyGlobals = function() {
    window.canvas = DocuWeaver.state.canvas;
    window.currentMode = DocuWeaver.state.currentMode;
    window.selectedSheet = DocuWeaver.state.selectedSheet;
    window.selectedAsset = DocuWeaver.state.selectedAsset;
    window.sheets = DocuWeaver.state.sheets;
    window.assets = DocuWeaver.state.assets;
    window.links = DocuWeaver.state.links;
    window.viewportRotation = DocuWeaver.state.viewportRotation;
    window.currentZoomLevel = DocuWeaver.state.currentZoomLevel;
    window.sheetCutData = DocuWeaver.state.sheetCutData;
    window.assetRotationDeg = DocuWeaver.state.assetRotationDeg;
    window.refAssetId = DocuWeaver.state.refAssetId;
    window.refPixelX = DocuWeaver.state.refPixelX;
    window.refPixelY = DocuWeaver.state.refPixelY;
};

console.log('DocuWeaver namespace initialized');
