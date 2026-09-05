import { describe, expect, it } from 'vitest';
import { EVENT_TYPE, JOB_STATUS } from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { SimulationOrchestrator } from '../orchestrator/SimulationOrchestrator';
import { OnlineUpdateSimulator, TARGET_STRATEGY } from './OnlineUpdateSimulator';

/**
 * The automatic update stream running against a live engine.
 *
 * This is the test that matters for the demo: it proves the two components together actually produce
 * contention, and that the guard holds under it. The unit tests establish that updates are valid and
 * that the engine handles a conflict, but neither would catch the failure where the simulator fires
 * harmlessly outside the in-flight window and the safety mechanism is never exercised at all.
 */

const TOTAL = 120;
const PARTITIONS = 4;
const SEED = 31337;
const JOB = 'BG-DEMO-001';

async function runWithAutoUpdates(options: {
  updatesPerHundred: number;
  strategy?: typeof TARGET_STRATEGY.IN_FLIGHT | typeof TARGET_STRATEGY.RANDOM;
  seed?: number;
}) {
  const seed = options.seed ?? SEED;
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();
  const clock = createManualClock();
  const events = new InMemoryEventSink(clock, 100_000);
  const rng = createRng(seed);

  await patients.replaceAll(
    generatePatients({ totalRecords: TOTAL, partitionCount: PARTITIONS, seed }),
  );

  const orchestrator = new SimulationOrchestrator({
    patients,
    jobs,
    events,
    clock,
    rng,
    seed,
    settings: {
      totalRecords: TOTAL,
      partitionCount: PARTITIONS,
      backfillSpeed: 1000,
      onlineUpdateFrequency: options.updatesPerHundred,
      checkpointInterval: 25,
      batchSize: 10,
      maxReevaluationAttempts: 3,
    },
  });

  const simulator = new OnlineUpdateSimulator({
    repository: patients,
    events,
    // A forked stream, matching production wiring, so the simulator's draws stay independent of the
    // orchestrator's.
    rng: rng.fork('online-updates'),
  });

  simulator.configureAuto(options.updatesPerHundred, options.strategy ?? TARGET_STRATEGY.IN_FLIGHT);
  orchestrator.register(simulator.asTickParticipant());

  await orchestrator.start();
  await orchestrator.runToCompletion();

  return { patients, jobs, events, orchestrator, simulator };
}

