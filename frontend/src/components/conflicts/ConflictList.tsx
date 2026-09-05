import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { CONFLICT_RESOLUTION, type ConflictRecord } from '@bg/shared';
import { ConflictCard } from './ConflictCard';

export interface ConflictListProps {
  conflicts: ConflictRecord[];
  total: number;
  open: number;
  loading: boolean;
  error: string | null;
  onSelectPatient?: (patientCode: string) => void;
  /** How many to render before the "show all" control. */
  initialVisible?: number;
}

/**
 * Detected conflicts, newest first (R14.3, R10.6).
 *
 * ## Why zero conflicts is presented as a caveat, not a success
 *
 * An empty list is tempting to render as a green tick. It is not one. Zero conflicts means the guard was
 * never exercised, so the run proves nothing about safety under contention — the interesting property is
 * untested, not confirmed. Saying so is the difference between a demo and a claim.
 */
export function ConflictList({
  conflicts,
  total,
  open,
  loading,
  error,
  onSelectPatient,
  initialVisible = 6,
}: ConflictListProps) {
  const [expanded, setExpanded] = useState(false);

  // Newest first, without mutating the caller's array.
  const ordered = [...conflicts].reverse();
  const visible = expanded ? ordered : ordered.slice(0, initialVisible);

  const resolved = conflicts.filter(
    (conflict) => conflict.resolution === CONFLICT_RESOLUTION.REEVALUATED,
  ).length;

  return (
    <section
      aria-labelledby="conflicts-heading"
      className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
        <h2
          id="conflicts-heading"
          className="flex items-center gap-2 text-base font-semibold text-slate-900"
        >
          <ShieldAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
          Version conflicts
        </h2>

        {total > 0 ? (
          <p className="text-xs text-slate-600">
            <span className="font-semibold tabular-nums text-slate-900">{total}</span> detected ·{' '}
            <span className="font-semibold tabular-nums text-emerald-800">{resolved}</span>{' '}
            re-evaluated
            {open > 0 ? (
              <>
                {' '}
                · <span className="font-semibold tabular-nums text-amber-800">{open}</span> open
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {error ? (
        <p className="px-5 py-6 text-sm text-rose-700">{error}</p>
      ) : loading && conflicts.length === 0 ? (
        <p className="px-5 py-6 text-sm text-slate-500">Loading conflicts…</p>
      ) : conflicts.length === 0 ? (
        <div className="px-5 py-6">
          <p className="text-sm text-slate-600">No conflicts detected yet.</p>
          <p className="mt-1.5 text-xs text-slate-500">
            That is not the same as a safe run. A conflict is the version guard actually firing, so with
            none recorded the guard has not yet been exercised and this run demonstrates nothing about
            behaviour under contention. Trigger a clinical update while the backfill is mid-batch, or run
            the scripted demo.
          </p>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
            {visible.map((conflict) => (
              <ConflictCard
                key={conflict.id}
                conflict={conflict}
                {...(onSelectPatient ? { onSelectPatient } : {})}
              />
            ))}
          </div>

          {ordered.length > initialVisible ? (
            <div className="border-t border-slate-100 px-5 py-2.5">
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className="text-xs font-medium text-brand-700 hover:text-brand-900"
              >
                {expanded
                  ? `Show only the latest ${initialVisible}`
                  : `Show all ${ordered.length} conflicts`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
