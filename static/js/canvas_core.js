/**
 * Canvas Core - State Management and Initialization
 * Core state variables and initialization for the canvas editor
 */

// IMMEDIATE FIX: Patch CanvasRenderingContext2D to fix Fabric.js 'alphabetical' textBaseline bug
// This must run BEFORE any Fabric.js code to prevent console spam
(function() {
    const originalTextBaselineSetter = Object.getOwnPropertyDescriptor(
        CanvasRenderingContext2D.prototype, 'textBaseline'
    );
    if (originalTextBaselineSetter && originalTextBaselineSetter.set) {
        Object.defineProperty(CanvasRenderingContext2D.prototype, 'textBaseline', {
            set: function(value) {
                // Convert deprecated 'alphabetical' to valid 'alphabetic'
                if (value === 'alphabetical') {
                    value = 'alphabetic';
                }
                originalTextBaselineSetter.set.call(this, value);
            },
            get: originalTextBaselineSetter.get
        });
    }
})();

// ==================== Global State ====================

// Canvas instance
let canvas = null;

// Mode state
let currentMode = 'pan';
let selectedSheet = null;
let selectedAsset = null;
let selectedMeasurementId = null;

// Data arrays
let sheets = [];
let assets = [];
let links = [];
let linksVisible = true;

// Calibration
let calibrationPoints = [];

// Crop/Cut tool state
let cropRect = null;
let cropStart = null;
let isCropping = false;
let sheetCutData = {};
let cutStatsLabel = null;
let showUncutSheetId = null;

// Viewport state
let viewportRotation = 0;
let currentZoomLevel = 1;

// Asset layer calibration state
let assetRotationDeg = 0;
let refAssetId = '';
let refPixelX = 0, refPixelY = 0;
let verifyRefMarker = null;

// Measurement tool state (legacy - now handled by MeasurementTool module)
let measurePoints = [];
let measureMode = 'single';
let measureOverlays = [];
let measurePreviewLine = null;
let measurePreviewLabel = null;

// PDF inversion state
let isPdfInverted = false;

// Layer group and measurement set state
let assetGroups = [];
let linkGroups = [];
let sheetGroups = [];
let measurementGroups = [];
let measurementSets = [];
let groupVisibility = {};
let draggedItem = null;

// Undo system
const undoStack = [];
const MAX_UNDO_STEPS = 50;

// ==================== CSRF Token ====================

function getCSRFToken() {
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
}

// ==================== Undo System ====================

function saveUndoState(actionType, data) {
    undoStack.push({
        type: actionType,
        timestamp: Date.now(),
        data: JSON.parse(JSON.stringify(data))
    });

    if (undoStack.length > MAX_UNDO_STEPS) {
        undoStack.shift();
    }

    console.log('Undo state saved:', actionType, data);
}

async function undo() {
    if (undoStack.length === 0) {
        console.log('Nothing to undo');
        return;
    }

    const lastAction = undoStack.pop();
    console.log('Undoing action:', lastAction.type, lastAction.data);

    switch (lastAction.type) {
        case 'transform':
            await undoTransform(lastAction.data);
            break;
        case 'cut':
            await undoCut(lastAction.data);
            break;
        case 'clearCut':
            await undoClearCut(lastAction.data);
            break;
    }
}

async function undoTransform(data) {
    const { sheetId, previousX, previousY, previousRotation } = data;

    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        sheetObj.set({
            left: previousX,
            top: previousY,
            angle: previousRotation
        });
        sheetObj.setCoords();
        canvas.renderAll();

        const index = sheets.findIndex(s => s.id === sheetId);
        if (index >= 0) {
            sheets[index].offset_x = previousX;
            sheets[index].offset_y = previousY;
            sheets[index].rotation = previousRotation;
        }

        if (selectedSheet && selectedSheet.id === sheetId) {
            document.getElementById('sheet-offset-x').value = previousX;
            document.getElementById('sheet-offset-y').value = previousY;
            document.getElementById('sheet-rotation').value = previousRotation.toFixed(1);
            selectedSheet.offset_x = previousX;
            selectedSheet.offset_y = previousY;
            selectedSheet.rotation = previousRotation;
        }

        await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                offset_x: previousX,
                offset_y: previousY,
                rotation: previousRotation
            })
        });
    }
}

async function undoCut(data) {
    const { sheetId, previousCutData } = data;

    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        if (previousCutData && previousCutData.length > 0) {
            sheetCutData[sheetId] = previousCutData;
            applyAllCuts(sheetObj, previousCutData);
        } else {
            sheetObj.clipPath = null;
            sheetObj._clipPolygon = null;
            if (sheetObj._originalRender) {
                sheetObj._render = sheetObj._originalRender;
                delete sheetObj._originalRender;
            }
            delete sheetCutData[sheetId];
            sheetObj.objectCaching = true;
            sheetObj.dirty = true;
            canvas.renderAll();
        }

        await saveCutData(sheetId, previousCutData || []);
    }
}

async function undoClearCut(data) {
    const { sheetId, cutData } = data;

    if (!cutData || cutData.length === 0) return;

    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        sheetCutData[sheetId] = cutData;
        applyAllCuts(sheetObj, cutData);
        await saveCutData(sheetId, cutData);
    }
}

// ==================== Canvas Initialization ====================

function initCanvas() {
    const container = document.getElementById('canvas-container');
    const containerRect = container.getBoundingClientRect();

    const canvasEl = document.createElement('canvas');
    canvasEl.id = 'main-canvas';
    container.appendChild(canvasEl);

    canvas = new fabric.Canvas('main-canvas', {
        width: containerRect.width,
        height: containerRect.height,
        selection: false,
        preserveObjectStacking: true,
        renderOnAddRemove: false,
        enableRetinaScaling: true
    });

    canvas.backgroundColor = '#e0e0e0';
    canvas.renderAll();

    setupCanvasEvents();
    setupKeyboardShortcuts();

    window.addEventListener('resize', () => {
        const rect = container.getBoundingClientRect();
        canvas.setDimensions({ width: rect.width, height: rect.height });
        canvas.renderAll();
    });
}

// Export for other modules
window.CanvasCore = {
    getCanvas: () => canvas,
    getCSRFToken,
    saveUndoState,
    undo
};
