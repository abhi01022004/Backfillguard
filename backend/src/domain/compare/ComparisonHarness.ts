import {
  BACKFILL_MODE,
  PENDING_RESULT_STATE,
  type ComparisonResult,
  type ComparisonSide,
  type ComparisonSpotlight,
  type Patient,
  type VerificationReport,
} from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { BackfillEngine } from '../engine/BackfillEngine';
import { CheckpointManager } from '../engine/CheckpointManager';
import { ConflictEngine } from '../engine/ConflictEngine';
import { NaiveBackfillEngine } from '../engine/NaiveBackfillEngine';
import { RecoveryEngine } from '../engine/RecoveryEngine';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { VerificationEngine } from '../verify/VerificationEngine';
import { FAILURE_SCENARIO, type FailureScenario } from '../scenario/failureScenario';

/**
 * Runs the guarded and naive engines against the same scenario and scores both with the same auditor
 * (R12.2–R12.6).
 *
 * ## What makes this a fair comparison
 *
 * Both runs get a dataset generated from the same seed, the same partitioning and batch size, the same
 * crash point, and the same clinical updates during the outage. Both are then measured by the *same*
 * `VerificationEngine` — not by their own reports. If the guarded engine were flattered by a friendlier
 * auditor, the result would be worthless.
 *
 * ## Isolation
 *
 * Each side gets a freshly constructed `InMemoryPatientRepository`. Neither run can see the other, and
 * critically the naive engine has no path to the SQLite demo dataset at all. That is enforced by
 * construction here rather than by a rule someone has to remember (R12.7).
 *
 * ## A note on what "naive fails" means
 *
 * The interesting outcome is not a crash or an obvious error. The naive run typically finishes looking
 * perfectly healthy: full coverage, and every stored score matching its stored data, because it reverted a
 * clinical value and then rescored from the reverted value. Nothing appears wrong. A laboratory result has
 * simply vanished. That is why check C3 exists, and it is the most useful thing this comparison shows.
 */

export interface ComparisonHarnessDeps {
  /** Wall-clock source for report timestamps only; the runs themselves use a manual clock. */
  nowIso: () => string;
}

interface RunContext {
  patients: InMemoryPatientRepository;
  jobs: InMemoryJobRepository;
  events: InMemoryEventSink;
  verifier: VerificationEngine;
}

interface RunOutcome {
  report: VerificationReport;
  /** Patient codes whose results were staged at crash time, in batch order. */
  stagedCodes: string[];
  /** What the outage updates changed, captured as they were applied. */
  outageUpdates: AppliedOutageUpdate[];
  /** Rows as they stand at the end of the run, for the spotlight diff. */
  finalById: Map<number, Patient>;
  patientsByCode: Map<string, Patient>;
}

const JOB_ID = 'BG-COMPARE';

function buildContext(scenario: FailureScenario): RunContext {
  const clock = createManualClock();
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();
  const events = new InMemoryEventSink(clock, 100_000);

  return {
    patients,
    jobs,
    events,
    verifier: new VerificationEngine({ patients, jobs, events, clock }),
  };
}

async function seed(context: RunContext, scenario: FailureScenario): Promise<void> {
  await context.patients.replaceAll(
    generatePatients({
      totalRecords: scenario.totalRecords,
      partitionCount: scenario.partitionCount,
      seed: scenario.seed,
    }),
  );

  await context.jobs.create({
    jobId: JOB_ID,
    mode: BACKFILL_MODE.GUARDED,
    seed: scenario.seed,
    settings: {
      totalRecords: scenario.totalRecords,
      partitionCount: scenario.partitionCount,
      backfillSpeed: 1000,
      onlineUpdateFrequency: 0,
      checkpointInterval: scenario.checkpointInterval,
      batchSize: scenario.batchSize,
      maxReevaluationAttempts: 3,
    },
    totalRecords: scenario.totalRecords,
    partitionCount: scenario.partitionCount,
    eligibleRecords: scenario.totalRecords,
  });
}

/** What an outage update actually changed, captured at the moment it was applied. */
export interface AppliedOutageUpdate {
  patientCode: string;
  field: string;
  /** The value the row held before the update. */
  from: string | number;
  /** The value the clinician wrote. */
  to: string | number;
  versionBefore: number;
  versionAfter: number;
}

/**
 * Applies the scripted outage updates to whichever patients are staged.
 *
 * Returns what each update actually changed. Capturing `from` here rather than inferring it later matters:
 * reading the "original" value off the naive run's final row would only be correct *because* naive reverted
 * it, so the spotlight would silently stop making sense the moment the naive engine behaved differently.
 */
