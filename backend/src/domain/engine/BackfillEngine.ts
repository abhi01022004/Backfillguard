import {
  BACKFILL_STATUS,
  CONSIDERATION_OUTCOME,
  EVENT_SEVERITY,
  EVENT_TYPE,
  PARTITION_STATE,
  type JobMetrics,
  type PartitionProgress,
  type PartitionState,
  type Patient,
  type RiskLevel,
} from '@bg/shared';
import type { EventSink } from '../ports/EventSink';
import type {
  ClinicalSnapshot,
  PatientRepository,
  PendingResultWrite,
} from '../ports/PatientRepository';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { validateGuardedWrite, VERSION_DECISION } from './VersionValidator';
import { ConflictEngine, snapshotOf } from './ConflictEngine';

/**
 * The guarded backfill engine (R4, R5).
 *
 * ## Shape of the work
 *
 * Records are processed partition by partition, in id order, so a scan is a stable resumable sequence.
 * Each record is read, its source version captured, its score computed — and then *staged* in an
 * in-flight batch rather than written immediately.
 *
 * ## Why the batch exists
 *
 * Batching is not a performance flourish; it is the mechanism that makes the failure being
 * demonstrated real. Large backfills are commonly built as a compute stage that commits results to a
 * staging table and a write stage that drains it. That gap between computing a value and persisting it
 * is exactly where staleness is born: an online update can land in between, and on resume the staged
 * result is older than the row it is about to overwrite.
 *
 * So the engine keeps a bounded batch, and a crash freezes it durably. On resume, this engine
 * revalidates every staged entry against the current version before writing; the naive engine flushes
 * them verbatim. Same data, same scenario, opposite outcome.
 *
 * ## What the engine guarantees
 *
 * Every eligible record ends with exactly one terminal ledger entry. There is no path that skips a
 * record silently — not an error, not a conflict, not an exhausted retry. That is what makes coverage
 * a set comparison rather than a hopeful counter.
 */

export interface BackfillEngineDeps {
  repository: PatientRepository;
  events: EventSink;
  conflicts: ConflictEngine;
  jobId: string;
  partitionCount: number;
  batchSize: number;
  /** Phase label written to the ledgers, distinguishing initial processing from recovery. */
  phase: string;
}

/** A computed-but-unwritten result held in the in-flight batch. */
export interface StagedResult {
  patient: Patient;
  sourceVersion: number;
  snapshot: ClinicalSnapshot;
  score: number;
  level: RiskLevel;
}

export interface EngineCounters {
  processed: number;
  applied: number;
  noopAlreadyCurrent: number;
  conflicts: number;
  reevaluated: number;
  protectedUpdates: number;
  staleBlocked: number;
  failed: number;
}

const ZERO_COUNTERS: EngineCounters = {
  processed: 0,
  applied: 0,
  noopAlreadyCurrent: 0,
  conflicts: 0,
  reevaluated: 0,
  protectedUpdates: 0,
  staleBlocked: 0,
  failed: 0,
};

export interface StepResult {
  /** False once every partition has been processed and the final batch flushed. */
  hasMoreWork: boolean;
  /** True when this step ended with a flush, which is the only safe point to checkpoint (R7.2a). */
  flushed: boolean;
  patientCode: string | null;
}

export class BackfillEngine {
  private counters: EngineCounters = { ...ZERO_COUNTERS };

  private batch: StagedResult[] = [];

  private partitionIndex = 0;
  private recordIndex = 0;

  /** Records of the partition currently being scanned, loaded once per partition. */
  private partitionRecords: Patient[] = [];
  private partitionLoaded = false;

  /**
   * Monotonic count of records read into a batch.
   *
   * Distinct from `processed`, which only advances when a batch is *flushed*. The gap between the two
   * is exactly the in-flight window — the interval in which a record has been read and scored but not
   * yet written, and therefore the only interval in which an online update can create staleness.
   *
   * The scripted scenario keys its updates off this counter for that reason: targeting `processed`
   * could only ever inject an update after the write had already landed, which would produce no
   * conflict at all.
   */
  private recordsRead = 0;

  /** Position of the last record whose write has actually been flushed. */
  private lastFlushedPosition = -1;

  private partitionStates = new Map<number, PartitionState>();
  private partitionProcessed = new Map<number, number>();
  private partitionTotals = new Map<number, number>();

  private eligibleRecords = 0;
  private finished = false;

  constructor(private readonly deps: BackfillEngineDeps) {}

  // ------------------------------------------------------------------ lifecycle

