"""PDF processing service for rendering and manipulating PDFs."""
import logging
import os
from io import BytesIO

import pymupdf as fitz
from django.core.files.base import ContentFile
from PIL import Image

logger = logging.getLogger(__name__)


def get_pdf_layers(pdf_path):
    """
    Extract Optional Content Groups (layers) from a PDF.

    Returns a list of dicts: [{xref: int, name: str}, ...]
    """
    doc = fitz.open(pdf_path)
    try:
        ocgs = doc.get_ocgs()  # {xref: {name, intent, on}}
        layers = [{'xref': xref, 'name': info.get('name', f'Layer {xref}')}
                  for xref, info in ocgs.items()]
        return layers
    finally:
        doc.close()


def render_pdf_page(sheet, dpi=150):
    """
    Render a PDF page to an image and save it to the sheet.
    Respects visible_layers if set (empty list = all visible).

    Args:
        sheet: Sheet model instance
        dpi: Resolution for rendering (default 150)
    """
    pdf_path = sheet.pdf_file.path
    page_number = sheet.page_number - 1  # PyMuPDF uses 0-based indexing

    # Open the PDF
    doc = fitz.open(pdf_path)

    if page_number >= len(doc):
        doc.close()
        raise ValueError(f"Page {sheet.page_number} does not exist in PDF (has {len(doc)} pages)")

    # Extract layers on first render if not already set
    if not sheet.pdf_layers:
        ocgs = doc.get_ocgs()
        if ocgs:
            sheet.pdf_layers = [
                {'xref': xref, 'name': info.get('name', f'Layer {xref}')}
                for xref, info in ocgs.items()
            ]

    # Apply layer visibility if specified
    if sheet.visible_layers and sheet.pdf_layers:
        visible_set = set(sheet.visible_layers)
        on_names = [layer['name'] for layer in sheet.pdf_layers if layer['xref'] in visible_set]
        off_names = [layer['name'] for layer in sheet.pdf_layers if layer['xref'] not in visible_set]
        if on_names or off_names:
            doc.set_layer(-1, on=on_names, off=off_names)

    page = doc[page_number]

    # Render at specified DPI
    zoom = dpi / 72  # 72 is the default PDF resolution
    matrix = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=matrix)

    # Convert to PIL Image
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

    # Save to BytesIO
    buffer = BytesIO()
    img.save(buffer, format='PNG')
    buffer.seek(0)

    # Save to sheet
    filename = f"sheet_{sheet.id}_page_{sheet.page_number}.png"
    sheet.rendered_image.save(filename, ContentFile(buffer.read()), save=False)
    sheet.image_width = pix.width
    sheet.image_height = pix.height
    sheet.save()

    doc.close()

    logger.info("Rendered sheet %d page %d at %d DPI (%dx%d px)",
                sheet.id, sheet.page_number, dpi, pix.width, pix.height)

    return {
        'width': pix.width,
        'height': pix.height,
        'path': sheet.rendered_image.path
    }


def get_pdf_page_count(pdf_path):
    """Get the number of pages in a PDF."""
    doc = fitz.open(pdf_path)
    count = len(doc)
    doc.close()
    logger.info("PDF %s has %d page(s)", os.path.basename(pdf_path), count)
    return count


def apply_crop_to_image(image_path, crop_x, crop_y, crop_width, crop_height):
    """
    Apply crop to an image.

    Args:
        image_path: Path to the image file
        crop_x, crop_y: Top-left corner of crop region
        crop_width, crop_height: Size of crop region (0 means full size)
    """
    img = Image.open(image_path)

    if crop_width <= 0:
        crop_width = img.width - crop_x
    if crop_height <= 0:
        crop_height = img.height - crop_y

    # Crop region: (left, upper, right, lower)
    box = (
        int(crop_x),
        int(crop_y),
        int(crop_x + crop_width),
        int(crop_y + crop_height)
    )
    cropped = img.crop(box)

    return cropped


