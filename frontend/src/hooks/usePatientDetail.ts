import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENT_TYPE, type PatientDetail, type SimulationEvent } from '@bg/shared';
import { api, ApiError } from '../api/client';
import { useEventTrigger } from './useEventTrigger';

/**
 * One patient with its recomputed risk breakdown and merged version history (R16.3, R16.4).
 *
 * Refetched on any event that could change this record's story, including per-record ones. Unlike the list,
 * a single open record is cheap to refresh and it is the surface where a viewer is actively watching for a
 * conflict to appear — so here the noise is the point.
 *
 * `code === null` means the drawer is closed. The hook still runs (React requires it) but performs no
 * request and holds no stale detail, so reopening on a different patient cannot briefly show the previous
 * one's history.
 */

export interface PatientDetailState {
  detail: PatientDetail | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const TRIGGERS = [
  EVENT_TYPE.ONLINE_UPDATE,
  EVENT_TYPE.CONFLICT_DETECTED,
  EVENT_TYPE.STALE_RESULT_REJECTED,
  EVENT_TYPE.RE_EVALUATION_COMPLETED,
  EVENT_TYPE.RECORD_NO_ACTION,
  EVENT_TYPE.RECORD_FAILED,
  EVENT_TYPE.RECOVERY_COMPLETED,
  EVENT_TYPE.BACKFILL_COMPLETED,
  EVENT_TYPE.SIMULATION_RESET,
] as const;

export function usePatientDetail(
  code: string | null,
  events: SimulationEvent[],
): PatientDetailState {
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  const fetchDetail = useCallback(async () => {
    if (!code) {
      setDetail(null);
      setError(null);
      return;
    }

    setLoading(true);
    try {
      const response = await api.get<PatientDetail>(`/patients/${encodeURIComponent(code)}`);
      if (!mounted.current) return;
      setDetail(response);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setDetail(null);
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    mounted.current = true;
    // Clear immediately on a code change, so the previous patient's history is never shown under a new
    // patient's heading while the request is in flight.
    setDetail(null);
    void fetchDetail();
    return () => {
      mounted.current = false;
    };
  }, [fetchDetail]);

  useEventTrigger(events, TRIGGERS, () => {
    if (code) void fetchDetail();
  });

  return { detail, loading, error, refetch: () => void fetchDetail() };
}
