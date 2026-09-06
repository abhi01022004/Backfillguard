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

/**
 * Independently re-derived facts about the run's outbound risk alerts.
 *
 * ## Why this is an advisory and not a seventh check
 *
 * `checks[]` decides the verdict, and the verdict is a statement about **data safety**: was every record
 * considered, and did any stale value land on top of newer clinical data. Notifications are a side effect
 * *of* that process, not part of it.
 *
 * Folding these in would mean a defect in a demo messaging simulator could turn a run whose data was
 * provably correct into `VERIFICATION_FAILED`. That would misrepresent what the verdict means — a reader
 * seeing a red result would reasonably conclude patient data had been corrupted when it had not. Keeping
 * the two separate is what lets `VERIFIED_SAFE` retain a precise meaning.
 *
 * It is still measured the same way everything else here is: by re-reading stored notification rows and
 * cross-checking them against the write ledger, never by trusting a counter. And a non-zero anomaly is
 * reported loudly — it emits a CRITICAL event — it simply does not change the verdict.
 */
export interface NotificationAdvisory {
  sent: number;
  /** Alerts withheld because the version guard refused the underlying write. Expected to be > 0 under contention. */
  cancelled: number;
  /** Still QUEUED when the run ended. Non-zero means results were staged and never resolved either way. */
  queuedAtEnd: number;
  failed: number;
  /**
   * Alerts transmitted for a result that has no matching applied guarded write. **Must be 0.**
   *
   * This is the notification equivalent of `staleOverwrites`: it is the number that would be non-zero if
   * an alert had ever gone out describing data the database never actually committed.
   */
  staleNotifications: number;
  /** More than one alert transmitted for the same job, patient, version and band. **Must be 0.** */
  duplicateNotifications: number;
  /** True when both must-be-zero figures are zero. */
  clean: boolean;
  offendingPatientCodes: string[];
  /** How these numbers were reached, so a reviewer can judge their independence. */
  method: string;
}

export interface VerificationAdvisory {
  notifications: NotificationAdvisory;
}

export interface VerificationReport {
  jobId: string;
  mode: BackfillMode;
  datasetDescription: string;
  seed: number;
  verdict: VerificationVerdict;
  metrics: VerificationMetrics;
  checks: VerificationCheckResult[];
  /**
   * Non-blocking observations. Absent when the notification feature is not wired in.
   *
   * Deliberately optional rather than defaulted to zeros: a report from a system with no notification
   * store should say nothing about notifications, not claim it measured zero of them.
   */
  advisory?: VerificationAdvisory;
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
