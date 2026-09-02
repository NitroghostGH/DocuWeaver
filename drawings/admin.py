"""Django admin configuration for drawings app."""
from django.contrib import admin
from django.utils.html import format_html

from .models import (
    AdjustmentLog,
    Asset,
    AssetType,
    ColumnPreset,
    ImportBatch,
    JoinMark,
    LayerGroup,
    Link,
    MeasurementSet,
    Project,
    Sheet,
)


@admin.register(AssetType)
class AssetTypeAdmin(admin.ModelAdmin):
    """Admin for configuring asset types and their icons."""
    list_display = ['name', 'icon_shape', 'color_preview', 'size', 'custom_icon']
    list_editable = ['icon_shape', 'size']
    search_fields = ['name']

    def color_preview(self, obj):
        return format_html(
            '<span style="background-color: {}; padding: 5px 15px; border-radius: 3px;">&nbsp;</span> {}',
            obj.color,
            obj.color
        )
    color_preview.short_description = 'Color'


class SheetInline(admin.TabularInline):
    model = Sheet
    extra = 0
    fields = ['name', 'pdf_file', 'page_number', 'z_index']


class AssetInline(admin.TabularInline):
    model = Asset
    extra = 0
    fields = ['asset_id', 'asset_type', 'name', 'original_x', 'original_y', 'is_adjusted']
    readonly_fields = ['is_adjusted']


@admin.register(Project)
class ProjectAdmin(admin.ModelAdmin):
    list_display = ['name', 'created_at', 'sheet_count', 'asset_count']
    search_fields = ['name', 'description']
    inlines = [SheetInline, AssetInline]

    fieldsets = (
        (None, {
            'fields': ('name', 'description')
        }),
        ('Coordinate Calibration', {
            'fields': ('pixels_per_meter', 'origin_x', 'origin_y'),
            'classes': ('collapse',)
        }),
    )

    def sheet_count(self, obj):
        return obj.sheets.count()
    sheet_count.short_description = 'Sheets'

    def asset_count(self, obj):
        return obj.assets.count()
    asset_count.short_description = 'Assets'


@admin.register(Sheet)
class SheetAdmin(admin.ModelAdmin):
    list_display = ['name', 'project', 'page_number', 'z_index']
    list_filter = ['project']
    search_fields = ['name', 'project__name']


@admin.register(JoinMark)
class JoinMarkAdmin(admin.ModelAdmin):
    list_display = ['reference_label', 'sheet', 'x', 'y', 'linked_mark']
    list_filter = ['sheet__project']
    search_fields = ['reference_label']


@admin.register(Asset)
class AssetAdmin(admin.ModelAdmin):
    list_display = ['asset_id', 'name', 'asset_type', 'project', 'is_adjusted', 'delta_display']
    list_filter = ['project', 'asset_type', 'is_adjusted']
    search_fields = ['asset_id', 'name']
    readonly_fields = ['delta_display', 'current_x', 'current_y']

    fieldsets = (
        (None, {
            'fields': ('project', 'asset_type', 'asset_id', 'name')
        }),
        ('Original Coordinates', {
            'fields': ('original_x', 'original_y')
        }),
        ('Adjusted Coordinates', {
            'fields': ('adjusted_x', 'adjusted_y', 'is_adjusted', 'delta_display')
        }),
        ('Metadata', {
            'fields': ('metadata',),
            'classes': ('collapse',)
        }),
    )

    def delta_display(self, obj):
        if obj.is_adjusted:
            return f"{obj.delta_distance:.2f} meters"
        return "-"
    delta_display.short_description = 'Adjustment Distance'


@admin.register(AdjustmentLog)
class AdjustmentLogAdmin(admin.ModelAdmin):
    list_display = ['asset', 'timestamp', 'delta_distance', 'notes_preview']
    list_filter = ['asset__project', 'timestamp']
    search_fields = ['asset__asset_id', 'notes']
    readonly_fields = ['delta_x', 'delta_y', 'delta_distance']

    def notes_preview(self, obj):
        if obj.notes:
            return obj.notes[:50] + '...' if len(obj.notes) > 50 else obj.notes
        return '-'
    notes_preview.short_description = 'Notes'


@admin.register(ColumnPreset)
class ColumnPresetAdmin(admin.ModelAdmin):
    """Admin for managing CSV column name presets."""
    list_display = ['column_name', 'role', 'priority']
    list_filter = ['role']
    list_editable = ['priority']
    search_fields = ['column_name']


@admin.register(ImportBatch)
class ImportBatchAdmin(admin.ModelAdmin):
    list_display = ['filename', 'project', 'asset_count', 'created_at']
    list_filter = ['project']
    search_fields = ['filename']


@admin.register(LayerGroup)
class LayerGroupAdmin(admin.ModelAdmin):
    """Admin for managing layer groups (folders for organizing items)."""
    list_display = ['name', 'project', 'group_type', 'scope', 'item_count']
    list_filter = ['project', 'group_type', 'scope']
    search_fields = ['name']

    fieldsets = (
        (None, {
            'fields': ('project', 'name', 'group_type', 'scope', 'parent_group', 'visible')
        }),
        ('Metadata', {
            'fields': ('color',),
            'classes': ('collapse',)
        }),
    )

    def item_count(self, obj):
        return obj.item_count or 0
    item_count.short_description = 'Items'


@admin.register(Link)
class LinkAdmin(admin.ModelAdmin):
    """Admin for managing links (pipes, cables, etc.)."""
    list_display = ['link_id', 'name', 'project', 'link_type', 'layer_group']
    list_filter = ['project', 'link_type']
    search_fields = ['link_id', 'name']

    fieldsets = (
        (None, {
            'fields': ('project', 'link_id', 'name', 'link_type', 'layer_group')
        }),
        ('Display', {
            'fields': ('color', 'width', 'opacity')
        }),
        ('Data', {
            'fields': ('coordinates', 'metadata'),
            'classes': ('collapse',)
        }),
    )



@admin.register(MeasurementSet)
class MeasurementSetAdmin(admin.ModelAdmin):
    """Admin for managing saved measurements."""
    list_display = ['name', 'project', 'measurement_type', 'get_layer_group', 'visible', 'created_at']
    list_filter = ['project', 'measurement_type', 'visible', 'created_at']
    search_fields = ['name', 'project__name']
    readonly_fields = ['created_at', 'total_distance_pixels', 'total_distance_meters']

    fieldsets = (
        (None, {
            'fields': ('project', 'name', 'measurement_type', 'layer_group')
        }),
        ('Data', {
            'fields': ('points', 'color', 'visible')
        }),
        ('Calculated', {
            'fields': ('total_distance_pixels', 'total_distance_meters', 'created_at'),
            'classes': ('collapse',)
        }),
    )

    def get_layer_group(self, obj):
        """Display the layer group name or 'Ungrouped'."""
        return obj.layer_group.name if obj.layer_group else 'Ungrouped'
    get_layer_group.short_description = 'Folder'
