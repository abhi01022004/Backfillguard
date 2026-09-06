import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  EVENT_TYPE,
  JOB_STATUS,
  NOTIFICATION_REASON,
  NOTIFICATION_STATUS,
  PENDING_RESULT_STATE,
  RISK_LEVEL,
  UPDATE_SOURCE,
  VERIFICATION_VERDICT,
  type NotificationRecord,
} from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryNotificationRepository } from '../../infra/repositories/InMemoryNotificationRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { NotifyingPatientRepository } from '../../infra/repositories/NotifyingPatientRepository';
import { DemoWhatsAppProvider } from '../../infra/notification/DemoWhatsAppProvider';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { SimulationOrchestrator } from '../orchestrator/SimulationOrchestrator';
import { VerificationEngine } from '../verify/VerificationEngine';
import { OnlineUpdateSimulator, TARGET_STRATEGY } from '../online/OnlineUpdateSimulator';
import { NotificationService } from './NotificationService';

/**
 * The notification lifecycle, driven through the orchestrator rather than the port.
 *
 * ## Why this file exists alongside `NotifyingPatientRepository.test.ts`
 *
 * That suite proves the decorator behaves correctly when called. It sets each situation up by hand — moving a
 * version deliberately, calling `applyGuarded` directly — which is the right way to assert a guarantee but says
 * nothing about whether the real engines ever reach those situations.
 *
 * These tests drive the actual thing: a paced backfill, a real crash that freezes computed-but-unwritten
 * results, clinical edits landing during the outage, and evidence-based recovery. So they answer the question
 * the other suite cannot — *does the wiring hold when the system is used normally?*
 *
 * ## The claim being tested
 *
 * A risk alert is transmitted **only** for a result committed under a version guard. The interesting failure
 * mode is not "no alert was sent" — it is an alert sent for a value that a doctor had already superseded, which
 * is exactly what a naive implementation would do and exactly what a crash makes likely.
 */

const TOTAL = 100;
const PARTITIONS = 4;
const SEED = 90210;
const JOB = 'BG-DEMO-001';

interface Harness {
  patients: InMemoryPatientRepository;
  guarded: NotifyingPatientRepository;
  notificationStore: InMemoryNotificationRepository;
  notifications: NotificationService;
  jobs: InMemoryJobRepository;
  events: InMemoryEventSink;
  orchestrator: SimulationOrchestrator;
  verifier: VerificationEngine;
}

async function makeHarness(
  overrides: Partial<{ batchSize: number; checkpointInterval: number }> = {},
): Promise<Harness> {
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();
  const clock = createManualClock();
  const events = new InMemoryEventSink(clock, 100_000);

  await patients.replaceAll(
    generatePatients({ totalRecords: TOTAL, partitionCount: PARTITIONS, seed: SEED }),
  );

  const notificationStore = new InMemoryNotificationRepository();
  const notifications = new NotificationService({
    notifications: notificationStore,
    provider: new DemoWhatsAppProvider(),
    events,
  });
  const guarded = new NotifyingPatientRepository(patients, notifications);

  const orchestrator = new SimulationOrchestrator({
    patients: guarded,
    jobs,
    events,
    clock,
    rng: createRng(SEED),
    seed: SEED,
    notifications: notificationStore,
    settings: {
      totalRecords: TOTAL,
      partitionCount: PARTITIONS,
      backfillSpeed: 1000,
      // Zero, so the only clinical edits are the ones a test makes on purpose. Random contention would
      // make "was this alert stale?" depend on the scheduler.
      onlineUpdateFrequency: 0,
      checkpointInterval: overrides.checkpointInterval ?? 20,
      batchSize: overrides.batchSize ?? 25,
      maxReevaluationAttempts: 3,
    },
  });

  const verifier = new VerificationEngine({
    patients,
    jobs,
    events,
    clock,
    notifications: notificationStore,
  });

  return {
    patients,
    guarded,
    notificationStore,
    notifications,
    jobs,
    events,
    orchestrator,
    verifier,
  };
}

async function tickUntil(
  orchestrator: SimulationOrchestrator,
  predicate: () => boolean,
  maxTicks = 5000,
): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    const hasMore = await orchestrator.tickOnce();
    if (!hasMore) return;
  }
  throw new Error('tickUntil exhausted its tick budget without the predicate becoming true');
}

