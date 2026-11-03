"""API views for drawings app."""
import io
import json
import logging
import math
import os

from django.db import transaction
from django.http import FileResponse
from django.shortcuts import get_object_or_404
from rest_framework import generics, status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import (
    AdjustmentLog,
    Asset,
    AssetType,
    ColumnPreset,
    ImportBatch,
    LayerGroup,
    Link,
    MeasurementSet,
    Project,
    Sheet,
    parent_creates_cycle,
    save_fields,
)
from .serializers import (
    AdjustmentLogSerializer,
    AssetSerializer,
    CalibrateProjectSerializer,
    ImportBatchSerializer,
    LayerGroupSerializer,
    LayerGroupTree,
    LinkSerializer,
    MeasurementSetSerializer,
    ProjectListSerializer,
    ProjectSerializer,
    SheetSerializer,
)
from .services.csv_importer import import_assets_from_csv, import_links_from_csv
from .services.export_service import (
    ExportError,
    download_name,
    export_project_pdf,
    generate_adjustment_report,
    report_assets,
)
from .services.pdf_processor import PdfError, delete_files, render_pdf_page, render_upload

logger = logging.getLogger(__name__)


class ProjectListCreate(generics.ListCreateAPIView):
    def get_queryset(self):
        qs = Project.objects.all()
        if self.request.method == 'GET':
            return ProjectListSerializer.annotate_queryset(qs)
        return qs

    def get_serializer_class(self):
        if self.request.method == 'GET':
            return ProjectListSerializer
        return ProjectSerializer


class ProjectDetail(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = ProjectSerializer

    def get_queryset(self):
        qs = ProjectSerializer.annotate_queryset(Project.objects.all())
        if self.request.method == 'GET':
            qs = qs.prefetch_related('sheets__join_marks')
        return qs


CASCADE_STEP_PX = 50


def cascade_offset(index):
    """Starting position for a project's sheet number ``index`` (0-based)."""
    return {'offset_x': index * CASCADE_STEP_PX, 'offset_y': index * CASCADE_STEP_PX}


class SheetListCreate(generics.ListCreateAPIView):
    serializer_class = SheetSerializer

    def get_queryset(self):
        return Sheet.objects.filter(
            project_id=self.kwargs['project_pk']
        ).select_related('layer_group').prefetch_related('join_marks')

    def create(self, request, *args, **kwargs):
        """Create a sheet for each page of an uploaded PDF.

        A one-page PDF gets the given name; pages of a longer one are named
        name-01, name-02, ... Every page is rendered before any sheet is
        saved, so a PDF that can't be used (password-protected, damaged,
        a page too large) is refused with a 400 and leaves nothing behind.
        """
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        pdf_file = request.FILES.get('pdf_file')
        if not pdf_file:
            return Response({'error': 'No PDF file provided'}, status=status.HTTP_400_BAD_REQUEST)
        base_name = (request.data.get('name', '').strip()
                     or os.path.splitext(pdf_file.name)[0] or 'Sheet')

        # dict(), not copy(): copy() deep-copies the upload, and a file large
        # enough to be spooled to disk can't be copied (TypeError).
        data = request.data.dict() if hasattr(request.data, 'dict') else dict(request.data)
        data['name'] = base_name
        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)

        # Rendering takes about a second per A1 page, so it happens before the
        # transaction: SQLite allows one writer, and holding the lock that long
        # would stall every other user's saves.
        try:
            pdf_layers, pages = render_upload(pdf_file, serializer.validated_data.get('visible_layers') or [])
        except PdfError as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

        # New sheets are cascaded 50 px apart so they don't all stack at
        # (0, 0). The offset is saved, so the editor draws them where they are.
        placed = 'offset_x' in data or 'offset_y' in data
        width = len(str(len(pages)))
        saved_pdf = None
        try:
            # Stored once, by name, and shared by every page's sheet.
            field = Sheet._meta.get_field('pdf_file')
            saved_pdf = field.storage.save(field.generate_filename(None, pdf_file.name), pdf_file,
                                           max_length=field.max_length)
            with transaction.atomic():
                existing = project.sheets.count()
                created = []
                for page in pages:
                    n = page['page_number']
                    fields = {**page, 'pdf_file': saved_pdf, 'pdf_layers': pdf_layers}
                    if len(pages) > 1:
                        fields['name'] = f"{base_name}-{str(n).zfill(width)}"
                    if n == 1:
                        sheet = serializer.save(project=project,
                                                **({} if placed else cascade_offset(existing)), **fields)
                        position = {'offset_x': sheet.offset_x, 'offset_y': sheet.offset_y}
                    else:
                        sheet = Sheet.objects.create(
                            project=project, layer_group=created[0].layer_group,
                            visible_layers=created[0].visible_layers,
                            **(position if placed else cascade_offset(existing + n - 1)), **fields)
                    created.append(sheet)
        except BaseException:
            delete_files([p['rendered_image'] for p in pages] + [saved_pdf])
            raise

        return Response(self.get_serializer(created, many=True).data, status=status.HTTP_201_CREATED)


