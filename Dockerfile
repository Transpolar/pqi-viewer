# --- Stage 1: build the desktop React frontend --------------------------
FROM node:20-alpine AS client-build
WORKDIR /app/client

# Install deps first (cache-friendly). The `rm -rf node_modules` defends
# against the host's node_modules sneaking into the build context on Docker
# versions where **/node_modules in .dockerignore isn't honoured — files
# transferred from a different OS often lose the exec bit on .bin/vite.
COPY client/package.json client/package-lock.json* ./
RUN rm -rf node_modules && npm install --no-audit --no-fund

COPY client/ ./
RUN rm -rf node_modules && npm install --no-audit --no-fund

# Call vite via `node` directly so we don't depend on the .bin/vite exec bit.
RUN node ./node_modules/vite/bin/vite.js build

# --- Stage 2: build the mobile companion React frontend -----------------
FROM node:20-alpine AS mobile-build
WORKDIR /app/mobile/client

COPY mobile/client/package.json mobile/client/package-lock.json* ./
RUN rm -rf node_modules && npm install --no-audit --no-fund

COPY mobile/client/ ./
RUN rm -rf node_modules && npm install --no-audit --no-fund

RUN node ./node_modules/vite/bin/vite.js build

# --- Stage 3: server runtime --------------------------------------------
FROM node:20-alpine AS runtime

RUN mkdir -p /app/server /app/client/dist /app/mobile/client/dist

WORKDIR /app/server
# `pg` is pure JS — no C toolchain needed at install time.
COPY server/package.json server/package-lock.json* ./
RUN rm -rf node_modules && npm install --omit=dev --no-audit --no-fund

COPY server/ ./
RUN rm -rf node_modules && npm install --omit=dev --no-audit --no-fund

COPY --from=client-build /app/client/dist /app/client/dist
COPY --from=mobile-build /app/mobile/client/dist /app/mobile/client/dist

ENV NODE_ENV=production \
    PORT=8080 \
    MOBILE_PORT=8081
# DATABASE_URL must be provided at runtime (env var, set by deploy.sh /
# docker-compose / Container App secret).

# 8080 = desktop UI + REST API
# 8081 = mobile companion UI (same REST API surface for the endpoints it uses)
EXPOSE 8080 8081

CMD ["node", "index.js"]
