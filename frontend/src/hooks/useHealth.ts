import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthResponse } from '@bg/shared';
import { api, ApiError } from '../api/client';

export interface HealthState {
  data: HealthResponse | null;
  error: ApiError | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Polls the backend health endpoint.
 *
 * Hand-rolled rather than pulling in a data-fetching library for one endpoint; the richer
 * server-state hooks arrive with the dashboard, where caching and invalidation actually earn their
 * keep.
 */
export function useHealth(pollIntervalMs = 5000): HealthState {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const fetchHealth = useCallback(async () => {
    try {
      const result = await api.get<HealthResponse>('/health');
      if (!mounted.current) return;
      setData(result);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError('INTERNAL_ERROR', String(cause), 0),
      );
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchHealth();

    const timer = setInterval(() => void fetchHealth(), pollIntervalMs);

    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [fetchHealth, pollIntervalMs]);

  return { data, error, loading, refetch: () => void fetchHealth() };
}
