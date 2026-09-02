"""CSV import service for asset data."""
import csv
import io
import json
import logging

from django.db import transaction

from ..models import Asset, AssetType, ImportBatch, LayerGroup, Link

logger = logging.getLogger(__name__)

# Default column names when no mapping is provided
DEFAULT_MAPPING = {
    'asset_id': 'asset_id',
    'asset_type': 'asset_type',
    'x': 'x',
    'y': 'y',
    'name': 'name',
}


def import_assets_from_csv(project, csv_file, column_mapping=None, filename=None, fixed_asset_type=None):
    """
    Import assets from a CSV file into a project.

    Args:
        project: Project model instance
        csv_file: Uploaded file object
        column_mapping: Optional dict mapping roles to CSV column names, e.g.
            {'asset_id': 'TN', 'asset_type': 'asset_type', 'x': 'Easting', 'y': 'Northing'}
        filename: Original filename for batch tracking
        fixed_asset_type: Optional asset type name to apply to all rows (skips column lookup)

    Returns:
        dict with import results
    """
    mapping = {**DEFAULT_MAPPING, **(column_mapping or {})}

    # Read the CSV content
    content = csv_file.read()
    if isinstance(content, bytes):
        content = content.decode('utf-8-sig')  # Handle BOM if present

    reader = csv.DictReader(io.StringIO(content))

    # Validate that mapped columns exist in the CSV
    fieldnames = reader.fieldnames
    required_roles = ['asset_id', 'x', 'y']
    if not fixed_asset_type:
        required_roles.append('asset_type')
    missing = []
    for role in required_roles:
        col = mapping.get(role, '')
        if not col or col not in fieldnames:
            missing.append(f"{role} (mapped to '{col}')")
    if missing:
        raise ValueError(f"Missing columns in CSV: {', '.join(missing)}")

    # Build set of mapped column names to exclude from metadata
    mapped_columns = set(mapping.values())

    # Get or create asset types
    asset_types_cache = {at.name.lower(): at for at in AssetType.objects.all()}

    results = {
        'created': 0,
        'updated': 0,
        'errors': [],
        'assets': []
    }

    col_id = mapping['asset_id']
    col_type = mapping.get('asset_type', '') if not fixed_asset_type else ''
    col_x = mapping['x']
    col_y = mapping['y']
    col_name = mapping.get('name', '')

    # Resolve fixed asset type once if provided
    fixed_type_obj = None
    if fixed_asset_type:
        fixed_key = fixed_asset_type.lower()
        if fixed_key not in asset_types_cache:
            fixed_type_obj = AssetType.objects.create(name=fixed_asset_type)
            asset_types_cache[fixed_key] = fixed_type_obj
        else:
            fixed_type_obj = asset_types_cache[fixed_key]

    with transaction.atomic():
        # Create import batch for tracking
        batch_filename = filename or getattr(csv_file, 'name', 'unknown.csv')
        batch = ImportBatch.objects.create(
            project=project,
            filename=batch_filename,
            asset_count=0
        )

        # Create a layer group for this import
        group_name = batch_filename.rsplit('.', 1)[0] if '.' in batch_filename else batch_filename
        layer_group = LayerGroup.objects.create(
            project=project,
            name=group_name,
            group_type='asset',
            import_batch=batch
        )

        for row_num, row in enumerate(reader, start=2):  # Start at 2 (1-indexed + header)
            try:
                # Extract fields using mapped column names
                asset_id = row.get(col_id, '').strip()
                x_str = row.get(col_x, '').strip()
                y_str = row.get(col_y, '').strip()

                if not asset_id:
                    results['errors'].append(f"Row {row_num}: Missing asset_id (column '{col_id}')")
                    continue

                # Parse coordinates
                try:
                    x = float(x_str)
                    y = float(y_str)
                except ValueError:
                    results['errors'].append(f"Row {row_num}: Invalid coordinates ({col_x}={x_str}, {col_y}={y_str})")
                    continue

                # Resolve asset type
                if fixed_type_obj:
                    asset_type = fixed_type_obj
                else:
                    asset_type_name = row.get(col_type, '').strip()
                    if not asset_type_name:
                        results['errors'].append(f"Row {row_num}: Missing asset_type (column '{col_type}')")
                        continue
                    asset_type_key = asset_type_name.lower()
                    if asset_type_key not in asset_types_cache:
                        asset_type = AssetType.objects.create(name=asset_type_name)
                        asset_types_cache[asset_type_key] = asset_type
                    else:
                        asset_type = asset_types_cache[asset_type_key]

                # Build metadata from extra columns (not mapped to any role)
                metadata = {}
                for key, value in row.items():
                    if key not in mapped_columns and value:
                        metadata[key] = value

                # Get optional name
                name = row.get(col_name, '').strip() if col_name else ''

                # Create or update asset
                asset, created = Asset.objects.update_or_create(
                    project=project,
                    asset_id=asset_id,
                    defaults={
                        'asset_type': asset_type,
                        'name': name,
                        'original_x': x,
                        'original_y': y,
                        'metadata': metadata,
                        'import_batch': batch,
                        'layer_group': layer_group,
                    }
                )

                if created:
                    results['created'] += 1
                else:
                    results['updated'] += 1

                results['assets'].append({
                    'asset_id': asset_id,
                    'created': created,
                    'x': x,
                    'y': y
                })

            except Exception as e:
                results['errors'].append(f"Row {row_num}: {str(e)}")

        # Update batch asset count
        batch.asset_count = results['created'] + results['updated']
        batch.save(update_fields=['asset_count'])

        # Add layer group info to results
        results['layer_group'] = {
            'id': layer_group.id,
            'name': layer_group.name
        }

    logger.info("CSV import for project %d: %d created, %d updated, %d errors",
                project.pk, results['created'], results['updated'], len(results['errors']))
    if results['errors']:
        logger.warning("CSV import errors: %s", results['errors'][:5])  # Log first 5

    return results


