# DocuWeaver Development Notes

Technical notes for people working on the code: how the canvas editor is put
together, known defects, and design decisions that aren't obvious from the
source. Installation and usage are in `README.md`; the current project state
and next steps are in `STATUS.md`.

_Last reviewed: 2026-11-02_

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
7. An inline script that re-applies the theme (canvas colour, sheet filter, OSM tiles) when dark mode is toggled.

Conventions:

- Each module is an IIFE that reads and writes `DocuWeaver.state` and attaches
  its public functions to `window.*`. The `window.*` exports exist because
  `editor.html` uses inline `onclick`/`onchange` handlers by name.
- Cross-module calls are usually guarded with `if (typeof fn === 'function')`.
  This means **a missing function fails silently** instead of throwing. When
  you rename or move a function, grep for its name across `static/js` and
  `templates`.
- `verify.js` checks that the expected modules, `window.*` functions and
  `state` keys exist once the page has loaded, and prints one
  "DocuWeaver self-check" line in the DevTools console (an error line if
  anything is missing). Add `?verify=1` to the editor URL for every check.
  It is the quickest way to spot a dropped function, and it should report no
  failures. When you add a function that another module or `editor.html`
  calls, add it to `verify.js` too. The browser tests fail if this line
  isn't an all-pass.
- `browser_tests/` (see below) catches what `verify.js` can't: a function
  that exists but no longer does its job.
- Use `console.error`/`console.warn` for problems only; routine
  `console.log` calls were removed. Tell the user with `DW.showToast`.
- Shared helpers in `namespace.js`: `DW.storage.get/set` (localStorage
  that never throws, for private windows), `DW.naturalCompare` (V2 before
  V10) and `DW.responseError(response)` (one readable message from any DRF
  error body).

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

## Browser tests (since 2026-11-04)

`pytest browser_tests` runs the editor in headless Chromium (Playwright for
Python, pinned in `requirements-browser.txt`). How to install and run them is
in CONTRIBUTING.md. They are kept out of the plain `pytest` run
(`testpaths = drawings` in `pytest.ini`) because they need the browser.

- **Server.** `conftest.py` starts `manage.py serve` in a subprocess with
  `DJANGO_DEBUG=false`, `DOCUWEAVER_REQUIRE_LOGIN=true` and a temporary
  `DOCUWEAVER_DATA_DIR`, after `migrate` and `createsuperuser`. So the tests
  see collected static files, WhiteNoise, Waitress and CSRF as a real install
  does. The batch 1 CSRF bugs only showed under these settings.
- **Known answers.** `drawing.py` builds the PDF (A3 at 1:500, nine valves, a
  200 m scale bar) and the CSVs (WGS84 and MGA) from one table of valve
  offsets in metres. Lat/lon comes from the WGS84 radii of curvature, not the
  series the app uses. Pixel positions assume `RENDER_DPI = 150`, and the
  upload test checks the rendered image size, so a DPI change fails loudly.
- **Exact clicks.** `UI.show(x, y, zoom)` sets the viewport so canvas point
  (x, y) sits on a whole screen pixel and returns it, so a click there picks
  exactly (x, y). That is why the scale and Verify & Plot test can require
  markers within 0.05 px of their valves after calibrating through the UI.
  Tolerances elsewhere match what the app stores: the scale dialog rounds
  the picked distance to 0.01 px, and metre adjustments are saved to the
  millimetre.
- **What fails a test.** Besides its assertions, a test fails on a console
  error, a `pageerror`, a request to the server that fails or returns 4xx/5xx,
  or an alert matching error/could not/failed/missing. Requests to other
  hosts (map tiles) are ignored. Screenshots and the server log go to
  `browser-test-artifacts/` (or `$BROWSER_TEST_ARTIFACTS`).
- **Speed.** One server and one signed-in session for the whole run. Each
  test makes its own project through the API (`UI.new_project`), so tests
  don't depend on each other. Don't sign out in a test that uses the `ui`
  fixture: it would end the shared session. `guest_ui` starts signed out.

Checked 2026-11-04 against the released code: all 10 tests fail on v1.0.0,
and 8 fail on v1.0.1 (sheet drag and split were fixed in 1.0.1). Each failure
is for the bug it targets: mirrored MGA, stretched lat/lon, offset markers,
the CSRF failures, Save Measurement, the missing export button and the
import column matching.

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

### Duplicate handlers (resolved 2026-11-03)

