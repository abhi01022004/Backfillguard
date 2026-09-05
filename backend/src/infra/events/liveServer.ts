import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import {
  LIVE_CHANNEL,
  LIVE_PATH,
  TRANSPORT,
  type BackfillJobState,
  type LiveSnapshot,
} from '@bg/shared';
import type { EventSink } from '../../domain/ports/EventSink';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

/**
 * Socket.IO server for the live dashboard (R13.3, R13.4).
 *
 * Uses `/live` as the transport *path* rather than a namespace, so one Vite proxy rule covers both the
 * handshake and the upgraded WebSocket.
 */

export interface LiveServerDeps {
  httpServer: HttpServer;
  events: EventSink;
  getJobState: () => Promise<BackfillJobState | null>;
}

export function createLiveServer({ httpServer, events, getJobState }: LiveServerDeps): SocketServer {
  const io = new SocketServer(httpServer, {
    path: LIVE_PATH,
    // Same restriction as the REST API rather than '*' (R22.8).
    cors: { origin: env.CORS_ORIGIN, methods: ['GET', 'POST'] },
    // Long polling is kept as a fallback so a restrictive network cannot break a live demo outright.
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    logger.debug('live client connected', { socketId: socket.id });

    /**
     * Send a full snapshot immediately (R13.4).
     *
     * A client joining mid-run must be correct straight away rather than waiting for the next event. This
     * is also the reconnect path: after a dropped connection the client resubscribes and gets current
     * state, so a gap in the stream self-heals instead of leaving the dashboard stale.
     */
    void (async () => {
      try {
        const job = await getJobState();
        const snapshot: LiveSnapshot = {
          job,
          recentEvents: events.recent(TRANSPORT.timelineWindow),
          latestSequence: events.latestSequence(),
        };
        socket.emit(LIVE_CHANNEL.snapshot, snapshot);
      } catch (error) {
        logger.error('failed to send live snapshot', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    // Lets a client that suspects it missed something ask for a fresh snapshot without reconnecting.
    socket.on('resync', () => {
      void (async () => {
        const job = await getJobState();
        socket.emit(LIVE_CHANNEL.snapshot, {
          job,
          recentEvents: events.recent(TRANSPORT.timelineWindow),
          latestSequence: events.latestSequence(),
        } satisfies LiveSnapshot);
      })();
    });

    socket.on('disconnect', (reason) => {
      logger.debug('live client disconnected', { socketId: socket.id, reason });
    });
  });

  return io;
}
