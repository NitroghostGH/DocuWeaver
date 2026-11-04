"""Remove assets whose coordinates aren't finite numbers.

Before 1.1.0 the asset CSV importer accepted "inf" as a coordinate. Such an
asset could never be drawn, and once one was stored its project's whole asset
list failed to load ("Out of range float values are not JSON compliant").
The importer now rejects those rows; this removes any that were stored, and
prints what it removed so they can be imported again with correct values.

(Links can't be affected: SQLite's JSON check rejects NaN and Infinity, so
such a link was never stored.)
"""
import math

from django.db import migrations


def _finite(*values):
    try:
        return all(math.isfinite(float(v)) for v in values)
    except (TypeError, ValueError):
        return False


def remove_non_finite(apps, schema_editor):
    Asset = apps.get_model('drawings', 'Asset')

    bad = [a for a in Asset.objects.select_related('project')
           .only('id', 'asset_id', 'original_x', 'original_y', 'project__name')
           if not _finite(a.original_x, a.original_y)]
    if bad:
        print(f'\n  Removing {len(bad)} asset(s) with coordinates that are not finite numbers:')
        for asset in bad:
            print(f'    project "{asset.project.name}": {asset.asset_id}')
        Asset.objects.filter(pk__in=[a.pk for a in bad]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('drawings', '0014_save_sheet_cascade_offsets'),
    ]

    operations = [
        migrations.RunPython(remove_non_finite, migrations.RunPython.noop),
    ]
