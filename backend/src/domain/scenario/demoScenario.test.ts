import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  CONFLICT_RESOLUTION,
  DEFAULT_SEED,
  EVENT_TYPE,
  JOB_STATUS,
  SIMULATION_BOUNDS,
  VERIFICATION_VERDICT,
  type ActorType,
} from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { reseedToBaseline } from '../../infra/seed/seedRunner';
import { OnlineUpdateSimulator } from '../online/OnlineUpdateSimulator';
import { SimulationOrchestrator } from '../orchestrator/SimulationOrchestrator';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { DEMO_SCRIPT, findLevelCrossingChange, resolveDemoPlan } from './demoScript';
import { ScenarioManager } from './ScenarioManager';

/**
 * The scripted demo (R18).
 *
 * ## Why this suite exists
 *
 * The demo is the artefact a judge actually sees, and it makes six specific claims. If any of them
 * silently stops holding — because a threshold moved, a heuristic changed, or the risk config was
 * retuned — the failure would show up live, in front of an audience, as a demo that quietly proved
 * nothing. So each claim is asserted here, and the build breaks instead.
 *
 * The dataset sizes below are chosen to exercise the scaling logic: 300 records is a normal run, and 100
 * is the smallest the bounds permit. An earlier draft of the script used absolute record counts and
 * passed at 1,000 records while silently skipping the crash entirely at 100.
 */

const JOB = 'BG-DEMO-001';

interface Harness {
  patients: InMemoryPatientRepository;
  jobs: InMemoryJobRepository;
  events: InMemoryEventSink;
  orchestrator: SimulationOrchestrator;
  scenarios: ScenarioManager;
}

async function makeHarness(totalRecords: number, partitionCount = 5): Promise<Harness> {
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();
  const clock = createManualClock();
  const events = new InMemoryEventSink(clock, 200_000);
  const rng = createRng(DEFAULT_SEED);

  await patients.replaceAll(
    generatePatients({ totalRecords, partitionCount, seed: DEFAULT_SEED }),
  );

  const orchestrator = new SimulationOrchestrator({
    patients,
    jobs,
    events,
    clock,
    rng,
    seed: DEFAULT_SEED,
    settings: {
      totalRecords,
      partitionCount,
      backfillSpeed: 1000,
      onlineUpdateFrequency: 0,
      checkpointInterval: 20,
      batchSize: 10,
      maxReevaluationAttempts: 3,
    },
  });

  const simulator = new OnlineUpdateSimulator({
    repository: patients,
    events,
    rng: rng.fork('online-updates'),
  });
  orchestrator.register(simulator.asTickParticipant());

  const scenarios = new ScenarioManager({
    orchestrator,
    simulator,
    repository: patients,
    events,
    clock,
    // Matches the running application: each run starts from the generated baseline, which is what makes a
    // repeated demo a replay rather than a fresh run over mutated data.
    prepareDataset: async () => {
      await reseedToBaseline(patients, DEFAULT_SEED);
    },
    // Unpaced: a manual clock cannot resolve a sleep, and pacing changes nothing about the outcome.
    tickDelayMs: 0,
  });
  orchestrator.register(scenarios);

  return { patients, jobs, events, orchestrator, scenarios };
}

// ====================================================================== level-crossing targeting

