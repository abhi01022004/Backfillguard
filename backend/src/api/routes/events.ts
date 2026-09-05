import { Router } from 'express';
import { z } from 'zod';
import { TRANSPORT, type SimulationEvent } from '@bg/shared';
import { validate } from '../middleware/validate';

/**
 * The reading surface this router actually uses.
 *
 * Declared structurally rather than as `BufferedDbEventSink`, so the API can be exercised over in-memory
 * infrastructure with no database at all. Naming the concrete class here would have forced every API test to
 * stand up Prisma just to read an event count.
 */
export interface EventLogReader {
  /** Durable log, for filling a detected gap. */
  since(sequence: number, limit?: number): Promise<SimulationEvent[]>;
  /** The bounded in-memory window backing the live timeline. */
  recent(limit?: number): SimulationEvent[];
  latestSequence(): number;
  /** Non-zero means the durable log is incomplete. */
  readonly droppedCount: number;
}

export interface EventRoutesDeps {
  events: EventLogReader;
}

const eventQuerySchema = z.strictObject({
  /** Return events with a sequence greater than this. Lets a client fill a gap it detected. */
  sinceSequence: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(TRANSPORT.timelineWindow),
});

type EventQuery = z.infer<typeof eventQuerySchema>;

/**
 * Event log queries (R13.4).
 *
 * The socket carries the live stream; this endpoint serves the durable log. Both are needed: the socket's
 * in-memory window is bounded and its per-record events are coalesced for transport, so anything wanting
 * the complete ordered history — the per-patient timeline, or a client filling a detected gap — reads it
 * from here instead.
 */
export function createEventRouter({ events }: EventRoutesDeps): Router {
  const router = Router();

  router.get('/', validate({ query: eventQuerySchema }), async (req, res, next) => {
    try {
      const query = req.validated.query as EventQuery;

      const items = await events.since(query.sinceSequence, query.limit);

      res.json({
        events: items,
        sinceSequence: query.sinceSequence,
        latestSequence: events.latestSequence(),
        /** Non-zero would mean the durable log is incomplete, so it is surfaced rather than hidden. */
        droppedCount: events.droppedCount,
      });
    } catch (error) {
      next(error);
    }
  });

  /** The in-memory window backing the live timeline, for a client that cannot open a socket. */
  router.get('/recent', async (_req, res, next) => {
    try {
      res.json({
        events: events.recent(TRANSPORT.timelineWindow),
        latestSequence: events.latestSequence(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
