import {
  EVENT_SEVERITY,
  EVENT_TYPE,
  JOB_STATUS,
  UPDATE_SOURCE,
  type ActorType,
  type Patient,
  type ScenarioState,
  type ScenarioStepState,
} from '@bg/shared';
import type { Clock } from '../../lib/clock';
import { ScenarioFailedError } from '../../lib/errors';
import type { EventSink } from '../ports/EventSink';
import type { PatientRepository } from '../ports/PatientRepository';
import type { OnlineUpdateSimulator } from '../online/OnlineUpdateSimulator';
import type {
  SimulationOrchestrator,
  TickContext,
  TickParticipant,
} from '../orchestrator/SimulationOrchestrator';
import {
  DEMO_ACTION,
  DEMO_SCRIPT,
  DEMO_STEP_DWELL_MS,
  DEMO_TRIGGER,
  findLevelCrossingChange,
  resolveDemoPlan,
  type DemoScript,
  type DemoStep,
  type DemoTrigger,
} from './demoScript';

/**
 * Runs the scripted demo end to end (R18).
 *
 * ## Why this owns the tick loop
 *
 * The manager drives `tickOnce()` itself rather than letting `start()` spin up the orchestrator's own
 * background loop. Two reasons, and the first is a hard constraint rather than a preference:
 *
 *  1. The crash step fires from inside a tick participant. If the orchestrator's background loop were
 *     running, `crash()` would await the very loop it is executing inside, and the demo would hang
 *     forever at its most important moment.
 *  2. Post-crash steps — destroy the checkpoint, recover, verify — happen while nothing is ticking. A
 *     single driver that can see the whole sequence is far easier to reason about than a participant
 *     trying to resume a loop it does not own.
 *
 * ## What "deterministic" means here
 *
 * Same seed, same dataset, same run: identical conflicts on identical patients. Pacing is the only thing
 * `backfillSpeed` changes. Every step trigger is a record count, and the one place a value is chosen at
 * runtime — which patient to update, and to what — is a deterministic search over the in-flight batch
 * rather than a random draw.
 */

export interface ScenarioManagerDeps {
  orchestrator: SimulationOrchestrator;
  simulator: OnlineUpdateSimulator;
  repository: PatientRepository;
  events: EventSink;
  clock: Clock;
  /**
   * Restores the dataset to its generated baseline before a run.
   *
   * Injected as a callback rather than called directly, because regenerating patients is an infrastructure
   * concern and the domain must not import the generator. Optional: without it the demo still runs correctly,
   * it simply is not a byte-for-byte replay of the previous one.
   */
  prepareDataset?: () => Promise<void>;
  /**
   * Milliseconds to hold each post-crash step so a viewer can read it.
   *
   * ## Why a deliberate pause exists at all
   *
   * The outage steps — crash, clinical update, destroy checkpoint, recover — used to fire back to back with no
   * gap. Correct, and unwatchable: a live measurement found the `CRASHED` state lasted under 250 ms, so the
   * dashboard panel that explains what a crash means was on screen for about a fifth of a second. The most
   * dramatic moment of the demo was effectively invisible.
   *
   * This is pacing, not sequencing. It changes how long the demo takes in wall-clock terms and nothing about
   * the order in which anything happens, so the run stays reproducible — exactly the same distinction
   * `backfillSpeed` already relies on. Zero in tests, where nobody is watching and a manual clock cannot
   * resolve a sleep.
   */
  stepDwellMs?: number;
  /**
   * Milliseconds to wait between ticks. Defaults to the script's speed.
   *
   * Zero drives the run as fast as it will go, which is what the test suite uses: a manual clock has
   * nothing to resolve a `sleep()` with, so any positive delay would hang rather than run quickly.
   * Pacing changes how long the demo takes, never what it does.
   */
  tickDelayMs?: number;
}

interface StepRuntime {
  step: DemoStep;
  status: ScenarioStepState['status'];
  /** The step's fraction resolved against this run's record count. Zero for non-count triggers. */
  atRecordsRead: number;
}

export class ScenarioManager implements TickParticipant {
  private script: DemoScript = DEMO_SCRIPT;
  private steps: StepRuntime[] = [];

