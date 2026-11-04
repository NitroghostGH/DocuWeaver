"""Project files (.docuweaver): building the archive data and importing it.

A project file is a ZIP holding either `project.db` (an SQLite database with
the project as JSON plus every file as a blob; what the app exports) or
`project.json` with the files in `pdfs/`, `rendered/` and `icons/` folders.
Both carry the same JSON, built by `collect_project`.

Records refer to each other by the id they had in the exporting database
(`layer_group_id`, `parent_group_id`, `import_batch_id`, `linked_mark_id`).
Files exported before 1.1.0 only had names (`layer_group_name`,
`parent_group_name`); those are still written, so older versions can read new
files, and still read, with the closest match by name and folder type.

An imported file is untrusted: numbers must be finite, embedded files must be
the type their folder says (a PDF, a PNG), the unpacked size is capped, and
asset types that already exist (they are shared by every project) are not
changed.
"""
import json
import logging
import math
import os

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.serializers.json import DjangoJSONEncoder
from django.db import models, transaction
from django.utils.dateparse import parse_datetime

from ..models import (
    AdjustmentLog,
    Asset,
    AssetType,
    ImportBatch,
    JoinMark,
    LayerGroup,
    Link,
    MeasurementSet,
    Project,
    Sheet,
    parent_creates_cycle,
)

logger = logging.getLogger(__name__)

# Marks exports whose sheet offsets are where the editor draws the sheets.
# Older exports (before 1.1.0) left sheets at (0, 0) and the editor spread
# them out on the fly; see migration 0014_save_sheet_cascade_offsets.
SHEET_OFFSETS_SAVED = 'saved'

# Folder names inside a project.json archive, by file type.
FILE_DIRS = {'pdf': 'pdfs', 'rendered': 'rendered', 'icon': 'icons'}


class ArchiveError(ValueError):
    """The project file can't be imported; the message says why."""


def max_import_bytes():
    return int(getattr(settings, 'DOCUWEAVER_MAX_IMPORT_MB', 2048)) * 1024 * 1024


# ---------------------------------------------------------------------------
# Field helpers
# ---------------------------------------------------------------------------

def _plain_fields(model):
    """Fields copied as-is: not the id, a relation, a file or a timestamp."""
    return [
        f for f in model._meta.concrete_fields
        if not (f.primary_key or f.is_relation or isinstance(f, models.FileField)
                or getattr(f, 'auto_now', False) or getattr(f, 'auto_now_add', False))
    ]


def _dump(obj):
    return {f.name: f.value_from_object(obj) for f in _plain_fields(type(obj))}


def _finite(value, what):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ArchiveError(f'{what} must be a number, got {value!r}')
    if not math.isfinite(number):
        raise ArchiveError(f'{what} must be a finite number, got {value!r}')
    return number


def _load(model, data, what):
    """Constructor kwargs for `model` from an archive record (unknown keys are ignored)."""
    if not isinstance(data, dict):
        raise ArchiveError(f'{what} must be an object')
    values = {}
    for f in _plain_fields(model):
        if f.name not in data:
            continue
        value = data[f.name]
        if isinstance(f, models.FloatField) and value is not None:
            value = _finite(value, f'{what}.{f.name}')
        values[f.name] = value
    return values


def _reject_constant(name):
    raise ArchiveError(f'Project data contains {name}, which is not a number DocuWeaver can store')


def _parse_float(text):
    number = float(text)
    if not math.isfinite(number):
        _reject_constant(text)
    return number


def parse_project_json(text):
    """json.loads that refuses NaN, Infinity and overflowing numbers."""
    try:
        data = json.loads(text, parse_constant=_reject_constant, parse_float=_parse_float)
    except json.JSONDecodeError as e:
        raise ArchiveError(f'Invalid project data: {e}')
    if not isinstance(data, dict) or not isinstance(data.get('project'), dict):
        raise ArchiveError('Invalid project data: no project')
    return data


def dumps(data):
    return json.dumps(data, cls=DjangoJSONEncoder, allow_nan=False)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

class _FileNames:
    """Archive names for stored files: the file's own name, unique per type."""

    def __init__(self):
        self.by_path = {}   # (file_type, storage name) -> archive name
        self.files = {}     # (file_type, archive name) -> filesystem path

    def add(self, file_type, field_file):
        if not field_file:
            return None
        key = (file_type, field_file.name)
        if key not in self.by_path:
            base = os.path.basename(field_file.name)
            name, n = base, 1
            while (file_type, name) in self.files:
                stem, ext = os.path.splitext(base)
                name, n = f'{stem}_{n}{ext}', n + 1
            self.by_path[key] = name
            self.files[(file_type, name)] = field_file.path
        return self.by_path[key]


