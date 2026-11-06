"""The canvas editor, checked against the known-answer drawing (drawing.py)."""
import math
import re

import pymupdf
import pytest

from . import drawing


def _assert_on_valves(markers, tolerance):
    off = {}
    for asset_id in drawing.VALVES:
        x, y = drawing.pixel(asset_id)
        mx, my = markers[asset_id]
        if math.hypot(mx - x, my - y) > tolerance:
            off[asset_id] = f'({mx:.2f}, {my:.2f}) instead of ({x:.2f}, {y:.2f})'
    assert not off, f'markers off their drawn valves: {off}'


def _on_post(path_part, method='POST'):
    return lambda r: path_part in r.url and r.request.method == method


def test_editor_loads_and_passes_its_self_check(ui):
    project = ui.new_project('Self-check')
    ui.open_editor(project['id'], markers=len(drawing.VALVES))
    lines = [line for line in ui.info if line.startswith('DocuWeaver self-check')]
    assert lines, 'verify.js printed no self-check line'
    assert re.fullmatch(r'DocuWeaver self-check: (\d+)/\1 passed', lines[0]), lines[0]
    assert len(ui.markers()) == len(drawing.VALVES)


def test_scale_tool_and_verify_and_plot_put_lat_lon_assets_on_their_valves(ui):
    page = ui.page
    project = ui.new_project('Known answer, lat/lon', calibrated=False, referenced=False)
    pid = project['id']
    ui.open_editor(pid)

    # Scale tool: the two ends of the 200 m scale bar
    ui.tool('calibrate')
    (x1, y1), (x2, y2) = drawing.scale_bar_pixels()
    ui.click_at(x1, y1, zoom=2)
    ui.click_at(x2, y2, zoom=2)
    page.wait_for_selector('#calibrateModal', state='visible')
    page.fill('#real-distance', str(drawing.SCALE_BAR_M))
    with page.expect_response(_on_post('/calibrate/')):
        page.click('#calibrateModal button:has-text("Apply")')
    # The dialog rounds the picked distance to 0.01 px
    _, saved = ui.api('GET', f'/api/projects/{pid}/')
    assert saved['pixels_per_meter'] == pytest.approx(drawing.PX_PER_M, rel=1e-5)

    # Verify & Plot: lat/lon, with V1 placed on its drawn symbol
    page.click('button:has-text("Verify & Plot")')
    with page.expect_response(_on_post('/calibrate/')):
        page.select_option('#verify-coord-unit', 'degrees')
    page.select_option('#verify-asset-select', 'V1')
    ui.click_at(*drawing.pixel('V1'), zoom=2)
    with page.expect_response(_on_post('/calibrate/')) as saving:
        page.click('button:has-text("Apply & Plot All")')
    assert saving.value.ok
    _, saved = ui.api('GET', f'/api/projects/{pid}/')
    assert saved['ref_asset_id'] == 'V1'
    assert (saved['ref_pixel_x'], saved['ref_pixel_y']) == pytest.approx(drawing.pixel('V1'), abs=1e-6)

    # Nine markers, each on its valve. Before 1.1.0 lat/lon was stretched
    # north-south by 0.5% and every marker sat half a symbol off its point.
    _assert_on_valves(ui.markers(), tolerance=0.05)
    ui.open_editor(pid, markers=len(drawing.VALVES))
    _assert_on_valves(ui.markers(), tolerance=0.05)


def test_mga_assets_plot_north_up(ui):
    # Before 1.1.0, metre and MGA projects were mirrored north-south.
    project = ui.new_project('Known answer, MGA', csv='mga')
    ui.open_editor(project['id'], markers=len(drawing.VALVES))
    _assert_on_valves(ui.markers(), tolerance=0.01)


