"""DRF Serializers for drawings app."""
from django.db.models import Count
from rest_framework import serializers

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
)


class AssetTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = AssetType
        fields = ['id', 'name', 'icon_shape', 'custom_icon', 'color', 'size']


class JoinMarkSerializer(serializers.ModelSerializer):
    class Meta:
        model = JoinMark
        fields = ['id', 'sheet', 'x', 'y', 'reference_label', 'linked_mark']


class SheetSerializer(serializers.ModelSerializer):
    join_marks = JoinMarkSerializer(many=True, read_only=True)
    rendered_image_url = serializers.SerializerMethodField()

    class Meta:
        model = Sheet
        fields = [
            'id', 'project', 'name', 'pdf_file', 'page_number',
            'rendered_image', 'rendered_image_url', 'image_width', 'image_height',
            'cuts_json',
            'offset_x', 'offset_y', 'rotation', 'z_index',
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
    class Meta:
        model = ImportBatch
        fields = ['id', 'project', 'filename', 'asset_count', 'created_at']
        read_only_fields = ['project']


class AssetSerializer(serializers.ModelSerializer):
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
            'current_x', 'current_y', 'is_adjusted', 'delta_distance',
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


class ProjectSerializer(serializers.ModelSerializer):
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


class LinkSerializer(serializers.ModelSerializer):
    """Serializer for Link polylines."""
    point_count = serializers.IntegerField(read_only=True)
    layer_group_name = serializers.CharField(source='layer_group.name', read_only=True, default=None)

    class Meta:
        model = Link
        fields = [
            'id', 'project', 'link_id', 'name', 'coordinates',
            'color', 'width', 'opacity', 'link_type',
            'import_batch', 'layer_group', 'layer_group_name',
            'point_count', 'metadata', 'created_at', 'updated_at'
        ]
        read_only_fields = ['project']


class LayerGroupSerializer(serializers.ModelSerializer):
    """Serializer for layer groups with nested children."""
    item_count = serializers.IntegerField(read_only=True)
    total_items = serializers.IntegerField(read_only=True)
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

    def get_child_groups(self, obj):
        """Recursively serialize child groups."""
        children = obj.child_groups.all()
        return LayerGroupSerializer(children, many=True).data


class MeasurementSetSerializer(serializers.ModelSerializer):
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
    ref_asset_id = serializers.CharField(required=False, max_length=100)
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
