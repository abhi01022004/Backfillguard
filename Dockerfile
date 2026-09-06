# BackfillGuard — container image.
#
# One Dockerfile, two published targets: `backend` and `frontend`.
#
# ## Why Debian slim and not Alpine
#
# Prisma ships prebuilt native query engines per platform. The schema pins no `binaryTargets`, so
# generation resolves to `native` — on Alpine that means the musl engine, which needs extra compat
# packages and fails at *runtime* rather than at build time when they are missing. Debian slim costs
# about 40 MB more and removes a class of problem that is genuinely hard to diagnose from a container
# log. This project is meant to run first time on a machine nobody has prepared.
#
# ## Why the runtime still contains devDependencies
#
# The backend has no JavaScript build step: `npm run build` is `tsc --noEmit` and `npm start` is
# `tsx src/index.ts`. TypeScript is executed directly, on purpose, so `@bg/shared` can be consumed
# from source with no dist/src ambiguity. `tsx` is therefore genuinely a runtime requirement here, and
# so is the Prisma CLI, which applies migrations when the container starts.
#
# `--omit=dev` would produce an image that builds cleanly and then crashes on boot. The honest fix is
# to install per workspace so the backend does not also carry the frontend's toolchain — see below.

# =============================================================================================
# deps-backend — dependencies for the backend workspace only
# =============================================================================================
FROM node:22-bookworm-slim AS deps-backend

# openssl is required by the Prisma query engine; ca-certificates for TLS if a real messaging
# provider is ever wired in place of the demo one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

# All four manifests are required even for a filtered install: `npm ci` validates the whole workspace
# tree against the root lockfile and refuses to run if one is missing.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# Every workspace tsconfig extends this one, so both targets need it. Copied with the manifests
# because it changes about as rarely, which keeps it inside the cached layer. Its absence is not a
# clean failure: `tsc` reports the missing file and then floods the log with spurious library type
# errors, because the `skipLibCheck` it sets is gone too.
COPY tsconfig.base.json ./

# Scoped to the two workspaces the server actually needs.
#
# A single unfiltered `npm ci` shared between both targets was the first version of this file. It
# built fine and produced a 2 GB backend image, because the server was carrying the entire frontend
# toolchain — lucide-react, vite, rolldown, lightningcss, testing-library — roughly 160 MB of
# dependencies it can never load. Two installs cost some build time and are cached independently.
#
# `--ignore-scripts` because the backend's `postinstall` runs `prisma generate`, which needs the
# schema; the schema is deliberately not in this layer, so generation happens explicitly below.
RUN npm ci --ignore-scripts --workspace @bg/backend --workspace @bg/shared --include-workspace-root


# =============================================================================================
# backend — Express API, simulation engines, SQLite
# =============================================================================================
FROM deps-backend AS backend

COPY shared/ ./shared/
COPY backend/ ./backend/

# Generate the Prisma client for *this* platform, into backend/src/generated/prisma per the `output`
# in schema.prisma.
#
# Invoked by explicit path from the backend workspace, not as `npx prisma` from the root. npm does not
# hoist this one: `prisma` lands in backend/node_modules/.bin because it is a devDependency of that
# workspace while @prisma/client is a runtime dependency of it. From /app, `npx prisma` finds nothing
# and falls through to a registry fetch that fails with a bare "prisma: not found".
#
# DATABASE_URL is a throwaway: generation reads the schema, never the data.
WORKDIR /app/backend
RUN DATABASE_URL="file:/tmp/generate.db" ./node_modules/.bin/prisma generate
WORKDIR /app

COPY docker/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh

# `sed` strips carriage returns. The repository is developed on Windows, and a CRLF shebang makes the
# kernel look for an interpreter literally named "/bin/sh\r", which fails as "not found".
# .gitattributes already forces LF for text files; this keeps the image correct if that is bypassed.
RUN sed -i 's/\r$//' /usr/local/bin/backend-entrypoint.sh \
 && chmod +x /usr/local/bin/backend-entrypoint.sh

# Only the data directory is chowned — deliberately not `/app`.
#
# `chown -R /app` rewrites metadata on every one of ~40,000 dependency files, and because that changes
# them, the layer stores a second full copy of the tree. It added about 500 MB to the image on its own.
# The `node` user only ever needs to *write* the database; everything else it merely reads, and the
# root-owned files from `npm ci` are world-readable already.
#
# Doing it before USER is also what lets the named volume mounted here inherit writable ownership on
# first use. A host bind mount would not — see the README note.
RUN mkdir -p /app/backend/data && chown node:node /app/backend/data

USER node
WORKDIR /app/backend

ENV NODE_ENV=production \
    PORT=4000

EXPOSE 4000

# Node 22 ships a global fetch, so the check needs no curl or wget in the image.
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/backend-entrypoint.sh"]

# Exec form, invoking tsx directly rather than `npm start`. npm as PID 1 does not forward SIGTERM to
# its child, so `docker stop` would wait out the 10s timeout and then SIGKILL — losing the graceful
# shutdown that flushes buffered events to the durable log.
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]


# =============================================================================================
# deps-frontend — dependencies for the frontend build only
# =============================================================================================
FROM node:22-bookworm-slim AS deps-frontend

WORKDIR /app

ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY tsconfig.base.json ./

# Scoped to the frontend, so the build does not pull Prisma's engines (~180 MB) for an image whose
# output is a directory of static files.
RUN npm ci --ignore-scripts --workspace @bg/frontend --workspace @bg/shared --include-workspace-root


# =============================================================================================
# frontend-build — compile the React app to static assets
# =============================================================================================
FROM deps-frontend AS frontend-build

COPY shared/ ./shared/
COPY frontend/ ./frontend/

# Runs `tsc --noEmit && vite build`, so a type error fails the image build instead of shipping.
RUN npm run build --workspace frontend


# =============================================================================================
# frontend — nginx serving the SPA and proxying to the backend
# =============================================================================================
FROM nginx:1.27-alpine AS frontend

# nginx, rather than teaching Express to serve static files.
#
# The backend deliberately serves no assets, and adding that would mean changing application code to
# suit the packaging. nginx also reproduces the Vite dev proxy exactly — same-origin /api and /live
# with a websocket upgrade — so the app behaves identically in development and in a container.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
