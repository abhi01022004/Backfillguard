import { Radio, Terminal, Users } from 'lucide-react';
import { DISCLAIMER } from '@bg/shared';
import { useLiveStream } from '../hooks/useLiveStream';
import { useVerificationReport } from '../hooks/useVerificationReport';
import { KpiGrid } from '../components/kpi/KpiGrid';
import { ProgressPanel } from '../components/backfill/ProgressPanel';
import { RecoveryTimeline } from '../components/backfill/RecoveryTimeline';
import { ConnectionNotice } from '../components/layout/ConnectionNotice';

/**
 * The main dashboard (R14).
 *
 * Everything here is bound to live server state. Sections that later tasks fill — the partition grid, the
 * event timeline, conflict cards, the control panel — are announced as coming rather than mocked up, because
 * a placeholder that looks like a working feature is the same category of dishonesty as a placeholder
 * number.
 */

interface PendingSection {
  label: string;
  detail: string;
  icon: typeof Users;
}

const PENDING_SECTIONS: PendingSection[] = [
  {
    label: 'Partition status',
    detail: 'Per-partition progress and state across all partitions',
    icon: Terminal,
  },
  {
    label: 'Live activity and conflict detail',
    detail: 'Event timeline, clinical update feed, and per-conflict version evidence',
    icon: Radio,
  },
  {
    label: 'Patients and simulation controls',
    detail: 'Patient records with version history, and the run controls',
    icon: Users,
  },
];

export function Dashboard() {
  const { status, job, events, resync } = useLiveStream();
  const { report, loaded: reportLoaded } = useVerificationReport(events);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-6 sm:px-6">
      <ConnectionNotice status={status} onRetry={resync} />

      <KpiGrid job={job} report={report} reportLoaded={reportLoaded} />

      {/* Two columns on wide screens, stacking to one on narrow (R14.7). */}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ProgressPanel job={job} />
        </div>
        <RecoveryTimeline job={job} events={events} />
      </div>

      <section
        aria-labelledby="pending-heading"
        className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-5"
      >
        <h2 id="pending-heading" className="text-sm font-semibold text-slate-700">
          Still to come
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          These sections are not built yet. They are listed rather than mocked up, so nothing on this page
          looks like a working feature that is not.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-3">
          {PENDING_SECTIONS.map((section) => {
            const Icon = section.icon;
            return (
              <li
                key={section.label}
                className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-white p-3"
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
                <div>
                  <p className="text-xs font-medium text-slate-700">{section.label}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{section.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="pb-2 text-center text-xs text-slate-400">{DISCLAIMER.LONG}</p>
    </div>
  );
}
