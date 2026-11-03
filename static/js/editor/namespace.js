/**
 * DocuWeaver Canvas Editor - Global Namespace
 * 
 * This file establishes the shared namespace and state for all editor modules.
 * MUST be loaded first before any other editor modules.
 * 
 * The script order in templates/drawings/editor.html is the source of truth:
 * namespace, undo, viewport, tools, canvas_init, crop, split, calibration,
 * assets, links, sheets, osm, measurements, layers, imports, sidebar, main,
 * then verify (a self-check).
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
    measureMode: 'single',
    
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
    groupVisibility: {},
    folderById: new Map(),   // every folder, nested ones too (layers.js)
    hiddenSections: {},      // section eyes, per browser (main.js)
    hiddenBatches: {},       // import-batch eyes, per browser (imports.js)
    draggedItem: null,
    
    // OSM layer
    osmTiles: [],
    osmEnabled: false,
    osmOpacity: 0.7,
    osmRefreshTimeout: null,
    osmDarkMode: false,
    osmCurrentZoom: null,
    osmLoadedTiles: new Map(),
    osmPendingTiles: new Set(),
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
 * Per-browser settings in localStorage. Reads and writes can throw (private
 * windows, blocked site data), and the editor must work without them.
 */
DocuWeaver.storage = {
    get(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            // Not saved; the setting lasts until the page is reloaded.
        }
    }
};

/**
 * Compare names the way people number things: V2 before V10.
 */
DocuWeaver.naturalCompare = function(a, b) {
    return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
};

/**
 * A readable message from a failed API response: DRF field errors, our
 * {error} / {message} bodies, or the HTTP status.
 */
DocuWeaver.responseError = async function(response) {
    let body = null;
    try {
        body = await response.json();
    } catch (e) {
        return `HTTP ${response.status}`;
    }
    const flatten = (value) => {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(flatten).join(' ');
        if (typeof value === 'object') {
            return Object.entries(value)
                .map(([k, v]) => (k === 'non_field_errors' || k === 'error' || k === 'detail' || k === 'message')
                    ? flatten(v) : `${k}: ${flatten(v)}`)
                .join(' ');
        }
        return String(value);
    };
    return flatten(body.error || body.message || body.detail || body) || `HTTP ${response.status}`;
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

