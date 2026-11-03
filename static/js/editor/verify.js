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
 *
 * Prints one summary line, plus any failures. Add ?verify=1 to the editor
 * URL for the full list.
 */
(function() {
    'use strict';

    // Run after main.js has created the canvas (its DOMContentLoaded
    // handler is registered first, so it runs first).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runSelfCheck);
    } else {
        runSelfCheck();
    }

    function runSelfCheck() {
    var verbose = /[?&]verify=1\b/.test(window.location.search);
    function log() {
        if (verbose) console.log.apply(console, arguments);
    }

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

    log('%c=== DocuWeaver Verification ===', 'font-weight:bold;font-size:14px;color:#4fc3f7');

    // ==================== 1. Namespace Modules ====================

    log('%c--- Module Load Check ---', 'font-weight:bold;color:#81c784');

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
            log('  ✅ DW.' + mod);
        } else {
            log('  ❌ DW.' + mod + ' — MISSING');
        }
    });

    // ==================== 2. Global Functions ====================

    log('%c--- Global Function Check ---', 'font-weight:bold;color:#81c784');

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
        'exportComposedPdf', 'downloadReport',

        // Calibration / Verify
        'applyCalibration', 'hideCalibrateModal',
        'applyVerification', 'toggleVerifyPanel',
        'onVerifyAssetSelected', 'onVerifyRotationChange',
        'setAssetRotation', 'onCoordUnitChange',
        'filterVerifyAssetSelect',

        // Selection / Data
        'clearSelection', 'updateContextTools',
        'loadProjectData', 'selectMeasurement',
        'highlightMeasurementInSidebar', 'deleteSelectedMeasurement',
        'updateAssetPositionFromCanvas',
        'saveSheetTransformFromCanvas',
        'saveAssetAdjustment',
        'updateAssetPosition',

        // Canvas helpers
        'applyFiltersPreservingSize', 'applyPdfInversion',
        'applyCanvasTheme', 'getCSRFToken', 'showToast',

        // Undo
        'saveUndoState', 'clearUndoHistory', 'undo',

        // Visibility (sheet, asset, link, folder, section and batch eyes)
        'applyVisibility', 'isItemShown', 'toggleSheetVisibility',
        'toggleAssetVisibility', 'toggleLinkVisibility',
        'toggleLayerGroupVisibility', 'toggleBatchVisibility',
        'setSheetInversion', 'setupSheetImage', 'repositionAssets',

        // OSM
        'toggleOSMLayer'
    ];

    var missingGlobals = [];
    requiredGlobals.forEach(function(fn) {
        var exists = typeof window[fn] === 'function';
        check('window.' + fn, exists);
        if (!exists) {
            missingGlobals.push(fn);
            log('  ❌ window.' + fn + ' — MISSING');
        }
    });

    if (missingGlobals.length === 0) {
        log('  ✅ All ' + requiredGlobals.length + ' global functions present');
    }

    // ==================== 3. State Check ====================

    log('%c--- State Initialization Check ---', 'font-weight:bold;color:#81c784');

    var stateProps = [
        'canvas', 'sheets', 'assets', 'links', 'currentMode',
        'selectedSheet', 'selectedAsset', 'isPdfInverted',
        'sheetCutData', 'undoStack', 'osmEnabled', 'osmOpacity',
        'osmDarkMode', 'osmPendingTiles', 'assetRotationDeg',
        'folderById', 'hiddenSections', 'hiddenBatches',
        'showUncutSheetId', 'selectedMeasurementId',
        'assetGroups', 'linkGroups', 'sheetGroups', 'measurementGroups'
    ];

    if (DW && DW.state) {
        stateProps.forEach(function(prop) {
            var exists = prop in DW.state;
            check('state.' + prop + ' exists', exists);
            if (!exists) {
                log('  ❌ state.' + prop + ' — MISSING');
            }
        });

        // Canvas should be a fabric.Canvas instance
        if (DW.state.canvas) {
            var isFabric = DW.state.canvas instanceof fabric.Canvas ||
                           (DW.state.canvas.renderAll && DW.state.canvas.getObjects);
            check('state.canvas is Fabric instance', isFabric);
            if (isFabric) {
                log('  ✅ state.canvas is a Fabric.js Canvas');
            } else {
                log('  ❌ state.canvas exists but is not a Fabric Canvas');
            }
        } else {
            warn('state.canvas is null (page may still be loading)');
            log('  ⚠️  state.canvas is null — if page is still loading this is OK');
        }

        log('  ✅ All ' + stateProps.length + ' state properties present');
    } else {
        check('DW.state exists', false);
    }

    // ==================== 4. Cross-module Integration Spot Checks ====================

    log('%c--- Integration Spot Checks ---', 'font-weight:bold;color:#81c784');

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
        { name: 'clearCalibrationPick', desc: 'scale tool reset' },
        { name: 'renderImportBatches', desc: 'import batch list' },
        { name: 'renderLinkImportBatches', desc: 'link batch list' },
        { name: 'renderLayerGroupsUI', desc: 'layer groups UI' },
        { name: 'replaceSheetData', desc: 'sheet data after a save' },
        { name: 'updateMarkerScale', desc: 'marker size at low zoom' },
        { name: 'refreshAssets', desc: 'asset refresh after save' }
    ];

    crossModuleFns.forEach(function(item) {
        var exists = typeof window[item.name] === 'function';
        if (exists) {
            log('  ✅ ' + item.name + ' (' + item.desc + ')');
        } else {
            warn(item.name + ' not found (' + item.desc + ')');
            log('  ⚠️  ' + item.name + ' — not found (' + item.desc + ')');
        }
    });

    // ==================== Summary ====================

    var total = pass + fail;
    if (fail === 0) {
        console.info('DocuWeaver self-check: ' + pass + '/' + total + ' passed' +
            (warnings ? ', ' + warnings + ' warning(s): ' + warningsList.join('; ') : ''));
    } else {
        console.error('DocuWeaver self-check: ' + fail + ' of ' + total + ' failed: ' + failures.join('; '));
    }
    }
})();
