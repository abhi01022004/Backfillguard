import { JOB_STATUS, type JobStatus } from '@bg/shared';
import { InvalidJobStateError } from '../../lib/errors';

/**
 * The job lifecycle, as a single table (R8.7, R23.1).
 *
 * Every control the UI exposes maps to one action here. Centralising the rules means an illegal
 * transition is impossible rather than merely discouraged, and the error can name both the current
 * state and what is actually allowed — which is what lets the control panel disable a button with a
 * real explanation instead of failing on click.
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
const TRANSITIONS: Record<JobAction, { from: readonly JobStatus[]; to: JobStatus }> = {
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
  return TRANSITIONS[action].from.includes(current);
}

export function allowedFrom(action: JobAction): readonly JobStatus[] {
  return TRANSITIONS[action].from;
}

/**
 * Returns the next status, or throws `InvalidJobStateError` naming the allowed states.
 *
 * Throwing rather than returning a result type is deliberate: an illegal transition is a bug or a
 * stale UI, never an expected outcome to be quietly handled.
 */
export function transition(action: JobAction, current: JobStatus): JobStatus {
  if (!canTransition(action, current)) {
    throw new InvalidJobStateError(action, current, TRANSITIONS[action].from);
  }
  return TRANSITIONS[action].to;
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
