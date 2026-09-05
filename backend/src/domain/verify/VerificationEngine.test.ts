import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  BACKFILL_STATUS,
  CONFLICT_RESOLUTION,
  CONSIDERATION_OUTCOME,
  EVENT_TYPE,
  JOB_STATUS,
  RISK_LEVEL,
  UPDATE_SOURCE,
  VERIFICATION_CHECK,
  VERIFICATION_VERDICT,
  type VerificationCheckId,
  type VerificationReport,
} from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { SimulationOrchestrator } from '../orchestrator/SimulationOrchestrator';
import { VerificationEngine } from './VerificationEngine';

/**
 * The audit, and — more importantly — proof that it can fail.
 *
 * A check that cannot produce a negative result proves nothing, so the second half of this suite
 * deliberately breaks each invariant and asserts the verdict flips. "Stale overwrites = 0" is only
 * evidence because a non-zero is reachable (R11.9).
 */

const TOTAL = 80;
const PARTITIONS = 4;
const SEED = 5150;
const JOB = 'BG-DEMO-001';

interface Harness {
  patients: InMemoryPatientRepository;
  jobs: InMemoryJobRepository;
  events: InMemoryEventSink;
  orchestrator: SimulationOrchestrator;
  verifier: VerificationEngine;
}

async function makeHarness(): Promise<Harness> {
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();
  const clock = createManualClock();
  const events = new InMemoryEventSink(clock, 100_000);

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
      batchSize: 10,
      maxReevaluationAttempts: 3,
    },
  });

  const verifier = new VerificationEngine({ patients, jobs, events, clock });

  return { patients, jobs, events, orchestrator, verifier };
}

/** Runs a clean backfill to completion, leaving state that should verify safe. */
async function runCleanBackfill(harness: Harness): Promise<void> {
  await harness.orchestrator.start({}, { autoAdvance: false });
  await harness.orchestrator.runToCompletion();
}

function check(report: VerificationReport, id: VerificationCheckId) {
  return report.checks.find((entry) => entry.id === id)!;
}

// ====================================================================== the clean case

