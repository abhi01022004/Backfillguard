import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  BACKFILL_STATUS,
  CONFLICT_RESOLUTION,
  CONSIDERATION_OUTCOME,
  EVENT_TYPE,
  JOB_STATUS,
  UPDATE_SOURCE,
  type Patient,
} from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { SimulationOrchestrator, type TickParticipant } from '../orchestrator/SimulationOrchestrator';

/**
 * End-to-end engine behaviour, covering the mandatory cases from R21.1.
 *
 * Everything runs against the in-memory repositories and a manual clock, so a full simulation finishes
 * in milliseconds with no timers and no sleeps. The orchestrator is driven one tick at a time, which is
 * what makes "an online update lands between record N and N+1" an exact, repeatable statement rather
 * than a race.
 */

const TOTAL = 60;
const PARTITIONS = 3;
const SEED = 4242;

interface Harness {
  patients: InMemoryPatientRepository;
  jobs: InMemoryJobRepository;
  events: InMemoryEventSink;
  orchestrator: SimulationOrchestrator;
}

async function makeHarness(overrides: Partial<{ batchSize: number; maxReevaluationAttempts: number }> = {}): Promise<Harness> {
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();
  const clock = createManualClock();
  const events = new InMemoryEventSink(clock);

  await patients.replaceAll(
    generatePatients({ totalRecords: TOTAL, partitionCount: PARTITIONS, seed: SEED }),
  );

  const orchestrator = new SimulationOrchestrator({
    patients,
    jobs,
    events,
    clock,
    rng: createRng(SEED),
    seed: SEED,
    settings: {
      totalRecords: TOTAL,
      partitionCount: PARTITIONS,
      backfillSpeed: 1000,
      onlineUpdateFrequency: 0,
      checkpointInterval: 20,
      batchSize: overrides.batchSize ?? 10,
      maxReevaluationAttempts: overrides.maxReevaluationAttempts ?? 3,
    },
  });

  return { patients, jobs, events, orchestrator };
}

/**
 * Injects an online update once a given number of records have been *read*.
 *
 * Keyed to `recordsRead`, not `processed`. `processed` only advances on flush, so an update keyed to it
 * would always land after the write had already succeeded and could never create a conflict — the
 * in-flight window is precisely the gap between the two counters.
 */
function updateAfterRead(
  readTarget: number,
  action: (harness: Harness) => Promise<void>,
  harness: Harness,
  options: { expectInFlight?: string } = {},
): TickParticipant {
  let fired = false;

  return {
    async beforeStep(context) {
      if (fired || context.recordsRead < readTarget) return;
      fired = true;

      // Guards the test's own premise: if the target were already flushed, a passing "no conflict"
      // result would be meaningless rather than informative.
      if (options.expectInFlight) {
        expect(
          context.inFlightCodes,
          `${options.expectInFlight} must be staged and unwritten for this test to mean anything`,
        ).toContain(options.expectInFlight);
      }

      await action(harness);
    },
  };
}

/** Applies an online update to a patient by code, reading its current version first. */
async function onlineUpdate(
  harness: Harness,
  code: string,
  changes: Record<string, number>,
): Promise<void> {
  const current = (await harness.patients.findByCode(code))!;
  await harness.patients.applyOnlineUpdate(
    current.id,
    current.version,
    changes,
    ACTOR_TYPE.DOCTOR,
    UPDATE_SOURCE.SCRIPTED,
  );
}