class SheetDetail(generics.RetrieveUpdateDestroyAPIView):
    queryset = Sheet.objects.all()
    serializer_class = SheetSerializer


@api_view(['POST'])
def render_sheet(request, pk):
    """Re-render a sheet's PDF to image."""
    sheet = get_object_or_404(Sheet, pk=pk)
    try:
        render_pdf_page(sheet)
        return Response({
            'status': 'success',
            'rendered_image': request.build_absolute_uri(sheet.rendered_image.url),
            'width': sheet.image_width,
            'height': sheet.image_height
        })
    except PdfError as e:
        return Response({'status': 'error', 'message': str(e)}, status=400)
    except Exception as e:
        logger.error("Failed to render sheet %d: %s", pk, e)
        return Response({'status': 'error', 'message': 'Failed to render sheet'}, status=500)


@api_view(['POST'])
def set_sheet_layers(request, pk):
    """Update visible layers for a sheet and re-render."""
    sheet = get_object_or_404(Sheet, pk=pk)

    visible_layers = request.data.get('visible_layers')
    if visible_layers is None:
        return Response({'error': 'visible_layers is required'}, status=400)

    if not isinstance(visible_layers, list) or not all(
        isinstance(x, int) and not isinstance(x, bool) for x in visible_layers
    ):
        return Response({'error': 'visible_layers must be a list of xref integers'}, status=400)

    # Keep the old value until the render succeeds, so a failed render
    # doesn't leave the sheet stuck with a layer setting it can't draw.
    previous = sheet.visible_layers
    sheet.visible_layers = visible_layers
    try:
        render_pdf_page(sheet)
    except PdfError as e:
        return Response({'status': 'error', 'message': str(e)}, status=400)
    except Exception as e:
        sheet.visible_layers = previous
        logger.error("Failed to re-render sheet %d with layers: %s", pk, e)
        return Response({'status': 'error', 'message': 'Failed to render sheet with layer changes'}, status=500)
    sheet.save(update_fields=['visible_layers'])
    serializer = SheetSerializer(sheet, context={'request': request})
    return Response(serializer.data)


class AssetListCreate(generics.ListCreateAPIView):
    serializer_class = AssetSerializer

    def get_queryset(self):
        return Asset.objects.filter(
            project_id=self.kwargs['project_pk']
        ).select_related('asset_type', 'import_batch', 'layer_group')

    def perform_create(self, serializer):
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        serializer.save(project=project)


class AssetDetail(generics.RetrieveUpdateDestroyAPIView):
    queryset = Asset.objects.all()
    serializer_class = AssetSerializer


@api_view(['POST'])
def adjust_asset(request, pk):
    """Adjust an asset's position and log the change."""
    asset = get_object_or_404(Asset, pk=pk)

    new_x = request.data.get('x')
    new_y = request.data.get('y')
    notes = request.data.get('notes', '')

    if new_x is None or new_y is None:
        return Response({'error': 'x and y coordinates required'}, status=400)

    try:
        new_x = _parse_finite_float(new_x, 'x')
        new_y = _parse_finite_float(new_y, 'y')
    except ValueError as e:
        return Response({'error': str(e)}, status=400)

    # Get the "from" coordinates
    from_x = asset.current_x
    from_y = asset.current_y

    # Create adjustment log
    AdjustmentLog.objects.create(
        asset=asset,
        from_x=from_x,
        from_y=from_y,
        to_x=new_x,
        to_y=new_y,
        notes=notes
    )

    # Update asset
    asset.adjusted_x = new_x
    asset.adjusted_y = new_y
    asset.is_adjusted = True
    save_fields(asset, ['adjusted_x', 'adjusted_y', 'is_adjusted'])

    serializer = AssetSerializer(asset)
    return Response(serializer.data)