describe('VerificationEngine on a clean run', () => {
  let harness: Harness;
  let report: VerificationReport;

  beforeEach(async () => {
    harness = await makeHarness();
    await runCleanBackfill(harness);
    report = await harness.verifier.verify(JOB);
  });

  it('returns VERIFIED_SAFE with every check passing', () => {
    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(report.checks).toHaveLength(6);
    for (const entry of report.checks) {
      expect(entry.passed, `${entry.id} should pass: ${entry.detail}`).toBe(true);
      expect(entry.offendingPatientCodes).toEqual([]);
    }
  });

  it('reports 100% coverage with no missed records', () => {
    expect(report.metrics.eligibleRecords).toBe(TOTAL);
    expect(report.metrics.consideredRecords).toBe(TOTAL);
    expect(report.metrics.missedRecords).toBe(0);
    expect(report.metrics.coveragePercent).toBe(100);
  });

  it('reports zero on both safety metrics', () => {
    expect(report.metrics.staleOverwrites).toBe(0);
    expect(report.metrics.lostOnlineUpdates).toBe(0);
    expect(report.metrics.inconsistentRecords).toBe(0);
  });

  it('carries the plain-language guarantee statement', () => {
    expect(report.guaranteeStatement).toContain('Every eligible record was considered');
    expect(report.guaranteeStatement).toContain('No newer online update was overwritten');
  });

  it('includes the job identity and dataset description', () => {
    expect(report.jobId).toBe(JOB);
    expect(report.seed).toBe(SEED);
    expect(report.datasetDescription).toContain(String(TOTAL));
    expect(report.verifiedAt).toBeTruthy();
  });

  it('explains the method behind every check', () => {
    // A reviewer has to be able to judge whether a check is actually independent.
    for (const entry of report.checks) {
      expect(entry.method.length).toBeGreaterThan(20);
      expect(entry.detail.length).toBeGreaterThan(10);
    }
  });

  it('emits VERIFICATION_STARTED then VERIFICATION_PASSED', () => {
    expect(harness.events.countOfType(EVENT_TYPE.VERIFICATION_STARTED)).toBe(1);
    expect(harness.events.countOfType(EVENT_TYPE.VERIFICATION_PASSED)).toBe(1);
    expect(harness.events.countOfType(EVENT_TYPE.VERIFICATION_FAILED)).toBe(0);
    expect(harness.events.ofType(EVENT_TYPE.VERIFICATION_PASSED)[0]!.message).toContain(
      'VERIFIED SAFE',
    );
  });

  it('does not consult engine counters', async () => {
    /**
     * Independence, demonstrated rather than asserted.
     *
     * Corrupting the job row's counters to nonsense must not change a single verified number, because
     * the audit derives everything from patient rows and ledgers.
     */
    await harness.jobs.saveCounters(JOB, {
      processed: 999_999,
      applied: 0,
      noopAlreadyCurrent: 0,
      conflicts: 12_345,
      reevaluated: 0,
      protectedUpdates: 0,
      staleBlocked: 0,
      failed: 777,
      currentPartition: 0,
      currentRecordIndex: 0,
    });

    const second = await harness.verifier.verify(JOB);

    expect(second.metrics).toEqual(report.metrics);
    expect(second.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
  });
});

// ====================================================================== falsifiability

describe('VerificationEngine falsifiability (R11.9)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness();
    await runCleanBackfill(harness);
    // Confirm the baseline is clean, so a later failure is attributable to the injected fault alone.
    expect((await harness.verifier.verify(JOB)).verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
  });

  it('C1 fails when a consideration ledger entry is missing', async () => {
    const target = (await harness.patients.findByCode('P0007'))!;
    harness.patients.deleteConsiderationForTest(JOB, target.id);

    const report = await harness.verifier.verify(JOB);

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFICATION_FAILED);
    const c1 = check(report, VERIFICATION_CHECK.C1_COVERAGE);
    expect(c1.passed).toBe(false);
    expect(c1.offendingPatientCodes).toContain('P0007');
    expect(report.metrics.missedRecords).toBe(1);
    expect(report.metrics.coveragePercent).toBeLessThan(100);
  });

  it('C2 fails when an unguarded stale write is injected', async () => {
    /**
     * The headline safety check, falsified.
     *
     * Uses the same unguarded whole-row path the naive engine uses, so this is not a synthetic ledger
     * edit — it is a genuine stale overwrite performed through the repository.
     */
    const target = (await harness.patients.findByCode('P0011'))!;

    // A doctor moves the record forward.
    await harness.patients.applyOnlineUpdate(
      target.id,
      target.version,
      { glucose: 260 },
      ACTOR_TYPE.DOCTOR,
      UPDATE_SOURCE.MANUAL,
    );

    // Then a stale computation is written over it without a version predicate.
    await harness.patients.applyUnguardedWholeRow(
      target.id,
      {
        age: target.age,
        bloodPressureSystolic: target.bloodPressureSystolic,
        bloodPressureDiastolic: target.bloodPressureDiastolic,
        heartRate: target.heartRate,
        glucose: target.glucose,
        diagnosis: target.diagnosis,
      },
      { riskScore: 42, riskLevel: RISK_LEVEL.MEDIUM, backfillStatus: BACKFILL_STATUS.COMPLETED },
      target.version,
      { jobId: JOB, phase: 'INJECTED', scoreWritten: 42 },
    );

    const report = await harness.verifier.verify(JOB);

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFICATION_FAILED);
    const c2 = check(report, VERIFICATION_CHECK.C2_NO_STALE_OVERWRITE);
    expect(c2.passed).toBe(false);
    expect(c2.offendingPatientCodes).toContain('P0011');
    expect(report.metrics.staleOverwrites).toBeGreaterThan(0);
    // The unguarded write is also called out in the detail text.
    expect(c2.detail).toContain('no version predicate');
  });

  it('C3 fails when a clinical value written by an update is reverted', async () => {
    const target = (await harness.patients.findByCode('P0013'))!;

    await harness.patients.applyOnlineUpdate(
      target.id,
      target.version,
      { glucose: 265 },
      ACTOR_TYPE.LAB,
      UPDATE_SOURCE.MANUAL,
    );

    // Revert it behind the audit's back, as a whole-row write-back would.
    harness.patients.forceClinicalValueForTest(target.id, 'glucose', target.glucose);

    const report = await harness.verifier.verify(JOB);

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFICATION_FAILED);
    const c3 = check(report, VERIFICATION_CHECK.C3_NO_LOST_ONLINE_UPDATE);
    expect(c3.passed).toBe(false);
    expect(c3.offendingPatientCodes).toContain('P0013');
    expect(report.metrics.lostOnlineUpdates).toBe(1);
  });

  it('C3 tolerates two updates touching different fields', async () => {
    /**
     * Guards against the false positive a per-update comparison would produce: the newest update
     * mentions only one field, and the earlier field write must still be verified.
     */
    const target = (await harness.patients.findByCode('P0015'))!;

    await harness.patients.applyOnlineUpdate(
      target.id,
      target.version,
      { glucose: 250 },
      ACTOR_TYPE.LAB,
      UPDATE_SOURCE.MANUAL,
    );
    const mid = (await harness.patients.findById(target.id))!;
    await harness.patients.applyOnlineUpdate(
      mid.id,
      mid.version,
      { heartRate: 130 },
      ACTOR_TYPE.NURSE,
      UPDATE_SOURCE.MANUAL,
    );

    const report = await harness.verifier.verify(JOB);
    const c3 = check(report, VERIFICATION_CHECK.C3_NO_LOST_ONLINE_UPDATE);

    expect(c3.passed).toBe(true);
    expect(report.metrics.lostOnlineUpdates).toBe(0);
  });

  it('C4 fails when a stored score is corrupted', async () => {
    // The check that would catch a stale write even if every ledger looked clean, because it redoes the
    // arithmetic from the row itself.
    const target = (await harness.patients.findByCode('P0019'))!;
    harness.patients.forceScoreForTest(target.id, (target.riskScore ?? 0) + 7);

    const report = await harness.verifier.verify(JOB);

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFICATION_FAILED);
    const c4 = check(report, VERIFICATION_CHECK.C4_DERIVED_CONSISTENCY);
    expect(c4.passed).toBe(false);
    expect(c4.offendingPatientCodes).toContain('P0019');
    expect(report.metrics.inconsistentRecords).toBe(1);
  });

  it('C5 fails when a completed record has a mislabelled level', async () => {
    const target = (await harness.patients.findByCode('P0021'))!;
    // Score stays valid but the level no longer matches its band.
    harness.patients.forceLevelForTest(target.id, RISK_LEVEL.LOW);

    const report = await harness.verifier.verify(JOB);
    const c5 = check(report, VERIFICATION_CHECK.C5_VALID_OUTPUTS);

    // A mislabelled level breaks both the band check and the recomputation check, which is expected:
    // they inspect the same fact from different angles.
    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFICATION_FAILED);
    expect(c5.passed).toBe(false);
    expect(c5.offendingPatientCodes).toContain('P0021');
  });

  it('C6 fails when a conflict is left pending', async () => {
    const target = (await harness.patients.findByCode('P0023'))!;

    await harness.patients.recordConflict({
      jobId: JOB,
      patientId: target.id,
      sourceVersion: 1,
      currentVersion: 2,
      oldScore: 50,
      changedFields: [{ field: 'glucose', from: 100, to: 200 }],
    });

    const report = await harness.verifier.verify(JOB);

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFICATION_FAILED);
    const c6 = check(report, VERIFICATION_CHECK.C6_CONFLICTS_RESOLVED);
    expect(c6.passed).toBe(false);
    expect(c6.offendingPatientCodes).toContain('P0023');
  });

  it('C6 fails when a record is left in the transient PROTECTED state', async () => {
    // PROTECTED marks a blocked write awaiting re-evaluation. Surviving to the end means re-evaluation
    // never completed — a real gap, even though nothing unsafe was written.
    const target = (await harness.patients.findByCode('P0025'))!;
    await harness.patients.markStatus(target.id, BACKFILL_STATUS.PROTECTED);

    const report = await harness.verifier.verify(JOB);
    const c6 = check(report, VERIFICATION_CHECK.C6_CONFLICTS_RESOLVED);

    expect(c6.passed).toBe(false);
    expect(c6.offendingPatientCodes).toContain('P0025');
  });

  it('names the failing checks in the emitted event', async () => {
    const target = (await harness.patients.findByCode('P0027'))!;
    harness.patients.deleteConsiderationForTest(JOB, target.id);

    await harness.verifier.verify(JOB);

    const failed = harness.events.ofType(EVENT_TYPE.VERIFICATION_FAILED).pop()!;
    expect(failed.message).toContain('VERIFICATION FAILED');
    expect(failed.message).toContain('Every eligible record was considered');
  });
});

