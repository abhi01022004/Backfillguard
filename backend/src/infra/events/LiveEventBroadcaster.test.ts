import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_TYPE,
  LIVE_CHANNEL,
  SIGNIFICANT_EVENT_TYPES,
  isSignificantEvent,
  type BackfillJobState,
  type EventType,
  type SimulationEvent,
} from '@bg/shared';
import type { Server as SocketServer } from 'socket.io';
import { createManualClock } from '../../lib/clock';
import { InMemoryEventSink } from './InMemoryEventSink';
import { LiveEventBroadcaster } from './LiveEventBroadcaster';

/**
 * Broadcast policy (R13.5, R13.6).
 *
 * The risk being tested is specific: coalescing high-volume telemetry is fine, but silently folding away a
 * conflict or a checkpoint loss would gut the demo while leaving every other number correct.
 */

interface Emitted {
  channel: string;
  payload: unknown;
}

function makeHarness(jobState: BackfillJobState | null = null) {
  const emitted: Emitted[] = [];

  const io = {
    emit: (channel: string, payload: unknown) => {
      emitted.push({ channel, payload });
      return true;
    },
  } as unknown as SocketServer;

  const base = new InMemoryEventSink(createManualClock(), 10_000);
  const broadcaster = new LiveEventBroadcaster(base, {
    io,
    getJobState: async () => jobState,
  });

  return { emitted, base, broadcaster };
}

const STUB_STATE: BackfillJobState = {
  jobId: 'BG-DEMO-001',
  status: 'RUNNING',
  mode: 'GUARDED',
  seed: 1,
  settings: {
    totalRecords: 100,
    partitionCount: 4,
    backfillSpeed: 25,
    onlineUpdateFrequency: 0,
    checkpointInterval: 20,
    batchSize: 10,
    maxReevaluationAttempts: 3,
  },
  metrics: {
    eligibleRecords: 100,
    processed: 10,
    applied: 10,
    noopAlreadyCurrent: 0,
    conflicts: 0,
    reevaluated: 0,
    protectedUpdates: 0,
    staleWriteAttemptsBlocked: 0,
    failed: 0,
    currentPartition: 0,
    currentRecordIndex: 10,
    percentComplete: 10,
  },
  partitions: [],
  pendingResultCount: 0,
  checkpoint: null,
  startedAt: null,
  crashedAt: null,
  recoveredAt: null,
  completedAt: null,
  failureReason: null,
};