@api_view(['POST'])
def import_csv(request, project_pk):
    """Import assets from CSV file with optional column mapping."""
    project = get_object_or_404(Project, pk=project_pk)

    if 'file' not in request.FILES:
        return Response({'error': 'No file provided'}, status=400)

    csv_file = request.FILES['file']

    # Parse column_mapping if provided (JSON string in form data)
    column_mapping = None
    mapping_raw = request.data.get('column_mapping')
    if mapping_raw:
        try:
            column_mapping = json.loads(mapping_raw) if isinstance(mapping_raw, str) else mapping_raw
        except (json.JSONDecodeError, TypeError):
            return Response({'error': 'Invalid column_mapping JSON'}, status=400)

    fixed_asset_type = request.data.get('fixed_asset_type') or None

    try:
        result = import_assets_from_csv(
            project, csv_file,
            column_mapping=column_mapping,
            filename=csv_file.name,
            fixed_asset_type=fixed_asset_type,
        )
        return Response(result)
    except ValueError as e:
        logger.error("CSV import failed for project %d: %s", project_pk, e)
        return Response({'error': str(e)}, status=400)
    except Exception as e:
        logger.error("CSV import failed for project %d: %s", project_pk, e)
        return Response({'error': 'CSV import failed'}, status=400)


@api_view(['GET'])
def export_project(request, project_pk):
    """Download the project's sheets with asset markers as one PDF.

    ``?sheets=3,5`` limits it to those sheets. Hidden sheets and assets are
    left out (see export_project_pdf).
    """
    project = get_object_or_404(Project, pk=project_pk)
    sheet_ids = None
    if request.query_params.get('sheets'):
        try:
            sheet_ids = {int(v) for v in request.query_params['sheets'].split(',') if v.strip()}
        except ValueError:
            return Response({'error': 'sheets must be a comma-separated list of sheet ids'}, status=400)
    try:
        pdf = export_project_pdf(project, sheet_ids)
    except ExportError as e:
        return Response({'error': str(e)}, status=400)
    logger.info("Exported project %d as PDF (%d bytes)", project_pk, len(pdf))
    return FileResponse(io.BytesIO(pdf), as_attachment=True, content_type='application/pdf',
                        filename=download_name(project.name, 'pdf'))


@api_view(['GET'])
def adjustment_report(request, project_pk):
    """Generate adjustment report for a project."""
    project = get_object_or_404(Project, pk=project_pk)
    # Not 'format': DRF reserves ?format= for renderer selection and 404s on
    # values it has no renderer for, so ?format=csv never reached this view.
    format_type = request.query_params.get('output', 'json')

    adjusted_assets = report_assets(project)
    if format_type == 'csv':
        return generate_adjustment_report(project, adjusted_assets)

    logs = AdjustmentLog.objects.filter(
        asset__project=project
    ).select_related('asset').order_by('-timestamp')
    report = {
        'project': project.name,
        'total_assets': project.assets.count(),
        'adjusted_count': adjusted_assets.count(),
        'adjustments': AdjustmentLogSerializer(logs, many=True).data,
        'summary': []
    }

    for asset in adjusted_assets:
        report['summary'].append({
            'asset_id': asset.asset_id,
            'name': asset.name,
            'original': {'x': asset.original_x, 'y': asset.original_y},
            'adjusted': {'x': asset.adjusted_x, 'y': asset.adjusted_y},
            'delta_distance': asset.delta_distance,
            'adjustment_count': asset.adjustment_count,
        })

    return Response(report)


@api_view(['GET'])
def column_presets(request):
    """Return column presets grouped by role for CSV import mapping."""
    presets = ColumnPreset.objects.all()
    grouped = {}
    for preset in presets:
        grouped.setdefault(preset.role, []).append(preset.column_name)
    return Response(grouped)


@api_view(['GET'])
def import_batch_list(request, project_pk):
    """List import batches for a project."""
    batches = ImportBatchSerializer.annotate_queryset(ImportBatch.objects.filter(project_id=project_pk))
    serializer = ImportBatchSerializer(batches, many=True)
    return Response(serializer.data)


