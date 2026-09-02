# DocuWeaver Development Notes

This file tracks development notes, migration plans, and technical debt.

---

## 2026-02-23: canvas_editor.js Migration Plan

**Goal:** Remove the monolithic `canvas_editor.js` (~8000 lines, ~170 functions) by migrating remaining functions to modular files in `static/js/editor/`.

### Current Status
- **~77 functions** already duplicated/exported in modular files
- **~93 functions** still ONLY in `canvas_editor.js`

### Functions NOT yet migrated (grouped by feature):

#### 1. Import/Upload UI (~10 functions) → `editor/import.js`
- `toggleImportDropdown`, `closeImportDropdown`, `showUploadModal`, `hideUploadModal`
- `showImportModal`, `hideImportModal`, `importStepBack`
- `showImportLinksModal`, `hideImportLinksModal`, `importLinksStepBack`
- `toggleAssetTypeMode`

#### 2. Calibration/Verification Panel (~15 functions) → `editor/calibration.js`
- `handleCalibrationClick`, `hideCalibrateModal`, `drawOriginMarker`
- `toggleVerifyPanel`, `filterVerifyAssetSelect`, `expandVerifyAssetList`, `collapseVerifyAssetList`
- `onVerifyAssetSelected`, `updateVerifyRefInfo`, `handleVerifyClick`, `drawVerifyRefMarker`
- `onVerifyRotationChange`, `setAssetRotation`, `debouncedSaveAssetCalibration`, `onCoordUnitChange`

#### 3. Sheet Cropping/Cutting (~15 functions) → `editor/cropping.js`
- `handleCropClick`, `handleCropMove`, `handleCropEnd`
- `applyCutMask`, `clipPolygonByEdge`, `computeMultiCutPolygon`, `applyAllCuts`
- `applyCutMaskWithDirection`, `clearSheetCut`, `clearSelectedSheetCut`
- `flipSelectedSheetCut`, `toggleShowUncut`, `updateCutStats`, `removeCutStats`

#### 4. Sheet Splitting (~3 functions) → `editor/cropping.js`
- `handleSplitClick`, `handleSplitMove`

#### 5. Canvas Setup (~5 functions) → Already in `editor/canvas_init.js`
- `initCanvas`, `setupCanvasEvents`, `setupKeyboardShortcuts`
- Note: canvas_editor.js may override these - need to verify and consolidate

#### 6. Layer Groups/Folders UI (~20 functions) → `editor/folders.js`
- `showCreateGroupModal`, `hideCreateGroupModal`, `renderLayerGroupsUI`
- `getAllGlobalGroups`, `flattenGroupHierarchy`, `getGroupItemCountForType`, `isDescendantOf`
- `toggleUnifiedFolderView`, `renderUnifiedList`, `renderUnifiedFlatView`, `renderUnifiedFolderView`
- `createUnifiedFolderSection`, `renderAssetGroupList`, `renderLinkGroupList`, `renderSheetGroupList`
- `createSheetItem`, `createUngroupedFolder`, `createGroupItem`, `createFolderItemElement`
- `showFolderSettingsMenu`, `showMoveGroupDialog`, `showJoinGroupDialog`

#### 7. Sidebar/UI Controls (~5 functions) → `editor/sidebar.js`
- `toggleLeftSidebar`, `toggleRightSidebar`, `resizeCanvasToFit`
- `showTab`, `showBatchTypeSelect`

#### 8. Misc (~10 functions)
- `saveUndoState` → `editor/undo.js` (future)
- `downloadReport` → `editor/export.js` (future)
- `selectMeasurement`, `highlightMeasurementInSidebar` → `editor/measurements.js`
- OSM tile caching (already mostly in `editor/osm.js`, verify consolidation):
  - `loadOSMTile`, `addOSMTileToCanvas`, `getOSMCacheKey`, `storeOSMTileInCache`, `pruneOSMTileCache`

### Migration Steps
1. Create new module file with IIFE pattern matching existing modules
2. Move functions from canvas_editor.js to new module
3. Export to `window.*` for backward compatibility
4. Test thoroughly
5. Remove duplicated code from canvas_editor.js
6. Repeat until canvas_editor.js is empty
7. Remove canvas_editor.js from editor.html

### Priority Order
1. `editor/folders.js` - Most complex, highest value
2. `editor/calibration.js` - Important for workflows
3. `editor/cropping.js` - Sheet manipulation
4. `editor/import.js` - Modal handling
5. `editor/sidebar.js` - Simple UI controls

---

## 2026-02-23: Folder Move Dialog Fix

**Issue:** When selecting "Move to another folder" on a folder that only contains nested empty subfolders, no options appeared.

**Root Cause:** The dialog was filtering out descendant folders (correct for preventing circular references) but then showed "No folders available" even when root-level was a valid option.

**Fix:** 
- Root level option now only shown when the folder has a parent (isn't already at root)
- Improved error message when truly no options available
- Fixed index calculation when root option is conditionally included

**Note on Moving Folders into Child Folders:**
This is intentionally NOT supported because it would create a circular reference. If a user wants to reorganize:
1. Move the child folder to root level first
2. Then move the parent folder into what was its child

---

## 2026-02-23: Added "Move contents to..." Feature

**Request:** User wanted to move the CONTENTS (items) of a folder into a subfolder, not move the folder itself.

**Solution:** Added new menu option "Move contents to..." which:
- Shows ALL folders including subfolders of the source folder (valid targets for items)
- Marks subfolders with ⬇️ indicator for clarity
- Includes "Ungrouped" option to remove items from any folder
- Keeps the original folder intact (just empties it)

**Changes:**
- `canvas_editor.js`: Added `showMoveContentsDialog()` and `moveContentsToFolder()` functions
- `api_views.py`: Added `move_contents_to_folder()` endpoint
- `api_urls.py`: Added route `layer-groups/<int:pk>/move-contents/`

**Menu now has:**
- "Move folder to..." - Moves the folder itself to another parent (can't move into descendants)
- "Move contents to..." - Moves items inside the folder to any other folder (including subfolders)

**Context-aware behavior:**
- When in Measurements tab → only moves measurements (dialog shows "Move measurements from...")
- When in Assets tab → only moves assets
- When in Unified view → moves all item types
- This prevents users from accidentally moving items they can't see in the current view

---

