import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  BACKFILL_STATUS,
  CONSIDERATION_OUTCOME,
  DIAGNOSIS,
  RISK_LEVEL,
  UPDATE_SOURCE,
  type Patient,
} from '@bg/shared';
import type { PatientRepository } from '../../domain/ports/PatientRepository';
import { generatePatients } from '../seed/patientGenerator';

/**
 * One contract, both adapters (task 2.4).
 *
 * The SQLite and in-memory repositories back the production app and the test/comparison paths
 * respectively. If their semantics drift, every conclusion the test suite reaches about safety stops
 * applying to the real system. So both are held to exactly these assertions.
 *
 * The subtle behaviours this pins down are the ones a reimplementation would plausibly get wrong:
 * that a guarded write leaves `version` and clinical fields alone, that a failed guard reports the
 * true current version, that a zero-change online update does not consume a version, and that
 * re-deciding a record updates its ledger entry instead of adding a second one.
 */

export interface ContractHarness {
  name: string;
  create: () => Promise<PatientRepository>;
  /**
   * Creates the parent job row the ledgers reference.
   *
   * The SQLite schema enforces a real foreign key from the write and consideration ledgers to
   * `BackfillJob`, which is deliberate: it makes orphaned ledger rows impossible, and orphaned ledger
   * rows would corrupt exactly the coverage and safety numbers this project claims. So the contract
   * has to establish a job first, the same way the running system does. The in-memory adapter has no
   * referential integrity to satisfy and no-ops.
   */
  ensureJob?: (jobId: string) => Promise<void>;
  /** Called after each test; used by the SQLite adapter to clean up between cases. */
  teardown?: () => Promise<void>;
}

const JOB = 'CONTRACT-JOB';

const LEDGER = { jobId: JOB, guarded: true, wroteSourceFields: false, phase: 'INITIAL', scoreWritten: null };