@api_view(['DELETE', 'PATCH'])
def import_batch_delete(request, pk):
    """Delete an import batch, or PATCH to reassign asset type."""
    batch = get_object_or_404(ImportBatch, pk=pk)

    if request.method == 'PATCH':
        asset_type_name = (request.data.get('asset_type_name') or '').strip()
        if not asset_type_name:
            return Response({'error': 'asset_type_name is required'}, status=status.HTTP_400_BAD_REQUEST)
        asset_type, _created = AssetType.objects.get_or_create(name=asset_type_name)
        updated = batch.assets.all().update(asset_type=asset_type)
        logger.info("Reassigned %d assets in batch %d to type '%s'", updated, pk, asset_type_name)
        return Response({'updated': updated, 'asset_type': asset_type_name})
    project = batch.project
    with transaction.atomic():
        # Only what this batch created: assets and links that a later import
        # repeated still belong to their first batch (see csv_importer).
        asset_count, _ = batch.assets.all().delete()
        link_count, _ = batch.links.all().delete()
        folder = LayerGroup.objects.filter(import_batch=batch).first()
        batch.delete()
        # The folder the import created goes too, unless the user has put
        # something else in it.
        if folder and not (folder.assets.exists() or folder.links_in_group.exists()
                           or folder.sheets_in_group.exists() or folder.measurements_in_group.exists()
                           or folder.child_groups.exists()):
            folder.delete()
    logger.info("Deleted import batch %d (%d assets, %d links)", pk, asset_count, link_count)

    # Clear calibration if no assets remain
    if project.assets.count() == 0:
        project.ref_asset_id = ''
        project.ref_pixel_x = 0.0
        project.ref_pixel_y = 0.0
        project.asset_rotation = 0.0
        project.save(update_fields=['ref_asset_id', 'ref_pixel_x', 'ref_pixel_y', 'asset_rotation'])
        logger.info("Cleared asset calibration for project %d (no assets remain)", project.pk)

    return Response(status=status.HTTP_204_NO_CONTENT)


