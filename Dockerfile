# Team Kazakhstan: build from source (variant B) for linux/amd64 or linux/arm64.
#
# Works with the classic builder of Docker 20.10 (Synology DSM 6.2 "Docker"
# package) and with BuildKit/buildx: no BuildKit-only syntax is used.
# Alpine (musl) on purpose: old Docker seccomp profiles break images built on a
# new glibc, see README_RU.md "Почему Alpine".
#
#   docker build -t team-kazakhstan:1.0.0 .
#   docker buildx build --platform linux/arm64 -t team-kazakhstan:1.0.0-arm64 --load .

ARG NODE_IMAGE=node:24.22.0-alpine3.24

# ---------------------------------------------------------------- 1. build
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && find node_modules -name "*.node" | grep -q . && { echo "native modules are not expected"; exit 1; } || true

# -------------------------------------------------------------- 2. runtime
FROM ${NODE_IMAGE}
ARG APP_VERSION=1.0.0
LABEL org.opencontainers.image.title="Team Kazakhstan" \
      org.opencontainers.image.description="Internal employee directory of the group of companies" \
      org.opencontainers.image.version="${APP_VERSION}"
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY migrations ./migrations
COPY VERSION ./
# /data is a bind mount on the NAS; the directory here only serves a plain
# `docker run` without a mount. The app runs as uid 1000 (user "node").
RUN mkdir -p /data && chown 1000:1000 /data && chmod 750 /data
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "/app/dist/server/healthcheck.js"]
CMD ["node", "dist/server/main.js"]
