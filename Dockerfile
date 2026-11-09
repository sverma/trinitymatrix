# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-alpine
ARG RUNTIME_IMAGE=alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

FROM node:${NODE_VERSION} AS dependencies
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/game-domain/package.json packages/game-domain/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM dependencies AS build
COPY apps ./apps
COPY packages ./packages
COPY tests/load/run.mjs ./tests/load/run.mjs
COPY tests/load/lib ./tests/load/lib
RUN npm run build

FROM node:${NODE_VERSION} AS production-dependencies
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/game-domain/package.json packages/game-domain/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

FROM ${RUNTIME_IMAGE} AS runtime-rootfs

# Use Alpine's maintained Node package so TLS is dynamically linked to the
# patched system libraries instead of embedded in the upstream Node binary.
RUN apk add --no-cache ca-certificates nodejs \
  && apk upgrade --no-cache libcrypto3 libssl3 \
  && addgroup -g 1000 -S node \
  && adduser -u 1000 -S -D -G node -h /home/node -s /sbin/nologin node

# The runtime starts the compiled server directly with Node. Remove the global
# package managers inherited from the build image so their unused dependency
# trees are not shipped in production.
RUN rm -rf \
  /opt/yarn-v1.22.22 \
  /usr/local/lib/node_modules/corepack \
  /usr/local/lib/node_modules/npm \
  /usr/local/bin/corepack \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/bin/pnpm \
  /usr/local/bin/pnpx \
  /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg

WORKDIR /app
COPY LICENSE NOTICE.md ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist

# Copy the merged runtime filesystem into one scratch layer. This keeps patched
# libraries, CA certificates, the node user and application data while removing
# superseded package bytes from the base image's lower-layer history.
FROM scratch AS runtime
ARG APP_VERSION=0.1.0
ARG APP_REVISION=unknown
ARG APP_BUILD_TIME=unknown

LABEL org.opencontainers.image.title="TrinityMatrix Web" \
  org.opencontainers.image.description="TrinityMatrix lobby and authoritative ranking-game service" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.revision="${APP_REVISION}" \
  org.opencontainers.image.created="${APP_BUILD_TIME}"

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8080 \
  WEB_DIST_PATH=/app/apps/web/dist \
  APP_VERSION=${APP_VERSION} \
  APP_REVISION=${APP_REVISION} \
  APP_BUILD_TIME=${APP_BUILD_TIME} \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

COPY --from=runtime-rootfs / /

USER node
WORKDIR /app/apps/server
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
