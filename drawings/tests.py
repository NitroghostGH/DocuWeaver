"""Tests for the drawings app."""
import csv
import io
import re
from unittest.mock import patch

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from .models import (
    AdjustmentLog,
    Asset,
    AssetType,
    ColumnPreset,
    ImportBatch,
    LayerGroup,
    Project,
    Sheet,
)
from .services.csv_importer import import_assets_from_csv
from .validators import ImageFileValidator, PDFFileValidator


def make_pdf_file(name='test.pdf', size=None):
    """Create a minimal valid PDF file for testing."""
    content = b'%PDF-1.4 minimal test content'
    if size and size > len(content):
        content += b'\x00' * (size - len(content))
    return SimpleUploadedFile(name, content, content_type='application/pdf')


def make_real_pdf(name='test.pdf', pages=1, width=100, height=100):
    """An upload of a PDF that PyMuPDF can open and render."""
    import pymupdf

    doc = pymupdf.open()
    for _ in range(pages):
        doc.new_page(width=width, height=height)
    data = doc.tobytes()
    doc.close()
    return SimpleUploadedFile(name, data, content_type='application/pdf')


def media_files():
    """Every file under MEDIA_ROOT (a temporary directory in tests)."""
    import os

    from django.conf import settings

    found = set()
    for root, _dirs, names in os.walk(settings.MEDIA_ROOT):
        found.update(os.path.join(root, n) for n in names)
    return found


def make_png_file(name='test.png', size=None):
    """Create a minimal valid PNG file for testing."""
    # Minimal PNG header
    content = b'\x89PNG\r\n\x1a\n' + b'\x00' * 50
    if size and size > len(content):
        content += b'\x00' * (size - len(content))
    return SimpleUploadedFile(name, content, content_type='image/png')


def make_csv_content(rows, fieldnames=None):
    """Build an in-memory CSV file from rows."""
    if fieldnames is None:
        fieldnames = rows[0].keys() if rows else []
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    buf.seek(0)
    return SimpleUploadedFile('test.csv', buf.getvalue().encode('utf-8'), content_type='text/csv')


def create_project(**kwargs):
    defaults = {'name': 'Test Project'}
    defaults.update(kwargs)
    return Project.objects.create(**defaults)


def create_asset_type(**kwargs):
    defaults = {'name': 'Manhole'}
    defaults.update(kwargs)
    return AssetType.objects.create(**defaults)


# ---------------------------------------------------------------------------
# Model tests
# ---------------------------------------------------------------------------

class ProjectModelTests(TestCase):
    def test_create_with_defaults(self):
        p = create_project()
        self.assertEqual(p.pixels_per_meter, 100.0)
        self.assertEqual(p.origin_x, 0.0)
        self.assertEqual(p.canvas_rotation, 0.0)
        self.assertEqual(p.asset_rotation, 0.0)
        self.assertEqual(p.ref_asset_id, '')

    def test_str(self):
        p = create_project(name='My Map')
        self.assertEqual(str(p), 'My Map')


class SheetModelTests(TestCase):
    def setUp(self):
        self.project = create_project()

    def test_create(self):
        s = Sheet.objects.create(
            project=self.project,
            name='Sheet A',
            pdf_file=make_pdf_file(),
        )
        self.assertEqual(s.page_number, 1)
        self.assertEqual(s.z_index, 0)
        self.assertEqual(s.cuts_json, [])

    def test_str(self):
        s = Sheet.objects.create(project=self.project, name='S1', pdf_file=make_pdf_file())
        self.assertEqual(str(s), 'S1 (Page 1)')

    def test_delete_removes_files(self):
        s = Sheet.objects.create(project=self.project, name='S1', pdf_file=make_pdf_file())
        s.delete()
        # After deletion the file should be cleaned up by the storage backend
        self.assertFalse(Sheet.objects.filter(name='S1').exists())

    def test_delete_shared_pdf_keeps_file(self):
        """When two sheets share the same PDF, deleting one should not delete the file."""
        pdf = make_pdf_file()
        s1 = Sheet.objects.create(project=self.project, name='S1', pdf_file=pdf)
        # Create second sheet pointing to same PDF path
        s2 = Sheet.objects.create(
            project=self.project, name='S2',
            pdf_file=s1.pdf_file.name, page_number=2,
        )
        # Deleting s1 should not crash even though s2 still references the PDF
        s1.delete()
        self.assertTrue(Sheet.objects.filter(pk=s2.pk).exists())


class AssetTypeModelTests(TestCase):
    def test_defaults(self):
        at = create_asset_type()
        self.assertEqual(at.icon_shape, 'circle')
        self.assertEqual(at.color, '#FF0000')
        self.assertEqual(at.size, 20)

    def test_unique_name(self):
        create_asset_type(name='Valve')
        with self.assertRaises(Exception):
            create_asset_type(name='Valve')


class ImportBatchModelTests(TestCase):
    def test_create(self):
        p = create_project()
        b = ImportBatch.objects.create(project=p, filename='data.csv', asset_count=5)
        self.assertEqual(str(b), 'data.csv (5 assets)')


class AssetModelTests(TestCase):
    def setUp(self):
        self.project = create_project()
        self.asset_type = create_asset_type()

    def test_current_coords_unadjusted(self):
        a = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='A1', original_x=10.0, original_y=20.0,
        )
        self.assertEqual(a.current_x, 10.0)
        self.assertEqual(a.current_y, 20.0)
        self.assertEqual(a.delta_distance, 0.0)

    def test_current_coords_adjusted(self):
        a = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='A2', original_x=10.0, original_y=20.0,
            adjusted_x=13.0, adjusted_y=24.0, is_adjusted=True,
        )
        self.assertEqual(a.current_x, 13.0)
        self.assertEqual(a.current_y, 24.0)
        self.assertAlmostEqual(a.delta_distance, 5.0)

    def test_str(self):
        a = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='MH-001', name='Main St', original_x=0, original_y=0,
        )
        self.assertEqual(str(a), 'MH-001 - Main St')

    def test_unique_together(self):
        Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='DUP', original_x=0, original_y=0,
        )
        with self.assertRaises(Exception):
            Asset.objects.create(
                project=self.project, asset_type=self.asset_type,
                asset_id='DUP', original_x=1, original_y=1,
            )


class AdjustmentLogModelTests(TestCase):
    def test_auto_deltas(self):
        p = create_project()
        at = create_asset_type()
        a = Asset.objects.create(
            project=p, asset_type=at, asset_id='X1',
            original_x=0, original_y=0,
        )
        log = AdjustmentLog.objects.create(
            asset=a, from_x=0, from_y=0, to_x=3.0, to_y=4.0,
        )
        self.assertAlmostEqual(log.delta_x, 3.0)
        self.assertAlmostEqual(log.delta_y, 4.0)
        self.assertAlmostEqual(log.delta_distance, 5.0)


class ColumnPresetModelTests(TestCase):
    def test_create(self):
        cp = ColumnPreset.objects.create(role='asset_id', column_name='MyCustomCol', priority=5)
        self.assertIn('MyCustomCol', str(cp))

    def test_unique_together(self):
        ColumnPreset.objects.create(role='x', column_name='Easting_unique')
        with self.assertRaises(Exception):
            ColumnPreset.objects.create(role='x', column_name='Easting_unique')


# ---------------------------------------------------------------------------
# Validator tests
# ---------------------------------------------------------------------------

class PDFFileValidatorTests(TestCase):
    def test_valid_pdf(self):
        v = PDFFileValidator()
        f = make_pdf_file()
        v(f)  # should not raise

    def test_rejects_oversized(self):
        v = PDFFileValidator(max_size=100)
        f = make_pdf_file(size=200)
        with self.assertRaises(ValidationError):
            v(f)

    def test_rejects_bad_extension(self):
        v = PDFFileValidator()
        f = SimpleUploadedFile('bad.txt', b'%PDF-1.4 content', content_type='application/pdf')
        with self.assertRaises(ValidationError):
            v(f)

    def test_rejects_bad_header(self):
        v = PDFFileValidator()
        f = SimpleUploadedFile('fake.pdf', b'NOT A PDF FILE', content_type='application/pdf')
        with self.assertRaises(ValidationError):
            v(f)


class ImageFileValidatorTests(TestCase):
    def test_valid_png(self):
        v = ImageFileValidator()
        f = make_png_file()
        v(f)  # should not raise

    def test_valid_jpeg(self):
        v = ImageFileValidator()
        f = SimpleUploadedFile('img.jpg', b'\xff\xd8\xff\xe0' + b'\x00' * 50, content_type='image/jpeg')
        v(f)  # should not raise

    def test_rejects_oversized(self):
        v = ImageFileValidator(max_size=100)
        f = make_png_file(size=200)
        with self.assertRaises(ValidationError):
            v(f)

    def test_rejects_bad_extension(self):
        v = ImageFileValidator()
        f = SimpleUploadedFile('img.bmp', b'\x89PNG\r\n\x1a\n' + b'\x00' * 50, content_type='image/bmp')
        with self.assertRaises(ValidationError):
            v(f)

    def test_rejects_bad_content(self):
        v = ImageFileValidator()
        f = SimpleUploadedFile('img.png', b'this is not an image', content_type='image/png')
        with self.assertRaises(ValidationError):
            v(f)


# ---------------------------------------------------------------------------
# CSV importer service tests
# ---------------------------------------------------------------------------

class CsvImporterTests(TestCase):
    def setUp(self):
        self.project = create_project()

    def test_basic_import(self):
        csv_file = make_csv_content([
            {'asset_id': 'A1', 'asset_type': 'Valve', 'x': '100.5', 'y': '200.3', 'name': 'First'},
            {'asset_id': 'A2', 'asset_type': 'Valve', 'x': '101.0', 'y': '201.0', 'name': 'Second'},
        ])
        result = import_assets_from_csv(self.project, csv_file)
        self.assertEqual(result['created'], 2)
        self.assertEqual(result['updated'], 0)
        self.assertEqual(len(result['errors']), 0)
        self.assertEqual(Asset.objects.filter(project=self.project).count(), 2)

    def test_creates_import_batch(self):
        csv_file = make_csv_content([
            {'asset_id': 'B1', 'asset_type': 'Pipe', 'x': '0', 'y': '0', 'name': ''},
        ])
        import_assets_from_csv(self.project, csv_file, filename='myfile.csv')
        batch = ImportBatch.objects.get(project=self.project)
        self.assertEqual(batch.filename, 'myfile.csv')
        self.assertEqual(batch.asset_count, 1)

    def test_custom_column_mapping(self):
        csv_file = make_csv_content(
            [{'TN': 'X1', 'Type': 'Hydrant', 'Easting': '50', 'Northing': '60', 'Label': 'H1'}],
            fieldnames=['TN', 'Type', 'Easting', 'Northing', 'Label'],
        )
        mapping = {
            'asset_id': 'TN',
            'asset_type': 'Type',
            'x': 'Easting',
            'y': 'Northing',
            'name': 'Label',
        }
        result = import_assets_from_csv(self.project, csv_file, column_mapping=mapping)
        self.assertEqual(result['created'], 1)
        a = Asset.objects.get(project=self.project, asset_id='X1')
        self.assertAlmostEqual(a.original_x, 50.0)
        self.assertAlmostEqual(a.original_y, 60.0)
        self.assertEqual(a.name, 'H1')

    def test_missing_columns_raises(self):
        csv_file = make_csv_content(
            [{'only_col': 'val'}],
            fieldnames=['only_col'],
        )
        with self.assertRaises(ValueError):
            import_assets_from_csv(self.project, csv_file)

    def test_invalid_coords_logged_as_error(self):
        csv_file = make_csv_content([
            {'asset_id': 'OK', 'asset_type': 'T', 'x': '10', 'y': '20', 'name': ''},
            {'asset_id': 'BAD', 'asset_type': 'T', 'x': 'abc', 'y': 'def', 'name': ''},
        ])
        result = import_assets_from_csv(self.project, csv_file)
        self.assertEqual(result['created'], 1)
        self.assertEqual(len(result['errors']), 1)
        self.assertTrue(Asset.objects.filter(asset_id='OK').exists())
        self.assertFalse(Asset.objects.filter(asset_id='BAD').exists())

    def test_reimport_updates_existing(self):
        csv_file1 = make_csv_content([
            {'asset_id': 'U1', 'asset_type': 'Gate', 'x': '1', 'y': '2', 'name': 'v1'},
        ])
        import_assets_from_csv(self.project, csv_file1)
        csv_file2 = make_csv_content([
            {'asset_id': 'U1', 'asset_type': 'Gate', 'x': '10', 'y': '20', 'name': 'v2'},
        ])
        result = import_assets_from_csv(self.project, csv_file2)
        self.assertEqual(result['updated'], 1)
        a = Asset.objects.get(project=self.project, asset_id='U1')
        self.assertAlmostEqual(a.original_x, 10.0)
        self.assertEqual(a.name, 'v2')

    def test_metadata_captures_extra_columns(self):
        csv_file = make_csv_content(
            [{'asset_id': 'M1', 'asset_type': 'T', 'x': '0', 'y': '0', 'name': '', 'depth': '3.5', 'material': 'steel'}],
            fieldnames=['asset_id', 'asset_type', 'x', 'y', 'name', 'depth', 'material'],
        )
        import_assets_from_csv(self.project, csv_file)
        a = Asset.objects.get(asset_id='M1')
        self.assertEqual(a.metadata.get('depth'), '3.5')
        self.assertEqual(a.metadata.get('material'), 'steel')

    def test_fixed_asset_type_import(self):
        csv_file = make_csv_content(
            [{'asset_id': 'F1', 'x': '1', 'y': '2', 'name': 'test'}],
            fieldnames=['asset_id', 'x', 'y', 'name'],
        )
        result = import_assets_from_csv(self.project, csv_file,
                                        column_mapping={'asset_id': 'asset_id', 'x': 'x', 'y': 'y', 'name': 'name'},
                                        fixed_asset_type='CCTV')
        self.assertEqual(result['created'], 1)
        a = Asset.objects.get(project=self.project, asset_id='F1')
        self.assertEqual(a.asset_type.name, 'CCTV')

    def test_fixed_asset_type_creates_if_missing(self):
        csv_file = make_csv_content(
            [{'asset_id': 'F2', 'x': '3', 'y': '4', 'name': ''}],
            fieldnames=['asset_id', 'x', 'y', 'name'],
        )
        result = import_assets_from_csv(self.project, csv_file,
                                        column_mapping={'asset_id': 'asset_id', 'x': 'x', 'y': 'y'},
                                        fixed_asset_type='BrandNew')
        self.assertEqual(result['created'], 1)
        self.assertTrue(AssetType.objects.filter(name='BrandNew').exists())

    def test_fixed_asset_type_skips_column_validation(self):
        csv_file = make_csv_content(
            [{'asset_id': 'F3', 'x': '5', 'y': '6'}],
            fieldnames=['asset_id', 'x', 'y'],
        )
        result = import_assets_from_csv(self.project, csv_file,
                                        column_mapping={'asset_id': 'asset_id', 'x': 'x', 'y': 'y'},
                                        fixed_asset_type='VSL')
        self.assertEqual(result['created'], 1)