describe('BackfillEngine (uncontended)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  it('scores every record and reaches full coverage', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.COMPLETED);

    const metrics = (await harness.orchestrator.getState()).metrics!;
    expect(metrics.eligibleRecords).toBe(TOTAL);
    expect(metrics.processed).toBe(TOTAL);
    expect(metrics.applied).toBe(TOTAL);
    expect(metrics.conflicts).toBe(0);
    expect(metrics.failed).toBe(0);
    expect(metrics.percentComplete).toBe(100);
  });

  it('gives every eligible record exactly one terminal ledger entry', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const ids = await harness.patients.allIds();
    const considered = await harness.patients.consideredPatientIds('BG-DEMO-001');

    expect(considered).toHaveLength(ids.length);
    expect(new Set(considered).size).toBe(ids.length);
    expect(considered).toEqual(ids);
  });

  it('stores a score that matches a fresh recomputation for every record', async () => {
    // The invariant verification later relies on: stored score == recompute(current data), and
    // lastBackfillVersion == version.
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const all = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;

    for (const patient of all) {
      const expected = calculateRiskScore(toRiskInput(patient));
      expect(patient.riskScore).toBe(expected.score);
      expect(patient.riskLevel).toBe(expected.level);
      expect(patient.lastBackfillVersion).toBe(patient.version);
      expect(patient.backfillStatus).toBe(BACKFILL_STATUS.COMPLETED);
    }
  });

  it('never touches a clinical field or the version', async () => {
    const before = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const after = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
    const byId = new Map<number, Patient>(after.map((p) => [p.id, p]));

    for (const original of before) {
      const updated = byId.get(original.id)!;
      expect(updated.version).toBe(original.version);
      expect(updated.glucose).toBe(original.glucose);
      expect(updated.heartRate).toBe(original.heartRate);
      expect(updated.bloodPressureSystolic).toBe(original.bloodPressureSystolic);
      expect(updated.bloodPressureDiastolic).toBe(original.bloodPressureDiastolic);
      expect(updated.diagnosis).toBe(original.diagnosis);
      expect(updated.age).toBe(original.age);
    }
  });

  it('records one applied, guarded write per record with matching versions', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const ledger = await harness.patients.listWriteLedger('BG-DEMO-001');
    expect(ledger).toHaveLength(TOTAL);

    for (const entry of ledger) {
      expect(entry.applied).toBe(true);
      expect(entry.guarded).toBe(true);
      expect(entry.wroteSourceFields).toBe(false);
      // The safety invariant, per write: the guard version equalled the row version.
      expect(entry.guardVersion).toBe(entry.rowVersionAtWrite);
    }
  });

  it('reports all partitions complete', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const { partitions } = await harness.orchestrator.getState();
    expect(partitions).toHaveLength(PARTITIONS);

    for (const partition of partitions) {
      expect(partition.state).toBe('COMPLETED');
      expect(partition.processedRecords).toBe(partition.totalRecords);
      expect(partition.percentComplete).toBe(100);
      expect(partition.openConflicts).toBe(0);
    }
  });

  it('emits the expected lifecycle events', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    expect(harness.events.countOfType(EVENT_TYPE.BACKFILL_STARTED)).toBe(1);
    expect(harness.events.countOfType(EVENT_TYPE.BACKFILL_COMPLETED)).toBe(1);
    expect(harness.events.countOfType(EVENT_TYPE.CONFLICT_DETECTED)).toBe(0);
    expect(harness.events.countOfType(EVENT_TYPE.STALE_RESULT_REJECTED)).toBe(0);
  });

  it('assigns strictly increasing, gap-free sequence numbers', async () => {
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const sequences = harness.events.all().map((event) => event.sequence);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }
  });
});

