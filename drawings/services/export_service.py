"""Exports: the composed PDF (sheets with links, asset markers and
measurements) and the adjustment report."""
import csv
import itertools
import logging
import math
import os
import re
from io import StringIO

import pymupdf as fitz
from django.db.models import Count, OuterRef, Subquery
from django.http import HttpResponse
from django.utils.http import content_disposition_header

from ..models import AdjustmentLog, LayerGroup
from .pdf_processor import RENDER_DPI, PdfError, open_pdf, parse_color

logger = logging.getLogger(__name__)

# Coordinate units whose values are degrees (x = longitude, y = latitude).
DEGREE_UNITS = ('degrees', 'gda94_geo')


class ExportError(ValueError):
    """Nothing could be exported. The message is written for the user."""


def sanitize_csv_value(value):
    """Sanitize a string value for CSV export to prevent formula injection."""
    if isinstance(value, str) and value and value[0] in ('=', '+', '-', '@', '\t', '\r'):
        return "'" + value
    return value


def download_name(name, extension):
    """A download filename from a project name: path separators and control
    characters replaced, so the browser saves what the user named it."""
    cleaned = ''.join('-' if c in '/\\' else ' ' if ord(c) < 32 or ord(c) == 127 else c
                      for c in str(name)).strip(' .')
    return f'{cleaned or "project"}.{extension}'


def attachment(response, filename):
    """Mark `response` as a download called `filename` (quotes and non-ASCII
    characters are encoded, so any project name works)."""
    response.headers['Content-Disposition'] = content_disposition_header(True, filename)
    return response


def metres_per_degree(lat_deg):
    """Metres per degree of latitude and of longitude at a latitude (WGS84).

    The same formula as metresPerDegree in static/js/editor/assets.js.
    """
    p = math.radians(lat_deg)
    lat = 111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p) - 0.0023 * math.cos(6 * p)
    lon = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p) + 0.118 * math.cos(5 * p)
    return lat, lon


# ---------------------------------------------------------------------------
# Composed PDF
# ---------------------------------------------------------------------------

def _folder_hidden(groups):
    """function(folder id) -> True if that folder or any folder above it is hidden."""
    def hidden(group_id):
        seen = set()
        while group_id is not None and group_id not in seen:
            seen.add(group_id)
            group = groups.get(group_id)
            if group is None:
                return False
            if not group.visible:
                return True
            group_id = group.parent_group_id
        return False

    return hidden


class MarkerLayout:
    """Where the editor draws each asset, in canvas pixels.

    The same transform as assetMeterToPixel in static/js/editor/assets.js:
    the reference asset's ORIGINAL coordinates sit at (ref_pixel_x,
    ref_pixel_y); other assets are offset from it in metres (x east, y south
    on the canvas), rotated by asset_rotation and scaled by pixels_per_meter.
    """

    def __init__(self, project, assets):
        self.project = project
        self.ppm = project.pixels_per_meter
        self.degrees = project.coord_unit in DEGREE_UNITS
        self.ref = next((a for a in assets if a.asset_id == project.ref_asset_id), None)
        rad = math.radians(project.asset_rotation or 0)
        self.cos, self.sin = math.cos(rad), math.sin(rad)

    @property
    def drawable(self):
        # The editor draws no markers until a reference point is set, and a
        # scale that isn't a positive number would pile them all at (0, 0).
        return (bool(self.project.ref_asset_id)
                and not (self.project.ref_pixel_x == 0 and self.project.ref_pixel_y == 0)
                and self.ppm is not None and math.isfinite(self.ppm) and self.ppm > 0)

    def _metres(self, dx, dy, ref_y):
        if self.degrees:
            lat_m, lon_m = metres_per_degree(ref_y or 0)
            return dx * lon_m, -dy * lat_m
        return dx, -dy

    def pixel(self, x, y):
        if self.ref is None:
            mx, my = self._metres(x, y, y)
            return self.project.origin_x + mx * self.ppm, self.project.origin_y + my * self.ppm
        mx, my = self._metres(x - self.ref.original_x, y - self.ref.original_y, self.ref.original_y)
        return (self.project.ref_pixel_x + (mx * self.cos - my * self.sin) * self.ppm,
                self.project.ref_pixel_y + (mx * self.sin + my * self.cos) * self.ppm)


