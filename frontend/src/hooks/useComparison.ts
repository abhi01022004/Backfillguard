import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComparisonResult } from '@bg/shared';
import { api, ApiError } from '../api/client';

/**
 * The naive-versus-guarded comparison (R12.5).
 *
 * Every run happens entirely in memory on freshly generated datasets, so the unsafe engine has no path to the
 * demo data — which is why this is safe to trigger at any time, including mid-backfill.
 *
 * The client can request either scenario. `control` runs the same crash and recovery with no updates during
 * the outage, where both engines must agree exactly; it exists because "was the naive engine simply written
 * to fail?" is the first fair question anyone asks, and the answer should be demonstrable rather than
 * asserted.
 */

export type ComparisonScenario = 'contended' | 'control';

export interface ComparisonResponse extends ComparisonResult {
  scenarioDescription?: string;
  headline?: { naive: string; guarded: string };
}

export interface ComparisonState {
  result: ComparisonResponse | null;
  running: boolean;
  /** True once a fetch has completed, so "never run" is distinguishable from "not yet asked". */
  loaded: boolean;
  error: string | null;
  run: (scenario: ComparisonScenario) => Promise<void>;
}

export function useComparison(): ComparisonState {
  const [result, setResult] = useState<ComparisonResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    // Load any previous result on mount, so a page refresh does not lose one that was already computed.
    void (async () => {
      try {
        const latest = await api.get<ComparisonResponse>('/compare/latest');
        if (mounted.current) setResult(latest);
      } catch (cause) {
        // 404 is the expected answer before the first run, not a failure worth showing.
        if (mounted.current && !(cause instanceof ApiError && cause.status === 404)) {
          setError(cause instanceof ApiError ? cause.message : String(cause));
        }
      } finally {
        if (mounted.current) setLoaded(true);
      }
    })();

    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (scenario: ComparisonScenario) => {
    setRunning(true);
    setError(null);
    try {
      const response = await api.post<ComparisonResponse>('/compare/run', { scenario });
      if (!mounted.current) return;
      setResult(response);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      if (mounted.current) {
        setRunning(false);
        setLoaded(true);
      }
    }
  }, []);

  return { result, running, loaded, error, run };
}
