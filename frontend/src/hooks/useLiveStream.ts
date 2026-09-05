import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  LIVE_CHANNEL,
  LIVE_PATH,
  TRANSPORT,
  type BackfillJobState,
  type LiveSnapshot,
  type SimulationEvent,
} from '@bg/shared';

/**
 * Subscribes to the live simulation stream (R13.3, R13.4, R13.7).
 *
 * The server pushes three things: a full snapshot on connect, individual significant events, and a
 * throttled job-state frame. This hook folds them into one piece of React state so components never have
 * to think about the transport.
 *
 * ## Why a snapshot rather than replaying history
 *
 * A client can connect at any point — mid-run, or after a dropped connection. Rebuilding state by
 * replaying events from zero would be slow and would need the whole log. Instead the server sends current
 * state plus a recent window, so a late or reconnecting client is correct immediately. That makes reconnect
 * self-healing: whatever was missed is superseded by the snapshot that follows.
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface LiveStream {
  status: ConnectionStatus;
  job: BackfillJobState | null;
  /** Significant events, newest last, capped at the timeline window. */
  events: SimulationEvent[];
  latestSequence: number;
  /** Asks the server for a fresh snapshot without reconnecting. */
  resync: () => void;
}

/**
 * Merges incoming events into the existing list.
 *
 * Deduplicates by sequence number, which matters on reconnect: the snapshot's recent window overlaps
 * events already held, and rendering a conflict twice would inflate what the operator sees. Sorting by
 * sequence rather than arrival order also means a frame that arrives slightly out of order still displays
 * correctly.
 */
function mergeEvents(
  existing: SimulationEvent[],
  incoming: SimulationEvent[],
): SimulationEvent[] {
  if (incoming.length === 0) return existing;

  const bySequence = new Map<number, SimulationEvent>();
  for (const event of existing) bySequence.set(event.sequence, event);
  for (const event of incoming) bySequence.set(event.sequence, event);

  return [...bySequence.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-TRANSPORT.timelineWindow);
}

export function useLiveStream(): LiveStream {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [job, setJob] = useState<BackfillJobState | null>(null);
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [latestSequence, setLatestSequence] = useState(0);

  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    /**
     * Connects to the same origin, so the Vite dev proxy handles it in development and a single deployed
     * origin handles it in production. `LIVE_PATH` is Socket.IO's HTTP path, not a namespace.
     */
    const socket = io({
      path: LIVE_PATH,
      transports: ['websocket', 'polling'],
      // Reconnection is left on: a dropped connection during a demo should heal itself rather than
      // requiring a page reload.
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });

    socketRef.current = socket;

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('disconnected'));

    socket.on(LIVE_CHANNEL.snapshot, (snapshot: LiveSnapshot) => {
      setJob(snapshot.job);
      // Merge rather than replace, so a resync mid-run does not discard events the client already had that
      // fall outside the server's recent window.
      setEvents((current) => mergeEvents(current, snapshot.recentEvents));
      setLatestSequence(snapshot.latestSequence);
      setStatus('connected');
    });

    socket.on(LIVE_CHANNEL.event, (event: SimulationEvent) => {
      setEvents((current) => mergeEvents(current, [event]));
      setLatestSequence((current) => Math.max(current, event.sequence));
    });

    socket.on(LIVE_CHANNEL.jobState, (state: BackfillJobState) => {
      setJob(state);
    });

    return () => {
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
    };
  }, []);

  const resync = useMemo(
    () => () => {
      socketRef.current?.emit('resync');
    },
    [],
  );

  return { status, job, events, latestSequence, resync };
}
