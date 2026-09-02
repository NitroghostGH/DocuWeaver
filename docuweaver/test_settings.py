"""Settings used by the test suite (see pytest.ini)."""
from .settings import *  # noqa: F403

# Serve static files straight from the source tree; the hashed manifest
# storage needs a ``collectstatic`` run which tests should not depend on.
STORAGES['staticfiles'] = {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'}  # noqa: F405
WHITENOISE_USE_FINDERS = True
WHITENOISE_AUTOREFRESH = True
