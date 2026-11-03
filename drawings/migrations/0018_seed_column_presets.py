"""Seed common CSV column names for the asset import's column matching.

The import dialog picks, for each role, the first preset (highest priority)
that equals a CSV header, ignoring case. A fresh install had no presets, so
"Type", "Latitude" or "Easting" were never matched. Presets an administrator
already made are kept, and a name already present for a role in any case is
not added again.
"""
from django.db import migrations

# role -> [(column name, priority)]; higher priority wins when a file has
# more than one matching column.
SEED = {
    'asset_id': [('asset_id', 100), ('asset id', 95), ('assetid', 90), ('id', 80),
                 ('asset', 60), ('name', 10)],
    'asset_type': [('asset_type', 100), ('asset type', 95), ('type', 80), ('category', 60)],
    'x': [('x', 100), ('easting', 95), ('east', 90), ('longitude', 85), ('lon', 80),
          ('long', 75), ('lng', 70), ('e', 50)],
    'y': [('y', 100), ('northing', 95), ('north', 90), ('latitude', 85), ('lat', 80), ('n', 50)],
    'name': [('name', 100), ('asset_name', 95), ('asset name', 90), ('label', 60)],
}


def seed(apps, schema_editor):
    ColumnPreset = apps.get_model('drawings', 'ColumnPreset')
    for role, columns in SEED.items():
        for column_name, priority in columns:
            if not ColumnPreset.objects.filter(role=role, column_name__iexact=column_name).exists():
                ColumnPreset.objects.create(role=role, column_name=column_name, priority=priority)


def unseed(apps, schema_editor):
    ColumnPreset = apps.get_model('drawings', 'ColumnPreset')
    for role, columns in SEED.items():
        for column_name, priority in columns:
            ColumnPreset.objects.filter(role=role, column_name=column_name, priority=priority).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('drawings', '0017_saved_item_visibility'),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
