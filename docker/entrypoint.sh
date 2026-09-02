#!/bin/sh
set -e

python manage.py migrate --noinput

# Create an initial admin account on first start if credentials are provided.
if [ -n "$DOCUWEAVER_ADMIN_USER" ] && [ -n "$DOCUWEAVER_ADMIN_PASSWORD" ]; then
  DJANGO_SUPERUSER_USERNAME="$DOCUWEAVER_ADMIN_USER" \
  DJANGO_SUPERUSER_PASSWORD="$DOCUWEAVER_ADMIN_PASSWORD" \
  DJANGO_SUPERUSER_EMAIL="${DOCUWEAVER_ADMIN_EMAIL:-admin@example.com}" \
  python manage.py createsuperuser --noinput 2>/dev/null || true
fi

exec python manage.py serve "$@"