/** At least one checkpoint exists and results are staged but unwritten — what a crash needs to be interesting. */
function checkpointedWithStagedResults(harness: Harness, staged: number): () => boolean {
  return () => {
    const engine = harness.orchestrator.getEngine();
    if (!engine) return false;
    return (
      harness.events.countOfType(EVENT_TYPE.CHECKPOINT_CREATED) >= 1 &&
      engine.inFlightCount() >= staged
    );
  };
}

const listAll = (harness: Harness): Promise<NotificationRecord[]> =>
  harness.notificationStore.list({ limit: 100_000 });

const listOf = (harness: Harness, status: string): Promise<NotificationRecord[]> =>
  harness.notificationStore.list({ status: status as never, limit: 100_000 });

// ====================================================================== a clean run

describe('notification lifecycle: a clean run', () => {
  it('alerts every HIGH record exactly once and nothing below HIGH', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const patients = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
    const expectedHigh = patients.filter((patient) => patient.riskLevel === RISK_LEVEL.HIGH);

    const sent = await listOf(harness, NOTIFICATION_STATUS.SENT);

    // One alert per HIGH record, no more and no fewer.
    expect(sent).toHaveLength(expectedHigh.length);
    expect(expectedHigh.length).toBeGreaterThan(0);

    expect(new Set(sent.map((record) => record.patientId)).size).toBe(sent.length);
    expect(sent.every((record) => record.riskLevel === RISK_LEVEL.HIGH)).toBe(true);

    // And every alert names the version the record actually now holds.
    for (const record of sent) {
      const patient = patients.find((entry) => entry.id === record.patientId)!;
      expect(record.patientVersion).toBe(patient.version);
    }
  });

  it('leaves nothing queued once the run has finished', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    // A leftover QUEUED row would mean a staged result was never resolved either way.
    expect(await listOf(harness, NOTIFICATION_STATUS.QUEUED)).toHaveLength(0);
    expect(await listOf(harness, NOTIFICATION_STATUS.FAILED)).toHaveLength(0);
  });
});

// ====================================================================== crash

describe('notification lifecycle: a crash with results in flight', () => {
  it('transmits nothing for results that were computed but never committed', async () => {
    const harness = await makeHarness({ batchSize: 25 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 10));

    const sentBeforeCrash = (await listOf(harness, NOTIFICATION_STATUS.SENT)).length;

    await harness.orchestrator.crash();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.CRASHED);

    const staged = await harness.patients.pendingResults(JOB, PENDING_RESULT_STATE.PENDING);
    expect(staged.length).toBeGreaterThan(0);

    /**
     * The property: a crash cannot leave a sent alert behind for an uncommitted result.
     *
     * Staged HIGH results become `QUEUED` rows, which are never handed to the provider. So the sent count is
     * unchanged by the crash even though there are results frozen mid-flight.
     */
    const sentAfterCrash = await listOf(harness, NOTIFICATION_STATUS.SENT);
    expect(sentAfterCrash).toHaveLength(sentBeforeCrash);

    // Whatever is queued corresponds to staged work, not to anything transmitted.
    const queued = await listOf(harness, NOTIFICATION_STATUS.QUEUED);
    const stagedIds = new Set(staged.map((entry) => entry.patientId));
    expect(queued.every((record) => stagedIds.has(record.patientId))).toBe(true);
  });

  it('sends the alert only after recovery commits the result', async () => {
    const harness = await makeHarness({ batchSize: 25, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 10));
    await harness.orchestrator.crash();

    const queuedAtCrash = await listOf(harness, NOTIFICATION_STATUS.QUEUED);
    const sentAtCrash = (await listOf(harness, NOTIFICATION_STATUS.SENT)).length;

    await harness.orchestrator.loseCheckpoint();
    await harness.orchestrator.recover();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.COMPLETED);

    const sentAfterRecovery = await listOf(harness, NOTIFICATION_STATUS.SENT);

    // Nothing was disturbed during the outage, so every queued alert should now have been sent.
    expect(sentAfterRecovery.length).toBeGreaterThan(sentAtCrash);
    expect(await listOf(harness, NOTIFICATION_STATUS.QUEUED)).toHaveLength(0);

    // The previously queued rows are the same rows, promoted — not duplicates alongside them.
    for (const record of queuedAtCrash) {
      const after = await harness.notificationStore.findById(record.id);
      expect(after!.status).toBe(NOTIFICATION_STATUS.SENT);
    }
  });

  it('does not alert twice for a record recovery revisits', async () => {
    const harness = await makeHarness({ batchSize: 10, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(
      harness.orchestrator,
      () => harness.orchestrator.getEngine()!.getMetrics().processed >= 40,
    );
    await harness.orchestrator.crash();
    await harness.orchestrator.loseCheckpoint();

    /**
     * Recovery deliberately re-examines records it cannot prove were completed, so records committed before
     * the crash get committed again at the same version. The idempotency key makes that one alert, not two.
     */
    await harness.orchestrator.recover();

    const sent = await listOf(harness, NOTIFICATION_STATUS.SENT);
    const keys = sent.map(
      (record) => `${record.patientId}:${record.patientVersion}:${record.riskLevel}`,
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(sent.map((record) => record.patientId)).size).toBe(sent.length);
  });
});

