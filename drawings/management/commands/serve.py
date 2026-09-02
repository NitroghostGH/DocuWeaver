"""Run DocuWeaver under the Waitress production WSGI server."""
import os

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Serve DocuWeaver with Waitress (a production-ready, cross-platform WSGI server).'

    def add_arguments(self, parser):
        parser.add_argument('--host', default=os.getenv('DOCUWEAVER_HOST', '127.0.0.1'),
                            help='Interface to bind (default 127.0.0.1; use 0.0.0.0 for LAN access)')
        parser.add_argument('--port', type=int, default=int(os.getenv('DOCUWEAVER_PORT', '8000')),
                            help='Port to listen on (default 8000)')
        parser.add_argument('--threads', type=int, default=int(os.getenv('DOCUWEAVER_THREADS', '4')),
                            help='Worker threads (default 4)')

    def handle(self, *args, **options):
        from waitress import serve

        host, port = options['host'], options['port']
        if not settings.DEBUG:
            # Production static storage needs collected, hashed files. Doing it
            # here (before the WSGI app and WhiteNoise are loaded) means
            # "python manage.py serve" just works after an upgrade.
            call_command('collectstatic', interactive=False, verbosity=0)

        from docuweaver.wsgi import application

        if settings.DEBUG:
            self.stdout.write(self.style.WARNING(
                'DJANGO_DEBUG is enabled. Set it to false for anything other than local development.'))
        self.stdout.write(self.style.SUCCESS(f'DocuWeaver listening on http://{host}:{port}/  (Ctrl+C to stop)'))
        serve(application, host=host, port=port, threads=options['threads'],
              # Large PDF uploads: don't buffer whole bodies in memory
              max_request_body_size=1024 * 1024 * 1024)