export function runPatientRepositoryContract(harness: ContractHarness): void {
  describe(`PatientRepository contract: ${harness.name}`, () => {
    let repository: PatientRepository;
    let patients: Patient[];

    beforeEach(async () => {
      repository = await harness.create();

      await repository.replaceAll(
        generatePatients({ totalRecords: 30, partitionCount: 3, seed: 4242 }),
      );

      // Ledger writes reference a job; both job ids used below must exist before they are written to.
      await harness.ensureJob?.(JOB);
      await harness.ensureJob?.('OTHER-JOB');

      patients = (await repository.findPage({ page: 1, pageSize: 100 })).items;
    });

    // Registered unconditionally so the hook is always set up during collection; adapters without
    // external resources simply supply no teardown.
    afterEach(async () => {
      await harness.teardown?.();
    });

    // ------------------------------------------------------------------ reads

    it('seeds the requested number of patients', async () => {
      expect(await repository.countAll()).toBe(30);
      expect(patients).toHaveLength(30);
    });

    it('finds a patient by id and by code', async () => {
      const first = patients[0]!;
      expect((await repository.findById(first.id))?.patientCode).toBe(first.patientCode);
      expect((await repository.findByCode(first.patientCode))?.id).toBe(first.id);
    });

    it('returns null rather than throwing for a missing patient', async () => {
      expect(await repository.findById(999_999)).toBeNull();
      expect(await repository.findByCode('P9999')).toBeNull();
    });

    it('returns partitions ordered by id so a scan is resumable', async () => {
      const partition = await repository.findByPartition(1);
      expect(partition).toHaveLength(10);
      expect(partition.every((p) => p.partitionIndex === 1)).toBe(true);
      expect(partition.map((p) => p.id)).toEqual([...partition.map((p) => p.id)].sort((a, b) => a - b));
    });

    it('paginates with correct totals', async () => {
      const page2 = await repository.findPage({ page: 2, pageSize: 10 });
      expect(page2.items).toHaveLength(10);
      expect(page2.total).toBe(30);
      expect(page2.totalPages).toBe(3);
      expect(page2.items[0]!.id).toBe(patients[10]!.id);
    });

    it('filters by status, partition and free text', async () => {
      const pending = await repository.findPage({
        page: 1,
        pageSize: 100,
        status: BACKFILL_STATUS.PENDING,
      });
      expect(pending.total).toBe(30);

      const partitioned = await repository.findPage({ page: 1, pageSize: 100, partitionIndex: 2 });
      expect(partitioned.total).toBe(10);

      const byCode = await repository.findPage({
        page: 1,
        pageSize: 100,
        q: patients[3]!.patientCode,
      });
      expect(byCode.total).toBe(1);
      expect(byCode.items[0]!.patientCode).toBe(patients[3]!.patientCode);
    });

    it('lists all ids in ascending order', async () => {
      const ids = await repository.allIds();
      expect(ids).toHaveLength(30);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });

    it('counts by status', async () => {
      const counts = await repository.countByStatus();
      expect(counts[BACKFILL_STATUS.PENDING]).toBe(30);
    });

    // ------------------------------------------------------------------ guarded write

    it('applies a guarded write when the version still matches', async () => {
      const target = patients[0]!;

      const result = await repository.applyGuarded(
        target.id,
        target.version,
        { riskScore: 72, riskLevel: RISK_LEVEL.HIGH, backfillStatus: BACKFILL_STATUS.COMPLETED },
        LEDGER,
      );

      expect(result.applied).toBe(true);
      expect(result.currentVersion).toBe(target.version);

      const after = await repository.findById(target.id);
      expect(after?.riskScore).toBe(72);
      expect(after?.riskLevel).toBe(RISK_LEVEL.HIGH);
      expect(after?.backfillStatus).toBe(BACKFILL_STATUS.COMPLETED);
      expect(after?.lastBackfillVersion).toBe(target.version);
    });

    it('leaves version and every clinical field untouched on a guarded write', async () => {
      const target = patients[1]!;

      await repository.applyGuarded(
        target.id,
        target.version,
        { riskScore: 40, riskLevel: RISK_LEVEL.MEDIUM, backfillStatus: BACKFILL_STATUS.COMPLETED },
        LEDGER,
      );

      const after = (await repository.findById(target.id))!;
      expect(after.version).toBe(target.version);
      expect(after.glucose).toBe(target.glucose);
      expect(after.heartRate).toBe(target.heartRate);
      expect(after.bloodPressureSystolic).toBe(target.bloodPressureSystolic);
      expect(after.bloodPressureDiastolic).toBe(target.bloodPressureDiastolic);
      expect(after.diagnosis).toBe(target.diagnosis);
      expect(after.age).toBe(target.age);
    });

    it('refuses a stale guarded write and reports the true current version', async () => {
      const target = patients[2]!;
      const staleVersion = target.version;

      await repository.applyOnlineUpdate(
        target.id,
        staleVersion,
        { glucose: 190 },
        ACTOR_TYPE.DOCTOR,
        UPDATE_SOURCE.MANUAL,
      );

      const result = await repository.applyGuarded(
        target.id,
        staleVersion,
        { riskScore: 99, riskLevel: RISK_LEVEL.HIGH, backfillStatus: BACKFILL_STATUS.COMPLETED },
        LEDGER,
      );

      expect(result.applied).toBe(false);
      expect(result.currentVersion).toBe(staleVersion + 1);

      const after = (await repository.findById(target.id))!;
      expect(after.riskScore).toBeNull();
      expect(after.glucose).toBe(190);
    });

    it('records every write attempt in the ledger, applied or not', async () => {
      const target = patients[3]!;

      await repository.applyGuarded(
        target.id,
        target.version,
        { riskScore: 50, riskLevel: RISK_LEVEL.MEDIUM, backfillStatus: BACKFILL_STATUS.COMPLETED },
        LEDGER,
      );
      await repository.applyGuarded(
        target.id,
        target.version + 5,
        { riskScore: 51, riskLevel: RISK_LEVEL.MEDIUM, backfillStatus: BACKFILL_STATUS.COMPLETED },
        LEDGER,
      );

      const ledger = (await repository.listWriteLedger(JOB)).filter((w) => w.patientId === target.id);
      expect(ledger).toHaveLength(2);
      expect(ledger[0]!.applied).toBe(true);
      expect(ledger[0]!.guardVersion).toBe(ledger[0]!.rowVersionAtWrite);
      expect(ledger[1]!.applied).toBe(false);
      expect(ledger[1]!.guardVersion).not.toBe(ledger[1]!.rowVersionAtWrite);
    });

    // ------------------------------------------------------------------ unguarded write

    it('lets the naive path revert clinical values and flags it in the ledger', async () => {
      const target = patients[4]!;
      const staleSnapshot = {
        age: target.age,
        bloodPressureSystolic: target.bloodPressureSystolic,
        bloodPressureDiastolic: target.bloodPressureDiastolic,
        heartRate: target.heartRate,
        glucose: target.glucose,
        diagnosis: target.diagnosis,
      };

      await repository.applyOnlineUpdate(
        target.id,
        target.version,
        { glucose: 210 },
        ACTOR_TYPE.LAB,
        UPDATE_SOURCE.MANUAL,
      );
      expect((await repository.findById(target.id))!.glucose).toBe(210);

      await repository.applyUnguardedWholeRow(
        target.id,
        staleSnapshot,
        { riskScore: 60, riskLevel: RISK_LEVEL.MEDIUM, backfillStatus: BACKFILL_STATUS.COMPLETED },
        target.version,
        { jobId: JOB, phase: 'RECOVERY', scoreWritten: 60 },
      );

      // The newer lab value is gone: this is the failure the guarded path prevents.
      const after = (await repository.findById(target.id))!;
      expect(after.glucose).toBe(staleSnapshot.glucose);
      expect(after.lastBackfillVersion).toBe(target.version);
      expect(after.lastBackfillVersion).toBeLessThan(after.version);

      const entry = (await repository.listWriteLedger(JOB)).find(
        (w) => w.patientId === target.id && !w.guarded,
      )!;
      expect(entry.wroteSourceFields).toBe(true);
      expect(entry.applied).toBe(true);
      expect(entry.guardVersion).not.toBe(entry.rowVersionAtWrite);
    });

    // ------------------------------------------------------------------ online updates

    it('increments version by exactly one and records the field diff', async () => {
      const target = patients[5]!;

      const result = await repository.applyOnlineUpdate(
        target.id,
        target.version,
        { glucose: 190, heartRate: 105 },
        ACTOR_TYPE.DOCTOR,
        UPDATE_SOURCE.SCRIPTED,
      );

      expect(result).not.toBeNull();
      expect(result!.patient.version).toBe(target.version + 1);
      expect(result!.changedFields).toHaveLength(2);

      const glucoseChange = result!.changedFields.find((c) => c.field === 'glucose')!;
      expect(glucoseChange.from).toBe(target.glucose);
      expect(glucoseChange.to).toBe(190);

      const stored = await repository.listOnlineUpdates(target.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.previousVersion).toBe(target.version);
      expect(stored[0]!.newVersion).toBe(target.version + 1);
      expect(stored[0]!.actorType).toBe(ACTOR_TYPE.DOCTOR);
    });

    it('rejects an online update built on a stale version', async () => {
      const target = patients[6]!;
      const stale = target.version;

      await repository.applyOnlineUpdate(
        target.id,
        stale,
        { glucose: 150 },
        ACTOR_TYPE.NURSE,
        UPDATE_SOURCE.MANUAL,
      );

      const second = await repository.applyOnlineUpdate(
        target.id,
        stale,
        { glucose: 160 },
        ACTOR_TYPE.NURSE,
        UPDATE_SOURCE.MANUAL,
      );

      expect(second).toBeNull();
      expect((await repository.findById(target.id))!.glucose).toBe(150);
    });

    it('does not consume a version for a no-op update', async () => {
      // Versions are evidence. Burning one for a write that changed nothing would create phantom
      // conflicts and make the version sequence meaningless.
      const target = patients[7]!;

      const result = await repository.applyOnlineUpdate(
        target.id,
        target.version,
        { glucose: target.glucose },
        ACTOR_TYPE.LAB,
        UPDATE_SOURCE.MANUAL,
      );

      expect(result).not.toBeNull();
      expect(result!.changedFields).toHaveLength(0);
      expect((await repository.findById(target.id))!.version).toBe(target.version);
      expect(await repository.listOnlineUpdates(target.id)).toHaveLength(0);
    });

    it('returns null for an online update to a missing patient', async () => {
      expect(
        await repository.applyOnlineUpdate(
          999_999,
          1,
          { glucose: 100 },
          ACTOR_TYPE.DOCTOR,
          UPDATE_SOURCE.MANUAL,
        ),
      ).toBeNull();
    });

    it('orders stored updates by patient then version', async () => {
      const a = patients[8]!;
      const b = patients[9]!;

      await repository.applyOnlineUpdate(b.id, b.version, { glucose: 141 }, ACTOR_TYPE.LAB, UPDATE_SOURCE.AUTO);
      await repository.applyOnlineUpdate(a.id, a.version, { glucose: 142 }, ACTOR_TYPE.LAB, UPDATE_SOURCE.AUTO);
      await repository.applyOnlineUpdate(a.id, a.version + 1, { glucose: 143 }, ACTOR_TYPE.LAB, UPDATE_SOURCE.AUTO);

      const all = await repository.listOnlineUpdates();
      const relevant = all.filter((u) => u.patientId === a.id || u.patientId === b.id);

      expect(relevant.map((u) => `${u.patientId}:${u.newVersion}`)).toEqual([
        `${a.id}:${a.version + 1}`,
        `${a.id}:${a.version + 2}`,
        `${b.id}:${b.version + 1}`,
      ]);
    });

    // ------------------------------------------------------------------ consideration ledger

    it('records a consideration and counts it toward coverage', async () => {
      const target = patients[10]!;

      await repository.recordConsideration({
        jobId: JOB,
        patientId: target.id,
        outcome: CONSIDERATION_OUTCOME.APPLIED,
        sourceVersion: target.version,
        appliedVersion: target.version,
        attempts: 1,
        phase: 'INITIAL',
        reason: null,
      });

      expect(await repository.consideredPatientIds(JOB)).toEqual([target.id]);
    });

    it('updates rather than duplicates when a record is reconsidered', async () => {
      // Recovery legitimately revisits records. A second row would inflate coverage and could let a
      // job claim 100% while having genuinely missed something.
      const target = patients[11]!;

      await repository.recordConsideration({
        jobId: JOB,
        patientId: target.id,
        outcome: CONSIDERATION_OUTCOME.APPLIED,
        sourceVersion: 1,
        appliedVersion: 1,
        attempts: 1,
        phase: 'INITIAL',
        reason: null,
      });
      await repository.recordConsideration({
        jobId: JOB,
        patientId: target.id,
        outcome: CONSIDERATION_OUTCOME.REEVALUATED_APPLIED,
        sourceVersion: 2,
        appliedVersion: 2,
        attempts: 2,
        phase: 'RECOVERY',
        reason: 'version changed',
      });

      expect(await repository.consideredPatientIds(JOB)).toEqual([target.id]);

      const entries = (await repository.listConsiderations(JOB)).filter(
        (e) => e.patientId === target.id,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]!.outcome).toBe(CONSIDERATION_OUTCOME.REEVALUATED_APPLIED);
      expect(entries[0]!.attempts).toBe(2);
      expect(entries[0]!.phase).toBe('RECOVERY');
    });

    it('scopes ledgers by job', async () => {
      const target = patients[12]!;

      await repository.recordConsideration({
        jobId: 'OTHER-JOB',
        patientId: target.id,
        outcome: CONSIDERATION_OUTCOME.APPLIED,
        sourceVersion: 1,
        appliedVersion: 1,
        attempts: 1,
        phase: 'INITIAL',
        reason: null,
      });

      expect(await repository.consideredPatientIds(JOB)).toEqual([]);
      expect(await repository.consideredPatientIds('OTHER-JOB')).toEqual([target.id]);
    });

    // ------------------------------------------------------------------ per-patient evidence

    it('gathers one patient\'s evidence across jobs and excludes other patients', async () => {
      // Deliberately spans two jobs: a record's history belongs to the record, not to a run, and the
      // per-patient timeline would silently lose evidence if this filtered by the current job.
      const target = patients[17]!;
      const other = patients[18]!;

      await repository.applyOnlineUpdate(
        target.id,
        target.version,
        { glucose: 205 },
        ACTOR_TYPE.LAB,
        UPDATE_SOURCE.SCRIPTED,
      );

      await repository.applyGuarded(
        target.id,
        target.version,
        { riskScore: 44, riskLevel: RISK_LEVEL.MEDIUM, backfillStatus: BACKFILL_STATUS.COMPLETED },
        LEDGER,
      );

      const conflictId = await repository.recordConflict({
        jobId: 'OTHER-JOB',
        patientId: target.id,
        sourceVersion: target.version,
        currentVersion: target.version + 1,
        oldScore: 44,
        changedFields: [{ field: 'glucose', from: target.glucose, to: 205 }],
      });
      await repository.resolveConflict(conflictId, 'REEVALUATED', 59);

      await repository.recordConsideration({
        jobId: 'OTHER-JOB',
        patientId: target.id,
        outcome: CONSIDERATION_OUTCOME.NO_ACTION_ALREADY_CURRENT,
        sourceVersion: target.version + 1,
        appliedVersion: target.version + 1,
        attempts: 1,
        phase: 'RECOVERY',
        reason: null,
      });

      const evidence = await repository.patientEvidence(target.id);

      expect(evidence.onlineUpdates).toHaveLength(1);
      expect(evidence.onlineUpdates[0]!.newVersion).toBe(target.version + 1);

      // The guarded write was refused: it was guarded at a version the online update had already moved.
      expect(evidence.writes).toHaveLength(1);
      expect(evidence.writes[0]!.applied).toBe(false);

      expect(evidence.conflicts).toHaveLength(1);
      expect(evidence.conflicts[0]!.resolution).toBe('REEVALUATED');
      expect(evidence.conflicts[0]!.newScore).toBe(59);
      expect(evidence.conflicts[0]!.patientCode).toBe(target.patientCode);

      expect(evidence.considerations).toHaveLength(1);
      expect(evidence.considerations[0]!.phase).toBe('RECOVERY');

      const untouched = await repository.patientEvidence(other.id);
      expect(untouched.onlineUpdates).toEqual([]);
      expect(untouched.writes).toEqual([]);
      expect(untouched.conflicts).toEqual([]);
      expect(untouched.considerations).toEqual([]);
    });

    // ------------------------------------------------------------------ staged results

    it('stages results and preserves the read-time snapshot and version', async () => {
      const target = patients[13]!;

      await repository.stagePendingResults([
        {
          jobId: JOB,
          patientId: target.id,
          sourceVersion: target.version,
          computedScore: 68,
          computedLevel: RISK_LEVEL.HIGH,
          inputSnapshot: {
            age: target.age,
            bloodPressureSystolic: target.bloodPressureSystolic,
            bloodPressureDiastolic: target.bloodPressureDiastolic,
            heartRate: target.heartRate,
            glucose: target.glucose,
            diagnosis: DIAGNOSIS.DIABETES_TYPE_2,
          },
        },
      ]);

      const staged = await repository.pendingResults(JOB);
      expect(staged).toHaveLength(1);
      expect(staged[0]!.sourceVersion).toBe(target.version);
      expect(staged[0]!.computedScore).toBe(68);
      expect(staged[0]!.state).toBe('PENDING');
      expect(staged[0]!.inputSnapshot.glucose).toBe(target.glucose);
      expect(staged[0]!.inputSnapshot.diagnosis).toBe(DIAGNOSIS.DIABETES_TYPE_2);
    });

    it('filters staged results by state and transitions them', async () => {
      const target = patients[14]!;

      await repository.stagePendingResults([
        {
          jobId: JOB,
          patientId: target.id,
          sourceVersion: target.version,
          computedScore: 30,
          computedLevel: RISK_LEVEL.LOW,
          inputSnapshot: {
            age: target.age,
            bloodPressureSystolic: target.bloodPressureSystolic,
            bloodPressureDiastolic: target.bloodPressureDiastolic,
            heartRate: target.heartRate,
            glucose: target.glucose,
            diagnosis: target.diagnosis,
          },
        },
      ]);

      const [staged] = await repository.pendingResults(JOB, 'PENDING');
      await repository.setPendingResultState(staged!.id, 'REJECTED');

      expect(await repository.pendingResults(JOB, 'PENDING')).toHaveLength(0);
      expect(await repository.pendingResults(JOB, 'REJECTED')).toHaveLength(1);
    });

    it('accepts an empty stage call without error', async () => {
      await expect(repository.stagePendingResults([])).resolves.toBeUndefined();
    });

    // ------------------------------------------------------------------ lifecycle

    it('clears simulation state and returns patients to an unscored baseline', async () => {
      const target = patients[15]!;

      await repository.applyGuarded(
        target.id,
        target.version,
        { riskScore: 80, riskLevel: RISK_LEVEL.HIGH, backfillStatus: BACKFILL_STATUS.COMPLETED },
        LEDGER,
      );
      await repository.recordConsideration({
        jobId: JOB,
        patientId: target.id,
        outcome: CONSIDERATION_OUTCOME.APPLIED,
        sourceVersion: target.version,
        appliedVersion: target.version,
        attempts: 1,
        phase: 'INITIAL',
        reason: null,
      });

      await repository.clearSimulationState();

      const after = (await repository.findById(target.id))!;
      expect(after.riskScore).toBeNull();
      expect(after.riskLevel).toBeNull();
      expect(after.lastBackfillVersion).toBeNull();
      expect(after.backfillStatus).toBe(BACKFILL_STATUS.PENDING);

      expect(await repository.consideredPatientIds(JOB)).toEqual([]);
      expect(await repository.listWriteLedger(JOB)).toEqual([]);
      // The dataset itself survives, so a demo can be replayed against identical starting data.
      expect(await repository.countAll()).toBe(30);
    });

    it('marks status without touching version or clinical data', async () => {
      const target = patients[16]!;
      await repository.markStatus(target.id, BACKFILL_STATUS.PROCESSING);

      const after = (await repository.findById(target.id))!;
      expect(after.backfillStatus).toBe(BACKFILL_STATUS.PROCESSING);
      expect(after.version).toBe(target.version);
      expect(after.glucose).toBe(target.glucose);
    });
  });
}
