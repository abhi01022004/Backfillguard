import { Router } from 'express';
import { z } from 'zod';
import { TRANSPORT } from '@bg/shared';
import type { BufferedDbEventSink } from '../../infra/events/BufferedDbEventSink';
import { validate } from '../middleware/validate';

export interface EventRoutesDeps {
  events: BufferedDbEventSink;
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