def collect_project(project, version):
    """The archive JSON for `project`, and the files it refers to.

    Returns (data, files) where files maps (file_type, archive name) to the
    file's path on disk.
    """
    names = _FileNames()

    groups = list(project.layer_groups.select_related('parent_group'))
    group_names = {g.id: g.name for g in groups}

    sheets = []
    for sheet in project.sheets.prefetch_related('join_marks'):
        sheets.append({
            **_dump(sheet),
            'id': sheet.id,
            'layer_group_id': sheet.layer_group_id,
            'layer_group_name': group_names.get(sheet.layer_group_id),
            'pdf_file': names.add('pdf', sheet.pdf_file),
            'rendered_image': names.add('rendered', sheet.rendered_image),
            'join_marks': [
                {**_dump(jm), 'id': jm.id, 'linked_mark_id': jm.linked_mark_id}
                for jm in sheet.join_marks.all()
            ],
        })

    asset_types = []
    for at in AssetType.objects.filter(assets__project=project).distinct():
        asset_types.append({**_dump(at), 'custom_icon': names.add('icon', at.custom_icon)})

    logs_by_asset = {}
    for log in AdjustmentLog.objects.filter(asset__project=project).order_by('timestamp', 'id'):
        logs_by_asset.setdefault(log.asset_id, []).append({**_dump(log), 'timestamp': log.timestamp.isoformat()})

    assets = [
        {
            **_dump(a),
            'asset_type_name': a.asset_type.name,
            'import_batch_id': a.import_batch_id,
            'layer_group_id': a.layer_group_id,
            'layer_group_name': group_names.get(a.layer_group_id),
            'adjustment_logs': logs_by_asset.get(a.id, []),
        }
        for a in project.assets.select_related('asset_type')
    ]

    links = [
        {
            **_dump(link),
            'import_batch_id': link.import_batch_id,
            'layer_group_id': link.layer_group_id,
            'layer_group_name': group_names.get(link.layer_group_id),
        }
        for link in project.links.all()
    ]

    data = {
        'version': version,
        'sheet_offsets': SHEET_OFFSETS_SAVED,
        'project': _dump(project),
        'sheets': sheets,
        'asset_types': asset_types,
        'import_batches': [
            {**_dump(b), 'id': b.id, 'created_at': b.created_at.isoformat()}
            for b in project.import_batches.all()
        ],
        'assets': assets,
        'links': links,
        'layer_groups': [
            {
                **_dump(g),
                'id': g.id,
                'parent_group_id': g.parent_group_id,
                'parent_group_name': g.parent_group.name if g.parent_group else None,
                'import_batch_id': g.import_batch_id,
            }
            for g in groups
        ],
        'measurement_sets': [
            {
                **_dump(ms),
                'layer_group_id': ms.layer_group_id,
                'layer_group_name': group_names.get(ms.layer_group_id),
            }
            for ms in project.measurement_sets.all()
        ],
    }
    return data, names.files


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

# What an embedded file must start with, and the extension it's stored under.
_IMAGE_TYPES = (
    (b'\x89PNG\r\n\x1a\n', '.png'),
    (b'\xff\xd8\xff', '.jpg'),
    (b'GIF87a', '.gif'),
    (b'GIF89a', '.gif'),
)


def _stored_name(file_type, archive_name, content):
    """A safe file name for embedded `content`, or ArchiveError if it isn't
    the kind of file its folder holds. The extension always matches the
    content, so nothing is ever served back as HTML or SVG."""
    stem = os.path.splitext(os.path.basename(str(archive_name)))[0] or file_type
    if file_type == 'pdf':
        if b'%PDF-' not in content[:1024]:
            raise ArchiveError(f'{archive_name} in the project file is not a PDF')
        return stem + '.pdf'
    allowed = _IMAGE_TYPES[:1] if file_type == 'rendered' else _IMAGE_TYPES
    if file_type == 'icon' and content[:4] == b'RIFF' and content[8:12] == b'WEBP':
        return stem + '.webp'
    for magic, ext in allowed:
        if content.startswith(magic):
            return stem + ext
    raise ArchiveError(f'{archive_name} in the project file is not a '
                       f'{"PNG" if file_type == "rendered" else "PNG, JPEG, GIF or WebP"} image')