describe('automatic online updates against a running backfill', () => {
  it('creates real contention and still completes safely', async () => {
    const { patients, events, orchestrator } = await runWithAutoUpdates({ updatesPerHundred: 20 });

    expect(orchestrator.getStatus()).toBe(JOB_STATUS.COMPLETED);

    const metrics = (await orchestrator.getState()).metrics;

    // The stream must actually collide with in-flight records, otherwise the guard is never tested.
    expect(events.countOfType(EVENT_TYPE.ONLINE_UPDATE)).toBeGreaterThan(0);
    expect(metrics.conflicts).toBeGreaterThan(0);
    expect(metrics.staleWriteAttemptsBlocked).toBe(metrics.conflicts);
    expect(metrics.protectedUpdates).toBe(metrics.conflicts);
    expect(metrics.reevaluated).toBe(metrics.conflicts);
    expect(metrics.failed).toBe(0);

    // Liveness: every record still reached a terminal decision.
    expect(metrics.processed).toBe(TOTAL);
    expect(await patients.consideredPatientIds(JOB)).toHaveLength(TOTAL);

    // Safety: not one applied write had a guard version that disagreed with the row.
    const staleOverwrites = (await patients.listWriteLedger(JOB)).filter(
      (entry) => entry.applied && entry.guardVersion !== entry.rowVersionAtWrite,
    );
    expect(staleOverwrites).toEqual([]);

    // Every conflict resolved.
    expect(await patients.openConflictCount(JOB)).toBe(0);
  });

  it('preserves every clinical value the updates wrote', async () => {
    const { patients } = await runWithAutoUpdates({ updatesPerHundred: 20 });

    /**
     * The lost-update check, per field.
     *
     * Folds each patient's updates in version order into the last value set for each field, then
     * confirms the row still holds it. This is exactly verification check C3, and it is the assertion
     * that would fail if a stale backfill write had clobbered newer clinical data.
     */
    const updates = await patients.listOnlineUpdates();
    const expected = new Map<number, Map<string, string | number>>();

    for (const update of updates) {
      const fields = expected.get(update.patientId) ?? new Map<string, string | number>();
      for (const change of update.changedFields) fields.set(change.field, change.to);
      expected.set(update.patientId, fields);
    }

    expect(expected.size).toBeGreaterThan(0);

    for (const [patientId, fields] of expected) {
      const patient = (await patients.findById(patientId))!;
      for (const [field, value] of fields) {
        expect(
          patient[field as keyof typeof patient],
          `${patient.patientCode}.${field} should still hold the value an online update wrote`,
        ).toBe(value);
      }
    }
  });

  it('leaves every completed record consistent with its own current data', async () => {
    const { patients } = await runWithAutoUpdates({ updatesPerHundred: 20 });

    // Verification check C4, applied to the records whose score is claimed to be current.
    const all = (await patients.findPage({ page: 1, pageSize: 500 })).items;
    let checked = 0;

    for (const patient of all) {
      if (patient.lastBackfillVersion !== patient.version) continue;
      checked += 1;
      const expectedScore = calculateRiskScore(toRiskInput(patient));
      expect(patient.riskScore).toBe(expectedScore.score);
      expect(patient.riskLevel).toBe(expectedScore.level);
    }

    expect(checked).toBeGreaterThan(0);
  });

  it('produces an identical conflict set from the same seed', async () => {
    // The determinism guarantee, exercised through the full stack: engine, simulator and tick loop.
    async function fingerprint() {
      const { patients } = await runWithAutoUpdates({ updatesPerHundred: 20 });
      const conflicts = await patients.listConflicts(JOB);
      return conflicts.map(
        (conflict) =>
          `${conflict.patientCode}:v${conflict.sourceVersion}->v${conflict.currentVersion}:` +
          `${conflict.oldScore}->${conflict.newScore}`,
      );
    }

    const first = await fingerprint();
    const second = await fingerprint();

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('produces far less contention with uniform random targeting', async () => {
    // Honest about the simulation choice: in-flight targeting is a deliberate bias toward the
    // interesting case. The mechanism under test is identical either way; only the hit rate differs.
    const focused = await runWithAutoUpdates({ updatesPerHundred: 20 });
    const uniform = await runWithAutoUpdates({
      updatesPerHundred: 20,
      strategy: TARGET_STRATEGY.RANDOM,
    });

    const focusedConflicts = (await focused.orchestrator.getState()).metrics.conflicts;
    const uniformConflicts = (await uniform.orchestrator.getState()).metrics.conflicts;

    expect(focusedConflicts).toBeGreaterThan(uniformConflicts);

    // Whichever strategy is used, safety and coverage must hold.
    for (const harness of [focused, uniform]) {
      const staleOverwrites = (await harness.patients.listWriteLedger(JOB)).filter(
        (entry) => entry.applied && entry.guardVersion !== entry.rowVersionAtWrite,
      );
      expect(staleOverwrites).toEqual([]);
      expect(await harness.patients.consideredPatientIds(JOB)).toHaveLength(TOTAL);
    }
  });

  it('applies no updates when the frequency is zero', async () => {
    const { events, orchestrator } = await runWithAutoUpdates({ updatesPerHundred: 0 });

    expect(events.countOfType(EVENT_TYPE.ONLINE_UPDATE)).toBe(0);
    expect((await orchestrator.getState()).metrics.conflicts).toBe(0);
  });
});
