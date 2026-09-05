import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  BACKFILL_STATUS,
  CHECKPOINT_STATUS,
  CONSIDERATION_OUTCOME,
  EVENT_TYPE,
  JOB_STATUS,
  PENDING_RESULT_STATE,
  UPDATE_SOURCE,
  type Patient,
} from '@bg/shared';
import { CheckpointMissingError } from '../../lib/errors';
import { createManualClock } from '../../lib/clock';
import { createRng } from '../../lib/rng';
import { InMemoryEventSink } from '../../infra/events/InMemoryEventSink';
import { InMemoryJobRepository } from '../../infra/repositories/InMemoryJobRepository';
import { InMemoryPatientRepository } from '../../infra/repositories/InMemoryPatientRepository';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { CheckpointManager } from './CheckpointManager';
import { SimulationOrchestrator, type TickParticipant } from '../orchestrator/SimulationOrchestrator';

/**
 * Checkpoints, crash injection and evidence-based recovery (R7, R8, R9).
 *
 * The suite builds up to the project's headline scenario: process some records, crash with results
 * staged but unwritten, destroy the checkpoint, then recover to full coverage with zero stale writes.
 */

const TOTAL = 100;
const PARTITIONS = 4;
const SEED = 90210;
const JOB = 'BG-DEMO-001';

interface Harness {
  patients: InMemoryPatientRepository;
  jobs: InMemoryJobRepository;
  events: InMemoryEventSink;
  orchestrator: SimulationOrchestrator;
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
      checkpointInterval: overrides.checkpointInterval ?? 20,
      batchSize: overrides.batchSize ?? 10,
      maxReevaluationAttempts: 3,
    },
  });

  return { patients, jobs, events, orchestrator };
}

/** Runs ticks until a predicate holds, so a scenario can stop at an exact point. */
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

/**
 * The state the crash scenarios need: at least one checkpoint exists (so it can be destroyed) *and*
 * results are staged but unwritten (so the crash has something stale to freeze).
 *
 * Both conditions matter. Stopping on staged results alone can land before the first flush, when
 * `processed` is still zero and no checkpoint has been created — at which point losing a checkpoint
 * correctly refuses, because there is nothing to lose.
 */
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

/** Fires an action once a given number of records have been read into a batch. */
function afterRead(readTarget: number, action: () => Promise<void>): TickParticipant {
  let fired = false;
  return {
    async beforeStep(context) {
      if (fired || context.recordsRead < readTarget) return;
      fired = true;
      await action();
    },
  };
}

// ====================================================================== checkpoints