`tools.js` used to keep its own copies of the crop, calibrate, origin and
verify click handlers, and the canvas called those while the copies in
`crop.js` and `calibration.js` went unused. The copies were deleted;
`canvas_init.js` now sends each tool's events to its own module
(`DW.crop.*`, `DW.split.*`, `DW.calibration.*`). `tools.js` keeps only
`setMode` and the select and measure clicks.

---

## Fixed 2026-11-02: default-install failures (review batch 1)

A browser review on 2026-11-01 (DEBUG off, sign-in on, real PDFs; report
linked from `STATUS.md`) found everyday actions failing that the test suite
couldn't see, because the tests skip CSRF checks, mock PDF rendering and
have no browser. Points worth knowing when touching this code:

- **CSRF in page scripts.** `fetch()` calls outside the editor take the token
  from a `{% csrf_token %}` inside their form and send it as `X-CSRFToken`.
  The editor uses `DocuWeaver.getCSRFToken()` (cookie). DRF only enforces
  CSRF for session-authenticated requests, so with `REQUIRE_LOGIN=false` a
  missing token goes unnoticed. Test with sign-in on.
- **PDF layers** (`render_pdf_page`, `set_sheet_layers`). `visible_layers`
  holds OCG xrefs: `[]` means every layer is on; otherwise exactly the listed
  xrefs are on, and the editor sends `[0]` (never a valid xref) for "all
  off". PyMuPDF's `set_layer()` must be given xrefs, not names, and MuPDF
  only applies it after the document is reopened, so the renderer reopens
  from `doc.tobytes()`. The endpoint saves `visible_layers` only after the
  render succeeds.
- **`?format=` is reserved by DRF** for choosing a renderer, and DRF answers
  404 for a format it has no renderer for. The adjustment report uses
  `?output=csv`.
- **Large uploads.** Files above `FILE_UPLOAD_MAX_MEMORY_SIZE` are spooled to a
  temp file, which `request.data.copy()` can't deep-copy. Use
  `request.data.dict()`.
- **Link CSV import** takes the file as `file` (what the editor sends, same as
  the asset import); `csv_file` is still accepted.
- **Re-rendering the canvas.** `loadProjectData()` runs again after imports and
  folder moves, so every `render*OnCanvas` function must remove its old
  objects first. Assets didn't, and doubled on each call.
- **Missing markup fails only in the browser.** `EditorMarkupTests` in
  `drawings/tests.py` checks the dialog ids the editor scripts look up; add
  new ones there.

Still open from the review: see `STATUS.md`, "In flight / next steps".

---

## Asset coordinates and markers (since 2026-11-02, review batch 2)

How asset coordinates become canvas pixels, all in `static/js/editor/assets.js`.
Links and the OSM basemap go through the same two functions
(`assetMeterToPixel`, `pixelToAssetMeter`), so they stay consistent.

- **Axes.** In every coordinate unit, x is easting or longitude and y is
  northing or latitude, increasing to the north. Canvas y increases
  downwards, so `coordOffsetToMeters` returns canvas-oriented metres
  (x east, y south). Before 2026-11-02 only degree units were flipped, so
  Meters and MGA projects plotted mirrored north–south.
- **Degrees to metres.** `metresPerDegree(lat)` gives separate WGS84 values
  for latitude and longitude at the reference asset's latitude (within
  0.5 ppm of the exact ellipsoid formulas). One 111,320 m/deg for both axes
  was 0.46% long north–south at 27.5° S. The equirectangular approximation
  about one latitude is fine at drawing-set scale (km).
- **Anchor.** The overlay is a single fixed transform: the reference asset's
  *original* (imported) coordinates sit at `(ref_pixel_x, ref_pixel_y)`,
  rotated by `asset_rotation` and scaled by `pixels_per_meter`. It must not
  depend on anything the user can adjust, or adjusting the reference asset
  drags every other asset along. When the Verify click lands on an asset that
  is already adjusted, `referencePixelForClick` stores the pixel of its
  original coordinates instead of the click.
- **Marker origin.** A marker is a `fabric.Group` of symbol and label. Its
  origin is set (fractional `originX/originY`, see `makeAssetGroup`) to the
  symbol centre, so `group.left/top` *is* the asset's pixel position for
  drawing, dragging and saving. With the default top-left origin the symbol
  was drawn half its size down and right of the point, and dragged positions
  were saved with the same error.
- **Interaction.** Markers are `selectable`/`evented` only in Select mode
  (`setMode` in `tools.js`, and `makeAssetGroup` for markers created later).
  In other modes a drag that starts on a marker pans, and measure clicks go
  through to the canvas.