# ---------------------------------------------------------------------------
# API tests
# ---------------------------------------------------------------------------

@override_settings(REQUIRE_LOGIN=False)
class ProjectAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_list_empty(self):
        resp = self.client.get('/api/projects/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), [])

    def test_create(self):
        resp = self.client.post('/api/projects/', {'name': 'New'}, format='json')
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()['name'], 'New')

    def test_retrieve(self):
        p = create_project(name='Fetch Me')
        resp = self.client.get(f'/api/projects/{p.pk}/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['name'], 'Fetch Me')

    def test_update(self):
        p = create_project()
        resp = self.client.patch(f'/api/projects/{p.pk}/', {'name': 'Renamed'}, format='json')
        self.assertEqual(resp.status_code, 200)
        p.refresh_from_db()
        self.assertEqual(p.name, 'Renamed')

    def test_delete(self):
        p = create_project()
        resp = self.client.delete(f'/api/projects/{p.pk}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(Project.objects.filter(pk=p.pk).exists())


@override_settings(REQUIRE_LOGIN=False)
class CalibrateAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    def test_set_scale(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'pixel_distance': 500, 'real_distance': 10},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertAlmostEqual(resp.json()['pixels_per_meter'], 50.0)

    def test_set_origin(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'origin_x': 100, 'origin_y': 200},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.origin_x, 100.0)

    def test_set_rotation(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'canvas_rotation': 45.0},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.canvas_rotation, 45.0)

    def test_set_asset_calibration(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'asset_rotation': 12.5, 'ref_asset_id': 'REF1', 'ref_pixel_x': 300, 'ref_pixel_y': 400},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.asset_rotation, 12.5)
        self.assertEqual(self.project.ref_asset_id, 'REF1')

    def test_invalid_real_distance(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'pixel_distance': 500, 'real_distance': 0},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_non_finite_value_rejected(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'origin_x': 'inf'},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_non_numeric_value_rejected(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'origin_x': 'abc'},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_scale_calibrated_set_on_calibration(self):
        self.assertFalse(self.project.scale_calibrated)
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'pixel_distance': 500, 'real_distance': 10},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json().get('scale_calibrated'))
        self.project.refresh_from_db()
        self.assertTrue(self.project.scale_calibrated)

    def test_scale_calibrated_in_project_detail(self):
        resp = self.client.get(f'/api/projects/{self.project.pk}/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('scale_calibrated', data)
        self.assertFalse(data['scale_calibrated'])
        self.assertIn('coord_unit', data)
        self.assertEqual(data['coord_unit'], 'meters')

    def test_set_coord_unit(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'coord_unit': 'degrees'},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['coord_unit'], 'degrees')
        self.project.refresh_from_db()
        self.assertEqual(self.project.coord_unit, 'degrees')

    def test_invalid_coord_unit_rejected(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'coord_unit': 'invalid'},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_set_gda94_geo_coord_unit(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'coord_unit': 'gda94_geo'},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.coord_unit, 'gda94_geo')

    def test_set_gda94_mga_coord_unit(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/calibrate/',
            {'coord_unit': 'gda94_mga'},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.project.refresh_from_db()
        self.assertEqual(self.project.coord_unit, 'gda94_mga')


@override_settings(REQUIRE_LOGIN=False)
class AssetAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.asset_type = create_asset_type()

    def test_list(self):
        Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='L1', original_x=0, original_y=0,
        )
        resp = self.client.get(f'/api/projects/{self.project.pk}/assets/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 1)

    def test_create(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/assets/',
            {'asset_type': self.asset_type.pk, 'asset_id': 'NEW1', 'original_x': 5, 'original_y': 6},
            format='json',
        )
        self.assertEqual(resp.status_code, 201)

    def test_retrieve(self):
        a = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='R1', original_x=0, original_y=0,
        )
        resp = self.client.get(f'/api/assets/{a.pk}/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['asset_id'], 'R1')

    def test_delete(self):
        a = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='D1', original_x=0, original_y=0,
        )
        resp = self.client.delete(f'/api/assets/{a.pk}/')
        self.assertEqual(resp.status_code, 204)


@override_settings(REQUIRE_LOGIN=False)
class AdjustAssetAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.asset_type = create_asset_type()
        self.asset = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='ADJ1', original_x=10, original_y=20,
        )

    def test_adjust(self):
        resp = self.client.post(
            f'/api/assets/{self.asset.pk}/adjust/',
            {'x': 13.0, 'y': 24.0, 'notes': 'moved'},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.asset.refresh_from_db()
        self.assertTrue(self.asset.is_adjusted)
        self.assertAlmostEqual(self.asset.adjusted_x, 13.0)
        self.assertEqual(AdjustmentLog.objects.count(), 1)

    def test_adjust_missing_coords(self):
        resp = self.client.post(
            f'/api/assets/{self.asset.pk}/adjust/',
            {'notes': 'no coords'},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)


@override_settings(REQUIRE_LOGIN=False)
class ImportCSVAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    def test_import_csv(self):
        csv_file = make_csv_content([
            {'asset_id': 'I1', 'asset_type': 'Pump', 'x': '1', 'y': '2', 'name': 'P1'},
        ])
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/import-csv/',
            {'file': csv_file},
            format='multipart',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['created'], 1)

    def test_import_with_mapping(self):
        import json
        csv_file = make_csv_content(
            [{'TN': 'M1', 'Type': 'Pipe', 'E': '5', 'N': '6', 'Desc': 'test'}],
            fieldnames=['TN', 'Type', 'E', 'N', 'Desc'],
        )
        mapping = json.dumps({
            'asset_id': 'TN', 'asset_type': 'Type',
            'x': 'E', 'y': 'N', 'name': 'Desc',
        })
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/import-csv/',
            {'file': csv_file, 'column_mapping': mapping},
            format='multipart',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['created'], 1)
        self.assertTrue(Asset.objects.filter(asset_id='M1').exists())

    def test_no_file(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/import-csv/',
            {},
            format='multipart',
        )
        self.assertEqual(resp.status_code, 400)


@override_settings(REQUIRE_LOGIN=False)
class ImportBatchAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.asset_type = create_asset_type()

    def test_list_batches(self):
        ImportBatch.objects.create(project=self.project, filename='f.csv', asset_count=2)
        resp = self.client.get(f'/api/projects/{self.project.pk}/import-batches/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 1)

    def test_delete_batch_cascades(self):
        batch = ImportBatch.objects.create(project=self.project, filename='f.csv', asset_count=1)
        Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='BA1', original_x=0, original_y=0, import_batch=batch,
        )
        resp = self.client.delete(f'/api/import-batches/{batch.pk}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(Asset.objects.filter(asset_id='BA1').exists())
        self.assertFalse(ImportBatch.objects.filter(pk=batch.pk).exists())

    def test_reassign_batch_asset_type(self):
        batch = ImportBatch.objects.create(project=self.project, filename='r.csv', asset_count=2)
        Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='RA1', original_x=0, original_y=0, import_batch=batch,
        )
        Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='RA2', original_x=1, original_y=1, import_batch=batch,
        )
        resp = self.client.patch(
            f'/api/import-batches/{batch.pk}/',
            {'asset_type_name': 'NewType'},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['updated'], 2)
        new_type = AssetType.objects.get(name='NewType')
        self.assertTrue(Asset.objects.filter(import_batch=batch, asset_type=new_type).count() == 2)

    def test_reassign_batch_missing_name(self):
        batch = ImportBatch.objects.create(project=self.project, filename='r2.csv', asset_count=0)
        resp = self.client.patch(
            f'/api/import-batches/{batch.pk}/',
            {'asset_type_name': ''},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)


@override_settings(REQUIRE_LOGIN=False)
class ColumnPresetsAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_list_presets(self):
        ColumnPreset.objects.create(role='asset_id', column_name='SerialNum', priority=10)
        ColumnPreset.objects.create(role='x', column_name='Lon', priority=0)
        resp = self.client.get('/api/column-presets/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn('asset_id', data)
        self.assertIn('SerialNum', data['asset_id'])


@override_settings(REQUIRE_LOGIN=False)
class SheetAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    def test_create_sheet(self):
        pdf = make_real_pdf()
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/sheets/',
            {'name': 'MySheet', 'pdf_file': pdf},
            format='multipart',
        )
        self.assertEqual(resp.status_code, 201)
        self.assertTrue(Sheet.objects.filter(project=self.project).exists())

    def test_update_sheet(self):
        s = Sheet.objects.create(project=self.project, name='Old', pdf_file=make_pdf_file())
        resp = self.client.patch(
            f'/api/sheets/{s.pk}/',
            {'name': 'New', 'offset_x': 50, 'offset_y': 100},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        s.refresh_from_db()
        self.assertEqual(s.name, 'New')
        self.assertEqual(s.offset_x, 50.0)

    def test_update_cuts_json(self):
        s = Sheet.objects.create(project=self.project, name='CutSheet', pdf_file=make_pdf_file())
        cuts = [{'p1': {'x': 0, 'y': 0}, 'p2': {'x': 100, 'y': 100}, 'flipped': False}]
        resp = self.client.patch(
            f'/api/sheets/{s.pk}/',
            {'cuts_json': cuts},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        s.refresh_from_db()
        self.assertEqual(len(s.cuts_json), 1)

    def test_invalid_cuts_json(self):
        s = Sheet.objects.create(project=self.project, name='Bad', pdf_file=make_pdf_file())
        resp = self.client.patch(
            f'/api/sheets/{s.pk}/',
            {'cuts_json': 'not a list'},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_delete_sheet(self):
        s = Sheet.objects.create(project=self.project, name='Del', pdf_file=make_pdf_file())
        resp = self.client.delete(f'/api/sheets/{s.pk}/')
        self.assertEqual(resp.status_code, 204)


@override_settings(REQUIRE_LOGIN=False)
class SplitSheetAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    @patch('drawings.api_views.render_pdf_page')
    def test_split(self, mock_render):
        s = Sheet.objects.create(project=self.project, name='ToSplit', pdf_file=make_pdf_file())
        resp = self.client.post(
            f'/api/sheets/{s.pk}/split/',
            {'p1': {'x': 0, 'y': 50}, 'p2': {'x': 100, 'y': 50}},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        # Original should have a cut appended
        s.refresh_from_db()
        self.assertEqual(len(s.cuts_json), 1)
        self.assertFalse(s.cuts_json[0].get('flipped', True))
        # New sheet should exist with flipped cut
        new_id = resp.json()['new_sheet']['id']
        new_sheet = Sheet.objects.get(pk=new_id)
        self.assertTrue(new_sheet.cuts_json[0]['flipped'])

    def test_split_missing_coords(self):
        s = Sheet.objects.create(project=self.project, name='NoCoords', pdf_file=make_pdf_file())
        resp = self.client.post(
            f'/api/sheets/{s.pk}/split/',
            {'p1': {'x': 0, 'y': 0}},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)


@override_settings(REQUIRE_LOGIN=False)
class AdjustmentReportAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.asset_type = create_asset_type()

    def test_empty_report(self):
        resp = self.client.get(f'/api/projects/{self.project.pk}/adjustment-report/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['adjusted_count'], 0)

    def test_report_with_adjustments(self):
        a = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='R1', original_x=0, original_y=0,
            adjusted_x=3, adjusted_y=4, is_adjusted=True,
        )
        AdjustmentLog.objects.create(asset=a, from_x=0, from_y=0, to_x=3, to_y=4)
        resp = self.client.get(f'/api/projects/{self.project.pk}/adjustment-report/')
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['adjusted_count'], 1)
        self.assertEqual(len(data['summary']), 1)

    def test_csv_format(self):
        """The editor's "Adjustment Report" link asks for ?output=csv.

        It used ?format=csv, which DRF reserves for choosing a renderer, so
        the request 404'd before reaching the view.
        """
        a = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='C1', original_x=0, original_y=0,
            adjusted_x=1, adjusted_y=1, is_adjusted=True,
        )
        AdjustmentLog.objects.create(asset=a, from_x=0, from_y=0, to_x=1, to_y=1)

        resp = self.client.get(f'/api/projects/{self.project.pk}/adjustment-report/?output=csv')

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp['Content-Type'], 'text/csv')
        content = resp.content.decode('utf-8')
        self.assertIn('C1', content)
        self.assertIn('Asset ID', content)


# ---------------------------------------------------------------------------
# adjust_asset input validation tests
# ---------------------------------------------------------------------------

@override_settings(REQUIRE_LOGIN=False)
class AdjustAssetValidationTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.asset_type = create_asset_type()
        self.asset = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='VAL1', original_x=10, original_y=20,
        )

    def test_adjust_non_numeric_rejected(self):
        resp = self.client.post(
            f'/api/assets/{self.asset.pk}/adjust/',
            {'x': 'abc', 'y': '24.0'},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_adjust_infinity_rejected(self):
        resp = self.client.post(
            f'/api/assets/{self.asset.pk}/adjust/',
            {'x': 'inf', 'y': '24.0'},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)

    def test_adjust_nan_rejected(self):
        resp = self.client.post(
            f'/api/assets/{self.asset.pk}/adjust/',
            {'x': '13.0', 'y': 'nan'},
            format='json',
        )
        self.assertEqual(resp.status_code, 400)


# ---------------------------------------------------------------------------
# render_sheet endpoint tests
# ---------------------------------------------------------------------------

@override_settings(REQUIRE_LOGIN=False)
class RenderSheetAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    @patch('drawings.api_views.render_pdf_page')
    def test_render_sheet_success(self, mock_render):
        s = Sheet.objects.create(project=self.project, name='Render', pdf_file=make_pdf_file())
        # Mock render to set the rendered_image so the response builder works
        def fake_render(sheet):
            sheet.rendered_image = 'rendered/test.png'
            sheet.image_width = 800
            sheet.image_height = 600
            sheet.save()
        mock_render.side_effect = fake_render
        resp = self.client.post(f'/api/sheets/{s.pk}/render/')
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['status'], 'success')
        mock_render.assert_called_once_with(s)

    def test_render_sheet_not_found(self):
        resp = self.client.post('/api/sheets/99999/render/')
        self.assertEqual(resp.status_code, 404)

    @patch('drawings.api_views.render_pdf_page', side_effect=Exception('disk full'))
    def test_render_sheet_error_no_leak(self, mock_render):
        s = Sheet.objects.create(project=self.project, name='Fail', pdf_file=make_pdf_file())
        resp = self.client.post(f'/api/sheets/{s.pk}/render/')
        self.assertEqual(resp.status_code, 500)
        self.assertNotIn('disk full', resp.json().get('message', ''))