def parse_coordinates_column(coord_str):
    """
    Parse a coordinates string from CSV into a list of [lon, lat] pairs.

    Supports formats:
    - JSON array: [[145.74, -16.96], [145.75, -16.95]]
    - Scientific notation: [[1.457403970000000e+02, -1.695981400000000e+01], ...]
    - Semicolon-separated pairs: 145.74,-16.96;145.75,-16.95

    Returns:
        list: Array of [lon, lat] pairs, or None if parsing fails
    """
    if not coord_str or not coord_str.strip():
        return None

    coord_str = coord_str.strip()

    # Try JSON parsing first (handles scientific notation too)
    if coord_str.startswith('['):
        try:
            coords = json.loads(coord_str)
            if isinstance(coords, list) and len(coords) >= 2:
                # Validate structure - either list of pairs or needs conversion
                if isinstance(coords[0], (list, tuple)):
                    # Already in [[lon, lat], ...] format
                    return [[float(p[0]), float(p[1])] for p in coords]
                elif isinstance(coords[0], (int, float)):
                    # Flat array - convert to pairs
                    pairs = []
                    for i in range(0, len(coords) - 1, 2):
                        pairs.append([float(coords[i]), float(coords[i + 1])])
                    return pairs if len(pairs) >= 2 else None
        except (json.JSONDecodeError, ValueError, TypeError, IndexError):
            pass

    # Try semicolon-separated format: lon,lat;lon,lat;...
    if ';' in coord_str or (coord_str.count(',') >= 3):
        try:
            pairs = []
            # Split by semicolon or by every other comma
            if ';' in coord_str:
                for pair_str in coord_str.split(';'):
                    pair_str = pair_str.strip()
                    if ',' in pair_str:
                        parts = pair_str.split(',')
                        pairs.append([float(parts[0].strip()), float(parts[1].strip())])
            else:
                # Comma-only format: lon1,lat1,lon2,lat2,...
                parts = [p.strip() for p in coord_str.split(',')]
                for i in range(0, len(parts) - 1, 2):
                    pairs.append([float(parts[i]), float(parts[i + 1])])

            return pairs if len(pairs) >= 2 else None
        except (ValueError, IndexError):
            pass

    return None


