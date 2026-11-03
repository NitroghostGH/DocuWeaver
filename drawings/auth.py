"""Login enforcement for page views, and the API's CSRF check without login."""
from functools import wraps

from django.conf import settings
from django.contrib.auth.decorators import login_required
from rest_framework.authentication import SessionAuthentication


def login_required_if_enabled(view_func):
    """
    Behave like ``login_required`` when ``settings.REQUIRE_LOGIN`` is True,
    otherwise pass the request straight through.

    The setting is read on every request so tests can override it.
    """
    protected = login_required(view_func)

    @wraps(view_func)
    def wrapper(request, *args, **kwargs):
        if getattr(settings, 'REQUIRE_LOGIN', True):
            return protected(request, *args, **kwargs)
        return view_func(request, *args, **kwargs)

    return wrapper


class CsrfCheckWithoutLogin(SessionAuthentication):
    """Check the CSRF token on API requests that aren't signed in.

    DRF checks CSRF only after it finds a signed-in session user. With
    ``DOCUWEAVER_REQUIRE_LOGIN=false`` requests without one are accepted, so
    without this check any website the user visits could change projects
    through their browser, for example with a hidden form. Listed after the
    real authentication classes, so it only sees requests none of them
    accepted, and it never signs anyone in. Basic-auth clients don't rely
    on cookies, so they're authenticated before it and aren't affected.
    """

    def authenticate(self, request):
        self.enforce_csrf(request)
        return None
