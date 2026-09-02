"""Page views for drawings app."""
import json
import logging
import os
import sqlite3
import zipfile
from io import BytesIO

from django.core.files.base import ContentFile
from django.db import transaction
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_POST

from .auth import login_required_if_enabled
from .models import Asset, AssetType, ImportBatch, JoinMark, LayerGroup, Link, MeasurementSet, Project, Sheet

# Configure logger
logger = logging.getLogger(__name__)


@login_required_if_enabled
def project_list(request):
    """List all projects."""
    projects = Project.objects.all()
    return render(request, 'drawings/project_list.html', {'projects': projects})


@login_required_if_enabled
def project_detail(request, pk):
    """View project details."""
    project = get_object_or_404(Project, pk=pk)
    return render(request, 'drawings/project_detail.html', {'project': project})


@login_required_if_enabled
def editor(request, pk):
    """Main canvas editor for a project."""
    project = get_object_or_404(Project, pk=pk)
    asset_types = AssetType.objects.all()
    return render(request, 'drawings/editor.html', {
        'project': project,
        'asset_types': asset_types,
    })


@login_required_if_enabled
def export_project(request, pk):
    """Export a project as a ZIP file containing JSON data and media files."""
    project = get_object_or_404(Project, pk=pk)

    # Create in-memory ZIP file
    zip_buffer = BytesIO()

    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        # Export project data
        project_data = {
            'name': project.name,
            'description': project.description,
            'pixels_per_meter': project.pixels_per_meter,
            'scale_calibrated': project.scale_calibrated,
            'coord_unit': project.coord_unit,
            'origin_x': project.origin_x,
            'origin_y': project.origin_y,
            'canvas_rotation': project.canvas_rotation,
            'asset_rotation': project.asset_rotation,
            'ref_asset_id': project.ref_asset_id,
            'ref_pixel_x': project.ref_pixel_x,
            'ref_pixel_y': project.ref_pixel_y,
            'cadastre_color': project.cadastre_color,
            'cadastre_enabled': project.cadastre_enabled,
            'osm_enabled': project.osm_enabled,
            'osm_opacity': project.osm_opacity,
            'osm_z_index': project.osm_z_index,
        }

        # Export sheets
        sheets_data = []
        pdf_files = {}  # Track unique PDF files
        rendered_files = {}  # Track rendered images

        for sheet in project.sheets.all():
            sheet_data = {
                'name': sheet.name,
                'page_number': sheet.page_number,
                'cuts_json': sheet.cuts_json,
                'offset_x': sheet.offset_x,
                'offset_y': sheet.offset_y,
                'rotation': sheet.rotation,
                'z_index': sheet.z_index,
                'image_width': sheet.image_width,
                'image_height': sheet.image_height,
                'layer_group_name': sheet.layer_group.name if sheet.layer_group else None,
                'crop_flipped': sheet.crop_flipped,
            }

            # Track PDF file
            if sheet.pdf_file:
                pdf_name = os.path.basename(sheet.pdf_file.name)
                sheet_data['pdf_file'] = pdf_name
                if pdf_name not in pdf_files:
                    pdf_files[pdf_name] = sheet.pdf_file.path

            # Track rendered image
            if sheet.rendered_image:
                rendered_name = os.path.basename(sheet.rendered_image.name)
                sheet_data['rendered_image'] = rendered_name
                if rendered_name not in rendered_files:
                    rendered_files[rendered_name] = sheet.rendered_image.path

            # Export join marks
            sheet_data['join_marks'] = [
                {'x': jm.x, 'y': jm.y, 'reference_label': jm.reference_label}
                for jm in sheet.join_marks.all()
            ]

            sheets_data.append(sheet_data)

        # Export asset types
        asset_types_data = []
        icon_files = {}

        for at in AssetType.objects.filter(assets__project=project).distinct():
            at_data = {
                'name': at.name,
                'icon_shape': at.icon_shape,
                'color': at.color,
                'size': at.size,
            }
            if at.custom_icon:
                icon_name = os.path.basename(at.custom_icon.name)
                at_data['custom_icon'] = icon_name
                if icon_name not in icon_files:
                    icon_files[icon_name] = at.custom_icon.path
            asset_types_data.append(at_data)

        # Export import batches
        batches_data = []
        for batch in project.import_batches.all():
            batches_data.append({
                'id': batch.id,
                'filename': batch.filename,
                'asset_count': batch.asset_count,
            })

        # Export assets
        assets_data = []
        for asset in project.assets.all():
            assets_data.append({
                'asset_id': asset.asset_id,
                'asset_type_name': asset.asset_type.name,
                'import_batch_id': asset.import_batch_id,
                'layer_group_name': asset.layer_group.name if asset.layer_group else None,
                'name': asset.name,
                'original_x': asset.original_x,
                'original_y': asset.original_y,
                'adjusted_x': asset.adjusted_x,
                'adjusted_y': asset.adjusted_y,
                'is_adjusted': asset.is_adjusted,
                'metadata': asset.metadata,
            })

        # Export links
        links_data = []
        for link in project.links.all():
            links_data.append({
                'link_id': link.link_id,
                'import_batch_id': link.import_batch_id,
                'layer_group_name': link.layer_group.name if link.layer_group else None,
                'name': link.name,
                'coordinates': link.coordinates,
                'color': link.color,
                'width': link.width,
                'opacity': link.opacity,
                'link_type': link.link_type,
                'metadata': link.metadata,
            })

        # Export layer groups
        groups_data = []
        for group in project.layer_groups.all():
            groups_data.append({
                'name': group.name,
                'group_type': group.group_type,
                'color': group.color,
                'visible': group.visible,
                'parent_group_name': group.parent_group.name if group.parent_group else None,
            })

        # Export measurement sets
        measurements_data = []
        for ms in project.measurement_sets.all():
            measurements_data.append({
                'name': ms.name,
                'measurement_type': ms.measurement_type,
                'points': ms.points,
                'color': ms.color,
                'visible': ms.visible,
                'total_distance_pixels': ms.total_distance_pixels,
                'total_distance_meters': ms.total_distance_meters,
            })

        # Combine all data
        export_data = {
            'version': '1.0',
            'project': project_data,
            'sheets': sheets_data,
            'asset_types': asset_types_data,
            'import_batches': batches_data,
            'assets': assets_data,
            'links': links_data,
            'layer_groups': groups_data,
            'measurement_sets': measurements_data,
        }

        # Write JSON data
        zf.writestr('project.json', json.dumps(export_data, indent=2))

        # Add PDF files
        for name, path in pdf_files.items():
            if os.path.exists(path):
                zf.write(path, f'pdfs/{name}')
                logger.info(f"Export: Added PDF {name} ({os.path.getsize(path)} bytes)")
            else:
                logger.warning(f"Export: PDF file missing: {path}")

        # Add rendered images
        for name, path in rendered_files.items():
            if os.path.exists(path):
                zf.write(path, f'rendered/{name}')
                logger.info(f"Export: Added rendered image {name}")
            else:
                logger.warning(f"Export: Rendered image missing: {path}")

        # Add custom icons
        for name, path in icon_files.items():
            if os.path.exists(path):
                zf.write(path, f'icons/{name}')
            else:
                logger.warning(f"Export: Icon missing: {path}")

    # Prepare response
    zip_buffer.seek(0)
    response = HttpResponse(zip_buffer.read(), content_type='application/zip')
    response['Content-Disposition'] = f'attachment; filename="{project.name}.docuweaver"'
    return response


