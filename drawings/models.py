"""Models for the PDF alignment and asset overlay system."""
import math

from django.db import models

from .validators import ImageFileValidator, PDFFileValidator


class Project(models.Model):
    """A project containing multiple sheets and assets."""
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Coordinate system calibration
    COORD_UNIT_CHOICES = [
        ('meters', 'Meters'),
        ('degrees', 'Lat/Lon Degrees (WGS84)'),
        ('gda94_geo', 'GDA94 Geographic (Lat/Lon)'),
        ('gda94_mga', 'GDA94 MGA (Easting/Northing)'),
    ]
    pixels_per_meter = models.FloatField(default=100.0, help_text="Scale factor from pixels to meters")
    scale_calibrated = models.BooleanField(default=False, help_text="Whether scale has been explicitly calibrated")
    coord_unit = models.CharField(max_length=10, choices=COORD_UNIT_CHOICES, default='meters',
                                  help_text="Unit of asset coordinates: meters or lat/lon degrees")
    origin_x = models.FloatField(default=0.0, help_text="X coordinate of origin in pixels")
    origin_y = models.FloatField(default=0.0, help_text="Y coordinate of origin in pixels")

    # Viewport rotation (for aligning drawings with different orientations)
    canvas_rotation = models.FloatField(default=0.0, help_text="Viewport rotation in degrees")

    # Asset layer calibration (independent of viewport)
    asset_rotation = models.FloatField(default=0.0, help_text="Asset layer rotation in degrees")
    ref_asset_id = models.CharField(max_length=100, blank=True, default='', help_text="Asset ID of the reference point asset")
    ref_pixel_x = models.FloatField(default=0.0, help_text="Pixel X where reference asset was placed on canvas")
    ref_pixel_y = models.FloatField(default=0.0, help_text="Pixel Y where reference asset was placed on canvas")

    # Cadastre overlay settings
    cadastre_color = models.CharField(max_length=7, default='#FF6600', help_text="Color for cadastre boundaries")
    cadastre_enabled = models.BooleanField(default=False, help_text="Enable cadastre overlay layer")

    # OpenStreetMap overlay settings
    osm_enabled = models.BooleanField(default=False, help_text="Enable OpenStreetMap tile layer")
    osm_opacity = models.FloatField(default=0.7, help_text="Opacity of OSM layer (0.0 to 1.0)")
    osm_z_index = models.IntegerField(default=0, help_text="Z-index for OSM layer ordering (0=bottom, higher=top)")

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.name