def test_dragging_a_sheet_is_saved_and_ctrl_z_moves_it_back(ui):
    page = ui.page
    project = ui.new_project('Sheet drag', csv=None)
    pid, sheet_id = project['id'], project['sheet']
    ui.open_editor(pid)
    ui.tool('select')

    def drag_sheet(dx, dy):
        start = ui.show(1240, 300, zoom=0.5)
        with page.expect_response(_on_post(f'/api/sheets/{sheet_id}/', 'PATCH')):
            ui.drag(start, {'x': start['x'] + dx, 'y': start['y'] + dy})
        return ui.api('GET', f'/api/sheets/{sheet_id}/')[1]

    # At zoom 0.5 a 100 px drag moves the sheet 200 canvas pixels
    moved = drag_sheet(100, 60)
    assert (moved['offset_x'], moved['offset_y']) == pytest.approx((200, 120), abs=1e-6)
    ui.open_editor(pid)
    reloaded = ui.sheet_object(sheet_id)
    assert (reloaded['left'], reloaded['top']) == pytest.approx((200, 120), abs=1e-6)

    ui.tool('select')
    assert (drag_sheet(100, 60)['offset_x']) == pytest.approx(400, abs=1e-6)
    with page.expect_response(_on_post(f'/api/sheets/{sheet_id}/', 'PATCH')):
        ui.undo()
    undone = ui.api('GET', f'/api/sheets/{sheet_id}/')[1]
    assert (undone['offset_x'], undone['offset_y']) == pytest.approx((200, 120), abs=1e-6)
    on_canvas = ui.sheet_object(sheet_id)
    assert (on_canvas['left'], on_canvas['top']) == pytest.approx((200, 120), abs=1e-6)


def test_dragging_a_marker_saves_an_adjustment_and_ctrl_z_restores_it(ui):
    page = ui.page
    project = ui.new_project('Asset drag', csv='mga')
    asset_id = project['assets']['V5']
    ui.open_editor(project['id'], markers=len(drawing.VALVES))
    ui.tool('select')

    x, y = drawing.pixel('V5')
    start = ui.show(x, y, zoom=1)
    with page.expect_response(_on_post(f'/api/assets/{asset_id}/adjust/')):
        ui.drag(start, {'x': start['x'] + 118, 'y': start['y']})
    # Metre coordinates are saved to the millimetre
    _, asset = ui.api('GET', f'/api/assets/{asset_id}/')
    assert asset['current_x'] - asset['original_x'] == pytest.approx(118 / drawing.PX_PER_M, abs=0.0005)
    assert asset['current_y'] == pytest.approx(asset['original_y'], abs=0.0005)
    assert ui.markers()['V5'] == pytest.approx((x + 118, y), abs=0.01)

    with page.expect_response(_on_post(f'/api/assets/{asset_id}/adjust/')):
        ui.undo()
    _, asset = ui.api('GET', f'/api/assets/{asset_id}/')
    assert (asset['current_x'], asset['current_y']) == pytest.approx(
        (asset['original_x'], asset['original_y']), abs=1e-6)
    assert ui.markers()['V5'] == pytest.approx((x, y), abs=1e-6)


def test_measuring_between_two_valves_gives_the_ground_distance_and_saves(ui):
    page = ui.page
    project = ui.new_project('Measure', csv='mga')
    pid = project['id']
    ui.open_editor(pid, markers=len(drawing.VALVES))

    ui.tool('measure')
    ui.click_at(*drawing.pixel('V1'))
    ui.click_at(*drawing.pixel('V5'))
    expected = drawing.metres_between('V1', 'V5')
    shown = page.text_content('#measure-total')
    assert float(re.search(r'[\d.]+', shown).group()) == pytest.approx(expected, abs=0.01), shown

    page.click('#measure-section button:has-text("Save")')
    page.wait_for_selector('#saveMeasurementModal', state='visible')
    page.fill('#measurement-name', 'V1 to V5')
    with page.expect_response(_on_post('/measurement-sets/')) as saving:
        page.click('#saveMeasurementForm button[type=submit]')
    assert saving.value.status == 201
    _, saved = ui.api('GET', f'/api/projects/{pid}/measurement-sets/')
    assert [m['name'] for m in saved] == ['V1 to V5']
    assert len(saved[0]['points']) == 2

    ui.open_editor(pid, markers=len(drawing.VALVES))
    drawn = page.evaluate('() => DocuWeaver.state.canvas.getObjects().filter(o => o.isSavedMeasurement).length')
    assert drawn >= 1


