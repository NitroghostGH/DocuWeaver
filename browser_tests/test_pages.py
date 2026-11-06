"""Sign-in, the project list and the Details page, used through their forms."""
from urllib.parse import urljoin

from . import drawing


def test_sign_in_create_a_project_upload_a_pdf_and_import_assets(guest_ui):
    page, base = guest_ui.page, guest_ui.base

    page.goto(base + '/')
    assert '/accounts/login/' in page.url, 'signed-out visitors should get the sign-in page'
    page.fill('input[name=username]', 'tester')
    page.fill('input[name=password]', 'browser-test-pass-123')
    with page.expect_navigation():
        page.click('button:has-text("Sign in")')
    assert page.url == base + '/'

    # New Project on the list page (its form once failed with "CSRF token missing")
    page.click('text=+ New Project')
    page.fill('#createForm input[name=name]', 'Pages check')
    with page.expect_navigation():
        page.click('#createForm button[type=submit]')
    row = page.locator('tr', has_text='Pages check')
    with page.expect_navigation():
        row.locator('a', has_text='Details').click()
    pid = int(page.url.rstrip('/').split('/')[-1])

    # Upload PDF on the Details page
    page.click('text=+ Upload PDF')
    page.fill('#uploadForm input[name=name]', 'DW-TEST-01')
    page.set_input_files('#uploadForm input[name=pdf_file]', files=[
        {'name': 'DW-TEST-01.pdf', 'mimeType': 'application/pdf', 'buffer': drawing.pdf_bytes()}])
    with page.expect_navigation(timeout=60000):
        page.click('#uploadForm button[type=submit]')
    _, sheets = guest_ui.api('GET', f'/api/projects/{pid}/sheets/')
    assert len(sheets) == 1
    # The test drawing's pixel positions assume the server's 150 DPI render
    assert (sheets[0]['image_width'], sheets[0]['image_height']) == drawing.IMAGE_SIZE
    image = page.request.get(urljoin(base, sheets[0]['rendered_image_url']))
    assert image.ok and image.body()[:4] == b'\x89PNG'

    # Import CSV on the Details page
    page.click('text=+ Import CSV')
    page.set_input_files('#importForm input[name=file]', files=[
        {'name': 'valves.csv', 'mimeType': 'text/csv', 'buffer': drawing.mga_csv()}])
    with page.expect_navigation(timeout=60000):
        page.click('#importForm button[type=submit]')
    assert any('9 created' in d for d in guest_ui.dialogs), guest_ui.dialogs
    _, assets = guest_ui.api('GET', f'/api/projects/{pid}/assets/')
    assert sorted(a['asset_id'] for a in assets) == sorted(drawing.VALVES)

    # Sign out (a POST form since Django 5)
    with page.expect_navigation():
        page.click('button:has-text("Sign out")')
    page.goto(base + '/')
    assert '/accounts/login/' in page.url

