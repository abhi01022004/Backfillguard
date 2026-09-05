import {
  Activity,
  CheckCheck,
  GitCompareArrows,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { BackfillJobState, VerificationReport } from '@bg/shared';
import { KpiCard } from './KpiCard';

/**
 * The seven headline numbers (R14.2).
 *
 * ## Where each number comes from, and why that distinction is on screen
 *
 * Five come from live job state — the engine's running account of its own work. Two do not:
 * **Stale Overwrites** and **Coverage** are read from the independent verification report, and show
 * "awaiting verification" until the audit has run.
 *
 * That is deliberate, and it is the most important design decision on this dashboard. "Stale overwrites: 0"
 * is the project's central claim. Sourcing it from the engine that did the writing would make it an
 * assertion; sourcing it from an audit that recomputes from stored rows makes it a finding. Showing a
 * comfortable zero before anyone checked would undermine the one number a judge should trust.
 */

export interface KpiGridProps {
  job: BackfillJobState | null;
  report: VerificationReport | null;
  /** True once the report fetch has completed, so "not asked yet" is not shown as "not run". */
  reportLoaded: boolean;
}

export function KpiGrid({ job, report, reportLoaded }: KpiGridProps) {
  const metrics = job?.metrics ?? null;

  /**
   * Coverage is shown from the audit when available, and from live progress while a run is in flight.
   *
   * Both are honest, but they answer different questions: live progress is "how far through are we", the
   * audited figure is "how many records provably reached a decision". The hint says which one is on screen.
   */
  const auditedCoverage = report?.metrics.coveragePercent ?? null;
  const liveCoverage = metrics?.percentComplete ?? null;
  const coverage = auditedCoverage ?? liveCoverage;
  const coverageHint = auditedCoverage !== null ? 'independently verified' : 'live progress';

  const staleOverwrites = report?.metrics.staleOverwrites ?? null;

  return (
    <section aria-label="Key metrics" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      <KpiCard
        label="Total patients"
        value={metrics?.eligibleRecords ?? null}
        icon={Users}
        tone="neutral"
        hint="synthetic records in scope"
        emptyHint="no job started"
      />

      <KpiCard
        label="Processed"
        value={metrics?.processed ?? null}
        icon={Activity}
        tone="brand"
        hint={
          metrics
            ? `${metrics.applied.toLocaleString('en-GB')} applied · ${metrics.noopAlreadyCurrent.toLocaleString('en-GB')} already current`
            : undefined
        }
        emptyHint="no job started"
      />

      <KpiCard
        label="Conflicts"
        value={metrics?.conflicts ?? null}
        icon={GitCompareArrows}
        tone={metrics && metrics.conflicts > 0 ? 'warning' : 'neutral'}
        hint="version mismatches detected"
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
        label="Protected updates"
        value={metrics?.protectedUpdates ?? null}
        icon={ShieldCheck}
        tone={metrics && metrics.protectedUpdates > 0 ? 'good' : 'neutral'}
        hint="stale writes refused"
        emptyHint="no job started"
      />

      {/* The headline safety number. Audited only — never inferred from the engine's own counters. */}
      <KpiCard
        label="Stale overwrites"
        value={staleOverwrites}
        icon={ShieldAlert}
        tone={staleOverwrites === null ? 'neutral' : staleOverwrites === 0 ? 'good' : 'critical'}
        hint={staleOverwrites === 0 ? 'none — verified' : 'newer data was overwritten'}
        emptyHint={reportLoaded ? 'awaiting verification' : 'checking…'}
        emphasis
      />

      <KpiCard
        label="Coverage"
        value={coverage}
        icon={CheckCheck}
        suffix="%"
        tone={coverage === 100 ? 'good' : 'neutral'}
        hint={coverageHint}
        emptyHint="no job started"
        emphasis
      />
    </section>
  );
}