  /** Loads the eligible set and resets progress. Emits BACKFILL_STARTED. */
  async begin(startPartition = 0): Promise<void> {
    this.counters = { ...ZERO_COUNTERS };
    this.batch = [];
    this.partitionIndex = startPartition;
    this.recordIndex = 0;
    this.partitionLoaded = false;
    this.lastFlushedPosition = -1;
    this.recordsRead = 0;
    this.finished = false;
    this.partitionStates.clear();
    this.partitionProcessed.clear();

    const ids = await this.deps.repository.allIds();
    this.eligibleRecords = ids.length;

    // Partition totals come from the data rather than from arithmetic, so an uneven distribution or a
    // partially seeded dataset is reflected accurately instead of assumed.
    this.partitionTotals.clear();
    for (let partition = 0; partition < this.deps.partitionCount; partition += 1) {
      const records = await this.deps.repository.findByPartition(partition);
      this.partitionTotals.set(partition, records.length);
      this.partitionStates.set(
        partition,
        partition < startPartition ? PARTITION_STATE.COMPLETED : PARTITION_STATE.PENDING,
      );
      this.partitionProcessed.set(partition, partition < startPartition ? records.length : 0);
    }

    this.deps.events.emit({
      type: EVENT_TYPE.BACKFILL_STARTED,
      severity: EVENT_SEVERITY.INFO,
      jobId: this.deps.jobId,
      message:
        `Backfill started over ${this.eligibleRecords} eligible records ` +
        `across ${this.deps.partitionCount} partitions.`,
      payload: {
        eligibleRecords: this.eligibleRecords,
        partitionCount: this.deps.partitionCount,
        batchSize: this.deps.batchSize,
        startPartition,
      },
    });
  }

  /**
   * Restores position without re-emitting a start event, used when recovery hands over to forward
   * processing.
   */
  async resumeAt(partitionIndex: number, recordIndex = 0): Promise<void> {
    this.partitionIndex = partitionIndex;
    this.recordIndex = recordIndex;
    this.partitionLoaded = false;
    this.finished = false;
  }

  // ------------------------------------------------------------------ the per-record step

  /**
   * Advances by exactly one record.
   *
   * Single-record granularity is what makes the simulation controllable and deterministic: pausing,
   * crashing and checkpointing all happen at record boundaries, and the orchestrator decides *when* to
   * step rather than the engine racing ahead on its own timer.
   */
  async step(): Promise<StepResult> {
    if (this.finished) {
      return { hasMoreWork: false, flushed: false, patientCode: null };
    }

    // Past the last partition: flush whatever remains and stop.
    if (this.partitionIndex >= this.deps.partitionCount) {
      const flushed = this.batch.length > 0;
      if (flushed) await this.flush();
      this.finished = true;
      return { hasMoreWork: false, flushed, patientCode: null };
    }

    if (!this.partitionLoaded) {
      this.partitionRecords = await this.deps.repository.findByPartition(this.partitionIndex);
      this.partitionLoaded = true;
      this.partitionStates.set(this.partitionIndex, PARTITION_STATE.PROCESSING);
    }

    // End of this partition: flush before advancing, so a partition is never reported complete while
    // any of its results are still unwritten.
    if (this.recordIndex >= this.partitionRecords.length) {
      const flushed = this.batch.length > 0;
      if (flushed) await this.flush();

      this.partitionStates.set(this.partitionIndex, PARTITION_STATE.COMPLETED);
      this.partitionIndex += 1;
      this.recordIndex = 0;
      this.partitionLoaded = false;

      return {
        hasMoreWork: this.partitionIndex < this.deps.partitionCount,
        flushed,
        patientCode: null,
      };
    }

    const patient = this.partitionRecords[this.recordIndex]!;
    this.recordIndex += 1;

    await this.readAndStage(patient);

    let flushed = false;
    if (this.batch.length >= this.deps.batchSize) {
      await this.flush();
      flushed = true;
    }

    return { hasMoreWork: true, flushed, patientCode: patient.patientCode };
  }

