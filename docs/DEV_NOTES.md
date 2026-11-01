# DocuWeaver Development Notes

Technical notes for people working on the code: how the canvas editor is put
together, known defects, and design decisions that aren't obvious from the
source. Installation and usage are in `README.md`; the current project state
and next steps are in `STATUS.md`.

_Last reviewed: 2026-11-01_

---

## Canvas editor architecture

The editor page is `templates/drawings/editor.html`. It loads plain scripts (no
bundler, no ES modules) in this order, and **the order in `editor.html` is the
source of truth**:

1. `static/js/vendor/fabric.min.js`: Fabric.js 5.3.1, vendored (MIT).
2. An inline script that defines `PROJECT_ID` and `PROJECT_DATA` from the template context.
3. `static/js/tool_section_item.js` and `static/js/measurement_tool.js`: standalone helpers (`MeasurementTool`).
4. `static/js/editor/namespace.js`: creates `window.DocuWeaver` and the shared `DocuWeaver.state`, and patches Fabric's `textBaseline` bug. Must load first among the editor modules.
5. Editor modules in `static/js/editor/`: `undo`, `viewport`, `tools`, `canvas_init`, `crop`, `split`, `calibration`, `assets`, `links`, `sheets`, `osm`, `measurements`, `layers` (folders/layer groups), `imports`, `sidebar`, then `main.js` (startup).
6. `static/js/editor/verify.js`: a self-check that logs to the browser console (see below).
7. An inline script that syncs dark mode with PDF inversion and OSM tiles.

Conventions:

- Each module is an IIFE that reads and writes `DocuWeaver.state` and attaches
  its public functions to `window.*`. The `window.*` exports exist because
  `editor.html` uses inline `onclick`/`onchange` handlers by name.
- Cross-module calls are usually guarded with `if (typeof fn === 'function')`.
  This means **a missing function fails silently** instead of throwing. When
  you rename or move a function, grep for its name across `static/js` and
  `templates`.
- `verify.js` checks that the expected modules, `window.*` functions and
  `state` keys exist, and prints a pass/fail summary in the DevTools console
  on every editor page load. It is the quickest way to spot a dropped
  function, and it should report no failures. When you add a function that
  another module or `editor.html` calls, add it to `verify.js` too.
- The load-order comment at the top of `namespace.js` is out of date (it lists
  a `modals.js` that doesn't exist). Trust `editor.html`.
- `static/js/canvas_core.js` isn't loaded by any template. It's a leftover
  from before the module split and can be deleted.

### History: the canvas_editor.js split (finished)

The editor used to be one ~8,100-line `static/js/canvas_editor.js`. It was
split into `static/js/editor/*` and deleted in the upstream repo
(jpmarshTMR/DocuWeaver, commit `db9d382`, 2026-02-24). The last version of the
old file is at commit `f50e817` in that repo:

```
gh api -H "Accept: application/vnd.github.raw" \
  "repos/jpmarshTMR/DocuWeaver/contents/static/js/canvas_editor.js?ref=f50e8177658063a2705d4400861997c1270df9c2"
```

Several functions were dropped or miswired during the split; they were
restored on 2026-11-01 (see below).

---

## Fixed 2026-11-01: functions lost in the split

Between the split (2026-02-24) and 2026-11-01 these editor actions silently
did nothing, because the functions they call had been dropped and the calls
are behind `typeof` guards (or threw `ReferenceError` from inline handlers):

| Action | Was broken because | Now handled by |
|---|---|---|
| Drag or rotate a sheet on the canvas | `updateSheetPositionFromCanvas` / `updateSheetRotationFromCanvas` missing, so nothing was saved and a reload lost the alignment | `saveSheetTransformFromCanvas` in `sheets.js` |
| Drag an asset on the canvas | `updateAssetPositionFromCanvas` and `saveAssetAdjustment` missing | same names, in `assets.js` |
| Type Adjusted X/Y, click "Save Adjustment" | `updateAssetPosition` (never existed) and `saveAssetAdjustment` missing | same names, in `assets.js` |
| Click a measurement, press Delete | `selectMeasurement`, `highlightMeasurementInSidebar`, `deleteSelectedMeasurement` missing | same names, in `measurements.js` |
| Split tool | canvas events went to a stub in `tools.js` that called a nonexistent `performSheetSplit` | `canvas_init.js` now calls `DW.split.*` (`split.js`); the stub was deleted |

Design points worth keeping:

- `saveSheetTransformFromCanvas` sends position and rotation in **one** PATCH,
  and only the fields that changed. Two concurrent PATCHes lose an update,
  because the sheet API writes back every field of the row.
- Dragging an asset saves immediately (one `AdjustmentLog` entry per drag).
  Typing in Adjusted X/Y only moves the marker until "Save Adjustment" is
  clicked. The Notes field belongs to the next adjustment and is cleared after
  each save. Coordinates are written with 8 decimals for degree-based
  projects (`degrees`, `gda94_geo`) and 3 for metres, about 1 mm either way.
- `verify.js` reported 7 failures before the fix and reports 115/115 after.

Verified 2026-11-01 with a Playwright script (headless Chromium against a
scratch database, not checked in). It drove each action above and checked
the network requests and the database. All 15 checks failed on the old code
and passed after the fix.

### Remaining tech debt

`tools.js` still has its own copies of the crop, calibrate, origin, verify and
measure click handlers, and canvas events go to those (`DW.tools.*`). The
same-named functions in `crop.js`, `calibration.js` and `measurements.js` are
exported on `window` but the canvas never calls them. The copies currently
behave the same (crop saves through `applyCutMask` → `saveCutData`;
calibrate, origin and verify save through the same endpoints). Pick one copy
of each and delete the other before they drift apart.

---

## Layer folders: moving folders vs moving contents

Folder menus (`showFolderSettingsMenu` in `static/js/editor/layers.js`) offer
two different moves:

- **Move folder to…** (`showMoveGroupDialog`) moves the folder itself under
  another parent. Descendants of the folder are filtered out, because moving
  a folder into its own child would create a cycle. The "root level" option
  only appears when the folder isn't already at the root. To put a parent
  inside what was its child, first move the child to the root, then move the
  parent into it.
- **Move contents to…** (`showMoveContentsDialog` / `moveContentsToFolder`)
  moves the items inside a folder and leaves the folder in place, now empty.
  The folder's own subfolders are valid targets (marked ⬇️), as is "Ungrouped".
  Only items of the type being viewed are moved (assets, measurements, etc.),
  so users don't move items they can't see. Backed by
  `POST /api/layer-groups/<id>/move-contents/` (`move_contents_to_folder` in
  `drawings/api_views.py`).
