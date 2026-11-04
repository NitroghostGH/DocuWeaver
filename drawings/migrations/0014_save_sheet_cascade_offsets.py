"""Store the cascade offset the editor used to apply on the fly.

Until 1.1.0 the editor drew every sheet saved at (0, 0), other than the first,
at (index * 50, index * 50), without saving that position. A sheet the user
had deliberately placed at (0, 0) was therefore drawn somewhere else. The
editor now draws saved positions as they are, and new sheets get their
cascaded offset when uploaded. This migration saves the offset the editor
was showing, so existing projects look the same as before.
"""
from django.db import migrations

CASCADE_STEP_PX = 50


def save_cascade_offsets(apps, schema_editor):
    Project = apps.get_model('drawings', 'Project')
    Sheet = apps.get_model('drawings', 'Sheet')
    for project in Project.objects.all():
        # Same order as the sheet API, which is the order the editor used.
        sheets = Sheet.objects.filter(project=project).order_by('z_index', 'name')
        for index, sheet in enumerate(sheets):
            if index > 0 and sheet.offset_x == 0 and sheet.offset_y == 0:
                sheet.offset_x = sheet.offset_y = index * CASCADE_STEP_PX
                sheet.save(update_fields=['offset_x', 'offset_y'])


class Migration(migrations.Migration):

    dependencies = [
        ('drawings', '0013_add_pdf_layers_to_sheet'),
    ]

    operations = [
        migrations.RunPython(save_cascade_offsets, migrations.RunPython.noop),
    ]