- **Sheet positions.** The editor draws sheets exactly at their saved offset.
  New sheets get a cascaded offset (50 px per existing sheet) when uploaded
  (`cascade_offset` in `api_views.py`); migration `0014` saved the offset the
  editor used to fake for sheets at (0, 0). Project files carry
  `"sheet_offsets": "saved"`; importing a file without it (exported before
  1.1.0) applies the same rule (`apply_legacy_sheet_cascade` in
  `drawings/services/project_archive.py`). Note `0014` also exists on the
  upstream `feature/join-mark-detection` branch; merging that branch needs a
  merge migration.
- **Known-answer check.** The 2026-11-02 verification used a synthetic 1:500
  drawing with 18 valves whose WGS84 and MGA coordinates were computed from
  the drawing: every marker landed within 1 mm. There's no automated JS test
  for this yet (see `STATUS.md`).

---

## Project data rules (since 2026-11-02, review batch 3)

- **Saving.** Never call a plain `save()` on a row loaded at the start of a
  request: it writes back every column, undoing anything another request
  changed meanwhile. Use `save_fields(obj, [...])` from `drawings/models.py`
  (adds the `auto_now` timestamp). The DRF serializers get the same through
  `SaveChangedFieldsMixin` in `serializers.py`, which also rejects a related
  object (folder, batch) from another project.
- **Import batches.** An asset or link belongs to the import that created it.
  A later import that repeats its ID updates the values but not
  `import_batch` or `layer_group` (`csv_importer.py`), so deleting a batch
  only deletes what it added. Deleting a batch also deletes the folder the
  import created if nothing else is in it. The batch count shown in the
  sidebar is counted live (`ImportBatchSerializer.asset_count`); the stored
  `ImportBatch.asset_count` is what the import created.
- **CSV rows.** Each row is imported in its own savepoint. A row that fails
  must not leave anything cached from inside its savepoint (the asset type
  cache is cleaned up for that reason). Coordinates go through
  `parse_finite_float`; `json` and `float()` both accept `nan`/`inf`, and
  one stored `inf` makes the asset list fail to serialise.
- **Folders.** `parent_creates_cycle` in `models.py` is the one cycle check,
  used by the folder PATCH, `join_groups` and project import.
- **Project files.** `drawings/services/project_archive.py` builds and reads
  both archive formats. Records are copied from the model fields
  (`_plain_fields`), so a new plain field is exported and imported without
  changes there; a new relation or file field needs adding by hand.
  References use the exporting database's ids; `*_name` fields are still
  written for older versions and used for files that predate ids. Imported
  files are checked by content (`_stored_name`), stored once each, and
  removed again if the import fails.

## Uploads and requests (since 2026-11-02, review batch 4)

- **PDF uploads are all or nothing.** `SheetListCreate.create` calls
  `render_upload` (`drawings/services/pdf_processor.py`), which opens the
  upload, refuses it with `PdfError` (password-protected, unreadable, no
  pages, a page over `MAX_RENDER_PIXELS`) and renders every page to a stored
  PNG. Only then are the PDF stored and the rows created, in one short
  transaction; any failure deletes the files again. Keep slow work like
  rendering out of transactions: SQLite allows one writer, and a held write
  lock stalls every other user's saves. `split_sheet` still renders one page
  inside its transaction.
- **`PdfError` is the user's problem, anything else is ours.** Views turn
  `PdfError` into a 400 with its message, which the editor shows as is.
  Other exceptions stay 500s and get logged.
- **Render size.** Sheets are rendered at `RENDER_DPI` (150; the export maps
  overlay positions back with it). A render needs about 7 bytes per pixel,
  so `MAX_RENDER_PIXELS` (100 Mpx, about 2.9 m² of paper) caps one render
  near 700 MB. Rendering goes straight from the pixmap to PNG with
  `pix.tobytes('png')`; going through Pillow took 45% more memory.
- **CSRF without login.** DRF checks CSRF only for signed-in session users.
  `drawings.auth.CsrfCheckWithoutLogin` must stay last in
  `DEFAULT_AUTHENTICATION_CLASSES`: it checks the token on requests that no
  earlier class signed in, which matters when `DOCUWEAVER_REQUIRE_LOGIN` is
  false. Basic-auth clients are signed in before it runs. Every fetch that
  changes data must send `X-CSRFToken` (the pages set the `csrftoken`
  cookie with `{% csrf_token %}`).
