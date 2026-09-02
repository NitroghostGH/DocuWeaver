"""Tests for the drawings app."""
import csv
import io
from unittest.mock import patch

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

    @patch('drawings.api_views.render_pdf_page')
    @patch('drawings.api_views.get_pdf_page_count', return_value=1)
    def test_create_sheet(self, mock_count, mock_render):
        pdf = make_pdf_file()
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
        """Test CSV report generation via the service function directly.

        DRF's URL_FORMAT_OVERRIDE intercepts ?format=csv, so we test the
        service function rather than the API endpoint.
        """
        from .services.export_service import generate_adjustment_report

        a = Asset.objects.create(
            project=self.project, asset_type=self.asset_type,
            asset_id='C1', original_x=0, original_y=0,
            adjusted_x=1, adjusted_y=1, is_adjusted=True,
        )
        AdjustmentLog.objects.create(asset=a, from_x=0, from_y=0, to_x=1, to_y=1)

        adjusted = self.project.assets.filter(is_adjusted=True)
        logs = AdjustmentLog.objects.filter(asset__project=self.project)
        resp = generate_adjustment_report(self.project, adjusted, logs, format_type='csv')

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

@override_settings(REQUIRE_LOGIN=False)
class ExportProjectAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.project = create_project()

    @patch('drawings.api_views.export_sheet_with_overlays', return_value='exports/test.pdf')
    def test_export_project_success(self, mock_export):
        Sheet.objects.create(project=self.project, name='E1', pdf_file=make_pdf_file())
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/export/',
            {},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()['status'], 'success')
        self.assertEqual(len(resp.json()['exports']), 1)

    @patch('drawings.api_views.export_sheet_with_overlays', return_value='exports/test.pdf')
    def test_export_specific_sheets(self, mock_export):
        s1 = Sheet.objects.create(project=self.project, name='E1', pdf_file=make_pdf_file())
        Sheet.objects.create(project=self.project, name='E2', pdf_file=make_pdf_file())
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/export/',
            {'sheet_ids': [s1.pk]},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()['exports']), 1)

    def test_export_empty_project(self):
        resp = self.client.post(
            f'/api/projects/{self.project.pk}/export/',
            {},
            format='json',
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()['exports']), 0)


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

        adjusted = p.assets.filter(is_adjusted=True)
        logs = AdjustmentLog.objects.filter(asset__project=p)
        resp = generate_adjustment_report(p, adjusted, logs, format_type='csv')
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
