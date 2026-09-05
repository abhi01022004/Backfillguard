import {
  EVENT_SEVERITY,
  TRANSPORT,
  type SimulationEvent,
} from '@bg/shared';
import type { Clock } from '../../lib/clock';
import type { EmitEventInput, EventSink } from '../../domain/ports/EventSink';

/**
 * Ring-buffered event sink.
 *
 * Holds a bounded window of recent events for the connect-time snapshot and the live timeline. It is
 * the base implementation used directly by tests and the naive comparison harness, and wrapped by the
 * broadcasting/persisting sink in the live application.
 *
 * The buffer is bounded because a full run emits several thousand events and an unbounded array would
 * grow across repeated demo runs for no benefit — the durable record belongs in the database, not here.
 *
 * Sequence assignment lives here rather than in callers so the stream is monotonic and gap-free by
 * construction, which is what lets tests assert ordering without depending on timestamps.
 */
export class InMemoryEventSink implements EventSink {
  private buffer: SimulationEvent[] = [];
  private sequence = 0;

  constructor(
    private readonly clock: Clock,
    private readonly capacity: number = TRANSPORT.timelineWindow * 5,
  ) {}

  emit(input: EmitEventInput): SimulationEvent {
    this.sequence += 1;

    const event: SimulationEvent = {
      sequence: this.sequence,
      type: input.type,
      severity: input.severity ?? EVENT_SEVERITY.INFO,
      message: input.message,
      createdAt: this.clock.nowIso(),
      ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      ...(input.patientCode === undefined ? {} : { patientCode: input.patientCode }),
      ...(input.partitionIndex === undefined ? {} : { partitionIndex: input.partitionIndex }),
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    };

    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }

    return event;
  }

  // Annotated as `number` rather than inferred: TRANSPORT is `as const`, so an inferred default would
  // narrow the parameter to the literal 200 and reject any other limit.
  recent(limit: number = TRANSPORT.timelineWindow): SimulationEvent[] {
    return this.buffer.slice(-limit);
  }

  latestSequence(): number {
    return this.sequence;
  }

  /**
   * Events after a given sequence number.
   *
   * Async to match the durable sink's signature, so this class satisfies the API's `EventLogReader` and the
   * event endpoints can be exercised without a database. Served from the ring buffer, which for this adapter
   * *is* the log — so unlike the persisting sink it can genuinely have lost old events, and callers relying on
   * completeness should use the durable one.
   */
  async since(sequence: number, limit: number = TRANSPORT.timelineWindow): Promise<SimulationEvent[]> {
    return this.buffer.filter((event) => event.sequence > sequence).slice(0, limit);
  }

  /** Always zero: nothing is queued for a write that could fail. */
  readonly droppedCount = 0;

  async flush(): Promise<void> {
    // Nothing buffered beyond memory; the persisting sink overrides this.
  }

  clear(): void {
    this.buffer = [];
    this.sequence = 0;
  }

  /** Test helper: every event emitted since the last clear, ignoring the ring-buffer window. */
  all(): SimulationEvent[] {
    return [...this.buffer];
  }

  /** Test helper: events of a given type, in order. */
  ofType(type: SimulationEvent['type']): SimulationEvent[] {
    return this.buffer.filter((event) => event.type === type);
  }

  countOfType(type: SimulationEvent['type']): number {
    return this.ofType(type).length;
  }
}