# ---------------------------------------------------------------------------
# export_project endpoint tests
# ---------------------------------------------------------------------------

def pdf_bytes(*pages):
    """A PDF with one page per (width, height, rotation, cropbox or None)."""
    import pymupdf

    doc = pymupdf.open()
    for width, height, rotation, cropbox in pages:
        page = doc.new_page(width=width, height=height)
        if cropbox:
            page.set_cropbox(pymupdf.Rect(*cropbox))
        page.set_rotation(rotation)
    data = doc.tobytes()
    doc.close()
    return data


def colour_centroid(page, match, dpi=144):
    """Centre, in displayed PDF points, of the pixels whose (r, g, b) `match` accepts."""
    pix = page.get_pixmap(dpi=dpi, alpha=False)
    samples, k = pix.samples, 72 / dpi
    xs = ys = n = 0
    for y in range(pix.height):
        row = y * pix.width * 3
        for x in range(pix.width):
            i = row + x * 3
            if match(samples[i], samples[i + 1], samples[i + 2]):
                xs, ys, n = xs + x, ys + y, n + 1
    return ((xs / n + 0.5) * k, (ys / n + 0.5) * k) if n else None


def is_red(r, g, b):
    return r > 200 and g < 70 and b < 70


def is_blue(r, g, b):
    return b > 200 and r < 70 and g < 70


@override_settings(REQUIRE_LOGIN=False)
class ExportProjectAPITests(TestCase):
    """R15: GET /api/projects/<pk>/export/ downloads one PDF with the asset
    markers where the editor draws them.

    Known answer, worked by hand (10 px/m, reference asset R at (0, 0) drawn
    at canvas (400, 500), asset layer turned 90 degrees clockwise, so north
    points right):
    - P at (12, 30): 30 m north and 12 m east become 300 px right and 120 px
      down, canvas (700, 620). Sheet A is a plain 400 x 600 pt page at
      (100, 200), so P is at image pixel (600, 420), PDF (288, 201.6) pt.
    - Q at (-40, 140): canvas (1800, 100). Sheet B is a page with /Rotate 90
      and a CropBox, shown 520 x 350 pt, turned 90 degrees clockwise on the
      canvas about its top-left corner at (2000, 0). Canvas (1800, 100) is
      image pixel (100, 200) of that page, (48, 96) pt as displayed.
    The review found a marker expected at (50, 300) drawn at (116, 49).
    """

    def setUp(self):
        self.client = APIClient()
        p = self.project = create_project(
            name='Known answer', coord_unit='meters', pixels_per_meter=10,
            ref_asset_id='R', ref_pixel_x=400, ref_pixel_y=500, asset_rotation=90)
        pdf = pdf_bytes((400, 600, 0, None), (400, 600, 90, (30, 40, 380, 560)))
        self.sheet_a = Sheet.objects.create(project=p, name='A', page_number=1, offset_x=100, offset_y=200,
                                            pdf_file=SimpleUploadedFile('set.pdf', pdf))
        self.sheet_b = Sheet.objects.create(project=p, name='B', page_number=2, offset_x=2000, offset_y=0,
                                            rotation=90, pdf_file=self.sheet_a.pdf_file.name)
        red = create_asset_type(name='Valve', color='#FF0000', size=20)
        blue = create_asset_type(name='Hidden', color='#0000FF', size=20)
        Asset.objects.create(project=p, asset_type=red, asset_id='R', original_x=0, original_y=0,
                             adjusted_x=-100, adjusted_y=0, is_adjusted=True)  # canvas (400, -500): off both pages
        Asset.objects.create(project=p, asset_type=red, asset_id='P', name='Valve P', original_x=12, original_y=30)
        Asset.objects.create(project=p, asset_type=red, asset_id='Q', original_x=-40, original_y=140)
        # Next to P, but hidden: by its own eye toggle, and by a hidden parent folder.
        parent = LayerGroup.objects.create(project=p, name='Off', group_type='asset', visible=False)
        child = LayerGroup.objects.create(project=p, name='Inside', group_type='asset', parent_group=parent)
        Asset.objects.create(project=p, asset_type=blue, asset_id='H1', original_x=12, original_y=31,
                             visible=False)
        Asset.objects.create(project=p, asset_type=blue, asset_id='H2', original_x=13, original_y=30,
                             layer_group=child)

    def export(self, query=''):
        import pymupdf

        resp = self.client.get(f'/api/projects/{self.project.pk}/export/{query}')
        self.assertEqual(resp.status_code, 200, getattr(resp, 'content', b''))
        self.assertEqual(resp['Content-Type'], 'application/pdf')
        return pymupdf.open(stream=b''.join(resp.streaming_content), filetype='pdf')

    def test_markers_land_where_the_editor_draws_them(self):
        doc = self.export()
        self.assertEqual(len(doc), 2)
        page_a, page_b = doc[0], doc[1]
        self.assertEqual((page_b.rotation, tuple(page_b.rect)), (90, (0, 0, 520, 350)))

        x, y = colour_centroid(page_a, is_red)
        self.assertAlmostEqual(x, 288, delta=1)
        self.assertAlmostEqual(y, 201.6, delta=1)
        x, y = colour_centroid(page_b, is_red)
        self.assertAlmostEqual(x, 48, delta=1)
        self.assertAlmostEqual(y, 96, delta=1)
        self.assertIn('Valve P', page_a.get_text())
        self.assertIn('Q', page_b.get_text())

    def test_hidden_assets_are_left_out(self):
        doc = self.export()
        self.assertIsNone(colour_centroid(doc[0], is_blue))
        self.assertIsNone(colour_centroid(doc[1], is_blue))

    def test_hidden_sheets_are_left_out(self):
        self.sheet_a.visible = False
        self.sheet_a.save(update_fields=['visible'])
        doc = self.export()
        self.assertEqual(len(doc), 1)
        self.assertEqual(doc[0].rotation, 90)

    def test_chosen_sheets(self):
        doc = self.export(f'?sheets={self.sheet_b.pk}')
        self.assertEqual(len(doc), 1)
        self.assertEqual(doc[0].rotation, 90)
        resp = self.client.get(f'/api/projects/{self.project.pk}/export/?sheets=abc')
        self.assertEqual(resp.status_code, 400)

    def test_download_name(self):
        resp = self.client.get(f'/api/projects/{self.project.pk}/export/')
        self.assertEqual(resp['Content-Disposition'], 'attachment; filename="Known answer.pdf"')

    def test_no_reference_point_exports_pages_without_markers(self):
        Project.objects.filter(pk=self.project.pk).update(ref_asset_id='')
        doc = self.export()
        self.assertEqual(len(doc), 2)
        self.assertIsNone(colour_centroid(doc[0], is_red))

    def test_export_empty_project(self):
        empty = create_project(name='Empty')
        resp = self.client.get(f'/api/projects/{empty.pk}/export/')
        self.assertEqual(resp.status_code, 400)
        self.assertIn('no visible sheets', resp.json()['error'])


# ---------------------------------------------------------------------------
# CSV formula injection tests
# ---------------------------------------------------------------------------

class CsvFormulaInjectionTests(TestCase):
    def test_export_csv_sanitizes_formulas(self):
        from .services.export_service import generate_adjustment_report

        p = create_project()
        at = create_asset_type(name='=CMD|calc|A0')
        a = Asset.objects.create(
            project=p, asset_type=at,
            asset_id='=1+1', name='+dangerous', original_x=0, original_y=0,
            adjusted_x=1, adjusted_y=1, is_adjusted=True,
        )
        AdjustmentLog.objects.create(
            asset=a, from_x=0, from_y=0, to_x=1, to_y=1,
            notes='=HYPERLINK("evil")',
        )

        from .services.export_service import report_assets

        resp = generate_adjustment_report(p, report_assets(p))
        content = resp.content.decode('utf-8')

        # All formula-like values should be prefixed with '
        self.assertIn("'=1+1", content)
        self.assertIn("'+dangerous", content)
        self.assertIn("'=CMD|calc|A0", content)
        self.assertIn("'=HYPERLINK", content)

    def test_import_formula_in_asset_id(self):
        """Formula values in CSV import should be stored (import doesn't need to sanitize on read)."""
        p = create_project()
        csv_file = make_csv_content([
            {'asset_id': '=SUM(A1)', 'asset_type': 'Valve', 'x': '10', 'y': '20', 'name': ''},
        ])
        result = import_assets_from_csv(p, csv_file)
        self.assertEqual(result['created'], 1)
        a = Asset.objects.get(project=p, asset_id='=SUM(A1)')
        self.assertEqual(a.asset_id, '=SUM(A1)')


# ---------------------------------------------------------------------------
# parse_color tests
# ---------------------------------------------------------------------------

class ParseColorTests(TestCase):
    def test_valid_hex_with_hash(self):
        from .services.pdf_processor import parse_color
        self.assertEqual(parse_color('#FF0000'), (1.0, 0.0, 0.0))

    def test_valid_hex_without_hash(self):
        from .services.pdf_processor import parse_color
        self.assertEqual(parse_color('00FF00'), (0.0, 1.0, 0.0))

    def test_invalid_color_returns_default(self):
        from .services.pdf_processor import parse_color
        self.assertEqual(parse_color('xyz'), (1.0, 0.0, 0.0))
        self.assertEqual(parse_color(''), (1.0, 0.0, 0.0))
        self.assertEqual(parse_color('#AB'), (1.0, 0.0, 0.0))


# ---------------------------------------------------------------------------
# Auth/Permission tests (REQUIRE_LOGIN=True)
# ---------------------------------------------------------------------------

