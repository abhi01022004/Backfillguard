import { ERROR_CODE, type ErrorCode, type JobStatus } from '@bg/shared';

/**
 * Typed application errors (R23.1).
 *
 * Every error carries a machine-readable code, an HTTP status, and an actionable message safe to
 * render directly in the UI. Nothing here is a generic `throw new Error('failed')` — the point is
 * that a failure tells the operator what broke and what to do about it (R23.5).
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;

  /** Relevant identifiers surfaced to the client alongside the message. */
  readonly details: Record<string, unknown> | undefined;

  /**
   * True for expected, handled conditions (a version conflict, a bad request).
   * False for bugs. Only operational errors are safe to show verbatim to a user.
   */
  readonly isOperational: boolean = true;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Request failed schema validation (R22.4). */
export class ValidationError extends AppError {
  readonly code = ERROR_CODE.VALIDATION_ERROR;
  readonly httpStatus = 400;
}

export class PatientNotFoundError extends AppError {
  readonly code = ERROR_CODE.PATIENT_NOT_FOUND;
  readonly httpStatus = 404;

  constructor(identifier: string | number) {
    super(`Patient ${identifier} does not exist.`, { patient: identifier });
  }
}

export class NotFoundError extends AppError {
  readonly code = ERROR_CODE.NOT_FOUND;
  readonly httpStatus = 404;
}

/**
 * A guarded write was refused because the row moved underneath us.
 * This is the core safety mechanism firing, not a malfunction.
 */
export class VersionConflictError extends AppError {
  readonly code = ERROR_CODE.VERSION_CONFLICT;
  readonly httpStatus = 409;

  constructor(patientCode: string, expectedVersion: number, currentVersion: number) {
    super(
      `Patient ${patientCode} was modified concurrently ` +
        `(expected v${expectedVersion}, found v${currentVersion}).`,
      { patientCode, expectedVersion, currentVersion },
    );
  }
}

/** Two online updates raced and one lost. */
export class ConcurrentUpdateError extends AppError {
  readonly code = ERROR_CODE.CONCURRENT_UPDATE;
  readonly httpStatus = 409;

  constructor(patientCode: string | number) {
    super(
      `Patient ${patientCode} was updated by someone else during this write. Retry the update.`,
      { patient: patientCode },
    );
  }
}

/**
 * A control was invoked in an incompatible job state (R8.7).
 * The message names the current state and what is actually allowed, so the UI can be specific.
 */
export class InvalidJobStateError extends AppError {
  readonly code = ERROR_CODE.INVALID_JOB_STATE;
  readonly httpStatus = 409;

  constructor(action: string, current: JobStatus, allowed: readonly JobStatus[]) {
    super(
      `Cannot ${action} while the job is ${current}. ` +
        `Allowed from: ${allowed.length > 0 ? allowed.join(', ') : 'no state'}.`,
      { action, currentStatus: current, allowedFrom: allowed },
    );
  }
}

/** Checkpoint operation attempted with no checkpoint present (R7.6). */
export class CheckpointMissingError extends AppError {
  readonly code = ERROR_CODE.CHECKPOINT_MISSING;
  readonly httpStatus = 409;

  constructor(jobId: string) {
    super(
      `Job ${jobId} has no checkpoint to operate on. Start the backfill and let it process ` +
        `enough records for a checkpoint to be created first.`,
      { jobId },
    );
  }
}

/** Recovery could not complete (R9.8). */
export class RecoveryFailedError extends AppError {
  readonly code = ERROR_CODE.RECOVERY_FAILED;
  readonly httpStatus = 422;

  constructor(reason: string, details?: Record<string, unknown>) {
    super(`Recovery failed: ${reason}`, details);
  }
}

export class ScenarioFailedError extends AppError {
  readonly code = ERROR_CODE.SCENARIO_FAILED;
  readonly httpStatus = 422;

  constructor(step: string, reason: string) {
    super(`Demo scenario failed at step "${step}": ${reason}`, { step, reason });
  }
}

/** Database-level failure. Not operational: the message shown to users stays generic. */
export class DatabaseError extends AppError {
  readonly code = ERROR_CODE.DATABASE_ERROR;
  readonly httpStatus = 500;
  override readonly isOperational = false;

  constructor(operation: string, cause?: unknown) {
    super(`Database operation failed: ${operation}`, { operation });
    this.cause = cause;
  }
}

/** Catch-all for unexpected failures. */
export class InternalError extends AppError {
  readonly code = ERROR_CODE.INTERNAL_ERROR;
  readonly httpStatus = 500;
  override readonly isOperational = false;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Normalise anything thrown into an AppError.
 * Nothing is swallowed — an unrecognised throw becomes an InternalError and keeps its cause (R23.3).
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof Error) {
    const wrapped = new InternalError(error.message);
    wrapped.cause = error;
    wrapped.stack = error.stack;
    return wrapped;
  }

  return new InternalError(`Unknown error: ${String(error)}`);
}
