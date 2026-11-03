"""PDF processing service for rendering and manipulating PDFs."""
import logging
import math
import os
import uuid

import pymupdf as fitz
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from PIL import Image

logger = logging.getLogger(__name__)

# Sheets are rendered at this resolution; the export maps overlay positions
# back to PDF points with it.
RENDER_DPI = 150

# Largest page we render, in pixels at RENDER_DPI. Rendering needs about
# 7 bytes per pixel (115 MB for an A1 page, 17 Mpx), so this caps a single
# render near 700 MB. 100 Mpx is about 2.9 m² of paper: an A0 sheet is 1 m².
MAX_RENDER_PIXELS = 100_000_000

RENDERED_DIR = 'rendered/'


class PdfError(ValueError):
    """A PDF we can't use. The message is written for the person uploading it."""


def open_pdf(source):
    """Open a PDF from a path or an uploaded file.

    Raises PdfError for a file that isn't a readable PDF, is
    password-protected, or has no pages.
    """
    try:
        if isinstance(source, (str, os.PathLike)):
            doc = fitz.open(source)
        elif hasattr(source, 'temporary_file_path'):
            doc = fitz.open(source.temporary_file_path())
        else:
            source.seek(0)
            data = source.read()
            source.seek(0)
            doc = fitz.open(stream=data, filetype='pdf')
    except (fitz.FileDataError, RuntimeError) as e:
        logger.info("Could not open PDF: %s", e)
        raise PdfError("This file can't be read as a PDF. It may be damaged; "
                       "try saving or exporting it again.") from e
    if doc.needs_pass:
        doc.close()
        raise PdfError("This PDF is password-protected. Save a copy without the password and upload that.")
    if len(doc) == 0:
        doc.close()
        raise PdfError("This PDF has no pages.")
    return doc


def document_layers(doc):
    """The document's optional content groups (layers): [{xref, name}, ...]."""
    return [{'xref': xref, 'name': info.get('name', f'Layer {xref}')}
            for xref, info in doc.get_ocgs().items()]


def _with_layers(doc, pdf_layers, visible_layers):
    """Return ``doc`` showing only ``visible_layers`` (an empty list shows
    every layer). If that needs a new document, ``doc`` is closed once the
    new one is open; on an error ``doc`` is left open for the caller."""
    if not (visible_layers and pdf_layers):
        return doc
    visible = set(visible_layers)
    xrefs = [layer['xref'] for layer in pdf_layers]
    doc.set_layer(-1, on=[x for x in xrefs if x in visible],
                  off=[x for x in xrefs if x not in visible])
    # MuPDF reads the layer configuration when a document is opened, so the
    # change only affects rendering after a reopen.
    layered = fitz.open(stream=doc.tobytes(), filetype='pdf')
    doc.close()
    return layered


def _page_png(doc, page_number, dpi):
    """Render page ``page_number`` (1-based) of ``doc``: (png_bytes, width, height)."""
    if not 1 <= page_number <= len(doc):
        raise PdfError(f"Page {page_number} does not exist in this PDF (it has {len(doc)} pages).")
    page = doc[page_number - 1]
    zoom = dpi / 72  # 72 is the default PDF resolution
    rect = page.rect
    if math.ceil(rect.width * zoom) * math.ceil(rect.height * zoom) > MAX_RENDER_PIXELS:
        mm = 25.4 / 72
        raise PdfError(
            f"Page {page_number} is {rect.width * mm:.0f} × {rect.height * mm:.0f} mm, "
            f"too large to render. Pages up to about "
            f"{MAX_RENDER_PIXELS / (dpi / 25.4) ** 2 / 1e6:.1f} m² can be used (A0 is 1 m²).")
    try:
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        # MuPDF's own PNG encoder: less memory and time than going through
        # Pillow, and a smaller file.
        return pix.tobytes('png'), pix.width, pix.height
    except RuntimeError as e:
        logger.info("Could not render page %d: %s", page_number, e)
        raise PdfError(f"Page {page_number} of this PDF couldn't be drawn. "
                       f"The file may be damaged; try saving or exporting it again.") from e


