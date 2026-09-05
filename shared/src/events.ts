import type { EventSeverity, EventType } from './enums';
import type { BackfillJobState, JobMetrics, PartitionProgress } from './job';

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
 * Coalesced progress frame (R13.5). Carries the high-volume per-record movement that would otherwise
 * flood the socket. The underlying RECORD_READ / RISK_CALCULATED events are still persisted.
 */
export interface ProgressFrame {
  jobId: string;
  metrics: JobMetrics;
  partitions: PartitionProgress[];
  latestSequence: number;
}

/** Socket.IO server → client channel names. */
export const LIVE_CHANNEL = {
  snapshot: 'snapshot',
  event: 'event',
  progress: 'progress',
  jobState: 'jobState',
} as const;

export const LIVE_NAMESPACE = '/live';
