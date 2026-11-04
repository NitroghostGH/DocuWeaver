"""DRF Serializers for drawings app."""
from django.db.models import Count
from rest_framework import serializers
from rest_framework.serializers import raise_errors_on_nested_writes

from .models import (
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
    save_fields,
)


class SaveChangedFieldsMixin:
    """PATCH/PUT writes only the fields in the request (see save_fields), and
    a related object (folder, import batch, sheet) must be in the same project."""

    def validate(self, attrs):
        attrs = super().validate(attrs)
        if self.instance is not None:
            project_id = getattr(self.instance, 'project_id', None)
        else:
            view = self.context.get('view')
            project_id = view.kwargs.get('project_pk') if view else None
        if project_id is not None:
            for name, value in attrs.items():
                other = getattr(value, 'project_id', None)
                if other is not None and str(other) != str(project_id):
                    raise serializers.ValidationError({name: 'Must belong to the same project.'})
        return attrs

    def update(self, instance, validated_data):
        raise_errors_on_nested_writes('update', self, validated_data)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        save_fields(instance, validated_data)
        return instance


class AssetTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = AssetType
        fields = ['id', 'name', 'icon_shape', 'custom_icon', 'color', 'size']


class JoinMarkSerializer(serializers.ModelSerializer):
    class Meta:
        model = JoinMark
        fields = ['id', 'sheet', 'x', 'y', 'reference_label', 'linked_mark']