  private running = false;
  private aborted = false;

  private startedAt: string | null = null;
  private completedAt: string | null = null;
  private abortedAt: string | null = null;

  /**
   * Codes staged at crash time, captured before recovery can consume them.
   *
   * Read from the `PendingResult` table rather than from engine memory, because the outage updates must
   * target records whose staleness is *durable*. A record whose result only ever existed in a dead
   * process's heap is not evidence of anything.
   */
  private stagedCodesAtCrash: string[] = [];

  private readonly tickDelayMs: number;
  private readonly stepDwellMs: number;

  constructor(private readonly deps: ScenarioManagerDeps) {
    this.tickDelayMs =
      deps.tickDelayMs ?? Math.max(1, Math.round(1000 / this.script.settings.backfillSpeed));
    this.stepDwellMs = deps.stepDwellMs ?? DEMO_STEP_DWELL_MS;

    // Thresholds are placeholders until a run resolves them against the real record count; the step
    // list is published before then so the UI can show what the demo will do.
    this.steps = this.buildSteps(0);
  }

  private buildSteps(eligibleRecords: number): StepRuntime[] {
    const { thresholds } = resolveDemoPlan(this.script, eligibleRecords);

    return this.script.steps.map((step, index) => ({
      step,
      status: 'PENDING',
      atRecordsRead: thresholds[index] ?? 0,
    }));
  }

  // ------------------------------------------------------------------ state

