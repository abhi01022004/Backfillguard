import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENT_TYPE, type RecoverySummary, type SimulationEvent } from '@bg/shared';
import { api, ApiError } from '../api/client';
import { useEventTrigger } from './useEventTrigger';

/**
 * The last recovery's summary (R9.7).
 *
 * Fetched rather than read off the `RECOVERY_COMPLETED` event, even though that event carries the same numbers
 * in its payload. Two reasons: the event stream is a capped rolling window, so on a long run the event scrolls
 * out and the summary would silently disappear from the UI; and the endpoint serves the orchestrator's own
 * record, so the panel and the API cannot disagree about what recovery did.
 *
 * The number that matters here is `noops` — records revisited and deliberately left alone. It is the evidence
 * that recovery reasoned from version data rather than rewriting everything it could not account for.
 */

export interface RecoveryState {
  recovery: RecoverySummary | null;
  error: string | null;
  refetch: () => void;
}

const TRIGGERS = [
  EVENT_TYPE.RECOVERY_COMPLETED,
  EVENT_TYPE.BACKFILL_STARTED,
  EVENT_TYPE.SIMULATION_RESET,
] as const;

export function useRecovery(events: SimulationEvent[]): RecoveryState {
  const [recovery, setRecovery] = useState<RecoverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  const fetchRecovery = useCallback(async () => {
    try {
      const response = await api.get<{ recovery: RecoverySummary | null }>('/backfill/recovery');
      if (!mounted.current) return;
      setRecovery(response.recovery);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchRecovery();
    return () => {
      mounted.current = false;
    };
  }, [fetchRecovery]);

  useEventTrigger(events, TRIGGERS, () => void fetchRecovery());

  return { recovery, error, refetch: () => void fetchRecovery() };
}
