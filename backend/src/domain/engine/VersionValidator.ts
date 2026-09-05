import type { GuardedWriteResult } from '../ports/PatientRepository';

/**
 * Interprets the outcome of a version-guarded write (R5.1–R5.3).
 *
 * This module is deliberately tiny, and its smallness is the point. The safety property this project
 * claims reduces to a single rule, so that rule lives in exactly one place where it can be read in
 * full and tested exhaustively:
 *
 *   > A derived value may be persisted only if the row is still at the version the value was
 *   > computed from.
 *
 * Two things it does **not** do, both of which would quietly break the guarantee:
 *
 *  - It never re-reads the row to decide whether a write was safe. The version predicate travels with
 *    the write itself, so the database performs the comparison atomically. Deciding from a separate
 *    read would leave a window in which the row could change between the check and the write — the
 *    exact race the guard exists to close.
 *  - It never retries a rejected write with the same computed value. A rejected result is stale by
 *    definition; the only correct response is to recompute from current data.
 */

export const VERSION_DECISION = {
  /** The row was unchanged; the derived value has been persisted. */
  APPLIED: 'APPLIED',
  /**
   * The row moved between read and write. The computed value was refused and must be discarded,
   * never retried as-is.
   */
  STALE_REJECTED: 'STALE_REJECTED',
} as const;
export type VersionDecision = (typeof VERSION_DECISION)[keyof typeof VERSION_DECISION];

export interface VersionValidation {
  decision: VersionDecision;
  /** Version the computation was based on. */
  sourceVersion: number;
  /** Version actually present on the row when the write was attempted. */
  currentVersion: number;
  /** How many versions of clinical change happened underneath the computation. */
  versionsMissed: number;
}

/**
 * Classifies a guarded write result.
 *
 * `applied` comes from the affected-row count of a conditional update, so it is evidence from the
 * database rather than an inference. When it is false the row necessarily moved, and `currentVersion`
 * reports where it moved to.
 */
export function validateGuardedWrite(result: GuardedWriteResult): VersionValidation {
  const versionsMissed = Math.max(0, result.currentVersion - result.guardVersion);

  if (result.applied) {
    // A guarded write leaves `version` untouched, so an applied write must report the same version it
    // was predicated on. Anything else means the repository violated its contract, and silently
    // trusting it would undermine every safety claim built on top.
    if (result.currentVersion !== result.guardVersion) {
      throw new Error(
        `Repository contract violation: a guarded write applied at version ${result.guardVersion} ` +
          `but the row reports version ${result.currentVersion}. A derived write must never change ` +
          `the source version.`,
      );
    }

    return {
      decision: VERSION_DECISION.APPLIED,
      sourceVersion: result.guardVersion,
      currentVersion: result.currentVersion,
      versionsMissed: 0,
    };
  }

  return {
    decision: VERSION_DECISION.STALE_REJECTED,
    sourceVersion: result.guardVersion,
    currentVersion: result.currentVersion,
    versionsMissed,
  };
}

export function isStale(validation: VersionValidation): boolean {
  return validation.decision === VERSION_DECISION.STALE_REJECTED;
}

/** Human-readable explanation used in event messages and conflict cards. */
export function explainValidation(validation: VersionValidation, patientCode: string): string {
  if (validation.decision === VERSION_DECISION.APPLIED) {
    return `${patientCode} unchanged at v${validation.sourceVersion} — result applied safely.`;
  }

  return (
    `${patientCode} moved from v${validation.sourceVersion} to v${validation.currentVersion} ` +
    `during processing — stale result refused.`
  );
}
