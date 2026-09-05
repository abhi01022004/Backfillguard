import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the determinism strategy at the source level.
 *
 * The demo's core claim is that the same seed reproduces the same run. Three things would silently
 * break that, and all three are easy to reintroduce by accident:
 *
 *  - `Math.random()`  — unseeded randomness
 *  - `Date.now()` / `new Date()` — decisions that depend on wall-clock time
 *  - `setTimeout` / `setInterval` — ordering that depends on real elapsed time, reintroducing exactly
 *    the race the tick loop exists to remove
 *
 * The failure mode is the worst kind: it passes in testing and breaks intermittently during a live
 * presentation. So this is enforced mechanically rather than by convention. Domain code must take
 * time and randomness through the injected `Clock` and `Rng` ports.
 */

const DOMAIN_DIR = join(dirname(fileURLToPath(import.meta.url)));

const BANNED: { pattern: RegExp; label: string; use: string }[] = [
  { pattern: /\bMath\s*\.\s*random\s*\(/, label: 'Math.random()', use: 'inject Rng and call rng.next()' },
  { pattern: /\bDate\s*\.\s*now\s*\(/, label: 'Date.now()', use: 'inject Clock and call clock.now()' },
  { pattern: /\bnew\s+Date\s*\(\s*\)/, label: 'new Date()', use: 'inject Clock and call clock.nowIso()' },
  { pattern: /\bsetTimeout\s*\(/, label: 'setTimeout()', use: 'await clock.sleep() from the tick loop' },
  { pattern: /\bsetInterval\s*\(/, label: 'setInterval()', use: 'drive work from the orchestrator tick loop' },
];

function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);

    if (statSync(fullPath).isDirectory()) {
      found.push(...collectSourceFiles(fullPath));
      continue;
    }

    // Tests may legitimately use real timers and dates; only production domain code is constrained.
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;

    found.push(fullPath);
  }

  return found;
}

/** Strips comments so a mention in prose (like this file's own docblock) is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('determinism guard', () => {
  const files = collectSourceFiles(DOMAIN_DIR);

  it('finds domain source files to check', () => {
    // If this ever reaches zero the guard has silently stopped protecting anything.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(BANNED)('forbids $label inside src/domain', ({ pattern, label, use }) => {
    const violations: string[] = [];

    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (pattern.test(source)) {
        violations.push(relative(DOMAIN_DIR, file));
      }
    }

    expect(
      violations,
      `${label} found in domain code: ${violations.join(', ')}. ` +
        `Domain logic must stay deterministic — ${use}.`,
    ).toEqual([]);
  });
});
