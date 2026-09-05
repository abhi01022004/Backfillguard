import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the SQLite database location.
 *
 * This exists to remove a genuine footgun: Prisma resolves a *relative* SQLite path against the
 * schema file's directory, not the working directory. So `file:./data/x.db` means
 * `backend/prisma/data/x.db` to Prisma, while the same string means `backend/data/x.db` to anyone
 * reading it in a shell — and the CLI and the running app would quietly use two different databases.
 *
 * Returning an absolute `file:` URL makes the location unambiguous for the CLI, the generated client
 * and the tests alike.
 */

const thisDir = dirname(fileURLToPath(import.meta.url));

/** `backend/` — two levels up from `backend/src/config/`. */
export const BACKEND_ROOT = resolve(thisDir, '..', '..');

export const DATABASE_DIR = resolve(BACKEND_ROOT, 'data');

export const DATABASE_FILE = resolve(DATABASE_DIR, 'backfillguard.db');

/**
 * Formats an absolute filesystem path as a Prisma SQLite connection string.
 *
 * The exact spelling matters and is not interchangeable. Prisma ships two separate native engines and
 * they disagree about URL forms on Windows:
 *
 *   - `file:D:/path/to.db`    accepted by the query engine *and* the schema engine  ← what we use
 *   - `file:///D:/path/to.db` accepted by the query engine, rejected by the schema engine
 *                             ("The specified path is invalid", os error 161), so `prisma db push`
 *                             fails while the application appears to work
 *
 * That asymmetry is worth pinning down in one place: the failure only shows up in migrations, which
 * makes it easy to misdiagnose as a broken schema rather than a URL format problem.
 */
export function toPrismaFileUrl(absolutePath: string): string {
  return `file:${absolutePath.replace(/\\/g, '/')}`;
}

/**
 * Connection string for the development database, creating the containing directory if needed so a
 * fresh clone works without a manual mkdir step.
 *
 * An explicit `DATABASE_URL` in the environment always wins, which is what lets tests point at a
 * throwaway file.
 */
export function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;

  mkdirSync(DATABASE_DIR, { recursive: true });
  return toPrismaFileUrl(DATABASE_FILE);
}
