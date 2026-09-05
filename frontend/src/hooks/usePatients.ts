import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EVENT_TYPE,
  type BackfillStatus,
  type Paginated,
  type Patient,
  type RiskLevel,
  type SimulationEvent,
} from '@bg/shared';
import { api, ApiError } from '../api/client';
import { useEventTrigger } from './useEventTrigger';

/**
 * The paginated, filtered patient list (R16.1, R16.2).
 *
 * ## Why filtering is server-side
 *
 * The dataset can reach 5,000 records. Fetching all of them to filter in the browser would work, and would
 * also mean the numbers on screen came from a snapshot taken at page load — steadily diverging from the
 * database while a backfill rewrote every row underneath it. Server-side filtering keeps each page a
 * genuine read of current state.
 *
 * ## Refresh policy
 *
 * Refetched on run-lifecycle events rather than on every record write. A 1,000-record run writes a row
 * roughly forty times a second; refetching the page each time would be pointless load, and the rows would
 * flicker faster than anyone could read them. The trade-off is stated plainly in the UI: the list carries a
 * "refresh" control and shows when it last loaded, so a stale page is visible rather than misleading.
 */

export interface PatientFilters {
  status: BackfillStatus | '';
  riskLevel: RiskLevel | '';
  partitionIndex: number | '';
  q: string;
}

export const EMPTY_FILTERS: PatientFilters = {
  status: '',
  riskLevel: '',
  partitionIndex: '',
  q: '',
};

export interface PatientsState {
  patients: Patient[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  loading: boolean;
  error: string | null;
  /** When the currently displayed page was fetched, so staleness is visible. */
  fetchedAt: string | null;
  setPage: (page: number) => void;
  refetch: () => void;
}

/** Events after which the whole list is likely to have changed materially. */
const TRIGGERS = [
  EVENT_TYPE.BACKFILL_STARTED,
  EVENT_TYPE.BACKFILL_COMPLETED,
  EVENT_TYPE.RECOVERY_COMPLETED,
  EVENT_TYPE.SIMULATION_RESET,
  EVENT_TYPE.DATASET_SEEDED,
] as const;

function buildQuery(filters: PatientFilters, page: number, pageSize: number): string {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });

  // Empty strings are omitted rather than sent: the server uses `strictObject`, and an empty `status`
  // would be a validation error rather than "no filter".
  if (filters.status) params.set('status', filters.status);
  if (filters.riskLevel) params.set('riskLevel', filters.riskLevel);
  if (filters.partitionIndex !== '') params.set('partitionIndex', String(filters.partitionIndex));
  if (filters.q.trim()) params.set('q', filters.q.trim());

  return params.toString();
}

export function usePatients(
  filters: PatientFilters,
  events: SimulationEvent[],
  pageSize = 25,
): PatientsState {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<Patient> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const mounted = useRef(true);

  // Serialised so the fetch effect depends on the filters' *value*, not on a fresh object each render.
  const query = useMemo(() => buildQuery(filters, page, pageSize), [filters, page, pageSize]);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<Paginated<Patient>>(`/patients?${query}`);
      if (!mounted.current) return;
      setResult(response);
      setFetchedAt(new Date().toISOString());
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    mounted.current = true;
    void fetchPage();
    return () => {
      mounted.current = false;
    };
  }, [fetchPage]);

  /**
   * Return to page one whenever the filters change.
   *
   * Staying on page 7 of a result set that now has two pages shows an empty table, which reads as "no
   * matches" when the truth is "you are past the end".
   */
  const filterKey = buildQuery(filters, 1, pageSize);
  const lastFilterKey = useRef(filterKey);

  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    setPage(1);
  }, [filterKey]);

  useEventTrigger(events, TRIGGERS, () => void fetchPage());

  return {
    patients: result?.items ?? [],
    page: result?.page ?? page,
    pageSize,
    total: result?.total ?? 0,
    totalPages: result?.totalPages ?? 0,
    loading,
    error,
    fetchedAt,
    setPage,
    refetch: () => void fetchPage(),
  };
}
