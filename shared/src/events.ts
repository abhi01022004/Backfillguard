import type { EventSeverity, EventType } from './enums';
import type { BackfillJobState } from './job';

/**
 * One entry in the live event stream (R13.2).
 *
 * `sequence` is monotonic and gap-free across the whole run, which gives the client a cheap way to
 * detect missed events and lets tests assert ordering without depending on timestamps.
 */
export interface SimulationEvent {
  sequence: number;
  type: EventType;
  severity: EventSeverity;
  /** Short, judge-readable explanation. */
  message: string;
  jobId?: string;
  patientCode?: string;
  partitionIndex?: number;
  /** Type-specific structured detail, e.g. versions for a conflict. */
  payload?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Sent once on connect so a client joining mid-run is immediately correct (R13.4).
 */
export interface LiveSnapshot {
  job: BackfillJobState | null;
  recentEvents: SimulationEvent[];
  /** Highest sequence included, so the client can request any gap. */
  latestSequence: number;
}

/**
 * Socket.IO server → client channel names.
 *
 * Three channels, deliberately:
 *
 *  - `snapshot`  full state plus recent history, sent on connect and on request
 *  - `event`     one significant event, never coalesced
 *  - `jobState`  the coalesced progress channel — throttled full state
 *
 * An earlier design also sent a lean `progress` frame carrying just metrics and partitions. It was
 * removed because it was a strict subset of `jobState`, so every update went over the wire twice while the
 * client still needed `jobState` for status and checkpoint information anyway.
 */
export const LIVE_CHANNEL = {
  snapshot: 'snapshot',
  event: 'event',
  jobState: 'jobState',
} as const;

/**
 * Socket.IO's HTTP `path`, not a namespace.
 *
 * The two are different concepts and easy to confuse: a namespace multiplexes logical channels over one
 * connection, while `path` is the URL the transport actually handshakes on. Using `/live` as the path
 * means a single Vite proxy entry (`/live` with `ws: true`) covers both the handshake and the upgraded
 * socket, rather than needing a separate rule for Socket.IO's default `/socket.io`.
 */
export const LIVE_PATH = '/live';
