import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  BACKFILL_STATUS,
  NOTIFICATION_REASON,
  NOTIFICATION_STATUS,
  RISK_LEVEL,
  UPDATE_SOURCE,
  type Patient,
  type RiskLevel,
} from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { InMemoryEventSink } from '../events/InMemoryEventSink';
import { DemoWhatsAppProvider } from '../notification/DemoWhatsAppProvider';
import { generatePatients } from '../seed/patientGenerator';
import { InMemoryNotificationRepository } from './InMemoryNotificationRepository';
import { InMemoryPatientRepository } from './InMemoryPatientRepository';
import { NotifyingPatientRepository } from './NotifyingPatientRepository';
import { NotificationService } from '../../domain/notification/NotificationService';
import type { ClinicalSnapshot, PendingResultWrite } from '../../domain/ports/PatientRepository';

/**
 * Behaviour of the notification decorator around the guarded write.
 *
 * These tests are written against the *port*, not against a running simulation, because the property being
 * checked is a property of the write path: an alert is transmitted if and only if the database accepted the
 * result at the version it was computed from. Driving a full backfill would exercise the same code with far more
 * moving parts and a much weaker assertion.
 *
 * The stale case in particular is set up by hand. In a real run a refusal depends on an online update landing
 * between the read and the write, which is a race; here the version is moved on purpose, so the test asserts the
 * guarantee rather than hoping to observe it.
 */

const JOB = 'NOTIFY-JOB';
const LEDGER = {
  jobId: JOB,
  guarded: true,
  wroteSourceFields: false,
  phase: 'INITIAL',
  scoreWritten: null,
};

const HIGH = { riskScore: 82, riskLevel: RISK_LEVEL.HIGH, backfillStatus: BACKFILL_STATUS.COMPLETED };
const MEDIUM = { riskScore: 45, riskLevel: RISK_LEVEL.MEDIUM, backfillStatus: BACKFILL_STATUS.COMPLETED };
const LOW = { riskScore: 12, riskLevel: RISK_LEVEL.LOW, backfillStatus: BACKFILL_STATUS.COMPLETED };

const snapshotOf = (patient: Patient): ClinicalSnapshot => ({
  age: patient.age,
  bloodPressureSystolic: patient.bloodPressureSystolic,
  bloodPressureDiastolic: patient.bloodPressureDiastolic,
  heartRate: patient.heartRate,
  glucose: patient.glucose,
  diagnosis: patient.diagnosis,
});

const stagedFor = (
  patient: Patient,
  derived: { riskScore: number; riskLevel: RiskLevel },
): PendingResultWrite => ({
  jobId: JOB,
  patientId: patient.id,
  sourceVersion: patient.version,
  computedScore: derived.riskScore,
  computedLevel: derived.riskLevel,
  inputSnapshot: snapshotOf(patient),
});