class _PageSpace:
    """Converts a point on the page as displayed (PDF points from the top-left
    of the visible page, which is what the editor's PNG shows) into the
    coordinates PyMuPDF's drawing methods expect.

    PyMuPDF draws in the unrotated page's space, and on a page that is both
    rotated (/Rotate) and cropped (/CropBox) its Shape and insert_image
    leave out the crop offset, so markers would land up to the crop margin
    away. Shape.insert_text does include it; points for shapes and images are
    built the way insert_text does it.
    """

    def __init__(self, page):
        self.page = page
        self.rotation = page.rotation % 360
        self.width, self.height = page.cropbox.width, page.cropbox.height
        self.crop = page.cropbox_position
        self.media_height = page.mediabox_size.y
        self.pctm = page.transformation_matrix

    def unrotated(self, x, y):
        """Displayed point -> unrotated page point (what insert_text takes)."""
        w, h = self.width, self.height
        return {0: (x, y), 90: (y, h - x), 180: (w - x, h - y), 270: (w - y, x)}[self.rotation]

    def user(self, x, y):
        """Displayed point -> PDF user space, the coordinates written into
        the page's content stream (y up from the bottom of the MediaBox)."""
        ux, uy = self.unrotated(x, y)
        return fitz.Point(ux + self.crop.x, self.media_height - uy - self.crop.y)

    def shape(self, x, y):
        """Displayed point -> point for Shape drawing methods and insert_image."""
        return self.user(x, y) * self.pctm


def _symbol_points(shape, x, y, size):
    """Outline of a marker symbol as the editor draws it, centred on (x, y);
    None for a circle."""
    if shape == 'square':
        h = size / 2
        return [(x - h, y - h), (x + h, y - h), (x + h, y + h), (x - h, y + h)]
    if shape == 'triangle':
        h = size / 2
        return [(x, y - h), (x + h, y + h), (x - h, y + h)]
    if shape == 'diamond':
        # A square of side 0.7 * size turned 45 degrees.
        d = 0.7 * size / math.sqrt(2)
        return [(x, y - d), (x + d, y), (x, y + d), (x - d, y)]
    if shape == 'star':
        points = []
        for i in range(10):
            r = size / 2 if i % 2 == 0 else size / 4
            angle = i * math.pi / 5 - math.pi / 2
            points.append((x + math.cos(angle) * r, y + math.sin(angle) * r))
        return points
    return None


def _icon_path(asset_type):
    """The custom icon file to draw, or None for a drawn symbol."""
    if asset_type.icon_shape != 'custom' or not asset_type.custom_icon:
        return None
    try:
        path = asset_type.custom_icon.path
    except (NotImplementedError, ValueError):
        return None
    return path if os.path.exists(path) else None


def _js_round(value):
    """Math.round: halves round up, as the editor rounds the cut polygon."""
    return math.floor(value + 0.5)


def _clip_by_edge(polygon, a, b):
    """Keep the part of `polygon` left of the line a->b (Sutherland-Hodgman),
    as clipPolygonByEdge in static/js/editor/crop.js."""
    ex, ey = b[0] - a[0], b[1] - a[1]

    def cross(p):
        return ex * (p[1] - a[1]) - ey * (p[0] - a[0])

    def intersection(p, q):
        cp, cq = cross(p), cross(q)
        if abs(cp - cq) < 1e-10:
            return (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
        t = cp / (cp - cq)
        return p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])

    out = []
    for i, current in enumerate(polygon):
        following = polygon[(i + 1) % len(polygon)]
        current_in, following_in = cross(current) >= 0, cross(following) >= 0
        if current_in:
            out.append(current)
            if not following_in:
                out.append(intersection(current, following))
        elif following_in:
            out.append(intersection(current, following))
    return out


def _cut_points(cut):
    try:
        points = (float(cut['p1']['x']), float(cut['p1']['y']),
                  float(cut['p2']['x']), float(cut['p2']['y']))
    except (KeyError, TypeError, ValueError):
        return None
    return points if all(math.isfinite(v) for v in points) else None


