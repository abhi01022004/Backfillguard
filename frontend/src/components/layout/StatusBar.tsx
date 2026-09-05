import { Settings2, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { BackfillJobState, VerificationReport } from '@bg/shared';
import { JobStateBadge } from './JobStateBadge';
import { PartitionStrip } from '../backfill/PartitionStrip';

/**
 * The pinned status strip (R14.1, R14.4).
 *
 * ## Why this exists
 *
 * The dashboard grew to roughly five screens tall, and the consequence was that scrolling to the conflict
 * feed took the run state off screen. During a live demo that is the wrong trade: you lose sight of *whether
 * the job is running* exactly when you are looking at what it produced.
 *
 * So the four things you must never lose track of are pinned here — job state, progress, and the two audited
 * safety numbers — and everything else is free to scroll underneath.
 *
 * ## Why only these four
 *
 * The temptation is to pin all seven KPIs. A strip that tall stops being a strip. These four were chosen
 * because each answers a distinct question: *is it running*, *how far*, *did it stay safe*, *did it skip
 * anything*. The rest are supporting detail and belong in the body.
 *
 * Note that Stale overwrites and Coverage come from the independent audit and read "—" until it has run. That
 * is preserved from the KPI cards deliberately: pinning a comfortable zero to the top of every screen would
 * be the most prominent unsupported claim in the whole interface.
 */

export interface StatusBarProps {
  job: BackfillJobState | null;
  report: VerificationReport | null;
  reportLoaded: boolean;
  /** Opens the controls drawer. */
  onOpenControls: () => void;
  /** Shown on the controls button so a pending action is visible while scrolled away. */
  pendingAction?: string | null;
}

function Metric({
  label,
  value,
  suffix,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  suffix?: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'critical' | 'muted';
}) {
  const valueClass =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'critical'
        ? 'text-rose-700'
        : tone === 'muted'
          ? 'text-slate-500'
          : 'text-slate-900';

  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase leading-tight tracking-wide text-slate-500">
        {label}
      </p>
      <p className={`text-base font-semibold leading-tight tabular-nums ${valueClass}`}>
        {value}
        {suffix ? <span className="text-xs font-medium">{suffix}</span> : null}
      </p>
      {hint ? <p className="truncate text-[10px] leading-tight text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function StatusBar({
  job,
  report,
  reportLoaded,
  onOpenControls,
  pendingAction = null,
}: StatusBarProps) {
  const metrics = job?.metrics ?? null;

  const staleOverwrites = report?.metrics.staleOverwrites ?? null;
  const auditedCoverage = report?.metrics.coveragePercent ?? null;
  const coverage = auditedCoverage ?? metrics?.percentComplete ?? null;

  return (
    <div
      /**
       * Sticky rather than fixed, so it participates in the document flow and cannot overlap content. `top-0`
       * is relative to the scroll container, and the header above it scrolls away normally — pinning the
       * header too would cost a third of the viewport on a laptop.
       */
      className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur"
    >
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
        <JobStateBadge status={job?.status ?? null} size="sm" />

        {/* --- progress --- */}
        {metrics ? (
          <div className="flex min-w-[11rem] flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  Records considered
                </p>
                <p className="text-xs font-semibold tabular-nums text-slate-700">
                  {metrics.processed.toLocaleString('en-GB')}
                  <span className="text-slate-500"> / {metrics.eligibleRecords.toLocaleString('en-GB')}</span>
                </p>
              </div>
              <div
                className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200"
                role="progressbar"
                aria-valuenow={metrics.processed}
                aria-valuemin={0}
                aria-valuemax={metrics.eligibleRecords}
                aria-label="Records considered"
              >
                <div
                  className="h-full rounded-full bg-brand-600 transition-[width] duration-200 ease-out"
                  style={{ width: `${Math.min(100, metrics.percentComplete)}%` }}
                />
              </div>
            </div>
          </div>
        ) : (
          <p className="flex-1 text-xs text-slate-500">
            No run yet — press <span className="font-medium">RUN DEMO</span> below.
          </p>
        )}

        <PartitionStrip
          partitions={job?.partitions ?? []}
          currentPartition={metrics?.currentPartition ?? null}
        />

        {/* --- the two audited numbers --- */}
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-1.5">
            {staleOverwrites === 0 ? (
              <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
            ) : (
              <ShieldAlert
                className={`h-4 w-4 shrink-0 ${staleOverwrites === null ? 'text-slate-500' : 'text-rose-600'}`}
                aria-hidden="true"
              />
            )}
            <Metric
              label="Stale overwrites"
              value={staleOverwrites === null ? '—' : String(staleOverwrites)}
              hint={
                staleOverwrites === null
                  ? reportLoaded
                    ? 'awaiting audit'
                    : 'checking…'
                  : 'audited'
              }
              tone={staleOverwrites === null ? 'muted' : staleOverwrites === 0 ? 'good' : 'critical'}
            />
          </div>

          <Metric
            label="Coverage"
            value={coverage === null ? '—' : String(coverage)}
            suffix={coverage === null ? undefined : '%'}
            hint={auditedCoverage !== null ? 'audited' : metrics ? 'live' : 'no run'}
            tone={coverage === 100 && auditedCoverage !== null ? 'good' : 'neutral'}
          />
        </div>

        <button
          type="button"
          onClick={onOpenControls}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          Controls
          {pendingAction ? (
            <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-brand-600" aria-label="action in progress" />
          ) : null}
        </button>
      </div>
    </div>
  );
}
