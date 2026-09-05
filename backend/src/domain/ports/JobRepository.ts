import type {
  BackfillMode,
  CheckpointInfo,
  JobStatus,
  SimulationSettings,
} from '@bg/shared';

/**
 * Persistence for the job record, its counters and its checkpoints.
 *
 * Split from `PatientRepository` because they answer different questions and have different
 * lifetimes: one is about the dataset being migrated, the other about the migration attempt. Keeping
 * them apart also means the naive comparison can share job bookkeeping while being handed a completely
 * separate patient store.
 */

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  mode: BackfillMode;
  seed: number;
  settings: SimulationSettings;
  totalRecords: number;
  partitionCount: number;
  eligibleRecords: number;
  processed: number;
  applied: number;
  noopAlreadyCurrent: number;
  conflicts: number;
  reevaluated: number;
  protectedUpdates: number;
  staleBlocked: number;
  failed: number;
  currentPartition: number;
  currentRecordIndex: number;
  startedAt: string | null;
  crashedAt: string | null;
  recoveredAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
}

export interface CreateJobInput {
  jobId: string;
  mode: BackfillMode;
  seed: number;
  settings: SimulationSettings;
  totalRecords: number;
  partitionCount: number;
  eligibleRecords: number;
}

/** Counter fields the engine increments. Kept separate so a typo can't overwrite job identity. */
export type JobCounters = Pick<
  JobRecord,
  | 'processed'
  | 'applied'
  | 'noopAlreadyCurrent'
  | 'conflicts'
  | 'reevaluated'
  | 'protectedUpdates'
  | 'staleBlocked'
  | 'failed'
  | 'currentPartition'
  | 'currentRecordIndex'
>;

export interface CreateCheckpointInput {
  jobId: string;
  partitionIndex: number;
  /** Must be the last *flushed* record position, never an in-flight one (R7.2a). */
  recordPosition: number;
  processedCount: number;
  jobStatus: JobStatus;
}

export interface JobRepository {
  create(input: CreateJobInput): Promise<JobRecord>;
  find(jobId: string): Promise<JobRecord | null>;
  /** The most recently started job, used to restore state after a restart. */
  findLatest(): Promise<JobRecord | null>;

  setStatus(
    jobId: string,
    status: JobStatus,
    timestamps?: Partial<
      Pick<JobRecord, 'crashedAt' | 'recoveredAt' | 'completedAt' | 'failureReason'>
    >,
  ): Promise<void>;

  /** Persists the counter snapshot. Called at flush boundaries rather than per record. */
  saveCounters(jobId: string, counters: JobCounters): Promise<void>;

  // --- checkpoints ---

  /** Creates an ACTIVE checkpoint and marks any previous one SUPERSEDED (R7.3). */
  createCheckpoint(input: CreateCheckpointInput): Promise<CheckpointInfo>;

  /** The ACTIVE checkpoint, or null. Never returns a LOST one (R7.7). */
  activeCheckpoint(jobId: string): Promise<CheckpointInfo | null>;

  /** Most recent checkpoint regardless of status, for the "last known position" display (R7.5). */
  lastKnownCheckpoint(jobId: string): Promise<CheckpointInfo | null>;

  /** Marks every checkpoint for the job LOST. Returns how many were affected. */
  loseCheckpoints(jobId: string): Promise<number>;

  deleteAll(): Promise<void>;
}
