import {
  BACKFILL_MODE,
  DEMO_JOB_ID,
  EVENT_SEVERITY,
  EVENT_TYPE,
  JOB_STATUS,
  type BackfillJobState,
  type JobStatus,
  type SimulationSettings,
} from '@bg/shared';
import type { Clock } from '../../lib/clock';
import type { Rng } from '../../lib/rng';
import type { EventSink } from '../ports/EventSink';
import type { JobRepository } from '../ports/JobRepository';
import type { PatientRepository } from '../ports/PatientRepository';
import { BackfillEngine } from '../engine/BackfillEngine';
import { ConflictEngine } from '../engine/ConflictEngine';
import {
  JOB_ACTION,
  isActivelyProcessing,
  isDatasetLocked,
  transition,
} from '../engine/jobStateMachine';

/**
 * Owns the simulation's single thread of execution (R4.9, R18.3).
 *
 * ## Why one loop
 *
 * This is the mechanism that makes the demo reproducible, and it is worth being precise about the
 * failure it prevents. If the backfill advanced on its own timer while an online-update simulator ran
 * on a second timer, the interleaving of the two would depend on event-loop scheduling — so the set of
 * records that conflict would differ between runs, and between machines. The demo would produce
 * different conflict counts every time, and R18.5 would be unsatisfiable.
 *
 * So every mutation is dispatched from inside `tick()`, in a fixed order, and nothing else in the
 * domain owns a timer. The `Clock` port provides pacing only: `backfillSpeed` changes how long a run
 * takes in wall-clock terms but never the order in which anything happens. Scenario steps and
 * automatic online updates trigger on *processed-record counts*, not elapsed time.
 *
 * A guard test enforces the other half of this by failing the build if `setTimeout` appears anywhere
 * in `src/domain`.
 */

/** Hook the online-update simulator registers (task 6) and the scenario manager extends (task 19). */
export interface TickParticipant {
  /** Called before the engine advances, so an update can land between two records deterministically. */
  beforeStep?(context: TickContext): Promise<void>;
  /** Called after the engine advances and any flush has completed. */
  afterStep?(context: TickContext): Promise<void>;
}

export interface TickContext {
  jobId: string;
  status: JobStatus;
  /** Records with a terminal decision. Only advances when a batch is flushed. */
  processed: number;
  /**
   * Records read into a batch, whether or not they have been written yet.
   *
   * This is the counter scenario steps should key off. The window between `recordsRead` and
   * `processed` is the in-flight window — the only interval in which an online update can make a
   * computed result stale. Keying an update to `processed` would always inject it *after* the write
   * had landed, producing no conflict.
   */
  recordsRead: number;
  /** Patient codes currently staged and unwritten. */
  inFlightCodes: string[];
  partitionIndex: number;
  /** True when the step just completed ended in a flush — the only safe point to checkpoint. */
  flushed: boolean;
}

export interface OrchestratorDeps {
  patients: PatientRepository;
  jobs: JobRepository;
  events: EventSink;
  clock: Clock;
  rng: Rng;
  settings: SimulationSettings;
  seed: number;
}

export class SimulationOrchestrator {
  private status: JobStatus = JOB_STATUS.IDLE;
  private jobId: string = DEMO_JOB_ID;
  private settings: SimulationSettings;
  private engine: BackfillEngine | null = null;
  private conflictEngine: ConflictEngine;

  private loop: Promise<void> | null = null;
  private participants: TickParticipant[] = [];

  /** Processed count at which the next checkpoint is due. */
  private nextCheckpointAt = 0;

