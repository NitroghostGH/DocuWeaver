"""Custom validators for the drawings app."""
from django.core.exceptions import ValidationError
from django.utils.deconstruct import deconstructible

# python-magic is optional - provides enhanced MIME type detection
try:
    import magic
    HAS_MAGIC = True
except ImportError:
    HAS_MAGIC = False


@deconstructible
class PDFFileValidator:
    """
    Validator that checks if an uploaded file is a valid PDF.
    Uses python-magic to check the file's actual content type,
    not just the extension.
    """
    allowed_mime_types = ['application/pdf']
    max_size = 50 * 1024 * 1024  # 50 MB default

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

        # Additional check using python-magic if available
        if HAS_MAGIC:
            try:
                mime_type = magic.from_buffer(file_header, mime=True)
                if mime_type not in self.allowed_mime_types:
                    raise ValidationError(
                        f'Invalid file type: {mime_type}. Only PDF files are allowed.'
                    )
            except Exception:
                # If magic fails, rely on the header check above
                pass

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

        if HAS_MAGIC:
            try:
                mime_type = magic.from_buffer(file_header, mime=True)
                if mime_type not in self.allowed_mime_types:
                    raise ValidationError(
                        f'Invalid file type: {mime_type}. Only image files are allowed.'
                    )
                return  # Magic check passed, no need for fallback
            except Exception:
                pass  # Fall through to basic header checks

        # Basic header checks (fallback when magic is unavailable or fails)
        # PNG: starts with \x89PNG
        # JPEG: starts with \xff\xd8\xff
        # GIF: starts with GIF87a or GIF89a
        is_png = file_header.startswith(b'\x89PNG')
        is_jpeg = file_header.startswith(b'\xff\xd8\xff')
        is_gif = file_header.startswith(b'GIF87a') or file_header.startswith(b'GIF89a')

        if not (is_png or is_jpeg or is_gif):
            raise ValidationError(
                'Invalid image file. The file content does not match expected image format.'
            )

    def __eq__(self, other):
        return (
            isinstance(other, ImageFileValidator) and
            self.max_size == other.max_size
        )


# Convenience instances
validate_pdf = PDFFileValidator()
validate_image = ImageFileValidator()