- **Upload limits.** `DOCUWEAVER_MAX_UPLOAD_MB` is read by
  `PDFFileValidator` when a file is checked (the model field passes no
  size, so changing the setting needs no migration). Non-file request
  bodies are capped at 10 MB, and uploads over 2.5 MB are spooled to a
  temporary file, which `open_pdf` opens by path.
- **python-magic is optional.** `detected_mime` returns None when it's
  missing or fails; the header checks in `validators.py` always run.

---

## Display and editing (since 2026-11-03, review batch 5)

- **Visibility has one rule, applied in one place.** An item is shown when
  its own `visible` flag is true, every folder above it is shown, its
  section (Sheets/Assets/Links/Measurements) isn't hidden, and its import
  batch isn't hidden. `applyVisibility()` in `layers.js` sets `obj.visible`
  for every canvas object from that rule (`isItemShown` / `isFolderShown`);
  renderers draw everything and only set the flag. Item and folder flags
  are saved on the server (`visible` on Sheet, Asset, Link, MeasurementSet
  and LayerGroup), so everyone sees the same. Section and batch eyes are per
  browser (`DW.storage`, keyed by project), because they're a viewing choice.
  `loadLayerGroups()` fetches every folder type in one request and indexes
  nested folders into `state.folderById`.
- **Stacking order is computed, not accumulated.** `applyRenderingHierarchy()`
  in `main.js` rebuilds `canvas._objects` in place: OSM tiles at the bottom,
  then sheets by (Z-index, position in `state.sheets`), then the other layer
  types. Every renderer calls it after adding objects, so image load order
  and earlier inserts don't matter. Z-index only orders sheets among
  themselves. OSM tiles use `canvas.insertAt(img, 0)` and skip the full sort.
- **Dark mode** is one ColorMatrix on each sheet (`setSheetInversion` in
  `main.js`): invert, then a 180° hue rotation, folded into
  `rgb' = 1 − H·rgb`. Blue stays blue and black becomes white. Fabric's 2D
  filter backend multiplies the matrix offsets by 255. Labels take their
  colour from `assetLabelStyle()` and are redrawn when the theme changes.
- **Markers keep their screen size when zoomed out**: `markerScale()` is
  1/zoom below 100% and 1 above, applied once per frame by
  `updateMarkerScale()` on zoom. Moving markers after a calibration or
  rotation change uses `repositionAssets()`, which keeps the same objects.
- **Undo** (`undo.js`) records `transform`, `sheetProperty`, `cut`,
  `clearCut` and `assetAdjust`. Anything that can't be undone, such as a
  split, calls `clearUndoHistory(reason)`, so Ctrl+Z can't reach past it to
  an older change. Ctrl+Z inside a text box is left to the browser.
- **Coordinates are shown in the project's unit.** `coordAxisLabel()` and
  `formatCoordPair()` in `assets.js` give Longitude/Latitude (°, 6
  decimals), Easting/Northing (m) or X/Y (m). The report CSV uses 8 decimals
  and `(deg)` for degree units.
- **Composed PDF export** (`GET /api/projects/<id>/export/`,
  `export_project_pdf` in `drawings/services/export_service.py`) draws onto
  the original PDF pages. `MarkerLayout` is a Python port of
  `assetMeterToPixel`; a marker's canvas position is mapped back through
  the sheet's offset and rotation and the 150 DPI render scale.
  `_PageSpace` works around PyMuPDF ignoring the crop box for shapes on
  rotated, cropped pages. Cuts, PDF layers, links and measurements were
  added on 2026-11-05; see "Composed PDF export" below.