def render_overlay_on_pdf(pdf_path, output_path, page_number, overlays, pixels_per_meter, origin_x, origin_y):
    """
    Render overlays onto a PDF page and save as new PDF.

    Args:
        pdf_path: Path to original PDF
        output_path: Path for output PDF
        page_number: Page to overlay (1-based)
        overlays: List of overlay dicts with {x, y, icon_shape, color, size, label}
        pixels_per_meter: Scale factor
        origin_x, origin_y: Coordinate origin in pixels
    """
    doc = fitz.open(pdf_path)
    page = doc[page_number - 1]

    # Get the transformation matrix to convert from rendered image coordinates to PDF coordinates
    # This accounts for the DPI difference
    render_dpi = 150
    scale = 72 / render_dpi  # Convert from rendered pixels to PDF points

    for overlay in overlays:
        # Convert meter coordinates to pixel coordinates
        pixel_x = origin_x + (overlay['x'] * pixels_per_meter)
        pixel_y = origin_y + (overlay['y'] * pixels_per_meter)

        # Convert pixel coordinates to PDF points
        pdf_x = pixel_x * scale
        pdf_y = pixel_y * scale

        # Parse color
        color = parse_color(overlay.get('color', '#FF0000'))
        size = overlay.get('size', 10) * scale
        shape = overlay.get('icon_shape', 'circle')

        # Draw the shape
        if shape == 'circle':
            page.draw_circle(
                fitz.Point(pdf_x, pdf_y),
                size / 2,
                color=color,
                fill=color,
                width=1
            )
        elif shape == 'square':
            rect = fitz.Rect(
                pdf_x - size/2, pdf_y - size/2,
                pdf_x + size/2, pdf_y + size/2
            )
            page.draw_rect(rect, color=color, fill=color)
        elif shape == 'triangle':
            points = [
                fitz.Point(pdf_x, pdf_y - size/2),
                fitz.Point(pdf_x - size/2, pdf_y + size/2),
                fitz.Point(pdf_x + size/2, pdf_y + size/2)
            ]
            page.draw_polyline(points, color=color, fill=color, closePath=True)
        elif shape == 'diamond':
            points = [
                fitz.Point(pdf_x, pdf_y - size/2),
                fitz.Point(pdf_x + size/2, pdf_y),
                fitz.Point(pdf_x, pdf_y + size/2),
                fitz.Point(pdf_x - size/2, pdf_y)
            ]
            page.draw_polyline(points, color=color, fill=color, closePath=True)
        elif shape == 'star':
            # Simple 5-pointed star
            draw_star(page, pdf_x, pdf_y, size/2, color)

        # Add label if provided
        label = overlay.get('label')
        if label:
            page.insert_text(
                fitz.Point(pdf_x + size/2 + 2, pdf_y + 4),
                label,
                fontsize=8,
                color=(0, 0, 0)
            )

    doc.save(output_path)
    doc.close()

    logger.info("Rendered %d overlay(s) on %s page %d -> %s",
                len(overlays), os.path.basename(pdf_path), page_number, output_path)

    return output_path


def draw_star(page, cx, cy, radius, color):
    """Draw a 5-pointed star."""
    import math
    points = []
    for i in range(10):
        angle = math.pi / 2 + i * math.pi / 5
        r = radius if i % 2 == 0 else radius / 2
        x = cx + r * math.cos(angle)
        y = cy - r * math.sin(angle)
        points.append(fitz.Point(x, y))

    page.draw_polyline(points, color=color, fill=color, closePath=True)


def parse_color(hex_color):
    """Convert hex color to RGB tuple (0-1 range). Returns red on invalid input."""
    try:
        hex_color = str(hex_color).lstrip('#')
        if len(hex_color) < 6:
            return (1.0, 0.0, 0.0)
        return tuple(int(hex_color[i:i+2], 16) / 255 for i in (0, 2, 4))
    except (ValueError, TypeError):
        return (1.0, 0.0, 0.0)