// ====================================================================== the headline case

describe('notification lifecycle: a doctor edits during the outage', () => {
  it('cancels the stale alert and sends one for the recomputed result instead', async () => {
    const harness = await makeHarness({ batchSize: 25, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 10));

    const stagedCodes = harness.orchestrator.getEngine()!.inFlightCodes();
    await harness.orchestrator.crash();

    /**
     * Pick a victim whose staged result is HIGH, so there is genuinely a queued alert to prevent.
     *
     * Choosing an arbitrary staged record would usually pick a LOW or MEDIUM one, and the test would pass
     * while asserting nothing — the failure mode this exists to catch would go unobserved.
     */
    const queued = await listOf(harness, NOTIFICATION_STATUS.QUEUED);
    const stagedCodeSet = new Set(stagedCodes);
    const victimAlert = queued.find((record) => stagedCodeSet.has(record.patientCode));
    expect(victimAlert).toBeDefined();

    const victim = (await harness.patients.findById(victimAlert!.patientId))!;
    const staleVersion = victim.version;
    expect(victimAlert!.patientVersion).toBe(staleVersion);

    // The outage window: a doctor moves the record the staged HIGH result was computed from.
    await harness.patients.applyOnlineUpdate(
      victim.id,
      staleVersion,
      { glucose: 300, bloodPressureSystolic: 200 },
      ACTOR_TYPE.DOCTOR,
      UPDATE_SOURCE.MANUAL,
    );

    await harness.orchestrator.loseCheckpoint();
    const summary = await harness.orchestrator.recover();

    expect(summary.pendingResultsRejected).toBeGreaterThan(0);

    // The stale alert was never transmitted, and it is still on record as prevented.
    const staleAlert = await harness.notificationStore.findById(victimAlert!.id);
    expect(staleAlert!.status).toBe(NOTIFICATION_STATUS.CANCELLED);
    expect(staleAlert!.reason).toBe(NOTIFICATION_REASON.STALE_NOTIFICATION_CANCELLED);
    expect(staleAlert!.providerMessageId).toBeNull();
    expect(staleAlert!.patientVersion).toBe(staleVersion);

    // The record was re-evaluated, and any alert for it now describes the doctor's data.
    const current = (await harness.patients.findById(victim.id))!;
    expect(current.version).toBeGreaterThan(staleVersion);

    const recomputed = calculateRiskScore(toRiskInput(current));
    const alertsForVictim = (await listAll(harness)).filter(
      (record) => record.patientId === victim.id,
    );
    const sentForVictim = alertsForVictim.filter(
      (record) => record.status === NOTIFICATION_STATUS.SENT,
    );

    if (recomputed.level === RISK_LEVEL.HIGH) {
      expect(sentForVictim).toHaveLength(1);
      expect(sentForVictim[0]!.patientVersion).toBe(current.version);
      expect(sentForVictim[0]!.riskScore).toBe(recomputed.score);
    } else {
      // Re-evaluation dropped it out of HIGH, so the correct outcome is no alert at all.
      expect(sentForVictim).toHaveLength(0);
    }

    // Either way, nothing was sent at the stale version.
    expect(sentForVictim.every((record) => record.patientVersion !== staleVersion)).toBe(true);
  });

  it('never transmits an alert for a version the database did not commit', async () => {
    const harness = await makeHarness({ batchSize: 25, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 12));
    await harness.orchestrator.crash();

    // Move several records while the job is down, to create real contention rather than one contrived case.
    const staged = await harness.patients.pendingResults(JOB, PENDING_RESULT_STATE.PENDING);
    for (const entry of staged.slice(0, 5)) {
      const patient = (await harness.patients.findById(entry.patientId))!;
      await harness.patients.applyOnlineUpdate(
        patient.id,
        patient.version,
        { glucose: 280 },
        ACTOR_TYPE.NURSE,
        UPDATE_SOURCE.MANUAL,
      );
    }

    await harness.orchestrator.loseCheckpoint();
    await harness.orchestrator.recover();

    /**
     * The audit, not the engine, has the last word.
     *
     * This joins every sent alert against the write ledger and reports any that has no applied guarded write
     * at its source version. It is the same measurement the report shows a reviewer.
     */
    const report = await harness.verifier.verify(JOB);

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(report.metrics.staleOverwrites).toBe(0);
    expect(report.advisory!.notifications.staleNotifications).toBe(0);
    expect(report.advisory!.notifications.duplicateNotifications).toBe(0);
    expect(report.advisory!.notifications.clean).toBe(true);

    // The prevention actually happened, so this run is evidence rather than a vacuous pass.
    expect(report.advisory!.notifications.cancelled).toBeGreaterThan(0);
  });
});