describe('CheckpointManager (R7)', () => {
  it('creates checkpoints at the configured cadence', async () => {
    const harness = await makeHarness({ checkpointInterval: 20, batchSize: 10 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const created = harness.events.countOfType(EVENT_TYPE.CHECKPOINT_CREATED);
    // 100 records at one checkpoint per 20.
    expect(created).toBeGreaterThanOrEqual(4);
    expect(created).toBeLessThanOrEqual(6);
  });

  it('refuses to record a checkpoint before anything has been flushed', async () => {
    /**
     * The invariant that protects coverage, tested directly.
     *
     * A checkpoint advertising progress past the last flushed record would let a resume skip records
     * that were never written — the job would report success while having silently missed data. The
     * guard lives in `CheckpointManager.record`, so that is what is asserted here rather than trying to
     * infer it from event payloads.
     */
    const harness = await makeHarness();
    const manager = new CheckpointManager({
      jobs: harness.jobs,
      events: harness.events,
      interval: 20,
    });

    await harness.orchestrator.start({}, { autoAdvance: false });

    await expect(
      manager.record(JOB, JOB_STATUS.RUNNING, {
        partitionIndex: 0,
        lastFlushedPosition: -1,
        processedCount: 12,
      }),
    ).rejects.toThrow(/never advertise unflushed progress/);
  });

  it('records monotonically increasing progress', async () => {
    // Flushes happen at batch-full *or* partition-end, so a checkpoint's processed count is not
    // necessarily a multiple of the batch size. What must hold is that progress only moves forward.
    const harness = await makeHarness({ checkpointInterval: 20, batchSize: 10 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const counts = harness.events
      .ofType(EVENT_TYPE.CHECKPOINT_CREATED)
      .map((event) => event.payload?.processedCount as number);

    expect(counts.length).toBeGreaterThan(1);
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
    }
    expect(counts[counts.length - 1]!).toBeLessThanOrEqual(TOTAL);
  });

  it('keeps exactly one active checkpoint', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.runToCompletion();

    const checkpoint = await harness.orchestrator.getCheckpoint();
    expect(checkpoint.active).not.toBeNull();
    expect(checkpoint.active!.status).toBe(CHECKPOINT_STATUS.ACTIVE);
    expect(checkpoint.active!.id).toBe(checkpoint.lastKnown!.id);
  });

  it('marks every checkpoint lost and leaves no usable cursor', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.events.countOfType(EVENT_TYPE.CHECKPOINT_CREATED) >= 2);

    const before = await harness.orchestrator.getCheckpoint();
    expect(before.active).not.toBeNull();

    await harness.orchestrator.loseCheckpoint();

    const after = await harness.orchestrator.getCheckpoint();
    expect(after.active).toBeNull();
    // The last known position survives for narration, but is no longer trusted as a cursor.
    expect(after.lastKnown).not.toBeNull();
    expect(after.lastKnown!.status).toBe(CHECKPOINT_STATUS.LOST);
  });

  it('emits CHECKPOINT_LOST naming the last known position', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.events.countOfType(EVENT_TYPE.CHECKPOINT_CREATED) >= 1);
    await harness.orchestrator.loseCheckpoint();

    const event = harness.events.ofType(EVENT_TYPE.CHECKPOINT_LOST)[0]!;
    expect(event.message).toContain('CHECKPOINT LOST');
    expect(event.payload?.lastKnownPartition).toBeTypeOf('number');
    expect(event.payload?.lastKnownRecordPosition).toBeTypeOf('number');
    expect(event.payload?.destroyedCount).toBeGreaterThan(0);
  });

  it('refuses to lose a checkpoint when none exists', async () => {
    // Reporting success for a destructive action that did nothing would be worse than an error.
    const harness = await makeHarness({ checkpointInterval: 500 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await harness.orchestrator.tickOnce();

    await expect(harness.orchestrator.loseCheckpoint()).rejects.toThrow(CheckpointMissingError);
  });

  it('leaves committed patient data untouched when checkpoints are lost', async () => {
    const harness = await makeHarness();

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.events.countOfType(EVENT_TYPE.CHECKPOINT_CREATED) >= 2);

    const before = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
    await harness.orchestrator.loseCheckpoint();
    const after = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;

    expect(after.map((p) => `${p.patientCode}:${p.riskScore}:${p.version}`)).toEqual(
      before.map((p) => `${p.patientCode}:${p.riskScore}:${p.version}`),
    );
  });
});

// ====================================================================== crash

describe('crash injection (R8)', () => {
  it('freezes the unflushed batch as staged results', async () => {
    // Staleness needs computed-but-unwritten values that outlive the interruption. Without this, a
    // crash would be indistinguishable from a pause.
    const harness = await makeHarness({ batchSize: 25 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    // Stop mid-batch so results are staged but unwritten.
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 12));

    const inFlightBefore = harness.orchestrator.getEngine()!.inFlightCount();
    expect(inFlightBefore).toBeGreaterThan(0);

    await harness.orchestrator.crash();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.CRASHED);

    const staged = await harness.patients.pendingResults(JOB, PENDING_RESULT_STATE.PENDING);
    expect(staged).toHaveLength(inFlightBefore);

    for (const entry of staged) {
      expect(entry.sourceVersion).toBeGreaterThan(0);
      expect(entry.computedScore).toBeGreaterThan(0);
      expect(entry.inputSnapshot.glucose).toBeGreaterThan(0);
    }
  });

  it('does not revert or delete any already-written value', async () => {
    const harness = await makeHarness({ batchSize: 10 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.orchestrator.getEngine()!.getMetrics().processed >= 30);

    const before = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
    const scoredBefore = before.filter((p) => p.riskScore !== null);
    expect(scoredBefore.length).toBeGreaterThan(0);

    await harness.orchestrator.crash();

    const after = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
    const byId = new Map<number, Patient>(after.map((p) => [p.id, p]));

    for (const original of scoredBefore) {
      const updated = byId.get(original.id)!;
      expect(updated.riskScore).toBe(original.riskScore);
      expect(updated.riskLevel).toBe(original.riskLevel);
      expect(updated.lastBackfillVersion).toBe(original.lastBackfillVersion);
      expect(updated.version).toBe(original.version);
    }
  });

  it('emits BACKFILL_CRASHED reporting the staged count', async () => {
    const harness = await makeHarness({ batchSize: 25 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 10));
    await harness.orchestrator.crash();

    const event = harness.events.ofType(EVENT_TYPE.BACKFILL_CRASHED)[0]!;
    expect(event.message).toContain('BACKFILL CRASHED');
    expect(event.payload?.stagedResultCount).toBeGreaterThan(0);
  });

  it('supports the process → crash → lose checkpoint sequence', async () => {
    const harness = await makeHarness({ batchSize: 10, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.events.countOfType(EVENT_TYPE.CHECKPOINT_CREATED) >= 2);
    await harness.orchestrator.crash();
    await harness.orchestrator.loseCheckpoint();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.CRASHED);
    expect((await harness.orchestrator.getCheckpoint()).active).toBeNull();
  });
});