async function applyOutageUpdates(
  context: RunContext,
  scenario: FailureScenario,
  stagedCodes: string[],
): Promise<AppliedOutageUpdate[]> {
  const applied: AppliedOutageUpdate[] = [];

  for (const update of scenario.outageUpdates) {
    const code = stagedCodes[update.stagedIndex];
    if (!code) continue;

    const patient = await context.patients.findByCode(code);
    if (!patient) continue;

    const result = await context.patients.applyOnlineUpdate(
      patient.id,
      patient.version,
      update.changes,
      update.actorType,
      'SCRIPTED',
    );

    if (!result) continue;

    for (const change of result.changedFields) {
      applied.push({
        patientCode: code,
        field: change.field,
        from: change.from,
        to: change.to,
        versionBefore: patient.version,
        versionAfter: result.patient.version,
      });
    }
  }

  return applied;
}

async function snapshotPatients(context: RunContext): Promise<{
  finalById: Map<number, Patient>;
  patientsByCode: Map<string, Patient>;
}> {
  const rows = (await context.patients.findPage({ page: 1, pageSize: 100_000 })).items;
  return {
    finalById: new Map(rows.map((row) => [row.id, row])),
    patientsByCode: new Map(rows.map((row) => [row.patientCode, row])),
  };
}

// ====================================================================== guarded run

async function runGuarded(scenario: FailureScenario): Promise<RunOutcome> {
  const context = buildContext(scenario);
  await seed(context, scenario);

  const conflicts = new ConflictEngine({
    repository: context.patients,
    events: context.events,
    maxAttempts: 3,
  });

  const checkpoints = new CheckpointManager({
    jobs: context.jobs,
    events: context.events,
    interval: scenario.checkpointInterval,
  });

  const engine = new BackfillEngine({
    repository: context.patients,
    events: context.events,
    conflicts,
    jobId: JOB_ID,
    partitionCount: scenario.partitionCount,
    batchSize: scenario.batchSize,
    phase: 'INITIAL',
  });

  await engine.begin();

  // Phase 1: read up to the crash point, checkpointing after each flush.
  while (engine.readCount < scenario.crashAfterRead) {
    const step = await engine.step();
    if (step.flushed) {
      const position = engine.position;
      if (position.lastFlushedPosition >= 0) {
        await checkpoints.maybeRecord(JOB_ID, 'RUNNING', {
          partitionIndex: position.partitionIndex,
          lastFlushedPosition: position.lastFlushedPosition,
          processedCount: engine.getMetrics().processed,
        });
      }
    }
    if (!step.hasMoreWork) break;
  }

  // Phase 2: crash, freezing the staged batch durably.
  const stagedCodes = engine.inFlightCodes();
  const staged = engine.takeInFlightBatch();
  await context.patients.stagePendingResults(staged);

  // Phase 3: clinical staff work during the outage.
  const outageUpdates = await applyOutageUpdates(context, scenario, stagedCodes);

  // Phase 4: destroy the checkpoint.
  await checkpoints.lose(JOB_ID);

  // Phase 5: recover from data evidence alone.
  const recovery = new RecoveryEngine({
    repository: context.patients,
    events: context.events,
    conflicts,
    jobId: JOB_ID,
    partitionCount: scenario.partitionCount,
    phase: 'RECOVERY',
  });

  const plan = await recovery.computePlan();
  await recovery.recover(plan);
  recovery.emitCompleted();

  const report = await context.verifier.verify(JOB_ID);
  const snapshot = await snapshotPatients(context);

  return { report, stagedCodes, outageUpdates, ...snapshot };
}

// ====================================================================== naive run

async function runNaive(scenario: FailureScenario): Promise<RunOutcome> {
  const context = buildContext(scenario);
  await seed(context, scenario);

  const engine = new NaiveBackfillEngine({
    repository: context.patients,
    events: context.events,
    jobId: JOB_ID,
    partitionCount: scenario.partitionCount,
    batchSize: scenario.batchSize,
  });

  await engine.begin();

  // Phase 1: identical read-up-to-crash-point loop.
  while (engine.readCount < scenario.crashAfterRead) {
    const hasMore = await engine.step();
    if (!hasMore) break;
  }

  // Phase 2: identical crash.
  const stagedCodes = engine.inFlightCodes();
  const staged = engine.takeInFlightBatch();
  await context.patients.stagePendingResults(staged);

  // Phase 3: identical outage updates.
  const outageUpdates = await applyOutageUpdates(context, scenario, stagedCodes);

  // Phase 4/5: the difference. Flush the frozen batch verbatim, then start over.
  await engine.resumeAfterCrash();

  let guard = 0;
  while (!engine.isFinished()) {
    if (guard > scenario.totalRecords * 4) {
      throw new Error('naive run failed to terminate');
    }
    guard += 1;
    await engine.step();
  }

  engine.emitCompleted();

  const report = await context.verifier.verify(JOB_ID);
  const snapshot = await snapshotPatients(context);

  return { report, stagedCodes, outageUpdates, ...snapshot };
}

