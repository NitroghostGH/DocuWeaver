FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DOCUWEAVER_DATA_DIR=/data \
    DOCUWEAVER_STATIC_ROOT=/app/staticfiles \
    DOCUWEAVER_HOST=0.0.0.0 \
    DOCUWEAVER_PORT=8000

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Collect static assets at build time so the image is self-contained.
RUN DJANGO_SECRET_KEY=build-only python manage.py collectstatic --noinput

RUN useradd --create-home --uid 1000 docuweaver \
    && mkdir -p /data \
    && chown -R docuweaver:docuweaver /data /app
USER docuweaver

VOLUME ["/data"]
EXPOSE 8000

ENTRYPOINT ["/app/docker/entrypoint.sh"]