- **Files are deleted with their rows**, after the transaction commits, by
  the `post_delete` receiver `delete_sheet_files` in `drawings/models.py`
  (cascades don't call `Sheet.delete()`). A PDF shared by several sheets is
  kept until the last one goes.
- **Folder lists cost a fixed number of queries**: `LayerGroupTree` in
  `drawings/serializers.py` loads every folder and the per-type item counts
  up front, and `LayerGroupSerializer` reads from it when it's in the
  serializer context.
- **CSV column matching**: `GET /api/column-presets/` returns names per
  role, highest priority first (seeded by migration 0018, editable in the
  admin). The import dialog compares names ignoring case, spaces, `_` and
  `-`, prefers a mapping remembered for the project, and leaves unmatched
  fields at "-- Select --".
- **Narrow screens**: below 1600 px the properties panel starts closed and
  `openRightSidebar()` opens it on selection; below 1440 px both sidebars
  are 250 px. The canvas is sized after the startup collapse, so the
  collapse skips its slide animation.

Verified 2026-11-03 with a Playwright script (headless Chromium, sign-in on,
`DJANGO_DEBUG=false`, scratch database, not checked in): 47 checks covering
each item above, including hue and label colours in dark mode, stacking
across three reloads, saved eyes and folders, undo, measurements, the scale
tool, unit labels, Fit, the PDF download, 1280×720 and a 390 px phone.

---

## Composed PDF export (since 2026-11-05)

`export_project_pdf` in `drawings/services/export_service.py` builds one PDF
from the original pages, showing what the editor shows. Each sheet's page is
copied with `insert_pdf`, then drawn on in the editor's default stacking
order: links, asset markers, measurements. A custom order chosen in the
rendering-hierarchy dialog isn't followed.

- **What's left out.** The same rule as `isItemShown`. The item and folder
  eyes are read from the database. The section and import-batch eyes exist
  only in the browser, so `exportQuery()` in `imports.js` sends them as
  `?hide=` and `?hidden_batches=`.
- **Cuts.** `cut_polygon` is a port of `computeMultiCutPolygon` in
  `crop.js`, including its rounding (`Math.round`, so halves round up) and
  "no polygon means show the whole sheet". Cut points are in the image's
  own pixels, measured from its centre. The polygon becomes a clip path
  (`q … W n` … `Q`) in streams *added* around the page's content. The
  copied streams are never edited, because two sheets of one page share
  them: a split makes exactly that pair, cut on opposite sides.
  `page.wrap_contents()` first balances the page's own `q`/`Q`, so the clip
  ends where it should.
  - Lines (links, measurements) are drawn in clipped streams.
  - Markers and labels aren't clipped. A marker whose centre isn't shown
    (off the page or cut away) is skipped instead, so labels don't get cut
    in half.
  - If a cut sheet's page has annotations or form fields, `bake()` turns
    them into page content first, so the clip covers them. Uncut sheets
    keep their annotations.
- **PDF layers.** `insert_pdf` copies a page's optional content groups but
  not the document's `/OCProperties`, so every layer would show.
  1. When a source PDF is opened, each of its OCGs is tagged with
     `/DocuWeaverShown true|false`. The value follows the same rule as
     `_with_layers` in `pdf_processor.py`: the sheet's `visible_layers`
     when it has a choice, otherwise the PDF's own default.
  2. Once every page is in, `_set_layers` writes `/OCProperties` (`/ON`,
     `/OFF`, `/Order`) from the tags and removes them.
  3. Sources are cached by (file, layer choice), so sheets that show
     different layers of one PDF get separate copies of its OCGs, and each
     page keeps its own choice.
  4. The output is saved with `garbage=2`, not 3. Level 3 merges identical
     objects, and once the tags are gone the copies are identical.
- **Shared objects.** `insert_pdf(..., final=False)` keeps PyMuPDF's map of
  objects already copied from a source. Without it, every sheet copied the
  PDF's fonts and images again: three sheets of a PDF with a 4 MB font came
  to 13.0 MB instead of 4.3 MB. Garbage collection can't undo that, because
  merging streams needs `garbage=4`.
- **Measurements** are drawn as in `renderSaved` (dashed, 2 px, a dot at
  each point). Each also gets a label, which the editor doesn't have: its
  name and length (`formatDistance`, from the points and the current
  scale). The label sits above the middle of the longest segment, moved
  out along the normal far enough that the text box clears the line at any
  angle. A measurement usually ends on an asset, whose own label would
  collide with one placed at the ends.
- **Tests.**
  - `ExportCutsAndLinesTests` and `ExportPdfLayersTests` in
    `drawings/tests.py` check colours at known points of rendered exports.
    They cover a cut and a flipped cut, two sheets of one page with
    opposite cuts, a rotated and cropped page, annotations, each eye, layer
    choices per sheet and object sharing.
  - `test_pdf_export_shows_cuts_links_measurements_and_section_eyes` in
    `browser_tests/` makes the cut with the crop tool and turns off a
    section eye in the sidebar, then checks the downloaded PDF.

---

## Layer folders: moving folders vs moving contents

Folder menus (`showFolderSettingsMenu` in `static/js/editor/layers.js`) offer
two different moves:

- **Move folder to…** (`showMoveGroupDialog`) moves the folder itself under
  another parent. Descendants of the folder are filtered out, because moving
  a folder into its own child would create a cycle (the server rejects it
  too). The "root level" option
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