// ====================================================================== spotlight

/**
 * Builds the concrete, named example (R12.5).
 *
 * Abstract metrics do not land. One patient, one lab value, and what each engine did with it is the thing
 * a judge will remember — and it is checkable against the patient detail view.
 */
function buildSpotlight(
  scenario: FailureScenario,
  guarded: RunOutcome,
  naive: RunOutcome,
): ComparisonSpotlight | null {
  const targetCode = guarded.stagedCodes[scenario.spotlightStagedIndex];
  if (!targetCode) return null;

  // Both runs applied the same script, so either side's record of the change works. Using the guarded
  // side's keeps `from` a captured fact rather than something inferred from a final row.
  const applied = guarded.outageUpdates.find((update) => update.patientCode === targetCode);
  if (!applied) return null;

  const field = applied.field as keyof Patient;

  const guardedFinal = guarded.patientsByCode.get(targetCode);
  const naiveFinal = naive.patientsByCode.get(targetCode);
  if (!guardedFinal || !naiveFinal) return null;

  const guardedValue = guardedFinal[field] as string | number;
  const naiveValue = naiveFinal[field] as string | number;

  return {
    patientCode: targetCode,
    field: applied.field,
    originalValue: applied.from,
    onlineUpdatedValue: applied.to,
    naive: {
      finalValue: naiveValue,
      finalScore: naiveFinal.riskScore,
      lostTheOnlineUpdate: naiveValue !== applied.to,
      staleOverwrite: naive.report.metrics.staleOverwrites > 0,
    },
    guarded: {
      finalValue: guardedValue,
      finalScore: guardedFinal.riskScore,
      lostTheOnlineUpdate: guardedValue !== applied.to,
      staleOverwrite: guarded.report.metrics.staleOverwrites > 0,
      conflictDetected: guarded.report.metrics.conflicts > 0,
      reevaluated: guarded.report.metrics.reevaluated > 0,
    },
  };
}

function toSide(mode: typeof BACKFILL_MODE.GUARDED | typeof BACKFILL_MODE.NAIVE, outcome: RunOutcome): ComparisonSide {
  return {
    mode,
    label: mode === BACKFILL_MODE.GUARDED ? 'BackfillGuard' : 'Naive backfill',
    metrics: outcome.report.metrics,
    verdict: outcome.report.verdict,
  };
}

// ====================================================================== entry point

export class ComparisonHarness {
  constructor(private readonly deps: ComparisonHarnessDeps) {}

  /**
   * Runs both engines and returns the side-by-side result.
   *
   * Sequential rather than parallel, purely so the event streams stay readable if anyone inspects them;
   * the runs are fully independent either way.
   */
  async run(scenario: FailureScenario = FAILURE_SCENARIO): Promise<ComparisonResult> {
    const guarded = await runGuarded(scenario);
    const naive = await runNaive(scenario);

    const spotlight = buildSpotlight(scenario, guarded, naive);

    return {
      seed: scenario.seed,
      scenarioName: scenario.name,
      guarded: toSide(BACKFILL_MODE.GUARDED, guarded),
      naive: toSide(BACKFILL_MODE.NAIVE, naive),
      spotlight: spotlight ?? {
        patientCode: '—',
        field: '—',
        originalValue: '—',
        onlineUpdatedValue: '—',
        naive: { finalValue: '—', finalScore: null, lostTheOnlineUpdate: false, staleOverwrite: false },
        guarded: {
          finalValue: '—',
          finalScore: null,
          lostTheOnlineUpdate: false,
          staleOverwrite: false,
          conflictDetected: false,
          reevaluated: false,
        },
      },
      ranAt: this.deps.nowIso(),
    };
  }

  /** Exposed for tests that need to inspect the raw run outcomes rather than the summary. */
  async runSides(scenario: FailureScenario = FAILURE_SCENARIO) {
    return { guarded: await runGuarded(scenario), naive: await runNaive(scenario) };
  }
}

/** Recomputes a patient's score, so tests can assert what a value *should* be. */
export function expectedScoreFor(patient: Patient): number {
  return calculateRiskScore(toRiskInput(patient)).score;
}

export { PENDING_RESULT_STATE };
