"""API URL configuration for drawings app."""
from django.urls import path

from . import api_views

urlpatterns = [
    # Projects
    path('projects/', api_views.ProjectListCreate.as_view(), name='project-list'),
    path('projects/<int:pk>/', api_views.ProjectDetail.as_view(), name='project-detail'),

    # Sheets
    path('projects/<int:project_pk>/sheets/', api_views.SheetListCreate.as_view(), name='sheet-list'),
    path('sheets/<int:pk>/', api_views.SheetDetail.as_view(), name='sheet-detail'),
    path('sheets/<int:pk>/render/', api_views.render_sheet, name='sheet-render'),
    path('sheets/<int:pk>/layers/', api_views.set_sheet_layers, name='sheet-layers'),
    path('sheets/<int:pk>/split/', api_views.split_sheet, name='sheet-split'),

    # Assets
    path('projects/<int:project_pk>/assets/', api_views.AssetListCreate.as_view(), name='asset-list'),
    path('assets/<int:pk>/', api_views.AssetDetail.as_view(), name='asset-detail'),
    path('assets/<int:pk>/adjust/', api_views.adjust_asset, name='asset-adjust'),

    # Links
    path('projects/<int:project_pk>/links/', api_views.LinkListCreate.as_view(), name='link-list'),
    path('links/<int:pk>/', api_views.LinkDetail.as_view(), name='link-detail'),
    path('projects/<int:project_pk>/import-links-csv/', api_views.import_links_csv, name='import-links-csv'),

    # CSV Import
    path('projects/<int:project_pk>/import-csv/', api_views.import_csv, name='import-csv'),
    path('column-presets/', api_views.column_presets, name='column-presets'),

    # Import Batches
    path('projects/<int:project_pk>/import-batches/', api_views.import_batch_list, name='import-batch-list'),
    path('import-batches/<int:pk>/', api_views.import_batch_delete, name='import-batch-delete'),

    # Export
    path('projects/<int:project_pk>/export/', api_views.export_project, name='export-project'),
    path('projects/<int:project_pk>/adjustment-report/', api_views.adjustment_report, name='adjustment-report'),

    # Calibration
    path('projects/<int:pk>/calibrate/', api_views.calibrate_project, name='calibrate-project'),


    # Layer Groups
    path('projects/<int:project_pk>/layer-groups/', api_views.LayerGroupListCreate.as_view(), name='layer-group-list'),
    path('layer-groups/<int:pk>/', api_views.LayerGroupDetail.as_view(), name='layer-group-detail'),
    path('projects/<int:project_pk>/layer-groups/join/', api_views.join_groups, name='join-groups'),
    path('layer-groups/<int:pk>/unjoin/', api_views.unjoin_group, name='unjoin-group'),
    path('layer-groups/<int:pk>/toggle-visibility/', api_views.toggle_group_visibility, name='toggle-group-visibility'),
    path('layer-groups/<int:pk>/move-item/', api_views.move_item_to_group, name='move-item-to-group'),
    path('layer-groups/<int:pk>/assign-ungrouped/', api_views.assign_ungrouped_to_group, name='assign-ungrouped-to-group'),
    path('layer-groups/<int:pk>/ungroup-all/', api_views.ungroup_all_items, name='ungroup-all-items'),
    path('layer-groups/<int:pk>/move-contents/', api_views.move_contents_to_folder, name='move-contents-to-folder'),

    # Measurement Sets
    path('projects/<int:project_pk>/measurement-sets/', api_views.MeasurementSetListCreate.as_view(), name='measurement-set-list'),
    path('measurement-sets/<int:pk>/', api_views.MeasurementSetDetail.as_view(), name='measurement-set-detail'),
    path('measurement-sets/<int:pk>/toggle-visibility/', api_views.toggle_measurement_visibility, name='toggle-measurement-visibility'),
]

