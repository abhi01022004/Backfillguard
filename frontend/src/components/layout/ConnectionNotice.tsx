import { RefreshCw, WifiOff } from 'lucide-react';
import type { ConnectionStatus } from '../../hooks/useLiveStream';

/**
 * Surfaces a dropped live connection (R13.7, R23.6).
 *
 * Renders nothing while connected, so it costs no space in the normal case. When the socket drops it says so
 * explicitly, because the failure mode it prevents is subtle and damaging: a dashboard whose numbers have
 * silently frozen looks exactly like a dashboard whose numbers are simply not changing. Mid-demo that is the
 * difference between "the backfill is idle" and "you are looking at stale data".
 *
 * Socket.IO reconnects on its own, so the retry button asks for a fresh snapshot rather than reconnecting —
 * useful when the connection is fine but a gap is suspected.
 */

export interface ConnectionNoticeProps {
  status: ConnectionStatus;
  onRetry: () => void;
}

export function ConnectionNotice({ status, onRetry }: ConnectionNoticeProps) {
  if (status === 'connected') return null;

  const connecting = status === 'connecting';

  return (
    <div
      className={
        connecting
          ? 'flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600'
          : 'flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800'
      }
      role={connecting ? 'status' : 'alert'}
    >
      {connecting ? (
        <>
          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Connecting to the live event stream…
        </>
      ) : (
        <>
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="font-medium">Live stream disconnected.</span>
          <span className="text-rose-700">
            The numbers below may be out of date. Reconnection is automatic.
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="ml-auto inline-flex items-center gap-1 rounded border border-rose-300 bg-white px-2 py-1 font-medium text-rose-700 hover:bg-rose-100"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Request fresh snapshot
          </button>
        </>
      )}
    </div>
  );
}
