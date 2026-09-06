import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EVENT_TYPE,
  type NotificationRecord,
  type NotificationStats,
  type SimulationEvent,
} from '@bg/shared';
import { api, ApiError } from '../api/client';
import { useEventTrigger } from './useEventTrigger';

/**
 * The risk notifications raised by the current run.
 *
 * Read from `/api/notifications`, which serves stored rows — deliberately not accumulated from the event
 * stream, for the same reason `useConflicts` does not. The stream is a capped rolling window, so a long run
 * would silently start under-counting and a reconnect could double-count. The stored rows are also what the
 * verification report audits, so the panel and the report cannot disagree about how many alerts were sent.
 *
 * Statuses are fetched whole rather than filtered server-side per tab. A full run produces a few hundred
 * notifications at most, and holding them all client-side means switching filters is instant and does not
 * fire a request per click. The counts on the filter tabs come from the same array, so they cannot disagree
 * with what the tab shows when opened.
 */

export interface ProviderInfo {
  name: string;
  /** True for the demo provider. Surfaced so the UI can say nothing was actually transmitted. */
  simulated: boolean;
}

export interface NotificationListResponse {
  notifications: NotificationRecord[];
  provider: ProviderInfo;
  disclaimer: string;
}

export type NotificationStatsResponse = NotificationStats & { provider: ProviderInfo };

export interface NotificationsState {
  notifications: NotificationRecord[];
  stats: NotificationStats | null;
  provider: ProviderInfo | null;
  loading: boolean;
  error: string | null;
  /** Set while a manual test send is in flight, so the button can disable itself. */
  sending: boolean;
  sendError: string | null;
  sendTest: (patientCode?: string) => Promise<void>;
  refetch: () => void;
}

/** Events after which the notification set may have changed. */
const TRIGGERS = [
  EVENT_TYPE.NOTIFICATION_QUEUED,
  EVENT_TYPE.NOTIFICATION_SENT,
  EVENT_TYPE.NOTIFICATION_CANCELLED,
  EVENT_TYPE.NOTIFICATION_FAILED,
  EVENT_TYPE.BACKFILL_STARTED,
  EVENT_TYPE.BACKFILL_COMPLETED,
  EVENT_TYPE.RECOVERY_COMPLETED,
  EVENT_TYPE.SIMULATION_RESET,
] as const;

export function useNotifications(events: SimulationEvent[]): NotificationsState {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [stats, setStats] = useState<NotificationStats | null>(null);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const mounted = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      /**
       * Both requests in parallel.
       *
       * The stats are computed by the database rather than derived from the list here, because the list is
       * capped by `limit` — deriving `total` from a truncated array would understate it, and the KPI would
       * quietly disagree with the report.
       */
      const [list, statsResponse] = await Promise.all([
        api.get<NotificationListResponse>('/notifications?limit=500'),
        api.get<NotificationStatsResponse>('/notifications/stats'),
      ]);

      if (!mounted.current) return;

      setNotifications(list.notifications);
      setProvider(list.provider);

      const { provider: _provider, ...counts } = statsResponse;
      setStats(counts);
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
    void fetchAll();
    return () => {
      mounted.current = false;
    };
  }, [fetchAll]);

  useEventTrigger(events, TRIGGERS, () => void fetchAll());

  /**
   * Fires the manual test send, then refetches rather than inserting the returned row locally.
   *
   * Appending it optimistically would be one line shorter and would put a record on screen that the server
   * had not confirmed. Everything else on this dashboard reflects server state for exactly that reason, and a
   * notification panel showing a message that was never recorded would undermine the one claim the feature
   * makes.
   */
  const sendTest = useCallback(
    async (patientCode?: string) => {
      setSending(true);
      setSendError(null);
      try {
        await api.post('/notifications/test', patientCode ? { patientCode } : {});
        await fetchAll();
      } catch (cause) {
        if (!mounted.current) return;
        setSendError(cause instanceof ApiError ? cause.message : String(cause));
      } finally {
        if (mounted.current) setSending(false);
      }
    },
    [fetchAll],
  );

  return {
    notifications,
    stats,
    provider,
    loading,
    error,
    sending,
    sendError,
    sendTest,
    refetch: () => void fetchAll(),
  };
}