  private startedAt: string | null = null;
  private completedAt: string | null = null;
  private crashedAt: string | null = null;
  private recoveredAt: string | null = null;
  private failureReason: string | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.settings = { ...deps.settings };
    this.conflictEngine = new ConflictEngine({
      repository: deps.patients,
      events: deps.events,
      maxAttempts: this.settings.maxReevaluationAttempts,
    });
  }

  // ------------------------------------------------------------------ registration

  register(participant: TickParticipant): void {
    this.participants.push(participant);
  }

  clearParticipants(): void {
    this.participants = [];
  }

  // ------------------------------------------------------------------ queries

  getStatus(): JobStatus {
    return this.status;
  }

  isRunning(): boolean {
    return isActivelyProcessing(this.status);
  }

  isDatasetLocked(): boolean {
    return isDatasetLocked(this.status);
  }

  getSettings(): SimulationSettings {
    return { ...this.settings };
  }

  async getState(): Promise<BackfillJobState> {
    const openConflicts = await this.openConflictsByPartition();

    const metrics = this.engine?.getMetrics() ?? {
      eligibleRecords: 0,
      processed: 0,
      applied: 0,
      noopAlreadyCurrent: 0,
      conflicts: 0,
      reevaluated: 0,
      protectedUpdates: 0,
      staleWriteAttemptsBlocked: 0,
      failed: 0,
      currentPartition: 0,
      currentRecordIndex: 0,
      percentComplete: 0,
    };

    const staged = await this.deps.patients.pendingResults(this.jobId, 'PENDING');

    return {
      jobId: this.jobId,
      status: this.status,
      mode: BACKFILL_MODE.GUARDED,
      seed: this.deps.seed,
      settings: this.getSettings(),
      metrics,
      partitions: this.engine?.getPartitionProgress(openConflicts) ?? [],
      pendingResultCount: staged.length,
      checkpoint: await this.deps.jobs.lastKnownCheckpoint(this.jobId),
      startedAt: this.startedAt,
      crashedAt: this.crashedAt,
      recoveredAt: this.recoveredAt,
      completedAt: this.completedAt,
      failureReason: this.failureReason,
    };
  }

  private async openConflictsByPartition(): Promise<Map<number, number>> {
    const conflicts = await this.deps.patients.listConflicts(this.jobId);
    const byPartition = new Map<number, number>();

    for (const conflict of conflicts) {
      if (conflict.resolution !== 'PENDING') continue;
      const patient = await this.deps.patients.findById(conflict.patientId);
      if (!patient) continue;
      byPartition.set(patient.partitionIndex, (byPartition.get(patient.partitionIndex) ?? 0) + 1);
    }

    return byPartition;
  }

  // ------------------------------------------------------------------ controls

  /**
   * Starts a fresh backfill.
   *
   * Applies any settings override before the eligible set is loaded, so the run's configuration is
   * fixed for its whole lifetime — changing batch size or partition count mid-run would invalidate the
   * engine's position and any checkpoint taken from it.
   */
  async start(settingsOverride: Partial<SimulationSettings> = {}): Promise<void> {
    const next = transition(JOB_ACTION.START, this.status);

    this.settings = { ...this.settings, ...settingsOverride };
    this.conflictEngine = new ConflictEngine({
      repository: this.deps.patients,
      events: this.deps.events,
      maxAttempts: this.settings.maxReevaluationAttempts,
    });

    const eligibleRecords = await this.deps.patients.countAll();

    if (eligibleRecords === 0) {
      throw new Error(
        'No patients to backfill. Seed the dataset first (npm run db:seed).',
      );
    }

    await this.deps.jobs.create({
      jobId: this.jobId,
      mode: BACKFILL_MODE.GUARDED,
      seed: this.deps.seed,
      settings: this.settings,
      totalRecords: eligibleRecords,
      partitionCount: this.settings.partitionCount,
      eligibleRecords,
    });

    this.engine = new BackfillEngine({
      repository: this.deps.patients,
      events: this.deps.events,
      conflicts: this.conflictEngine,
      jobId: this.jobId,
      partitionCount: this.settings.partitionCount,
      batchSize: this.settings.batchSize,
      phase: 'INITIAL',
    });

    await this.engine.begin();

    this.startedAt = this.deps.clock.nowIso();
    this.completedAt = null;
    this.crashedAt = null;
    this.recoveredAt = null;
    this.failureReason = null;
    this.nextCheckpointAt = this.settings.checkpointInterval;

    await this.setStatus(next);
    this.startLoop();
  }

  async pause(): Promise<void> {
    const next = transition(JOB_ACTION.PAUSE, this.status);
    await this.setStatus(next);

    this.deps.events.emit({
      type: EVENT_TYPE.BACKFILL_PAUSED,
      severity: EVENT_SEVERITY.WARNING,
      jobId: this.jobId,
      message: `Backfill paused at ${this.engine?.getMetrics().processed ?? 0} records.`,
      payload: this.engine?.position ?? {},
    });

    await this.awaitLoopStop();
  }

  async resume(): Promise<void> {
    const next = transition(JOB_ACTION.RESUME, this.status);
    await this.setStatus(next);

    this.deps.events.emit({
      type: EVENT_TYPE.BACKFILL_RESUMED,
      severity: EVENT_SEVERITY.INFO,
      jobId: this.jobId,
      message: 'Backfill resumed.',
      payload: this.engine?.position ?? {},
    });

    this.startLoop();
  }

  // ------------------------------------------------------------------ the tick loop

  /**
   * Starts the pacing loop if it is not already running.
   *
   * Guarded against double-start, because two concurrent loops would interleave ticks and destroy the
   * ordering guarantee the whole design depends on.
   */
  private startLoop(): void {
    if (this.loop) return;
    this.loop = this.runLoop().finally(() => {
      this.loop = null;
    });
  }

  private async runLoop(): Promise<void> {
    const delayMs = Math.max(0, Math.round(1000 / Math.max(1, this.settings.backfillSpeed)));

    while (isActivelyProcessing(this.status)) {
      const hasMore = await this.tickOnce();

      if (!hasMore) {
        await this.complete();
        return;
      }

      // Pacing only. Delay affects wall-clock duration, never ordering or results.
      await this.deps.clock.sleep(delayMs);
    }
  }

  private async awaitLoopStop(): Promise<void> {
    if (this.loop) await this.loop;
  }

  /**
   * Advances the simulation by exactly one record.
   *
   * Exposed so tests can drive the simulation synchronously with no timers at all, and so the scripted
   * demo can advance deterministically. Returns false when there is no work left.
   */
  async tickOnce(): Promise<boolean> {
    if (!this.engine) return false;
    if (!isActivelyProcessing(this.status)) return false;

    const beforeContext: TickContext = {
      jobId: this.jobId,
      status: this.status,
      processed: this.engine.getMetrics().processed,
      recordsRead: this.engine.readCount,
      inFlightCodes: this.engine.inFlightCodes(),
      partitionIndex: this.engine.position.partitionIndex,
      flushed: false,
    };

    // Participants run before the engine advances, so an injected online update lands at a precise,
    // reproducible point in the record sequence rather than wherever a timer happened to fire.
    for (const participant of this.participants) {
      await participant.beforeStep?.(beforeContext);
    }

    // Status can change inside a participant (the scripted demo crashes the job this way).
    if (!isActivelyProcessing(this.status)) return true;

    const step = await this.engine.step();

    const afterContext: TickContext = {
      jobId: this.jobId,
      status: this.status,
      processed: this.engine.getMetrics().processed,
      recordsRead: this.engine.readCount,
      inFlightCodes: this.engine.inFlightCodes(),
      partitionIndex: this.engine.position.partitionIndex,
      flushed: step.flushed,
    };

    if (step.flushed) {
      await this.maybeCheckpoint();
      await this.persistCounters();
    }

    for (const participant of this.participants) {
      await participant.afterStep?.(afterContext);
    }

    return step.hasMoreWork;
  }

  /**
   * Creates a checkpoint when enough records have been processed.
   *
   * Called only from the post-flush path, and the recorded position is the last *flushed* record. A
   * checkpoint that advertised unflushed progress would cause a resume to skip records that were never
   * written, silently breaking coverage while appearing to succeed (R7.2a).
   */
  private async maybeCheckpoint(): Promise<void> {
    if (!this.engine) return;

    const metrics = this.engine.getMetrics();
    if (metrics.processed < this.nextCheckpointAt) return;

    const position = this.engine.position;

    const checkpoint = await this.deps.jobs.createCheckpoint({
      jobId: this.jobId,
      partitionIndex: position.partitionIndex,
      recordPosition: Math.max(0, position.lastFlushedPosition),
      processedCount: metrics.processed,
      jobStatus: this.status,
    });

    this.nextCheckpointAt = metrics.processed + this.settings.checkpointInterval;

    this.deps.events.emit({
      type: EVENT_TYPE.CHECKPOINT_CREATED,
      severity: EVENT_SEVERITY.INFO,
      jobId: this.jobId,
      partitionIndex: checkpoint.partitionIndex,
      message:
        `Checkpoint at ${metrics.processed} records ` +
        `(partition ${checkpoint.partitionIndex}, record ${checkpoint.recordPosition}).`,
      payload: {
        checkpointId: checkpoint.id,
        processedCount: checkpoint.processedCount,
        partitionIndex: checkpoint.partitionIndex,
        recordPosition: checkpoint.recordPosition,
      },
    });
  }

  private async persistCounters(): Promise<void> {
    if (!this.engine) return;

    const metrics = this.engine.getMetrics();
    const counters = this.engine.getCounters();

    await this.deps.jobs.saveCounters(this.jobId, {
      processed: counters.processed,
      applied: counters.applied,
      noopAlreadyCurrent: counters.noopAlreadyCurrent,
      conflicts: counters.conflicts,
      reevaluated: counters.reevaluated,
      protectedUpdates: counters.protectedUpdates,
      staleBlocked: counters.staleBlocked,
      failed: counters.failed,
      currentPartition: metrics.currentPartition,
      currentRecordIndex: metrics.currentRecordIndex,
    });
  }

  // ------------------------------------------------------------------ completion

  /**
   * Finishes the run, but only if every eligible record has a terminal ledger entry (R4.8).
   *
   * This refusal is the liveness half of the central guarantee made mechanical: the job physically
   * cannot report success while a record is unaccounted for. Anything missing fails the job with the
   * codes listed, rather than completing quietly and leaving verification to discover the gap.
   */
  private async complete(): Promise<void> {
    if (!this.engine) return;

    await this.engine.flush();
    await this.persistCounters();

    const eligible = await this.deps.patients.allIds();
    const considered = new Set(await this.deps.patients.consideredPatientIds(this.jobId));
    const missing = eligible.filter((id) => !considered.has(id));

    if (missing.length > 0) {
      const codes: string[] = [];
      for (const id of missing.slice(0, 10)) {
        const patient = await this.deps.patients.findById(id);
        if (patient) codes.push(patient.patientCode);
      }

      this.failureReason =
        `${missing.length} eligible record(s) reached the end of the run without a terminal ` +
        `decision (${codes.join(', ')}${missing.length > codes.length ? ', …' : ''}).`;

      await this.setStatus(transition(JOB_ACTION.FAIL, this.status), {
        failureReason: this.failureReason,
      });

      this.deps.events.emit({
        type: EVENT_TYPE.RECORD_FAILED,
        severity: EVENT_SEVERITY.CRITICAL,
        jobId: this.jobId,
        message: this.failureReason,
        payload: { missingCount: missing.length, sampleCodes: codes },
      });

      await this.deps.events.flush();
      return;
    }

    this.completedAt = this.deps.clock.nowIso();
    await this.setStatus(transition(JOB_ACTION.COMPLETE, this.status), {
      completedAt: this.completedAt,
    });

    const metrics = this.engine.getMetrics();

    this.deps.events.emit({
      type: EVENT_TYPE.BACKFILL_COMPLETED,
      severity: EVENT_SEVERITY.SUCCESS,
      jobId: this.jobId,
      message:
        `Backfill complete: ${metrics.processed}/${metrics.eligibleRecords} records considered, ` +
        `${metrics.conflicts} conflict(s), ${metrics.reevaluated} re-evaluated, ` +
        `${metrics.staleWriteAttemptsBlocked} stale write(s) blocked.`,
      payload: { ...metrics },
    });

    await this.deps.events.flush();
  }

  // ------------------------------------------------------------------ helpers

  private async setStatus(
    status: JobStatus,
    timestamps: Parameters<JobRepository['setStatus']>[2] = {},
  ): Promise<void> {
    this.status = status;
    const existing = await this.deps.jobs.find(this.jobId);
    if (existing) await this.deps.jobs.setStatus(this.jobId, status, timestamps);
  }

  /**
   * Drives the simulation to completion with no pacing.
   *
   * For tests and for the headless scenario run. The tick cap is a safety net: an engine bug that
   * failed to make progress would otherwise hang the suite instead of failing it.
   */
  async runToCompletion(maxTicks = 200_000): Promise<void> {
    let ticks = 0;

    while (isActivelyProcessing(this.status)) {
      if (ticks >= maxTicks) {
        throw new Error(
          `runToCompletion exceeded ${maxTicks} ticks without finishing — the engine is not ` +
            `making progress.`,
        );
      }
      ticks += 1;

      const hasMore = await this.tickOnce();
      if (!hasMore) {
        await this.complete();
        return;
      }
    }
  }

  /** Exposed for the engine-level assertions in tests and for recovery to hand over position. */
  getEngine(): BackfillEngine | null {
    return this.engine;
  }
}
