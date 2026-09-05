import {
  CHECKPOINT_STATUS,
  JOB_STATUS,
  type CheckpointInfo,
  type JobStatus,
} from '@bg/shared';
import type {
  CreateCheckpointInput,
  CreateJobInput,
  JobCounters,
  JobRecord,
  JobRepository,
} from '../../domain/ports/JobRepository';

/**
 * In-memory job store, mirroring the SQLite one.
 *
 * Used by the test suite and by the naive-versus-guarded comparison, where each engine needs its own
 * isolated job bookkeeping alongside its isolated patient store.
 */
export class InMemoryJobRepository implements JobRepository {
  private jobs = new Map<string, JobRecord>();
  private checkpoints: CheckpointInfo[] = [];
  private nextCheckpointId = 1;
  private tick = 0;

  private stamp(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + this.tick).toISOString();
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const record: JobRecord = {
      jobId: input.jobId,
      status: JOB_STATUS.IDLE,
      mode: input.mode,
      seed: input.seed,
      settings: { ...input.settings },
      totalRecords: input.totalRecords,
      partitionCount: input.partitionCount,
      eligibleRecords: input.eligibleRecords,
      processed: 0,
      applied: 0,
      noopAlreadyCurrent: 0,
      conflicts: 0,
      reevaluated: 0,
      protectedUpdates: 0,
      staleBlocked: 0,
      failed: 0,
      currentPartition: 0,
      currentRecordIndex: 0,
      startedAt: this.stamp(),
      crashedAt: null,
      recoveredAt: null,
      completedAt: null,
      failureReason: null,
    };

    this.jobs.set(input.jobId, record);
    // Recreating a job discards the previous run's checkpoints, matching the cascade in SQLite.
    this.checkpoints = this.checkpoints.filter((cp) => cp.jobId !== input.jobId);

    return { ...record };
  }

  async find(jobId: string): Promise<JobRecord | null> {
    const record = this.jobs.get(jobId);
    return record ? { ...record } : null;
  }

  async findLatest(): Promise<JobRecord | null> {
    const all = [...this.jobs.values()];
    const latest = all[all.length - 1];
    return latest ? { ...latest } : null;
  }

  async setStatus(
    jobId: string,
    status: JobStatus,
    timestamps: Partial<
      Pick<JobRecord, 'crashedAt' | 'recoveredAt' | 'completedAt' | 'failureReason'>
    > = {},
  ): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`InMemoryJobRepository: job ${jobId} does not exist`);

    record.status = status;
    if (timestamps.crashedAt !== undefined) record.crashedAt = timestamps.crashedAt;
    if (timestamps.recoveredAt !== undefined) record.recoveredAt = timestamps.recoveredAt;
    if (timestamps.completedAt !== undefined) record.completedAt = timestamps.completedAt;
    if (timestamps.failureReason !== undefined) record.failureReason = timestamps.failureReason;
  }

  async saveCounters(jobId: string, counters: JobCounters): Promise<void> {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`InMemoryJobRepository: job ${jobId} does not exist`);
    Object.assign(record, counters);
  }

  async createCheckpoint(input: CreateCheckpointInput): Promise<CheckpointInfo> {
    for (const checkpoint of this.checkpoints) {
      if (checkpoint.jobId === input.jobId && checkpoint.status === CHECKPOINT_STATUS.ACTIVE) {
        checkpoint.status = CHECKPOINT_STATUS.SUPERSEDED;
      }
    }

    const created: CheckpointInfo = {
      id: this.nextCheckpointId++,
      jobId: input.jobId,
      partitionIndex: input.partitionIndex,
      recordPosition: input.recordPosition,
      processedCount: input.processedCount,
      jobStatus: input.jobStatus,
      status: CHECKPOINT_STATUS.ACTIVE,
      createdAt: this.stamp(),
    };

    this.checkpoints.push(created);
    return { ...created };
  }

  async activeCheckpoint(jobId: string): Promise<CheckpointInfo | null> {
    const found = [...this.checkpoints]
      .reverse()
      .find((cp) => cp.jobId === jobId && cp.status === CHECKPOINT_STATUS.ACTIVE);
    return found ? { ...found } : null;
  }

  async lastKnownCheckpoint(jobId: string): Promise<CheckpointInfo | null> {
    const found = [...this.checkpoints].reverse().find((cp) => cp.jobId === jobId);
    return found ? { ...found } : null;
  }

  async loseCheckpoints(jobId: string): Promise<number> {
    let count = 0;
    for (const checkpoint of this.checkpoints) {
      if (checkpoint.jobId === jobId && checkpoint.status !== CHECKPOINT_STATUS.LOST) {
        checkpoint.status = CHECKPOINT_STATUS.LOST;
        count += 1;
      }
    }
    return count;
  }

  async deleteAll(): Promise<void> {
    this.jobs.clear();
    this.checkpoints = [];
    this.nextCheckpointId = 1;
  }
}
