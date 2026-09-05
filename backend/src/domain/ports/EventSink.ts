import type {
  EventSeverity,
  EventType,
  SimulationEvent,
} from '@bg/shared';

/**
 * Where the domain sends events (R13.1, R13.2).
 *
 * The engines depend on this narrow port rather than on Socket.IO or the database, which is what lets
 * them run identically in the live application, in the headless test suite and inside the naive
 * comparison harness.
 *
 * Sequence numbers are assigned by the sink, not the caller. Keeping that responsibility in one place
 * is what guarantees the stream is monotonic and gap-free across a whole run — a property tests rely
 * on to assert ordering without depending on timestamps, and the client uses to detect dropped events.
 */

export interface EmitEventInput {
  type: EventType;
  severity?: EventSeverity;
  message: string;
  jobId?: string;
  patientCode?: string;
  partitionIndex?: number;
  payload?: Record<string, unknown>;
}

export interface EventSink {
  /** Records an event and returns it with its assigned sequence number. */
  emit(event: EmitEventInput): SimulationEvent;

  /** Most recent events, newest last. Used for the connect-time snapshot. */
  recent(limit?: number): SimulationEvent[];

  latestSequence(): number;

  /** Flushes any buffered persistence. Called at natural boundaries such as job completion. */
  flush(): Promise<void>;

  /** Drops all buffered events and resets the sequence. Used by simulation reset. */
  clear(): void;
}
