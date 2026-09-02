"""Login enforcement helpers for page views."""
from functools import wraps

from django.conf import settings
from django.contrib.auth.decorators import login_required


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