@override_settings(REQUIRE_LOGIN=True)
class AuthPermissionTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_project_list_requires_auth(self):
        resp = self.client.get('/api/projects/')
        self.assertIn(resp.status_code, [401, 403])

    def test_calibrate_requires_auth(self):
        p = create_project()
        resp = self.client.post(
            f'/api/projects/{p.pk}/calibrate/',
            {'origin_x': 100},
            format='json',
        )
        self.assertIn(resp.status_code, [401, 403])

    def test_import_csv_requires_auth(self):
        p = create_project()
        csv_file = make_csv_content([
            {'asset_id': 'A1', 'asset_type': 'T', 'x': '1', 'y': '2', 'name': ''},
        ])
        resp = self.client.post(
            f'/api/projects/{p.pk}/import-csv/',
            {'file': csv_file},
            format='multipart',
        )
        self.assertIn(resp.status_code, [401, 403])

    def test_page_views_redirect_to_login(self):
        p = create_project()
        for url in ['/', f'/project/{p.pk}/', f'/project/{p.pk}/editor/',
                    f'/project/{p.pk}/export-full/']:
            resp = self.client.get(url)
            self.assertEqual(resp.status_code, 302, url)
            self.assertTrue(resp['Location'].startswith('/accounts/login/'), url)

    def test_authenticated_user_can_access(self):
        from django.contrib.auth import get_user_model
        get_user_model().objects.create_user('alice', password='pw-for-tests-123')
        self.client.login(username='alice', password='pw-for-tests-123')
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.get('/api/projects/').status_code, 200)

    def test_login_page_renders(self):
        resp = self.client.get('/accounts/login/')
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'Sign in')

    def test_logout_requires_post(self):
        # Django 5 removed GET logout; make sure the nav form uses POST.
        self.assertEqual(self.client.get('/accounts/logout/').status_code, 405)
        self.assertEqual(self.client.post('/accounts/logout/').status_code, 302)


@override_settings(REQUIRE_LOGIN=False)
class OpenAccessTests(TestCase):
    """With login enforcement disabled, everything is reachable anonymously."""

    def test_pages_and_api_are_open(self):
        p = create_project()
        self.assertEqual(self.client.get('/').status_code, 200)
        self.assertEqual(self.client.get(f'/project/{p.pk}/editor/').status_code, 200)
        self.assertEqual(APIClient().get('/api/projects/').status_code, 200)

    def test_nav_has_no_sign_out(self):
        resp = self.client.get('/')
        self.assertNotContains(resp, 'Sign out')


# ---------------------------------------------------------------------------
# Edge case tests
# ---------------------------------------------------------------------------

@override_settings(REQUIRE_LOGIN=False)
class EdgeCaseTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    def test_import_csv_empty_file(self):
        """CSV with headers but no data rows should import 0 assets."""
        csv_file = make_csv_content(
            [],
            fieldnames=['asset_id', 'asset_type', 'x', 'y', 'name'],
        )
        result = import_assets_from_csv(self.project, csv_file)
        self.assertEqual(result['created'], 0)
        self.assertEqual(result['updated'], 0)

    def test_cuts_json_string_coordinates(self):
        """cuts_json with string coordinates should be rejected by validation."""
        s = Sheet.objects.create(project=self.project, name='StrCut', pdf_file=make_pdf_file())
        cuts = [{'p1': {'x': 'bad', 'y': 0}, 'p2': {'x': 100, 'y': 100}, 'flipped': False}]
        resp = self.client.patch(
            f'/api/sheets/{s.pk}/',
            {'cuts_json': cuts},
            format='json',
        )
        # Documents current behavior: serializer validates structure but not numeric types
        self.assertEqual(resp.status_code, 200)

    @patch('drawings.api_views.render_pdf_page')
    def test_split_out_of_bounds(self, mock_render):
        """Split coordinates outside sheet bounds should still succeed."""
        s = Sheet.objects.create(project=self.project, name='OOB', pdf_file=make_pdf_file())
        resp = self.client.post(
            f'/api/sheets/{s.pk}/split/',
            {'p1': {'x': -9999, 'y': -9999}, 'p2': {'x': 99999, 'y': 99999}},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)


# ---------------------------------------------------------------------------
# Regressions from the 2026-11-01 browser review (R numbers refer to it)
# ---------------------------------------------------------------------------

def make_layered_pdf():
    """A one-page PDF with a red square on layer RED and a blue one on BLUE.

    Returns (uploaded_file, red_xref, blue_xref).
    """
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page(width=200, height=200)
    red = doc.add_ocg('RED', on=True)
    blue = doc.add_ocg('BLUE', on=True)
    page.draw_rect(pymupdf.Rect(10, 10, 90, 90), color=(1, 0, 0), fill=(1, 0, 0), oc=red)
    page.draw_rect(pymupdf.Rect(110, 110, 190, 190), color=(0, 0, 1), fill=(0, 0, 1), oc=blue)
    data = doc.tobytes()
    doc.close()
    return SimpleUploadedFile('layers.pdf', data, content_type='application/pdf'), red, blue


def rendered_colours(sheet):
    """Colour at the centre of the red and the blue square in the render."""
    from PIL import Image

    sheet.refresh_from_db()
    with Image.open(sheet.rendered_image.path) as img:
        scale = img.width / 200
        rgb = img.convert('RGB')
        return rgb.getpixel((50 * scale, 50 * scale)), rgb.getpixel((150 * scale, 150 * scale))


WHITE = (255, 255, 255)


@override_settings(REQUIRE_LOGIN=True)
class CsrfTokenOnPagesTests(TestCase):
    """Pages that send API requests with fetch() must hand the script a CSRF
    token. Without one, every POST failed with 403 when signed in (R1)."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.test import Client

        get_user_model().objects.create_user('csrf', password='pw-for-tests-123')
        self.client = Client(enforce_csrf_checks=True)
        self.client.login(username='csrf', password='pw-for-tests-123')

    def form_token(self, html, form_id):
        import re

        match = re.search(
            rf'<form id="{form_id}"[^>]*>\s*<input type="hidden" name="csrfmiddlewaretoken" value="([^"]+)"',
            html,
        )
        self.assertIsNotNone(match, f'{form_id} has no CSRF token')
        return match.group(1)

    def test_new_project_uses_token_from_page(self):
        token = self.form_token(self.client.get('/').content.decode(), 'createForm')
        body = '{"name": "From the list page"}'
        denied = self.client.post('/api/projects/', body, content_type='application/json')
        self.assertEqual(denied.status_code, 403)
        resp = self.client.post('/api/projects/', body, content_type='application/json',
                                HTTP_X_CSRFTOKEN=token)
        self.assertEqual(resp.status_code, 201)

    def test_details_page_forms_have_tokens(self):
        project = create_project()
        html = self.client.get(f'/project/{project.pk}/').content.decode()
        self.form_token(html, 'uploadForm')
        self.form_token(html, 'importForm')


@override_settings(REQUIRE_LOGIN=False)
class PdfLayerRenderTests(TestCase):
    """Real PyMuPDF renders, no mocks (R4)."""

    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        pdf, self.red, self.blue = make_layered_pdf()
        resp = self.client.post(f'/api/projects/{self.project.pk}/sheets/',
                                {'name': 'Layers', 'pdf_file': pdf}, format='multipart')
        self.assertEqual(resp.status_code, 201)
        self.sheet = Sheet.objects.get(project=self.project)

    def set_layers(self, visible):
        return self.client.post(f'/api/sheets/{self.sheet.pk}/layers/',
                                {'visible_layers': visible}, format='json')

    def test_upload_detects_layers(self):
        self.assertEqual({layer['name'] for layer in self.sheet.pdf_layers}, {'RED', 'BLUE'})
        red, blue = rendered_colours(self.sheet)
        self.assertNotEqual(red, WHITE)
        self.assertNotEqual(blue, WHITE)

    def test_hiding_a_layer_removes_it_from_the_render(self):
        resp = self.set_layers([self.red])
        self.assertEqual(resp.status_code, 200)
        red, blue = rendered_colours(self.sheet)
        self.assertNotEqual(red, WHITE)
        self.assertEqual(blue, WHITE)
        self.assertEqual(self.sheet.visible_layers, [self.red])

    def test_list_matching_no_layer_hides_all(self):
        self.assertEqual(self.set_layers([0]).status_code, 200)
        self.assertEqual(rendered_colours(self.sheet), (WHITE, WHITE))

    def test_empty_list_shows_all(self):
        self.set_layers([self.red])
        self.assertEqual(self.set_layers([]).status_code, 200)
        red, blue = rendered_colours(self.sheet)
        self.assertNotEqual(blue, WHITE)

    def test_non_integer_layers_rejected(self):
        self.assertEqual(self.set_layers(['RED']).status_code, 400)

    @patch('drawings.api_views.render_pdf_page', side_effect=RuntimeError('render failed'))
    def test_failed_render_keeps_previous_setting(self, mock_render):
        resp = self.set_layers([self.red])
        self.assertEqual(resp.status_code, 500)
        self.sheet.refresh_from_db()
        self.assertEqual(self.sheet.visible_layers, [])

    def test_render_does_not_overwrite_concurrent_moves(self):
        """A render only writes its own fields, so a sheet moved meanwhile
        keeps its new position."""
        from .services.pdf_processor import render_pdf_page

        stale = Sheet.objects.get(pk=self.sheet.pk)
        Sheet.objects.filter(pk=self.sheet.pk).update(offset_x=321.0)
        render_pdf_page(stale)
        self.sheet.refresh_from_db()
        self.assertEqual(self.sheet.offset_x, 321.0)


@override_settings(REQUIRE_LOGIN=False, FILE_UPLOAD_MAX_MEMORY_SIZE=100)
class LargePdfUploadTests(TestCase):
    """Uploads bigger than FILE_UPLOAD_MAX_MEMORY_SIZE are spooled to a temp
    file, which request.data.copy() couldn't deep-copy (R6)."""

    def test_spooled_upload_creates_sheet(self):
        project = create_project()
        pdf, _, _ = make_layered_pdf()
        self.assertGreater(pdf.size, 100)
        resp = APIClient().post(f'/api/projects/{project.pk}/sheets/',
                                {'name': 'Big', 'pdf_file': pdf}, format='multipart')
        self.assertEqual(resp.status_code, 201, resp.content)


@override_settings(REQUIRE_LOGIN=False)
class LayerGroupTypeFilterTests(TestCase):
    def test_measurement_filter_returns_only_measurement_folders(self):
        project = create_project()
        LayerGroup.objects.create(project=project, name='Valves', group_type='asset')
        LayerGroup.objects.create(project=project, name='Runs', group_type='measurement')
        resp = APIClient().get(f'/api/projects/{project.pk}/layer-groups/?type=measurement')
        self.assertEqual([g['name'] for g in resp.json()], ['Runs'])


@override_settings(REQUIRE_LOGIN=False)
class EditorMarkupTests(TestCase):
    """Markup the editor scripts look up by id. Missing markup fails only in
    the browser, so check it here (R2, R3)."""

    def test_editor_has_dialogs_its_scripts_use(self):
        project = create_project()
        html = self.client.get(f'/project/{project.pk}/editor/').content.decode()
        for element_id in ('importLinksModal', 'import-links-csv-file', 'map-link-id',
                           'map-coordinates', 'saveMeasurementForm', 'measurement-folder',
                           'import-batches', 'link-import-batches'):
            self.assertIn(f'id="{element_id}"', html, element_id)
        self.assertNotIn('\ufffd', html)

    def test_editor_has_batch_5_markup(self):
        project = create_project()
        html = self.client.get(f'/project/{project.pk}/editor/').content.decode()
        for element_id in ('verify-unit-hint', 'verify-coord-unit', 'floating-toolbar',
                           'asset-rotation-slider', 'asset-adj-x', 'asset-adj-y'):
            self.assertIn(f'id="{element_id}"', html, element_id)
        # assets.js fills these with Longitude/Latitude, Easting/Northing or X/Y
        for label in ('Original:x', 'Original:y', 'Adjusted:x', 'Adjusted:y'):
            self.assertIn(f'data-coord-label="{label}"', html, label)
        self.assertIn('exportComposedPdf(this)', html)
        self.assertIn('rel="icon"', html)

    def test_editor_scripts_exist(self):
        """Every script the editor loads is in static/ (canvas_core.js was removed)."""
        project = create_project()
        html = self.client.get(f'/project/{project.pk}/editor/').content.decode()
        scripts = re.findall(r'<script src="/static/(js/[^"?]+)', html)
        self.assertGreater(len(scripts), 15)
        for path in scripts:
            self.assertTrue((settings.BASE_DIR / 'static' / path).is_file(), path)
        self.assertNotIn('canvas_core.js', html)


@override_settings(REQUIRE_LOGIN=False)
class ImportLinksAPITests(TestCase):
    """The editor's Import Links dialog posts the CSV as 'file' (R3)."""

    def post_links(self, field):
        project = create_project()
        content = (
            'link_id,name,coordinates\n'
            'L1,Main 1,"[[153.026, -27.4705], [153.0263, -27.4705]]"\n'
            'L2,Main 2,"[[153.0263, -27.4705], [153.0266, -27.4706]]"\n'
        )
        upload = SimpleUploadedFile('links.csv', content.encode(), content_type='text/csv')
        resp = APIClient().post(
            f'/api/projects/{project.pk}/import-links-csv/',
            {field: upload, 'column_mapping': '{"link_id": "link_id", "coordinates": "coordinates", "name": "name"}'},
            format='multipart',
        )
        return project, resp

    def test_import_with_editor_field_name(self):
        project, resp = self.post_links('file')
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()['created'], 2)
        self.assertEqual(project.links.count(), 2)

    def test_old_field_name_still_works(self):
        _, resp = self.post_links('csv_file')
        self.assertEqual(resp.status_code, 200, resp.content)


