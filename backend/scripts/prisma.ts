import { spawnSync } from 'node:child_process';
import { resolveDatabaseUrl } from '../src/config/databaseUrl';

/**
 * Wrapper around the Prisma CLI.
 *
 * Two problems this solves:
 *
 * 1. Prisma's CLI reads `DATABASE_URL` from the environment, and setting an env var inline in an npm
 *    script is not portable across bash/cmd/PowerShell. Doing it in Node works everywhere without
 *    pulling in cross-env.
 * 2. It guarantees the CLI and the running application resolve to the *same* absolute database file,
 *    rather than relying on everyone remembering how Prisma resolves relative SQLite paths.
 *
 * A fresh clone therefore needs no .env file at all.
 *
 * Usage: tsx scripts/prisma.ts <prisma args...>
 */

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: tsx scripts/prisma.ts <prisma args...>  e.g. migrate dev --name init');
  process.exit(1);
}

const databaseUrl = resolveDatabaseUrl();
console.log(`[prisma] DATABASE_URL=${databaseUrl}`);

const result = spawnSync('npx', ['prisma', ...args], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
  // npx resolves to npx.cmd on Windows, which requires shell invocation.
  shell: true,
});

if (result.error) {
  console.error('[prisma] failed to launch the Prisma CLI:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
