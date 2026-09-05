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

  recent(limit = TRANSPORT.timelineWindow): SimulationEvent[] {
    return this.buffer.slice(-limit);
  }

  latestSequence(): number {
    return this.sequence;
  }

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
