"""Browser tests: headless Chromium against a real DocuWeaver server.

The server runs the way a default install does: ``manage.py serve``
(Waitress, collected static files) with DEBUG off and sign-in on, against a
throwaway data directory. Several past bugs only showed with those settings.

Run:      pytest browser_tests
Install:  pip install -r requirements-browser.txt
          python -m playwright install --only-shell chromium

Every test fails if the page logged a JavaScript error, a request to the
server failed or returned 4xx/5xx, or an alert reported an error. On a
failure a screenshot is saved in browser-test-artifacts/ (or
$BROWSER_TEST_ARTIFACTS), next to the server log.
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover - only without the optional install
    raise ImportError(
        'The browser tests need Playwright: pip install -r requirements-browser.txt, '
        'then python -m playwright install --only-shell chromium') from None

from . import drawing

REPO = Path(__file__).resolve().parent.parent
ARTIFACTS = Path(os.environ.get('BROWSER_TEST_ARTIFACTS', REPO / 'browser-test-artifacts'))
USERNAME, PASSWORD = 'tester', 'browser-test-pass-123'
VIEWPORT = {'width': 1600, 'height': 1000}

# Alerts that mean something went wrong. The rest (import summaries, "Sheet
# split successfully") are the app's normal way of reporting; their
# "0 errors" / "Errors: 0" lines are removed before matching.
ERROR_ALERT = re.compile(r'error|could not|failed|missing', re.IGNORECASE)
NO_ERRORS = re.compile(r'\b0 errors\b|\berrors: 0\b', re.IGNORECASE)


def _free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


@pytest.fixture(scope='session')
def server(tmp_path_factory):
    """Base URL of a fresh server, with one user (USERNAME / PASSWORD)."""
    data = tmp_path_factory.mktemp('dw-data')
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith(('DJANGO_', 'DOCUWEAVER_'))}
    env.update({
        'DJANGO_SETTINGS_MODULE': 'docuweaver.settings',
        'DJANGO_SECRET_KEY': 'browser-tests-only-0123456789abcdefghijklmnopqrstuvwxyz',
        'DJANGO_DEBUG': 'false',
        'DOCUWEAVER_REQUIRE_LOGIN': 'true',
        'DOCUWEAVER_DATA_DIR': str(data),
        'DOCUWEAVER_HOST': '127.0.0.1',
        'DOCUWEAVER_PORT': str(port),
        'DJANGO_SUPERUSER_USERNAME': USERNAME,
        'DJANGO_SUPERUSER_PASSWORD': PASSWORD,
        'DJANGO_SUPERUSER_EMAIL': 'tester@example.com',
    })
    manage = [sys.executable, str(REPO / 'manage.py')]
    for args in (['migrate', '--noinput'], ['createsuperuser', '--noinput']):
        subprocess.run(manage + args, env=env, cwd=REPO, check=True, capture_output=True)

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    log_path = ARTIFACTS / 'server.log'
    with open(log_path, 'w') as log:
        proc = subprocess.Popen(manage + ['serve'], env=env, cwd=REPO,
                                stdout=log, stderr=subprocess.STDOUT)
        base = f'http://127.0.0.1:{port}'
        deadline = time.monotonic() + 90
        while True:
            try:
                urllib.request.urlopen(base + '/accounts/login/', timeout=2)
                break
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                if proc.poll() is not None or time.monotonic() > deadline:
                    proc.kill()
                    pytest.fail('The server did not start:\n' + log_path.read_text()[-3000:])
                time.sleep(0.25)
        yield base
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture(scope='session')
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def sign_in(page, base):
    page.goto(base + '/')
    page.fill('input[name=username]', USERNAME)
    page.fill('input[name=password]', PASSWORD)
    with page.expect_navigation():
        page.click('button:has-text("Sign in")')


@pytest.fixture(scope='session')
def signed_in_state(browser, server):
    context = browser.new_context()
    page = context.new_page()
    sign_in(page, server)
    assert page.url == server + '/', f'sign-in landed on {page.url}'
    state = context.storage_state()
    context.close()
    return state


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_makereport(item, call):
    report = yield
    setattr(item, 'rep_' + report.when, report)
    return report


class UI:
    """A browser page plus the helpers the tests share."""

    def __init__(self, page, base):
        self.page = page
        self.base = base
        self.problems = []
        self.dialogs = []
        self.info = []
        page.on('console', self._console)
        page.on('pageerror', lambda e: self.problems.append(f'page error: {e}'))
        page.on('response', self._response)
        page.on('requestfailed', self._request_failed)
        page.on('dialog', self._dialog)

    # ---- recording -------------------------------------------------------

    def _ours(self, url):
        return url.startswith(self.base)

    def _console(self, msg):
        if msg.type == 'info':
            self.info.append(msg.text)
        elif msg.type == 'error':
            url = (msg.location or {}).get('url', '')
            # A failed request is already reported, with its URL, by
            # _response; outside resources (map tiles) aren't ours to test.
            if 'Failed to load resource' in msg.text:
                return
            if url and not self._ours(url):
                return
            self.problems.append(f'console error: {msg.text}')

    def _response(self, response):
        if response.status >= 400 and self._ours(response.url):
            self.problems.append(f'{response.request.method} {response.url} -> {response.status}')

    def _request_failed(self, request):
        # Navigating away cancels requests still in flight; that's not a bug.
        if self._ours(request.url) and 'ERR_ABORTED' not in (request.failure or ''):
            self.problems.append(f'{request.method} {request.url} failed: {request.failure}')

    def _dialog(self, dialog):
        self.dialogs.append(dialog.message)
        if ERROR_ALERT.search(NO_ERRORS.sub('', dialog.message)):
            self.problems.append(f'alert: {dialog.message}')
        dialog.accept()

    # ---- server API --------------------------------------------------------

    def api(self, method, path, json_body=None, form=None, files=None, expect=None):
        """Call the API as the signed-in user. Returns (status, body).
        Fails on a status other than `expect` (by default, on any 4xx/5xx)."""
        token = next(c['value'] for c in self.page.context.cookies() if c['name'] == 'csrftoken')
        headers = {'X-CSRFToken': token}
        kwargs = {}
        if files:
            multipart = dict(form or {})
            for field, (name, data, mime) in files.items():
                multipart[field] = {'name': name, 'mimeType': mime, 'buffer': data}
            kwargs['multipart'] = multipart
        elif json_body is not None:
            headers['Content-Type'] = 'application/json'
            kwargs['data'] = json.dumps(json_body)
        response = self.page.request.fetch(self.base + path, method=method, headers=headers, **kwargs)
        ctype = response.headers.get('content-type', '')
        body = response.json() if ctype.startswith('application/json') else response.body()
        ok = response.status == expect if expect is not None else response.status < 400
        assert ok, f'{method} {path} -> {response.status}: {body!r:.300}'
        return response.status, body

    def new_project(self, name, csv='wgs84', calibrated=True, referenced=True):
        """A project with the test drawing and its nine valves, set up
        through the API. `csv` is 'wgs84', 'mga' or None (no assets).
        Returns {'id', 'sheet', 'assets': {asset_id: id}}."""
        _, project = self.api('POST', '/api/projects/', {'name': name}, expect=201)
        pid = project['id']
        self.api('POST', f'/api/projects/{pid}/sheets/', form={'name': 'DW-TEST-01'},
                 files={'pdf_file': ('DW-TEST-01.pdf', drawing.pdf_bytes(), 'application/pdf')})
        if calibrated:
            self.api('POST', f'/api/projects/{pid}/calibrate/',
                     {'pixel_distance': drawing.PX_PER_M, 'real_distance': 1}, expect=200)
        if csv == 'wgs84':
            data, mapping, unit = drawing.wgs84_csv(), drawing.WGS84_MAPPING, 'degrees'
        elif csv == 'mga':
            data, unit = drawing.mga_csv(), 'gda94_mga'
            mapping = {'asset_id': 'asset_id', 'asset_type': 'asset_type', 'x': 'x', 'y': 'y', 'name': 'name'}
        if csv:
            self.api('POST', f'/api/projects/{pid}/import-csv/', form={'column_mapping': json.dumps(mapping)},
                     files={'file': ('valves.csv', data, 'text/csv')}, expect=200)
        if csv and referenced:
            x, y = drawing.pixel('V1')
            self.api('POST', f'/api/projects/{pid}/calibrate/',
                     {'ref_asset_id': 'V1', 'ref_pixel_x': x, 'ref_pixel_y': y, 'coord_unit': unit},
                     expect=200)
        _, sheets = self.api('GET', f'/api/projects/{pid}/sheets/', expect=200)
        _, assets = self.api('GET', f'/api/projects/{pid}/assets/', expect=200)
        return {'id': pid, 'sheet': sheets[0]['id'], 'assets': {a['asset_id']: a['id'] for a in assets}}

    # ---- editor ------------------------------------------------------------

    def open_editor(self, pid, markers=0):
        self.page.goto(f'{self.base}/project/{pid}/editor/')
        self.page.wait_for_function(
            """m => window.DocuWeaver && DocuWeaver.state.canvas &&
                   DocuWeaver.state.canvas.getObjects().some(o => o.sheetData && o._element) &&
                   DocuWeaver.state.canvas.getObjects().filter(o => o.assetData).length >= m""",
            arg=markers, timeout=30000)
        self.page.wait_for_load_state('networkidle')

    def tool(self, mode):
        self.page.click(f'.ftool-btn[data-mode="{mode}"]')

    def show(self, x, y, zoom=1.0):
        """Zoom to `zoom` with canvas point (x, y) at a whole-pixel spot near
        the canvas centre, and return that spot in page coordinates. A click
        there lands exactly on (x, y), so picks made through the UI are exact."""
        return self.page.evaluate("""([x, y, zoom]) => {
            const c = DocuWeaver.state.canvas;
            const r = c.upperCanvasEl.getBoundingClientRect();
            const sx = Math.round(r.left + c.getWidth() / 2), sy = Math.round(r.top + c.getHeight() / 2);
            c.setViewportTransform([zoom, 0, 0, zoom, sx - r.left - x * zoom, sy - r.top - y * zoom]);
            DocuWeaver.state.currentZoomLevel = zoom;
            window.currentZoomLevel = zoom;
            if (typeof updateMarkerScale === 'function') updateMarkerScale();
            c.requestRenderAll();
            return {x: sx, y: sy};
        }""", [x, y, zoom])

    def screen(self, x, y):
        """Page coordinates of canvas point (x, y) in the current view."""
        return self.page.evaluate("""([x, y]) => {
            const c = DocuWeaver.state.canvas;
            const p = fabric.util.transformPoint(new fabric.Point(x, y), c.viewportTransform);
            const r = c.upperCanvasEl.getBoundingClientRect();
            return {x: r.left + p.x, y: r.top + p.y};
        }""", [x, y])

    def drag(self, start, end, steps=8):
        """Drag with the left button between two page points."""
        self.page.mouse.move(start['x'], start['y'])
        self.page.mouse.down()
        self.page.mouse.move(end['x'], end['y'], steps=steps)
        self.page.mouse.up()

    def click_at(self, x, y, zoom=1.0):
        p = self.show(x, y, zoom)
        self.page.mouse.click(p['x'], p['y'])

    def markers(self):
        """{asset_id: (left, top)} for the markers on the canvas."""
        pairs = self.page.evaluate("""() => DocuWeaver.state.canvas.getObjects()
            .filter(o => o.assetData).map(o => [o.assetData.asset_id, [o.left, o.top]])""")
        return {k: tuple(v) for k, v in pairs}

    def sheet_object(self, sheet_id):
        return self.page.evaluate("""id => {
            const o = DocuWeaver.state.canvas.getObjects().find(o => o.sheetData && o.sheetData.id === id);
            return o ? {left: o.left, top: o.top, angle: o.angle} : null;
        }""", sheet_id)

    def undo(self):
        # Ctrl+Z in a text box is the browser's own text undo, so leave it first
        self.page.evaluate('() => document.activeElement && document.activeElement.blur()')
        self.page.keyboard.press('Control+z')


def _browser_page(request, browser, server, storage_state):
    context = browser.new_context(viewport=VIEWPORT, accept_downloads=True, storage_state=storage_state)
    page = context.new_page()
    page.set_default_timeout(15000)
    helper = UI(page, server)
    yield helper

    failed = getattr(request.node, 'rep_call', None) is not None and request.node.rep_call.failed
    if failed or helper.problems:
        ARTIFACTS.mkdir(parents=True, exist_ok=True)
        name = re.sub(r'[^\w.-]+', '_', request.node.name)
        try:
            page.screenshot(path=str(ARTIFACTS / f'{name}.png'))
        except Exception:  # noqa: BLE001 - a screenshot is best effort
            pass
        (ARTIFACTS / f'{name}.txt').write_text('\n'.join(
            ['problems:'] + helper.problems + ['', 'alerts:'] + helper.dialogs + ['', 'info:'] + helper.info))
    context.close()
    if helper.problems and not failed:
        pytest.fail('The browser reported problems:\n  ' + '\n  '.join(helper.problems))


@pytest.fixture
def ui(request, browser, server, signed_in_state):
    """A page in a browser that is signed in."""
    yield from _browser_page(request, browser, server, signed_in_state)


@pytest.fixture
def guest_ui(request, browser, server):
    """A page in a browser that has not signed in."""
    yield from _browser_page(request, browser, server, None)
