import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, JOB_STATUS, VERIFICATION_VERDICT } from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { SimulationOrchestrator } from './SimulationOrchestrator';

/**
 * Restart recovery (design §6).
 *
 * Job status and the cached audit live in memory. Restart the process after a completed run and the database
 * still holds the job row, every ledger and every scored patient — while the application would claim no job
 * had ever been started, and would then *refuse* to verify, because verification is only allowed from a
 * settled state. That is the exact failure these tests pin down.
 *
 * Two repositories are shared across two orchestrators to model the restart: the storage survives, the process
 * does not.
 */

const TOTAL = 60;
const PARTITIONS = 3;

interface Storage {
  patients: InMemoryPatientRepository;
  jobs: InMemoryJobRepository;
}

async function makeStorage(): Promise<Storage> {
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();

  await patients.replaceAll(
    generatePatients({ totalRecords: TOTAL, partitionCount: PARTITIONS, seed: DEFAULT_SEED }),
  );

  return { patients, jobs };
}

/** A fresh orchestrator over existing storage — the "after the restart" process. */
function makeOrchestrator(storage: Storage): SimulationOrchestrator {
  const clock = createManualClock();

  return new SimulationOrchestrator({
    patients: storage.patients,
    jobs: storage.jobs,
    events: new InMemoryEventSink(clock, 50_000),
    clock,
    rng: createRng(DEFAULT_SEED),
    seed: DEFAULT_SEED,
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
}

describe('SimulationOrchestrator.restore', () => {
  it('reports nothing to restore on a first-ever start', async () => {
    const storage = await makeStorage();
    const orchestrator = makeOrchestrator(storage);

    expect(await orchestrator.restore()).toBeNull();
    expect(orchestrator.getStatus()).toBe(JOB_STATUS.IDLE);
    expect((await orchestrator.getState()).metrics).toBeNull();
  });

  it('restores a completed run, with metrics re-derived from the ledger', async () => {
    const storage = await makeStorage();

    const first = makeOrchestrator(storage);
    await first.start({}, { autoAdvance: false });
    await first.runToCompletion();
    expect(first.getStatus()).toBe(JOB_STATUS.COMPLETED);

    const second = makeOrchestrator(storage);
    expect(await second.restore()).toBe(JOB_STATUS.COMPLETED);

    const state = await second.getState();
    expect(state.status).toBe(JOB_STATUS.COMPLETED);
    expect(state.metrics).not.toBeNull();
    expect(state.metrics!.eligibleRecords).toBe(TOTAL);
    expect(state.metrics!.processed).toBe(TOTAL);
    expect(state.metrics!.percentComplete).toBe(100);
    expect(state.completedAt).not.toBeNull();
  });

  it('lets a restored run be verified, which is the whole point', async () => {
    /**
     * The failure this prevents: after a restart the audit of a finished run was unreachable. `/verify/latest`
     * returned 404 and re-running was refused with "cannot verify while IDLE", even though every row the audit
     * reads was still in the database.
     */
    const storage = await makeStorage();

    const first = makeOrchestrator(storage);
    await first.start({}, { autoAdvance: false });
    await first.runToCompletion();

    const second = makeOrchestrator(storage);
    await second.restore();

    const report = await second.runVerification();

    expect(report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(report.metrics.coveragePercent).toBe(100);
    expect(report.metrics.staleOverwrites).toBe(0);
    expect(second.getStatus()).toBe(JOB_STATUS.VERIFIED_SAFE);
  });

  it('leaves an interrupted run at IDLE and says why, rather than pretending it is resumable', async () => {
    /**
     * A job recorded as RUNNING had its engine — batch positions, in-flight window — only in the dead process.
     * Restoring the status would advertise a resume that cannot happen.
     */
    const storage = await makeStorage();

    const first = makeOrchestrator(storage);
    await first.start({}, { autoAdvance: false });
    await first.tickOnce();
    expect(first.getStatus()).toBe(JOB_STATUS.RUNNING);

    const second = makeOrchestrator(storage);
    expect(await second.restore()).toBeNull();
    expect(second.getStatus()).toBe(JOB_STATUS.IDLE);

    const state = await second.getState();
    expect(state.metrics).toBeNull();
    expect(state.failureReason).toMatch(/interrupted while RUNNING/);
    expect(state.failureReason).toMatch(/dataset is intact/);
  });

  it('does not restore a crashed run as resumable', async () => {
    // CRASHED is a live demo state whose meaning depends on staged results the engine held; a new process
    // cannot honour the recover contract, so it must not offer it.
    const storage = await makeStorage();

    const first = makeOrchestrator(storage);
    await first.start({}, { autoAdvance: false });
    await first.tickOnce();
    await first.crash();
    expect(first.getStatus()).toBe(JOB_STATUS.CRASHED);

    const second = makeOrchestrator(storage);
    expect(await second.restore()).toBeNull();
    expect(second.getStatus()).toBe(JOB_STATUS.IDLE);
  });

  it('discards restored metrics once a new run starts', async () => {
    const storage = await makeStorage();

    const first = makeOrchestrator(storage);
    await first.start({}, { autoAdvance: false });
    await first.runToCompletion();

    const second = makeOrchestrator(storage);
    await second.restore();
    expect((await second.getState()).metrics!.processed).toBe(TOTAL);

    await second.start({}, { autoAdvance: false });

    // A fresh run's metrics come from its own engine and ledger, never from the restored snapshot.
    const state = await second.getState();
    expect(state.status).toBe(JOB_STATUS.RUNNING);
    expect(state.metrics!.processed).toBe(0);
  });

  it('clears restored metrics on reset', async () => {
    const storage = await makeStorage();

    const first = makeOrchestrator(storage);
    await first.start({}, { autoAdvance: false });
    await first.runToCompletion();

    const second = makeOrchestrator(storage);
    await second.restore();
    await second.reset();

    const state = await second.getState();
    expect(state.status).toBe(JOB_STATUS.IDLE);
    expect(state.metrics).toBeNull();
  });

  it('restores the settings the run actually used, not the process defaults', async () => {
    const storage = await makeStorage();

    const first = makeOrchestrator(storage);
    await first.start({ batchSize: 7, checkpointInterval: 15 }, { autoAdvance: false });
    await first.runToCompletion();

    const second = makeOrchestrator(storage);
    await second.restore();

    const state = await second.getState();
    expect(state.settings.batchSize).toBe(7);
    expect(state.settings.checkpointInterval).toBe(15);
  });
});
