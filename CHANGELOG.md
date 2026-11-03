# Changelog

All notable changes to DocuWeaver are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Fixes everyday actions that failed on a default install (sign-in on), where
assets are drawn, project data that was lost or merged, and PDF uploads that
failed or left half-made sheets, found by a browser review on 2026-11-01.
With sign-in turned off, other websites can no longer change projects. Dark
mode keeps drawing colours, hidden items and folders stay hidden, Ctrl+Z
covers most edits, and the composed PDF export works. Checked against a drawing set with 18 surveyed
valves: lat/lon assets now land within 1 mm of their drawn symbols
(previously 0.3–0.6 m off) and MGA assets within 1 mm (previously mirrored,
up to 19.5 m off).

### Upgrading: check existing projects
Existing projects change in these ways, because they were wrong:
- **Meters and GDA94 MGA projects** were plotted upside down (mirrored north–south about the reference asset). They now plot the right way up. Adjustments made against the mirrored overlay will look wrong and should be redone.
- **Lat/lon projects** were stretched north–south by about 0.5% (0.46% at 27.5° S, 0.67% at the equator). Assets far north or south of the reference move a little, for example about 2 m at 500 m.
- **Asset markers** were drawn half a symbol width down and to the right of their position (8–10 px). They now sit on the exact point, so they appear to move up and left. Adjustments made by dragging a marker onto a drawn symbol were saved that same distance up and left of the symbol, and now show that offset.
- **Projects whose reference asset has been adjusted:** the overlay is now anchored on the reference asset's original (imported) coordinates. If you adjusted the reference asset before placing it in Verify & Plot, place it again.
- **Assets imported with `inf` as a coordinate** are removed by the upgrade (they could never be drawn, and stopped their project's asset list from loading). The database upgrade (run by `start.sh`, `start.bat` and the Docker image, or `python manage.py migrate`) prints each one it removes, so you can import it again with correct values.
- **Re-imported assets** now stay in the import batch and folder that first created them. Assets that an earlier version moved into a later batch stay where they are now.
- **Sheets with the same Z-index** now always stack in the order of the sheet list (Z-index, then name). Before, the order changed from one load to the next, so where such sheets overlap a different one may now be on top. Set Z-index to choose.
- **Eye toggles on sheets, assets and links** are now saved with the project, so everyone sees the same items hidden. Items hidden with an earlier version weren't saved, so everything starts visible. The eyes on the Sheets/Assets/Links/Measurements sections and on import batches are remembered per browser.
- **Deleting a sheet or project** now deletes its PDF and page images. Files left behind by earlier versions stay where they are, and the `exports` folder in the media directory is no longer used and can be deleted.

### Upgrading: settings and scripts
- **`DOCUWEAVER_MAX_UPLOAD_MB` is now the largest PDF that can be uploaded**, with a default of 50, the limit PDFs already had. Before, it only decided when an upload was buffered to disk, so a value below 50 now lowers the PDF limit and a value above 50 now raises it. The Docker setup already defaulted to 50.
- **With sign-in turned off**, API requests that change data now need a CSRF token, as they already did when signed in. The app's own pages send it. A script that posts to the API can sign in with HTTP Basic auth instead (it needs an account), or fetch a page first and send the `csrftoken` cookie back in an `X-CSRFToken` header.
- **The adjustment report CSV** has new headers for scripts that read it. In lat/lon projects, coordinate columns are headed `(deg)` and have 8 decimals instead of 3. "Delta Distance (m)" is now "Distance Moved (m)" and is always in metres. The download is named after the project (`<project> adjustments.csv`). The JSON report is unchanged.
- **`/api/projects/<id>/export/`** is now a GET that returns the PDF. It was a POST that returned a path on the server.
- **Sheets, assets and links** have a new `visible` field in the API.
- The database upgrade adds two migrations: 0017 adds the `visible` columns, and 0018 adds common column names (such as Latitude, Longitude, Easting, Type) to the CSV column presets, keeping any you have set up.

### Fixed
- MGA and metre coordinates were plotted mirrored north–south.
- Degrees were converted with 111,320 m for both latitude and longitude; each now uses the WGS84 value for the reference latitude.
- Asset markers were drawn offset from their coordinates, so dragging a marker onto a drawn symbol saved the wrong position.
- Panning with a drag that started on an asset moved the asset and saved an adjustment, because markers could be dragged in every tool. Markers now respond only to the Select tool, which also stops measure-mode clicks from selecting them.
- Adjusting the reference asset moved every other asset with it.
- A sheet saved at (0, 0), other than the first in the list, was drawn somewhere else after a reload (50 px down and right for each sheet before it). New sheets now get their cascaded starting position saved when uploaded, and a migration saves the position the editor was showing for existing sheets. Project files (`.docuweaver`) exported by earlier versions get the same treatment when imported.
- "New Project" on the project list, and "Upload PDF" and "Import CSV" on a project's Details page, failed with "CSRF token missing" when signed in.
- "Save" in the measure panel reloaded the page and the measurement was lost.
- "Import Links CSV" did nothing: its dialog was missing from the editor, and the server expected a different upload field name than the editor sent.
- Turning a PDF layer off failed with a server error, and the sheet then failed every later re-render. Turning all layers off now hides them all instead of showing them all.
- "Adjustment Report" opened a "Not found" page instead of downloading the CSV. The report's API parameter is now `?output=csv` (DRF reserves `?format=`).
- Uploading a PDF larger than 10 MB failed with a server error.
- Each reload of the editor's data (after an import or a folder change) drew another copy of every asset marker.
- The asset and link import-batch lists in the editor sidebar were never filled in.
- `start.bat` wrote an empty `DJANGO_SECRET_KEY` to `.env`, so the server refused to start. `start.sh` could write a mangled key when the generated key contained `&`. Batch files now check out with CRLF line endings.
- Measurement folder lists also contained asset, link and sheet folders.
- Re-rendering a sheet no longer overwrites a move or rotation saved while it rendered.
- Broken glyphs on the project list's export button and the editor's export link.
- Re-importing a CSV moved the assets it repeated into the new import batch, so deleting that batch also deleted those assets and their adjustment history. Batch counts in the sidebar are now counted live instead of going stale.
- Deleting a link import batch left its links and folder behind.
- CSV imports accepted `inf` and `nan` as coordinates, after which the project's asset list failed to load. Such rows are now reported as errors.
- CSV imports failed on files saved by Excel as Windows-1252 (with characters such as `°`), and on rows with fewer cells than the header. A repeated ID within one file is now reported instead of silently overwriting the earlier row. A database error on one row no longer fails every row after it.
- Project files (`.docuweaver`) lost PDF layer choices, folder scope, which folder an import created, measurement folders, the adjustment history and links between join marks. Folders with the same name were merged on import (and a subfolder named like its parent became its own parent, breaking the folder list). Each page of a multi-page PDF was stored as a separate copy.
- Splitting a sheet that had already been cut brought the earlier cuts back on the new piece, and the new piece lost the sheet's PDF layer choice and folder.
- Two changes to one item made close together (for example a drag and a move to another folder) could undo each other, because each saved every field of the item.
- A folder could be moved inside itself or one of its subfolders, or into another project's folder.
- Deleting an asset or link with the × in a folder list left it on the canvas until the page was reloaded. Taking a measurement out of a folder sent the request to the link API instead.
- Uploading a password-protected or damaged PDF failed with a server error and left a sheet with no image. Such files, and pages too large to render (over about 2.9 m² of paper; A0 is 1 m²), are now refused with a message saying why, and an upload that fails part-way leaves no sheets or files behind. The editor shows that message instead of raw JSON.
- The file type check done when python-magic is installed never rejected a file. Without python-magic, WebP icons were refused.
- Dark mode inverted the drawings' colours, so blue mains turned yellow and red markups cyan, and asset labels were drawn black on the dark canvas. Drawings now keep their hues and only light and dark swap. Labels follow the theme, with a halo so they read on any background, and use the page font instead of a serif fallback.
- Sheets with the same Z-index stacked in a different order on each load. Typing a Z-index brought the sheet in front of assets and measurements; it now only moves the sheet among the sheets.
- Eye toggles on sheets, assets and links were forgotten on reload. Hiding a sheet folder, a measurement folder or a parent folder was saved but hid nothing, and a link import batch's eye did nothing.
- The CSV import dialog didn't recognise common column names on a new install (no column presets), and fields it couldn't match defaulted to the first column, so clicking Import at once mapped X and Y to the ID column. Unmatched fields are now left at "-- Select --", and names are compared ignoring case, spaces, `_` and `-`. The asset-type radio buttons sat apart from their labels.
- Choosing a coordinate unit before placing a reference asset failed without saying so. Opening Verify & Plot switched the project to degrees whenever every coordinate fell within ±180/±90, which re-plotted small local metre grids; it now only suggests degrees.
- Ctrl+Z skipped some actions and undid an older one instead. Typed sheet properties, cut flips and asset adjustments can now be undone. Splitting a sheet can't be undone, so it clears the history and Ctrl+Z says so instead of undoing something older.
- Ending a chain measurement with a right or middle click saved it as a single measurement, and the next click added to the old chain. Middle-click (end chain, or drag to pan) never reached the editor at all. Clicking a measurement in the sidebar did nothing, and deleting one there left it on the canvas.
- Two clicks on the same spot with the Scale tool saved 0 px per metre, collapsing every asset onto one point. Cancelling the scale dialog left its points behind, so it never opened again. Scale and origin changes now report a failed save.
- Lat/lon projects showed degrees under "(m)" labels in the cursor readout, Verify & Plot and the properties panel, and the report rounded them to 3 decimals (about 100 m). Labels now read Longitude/Latitude (°), Easting/Northing (m) or X/Y (m).
- At 1280×720 the two sidebars left 680 px of canvas. Below 1600 px wide the properties panel now starts closed and opens when something is selected, and below 1440 px both sidebars are narrower. Fit left the first sheet under the floating toolbar. Markers shrank to specks when zoomed out; they now keep their size on screen. Asset and link lists sorted V1, V10, V11… instead of V1, V2, V3. The project list scrolled sideways on a phone.
- The OpenStreetMap layer re-sorted the whole canvas for every tile, and could add a tile twice so its opacity stacked. The asset rotation slider rebuilt every marker and redrew every link on each step; it now moves the markers in place and redraws links once the slider stops.
- The README's composed PDF export had no button, and the server placed markers in the wrong spot on offset, rotated or reference-calibrated sheets. "Drawings with Assets (PDF)" in the editor's Export section now downloads one PDF with a page per visible sheet, and assets drawn where the editor shows them.
- Re-rendering a sheet left the old page image on disk, and deleting a project left its PDFs and images behind.
- The folder list took about 400 database queries for 100 folders and the editor loaded it four times; it now takes a fixed handful, once. The project page, project list and report no longer make a query per sheet, project or asset.
- The "adjusted" badge on a project's details page showed the total asset count. Download filenames broke on quotes in the project name.
- Every page logged a 404 for the missing favicon.
- `start.sh` couldn't recover from a failed first run. When the virtual environment couldn't be created (on Debian or Ubuntu, because the python3-venv package was missing), it left a broken `.venv` behind, and every later run failed with "No module named pip", even after the package was installed. It now removes a half-made `.venv` and repairs one left by an earlier version.

### Security
- With sign-in turned off (`DOCUWEAVER_REQUIRE_LOGIN=false`), any website open in the same browser could change projects with a hidden form, for example recalibrate one or create new ones. API requests that change data now need a CSRF token in that mode too.
- Importing a project file now checks what is inside it. Embedded files must be the PDFs and images they claim to be (an HTML file stored as a "PDF" was served from the app's own address), an asset type that already exists is no longer changed by an import (asset types are shared by all projects), the unpacked size is capped by the new `DOCUWEAVER_MAX_IMPORT_MB` setting (default 2048), and a rejected import no longer leaves files behind.

### Changed
- `DOCUWEAVER_MAX_UPLOAD_MB` sets the largest PDF that can be uploaded; its default is now 50 (see Upgrading).
- Every page of an uploaded PDF is rendered before any sheet is created. Pages are encoded to PNG by PyMuPDF directly, which for an A1 page takes about 30% less memory (115 MB instead of 166 MB) and gives a file about 25% smaller.
- Project files exported by this version (format 2.1) refer to folders, batches and join marks by id. Earlier versions can still import them, and this version still imports files from earlier versions.
- Asset, link and sheet lists in the editor sort in natural order (V2 before V10).
- The editor's browser console only shows errors and a one-line self-check. Add `?verify=1` to the editor URL for the full check.

### Removed
- The unused `static/js/canvas_core.js` and duplicate copies of editor functions that silently replaced each other (the Scale, Origin and Verify click handlers, section sorting and batch visibility).

## [1.0.1] - 2026-11-01

Fixes canvas editor actions that had silently stopped working when the editor
was split into separate modules, before 1.0.0.

### Fixed
- Moving or rotating a sheet on the canvas was not saved, so the alignment was lost on reload.
- Dragging an asset on the canvas, or clicking "Save Adjustment" in the asset panel, did not record the adjustment. Typing in Adjusted X/Y now also moves the marker before you save.
- Clicking a saved measurement did not select it, and the Delete key did not remove it.
- The split tool drew a cut line but never split the sheet.
- Running the test suite left uploaded test files in the real `media/` directory.

### Changed
- CI uses `actions/checkout@v7` and `actions/setup-python@v7` (Node 24 runtime).

## [1.0.0] - 2026-09-02

First public release, prepared for distribution as free and open-source software.

### Added
- AGPL-3.0-or-later licence.
- Sign-in page, sign-out button and login enforcement for every page and API endpoint, controlled by `DOCUWEAVER_REQUIRE_LOGIN`.
- `python manage.py serve`: production server (Waitress) with automatic static-file collection.
- One-command launchers `start.sh` and `start.bat` that create a virtualenv, install, migrate and run.
- `Dockerfile`, `docker-compose.yml` and container entrypoint with optional first-start admin account.
- Environment settings `DOCUWEAVER_DATA_DIR`, `DOCUWEAVER_HTTPS`, `DOCUWEAVER_MAX_UPLOAD_MB`, `DJANGO_CSRF_TRUSTED_ORIGINS`, `DJANGO_TIME_ZONE`, `DOCUWEAVER_LOG_LEVEL`.
- Uploaded media is served behind the login check when `DJANGO_DEBUG` is off.
- `requirements-dev.txt`, `ruff.toml`, and a CI matrix over Python 3.10 to 3.13 that also checks migrations and builds the Docker image.
- Tests for login enforcement and open-access mode.
- `CONTRIBUTING.md` and this changelog.

### Changed
- Upgraded to Django 5.2 LTS (4.2 reached end of life in April 2026) and Django REST Framework 3.16+.
- Fabric.js is bundled locally instead of loaded from a CDN, so the editor works without internet access.
- Static files are served by WhiteNoise with hashed, cacheable names.
- Security headers are always on; HTTPS-only settings are enabled with `DOCUWEAVER_HTTPS=true` rather than commented out.
- README rewritten with install, configuration, usage, backup and upgrade guides.
- Page titles and navigation now say "DocuWeaver" instead of "PDF Alignment Tool".

### Fixed
- Fresh installs failed to migrate: migration `0013` depended on `0012_unique_constraints_and_indexes`, which had never been committed. It has been recreated.
- Debug scripts at the repository root (`test_export.py`, `test_roundtrip.py`, `check_pdf_size.py`) were collected by pytest and crashed against an empty database. Removed.
- CI referenced a `requirements-test.txt` that did not exist.

### Removed
- Unused dependencies `reportlab` and `django-cors-headers`.
- Empty `drawings/services/cadastre_service.py`.
