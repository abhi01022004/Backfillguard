import { Activity, Database, Layers, Package, Save } from 'lucide-react';
import type { BackfillJobState } from '@bg/shared';
import { JobStateBadge } from '../layout/JobStateBadge';

/**
 * Backfill progress (R14.3, R24.3).
 *
 * The bar is bound to `processed / eligibleRecords` and nothing else. There is deliberately no
 * indeterminate spinner or synthetic animation standing in for progress: an animation that does not
 * represent real state is worse than no animation, because it invites the viewer to believe something is
 * happening when it may not be.
 */

export interface ProgressPanelProps {
  job: BackfillJobState | null;
  /**
   * Hides the bar and the headline count, for use alongside the pinned status strip.
   *
   * The strip shows `processed / eligible` with a bar. Rendering the same bar again a few hundred pixels below
   * it looks unconsidered and wastes the space this panel should spend on detail the strip has no room for —
   * how the processed records split between applied and already-current, and where the checkpoint is.
   */
  compact?: boolean;
}

function Stat({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Database;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <p className="text-sm font-semibold tabular-nums text-slate-900">{value}</p>
        {detail ? <p className="text-xs text-slate-500">{detail}</p> : null}
      </div>
    </div>
  );
}

export function ProgressPanel({ job, compact = false }: ProgressPanelProps) {
  return (
    <section
      aria-labelledby="progress-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="progress-heading" className="text-base font-semibold text-slate-900">
          {compact ? 'Run detail' : 'Backfill progress'}
        </h2>
        {compact ? null : (
          <JobStateBadge status={job?.status ?? null} detail={job?.failureReason ?? null} />
        )}
      </div>

      {/* Metrics are null before a run and after a reset: no run means nothing measured. */}
      {!job || !job.metrics ? (
        <p className="mt-4 text-sm text-slate-500">
          No backfill has been started. Progress will appear here once a job is running.
        </p>
      ) : (
        <>
          {/* Suppressed in compact mode: the pinned status strip already carries this exact bar and count. */}
          <div className={compact ? 'hidden' : 'mt-4'}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-slate-600">
                <span className="text-lg font-semibold tabular-nums text-slate-900">
                  {job.metrics.processed.toLocaleString('en-GB')}
                </span>
                <span className="text-slate-500"> / </span>
                <span className="tabular-nums">
                  {job.metrics.eligibleRecords.toLocaleString('en-GB')}
                </span>
                <span className="ml-1.5 text-slate-500">records considered</span>
              </p>
              <p className="text-sm font-semibold tabular-nums text-brand-700">
                {job.metrics.percentComplete}%
              </p>
            </div>

            <div
              className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
              role="progressbar"
              aria-valuenow={job.metrics.processed}
              aria-valuemin={0}
              aria-valuemax={job.metrics.eligibleRecords}
              aria-label="Records considered"
            >
              {/* Width comes straight from real counts. Transition only smooths a genuine change. */}
              <div
                className="h-full rounded-full bg-brand-600 transition-[width] duration-200 ease-out"
                style={{ width: `${Math.min(100, job.metrics.percentComplete)}%` }}
              />
            </div>
          </div>

          <div
            className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${compact ? 'mt-3' : 'mt-5 lg:grid-cols-4'}`}
          >
            {/* Only shown in compact mode, where the status strip carries the total but not the split. */}
            {compact ? (
              <Stat
                icon={Activity}
                label="Outcomes"
                value={`${job.metrics.applied.toLocaleString('en-GB')} applied`}
                detail={`${job.metrics.noopAlreadyCurrent.toLocaleString('en-GB')} already current · ${job.metrics.reevaluated.toLocaleString('en-GB')} re-evaluated`}
              />
            ) : null}

            <Stat
              icon={Layers}
              label="Current partition"
              value={`P${job.metrics.currentPartition + 1} of ${job.settings.partitionCount}`}
              detail={`record ${job.metrics.currentRecordIndex}`}
            />
            <Stat
              icon={Package}
              label="Staged, unwritten"
              value={job.pendingResultCount.toLocaleString('en-GB')}
              detail={
                job.pendingResultCount > 0
                  ? 'computed before the crash — must be revalidated'
                  : 'nothing pending'
              }
            />
            <Stat
              icon={Save}
              label="Checkpoint"
              value={
                job.checkpoint
                  ? `P${job.checkpoint.partitionIndex + 1} / r${job.checkpoint.recordPosition}`
                  : 'none yet'
              }
              detail={
                job.checkpoint
                  ? job.checkpoint.status === 'LOST'
                    ? 'LOST — recovery must use version evidence'
                    : `${job.checkpoint.status.toLowerCase()} at ${job.checkpoint.processedCount} records`
                  : 'created every few records'
              }
            />
            <Stat
              icon={Database}
              label="Failed records"
              value={job.metrics.failed.toLocaleString('en-GB')}
              detail={job.metrics.failed === 0 ? 'none' : 'reported, never silently skipped'}
            />
          </div>
        </>
      )}
    </section>
  );
}
