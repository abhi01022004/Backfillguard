import {
  LIVE_CHANNEL,
  TRANSPORT,
  isSignificantEvent,
  type BackfillJobState,
  type SimulationEvent,
} from '@bg/shared';
import type { Server as SocketServer } from 'socket.io';
import type { EmitEventInput, EventSink } from '../../domain/ports/EventSink';

/**
 * Pushes the event stream to connected clients (R13.3, R13.5, R13.6).
 *
 * ## The problem this solves
 *
 * A run over 1,000 records emits several thousand events, most of them per-record telemetry
 * (`RECORD_READ`, `RISK_CALCULATED`, `VERSION_VALIDATED`). Forwarding every one would flood the socket and
 * force the browser to re-render faster than a human can perceive, for no benefit.
 *
 * ## The rule, and why it is safe
 *
 * Events are split by whether losing one would lose *meaning*:
 *
 *  - **Significant** events — a conflict, a stale write refused, a checkpoint lost, a crash, a recovery, a
 *    verdict — are forwarded immediately and individually. These are the narrative. Coalescing them would
 *    be a bug, and the classification lives in `shared` so the server and client cannot disagree about it.
 *  - **Everything else** is high-volume progress. It is still assigned a sequence number and still written
 *    to the durable log, so nothing is *lost*; only its transport is folded into a throttled frame
 *    carrying current counts.
 *
 * So "coalesced" here means the client learns the aggregate rather than each step. The full stream remains
 * queryable via the events endpoint, which is what the per-patient history view uses.
 */

export interface LiveEventBroadcasterDeps {
  io: SocketServer;
  /** Supplies the current job state for progress frames and the connect-time snapshot. */
  getJobState: () => Promise<BackfillJobState | null>;
}

export class LiveEventBroadcaster implements EventSink {
  private progressDirty = false;
  private progressTimer: NodeJS.Timeout | null = null;
  private lastProgressAt = 0;

  private forwarded = 0;
  private coalesced = 0;

  constructor(
    private readonly base: EventSink,
    private readonly deps: LiveEventBroadcasterDeps,
  ) {}

  emit(input: EmitEventInput): SimulationEvent {
    const event = this.base.emit(input);

    if (isSignificantEvent(event.type)) {
      this.forwarded += 1;
      // Forwarded immediately: this is the narrative, and it must not wait for a frame boundary.
      this.deps.io.emit(LIVE_CHANNEL.event, event);
    } else {
      this.coalesced += 1;
    }

    /**
     * State updates are always throttled, including after a significant event.
     *
     * An earlier version pushed state immediately on every significant event so the KPI cards could not
     * lag a highlighted conflict. That was measurably wrong: a live run produced 472 state frames in 19
     * seconds, and computing state reads the whole consideration ledger, so it meant re-reading 1,000 rows
     * roughly 25 times a second purely to keep counters a few milliseconds fresher.
     *
     * Marking the frame dirty instead bounds the cost to the frame interval while keeping the visible lag
     * under 100ms, which is not perceptible as disagreement.
     */
    this.markProgressDirty();

    return event;
  }

  recent(limit?: number): SimulationEvent[] {
    return this.base.recent(limit);
  }

  latestSequence(): number {
    return this.base.latestSequence();
  }

  async flush(): Promise<void> {
    await this.base.flush();
    await this.pushProgress();
  }

  clear(): void {
    this.clearProgressTimer();
    this.progressDirty = false;
    this.forwarded = 0;
    this.coalesced = 0;
    this.base.clear();
  }

  // ------------------------------------------------------------------ progress frames

  private markProgressDirty(): void {
    this.progressDirty = true;
    if (this.progressTimer) return;

    const sinceLast = Date.now() - this.lastProgressAt;
    const delay = Math.max(0, TRANSPORT.progressFrameIntervalMs - sinceLast);

    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      void this.pushProgress();
    }, delay);
    this.progressTimer.unref?.();
  }

  private async pushProgress(): Promise<void> {
    this.clearProgressTimer();
    this.progressDirty = false;
    this.lastProgressAt = Date.now();

    const job = await this.deps.getJobState();
    // Nothing meaningful to send before a run, and inventing zeros would be indistinguishable from a real
    // run that had processed nothing.
    if (!job) return;

    this.deps.io.emit(LIVE_CHANNEL.jobState, job);
  }

  private clearProgressTimer(): void {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
  }

  /** Diagnostics, so the coalescing ratio is observable rather than assumed. */
  get stats(): { forwarded: number; coalesced: number } {
    return { forwarded: this.forwarded, coalesced: this.coalesced };
  }
}
