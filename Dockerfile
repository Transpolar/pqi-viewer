# --- Stage 1: build the React frontend ----------------------------------
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

# --- Stage 2: server runtime --------------------------------------------
FROM node:20-alpine AS runtime

RUN mkdir -p /app/server /app/client/dist

WORKDIR /app/server
# `pg` is pure JS — no C toolchain needed at install time (unlike the
# SQLite branch, which needed python3/make/g++ for better-sqlite3).
COPY server/package.json server/package-lock.json* ./
RUN rm -rf node_modules && npm install --omit=dev --no-audit --no-fund

COPY server/ ./
RUN rm -rf node_modules && npm install --omit=dev --no-audit --no-fund

COPY --from=client-build /app/client/dist /app/client/dist

ENV NODE_ENV=production \
    PORT=8080
# DATABASE_URL must be provided at runtime (env var, set by deploy.sh /
# docker-compose / Container App secret).

EXPOSE 8080

CMD ["node", "index.js"]