class Sheet(models.Model):
    """A single PDF page/sheet within a project."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='sheets')
    name = models.CharField(max_length=255)
    pdf_file = models.FileField(
        upload_to='pdfs/',
        validators=[PDFFileValidator(max_size=50 * 1024 * 1024)]  # 50 MB max
    )
    page_number = models.PositiveIntegerField(default=1, help_text="Page number within the PDF")

    # PDF Optional Content Groups (layers)
    pdf_layers = models.JSONField(default=list, blank=True,
        help_text="Available OCG layers: [{xref: int, name: str}, ...]")
    visible_layers = models.JSONField(default=list, blank=True,
        help_text="List of visible layer xrefs (empty = all visible)")

    # Layer group for organizing sheets into folders
    layer_group = models.ForeignKey(
        'LayerGroup',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='sheets_in_group'
    )

    # Rendered image cache
    rendered_image = models.ImageField(upload_to='rendered/', blank=True, null=True)
    image_width = models.PositiveIntegerField(default=0)
    image_height = models.PositiveIntegerField(default=0)

    # Cut lines (array of {p1: {x, y}, p2: {x, y}, flipped: bool})
    cuts_json = models.JSONField(default=list, blank=True,
        help_text="Array of cut definitions: [{p1: {x, y}, p2: {x, y}, flipped: bool}, ...]")

    # Crop/cut state
    crop_flipped = models.BooleanField(default=False, help_text="Whether the crop is flipped")

    # Position offset for alignment
    offset_x = models.FloatField(default=0.0, help_text="X offset in pixels")
    offset_y = models.FloatField(default=0.0, help_text="Y offset in pixels")
    rotation = models.FloatField(default=0.0, help_text="Rotation in degrees")
    z_index = models.IntegerField(default=0, help_text="Layer order (higher = on top)")

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['z_index', 'name']

    def __str__(self):
        return f"{self.name} (Page {self.page_number})"

    def delete(self, *args, **kwargs):
        pdf_path = self.pdf_file.name if self.pdf_file else None
        rendered_path = self.rendered_image.name if self.rendered_image else None

        # Check if other sheets share the same PDF file
        other_pdf_users = 0
        if pdf_path:
            other_pdf_users = Sheet.objects.filter(pdf_file=pdf_path).exclude(pk=self.pk).count()

        # Delete the DB record (without auto-deleting the file)
        super().delete(*args, **kwargs)

        # Only delete files if no other sheets reference them
        if pdf_path and other_pdf_users == 0:
            self.pdf_file.storage.delete(pdf_path)
        if rendered_path:
            self.rendered_image.storage.delete(rendered_path)


class JoinMark(models.Model):
    """A join mark on a sheet that references another sheet."""
    sheet = models.ForeignKey(Sheet, on_delete=models.CASCADE, related_name='join_marks')

    # Position on sheet (in pixels)
    x = models.FloatField()
    y = models.FloatField()

    # Reference label (e.g., "JOIN TO SHEET B-3")
    reference_label = models.CharField(max_length=255)

    # Link to the matching join mark on another sheet
    linked_mark = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='linked_from'
    )

    def __str__(self):
        return f"{self.reference_label} at ({self.x}, {self.y})"


class AssetType(models.Model):
    """Configurable asset type with icon settings (editable in Django admin)."""
    ICON_CHOICES = [
        ('circle', 'Circle'),
        ('square', 'Square'),
        ('triangle', 'Triangle'),
        ('star', 'Star'),
        ('diamond', 'Diamond'),
        ('custom', 'Custom Image'),
    ]

    name = models.CharField(max_length=100, unique=True)
    icon_shape = models.CharField(max_length=20, choices=ICON_CHOICES, default='circle')
    custom_icon = models.ImageField(
        upload_to='icons/',
        blank=True,
        null=True,
        help_text="Custom icon image (PNG/JPG)",
        validators=[ImageFileValidator(max_size=5 * 1024 * 1024)]  # 5 MB max
    )
    color = models.CharField(max_length=7, default='#FF0000', help_text="Hex color code")
    size = models.PositiveIntegerField(default=20, help_text="Icon size in pixels")

    class Meta:
        verbose_name = "Asset Type"
        verbose_name_plural = "Asset Types"

    def save(self, *args, **kwargs):
        # Auto-sync icon_shape with custom_icon presence
        if self.custom_icon:
            self.icon_shape = 'custom'
        elif self.icon_shape == 'custom':
            # Reset to default if custom icon was removed
            self.icon_shape = 'circle'
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class ImportBatch(models.Model):
    """A batch of assets imported from a single CSV file."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='import_batches')
    filename = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    asset_count = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.filename} ({self.asset_count} assets)"


