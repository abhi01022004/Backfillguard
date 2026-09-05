import { NOTIFICATION_REASON, RISK_LEVEL, type NotificationReason, type RiskLevel } from '@bg/shared';

/**
 * When a notification should exist, and what to call it.
 *
 * ## Why the rule lives here rather than in the risk calculator
 *
 * The calculator's only job is to turn clinical values into a score and a band. It performs no I/O, consults no
 * clock and has no idea notifications exist — a guard test fails the build if it acquires any of those. Putting
 * "and also alert someone" inside it would couple a pure function to an outbound side effect and make the
 * scoring logic untestable without stubbing a messaging provider.
 *
 * So the calculator produces a `RiskLevel`, and this module decides what that means. The threshold itself is
 * *not* redefined here: `RISK_LEVEL.HIGH` comes from the shared enum and the band boundaries come from
 * `RISK_CONFIG`, so retuning the formula automatically retunes what gets alerted. Hard-coding a score cutoff
 * like `>= 61` would have created a second, silently diverging definition of "high risk".
 */

/**
 * Whether a committed result warrants an alert.
 *
 * Only `HIGH`. `LOW` and `MEDIUM` produce nothing at all — not a suppressed notification, not a row with a
 * status meaning "decided against". There is no record because there was no event.
 */
export function shouldNotify(riskLevel: RiskLevel | null): boolean {
  return riskLevel === RISK_LEVEL.HIGH;
}

/**
 * Distinguishes a first-time alert from one produced after a conflict was resolved.
 *
 * Both are legitimate `HIGH` alerts and both are sent; the distinction is purely provenance, so the timeline can
 * show that an alert was the *outcome of* a re-evaluation rather than an independent detection. That is the
 * interesting case to a reviewer: it is the one where a naive implementation would have alerted on stale data.
 */
export function reasonForCommit(wasReevaluated: boolean): NotificationReason {
  return wasReevaluated
    ? NOTIFICATION_REASON.HIGH_RISK_RECALCULATED
    : NOTIFICATION_REASON.HIGH_RISK_DETECTED;
}

/**
 * The deduplication key.
 *
 * `jobId:patientId:version:riskLevel`. Stored under a unique constraint, so duplicate suppression is enforced
 * by the database rather than by a check that has to remember to run.
 *
 * Including the **version** is what makes this correct across recovery. Recovery deliberately revisits records
 * it cannot account for, so the same patient can be committed twice within one job. If the second commit is at
 * the same version with the same band, it is the same fact and must not alert again. If a clinician moved the
 * record in between, the version differs, the result is genuinely new, and a second alert is correct.
 *
 * Including the **risk level** covers the case where a re-evaluation changes the band: an alert for a patient
 * who was MEDIUM and is now HIGH is a new fact even at the same version, which cannot otherwise happen but
 * costs nothing to be right about.
 */
export function idempotencyKey(
  jobId: string,
  patientId: number,
  patientVersion: number,
  riskLevel: RiskLevel,
): string {
  return `${jobId}:${patientId}:${patientVersion}:${riskLevel}`;
}

/**
 * The synthetic destination for a patient.
 *
 * ## Why this is derived rather than stored
 *
 * The feature specification suggested adding a phone column to the patient table. Deriving it instead has three
 * advantages, and no cost: the patient schema is untouched so no migration risks existing data; nothing
 * phone-shaped is ever persisted, so there is no column a future reader could mistake for real contact
 * details; and the value is deterministic, so the same patient always shows the same number across runs.
 *
 * The `+91 90000…` prefix is inside a documented test range and the number is visibly sequential, so it reads
 * as obviously fabricated rather than plausibly real.
 */
export function syntheticRecipient(patientId: number): string {
  return `+91 90000${String(patientId).padStart(5, '0')}`;
}
