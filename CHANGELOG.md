# Changelog

All notable changes to DocuWeaver are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-02

First public release, prepared for distribution as free and open-source software.

### Added
- AGPL-3.0-or-later licence.
- Sign-in page, sign-out button and login enforcement for every page and API endpoint, controlled by `DOCUWEAVER_REQUIRE_LOGIN`.
- `python manage.py serve`: production server (Waitress) with automatic static-file collection.
- One-command launchers `start.sh` and `start.bat` that create a virtualenv, install, migrate and run.
- `Dockerfile`, `docker-compose.yml` and container entrypoint with optional first-start admin account.
- Environment settings `DOCUWEAVER_DATA_DIR`, `DOCUWEAVER_HTTPS`, `DOCUWEAVER_MAX_UPLOAD_MB`, `DJANGO_CSRF_TRUSTED_ORIGINS`, `DJANGO_TIME_ZONE`, `DOCUWEAVER_LOG_LEVEL`.
- Uploaded media is served behind the login check when `DJANGO_DEBUG` is off.
- `requirements-dev.txt`, `ruff.toml`, and a CI matrix over Python 3.10 to 3.13 that also checks migrations and builds the Docker image.
- Tests for login enforcement and open-access mode.
- `CONTRIBUTING.md` and this changelog.

### Changed
- Upgraded to Django 5.2 LTS (4.2 reached end of life in April 2026) and Django REST Framework 3.16+.
- Fabric.js is bundled locally instead of loaded from a CDN, so the editor works without internet access.
- Static files are served by WhiteNoise with hashed, cacheable names.
- Security headers are always on; HTTPS-only settings are enabled with `DOCUWEAVER_HTTPS=true` rather than commented out.
- README rewritten with install, configuration, usage, backup and upgrade guides.
- Page titles and navigation now say "DocuWeaver" instead of "PDF Alignment Tool".

### Fixed
- Fresh installs failed to migrate: migration `0013` depended on `0012_unique_constraints_and_indexes`, which had never been committed. It has been recreated.
- Debug scripts at the repository root (`test_export.py`, `test_roundtrip.py`, `check_pdf_size.py`) were collected by pytest and crashed against an empty database. Removed.
- CI referenced a `requirements-test.txt` that did not exist.

### Removed
- Unused dependencies `reportlab` and `django-cors-headers`.
- Empty `drawings/services/cadastre_service.py`.