  /**
   * Reads a record, captures the version its computation is based on, and stages the result.
   *
   * Capturing `sourceVersion` here — not at write time — is the whole basis of the safety mechanism.
   * It is the evidence that says "this number was derived from the row as it looked at version N".
   */
  private async readAndStage(patient: Patient): Promise<void> {
    // Re-read rather than trusting the partition snapshot: the list may have been loaded many records
    // ago, and staging a result against a version we no longer know to be current would manufacture
    // conflicts that never really happened.
    const fresh = (await this.deps.repository.findById(patient.id)) ?? patient;

    const snapshot = snapshotOf(fresh);
    const sourceVersion = fresh.version;

    this.deps.events.emit({
      type: EVENT_TYPE.RECORD_READ,
      jobId: this.deps.jobId,
      patientCode: fresh.patientCode,
      partitionIndex: fresh.partitionIndex,
      message: `Read ${fresh.patientCode} at v${sourceVersion}.`,
      payload: { sourceVersion },
    });

    const result = calculateRiskScore(toRiskInput(snapshot));

    this.deps.events.emit({
      type: EVENT_TYPE.RISK_CALCULATED,
      jobId: this.deps.jobId,
      patientCode: fresh.patientCode,
      partitionIndex: fresh.partitionIndex,
      message: `Computed score ${result.score} (${result.level}) for ${fresh.patientCode} from v${sourceVersion}.`,
      payload: { score: result.score, level: result.level, sourceVersion },
    });

    this.batch.push({
      patient: fresh,
      sourceVersion,
      snapshot,
      score: result.score,
      level: result.level,
    });

    this.recordsRead += 1;
  }

  // ------------------------------------------------------------------ flush

  /**
   * Attempts a guarded write for every staged result.
   *
   * Each entry is written under the version it was computed from. An entry whose row has moved is
   * refused by the database and handed to the conflict engine, which recomputes from current data.
   */
  async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const entries = this.batch;
    this.batch = [];

    for (const entry of entries) {
      await this.writeStaged(entry);
    }