def _parse_finite_float(value, name):
    """Parse a value as a finite float, raising ValueError with a descriptive message."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"'{name}' must be a valid number, got: {value!r}")
    if not math.isfinite(result):
        raise ValueError(f"'{name}' must be a finite number, got: {result}")
    return result


@api_view(['POST'])
def calibrate_project(request, pk):
    """Set scale calibration for a project."""
    project = get_object_or_404(Project, pk=pk)

    serializer = CalibrateProjectSerializer(data=request.data)
    if not serializer.is_valid():
        return Response({'error': serializer.errors}, status=400)

    data = serializer.validated_data

    changed = []

    # Scale calibration
    if 'pixel_distance' in data and 'real_distance' in data:
        project.pixels_per_meter = data['pixel_distance'] / data['real_distance']
        project.scale_calibrated = True
        changed += ['pixels_per_meter', 'scale_calibrated']
        logger.info("Project %d calibrated: %.2f px/m (pixel_dist=%.2f, real_dist=%.2f)",
                     project.pk, project.pixels_per_meter, data['pixel_distance'], data['real_distance'])

    # Apply simple field updates
    simple_fields = (
        'origin_x', 'origin_y', 'canvas_rotation', 'asset_rotation',
        'ref_asset_id', 'ref_pixel_x', 'ref_pixel_y', 'coord_unit',
        'osm_enabled', 'osm_opacity', 'osm_z_index',
    )
    for field in simple_fields:
        if field in data:
            setattr(project, field, data[field])
            changed.append(field)

    save_fields(project, changed)

    return Response({
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
        'osm_enabled': project.osm_enabled,
        'osm_opacity': project.osm_opacity,
        'osm_z_index': project.osm_z_index,
    })


@api_view(['POST'])
def split_sheet(request, pk):
    """Split a sheet into two independent pieces along a line."""
    original = get_object_or_404(Sheet, pk=pk)

    p1 = request.data.get('p1')  # {x, y}
    p2 = request.data.get('p2')  # {x, y}

    if not p1 or not p2:
        return Response({'error': 'p1 and p2 coordinates required'}, status=400)

    # Validate p1 and p2 have numeric x,y keys
    try:
        p1_x = _parse_finite_float(p1.get('x'), 'p1.x')
        p1_y = _parse_finite_float(p1.get('y'), 'p1.y')
        p2_x = _parse_finite_float(p2.get('x'), 'p2.x')
        p2_y = _parse_finite_float(p2.get('y'), 'p2.y')
    except (ValueError, AttributeError) as e:
        return Response({'error': f'Invalid coordinates: {e}'}, status=400)

    cut_entry = {'p1': {'x': p1_x, 'y': p1_y}, 'p2': {'x': p2_x, 'y': p2_y}}

    new_sheet = None

    def discard_render():
        # The rows roll back, but the new piece's image is already on disk.
        if new_sheet is not None and new_sheet.rendered_image:
            delete_files([new_sheet.rendered_image.name])

    try:
        with transaction.atomic():
            # Both pieces keep the cuts the sheet already had: the new piece
            # is the other side of this cut, not the other side of the whole
            # uncut page. It also keeps the sheet's PDF layer choice and folder.
            earlier_cuts = list(original.cuts_json or [])
            new_sheet = Sheet.objects.create(
                project=original.project,
                name=f"{original.name}-split",
                pdf_file=original.pdf_file,
                page_number=original.page_number,
                offset_x=original.offset_x,
                offset_y=original.offset_y,
                rotation=original.rotation,
                z_index=original.z_index + 1,
                cuts_json=earlier_cuts + [{**cut_entry, 'flipped': True}],
                pdf_layers=original.pdf_layers,
                visible_layers=original.visible_layers,
                layer_group=original.layer_group,
            )

            # Render the new sheet's image
            render_pdf_page(new_sheet)

            original.cuts_json = earlier_cuts + [{**cut_entry, 'flipped': False}]
            save_fields(original, ['cuts_json'])

        logger.info("Sheet %d split into %d and %d", original.pk, original.pk, new_sheet.pk)
    except PdfError as e:
        discard_render()
        return Response({'error': str(e)}, status=400)
    except Exception as e:
        discard_render()
        logger.error("Failed to split sheet %d: %s", pk, e)
        return Response({'error': 'Split failed'}, status=500)

    return Response({
        'original_id': original.id,
        'new_sheet': SheetSerializer(new_sheet, context={'request': request}).data
    })


# ============================================================================
# Link Views
# ============================================================================

class LinkListCreate(generics.ListCreateAPIView):
    """List and create links for a project."""
    serializer_class = LinkSerializer

    def get_queryset(self):
        return Link.objects.filter(
            project_id=self.kwargs['project_pk']
        ).select_related('import_batch', 'layer_group')

    def perform_create(self, serializer):
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        serializer.save(project=project)


class LinkDetail(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update or delete a link."""
    queryset = Link.objects.all()
    serializer_class = LinkSerializer


@api_view(['POST'])
def import_links_csv(request, project_pk):
    """Import links from CSV file."""
    project = get_object_or_404(Project, pk=project_pk)

    # The editor sends 'file' (as the asset import does); 'csv_file' is the
    # older name, still accepted for scripts that use it.
    csv_file = request.FILES.get('file') or request.FILES.get('csv_file')
    if not csv_file:
        return Response({'error': 'No file provided'}, status=400)

    # Parse column mapping from form data
    column_mapping = {}
    if 'column_mapping' in request.data:
        try:
            column_mapping = json.loads(request.data['column_mapping'])
        except json.JSONDecodeError:
            return Response({'error': 'Invalid column_mapping JSON'}, status=400)

    try:
        results = import_links_from_csv(
            project, csv_file, column_mapping, filename=csv_file.name
        )
        return Response(results)
    except ValueError as e:
        return Response({'error': str(e)}, status=400)
    except Exception:
        logger.exception("Link CSV import failed")
        return Response({'error': 'Import failed'}, status=500)


# ============================================================================
# Layer Group Views
# ============================================================================

