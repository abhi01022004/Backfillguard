import { JOB_TRANSITIONS, type JobAction, type JobStatus, canTransition } from '@bg/shared';
import { InvalidJobStateError } from '../../lib/errors';

/**
 * The enforcement half of the job lifecycle (R8.7, R23.1).
 *
 * The rules themselves live in `@bg/shared` as a plain table, because the frontend needs the same rules to
 * decide which controls to enable. What lives *here* is the one thing the browser must not have: the
 * authority to refuse. The server is the enforcement point; the client's copy of the table is a prediction
 * used for labelling, and the two cannot disagree because there is only one table.
 *
 * Everything the previous single-file version exported is re-exported, so callers and tests are unaffected
 * by where the data now sits.
 */

export {
  JOB_ACTION,
  JOB_TRANSITIONS,
  SETTLED_STATUSES,
  allowedFrom,
  canTransition,
  isActivelyProcessing,
  isDatasetLocked,
  resolveVerificationResult,
  whyNotAllowed,
  type JobAction,
} from '@bg/shared';

/**
 * Returns the next status, or throws `InvalidJobStateError` naming the allowed states.
 *
 * Throwing rather than returning a result type is deliberate: an illegal transition is a bug or a
 * stale UI, never an expected outcome to be quietly handled.
 */
export function transition(action: JobAction, current: JobStatus): JobStatus {
  if (!canTransition(action, current)) {
    throw new InvalidJobStateError(action, current, JOB_TRANSITIONS[action].from);
  }
  return JOB_TRANSITIONS[action].to;
}
