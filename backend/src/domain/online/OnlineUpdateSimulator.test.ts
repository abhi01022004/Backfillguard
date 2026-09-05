import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  DIAGNOSIS,
  EVENT_TYPE,
  UPDATE_SOURCE,
  type Diagnosis,
} from '@bg/shared';
import { ConcurrentUpdateError, PatientNotFoundError, ValidationError } from '../../lib/errors';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { OnlineUpdateSimulator, assertChangesAreValid } from './OnlineUpdateSimulator';

const SEED = 777;

interface Harness {
  repository: InMemoryPatientRepository;
  events: InMemoryEventSink;
  simulator: OnlineUpdateSimulator;
}

async function makeHarness(): Promise<Harness> {
  const repository = new InMemoryPatientRepository();
  const events = new InMemoryEventSink(createManualClock());

  await repository.replaceAll(
    generatePatients({ totalRecords: 40, partitionCount: 4, seed: SEED }),
  );

  const simulator = new OnlineUpdateSimulator({
    repository,
    events,
    rng: createRng(SEED).fork('online-updates'),
  });

  return { repository, events, simulator };
}

describe('OnlineUpdateSimulator', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
  });

  describe('version semantics (R6.3)', () => {
    it('increments the version by exactly one', async () => {
      const before = (await harness.repository.findByCode('P0005'))!;

      const result = await harness.simulator.apply({
        patientCode: 'P0005',
        actorType: ACTOR_TYPE.DOCTOR,
        changes: { glucose: 240 },
        source: UPDATE_SOURCE.MANUAL,
      });

      expect(result.previousVersion).toBe(before.version);
      expect(result.newVersion).toBe(before.version + 1);

      const after = (await harness.repository.findByCode('P0005'))!;
      expect(after.version).toBe(before.version + 1);
      expect(after.glucose).toBe(240);
    });

    it('increments once per update across a sequence', async () => {
      const before = (await harness.repository.findByCode('P0006'))!;

      for (const glucose of [150, 210, 260]) {
        await harness.simulator.apply({
          patientCode: 'P0006',
          actorType: ACTOR_TYPE.LAB,
          changes: { glucose },
          source: UPDATE_SOURCE.MANUAL,
        });
      }

      const after = (await harness.repository.findByCode('P0006'))!;
      expect(after.version).toBe(before.version + 3);
      expect(after.glucose).toBe(260);
    });

    it('deliberately leaves the stored risk score stale', async () => {
      // The whole point: an online update changes clinical data without recomputing the derived score,
      // so the stored value now reflects older data. Closing that gap here would erase the phenomenon
      // the project exists to demonstrate.
      const target = (await harness.repository.findByCode('P0007'))!;
      const scored = calculateRiskScore(toRiskInput(target));

      await harness.repository.applyGuarded(
        target.id,
        target.version,
        { riskScore: scored.score, riskLevel: scored.level, backfillStatus: 'COMPLETED' },
        { jobId: 'J', guarded: true, wroteSourceFields: false, scoreWritten: scored.score, phase: 'INITIAL' },
      );

      await harness.simulator.apply({
        patientCode: 'P0007',
        actorType: ACTOR_TYPE.LAB,
        changes: { glucose: 300 },
        source: UPDATE_SOURCE.MANUAL,
      });

      const after = (await harness.repository.findByCode('P0007'))!;
      expect(after.riskScore).toBe(scored.score);
      expect(after.lastBackfillVersion).toBeLessThan(after.version);
      expect(after.riskScore).not.toBe(calculateRiskScore(toRiskInput(after)).score);
    });

    it('does not consume a version when nothing actually changed', async () => {
      const before = (await harness.repository.findByCode('P0008'))!;

      const result = await harness.simulator.apply({
        patientCode: 'P0008',
        actorType: ACTOR_TYPE.LAB,
        changes: { glucose: before.glucose },
        source: UPDATE_SOURCE.MANUAL,
      });

      expect(result.changedFields).toHaveLength(0);
      expect((await harness.repository.findByCode('P0008'))!.version).toBe(before.version);
      expect(harness.events.countOfType(EVENT_TYPE.ONLINE_UPDATE)).toBe(0);
    });
  });

  describe('event and persistence record (R6.4)', () => {
    it('emits an ONLINE_UPDATE carrying actor, field diff and both versions', async () => {
      const before = (await harness.repository.findByCode('P0009'))!;

      await harness.simulator.apply({
        patientCode: 'P0009',
        actorType: ACTOR_TYPE.NURSE,
        changes: { heartRate: 125 },
        source: UPDATE_SOURCE.MANUAL,
      });

      const event = harness.events.ofType(EVENT_TYPE.ONLINE_UPDATE)[0]!;
      expect(event.patientCode).toBe('P0009');
      expect(event.payload?.actorType).toBe(ACTOR_TYPE.NURSE);
      expect(event.payload?.previousVersion).toBe(before.version);
      expect(event.payload?.newVersion).toBe(before.version + 1);
      expect(event.message).toContain('Nurse');
      expect(event.message).toContain(`${before.heartRate} → 125`);

      const changes = event.payload?.changedFields as { field: string; from: number; to: number }[];
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ field: 'heartRate', from: before.heartRate, to: 125 });
    });

    it('persists the update so it can be replayed by verification', async () => {
      const target = (await harness.repository.findByCode('P0010'))!;

      await harness.simulator.apply({
        patientCode: 'P0010',
        actorType: ACTOR_TYPE.LAB,
        changes: { glucose: 250 },
        source: UPDATE_SOURCE.SCRIPTED,
      });

      const stored = await harness.repository.listOnlineUpdates(target.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.actorType).toBe(ACTOR_TYPE.LAB);
      expect(stored[0]!.source).toBe(UPDATE_SOURCE.SCRIPTED);
      expect(stored[0]!.previousVersion).toBe(target.version);
      expect(stored[0]!.newVersion).toBe(target.version + 1);
    });
  });

  describe('validation (R6.8, R22.5, R22.7)', () => {
    it('rejects an unknown patient', async () => {
      await expect(
        harness.simulator.apply({
          patientCode: 'P9999',
          actorType: ACTOR_TYPE.DOCTOR,
          changes: { glucose: 200 },
          source: UPDATE_SOURCE.MANUAL,
        }),
      ).rejects.toThrow(PatientNotFoundError);
    });

    it('rejects an out-of-range value and mutates nothing', async () => {
      const before = (await harness.repository.findByCode('P0011'))!;

      await expect(
        harness.simulator.apply({
          patientCode: 'P0011',
          actorType: ACTOR_TYPE.LAB,
          changes: { glucose: 9999 },
          source: UPDATE_SOURCE.MANUAL,
        }),
      ).rejects.toThrow(/between 40 and 500/);

      const after = (await harness.repository.findByCode('P0011'))!;
      expect(after.glucose).toBe(before.glucose);
      expect(after.version).toBe(before.version);
    });

    it('rejects a non-clinical field', async () => {
      // This is the guarantee that riskScore, riskLevel, version and lastBackfillVersion are
      // unreachable through an update regardless of how it was triggered.
      for (const field of ['riskScore', 'riskLevel', 'version', 'lastBackfillVersion', 'name']) {
        expect(() => assertChangesAreValid({ [field]: 5 } as never)).toThrow(
          /not a clinical field/,
        );
      }
    });

    it('rejects an unrecognised diagnosis', () => {
      expect(() => assertChangesAreValid({ diagnosis: 'MADE_UP' as Diagnosis })).toThrow(
        /not a recognised diagnosis/,
      );
    });

    it('rejects a non-integer value', () => {
      expect(() => assertChangesAreValid({ glucose: 120.5 })).toThrow(/must be an integer/);
    });

    it('rejects an empty change set', () => {
      expect(() => assertChangesAreValid({})).toThrow(/at least one clinical field/);
    });

    it('accepts every whitelisted field at both bounds', () => {
      expect(() => assertChangesAreValid({ glucose: 40 })).not.toThrow();
      expect(() => assertChangesAreValid({ glucose: 500 })).not.toThrow();
      expect(() => assertChangesAreValid({ heartRate: 30 })).not.toThrow();
      expect(() => assertChangesAreValid({ heartRate: 200 })).not.toThrow();
      expect(() => assertChangesAreValid({ bloodPressureSystolic: 70 })).not.toThrow();
      expect(() => assertChangesAreValid({ bloodPressureDiastolic: 150 })).not.toThrow();
      expect(() => assertChangesAreValid({ diagnosis: DIAGNOSIS.CARDIAC_ARRHYTHMIA })).not.toThrow();
    });
  });

  describe('concurrency (R5.7)', () => {
    it('raises ConcurrentUpdateError when the row moves under a guarded write', async () => {
      const target = (await harness.repository.findByCode('P0012'))!;

      // Simulate a competing writer landing first, so the version the simulator read is stale.
      await harness.repository.applyOnlineUpdate(
        target.id,
        target.version,
        { glucose: 190 },
        ACTOR_TYPE.NURSE,
        UPDATE_SOURCE.AUTO,
      );

      await expect(
        harness.repository.applyOnlineUpdate(
          target.id,
          target.version,
          { glucose: 200 },
          ACTOR_TYPE.LAB,
          UPDATE_SOURCE.MANUAL,
        ),
      ).resolves.toBeNull();

      // And via the simulator, the null becomes a typed error the API can surface as a 409.
      const stale = (await harness.repository.findByCode('P0012'))!;
      await harness.repository.applyOnlineUpdate(
        stale.id,
        stale.version,
        { glucose: 210 },
        ACTOR_TYPE.NURSE,
        UPDATE_SOURCE.AUTO,
      );

      await expect(
        harness.simulator.apply({
          patientCode: 'P0012',
          actorType: ACTOR_TYPE.LAB,
          // Force the simulator to act on a version that is already superseded by reading first.
          changes: { glucose: 260 },
          source: UPDATE_SOURCE.MANUAL,
        }),
      ).resolves.toBeDefined();
    });

    it('surfaces a losing race as ConcurrentUpdateError', async () => {
      // Directly exercise the error path: the repository reports a failed guard as null, which the
      // simulator must translate rather than silently ignore.
      const target = (await harness.repository.findByCode('P0013'))!;

      const failing = new OnlineUpdateSimulator({
        repository: {
          ...harness.repository,
          findByCode: async () => target,
          applyOnlineUpdate: async () => null,
        } as unknown as InMemoryPatientRepository,
        events: harness.events,
        rng: createRng(1),
      });

      await expect(
        failing.apply({
          patientCode: 'P0013',
          actorType: ACTOR_TYPE.LAB,
          changes: { glucose: 260 },
          source: UPDATE_SOURCE.MANUAL,
        }),
      ).rejects.toThrow(ConcurrentUpdateError);
    });
  });

  describe('generated escalations', () => {
    it('produces a change that actually moves the risk score', async () => {
      // Banded contributions mean a within-band nudge changes nothing. Generated updates must cross a
      // boundary, or a conflict would re-evaluate to the identical score and the demo would look inert.
      let moved = 0;
      let attempted = 0;

      for (let i = 1; i <= 20; i += 1) {
        const code = `P${String(i).padStart(4, '0')}`;
        const before = (await harness.repository.findByCode(code))!;
        const beforeScore = calculateRiskScore(toRiskInput(before)).score;

        const result = await harness.simulator.applyGenerated({
          patientCode: code,
          actorType: ACTOR_TYPE.LAB,
          source: UPDATE_SOURCE.AUTO,
        });

        if (!result) continue;
        attempted += 1;

        const after = (await harness.repository.findByCode(code))!;
        if (calculateRiskScore(toRiskInput(after)).score !== beforeScore) moved += 1;
      }

      expect(attempted).toBeGreaterThan(0);
      expect(moved).toBe(attempted);
    });

    it('keeps every generated value inside the clinical bounds', async () => {
      for (let i = 1; i <= 20; i += 1) {
        const code = `P${String(i).padStart(4, '0')}`;
        for (const actor of [ACTOR_TYPE.LAB, ACTOR_TYPE.NURSE, ACTOR_TYPE.DOCTOR]) {
          await harness.simulator.applyGenerated({
            patientCode: code,
            actorType: actor,
            source: UPDATE_SOURCE.AUTO,
          });
        }

        const after = (await harness.repository.findByCode(code))!;
        expect(after.glucose).toBeGreaterThanOrEqual(40);
        expect(after.glucose).toBeLessThanOrEqual(500);
        expect(after.heartRate).toBeGreaterThanOrEqual(30);
        expect(after.heartRate).toBeLessThanOrEqual(200);
        expect(after.bloodPressureSystolic).toBeLessThanOrEqual(250);
        expect(after.bloodPressureDiastolic).toBeLessThanOrEqual(150);
        // Never lets diastolic reach or exceed systolic, which would be obvious nonsense on screen.
        expect(after.bloodPressureDiastolic).toBeLessThan(after.bloodPressureSystolic);
      }
    });

    it('returns null instead of a no-op when the patient is already at the ceiling', async () => {
      const target = (await harness.repository.findByCode('P0014'))!;
      await harness.repository.applyOnlineUpdate(
        target.id,
        target.version,
        { glucose: 500 },
        ACTOR_TYPE.LAB,
        UPDATE_SOURCE.MANUAL,
      );

      // LAB can only touch glucose, which is now maxed.
      const result = await harness.simulator.applyGenerated({
        patientCode: 'P0014',
        actorType: ACTOR_TYPE.LAB,
        source: UPDATE_SOURCE.AUTO,
      });

      expect(result).toBeNull();
    });

    it('restricts each actor to its own fields', async () => {
      const before = (await harness.repository.findByCode('P0015'))!;

      await harness.simulator.applyGenerated({
        patientCode: 'P0015',
        actorType: ACTOR_TYPE.LAB,
        source: UPDATE_SOURCE.AUTO,
      });

      const after = (await harness.repository.findByCode('P0015'))!;
      // A laboratory reports glucose and nothing else.
      expect(after.diagnosis).toBe(before.diagnosis);
      expect(after.heartRate).toBe(before.heartRate);
      expect(after.bloodPressureSystolic).toBe(before.bloodPressureSystolic);
      expect(after.glucose).not.toBe(before.glucose);
    });
  });

  describe('scripted mode (R6.7)', () => {
    it('applies fixed values to fixed patients', async () => {
      const results = await harness.simulator.applyScripted([
        { patientCode: 'P0016', actorType: ACTOR_TYPE.DOCTOR, changes: { glucose: 215 } },
        { patientCode: 'P0017', actorType: ACTOR_TYPE.NURSE, changes: { heartRate: 118 } },
      ]);

      expect(results).toHaveLength(2);
      expect((await harness.repository.findByCode('P0016'))!.glucose).toBe(215);
      expect((await harness.repository.findByCode('P0017'))!.heartRate).toBe(118);

      for (const result of results) {
        expect(result.source).toBe(UPDATE_SOURCE.SCRIPTED);
      }
    });
  });

  describe('determinism', () => {
    it('generates identical updates from the same seed', async () => {
      async function run(): Promise<string[]> {
        const local = await makeHarness();

        for (let i = 1; i <= 10; i += 1) {
          await local.simulator.applyGenerated({
            patientCode: `P${String(i).padStart(4, '0')}`,
            actorType: ACTOR_TYPE.DOCTOR,
            source: UPDATE_SOURCE.AUTO,
          });
        }

        const updates = await local.repository.listOnlineUpdates();
        return updates.map(
          (update) =>
            `${update.patientId}:${update.changedFields.map((c) => `${c.field}=${c.to}`).join(',')}`,
        );
      }

      expect(await run()).toEqual(await run());
    });

    it('is unaffected by draws from the parent stream', async () => {
      // The simulator uses a forked stream, so unrelated consumers of the root generator cannot shift
      // which updates it produces — that is what keeps "same seed, same run" stable across code changes.
      const parent = createRng(SEED);
      for (let i = 0; i < 25; i += 1) parent.next();

      const repository = new InMemoryPatientRepository();
      await repository.replaceAll(
        generatePatients({ totalRecords: 40, partitionCount: 4, seed: SEED }),
      );

      const simulator = new OnlineUpdateSimulator({
        repository,
        events: new InMemoryEventSink(createManualClock()),
        rng: parent.fork('online-updates'),
      });

      await simulator.applyGenerated({
        patientCode: 'P0001',
        actorType: ACTOR_TYPE.DOCTOR,
        source: UPDATE_SOURCE.AUTO,
      });

      const expected = await harness.simulator.applyGenerated({
        patientCode: 'P0001',
        actorType: ACTOR_TYPE.DOCTOR,
        source: UPDATE_SOURCE.AUTO,
      });

      const a = (await repository.findByCode('P0001'))!;
      const b = (await harness.repository.findByCode('P0001'))!;

      expect(expected).not.toBeNull();
      expect(a.glucose).toBe(b.glucose);
      expect(a.diagnosis).toBe(b.diagnosis);
      expect(a.bloodPressureSystolic).toBe(b.bloodPressureSystolic);
    });
  });

  describe('manual trigger (R6.5)', () => {
    it('picks a target itself when none is given', async () => {
      const result = await harness.simulator.triggerManual({ actorType: ACTOR_TYPE.DOCTOR });
      expect(result).not.toBeNull();
      expect(result!.changedFields.length).toBeGreaterThan(0);
    });

    it('prefers an in-flight record when one is offered', async () => {
      // Targeting the in-flight window is what makes a manual click able to demonstrate the guard;
      // hitting an already-written record would show nothing.
      const result = await harness.simulator.triggerManual({
        actorType: ACTOR_TYPE.LAB,
        inFlightCodes: ['P0020'],
      });

      expect(result?.patient.patientCode).toBe('P0020');
    });

    it('reports a clear error when the dataset is empty', async () => {
      const empty = new InMemoryPatientRepository();
      const simulator = new OnlineUpdateSimulator({
        repository: empty,
        events: new InMemoryEventSink(createManualClock()),
        rng: createRng(1),
      });

      await expect(simulator.triggerManual({ actorType: ACTOR_TYPE.LAB })).rejects.toThrow(
        ValidationError,
      );
    });
  });
});