def cut_polygon(cuts, width, height):
    """The part of a sheet its cuts leave, in image pixels from the image's
    top-left corner: computeMultiCutPolygon in static/js/editor/crop.js.

    Each cut is a line in the image's own coordinates (from its centre); it
    keeps the side the centre is on, or the other side if flipped. Returns
    None when there are no cuts, or when they leave nothing, in which case
    the editor shows the whole sheet.
    """
    if not cuts or not isinstance(cuts, list):
        return None
    pad = max(width, height) * 0.6
    w, h = width / 2 + pad, height / 2 + pad
    polygon = [(-w, -h), (w, -h), (w, h), (-w, h)]
    for cut in cuts:
        points = _cut_points(cut) if isinstance(cut, dict) else None
        if points is None:
            continue
        x1, y1, x2, y2 = points
        dx, dy = x2 - x1, y2 - y1
        length = math.hypot(dx, dy)
        if length == 0:
            continue
        # Normal pointing to the kept side: towards the centre, unless flipped
        nx, ny = -dy / length, dx / length
        if -(x1 + x2) / 2 * nx - (y1 + y2) / 2 * ny < 0:
            nx, ny = -nx, -ny
        if cut.get('flipped'):
            nx, ny = -nx, -ny
        if nx * -dy / length + ny * dx / length > 0:
            polygon = _clip_by_edge(polygon, (x1, y1), (x2, y2))
        else:
            polygon = _clip_by_edge(polygon, (x2, y2), (x1, y1))
        if not polygon:
            return None
    if len(polygon) < 3:
        return None
    return [(_js_round(x) + width / 2, _js_round(y) + height / 2) for x, y in polygon]