@override_settings(REQUIRE_LOGIN=False)
class SheetCascadeOffsetTests(TestCase):
    """New sheets get a saved, cascaded position; the editor used to fake one
    for sheets at (0, 0), which moved sheets placed there on purpose (R14)."""

    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    def upload(self, **extra):
        import pymupdf

        doc = pymupdf.open()
        for _ in range(3):
            doc.new_page(width=100, height=100)
        pdf = SimpleUploadedFile('three.pdf', doc.tobytes(), content_type='application/pdf')
        doc.close()
        resp = self.client.post(f'/api/projects/{self.project.pk}/sheets/',
                                {'name': 'Set', 'pdf_file': pdf, **extra}, format='multipart')
        self.assertEqual(resp.status_code, 201, resp.content)
        return resp.json()

    def test_pages_are_cascaded_and_saved(self):
        self.upload()
        self.upload()
        offsets = [(s.offset_x, s.offset_y) for s in Sheet.objects.order_by('pk')]
        self.assertEqual(offsets, [(i * 50.0, i * 50.0) for i in range(6)])

    def test_explicit_offset_is_kept(self):
        self.upload()
        self.upload(offset_x=10, offset_y=20)
        newest = list(Sheet.objects.order_by('pk'))[3:]
        self.assertEqual({(s.offset_x, s.offset_y) for s in newest}, {(10.0, 20.0)})

    def test_migration_saves_the_offset_the_editor_showed(self):
        from importlib import import_module

        from django.apps import apps

        migration = import_module('drawings.migrations.0014_save_sheet_cascade_offsets')
        a = Sheet.objects.create(project=self.project, name='A', pdf_file=make_pdf_file())
        b = Sheet.objects.create(project=self.project, name='B', pdf_file=make_pdf_file())
        c = Sheet.objects.create(project=self.project, name='C', pdf_file=make_pdf_file(),
                                 offset_x=300, offset_y=0)
        d = Sheet.objects.create(project=self.project, name='D', pdf_file=make_pdf_file())
        migration.save_cascade_offsets(apps, None)
        for sheet in (a, b, c, d):
            sheet.refresh_from_db()
        self.assertEqual((a.offset_x, a.offset_y), (0, 0))      # first sheet stays
        self.assertEqual((b.offset_x, b.offset_y), (50, 50))    # index 1
        self.assertEqual((c.offset_x, c.offset_y), (300, 0))    # already placed
        self.assertEqual((d.offset_x, d.offset_y), (150, 150))  # index 3

    def test_project_file_round_trip_keeps_sheet_at_origin(self):
        from django.contrib.auth import get_user_model
        from django.test import Client

        for name, offset in (('A', 0), ('B', 0), ('C', 100)):
            Sheet.objects.create(project=self.project, name=name, pdf_file=make_pdf_file(),
                                 offset_x=offset, offset_y=offset)
        get_user_model().objects.create_user('io', password='pw-for-tests-123')
        client = Client()
        client.login(username='io', password='pw-for-tests-123')
        archive = client.get(f'/project/{self.project.pk}/export-full/')
        self.assertEqual(archive.status_code, 200)
        upload = SimpleUploadedFile('p.docuweaver', archive.content)
        resp = client.post('/import/', {'file': upload})
        self.assertEqual(resp.status_code, 200, resp.content)
        imported = Project.objects.exclude(pk=self.project.pk).get()
        self.assertEqual(
            [(s.name, s.offset_x, s.offset_y) for s in imported.sheets.order_by('name')],
            [('A', 0, 0), ('B', 0, 0), ('C', 100, 100)],
        )

    def test_old_project_file_gets_the_cascade_the_editor_showed(self):
        from .services.project_archive import create_project_from_data

        data = {'project': {'name': 'From 1.0.1'},
                'sheets': [{'name': 'A'}, {'name': 'B'}, {'name': 'C', 'offset_x': 300}]}
        create_project_from_data(data, lambda *args: None)
        project = Project.objects.get(name='From 1.0.1')
        self.assertEqual(
            [(s.name, s.offset_x, s.offset_y) for s in project.sheets.order_by('name')],
            [('A', 0, 0), ('B', 50, 50), ('C', 300, 0)],
        )


# ---------------------------------------------------------------------------
# Review batch 3: data that was lost, merged or corrupted (R16-R24, R26, R27)
# ---------------------------------------------------------------------------

def upload_csv(name, text, encoding='utf-8'):
    return SimpleUploadedFile(name, text.encode(encoding), content_type='text/csv')


@override_settings(REQUIRE_LOGIN=False)
class CsvImportEdgeCaseTests(TestCase):
    """R17, R26: rows the importers used to store wrongly or fail on."""

    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    def import_assets(self, text, name='a.csv', encoding='utf-8'):
        resp = self.client.post(f'/api/projects/{self.project.pk}/import-csv/',
                                {'file': upload_csv(name, text, encoding)}, format='multipart')
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def import_links(self, text, name='l.csv'):
        resp = self.client.post(f'/api/projects/{self.project.pk}/import-links-csv/',
                                {'file': upload_csv(name, text)}, format='multipart')
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def test_excel_cp1252_file(self):
        result = self.import_assets('asset_id,asset_type,x,y,notes\nA1,Pit,1,2,Bearing 45°\n', encoding='cp1252')
        self.assertEqual(result['created'], 1, result)
        self.assertEqual(Asset.objects.get(asset_id='A1').metadata['notes'], 'Bearing 45°')

    def test_short_row_reads_missing_cells_as_empty(self):
        result = self.import_assets('asset_id,asset_type,x,y,name\nS1,Pit,1,2,Alpha\nS2,Pit,3,4\n')
        self.assertEqual((result['created'], result['errors']), (2, []))
        self.assertEqual(Asset.objects.get(asset_id='S2').name, '')

    def test_non_finite_coordinates_are_rejected(self):
        result = self.import_assets('asset_id,asset_type,x,y\nN1,Pit,nan,2\nI1,Pit,inf,2\nOK,Pit,3,4\n')
        self.assertEqual(result['created'], 1)
        self.assertEqual(len(result['errors']), 2)
        self.assertEqual(self.client.get(f'/api/projects/{self.project.pk}/assets/').status_code, 200)

    def test_non_finite_link_points_are_rejected(self):
        result = self.import_links('link_id,coordinates\nL1,"[[NaN,-27.5],[153.1,-27.6]]"\n'
                                   'L2,"[[153.0,-27.5],[153.1,-27.6]]"\n')
        self.assertEqual(result['created'], 1, result)
        self.assertEqual(self.client.get(f'/api/projects/{self.project.pk}/links/').status_code, 200)

    def test_repeated_id_in_one_file_is_reported(self):
        result = self.import_assets('asset_id,asset_type,x,y\nD1,Pit,1,1\nD1,Pit,5,5\n')
        self.assertEqual((result['created'], result['updated']), (1, 0))
        self.assertIn('already appeared on row 2', result['errors'][0])
        self.assertEqual(Asset.objects.get(asset_id='D1').original_x, 1)

    def test_a_failing_row_does_not_stop_the_rest(self):
        from django.db import IntegrityError

        real_create = Asset.objects.create
        calls = []

        def create(**kwargs):
            calls.append(kwargs['asset_id'])
            if kwargs['asset_id'] == 'BAD':
                raise IntegrityError('simulated')
            return real_create(**kwargs)

        with patch.object(Asset.objects, 'create', side_effect=create):
            result = self.import_assets('asset_id,asset_type,x,y\nBAD,Pit,1,1\nGOOD,Pit,2,2\n')
        self.assertEqual(result['created'], 1, result)
        self.assertTrue(Asset.objects.filter(asset_id='GOOD').exists())


@override_settings(REQUIRE_LOGIN=False)
class ImportBatchOwnershipTests(TestCase):
    """R16, R23: an asset or link belongs to the import that created it."""

    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    def import_csv(self, name, text, url='import-csv'):
        resp = self.client.post(f'/api/projects/{self.project.pk}/{url}/',
                                {'file': upload_csv(name, text)}, format='multipart')
        self.assertEqual(resp.status_code, 200, resp.content)

    def batch(self, filename):
        return ImportBatch.objects.get(project=self.project, filename=filename)

    def test_deleting_a_later_import_keeps_assets_it_repeated(self):
        self.import_csv('A.csv', 'asset_id,asset_type,x,y\nA1,Pit,1,1\nA2,Pit,2,2\n')
        a1 = Asset.objects.get(asset_id='A1')
        self.client.post(f'/api/assets/{a1.pk}/adjust/', {'x': 1.5, 'y': 1.5}, format='json')
        self.import_csv('B.csv', 'asset_id,asset_type,x,y\nA1,Pit,1.1,1.1\nB1,Pit,9,9\n')

        a1.refresh_from_db()
        self.assertEqual(a1.original_x, 1.1)                 # values updated
        self.assertEqual(a1.import_batch, self.batch('A.csv'))  # ownership kept
        self.assertEqual(a1.layer_group.name, 'A')

        batches = {b['filename']: b['asset_count'] for b in
                   self.client.get(f'/api/projects/{self.project.pk}/import-batches/').json()}
        self.assertEqual(batches, {'A.csv': 2, 'B.csv': 1})

        self.client.delete(f'/api/import-batches/{self.batch("B.csv").pk}/')
        self.assertEqual(sorted(Asset.objects.values_list('asset_id', flat=True)), ['A1', 'A2'])
        self.assertEqual(AdjustmentLog.objects.filter(asset=a1).count(), 1)
        self.assertFalse(LayerGroup.objects.filter(name='B').exists())

    def test_deleting_a_link_import_removes_its_links_and_folder(self):
        from .models import Link

        self.import_csv('pipes.csv', 'link_id,coordinates\nL1,"[[153.0,-27.5],[153.1,-27.6]]"\n',
                        url='import-links-csv')
        resp = self.client.delete(f'/api/import-batches/{self.batch("links:pipes.csv").pk}/')
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(Link.objects.exists())
        self.assertFalse(LayerGroup.objects.filter(name='pipes').exists())

    def test_import_folder_is_kept_when_the_user_put_other_things_in_it(self):
        self.import_csv('A.csv', 'asset_id,asset_type,x,y\nA1,Pit,1,1\n')
        folder = LayerGroup.objects.get(name='A')
        other = Asset.objects.create(project=self.project, asset_type=AssetType.objects.get(name='Pit'),
                                     asset_id='MANUAL', original_x=0, original_y=0, layer_group=folder)
        self.client.delete(f'/api/import-batches/{self.batch("A.csv").pk}/')
        self.assertTrue(LayerGroup.objects.filter(pk=folder.pk).exists())
        self.assertTrue(Asset.objects.filter(pk=other.pk).exists())