describe('NotifyingPatientRepository', () => {
  let inner: InMemoryPatientRepository;
  let store: InMemoryNotificationRepository;
  let provider: DemoWhatsAppProvider;
  let events: InMemoryEventSink;
  let repository: NotifyingPatientRepository;
  let service: NotificationService;

  beforeEach(async () => {
    inner = new InMemoryPatientRepository();
    await inner.replaceAll(generatePatients({ totalRecords: 20, partitionCount: 2, seed: 7 }));

    store = new InMemoryNotificationRepository();
    provider = new DemoWhatsAppProvider();
    events = new InMemoryEventSink(createManualClock());

    service = new NotificationService({ notifications: store, provider, events });
    repository = new NotifyingPatientRepository(inner, service);
  });

  const target = async (index: number) => {
    const patients = await inner.findByPartition(0);
    return patients[index]!;
  };

  /**
   * How many alerts were actually transmitted.
   *
   * Counted from persisted `SENT` rows rather than from a spy on the provider. The provider keeps no outbox by
   * design, and this is the better assertion regardless: a row reaches `SENT` only after the provider returned a
   * message id, so it proves both that the send happened and that its outcome was recorded.
   */
  const sentCount = async () =>
    (await service.list({ status: NOTIFICATION_STATUS.SENT })).length;

  /** Moves a record on, the way a clinician's edit would mid-run. */
  const bumpVersion = async (patient: Patient) => {
    await inner.applyOnlineUpdate(
      patient.id,
      patient.version,
      { bloodPressureSystolic: patient.bloodPressureSystolic + 25 },
      ACTOR_TYPE.DOCTOR,
      UPDATE_SOURCE.MANUAL,
    );
  };

  // ---------------------------------------------------------------- risk band gating

  it('sends nothing for a committed LOW result', async () => {
    const patient = await target(0);

    const result = await repository.applyGuarded(patient.id, patient.version, LOW, LEDGER);

    expect(result.applied).toBe(true);
    expect(await service.list({})).toHaveLength(0);
  });

  it('sends nothing for a committed MEDIUM result', async () => {
    const patient = await target(1);

    const result = await repository.applyGuarded(patient.id, patient.version, MEDIUM, LEDGER);

    expect(result.applied).toBe(true);
    expect(await service.list({})).toHaveLength(0);
  });

  it('sends exactly one alert for a committed HIGH result', async () => {
    const patient = await target(2);

    const result = await repository.applyGuarded(patient.id, patient.version, HIGH, LEDGER);
    expect(result.applied).toBe(true);

    const records = await service.list({});
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe(NOTIFICATION_STATUS.SENT);
    expect(records[0]!.patientCode).toBe(patient.patientCode);
    expect(records[0]!.patientVersion).toBe(patient.version);
    expect(records[0]!.reason).toBe(NOTIFICATION_REASON.HIGH_RISK_DETECTED);
    expect(records[0]!.providerMessageId).toMatch(/^DEMO-WA-\d{6}$/);
  });

  // ---------------------------------------------------------------- the core safety property

  it('sends nothing when the version guard refuses a stale write', async () => {
    const patient = await target(3);
    const staleVersion = patient.version;

    // A HIGH result is computed and staged against the version just read.
    await repository.stagePendingResults([stagedFor(patient, HIGH)]);

    // Queued, but deliberately not transmitted.
    const queued = await service.list({});
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe(NOTIFICATION_STATUS.QUEUED);
    expect(await sentCount()).toBe(0);

    // A clinician moves the record before the backfill writes.
    await bumpVersion(patient);

    const result = await repository.applyGuarded(patient.id, staleVersion, HIGH, LEDGER);

    expect(result.applied).toBe(false);
    expect(await sentCount()).toBe(0);

    const after = await service.list({});
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe(NOTIFICATION_STATUS.CANCELLED);
    expect(after[0]!.reason).toBe(NOTIFICATION_REASON.STALE_NOTIFICATION_CANCELLED);
  });

  it('sends one alert at the new version after a stale attempt is re-evaluated', async () => {
    const patient = await target(4);
    const staleVersion = patient.version;

    await repository.stagePendingResults([stagedFor(patient, HIGH)]);
    await bumpVersion(patient);

    // First attempt refused at the stale version.
    await repository.applyGuarded(patient.id, staleVersion, HIGH, LEDGER);
    expect(await sentCount()).toBe(0);

    // Re-evaluated against the version the record actually reached.
    const current = (await inner.findById(patient.id))!;
    const applied = await repository.applyGuarded(patient.id, current.version, HIGH, {
      ...LEDGER,
      phase: 'RECOVERY',
    });

    expect(applied.applied).toBe(true);
    expect(await sentCount()).toBe(1);

    const sent = await service.list({ status: NOTIFICATION_STATUS.SENT });
    expect(sent[0]!.patientVersion).toBe(current.version);
    expect(sent[0]!.reason).toBe(NOTIFICATION_REASON.HIGH_RISK_RECALCULATED);

    // The stale one is still visible as prevented, not deleted.
    const cancelled = await service.list({ status: NOTIFICATION_STATUS.CANCELLED });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.patientVersion).toBe(staleVersion);
  });

  // ---------------------------------------------------------------- duplicate suppression

  it('does not send twice when the same result is committed again at the same version', async () => {
    const patient = await target(5);

    await repository.applyGuarded(patient.id, patient.version, HIGH, LEDGER);
    expect(await sentCount()).toBe(1);

    // Recovery revisiting a record it could not account for: same job, patient, version and band.
    const committedVersion = (await inner.findById(patient.id))!.version;
    await repository.applyGuarded(patient.id, committedVersion, HIGH, {
      ...LEDGER,
      phase: 'RECOVERY',
    });

    expect(await sentCount()).toBe(1);
    expect(await service.list({})).toHaveLength(1);
  });

  it('promotes the staged row rather than creating a second one on commit', async () => {
    const patient = await target(6);

    await repository.stagePendingResults([stagedFor(patient, HIGH)]);
    const queuedId = (await service.list({}))[0]!.id;

    await repository.applyGuarded(patient.id, patient.version, HIGH, LEDGER);

    const records = await service.list({});
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(queuedId);
    expect(records[0]!.status).toBe(NOTIFICATION_STATUS.SENT);
  });

  // ---------------------------------------------------------------- crash semantics

  it('leaves nothing sent when results are staged but never committed', async () => {
    const patients = await inner.findByPartition(0);

    await repository.stagePendingResults(
      patients.slice(0, 3).map((patient) => stagedFor(patient, HIGH)),
    );

    // Simulates the crash: no applyGuarded follows.
    expect(await sentCount()).toBe(0);

    const records = await service.list({});
    expect(records).toHaveLength(3);
    expect(records.every((record) => record.status === NOTIFICATION_STATUS.QUEUED)).toBe(true);
  });

  it('ignores staged results below the HIGH band', async () => {
    const patient = await target(7);

    await repository.stagePendingResults([stagedFor(patient, MEDIUM)]);

    expect(await service.list({})).toHaveLength(0);
  });

  // ---------------------------------------------------------------- the unsafe path is not observed

  it('raises no alert for an unguarded whole-row write', async () => {
    const patient = await target(8);

    await repository.applyUnguardedWholeRow(
      patient.id,
      snapshotOf(patient),
      HIGH,
      patient.version,
      { jobId: JOB, phase: 'INITIAL', scoreWritten: HIGH.riskScore },
    );

    expect(await service.list({})).toHaveLength(0);
  });

  // ---------------------------------------------------------------- lifecycle

  it('clears a job\u2019s notifications alongside its run evidence', async () => {
    const patient = await target(9);
    await repository.applyGuarded(patient.id, patient.version, HIGH, LEDGER);
    expect(await service.list({})).toHaveLength(1);

    await repository.clearRunEvidence(JOB);

    expect(await service.list({})).toHaveLength(0);
  });

  it('clears every notification when the simulation is reset', async () => {
    const patient = await target(0);
    await repository.applyGuarded(patient.id, patient.version, HIGH, LEDGER);

    await repository.clearSimulationState();

    expect(await service.list({})).toHaveLength(0);
  });

  // ---------------------------------------------------------------- failure isolation

  it('still applies the write when the notification layer throws', async () => {
    const patient = await target(0);

    const brokenStore = new InMemoryNotificationRepository();
    brokenStore.createOrGet = async () => {
      throw new Error('notification store unavailable');
    };

    const guarded = new NotifyingPatientRepository(
      inner,
      new NotificationService({ notifications: brokenStore, provider, events }),
    );

    const result = await guarded.applyGuarded(patient.id, patient.version, HIGH, LEDGER);

    // The point: persistence succeeded even though alerting did not.
    expect(result.applied).toBe(true);
    expect((await inner.findById(patient.id))!.riskLevel).toBe(RISK_LEVEL.HIGH);
  });
});
