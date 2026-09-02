# DocuWeaver

DocuWeaver is a free, open-source web app for lining up multi-page PDF engineering drawings, stitching the sheets together on an interactive canvas, and overlaying geo-referenced assets loaded from CSV files. It runs on your own machine or server; no cloud account is needed and your drawings never leave your network.

Licensed under the [GNU AGPL v3 or later](LICENSE).

## Features

- **PDF upload and sheet splitting.** Upload a multi-page PDF and each page becomes a sheet you can position independently.
- **PDF layer (OCG) control.** Toggle the optional content layers embedded in CAD-exported PDFs.
- **Interactive canvas editor.** Pan, zoom, rotate, crop, cut and align sheets on a Fabric.js canvas, with undo.
- **CSV asset and link import.** Flexible column mapping, saved column presets, batch management, and polyline links between assets.
- **Coordinate systems.** Metres, WGS84 latitude/longitude, GDA94 geographic and GDA94 MGA.
- **Calibration.** Two-point scale calibration and reference-point anchoring so imported coordinates land in the right spot.
- **Measurement tool.** Distances and areas with named measurement sets.
- **Layer groups.** Organise sheets, assets and links into nested folders with per-group visibility.
- **OpenStreetMap basemap.** Optional map tiles underneath your drawings (needs internet access).
- **Export.** Composed sheets with overlays as PDF, adjustment reports, and a full project backup you can import on another machine.
- **Custom icons and dark mode.**

## Quick start

You need Python 3.10 or newer. Everything else is installed for you.

### Windows

1. Download or clone this repository.
2. Double-click `start.bat`.

The Windows launcher has had less testing than the Linux/macOS one; if it fails, follow the manual install steps below and open an issue.

### macOS / Linux

```bash
git clone https://github.com/NitroghostGH/DocuWeaver.git
cd DocuWeaver
./start.sh
```

The first run creates a virtual environment, installs dependencies, generates a `.env` file with a random secret key, sets up the database, and asks you to create the first user account. It then starts the server at <http://127.0.0.1:8000>. Later runs skip straight to starting the server.

To let colleagues on your network use it, edit `.env`:

```ini
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1,my-pc-name,192.168.1.20
DJANGO_CSRF_TRUSTED_ORIGINS=http://my-pc-name:8000,http://192.168.1.20:8000
DOCUWEAVER_HOST=0.0.0.0
```

### Docker

```bash
cp .env.example .env            # set DJANGO_SECRET_KEY (and optionally DOCUWEAVER_ADMIN_USER / _PASSWORD)
docker compose up -d
```

Data lives in the `docuweaver-data` volume. If you set `DOCUWEAVER_ADMIN_USER` and `DOCUWEAVER_ADMIN_PASSWORD`, that account is created on first start; otherwise run `docker compose exec docuweaver python manage.py createsuperuser`.

### Manual install

```bash
python -m venv .venv
source .venv/bin/activate         # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env              # then set DJANGO_SECRET_KEY
python manage.py migrate
python manage.py createsuperuser
python manage.py serve            # production server (Waitress)
```

Use `python manage.py runserver` with `DJANGO_DEBUG=true` for development.

## Configuration

All settings are environment variables and can be placed in `.env`. See [`.env.example`](.env.example) for the annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `DJANGO_SECRET_KEY` | *(required)* | Signs sessions and CSRF tokens. Generate with `python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"`. |
| `DJANGO_DEBUG` | `false` | Detailed error pages. Development only. |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Hostnames/IPs the app may be reached on. |
| `DJANGO_CSRF_TRUSTED_ORIGINS` | *(empty)* | Origins allowed to POST, e.g. `http://my-pc:8000`. Needed for any host other than localhost. |
| `DOCUWEAVER_REQUIRE_LOGIN` | `true` | Require sign-in for every page and API call. Set to `false` for a single-user install on a trusted machine. |
| `DOCUWEAVER_DATA_DIR` | project folder | Where the SQLite database and uploads are stored. |
| `DOCUWEAVER_HTTPS` | `false` | Turn on secure cookies, HTTPS redirect and HSTS. Only when served over TLS. |
| `DOCUWEAVER_MAX_UPLOAD_MB` | `10` | Largest accepted upload. |
| `DOCUWEAVER_HOST` / `DOCUWEAVER_PORT` | `127.0.0.1` / `8000` | Bind address for `manage.py serve`. |
| `DJANGO_TIME_ZONE` | `UTC` | Timezone for displayed timestamps. |

### User accounts

Sign-in is required by default. Create accounts with `python manage.py createsuperuser` or from the Admin link in the navigation bar (staff users only). Every signed-in user can see and edit every project; DocuWeaver does not have per-project permissions.

### Network access

DocuWeaver works fully offline except for the optional OpenStreetMap basemap, which fetches tiles from `tile.openstreetmap.org` and `cartodb-basemaps-a.global.ssl.fastly.net` (dark mode) from the user's browser. Use of those tiles is subject to the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Usage overview

1. **Create a project** from the Projects page, then open the editor.
2. **Upload a PDF.** Each page becomes a sheet. Drag, rotate, crop and cut sheets until they line up.
3. **Calibrate.** Use the scale tool on a known dimension, then anchor a reference point with a known coordinate.
4. **Import assets** from CSV, mapping your columns to asset ID, type, X/Y (or lat/lon) and optional metadata. Save the mapping as a preset for next time.
5. **Verify and adjust.** Drag any asset to its true position; adjustments are logged and can be exported as a report.
6. **Export** composed sheets as PDF, or export the whole project (`.docuweaver` file) to move it to another machine.

## Backing up

Everything is in `DOCUWEAVER_DATA_DIR`: `db.sqlite3` plus the `media/` folder. Copy both to back up, or use *Export project* from the Projects page for a single portable file per project.

## Upgrading

```bash
git pull
./start.sh          # or start.bat, or: pip install -r requirements.txt && python manage.py migrate
```

Docker: `docker compose build && docker compose up -d`. Migrations run automatically on start.

## Development

```bash
pip install -r requirements-dev.txt
pytest                     # test suite
ruff check .               # lint
python manage.py makemigrations --check   # confirm migrations are up to date
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and conventions.

## Tech stack

| Component | Licence |
|---|---|
| [Django](https://www.djangoproject.com/) 5.2 LTS, [Django REST Framework](https://www.django-rest-framework.org/) | BSD |
| [PyMuPDF](https://pymupdf.readthedocs.io/) (PDF rendering) | AGPL-3.0 |
| [Pillow](https://python-pillow.org/) | MIT-CMU |
| [Fabric.js](http://fabricjs.com/) 5.3 (bundled in `static/js/vendor`) | MIT |
| [WhiteNoise](https://whitenoise.readthedocs.io/), [Waitress](https://docs.pylonsproject.org/projects/waitress/) | MIT, ZPL |
| SQLite | Public domain |

## Credits

DocuWeaver was created by [NitroghostGH](https://github.com/NitroghostGH) and [jpmarshTMR](https://github.com/jpmarshTMR). It was developed with the assistance of Claude by Anthropic.

## License

DocuWeaver is released under the GNU Affero General Public License, version 3 or later. See [LICENSE](LICENSE).

The AGPL was chosen because DocuWeaver depends on PyMuPDF, which is itself AGPL-licensed. You may use, modify and self-host DocuWeaver freely; if you distribute a modified version or offer it to others over a network, you must make your modified source available under the same licence.