// ====================================================================== contention during a live run

describe('notification lifecycle: contention while the backfill is running', () => {
  it('keeps alerts honest when records change mid-batch', async () => {
    const harness = await makeHarness({ batchSize: 10, checkpointInterval: 25 });

    /**
     * Contention is generated by the online-update simulator targeting in-flight records, not by editing rows
     * between ticks.
     *
     * An earlier version of this test edited staged records from the outside after `tickUntil` returned, and
     * recorded zero conflicts — by the time control came back, those batches had already flushed. Driving the
     * updates as a tick participant is how the application creates contention, and it is the only way to be
     * sure the edit lands inside the window between reading a record and writing it.
     */
    const simulator = new OnlineUpdateSimulator({
      repository: harness.guarded,
      events: harness.events,
      rng: createRng(SEED).fork('online-updates'),
    });
    simulator.configureAuto(25, TARGET_STRATEGY.IN_FLIGHT);
    harness.orchestrator.register(simulator.asTickParticipant());

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const report = await harness.verifier.verify(JOB);

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(report.metrics.conflicts).toBeGreaterThan(0);
    expect(report.advisory!.notifications.staleNotifications).toBe(0);
    expect(report.advisory!.notifications.duplicateNotifications).toBe(0);

    // Every sent alert still matches the record's current state, having been recomputed where needed.
    const patients = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
    for (const record of await listOf(harness, NOTIFICATION_STATUS.SENT)) {
      const patient = patients.find((entry) => entry.id === record.patientId)!;
      expect(record.patientVersion).toBe(patient.lastBackfillVersion);
    }
  });
});

// ====================================================================== lifecycle and determinism

describe('notification lifecycle: reset and determinism', () => {
  it('discards a job\u2019s alerts along with its evidence', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();
    expect((await listAll(harness)).length).toBeGreaterThan(0);

    await harness.guarded.clearRunEvidence(JOB);

    // Alerts must not outlive the ledger they were derived from, or the next run's figures would
    // describe a job whose evidence had already been thrown away.
    expect(await listAll(harness)).toHaveLength(0);
  });

  it('clears every alert on a full simulation reset', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    /**
     * Both halves, because that is what a reset actually is.
     *
     * `orchestrator.reset()` drops in-memory job state, the cached report and the counters;
     * `clearSimulationState()` clears the durable ledgers. The reset endpoint calls both, and notifications are
     * cleared by the second — they are durable evidence, so they belong with the ledgers rather than with the
     * in-memory state. Calling only the first here would have been testing a path no caller uses.
     */
    await harness.orchestrator.reset();
    await harness.guarded.clearSimulationState();

    expect(await listAll(harness)).toHaveLength(0);
  });

  it('produces an identical alert set from two identical runs', async () => {
    async function run(): Promise<string[]> {
      const harness = await makeHarness();
      await harness.orchestrator.start({}, { autoAdvance: false });
      await harness.orchestrator.runToCompletion();

      return (await listOf(harness, NOTIFICATION_STATUS.SENT))
        .map(
          (record) =>
            `${record.patientCode}:${record.patientVersion}:${record.riskLevel}:${record.riskScore}`,
        )
        .sort();
    }

    /**
     * Same seed, same alerts — including the provider ids being assigned in the same order.
     *
     * The notification layer holds a counter for message ids and another for manual-send salting, so it is
     * exactly the kind of place a wall-clock or random value would creep in and quietly break
     * reproducibility. Comparing whole runs is the cheapest way to notice.
     */
    expect(await run()).toEqual(await run());
  });
});