class Asset(models.Model):
    """An asset with coordinates to be plotted on the drawing."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='assets')
    asset_type = models.ForeignKey(AssetType, on_delete=models.PROTECT, related_name='assets')
    import_batch = models.ForeignKey('ImportBatch', on_delete=models.SET_NULL, null=True, blank=True, related_name='assets')
    layer_group = models.ForeignKey('LayerGroup', on_delete=models.SET_NULL, null=True, blank=True, related_name='assets')

    # Identifier from source data
    asset_id = models.CharField(max_length=100)
    name = models.CharField(max_length=255, blank=True)

    # Original coordinates from data source (in meters)
    original_x = models.FloatField()
    original_y = models.FloatField()

    # Adjusted coordinates after manual correction (in meters)
    adjusted_x = models.FloatField(null=True, blank=True)
    adjusted_y = models.FloatField(null=True, blank=True)

    # Flag to track if asset has been manually adjusted
    is_adjusted = models.BooleanField(default=False, db_index=True)

    # Additional metadata from CSV
    metadata = models.JSONField(default=dict, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['asset_id']
        constraints = [
            models.UniqueConstraint(fields=['project', 'asset_id'], name='unique_project_asset'),
        ]

    def __str__(self):
        return f"{self.asset_id} - {self.name}"

    @property
    def current_x(self):
        """Return adjusted X if available, otherwise original."""
        return self.adjusted_x if self.is_adjusted else self.original_x

    @property
    def current_y(self):
        """Return adjusted Y if available, otherwise original."""
        return self.adjusted_y if self.is_adjusted else self.original_y

    @property
    def delta_distance(self):
        """Calculate the distance between original and adjusted positions."""
        if not self.is_adjusted:
            return 0.0
        dx = self.adjusted_x - self.original_x
        dy = self.adjusted_y - self.original_y
        return math.sqrt(dx * dx + dy * dy)


class AdjustmentLog(models.Model):
    """Log of manual adjustments made to assets."""
    asset = models.ForeignKey(Asset, on_delete=models.CASCADE, related_name='adjustment_logs')

    # Coordinates before adjustment (in meters)
    from_x = models.FloatField()
    from_y = models.FloatField()

    # Coordinates after adjustment (in meters)
    to_x = models.FloatField()
    to_y = models.FloatField()

    # Calculated deltas
    delta_x = models.FloatField()
    delta_y = models.FloatField()
    delta_distance = models.FloatField()

    # Metadata
    timestamp = models.DateTimeField(auto_now_add=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ['-timestamp']

    def __str__(self):
        return f"{self.asset.asset_id} adjusted {self.delta_distance:.2f}m on {self.timestamp}"

    def save(self, *args, **kwargs):
        # Calculate deltas before saving
        self.delta_x = self.to_x - self.from_x
        self.delta_y = self.to_y - self.from_y
        self.delta_distance = math.sqrt(self.delta_x ** 2 + self.delta_y ** 2)
        super().save(*args, **kwargs)


class ColumnPreset(models.Model):
    """Admin-managed mapping of known CSV column names to import roles."""
    ROLE_CHOICES = [
        ('asset_id', 'Asset ID'),
        ('asset_type', 'Asset Type'),
        ('x', 'X Coordinate'),
        ('y', 'Y Coordinate'),
        ('name', 'Name (optional)'),
    ]

    role = models.CharField(max_length=20, choices=ROLE_CHOICES)
    column_name = models.CharField(max_length=100, help_text="CSV column header that maps to this role")
    priority = models.IntegerField(default=0, help_text="Higher = preferred when multiple matches")

    class Meta:
        ordering = ['role', '-priority']
        constraints = [
            models.UniqueConstraint(fields=['role', 'column_name'], name='unique_role_column'),
        ]
        verbose_name = "Column Preset"
        verbose_name_plural = "Column Presets"

    def __str__(self):
        return f"{self.column_name} \u2192 {self.get_role_display()}"


class Link(models.Model):
    """A polyline link (pipe, cable, etc.) to be rendered on the canvas."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='links')
    import_batch = models.ForeignKey('ImportBatch', on_delete=models.SET_NULL, null=True, blank=True, related_name='links')
    layer_group = models.ForeignKey('LayerGroup', on_delete=models.SET_NULL, null=True, blank=True, related_name='links_in_group')

    link_id = models.CharField(max_length=100)
    name = models.CharField(max_length=255, blank=True)

    # Coordinates as array of [longitude, latitude] pairs
    coordinates = models.JSONField(
        help_text="Array of [longitude, latitude] coordinate pairs, e.g. [[145.74, -16.96], [145.75, -16.95]]"
    )

    # Display properties
    color = models.CharField(max_length=7, default='#0066FF', help_text="Hex color code")
    width = models.PositiveIntegerField(default=2, help_text="Line width in pixels")
    opacity = models.FloatField(default=1.0, help_text="Opacity from 0.0 to 1.0")

    LINK_TYPE_CHOICES = [
        ('pipe', 'Pipe'),
        ('cable', 'Cable'),
        ('conduit', 'Conduit'),
        ('duct', 'Duct'),
        ('main', 'Main'),
        ('service', 'Service'),
        ('other', 'Other'),
    ]
    link_type = models.CharField(max_length=20, choices=LINK_TYPE_CHOICES, default='other')

    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['link_id']
        constraints = [
            models.UniqueConstraint(fields=['project', 'link_id'], name='unique_project_link'),
        ]

    def __str__(self):
        return f"{self.link_id} - {self.name}"

    @property
    def point_count(self):
        return len(self.coordinates) if self.coordinates else 0


