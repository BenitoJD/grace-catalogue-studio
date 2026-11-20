# syntax=docker/dockerfile:1

# Grace Catalogue Studio API and PDF renderer.
#
# Single stage on purpose: WeasyPrint 70 is installed from wheels, so there are
# no compiler toolchain or build headers that a second stage would remove. The
# runtime image is kept clean by installing only runtime packages and deleting
# the apt lists and pip caches in the same layer.
FROM node:24-bookworm-slim

# NODE_ENV is set here and not only at run time so a bare docker run behaves
# like a production container. HOME gives fontconfig and WeasyPrint a writable
# cache directory for the non root user.
ENV NODE_ENV=production \
    PORT=8787 \
    HOME=/home/node \
    CATALOG_DATA_DIR=/app/data \
    CATALOG_TEMPLATES_DIR=/app/templates \
    WEASYPRINT_BIN=/opt/venv/bin/weasyprint \
    PDFTOPPM_BIN=/usr/bin/pdftoppm \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

# Pango, Cairo and GDK-Pixbuf are WeasyPrint's native dependencies.
# poppler-utils supplies pdftoppm, which rasterises PDF pages for the app
# preview. fonts-liberation is a sane fallback if a bundled web font ever fails
# to load. python3-venv is needed only to create the virtualenv below. Debian
# ships the pip and setuptools wheels that venv seeds a new environment with in
# separate packages, and --no-install-recommends skips them, so they are named
# explicitly. Debian package versions are deliberately not pinned: bookworm
# security updates change them and a pinned image would stop building.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libpango-1.0-0 \
      libpangoft2-1.0-0 \
      libcairo2 \
      libgdk-pixbuf-2.0-0 \
      shared-mime-info \
      fonts-liberation \
      poppler-utils \
      python3 \
      python3-venv \
      python3-pip-whl \
      python3-setuptools-whl \
 && rm -rf /var/lib/apt/lists/*

# WeasyPrint lives in its own virtualenv at /opt/venv. Only requirements.txt is
# copied first so this layer is cached until the pinned version changes.
RUN python3 -m venv /opt/venv
COPY requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
 && rm -f /tmp/requirements.txt

WORKDIR /app

# Runtime dependencies for the server only. package-lock.json is required by
# npm ci, and --omit=dev keeps dev tooling out of the image.
COPY server/package.json server/package-lock.json ./server/
RUN npm --prefix server ci --omit=dev \
 && npm cache clean --force

# server/src/config.mjs walks up two levels from its own file, so the image
# layout must be /app/server/src plus /app/templates. Templates are writable by
# the runtime user because rendering writes temporary built-*.html files next
# to the templates for relative asset paths to resolve.
COPY --chown=node:node server/src ./server/src
COPY --chown=node:node templates ./templates

# The data directory is created here so the image itself works with docker run.
# In production it is a named volume or a bind mount (see docker-compose.yml).
RUN mkdir -p /app/data \
 && chown node:node /app/data

# The node user exists in the official image with uid and gid 1000.
# hadolint ignore=DL3066
USER node
EXPOSE 8787
VOLUME ["/app/data"]

# Node's built in fetch keeps curl out of the runtime image. 127.0.0.1 is used
# so the check does not depend on Docker's DNS or on how PORT is remapped.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Keep node in the foreground so SIGTERM reaches the shutdown handler.
CMD ["node", "server/src/index.mjs"]
