# Build from the repository root: docker build -f server/Dockerfile .
FROM node:24-bookworm-slim AS profit-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend --ignore-scripts
COPY frontend/src ./frontend/src
COPY desktop/server-core ./desktop/server-core
COPY desktop/scripts/build-private-profit-core.mjs ./desktop/scripts/build-private-profit-core.mjs
COPY shared ./shared
RUN node desktop/scripts/build-private-profit-core.mjs --full-pipeline --output=/opt/wangzai/profit-core

FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PRIVATE_PROFIT_CORE_FILE=/opt/wangzai/profit-core/profit-core.mjs \
    PRIVATE_PROFIT_CORE_MANIFEST=/opt/wangzai/profit-core/source-manifest.json \
    PRIVATE_PROFIT_NODE_EXECUTABLE=/usr/local/bin/node

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system license \
    && adduser --system --ingroup license license
COPY --from=profit-build /usr/local/bin/node /usr/local/bin/node
COPY --from=profit-build /opt/wangzai/profit-core /opt/wangzai/profit-core
WORKDIR /app

COPY server/requirements-lock.txt ./requirements-lock.txt
RUN pip install --no-cache-dir -r requirements-lock.txt

COPY server/alembic.ini ./
COPY server/migrations ./migrations
COPY server/app ./app
COPY server/scripts/container-profit-environment.py server/scripts/container-profit-smoke.py ./scripts/
COPY server/docker-entrypoint.sh /usr/local/bin/license-center-entrypoint
COPY LICENSE THIRD_PARTY_NOTICES.md ./
RUN chmod 0555 /usr/local/bin/license-center-entrypoint \
    && chmod 0444 /opt/wangzai/profit-core/* \
    && chown -R license:license /app \
    && node --version \
    && python scripts/container-profit-environment.py

EXPOSE 8000

HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

ENTRYPOINT ["license-center-entrypoint"]
