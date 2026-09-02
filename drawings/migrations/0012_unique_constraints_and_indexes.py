# Recreated for the 1.0 release. The original 0012 was generated locally but
# never committed; migration 0013 depends on it by name, so this file restores
# the exact schema changes Django reports between 0011 and the current models.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('drawings', '0011_alter_layergroup_group_type'),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name='asset',
            unique_together=set(),
        ),
        migrations.AlterUniqueTogether(
            name='columnpreset',
            unique_together=set(),
        ),
        migrations.AlterUniqueTogether(
            name='link',
            unique_together=set(),
        ),
        migrations.AlterField(
            model_name='asset',
            name='is_adjusted',
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddConstraint(
            model_name='asset',
            constraint=models.UniqueConstraint(fields=('project', 'asset_id'), name='unique_project_asset'),
        ),
        migrations.AddConstraint(
            model_name='columnpreset',
            constraint=models.UniqueConstraint(fields=('role', 'column_name'), name='unique_role_column'),
        ),
        migrations.AddConstraint(
            model_name='link',
            constraint=models.UniqueConstraint(fields=('project', 'link_id'), name='unique_project_link'),
        ),
    ]