@login_required_if_enabled
def export_project_with_sqlite(request, pk):
    """
    Export a project with all binary files embedded in a SQLite database.
    This creates a more portable single-file archive.
    """
    project = get_object_or_404(Project, pk=pk)

    # sqlite3 needs a real file path, so build the export database in a temp file
    import tempfile
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
        tmp_path = tmp.name

    try:
        conn = sqlite3.connect(tmp_path)
        cursor = conn.cursor()

        # Create tables for storing binary files and metadata
        cursor.execute('''
            CREATE TABLE metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        ''')

        cursor.execute('''
            CREATE TABLE files (
                id INTEGER PRIMARY KEY,
                file_type TEXT,
                filename TEXT,
                data BLOB,
                size INTEGER
            )
        ''')

        cursor.execute('''
            CREATE TABLE project_data (
                id INTEGER PRIMARY KEY,
                json_data TEXT
            )
        ''')

        # Build project data (same as existing export)
        project_data = {
            'name': project.name,
            'description': project.description,
            'pixels_per_meter': project.pixels_per_meter,
            'scale_calibrated': project.scale_calibrated,
            'coord_unit': project.coord_unit,
            'origin_x': project.origin_x,
            'origin_y': project.origin_y,
            'canvas_rotation': project.canvas_rotation,
            'asset_rotation': project.asset_rotation,
            'ref_asset_id': project.ref_asset_id,
            'ref_pixel_x': project.ref_pixel_x,
            'ref_pixel_y': project.ref_pixel_y,
            'cadastre_color': project.cadastre_color,
            'cadastre_enabled': project.cadastre_enabled,
            'osm_enabled': project.osm_enabled,
            'osm_opacity': project.osm_opacity,
            'osm_z_index': project.osm_z_index,
        }

        sheets_data = []
        added_pdfs = set()  # Track which PDFs we've already added
        added_rendered = set()  # Track which rendered images we've already added

        for sheet in project.sheets.all():
            sheet_data = {
                'name': sheet.name,
                'page_number': sheet.page_number,
                'cuts_json': sheet.cuts_json,
                'offset_x': sheet.offset_x,
                'offset_y': sheet.offset_y,
                'rotation': sheet.rotation,
                'z_index': sheet.z_index,
                'image_width': sheet.image_width,
                'image_height': sheet.image_height,
                'layer_group_name': sheet.layer_group.name if sheet.layer_group else None,
                'crop_flipped': sheet.crop_flipped,
                'join_marks': [
                    {'x': jm.x, 'y': jm.y, 'reference_label': jm.reference_label}
                    for jm in sheet.join_marks.all()
                ]
            }

            # Store PDF file reference and add to files table (only once per unique file)
            if sheet.pdf_file:
                pdf_name = os.path.basename(sheet.pdf_file.name)
                sheet_data['pdf_file'] = pdf_name
                if pdf_name not in added_pdfs and os.path.exists(sheet.pdf_file.path):
                    with open(sheet.pdf_file.path, 'rb') as f:
                        pdf_data = f.read()
                    cursor.execute(
                        'INSERT INTO files (file_type, filename, data, size) VALUES (?, ?, ?, ?)',
                        ('pdf', pdf_name, pdf_data, len(pdf_data))
                    )
                    added_pdfs.add(pdf_name)
                    logger.info(f"SQLite Export: Added PDF {pdf_name} ({len(pdf_data)} bytes)")

            # Store rendered image (only once per unique file)
            if sheet.rendered_image:
                rendered_name = os.path.basename(sheet.rendered_image.name)
                sheet_data['rendered_image'] = rendered_name
                if rendered_name not in added_rendered and os.path.exists(sheet.rendered_image.path):
                    with open(sheet.rendered_image.path, 'rb') as f:
                        img_data = f.read()
                    cursor.execute(
                        'INSERT INTO files (file_type, filename, data, size) VALUES (?, ?, ?, ?)',
                        ('rendered', rendered_name, img_data, len(img_data))
                    )
                    added_rendered.add(rendered_name)

            sheets_data.append(sheet_data)

        # Asset types with custom icons
        asset_types_data = []
        added_icons = set()  # Track which icons we've already added
        for at in AssetType.objects.filter(assets__project=project).distinct():
            at_data = {
                'name': at.name,
                'icon_shape': at.icon_shape,
                'color': at.color,
                'size': at.size,
            }
            if at.custom_icon:
                icon_name = os.path.basename(at.custom_icon.name)
                at_data['custom_icon'] = icon_name
                if icon_name not in added_icons and os.path.exists(at.custom_icon.path):
                    with open(at.custom_icon.path, 'rb') as f:
                        icon_data = f.read()
                    cursor.execute(
                        'INSERT INTO files (file_type, filename, data, size) VALUES (?, ?, ?, ?)',
                        ('icon', icon_name, icon_data, len(icon_data))
                    )
                    added_icons.add(icon_name)
            asset_types_data.append(at_data)

        # Import batches
        batches_data = [
            {'id': b.id, 'filename': b.filename, 'asset_count': b.asset_count}
            for b in project.import_batches.all()
        ]

        # Assets
        assets_data = [
            {
                'asset_id': a.asset_id,
                'asset_type_name': a.asset_type.name,
                'import_batch_id': a.import_batch_id,
                'layer_group_name': a.layer_group.name if a.layer_group else None,
                'name': a.name,
                'original_x': a.original_x,
                'original_y': a.original_y,
                'adjusted_x': a.adjusted_x,
                'adjusted_y': a.adjusted_y,
                'is_adjusted': a.is_adjusted,
                'metadata': a.metadata,
            }
            for a in project.assets.all()
        ]
        logger.info(f"SQLite Export: Collected {len(assets_data)} assets for export")

        # Links
        links_data = [
            {
                'link_id': link.link_id,
                'import_batch_id': link.import_batch_id,
                'layer_group_name': link.layer_group.name if link.layer_group else None,
                'name': link.name,
                'coordinates': link.coordinates,
                'color': link.color,
                'width': link.width,
                'opacity': link.opacity,
                'link_type': link.link_type,
                'metadata': link.metadata,
            }
            for link in project.links.all()
        ]
        logger.info(f"SQLite Export: Collected {len(links_data)} links for export")

        # Layer groups
        groups_data = [
            {
                'name': g.name,
                'group_type': g.group_type,
                'color': g.color,
                'visible': g.visible,
                'parent_group_name': g.parent_group.name if g.parent_group else None,
            }
            for g in project.layer_groups.all()
        ]

        # Measurement sets
        measurements_data = [
            {
                'name': ms.name,
                'measurement_type': ms.measurement_type,
                'points': ms.points,
                'color': ms.color,
                'visible': ms.visible,
                'total_distance_pixels': ms.total_distance_pixels,
                'total_distance_meters': ms.total_distance_meters,
            }
            for ms in project.measurement_sets.all()
        ]

        # Store all project data as JSON
        export_data = {
            'version': '2.0',  # New version for SQLite format
            'format': 'sqlite',
            'project': project_data,
            'sheets': sheets_data,
            'asset_types': asset_types_data,
            'import_batches': batches_data,
            'assets': assets_data,
            'links': links_data,
            'layer_groups': groups_data,
            'measurement_sets': measurements_data,
        }

        logger.info(f"SQLite Export: Exporting {len(assets_data)} assets, {len(links_data)} links, {len(groups_data)} layer groups, {len(measurements_data)} measurements")

        cursor.execute(
            'INSERT INTO project_data (json_data) VALUES (?)',
            (json.dumps(export_data),)
        )

        # Store metadata
        cursor.execute('INSERT INTO metadata (key, value) VALUES (?, ?)', ('version', '2.0'))
        cursor.execute('INSERT INTO metadata (key, value) VALUES (?, ?)', ('project_name', project.name))

        conn.commit()
        conn.close()

        # Read the SQLite file
        with open(tmp_path, 'rb') as f:
            db_data = f.read()

        # Create ZIP with just the SQLite database
        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('project.db', db_data)

        zip_buffer.seek(0)
        response = HttpResponse(zip_buffer.read(), content_type='application/zip')
        response['Content-Disposition'] = f'attachment; filename="{project.name}.docuweaver"'

        logger.info(f"SQLite Export complete: {project.name} ({len(db_data)} bytes)")
        return response

    finally:
        # Clean up temp file
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@login_required_if_enabled
@require_POST
def import_project(request):
    """Import a project from an uploaded ZIP file (supports both JSON and SQLite formats)."""
    logger.info("="*80)
    logger.info("Starting project import")

    if 'file' not in request.FILES:
        logger.error("No file uploaded in request")
        return JsonResponse({'error': 'No file uploaded'}, status=400)

    uploaded_file = request.FILES['file']
    logger.info(f"Uploaded file: {uploaded_file.name} ({uploaded_file.size} bytes)")

    if not uploaded_file.name.endswith('.docuweaver'):
        logger.error(f"Invalid file type: {uploaded_file.name}")
        return JsonResponse({'error': 'Invalid file type. Please upload a .docuweaver file'}, status=400)

    try:
        with zipfile.ZipFile(uploaded_file, 'r') as zf:
            logger.info(f"ZIP file opened successfully. Contents: {zf.namelist()}")

            # Detect format - SQLite (project.db) or JSON (project.json)
            if 'project.db' in zf.namelist():
                logger.info("Detected SQLite format (v2.0)")
                return _import_project_sqlite(zf)
            elif 'project.json' in zf.namelist():
                logger.info("Detected JSON format (v1.0)")
                return _import_project_json(zf)
            else:
                logger.error("No project.json or project.db found in ZIP")
                return JsonResponse({'error': 'Invalid project file: missing project data'}, status=400)

    except zipfile.BadZipFile as e:
        logger.error(f"Invalid ZIP file: {e}")
        return JsonResponse({'error': 'Invalid ZIP file'}, status=400)
    except Exception as e:
        logger.error(f"Import failed with exception: {e}")
        logger.exception("Full traceback:")
        return JsonResponse({'error': f'Import failed: {str(e)}'}, status=500)