def test_cut_then_split_a_sheet(ui):
    page = ui.page
    project = ui.new_project('Cut and split', csv=None)
    pid, sheet_id = project['id'], project['sheet']
    width, height = drawing.IMAGE_SIZE
    ui.open_editor(pid)

    # Cut: a line down the middle of the sheet, then Ctrl+Z
    ui.show(width / 2, height / 2, zoom=0.4)
    top, bottom = ui.screen(width / 2, 50), ui.screen(width / 2, height - 50)
    ui.tool('crop')
    with page.expect_response(_on_post(f'/api/sheets/{sheet_id}/', 'PATCH')):
        ui.drag(top, bottom)
    assert len(ui.api('GET', f'/api/sheets/{sheet_id}/')[1]['cuts_json']) == 1
    with page.expect_response(_on_post(f'/api/sheets/{sheet_id}/', 'PATCH')):
        ui.undo()
    assert ui.api('GET', f'/api/sheets/{sheet_id}/')[1]['cuts_json'] == []

    # Split along the same line: a second sheet with the other half
    ui.tool('split')
    with page.expect_response(_on_post(f'/api/sheets/{sheet_id}/split/')) as splitting:
        ui.drag(top, bottom)
    assert splitting.value.ok
    page.wait_for_function('() => DocuWeaver.state.sheets.length === 2')
    assert any('split successfully' in d for d in ui.dialogs), ui.dialogs
    _, sheets = ui.api('GET', f'/api/projects/{pid}/sheets/')
    assert len(sheets) == 2


def test_composed_pdf_export_draws_each_marker_on_its_valve(ui, tmp_path):
    page = ui.page
    project = ui.new_project('Export', csv='mga')
    ui.open_editor(project['id'], markers=len(drawing.VALVES))

    with page.expect_download(timeout=60000) as download:
        page.click('button:has-text("Drawings with Assets (PDF)")')
    path = tmp_path / 'export.pdf'
    download.value.save_as(path)
    assert download.value.suggested_filename == 'Export.pdf'

    with pymupdf.open(path) as doc:
        assert doc.page_count == 1
        pdf_page = doc[0]
        # The drawing's own valves are open circles; the markers are filled
        filled = [d['rect'] for d in pdf_page.get_drawings() if d.get('fill') is not None]
        missing = []
        for asset_id in drawing.VALVES:
            x, y = drawing.paper_pt(asset_id)
            if not any(abs((r.x0 + r.x1) / 2 - x) < 0.1 and abs((r.y0 + r.y1) / 2 - y) < 0.1 for r in filled):
                missing.append(asset_id)
            assert pdf_page.search_for(f'Valve {asset_id[1:]}'), f'no label for {asset_id}'
        assert not missing, f'no marker drawn on the valve for {missing}'


def _export_pdf(page, tmp_path, name):
    with page.expect_download(timeout=60000) as download:
        page.click('button:has-text("Drawings with Assets (PDF)")')
    path = tmp_path / name
    download.value.save_as(path)
    return pymupdf.open(path)


def _colour_near(pix, point_pt, match, radius=3):
    """Whether any pixel within `radius` pixels of a point (PDF pt) of a
    page rendered at 144 DPI (2 px per pt) matches."""
    cx, cy = (round(v * 2) for v in point_pt)
    return any(match(*pix.pixel(x, y))
               for x in range(cx - radius, cx + radius + 1)
               for y in range(cy - radius, cy + radius + 1)
               if 0 <= x < pix.width and 0 <= y < pix.height)


def _drawing_blue(r, g, b):
    # The drawing's thin blue lines, anti-aliased against white
    return b - r > 60 and b - g > 40


def _link_magenta(r, g, b):
    return r > 200 and b > 200 and g < 80


