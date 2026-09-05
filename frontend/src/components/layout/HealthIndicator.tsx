import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { useHealth } from '../../hooks/useHealth';

/**
 * Backend connectivity indicator.
 *
 * This is the acceptance surface for R1.2 (the frontend must demonstrably reach the backend health
 * endpoint) and it stays useful afterwards as the disconnected state required by R23.6.
 *
 * State is conveyed by icon and text as well as colour (R24.6).
 */
export function HealthIndicator() {
  const { data, error, loading, refetch } = useHealth();

  if (loading && !data && !error) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Connecting to backend
      </span>
    );
  }

  if (error) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-200"
        role="alert"
      >
        <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
        Backend unreachable
        <button
          type="button"
          onClick={refetch}
          className="ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-rose-700 hover:bg-rose-100"
          aria-label="Retry connecting to the backend"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Retry
        </button>
      </span>
    );
  }

  const degraded = data?.status === 'degraded';

  return (
    <span
      className={
        degraded
          ? 'inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200'
          : 'inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200'
      }
      role="status"
    >
      {degraded ? (
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {degraded ? 'Backend degraded' : 'Backend connected'}
      <span className="font-mono text-[10px] text-slate-500">v{data?.version}</span>
    </span>
  );
}
