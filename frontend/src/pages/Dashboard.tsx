import { Users } from 'lucide-react';
import { DISCLAIMER } from '@bg/shared';
import { useLiveStream } from '../hooks/useLiveStream';
import { useVerificationReport } from '../hooks/useVerificationReport';
import { useConflicts } from '../hooks/useConflicts';
import { KpiGrid } from '../components/kpi/KpiGrid';
import { ProgressPanel } from '../components/backfill/ProgressPanel';
import { PartitionGrid } from '../components/backfill/PartitionGrid';
import { RecoveryTimeline } from '../components/backfill/RecoveryTimeline';
import { EventTimeline } from '../components/events/EventTimeline';
import { ConflictList } from '../components/conflicts/ConflictList';
import { ConnectionNotice } from '../components/layout/ConnectionNotice';

/**
 * The main dashboard (R14).
 *
 * Everything here is bound to live server state. Sections that later tasks fill are announced as coming
 * rather than mocked up, because a placeholder that looks like a working feature is the same category of
 * dishonesty as a placeholder number.
 */
export function Dashboard() {
  const { status, job, events, resync } = useLiveStream();
  const { report, loaded: reportLoaded } = useVerificationReport(events);
  const conflicts = useConflicts(events);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-6 sm:px-6">
      <ConnectionNotice status={status} onRetry={resync} />

      <KpiGrid job={job} report={report} reportLoaded={reportLoaded} />

      {/* Two columns on wide screens, stacking to one on narrow (R14.7). */}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <ProgressPanel job={job} />
          <PartitionGrid job={job} currentPartition={job?.metrics?.currentPartition ?? null} />
        </div>
        <RecoveryTimeline job={job} events={events} />
      </div>

      {/**
       * Activity and conflicts sit side by side and both scroll internally, with a bounded height.
       *
       * Without the cap the page would grow without limit during a run and the controls above would scroll
       * out of reach exactly when they are needed.
       */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="max-h-[32rem] min-h-0">
          <EventTimeline events={events} />
        </div>
        <div className="max-h-[32rem] min-h-0">
          <ConflictList
            conflicts={conflicts.conflicts}
            total={conflicts.total}
            open={conflicts.open}
            loading={conflicts.loading}
            error={conflicts.error}
          />
        </div>
      </div>

      <section
        aria-labelledby="pending-heading"
        className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-5"
      >
        <h2 id="pending-heading" className="text-sm font-semibold text-slate-700">
          Still to come
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Not built yet, so listed rather than mocked up — nothing on this page should look like a working
          feature that is not.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          <li className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-white p-3">
            <Users className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
            <div>
              <p className="text-xs font-medium text-slate-700">Patients and simulation controls</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Patient records with version history, and the run controls
              </p>
            </div>
          </li>
        </ul>
      </section>

      <p className="pb-2 text-center text-xs text-slate-400">{DISCLAIMER.LONG}</p>
    </div>
  );
}
