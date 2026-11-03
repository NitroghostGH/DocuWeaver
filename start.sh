#!/usr/bin/env bash
# One-command launcher for Linux/macOS: creates a virtualenv, installs
# dependencies, applies migrations and starts the server.
set -euo pipefail
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
if [ ! -x .venv/bin/python ]; then
  echo ">> Creating virtual environment (.venv)"
  existed=0; [ -e .venv ] && existed=1
  if ! "$PY" -m venv .venv; then
    # A failed attempt leaves .venv/bin/python without pip, and the next run
    # would reuse it and fail on "No module named pip" every time.
    [ "$existed" = 0 ] && rm -rf .venv
    echo >&2
    echo "Could not create the virtual environment. Fix the problem above (on Debian or" >&2
    echo "Ubuntu, usually by installing the python3-venv package), then run $0 again." >&2
    exit 1
  fi
fi
# An environment left without pip by an earlier failed attempt: add pip now
# that it may be available, instead of failing on every run.
if ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
  echo ">> Installing pip into .venv"
  if ! .venv/bin/python -m ensurepip --upgrade >/dev/null; then
    echo >&2
    echo "The .venv folder has no pip and it can't be added. Install your system's" >&2
    echo "python3-venv package (Debian/Ubuntu), delete the .venv folder, then run $0 again." >&2
    exit 1
  fi
fi
. .venv/bin/activate

echo ">> Installing dependencies"
python -m pip install -q --upgrade pip
python -m pip install -q -r requirements.txt

if [ ! -f .env ]; then
  echo ">> Creating .env with a fresh secret key"
  cp .env.example .env
  # Not sed: the key alphabet includes "&", which sed reads as "the match".
  python -c 'import re;from django.core.management.utils import get_random_secret_key as g;p=".env";s=open(p).read();open(p,"w").write(re.sub(r"(?m)^DJANGO_SECRET_KEY=.*$",lambda m:"DJANGO_SECRET_KEY="+g(),s))'
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
