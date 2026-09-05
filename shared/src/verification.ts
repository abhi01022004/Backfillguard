import type { BackfillMode, VerificationCheckId, VerificationVerdict } from './enums';

/**
 * Result of one independent verification check (design §10).
 *
 * `offendingPatientCodes` is what makes a failure actionable rather than just a red number:
 * the report names the exact records that broke the invariant (R20.3).
 */
export interface VerificationCheckResult {
  id: VerificationCheckId;
  /** Short title, e.g. 'Every eligible record considered'. */
  title: string;
  passed: boolean;
  /** What was actually measured, e.g. '1000 / 1000 records considered'. */
  detail: string;
  /** How this check reaches its conclusion, so a reviewer can judge its independence. */
  method: string;
  offendingPatientCodes: string[];
}

/**
 * The full audited metric set (R11.9).
 *
 * Every number here is derived by re-reading persisted state and recomputing — none of it is copied
 * from an engine counter (R11.1). That is the whole point: the engine does not grade itself.
 */
export interface VerificationMetrics {
  eligibleRecords: number;
  consideredRecords: number;
  completedRecords: number;
  conflicts: number;
  reevaluated: number;
  protectedUpdates: number;
  /** Stale writes the version guard refused. Expected to be > 0 in any interesting run. */
  staleWriteAttemptsBlocked: number;
  /**
   * Stale writes that actually landed. This is the headline safety number and must be 0.
   * Measured from the write ledger, not from a counter.
   */
  staleOverwrites: number;
  /** Clinical values written by an online update and later clobbered by older data. Must be 0. */
  lostOnlineUpdates: number;
  missedRecords: number;
  /** Rows whose stored score does not match a recomputation from current values. Must be 0. */
  inconsistentRecords: number;
  /**
   * Records updated online *after* their own consideration. Not a safety violation (R11.8): the
   * record was considered and nothing stale was written over it, the score is simply older than the
   * newest reading. Reported so the gap is visible rather than hidden, and resolved by a subsequent
   * backfill generation.
   */
  postConsiderationDrift: number;
  coveragePercent: number;
}

export interface VerificationReport {
  jobId: string;
  mode: BackfillMode;
  datasetDescription: string;
  seed: number;
  verdict: VerificationVerdict;
  metrics: VerificationMetrics;
  checks: VerificationCheckResult[];
  /** The plain-language guarantee statement shown on the report (R20.4). */
  guaranteeStatement: string;
  jobStartedAt: string | null;
  jobCompletedAt: string | null;
  verifiedAt: string;
  durationMs: number | null;
}

/** One side of the naive-vs-guarded comparison (R12.3, R12.4). */
export interface ComparisonSide {
  mode: BackfillMode;
  label: string;
  metrics: VerificationMetrics;
  verdict: VerificationVerdict;
}

/**
 * The concrete, named example that makes the abstract claim legible (R12.5):
 * one patient, shown under both engines.
 */
export interface ComparisonSpotlight {
  patientCode: string;
  /** The clinical field the online update changed. */
  field: string;
  /** Value before the online update — what the stale computation was based on. */
  originalValue: string | number;
  /** Value the doctor/lab wrote. */
  onlineUpdatedValue: string | number;
  naive: {
    /** Under naive whole-row write-back this reverts to `originalValue`. */
    finalValue: string | number;
    finalScore: number | null;
    lostTheOnlineUpdate: boolean;
    staleOverwrite: boolean;
  };
  guarded: {
    /** Under BackfillGuard this stays at `onlineUpdatedValue`. */
    finalValue: string | number;
    finalScore: number | null;
    lostTheOnlineUpdate: boolean;
    staleOverwrite: boolean;
    conflictDetected: boolean;
    reevaluated: boolean;
  };
}

export interface ComparisonResult {
  seed: number;
  scenarioName: string;
  naive: ComparisonSide;
  guarded: ComparisonSide;
  spotlight: ComparisonSpotlight;
  ranAt: string;
}
