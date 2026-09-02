"""Custom permissions for the drawings app."""
from django.conf import settings
from rest_framework.permissions import BasePermission


class IsAuthenticatedOrOpenAccess(BasePermission):
    """
    Require an authenticated user unless the deployment has opted out of
    login enforcement with ``DOCUWEAVER_REQUIRE_LOGIN=false``.
    """

    def has_permission(self, request, view):
        if not getattr(settings, 'REQUIRE_LOGIN', True):
            return True
        return bool(request.user and request.user.is_authenticated)