def _inside(polygon, x, y):
    """Ray-casting point-in-polygon test (isPointInVisibleArea in crop.js)."""
    inside = False
    j = len(polygon) - 1
    for i, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _number(value):
    """A finite float, or None."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


class _SheetPage:
    """One sheet's page in the export: where canvas pixels fall on it, and
    the part of it the editor shows (the page, less what the cuts remove)."""

    K = 72 / RENDER_DPI  # canvas pixels are rendered-image pixels

    def __init__(self, page, sheet):
        self.page = page
        self.space = _PageSpace(page)
        self.offset_x, self.offset_y = sheet.offset_x, sheet.offset_y
        theta = math.radians(sheet.rotation or 0)
        self.cos, self.sin = math.cos(theta), math.sin(theta)
        rect = page.rect
        # The rendered image's size, which the editor's cut coordinates are
        # relative to; PyMuPDF rounds the render up to whole pixels.
        zoom = RENDER_DPI / 72
        width = sheet.image_width or math.ceil(rect.width * zoom)
        height = sheet.image_height or math.ceil(rect.height * zoom)
        polygon = cut_polygon(sheet.cuts_json, width, height)
        self.cut = [(x * self.K, y * self.K) for x, y in polygon] if polygon else None
        self.clip = self._clip_operators()

    def point(self, cx, cy):
        """Canvas pixel -> displayed page point. Undoes the sheet's offset and
        its rotation about its top-left corner (Fabric's default origin)."""
        dx, dy = cx - self.offset_x, cy - self.offset_y
        return ((dx * self.cos + dy * self.sin) * self.K,
                (-dx * self.sin + dy * self.cos) * self.K)

    def shows(self, x, y):
        """Whether a displayed point is on the part of the page the editor shows."""
        return self.page.rect.contains(fitz.Point(x, y)) and (self.cut is None or _inside(self.cut, x, y))

    def touches(self, points, margin=10):
        """Whether a line through these displayed points may cross the page.
        (Not Rect.intersects, which treats the flat box of a level line as
        empty.)"""
        rect = self.page.rect
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        return (max(xs) >= rect.x0 - margin and min(xs) <= rect.x1 + margin
                and max(ys) >= rect.y0 - margin and min(ys) <= rect.y1 + margin)

    def _clip_operators(self):
        """PDF operators that clip to the cut polygon, or None without cuts."""
        if self.cut is None:
            return None
        ops = [f'{p.x:.3f} {p.y:.3f} {"m" if i == 0 else "l"}'
               for i, p in enumerate(self.space.user(x, y) for x, y in self.cut)]
        return ('\n'.join(ops) + '\nh W n\n').encode()


def _add_contents(page, data, first=False):
    """Add a content stream before or after the page's others. The page's
    own streams are left as they are: another page may share them."""
    doc = page.parent
    xref = doc.get_new_xref()
    doc.update_object(xref, '<<>>')
    doc.update_stream(xref, data)
    contents = page.get_contents()
    contents = [xref, *contents] if first else [*contents, xref]
    doc.xref_set_key(page.xref, 'Contents', '[' + ' '.join(f'{x} 0 R' for x in contents) + ']')


def _commit(shape, clip=None):
    """Commit a Shape, clipped to `clip` (PDF operators) if given."""
    page = shape.page
    before = set(page.get_contents())
    shape.commit()
    contents = page.get_contents()
    if clip and contents and contents[-1] not in before:
        doc = page.parent
        doc.update_stream(contents[-1], b'q\n' + clip + doc.xref_stream(contents[-1]) + b'\nQ\n')


def _draw_label(shape, sp, x, y, text, fontsize):
    """Black text with its baseline set so it's centred on y."""
    shape.insert_text(sp.space.unrotated(x, y + 0.35 * fontsize), text,
                      fontsize=fontsize, color=(0, 0, 0), rotate=sp.space.rotation)


def _draw_links(sp, links):
    """Links as the editor draws them (renderLinksOnCanvas in links.js):
    polylines with the link's colour, width and opacity."""
    shape = sp.page.new_shape()
    for link, canvas_points in links:
        points = [sp.point(cx, cy) for cx, cy in canvas_points]
        if not sp.touches(points):
            continue
        shape.draw_polyline([sp.space.shape(x, y) for x, y in points])
        opacity = _number(link.opacity) or 1.0
        shape.finish(color=parse_color(link.color or '#0066FF'), width=(link.width or 2) * sp.K,
                     stroke_opacity=min(max(opacity, 0), 1), closePath=False)
    _commit(shape, sp.clip)


def _draw_markers(sp, markers):
    """Asset markers and labels. Returns how many were drawn. Markers are
    left out where the page isn't shown (off the page or cut away); a label
    may run past a cut."""
    k = sp.K
    shape = sp.page.new_shape()
    images = []
    drawn = 0
    for asset, (cx, cy) in markers:
        x, y = sp.point(cx, cy)
        if not sp.shows(x, y):
            continue
        drawn += 1
        asset_type = asset.asset_type
        size = (asset_type.size or 20) * k
        color = parse_color(asset_type.color)

        icon_path = _icon_path(asset_type)
        if icon_path:
            corners = fitz.Rect(sp.space.shape(x - size / 2, y - size / 2),
                                sp.space.shape(x + size / 2, y + size / 2))
            images.append((corners.normalize(), icon_path))
        else:
            points = _symbol_points(asset_type.icon_shape, x, y, size)
            if points is None:
                shape.draw_circle(sp.space.shape(x, y), size / 2)
            else:
                shape.draw_polyline([sp.space.shape(px, py) for px, py in points])
            shape.finish(color=(0, 0, 0), fill=color, width=k, closePath=True)
        _draw_label(shape, sp, x + size / 2 + 3 * k, y, asset.name or asset.asset_id, 10 * k)
    _commit(shape)
    for corners, path in images:
        try:
            sp.page.insert_image(corners, filename=path, rotate=sp.space.rotation)
        except (RuntimeError, ValueError, OSError) as e:
            logger.warning("Export: could not draw icon %s: %s", path, e)
    return drawn


def _format_distance(pixels, project):
    """formatDistance in static/js/measurement_tool.js."""
    ppm = project.pixels_per_meter
    if not (project.scale_calibrated and ppm and math.isfinite(ppm) and ppm > 0):
        return f'{_js_round(pixels)} px'
    metres = pixels / ppm
    if metres >= 1000:
        return f'{metres / 1000:.2f} km'
    if metres >= 1:
        return f'{metres:.2f} m'
    return f'{metres * 100:.1f} cm'


def _draw_measurements(sp, project, measurements):
    """Saved measurements as the editor draws them (renderSaved in
    measurement_tool.js): dashed lines with a dot at each point. On paper
    there's nothing to click, so each also gets a label with its name and
    length, above the middle of its longest segment (its ends are often on
    assets, which have labels of their own)."""
    k = sp.K
    fontsize = 10 * k
    lines, labels = sp.page.new_shape(), sp.page.new_shape()
    for ms, canvas_points in measurements:
        points = [sp.point(cx, cy) for cx, cy in canvas_points]
        if not sp.touches(points):
            continue
        color = parse_color(ms.color or '#00bcd4')
        if len(points) >= 2:
            lines.draw_polyline([sp.space.shape(x, y) for x, y in points])
            lines.finish(color=color, width=2 * k, dashes=f'[{5 * k:.4f} {5 * k:.4f}] 0', closePath=False)
        for x, y in points:
            lines.draw_circle(sp.space.shape(x, y), 4 * k)
            lines.finish(color=(1, 1, 1), fill=color, width=k)
        if len(points) < 2:
            continue
        a, b = max(itertools.pairwise(points), key=lambda seg: math.dist(*seg))
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        span = math.dist(a, b)
        if not sp.shows(mx, my) or span == 0:
            continue
        length = _format_distance(sum(math.dist(p, q) for p, q in itertools.pairwise(canvas_points)), project)
        text = f'{ms.name}: {length}' if ms.name else length
        width = fitz.get_text_length(text, fontsize=fontsize)
        # Move the text's centre off the line, along the normal that points
        # up the page (or right, for an upright line), just far enough for
        # the whole text box to clear it at any angle.
        nx, ny = (b[1] - a[1]) / span, -(b[0] - a[0]) / span
        if ny > 0 or (ny == 0 and nx < 0):
            nx, ny = -nx, -ny
        d = width / 2 * abs(nx) + fontsize / 2 * abs(ny) + 3 * k
        _draw_label(labels, sp, mx + nx * d - width / 2, my + ny * d, text, fontsize)
    _commit(lines, sp.clip)
    _commit(labels)


# PDF layers. Copying a page into the export keeps its layers (optional
# content groups) but not the document's layer settings, so every layer
# would show. Each OCG is tagged in the source with whether the sheet shows
# it, and the export's settings are rebuilt from the tags once every page is
# in. Sheets that show different layers of the same PDF get their own copy
# of it, so each page keeps its own choice.
_LAYER_TAG = 'DocuWeaverShown'


def _layer_choice(sheet):
    """The xrefs of the layers the sheet shows, or None for the PDF's own
    settings (the same rule as _with_layers in pdf_processor.py: a list
    that names no layer, such as the editor's [0], hides them all)."""
    if sheet.visible_layers and sheet.pdf_layers and isinstance(sheet.visible_layers, list):
        return frozenset(v for v in sheet.visible_layers if isinstance(v, int))
    return None


def _tag_layers(src, sheet):
    """Tag every layer of a source PDF with whether `sheet` shows it.
    Returns whether the PDF has layers."""
    ocgs = src.get_ocgs()
    choice = _layer_choice(sheet)
    chosen = {layer.get('xref') for layer in sheet.pdf_layers or [] if isinstance(layer, dict)}
    for xref, info in ocgs.items():
        shown = xref in choice if choice is not None and xref in chosen else info.get('on', True)
        src.xref_set_key(xref, _LAYER_TAG, 'true' if shown else 'false')
    return bool(ocgs)


def _set_layers(out):
    """Give the export layer settings that show what each sheet showed."""
    on, off = [], []
    for xref in range(1, out.xref_length()):
        if out.xref_get_key(xref, 'Type') != ('name', '/OCG'):
            continue
        tag = out.xref_get_key(xref, _LAYER_TAG)[1]
        (off if tag == 'false' else on).append(xref)
        # Drop the tag (setting it to null would leave "/DocuWeaverShown null")
        out.update_object(xref, re.sub(rf'/{_LAYER_TAG}\s*(true|false)', '', out.xref_object(xref, compressed=True)))
    if not on and not off:
        return

    def refs(xrefs):
        return ' '.join(f'{x} 0 R' for x in xrefs)

    out.xref_set_key(out.pdf_catalog(), 'OCProperties',
                     f'<</OCGs [{refs(on + off)}] /D <</Name (DocuWeaver) /BaseState /ON '
                     f'/ON [{refs(on)}] /OFF [{refs(off)}] /Order [{refs(sorted(on + off))}]>>>>')


def _line_points(pairs, layout):
    """Canvas pixels of a link's [x, y] coordinates; None if there aren't
    two usable ones."""
    points = []
    for pair in pairs if isinstance(pairs, list) else []:
        if isinstance(pair, (list, tuple)) and len(pair) >= 2:
            x, y = _number(pair[0]), _number(pair[1])
            if x is not None and y is not None:
                points.append(layout.pixel(x, y))
    return points if len(points) >= 2 else None


def _canvas_points(points):
    """A measurement's {x, y} canvas points, without unusable ones."""
    out = []
    for point in points if isinstance(points, list) else []:
        if isinstance(point, dict):
            x, y = _number(point.get('x')), _number(point.get('y'))
            if x is not None and y is not None:
                out.append((x, y))
    return out


EXPORT_SECTIONS = ('sheets', 'assets', 'links', 'measurements')


def export_project_pdf(project, sheet_ids=None, hide=(), hidden_batches=()):
    """One PDF with a page per visible sheet (lowest Z-index first): each the
    sheet's original PDF page, cut and with its PDF layers as the editor
    shows it, with links, asset markers and saved measurements drawn on top
    where the editor draws them. Returns the PDF bytes; raises ExportError
    if there's nothing to export.

    What's hidden in the editor is left out: items whose own eye or any
    folder above them is off (saved on the server), plus the sections in
    `hide` and the import batches in `hidden_batches`, whose eyes the
    editor keeps per browser and sends with the request. Markers are left
    out where the page isn't shown (off the page or cut away); lines are
    clipped there.
    """
    hide = set(hide)
    hidden_batches = set(hidden_batches)
    groups = {g.id: g for g in LayerGroup.objects.filter(project=project)}
    hidden = _folder_hidden(groups)

    def shown(item, section):
        return (section not in hide and item.visible and not hidden(item.layer_group_id)
                and getattr(item, 'import_batch_id', None) not in hidden_batches)

    sheets = [s for s in project.sheets.all()
              if (sheet_ids is None or s.id in sheet_ids) and shown(s, 'sheets')]
    if not sheets:
        raise ExportError('There are no visible sheets to export.')

    assets = list(project.assets.select_related('asset_type'))
    layout = MarkerLayout(project, assets)
    markers, links = [], []
    # Markers and links need the reference point, as in the editor.
    if layout.drawable:
        markers = [(a, layout.pixel(a.current_x, a.current_y)) for a in assets if shown(a, 'assets')]
        for link in project.links.all():
            points = _line_points(link.coordinates, layout) if shown(link, 'links') else None
            if points:
                links.append((link, points))
    measurements = []
    for ms in project.measurement_sets.all():
        points = _canvas_points(ms.points) if shown(ms, 'measurements') else []
        if points:
            measurements.append((ms, points))

    out = fitz.open()
    sources = {}
    skipped = []
    layered = False
    try:
        for sheet in sheets:
            key = (sheet.pdf_file.name, _layer_choice(sheet))
            try:
                if key not in sources:
                    src = open_pdf(sheet.pdf_file.path)
                    sources[key] = src
                    layered = _tag_layers(src, sheet) or layered
                src = sources[key]
            except (PdfError, OSError, ValueError) as e:
                logger.warning("Export: sheet %d skipped, its PDF can't be read: %s", sheet.id, e)
                skipped.append(sheet.name)
                continue
            if not 1 <= sheet.page_number <= len(src):
                skipped.append(sheet.name)
                continue
            src_page = src[sheet.page_number - 1]
            if sheet.cuts_json and (src_page.first_annot is not None or src_page.first_widget is not None):
                # A cut clips the page's content, and annotations (markups,
                # form fields) are drawn apart from it: make them content.
                src.bake()
            # final=False keeps PyMuPDF's map of the objects already copied
            # from this source, so its pages share fonts, images and layers.
            out.insert_pdf(src, from_page=sheet.page_number - 1, to_page=sheet.page_number - 1, final=False)
            page = out[-1]
            sp = _SheetPage(page, sheet)
            page.wrap_contents()  # a balanced page, so the cut's clip ends where it should
            if sp.clip:
                _add_contents(page, b'q\n' + sp.clip, first=True)
                _add_contents(page, b'\nQ\n')
            # The editor's stacking: sheets, links, assets, measurements
            _draw_links(sp, links)
            drawn = _draw_markers(sp, markers)
            _draw_measurements(sp, project, measurements)
            logger.info("Export: sheet %d page %d with %d marker(s)", sheet.id, sheet.page_number, drawn)
        if len(out) == 0:
            raise ExportError(f"None of the sheets' PDF files could be read ({', '.join(skipped)}).")
        if layered:
            _set_layers(out)
        # Not garbage=3: it merges identical objects, and the copies of a
        # layer that one sheet shows and another hides are identical once
        # their tags are gone. Objects shared within one source are shared
        # already (final=False above).
        return out.tobytes(garbage=2, deflate=True)
    finally:
        out.close()
        for src in sources.values():
            src.close()


# ---------------------------------------------------------------------------
# Adjustment report
# ---------------------------------------------------------------------------

def report_assets(project):
    """Adjusted assets with what the report needs, in a fixed number of queries."""
    last_notes = (AdjustmentLog.objects.filter(asset=OuterRef('pk'))
                  .order_by('-timestamp', '-pk').values('notes')[:1])
    return (project.assets.filter(is_adjusted=True).select_related('asset_type')
            .annotate(adjustment_count=Count('adjustment_logs'), last_notes=Subquery(last_notes)))


def distance_metres(project, x1, y1, x2, y2):
    """Ground distance between two positions in the project's coordinate unit."""
    dx, dy = x2 - x1, y2 - y1
    if project.coord_unit in DEGREE_UNITS:
        lat_m, lon_m = metres_per_degree(y1)
        dx, dy = dx * lon_m, dy * lat_m
    return math.hypot(dx, dy)


def generate_adjustment_report(project, adjusted_assets):
    """The adjustment report as a CSV download.

    Coordinates are in the project's unit: degrees to 8 decimals (about
    1 mm), metres to 3. The distance moved is always in metres.
    """
    degrees = project.coord_unit in DEGREE_UNITS
    unit, places = ('deg', 8) if degrees else ('m', 3)

    def number(value):
        return '' if value is None else f"{value:.{places}f}"

    output = StringIO()
    writer = csv.writer(output)
    writer.writerow([
        'Asset ID', 'Asset Name', 'Asset Type',
        f'Original X ({unit})', f'Original Y ({unit})',
        f'Adjusted X ({unit})', f'Adjusted Y ({unit})',
        f'Delta X ({unit})', f'Delta Y ({unit})', 'Distance Moved (m)',
        'Adjustment Count', 'Last Adjustment Notes'
    ])
    for asset in adjusted_assets:
        moved = asset.adjusted_x is not None and asset.adjusted_y is not None
        writer.writerow([
            sanitize_csv_value(asset.asset_id),
            sanitize_csv_value(asset.name),
            sanitize_csv_value(asset.asset_type.name),
            number(asset.original_x),
            number(asset.original_y),
            number(asset.adjusted_x),
            number(asset.adjusted_y),
            number(asset.adjusted_x - asset.original_x if moved else 0),
            number(asset.adjusted_y - asset.original_y if moved else 0),
            f"{distance_metres(project, asset.original_x, asset.original_y, asset.adjusted_x, asset.adjusted_y):.3f}"
            if moved else '0.000',
            asset.adjustment_count,
            sanitize_csv_value(asset.last_notes or ''),
        ])

    response = HttpResponse(output.getvalue(), content_type='text/csv')
    return attachment(response, download_name(f'{project.name} adjustments', 'csv'))