    this.lastFlushedPosition = this.recordIndex - 1;
  }

  private async writeStaged(entry: StagedResult): Promise<void> {
    const { patient, sourceVersion, snapshot, score, level } = entry;

    try {
      const result = await this.deps.repository.applyGuarded(
        patient.id,
        sourceVersion,
        { riskScore: score, riskLevel: level, backfillStatus: BACKFILL_STATUS.COMPLETED },
        {
          jobId: this.deps.jobId,
          guarded: true,
          wroteSourceFields: false,
          scoreWritten: score,
          phase: this.deps.phase,
        },
      );

      const validation = validateGuardedWrite(result);

      this.deps.events.emit({
        type: EVENT_TYPE.VERSION_VALIDATED,
        jobId: this.deps.jobId,
        patientCode: patient.patientCode,
        partitionIndex: patient.partitionIndex,
        message:
          validation.decision === VERSION_DECISION.APPLIED
            ? `${patient.patientCode} still at v${sourceVersion} — safe to apply.`
            : `${patient.patientCode} moved to v${validation.currentVersion} — result is stale.`,
        payload: {
          decision: validation.decision,
          sourceVersion,
          currentVersion: validation.currentVersion,
        },
      });

      if (validation.decision === VERSION_DECISION.APPLIED) {
        await this.deps.repository.recordConsideration({
          jobId: this.deps.jobId,
          patientId: patient.id,
          outcome: CONSIDERATION_OUTCOME.APPLIED,
          sourceVersion,
          appliedVersion: sourceVersion,
          attempts: 1,
          phase: this.deps.phase,
          reason: null,
        });

        this.counters.applied += 1;
        this.counters.processed += 1;
        this.bumpPartitionProgress(patient.partitionIndex);

        this.deps.events.emit({
          type: EVENT_TYPE.RECORD_UPDATED,
          severity: EVENT_SEVERITY.SUCCESS,
          jobId: this.deps.jobId,
          patientCode: patient.patientCode,
          partitionIndex: patient.partitionIndex,
          message: `${patient.patientCode} scored ${score} (${level}).`,
          payload: { score, level, appliedVersion: sourceVersion },
        });

        return;
      }

      // Stale. The guard refused the write, so a newer online update has been protected.
      this.counters.staleBlocked += 1;
      this.counters.protectedUpdates += 1;
      this.counters.conflicts += 1;

      const outcome = await this.deps.conflicts.handleStaleWrite({
        jobId: this.deps.jobId,
        patient,
        staleSnapshot: snapshot,
        staleScore: score,
        sourceVersion,
        currentVersion: validation.currentVersion,
        phase: this.deps.phase,
      });

      if (outcome.resolved) {
        this.counters.reevaluated += 1;
      } else {
        this.counters.failed += 1;
      }

      this.counters.processed += 1;
      this.bumpPartitionProgress(patient.partitionIndex);
    } catch (error) {
      // An unexpected failure must still leave the record with a terminal outcome. Skipping it here
      // would break the coverage guarantee in the one situation nobody is watching.
      const reason = error instanceof Error ? error.message : String(error);

      await this.deps.repository.recordConsideration({
        jobId: this.deps.jobId,
        patientId: patient.id,
        outcome: CONSIDERATION_OUTCOME.FAILED,
        sourceVersion,
        appliedVersion: null,
        attempts: 1,
        phase: this.deps.phase,
        reason,
      });

      this.counters.failed += 1;
      this.counters.processed += 1;
      this.bumpPartitionProgress(patient.partitionIndex);
      this.partitionStates.set(patient.partitionIndex, PARTITION_STATE.FAILED);

      this.deps.events.emit({
        type: EVENT_TYPE.RECORD_FAILED,
        severity: EVENT_SEVERITY.CRITICAL,
        jobId: this.deps.jobId,
        patientCode: patient.patientCode,
        partitionIndex: patient.partitionIndex,
        message: `${patient.patientCode} failed: ${reason}`,
        payload: { reason },
      });
    }
  }

  private bumpPartitionProgress(partitionIndex: number): void {
    this.partitionProcessed.set(partitionIndex, (this.partitionProcessed.get(partitionIndex) ?? 0) + 1);
  }

  // ------------------------------------------------------------------ crash support

  /**
   * Hands over the unflushed batch so it can be staged durably (R8.4).
   *
   * Clears the in-memory batch, because after a crash the authoritative copy is the staged one. Two
   * copies of the same pending result would risk writing it twice.
   */
  takeInFlightBatch(): PendingResultWrite[] {
    const entries = this.batch;
    this.batch = [];

    return entries.map((entry) => ({
      jobId: this.deps.jobId,
      patientId: entry.patient.id,
      sourceVersion: entry.sourceVersion,
      computedScore: entry.score,
      computedLevel: entry.level,
      inputSnapshot: entry.snapshot,
    }));
  }

  inFlightCount(): number {
    return this.batch.length;
  }

  /** Records read into a batch so far. See `recordsRead` for why this differs from `processed`. */
  get readCount(): number {
    return this.recordsRead;
  }

  /** Patient codes currently staged and unwritten — the records an update could make stale. */
  inFlightCodes(): string[] {
    return this.batch.map((entry) => entry.patient.patientCode);
  }

  // ------------------------------------------------------------------ progress reporting

  getCounters(): EngineCounters {
    return { ...this.counters };
  }

  /** Lets recovery seed the counters it has already accrued before forward processing continues. */
  setCounters(counters: EngineCounters): void {
    this.counters = { ...counters };
  }

  get position(): { partitionIndex: number; recordIndex: number; lastFlushedPosition: number } {
    return {
      partitionIndex: this.partitionIndex,
      recordIndex: this.recordIndex,
      lastFlushedPosition: this.lastFlushedPosition,
    };
  }

  get eligible(): number {
    return this.eligibleRecords;
  }

  isFinished(): boolean {
    return this.finished;
  }

  markPartitionState(partitionIndex: number, state: PartitionState): void {
    this.partitionStates.set(partitionIndex, state);
  }

  getMetrics(): JobMetrics {
    const percentComplete =
      this.eligibleRecords === 0
        ? 0
        : Math.min(100, Math.round((this.counters.processed / this.eligibleRecords) * 1000) / 10);

    return {
      eligibleRecords: this.eligibleRecords,
      processed: this.counters.processed,
      applied: this.counters.applied,
      noopAlreadyCurrent: this.counters.noopAlreadyCurrent,
      conflicts: this.counters.conflicts,
      reevaluated: this.counters.reevaluated,
      protectedUpdates: this.counters.protectedUpdates,
      staleWriteAttemptsBlocked: this.counters.staleBlocked,
      failed: this.counters.failed,
      currentPartition: Math.min(this.partitionIndex, this.deps.partitionCount - 1),
      currentRecordIndex: this.recordIndex,
      percentComplete,
    };
  }

  getPartitionProgress(openConflictsByPartition: Map<number, number> = new Map()): PartitionProgress[] {
    const progress: PartitionProgress[] = [];

    for (let partition = 0; partition < this.deps.partitionCount; partition += 1) {
      const total = this.partitionTotals.get(partition) ?? 0;
      const processed = this.partitionProcessed.get(partition) ?? 0;

      progress.push({
        partitionIndex: partition,
        state: this.partitionStates.get(partition) ?? PARTITION_STATE.PENDING,
        totalRecords: total,
        processedRecords: processed,
        openConflicts: openConflictsByPartition.get(partition) ?? 0,
        percentComplete: total === 0 ? 0 : Math.round((processed / total) * 100),
      });
    }

    return progress;
  }
}
