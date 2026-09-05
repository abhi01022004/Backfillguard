import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENT_TYPE, type SimulationEvent, type VerificationReport } from '@bg/shared';
import { api, ApiError } from '../api/client';

/**
 * Tracks the latest independent verification report.
 *
 * Kept separate from the live stream on purpose. Job metrics are *the engine's* running account of itself;
 * a verification report is an independent audit of persisted state. Conflating them would let the dashboard
 * present an unaudited number with the same authority as an audited one — which is precisely the confusion
 * this project exists to avoid.
 *
 * `null` means verification has not run. That is a meaningful state, not a loading gap: it is why the
 * stale-overwrite card shows "awaiting verification" rather than a reassuring zero (R14.6).
 */

export interface VerificationReportState {
  report: VerificationReport | null;
  loading: boolean;
  /** True once a fetch has completed, so "no report" can be distinguished from "not yet asked". */
  loaded: boolean;
  error: string | null;
  refetch: () => void;
}

export function useVerificationReport(events: SimulationEvent[]): VerificationReportState {
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<VerificationReport>('/verify/latest');
      if (!mounted.current) return;
      setReport(result);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;

      // 404 is the expected answer before verification has been run, not a failure worth showing.
      if (cause instanceof ApiError && cause.status === 404) {
        setReport(null);
        setError(null);
      } else {
        setError(cause instanceof ApiError ? cause.message : String(cause));
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchReport();
    return () => {
      mounted.current = false;
    };
  }, [fetchReport]);

  /**
   * Refetch when the report's validity changes.
   *
   * Driven by the event stream rather than polling: the stream already says exactly when something relevant
   * happened, and the report only changes on those events.
   *
   * Crucially this includes `BACKFILL_STARTED` and `SIMULATION_RESET`, not just verification verdicts. A
   * report describes one specific run, so the moment a new run begins the old one describes history. A live
   * check caught the consequence of omitting these: the dashboard showed an audited "coverage 100%" while a
   * fresh run was only 140 records in, and kept showing it after a reset had wiped the data it described.
   */
  const invalidatingSequence = events.reduce((highest, event) => {
    if (
      event.type === EVENT_TYPE.VERIFICATION_PASSED ||
      event.type === EVENT_TYPE.VERIFICATION_FAILED ||
      event.type === EVENT_TYPE.BACKFILL_STARTED ||
      event.type === EVENT_TYPE.SIMULATION_RESET
    ) {
      return Math.max(highest, event.sequence);
    }
    return highest;
  }, 0);

  const lastHandledRef = useRef(0);

  useEffect(() => {
    if (invalidatingSequence === 0 || invalidatingSequence === lastHandledRef.current) return;
    lastHandledRef.current = invalidatingSequence;
    void fetchReport();
  }, [invalidatingSequence, fetchReport]);

  return { report, loading, loaded, error, refetch: () => void fetchReport() };
}
