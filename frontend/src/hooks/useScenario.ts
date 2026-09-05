import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENT_TYPE, type ScenarioState, type SimulationEvent } from '@bg/shared';
import { api, ApiError } from '../api/client';
import { useEventTrigger } from './useEventTrigger';

/**
 * The scripted demo's step tracker (R18.7).
 *
 * `POST /api/scenario/demo` returns immediately with 202: the run takes tens of seconds by design, so
 * holding the request open would risk a proxy timeout killing the demo halfway through. Progress therefore
 * arrives on the event stream, and each `SCENARIO_STEP` event triggers a refetch of the step list here.
 *
 * That makes the tracker eventually consistent with the server rather than optimistic, which is the right
 * trade: a step shown as done that the server has not reached would be a lie about the one thing this
 * feature exists to demonstrate.
 */

export interface ScenarioResponse {
  scenario: ScenarioState;
}

export interface ScenarioTrackerState {
  scenario: ScenarioState | null;
  error: string | null;
  refetch: () => void;
}

const TRIGGERS = [
  EVENT_TYPE.SCENARIO_STARTED,
  EVENT_TYPE.SCENARIO_STEP,
  EVENT_TYPE.SCENARIO_COMPLETED,
  EVENT_TYPE.SCENARIO_ABORTED,
] as const;

export function useScenario(events: SimulationEvent[]): ScenarioTrackerState {
  const [scenario, setScenario] = useState<ScenarioState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  const fetchScenario = useCallback(async () => {
    try {
      const response = await api.get<ScenarioResponse>('/scenario/state');
      if (!mounted.current) return;
      setScenario(response.scenario);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchScenario();
    return () => {
      mounted.current = false;
    };
  }, [fetchScenario]);

  useEventTrigger(events, TRIGGERS, () => void fetchScenario());

  return { scenario, error, refetch: () => void fetchScenario() };
}
