"""Settings used by the test suite (see pytest.ini)."""
import atexit
import shutil
import tempfile
from pathlib import Path

from .settings import *  # noqa: F403

# Serve static files straight from the source tree; the hashed manifest
# storage needs a ``collectstatic`` run which tests should not depend on.
STORAGES['staticfiles'] = {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'}  # noqa: F405
WHITENOISE_USE_FINDERS = True
WHITENOISE_AUTOREFRESH = True

# Uploads made by the tests go to a throwaway directory, not the real media/
# folder, and are deleted when the test process exits.
MEDIA_ROOT = Path(tempfile.mkdtemp(prefix='docuweaver-test-media-'))
atexit.register(shutil.rmtree, MEDIA_ROOT, ignore_errors=True)