describe('BackfillEngine (contended)', () => {
  it('detects a conflict, refuses the stale result and re-evaluates', async () => {
    const harness = await makeHarness({ batchSize: 10 });

    // Target a record that will be read into the batch but not yet flushed, then move it underneath
    // the pending write. This is the exact race the version guard exists to catch.
    const target = (await harness.patients.findByCode('P0003'))!;
    const staleScore = calculateRiskScore(toRiskInput(target)).score;

    harness.orchestrator.register(
      updateAfterRead(5, () => onlineUpdate(harness, 'P0003', { glucose: 260 }), harness, {
        expectInFlight: 'P0003',
      }),
    );

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const metrics = (await harness.orchestrator.getState()).metrics!;
    expect(metrics.conflicts).toBe(1);
    expect(metrics.staleWriteAttemptsBlocked).toBe(1);
    expect(metrics.protectedUpdates).toBe(1);
    expect(metrics.reevaluated).toBe(1);
    expect(metrics.failed).toBe(0);
    expect(metrics.processed).toBe(TOTAL);

    // The doctor's value survived, and the stored score reflects it rather than the stale reading.
    const after = (await harness.patients.findByCode('P0003'))!;
    expect(after.glucose).toBe(260);
    expect(after.version).toBe(target.version + 1);
    expect(after.backfillStatus).toBe(BACKFILL_STATUS.REEVALUATED);

    const recomputed = calculateRiskScore(toRiskInput(after));
    expect(after.riskScore).toBe(recomputed.score);
    expect(after.riskScore).not.toBe(staleScore);
    expect(after.lastBackfillVersion).toBe(after.version);
  });

  it('records the refused write in the ledger without applying it', async () => {
    const harness = await makeHarness({ batchSize: 10 });

    harness.orchestrator.register(
      updateAfterRead(5, () => onlineUpdate(harness, 'P0003', { glucose: 260 }), harness, {
        expectInFlight: 'P0003',
      }),
    );

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const target = (await harness.patients.findByCode('P0003'))!;
    const entries = (await harness.patients.listWriteLedger('BG-DEMO-001')).filter(
      (entry) => entry.patientId === target.id,
    );

    // Two attempts: the refused stale write, then the successful re-evaluation.
    expect(entries).toHaveLength(2);

    const refused = entries[0]!;
    expect(refused.applied).toBe(false);
    expect(refused.guardVersion).not.toBe(refused.rowVersionAtWrite);

    const reapplied = entries[1]!;
    expect(reapplied.applied).toBe(true);
    expect(reapplied.guardVersion).toBe(reapplied.rowVersionAtWrite);

    // No applied write anywhere in the run had a mismatched guard: zero stale overwrites.
    const staleOverwrites = (await harness.patients.listWriteLedger('BG-DEMO-001')).filter(
      (entry) => entry.applied && entry.guardVersion !== entry.rowVersionAtWrite,
    );
    expect(staleOverwrites).toEqual([]);
  });

  it('persists the conflict with both versions and the changed field', async () => {
    const harness = await makeHarness({ batchSize: 10 });
    const target = (await harness.patients.findByCode('P0003'))!;
    const originalGlucose = target.glucose;

    harness.orchestrator.register(
      updateAfterRead(5, () => onlineUpdate(harness, 'P0003', { glucose: 260 }), harness, {
        expectInFlight: 'P0003',
      }),
    );

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const conflicts = await harness.patients.listConflicts('BG-DEMO-001');
    expect(conflicts).toHaveLength(1);

    const conflict = conflicts[0]!;
    expect(conflict.patientCode).toBe('P0003');
    expect(conflict.sourceVersion).toBe(target.version);
    expect(conflict.currentVersion).toBe(target.version + 1);
    expect(conflict.resolution).toBe(CONFLICT_RESOLUTION.REEVALUATED);
    expect(conflict.newScore).not.toBeNull();

    const glucoseChange = conflict.changedFields.find((c) => c.field === 'glucose')!;
    expect(glucoseChange.from).toBe(originalGlucose);
    expect(glucoseChange.to).toBe(260);
  });

  it('marks the record REEVERALUATED_APPLIED in the coverage ledger', async () => {
    const harness = await makeHarness({ batchSize: 10 });

    harness.orchestrator.register(
      updateAfterRead(5, () => onlineUpdate(harness, 'P0003', { glucose: 260 }), harness, {
        expectInFlight: 'P0003',
      }),
    );

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const target = (await harness.patients.findByCode('P0003'))!;
    const entry = (await harness.patients.listConsiderations('BG-DEMO-001')).find(
      (e) => e.patientId === target.id,
    )!;

    expect(entry.outcome).toBe(CONSIDERATION_OUTCOME.REEVALUATED_APPLIED);
    expect(entry.appliedVersion).toBe(target.version);
  });

  it('emits conflict, rejection and re-evaluation events in order', async () => {
    const harness = await makeHarness({ batchSize: 10 });

    harness.orchestrator.register(
      updateAfterRead(5, () => onlineUpdate(harness, 'P0003', { glucose: 260 }), harness, {
        expectInFlight: 'P0003',
      }),
    );

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const relevant = harness.events
      .all()
      .filter((event) =>
        (
          [
            EVENT_TYPE.CONFLICT_DETECTED,
            EVENT_TYPE.STALE_RESULT_REJECTED,
            EVENT_TYPE.RE_EVALUATION_STARTED,
            EVENT_TYPE.RE_EVALUATION_COMPLETED,
          ] as string[]
        ).includes(event.type),
      )
      .map((event) => event.type);

    expect(relevant).toEqual([
      EVENT_TYPE.CONFLICT_DETECTED,
      EVENT_TYPE.STALE_RESULT_REJECTED,
      EVENT_TYPE.RE_EVALUATION_STARTED,
      EVENT_TYPE.RE_EVALUATION_COMPLETED,
    ]);

    const completed = harness.events.ofType(EVENT_TYPE.RE_EVALUATION_COMPLETED)[0]!;
    expect(completed.payload?.staleOverwrite).toBe('PREVENTED');
  });

  it('still reaches full coverage when many records conflict', async () => {
    const harness = await makeHarness({ batchSize: 10 });

    // Move several staged records at once, so a whole batch flush hits conflicts.
    harness.orchestrator.register(
      updateAfterRead(
        15,
        async () => {
          // Records 11-15 are staged but unflushed at this point, so all five go stale together and a
          // whole batch flush hits conflicts.
          for (const code of ['P0011', 'P0012', 'P0013', 'P0014', 'P0015']) {
            await onlineUpdate(harness, code, { glucose: 245, heartRate: 125 });
          }
        },
        harness,
        { expectInFlight: 'P0013' },
      ),
    );

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const metrics = (await harness.orchestrator.getState()).metrics!;
    expect(metrics.conflicts).toBeGreaterThan(0);
    expect(metrics.reevaluated).toBe(metrics.conflicts);
    expect(metrics.failed).toBe(0);
    expect(metrics.processed).toBe(TOTAL);

    const considered = await harness.patients.consideredPatientIds('BG-DEMO-001');
    expect(considered).toHaveLength(TOTAL);

    // The headline safety number, measured from the ledger rather than a counter.
    const staleOverwrites = (await harness.patients.listWriteLedger('BG-DEMO-001')).filter(
      (entry) => entry.applied && entry.guardVersion !== entry.rowVersionAtWrite,
    );
    expect(staleOverwrites).toEqual([]);

    // Every conflict was resolved; none left open.
    expect(await harness.patients.openConflictCount('BG-DEMO-001')).toBe(0);
  });
});

describe('BackfillEngine determinism', () => {
  it('produces identical results across two runs with the same seed and script', async () => {
    async function run() {
      const harness = await makeHarness({ batchSize: 10 });

      harness.orchestrator.register(
        updateAfterRead(5, () => onlineUpdate(harness, 'P0003', { glucose: 260 }), harness, {
          expectInFlight: 'P0003',
        }),
      );

      await harness.orchestrator.start({}, { autoAdvance: false });
      await harness.orchestrator.runToCompletion();

      const patients = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
      const conflicts = await harness.patients.listConflicts('BG-DEMO-001');

      return {
        metrics: (await harness.orchestrator.getState()).metrics,
        scores: patients.map((p) => `${p.patientCode}:${p.riskScore}:${p.riskLevel}`),
        conflictCodes: conflicts.map((c) => `${c.patientCode}:${c.sourceVersion}->${c.currentVersion}`),
      };
    }

    const first = await run();
    const second = await run();

    expect(second.metrics).toEqual(first.metrics);
    expect(second.scores).toEqual(first.scores);
    expect(second.conflictCodes).toEqual(first.conflictCodes);
  });
});
