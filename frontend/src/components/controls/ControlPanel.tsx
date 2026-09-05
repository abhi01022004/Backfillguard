import {
  AlertCircle,
  FlaskConical,
  LifeBuoy,
  Pause,
  Play,
  RotateCcw,
  SaveOff,
  ShieldCheck,
  Stethoscope,
  Syringe,
  X,
  ZapOff,
} from 'lucide-react';
import {
  ACTOR_TYPE,
  JOB_ACTION,
  JOB_STATUS,
  whyNotAllowed,
  type BackfillJobState,
  type SimulationSettings,
} from '@bg/shared';
import type { ControlsState } from '../../hooks/useSimulationControls';
import { ControlButton } from './ControlButton';

/**
 * The simulation controls (R17.1).
 *
 * ## Where enablement comes from
 *
 * Every lifecycle control asks `whyNotAllowed` — the same transition table the server enforces, imported
 * from `@bg/shared`. Nothing here reimplements the rules. That matters because the alternative fails in the
 * worst direction: a client-side copy would drift, the UI would offer a button the server refuses, and the
 * mismatch would surface as a 409 mid-demo.
 *
 * ## The controls that are not lifecycle transitions
 *
 * Three do not map to a job action and need their own reasoning:
 *
 *  - **Lose checkpoint** needs a checkpoint to exist. Offering it with none present would let a destructive
 *    action report success having done nothing, so it is disabled until one has been created (R7.6).
 *  - **Clinical updates** are meaningful whenever a dataset exists, running or not — that is the point, the
 *    system is never taken offline. They are most interesting mid-run, and the panel says so.
 *  - **Reset** is deliberately always available. It is the escape hatch out of a wedged job.
 */

export interface ControlPanelProps {
  job: BackfillJobState | null;
  /** Whether a checkpoint currently exists for the job. */
  hasCheckpoint: boolean;
  /**
   * Set when checkpoint state could not be read.
   *
   * Kept distinct from `hasCheckpoint: false`, which is a *measurement*. Collapsing the two would make the
   * control claim "no checkpoint exists yet" when the truth is "nobody knows" — a confident statement about
   * something that was never established.
   */
  checkpointError?: string | null;
  controls: ControlsState;
  /** Run settings to start with, from the settings form. */
  settings?: Partial<SimulationSettings>;
}

