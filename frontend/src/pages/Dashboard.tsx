import { useState } from 'react';
import {
  DEFAULT_SIMULATION_SETTINGS,
  DISCLAIMER,
  JOB_ACTION,
  whyNotAllowed,
  type SimulationSettings,
} from '@bg/shared';
import { useLiveStream } from '../hooks/useLiveStream';
import { useVerificationReport } from '../hooks/useVerificationReport';
import { useConflicts } from '../hooks/useConflicts';
import { useNotifications } from '../hooks/useNotifications';
import { useCheckpoint } from '../hooks/useCheckpoint';
import { useScenario } from '../hooks/useScenario';
import { useRecovery } from '../hooks/useRecovery';
import { useSimulationControls } from '../hooks/useSimulationControls';
import { StatusBar } from '../components/layout/StatusBar';
import { ControlsDrawer } from '../components/layout/ControlsDrawer';
import { ConnectionNotice } from '../components/layout/ConnectionNotice';
import { DemoRunner } from '../components/controls/DemoRunner';
import { ControlPanel } from '../components/controls/ControlPanel';
import { SettingsForm } from '../components/controls/SettingsForm';
import { LiveMoment } from '../components/live/LiveMoment';
import { KpiGrid } from '../components/kpi/KpiGrid';
import { VerdictSummary } from '../components/report/VerdictSummary';
import { ProgressPanel } from '../components/backfill/ProgressPanel';
import { PartitionGrid } from '../components/backfill/PartitionGrid';
import { RecoveryTimeline } from '../components/backfill/RecoveryTimeline';
import { ActivityPanel } from '../components/events/ActivityPanel';
import { NotificationKpis } from '../components/notifications/NotificationKpis';
import { NotificationPanel } from '../components/notifications/NotificationPanel';
import { navigate, ROUTES } from '../routes';

/**
 * The main dashboard (R14, R24.1).
 *
 * ## Layout, and why it is in this order
 *
 * The requirement is that everything is conveyable without navigation. An earlier version satisfied that by
 * stacking nine panels vertically, which was technically compliant and practically poor: the page ran to about
 * five screens, so reaching the conflict evidence scrolled the run state off the top, and the controls occupied
 * prime space nobody touches after the first ten seconds.
 *
 * The current order is: **act, then watch, then count, then prove, then inspect.**
 *
 * 1. **Pinned status strip** — run state, progress, and the two audited safety numbers. Never scrolls away.
 * 2. **Demo runner** — the one-click call to action, above the fold on first load (R24.5).
 * 3. **Live moment** — what is happening right now, in words, changing colour with the run. On a contended
 *    run this is where the newest conflict card renders full-size.
 * 4. **Four KPI cards** — the counts.
 * 5. **Verdict** and **recovery timeline** — the proof and the narrative.
 * 6. **Activity / conflicts** tabbed, beside the run detail and partition grid — the corroborating detail.
 * 7. **Risk alerts** — the outbound side effect, last, because it only means something once the guard above it
 *    has been shown to work.
 *
 * Controls and settings live in a drawer behind the status strip's button. The run keeps going while it is
 * open, and the strip stays visible, so pausing or crashing the job never means losing sight of it.
 *
 * Nothing here holds an optimistic local copy of server state. After a control fires, the result arrives on the
 * same stream every other viewer sees, so the projected screen and the presenter's laptop cannot disagree.
 */
export function Dashboard() {
  const { status, job, events, resync } = useLiveStream();
  const { report, loaded: reportLoaded } = useVerificationReport(events);
  const conflicts = useConflicts(events);
  const notifications = useNotifications(events);
  const checkpoint = useCheckpoint(events);
  const { scenario, error: scenarioError } = useScenario(events);
  const { recovery } = useRecovery(events);
  const controls = useSimulationControls();

  const [controlsOpen, setControlsOpen] = useState(false);

  /**
   * Run settings are held here rather than inside the form.
   *
   * Both the form's own start button and the control panel's need the same draft, and lifting it is the only
   * way the two cannot disagree about what "start" would apply.
   */
  const [runSettings, setRunSettings] = useState<Partial<SimulationSettings>>({});

  const settings = job?.settings ?? DEFAULT_SIMULATION_SETTINGS;
  const startDisabledReason = whyNotAllowed(JOB_ACTION.START, job?.status ?? null);

  return (
    <>
      <StatusBar
        job={job}
        report={report}
        reportLoaded={reportLoaded}
        onOpenControls={() => setControlsOpen(true)}
        pendingAction={controls.pending}
      />

      <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-5 sm:px-6">
        <ConnectionNotice status={status} onRetry={resync} />

        <DemoRunner
          scenario={scenario}
          controls={controls}
          patientCount={job?.metrics?.eligibleRecords ?? null}
          scenarioError={scenarioError}
        />

        <LiveMoment
          job={job}
          conflicts={conflicts.conflicts}
          recovery={recovery}
          report={report}
        />

        <KpiGrid job={job} />

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <VerdictSummary report={report} loaded={reportLoaded} />
          </div>
          <RecoveryTimeline job={job} events={events} />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          {/* Tabbed, so a conflict card gets enough width to read on one line. */}
          <div className="min-w-0 xl:col-span-2">
            <ActivityPanel
              events={events}
              conflicts={conflicts.conflicts}
              conflictTotal={conflicts.total}
              conflictOpen={conflicts.open}
              conflictsLoading={conflicts.loading}
              conflictsError={conflicts.error}
              // Deep-links to the patient browser, where a record's full history is presented in one place.
              onSelectPatient={(code) => navigate(ROUTES.patients, { code })}
            />
          </div>

          <div className="space-y-4">
            <ProgressPanel job={job} compact />
            <PartitionGrid job={job} currentPartition={job?.metrics?.currentPartition ?? null} />
          </div>
        </div>

        {/*
          * Notifications sit after the safety story rather than above it.
          *
          * They are the newest feature and the most eye-catching, which is exactly why they are not at the top:
          * the alerts are a *consequence* of the version guard, and they only mean anything once the viewer has
          * seen the conflicts and the verdict that make them trustworthy. Leading with them would sell the demo
          * and bury the argument.
          */}
        <NotificationKpis stats={notifications.stats} loaded={!notifications.loading} />

        <NotificationPanel
          notifications={notifications}
          onSelectPatient={(code) => navigate(ROUTES.patients, { code })}
        />

        <p className="pb-2 text-center text-xs text-slate-500">{DISCLAIMER.LONG}</p>
      </div>

      <ControlsDrawer open={controlsOpen} onClose={() => setControlsOpen(false)}>
        <ControlPanel
          job={job}
          hasCheckpoint={checkpoint.hasCheckpoint}
          checkpointError={checkpoint.error}
          controls={controls}
          settings={runSettings}
        />
        <SettingsForm
          current={settings}
          status={job?.status ?? null}
          busy={controls.pending !== null}
          startDisabledReason={startDisabledReason}
          onStart={(next) => {
            setRunSettings(next);
            void controls.start(next);
          }}
          onReseed={(options) => void controls.reseed(options)}
        />
      </ControlsDrawer>
    </>
  );
}
