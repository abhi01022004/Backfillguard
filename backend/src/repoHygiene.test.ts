import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BACKEND_ROOT } from './config/databaseUrl';

/**
 * Guards against committing anything that shouldn't be published (R22).
 *
 * A one-off manual audit only proves the repository was clean at one moment. This makes the check
 * repeatable, so the guarantee survives every future commit.
 *
 * This project has no secrets by design — no authentication, no external APIs, synthetic data only,
 * and the database path is resolved in code so `DATABASE_URL` is not even required. That makes the
 * bar simple to hold: nothing credential-shaped should ever appear in a tracked file.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: BACKEND_ROOT,
  encoding: 'utf8',
}).trim();

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** `git grep` exits 1 when it finds nothing, which is the success case here. */
function grepTracked(pattern: string, extraArgs: string[] = []): string[] {
  try {
    const output = git(['grep', '-n', '-I', '-E', pattern, '--', '.', ...extraArgs]);
    return output.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

const trackedFiles = git(['ls-files']).split('\n').filter(Boolean);

describe('repository hygiene', () => {
  it('tracks no real environment file, only the committed example', () => {
    const envFiles = trackedFiles.filter((file) => /(^|\/)\.env/.test(file));
    expect(envFiles).toEqual(['.env.example']);
  });

  it('tracks no database, generated client or native binary', () => {
    // These are all regenerable, and the Prisma engine binary alone is several megabytes.
    const artifacts = trackedFiles.filter((file) =>
      /\.db$|\.db-wal$|\.db-shm$|(^|\/)generated\/|query_engine|\.node$|\.wasm$/.test(file),
    );
    expect(artifacts).toEqual([]);
  });

  it('contains no credential material in any tracked file', () => {
    const patterns = [
      '(ghp_|github_pat_|gho_|ghs_)[A-Za-z0-9]{10,}', // GitHub tokens
      'AKIA[0-9A-Z]{12,}', //                            AWS access key id
      '-----BEGIN [A-Z ]*PRIVATE KEY-----', //           PEM private key
      'xox[baprs]-[A-Za-z0-9-]{10,}', //                 Slack tokens
      'sk-[A-Za-z0-9]{20,}', //                          OpenAI-style keys
    ];

    const findings = patterns.flatMap((pattern) =>
      grepTracked(pattern, [':!package-lock.json', ':!*.test.ts']),
    );
    expect(findings).toEqual([]);
  });

  it('assigns no secret-like value in source', () => {
    const findings = grepTracked(
      '(password|passwd|secret|api[_-]?key|apikey|auth[_-]?token|private[_-]?key)\\s*[:=]\\s*.[^\'"]{6,}',
      [':!*.md', ':!package-lock.json', ':!*.test.ts'],
    );
    expect(findings).toEqual([]);
  });

  it('leaks no absolute local user path', () => {
    // Committing C:\Users\<name>\... exposes the machine layout and breaks on every other machine.
    const findings = grepTracked('[A-Za-z]:[\\\\/](Users|home)[\\\\/]', [
      ':!package-lock.json',
      ':!*.test.ts',
    ]);
    expect(findings).toEqual([]);
  });

  it('ignores the runtime database directory while keeping it present', () => {
    expect(trackedFiles).toContain('backend/data/.gitkeep');

    // A tracked .gitkeep inside an ignored directory is intentional: a fresh clone needs somewhere to
    // write the database, but none of its contents should ever be committed.
    let ignored = false;
    try {
      git(['check-ignore', '-q', 'backend/data/backfillguard.db']);
      ignored = true;
    } catch {
      ignored = false;
    }
    expect(ignored).toBe(true);
  });
});
