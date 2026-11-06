"""A drawing whose answers are known.

One A3 landscape sheet at 1:500 with nine valves drawn at exact positions, a
water main through them and a 200 m scale bar. The asset CSVs give the same
valves in WGS84 lat/lon and in GDA94 MGA metres, worked out from where they
are drawn, so a test can check that every marker lands on its drawn symbol.

Positions are in rendered-image pixels: the server renders PDFs at 150 DPI
(RENDER_DPI in drawings/services/pdf_processor.py), and the first sheet sits
at canvas (0, 0), so these are also canvas coordinates.
"""
import csv
import io
import math

import pymupdf

RENDER_DPI = 150
SCALE = 500                      # 1:500
PAGE_MM = (420, 297)             # A3 landscape
PT_PER_MM = 72 / 25.4
PX_PER_MM = RENDER_DPI / 25.4
PX_PER_M = 1000 / SCALE * PX_PER_MM   # 2 mm of paper per metre: 11.811 px/m

# PyMuPDF rounds the rendered image up to whole pixels
IMAGE_SIZE = (math.ceil(PAGE_MM[0] * PX_PER_MM), math.ceil(PAGE_MM[1] * PX_PER_MM))

# Where V1 is drawn, in mm from the page's top-left corner. The others are
# placed from it by their offsets below, so north is up the page.
V1_MM = (30.0, 230.0)

# Metres east and north of V1. Spread over both axes so that a mirrored or
# stretched axis moves some markers well off their symbols.
VALVES = {
    'V1': (0.0, 0.0),
    'V2': (35.5, 8.25),
    'V3': (72.0, 21.5),
    'V4': (110.25, 30.0),
    'V5': (150.0, 47.75),
    'V6': (168.5, 90.0),
    'V7': (120.0, 96.5),
    'V8': (60.75, 80.0),
    'V9': (20.0, 55.5),
}

# The scale bar: 200 m (400 mm of paper) along the bottom of the sheet.
SCALE_BAR_M = 200
SCALE_BAR_MM = ((10.0, 280.0), (410.0, 280.0))

# Where V1 is on the ground.
V1_LATLON = (-27.4705, 153.026)
V1_MGA = (502650.0, 6961250.0)   # zone 56


def paper_mm(asset_id):
    east, north = VALVES[asset_id]
    return V1_MM[0] + east * 1000 / SCALE, V1_MM[1] - north * 1000 / SCALE


def pixel(asset_id):
    """Where the valve is drawn, in canvas pixels."""
    x, y = paper_mm(asset_id)
    return x * PX_PER_MM, y * PX_PER_MM


def paper_pt(asset_id):
    """Where the valve is drawn, in PDF points."""
    x, y = paper_mm(asset_id)
    return x * PT_PER_MM, y * PT_PER_MM


def scale_bar_pixels():
    return [(x * PX_PER_MM, y * PX_PER_MM) for x, y in SCALE_BAR_MM]


def metres_between(a, b):
    (ea, na), (eb, nb) = VALVES[a], VALVES[b]
    return math.hypot(eb - ea, nb - na)


def _metres_per_degree(lat_deg):
    """WGS84 metres per degree of latitude and longitude, from the
    ellipsoid's radii of curvature (not the series the app uses)."""
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    s = math.sin(math.radians(lat_deg))
    w = 1 - e2 * s * s
    meridian = a * (1 - e2) / w ** 1.5
    normal = a / math.sqrt(w)
    return (math.pi / 180 * meridian,
            math.pi / 180 * normal * math.cos(math.radians(lat_deg)))


def latlon(asset_id):
    east, north = VALVES[asset_id]
    lat_m, lon_m = _metres_per_degree(V1_LATLON[0])
    return V1_LATLON[0] + north / lat_m, V1_LATLON[1] + east / lon_m


def mga(asset_id):
    east, north = VALVES[asset_id]
    return V1_MGA[0] + east, V1_MGA[1] + north


def _csv(header, rows):
    out = io.StringIO()
    writer = csv.writer(out, lineterminator='\n')
    writer.writerow(header)
    writer.writerows(rows)
    return out.getvalue().encode()


def wgs84_csv():
    """Column names as a GIS export would have them, for the import dialog
    to match on its own."""
    rows = []
    for asset_id in VALVES:
        lat, lon = latlon(asset_id)
        rows.append([asset_id, 'Hydrant' if asset_id == 'V1' else 'Valve',
                     f'{lat:.10f}', f'{lon:.10f}', f'Valve {asset_id[1:]}'])
    return _csv(['Asset ID', 'Type', 'Latitude', 'Longitude', 'Description'], rows)


WGS84_MAPPING = {'asset_id': 'Asset ID', 'asset_type': 'Type', 'x': 'Longitude',
                 'y': 'Latitude', 'name': 'Description'}


def mga_csv():
    """The importer's own column names, which every import path accepts."""
    rows = [[asset_id, 'Valve', f'{e:.3f}', f'{n:.3f}', f'Valve {asset_id[1:]}']
            for asset_id, (e, n) in ((a, mga(a)) for a in VALVES)]
    return _csv(['asset_id', 'asset_type', 'x', 'y', 'name'], rows)


def pdf_bytes():
    doc = pymupdf.open()
    w, h = (v * PT_PER_MM for v in PAGE_MM)
    page = doc.new_page(width=w, height=h)
    mm = PT_PER_MM
    blue = (0, 0.25, 0.8)

    shape = page.new_shape()
    shape.draw_rect(pymupdf.Rect(5 * mm, 5 * mm, w - 5 * mm, h - 5 * mm))
    shape.finish(color=(0, 0, 0), width=0.8)

    # Water main through the valves, then the valves as open circles
    shape.draw_polyline([pymupdf.Point(*paper_pt(a)) for a in VALVES])
    shape.finish(color=blue, width=1.2, closePath=False)
    for asset_id in VALVES:
        shape.draw_circle(pymupdf.Point(*paper_pt(asset_id)), 2 * mm)
        shape.finish(color=blue, width=0.6)

    (x1, y1), (x2, y2) = SCALE_BAR_MM
    shape.draw_line(pymupdf.Point(x1 * mm, y1 * mm), pymupdf.Point(x2 * mm, y2 * mm))
    for x in (x1, x2):
        shape.draw_line(pymupdf.Point(x * mm, (y1 - 3) * mm), pymupdf.Point(x * mm, (y1 + 3) * mm))
    shape.finish(color=(0, 0, 0), width=0.6)
    shape.commit()

    for asset_id in VALVES:
        x, y = paper_pt(asset_id)
        page.insert_text(pymupdf.Point(x + 3 * mm, y - 3 * mm), asset_id, fontsize=9, color=blue)
    page.insert_text(pymupdf.Point(12 * mm, 275 * mm), f'{SCALE_BAR_M} m', fontsize=9)
    page.insert_text(pymupdf.Point(12 * mm, 15 * mm), 'DW-TEST-01  Water reticulation  1:500', fontsize=12)

    data = doc.tobytes()
    doc.close()
    return data
