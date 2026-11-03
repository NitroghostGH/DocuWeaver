"""Page views for drawings app."""
import logging
import os
import shutil
import sqlite3
import tempfile
import zipfile
from io import BytesIO

from django.core.exceptions import SuspiciousOperation
from django.db import IntegrityError
from django.db.models import Count
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.http import require_POST

from .auth import login_required_if_enabled
from .models import AssetType, Project
from .services import project_archive
from .services.export_service import attachment, download_name

# Configure logger
logger = logging.getLogger(__name__)


@login_required_if_enabled
def project_list(request):
    """List all projects."""
    # Counted in the one query: the template used to ask each project for
    # its sheet and asset counts, two queries per project.
    projects = Project.objects.annotate(num_sheets=Count('sheets', distinct=True),
                                        num_assets=Count('assets', distinct=True))
    return render(request, 'drawings/project_list.html', {'projects': projects})


@login_required_if_enabled
def project_detail(request, pk):
    """View project details."""
    project = get_object_or_404(Project, pk=pk)
    return render(request, 'drawings/project_detail.html', {
        'project': project,
        'sheets': list(project.sheets.all()),
        'asset_count': project.assets.count(),
        'adjusted_count': project.assets.filter(is_adjusted=True).count(),
    })


@login_required_if_enabled
def editor(request, pk):
    """Main canvas editor for a project."""
    project = get_object_or_404(Project, pk=pk)
    asset_types = AssetType.objects.all()
    return render(request, 'drawings/editor.html', {
        'project': project,
        'asset_types': asset_types,
    })


def _download(content, project):
    response = HttpResponse(content, content_type='application/zip')
    return attachment(response, download_name(project.name, 'docuweaver'))


@login_required_if_enabled
def export_project(request, pk):
    """Export a project as a ZIP of project.json plus pdfs/, rendered/ and icons/."""
    project = get_object_or_404(Project, pk=pk)
    data, files = project_archive.collect_project(project, version='1.1')

    zip_buffer = BytesIO()
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('project.json', project_archive.dumps(data))
        for (file_type, name), path in files.items():
            if os.path.exists(path):
                zf.write(path, f'{project_archive.FILE_DIRS[file_type]}/{name}')
            else:
                logger.warning("Export: %s file missing: %s", file_type, path)
    return _download(zip_buffer.getvalue(), project)


@login_required_if_enabled
def export_project_with_sqlite(request, pk):
    """Export a project as a ZIP holding one SQLite database (project.db) with
    the project data and every file embedded. This is what the Export buttons use."""
    project = get_object_or_404(Project, pk=pk)
    data, files = project_archive.collect_project(project, version='2.1')

    # sqlite3 needs a real file path, so build the export database in a temp file
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
        tmp_path = tmp.name
    try:
        conn = sqlite3.connect(tmp_path)
        try:
            cursor = conn.cursor()
            cursor.execute('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)')
            cursor.execute('CREATE TABLE files (id INTEGER PRIMARY KEY, file_type TEXT, filename TEXT, '
                           'data BLOB, size INTEGER)')
            cursor.execute('CREATE TABLE project_data (id INTEGER PRIMARY KEY, json_data TEXT)')
            for (file_type, name), path in files.items():
                if not os.path.exists(path):
                    logger.warning("SQLite export: %s file missing: %s", file_type, path)
                    continue
                with open(path, 'rb') as f:
                    blob = f.read()
                cursor.execute('INSERT INTO files (file_type, filename, data, size) VALUES (?, ?, ?, ?)',
                               (file_type, name, blob, len(blob)))
            cursor.execute('INSERT INTO project_data (json_data) VALUES (?)', (project_archive.dumps(data),))
            cursor.execute('INSERT INTO metadata (key, value) VALUES (?, ?)', ('version', data['version']))
            cursor.execute('INSERT INTO metadata (key, value) VALUES (?, ?)', ('project_name', project.name))
            conn.commit()
        finally:
            conn.close()

        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.write(tmp_path, 'project.db')
        logger.info("SQLite export complete: %s (%d files)", project.name, len(files))
        return _download(zip_buffer.getvalue(), project)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


@login_required_if_enabled
@require_POST
def import_project(request):
    """Import a project from an uploaded .docuweaver file (either format)."""
    if 'file' not in request.FILES:
        return JsonResponse({'error': 'No file uploaded'}, status=400)

    uploaded_file = request.FILES['file']
    logger.info("Importing project file %s (%d bytes)", uploaded_file.name, uploaded_file.size)
    if not uploaded_file.name.endswith('.docuweaver'):
        return JsonResponse({'error': 'Invalid file type. Please upload a .docuweaver file'}, status=400)

    try:
        with zipfile.ZipFile(uploaded_file, 'r') as zf:
            # A ZIP member never unpacks to more than its declared size, so
            # this bounds the disk and memory an import can use.
            unpacked = sum(info.file_size for info in zf.infolist())
            limit = project_archive.max_import_bytes()
            if unpacked > limit:
                return JsonResponse({'error': f'Project file unpacks to {unpacked // 2**20} MB, more than the '
                                              f'{limit // 2**20} MB limit (DOCUWEAVER_MAX_IMPORT_MB)'}, status=400)
            names = set(zf.namelist())
            if 'project.db' in names:
                project = _import_project_sqlite(zf)
            elif 'project.json' in names:
                project = _import_project_json(zf)
            else:
                return JsonResponse({'error': 'Invalid project file: missing project data'}, status=400)
    except zipfile.BadZipFile:
        return JsonResponse({'error': 'Invalid project file: not a ZIP archive'}, status=400)
    except (project_archive.ArchiveError, sqlite3.DatabaseError, IntegrityError, SuspiciousOperation,
            KeyError, TypeError, ValueError) as e:
        logger.warning("Project import rejected: %s", e)
        return JsonResponse({'error': f'Invalid project file: {e}'}, status=400)
    except Exception as e:
        logger.exception("Project import failed")
        return JsonResponse({'error': f'Import failed: {e}'}, status=500)

    return JsonResponse({
        'status': 'success',
        'project_id': project.id,
        'project_name': project.name,
    })


def _import_project_sqlite(zf):
    """Import from SQLite format (project.db)."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
        tmp_path = tmp.name
        with zf.open('project.db') as src:
            shutil.copyfileobj(src, tmp)
    try:
        conn = sqlite3.connect(tmp_path)
        try:
            cursor = conn.cursor()
            cursor.execute('SELECT json_data FROM project_data LIMIT 1')
            row = cursor.fetchone()
            if not row:
                raise project_archive.ArchiveError('no project data in project.db')
            data = project_archive.parse_project_json(row[0])

            def get_file_from_db(file_type, filename):
                cursor.execute('SELECT data FROM files WHERE file_type = ? AND filename = ?',
                               (file_type, filename))
                found = cursor.fetchone()
                return bytes(found[0]) if found else None

            return project_archive.create_project_from_data(data, get_file_from_db)
        finally:
            conn.close()
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def _import_project_json(zf):
    """Import from JSON format (project.json plus pdfs/, rendered/, icons/)."""
    data = project_archive.parse_project_json(zf.read('project.json'))

    def get_file_from_zip(file_type, filename):
        try:
            return zf.read(f"{project_archive.FILE_DIRS[file_type]}/{filename}")
        except KeyError:
            return None

    return project_archive.create_project_from_data(data, get_file_from_zip)
