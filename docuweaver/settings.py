"""
Django settings for DocuWeaver.

All deployment-specific values are read from environment variables (or a
``.env`` file in the project root). See ``.env.example`` for the full list.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name, default=False):
    """Read a boolean from the environment (accepts true/1/yes/on)."""
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ('1', 'true', 'yes', 'on')


def env_list(name, default=''):
    """Read a comma-separated list from the environment."""
    return [item.strip() for item in os.getenv(name, default).split(',') if item.strip()]


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

# Security: require SECRET_KEY to be set in environment (no insecure fallback)
SECRET_KEY = os.getenv('DJANGO_SECRET_KEY')
if not SECRET_KEY:
    raise ValueError(
        "DJANGO_SECRET_KEY environment variable is required. "
        "Generate one with: python -c \"from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())\""
    )

# Security: DEBUG defaults to False
DEBUG = env_bool('DJANGO_DEBUG', False)

ALLOWED_HOSTS = env_list('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1')

# Needed when the app is served on a hostname/port other than localhost
# (e.g. https://docuweaver.example.org or http://192.168.1.10:8000).
CSRF_TRUSTED_ORIGINS = env_list('DJANGO_CSRF_TRUSTED_ORIGINS')

# Where the SQLite database and uploaded files live. Defaults to the project
# directory; point this at a persistent volume in Docker or a shared drive.
DATA_DIR = Path(os.getenv('DOCUWEAVER_DATA_DIR', BASE_DIR)).resolve()

# When True (the default), every page and API call requires a logged-in user.
# Set DOCUWEAVER_REQUIRE_LOGIN=false for a single-user install on a trusted
# machine where you do not want to bother with accounts.
REQUIRE_LOGIN = env_bool('DOCUWEAVER_REQUIRE_LOGIN', True)

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'drawings',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'docuweaver.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
                'drawings.context_processors.docuweaver',
            ],
        },
    },
]

WSGI_APPLICATION = 'docuweaver.wsgi.application'

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': DATA_DIR / 'db.sqlite3',
    }
}

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LOGIN_URL = '/accounts/login/'
LOGIN_REDIRECT_URL = '/'
LOGOUT_REDIRECT_URL = '/accounts/login/'

# ---------------------------------------------------------------------------
# I18N
# ---------------------------------------------------------------------------

LANGUAGE_CODE = 'en-us'
TIME_ZONE = os.getenv('DJANGO_TIME_ZONE', 'UTC')
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Static & media
# ---------------------------------------------------------------------------

STATIC_URL = 'static/'
STATICFILES_DIRS = [BASE_DIR / 'static']
STATIC_ROOT = Path(os.getenv('DOCUWEAVER_STATIC_ROOT', DATA_DIR / 'staticfiles'))

STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {
        'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage'
        if not DEBUG else 'django.contrib.staticfiles.storage.StaticFilesStorage',
    },
}
# Serve files straight from STATICFILES_DIRS in development so ``collectstatic``
# is only required for production installs.
WHITENOISE_USE_FINDERS = DEBUG
WHITENOISE_AUTOREFRESH = DEBUG

MEDIA_URL = 'media/'
MEDIA_ROOT = DATA_DIR / 'media'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ---------------------------------------------------------------------------
# REST framework
# ---------------------------------------------------------------------------

REST_FRAMEWORK = {
    'DEFAULT_PERMISSION_CLASSES': [
        # Honours DOCUWEAVER_REQUIRE_LOGIN (see drawings/permissions.py)
        'drawings.permissions.IsAuthenticatedOrOpenAccess',
    ],
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.SessionAuthentication',
        'rest_framework.authentication.BasicAuthentication',
    ],
}

# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------

# Maximum size of an uploaded file held in memory / request body (default 10 MB).
# PDF drawings can be large; raise DOCUWEAVER_MAX_UPLOAD_MB if uploads are rejected.
_max_upload = int(os.getenv('DOCUWEAVER_MAX_UPLOAD_MB', '10')) * 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = _max_upload
FILE_UPLOAD_MAX_MEMORY_SIZE = _max_upload

# ---------------------------------------------------------------------------
# Security headers
# ---------------------------------------------------------------------------

SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'DENY'

# Set DOCUWEAVER_HTTPS=true when the app is served over TLS (directly or
# behind a reverse proxy). Leave it off for plain-HTTP LAN/localhost use,
# otherwise browsers will refuse to send the session cookie.
if env_bool('DOCUWEAVER_HTTPS', False):
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = 31536000  # 1 year
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'simple': {'format': '%(levelname)s %(asctime)s %(name)s: %(message)s'},
    },
    'handlers': {
        'console': {'class': 'logging.StreamHandler', 'formatter': 'simple'},
    },
    'root': {
        'handlers': ['console'],
        'level': os.getenv('DOCUWEAVER_LOG_LEVEL', 'INFO').upper(),
    },
}