class LayerGroup(models.Model):
    """A group of assets or links that can be toggled together."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='layer_groups')
    name = models.CharField(max_length=255)

    GROUP_TYPE_CHOICES = [
        ('asset', 'Asset Group'),
        ('link', 'Link Group'),
        ('sheet', 'Sheet Group'),
        ('measurement', 'Measurement Group'),
    ]
    group_type = models.CharField(max_length=15, choices=GROUP_TYPE_CHOICES)

    # Scope determines if folder is visible only in its section (local) or shared across sections (global)
    SCOPE_CHOICES = [
        ('local', 'Local - Only visible in its own section'),
        ('global', 'Global - Shared across all sections'),
    ]
    scope = models.CharField(max_length=10, choices=SCOPE_CHOICES, default='local', help_text="Whether this folder is local to one section or global")

    color = models.CharField(max_length=7, default='#3498db', help_text="Color for UI display")
    visible = models.BooleanField(default=True)

    # Optional parent for group joining
    parent_group = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='child_groups'
    )

    # Link to import batch if created from import
    import_batch = models.OneToOneField(
        'ImportBatch',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='layer_group'
    )

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f"{self.name} ({self.group_type})"

    @property
    def is_joined(self):
        """Return True if this group is joined to a parent."""
        return self.parent_group is not None

    @property
    def item_count(self):
        """Return count of items directly in this group."""
        # Global folders can contain items of any type
        if self.scope == 'global':
            count = 0
            count += self.assets.count()
            count += self.sheets_in_group.count()
            count += self.links_in_group.count()
            count += self.measurements_in_group.count()
            return count

        # Local folders only count their own type
        if self.group_type == 'asset':
            return self.assets.count()
        elif self.group_type == 'sheet':
            return self.sheets_in_group.count()
        elif self.group_type == 'measurement':
            return self.measurements_in_group.count()
        else:
            return self.links_in_group.count()

    @property
    def total_items(self):
        """Return count of items including child groups."""
        count = self.item_count
        for child in self.child_groups.all():
            count += child.total_items
        return count


class MeasurementSet(models.Model):
    """A saved measurement (single or chain) for persistence."""
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name='measurement_sets')
    name = models.CharField(max_length=255)

    MEASUREMENT_TYPE_CHOICES = [
        ('single', 'Single Measurement'),
        ('chain', 'Chain Measurement'),
    ]
    measurement_type = models.CharField(max_length=10, choices=MEASUREMENT_TYPE_CHOICES, default='single')

    # Layer group for organizing measurements into folders
    layer_group = models.ForeignKey(
        'LayerGroup',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='measurements_in_group'
    )

    # Points stored as array of {x, y} objects
    points = models.JSONField(default=list, help_text="Array of {x, y} canvas coordinate points")

    color = models.CharField(max_length=7, default='#00bcd4', help_text="Line/point color")
    visible = models.BooleanField(default=True)

    # Calculated distances
    total_distance_pixels = models.FloatField(null=True, blank=True)
    total_distance_meters = models.FloatField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.name} ({self.measurement_type})"
