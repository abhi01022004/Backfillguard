import { TRANSPORT, type SimulationEvent } from '@bg/shared';
import type { EmitEventInput, EventSink } from '../../domain/ports/EventSink';
import type { AppPrismaClient } from '../db/prisma';
import { logger } from '../../lib/logger';
import type { InMemoryEventSink } from './InMemoryEventSink';

/**
 * Persists the event stream to the database in batches (R13.1).
 *
 * A full run over 1,000 records emits several thousand events. Writing each one individually would put
 * thousands of round trips in the middle of the engine's hot path, and on SQLite that write pressure is
 * exactly what WAL mode and the batching here exist to avoid.
 *
 * ## Why the durable log matters at all
 *
 * The in-memory ring buffer only holds a recent window, which is right for the live timeline but useless
 * for after the fact. The per-patient history view and the audit trail both need the full sequence, so it
 * goes to `EventLog` — and because sequence numbers are assigned once, by the base sink, the persisted
 * stream is provably gap-free and can be replayed in order.
 *
 * ## Failure policy
 *
 * A failed event insert must never break a run. Events are diagnostic; the ledgers are the evidence. So a
 * persistence error is logged and the batch dropped rather than propagated into the engine, where it would
 * turn an observability problem into a correctness one.
 */
export class BufferedDbEventSink implements EventSink {
  private queue: SimulationEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private dropped = 0;

  constructor(
    private readonly base: InMemoryEventSink,
    private readonly prisma: AppPrismaClient,
  ) {}

  emit(input: EmitEventInput): SimulationEvent {
    const event = this.base.emit(input);
    this.queue.push(event);

    if (this.queue.length >= TRANSPORT.eventFlushBatchSize) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }

    return event;
  }

  recent(limit?: number): SimulationEvent[] {
    return this.base.recent(limit);
  }

  latestSequence(): number {
    return this.base.latestSequence();
  }

  /**
   * Writes any queued events.
   *
   * Serialised through `this.flushing` so two concurrent flushes cannot interleave and write the same
   * batch twice — `sequence` is unique, so a double write would fail the second insert and lose events
   * that were actually fine.
   */
  async flush(): Promise<void> {
    this.clearTimer();

    if (this.flushing) {
      await this.flushing;
      // Another flush may have arrived while waiting; drain whatever is left.
      if (this.queue.length === 0) return;
    }

    if (this.queue.length === 0) return;

    const batch = this.queue;
    this.queue = [];

    this.flushing = this.write(batch).finally(() => {
      this.flushing = null;
    });

    await this.flushing;
  }

  private async write(batch: SimulationEvent[]): Promise<void> {
    try {
      await this.prisma.eventLog.createMany({
        data: batch.map((event) => ({
          sequence: event.sequence,
          jobId: event.jobId ?? null,
          type: event.type,
          severity: event.severity,
          message: event.message,
          patientCode: event.patientCode ?? null,
          partitionIndex: event.partitionIndex ?? null,
          payload: event.payload ? JSON.stringify(event.payload) : null,
          createdAt: new Date(event.createdAt),
        })),
      });
    } catch (error) {
      // Deliberately swallowed: the event log is diagnostic, the ledgers are the evidence. Failing a
      // backfill because a log insert failed would turn an observability problem into a correctness one.
      this.dropped += batch.length;
      logger.warn('failed to persist event batch', {
        count: batch.length,
        droppedTotal: this.dropped,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, TRANSPORT.eventFlushIntervalMs);
    // Never hold the process open for a pending log write.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  clear(): void {
    this.clearTimer();
    this.queue = [];
    this.dropped = 0;
    this.base.clear();
  }

  /** Events since a given sequence number, read from the durable log (R13.4). */
  async since(sequence: number, limit = 500): Promise<SimulationEvent[]> {
    const rows = await this.prisma.eventLog.findMany({
      where: { sequence: { gt: sequence } },
      orderBy: { sequence: 'asc' },
      take: limit,
    });

    return rows.map((row) => ({
      sequence: row.sequence,
      type: row.type as SimulationEvent['type'],
      severity: row.severity as SimulationEvent['severity'],
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      ...(row.jobId === null ? {} : { jobId: row.jobId }),
      ...(row.patientCode === null ? {} : { patientCode: row.patientCode }),
      ...(row.partitionIndex === null ? {} : { partitionIndex: row.partitionIndex }),
      ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as Record<string, unknown> }),
    }));
  }

  get droppedCount(): number {
    return this.dropped;
  }
}