class LayerGroupListCreate(generics.ListCreateAPIView):
    """List and create layer groups for a project.

    GET returns the top-level folders (``?top_level=false``: every folder),
    optionally only one ``?type=``, each with its subfolders nested. The
    editor asks once, without a type, and sorts the folders by type itself.
    """
    serializer_class = LayerGroupSerializer

    def get_queryset(self):
        return LayerGroup.objects.filter(project_id=self.kwargs['project_pk'])

    def list(self, request, *args, **kwargs):
        # Counts and subfolders for the whole tree in a fixed number of
        # queries; serializing folder by folder took four per folder.
        tree = LayerGroupTree(self.kwargs['project_pk'])
        groups = tree.groups
        group_type = request.query_params.get('type')
        if group_type in dict(LayerGroup.GROUP_TYPE_CHOICES):
            groups = [g for g in groups if g.group_type == group_type]
        if request.query_params.get('top_level', 'true').lower() == 'true':
            groups = [g for g in groups if g.parent_group_id is None]
        context = {**self.get_serializer_context(), 'layer_tree': tree}
        return Response(LayerGroupSerializer(groups, many=True, context=context).data)

    def perform_create(self, serializer):
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        serializer.save(project=project)


class LayerGroupDetail(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update or delete a layer group."""
    queryset = LayerGroup.objects.all()
    serializer_class = LayerGroupSerializer


@api_view(['POST'])
def join_groups(request, project_pk):
    """Join one group to another (make child a sub-group of parent)."""
    parent_id = request.data.get('parent_id')
    child_id = request.data.get('child_id')

    if not parent_id or not child_id:
        return Response({'error': 'parent_id and child_id are required'}, status=400)

    parent = get_object_or_404(LayerGroup, pk=parent_id, project_id=project_pk)
    child = get_object_or_404(LayerGroup, pk=child_id, project_id=project_pk)

    if parent.group_type != child.group_type:
        return Response({'error': 'Cannot join groups of different types'}, status=400)

    if parent_id == child_id:
        return Response({'error': 'Cannot join a group to itself'}, status=400)

    if parent_creates_cycle(child, parent):
        return Response({'error': 'Cannot create circular group reference'}, status=400)

    child.parent_group = parent
    save_fields(child, ['parent_group'])

    logger.info("Group %d joined to parent %d", child.id, parent.id)
    return Response({
        'status': 'joined',
        'parent': LayerGroupSerializer(parent).data,
        'child': LayerGroupSerializer(child).data
    })


@api_view(['POST'])
def unjoin_group(request, pk):
    """Remove a group from its parent (make it top-level again)."""
    group = get_object_or_404(LayerGroup, pk=pk)

    if not group.parent_group:
        return Response({'error': 'Group is not joined to any parent'}, status=400)

    old_parent_id = group.parent_group.id
    group.parent_group = None
    save_fields(group, ['parent_group'])

    logger.info("Group %d unjoined from parent %d", group.id, old_parent_id)
    return Response({
        'status': 'unjoined',
        'group': LayerGroupSerializer(group).data
    })


@api_view(['PATCH'])
def toggle_group_visibility(request, pk):
    """Toggle or set visibility of a group."""
    group = get_object_or_404(LayerGroup, pk=pk)

    # If 'visible' is provided, use it; otherwise toggle
    if 'visible' in request.data:
        group.visible = bool(request.data.get('visible'))
    else:
        group.visible = not group.visible

    save_fields(group, ['visible'])

    return Response({
        'id': group.id,
        'visible': group.visible
    })


# Model lookup for layer group item operations
ITEM_TYPE_MODELS = {
    'asset': (Asset, 'asset'),
    'link': (Link, 'link'),
    'sheet': (Sheet, 'sheet'),
    'measurement': (MeasurementSet, 'measurement'),
}

VALID_ITEM_TYPES = '"asset", "link", "sheet", or "measurement"'


def _validate_item_type_for_group(group, item_type):
    """Check if item_type is compatible with a group's scope and type."""
    if group.scope == 'global':
        return True
    return group.group_type == item_type


def _update_items_for_types(types, filter_kwargs, update_kwargs):
    """Run an update across one or more item types. Returns total count."""
    count = 0
    for type_name in types:
        model, _ = ITEM_TYPE_MODELS[type_name]
        count += model.objects.filter(**filter_kwargs).update(**update_kwargs)
    return count


@api_view(['PATCH'])
def move_item_to_group(request, pk):
    """Move an asset, link, sheet, or measurement to a different group."""
    group = get_object_or_404(LayerGroup, pk=pk)
    item_type = request.data.get('item_type')
    item_id = request.data.get('item_id')

    if not item_type or not item_id:
        return Response({'error': 'item_type and item_id are required'}, status=400)

    if item_type not in ITEM_TYPE_MODELS:
        return Response({'error': f'item_type must be {VALID_ITEM_TYPES}'}, status=400)

    if not _validate_item_type_for_group(group, item_type):
        return Response({'error': f'Cannot move {item_type} to a non-{item_type} local group'}, status=400)

    model, _ = ITEM_TYPE_MODELS[item_type]
    item = get_object_or_404(model, pk=item_id, project=group.project)
    item.layer_group = group
    save_fields(item, ['layer_group'])
    return Response({'status': 'moved', 'item_type': item_type, 'item_id': item_id, 'group_id': pk})


@api_view(['POST'])
def assign_ungrouped_to_group(request, pk):
    """Assign all ungrouped items of a type to this group."""
    group = get_object_or_404(LayerGroup, pk=pk)
    item_type = request.data.get('item_type')

    if not item_type:
        return Response({'error': 'item_type is required'}, status=400)

    if item_type not in ITEM_TYPE_MODELS:
        return Response({'error': f'item_type must be {VALID_ITEM_TYPES}'}, status=400)

    if not _validate_item_type_for_group(group, item_type):
        return Response({'error': f'Cannot assign {item_type}s to a non-{item_type} local group'}, status=400)

    model, _ = ITEM_TYPE_MODELS[item_type]
    count = model.objects.filter(project=group.project, layer_group__isnull=True).update(layer_group=group)
    return Response({'status': 'assigned', 'count': count, 'item_type': item_type})


@api_view(['POST'])
def ungroup_all_items(request, pk):
    """Remove all items from a group (make them ungrouped)."""
    group = get_object_or_404(LayerGroup, pk=pk)

    if group.scope == 'global':
        types = list(ITEM_TYPE_MODELS.keys())
    else:
        types = [group.group_type]

    count = _update_items_for_types(types, {'layer_group': group}, {'layer_group': None})
    return Response({'status': 'ungrouped', 'count': count})


@api_view(['POST'])
def move_contents_to_folder(request, pk):
    """Move all items from one folder to another folder (or to ungrouped).

    If item_type is specified, only moves items of that type (respects the view context).
    If item_type is not specified AND source is a global folder, moves all types (Unified view).
    """
    source_group = get_object_or_404(LayerGroup, pk=pk)
    target_group_id = request.data.get('target_group')  # None means ungrouped
    item_type = request.data.get('item_type')

    # Get target group if specified
    target_group = None
    if target_group_id:
        target_group = get_object_or_404(LayerGroup, pk=target_group_id)
        if target_group.project_id != source_group.project_id:
            return Response({'error': 'Target folder must be in the same project'}, status=400)

    # Determine which types to move
    if item_type in ITEM_TYPE_MODELS:
        types = [item_type]
    elif item_type is None or item_type == 'all':
        types = list(ITEM_TYPE_MODELS.keys())
    else:
        return Response({'error': 'Invalid item_type'}, status=400)

    count = _update_items_for_types(types, {'layer_group': source_group}, {'layer_group': target_group})

    return Response({
        'status': 'moved',
        'moved_count': count,
        'source_group': source_group.id,
        'target_group': target_group.id if target_group else None
    })


# ============================================================================
# Measurement Set Views
# ============================================================================

class MeasurementSetListCreate(generics.ListCreateAPIView):
    """List and create measurement sets for a project."""
    serializer_class = MeasurementSetSerializer

    def get_queryset(self):
        return MeasurementSet.objects.filter(project_id=self.kwargs['project_pk'])

    def perform_create(self, serializer):
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        serializer.save(project=project)


class MeasurementSetDetail(generics.RetrieveUpdateDestroyAPIView):
    """Retrieve, update or delete a measurement set."""
    queryset = MeasurementSet.objects.all()
    serializer_class = MeasurementSetSerializer


@api_view(['PATCH'])
def toggle_measurement_visibility(request, pk):
    """Toggle or set visibility of a measurement set."""
    measurement = get_object_or_404(MeasurementSet, pk=pk)

    if 'visible' in request.data:
        measurement.visible = bool(request.data.get('visible'))
    else:
        measurement.visible = not measurement.visible

    save_fields(measurement, ['visible'])

    return Response({
        'id': measurement.id,
        'visible': measurement.visible
    })
