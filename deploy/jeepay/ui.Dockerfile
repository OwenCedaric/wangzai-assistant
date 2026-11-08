# Local aliases are created from the checksum-pinned images already pulled by
# the deployment procedure. This avoids an external registry re-check midway
# through a reproducible local build on unstable networks.
FROM wangzai/node:20-alpine AS builder

ARG PLATFORM
WORKDIR /workspace
COPY . /workspace
RUN --mount=type=cache,target=/root/.npm \
    npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 2000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && cd /workspace/jeepay-ui-${PLATFORM} \
    && npm ci --prefer-offline --no-audit \
    && npm run build

FROM wangzai/nginx:alpine

ARG PLATFORM
ENV BACKEND_HOST=""
WORKDIR /workspace
COPY --from=builder /workspace/jeepay-ui-${PLATFORM}/dist /workspace
RUN chmod -R a+r /workspace \
    && rm -f /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/default.conf.template /etc/nginx/templates/default.conf.template