// ====================================================================== drift

describe('post-consideration drift (R11.8)', () => {
  it('reports drift without failing the verdict', async () => {
    /**
     * A record scored correctly and then updated afterwards satisfies both halves of the guarantee: it
     * was considered, and nothing stale was written over it. Its score is simply older than the newest
     * reading, which is inherent to backfilling a live system.
     *
     * Failing the run for this would be misleading, and a single stray manual update after completion
     * would turn an otherwise correct demo red.
     */
    const harness = await makeHarness();
    await runCleanBackfill(harness);

    const target = (await harness.patients.findByCode('P0030'))!;
    await harness.patients.applyOnlineUpdate(
      target.id,
      target.version,
      { glucose: 275 },
      ACTOR_TYPE.LAB,
      UPDATE_SOURCE.MANUAL,
    );

    const report = await harness.verifier.verify(JOB);

    expect(report.metrics.postConsiderationDrift).toBe(1);
    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(report.metrics.staleOverwrites).toBe(0);
    expect(report.metrics.lostOnlineUpdates).toBe(0);
  });

  it('does not count an update that preceded its record being considered', async () => {
    // A mid-flight update that caused a conflict was resolved *before* the final decision, so it is
    // contention rather than drift.
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.tickOnce();
    await harness.orchestrator.tickOnce();

    const staged = harness.orchestrator.getEngine()!.inFlightCodes();
    const victim = (await harness.patients.findByCode(staged[0]!))!;
    await harness.patients.applyOnlineUpdate(
      victim.id,
      victim.version,
      { glucose: 268 },
      ACTOR_TYPE.DOCTOR,
      UPDATE_SOURCE.SCRIPTED,
    );

    await harness.orchestrator.runToCompletion();

    const report = await harness.verifier.verify(JOB);

    expect(report.metrics.conflicts).toBeGreaterThan(0);
    expect(report.metrics.postConsiderationDrift).toBe(0);
    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
  });
});

