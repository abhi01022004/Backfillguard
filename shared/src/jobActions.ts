import { JOB_STATUS, type JobStatus } from './enums';

/**
 * The job lifecycle as data (design §6).
 *
 * ## Why this lives in `shared`
 *
 * Two consumers need the same rules for different purposes. The backend enforces them — an illegal
 * transition throws. The frontend *predicts* them, so a control can be disabled with a real explanation
 * instead of failing on click (R8.7, R17.1).
 *
 * Keeping one table means those two views cannot drift. The alternative — a duplicate table in the client —
 * fails in the worst possible direction: the UI would happily offer a button the server refuses, and the
 * mismatch would only surface as a 409 in front of an audience. Nothing here throws or imports an error
 * type, precisely so the browser can use it.
 *
 * ```
 * IDLE ──start──> RUNNING ──pause──> PAUSED ──resume──> RUNNING
 *                   │                                      │
 *                   ├──crash──> CRASHED ──recover──> RECOVERING ──┤
 *                   │                                             │
 *                   └────────── all partitions done ──────────────┴──> COMPLETED
 *
 * COMPLETED ──verify──> VERIFYING ──> VERIFIED_SAFE | VERIFICATION_FAILED
 * any ──fail──> FAILED            any ──reset──> IDLE
 * ```
 *
 * The values are phrased as verb phrases because they are interpolated straight into error messages
 * ("Cannot pause the backfill while the job is IDLE").
 */
export const JOB_ACTION = {
  START: 'start the backfill',
  PAUSE: 'pause the backfill',
  RESUME: 'resume the backfill',
  CRASH: 'crash the backfill',
  RECOVER: 'resume recovery',
  COMPLETE: 'complete the backfill',
  VERIFY: 'run verification',
  FINISH_VERIFICATION: 'record the verification result',
  FAIL: 'fail the job',
  RESET: 'reset the simulation',
} as const;
export type JobAction = (typeof JOB_ACTION)[keyof typeof JOB_ACTION];

/** Which states each action may be invoked from, and where it leads. */
export const JOB_TRANSITIONS: Record<JobAction, { from: readonly JobStatus[]; to: JobStatus }> = {
  [JOB_ACTION.START]: {
    // Re-runnable from any settled state, so a judge can replay without restarting the server.
    from: [
      JOB_STATUS.IDLE,
      JOB_STATUS.COMPLETED,
      JOB_STATUS.VERIFIED_SAFE,
      JOB_STATUS.VERIFICATION_FAILED,
      JOB_STATUS.FAILED,
    ],
    to: JOB_STATUS.RUNNING,
  },
  [JOB_ACTION.PAUSE]: {
    from: [JOB_STATUS.RUNNING, JOB_STATUS.RECOVERING],
    to: JOB_STATUS.PAUSED,
  },
  [JOB_ACTION.RESUME]: {
    from: [JOB_STATUS.PAUSED],
    to: JOB_STATUS.RUNNING,
  },
  [JOB_ACTION.CRASH]: {
    // Pausing first and then crashing is a legitimate demo sequence.
    from: [JOB_STATUS.RUNNING, JOB_STATUS.PAUSED, JOB_STATUS.RECOVERING],
    to: JOB_STATUS.CRASHED,
  },
  [JOB_ACTION.RECOVER]: {
    from: [JOB_STATUS.CRASHED],
    to: JOB_STATUS.RECOVERING,
  },
  [JOB_ACTION.COMPLETE]: {
    from: [JOB_STATUS.RUNNING, JOB_STATUS.RECOVERING],
    to: JOB_STATUS.COMPLETED,
  },
  [JOB_ACTION.VERIFY]: {
    // Verification is an audit of a finished run, so it deliberately cannot be run mid-flight:
    // the numbers would describe a moving target. Re-verifying a verified job is allowed.
    from: [JOB_STATUS.COMPLETED, JOB_STATUS.VERIFIED_SAFE, JOB_STATUS.VERIFICATION_FAILED],
    to: JOB_STATUS.VERIFYING,
  },
  [JOB_ACTION.FINISH_VERIFICATION]: {
    from: [JOB_STATUS.VERIFYING],
    // Resolved to the actual verdict by the caller; see `resolveVerificationResult`.
    to: JOB_STATUS.VERIFIED_SAFE,
  },
  [JOB_ACTION.FAIL]: {
    from: [
      JOB_STATUS.RUNNING,
      JOB_STATUS.PAUSED,
      JOB_STATUS.CRASHED,
      JOB_STATUS.RECOVERING,
      JOB_STATUS.VERIFYING,
    ],
    to: JOB_STATUS.FAILED,
  },
  [JOB_ACTION.RESET]: {
    // Deliberately allowed from every state: reset is the escape hatch that must always work,
    // including out of a wedged job mid-demo.
    from: Object.values(JOB_STATUS),
    to: JOB_STATUS.IDLE,
  },
};

export function canTransition(action: JobAction, current: JobStatus): boolean {
  return JOB_TRANSITIONS[action].from.includes(current);
}

export function allowedFrom(action: JobAction): readonly JobStatus[] {
  return JOB_TRANSITIONS[action].from;
}

/** Terminal states: no work is in flight and no timer should be running. */
export const SETTLED_STATUSES: readonly JobStatus[] = [
  JOB_STATUS.IDLE,
  JOB_STATUS.COMPLETED,
  JOB_STATUS.VERIFIED_SAFE,
  JOB_STATUS.VERIFICATION_FAILED,
  JOB_STATUS.FAILED,
];

/** True while the engine should be advancing on each tick. */
export function isActivelyProcessing(status: JobStatus): boolean {
  return status === JOB_STATUS.RUNNING || status === JOB_STATUS.RECOVERING;
}

/**
 * True when the dataset must not be mutated from outside.
 *
 * Reseeding under a live engine would invalidate its in-flight state and make any coverage claim
 * meaningless, so this gates the destructive dataset endpoints.
 */
export function isDatasetLocked(status: JobStatus): boolean {
  return (
    status === JOB_STATUS.RUNNING ||
    status === JOB_STATUS.PAUSED ||
    status === JOB_STATUS.CRASHED ||
    status === JOB_STATUS.RECOVERING ||
    status === JOB_STATUS.VERIFYING
  );
}

export function resolveVerificationResult(passed: boolean): JobStatus {
  return passed ? JOB_STATUS.VERIFIED_SAFE : JOB_STATUS.VERIFICATION_FAILED;
}

/**
 * Human-readable reason a control is unavailable.
 *
 * Returns null when the action *is* available. The message names the current state and what is actually
 * allowed, which is the difference between a disabled button a user can reason about and one that just
 * looks broken.
 */
export function whyNotAllowed(action: JobAction, current: JobStatus | null): string | null {
  // No job yet. Only actions valid from IDLE make sense, since that is where a fresh server sits.
  const effective = current ?? JOB_STATUS.IDLE;
  if (canTransition(action, effective)) return null;

  return (
    `Cannot ${action} while the job is ${effective}. ` +
    `Allowed from: ${allowedFrom(action).join(', ')}.`
  );
}