class _Importer:
    def __init__(self, data, get_file):
        self.data = data
        self.get_file = get_file
        self.saved = {}          # (file_type, archive name) -> storage name
        self.new_files = []      # storage names written by this import

    def file(self, file_type, archive_name, field_file):
        """Store an embedded file once, however many records use it, and
        point `field_file` at it. A file missing from the archive is skipped."""
        if not archive_name:
            return
        key = (file_type, archive_name)
        if key not in self.saved:
            content = self.get_file(file_type, archive_name)
            if content is None:
                logger.warning('Import: %s file %s is missing from the archive', file_type, archive_name)
                self.saved[key] = None
                return
            name = _stored_name(file_type, archive_name, content)
            field_file.save(name, ContentFile(content), save=False)
            self.new_files.append(field_file.name)
            self.saved[key] = field_file.name
        elif self.saved[key]:
            # Same file as an earlier record (the pages of one PDF): share it.
            setattr(field_file.instance, field_file.field.attname, self.saved[key])

    def records(self, key):
        value = self.data.get(key) or []
        if not isinstance(value, list):
            raise ArchiveError(f'{key} must be a list')
        return value

    def run(self):
        try:
            with transaction.atomic():
                return self._create()
        except Exception:
            # The database rolls back; remove the files it would have used.
            for name in self.new_files:
                try:
                    default_storage.delete(name)
                except OSError:
                    logger.warning('Import: could not remove %s after a failed import', name)
            raise

    # -- the import itself -------------------------------------------------

    def _create(self):
        project_data = _load(Project, self.data['project'], 'project')
        base_name = str(project_data.get('name') or 'Imported project')
        name, counter = base_name, 1
        while Project.objects.filter(name=name).exists():
            name = f'{base_name} ({counter})'
            counter += 1
        project_data['name'] = name
        project = Project.objects.create(**project_data)

        asset_types = self._asset_types()
        batches = self._batches(project)
        groups = self._groups(project, batches)
        self._sheets(project, groups)
        if self.data.get('sheet_offsets') != SHEET_OFFSETS_SAVED:
            apply_legacy_sheet_cascade(project)
        self._assets(project, asset_types, batches, groups)
        self._links(project, batches, groups)
        for i, ms_data in enumerate(self.records('measurement_sets')):
            MeasurementSet.objects.create(
                project=project, layer_group=groups.find(ms_data, 'measurement'),
                **_load(MeasurementSet, ms_data, f'measurement_sets[{i}]'))

        logger.info("Project '%s' (ID: %d) imported", project.name, project.id)
        return project

    def _asset_types(self):
        """Asset types are shared by every project: an existing one is used
        as it is, and only a type this file creates gets the file's icon."""
        types = {}
        for i, at_data in enumerate(self.records('asset_types')):
            values = _load(AssetType, at_data, f'asset_types[{i}]')
            type_name = values.pop('name', None)
            if not type_name:
                raise ArchiveError(f'asset_types[{i}] has no name')
            at, created = AssetType.objects.get_or_create(name=type_name, defaults=values)
            if created and at_data.get('custom_icon'):
                self.file('icon', at_data['custom_icon'], at.custom_icon)
                if at.custom_icon:
                    at.save()
            types[type_name] = at
        return types

    def _batches(self, project):
        batches = {}
        for i, b_data in enumerate(self.records('import_batches')):
            batch = ImportBatch.objects.create(project=project, **_load(ImportBatch, b_data, f'import_batches[{i}]'))
            created_at = parse_datetime(str(b_data.get('created_at') or ''))
            if created_at:
                ImportBatch.objects.filter(pk=batch.pk).update(created_at=created_at)
            if 'id' in b_data:
                batches[b_data['id']] = batch
        return batches

    def _groups(self, project, batches):
        groups = _GroupMap()
        records = self.records('layer_groups')
        claimed = set()
        for i, g_data in enumerate(records):
            values = _load(LayerGroup, g_data, f'layer_groups[{i}]')
            # A batch has one folder; a second claim (a hand-edited file) is dropped.
            batch = batches.get(g_data.get('import_batch_id'))
            if batch is not None and batch.pk in claimed:
                batch = None
            if batch is not None:
                claimed.add(batch.pk)
            group = LayerGroup.objects.create(project=project, import_batch=batch, **values)
            groups.add(g_data.get('id'), group)

        for g_data, group in zip(records, groups.created, strict=True):
            if g_data.get('parent_group_id') is not None:
                parent = groups.by_id.get(g_data['parent_group_id'])
            elif g_data.get('parent_group_name'):
                parent = groups.by_name(g_data['parent_group_name'], group.group_type, exclude=group)
            else:
                parent = None
            if parent is not None and parent is not group and not parent_creates_cycle(group, parent):
                group.parent_group = parent
                group.save(update_fields=['parent_group'])
        return groups

    def _sheets(self, project, groups):
        marks = {}         # archived join mark id -> JoinMark
        mark_links = []    # (JoinMark, archived linked_mark_id)
        for i, s_data in enumerate(self.records('sheets')):
            sheet = Sheet(project=project, layer_group=groups.find(s_data, 'sheet'),
                          **_load(Sheet, s_data, f'sheets[{i}]'))
            self.file('pdf', s_data.get('pdf_file'), sheet.pdf_file)
            self.file('rendered', s_data.get('rendered_image'), sheet.rendered_image)
            sheet.save()
            for j, jm_data in enumerate(s_data.get('join_marks') or []):
                mark = JoinMark.objects.create(sheet=sheet, **_load(JoinMark, jm_data, f'sheets[{i}].join_marks[{j}]'))
                if jm_data.get('id') is not None:
                    marks[jm_data['id']] = mark
                if jm_data.get('linked_mark_id') is not None:
                    mark_links.append((mark, jm_data['linked_mark_id']))
        for mark, linked_id in mark_links:
            if linked_id in marks:
                mark.linked_mark = marks[linked_id]
                mark.save(update_fields=['linked_mark'])

    def _assets(self, project, asset_types, batches, groups):
        for i, a_data in enumerate(self.records('assets')):
            type_name = a_data.get('asset_type_name') if isinstance(a_data, dict) else None
            if not type_name:
                raise ArchiveError(f'assets[{i}] has no asset_type_name')
            asset_type = asset_types.get(type_name)
            if asset_type is None:
                asset_type, _ = AssetType.objects.get_or_create(name=type_name)
                asset_types[type_name] = asset_type
            asset = Asset.objects.create(
                project=project, asset_type=asset_type,
                import_batch=batches.get(a_data.get('import_batch_id')),
                layer_group=groups.find(a_data, 'asset'),
                **_load(Asset, a_data, f'assets[{i}]'))
            for j, log_data in enumerate(a_data.get('adjustment_logs') or []):
                log = AdjustmentLog.objects.create(
                    asset=asset, **_load(AdjustmentLog, log_data, f'assets[{i}].adjustment_logs[{j}]'))
                timestamp = parse_datetime(str(log_data.get('timestamp') or ''))
                if timestamp:
                    AdjustmentLog.objects.filter(pk=log.pk).update(timestamp=timestamp)

    def _links(self, project, batches, groups):
        for i, l_data in enumerate(self.records('links')):
            values = _load(Link, l_data, f'links[{i}]')
            coordinates = values.get('coordinates')
            if not isinstance(coordinates, list) or not all(
                    isinstance(p, list) and len(p) >= 2 and all(isinstance(c, (int, float)) for c in p[:2])
                    for p in coordinates):
                raise ArchiveError(f'links[{i}].coordinates must be a list of [x, y] pairs')
            Link.objects.create(
                project=project,
                import_batch=batches.get(l_data.get('import_batch_id')),
                layer_group=groups.find(l_data, 'link'),
                **values)


