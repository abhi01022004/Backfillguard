import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, EVENT_TYPE, JOB_STATUS } from '@bg/shared';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { SimulationOrchestrator, type TickParticipant } from './SimulationOrchestrator';

/**
 * Mid-run failure handling (R23.3, R23.4).
 *
 * The requirement is that an engine error moves the job to a valid state *and* appears in the event stream.
 * Both halves matter, and the second is the one that is easy to get wrong: the paced loop's promise is awaited
 * by nothing except the pause path, so an error inside it surfaces only as an unhandled rejection in the
 * process log — while the dashboard keeps showing a RUNNING job with a progress bar that has silently stopped.
 * A failure invisible on the surface it is meant to be observed from is worse than a loud one.
 *
 * The per-record failure path is covered by the engine suite; these cases are about everything the per-record
 * handler does not catch.
 */

const TOTAL = 40;
const PARTITIONS = 4;

interface Harness {
  patients: InMemoryPatientRepository;
  events: InMemoryEventSink;
  orchestrator: SimulationOrchestrator;
}

async function makeHarness(): Promise<Harness> {
  const patients = new InMemoryPatientRepository();
  const jobs = new InMemoryJobRepository();
  const clock = createManualClock();
  const events = new InMemoryEventSink(clock, 50_000);

  await patients.replaceAll(
    generatePatients({ totalRecords: TOTAL, partitionCount: PARTITIONS, seed: DEFAULT_SEED }),
  );

  const orchestrator = new SimulationOrchestrator({
    patients,
    jobs,
    events,
    clock,
    rng: createRng(DEFAULT_SEED),
    seed: DEFAULT_SEED,
    settings: {
      totalRecords: TOTAL,
      partitionCount: PARTITIONS,
      backfillSpeed: 1000,
      onlineUpdateFrequency: 0,
      checkpointInterval: 10,
      batchSize: 5,
      maxReevaluationAttempts: 3,
    },
  });

  return { patients, events, orchestrator };
}

/** A participant that throws once the run reaches a given point. */
function throwingParticipant(atRecordsRead: number, message: string): TickParticipant {
  return {
    async beforeStep(context) {
      if (context.recordsRead < atRecordsRead) return;
      throw new Error(message);
    },
  };
}

describe('mid-run failure handling', () => {
  it('moves the job to FAILED and reports the reason on the event stream', async () => {
    const harness = await makeHarness();
    harness.orchestrator.register(throwingParticipant(10, 'checkpoint store went away'));

    await harness.orchestrator.start({}, { autoAdvance: false });

    // An external driver propagates, which is correct — but the job must still land somewhere valid.
    await expect(harness.orchestrator.runToCompletion()).rejects.toThrow(
      /checkpoint store went away/,
    );

    await harness.orchestrator.reportFailure(new Error('checkpoint store went away'));

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.FAILED);

    const failure = harness.events
      .ofType(EVENT_TYPE.RECORD_FAILED)
      .find((event) => event.message.includes('checkpoint store went away'));

    expect(failure).toBeDefined();
    expect(failure!.severity).toBe('CRITICAL');
  });

  it('records the failure reason on the reported state, not just in a log line', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.reportFailure(new Error('repository connection lost'));

    const state = await harness.orchestrator.getState();
    expect(state.status).toBe(JOB_STATUS.FAILED);
    expect(state.failureReason).toBe('repository connection lost');
  });

  it('leaves committed data untouched when a run fails', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    for (let tick = 0; tick < 12; tick += 1) await harness.orchestrator.tickOnce();

    const before = (await harness.patients.findPage({ page: 1, pageSize: TOTAL })).items;
    const scoredBefore = before.filter((patient) => patient.riskScore !== null).length;
    expect(scoredBefore).toBeGreaterThan(0);

    await harness.orchestrator.reportFailure(new Error('boom'));

    const after = (await harness.patients.findPage({ page: 1, pageSize: TOTAL })).items;
    expect(after.filter((patient) => patient.riskScore !== null)).toHaveLength(scoredBefore);
  });

  it('survives a failure while already in a state FAIL is not allowed from', async () => {
    /**
     * Re-throwing here would replace a described failure with an anonymous one, so the reason must still reach
     * the event stream even when the state transition itself is refused.
     */
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();
    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.COMPLETED);

    await expect(
      harness.orchestrator.reportFailure(new Error('late failure')),
    ).resolves.toBeUndefined();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.FAILED);
    expect(
      harness.events.ofType(EVENT_TYPE.RECORD_FAILED).some((e) => e.message.includes('late failure')),
    ).toBe(true);
  });

  it('allows a reset out of a failed job', async () => {
    // The escape hatch has to work from the state a failure leaves behind, or a wedged demo needs a restart.
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.reportFailure(new Error('boom'));
    await harness.orchestrator.reset();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.IDLE);
    expect((await harness.orchestrator.getState()).failureReason).toBeNull();
  });

  it('refuses to complete a run with a record left undecided', async () => {
    /**
     * The liveness half of the guarantee, made mechanical: the job physically cannot report success while a
     * record is unaccounted for. Here a ledger entry is deleted behind the engine's back to simulate the gap.
     */
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });

    let deleted = false;
    harness.orchestrator.register({
      async afterStep(context) {
        if (deleted || context.processed < 5) return;
        deleted = true;
        const first = (await harness.patients.allIds())[0]!;
        harness.patients.deleteConsiderationForTest('BG-DEMO-001', first);
      },
    });

    await harness.orchestrator.runToCompletion();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.FAILED);

    const state = await harness.orchestrator.getState();
    expect(state.failureReason).toMatch(/without a terminal decision/);

    // And the gap is named, not merely counted.
    expect(state.failureReason).toMatch(/P\d{4}/);
  });
});
