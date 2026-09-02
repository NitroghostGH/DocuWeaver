# Contributing to DocuWeaver

Thanks for helping out. Bug reports, feature requests and pull requests are all welcome on the GitHub issue tracker.

## Setting up

```bash
git clone https://github.com/NitroghostGH/DocuWeaver.git
cd DocuWeaver
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env    # set DJANGO_SECRET_KEY and DJANGO_DEBUG=true
python manage.py migrate
python manage.py runserver
```

## Before opening a pull request

```bash
ruff check .                                # lint (config in ruff.toml)
python manage.py makemigrations --check     # every model change needs a committed migration
pytest                                      # all tests must pass
```

CI runs the same three commands on Python 3.10 to 3.13, and builds the Docker image.

## Project layout

```
docuweaver/         Django project: settings, URLs, WSGI, test_settings
drawings/           The application
  models.py         Project, Sheet, Asset, Link, LayerGroup, MeasurementSet, ...
  api_views.py      REST endpoints used by the editor (see api_urls.py)
  views.py          Page views, project export/import
  services/         pdf_processor (PyMuPDF), csv_importer, export_service
  validators.py     Upload validation
  permissions.py    Login enforcement for the API
  auth.py           Login enforcement for page views
  management/       `manage.py serve` (Waitress server)
  tests.py          Test suite (pytest-django)
templates/          Django templates; editor.html holds the canvas UI
static/js/editor/   Canvas editor modules, all under the window.DocuWeaver namespace
static/js/vendor/   Third-party JS (Fabric.js), committed so the app works offline
docker/             Container entrypoint
```

The editor JavaScript is loaded in dependency order at the bottom of `templates/drawings/editor.html`; `namespace.js` must come first and `main.js` last.

## Conventions

- Keep configuration in environment variables read in `docuweaver/settings.py`; document new ones in `.env.example` and the README table.
- Never commit `.env`, databases or uploaded media.
- Migrations are committed. Do not ask users to run `makemigrations`.
- Add or update tests for behaviour changes. API tests use `@override_settings(REQUIRE_LOGIN=False)` unless they are specifically testing authentication.
- Write user-facing text and code comments in plain English; avoid one-letter variable names.
- Third-party code must be under an OSI-approved licence compatible with the AGPL-3.0.

## Releasing

1. Update `__version__` in `docuweaver/__init__.py` and add a section to `CHANGELOG.md`.
2. Tag the commit: `git tag -a v1.2.3 -m "v1.2.3"` and push the tag.
