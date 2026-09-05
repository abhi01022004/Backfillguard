import {
  BACKFILL_MODE,
  DEMO_JOB_ID,
  EVENT_SEVERITY,
  EVENT_TYPE,
  CONSIDERATION_OUTCOME,
  JOB_STATUS,
  PARTITION_STATE,
  type BackfillJobState,
  type JobMetrics,
  type JobStatus,
  type RecoverySummary,
  type SimulationSettings,
} from '@bg/shared';
import type { Clock } from '../../lib/clock';
import type { Rng } from '../../lib/rng';
import { RecoveryFailedError } from '../../lib/errors';
import type { EventSink } from '../ports/EventSink';
import type { JobRepository } from '../ports/JobRepository';
import type { PatientRepository } from '../ports/PatientRepository';
import { BackfillEngine, type EngineCounters } from '../engine/BackfillEngine';
import { CheckpointManager } from '../engine/CheckpointManager';
import { ConflictEngine } from '../engine/ConflictEngine';
import { RecoveryEngine } from '../engine/RecoveryEngine';
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

export interface StartOptions {
  /**
   * Whether to begin the paced background loop.
   *
   * True (the default) for the running application. False when the caller will drive `tickOnce()`
   * itself — tests and the headless scenario runner — so there is exactly one thing advancing the
   * engine at any time.
   */
  autoAdvance?: boolean;
}

export class SimulationOrchestrator {
  private status: JobStatus = JOB_STATUS.IDLE;
  private jobId: string = DEMO_JOB_ID;
  private settings: SimulationSettings;
  private engine: BackfillEngine | null = null;
  private conflictEngine: ConflictEngine;

  private loop: Promise<void> | null = null;
  private participants: TickParticipant[] = [];

  private checkpoints: CheckpointManager;

  /**
   * Event counts carried over from phases the current engine no longer holds.
   *
   * Only the genuinely additive counters live here. Per-record progress is derived from the ledger in
   * `buildMetrics`, precisely so it cannot be double counted when recovery revisits a record the first
   * pass already decided.
   */
  private accumulatedEventCounters = { conflicts: 0, protectedUpdates: 0, staleBlocked: 0 };

