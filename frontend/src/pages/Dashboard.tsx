import { useState } from 'react';
import { DEFAULT_SIMULATION_SETTINGS, JOB_ACTION, whyNotAllowed, type SimulationSettings } from '@bg/shared';
import { DISCLAIMER } from '@bg/shared';
import { useLiveStream } from '../hooks/useLiveStream';
import { useVerificationReport } from '../hooks/useVerificationReport';
import { useConflicts } from '../hooks/useConflicts';
import { useCheckpoint } from '../hooks/useCheckpoint';
import { useScenario } from '../hooks/useScenario';
import { useSimulationControls } from '../hooks/useSimulationControls';
import { KpiGrid } from '../components/kpi/KpiGrid';
import { DemoRunner } from '../components/controls/DemoRunner';
import { ControlPanel } from '../components/controls/ControlPanel';
import { SettingsForm } from '../components/controls/SettingsForm';
import { ProgressPanel } from '../components/backfill/ProgressPanel';
import { PartitionGrid } from '../components/backfill/PartitionGrid';
import { RecoveryTimeline } from '../components/backfill/RecoveryTimeline';
import { EventTimeline } from '../components/events/EventTimeline';
import { ConflictList } from '../components/conflicts/ConflictList';
import { ConnectionNotice } from '../components/layout/ConnectionNotice';
import { navigate, ROUTES } from '../routes';

/**
 * The main dashboard (R14).
 *
 * ## Layout order
 *
 * The demo runner is first, above the fold, because a judge with three minutes should not have to work out
 * which of a dozen controls to press in what order (R18.6). Then the KPIs, then the controls, then the
 * detail — headline claim, then the levers, then the evidence.
 *
 * Everything is bound to live server state. Nothing here holds an optimistic local copy: after a control
 * fires, the resulting state arrives on the same stream every other viewer sees, so the projected screen and
 * the presenter's laptop cannot disagree.
 */
export function Dashboard() {
  const { status, job, events, resync } = useLiveStream();
  const { report, loaded: reportLoaded } = useVerificationReport(events);
  const conflicts = useConflicts(events);
  const checkpoint = useCheckpoint(events);
  const { scenario, error: scenarioError } = useScenario(events);
  const controls = useSimulationControls();

  /**
   * Run settings live here rather than inside the form.
   *
   * Both the form's own start button and the control panel's need the same draft, and lifting it is the only
   * way the two cannot disagree about what "start" would apply.
   */
  const [runSettings, setRunSettings] = useState<Partial<SimulationSettings>>({});

  const settings = job?.settings ?? DEFAULT_SIMULATION_SETTINGS;
  const startDisabledReason = whyNotAllowed(JOB_ACTION.START, job?.status ?? null);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 px-4 py-6 sm:px-6">
      <ConnectionNotice status={status} onRetry={resync} />

      <DemoRunner
        scenario={scenario}
        controls={controls}
        patientCount={job?.metrics?.eligibleRecords ?? null}
        scenarioError={scenarioError}
      />

      <KpiGrid job={job} report={report} reportLoaded={reportLoaded} />

      <div className="grid gap-4 xl:grid-cols-2">
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
      </div>

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
            // Deep-links to the patient browser. The drawer opens there rather than here, so a record's full
            // history is presented in exactly one place.
            onSelectPatient={(code) => navigate(ROUTES.patients, { code })}
          />
        </div>
      </div>

      <p className="pb-2 text-center text-xs text-slate-400">{DISCLAIMER.LONG}</p>
    </div>
  );
}