def test_pdf_export_shows_cuts_links_measurements_and_section_eyes(ui, tmp_path):
    page = ui.page
    project = ui.new_project('Export as shown', csv='mga')
    pid, sheet_id = project['id'], project['sheet']
    width, height = drawing.IMAGE_SIZE
    # A link from V1 to V6 in MGA metres, and a measurement from V1 to V3
    # in canvas pixels
    ui.api('POST', f'/api/projects/{pid}/links/', json_body={
        'link_id': 'MAIN', 'name': 'Main', 'coordinates': [list(drawing.mga('V1')), list(drawing.mga('V6'))],
        'color': '#FF00FF', 'width': 6}, expect=201)
    (x1, y1), (x3, y3) = drawing.pixel('V1'), drawing.pixel('V3')
    ui.api('POST', f'/api/projects/{pid}/measurement-sets/', json_body={
        'name': 'Main check', 'measurement_type': 'single', 'color': '#00bcd4',
        'points': [{'x': x1, 'y': y1}, {'x': x3, 'y': y3}]}, expect=201)
    ui.open_editor(pid, markers=len(drawing.VALVES))

    def link_at(t):
        (ax, ay), (bx, by) = drawing.paper_pt('V1'), drawing.paper_pt('V6')
        return ax + t * (bx - ax), ay + t * (by - ay)

    def ring_below(asset_id):
        x, y = drawing.paper_pt(asset_id)
        return x, y + 2 * drawing.PT_PER_MM  # the drawn valve circle has a 2 mm radius

    def markers_drawn(pdf_page):
        filled = [d['rect'] for d in pdf_page.get_drawings() if d.get('fill') is not None]
        return {a for a in drawing.VALVES
                if any(abs((r.x0 + r.x1) / 2 - drawing.paper_pt(a)[0]) < 0.1
                       and abs((r.y0 + r.y1) / 2 - drawing.paper_pt(a)[1]) < 0.1 for r in filled)}

    # Everything shown, nothing cut
    with _export_pdf(page, tmp_path, 'before.pdf') as doc:
        pdf_page = doc[0]
        pix = pdf_page.get_pixmap(dpi=144, alpha=False)
        assert markers_drawn(pdf_page) == set(drawing.VALVES)
        assert _colour_near(pix, ring_below('V6'), _drawing_blue)
        assert _colour_near(pix, link_at(0.25), _link_magenta)
        assert _colour_near(pix, link_at(0.95), _link_magenta)
        expected = f'Main check: {drawing.metres_between("V1", "V3"):.2f} m'
        assert expected in pdf_page.get_text(), pdf_page.get_text()

    # Cut down the sheet at 300 mm across: V5 and V6 are on the far side
    cut_x = 300 * drawing.PX_PER_MM
    ui.show(width / 2, height / 2, zoom=0.4)
    top, bottom = ui.screen(cut_x, 50), ui.screen(cut_x, height - 50)
    ui.tool('crop')
    with page.expect_response(_on_post(f'/api/sheets/{sheet_id}/', 'PATCH')):
        ui.drag(top, bottom)
    # Hide the measurements section: that eye is kept in the browser
    page.uncheck('#measurements-group-vis')

    with _export_pdf(page, tmp_path, 'after.pdf') as doc:
        pdf_page = doc[0]
        pix = pdf_page.get_pixmap(dpi=144, alpha=False)
        assert markers_drawn(pdf_page) == set(drawing.VALVES) - {'V5', 'V6'}
        assert not _colour_near(pix, ring_below('V6'), _drawing_blue), 'the cut-away part was exported'
        assert _colour_near(pix, ring_below('V4'), _drawing_blue)
        assert _colour_near(pix, link_at(0.25), _link_magenta)
        assert not _colour_near(pix, link_at(0.95), _link_magenta), 'the link was drawn over the cut-away part'
        assert 'Main check' not in pdf_page.get_text(), 'the hidden measurement was exported'


def test_import_dialog_matches_gis_column_names_and_imports(ui):
    page = ui.page
    project = ui.new_project('Import dialog', csv=None)
    ui.open_editor(project['id'])

    page.click('text=Import / Add')
    page.click('text=Import Assets CSV')
    page.set_input_files('#import-csv-file', files=[
        {'name': 'valves.csv', 'mimeType': 'text/csv', 'buffer': drawing.wgs84_csv()}])
    page.click('#importModal button:has-text("Next")')
    page.wait_for_function("() => document.getElementById('map-x').options.length > 1")
    mapped = page.evaluate("""() => ['map-asset-id', 'map-asset-type', 'map-x', 'map-y']
        .map(id => document.getElementById(id).value)""")
    assert mapped == ['Asset ID', 'Type', 'Longitude', 'Latitude']

    with page.expect_response(_on_post('/import-csv/')) as importing:
        page.click('#importModal button:has-text("Import")')
    assert importing.value.ok
    page.wait_for_function(f'() => DocuWeaver.state.assets.length === {len(drawing.VALVES)}')
    assert any('9 created' in d for d in ui.dialogs), ui.dialogs