  private lastRecoverySummary: RecoverySummary | null = null;

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
    this.checkpoints = new CheckpointManager({
      jobs: deps.jobs,
      events: deps.events,
      interval: this.settings.checkpointInterval,
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
    const metrics = await this.buildMetrics();
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

  /**
   * Builds the reported metrics from persisted evidence rather than from in-memory counters.
   *
   * ## Why this is not just tidiness
   *
   * A run can span two phases — initial processing and recovery — and each phase has its own engine
   * counters. Naively carrying one phase's counters forward under-reports (recovery only counts the
   * records it revisited, so partitions completed before the crash vanish), and naively adding them
   * over-reports (recovery legitimately revisits records the first pass already counted). A live run
   * showed exactly the first failure: 900 of 1000, while the ledger held all 1000.
   *
   * The fix is to stop treating per-record progress as a counter at all. Two different kinds of number
   * are being conflated:
   *
   *  - **Per-record outcomes** (processed, applied, no-op, re-evaluated, failed) are properties of a
   *    *set of records*. They come from the consideration ledger, which is keyed per record and so is
   *    immune to double counting no matter how many phases touch a row.
   *  - **Event counts** (conflicts detected, stale writes blocked, updates protected) are genuinely
   *    additive occurrences — one record can conflict in more than one phase, and each of those is a
   *    real event worth reporting. These accumulate across phases.
   *
   * This also means the dashboard and the verification report read the same source of truth, so they
   * cannot disagree.
   */
  private async buildMetrics(): Promise<JobMetrics> {
    const engineMetrics = this.engine?.getMetrics() ?? {
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

    if (!this.engine) return engineMetrics;

    const ledger = await this.deps.patients.listConsiderations(this.jobId);

    const outcomes = { applied: 0, noop: 0, reevaluated: 0, failed: 0, skipped: 0 };
    for (const entry of ledger) {
      switch (entry.outcome) {
        case CONSIDERATION_OUTCOME.APPLIED:
          outcomes.applied += 1;
          break;
        case CONSIDERATION_OUTCOME.NO_ACTION_ALREADY_CURRENT:
          outcomes.noop += 1;
          break;
        case CONSIDERATION_OUTCOME.REEVALUATED_APPLIED:
          outcomes.reevaluated += 1;
          break;
        case CONSIDERATION_OUTCOME.FAILED:
          outcomes.failed += 1;
          break;
        default:
          outcomes.skipped += 1;
      }
    }

    const eligible = engineMetrics.eligibleRecords;
    const processed = ledger.length;

    // Event counters: this phase's, plus anything accumulated by a previous phase.
    const events = this.accumulatedEventCounters;
    const engineCounters = this.engine.getCounters();

    return {
      eligibleRecords: eligible,
      processed,
      applied: outcomes.applied,
      noopAlreadyCurrent: outcomes.noop,
      reevaluated: outcomes.reevaluated,
      failed: outcomes.failed,
      conflicts: events.conflicts + engineCounters.conflicts,
      protectedUpdates: events.protectedUpdates + engineCounters.protectedUpdates,
      staleWriteAttemptsBlocked: events.staleBlocked + engineCounters.staleBlocked,
      currentPartition: engineMetrics.currentPartition,
      currentRecordIndex: engineMetrics.currentRecordIndex,
      percentComplete:
        eligible === 0 ? 0 : Math.min(100, Math.round((processed / eligible) * 1000) / 10),
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
  async start(
    settingsOverride: Partial<SimulationSettings> = {},
    options: StartOptions = {},
  ): Promise<void> {
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
    this.accumulatedEventCounters = { conflicts: 0, protectedUpdates: 0, staleBlocked: 0 };
    this.lastRecoverySummary = null;

    this.checkpoints = new CheckpointManager({
      jobs: this.deps.jobs,
      events: this.deps.events,
      interval: this.settings.checkpointInterval,
    });

    await this.setStatus(next);

    /**
     * Only the paced loop is optional, never the state transition.
     *
     * Tests and the headless scenario runner drive `tickOnce()` themselves, and must not also have a
     * background loop advancing the same engine — two drivers on one engine would double-step records
     * and make ordering unpredictable. A manual clock cannot resolve `sleep()` anyway, so a paced loop
     * would simply hang and then deadlock anything that awaits it.
     */
    if (options.autoAdvance ?? true) this.startLoop();
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
   * Offers a checkpoint after a flush.
   *
   * Only ever called from the post-flush path, and the position handed over is the last *flushed*
   * record. The manager asserts that too, so the invariant is enforced at both ends (R7.2a).
   */
  private async maybeCheckpoint(): Promise<void> {
    if (!this.engine) return;

    const metrics = this.engine.getMetrics();
    const position = this.engine.position;

    await this.checkpoints.maybeRecord(this.jobId, this.status, {
      partitionIndex: position.partitionIndex,
      lastFlushedPosition: position.lastFlushedPosition,
      processedCount: metrics.processed,
    });
  }

  // ------------------------------------------------------------------ failure injection

  /**
   * Crashes the job, freezing the unflushed batch durably (R8.3–R8.5).
   *
   * Two properties are essential and both are asserted by tests. No patient row is touched, so every
   * already-committed derived value survives byte for byte. And the in-flight batch — results computed
   * but not yet written — is staged to `PendingResult`, which is what carries staleness across the
   * interruption and gives recovery something genuinely dangerous to reason about.
   */
  async crash(): Promise<void> {
    const next = transition(JOB_ACTION.CRASH, this.status);

    // Stop the loop first, so nothing advances while state is being captured.
    this.status = next;
    await this.awaitLoopStop();

    const staged = this.engine?.takeInFlightBatch() ?? [];
    if (staged.length > 0) {
      await this.deps.patients.stagePendingResults(staged);
    }

    this.crashedAt = this.deps.clock.nowIso();
    await this.setStatus(next, { crashedAt: this.crashedAt });
    await this.persistCounters();

    const metrics = this.engine?.getMetrics();

    this.deps.events.emit({
      type: EVENT_TYPE.BACKFILL_CRASHED,
      severity: EVENT_SEVERITY.CRITICAL,
      jobId: this.jobId,
      partitionIndex: this.engine?.position.partitionIndex,
      message:
        `BACKFILL CRASHED after ${metrics?.processed ?? 0} records. ` +
        `${staged.length} computed result(s) were staged but never written — they are now stale ` +
        `candidates that recovery must revalidate. Committed data is untouched.`,
      payload: {
        processed: metrics?.processed ?? 0,
        stagedResultCount: staged.length,
        stagedPatientIds: staged.map((entry) => entry.patientId),
        position: this.engine?.position ?? {},
      },
    });

    await this.deps.events.flush();
  }

  /** Destroys every checkpoint for the job (R7.4). */
  async loseCheckpoint(): Promise<void> {
    await this.checkpoints.lose(this.jobId);
  }

  async getCheckpoint() {
    return {
      active: await this.checkpoints.getResumeCursor(this.jobId),
      lastKnown: await this.checkpoints.getLastKnown(this.jobId),
      created: this.checkpoints.created,
    };
  }

  // ------------------------------------------------------------------ recovery

  /**
   * Resumes after a crash using data evidence rather than a cursor (R9).
   *
   * Note what is deliberately absent: this never consults a checkpoint. Whether one survives is
   * irrelevant to correctness, which is the claim the demo makes by destroying it first.
   */
  async recover(): Promise<RecoverySummary> {
    const next = transition(JOB_ACTION.RECOVER, this.status);
    await this.setStatus(next);

    if (!this.engine) {
      throw new RecoveryFailedError(
        'no engine state to recover; start a backfill before attempting recovery',
        { jobId: this.jobId },
      );
    }

    try {
      const recovery = new RecoveryEngine({
        repository: this.deps.patients,
        events: this.deps.events,
        conflicts: this.conflictEngine,
        jobId: this.jobId,
        partitionCount: this.settings.partitionCount,
        phase: 'RECOVERY',
      });

      const plan = await recovery.computePlan();

      // Mark the range as recovering so the partition grid shows it (R15.4).
      for (let partition = plan.recoveryStartPartition; partition < this.settings.partitionCount; partition += 1) {
        this.engine.markPartitionState(partition, PARTITION_STATE.RECOVERING);
      }

      const summary = await recovery.recover(plan);
      recovery.emitCompleted();

      this.lastRecoverySummary = summary;
      this.recoveredAt = this.deps.clock.nowIso();

      /**
       * Recovery revisits everything from the boundary to the end of the dataset, so once it finishes
       * there is no forward work left.
       *
       * Its *event* counts are folded into the accumulated totals (a conflict during recovery is a real
       * additional conflict). Its per-record progress is deliberately not carried anywhere: that comes
       * from the ledger, which already reflects every decision both phases made.
       */
      const recoveryCounters = recovery.getCounters();
      const preRecovery = this.engine.getCounters();

      this.accumulatedEventCounters = {
        conflicts: preRecovery.conflicts + recoveryCounters.conflicts,
        protectedUpdates: preRecovery.protectedUpdates + recoveryCounters.protectedUpdates,
        staleBlocked: preRecovery.staleBlocked + recoveryCounters.staleBlocked,
      };

      // Zero the engine's own counters so they are not added a second time in buildMetrics.
      this.engine.setCounters({
        processed: 0,
        applied: 0,
        noopAlreadyCurrent: 0,
        conflicts: 0,
        reevaluated: 0,
        protectedUpdates: 0,
        staleBlocked: 0,
        failed: 0,
      });

      for (let partition = plan.recoveryStartPartition; partition < this.settings.partitionCount; partition += 1) {
        this.engine.markPartitionState(partition, PARTITION_STATE.COMPLETED);
      }

      await this.deps.jobs.setStatus(this.jobId, next, { recoveredAt: this.recoveredAt });
      await this.persistCounters();
      await this.complete();

      return summary;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.failureReason = reason;

      await this.setStatus(transition(JOB_ACTION.FAIL, this.status), { failureReason: reason });

      this.deps.events.emit({
        type: EVENT_TYPE.RECORD_FAILED,
        severity: EVENT_SEVERITY.CRITICAL,
        jobId: this.jobId,
        message: `Recovery failed: ${reason}`,
        payload: { reason },
      });

      throw error instanceof RecoveryFailedError ? error : new RecoveryFailedError(reason);
    }
  }

  getLastRecoverySummary(): RecoverySummary | null {
    return this.lastRecoverySummary;
  }

  /**
   * Persists the same numbers the API reports.
   *
   * Deliberately goes through `buildMetrics` rather than reading engine counters directly, so the
   * stored job row, the dashboard and the verification report can never disagree about a run.
   */
  private async persistCounters(): Promise<void> {
    if (!this.engine) return;

    const metrics = await this.buildMetrics();

    await this.deps.jobs.saveCounters(this.jobId, {
      processed: metrics.processed,
      applied: metrics.applied,
      noopAlreadyCurrent: metrics.noopAlreadyCurrent,
      conflicts: metrics.conflicts,
      reevaluated: metrics.reevaluated,
      protectedUpdates: metrics.protectedUpdates,
      staleBlocked: metrics.staleWriteAttemptsBlocked,
      failed: metrics.failed,
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

    const metrics = await this.buildMetrics();

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
