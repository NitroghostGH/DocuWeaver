"""URL configuration for drawings app views."""
from django.urls import path

from . import views

app_name = 'drawings'

urlpatterns = [
    path('', views.project_list, name='project_list'),
    path('project/<int:pk>/', views.project_detail, name='project_detail'),
    path('project/<int:pk>/editor/', views.editor, name='editor'),
    # Legacy JSON export (no embedded PDFs) - kept for API compatibility
    path('project/<int:pk>/export/', views.export_project, name='export_project'),
    # SQLite export with embedded PDFs (recommended)
    path('project/<int:pk>/export-full/', views.export_project_with_sqlite, name='export_project_sqlite'),
    path('import/', views.import_project, name='import_project'),
]
