import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENT_TYPE, type CheckpointInfo, type SimulationEvent } from '@bg/shared';
import { api, ApiError } from '../api/client';
import { useEventTrigger } from './useEventTrigger';

/**
 * Checkpoint availability (R7.5, R7.6).
 *
 * Two fields with a deliberately sharp distinction:
 *
 *  - `active` is a checkpoint that could actually be resumed from. Null once checkpoints are destroyed.
 *  - `lastKnown` is the most recent checkpoint whatever its status, kept only so the UI can narrate "the job
 *    last knew it was here". It is never a resume cursor, and the backend enforces that separately (R7.7).
 *
 * The distinction is the entire point of the "destroy the checkpoint" demo step: after it, `active` is null
 * while `lastKnown` still shows a position — so a viewer can see that the job remembers nothing it is
 * allowed to trust.
 */

export interface CheckpointResponse {
  active: CheckpointInfo | null;
  lastKnown: CheckpointInfo | null;
  createdThisRun: number;
}

export interface CheckpointState {
  active: CheckpointInfo | null;
  lastKnown: CheckpointInfo | null;
  createdThisRun: number;
  /** True when a checkpoint exists that could be destroyed. */
  hasCheckpoint: boolean;
  error: string | null;
  refetch: () => void;
}

const TRIGGERS = [
  EVENT_TYPE.CHECKPOINT_CREATED,
  EVENT_TYPE.CHECKPOINT_LOST,
  EVENT_TYPE.BACKFILL_STARTED,
  EVENT_TYPE.BACKFILL_CRASHED,
  EVENT_TYPE.RECOVERY_COMPLETED,
  EVENT_TYPE.SIMULATION_RESET,
] as const;

export function useCheckpoint(events: SimulationEvent[]): CheckpointState {
  const [state, setState] = useState<CheckpointResponse>({
    active: null,
    lastKnown: null,
    createdThisRun: 0,
  });
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  const fetchCheckpoint = useCallback(async () => {
    try {
      const response = await api.get<CheckpointResponse>('/checkpoint');
      if (!mounted.current) return;
      setState(response);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchCheckpoint();
    return () => {
      mounted.current = false;
    };
  }, [fetchCheckpoint]);

  useEventTrigger(events, TRIGGERS, () => void fetchCheckpoint());

  return {
    ...state,
    hasCheckpoint: state.active !== null,
    error,
    refetch: () => void fetchCheckpoint(),
  };
}
