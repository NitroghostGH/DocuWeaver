"""Exports: the composed PDF (sheets with asset markers) and the adjustment report."""
import csv
import logging
import math
import os
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

    def shape(self, x, y):
        """Displayed point -> point for Shape drawing methods and insert_image."""
        ux, uy = self.unrotated(x, y)
        user = fitz.Point(ux + self.crop.x, self.media_height - uy - self.crop.y)
        return user * self.pctm


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


def _draw_markers(page, sheet, markers):
    """Draw the markers that fall on this sheet's page. Returns how many."""
    k = 72 / RENDER_DPI  # canvas pixels are rendered-image pixels
    theta = math.radians(sheet.rotation or 0)
    cos, sin = math.cos(theta), math.sin(theta)
    space = _PageSpace(page)
    rect = page.rect
    shape = page.new_shape()
    images = []
    drawn = 0
    for asset, (cx, cy) in markers:
        # Canvas -> the sheet image's own pixels: undo the sheet's offset and
        # its rotation about its top-left corner (Fabric's default origin).
        dx, dy = cx - sheet.offset_x, cy - sheet.offset_y
        x = (dx * cos + dy * sin) * k
        y = (-dx * sin + dy * cos) * k
        if not rect.contains(fitz.Point(x, y)):
            continue
        drawn += 1
        asset_type = asset.asset_type
        size = (asset_type.size or 20) * k
        color = parse_color(asset_type.color)

        icon_path = _icon_path(asset_type)
        if icon_path:
            corners = fitz.Rect(space.shape(x - size / 2, y - size / 2), space.shape(x + size / 2, y + size / 2))
            images.append((corners.normalize(), icon_path))
        else:
            points = _symbol_points(asset_type.icon_shape, x, y, size)
            if points is None:
                shape.draw_circle(space.shape(x, y), size / 2)
            else:
                shape.draw_polyline([space.shape(px, py) for px, py in points])
            shape.finish(color=(0, 0, 0), fill=color, width=k, closePath=True)

        fontsize = 10 * k
        label_x, label_y = x + size / 2 + 3 * k, y + 0.35 * fontsize  # baseline: text centred on y
        shape.insert_text(space.unrotated(label_x, label_y), asset.name or asset.asset_id,
                          fontsize=fontsize, color=(0, 0, 0), rotate=space.rotation)
    shape.commit()
    for corners, path in images:
        try:
            page.insert_image(corners, filename=path, rotate=space.rotation)
        except (RuntimeError, ValueError, OSError) as e:
            logger.warning("Export: could not draw icon %s: %s", path, e)
    return drawn


def export_project_pdf(project, sheet_ids=None):
    """One PDF with a page per visible sheet (lowest Z-index first), each the
    sheet's original PDF page with asset markers drawn where the editor
    shows them. Returns the PDF bytes; raises ExportError if there's nothing
    to export.

    Hidden sheets and assets (their own eye toggle or any folder above them)
    are left out, as are markers that fall outside a page. Cuts only trim
    the sheet on the canvas, so the whole page and every marker on it are
    exported.
    """
    groups = {g.id: g for g in LayerGroup.objects.filter(project=project)}
    hidden = _folder_hidden(groups)

    sheets = [s for s in project.sheets.all()
              if (sheet_ids is None or s.id in sheet_ids) and s.visible and not hidden(s.layer_group_id)]
    if not sheets:
        raise ExportError('There are no visible sheets to export.')

    assets = list(project.assets.select_related('asset_type'))
    layout = MarkerLayout(project, assets)
    markers = []
    if layout.drawable:
        markers = [(a, layout.pixel(a.current_x, a.current_y)) for a in assets
                   if a.visible and not hidden(a.layer_group_id)]

    out = fitz.open()
    sources = {}
    skipped = []
    try:
        for sheet in sheets:
            name = sheet.pdf_file.name
            try:
                if name not in sources:
                    sources[name] = open_pdf(sheet.pdf_file.path)
                src = sources[name]
            except (PdfError, OSError, ValueError) as e:
                logger.warning("Export: sheet %d skipped, its PDF can't be read: %s", sheet.id, e)
                skipped.append(sheet.name)
                continue
            if not 1 <= sheet.page_number <= len(src):
                skipped.append(sheet.name)
                continue
            out.insert_pdf(src, from_page=sheet.page_number - 1, to_page=sheet.page_number - 1)
            drawn = _draw_markers(out[-1], sheet, markers)
            logger.info("Export: sheet %d page %d with %d marker(s)", sheet.id, sheet.page_number, drawn)
        if len(out) == 0:
            raise ExportError(f"None of the sheets' PDF files could be read ({', '.join(skipped)}).")
        return out.tobytes(garbage=3, deflate=True)
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