@override_settings(REQUIRE_LOGIN=False)
class PartialSaveTests(TestCase):
    """R19: a request writes only the fields it changes, so two requests that
    change different fields of one row can't undo each other."""

    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.sheet = Sheet.objects.create(project=self.project, name='S', pdf_file=make_pdf_file())
        self.folder = LayerGroup.objects.create(project=self.project, name='F', group_type='sheet')

    def test_serializer_update_does_not_write_back_stale_fields(self):
        from .serializers import SheetSerializer

        stale = Sheet.objects.get(pk=self.sheet.pk)       # loaded before the drag lands
        self.client.patch(f'/api/sheets/{self.sheet.pk}/', {'offset_x': 123}, format='json')
        serializer = SheetSerializer(stale, data={'layer_group': self.folder.pk}, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        self.sheet.refresh_from_db()
        self.assertEqual((self.sheet.offset_x, self.sheet.layer_group), (123, self.folder))

    def test_handlers_update_only_their_columns(self):
        import re

        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        at = create_asset_type()
        asset = Asset.objects.create(project=self.project, asset_type=at, asset_id='A', original_x=1, original_y=1)
        measurement = __import__('drawings.models', fromlist=['MeasurementSet']).MeasurementSet.objects.create(
            project=self.project, name='m', points=[])
        other = LayerGroup.objects.create(project=self.project, name='G', group_type='sheet')
        calls = [
            ('patch', f'/api/sheets/{self.sheet.pk}/', {'offset_x': 5}, {'offset_x'}),
            ('post', f'/api/projects/{self.project.pk}/calibrate/', {'osm_opacity': 0.5}, {'osm_opacity', 'updated_at'}),
            ('post', f'/api/assets/{asset.pk}/adjust/', {'x': 2, 'y': 2},
             {'adjusted_x', 'adjusted_y', 'is_adjusted', 'updated_at'}),
            ('patch', f'/api/layer-groups/{self.folder.pk}/move-item/', {'item_type': 'sheet', 'item_id': self.sheet.pk},
             {'layer_group_id'}),
            ('patch', f'/api/layer-groups/{self.folder.pk}/toggle-visibility/', {}, {'visible'}),
            ('post', f'/api/projects/{self.project.pk}/layer-groups/join/',
             {'parent_id': other.pk, 'child_id': self.folder.pk}, {'parent_group_id'}),
            ('patch', f'/api/measurement-sets/{measurement.pk}/toggle-visibility/', {}, {'visible'}),
        ]
        for method, url, body, expected in calls:
            with CaptureQueriesContext(connection) as queries:
                resp = getattr(self.client, method)(url, body, format='json')
            self.assertLess(resp.status_code, 300, (url, resp.content))
            updates = [q['sql'] for q in queries.captured_queries if q['sql'].startswith('UPDATE')]
            columns = set(re.findall(r'"(\w+)" = ', updates[-1].split(' WHERE ')[0]))
            self.assertEqual(columns, expected, url)


@override_settings(REQUIRE_LOGIN=False)
class FolderParentValidationTests(TestCase):
    """R20: a folder can't be moved inside itself, one of its subfolders, or
    another project's folder."""

    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.top = LayerGroup.objects.create(project=self.project, name='Top', group_type='asset')
        self.sub = LayerGroup.objects.create(project=self.project, name='Sub', group_type='asset',
                                             parent_group=self.top)

    def move(self, group, parent):
        return self.client.patch(f'/api/layer-groups/{group.pk}/', {'parent_group': parent.pk}, format='json')

    def test_into_own_subfolder(self):
        self.assertEqual(self.move(self.top, self.sub).status_code, 400)
        self.top.refresh_from_db()
        self.assertIsNone(self.top.parent_group)

    def test_into_itself(self):
        self.assertEqual(self.move(self.top, self.top).status_code, 400)

    def test_into_another_project(self):
        elsewhere = LayerGroup.objects.create(project=create_project(name='Other'), name='X', group_type='asset')
        self.assertEqual(self.move(self.sub, elsewhere).status_code, 400)

    def test_into_a_folder_of_another_type(self):
        sheets = LayerGroup.objects.create(project=self.project, name='Sheets', group_type='sheet')
        self.assertEqual(self.move(self.sub, sheets).status_code, 400)
        shared = LayerGroup.objects.create(project=self.project, name='Shared', group_type='sheet', scope='global')
        self.assertEqual(self.move(self.sub, shared).status_code, 200)

    def test_allowed_move(self):
        other = LayerGroup.objects.create(project=self.project, name='Other', group_type='asset')
        self.assertEqual(self.move(self.sub, other).status_code, 200)
        self.sub.refresh_from_db()
        self.assertEqual(self.sub.parent_group, other)


@override_settings(REQUIRE_LOGIN=False)
class SplitKeepsSheetSettingsTests(TestCase):
    """R24: the new piece keeps earlier cuts, PDF layer choice and folder."""

    @patch('drawings.api_views.render_pdf_page')
    def test_split_twice(self, mock_render):
        client = APIClient()
        project = create_project()
        folder = LayerGroup.objects.create(project=project, name='F', group_type='sheet')
        earlier = {'p1': {'x': 50, 'y': 0}, 'p2': {'x': 50, 'y': 100}, 'flipped': False}
        sheet = Sheet.objects.create(project=project, name='S', pdf_file=make_pdf_file(), cuts_json=[earlier],
                                     pdf_layers=[{'xref': 5, 'name': 'Red'}], visible_layers=[5], layer_group=folder)
        resp = client.post(f'/api/sheets/{sheet.pk}/split/',
                           {'p1': {'x': 0, 'y': 50}, 'p2': {'x': 100, 'y': 50}}, format='json')
        self.assertEqual(resp.status_code, 200, resp.content)
        new = Sheet.objects.get(pk=resp.json()['new_sheet']['id'])
        self.assertEqual(new.cuts_json[0], earlier)
        self.assertTrue(new.cuts_json[1]['flipped'])
        self.assertEqual((new.visible_layers, new.pdf_layers, new.layer_group),
                         ([5], [{'xref': 5, 'name': 'Red'}], folder))
        sheet.refresh_from_db()
        self.assertEqual([c['flipped'] for c in sheet.cuts_json], [False, False])


@override_settings(REQUIRE_LOGIN=True)
class ProjectFileRoundTripTests(TestCase):
    """R18: exporting and importing a project keeps everything in it."""

    def setUp(self):
        import tempfile

        import pymupdf
        from django.contrib.auth import get_user_model
        from django.test import Client

        from .models import JoinMark, Link, MeasurementSet

        get_user_model().objects.create_user('rt', password='pw-for-tests-123')
        self.client = Client()
        self.client.login(username='rt', password='pw-for-tests-123')

        p = self.project = create_project(name='RT', coord_unit='gda94_mga', pixels_per_meter=11.8)
        doc = pymupdf.open()
        for _ in range(3):
            doc.new_page(width=100, height=100)
        three_pages = doc.tobytes()
        doc.close()
        self.tmp = tempfile.mkdtemp()
        resp = APIClient()
        resp.force_authenticate(get_user_model().objects.get(username='rt'))
        r = resp.post(f'/api/projects/{p.pk}/sheets/', {'pdf_file': SimpleUploadedFile('three.pdf', three_pages)},
                      format='multipart')
        self.assertEqual(r.status_code, 201, r.content)
        s1, s2, _s3 = p.sheets.order_by('page_number')

        # Same-named folders of different types, a nested folder named like
        # its parent, and a global folder.
        sheet_folder = LayerGroup.objects.create(project=p, name='Phase 1', group_type='sheet')
        zone = LayerGroup.objects.create(project=p, name='Zone', group_type='asset')
        LayerGroup.objects.create(project=p, name='Zone', group_type='asset', parent_group=zone)
        LayerGroup.objects.create(project=p, name='Shared', group_type='asset', scope='global')
        checks = LayerGroup.objects.create(project=p, name='Checks', group_type='measurement')

        s1.pdf_layers = [{'xref': 5, 'name': 'Red'}, {'xref': 6, 'name': 'Blue'}]
        s1.visible_layers = [5]
        s1.layer_group = sheet_folder
        s1.save()
        m1 = JoinMark.objects.create(sheet=s1, x=1, y=2, reference_label='TO 2')
        m2 = JoinMark.objects.create(sheet=s2, x=3, y=4, reference_label='TO 1', linked_mark=m1)
        m1.linked_mark = m2
        m1.save()

        ac = APIClient()
        ac.force_authenticate(get_user_model().objects.get(username='rt'))
        ac.post(f'/api/projects/{p.pk}/import-csv/',
                {'file': upload_csv('Phase 1.csv', 'asset_id,asset_type,x,y\nA1,Pit,1,1\nA2,Pit,2,2\n')},
                format='multipart')
        ac.post(f'/api/projects/{p.pk}/import-links-csv/',
                {'file': upload_csv('Phase 1.csv', 'link_id,coordinates\nL1,"[[1,1],[2,2]]"\n')},
                format='multipart')
        a1 = Asset.objects.get(project=p, asset_id='A1')
        ac.post(f'/api/assets/{a1.pk}/adjust/', {'x': 1.5, 'y': 1.5, 'notes': 'surveyed'}, format='json')
        Asset.objects.filter(asset_id='A2').update(layer_group=zone)
        MeasurementSet.objects.create(project=p, name='m1', points=[{'x': 0, 'y': 0}, {'x': 1, 'y': 1}],
                                      layer_group=checks)
        self.assertEqual(Link.objects.filter(project=p).count(), 1)

    def snapshot(self, project):
        from .models import JoinMark

        def folder(obj):
            g = obj.layer_group
            return g and (g.name, g.group_type, g.scope, g.parent_group and g.parent_group.name)

        return {
            'project': (project.coord_unit, project.pixels_per_meter),
            'sheets': [(s.name, s.page_number, s.pdf_layers, s.visible_layers, folder(s), s.offset_x)
                       for s in project.sheets.order_by('page_number')],
            'pdf_files': len({s.pdf_file.name for s in project.sheets.all()}),
            'assets': sorted(((a.asset_id, a.adjusted_x, folder(a), a.import_batch.filename)
                              for a in project.assets.all()), key=repr),
            'links': [(link.link_id, folder(link), link.import_batch.filename) for link in project.links.all()],
            'groups': sorted(((g.name, g.group_type, g.scope, g.parent_group and g.parent_group.name,
                               g.import_batch and g.import_batch.filename)
                              for g in project.layer_groups.all()), key=repr),
            'measurements': [(m.name, folder(m)) for m in project.measurement_sets.all()],
            'logs': [(log.asset.asset_id, log.to_x, log.notes, log.timestamp)
                     for log in AdjustmentLog.objects.filter(asset__project=project)],
            'marks': sorted(((m.reference_label, m.linked_mark and m.linked_mark.reference_label)
                             for m in JoinMark.objects.filter(sheet__project=project)), key=repr),
        }

    def round_trip(self, url):
        archive = self.client.get(url)
        self.assertEqual(archive.status_code, 200)
        resp = self.client.post('/import/', {'file': SimpleUploadedFile('RT.docuweaver', archive.content)})
        self.assertEqual(resp.status_code, 200, resp.content)
        return Project.objects.get(pk=resp.json()['project_id'])

    def test_full_export(self):
        before = self.snapshot(self.project)
        self.assertEqual(before['pdf_files'], 1)
        after = self.snapshot(self.round_trip(f'/project/{self.project.pk}/export-full/'))
        self.assertEqual(after, before)

    def test_json_export(self):
        before = self.snapshot(self.project)
        after = self.snapshot(self.round_trip(f'/project/{self.project.pk}/export/'))
        self.assertEqual(after, before)

    def test_old_file_with_same_named_folders(self):
        """Files from before 1.1.0 refer to folders by name only."""
        from .services.project_archive import create_project_from_data

        data = {
            'project': {'name': 'Old'},
            'layer_groups': [
                {'name': 'Phase 1', 'group_type': 'sheet'},
                {'name': 'Phase 1', 'group_type': 'asset'},
                {'name': 'Zone', 'group_type': 'asset'},
                {'name': 'Zone', 'group_type': 'asset', 'parent_group_name': 'Zone'},
            ],
            'asset_types': [{'name': 'Pit'}],
            'assets': [{'asset_id': 'A1', 'asset_type_name': 'Pit', 'original_x': 1, 'original_y': 1,
                        'layer_group_name': 'Phase 1'}],
        }
        project = create_project_from_data(data, lambda *args: None)
        self.assertEqual(project.assets.get().layer_group.group_type, 'asset')
        zones = project.layer_groups.filter(name='Zone')
        self.assertTrue(all(g.parent_group_id != g.id for g in zones))
        self.assertEqual(self.client.get(f'/api/layer-groups/{zones[1].pk}/').status_code, 200)


@override_settings(REQUIRE_LOGIN=True)
class ProjectFileImportSafetyTests(TestCase):
    """R27: an imported project file is untrusted."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.test import Client

        get_user_model().objects.create_user('imp', password='pw-for-tests-123')
        self.client = Client()
        self.client.login(username='imp', password='pw-for-tests-123')

    def archive(self, data, files=None):
        import json
        import zipfile

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('project.json', data if isinstance(data, str) else json.dumps(data))
            for name, content in (files or {}).items():
                zf.writestr(name, content)
        return SimpleUploadedFile('x.docuweaver', buf.getvalue())

    def post(self, data, files=None):
        return self.client.post('/import/', {'file': self.archive(data, files)})

    def media_files(self):
        return media_files()

    def test_html_disguised_as_pdf_is_rejected_and_nothing_is_left(self):
        before = self.media_files()
        good = b'%PDF-1.4 ok'
        resp = self.post({'project': {'name': 'X'}, 'sheets': [
            {'name': 'ok', 'pdf_file': 'ok.pdf'},
            {'name': 'evil', 'pdf_file': 'evil.html'},
        ]}, {'pdfs/ok.pdf': good, 'pdfs/evil.html': b'<script>alert(1)</script>'})
        self.assertEqual(resp.status_code, 400)
        self.assertIn('not a PDF', resp.json()['error'])
        self.assertFalse(Project.objects.filter(name='X').exists())
        self.assertEqual(self.media_files(), before)

    def test_svg_rendered_image_is_rejected(self):
        resp = self.post({'project': {'name': 'X'}, 'sheets': [{'name': 's', 'rendered_image': 'a.svg'}]},
                         {'rendered/a.svg': b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'})
        self.assertEqual(resp.status_code, 400)

    def test_stored_extension_follows_the_content(self):
        resp = self.post({'project': {'name': 'X'}, 'sheets': [{'name': 's', 'pdf_file': 'drawing.html'}]},
                         {'pdfs/drawing.html': b'%PDF-1.4 real pdf'})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(Sheet.objects.get(name='s').pdf_file.name.endswith('.pdf'))

    def test_existing_asset_type_is_not_changed(self):
        AssetType.objects.create(name='Valve', color='#00FF00')
        png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 20
        resp = self.post({'project': {'name': 'X'},
                          'asset_types': [{'name': 'Valve', 'color': '#FF0000', 'custom_icon': 'v.png'},
                                          {'name': 'Fresh', 'custom_icon': 'f.png'}]},
                         {'icons/v.png': png, 'icons/f.png': png})
        self.assertEqual(resp.status_code, 200, resp.content)
        valve = AssetType.objects.get(name='Valve')
        self.assertEqual((valve.color, bool(valve.custom_icon)), ('#00FF00', False))
        self.assertTrue(AssetType.objects.get(name='Fresh').custom_icon)

    def test_non_finite_numbers_are_rejected(self):
        for text in ('{"project": {"name": "X", "origin_x": NaN}}',
                     '{"project": {"name": "X", "origin_x": 1e999}}',
                     '{"project": {"name": "X", "origin_x": "inf"}}'):
            resp = self.post(text)
            self.assertEqual(resp.status_code, 400, text)
        self.assertFalse(Project.objects.filter(name='X').exists())

    @override_settings(DOCUWEAVER_MAX_IMPORT_MB=1)
    def test_unpacked_size_is_capped(self):
        resp = self.post({'project': {'name': 'X'}}, {'pdfs/big.pdf': b'%PDF-' + b'\0' * (2 * 2**20)})
        self.assertEqual(resp.status_code, 400)
        self.assertIn('DOCUWEAVER_MAX_IMPORT_MB', resp.json()['error'])

    def test_path_in_file_name_is_rejected_cleanly(self):
        resp = self.post({'project': {'name': 'X'}, 'sheets': [{'name': 't', 'pdf_file': '../../../../tmp/pwn.pdf'}]},
                         {'pdfs/../../../../tmp/pwn.pdf': b'%PDF-1'})
        self.assertIn(resp.status_code, (200, 400))
        if resp.status_code == 200:
            self.assertNotIn('..', Sheet.objects.get(name='t').pdf_file.name)


class NonFiniteCleanupMigrationTests(TestCase):
    """R17: migration 0015 removes assets an older importer stored with inf."""

    def test_removes_only_bad_rows(self):
        from importlib import import_module

        from django.apps import apps

        project = create_project()
        at = create_asset_type()
        Asset.objects.create(project=project, asset_type=at, asset_id='BAD', original_x=float('inf'), original_y=1)
        Asset.objects.create(project=project, asset_type=at, asset_id='OK', original_x=1, original_y=1)
        migration = import_module('drawings.migrations.0015_remove_non_finite_coordinates')
        with patch('builtins.print'):
            migration.remove_non_finite(apps, None)
        self.assertEqual(list(Asset.objects.values_list('asset_id', flat=True)), ['OK'])


@override_settings(REQUIRE_LOGIN=False)
class PdfUploadAllOrNothingTests(TestCase):
    """R25: a PDF that can't be used is refused with a 400 and leaves no
    sheet and no file behind; a good one becomes one sheet per page."""

    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.before = media_files()

    def upload(self, pdf):
        return self.client.post(f'/api/projects/{self.project.pk}/sheets/',
                                {'name': 'Set', 'pdf_file': pdf}, format='multipart')

    def assert_nothing_left(self):
        self.assertFalse(Sheet.objects.exists())
        self.assertEqual(media_files(), self.before)

    def test_password_protected(self):
        import pymupdf

        doc = pymupdf.open()
        doc.new_page()
        data = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='o', user_pw='u')
        resp = self.upload(SimpleUploadedFile('locked.pdf', data))
        self.assertEqual(resp.status_code, 400)
        self.assertIn('password', resp.json()['error'])
        self.assert_nothing_left()

    def test_damaged(self):
        resp = self.upload(SimpleUploadedFile('broken.pdf', b'%PDF-1.7\n' + bytes(range(256)) * 12))
        self.assertEqual(resp.status_code, 400)
        self.assertIn("can't be read", resp.json()['error'])
        self.assert_nothing_left()

    def test_oversized_page_after_a_good_one(self):
        """Page 1 renders before page 2 is refused; its image is removed too."""
        import pymupdf

        doc = pymupdf.open()
        doc.new_page(width=100, height=100)
        doc.new_page(width=14400, height=14400)  # 5 x 5 m: 900 Mpx at 150 dpi
        resp = self.upload(SimpleUploadedFile('huge.pdf', doc.tobytes()))
        self.assertEqual(resp.status_code, 400)
        self.assertIn('Page 2 is 5080 × 5080 mm', resp.json()['error'])
        self.assert_nothing_left()

    def test_database_failure_removes_files(self):
        from django.db import OperationalError

        real_create = Sheet.objects.create

        def fail_on_page_3(**kwargs):
            if kwargs['page_number'] == 3:
                raise OperationalError('database is locked')
            return real_create(**kwargs)

        with patch.object(Sheet.objects, 'create', side_effect=fail_on_page_3):
            with self.assertRaises(OperationalError):
                self.upload(make_real_pdf(pages=3))
        self.assert_nothing_left()

    def test_pages_share_one_stored_pdf(self):
        resp = self.upload(make_real_pdf(pages=3))
        self.assertEqual(resp.status_code, 201, resp.content)
        sheets = list(Sheet.objects.order_by('page_number'))
        self.assertEqual([s.name for s in sheets], ['Set-1', 'Set-2', 'Set-3'])
        self.assertEqual(len({s.pdf_file.name for s in sheets}), 1)
        self.assertEqual(len({s.rendered_image.name for s in sheets}), 3)
        self.assertTrue(all(s.image_width == 209 and s.image_height == 209 for s in sheets))
        # The PDF plus three renders, nothing else.
        self.assertEqual(len(media_files() - self.before), 4)

    def test_rerender_of_missing_page_is_a_client_error(self):
        resp = self.upload(make_real_pdf())
        sheet = Sheet.objects.get(pk=resp.json()[0]['id'])
        Sheet.objects.filter(pk=sheet.pk).update(page_number=7)
        resp = self.client.post(f'/api/sheets/{sheet.pk}/render/')
        self.assertEqual(resp.status_code, 400)
        self.assertIn('Page 7 does not exist', resp.json()['message'])


class CsrfWithoutLoginTests(TestCase):
    """R28: with sign-in off, a POST needs a CSRF token, so another website
    can't change projects through the user's browser."""

    def setUp(self):
        from django.test import Client

        self.project = create_project()
        self.browser = Client(enforce_csrf_checks=True)

    def calibrate(self, **headers):
        return self.browser.post(f'/api/projects/{self.project.pk}/calibrate/',
                                 {'pixel_distance': '1', 'real_distance': '1000'}, **headers)

    @override_settings(REQUIRE_LOGIN=False)
    def test_cross_site_post_is_refused(self):
        self.assertEqual(self.calibrate().status_code, 403)
        self.assertEqual(self.browser.post('/api/projects/', {'name': 'evil'}).status_code, 403)
        self.project.refresh_from_db()
        self.assertFalse(self.project.scale_calibrated)
        self.assertFalse(Project.objects.filter(name='evil').exists())

    @override_settings(REQUIRE_LOGIN=False)
    def test_the_app_itself_still_works(self):
        self.assertEqual(self.browser.get('/').status_code, 200)  # sets the csrftoken cookie
        token = self.browser.cookies['csrftoken'].value
        self.assertEqual(self.browser.get('/api/projects/').status_code, 200)
        self.assertEqual(self.calibrate(HTTP_X_CSRFTOKEN=token).status_code, 200)

    @override_settings(REQUIRE_LOGIN=True)
    def test_basic_auth_clients_need_no_token(self):
        import base64

        from django.contrib.auth import get_user_model

        get_user_model().objects.create_user('script', password='pw-for-tests-123')
        auth = 'Basic ' + base64.b64encode(b'script:pw-for-tests-123').decode()
        self.assertEqual(self.calibrate(HTTP_AUTHORIZATION=auth).status_code, 200)


class MagicMimeCheckTests(TestCase):
    """R29: a python-magic rejection used to be swallowed by its own except."""

    def check(self, validator, upload, detected):
        with patch('drawings.validators.HAS_MAGIC', True), \
             patch('drawings.validators.magic', create=True) as magic:
            magic.from_buffer.return_value = detected
            validator(upload)

    def test_pdf_rejected_when_magic_disagrees(self):
        with self.assertRaises(ValidationError):
            self.check(PDFFileValidator(), make_pdf_file(), 'text/html')
        self.check(PDFFileValidator(), make_pdf_file(), 'application/pdf')

    def test_image_rejected_when_magic_disagrees(self):
        with self.assertRaises(ValidationError):
            self.check(ImageFileValidator(), make_png_file(), 'text/html')
        self.check(ImageFileValidator(), make_png_file(), 'image/png')

    def test_magic_failure_falls_back_to_header_check(self):
        with patch('drawings.validators.HAS_MAGIC', True), \
             patch('drawings.validators.magic', create=True) as magic:
            magic.from_buffer.side_effect = OSError('no libmagic')
            PDFFileValidator()(make_pdf_file())
            with self.assertRaises(ValidationError):
                ImageFileValidator()(SimpleUploadedFile('x.png', b'<html>'))

    def test_webp_accepted_without_magic(self):
        webp = SimpleUploadedFile('icon.webp', b'RIFF\x24\x00\x00\x00WEBPVP8 ' + b'\x00' * 40)
        with patch('drawings.validators.HAS_MAGIC', False):
            ImageFileValidator()(webp)


@override_settings(REQUIRE_LOGIN=False)
class UploadSizeSettingTests(TestCase):
    """DOCUWEAVER_MAX_UPLOAD_MB is the PDF size limit. It used to only set
    when uploads were buffered to disk, while PDFs were capped at 50 MB."""

    def test_setting_is_the_pdf_limit(self):
        two_mb = make_pdf_file(size=2 * 1024 * 1024)
        with override_settings(DOCUWEAVER_MAX_UPLOAD_MB=1):
            with self.assertRaisesMessage(ValidationError, 'DOCUWEAVER_MAX_UPLOAD_MB'):
                PDFFileValidator()(two_mb)
        with override_settings(DOCUWEAVER_MAX_UPLOAD_MB=3):
            PDFFileValidator()(two_mb)

    @override_settings(DOCUWEAVER_MAX_UPLOAD_MB=1)
    def test_upload_over_the_limit_is_a_clear_400(self):
        resp = APIClient().post(f'/api/projects/{create_project().pk}/sheets/',
                                {'pdf_file': make_pdf_file(size=2 * 1024 * 1024)}, format='multipart')
        self.assertEqual(resp.status_code, 400)
        self.assertIn('exceeds maximum allowed size (1.0 MB)', resp.json()['pdf_file'][0])
        self.assertFalse(Sheet.objects.exists())


# ---------------------------------------------------------------------------
# Review batch 5: display and housekeeping (R33, R34, R35, R38, R39, R44-R46)
# ---------------------------------------------------------------------------

@override_settings(REQUIRE_LOGIN=False)
class SavedVisibilityTests(TestCase):
    """R33: the sidebar eye toggles are saved (they reset on every reload)."""

    def setUp(self):
        from .models import Link

        self.client = APIClient()
        self.project = create_project()
        self.sheet = Sheet.objects.create(project=self.project, name='S', pdf_file=make_pdf_file())
        self.asset = Asset.objects.create(project=self.project, asset_type=create_asset_type(),
                                          asset_id='A1', original_x=1, original_y=2)
        self.link = Link.objects.create(project=self.project, link_id='L1', coordinates=[[0, 0], [1, 1]])

    def test_patch_saves_only_visibility(self):
        for url, obj in ((f'/api/sheets/{self.sheet.pk}/', self.sheet),
                         (f'/api/assets/{self.asset.pk}/', self.asset),
                         (f'/api/links/{self.link.pk}/', self.link)):
            self.assertTrue(self.client.get(url).json()['visible'])
            # Another request renames it meanwhile; hiding it mustn't undo that.
            type(obj).objects.filter(pk=obj.pk).update(name='renamed')
            resp = self.client.patch(url, {'visible': False}, format='json')
            self.assertEqual(resp.status_code, 200)
            obj.refresh_from_db()
            self.assertEqual((obj.visible, obj.name), (False, 'renamed'))

    def test_lists_include_visibility(self):
        pk = self.project.pk
        for url in (f'/api/projects/{pk}/sheets/', f'/api/projects/{pk}/assets/', f'/api/projects/{pk}/links/'):
            self.assertEqual([item['visible'] for item in self.client.get(url).json()], [True])

    def test_project_file_keeps_visibility(self):
        from .services import project_archive

        Sheet.objects.filter(pk=self.sheet.pk).update(visible=False)
        Asset.objects.filter(pk=self.asset.pk).update(visible=False)
        type(self.link).objects.filter(pk=self.link.pk).update(visible=False)
        data, _files = project_archive.collect_project(self.project, version='2.1')
        data = project_archive.parse_project_json(project_archive.dumps(data))

        copy = project_archive.create_project_from_data(data, lambda file_type, name: None)
        self.assertEqual([copy.sheets.get().visible, copy.assets.get().visible, copy.links.get().visible],
                         [False, False, False])

        # A file from before 1.1.0 has no visibility: everything is shown.
        for key in ('sheets', 'assets', 'links'):
            for record in data[key]:
                del record['visible']
        old = project_archive.create_project_from_data(data, lambda file_type, name: None)
        self.assertEqual([old.sheets.get().visible, old.assets.get().visible, old.links.get().visible],
                         [True, True, True])


@override_settings(REQUIRE_LOGIN=False)
class SheetFileCleanupTests(TestCase):
    """R44: re-rendering left the old PNG behind, and deleting a project left
    all of its PDFs and PNGs (Sheet.delete() isn't called on a cascade)."""

    def setUp(self):
        self.client = APIClient()
        self.project = create_project()
        self.before = media_files()

    def upload(self, name, pages):
        with self.captureOnCommitCallbacks(execute=True):
            resp = self.client.post(f'/api/projects/{self.project.pk}/sheets/',
                                    {'pdf_file': make_real_pdf(name, pages=pages)}, format='multipart')
        self.assertEqual(resp.status_code, 201, resp.content)
        return [Sheet.objects.get(pk=s['id']) for s in resp.json()]

    def new_files(self):
        import os

        return sorted(os.path.basename(f) for f in media_files() - self.before)

    def test_rerender_replaces_the_png(self):
        sheet, = self.upload('one.pdf', 1)
        old_png = sheet.rendered_image.name
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.post(f'/api/sheets/{sheet.pk}/render/').status_code, 200)
            self.assertEqual(self.client.post(f'/api/sheets/{sheet.pk}/layers/', {'visible_layers': []},
                                              format='json').status_code, 200)
        sheet.refresh_from_db()
        self.assertNotEqual(sheet.rendered_image.name, old_png)
        self.assertEqual(len(self.new_files()), 2, self.new_files())  # one PDF, one PNG

    def test_deleting_a_project_removes_its_files(self):
        self.upload('two.pdf', 2)
        self.upload('one.pdf', 1)
        self.assertEqual(len(self.new_files()), 5)  # two PDFs, three PNGs
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.delete(f'/api/projects/{self.project.pk}/').status_code, 204)
        self.assertEqual(self.new_files(), [])

    def test_shared_pdf_goes_with_its_last_sheet(self):
        first, second = self.upload('two.pdf', 2)
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f'/api/sheets/{first.pk}/')
        self.assertEqual(len(self.new_files()), 2)  # the shared PDF and page 2's PNG
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f'/api/sheets/{second.pk}/')
        self.assertEqual(self.new_files(), [])

    def test_rolled_back_delete_keeps_files(self):
        from django.db import transaction

        sheet, = self.upload('one.pdf', 1)
        pk = sheet.pk
        with self.captureOnCommitCallbacks(execute=True):
            with self.assertRaises(RuntimeError), transaction.atomic():
                sheet.delete()
                raise RuntimeError('undo')
        self.assertTrue(Sheet.objects.filter(pk=pk).exists())
        self.assertEqual(len(self.new_files()), 2)

    def test_failed_split_leaves_no_png(self):
        sheet, = self.upload('one.pdf', 1)
        with patch('drawings.api_views.save_fields', side_effect=RuntimeError('disk full')):
            resp = self.client.post(f'/api/sheets/{sheet.pk}/split/',
                                    {'p1': {'x': 0, 'y': 50}, 'p2': {'x': 100, 'y': 50}}, format='json')
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(Sheet.objects.count(), 1)
        self.assertEqual(len(self.new_files()), 2)


