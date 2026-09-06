#!/bin/sh
#
# Prepares the database, then hands off to the server.
#
# Runs on every container start, so it has to be safe to run repeatedly. Two things happen:
#
#   1. `migrate deploy` applies any pending migrations. Idempotent by design, and it is the
#      deploy-safe command — unlike `migrate dev` it never prompts, never generates a new migration
#      and never offers to reset the database.
#
#   2. The dataset is seeded *only* when the database file did not exist beforehand.
#
# Point 2 matters more than it looks. Seeding calls `replaceAll`, which is destructive: running it on
# every boot would silently wipe a completed run every time the container restarted, and the wipe
# would look like data loss rather than a seed. Presence of the file is the signal that the volume
# has been initialised before.

set -eu

BACKEND_DIR="/app/backend"
DB_FILE="${BACKEND_DIR}/data/backfillguard.db"
TSX="/app/node_modules/.bin/tsx"

cd "$BACKEND_DIR"

if [ -f "$DB_FILE" ]; then
  FRESH=0
  echo "[entrypoint] existing database found at ${DB_FILE}"
else
  FRESH=1
  echo "[entrypoint] no database at ${DB_FILE} — treating this volume as new"
fi

echo "[entrypoint] applying migrations"
# Invoked through the project's own wrapper rather than calling the Prisma CLI directly, so the
# container resolves DATABASE_URL by exactly the same code path the application does. Duplicating
# that logic in shell is how the CLI and the app end up pointed at two different files.
"$TSX" scripts/prisma.ts migrate deploy

# SEED_ON_START allows the default to be overridden either way: `false` to boot an empty database on
# purpose, `true` to force a reseed of an existing volume.
SEED="${SEED_ON_START:-auto}"

case "$SEED" in
  auto)  [ "$FRESH" = "1" ] && DO_SEED=1 || DO_SEED=0 ;;
  true)  DO_SEED=1 ;;
  false) DO_SEED=0 ;;
  *)     echo "[entrypoint] unrecognised SEED_ON_START='${SEED}', treating as auto" >&2
         [ "$FRESH" = "1" ] && DO_SEED=1 || DO_SEED=0 ;;
esac

if [ "$DO_SEED" = "1" ]; then
  echo "[entrypoint] seeding the synthetic dataset"
  "$TSX" src/infra/seed/seedCli.ts
else
  echo "[entrypoint] skipping seed (SEED_ON_START=${SEED})"
fi

echo "[entrypoint] starting: $*"

# `exec` replaces this shell, so the server becomes PID 1 and receives SIGTERM directly from
# `docker stop`. Without it the signal would stop at this script and the graceful shutdown — which
# flushes buffered events to the event log — would never run.
exec "$@"