class SheetSerializer(SaveChangedFieldsMixin, serializers.ModelSerializer):
    join_marks = JoinMarkSerializer(many=True, read_only=True)
    rendered_image_url = serializers.SerializerMethodField()

    class Meta:
        model = Sheet
        fields = [
            'id', 'project', 'name', 'pdf_file', 'page_number',
            'rendered_image', 'rendered_image_url', 'image_width', 'image_height',
            'cuts_json',
            'offset_x', 'offset_y', 'rotation', 'z_index', 'visible',
            'layer_group',
            'pdf_layers', 'visible_layers',
            'join_marks', 'created_at'
        ]
        read_only_fields = ['project', 'rendered_image', 'image_width', 'image_height', 'pdf_layers']

    def validate_cuts_json(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("cuts_json must be a list")
        for i, cut in enumerate(value):
            if not isinstance(cut, dict):
                raise serializers.ValidationError(f"cuts_json[{i}] must be an object")
            for key in ('p1', 'p2'):
                if key not in cut:
                    raise serializers.ValidationError(f"cuts_json[{i}] missing '{key}'")
                pt = cut[key]
                if not isinstance(pt, dict) or 'x' not in pt or 'y' not in pt:
                    raise serializers.ValidationError(f"cuts_json[{i}].{key} must have x and y")
        return value

    def get_rendered_image_url(self, obj):
        if obj.rendered_image:
            request = self.context.get('request')
            if request:
                return request.build_absolute_uri(obj.rendered_image.url)
            return obj.rendered_image.url
        return None


class ImportBatchSerializer(serializers.ModelSerializer):
    # Counted live: the stored asset_count went stale whenever assets were
    # deleted or (before 1.1.0) taken over by a later import.
    asset_count = serializers.SerializerMethodField()

    class Meta:
        model = ImportBatch
        fields = ['id', 'project', 'filename', 'asset_count', 'created_at']
        read_only_fields = ['project']

    @staticmethod
    def annotate_queryset(queryset):
        return queryset.annotate(n_assets=Count('assets', distinct=True), n_links=Count('links', distinct=True))

    def get_asset_count(self, obj):
        """Assets for an asset import, links for a link import."""
        if hasattr(obj, 'n_assets'):
            return obj.n_assets + obj.n_links
        return obj.assets.count() + obj.links.count()


class AssetSerializer(SaveChangedFieldsMixin, serializers.ModelSerializer):
    asset_type_data = AssetTypeSerializer(source='asset_type', read_only=True)
    current_x = serializers.FloatField(read_only=True)
    current_y = serializers.FloatField(read_only=True)
    delta_distance = serializers.FloatField(read_only=True)
    import_batch_name = serializers.CharField(source='import_batch.filename', read_only=True, default=None)
    layer_group_name = serializers.CharField(source='layer_group.name', read_only=True, default=None)

    class Meta:
        model = Asset
        fields = [
            'id', 'project', 'asset_type', 'asset_type_data', 'asset_id', 'name',
            'original_x', 'original_y', 'adjusted_x', 'adjusted_y',
            'current_x', 'current_y', 'is_adjusted', 'delta_distance', 'visible',
            'import_batch', 'import_batch_name',
            'layer_group', 'layer_group_name',
            'metadata', 'created_at', 'updated_at'
        ]
        read_only_fields = ['project', 'is_adjusted']


class AdjustmentLogSerializer(serializers.ModelSerializer):
    asset_id = serializers.CharField(source='asset.asset_id', read_only=True)

    class Meta:
        model = AdjustmentLog
        fields = [
            'id', 'asset', 'asset_id',
            'from_x', 'from_y', 'to_x', 'to_y',
            'delta_x', 'delta_y', 'delta_distance',
            'timestamp', 'notes'
        ]
        read_only_fields = ['delta_x', 'delta_y', 'delta_distance']


class ProjectSerializer(SaveChangedFieldsMixin, serializers.ModelSerializer):
    sheets = SheetSerializer(many=True, read_only=True)
    asset_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Project
        fields = [
            'id', 'name', 'description',
            'pixels_per_meter', 'scale_calibrated', 'coord_unit',
            'origin_x', 'origin_y', 'canvas_rotation',
            'asset_rotation', 'ref_asset_id', 'ref_pixel_x', 'ref_pixel_y',
            'sheets', 'asset_count',
            'created_at', 'updated_at'
        ]

    @staticmethod
    def annotate_queryset(queryset):
        return queryset.annotate(asset_count=Count('assets'))


class ProjectListSerializer(serializers.ModelSerializer):
    """Lighter serializer for list views."""
    sheet_count = serializers.IntegerField(read_only=True)
    asset_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Project
        fields = ['id', 'name', 'description', 'sheet_count', 'asset_count', 'created_at']

    @staticmethod
    def annotate_queryset(queryset):
        return queryset.annotate(
            sheet_count=Count('sheets', distinct=True),
            asset_count=Count('assets', distinct=True),
        )


class LinkSerializer(SaveChangedFieldsMixin, serializers.ModelSerializer):
    """Serializer for Link polylines."""
    point_count = serializers.IntegerField(read_only=True)
    layer_group_name = serializers.CharField(source='layer_group.name', read_only=True, default=None)

    class Meta:
        model = Link
        fields = [
            'id', 'project', 'link_id', 'name', 'coordinates',
            'color', 'width', 'opacity', 'link_type', 'visible',
            'import_batch', 'layer_group', 'layer_group_name',
            'point_count', 'metadata', 'created_at', 'updated_at'
        ]
        read_only_fields = ['project']


class LayerGroupTree:
    """Every folder of a project with its item counts, from five queries
    however many folders there are. The serializer reads counts and child
    folders from here when it's in the context as ``layer_tree``; without
    it, each folder runs its own count queries (fine for one folder)."""

    COUNTED = {
        # group_type: (model, related name used by LayerGroup.item_count)
        'asset': (Asset, 'assets'),
        'sheet': (Sheet, 'sheets_in_group'),
        'link': (Link, 'links_in_group'),
        'measurement': (MeasurementSet, 'measurements_in_group'),
    }

    def __init__(self, project_id):
        self.groups = list(LayerGroup.objects.filter(project_id=project_id))
        self.children = {}
        for group in self.groups:
            if group.parent_group_id is not None:
                self.children.setdefault(group.parent_group_id, []).append(group)
        self.counts = {}  # group_type -> {group id: n}
        for group_type, (model, _related) in self.COUNTED.items():
            rows = (model.objects.filter(project_id=project_id, layer_group__isnull=False)
                    .values('layer_group').annotate(n=Count('id')).order_by())
            self.counts[group_type] = {row['layer_group']: row['n'] for row in rows}
        self._totals = {}

    def item_count(self, group):
        """Same rule as LayerGroup.item_count."""
        if group.scope == 'global':
            return sum(by_group.get(group.id, 0) for by_group in self.counts.values())
        group_type = group.group_type if group.group_type in self.counts else 'link'
        return self.counts[group_type].get(group.id, 0)

    def total_items(self, group, _seen=None):
        """Same rule as LayerGroup.total_items (a parent loop is counted once)."""
        if group.id not in self._totals:
            seen = (_seen or set()) | {group.id}
            self._totals[group.id] = self.item_count(group) + sum(
                self.total_items(child, seen) for child in self.children.get(group.id, [])
                if child.id not in seen)
        return self._totals[group.id]


class LayerGroupSerializer(SaveChangedFieldsMixin, serializers.ModelSerializer):
    """Serializer for layer groups with nested children."""
    item_count = serializers.SerializerMethodField()
    total_items = serializers.SerializerMethodField()
    is_joined = serializers.BooleanField(read_only=True)
    child_groups = serializers.SerializerMethodField()

    class Meta:
        model = LayerGroup
        fields = [
            'id', 'project', 'name', 'group_type', 'scope', 'color', 'visible',
            'parent_group', 'import_batch', 'is_joined',
            'item_count', 'total_items', 'child_groups', 'created_at'
        ]
        read_only_fields = ['project']

    def validate(self, attrs):
        attrs = super().validate(attrs)
        parent = attrs.get('parent_group')
        if parent is not None:
            group_type = attrs.get('group_type') or getattr(self.instance, 'group_type', None)
            if parent.scope != 'global' and parent.group_type != group_type:
                raise serializers.ValidationError({'parent_group': 'Must be a global folder or one of the same type.'})
            if self.instance is not None and parent_creates_cycle(self.instance, parent):
                raise serializers.ValidationError(
                    {'parent_group': 'A folder cannot be placed inside itself or one of its subfolders.'})
        return attrs

    def get_item_count(self, obj):
        tree = self.context.get('layer_tree')
        return tree.item_count(obj) if tree else obj.item_count

    def get_total_items(self, obj):
        tree = self.context.get('layer_tree')
        return tree.total_items(obj) if tree else obj.total_items

    def get_child_groups(self, obj):
        """Recursively serialize child groups."""
        tree = self.context.get('layer_tree')
        if tree:
            ancestors = self.context.get('layer_ancestors', frozenset()) | {obj.id}
            # A parent loop (which validation now prevents) would recurse forever.
            children = [c for c in tree.children.get(obj.id, []) if c.id not in ancestors]
            context = {**self.context, 'layer_ancestors': ancestors}
        else:
            children = obj.child_groups.all()
            context = self.context
        return LayerGroupSerializer(children, many=True, context=context).data


class MeasurementSetSerializer(SaveChangedFieldsMixin, serializers.ModelSerializer):
    """Serializer for saved measurement sets."""

    class Meta:
        model = MeasurementSet
        fields = [
            'id', 'project', 'name', 'measurement_type', 'points',
            'color', 'visible', 'layer_group', 'total_distance_pixels', 'total_distance_meters',
            'created_at'
        ]
        read_only_fields = ['project']

    def validate_points(self, value):
        """Validate points array format."""
        if not isinstance(value, list):
            raise serializers.ValidationError("points must be a list")
        for i, pt in enumerate(value):
            if not isinstance(pt, dict) or 'x' not in pt or 'y' not in pt:
                raise serializers.ValidationError(f"points[{i}] must have x and y")
        return value


class CalibrateProjectSerializer(serializers.Serializer):
    """Validates calibration input for a project."""
    VALID_COORD_UNITS = ('meters', 'degrees', 'gda94_geo', 'gda94_mga')

    pixel_distance = serializers.FloatField(required=False)
    real_distance = serializers.FloatField(required=False)
    origin_x = serializers.FloatField(required=False)
    origin_y = serializers.FloatField(required=False)
    canvas_rotation = serializers.FloatField(required=False)
    asset_rotation = serializers.FloatField(required=False)
    # Blank means "no reference asset yet": the editor sends it when the
    # coordinate unit is chosen before a reference asset.
    ref_asset_id = serializers.CharField(required=False, allow_blank=True, max_length=100)
    ref_pixel_x = serializers.FloatField(required=False)
    ref_pixel_y = serializers.FloatField(required=False)
    coord_unit = serializers.ChoiceField(choices=VALID_COORD_UNITS, required=False)
    osm_enabled = serializers.BooleanField(required=False)
    osm_opacity = serializers.FloatField(required=False, min_value=0.0, max_value=1.0)
    osm_z_index = serializers.IntegerField(required=False)

    def validate(self, data):
        import math
        for field in ('pixel_distance', 'real_distance', 'origin_x', 'origin_y',
                      'canvas_rotation', 'asset_rotation', 'ref_pixel_x', 'ref_pixel_y',
                      'osm_opacity'):
            if field in data and not math.isfinite(data[field]):
                raise serializers.ValidationError({field: f'{field} must be a finite number'})

        if 'pixel_distance' in data or 'real_distance' in data:
            if 'pixel_distance' not in data or 'real_distance' not in data:
                raise serializers.ValidationError('Both pixel_distance and real_distance are required for scale calibration')
            if data['real_distance'] <= 0:
                raise serializers.ValidationError({'real_distance': 'Must be greater than 0'})
            if data['pixel_distance'] <= 0:
                raise serializers.ValidationError({'pixel_distance': 'Must be greater than 0'})

        return data