export function ControlPanel({
  job,
  hasCheckpoint,
  checkpointError = null,
  controls,
  settings = {},
}: ControlPanelProps) {
  const status = job?.status ?? null;
  const busy = (action: string) => controls.pending === action;

  // Any in-flight request blocks the rest: two lifecycle transitions racing would be ambiguous.
  const otherBusy = (action: string) => controls.pending !== null && controls.pending !== action;
  const reason = (action: string, ruleReason: string | null): string | null =>
    ruleReason ?? (otherBusy(action) ? 'another control is still running' : null);

  const checkpointReason = checkpointError
    ? `Checkpoint state could not be read, so this control is unavailable: ${checkpointError}`
    : status === null || status === JOB_STATUS.IDLE
      ? 'No job is running, so there is no checkpoint to destroy.'
      : !hasCheckpoint
        ? 'No checkpoint exists yet. Let the backfill process enough records for one to be created.'
        : null;

  return (
    <section
      aria-labelledby="controls-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 id="controls-heading" className="text-base font-semibold text-slate-900">
        Simulation controls
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Unavailable controls say why. The rules come from the same state machine the server enforces, so a
        control is never offered when the server would refuse it.
      </p>

      {/* --- run lifecycle --- */}
      <div className="mt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Run
        </h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <ControlButton
            label="Start backfill"
            icon={Play}
            tone="primary"
            hint="re-score every record"
            busy={busy('start')}
            disabledReason={reason('start', whyNotAllowed(JOB_ACTION.START, status))}
            onClick={() => void controls.start(settings)}
          />
          <ControlButton
            label="Pause"
            icon={Pause}
            hint="stop at a record boundary"
            busy={busy('pause')}
            disabledReason={reason('pause', whyNotAllowed(JOB_ACTION.PAUSE, status))}
            onClick={() => void controls.pause()}
          />
          <ControlButton
            label="Resume"
            icon={Play}
            hint="continue from where it stopped"
            busy={busy('resume')}
            disabledReason={reason('resume', whyNotAllowed(JOB_ACTION.RESUME, status))}
            onClick={() => void controls.resume()}
          />
          <ControlButton
            label="Run verification"
            icon={ShieldCheck}
            tone="primary"
            hint="independent audit of the finished run"
            busy={busy('verify')}
            disabledReason={reason('verify', whyNotAllowed(JOB_ACTION.VERIFY, status))}
            onClick={() => void controls.verify()}
          />
        </div>
      </div>

      {/* --- failure injection --- */}
      <div className="mt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Failure injection
        </h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <ControlButton
            label="Crash mid-batch"
            icon={ZapOff}
            tone="danger"
            hint="freeze computed, unwritten results"
            busy={busy('crash')}
            disabledReason={reason('crash', whyNotAllowed(JOB_ACTION.CRASH, status))}
            onClick={() => void controls.crash()}
          />
          <ControlButton
            label="Destroy checkpoint"
            icon={SaveOff}
            tone="danger"
            hint="recovery must use data evidence"
            busy={busy('loseCheckpoint')}
            disabledReason={reason('loseCheckpoint', checkpointReason)}
            onClick={() => void controls.loseCheckpoint()}
          />
          <ControlButton
            label="Recover"
            icon={LifeBuoy}
            tone="warning"
            hint="resume from the data, not a cursor"
            busy={busy('recover')}
            disabledReason={reason('recover', whyNotAllowed(JOB_ACTION.RECOVER, status))}
            onClick={() => void controls.recover()}
          />
        </div>
      </div>

      {/* --- live clinical traffic --- */}
      <div className="mt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Clinical updates
        </h3>
        <p className="mt-1 text-[11px] text-slate-500">
          These target a record the backfill has read but not yet written, where an update can actually make
          a computed result stale. Available at any time — the system is never taken offline.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <ControlButton
            label="Doctor updates a record"
            icon={Stethoscope}
            tone="warning"
            hint="diagnosis or blood pressure"
            busy={busy(`onlineUpdate:${ACTOR_TYPE.DOCTOR}`)}
            disabledReason={reason(`onlineUpdate:${ACTOR_TYPE.DOCTOR}`, null)}
            onClick={() => void controls.onlineUpdate(ACTOR_TYPE.DOCTOR)}
          />
          <ControlButton
            label="Nurse records observations"
            icon={Syringe}
            tone="warning"
            hint="heart rate or blood pressure"
            busy={busy(`onlineUpdate:${ACTOR_TYPE.NURSE}`)}
            disabledReason={reason(`onlineUpdate:${ACTOR_TYPE.NURSE}`, null)}
            onClick={() => void controls.onlineUpdate(ACTOR_TYPE.NURSE)}
          />
          <ControlButton
            label="Lab files a result"
            icon={FlaskConical}
            tone="warning"
            hint="glucose"
            busy={busy(`onlineUpdate:${ACTOR_TYPE.LAB}`)}
            disabledReason={reason(`onlineUpdate:${ACTOR_TYPE.LAB}`, null)}
            onClick={() => void controls.onlineUpdate(ACTOR_TYPE.LAB)}
          />
        </div>
      </div>

      {/* --- reset --- */}
      <div className="mt-4 border-t border-slate-100 pt-3">
        <ControlButton
          label="Reset simulation"
          icon={RotateCcw}
          hint="clears jobs, ledgers and audits; keeps the patients"
          busy={busy('reset')}
          // Always available by design: the escape hatch out of a wedged job must never be disabled.
          disabledReason={reason('reset', null)}
          onClick={() => void controls.reset()}
        />
      </div>

      {controls.error ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2.5 text-xs text-rose-900 ring-1 ring-rose-200"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="flex-1">
            <span className="font-semibold">{controls.error.action} failed.</span>{' '}
            {controls.error.message}
          </p>
          <button
            type="button"
            onClick={controls.clearError}
            className="rounded p-0.5 hover:bg-rose-100"
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
