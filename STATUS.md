# DocuWeaver — status
_Updated: 2026-11-01_

## What this is
Django 5.2 web app for aligning multi-page PDF engineering drawings on a Fabric.js canvas and overlaying geo-referenced assets from CSV. Self-hosted, SQLite, single-process. Run with `./start.sh` / `start.bat` (creates venv, installs, migrates, serves) or `python manage.py serve`. Tests: `pytest`. Lint: `ruff check .`. User-facing docs live in `README.md`; this file is the development state.

## Current state
Released and idle. Version 1.0.0 is a single-commit repository at https://github.com/NitroghostGH/DocuWeaver (branch `main`), tagged `v1.0.0` with a GitHub release (2026-09-02). CI is green on all five jobs (Python 3.10–3.13 plus the Docker build and smoke test). Re-checked 2026-11-01: 103 tests pass, ruff clean, `makemigrations --check` clean. No commits since the release.

- History: the code descends from https://github.com/jpmarshTMR/DocuWeaver (partner's repo, read-only for this account). The previous NitroghostGH fork was renamed to `DocuWeaver-legacy` and archived on 2026-09-02; the new repo was started fresh with one commit at the user's request.
- Docker image is only verified by the CI `docker` job (build, then curl the login page); there's no docker binary on this machine.
- `start.bat` is untested (no Windows machine available); `start.sh` was exercised end to end.

## Architecture map
- `docuweaver/settings.py` — all config from env vars (`env_bool`/`env_list` helpers). Key custom settings: `REQUIRE_LOGIN`, `DATA_DIR`, `DOCUWEAVER_HTTPS`. WhiteNoise for static.
- `docuweaver/test_settings.py` — pytest uses this (plain static storage, no manifest needed).
- `docuweaver/urls.py` — login/logout via `django.contrib.auth` views; media served through `login_required_if_enabled(serve)` when DEBUG is off.
- `drawings/auth.py` — `login_required_if_enabled` decorator for page views. `drawings/permissions.py` — `IsAuthenticatedOrOpenAccess` for DRF. Both read `settings.REQUIRE_LOGIN` at request time so `override_settings` works.
- `drawings/context_processors.py` — exposes `DOCUWEAVER_VERSION` and `REQUIRE_LOGIN` to templates (nav bar).
- `drawings/management/commands/serve.py` — Waitress server; runs `collectstatic` before importing the WSGI app (order matters for WhiteNoise).
- `drawings/api_views.py`, `drawings/views.py`, `drawings/services/` — unchanged application logic. `pdf_processor.py` imports `pymupdf as fitz`.
- `static/js/editor/*.js` — canvas editor modules; load order fixed in `templates/drawings/editor.html`. `static/js/vendor/fabric.min.js` — Fabric 5.3.1 vendored (MIT).
- `templates/registration/login.html` — login page; logout is a POST form in `templates/base.html` (Django 5 removed GET logout).
- `docker/entrypoint.sh` — migrate, optional first-start superuser from `DOCUWEAVER_ADMIN_USER/_PASSWORD`, then `manage.py serve`.

## Recently done
- 2026-11-01 — Tests no longer leak uploads: `docuweaver/test_settings.py` points `MEDIA_ROOT` at a `tempfile.mkdtemp()` dir that is removed at exit. Deleted the 112 leaked dummy `media/pdfs/test*.pdf` files. Rebuilt the local `.venv`, which had been moved from an old `jpm/` path and no longer worked. Confirmed CI green, v1.0.0 tagged and released, and upstream jpmarshTMR repo unchanged since 2026-04-08.
- 2026-09-02 — Release prep: AGPL-3.0 LICENSE; recreated missing migration `0012_unique_constraints_and_indexes` (fresh installs could not migrate); Django 4.2→5.2 LTS, DRF 3.17; dropped unused `reportlab` and `django-cors-headers`; added login page + `REQUIRE_LOGIN`; WhiteNoise + Waitress + `manage.py serve`; Dockerfile/compose; `start.sh`/`start.bat`; CI matrix 3.10–3.13 with lint, migration check and Docker build; README/CONTRIBUTING/CHANGELOG; removed root debug scripts and empty `cadastre_service.py`; vendored Fabric.js.

## In flight / next steps
1. Confirm the partner has switched to NitroghostGH/DocuWeaver; the jpmarshTMR repo is behind (last commit 2026-04-08).
2. Test `start.bat` on a Windows machine.
3. Unmerged branches on the jpmarshTMR repo worth a look: `feature/join-mark-detection` (5 commits, 2026-04-02: join-mark detection, north-arrow auto-rotation, stitched export; adds a `0014` migration and new deps) and `codebase-review-improvements` (adds `drawings/tests/` package, which conflicts with `drawings/tests.py`; would need merging into the single file). `Cadastre-layer` is stale (2026-02).
4. Optional: per-project permissions (currently every signed-in user sees every project); `docs/DEV_NOTES.md` is stale (refers to a removed `canvas_editor.js`).

## Gotchas
- Licence is AGPL because PyMuPDF is AGPL. Replacing PyMuPDF (e.g. with pypdfium2) would be required to relicense more permissively; OCG layer control in `pdf_processor.py` relies on PyMuPDF.
- `DJANGO_SECRET_KEY` is mandatory at import time; pytest gets one via `pytest-env` in `pytest.ini`.
- With `DJANGO_DEBUG=false`, static files need `collectstatic` (manifest storage). `manage.py serve` and the launchers do it; `runserver` with DEBUG off will 500 on the editor page unless you collect first.
- `DOCUWEAVER_HTTPS=true` sets Secure cookies; on plain HTTP nobody can log in. Leave it off for LAN use.
- Hosts other than localhost need both `DJANGO_ALLOWED_HOSTS` and `DJANGO_CSRF_TRUSTED_ORIGINS` (with scheme and port).
- On this dev box `python3 -m venv` lacks ensurepip; use `uv venv --seed .venv` then `uv pip install -r requirements-dev.txt`.
- `git shortlog` without a revision hangs in non-TTY shells (reads stdin); pass `HEAD`.
