@echo off
REM One-command launcher for Windows: creates a virtualenv, installs
REM dependencies, applies migrations and starts the server.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo ^>^> Creating virtual environment ^(.venv^)
  py -3 -m venv .venv || python -m venv .venv || goto :fail
)
call .venv\Scripts\activate.bat

echo ^>^> Installing dependencies
python -m pip install -q --upgrade pip
python -m pip install -q -r requirements.txt || goto :fail

if not exist ".env" (
  echo ^>^> Creating .env with a fresh secret key
  copy /y .env.example .env >nul
  for /f "delims=" %%k in ('python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"') do set "KEY=%%k"
  python -c "import re,io;p='.env';s=open(p).read();s=re.sub(r'^DJANGO_SECRET_KEY=.*$','DJANGO_SECRET_KEY=%KEY%',s,flags=re.M);open(p,'w').write(s)"
)

echo ^>^> Applying database migrations
python manage.py migrate --noinput || goto :fail
echo ^>^> Collecting static files
python manage.py collectstatic --noinput >nul || goto :fail

python manage.py shell -c "import sys; from django.contrib.auth import get_user_model; sys.exit(0 if get_user_model().objects.exists() else 1)" >nul 2>&1
if errorlevel 1 (
  echo ^>^> No user accounts exist yet. Create the first ^(admin^) account:
  python manage.py createsuperuser
)

python manage.py serve %*
goto :eof

:fail
echo.
echo Something went wrong. Make sure Python 3.10 or newer is installed and on your PATH.
pause
exit /b 1
