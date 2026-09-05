import type {
  BackfillMode,
  CheckpointStatus,
  ConflictResolution,
  JobStatus,
  PartitionState,
} from './enums';
import type { FieldChange } from './patient';
import type { SimulationSettings } from './config';

/** Live metrics for a backfill job (R4.6). Every field is a real count, never a placeholder. */
export interface JobMetrics {
  /** Records in scope for this job. */
  eligibleRecords: number;
  /** Records the engine has finished deciding about. */
  processed: number;
  /** Guarded writes that landed on first attempt. */
  applied: number;
  /** Revisited during recovery and correctly left alone (R9.4). */
  noopAlreadyCurrent: number;
  conflicts: number;
  reevaluated: number;
  /** Online updates protected from being clobbered — one per blocked stale write. */
  protectedUpdates: number;
  /** Stale writes the version guard refused. */
  staleWriteAttemptsBlocked: number;
  failed: number;
  currentPartition: number;
  currentRecordIndex: number;
  percentComplete: number;
}

export interface PartitionProgress {
  partitionIndex: number;
  state: PartitionState;
  totalRecords: number;
  processedRecords: number;
  /** Unresolved conflicts in this partition, drives the partition conflict badge (R15.5). */
  openConflicts: number;
  percentComplete: number;
}

export interface BackfillJobState {
  jobId: string;
  status: JobStatus;
  mode: BackfillMode;
  seed: number;
  settings: SimulationSettings;
  /**
   * Null when no run has been started or after a reset.
   *
   * Metrics describe a *run*, so with no run there are no metrics — and saying so is more accurate than
   * reporting zeros. A zeroed `eligibleRecords` in particular would be simply false: the dataset still holds
   * its patients, there is just nothing measuring them yet. A live check caught exactly that, with the
   * dashboard showing "Total patients: 0" over a seeded 1,000-record dataset.
   */
  metrics: JobMetrics | null;
  partitions: PartitionProgress[];
  /** Number of staged, computed-but-unwritten results. Non-zero after a crash. */
  pendingResultCount: number;
  checkpoint: CheckpointInfo | null;
  startedAt: string | null;
  crashedAt: string | null;
  recoveredAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
}

export interface CheckpointInfo {
  id: number;
  jobId: string;
  partitionIndex: number;
  /** Always the last *flushed* record position, never an in-flight one (R7.2a). */
  recordPosition: number;
  processedCount: number;
  jobStatus: JobStatus;
  status: CheckpointStatus;
  createdAt: string;
}

/** A detected version conflict and how it was resolved (R5.5, R10.1). */
export interface ConflictRecord {
  id: number;
  jobId: string;
  patientId: number;
  patientCode: string;
  /** Version the stale computation was based on. */
  sourceVersion: number;
  /** Version actually present in the database when the write was attempted. */
  currentVersion: number;
  /** The score that was computed from stale data and rejected. */
  oldScore: number;
  /** The score computed after re-reading. Null until re-evaluation completes. */
  newScore: number | null;
  changedFields: FieldChange[];
  resolution: ConflictResolution;
  detectedAt: string;
  resolvedAt: string | null;
}

/** Summary emitted by RECOVERY_COMPLETED (R9.7). */
export interface RecoverySummary {
  /** Partition the evidence-derived boundary landed on. */
  recoveryStartPartition: number;
  recordsRevisited: number;
  /** Left untouched because already derived from the current version. */
  noops: number;
  recordsReprocessed: number;
  conflictsFound: number;
  /** Staged stale results that were revalidated before any write. */
  pendingResultsRevalidated: number;
  pendingResultsRejected: number;
}
