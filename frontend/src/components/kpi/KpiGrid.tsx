import { GitCompareArrows, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import type { BackfillJobState } from '@bg/shared';
import { KpiCard } from './KpiCard';

/**
 * The headline counts (R14.2).
 *
 * ## Why four cards and not seven
 *
 * This grid used to carry seven, laid out in a single row. At 1600px that gave each card about 190px — too
 * narrow for a label, a value and a hint — and seven divides badly at every breakpoint.
 *
 * Two of the original seven, **Stale overwrites** and **Coverage**, moved to the pinned status strip. They are
 * the two audited numbers and the ones you must never lose sight of while scrolling, so pinning them is
 * strictly better than placing them in a row that scrolls away.
 *
 * A third, **Processed**, was removed rather than moved: the status strip already shows
 * `processed / eligible` with a bar, and its applied-versus-already-current breakdown belongs with the other
 * run detail in the progress panel.
 *
 * ## The redundancy this collapsed
 *
 * The old grid showed *Protected updates* and *Stale writes blocked* as separate cards. They are the same
 * event counted from two directions — the shared type defines protected updates as "one per blocked stale
 * write" — so they are equal by construction, and a live run confirmed it: both read 11. Two cards showing
 * the same number implies two independent measurements. They are now one card that states both framings.
 *
 * ## What is preserved
 *
 * `value` is still `number | null` with no default. Before a run these read "—" and say why, because a
 * confident zero for something nobody measured is the one thing this dashboard must never render.
 */

export interface KpiGridProps {
  job: BackfillJobState | null;
}

export function KpiGrid({ job }: KpiGridProps) {
  const metrics = job?.metrics ?? null;

  return (
    <section aria-label="Key metrics" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label="Total patients"
        value={metrics?.eligibleRecords ?? null}
        icon={Users}
        tone="neutral"
        hint="synthetic records in scope"
        emptyHint="no job started"
      />

      <KpiCard
        label="Conflicts detected"
        value={metrics?.conflicts ?? null}
        icon={GitCompareArrows}
        tone={metrics && metrics.conflicts > 0 ? 'warning' : 'neutral'}
        hint={
          metrics && metrics.conflicts === 0
            ? 'none yet — the guard is untested'
            : 'a clinical update landed mid-computation'
        }
        emptyHint="no job started"
      />

      <KpiCard
        label="Re-evaluated"
        value={metrics?.reevaluated ?? null}
        icon={RefreshCw}
        tone={metrics && metrics.reevaluated > 0 ? 'good' : 'neutral'}
        hint="recomputed from current data"
        emptyHint="no job started"
      />

      <KpiCard
        label="Stale writes blocked"
        value={metrics?.staleWriteAttemptsBlocked ?? null}
        icon={ShieldCheck}
        tone={metrics && metrics.staleWriteAttemptsBlocked > 0 ? 'good' : 'neutral'}
        // Both framings on one card, because they are the same event: each blocked write is an update protected.
        hint="= clinical updates protected"
        emptyHint="no job started"
      />
    </section>
  );
}
