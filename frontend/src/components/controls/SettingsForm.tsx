import { useState } from 'react';
import { Lock, RotateCcw, Settings2 } from 'lucide-react';
import {
  SIMULATION_BOUNDS,
  isDatasetLocked,
  type JobStatus,
  type SimulationSettingKey,
  type SimulationSettings,
} from '@bg/shared';

/**
 * Bounded simulation settings (R17.2).
 *
 * ## Which settings are which
 *
 * Two groups behave differently and the form says so rather than presenting one undifferentiated list:
 *
 *  - **Run settings** (speed, batch size, checkpoint interval, update frequency, retry limit) are fixed for
 *    a run's lifetime and applied when it starts. Changing batch size mid-run would invalidate the engine's
 *    position and any checkpoint taken from it, so they are locked while a job owns the data.
 *  - **Dataset settings** (record count, partition count) describe the *data*, not the run. Changing them is
 *    a reseed, which destroys all simulation state — so they sit under their own action with that stated.
 *
 * Every bound comes from `SIMULATION_BOUNDS`. The server validates independently and that check is the
 * authoritative one; these attributes exist for early, specific feedback (R22.7).
 */

const RUN_KEYS: readonly SimulationSettingKey[] = [
  'backfillSpeed',
  'batchSize',
  'checkpointInterval',
  'onlineUpdateFrequency',
  'maxReevaluationAttempts',
];

const DATASET_KEYS: readonly SimulationSettingKey[] = ['totalRecords', 'partitionCount'];

function NumberField({
  settingKey,
  value,
  disabled,
  onChange,
}: {
  settingKey: SimulationSettingKey;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const bound = SIMULATION_BOUNDS[settingKey];
  const id = `setting-${settingKey}`;

  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-medium text-slate-600">
        {bound.label}
      </label>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <input
          id={id}
          type="number"
          min={bound.min}
          max={bound.max}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          // The range is stated as help text as well as attributes, so it is visible rather than only
          // discoverable by triggering validation.
          aria-describedby={`${id}-range`}
          className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums disabled:bg-slate-100 disabled:text-slate-500"
        />
        {bound.unit ? <span className="text-[11px] text-slate-500">{bound.unit}</span> : null}
      </div>
      <p id={`${id}-range`} className="mt-0.5 text-[10px] text-slate-500 tabular-nums">
        {bound.min}–{bound.max}
      </p>
    </div>
  );
}

export interface SettingsFormProps {
  /** The settings the current or last run used. */
  current: SimulationSettings;
  status: JobStatus | null;
  busy: boolean;
  /** Starts a run with the run-scoped overrides. */
  onStart: (settings: Partial<SimulationSettings>) => void;
  /** Regenerates the dataset. Destroys all simulation state. */
  onReseed: (options: { totalRecords: number; partitionCount: number }) => void;
  startDisabledReason: string | null;
}

export function SettingsForm({
  current,
  status,
  busy,
  onStart,
  onReseed,
  startDisabledReason,
}: SettingsFormProps) {
  const [draft, setDraft] = useState<SimulationSettings>(current);

  const locked = isDatasetLocked(status ?? 'IDLE');

  const set = (key: SimulationSettingKey) => (value: number) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  return (
    <section
      aria-labelledby="settings-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="settings-heading"
          className="flex items-center gap-2 text-base font-semibold text-slate-900"
        >
          <Settings2 className="h-4 w-4 text-slate-500" aria-hidden="true" />
          Simulation settings
        </h2>

        {locked ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-300">
            <Lock className="h-3 w-3" aria-hidden="true" />
            locked while a job owns the data
          </span>
        ) : null}
      </div>

      <fieldset disabled={locked || busy} className="mt-4">
        <legend className="text-xs font-semibold text-slate-700">Run settings</legend>
        <p className="mt-0.5 text-[11px] text-slate-500">
          Applied when a run starts and fixed for its lifetime. Speed changes how long a run takes in
          wall-clock terms, never the order in which anything happens.
        </p>

        <div className="mt-2.5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {RUN_KEYS.map((key) => (
            <NumberField
              key={key}
              settingKey={key}
              value={draft[key]}
              disabled={locked || busy}
              onChange={set(key)}
            />
          ))}
        </div>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onStart({
              backfillSpeed: draft.backfillSpeed,
              batchSize: draft.batchSize,
              checkpointInterval: draft.checkpointInterval,
              onlineUpdateFrequency: draft.onlineUpdateFrequency,
              maxReevaluationAttempts: draft.maxReevaluationAttempts,
            })
          }
          disabled={startDisabledReason !== null || busy}
          title={startDisabledReason ?? 'Start a backfill with these settings'}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white ring-1 ring-brand-600 hover:enabled:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 disabled:ring-slate-200"
        >
          Start with these settings
        </button>

        <button
          type="button"
          onClick={() => setDraft(current)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:enabled:bg-slate-100"
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Revert to current
        </button>
      </div>

      <fieldset disabled={locked || busy} className="mt-5 border-t border-slate-100 pt-4">
        <legend className="text-xs font-semibold text-slate-700">Dataset</legend>
        <p className="mt-0.5 text-[11px] text-slate-500">
          Changing these regenerates the synthetic cohort and clears every job, ledger and audit result —
          the patients themselves are replaced, not just rescored.
        </p>

        <div className="mt-2.5 flex flex-wrap items-end gap-3">
          {DATASET_KEYS.map((key) => (
            <NumberField
              key={key}
              settingKey={key}
              value={draft[key]}
              disabled={locked || busy}
              onChange={set(key)}
            />
          ))}

          <button
            type="button"
            onClick={() =>
              onReseed({ totalRecords: draft.totalRecords, partitionCount: draft.partitionCount })
            }
            disabled={locked || busy}
            className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:enabled:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-500"
          >
            Regenerate dataset
          </button>
        </div>
      </fieldset>
    </section>
  );
}
