"""Export service for generating PDFs with overlays and reports."""
import csv
import logging
import os
from io import StringIO

from django.conf import settings
from django.http import HttpResponse
from django.utils.text import slugify

from .pdf_processor import render_overlay_on_pdf

logger = logging.getLogger(__name__)


def sanitize_csv_value(value):
    """Sanitize a string value for CSV export to prevent formula injection."""
    if isinstance(value, str) and value and value[0] in ('=', '+', '-', '@', '\t', '\r'):
        return "'" + value
    return value


def sanitize_filename(name, max_length=100):
    """
    Sanitize a string for use as a filename.
    Prevents path traversal and removes unsafe characters.
    """
    # Use slugify to remove unsafe characters and normalize
    safe_name = slugify(name, allow_unicode=False)
    # Ensure it's not empty after sanitization
    if not safe_name:
        safe_name = 'unnamed'
    # Truncate to max length
    return safe_name[:max_length]


def export_sheet_with_overlays(sheet, assets):
    """
    Export a sheet's PDF with asset overlays.

    Args:
        sheet: Sheet model instance
        assets: QuerySet of assets to overlay

    Returns:
        Path to the exported PDF
    """
    project = sheet.project

    # Build overlay data from assets
    overlays = []
    for asset in assets:
        overlays.append({
            'x': asset.current_x,
            'y': asset.current_y,
            'icon_shape': asset.asset_type.icon_shape,
            'color': asset.asset_type.color,
            'size': asset.asset_type.size,
            'label': asset.asset_id,
        })

    # Create export directory
    export_dir = os.path.join(settings.MEDIA_ROOT, 'exports', f'project_{project.id}')
    os.makedirs(export_dir, exist_ok=True)

    # Security: Sanitize filename to prevent path traversal
    safe_name = sanitize_filename(sheet.name)
    output_filename = f"{safe_name}_annotated.pdf"
    output_path = os.path.join(export_dir, output_filename)

    # Render overlays on PDF
    render_overlay_on_pdf(
        pdf_path=sheet.pdf_file.path,
        output_path=output_path,
        page_number=sheet.page_number,
        overlays=overlays,
        pixels_per_meter=project.pixels_per_meter,
        origin_x=project.origin_x,
        origin_y=project.origin_y
    )

    # Return relative path from MEDIA_ROOT
    rel_path = os.path.relpath(output_path, settings.MEDIA_ROOT)
    logger.info("Exported sheet '%s' with %d overlays -> %s", sheet.name, len(overlays), rel_path)
    return rel_path


def generate_adjustment_report(project, adjusted_assets, logs, format_type='csv'):
    """
    Generate a report of all adjustments made to assets.

    Args:
        project: Project instance
        adjusted_assets: QuerySet of adjusted assets
        logs: QuerySet of adjustment logs
        format_type: 'csv' or 'json'

    Returns:
        HttpResponse with CSV data
    """
    if format_type == 'csv':
        output = StringIO()
        writer = csv.writer(output)

        # Header
        writer.writerow([
            'Asset ID', 'Asset Name', 'Asset Type',
            'Original X (m)', 'Original Y (m)',
            'Adjusted X (m)', 'Adjusted Y (m)',
            'Delta X (m)', 'Delta Y (m)', 'Delta Distance (m)',
            'Adjustment Count', 'Last Adjustment Notes'
        ])

        # Data rows
        for asset in adjusted_assets:
            delta_x = asset.adjusted_x - asset.original_x if asset.adjusted_x else 0
            delta_y = asset.adjusted_y - asset.original_y if asset.adjusted_y else 0
            last_log = asset.adjustment_logs.first()
            last_notes = last_log.notes if last_log else ''

            writer.writerow([
                sanitize_csv_value(asset.asset_id),
                sanitize_csv_value(asset.name),
                sanitize_csv_value(asset.asset_type.name),
                f"{asset.original_x:.3f}",
                f"{asset.original_y:.3f}",
                f"{asset.adjusted_x:.3f}" if asset.adjusted_x else '',
                f"{asset.adjusted_y:.3f}" if asset.adjusted_y else '',
                f"{delta_x:.3f}",
                f"{delta_y:.3f}",
                f"{asset.delta_distance:.3f}",
                asset.adjustment_logs.count(),
                sanitize_csv_value(last_notes)
            ])

        response = HttpResponse(output.getvalue(), content_type='text/csv')
        # Security: Sanitize filename to prevent header injection
        safe_name = sanitize_filename(project.name)
        response['Content-Disposition'] = f'attachment; filename="{safe_name}_adjustments.csv"'
        return response

    return None


def generate_full_project_export(project):
    """
    Generate a complete export package for a project.

    Includes:
    - All sheets with overlays
    - Adjustment report
    - Project metadata

    Returns:
        Path to export directory
    """
    export_dir = os.path.join(settings.MEDIA_ROOT, 'exports', f'project_{project.id}_full')
    os.makedirs(export_dir, exist_ok=True)

    assets = project.assets.all()
    exported_sheets = []

    # Export each sheet
    for sheet in project.sheets.all():
        output_path = export_sheet_with_overlays(sheet, assets)
        exported_sheets.append({
            'sheet': sheet.name,
            'path': output_path
        })

    # Generate adjustment report
    adjusted_assets = project.assets.filter(is_adjusted=True)
    if adjusted_assets.exists():
        from ..models import AdjustmentLog
        logs = AdjustmentLog.objects.filter(asset__project=project)
        report_response = generate_adjustment_report(project, adjusted_assets, logs, 'csv')

        # Security: Sanitize filename
        safe_project_name = sanitize_filename(project.name)
        report_path = os.path.join(export_dir, f"{safe_project_name}_adjustments.csv")
        with open(report_path, 'w') as f:
            f.write(report_response.content.decode('utf-8'))

    return export_dir
