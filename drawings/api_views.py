"""API views for drawings app."""
import json
import logging
import math

from django.db import transaction
from django.db.models import Count
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
)
from .serializers import (
    AdjustmentLogSerializer,
    AssetSerializer,
    CalibrateProjectSerializer,
    ImportBatchSerializer,
    LayerGroupSerializer,
    LinkSerializer,
    MeasurementSetSerializer,
    ProjectListSerializer,
    ProjectSerializer,
    SheetSerializer,
)
from .services.csv_importer import import_assets_from_csv, import_links_from_csv
from .services.export_service import export_sheet_with_overlays, generate_adjustment_report
from .services.pdf_processor import get_pdf_page_count, render_pdf_page

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
        return ProjectSerializer.annotate_queryset(Project.objects.all())


class SheetListCreate(generics.ListCreateAPIView):
    serializer_class = SheetSerializer

    def get_queryset(self):
        return Sheet.objects.filter(
            project_id=self.kwargs['project_pk']
        ).select_related('layer_group').prefetch_related('join_marks')

    def create(self, request, *args, **kwargs):
        """
        Create sheet(s) from uploaded PDF.
        If the PDF has multiple pages, creates a sheet for each page with sequential naming.
        """
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        pdf_file = request.FILES.get('pdf_file')
        # Use provided name, or derive from PDF filename
        base_name = request.data.get('name', '').strip()
        if not base_name and pdf_file:
            import os
            base_name = os.path.splitext(pdf_file.name)[0]
        if not base_name:
            base_name = 'Sheet'

        if not pdf_file:
            return Response({'error': 'No PDF file provided'}, status=status.HTTP_400_BAD_REQUEST)

        # Save the file temporarily to get page count
        # First, create the initial sheet to save the file
        data = request.data.copy()
        data['name'] = base_name
        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        first_sheet = serializer.save(project=project, page_number=1)

        # Get the page count from the saved PDF
        try:
            page_count = get_pdf_page_count(first_sheet.pdf_file.path)
        except Exception:
            # If we can't read the PDF, just render the first page
            render_pdf_page(first_sheet)
            return Response(self.get_serializer(first_sheet).data, status=status.HTTP_201_CREATED)

        created_sheets = []

        if page_count == 1:
            # Single page PDF - just render and return
            render_pdf_page(first_sheet)
            created_sheets.append(first_sheet)
        else:
            # Multi-page PDF - update first sheet name and create additional sheets
            # Format: name-01, name-02, etc.
            width = len(str(page_count))  # Determine padding width

            # Update first sheet with sequential name
            first_sheet.name = f"{base_name}-{str(1).zfill(width)}"
            first_sheet.save()
            render_pdf_page(first_sheet)
            created_sheets.append(first_sheet)

            # Create sheets for remaining pages
            for page_num in range(2, page_count + 1):
                sheet_name = f"{base_name}-{str(page_num).zfill(width)}"
                sheet = Sheet.objects.create(
                    project=project,
                    name=sheet_name,
                    pdf_file=first_sheet.pdf_file,  # Reuse the same PDF file
                    page_number=page_num
                )
                render_pdf_page(sheet)
                created_sheets.append(sheet)

        # Return all created sheets
        response_serializer = self.get_serializer(created_sheets, many=True)
        return Response(response_serializer.data, status=status.HTTP_201_CREATED)

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

    if not isinstance(visible_layers, list):
        return Response({'error': 'visible_layers must be a list of xref integers'}, status=400)

    sheet.visible_layers = visible_layers
    sheet.save(update_fields=['visible_layers'])

    try:
        render_pdf_page(sheet)
        serializer = SheetSerializer(sheet, context={'request': request})
        return Response(serializer.data)
    except Exception as e:
        logger.error("Failed to re-render sheet %d with layers: %s", pk, e)
        return Response({'status': 'error', 'message': 'Failed to render sheet with layer changes'}, status=500)


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
    asset.save()

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


