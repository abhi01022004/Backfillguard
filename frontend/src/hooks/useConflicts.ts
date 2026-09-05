import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENT_TYPE, type ConflictRecord, type SimulationEvent } from '@bg/shared';
import { api, ApiError } from '../api/client';
import { useEventTrigger } from './useEventTrigger';

/**
 * The conflicts recorded for the current job (R10.6).
 *
 * Fetched from `/api/backfill/conflicts`, which serves stored rows — deliberately not accumulated from the
 * event stream. The two would drift: the stream is capped at a rolling window, so on a long run the client
 * would silently start under-counting, and a reconnect could double-count. More importantly, the stored rows
 * are the same evidence the verification engine audits, so the number on screen and the number in the report
 * cannot disagree.
 */

export interface ConflictsResponse {
  jobId: string;
  total: number;
  open: number;
  conflicts: ConflictRecord[];
}

export interface ConflictsState {
  conflicts: ConflictRecord[];
  total: number;
  open: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Events after which the conflict set may have changed. */
const TRIGGERS = [
  EVENT_TYPE.CONFLICT_DETECTED,
  EVENT_TYPE.RE_EVALUATION_COMPLETED,
  EVENT_TYPE.RECOVERY_COMPLETED,
  EVENT_TYPE.BACKFILL_COMPLETED,
  EVENT_TYPE.BACKFILL_STARTED,
  EVENT_TYPE.SIMULATION_RESET,
  EVENT_TYPE.RECORD_FAILED,
] as const;

export function useConflicts(events: SimulationEvent[]): ConflictsState {
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  const fetchConflicts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<ConflictsResponse>('/backfill/conflicts');
      if (!mounted.current) return;
      setConflicts(result.conflicts);
      setTotal(result.total);
      setOpen(result.open);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchConflicts();
    return () => {
      mounted.current = false;
    };
  }, [fetchConflicts]);

  useEventTrigger(events, TRIGGERS, () => void fetchConflicts());

  return { conflicts, total, open, loading, error, refetch: () => void fetchConflicts() };
}
