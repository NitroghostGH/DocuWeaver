"""URL configuration for DocuWeaver."""
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.urls import include, path, re_path
from django.views.static import serve

from drawings.auth import login_required_if_enabled

urlpatterns = [
    path('admin/', admin.site.urls),
    path('accounts/login/', auth_views.LoginView.as_view(redirect_authenticated_user=True), name='login'),
    path('accounts/logout/', auth_views.LogoutView.as_view(), name='logout'),
    path('', include('drawings.urls')),
    path('api/', include('drawings.api_urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
else:
    # Uploaded PDFs and rendered sheets are served by Django itself (behind
    # the same login check as the rest of the app). Static assets are handled
    # by WhiteNoise. This is fine for a small team; for heavy multi-user use
    # put a reverse proxy in front and serve MEDIA_ROOT from there.
    urlpatterns += [
        re_path(
            rf'^{settings.MEDIA_URL.lstrip("/")}(?P<path>.*)$',
            login_required_if_enabled(serve),
            {'document_root': settings.MEDIA_ROOT},
            name='media',
        ),
    ]