class _GroupMap:
    """Imported folders, found by archived id, or by name for old files."""

    def __init__(self):
        self.created = []
        self.by_id = {}

    def add(self, archived_id, group):
        self.created.append(group)
        if archived_id is not None:
            self.by_id[archived_id] = group

    def by_name(self, name, group_type, exclude=None):
        """Closest match for an old file's folder name: a folder of the item's
        own type first, then a global one, then any (old files can have
        several folders with the same name)."""
        candidates = [g for g in self.created if g.name == name and g is not exclude]
        for preferred in (lambda g: g.group_type == group_type,
                          lambda g: g.scope == 'global',
                          lambda g: True):
            for g in candidates:
                if preferred(g):
                    return g
        return None

    def find(self, record, item_type):
        if not isinstance(record, dict):
            return None
        if record.get('layer_group_id') is not None:
            return self.by_id.get(record['layer_group_id'])
        if record.get('layer_group_name'):
            return self.by_name(record['layer_group_name'], item_type)
        return None


def apply_legacy_sheet_cascade(project, step=50):
    """Give sheets from an old export the position the old editor showed."""
    for index, sheet in enumerate(project.sheets.order_by('z_index', 'name')):
        if index > 0 and sheet.offset_x == 0 and sheet.offset_y == 0:
            sheet.offset_x = sheet.offset_y = index * step
            sheet.save(update_fields=['offset_x', 'offset_y'])


def create_project_from_data(data, get_file):
    """Create a project from archive JSON.

    Args:
        data: the archive JSON (see collect_project)
        get_file: function(file_type, archive name) -> bytes, or None if missing

    Returns the new Project. Raises ArchiveError for a file that can't be
    imported; nothing is left behind when that happens.
    """
    if not isinstance(data, dict) or not isinstance(data.get('project'), dict):
        raise ArchiveError('Invalid project data: no project')
    return _Importer(data, get_file).run()
