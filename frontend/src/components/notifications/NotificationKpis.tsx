import { BellRing, MessageCircle, ShieldOff, TrendingUp } from 'lucide-react';
import type { NotificationStats } from '@bg/shared';
import { KpiCard } from '../kpi/KpiCard';

/**
 * The notification counts (feature: patient risk alerts).
 *
 * Reuses `KpiCard`, which carries the rule that matters here: `value` is `number | null` with no default, so
 * before anything is measured these render an em dash and say why rather than a confident zero. "0 alerts sent"
 * shown before a run would be indistinguishable from a broken notification pipeline.
 *
 * ## Why "cancelled" is toned as good rather than as a warning
 *
 * A cancelled alert is the version guard doing its job: a result went stale before it could be transmitted and
 * the alert was withheld. Colouring it amber would tell the viewer something had gone wrong, when in fact the
 * opposite is true — it is the only positive evidence on screen that stale alerts are actually being prevented
 * rather than merely not occurring.
 */

export interface NotificationKpisProps {
  stats: NotificationStats | null;
  /** True once a request has completed, so "no run yet" can be distinguished from "still loading". */
  loaded: boolean;
}

export function NotificationKpis({ stats, loaded }: NotificationKpisProps) {
  const emptyHint = loaded ? 'no alerts yet' : 'loading…';

  return (
    <section
      aria-label="Risk notification metrics"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <KpiCard
        label="High-risk patients"
        value={stats?.highRiskPatients ?? null}
        icon={BellRing}
        tone={stats && stats.highRiskPatients > 0 ? 'warning' : 'neutral'}
        hint="distinct patients alerted on"
        emptyHint={emptyHint}
      />

      <KpiCard
        label="Alerts sent"
        value={stats?.sent ?? null}
        icon={MessageCircle}
        tone={stats && stats.sent > 0 ? 'good' : 'neutral'}
        hint="each from a version-checked commit"
        emptyHint={emptyHint}
      />

      <KpiCard
        label="Stale alerts prevented"
        value={stats?.cancelled ?? null}
        icon={ShieldOff}
        // Good, not warning: a cancellation is the guard working, and it is the evidence that it works.
        tone={stats && stats.cancelled > 0 ? 'good' : 'neutral'}
        hint={
          stats && stats.cancelled === 0
            ? 'none needed yet'
            : 'the record moved before sending'
        }
        emptyHint={emptyHint}
      />

      <KpiCard
        label="Send success rate"
        value={stats?.successRate ?? null}
        icon={TrendingUp}
        suffix="%"
        tone={stats?.successRate === 100 ? 'good' : stats?.successRate == null ? 'neutral' : 'warning'}
        hint="cancelled alerts excluded"
        // Null here is meaningful rather than missing: nothing has been attempted, so there is no rate.
        emptyHint="nothing attempted yet"
      />
    </section>
  );
}