def import_links_from_csv(project, csv_file, column_mapping=None, filename=None):
    """
    Import links (polylines) from a CSV file into a project.

    Args:
        project: Project model instance
        csv_file: Uploaded file object
        column_mapping: Dict mapping roles to CSV column names, e.g.
            {'link_id': 'ID', 'coordinates': 'Coords', 'name': 'Name', 'link_type': 'Type'}
        filename: Original filename for batch tracking

    Returns:
        dict with import results
    """
    default_mapping = {
        'link_id': 'link_id',
        'coordinates': 'coordinates',
        'name': 'name',
        'link_type': 'link_type',
        'color': 'color',
        'width': 'width',
    }
    mapping = {**default_mapping, **(column_mapping or {})}

    # Read the CSV content
    content = csv_file.read()
    if isinstance(content, bytes):
        content = content.decode('utf-8-sig')  # Handle BOM if present

    reader = csv.DictReader(io.StringIO(content))

    # Validate required columns
    fieldnames = reader.fieldnames
    required_roles = ['link_id', 'coordinates']
    missing = []
    for role in required_roles:
        col = mapping.get(role, '')
        if not col or col not in fieldnames:
            missing.append(f"{role} (mapped to '{col}')")
    if missing:
        raise ValueError(f"Missing columns in CSV: {', '.join(missing)}")

    # Build set of mapped column names to exclude from metadata
    mapped_columns = set(mapping.values())

    results = {
        'created': 0,
        'updated': 0,
        'errors': [],
        'links': []
    }

    col_id = mapping['link_id']
    col_coords = mapping['coordinates']
    col_name = mapping.get('name', '')
    col_type = mapping.get('link_type', '')
    col_color = mapping.get('color', '')
    col_width = mapping.get('width', '')

    with transaction.atomic():
        # Create import batch for tracking
        batch_filename = filename or getattr(csv_file, 'name', 'unknown.csv')
        batch = ImportBatch.objects.create(
            project=project,
            filename=f"links:{batch_filename}",
            asset_count=0  # Will update with link count
        )

        # Create a layer group for this import
        group_name = batch_filename.rsplit('.', 1)[0] if '.' in batch_filename else batch_filename
        layer_group = LayerGroup.objects.create(
            project=project,
            name=group_name,
            group_type='link',
            import_batch=batch
        )

        for row_num, row in enumerate(reader, start=2):
            try:
                link_id = row.get(col_id, '').strip()
                coords_str = row.get(col_coords, '')

                if not link_id:
                    results['errors'].append(f"Row {row_num}: Missing link_id (column '{col_id}')")
                    continue

                # Parse coordinates
                coordinates = parse_coordinates_column(coords_str)
                if not coordinates:
                    results['errors'].append(f"Row {row_num}: Invalid or missing coordinates for {link_id}")
                    continue

                # Optional fields
                name = row.get(col_name, '').strip() if col_name and col_name in fieldnames else ''
                link_type = row.get(col_type, '').strip().lower() if col_type and col_type in fieldnames else 'other'

                # Validate link_type against choices
                valid_types = ['pipe', 'cable', 'conduit', 'duct', 'main', 'service', 'other']
                if link_type not in valid_types:
                    link_type = 'other'

                # Color
                color = '#0066FF'  # Default blue
                if col_color and col_color in fieldnames:
                    color_val = row.get(col_color, '').strip()
                    if color_val.startswith('#') and len(color_val) == 7:
                        color = color_val

                # Width
                width = 2
                if col_width and col_width in fieldnames:
                    try:
                        width = max(1, min(10, int(row.get(col_width, '2'))))
                    except ValueError:
                        pass

                # Build metadata from extra columns
                metadata = {}
                for key, value in row.items():
                    if key not in mapped_columns and value:
                        metadata[key] = value

                # Create or update link
                link, created = Link.objects.update_or_create(
                    project=project,
                    link_id=link_id,
                    defaults={
                        'name': name,
                        'coordinates': coordinates,
                        'color': color,
                        'width': width,
                        'link_type': link_type,
                        'metadata': metadata,
                        'import_batch': batch,
                        'layer_group': layer_group,
                    }
                )

                if created:
                    results['created'] += 1
                else:
                    results['updated'] += 1

                results['links'].append({
                    'link_id': link_id,
                    'created': created,
                    'point_count': len(coordinates)
                })

            except Exception as e:
                results['errors'].append(f"Row {row_num}: {str(e)}")

        # Update batch count
        batch.asset_count = results['created'] + results['updated']
        batch.save(update_fields=['asset_count'])

        # Add layer group info to results
        results['layer_group'] = {
            'id': layer_group.id,
            'name': layer_group.name
        }

    logger.info("Link CSV import for project %d: %d created, %d updated, %d errors",
                project.pk, results['created'], results['updated'], len(results['errors']))
    if results['errors']:
        logger.warning("Link import errors: %s", results['errors'][:5])

    return results