describe('LiveEventBroadcaster', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('forwards every significant event individually', async () => {
    const { emitted, broadcaster } = makeHarness(STUB_STATE);

    for (const type of SIGNIFICANT_EVENT_TYPES) {
      broadcaster.emit({ type, message: `test ${type}` });
    }
    await broadcaster.flush();

    const forwardedTypes = emitted
      .filter((entry) => entry.channel === LIVE_CHANNEL.event)
      .map((entry) => (entry.payload as SimulationEvent).type);

    expect(forwardedTypes).toEqual([...SIGNIFICANT_EVENT_TYPES]);
  });

  it('never forwards per-record telemetry as individual events', async () => {
    const { emitted, broadcaster } = makeHarness(STUB_STATE);

    const highVolume: EventType[] = [
      EVENT_TYPE.RECORD_READ,
      EVENT_TYPE.RISK_CALCULATED,
      EVENT_TYPE.VERSION_VALIDATED,
      EVENT_TYPE.RECORD_UPDATED,
      EVENT_TYPE.RECORD_NO_ACTION,
    ];

    for (let i = 0; i < 200; i += 1) {
      broadcaster.emit({ type: highVolume[i % highVolume.length]!, message: `noise ${i}` });
    }
    await broadcaster.flush();

    const individual = emitted.filter((entry) => entry.channel === LIVE_CHANNEL.event);
    expect(individual).toHaveLength(0);

    // The information still reaches the client, as an aggregate.
    expect(emitted.some((entry) => entry.channel === LIVE_CHANNEL.jobState)).toBe(true);
  });

  it('still assigns sequence numbers to coalesced events, gap-free', async () => {
    // Coalescing affects transport only. Dropping a sequence number would break the client's ability to
    // detect a genuine gap, and would corrupt the durable log's ordering.
    const { base, broadcaster } = makeHarness(STUB_STATE);

    for (let i = 0; i < 50; i += 1) {
      broadcaster.emit({ type: EVENT_TYPE.RECORD_READ, message: `read ${i}` });
    }
    broadcaster.emit({ type: EVENT_TYPE.CONFLICT_DETECTED, message: 'conflict' });

    const sequences = base.all().map((event) => event.sequence);
    expect(sequences).toHaveLength(51);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }
  });

  it('throttles progress frames rather than sending one per event', async () => {
    const { emitted, broadcaster } = makeHarness(STUB_STATE);

    for (let i = 0; i < 300; i += 1) {
      broadcaster.emit({ type: EVENT_TYPE.RECORD_READ, message: `read ${i}` });
    }
    await broadcaster.flush();

    const frames = emitted.filter((entry) => entry.channel === LIVE_CHANNEL.jobState);
    // 300 events must not produce 300 frames; the point of coalescing is a bounded frame rate.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThan(20);
  });

  it('forwards a significant event before the state frame that follows it', async () => {
    // The event leads; state follows within the frame interval. Ordering matters because the UI highlights
    // the event and then reads counters from state.
    const { emitted, broadcaster } = makeHarness(STUB_STATE);

    broadcaster.emit({ type: EVENT_TYPE.CONFLICT_DETECTED, message: 'conflict' });
    await broadcaster.flush();

    const eventIndex = emitted.findIndex((entry) => entry.channel === LIVE_CHANNEL.event);
    const frameIndex = emitted.findIndex((entry) => entry.channel === LIVE_CHANNEL.jobState);

    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(frameIndex).toBeGreaterThan(eventIndex);
  });

  it('throttles state frames even when every event is significant', async () => {
    /**
     * Guards the fix for a measured problem: pushing state on each significant event produced 472 frames
     * in a 19-second run, and computing state reads the entire consideration ledger — roughly 1,000 rows
     * re-read 25 times a second to keep counters a few milliseconds fresher.
     */
    const { emitted, broadcaster } = makeHarness(STUB_STATE);

    for (let i = 0; i < 200; i += 1) {
      broadcaster.emit({ type: EVENT_TYPE.CONFLICT_DETECTED, message: `conflict ${i}` });
    }
    await broadcaster.flush();

    const events = emitted.filter((entry) => entry.channel === LIVE_CHANNEL.event);
    const frames = emitted.filter((entry) => entry.channel === LIVE_CHANNEL.jobState);

    // Every event still arrives individually...
    expect(events).toHaveLength(200);
    // ...but state is not recomputed 200 times.
    expect(frames.length).toBeLessThan(20);
  });

  it('carries complete job state in a frame, not just counters', async () => {
    // One channel carrying full state, rather than a lean progress frame duplicating a subset of it.
    const { emitted, broadcaster } = makeHarness(STUB_STATE);

    broadcaster.emit({ type: EVENT_TYPE.RECORD_READ, message: 'read' });
    await broadcaster.flush();

    const frame = emitted.find((entry) => entry.channel === LIVE_CHANNEL.jobState)!;
    const payload = frame.payload as BackfillJobState;

    expect(payload.jobId).toBe('BG-DEMO-001');
    expect(payload.metrics.processed).toBe(10);
    // Status and checkpoint are why the client needs full state rather than metrics alone.
    expect(payload.status).toBe('RUNNING');
    expect(payload).toHaveProperty('checkpoint');
    expect(payload).toHaveProperty('pendingResultCount');
  });

  it('emits nothing when there is no job yet', async () => {
    // Before a run, a progress frame would have no meaningful content, and inventing zeros would be
    // indistinguishable from a real run that had processed nothing.
    const { emitted, broadcaster } = makeHarness(null);

    broadcaster.emit({ type: EVENT_TYPE.RECORD_READ, message: 'read' });
    await broadcaster.flush();

    expect(emitted.filter((entry) => entry.channel === LIVE_CHANNEL.jobState)).toHaveLength(0);
  });

  it('reports its coalescing ratio', async () => {
    const { broadcaster } = makeHarness(STUB_STATE);

    for (let i = 0; i < 100; i += 1) {
      broadcaster.emit({ type: EVENT_TYPE.RECORD_READ, message: 'read' });
    }
    broadcaster.emit({ type: EVENT_TYPE.CONFLICT_DETECTED, message: 'conflict' });
    await broadcaster.flush();

    // Observable rather than assumed, so a regression in the split is visible.
    expect(broadcaster.stats).toEqual({ forwarded: 1, coalesced: 100 });
  });
});

describe('significant event classification', () => {
  it('treats every narrative event as significant', () => {
    // These are the events a judge is watching for. Losing one to coalescing would be a real bug.
    const mustBeSignificant: EventType[] = [
      EVENT_TYPE.CONFLICT_DETECTED,
      EVENT_TYPE.STALE_RESULT_REJECTED,
      EVENT_TYPE.RE_EVALUATION_STARTED,
      EVENT_TYPE.RE_EVALUATION_COMPLETED,
      EVENT_TYPE.CHECKPOINT_CREATED,
      EVENT_TYPE.CHECKPOINT_LOST,
      EVENT_TYPE.BACKFILL_CRASHED,
      EVENT_TYPE.RECOVERY_STARTED,
      EVENT_TYPE.RECOVERY_COMPLETED,
      EVENT_TYPE.VERIFICATION_PASSED,
      EVENT_TYPE.VERIFICATION_FAILED,
      EVENT_TYPE.ONLINE_UPDATE,
      EVENT_TYPE.RECORD_FAILED,
    ];

    for (const type of mustBeSignificant) {
      expect(isSignificantEvent(type), `${type} must not be coalesced`).toBe(true);
    }
  });

  it('treats per-record telemetry as coalescible', () => {
    for (const type of [
      EVENT_TYPE.RECORD_READ,
      EVENT_TYPE.RISK_CALCULATED,
      EVENT_TYPE.VERSION_VALIDATED,
      EVENT_TYPE.RECORD_UPDATED,
      EVENT_TYPE.RECORD_NO_ACTION,
    ]) {
      expect(isSignificantEvent(type)).toBe(false);
    }
  });
});