def _import_project_sqlite(zf):
    """Import from SQLite format (v2.0)."""
    import tempfile

    # Extract SQLite database to temp file
    db_data = zf.read('project.db')
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
        tmp.write(db_data)
        tmp_path = tmp.name

    try:
        conn = sqlite3.connect(tmp_path)
        cursor = conn.cursor()

        # Read project data
        cursor.execute('SELECT json_data FROM project_data LIMIT 1')
        row = cursor.fetchone()
        if not row:
            return JsonResponse({'error': 'No project data in database'}, status=400)

        data = json.loads(row[0])
        logger.info(f"Parsed project data. Version: {data.get('version', 'unknown')}")

        # Create a file getter function for SQLite
        def get_file_from_db(file_type, filename):
            cursor.execute(
                'SELECT data FROM files WHERE file_type = ? AND filename = ?',
                (file_type, filename)
            )
            row = cursor.fetchone()
            return row[0] if row else None

        # Use common import logic
        result = _create_project_from_data(data, get_file_from_db)

        conn.close()
        return result

    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _import_project_json(zf):
    """Import from JSON format (v1.0)."""
    try:
        project_json = zf.read('project.json')
        data = json.loads(project_json)
        logger.info(f"Parsed project.json. Version: {data.get('version', 'unknown')}")
    except KeyError as e:
        logger.error(f"Missing project.json: {e}")
        return JsonResponse({'error': 'Invalid project file: missing project.json'}, status=400)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse project.json: {e}")
        return JsonResponse({'error': f'Invalid JSON: {e}'}, status=400)

    # Create a file getter function for ZIP
    def get_file_from_zip(file_type, filename):
        path_map = {'pdf': 'pdfs', 'rendered': 'rendered', 'icon': 'icons'}
        try:
            return zf.read(f"{path_map.get(file_type, file_type)}/{filename}")
        except KeyError:
            return None

    return _create_project_from_data(data, get_file_from_zip)


