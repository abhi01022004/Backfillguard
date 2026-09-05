import {
  CHECKPOINT_STATUS,
  DEFAULT_SIMULATION_SETTINGS,
  type BackfillMode,
  type CheckpointInfo,
  type CheckpointStatus,
  type JobStatus,
  type SimulationSettings,
} from '@bg/shared';
import type { BackfillJob, Checkpoint, PrismaClient } from '../../generated/prisma/client';
import type {
  CreateCheckpointInput,
  CreateJobInput,
  JobCounters,
  JobRecord,
  JobRepository,
} from '../../domain/ports/JobRepository';
import { DatabaseError } from '../../lib/errors';
import { logger } from '../../lib/logger';

export class PrismaJobRepository implements JobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private toJobRecord(row: BackfillJob): JobRecord {
    return {
      jobId: row.id,
      status: row.status as JobStatus,
      mode: row.mode as BackfillMode,
      seed: row.seed,
      settings: this.parseSettings(row.settings, row.id),
      totalRecords: row.totalRecords,
      partitionCount: row.partitionCount,
      eligibleRecords: row.eligibleRecords,
      processed: row.processed,
      applied: row.applied,
      noopAlreadyCurrent: row.noopAlreadyCurrent,
      conflicts: row.conflicts,
      reevaluated: row.reevaluated,
      protectedUpdates: row.protectedUpdates,
      staleBlocked: row.staleBlocked,
      failed: row.failed,
      currentPartition: row.currentPartition,
      currentRecordIndex: row.currentRecordIndex,
      startedAt: row.startedAt.toISOString(),
      crashedAt: row.crashedAt?.toISOString() ?? null,
      recoveredAt: row.recoveredAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      failureReason: row.failureReason,
    };
  }

  /**
   * Settings are stored as JSON, so a malformed value is possible in principle.
   *
   * Falling back to defaults with a warning rather than throwing: an unreadable settings blob should
   * not make an otherwise inspectable job record unloadable, which would block the reset that fixes it.
   */
  private parseSettings(raw: string, jobId: string): SimulationSettings {
    try {
      return JSON.parse(raw) as SimulationSettings;
    } catch {
      logger.warn('job settings could not be parsed; falling back to defaults', { jobId });
      return { ...DEFAULT_SIMULATION_SETTINGS };
    }
  }

  private toCheckpointInfo(row: Checkpoint): CheckpointInfo {
    return {
      id: row.id,
      jobId: row.jobId,
      partitionIndex: row.partitionIndex,
      recordPosition: row.recordPosition,
      processedCount: row.processedCount,
      jobStatus: row.jobStatus as JobStatus,
      status: row.status as CheckpointStatus,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- job

  async create(input: CreateJobInput): Promise<JobRecord> {
    try {
      /**
       * Upsert with a full counter reset, so restarting the demo reuses the same well-known job id
       * (BG-DEMO-001) rather than accumulating a graveyard of past runs. Cascades clear the previous
       * run's checkpoints and staged results; the ledgers are cleared separately by the reset path,
       * which also unscores the patients.
       */
      const row = await this.prisma.backfillJob.upsert({
        where: { id: input.jobId },
        create: {
          id: input.jobId,
          status: 'IDLE',
          mode: input.mode,
          seed: input.seed,
          settings: JSON.stringify(input.settings),
          totalRecords: input.totalRecords,
          partitionCount: input.partitionCount,
          eligibleRecords: input.eligibleRecords,
        },
        update: {
          status: 'IDLE',
          mode: input.mode,
          seed: input.seed,
          settings: JSON.stringify(input.settings),
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
          startedAt: new Date(),
          crashedAt: null,
          recoveredAt: null,
          completedAt: null,
          failureReason: null,
        },
      });

      return this.toJobRecord(row);
    } catch (cause) {
      throw new DatabaseError(`creating job ${input.jobId}`, cause);
    }
  }

  async find(jobId: string): Promise<JobRecord | null> {
    const row = await this.prisma.backfillJob.findUnique({ where: { id: jobId } });
    return row ? this.toJobRecord(row) : null;
  }

  async findLatest(): Promise<JobRecord | null> {
    const row = await this.prisma.backfillJob.findFirst({ orderBy: { startedAt: 'desc' } });
    return row ? this.toJobRecord(row) : null;
  }

  async setStatus(
    jobId: string,
    status: JobStatus,
    timestamps: Partial<
      Pick<JobRecord, 'crashedAt' | 'recoveredAt' | 'completedAt' | 'failureReason'>
    > = {},
  ): Promise<void> {
    await this.prisma.backfillJob.update({
      where: { id: jobId },
      data: {
        status,
        ...(timestamps.crashedAt === undefined
          ? {}
          : { crashedAt: timestamps.crashedAt === null ? null : new Date(timestamps.crashedAt) }),
        ...(timestamps.recoveredAt === undefined
          ? {}
          : { recoveredAt: timestamps.recoveredAt === null ? null : new Date(timestamps.recoveredAt) }),
        ...(timestamps.completedAt === undefined
          ? {}
          : { completedAt: timestamps.completedAt === null ? null : new Date(timestamps.completedAt) }),
        ...(timestamps.failureReason === undefined ? {} : { failureReason: timestamps.failureReason }),
      },
    });
  }

  async saveCounters(jobId: string, counters: JobCounters): Promise<void> {
    await this.prisma.backfillJob.update({ where: { id: jobId }, data: { ...counters } });
  }

  // ---------------------------------------------------------------- checkpoints

  async createCheckpoint(input: CreateCheckpointInput): Promise<CheckpointInfo> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Exactly one ACTIVE checkpoint per job (R7.3). Superseding inside the same transaction keeps
        // that invariant true even if a second checkpoint is requested concurrently.
        await tx.checkpoint.updateMany({
          where: { jobId: input.jobId, status: CHECKPOINT_STATUS.ACTIVE },
          data: { status: CHECKPOINT_STATUS.SUPERSEDED },
        });

        const row = await tx.checkpoint.create({
          data: {
            jobId: input.jobId,
            partitionIndex: input.partitionIndex,
            recordPosition: input.recordPosition,
            processedCount: input.processedCount,
            jobStatus: input.jobStatus,
            status: CHECKPOINT_STATUS.ACTIVE,
          },
        });

        return this.toCheckpointInfo(row);
      });
    } catch (cause) {
      throw new DatabaseError(`creating checkpoint for job ${input.jobId}`, cause);
    }
  }

  /**
   * Only ever returns an ACTIVE checkpoint.
   *
   * Filtering here rather than at the call site is deliberate: it makes it impossible for any caller to
   * accidentally resume from a checkpoint that was explicitly destroyed (R7.7).
   */
  async activeCheckpoint(jobId: string): Promise<CheckpointInfo | null> {
    const row = await this.prisma.checkpoint.findFirst({
      where: { jobId, status: CHECKPOINT_STATUS.ACTIVE },
      orderBy: { id: 'desc' },
    });
    return row ? this.toCheckpointInfo(row) : null;
  }

  /** Includes LOST checkpoints, for the "last known position" narration only (R7.5). */
  async lastKnownCheckpoint(jobId: string): Promise<CheckpointInfo | null> {
    const row = await this.prisma.checkpoint.findFirst({
      where: { jobId },
      orderBy: { id: 'desc' },
    });
    return row ? this.toCheckpointInfo(row) : null;
  }

  async loseCheckpoints(jobId: string): Promise<number> {
    const result = await this.prisma.checkpoint.updateMany({
      where: { jobId, status: { in: [CHECKPOINT_STATUS.ACTIVE, CHECKPOINT_STATUS.SUPERSEDED] } },
      data: { status: CHECKPOINT_STATUS.LOST },
    });
    return result.count;
  }

  async deleteAll(): Promise<void> {
    await this.prisma.backfillJob.deleteMany();
  }
}
