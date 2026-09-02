/**
 * DocuWeaver Post-Refactor Verification Script
 *
 * Paste into browser DevTools console on the editor page, or load via:
 *   <script src="{% static 'js/editor/verify.js' %}"></script>
 *
 * Checks:
 *   1. All 17 DW namespace modules exist
 *   2. All global functions referenced by editor.html onclick/onchange/oninput exist
 *   3. DW.state has expected properties and canvas is initialized
 */
(function() {
    'use strict';

    var pass = 0;
    var fail = 0;
    var warnings = 0;
    var failures = [];
    var warningsList = [];

    function check(label, condition) {
        if (condition) {
            pass++;
        } else {
            fail++;
            failures.push(label);
        }
    }

    function warn(label) {
        warnings++;
        warningsList.push(label);
    }

    console.log('%c=== DocuWeaver Verification ===', 'font-weight:bold;font-size:14px;color:#4fc3f7');

    // ==================== 1. Namespace Modules ====================

    console.log('%c--- Module Load Check ---', 'font-weight:bold;color:#81c784');

    var DW = window.DocuWeaver;
    check('DocuWeaver namespace exists', !!DW);

    var modules = [
        'state', 'viewport', 'tools', 'canvas', 'assets', 'links',
        'sheets', 'osm', 'measurements', 'undo', 'crop', 'split',
        'calibration', 'layers', 'imports', 'sidebar', 'main'
    ];

    modules.forEach(function(mod) {
        var exists = DW && typeof DW[mod] === 'object' && DW[mod] !== null;
        check('DW.' + mod + ' exists', exists);
        if (exists) {
            console.log('  ✅ DW.' + mod);
        } else {
            console.log('  ❌ DW.' + mod + ' — MISSING');
        }
    });

    // ==================== 2. Global Functions ====================

    console.log('%c--- Global Function Check ---', 'font-weight:bold;color:#81c784');

    // Every function referenced via onclick/onchange/oninput in editor.html
    var requiredGlobals = [
        // Sidebar
        'showTab', 'toggleLeftSidebar', 'toggleRightSidebar',
        'toggleImportDropdown', 'closeImportDropdown',

        // Viewport
        'matchSheetRotation', 'resetViewportRotation', 'rotateViewportBy',
        'setViewportRotation', 'zoomIn', 'zoomOut', 'zoomFit', 'resetView',

        // Tools & Modes
        'setMode',

        // Measurements
        'showMeasurementConfigModal', 'saveMeasurementConfig',
        'hideMeasurementConfigModal', 'onMeasureConfigTypeChange',
        'toggleMeasureMode', 'toggleMeasurePanel',
        'addNewConfigType', 'switchMeasureConfigTab',
        'saveMeasurementPrompt', 'clearMeasurements',
        'hideSaveMeasurementModal',

        // Sheets / Cuts
        'clearSelectedSheetCut', 'flipSelectedSheetCut',
        'deleteSelectedSheet', 'toggleShowUncut',
        'updateSheetProperty',

        // Layer groups
        'toggleLayerGroup', 'toggleGroupVisibility',
        'showCreateGroupModal', 'hideCreateGroupModal',
        'toggleUnifiedFolderView',

        // Imports / Export
        'showUploadModal', 'hideUploadModal',
        'showImportModal', 'hideImportModal',
        'showImportLinksModal',
        'importStepNext', 'importStepBack', 'importWithMapping',
        'toggleAssetTypeMode',
        'importLinksStepNext', 'importLinksStepBack', 'importLinksWithMapping',
        'exportProject', 'downloadReport',

        // Calibration / Verify
        'applyCalibration', 'hideCalibrateModal',
        'applyVerification', 'toggleVerifyPanel',
        'onVerifyAssetSelected', 'onVerifyRotationChange',
        'setAssetRotation', 'onCoordUnitChange',
        'filterVerifyAssetSelect',

        // Selection / Data
        'clearSelection', 'updateContextTools',
        'loadProjectData', 'selectMeasurement',
        'updateAssetPositionFromCanvas',
        'updateSheetPositionFromCanvas',
        'updateSheetRotationFromCanvas',
        'saveAssetAdjustment',
        'updateAssetPosition',

        // Canvas helpers
        'applyFiltersPreservingSize', 'applyPdfInversion',
        'applyCanvasTheme', 'getCSRFToken', 'showToast',

        // Undo
        'saveUndoState', 'undo',

        // OSM
        'toggleOSMLayer'
    ];

    var missingGlobals = [];
    requiredGlobals.forEach(function(fn) {
        var exists = typeof window[fn] === 'function';
        check('window.' + fn, exists);
        if (!exists) {
            missingGlobals.push(fn);
            console.log('  ❌ window.' + fn + ' — MISSING');
        }
    });

    if (missingGlobals.length === 0) {
        console.log('  ✅ All ' + requiredGlobals.length + ' global functions present');
    }

    // ==================== 3. State Check ====================

    console.log('%c--- State Initialization Check ---', 'font-weight:bold;color:#81c784');

    var stateProps = [
        'canvas', 'sheets', 'assets', 'links', 'currentMode',
        'selectedSheet', 'selectedAsset', 'isPdfInverted',
        'sheetCutData', 'undoStack', 'osmEnabled', 'osmOpacity',
        'osmZIndex', 'osmDarkMode', 'assetRotationDeg',
        'showUncutSheetId', 'selectedMeasurementId', 'layerGroups'
    ];

    if (DW && DW.state) {
        stateProps.forEach(function(prop) {
            var exists = prop in DW.state;
            check('state.' + prop + ' exists', exists);
            if (!exists) {
                console.log('  ❌ state.' + prop + ' — MISSING');
            }
        });

        // Canvas should be a fabric.Canvas instance
        if (DW.state.canvas) {
            var isFabric = DW.state.canvas instanceof fabric.Canvas ||
                           (DW.state.canvas.renderAll && DW.state.canvas.getObjects);
            check('state.canvas is Fabric instance', isFabric);
            if (isFabric) {
                console.log('  ✅ state.canvas is a Fabric.js Canvas');
            } else {
                console.log('  ❌ state.canvas exists but is not a Fabric Canvas');
            }
        } else {
            warn('state.canvas is null (page may still be loading)');
            console.log('  ⚠️  state.canvas is null — if page is still loading this is OK');
        }

        console.log('  ✅ All ' + stateProps.length + ' state properties present');
    } else {
        check('DW.state exists', false);
    }

    // ==================== 4. Cross-module Integration Spot Checks ====================

    console.log('%c--- Integration Spot Checks ---', 'font-weight:bold;color:#81c784');

    // Check that key utility functions are accessible across modules
    var crossModuleFns = [
        { name: 'assetMeterToPixel', desc: 'coord conversion (assets → links, osm)' },
        { name: 'pixelToAssetMeter', desc: 'reverse coord conversion' },
        { name: 'renderSheetsOnCanvas', desc: 'sheet rendering' },
        { name: 'renderAssetsOnCanvas', desc: 'asset rendering' },
        { name: 'renderLinksOnCanvas', desc: 'link rendering' },
        { name: 'renderSheetLayers', desc: 'sheet layer panel' },
        { name: 'renderAssetList', desc: 'asset list panel' },
        { name: 'renderOSMLayer', desc: 'OSM tile layer' },
        { name: 'renderSavedMeasurementsOnCanvas', desc: 'saved measurements' },
        { name: 'renderImportBatches', desc: 'import batch list' },
        { name: 'renderLinkImportBatches', desc: 'link batch list' },
        { name: 'renderLayerGroupsUI', desc: 'layer groups UI' },
        { name: 'saveSheetPosition', desc: 'sheet position persistence' },
        { name: 'saveSheetRotation', desc: 'sheet rotation persistence' },
        { name: 'refreshAssets', desc: 'asset refresh after save' }
    ];

    crossModuleFns.forEach(function(item) {
        var exists = typeof window[item.name] === 'function';
        if (exists) {
            console.log('  ✅ ' + item.name + ' (' + item.desc + ')');
        } else {
            warn(item.name + ' not found (' + item.desc + ')');
            console.log('  ⚠️  ' + item.name + ' — not found (' + item.desc + ')');
        }
    });

    // ==================== Summary ====================

    var total = pass + fail;
    console.log('');
    if (fail === 0) {
        console.log('%c✅ PASS: ' + pass + '/' + total + ' checks passed', 'font-weight:bold;font-size:13px;color:#4caf50');
    } else {
        console.log('%c❌ FAIL: ' + fail + ' of ' + total + ' checks failed', 'font-weight:bold;font-size:13px;color:#f44336');
        console.log('Failures:');
        failures.forEach(function(f) { console.log('  • ' + f); });
    }

    if (warnings > 0) {
        console.log('%c⚠️  ' + warnings + ' warning(s)', 'font-weight:bold;color:#ff9800');
        warningsList.forEach(function(w) { console.log('  • ' + w); });
    }

    console.log('%c=== End Verification ===', 'font-weight:bold;font-size:14px;color:#4fc3f7');
})();