// ====================================================================== after recovery

describe('VerificationEngine after crash and recovery', () => {
  it('verifies safe once the full crash scenario has been recovered', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });

    // Reach a point where a checkpoint exists and results are staged but unwritten.
    for (let i = 0; i < 400; i += 1) {
      const engine = harness.orchestrator.getEngine()!;
      if (
        harness.events.countOfType(EVENT_TYPE.CHECKPOINT_CREATED) >= 1 &&
        engine.inFlightCount() >= 5
      ) {
        break;
      }
      if (!(await harness.orchestrator.tickOnce())) break;
    }

    const stagedCodes = harness.orchestrator.getEngine()!.inFlightCodes();
    await harness.orchestrator.crash();

    // Clinical staff keep working during the outage.
    for (const code of stagedCodes.slice(0, 2)) {
      const patient = (await harness.patients.findByCode(code))!;
      await harness.patients.applyOnlineUpdate(
        patient.id,
        patient.version,
        { glucose: 258 },
        ACTOR_TYPE.LAB,
        UPDATE_SOURCE.SCRIPTED,
      );
    }

    await harness.orchestrator.loseCheckpoint();
    await harness.orchestrator.recover();

    const report = await harness.verifier.verify(JOB);

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(report.metrics.coveragePercent).toBe(100);
    expect(report.metrics.missedRecords).toBe(0);
    expect(report.metrics.staleOverwrites).toBe(0);
    expect(report.metrics.lostOnlineUpdates).toBe(0);
    expect(report.metrics.staleWriteAttemptsBlocked).toBeGreaterThan(0);
    expect(report.metrics.reevaluated).toBeGreaterThan(0);
  });
});

// ====================================================================== state machine

describe('verification through the orchestrator', () => {
  it('sets VERIFIED_SAFE on the job after a clean run', async () => {
    const harness = await makeHarness();
    await runCleanBackfill(harness);

    const report = await harness.orchestrator.runVerification();

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.VERIFIED_SAFE);
    expect(harness.orchestrator.getLastReport()).not.toBeNull();
  });

  it('sets VERIFICATION_FAILED when a check fails', async () => {
    const harness = await makeHarness();
    await runCleanBackfill(harness);

    const target = (await harness.patients.findByCode('P0009'))!;
    harness.patients.forceScoreForTest(target.id, 3);

    const report = await harness.orchestrator.runVerification();

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFICATION_FAILED);
    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.VERIFICATION_FAILED);
  });

  it('refuses to verify a job that is still running', async () => {
    const harness = await makeHarness();
    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.tickOnce();

    await expect(harness.orchestrator.runVerification()).rejects.toThrow(/Cannot run verification/);
  });

  it('allows re-verifying an already verified job', async () => {
    const harness = await makeHarness();
    await runCleanBackfill(harness);

    await harness.orchestrator.runVerification();
    const second = await harness.orchestrator.runVerification();

    expect(second.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
  });

  it('reports the same numbers on repeated verification', async () => {
    // The audit is a pure function of stored state, so running it twice must agree.
    const harness = await makeHarness();
    await runCleanBackfill(harness);

    const first = await harness.verifier.verify(JOB);
    const second = await harness.verifier.verify(JOB);

    expect(second.metrics).toEqual(first.metrics);
    expect(second.checks.map((c) => `${c.id}:${c.passed}`)).toEqual(
      first.checks.map((c) => `${c.id}:${c.passed}`),
    );
  });
});
