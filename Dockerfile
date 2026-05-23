# --- Stage 1: build the React frontend ----------------------------------
FROM node:20-alpine AS client-build
WORKDIR /app/client

# Install deps first (cache-friendly). The `rm -rf node_modules` defends
# against the host's node_modules sneaking into the build context on Docker
# versions where **/node_modules in .dockerignore isn't honoured — files
# transferred from a different OS often lose the exec bit on .bin/vite.
COPY client/package.json client/package-lock.json* ./
RUN rm -rf node_modules && npm install --no-audit --no-fund

# Now bring in the rest of the source.
COPY client/ ./
# Same defensive wipe + reinstall in case any node_modules leaked through.
RUN rm -rf node_modules && npm install --no-audit --no-fund

# Call vite via `node` directly so we don't depend on the .bin/vite exec bit.
RUN node ./node_modules/vite/bin/vite.js build

# --- Stage 2: server runtime --------------------------------------------
FROM node:20-alpine AS runtime

# better-sqlite3 needs a C toolchain at install time. Use a virtual
# build-deps package so we can drop it again after install and keep the
# final image small.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && mkdir -p /app/server /app/client/dist /app/data

WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN rm -rf node_modules \
 && npm install --omit=dev --no-audit --no-fund \
 && apk del .build-deps

COPY server/ ./
# Defensive wipe again, then reinstall production deps in case node_modules
# leaked in with the source COPY.
RUN rm -rf node_modules \
 && apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm install --omit=dev --no-audit --no-fund \
 && apk del .build-deps

COPY --from=client-build /app/client/dist /app/client/dist

ENV NODE_ENV=production \
    PORT=8080 \
    PQI_DATA_DIR=/app/data

EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "index.js"]