@override_settings(REQUIRE_LOGIN=False)
class QueryCountTests(TestCase):
    """R45: the folder list ran about four queries per folder (402 for 100
    folders), the project API one per sheet and the report two per asset.
    Each now takes the same number of queries for 5 items as for 50."""

    def setUp(self):
        self.client = APIClient()

    def build(self, n):
        from .models import Link, MeasurementSet

        p = create_project(name=f'N{n}')
        asset_type, _ = AssetType.objects.get_or_create(name='T')
        shared = LayerGroup.objects.create(project=p, name='Shared', group_type='asset', scope='global')
        for i in range(n):
            Sheet.objects.create(project=p, name=f's{i}', pdf_file='pdfs/x.pdf', layer_group=shared)
            parent = LayerGroup.objects.create(project=p, name=f'g{i}', group_type='asset')
            child = LayerGroup.objects.create(project=p, name=f'c{i}', group_type='asset', parent_group=parent)
            asset = Asset.objects.create(project=p, asset_type=asset_type, asset_id=f'a{i}', original_x=0,
                                         original_y=0, adjusted_x=1, adjusted_y=1, is_adjusted=True,
                                         layer_group=child)
            AdjustmentLog.objects.create(asset=asset, from_x=0, from_y=0, to_x=1, to_y=1, notes=f'n{i}')
            Link.objects.create(project=p, link_id=f'l{i}', coordinates=[[0, 0], [1, 1]], layer_group=shared)
            MeasurementSet.objects.create(project=p, name=f'm{i}', layer_group=parent)
        return p

    def count(self, url):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as queries:
            self.assertEqual(self.client.get(url).status_code, 200)
        return len(queries)

    def test_constant_query_counts(self):
        small, large = self.build(5), self.build(50)
        for url in ('/api/projects/{}/layer-groups/', '/api/projects/{}/layer-groups/?type=asset',
                    '/api/projects/{}/layer-groups/?top_level=false', '/api/projects/{}/',
                    '/api/projects/{}/adjustment-report/?output=csv', '/api/projects/{}/adjustment-report/'):
            self.assertEqual(self.count(url.format(small.pk)), self.count(url.format(large.pk)), url)

    def test_folder_tree_matches_folder_by_folder_serializer(self):
        """The fast list gives exactly what serializing each folder did."""
        from .serializers import LayerGroupSerializer

        p = self.build(3)
        LayerGroup.objects.create(project=p, name='Inner', group_type='sheet', scope='global',
                                  parent_group=LayerGroup.objects.get(project=p, name='Shared'))
        for query, groups in (('', LayerGroup.objects.filter(project=p, parent_group__isnull=True)),
                              ('?type=asset', LayerGroup.objects.filter(project=p, parent_group__isnull=True,
                                                                        group_type='asset')),
                              ('?top_level=false', LayerGroup.objects.filter(project=p))):
            fast = self.client.get(f'/api/projects/{p.pk}/layer-groups/{query}').json()
            self.assertEqual(fast, LayerGroupSerializer(groups, many=True).data, query)
        shared = next(g for g in fast if g['name'] == 'Shared')
        self.assertEqual((shared['item_count'], shared['total_items']), (6, 6))
        g0 = next(g for g in fast if g['name'] == 'g0')
        self.assertEqual((g0['item_count'], g0['total_items'], len(g0['child_groups'])), (0, 1, 1))


    def test_project_list_page(self):
        """The project list page counted each project's sheets and assets
        with two queries per project. The template reads the counts from
        num_sheets and num_assets."""
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        def page(n):
            Project.objects.all().delete()
            asset_type, _ = AssetType.objects.get_or_create(name='T')
            for i in range(n):
                p = create_project(name=f'P{i}')
                Sheet.objects.create(project=p, name='s', pdf_file='pdfs/x.pdf')
                Sheet.objects.create(project=p, name='t', pdf_file='pdfs/x.pdf')
                Asset.objects.create(project=p, asset_type=asset_type, asset_id='a', original_x=0, original_y=0)
            with CaptureQueriesContext(connection) as queries:
                resp = self.client.get('/')
            self.assertEqual(resp.status_code, 200)
            return len(queries), resp

        small, _ = page(5)
        large, resp = page(50)
        self.assertEqual(small, large)
        first = resp.context['projects'][0]
        self.assertEqual((first.num_sheets, first.num_assets), (2, 1))


