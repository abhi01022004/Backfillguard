import { describe, expect, it } from 'vitest';
import {
  explainValidation,
  isStale,
  validateGuardedWrite,
  VERSION_DECISION,
} from './VersionValidator';

describe('validateGuardedWrite', () => {
  it('classifies an applied write as APPLIED with no versions missed', () => {
    const validation = validateGuardedWrite({
      applied: true,
      guardVersion: 12,
      currentVersion: 12,
    });

    expect(validation.decision).toBe(VERSION_DECISION.APPLIED);
    expect(validation.versionsMissed).toBe(0);
    expect(isStale(validation)).toBe(false);
  });

  it('classifies a refused write as STALE_REJECTED and reports the gap', () => {
    const validation = validateGuardedWrite({
      applied: false,
      guardVersion: 12,
      currentVersion: 13,
    });

    expect(validation.decision).toBe(VERSION_DECISION.STALE_REJECTED);
    expect(validation.sourceVersion).toBe(12);
    expect(validation.currentVersion).toBe(13);
    expect(validation.versionsMissed).toBe(1);
    expect(isStale(validation)).toBe(true);
  });

  it('counts multiple intervening updates', () => {
    const validation = validateGuardedWrite({
      applied: false,
      guardVersion: 12,
      currentVersion: 17,
    });
    expect(validation.versionsMissed).toBe(5);
  });

  it('rejects a repository that claims to have applied a write while reporting a moved version', () => {
    // A guarded derived write must never change the source version. If a repository reports otherwise
    // it has violated its contract, and silently trusting it would undermine every safety claim built
    // on top of the guard.
    expect(() =>
      validateGuardedWrite({ applied: true, guardVersion: 12, currentVersion: 13 }),
    ).toThrow(/contract violation/i);
  });

  it('never reports a negative version gap', () => {
    // Defensive: a lower current version would be nonsense, and a negative gap would read as progress.
    const validation = validateGuardedWrite({
      applied: false,
      guardVersion: 12,
      currentVersion: 9,
    });
    expect(validation.versionsMissed).toBe(0);
  });

  describe('explainValidation', () => {
    it('describes a safe apply', () => {
      const message = explainValidation(
        validateGuardedWrite({ applied: true, guardVersion: 12, currentVersion: 12 }),
        'P0237',
      );
      expect(message).toContain('P0237');
      expect(message).toContain('v12');
      expect(message).toMatch(/applied safely/i);
    });

    it('describes a refusal with both versions', () => {
      const message = explainValidation(
        validateGuardedWrite({ applied: false, guardVersion: 15, currentVersion: 16 }),
        'P0237',
      );
      expect(message).toContain('v15');
      expect(message).toContain('v16');
      expect(message).toMatch(/refused/i);
    });
  });
});
