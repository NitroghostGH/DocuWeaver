"""Template context shared by every page."""
from django.conf import settings

from docuweaver import __version__


def docuweaver(request):
    return {
        'DOCUWEAVER_VERSION': __version__,
        'REQUIRE_LOGIN': getattr(settings, 'REQUIRE_LOGIN', True),
    }