describe('findLevelCrossingChange', () => {
  it('moves a patient across a risk level, not merely across a scoring band', () => {
    // Known-good fixture: normal blood pressure keeps the score low enough that a glucose escalation
    // can still cross MEDIUM → HIGH. A patient already high on other factors has no headroom.
    const patient = {
      id: 1,
      patientCode: 'P0001',
      name: 'Test',
      age: 62,
      bloodPressureSystolic: 112,
      bloodPressureDiastolic: 72,
      heartRate: 84,
      glucose: 118,
      diagnosis: 'CHRONIC_KIDNEY_DISEASE' as const,
      partitionIndex: 0,
      version: 1,
      riskScore: null,
      riskLevel: null,
      backfillStatus: 'PENDING' as const,
      lastBackfillVersion: null,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };

    const crossing = findLevelCrossingChange(patient, ACTOR_TYPE.LAB)!;

    expect(crossing).not.toBeNull();
    expect(crossing.fromLevel).toBe('MEDIUM');
    expect(crossing.toLevel).toBe('HIGH');

    const after = calculateRiskScore({ ...toRiskInput(patient), ...crossing.changes });
    expect(after.level).toBe(crossing.toLevel);
    expect(after.level).not.toBe(crossing.fromLevel);
  });

  it('returns null rather than a no-op when the actor has no headroom', () => {
    const maxedOut = {
      id: 1,
      patientCode: 'P0001',
      name: 'Test',
      age: 88,
      bloodPressureSystolic: 190,
      bloodPressureDiastolic: 120,
      heartRate: 150,
      glucose: 480,
      diagnosis: 'CARDIAC_ARRHYTHMIA' as const,
      partitionIndex: 0,
      version: 1,
      riskScore: null,
      riskLevel: null,
      backfillStatus: 'PENDING' as const,
      lastBackfillVersion: null,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    };

    expect(findLevelCrossingChange(maxedOut, ACTOR_TYPE.LAB)).toBeNull();
  });

  it('produces a change every actor is actually permitted to make', () => {
    // A change outside the actor's field list would be rejected by the domain validator at run time,
    // turning a demo step into a 400 in front of an audience.
    const actors: ActorType[] = [ACTOR_TYPE.LAB, ACTOR_TYPE.NURSE, ACTOR_TYPE.DOCTOR];
    const patients = generatePatients({ totalRecords: 200, partitionCount: 4, seed: DEFAULT_SEED });

    for (const actor of actors) {
      const found = patients
        .map((patient, index) => ({ ...patient, id: index + 1, createdAt: '', updatedAt: '' }))
        .map((patient) => findLevelCrossingChange(patient, actor))
        .filter((change) => change !== null);

      // Every actor must be able to move *some* patient across a level, or its demo step degrades to
      // the fallback path on every run.
      expect(found.length).toBeGreaterThan(0);
    }
  });
});

// ====================================================================== plan resolution

describe('resolveDemoPlan', () => {
  it('scales batch size and checkpoint interval with the dataset', () => {
    const large = resolveDemoPlan(DEMO_SCRIPT, 1000);
    expect(large.settings.batchSize).toBe(20);
    expect(large.settings.checkpointInterval).toBe(50);

    const small = resolveDemoPlan(DEMO_SCRIPT, 100);
    // Proportionally 2, floored to 4 so the crash step's staged-record requirement is reachable.
    expect(small.settings.batchSize).toBe(DEMO_SCRIPT.minStagedAtCrash + 1);
    // Clamped up to the permitted minimum rather than computed to 5, which the bounds would reject.
    expect(small.settings.checkpointInterval).toBe(SIMULATION_BOUNDS.checkpointInterval.min);
  });

  it('always leaves room for the crash step to observe its staged minimum', () => {
    // The observable maximum is batchSize - 1, because the readiness check runs before the read that
    // fills the batch and flushes it.
    for (const total of [100, 137, 250, 1000, 5000]) {
      const { settings } = resolveDemoPlan(DEMO_SCRIPT, total);
      expect(settings.batchSize - 1).toBeGreaterThanOrEqual(DEMO_SCRIPT.minStagedAtCrash);
    }
  });

  it('keeps every resolved setting inside the shared bounds', () => {
    for (const total of [100, 250, 1000, 5000]) {
      const { settings } = resolveDemoPlan(DEMO_SCRIPT, total);

      for (const key of ['batchSize', 'checkpointInterval'] as const) {
        expect(settings[key]).toBeGreaterThanOrEqual(SIMULATION_BOUNDS[key].min);
        expect(settings[key]).toBeLessThanOrEqual(SIMULATION_BOUNDS[key].max);
      }
    }
  });

  it('resolves count triggers in strictly increasing order', () => {
    const { thresholds } = resolveDemoPlan(DEMO_SCRIPT, 300);
    const counted = DEMO_SCRIPT.steps
      .map((step, index) => ({ step, threshold: thresholds[index]! }))
      .filter((entry) => entry.step.atFractionRead !== null)
      .map((entry) => entry.threshold);

    expect(counted).toEqual([...counted].sort((a, b) => a - b));
    expect(new Set(counted).size).toBe(counted.length);
  });
});

