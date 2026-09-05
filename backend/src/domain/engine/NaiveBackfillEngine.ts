import {
  BACKFILL_STATUS,
  CONSIDERATION_OUTCOME,
  EVENT_SEVERITY,
  EVENT_TYPE,
  PENDING_RESULT_STATE,
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
import { snapshotOf } from './ConflictEngine';

/**
 * A deliberately unsafe backfill, for comparison only (R12.1).
 *
 * ## Why this exists
 *
 * "Stale overwrites = 0" is unconvincing on its own — a backfill that never wrote anything would score
 * the same. The claim only means something if the guard is *load-bearing*, and the way to show that is
 * to remove it and watch the same scenario fail.
 *
 * ## It differs in exactly three ways
 *
 * Everything else — reading partition by partition, capturing a source version, computing the score with
 * the same pure function, staging into a bounded batch — is identical. The comparison isolates the guard
 * rather than pitting two unrelated programs against each other.
 *
 *  1. **No version predicate on the write.** It writes whatever it computed, whenever it gets round to it.
 *  2. **Whole-row write-back from the stale snapshot.** This is what a backfill built on "load entity,
 *     mutate, save entity" does, and it is what actually destroys clinical data: values that changed
 *     after the read are silently reverted.
 *  3. **No revalidation of staged results on resume.** After a crash it flushes the frozen batch verbatim,
 *     which is exactly where the guarded engine stops to check.
 *
 * ## Isolation
 *
 * This class can only ever be constructed by the comparison harness, which always hands it an in-memory
 * repository. It has no path to the demo dataset — that is structural, not a rule someone has to
 * remember (R12.7).
 *
 * The most instructive part of the result is *not* an obvious explosion. The naive run usually ends up
 * internally consistent: it reverts a lab value, then re-reads and rescores from the reverted value, so
 * the stored score matches the stored data perfectly. Nothing looks broken. The clinical reading is
 * simply gone.
 */

export interface NaiveBackfillEngineDeps {
  repository: PatientRepository;
  events: EventSink;
  jobId: string;
  partitionCount: number;
  batchSize: number;
}

interface NaiveStaged {
  patient: Patient;
  sourceVersion: number;
  snapshot: ClinicalSnapshot;
  score: number;
  level: RiskLevel;
}

export interface NaiveCounters {
  processed: number;
  applied: number;
  /** Staged results flushed after the crash with no version check at all. */
  blindFlushes: number;
  failed: number;
}

export class NaiveBackfillEngine {
  private counters: NaiveCounters = { processed: 0, applied: 0, blindFlushes: 0, failed: 0 };

  private batch: NaiveStaged[] = [];
  private partitionIndex = 0;
  private recordIndex = 0;
  private partitionRecords: Patient[] = [];
  private partitionLoaded = false;
  private recordsRead = 0;
  private finished = false;

  constructor(private readonly deps: NaiveBackfillEngineDeps) {}

  async begin(): Promise<void> {
    this.counters = { processed: 0, applied: 0, blindFlushes: 0, failed: 0 };
    this.batch = [];
    this.partitionIndex = 0;
    this.recordIndex = 0;
    this.partitionLoaded = false;
    this.recordsRead = 0;
    this.finished = false;

    this.deps.events.emit({
      type: EVENT_TYPE.BACKFILL_STARTED,
      jobId: this.deps.jobId,
      message: 'Naive backfill started (no version guard).',
    });
  }

  // ------------------------------------------------------------------ identical to the guarded engine

  async step(): Promise<boolean> {
    if (this.finished) return false;

    if (this.partitionIndex >= this.deps.partitionCount) {
      if (this.batch.length > 0) await this.flush();
      this.finished = true;
      return false;
    }

    if (!this.partitionLoaded) {
      this.partitionRecords = await this.deps.repository.findByPartition(this.partitionIndex);
      this.partitionLoaded = true;
    }

    if (this.recordIndex >= this.partitionRecords.length) {
      if (this.batch.length > 0) await this.flush();
      this.partitionIndex += 1;
      this.recordIndex = 0;
      this.partitionLoaded = false;
      return this.partitionIndex < this.deps.partitionCount;
    }

    const patient = this.partitionRecords[this.recordIndex]!;
    this.recordIndex += 1;

    // Read, capture the version, compute — all exactly as the guarded engine does.
    const fresh = (await this.deps.repository.findById(patient.id)) ?? patient;
    const snapshot = snapshotOf(fresh);
    const result = calculateRiskScore(toRiskInput(snapshot));

    this.batch.push({
      patient: fresh,
      sourceVersion: fresh.version,
      snapshot,
      score: result.score,
      level: result.level,
    });
    this.recordsRead += 1;

    if (this.batch.length >= this.deps.batchSize) await this.flush();

    return true;
  }

  // ------------------------------------------------------------------ difference 1 and 2

  /**
   * Writes every staged result with no version predicate, reverting the whole row from the snapshot.
   *
   * The guarded engine's equivalent method asks the database "is this row still at version N?" and
   * accepts the answer. This one does not ask.
   */
  async flush(): Promise<void> {
    if (this.batch.length === 0) return;

    const entries = this.batch;
    this.batch = [];

    for (const entry of entries) {
      await this.writeBlind(entry, 'INITIAL');
    }
  }

  private async writeBlind(entry: NaiveStaged, phase: string): Promise<void> {
    try {
      await this.deps.repository.applyUnguardedWholeRow(
        entry.patient.id,
        entry.snapshot,
        {
          riskScore: entry.score,
          riskLevel: entry.level,
          backfillStatus: BACKFILL_STATUS.COMPLETED,
        },
        entry.sourceVersion,
        { jobId: this.deps.jobId, phase, scoreWritten: entry.score },
      );

      await this.deps.repository.recordConsideration({
        jobId: this.deps.jobId,
        patientId: entry.patient.id,
        outcome: CONSIDERATION_OUTCOME.APPLIED,
        sourceVersion: entry.sourceVersion,
        appliedVersion: entry.sourceVersion,
        attempts: 1,
        phase,
        reason: null,
      });

      this.counters.applied += 1;
      this.counters.processed += 1;
    } catch (error) {
      this.counters.failed += 1;
      this.counters.processed += 1;

      await this.deps.repository.recordConsideration({
        jobId: this.deps.jobId,
        patientId: entry.patient.id,
        outcome: CONSIDERATION_OUTCOME.FAILED,
        sourceVersion: entry.sourceVersion,
        appliedVersion: null,
        attempts: 1,
        phase,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ------------------------------------------------------------------ crash

  /** Freezes the unflushed batch, exactly as the guarded engine does. */
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

  inFlightCodes(): string[] {
    return this.batch.map((entry) => entry.patient.patientCode);
  }

  get readCount(): number {
    return this.recordsRead;
  }

  // ------------------------------------------------------------------ difference 3

  /**
   * Resumes after a crash by flushing the frozen batch verbatim, then reprocessing from the start.
   *
   * Two naive behaviours, both common in the wild:
   *
   *  - The staged results are written without asking whether the rows still match. This is where clinical
   *    data is lost, because each write reverts the whole row to the snapshot taken before the outage.
   *  - With no checkpoint, it simply starts over from partition 0. Wasteful, but it does mean the naive
   *    run reaches full coverage — which is deliberate here: it keeps the comparison focused on *safety*
   *    rather than letting the naive engine also lose on liveness and muddy the point.
   */
  async resumeAfterCrash(): Promise<void> {
    const staged = await this.deps.repository.pendingResults(
      this.deps.jobId,
      PENDING_RESULT_STATE.PENDING,
    );

    this.deps.events.emit({
      type: EVENT_TYPE.RECOVERY_STARTED,
      severity: EVENT_SEVERITY.WARNING,
      jobId: this.deps.jobId,
      message:
        `Naive recovery: flushing ${staged.length} staged result(s) without revalidation, ` +
        `then reprocessing from partition 0.`,
      payload: { stagedResultCount: staged.length },
    });

    for (const entry of staged) {
      const patient = await this.deps.repository.findById(entry.patientId);
      if (!patient) continue;

      await this.writeBlind(
        {
          patient,
          sourceVersion: entry.sourceVersion,
          snapshot: entry.inputSnapshot,
          score: entry.computedScore,
          level: entry.computedLevel,
        },
        'RECOVERY',
      );

      await this.deps.repository.setPendingResultState(entry.id, PENDING_RESULT_STATE.FLUSHED);
      this.counters.blindFlushes += 1;
    }

    // No cursor survived, so start over. A naive engine has nothing better to go on.
    this.partitionIndex = 0;
    this.recordIndex = 0;
    this.partitionLoaded = false;
    this.finished = false;
  }

  emitCompleted(): void {
    this.deps.events.emit({
      type: EVENT_TYPE.BACKFILL_COMPLETED,
      jobId: this.deps.jobId,
      message:
        `Naive backfill finished: ${this.counters.applied} write(s) applied, ` +
        `${this.counters.blindFlushes} staged result(s) flushed without any version check.`,
      payload: { ...this.counters },
    });
  }

  getCounters(): NaiveCounters {
    return { ...this.counters };
  }

  isFinished(): boolean {
    return this.finished;
  }
}
