import { useCallback, useState } from 'react';
import type { ActorType, SimulationSettings } from '@bg/shared';
import { api, ApiError } from '../api/client';

/**
 * Invokes the simulation controls (R17.1, R23.6).
 *
 * ## Why nothing here updates local state
 *
 * Every control posts and then does nothing with the response. The resulting state arrives over the live
 * stream, which is the same channel every other client sees. Optimistically applying the response would
 * make this browser briefly disagree with the server and with every other viewer — and during a demo, the
 * projected screen and the presenter's laptop showing different numbers is a credibility problem, not a
 * cosmetic one.
 *
 * ## Why errors are held per action
 *
 * A 409 from `pause` should annotate the pause button, not replace the page with an error. The state
 * machine's messages already name the current state and what is allowed, so surfacing them next to the
 * control that failed makes them actionable (R8.7).
 */

export interface ControlsState {
  /** The action currently in flight, so exactly one control can show a spinner. */
  pending: string | null;
  /** Last failure, keyed by action id. */
  error: { action: string; message: string } | null
  clearError: () => void;
  run: (action: string, request: () => Promise<unknown>) => Promise<boolean>;

  start: (settings?: Partial<SimulationSettings>) => Promise<boolean>;
  pause: () => Promise<boolean>;
  resume: () => Promise<boolean>;
  crash: () => Promise<boolean>;
  recover: () => Promise<boolean>;
  loseCheckpoint: () => Promise<boolean>;
  verify: () => Promise<boolean>;
  reset: () => Promise<boolean>;
  reseed: (options: { totalRecords: number; partitionCount: number }) => Promise<boolean>;
  onlineUpdate: (actorType: ActorType) => Promise<boolean>;
  runDemo: () => Promise<boolean>;
  abortDemo: () => Promise<boolean>;
}

export function useSimulationControls(): ControlsState {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ action: string; message: string } | null>(null);

  const run = useCallback(
    async (action: string, request: () => Promise<unknown>): Promise<boolean> => {
      setPending(action);
      setError(null);
      try {
        await request();
        return true;
      } catch (cause) {
        setError({
          action,
          message: cause instanceof ApiError ? cause.message : String(cause),
        });
        return false;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  return {
    pending,
    error,
    clearError: () => setError(null),
    run,

    start: (settings = {}) => run('start', () => api.post('/backfill/start', settings)),
    pause: () => run('pause', () => api.post('/backfill/pause')),
    resume: () => run('resume', () => api.post('/backfill/resume')),
    crash: () => run('crash', () => api.post('/backfill/crash')),
    recover: () => run('recover', () => api.post('/backfill/recover')),
    loseCheckpoint: () => run('loseCheckpoint', () => api.post('/checkpoint/lose')),
    verify: () => run('verify', () => api.post('/verify')),
    reset: () => run('reset', () => api.post('/reset')),
    reseed: (options) => run('reseed', () => api.post('/seed', options)),
    onlineUpdate: (actorType) =>
      run(`onlineUpdate:${actorType}`, () => api.post('/online-update', { actorType })),
    runDemo: () => run('runDemo', () => api.post('/scenario/demo')),
    abortDemo: () => run('abortDemo', () => api.post('/scenario/abort')),
  };
}