def _create_project_from_data(data, get_file_func):
    """Common project creation logic for both import formats.

    Args:
        data: Dict containing project data
        get_file_func: Function(file_type, filename) -> bytes or None
    """
    with transaction.atomic():
        # Create project
        project_data = data['project']
        logger.info(f"Creating project: {project_data.get('name', 'Unknown')}")

        # Check for duplicate name and modify if needed
        base_name = project_data['name']
        name = base_name
        counter = 1
        while Project.objects.filter(name=name).exists():
            name = f"{base_name} ({counter})"
            counter += 1

        if name != base_name:
            logger.info(f"Project name changed to avoid duplicate: {base_name} -> {name}")

        project = Project.objects.create(
            name=name,
            description=project_data.get('description', ''),
            pixels_per_meter=project_data.get('pixels_per_meter', 100.0),
            scale_calibrated=project_data.get('scale_calibrated', False),
            coord_unit=project_data.get('coord_unit', 'meters'),
            origin_x=project_data.get('origin_x', 0.0),
            origin_y=project_data.get('origin_y', 0.0),
            canvas_rotation=project_data.get('canvas_rotation', 0.0),
            asset_rotation=project_data.get('asset_rotation', 0.0),
            ref_asset_id=project_data.get('ref_asset_id', ''),
            ref_pixel_x=project_data.get('ref_pixel_x', 0.0),
            ref_pixel_y=project_data.get('ref_pixel_y', 0.0),
            cadastre_color=project_data.get('cadastre_color', '#FF6600'),
            cadastre_enabled=project_data.get('cadastre_enabled', False),
            osm_enabled=project_data.get('osm_enabled', False),
            osm_opacity=project_data.get('osm_opacity', 0.7),
            osm_z_index=project_data.get('osm_z_index', 0),
        )

        # Create or get asset types
        asset_type_map = {}
        for at_data in data.get('asset_types', []):
            at, created = AssetType.objects.get_or_create(
                name=at_data['name'],
                defaults={
                    'icon_shape': at_data.get('icon_shape', 'circle'),
                    'color': at_data.get('color', '#FF0000'),
                    'size': at_data.get('size', 20),
                }
            )
            # Handle custom icon
            if at_data.get('custom_icon'):
                icon_data = get_file_func('icon', at_data['custom_icon'])
                if icon_data:
                    at.custom_icon.save(at_data['custom_icon'], ContentFile(icon_data), save=True)
            asset_type_map[at_data['name']] = at

        # Create layer groups (first pass - without parent references)
        group_map = {}
        for g_data in data.get('layer_groups', []):
            group = LayerGroup.objects.create(
                project=project,
                name=g_data['name'],
                group_type=g_data['group_type'],
                color=g_data.get('color', '#3498db'),
                visible=g_data.get('visible', True),
            )
            group_map[g_data['name']] = group

        # Set parent groups (second pass)
        for g_data in data.get('layer_groups', []):
            if g_data.get('parent_group_name'):
                group = group_map.get(g_data['name'])
                parent = group_map.get(g_data['parent_group_name'])
                if group and parent:
                    group.parent_group = parent
                    group.save()

        # Create import batches
        batch_map = {}
        logger.info(f"Creating {len(data.get('import_batches', []))} import batches")
        for b_data in data.get('import_batches', []):
            batch = ImportBatch.objects.create(
                project=project,
                filename=b_data['filename'],
                asset_count=b_data.get('asset_count', 0),
            )
            batch_map[b_data['id']] = batch

        # Create sheets
        sheets_data = data.get('sheets', [])
        logger.info(f"Creating {len(sheets_data)} sheets")
        for idx, s_data in enumerate(sheets_data):
            logger.debug(f"Creating sheet {idx+1}/{len(sheets_data)}: {s_data.get('name', 'Unknown')}")

            sheet = Sheet(
                project=project,
                name=s_data['name'],
                page_number=s_data.get('page_number', 1),
                cuts_json=s_data.get('cuts_json', []),
                crop_flipped=s_data.get('crop_flipped', False),
                offset_x=s_data.get('offset_x', 0.0),
                offset_y=s_data.get('offset_y', 0.0),
                rotation=s_data.get('rotation', 0.0),
                z_index=s_data.get('z_index', 0),
                image_width=s_data.get('image_width', 0),
                image_height=s_data.get('image_height', 0),
            )

            # Set layer group
            if s_data.get('layer_group_name'):
                sheet.layer_group = group_map.get(s_data['layer_group_name'])

            # Handle PDF file
            if s_data.get('pdf_file'):
                pdf_data = get_file_func('pdf', s_data['pdf_file'])
                if pdf_data:
                    sheet.pdf_file.save(s_data['pdf_file'], ContentFile(pdf_data), save=False)
                    logger.info(f"Imported PDF: {s_data['pdf_file']} ({len(pdf_data)} bytes)")

            # Handle rendered image
            if s_data.get('rendered_image'):
                img_data = get_file_func('rendered', s_data['rendered_image'])
                if img_data:
                    sheet.rendered_image.save(s_data['rendered_image'], ContentFile(img_data), save=False)

            sheet.save()

            # Create join marks
            for jm_data in s_data.get('join_marks', []):
                JoinMark.objects.create(
                    sheet=sheet,
                    x=jm_data['x'],
                    y=jm_data['y'],
                    reference_label=jm_data['reference_label'],
                )

        # Create assets
        assets_data = data.get('assets', [])
        logger.info(f"Creating {len(assets_data)} assets")
        for a_data in assets_data:
            asset_type = asset_type_map.get(a_data['asset_type_name'])
            if not asset_type:
                asset_type, _ = AssetType.objects.get_or_create(name=a_data['asset_type_name'])

            Asset.objects.create(
                project=project,
                asset_type=asset_type,
                import_batch=batch_map.get(a_data.get('import_batch_id')),
                layer_group=group_map.get(a_data.get('layer_group_name')),
                asset_id=a_data['asset_id'],
                name=a_data.get('name', ''),
                original_x=a_data['original_x'],
                original_y=a_data['original_y'],
                adjusted_x=a_data.get('adjusted_x'),
                adjusted_y=a_data.get('adjusted_y'),
                is_adjusted=a_data.get('is_adjusted', False),
                metadata=a_data.get('metadata', {}),
            )

        # Create links
        links_data = data.get('links', [])
        logger.info(f"Creating {len(links_data)} links")
        for l_data in links_data:
            Link.objects.create(
                project=project,
                import_batch=batch_map.get(l_data.get('import_batch_id')),
                layer_group=group_map.get(l_data.get('layer_group_name')),
                link_id=l_data['link_id'],
                name=l_data.get('name', ''),
                coordinates=l_data['coordinates'],
                color=l_data.get('color', '#0066FF'),
                width=l_data.get('width', 2),
                opacity=l_data.get('opacity', 1.0),
                link_type=l_data.get('link_type', 'other'),
                metadata=l_data.get('metadata', {}),
            )

        # Create measurement sets
        ms_data_list = data.get('measurement_sets', [])
        logger.info(f"Creating {len(ms_data_list)} measurement sets")
        for ms_data in ms_data_list:
            MeasurementSet.objects.create(
                project=project,
                name=ms_data['name'],
                measurement_type=ms_data.get('measurement_type', 'single'),
                points=ms_data.get('points', []),
                color=ms_data.get('color', '#00bcd4'),
                visible=ms_data.get('visible', True),
                total_distance_pixels=ms_data.get('total_distance_pixels'),
                total_distance_meters=ms_data.get('total_distance_meters'),
            )

        logger.info(f"Project '{project.name}' (ID: {project.id}) imported successfully")
        logger.info("="*80)

        return JsonResponse({
            'status': 'success',
            'project_id': project.id,
            'project_name': project.name,
        })
