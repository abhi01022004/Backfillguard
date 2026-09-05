import {
  CHECKPOINT_STATUS,
  EVENT_SEVERITY,
  EVENT_TYPE,
  type CheckpointInfo,
  type JobStatus,
} from '@bg/shared';
import type { EventSink } from '../ports/EventSink';
import type { JobRepository } from '../ports/JobRepository';
import { CheckpointMissingError } from '../../lib/errors';

/**
 * Checkpoint creation and destruction (R7).
 *
 * A checkpoint records where a run had got to, so an interruption does not mean starting over. The
 * demo then deliberately destroys it, to show that recovery does not actually depend on one — the
 * durable evidence in the data is enough.
 *
 * ## The invariant that matters
 *
 * `recordPosition` must always refer to the last record whose write has been **flushed**, never one
 * still sitting in the in-flight batch. A checkpoint that advertised unflushed progress would cause a
 * resume to skip records that were never written, silently breaking coverage while appearing to
 * succeed — the worst class of bug this project could ship, because the job would report success.
 *
 * `record()` therefore asserts the position it is given, and is only ever called from the post-flush
 * path (R7.2a).
 */

export interface CheckpointManagerDeps {
  jobs: JobRepository;
  events: EventSink;
  /** Records between checkpoints. */
  interval: number;
}

export interface CheckpointPosition {
  partitionIndex: number;
  /** Last flushed record position within the partition. */
  lastFlushedPosition: number;
  processedCount: number;
}

export class CheckpointManager {
  /** Processed count at which the next checkpoint becomes due. */
  private nextDueAt: number;

  private createdCount = 0;

  constructor(private readonly deps: CheckpointManagerDeps) {
    this.nextDueAt = deps.interval;
  }

  reset(): void {
    this.nextDueAt = this.deps.interval;
    this.createdCount = 0;
  }

  get created(): number {
    return this.createdCount;
  }

  /**
   * Creates a checkpoint if enough records have been processed since the last one.
   *
   * Returns the checkpoint when one was created, else null. Must only be called after a flush.
   */
  async maybeRecord(
    jobId: string,
    jobStatus: JobStatus,
    position: CheckpointPosition,
  ): Promise<CheckpointInfo | null> {
    if (position.processedCount < this.nextDueAt) return null;
    return this.record(jobId, jobStatus, position);
  }

  /** Forces a checkpoint regardless of cadence. Used at partition boundaries by recovery. */
  async record(
    jobId: string,
    jobStatus: JobStatus,
    position: CheckpointPosition,
  ): Promise<CheckpointInfo> {
    /**
     * Guards the invariant in code rather than by convention.
     *
     * A negative position means nothing has been flushed yet, which makes a checkpoint meaningless.
     * Recording one anyway would let a resume believe progress existed where none was durable.
     */
    if (position.lastFlushedPosition < 0) {
      throw new Error(
        `Refusing to checkpoint job ${jobId}: no record has been flushed yet ` +
          `(lastFlushedPosition=${position.lastFlushedPosition}). A checkpoint must never advertise ` +
          `unflushed progress.`,
      );
    }

    const checkpoint = await this.deps.jobs.createCheckpoint({
      jobId,
      partitionIndex: position.partitionIndex,
      recordPosition: position.lastFlushedPosition,
      processedCount: position.processedCount,
      jobStatus,
    });

    this.createdCount += 1;
    this.nextDueAt = position.processedCount + this.deps.interval;

    this.deps.events.emit({
      type: EVENT_TYPE.CHECKPOINT_CREATED,
      severity: EVENT_SEVERITY.INFO,
      jobId,
      partitionIndex: checkpoint.partitionIndex,
      message:
        `Checkpoint at ${checkpoint.processedCount} records ` +
        `(partition ${checkpoint.partitionIndex}, record ${checkpoint.recordPosition}).`,
      payload: {
        checkpointId: checkpoint.id,
        processedCount: checkpoint.processedCount,
        partitionIndex: checkpoint.partitionIndex,
        recordPosition: checkpoint.recordPosition,
      },
    });

    return checkpoint;
  }

  /**
   * A trusted resume cursor, or null.
   *
   * Only ever returns an ACTIVE checkpoint. The repository filters by status, and this method
   * re-asserts it: the whole demo turns on a lost checkpoint being genuinely unusable, so it is worth
   * two independent guards against a future change quietly making a LOST checkpoint readable (R7.7).
   */
  async getResumeCursor(jobId: string): Promise<CheckpointInfo | null> {
    const checkpoint = await this.deps.jobs.activeCheckpoint(jobId);
    if (!checkpoint) return null;

    if (checkpoint.status !== CHECKPOINT_STATUS.ACTIVE) {
      throw new Error(
        `Checkpoint ${checkpoint.id} for job ${jobId} has status ${checkpoint.status} but was ` +
          `returned as an active resume cursor. A non-active checkpoint must never be trusted.`,
      );
    }

    return checkpoint;
  }

  /** The most recent checkpoint whatever its status, for the "last known position" display (R7.5). */
  async getLastKnown(jobId: string): Promise<CheckpointInfo | null> {
    return this.deps.jobs.lastKnownCheckpoint(jobId);
  }

  /**
   * Destroys every checkpoint for the job (R7.4).
   *
   * Nothing about the dataset changes: already-written derived values stay exactly as they are. Only
   * the job's knowledge of its own position is lost, which is precisely the condition recovery has to
   * cope with using data evidence alone.
   */
  async lose(jobId: string): Promise<CheckpointInfo> {
    const lastKnown = await this.deps.jobs.lastKnownCheckpoint(jobId);

    if (!lastKnown) {
      // Refusing rather than silently succeeding: "lose checkpoint" with no checkpoint would tell the
      // operator a destructive action worked when nothing happened.
      throw new CheckpointMissingError(jobId);
    }

    const count = await this.deps.jobs.loseCheckpoints(jobId);

    this.deps.events.emit({
      type: EVENT_TYPE.CHECKPOINT_LOST,
      severity: EVENT_SEVERITY.CRITICAL,
      jobId,
      partitionIndex: lastKnown.partitionIndex,
      message:
        `CHECKPOINT LOST — ${count} checkpoint(s) destroyed. Last known position: ` +
        `partition ${lastKnown.partitionIndex} / record ${lastKnown.recordPosition} ` +
        `(${lastKnown.processedCount} records processed). Recovery must now rely on version evidence.`,
      payload: {
        destroyedCount: count,
        lastKnownPartition: lastKnown.partitionIndex,
        lastKnownRecordPosition: lastKnown.recordPosition,
        lastKnownProcessedCount: lastKnown.processedCount,
      },
    });

    return lastKnown;
  }
}