@api_view(['POST'])
def export_project(request, project_pk):
    """Export sheets with asset overlays as PDFs."""
    project = get_object_or_404(Project, pk=project_pk)
    sheet_ids = request.data.get('sheet_ids', [])

    if not sheet_ids:
        sheets = project.sheets.all()
    else:
        sheets = project.sheets.filter(id__in=sheet_ids)

    try:
        results = []
        for sheet in sheets:
            output_path = export_sheet_with_overlays(sheet, project.assets.all())
            results.append({
                'sheet_id': sheet.id,
                'sheet_name': sheet.name,
                'output_path': output_path
            })
        logger.info("Exported %d sheet(s) for project %d", len(results), project_pk)
        return Response({'status': 'success', 'exports': results})
    except Exception as e:
        logger.error("Export failed for project %d: %s", project_pk, e)
        return Response({'error': str(e)}, status=500)


@api_view(['GET'])
def adjustment_report(request, project_pk):
    """Generate adjustment report for a project."""
    project = get_object_or_404(Project, pk=project_pk)
    format_type = request.query_params.get('format', 'json')

    adjusted_assets = project.assets.filter(is_adjusted=True).annotate(
        adjustment_count=Count('adjustment_logs')
    )
    logs = AdjustmentLog.objects.filter(
        asset__project=project
    ).select_related('asset').order_by('-timestamp')

    if format_type == 'csv':
        return generate_adjustment_report(project, adjusted_assets, logs, format_type='csv')

    # JSON response
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
    batches = ImportBatch.objects.filter(project_id=project_pk)
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
    asset_count = batch.assets.count()
    batch.assets.all().delete()
    batch.delete()
    logger.info("Deleted import batch %d (%d assets)", pk, asset_count)

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

    # Scale calibration
    if 'pixel_distance' in data and 'real_distance' in data:
        project.pixels_per_meter = data['pixel_distance'] / data['real_distance']
        project.scale_calibrated = True
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

    project.save()

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

    try:
        with transaction.atomic():
            # Create new sheet (copy of original) with opposite cut
            new_sheet = Sheet.objects.create(
                project=original.project,
                name=f"{original.name}-split",
                pdf_file=original.pdf_file,
                page_number=original.page_number,
                offset_x=original.offset_x,
                offset_y=original.offset_y,
                rotation=original.rotation,
                z_index=original.z_index + 1,
                cuts_json=[{**cut_entry, 'flipped': True}],
            )

            # Render the new sheet's image
            render_pdf_page(new_sheet)

            # Append cut to original sheet's existing cuts
            original_cuts = list(original.cuts_json or [])
            original_cuts.append({**cut_entry, 'flipped': False})
            original.cuts_json = original_cuts
            original.save()

        logger.info("Sheet %d split into %d and %d", original.pk, original.pk, new_sheet.pk)
    except Exception as e:
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

    csv_file = request.FILES.get('csv_file')
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
    """List and create layer groups for a project."""
    serializer_class = LayerGroupSerializer

    def get_queryset(self):
        queryset = LayerGroup.objects.filter(
            project_id=self.kwargs['project_pk']
        ).prefetch_related('child_groups')
        # Filter by group_type if specified
        group_type = self.request.query_params.get('type')
        if group_type in ('asset', 'link', 'sheet'):
            queryset = queryset.filter(group_type=group_type)
        # By default, only return top-level groups (those without parents)
        if self.request.query_params.get('top_level', 'true').lower() == 'true':
            queryset = queryset.filter(parent_group__isnull=True)
        return queryset

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

    # Prevent circular references by walking the full ancestor chain
    ancestor = parent
    while ancestor:
        if ancestor.id == child.id:
            return Response({'error': 'Cannot create circular group reference'}, status=400)
        ancestor = ancestor.parent_group

    child.parent_group = parent
    child.save()

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
    group.save()

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

    group.save()

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
    item.save()
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

    measurement.save()

    return Response({
        'id': measurement.id,
        'visible': measurement.visible
    })