// ====================================================================== the run

describe('ScenarioManager: the scripted demo', () => {
  it('runs every step and reaches a verified verdict', async () => {
    const harness = await makeHarness(300);

    const state = await harness.scenarios.run();

    expect(state.running).toBe(false);
    expect(state.completedAt).not.toBeNull();
    expect(state.abortedAt).toBeNull();

    // No step may be skipped: a skipped step is a claim the demo failed to demonstrate.
    expect(state.steps.map((step) => step.status)).toEqual(
      state.steps.map(() => 'DONE'),
    );

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.VERIFIED_SAFE);
  });

  it('satisfies all six demo guarantees', async () => {
    const harness = await makeHarness(300);
    await harness.scenarios.run();

    const report = harness.orchestrator.getLastReport()!;
    const conflicts = await harness.patients.listConflicts(JOB);

    // 1. contention actually happened
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(report.metrics.staleWriteAttemptsBlocked).toBeGreaterThanOrEqual(1);

    // 2. and was resolved by recomputation rather than by giving up
    const reevaluated = conflicts.filter(
      (conflict) => conflict.resolution === CONFLICT_RESOLUTION.REEVALUATED,
    );
    expect(reevaluated.length).toBeGreaterThanOrEqual(1);

    // 3. exactly one checkpoint destruction, and it was not a no-op
    expect(harness.events.countOfType(EVENT_TYPE.CHECKPOINT_LOST)).toBe(1);
    expect(harness.events.countOfType(EVENT_TYPE.CHECKPOINT_CREATED)).toBeGreaterThanOrEqual(1);

    // 4. the headline safety number, measured by the independent audit
    expect(report.metrics.staleOverwrites).toBe(0);
    expect(report.metrics.lostOnlineUpdates).toBe(0);
    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);

    // 5. nothing was skipped to achieve that
    expect(report.metrics.coveragePercent).toBe(100);
    expect(report.metrics.missedRecords).toBe(0);

    /**
     * 6. at least one re-evaluation changed the patient's risk *level*.
     *
     * Compared as the level of the rejected score against the level of the applied score, which is the
     * form that makes the stakes legible: the stale value would have filed this patient one band lower.
     * Comparing stored `riskLevel` instead would under-report, because a record read but never written
     * has no stored level yet.
     */
    const levelChanges = reevaluated.filter((conflict) => {
      if (conflict.newScore === null) return false;
      return levelOf(conflict.oldScore) !== levelOf(conflict.newScore);
    });
    expect(levelChanges.length).toBeGreaterThanOrEqual(1);
  });

  it('crashes with results staged and a checkpoint available to destroy', async () => {
    const harness = await makeHarness(300);
    await harness.scenarios.run();

    const crash = harness.events
      .all()
      .find((event) => event.type === EVENT_TYPE.BACKFILL_CRASHED)!;

    expect(crash).toBeDefined();
    expect(crash.payload!.stagedResultCount as number).toBeGreaterThanOrEqual(
      DEMO_SCRIPT.minStagedAtCrash,
    );

    // Ordering matters: the checkpoint must exist before it is destroyed, or the step proves nothing.
    const sequence = harness.events
      .all()
      .filter((event) =>
        (
          [
            EVENT_TYPE.CHECKPOINT_CREATED,
            EVENT_TYPE.BACKFILL_CRASHED,
            EVENT_TYPE.CHECKPOINT_LOST,
            EVENT_TYPE.RECOVERY_STARTED,
          ] as string[]
        ).includes(event.type),
      )
      .map((event) => event.type);

    expect(sequence[0]).toBe(EVENT_TYPE.CHECKPOINT_CREATED);
    expect(sequence.indexOf(EVENT_TYPE.CHECKPOINT_LOST)).toBeGreaterThan(
      sequence.indexOf(EVENT_TYPE.BACKFILL_CRASHED),
    );
    expect(sequence.indexOf(EVENT_TYPE.RECOVERY_STARTED)).toBeGreaterThan(
      sequence.indexOf(EVENT_TYPE.CHECKPOINT_LOST),
    );
  });

  it('recovers with no checkpoint available, so the resume cannot have used one', async () => {
    const harness = await makeHarness(300);
    await harness.scenarios.run();

    const checkpoint = await harness.orchestrator.getCheckpoint();
    expect(checkpoint.active).toBeNull();

    const recovery = harness.orchestrator.getLastRecoverySummary()!;
    expect(recovery.recordsRevisited).toBeGreaterThan(0);
    // The evidence that recovery reasoned rather than rewrote: some records were left alone.
    expect(recovery.noops).toBeGreaterThan(0);
  });

  it('holds every guarantee on the smallest permitted dataset', async () => {
    // The case the fraction-based triggers exist for. With absolute counts this run never crashed.
    const harness = await makeHarness(SIMULATION_BOUNDS.totalRecords.min, 4);

    const state = await harness.scenarios.run();

    expect(state.steps.map((step) => step.status)).toEqual(state.steps.map(() => 'DONE'));
    expect(harness.events.countOfType(EVENT_TYPE.BACKFILL_CRASHED)).toBe(1);
    expect(harness.events.countOfType(EVENT_TYPE.CHECKPOINT_LOST)).toBe(1);

    const report = harness.orchestrator.getLastReport()!;
    expect(report.metrics.staleOverwrites).toBe(0);
    expect(report.metrics.coveragePercent).toBe(100);
  });

  it('produces an identical run from an identical seed', async () => {
    // The claim that makes every quoted number worth quoting.
    const first = await makeHarness(300);
    await first.scenarios.run();

    const second = await makeHarness(300);
    await second.scenarios.run();

    expect(await summarise(second)).toEqual(await summarise(first));
  });

  it('produces an identical run when repeated in the same process', async () => {
    /**
     * The harder half of the determinism claim, and the one that was actually broken.
     *
     * Two fresh harnesses each get a fresh generator, so the case above passes even when a repeated run does
     * not replay. A long-lived server reuses one generator across runs, so the second run continued from
     * wherever the first left the stream. Measured live on the 1,000-record dataset: four consecutive demo runs
     * reported 6, 8, 7 and 7 conflicts. All four were safe — but the demo puts "same seed, same run" on screen,
     * and a judge who pressed the button twice had every reason to disbelieve it.
     */
    const harness = await makeHarness(300);

    await harness.scenarios.run();
    const first = await summarise(harness);

    await harness.scenarios.run();
    const second = await summarise(harness);

    expect(second.conflictCodes).toEqual(first.conflictCodes);
    expect(second.conflictScores).toEqual(first.conflictScores);
    expect(second.metrics).toEqual(first.metrics);
  });

  it('refuses to start a second run while one is in progress', async () => {
    const harness = await makeHarness(150, 3);

    const running = harness.scenarios.run();
    await expect(harness.scenarios.run()).rejects.toThrow(/already in progress/i);

    await running;
  });

  it('refuses to run against an empty dataset instead of reporting a vacuous success', async () => {
    const harness = await makeHarness(150, 3);
    await harness.patients.replaceAll([]);

    await expect(harness.scenarios.run()).rejects.toThrow(/seed it before running/i);
  });

  it('discards the previous run entirely, so a repeat demo reports only its own numbers', async () => {
    const harness = await makeHarness(150, 3);

    await harness.scenarios.run();
    const first = harness.orchestrator.getLastReport()!;

    await harness.scenarios.run();
    const second = harness.orchestrator.getLastReport()!;

    // Coverage above 100% would be the signature of inherited ledger rows.
    expect(second.metrics.coveragePercent).toBe(100);
    expect(second.metrics.consideredRecords).toBe(first.metrics.consideredRecords);
    expect(second.metrics.staleOverwrites).toBe(0);
  });
});

/** The observable shape of a run, for comparing two of them. */
async function summarise(harness: Harness) {
  const conflicts = await harness.patients.listConflicts(JOB);
  const report = harness.orchestrator.getLastReport()!;

  return {
    conflictCodes: conflicts.map((conflict) => conflict.patientCode),
    conflictScores: conflicts.map((conflict) => `${conflict.oldScore}->${conflict.newScore}`),
    metrics: report.metrics,
  };
}

/** Local level banding, so the test does not depend on the engine's own classification helper. */
function levelOf(score: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (score <= 30) return 'LOW';
  if (score <= 60) return 'MEDIUM';
  return 'HIGH';
}