// ====================================================================== recovery

describe('RecoveryEngine (R9)', () => {
  it('recovers to full coverage after a crash and checkpoint loss', async () => {
    const harness = await makeHarness({ batchSize: 10, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.orchestrator.getEngine()!.getMetrics().processed >= 40);
    await harness.orchestrator.crash();
    await harness.orchestrator.loseCheckpoint();

    await harness.orchestrator.recover();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.COMPLETED);

    // Liveness: every eligible record has a terminal decision.
    const considered = await harness.patients.consideredPatientIds(JOB);
    expect(considered).toHaveLength(TOTAL);

    // Safety: no applied write had a guard version disagreeing with the row.
    const staleOverwrites = (await harness.patients.listWriteLedger(JOB)).filter(
      (entry) => entry.applied && entry.guardVersion !== entry.rowVersionAtWrite,
    );
    expect(staleOverwrites).toEqual([]);

    // Consistency: every record's stored score matches a recomputation from its current data.
    const all = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
    for (const patient of all) {
      const expected = calculateRiskScore(toRiskInput(patient));
      expect(patient.riskScore).toBe(expected.score);
      expect(patient.lastBackfillVersion).toBe(patient.version);
    }
  });

  it('does not blindly rewrite records that are already current', async () => {
    /**
     * The "must not rewrite everything" half of the requirement.
     *
     * Recovery revisits records it cannot prove are current, but a record whose stored score already
     * derives from its current version must be left alone. Measured by write count, not by inspecting
     * values: a no-op that happened to produce the same number would still be a write.
     */
    const harness = await makeHarness({ batchSize: 10, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.orchestrator.getEngine()!.getMetrics().processed >= 40);
    await harness.orchestrator.crash();
    await harness.orchestrator.loseCheckpoint();

    const writesBefore = (await harness.patients.listWriteLedger(JOB)).length;
    const summary = await harness.orchestrator.recover();
    const writesAfter = (await harness.patients.listWriteLedger(JOB)).length;

    expect(summary.noops).toBeGreaterThan(0);
    expect(summary.recordsRevisited).toBeGreaterThan(summary.recordsReprocessed);

    // Writes during recovery must be far fewer than records revisited: most took the no-op path.
    const writesDuringRecovery = writesAfter - writesBefore;
    expect(writesDuringRecovery).toBeLessThan(summary.recordsRevisited);

    const noopEntries = (await harness.patients.listConsiderations(JOB)).filter(
      (entry) => entry.outcome === CONSIDERATION_OUTCOME.NO_ACTION_ALREADY_CURRENT,
    );
    expect(noopEntries.length).toBe(summary.noops);
  });

  it('does not skip records that precede the lost checkpoint', async () => {
    // The "must not skip" half. Records written before the crash are proven current and no-op'd; records
    // that were staged but never written are unproven and must be processed.
    const harness = await makeHarness({ batchSize: 25, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 15));

    const unwritten = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items.filter(
      (patient) => patient.riskScore === null,
    );
    expect(unwritten.length).toBeGreaterThan(0);

    await harness.orchestrator.crash();
    await harness.orchestrator.loseCheckpoint();
    await harness.orchestrator.recover();

    // Every previously unscored record now has a score.
    for (const patient of unwritten) {
      const after = (await harness.patients.findById(patient.id))!;
      expect(after.riskScore).not.toBeNull();
    }
  });

  it('revalidates a staged result and flushes it when still current', async () => {
    const harness = await makeHarness({ batchSize: 25, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 10));
    await harness.orchestrator.crash();
    await harness.orchestrator.loseCheckpoint();

    const summary = await harness.orchestrator.recover();

    // Nothing changed those records, so their staged computations were still valid.
    expect(summary.pendingResultsRevalidated).toBeGreaterThan(0);
    expect(summary.pendingResultsRejected).toBe(0);

    const staged = await harness.patients.pendingResults(JOB);
    expect(staged.every((entry) => entry.state !== PENDING_RESULT_STATE.PENDING)).toBe(true);
  });

  it('refuses a staged result whose row moved during the outage', async () => {
    /**
     * The scenario the whole project is built around.
     *
     * A result is computed, the job crashes before writing it, a doctor changes the patient while the
     * job is down, and then recovery must refuse the now-stale value rather than write it over the
     * doctor's data.
     */
    const harness = await makeHarness({ batchSize: 25, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 10));

    const stagedCodes = harness.orchestrator.getEngine()!.inFlightCodes();
    const victimCode = stagedCodes[3]!;

    await harness.orchestrator.crash();

    // The outage window: clinical staff keep working while the job is down.
    const victim = (await harness.patients.findByCode(victimCode))!;
    await harness.patients.applyOnlineUpdate(
      victim.id,
      victim.version,
      { glucose: 260 },
      ACTOR_TYPE.DOCTOR,
      UPDATE_SOURCE.SCRIPTED,
    );

    await harness.orchestrator.loseCheckpoint();
    const summary = await harness.orchestrator.recover();

    expect(summary.pendingResultsRejected).toBeGreaterThan(0);
    expect(summary.conflictsFound).toBeGreaterThan(0);

    // The doctor's value survived and the score reflects it.
    const after = (await harness.patients.findByCode(victimCode))!;
    expect(after.glucose).toBe(260);
    expect(after.riskScore).toBe(calculateRiskScore(toRiskInput(after)).score);
    expect(after.lastBackfillVersion).toBe(after.version);
    expect(after.backfillStatus).toBe(BACKFILL_STATUS.REEVALUATED);

    // And nothing stale ever landed.
    const staleOverwrites = (await harness.patients.listWriteLedger(JOB)).filter(
      (entry) => entry.applied && entry.guardVersion !== entry.rowVersionAtWrite,
    );
    expect(staleOverwrites).toEqual([]);
  });

  it('moves the boundary backwards when an early partition is changed', async () => {
    /**
     * An expected consequence of deriving the boundary from evidence, documented so it is not mistaken
     * for a bug: an update to an already-completed early partition makes it un-provable, so recovery
     * legitimately restarts earlier than the lost checkpoint suggested.
     */
    const harness = await makeHarness({ batchSize: 10, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.orchestrator.getEngine()!.getMetrics().processed >= 60);

    // P0002 lives in partition 0, long since completed.
    const early = (await harness.patients.findByCode('P0002'))!;
    expect(early.riskScore).not.toBeNull();

    await harness.orchestrator.crash();
    await harness.patients.applyOnlineUpdate(
      early.id,
      early.version,
      { glucose: 280 },
      ACTOR_TYPE.LAB,
      UPDATE_SOURCE.SCRIPTED,
    );
    await harness.orchestrator.loseCheckpoint();

    const summary = await harness.orchestrator.recover();

    // Partition 0 is no longer provably complete, so recovery starts there.
    expect(summary.recoveryStartPartition).toBe(0);

    const after = (await harness.patients.findByCode('P0002'))!;
    expect(after.glucose).toBe(280);
    expect(after.riskScore).toBe(calculateRiskScore(toRiskInput(after)).score);
  });

  it('emits RECOVERY_STARTED and RECOVERY_COMPLETED with the evidence', async () => {
    const harness = await makeHarness({ batchSize: 10, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });
    await tickUntil(harness.orchestrator, () => harness.orchestrator.getEngine()!.getMetrics().processed >= 40);
    await harness.orchestrator.crash();
    await harness.orchestrator.loseCheckpoint();
    await harness.orchestrator.recover();

    const started = harness.events.ofType(EVENT_TYPE.RECOVERY_STARTED)[0]!;
    expect(started.message).toContain('no usable checkpoint');
    expect(started.payload?.recoveryStartPartition).toBeTypeOf('number');
    expect(started.payload?.provablyCompletePartitions).toBeInstanceOf(Array);

    const completed = harness.events.ofType(EVENT_TYPE.RECOVERY_COMPLETED)[0]!;
    // The no-op count is what shows recovery reasoned rather than rewrote.
    expect(completed.payload?.noops).toBeGreaterThan(0);
    expect(completed.payload?.recordsRevisited).toBeGreaterThan(0);
  });

  it('produces an identical outcome across two identical crash scenarios', async () => {
    async function run() {
      const harness = await makeHarness({ batchSize: 25, checkpointInterval: 20 });

      harness.orchestrator.register(
        afterRead(30, async () => {
          const target = (await harness.patients.findByCode('P0020'))!;
          await harness.patients.applyOnlineUpdate(
            target.id,
            target.version,
            { glucose: 265 },
            ACTOR_TYPE.DOCTOR,
            UPDATE_SOURCE.SCRIPTED,
          );
        }),
      );

      await harness.orchestrator.start({}, { autoAdvance: false });
      await tickUntil(harness.orchestrator, () => harness.orchestrator.getEngine()!.getMetrics().processed >= 50);
      await harness.orchestrator.crash();
      await harness.orchestrator.loseCheckpoint();
      const summary = await harness.orchestrator.recover();

      const patients = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;

      return {
        summary,
        scores: patients.map((p) => `${p.patientCode}:${p.riskScore}`),
      };
    }

    const first = await run();
    const second = await run();

    expect(second.summary).toEqual(first.summary);
    expect(second.scores).toEqual(first.scores);
  });
});

// ====================================================================== the headline scenario

describe('full crash-to-recovery scenario', () => {
  it('survives updates during the outage and finishes verifiably safe', async () => {
    const harness = await makeHarness({ batchSize: 25, checkpointInterval: 20 });

    await harness.orchestrator.start({}, { autoAdvance: false });

    // 1. Process part of the dataset, with results staged but unwritten.
    await tickUntil(harness.orchestrator, checkpointedWithStagedResults(harness, 15));
    const stagedCodes = harness.orchestrator.getEngine()!.inFlightCodes();

    // 2. Crash. Staged results survive; committed data is untouched.
    await harness.orchestrator.crash();
    const stagedAfterCrash = await harness.patients.pendingResults(JOB, PENDING_RESULT_STATE.PENDING);
    expect(stagedAfterCrash.length).toBe(stagedCodes.length);

    // 3. Clinical staff keep working during the outage, on records with staged results pending.
    const victims = stagedCodes.slice(0, 4);
    for (const code of victims) {
      const patient = (await harness.patients.findByCode(code))!;
      await harness.patients.applyOnlineUpdate(
        patient.id,
        patient.version,
        { glucose: 255, heartRate: 122 },
        ACTOR_TYPE.LAB,
        UPDATE_SOURCE.SCRIPTED,
      );
    }

    // 4. Destroy the checkpoint, so recovery cannot rely on a cursor.
    await harness.orchestrator.loseCheckpoint();
    expect((await harness.orchestrator.getCheckpoint()).active).toBeNull();

    // 5. Recover.
    const summary = await harness.orchestrator.recover();

    expect(harness.orchestrator.getStatus()).toBe(JOB_STATUS.COMPLETED);
    expect(summary.pendingResultsRejected).toBeGreaterThanOrEqual(victims.length);
    expect(summary.conflictsFound).toBeGreaterThanOrEqual(victims.length);

    // --- the two halves of the central guarantee, measured from persisted evidence ---

    // Liveness: 100% coverage.
    expect(await harness.patients.consideredPatientIds(JOB)).toHaveLength(TOTAL);

    // Safety, part 1: no applied write disagreed with the row it landed on.
    const staleOverwrites = (await harness.patients.listWriteLedger(JOB)).filter(
      (entry) => entry.applied && entry.guardVersion !== entry.rowVersionAtWrite,
    );
    expect(staleOverwrites).toEqual([]);

    // Safety, part 2: every clinical value an update wrote is still present, per field.
    const updates = await harness.patients.listOnlineUpdates();
    const expectedValues = new Map<number, Map<string, string | number>>();
    for (const update of updates) {
      const fields = expectedValues.get(update.patientId) ?? new Map<string, string | number>();
      for (const change of update.changedFields) fields.set(change.field, change.to);
      expectedValues.set(update.patientId, fields);
    }

    expect(expectedValues.size).toBe(victims.length);

    for (const [patientId, fields] of expectedValues) {
      const patient = (await harness.patients.findById(patientId))!;
      for (const [field, value] of fields) {
        expect(
          patient[field as keyof Patient],
          `${patient.patientCode}.${field} must still hold the value the lab wrote`,
        ).toBe(value);
      }
    }

    // Consistency: every record's score derives from its current data.
    const all = (await harness.patients.findPage({ page: 1, pageSize: 500 })).items;
    for (const patient of all) {
      expect(patient.riskScore).toBe(calculateRiskScore(toRiskInput(patient)).score);
      expect(patient.lastBackfillVersion).toBe(patient.version);
    }

    // Nothing left unresolved.
    expect(await harness.patients.openConflictCount(JOB)).toBe(0);
    expect(summary.recordsRevisited).toBeGreaterThan(0);
  });
});