  getState(): ScenarioState {
    const activeIndex = this.steps.findIndex((entry) => entry.status === 'ACTIVE');

    return {
      running: this.running,
      name: this.running || this.completedAt || this.abortedAt ? this.script.name : null,
      currentStepIndex: activeIndex === -1 ? null : activeIndex,
      steps: this.steps.map((entry, index) => ({
        index,
        name: entry.step.name,
        description: entry.step.description,
        status: entry.status,
        atProcessed: entry.step.atFractionRead === null ? null : entry.atRecordsRead,
      })),
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      abortedAt: this.abortedAt,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Requests a stop at the next step boundary.
   *
   * Cooperative rather than immediate: killing the run mid-recovery would leave the job in a state no
   * verification could describe, which is a worse outcome than taking a few hundred milliseconds to
   * stop cleanly.
   */
  abort(): void {
    if (!this.running) return;
    this.aborted = true;
  }

  // ------------------------------------------------------------------ tick participant

  /**
   * Fires count-triggered steps before the engine advances.
   *
   * `beforeStep` rather than `afterStep`, so an update lands while the target record is still staged and
   * unwritten. In `afterStep` the batch may already have flushed and the update would arrive too late to
   * conflict with anything.
   */
  async beforeStep(context: TickContext): Promise<void> {
    if (!this.running) return;

    /**
     * An abort takes effect by pausing, which drops the job out of the actively-processing states and so
     * ends the driver's loop after the current record. Pausing rather than killing leaves the job in a
     * state the dashboard can describe and the operator can resume or reset from.
     */
    if (this.aborted) {
      if (this.deps.orchestrator.getStatus() === JOB_STATUS.RUNNING) {
        await this.deps.orchestrator.pause();
      }
      return;
    }

    for (const entry of this.steps) {
      if (entry.status !== 'PENDING') continue;
      if (!(await this.isReady(entry, context))) continue;

      await this.executeStep(entry, context);

      // At most one step per tick, so an update and the crash can never collapse into one moment.
      return;
    }
  }

  /**
   * Whether a count-triggered step's preconditions all hold.
   *
   * The record-count threshold alone is not enough. An update step needs something actually staged and
   * unwritten to collide with, and the crash step additionally needs a checkpoint to exist so that the
   * step which destroys it has something real to destroy. Firing on the count alone would produce steps
   * that ran, reported success, and demonstrated nothing.
   */
  private async isReady(entry: StepRuntime, context: TickContext): Promise<boolean> {
    if (context.recordsRead < entry.atRecordsRead) return false;

    switch (entry.step.trigger) {
      case DEMO_TRIGGER.IN_FLIGHT:
        return context.inFlightCodes.length > 0;

      case DEMO_TRIGGER.CRASH_WINDOW: {
        // `resolveDemoPlan` guarantees the batch is large enough for this to be reachable.
        if (context.inFlightCodes.length < this.script.minStagedAtCrash) return false;
        const checkpoint = await this.deps.orchestrator.getCheckpoint();
        return checkpoint.active !== null;
      }

      default:
        return false;
    }
  }

  // ------------------------------------------------------------------ the run

  /**
   * Runs the whole demo and resolves when verification has finished.
   *
   * Resets first. A demo that inherited ledgers from a previous run could report coverage above 100% or
   * a conflict count that belongs to history, and the whole value of the exercise is that its numbers
   * describe one specific run.
   */
  async run(): Promise<ScenarioState> {
    /**
     * Claimed synchronously, before the first `await`.
     *
     * Setting the flag after an awaited dataset check would leave a window in which two overlapping
     * calls both pass the guard — and two drivers on one engine double-step records and destroy the
     * ordering the whole design rests on. A test caught this: the second call sailed past the guard and
     * failed much later, with a confusing "cannot run verification while IDLE".
     */
    if (this.running) {
      throw new ScenarioFailedError(this.script.name, 'a demo run is already in progress');
    }
    this.running = true;

    let patientCount: number;
    try {
      patientCount = await this.deps.repository.countAll();
      if (patientCount === 0) {
        throw new ScenarioFailedError(
          this.script.name,
          'the dataset is empty — seed it before running the demo',
        );
      }
    } catch (error) {
      // Release the claim: nothing has started, so the next caller should be free to try.
      this.running = false;
      throw error;
    }

    this.steps = this.buildSteps(patientCount);
    this.aborted = false;
    this.startedAt = this.deps.clock.nowIso();
    this.completedAt = null;
    this.abortedAt = null;
    this.stagedCodesAtCrash = [];

    this.deps.events.emit({
      type: EVENT_TYPE.SCENARIO_STARTED,
      severity: EVENT_SEVERITY.INFO,
      message:
        `Demo "${this.script.name}" started: ${patientCount} records, ` +
        `${this.steps.length} scripted steps, triggered by record count so the run is reproducible.`,
      payload: { steps: this.steps.map((entry) => entry.step.name), patientCount },
    });

    try {
      /**
       * Both halves of a reset, in order.
       *
       * `orchestrator.reset()` drops the in-memory job, cached report and counters;
       * `clearSimulationState()` clears the durable ledgers and returns every patient to an unscored
       * baseline. Doing only the first would leave the previous run's consideration rows in place, and
       * coverage would then be measured against a set that includes records this run never touched.
       */
      await this.deps.orchestrator.reset();

      /**
       * Restore the dataset before clearing state, in that order.
       *
       * Regenerating the patients is what makes a repeated demo a genuine replay: `clearSimulationState` alone
       * keeps each record's version and clinical values, so a second run would start from data the first run
       * mutated. `clearSimulationState` still runs afterwards to drop the ledgers, which the regeneration does
       * not own.
       */
      await this.deps.prepareDataset?.();
      await this.deps.repository.clearSimulationState();

      await this.executeByTrigger(DEMO_TRIGGER.IMMEDIATE);

      /**
       * Drive the backfill until it stops advancing.
       *
       * It stops for one of two reasons: the crash step fired, or the run finished. Both are handled
       * below, so an aborted or crash-free run cannot leave the driver waiting on something that will
       * never happen.
       */
      await this.deps.orchestrator.runToCompletion({ delayMs: this.tickDelayMs });

      if (this.aborted) return this.finishAborted();

      // Present only if the crash step actually fired.
      if (this.deps.orchestrator.getStatus() === JOB_STATUS.CRASHED) {
        await this.captureStagedCodes();
        await this.executeByTrigger(DEMO_TRIGGER.DURING_OUTAGE);

        if (this.aborted) return this.finishAborted();
      }

      await this.executeByTrigger(DEMO_TRIGGER.AFTER_RECOVERY);

      // Any step never reached is reported as skipped rather than left looking pending forever.
      for (const entry of this.steps) {
        if (entry.status === 'PENDING') entry.status = 'SKIPPED';
      }

      this.running = false;
      this.completedAt = this.deps.clock.nowIso();

      const report = this.deps.orchestrator.getLastReport();

      this.deps.events.emit({
        type: EVENT_TYPE.SCENARIO_COMPLETED,
        severity: EVENT_SEVERITY.SUCCESS,
        message: report
          ? `Demo complete. Independent audit: ${report.verdict}, ` +
            `${report.metrics.coveragePercent}% coverage, ` +
            `${report.metrics.staleWriteAttemptsBlocked} stale write(s) blocked, ` +
            `${report.metrics.staleOverwrites} stale overwrite(s).`
          : 'Demo complete, but verification did not produce a report.',
        payload: report ? { verdict: report.verdict, metrics: report.metrics } : {},
      });

      await this.deps.events.flush();

      return this.getState();
    } catch (error) {
      this.running = false;
      this.abortedAt = this.deps.clock.nowIso();

      const reason = error instanceof Error ? error.message : String(error);
      const active = this.steps.find((entry) => entry.status === 'ACTIVE');
      if (active) active.status = 'SKIPPED';

      this.deps.events.emit({
        type: EVENT_TYPE.SCENARIO_ABORTED,
        severity: EVENT_SEVERITY.CRITICAL,
        message: `Demo aborted at step "${active?.step.name ?? 'unknown'}": ${reason}`,
        payload: { reason },
      });

      await this.deps.events.flush();

      throw error instanceof ScenarioFailedError
        ? error
        : new ScenarioFailedError(active?.step.name ?? this.script.name, reason);
    }
  }

  private finishAborted(): ScenarioState {
    this.running = false;
    this.abortedAt = this.deps.clock.nowIso();

    for (const entry of this.steps) {
      if (entry.status === 'PENDING' || entry.status === 'ACTIVE') entry.status = 'SKIPPED';
    }

    this.deps.events.emit({
      type: EVENT_TYPE.SCENARIO_ABORTED,
      severity: EVENT_SEVERITY.WARNING,
      message: 'Demo aborted on request. The job is left where it stopped; reset to start over.',
    });

    return this.getState();
  }

  // ------------------------------------------------------------------ step execution

  private async executeByTrigger(trigger: DemoTrigger): Promise<void> {
    for (const entry of this.steps) {
      if (entry.status !== 'PENDING') continue;
      if (entry.step.trigger !== trigger) continue;
      if (this.aborted) return;

      /**
       * Hold the previous state before advancing.
       *
       * Before the step, not after, so the state the *last* step produced stays on screen long enough to read.
       * The crash is the case that matters: without this the dashboard went from CRASHED to RECOVERING in under
       * 250 ms and the panel explaining the crash never registered.
       */
      if (this.stepDwellMs > 0) await this.deps.clock.sleep(this.stepDwellMs);

      await this.executeStep(entry, null);
    }
  }

  private async executeStep(entry: StepRuntime, context: TickContext | null): Promise<void> {
    entry.status = 'ACTIVE';
    const index = this.steps.indexOf(entry);

    this.deps.events.emit({
      type: EVENT_TYPE.SCENARIO_STEP,
      severity: EVENT_SEVERITY.INFO,
      message: `Step ${index + 1}/${this.steps.length}: ${entry.step.name}. ${entry.step.description}`,
      payload: {
        stepIndex: index,
        name: entry.step.name,
        action: entry.step.action,
        triggerAtRecordsRead: entry.step.atFractionRead === null ? null : entry.atRecordsRead,
        recordsRead: context?.recordsRead ?? null,
      },
    });

    await this.runAction(entry.step, context);

    entry.status = 'DONE';
  }

  private async runAction(step: DemoStep, context: TickContext | null): Promise<void> {
    switch (step.action) {
      case DEMO_ACTION.START_BACKFILL: {
        /**
         * `autoAdvance: false` is what makes the crash step possible. The manager drives ticks itself,
         * so there is no background loop for `crash()` to deadlock against.
         */
        const { settings } = resolveDemoPlan(
          this.script,
          await this.deps.repository.countAll(),
        );
        this.deps.simulator.resetCounters();
        this.deps.simulator.configureAuto(settings.onlineUpdateFrequency);
        await this.deps.orchestrator.start(settings, { autoAdvance: false });
        return;
      }

      case DEMO_ACTION.UPDATE_IN_FLIGHT:
        await this.applyLevelCrossingUpdate(
          context?.inFlightCodes ?? [],
          step.actorType!,
          'in-flight',
        );
        return;

      case DEMO_ACTION.CRASH:
        await this.deps.orchestrator.crash();
        return;

      case DEMO_ACTION.UPDATE_STAGED:
        await this.applyLevelCrossingUpdate(this.stagedCodesAtCrash, step.actorType!, 'staged');
        return;

      case DEMO_ACTION.LOSE_CHECKPOINT:
        await this.deps.orchestrator.loseCheckpoint();
        return;

      case DEMO_ACTION.RECOVER:
        await this.deps.orchestrator.recover();
        return;

      case DEMO_ACTION.VERIFY:
        await this.deps.orchestrator.runVerification();
        return;
    }
  }

  // ------------------------------------------------------------------ update targeting

  /**
   * Applies the first update among `candidates` that moves a patient across a risk *level*.
   *
   * Scans in order and takes the first that qualifies, so the choice is a deterministic function of the
   * dataset and the engine's position — not a random draw. That is what makes the same seed produce the
   * same demo.
   *
   * Falls back to a generated escalating update when no candidate can cross a level. The fallback still
   * creates the conflict the step exists to demonstrate; it just does not also change the band. Silently
   * doing nothing would be the wrong answer, and so would throwing: a step that cannot find its ideal
   * target has still done something worth showing.
   */
  private async applyLevelCrossingUpdate(
    candidates: string[],
    actorType: ActorType,
    window: string,
  ): Promise<void> {
    if (candidates.length === 0) {
      throw new ScenarioFailedError(
        `update ${window} record`,
        `no ${window} records were available to update, so this step could not demonstrate a ` +
          `collision. Check batchSize and the step's record-count trigger.`,
      );
    }

    for (const code of candidates) {
      const patient = await this.deps.repository.findByCode(code);
      if (!patient) continue;

      const crossing = findLevelCrossingChange(patient, actorType);
      if (!crossing) continue;

      await this.deps.simulator.apply({
        patientCode: code,
        actorType,
        changes: crossing.changes,
        source: UPDATE_SOURCE.SCRIPTED,
      });

      this.deps.events.emit({
        type: EVENT_TYPE.SCENARIO_STEP,
        severity: EVENT_SEVERITY.WARNING,
        patientCode: code,
        message:
          `Scripted update targeted ${code} because it crosses a risk band: ` +
          `${crossing.fromLevel} → ${crossing.toLevel}. The score computed from the old data would ` +
          `have filed this patient one level lower.`,
        payload: {
          patientCode: code,
          window,
          fromLevel: crossing.fromLevel,
          toLevel: crossing.toLevel,
          changes: crossing.changes,
        },
      });

      return;
    }

    const fallbackCode = candidates[0]!;
    await this.deps.simulator.applyGenerated({
      patientCode: fallbackCode,
      actorType,
      source: UPDATE_SOURCE.SCRIPTED,
    });

    this.deps.events.emit({
      type: EVENT_TYPE.SCENARIO_STEP,
      severity: EVENT_SEVERITY.WARNING,
      patientCode: fallbackCode,
      message:
        `No ${window} record could be moved across a risk band, so ${fallbackCode} received a ` +
        `band-crossing score change instead. The conflict is demonstrated; the risk level is not.`,
      payload: { patientCode: fallbackCode, window, levelCrossing: false },
    });
  }

  /**
   * Reads the staged batch back out of storage after the crash.
   *
   * Deliberately queried rather than remembered: the point of the step that follows is that the stale
   * results survived the process, so the codes it targets should come from the durable record too.
   */
  private async captureStagedCodes(): Promise<void> {
    const state = await this.deps.orchestrator.getState();
    const staged = await this.deps.repository.pendingResults(state.jobId, 'PENDING');

    const codes: string[] = [];
    for (const entry of staged) {
      const patient: Patient | null = await this.deps.repository.findById(entry.patientId);
      if (patient) codes.push(patient.patientCode);
    }

    this.stagedCodesAtCrash = codes;
  }
}