def render_pdf_page(sheet, dpi=RENDER_DPI):
    """
    Render a PDF page to an image and save it to the sheet.

    Layer visibility follows ``sheet.visible_layers``: an empty list shows
    every layer; otherwise exactly the listed OCG xrefs are shown, so a list
    that matches no layer (the editor sends ``[0]``) hides them all.

    Raises PdfError if the page can't be rendered.
    """
    doc = open_pdf(sheet.pdf_file.path)
    try:
        if not sheet.pdf_layers:
            sheet.pdf_layers = document_layers(doc)
        doc = _with_layers(doc, sheet.pdf_layers, sheet.visible_layers)
        png, width, height = _page_png(doc, sheet.page_number, dpi)
    finally:
        doc.close()

    previous = sheet.rendered_image.name
    filename = f"sheet_{sheet.id}_page_{sheet.page_number}.png"
    # Storage gives the new image a fresh name, so the browser can't show a
    # cached copy of the old one.
    sheet.rendered_image.save(filename, ContentFile(png), save=False)
    sheet.image_width = width
    sheet.image_height = height
    try:
        # Only the render's own fields: a full save would overwrite position or
        # rotation changes made by another request while the page rendered.
        sheet.save(update_fields=['rendered_image', 'image_width', 'image_height', 'pdf_layers'])
    except BaseException:
        delete_files([sheet.rendered_image.name])
        raise
    if previous and previous != sheet.rendered_image.name:
        _delete_when_unused(previous)

    logger.info("Rendered sheet %d page %d at %d DPI (%dx%d px)",
                sheet.id, sheet.page_number, dpi, width, height)

    return {
        'width': width,
        'height': height,
        'path': sheet.rendered_image.path
    }


def render_upload(upload, visible_layers=(), dpi=RENDER_DPI):
    """Render every page of an uploaded PDF before any sheet is created.

    Each page's PNG is saved to storage as soon as it's drawn, so only one
    page is held in memory. Returns ``(pdf_layers, pages)``, where pages is
    a list of ``{'page_number', 'rendered_image', 'image_width',
    'image_height'}``. On any failure the PNGs already saved are deleted and
    the error is raised (PdfError for a problem with the file).
    """
    saved = []
    doc = open_pdf(upload)
    try:
        pdf_layers = document_layers(doc)
        page_count = len(doc)
        doc = _with_layers(doc, pdf_layers, list(visible_layers))
        batch = uuid.uuid4().hex[:8]
        pages = []
        for page_number in range(1, page_count + 1):
            png, width, height = _page_png(doc, page_number, dpi)
            name = default_storage.save(f'{RENDERED_DIR}upload_{batch}_page_{page_number}.png', ContentFile(png))
            saved.append(name)
            pages.append({'page_number': page_number, 'rendered_image': name,
                          'image_width': width, 'image_height': height})
    except BaseException:
        delete_files(saved)
        raise
    finally:
        doc.close()
    logger.info("Rendered %d page(s) of %s at %d DPI", len(pages), getattr(upload, 'name', upload), dpi)
    return pdf_layers, pages


def _delete_when_unused(name):
    """Delete a replaced rendered image once the change is committed (a
    rolled-back render still points at it), unless a sheet still uses it."""
    from django.db import transaction

    from ..models import Sheet

    def remove():
        if not Sheet.objects.filter(rendered_image=name).exists():
            delete_files([name])

    transaction.on_commit(remove)


def delete_files(names):
    """Delete stored files, ignoring ones already gone."""
    for name in names:
        if name:
            try:
                default_storage.delete(name)
            except OSError:
                logger.warning("Could not delete %s", name)


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


def parse_color(hex_color):
    """Convert hex color to RGB tuple (0-1 range). Returns red on invalid input."""
    try:
        hex_color = str(hex_color).lstrip('#')
        if len(hex_color) < 6:
            return (1.0, 0.0, 0.0)
        return tuple(int(hex_color[i:i+2], 16) / 255 for i in (0, 2, 4))
    except (ValueError, TypeError):
        return (1.0, 0.0, 0.0)
