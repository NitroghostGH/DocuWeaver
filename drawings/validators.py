"""Custom validators for the drawings app."""
from django.conf import settings
from django.core.exceptions import ValidationError
from django.utils.deconstruct import deconstructible

# python-magic is optional - provides enhanced MIME type detection
try:
    import magic
    HAS_MAGIC = True
except ImportError:
    HAS_MAGIC = False


def detected_mime(header):
    """The MIME type python-magic reports for ``header``, or None when it
    isn't installed or fails (the header checks still apply then)."""
    if not HAS_MAGIC:
        return None
    try:
        return magic.from_buffer(header, mime=True)
    except Exception:
        return None


@deconstructible
class PDFFileValidator:
    """
    Validator that checks if an uploaded file is a valid PDF.
    Uses python-magic to check the file's actual content type,
    not just the extension.
    """
    allowed_mime_types = ['application/pdf']

    def __init__(self, max_size=None):
        # None: the DOCUWEAVER_MAX_UPLOAD_MB setting, read when a file is checked.
        self.max_size = max_size

    def __call__(self, file):
        # Check file size
        max_size = self.max_size or getattr(settings, 'DOCUWEAVER_MAX_UPLOAD_MB', 50) * 1024 * 1024
        if file.size > max_size:
            raise ValidationError(
                f'File size ({file.size / 1024 / 1024:.1f} MB) exceeds maximum allowed size '
                f'({max_size / 1024 / 1024:.1f} MB).'
                + ('' if self.max_size else ' An administrator can raise DOCUWEAVER_MAX_UPLOAD_MB.')
            )

        # Check file extension
        if not file.name.lower().endswith('.pdf'):
            raise ValidationError('File must have a .pdf extension.')

        # Check actual file content using magic bytes
        file.seek(0)
        file_header = file.read(2048)
        file.seek(0)

        # Check PDF magic bytes (PDF files start with %PDF-)
        if not file_header.startswith(b'%PDF-'):
            raise ValidationError(
                'Invalid PDF file. The file content does not match PDF format.'
            )

        # Additional check using python-magic if available. (Only the call is
        # guarded: the rejection used to be caught by its own except.)
        mime_type = detected_mime(file_header)
        if mime_type is not None and mime_type not in self.allowed_mime_types:
            raise ValidationError(
                f'Invalid file type: {mime_type}. Only PDF files are allowed.'
            )

    def __eq__(self, other):
        return (
            isinstance(other, PDFFileValidator) and
            self.max_size == other.max_size
        )


@deconstructible
class ImageFileValidator:
    """
    Validator that checks if an uploaded file is a valid image.
    """
    allowed_extensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
    allowed_mime_types = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
    max_size = 5 * 1024 * 1024  # 5 MB default

    def __init__(self, max_size=None):
        if max_size is not None:
            self.max_size = max_size

    def __call__(self, file):
        # Check file size
        if file.size > self.max_size:
            raise ValidationError(
                f'File size ({file.size / 1024 / 1024:.1f} MB) exceeds maximum allowed size '
                f'({self.max_size / 1024 / 1024:.1f} MB).'
            )

        # Check file extension
        ext = '.' + file.name.lower().split('.')[-1] if '.' in file.name else ''
        if ext not in self.allowed_extensions:
            raise ValidationError(
                f'Invalid file extension: {ext}. Allowed: {", ".join(self.allowed_extensions)}'
            )

        # Check actual file content using magic bytes
        file.seek(0)
        file_header = file.read(2048)
        file.seek(0)

        # The header must be one of the allowed formats whether or not
        # python-magic is installed; magic, when present, must agree.
        is_png = file_header.startswith(b'\x89PNG')
        is_jpeg = file_header.startswith(b'\xff\xd8\xff')
        is_gif = file_header.startswith(b'GIF87a') or file_header.startswith(b'GIF89a')
        is_webp = file_header[:4] == b'RIFF' and file_header[8:12] == b'WEBP'

        if not (is_png or is_jpeg or is_gif or is_webp):
            raise ValidationError(
                'Invalid image file. The file content does not match expected image format.'
            )

        mime_type = detected_mime(file_header)
        if mime_type is not None and mime_type not in self.allowed_mime_types:
            raise ValidationError(
                f'Invalid file type: {mime_type}. Only image files are allowed.'
            )

    def __eq__(self, other):
        return (
            isinstance(other, ImageFileValidator) and
            self.max_size == other.max_size
        )


# Convenience instances
validate_pdf = PDFFileValidator()
validate_image = ImageFileValidator()