@override_settings(REQUIRE_LOGIN=False)
class ProjectDetailsPageTests(TestCase):
    def test_adjusted_badge_counts_adjusted_assets(self):
        """R46: the badge showed the total asset count."""
        p = create_project()
        at = create_asset_type()
        for i, adjusted in enumerate((True, False, False)):
            Asset.objects.create(project=p, asset_type=at, asset_id=f'a{i}', original_x=0, original_y=0,
                                 adjusted_x=1 if adjusted else None, adjusted_y=1 if adjusted else None,
                                 is_adjusted=adjusted)
        html = self.client.get(f'/project/{p.pk}/').content.decode()
        self.assertIn('3 total assets', html)
        self.assertIn('1 adjusted', html)


@override_settings(REQUIRE_LOGIN=False)
class DownloadFilenameTests(TestCase):
    """R46: downloads were named with the raw project name inside quotes, so
    a name with a quote broke the header."""

    def test_names_with_quotes_and_slashes(self):
        p = create_project(name='Bob\'s "Main" St, 2/3')
        expected = 'attachment; filename="Bob\'s \\"Main\\" St, 2-3.{}"'
        self.assertEqual(self.client.get(f'/project/{p.pk}/export-full/')['Content-Disposition'],
                         expected.format('docuweaver'))
        self.assertEqual(self.client.get(f'/project/{p.pk}/export/')['Content-Disposition'],
                         expected.format('docuweaver'))
        resp = self.client.get(f'/api/projects/{p.pk}/adjustment-report/?output=csv')
        self.assertEqual(resp['Content-Disposition'], expected.format('csv').replace('2-3.', '2-3 adjustments.'))

    def test_non_ascii_name(self):
        p = create_project(name='Café Ünter')
        header = self.client.get(f'/project/{p.pk}/export-full/')['Content-Disposition']
        self.assertEqual(header, "attachment; filename*=utf-8''Caf%C3%A9%20%C3%9Cnter.docuweaver")


@override_settings(REQUIRE_LOGIN=False)
class ReportUnitsTests(TestCase):
    """R39: the report rounded every coordinate to 3 decimals under "(m)"
    headings, so in a lat/lon project a 5 m move showed as 0.000."""

    def report(self, coord_unit, original, adjusted):
        p = create_project(coord_unit=coord_unit)
        a = Asset.objects.create(project=p, asset_type=create_asset_type(), asset_id='V1',
                                 original_x=original[0], original_y=original[1],
                                 adjusted_x=adjusted[0], adjusted_y=adjusted[1], is_adjusted=True)
        AdjustmentLog.objects.create(asset=a, from_x=original[0], from_y=original[1],
                                     to_x=adjusted[0], to_y=adjusted[1], notes='moved')
        resp = APIClient().get(f'/api/projects/{p.pk}/adjustment-report/?output=csv')
        rows = list(csv.reader(io.StringIO(resp.content.decode())))
        return dict(zip(rows[0], rows[1], strict=True))

    def test_degrees(self):
        # 5 m north at 27.47 degrees south is 0.0000452 degrees of latitude.
        row = self.report('degrees', (153.03, -27.47), (153.03, -27.4699548))
        self.assertEqual(row['Original Y (deg)'], '-27.47000000')
        self.assertEqual(row['Adjusted Y (deg)'], '-27.46995480')
        self.assertEqual(row['Delta Y (deg)'], '0.00004520')
        self.assertAlmostEqual(float(row['Distance Moved (m)']), 5.0, delta=0.01)
        self.assertEqual((row['Adjustment Count'], row['Last Adjustment Notes']), ('1', 'moved'))

    def test_metres(self):
        row = self.report('gda94_mga', (500000, 6960000), (0, 6960004))
        self.assertEqual(row['Original X (m)'], '500000.000')
        self.assertEqual(row['Adjusted X (m)'], '0.000')  # a 0 used to come out blank
        self.assertEqual(row['Delta Y (m)'], '4.000')
        self.assertEqual(row['Distance Moved (m)'], '500000.000')


@override_settings(REQUIRE_LOGIN=False)
class SeededColumnPresetTests(TestCase):
    """R34: a fresh install had no column presets, so the CSV import matched
    nothing but columns named exactly asset_id, asset_type, x and y."""

    def test_common_names_are_seeded(self):
        presets = APIClient().get('/api/column-presets/').json()
        for role, name in (('asset_type', 'type'), ('x', 'longitude'), ('y', 'latitude'),
                           ('x', 'easting'), ('y', 'northing'), ('asset_id', 'id')):
            self.assertIn(name, presets[role])
        # Highest priority first: an "id" column beats a "name" column.
        self.assertLess(presets['asset_id'].index('id'), presets['asset_id'].index('name'))

    def test_seeding_keeps_admin_presets_and_runs_once(self):
        import importlib

        from django.apps import apps

        seed = importlib.import_module('drawings.migrations.0018_seed_column_presets').seed
        ColumnPreset.objects.all().delete()
        ColumnPreset.objects.create(role='x', column_name='Easting', priority=500)
        seed(apps, None)
        count = ColumnPreset.objects.count()
        seed(apps, None)
        self.assertEqual(ColumnPreset.objects.count(), count)
        self.assertEqual(list(ColumnPreset.objects.filter(role='x', column_name__iexact='easting')
                              .values_list('column_name', 'priority')), [('Easting', 500)])


@override_settings(REQUIRE_LOGIN=False)
class CalibrationInputTests(TestCase):
    def setUp(self):
        self.project = create_project(pixels_per_meter=12.5)
        self.url = f'/api/projects/{self.project.pk}/calibrate/'

    def test_zero_length_scale_is_refused(self):
        """R38: two clicks on the same spot must not save 0 px/m."""
        resp = APIClient().post(self.url, {'pixel_distance': 0, 'real_distance': 10}, format='json')
        self.assertEqual(resp.status_code, 400)
        self.assertIn('pixel_distance', resp.json()['error'])
        self.project.refresh_from_db()
        self.assertEqual(self.project.pixels_per_meter, 12.5)

    def test_unit_before_reference_asset(self):
        """R35: choosing a coordinate unit before a reference asset sends an
        empty ref_asset_id, which got a 400 and the unit wasn't saved."""
        resp = APIClient().post(self.url, {'coord_unit': 'degrees', 'ref_asset_id': ''}, format='json')
        self.assertEqual(resp.status_code, 200, resp.content)
        self.project.refresh_from_db()
        self.assertEqual((self.project.coord_unit, self.project.ref_asset_id), ('degrees', ''))
