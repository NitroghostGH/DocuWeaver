#!/usr/bin/env bash
# One-command launcher for Linux/macOS: creates a virtualenv, installs
# dependencies, applies migrations and starts the server.
set -euo pipefail
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
if [ ! -x .venv/bin/python ]; then
  echo ">> Creating virtual environment (.venv)"
  "$PY" -m venv .venv
fi
. .venv/bin/activate

echo ">> Installing dependencies"
python -m pip install -q --upgrade pip
python -m pip install -q -r requirements.txt

if [ ! -f .env ]; then
  echo ">> Creating .env with a fresh secret key"
  cp .env.example .env
  KEY=$(python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())")
  sed -i.bak "s|^DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=${KEY}|" .env && rm -f .env.bak
fi

echo ">> Applying database migrations"
python manage.py migrate --noinput
echo ">> Collecting static files"
python manage.py collectstatic --noinput >/dev/null

if ! python manage.py shell -c "import sys; from django.contrib.auth import get_user_model; sys.exit(0 if get_user_model().objects.exists() else 1)" >/dev/null 2>&1; then
  if [ -t 0 ]; then
    echo ">> No user accounts exist yet. Create the first (admin) account:"
    python manage.py createsuperuser
  else
    echo ">> No user accounts exist yet. Run 'python manage.py createsuperuser' to create one."
  fi
fi

exec python manage.py serve "$@"
