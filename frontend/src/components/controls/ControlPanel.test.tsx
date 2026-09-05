import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_SIMULATION_SETTINGS,
  JOB_STATUS,
  SIMULATION_BOUNDS,
  type ScenarioState,
} from '@bg/shared';
import type { ControlsState } from '../../hooks/useSimulationControls';
import { makeJob } from '../../test/fixtures';
import { ControlPanel } from './ControlPanel';
import { SettingsForm } from './SettingsForm';
import { DemoRunner } from './DemoRunner';

/**
 * Controls, settings and the demo runner (R17, R18).
 *
 * The assertions that matter are about *not offering something the server would refuse*, and about explaining
 * every disabled control. Both are places where a plausible-looking UI misleads the person using it.
 */

function makeControls(overrides: Partial<ControlsState> = {}): ControlsState {
  const noop = async () => true;
  return {
    pending: null,
    error: null,
    clearError: vi.fn(),
    run: vi.fn(noop),
    start: vi.fn(noop),
    pause: vi.fn(noop),
    resume: vi.fn(noop),
    crash: vi.fn(noop),
    recover: vi.fn(noop),
    loseCheckpoint: vi.fn(noop),
    verify: vi.fn(noop),
    reset: vi.fn(noop),
    reseed: vi.fn(noop),
    onlineUpdate: vi.fn(noop),
    runDemo: vi.fn(noop),
    abortDemo: vi.fn(noop),
    ...overrides,
  };
}

describe('ControlPanel enablement', () => {
  it('offers only Start and clinical updates from idle', () => {
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.IDLE, metrics: null })}
        hasCheckpoint={false}
        controls={makeControls()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Start backfill' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Pause —/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Recover —/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Run verification —/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Doctor updates a record' })).toBeEnabled();
  });

  it('swaps Start for Pause and Crash once running', () => {
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.RUNNING })}
        hasCheckpoint
        controls={makeControls()}
      />,
    );

    expect(screen.getByRole('button', { name: /^Start backfill —/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Crash mid-batch' })).toBeEnabled();
  });

  it('allows only Recover and Reset from a crashed job', () => {
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.CRASHED })}
        hasCheckpoint
        controls={makeControls()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Recover' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset simulation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Pause —/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Resume —/ })).toBeDisabled();
  });

  it('permits verification only once a run has settled', () => {
    const { unmount } = render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.COMPLETED })}
        hasCheckpoint={false}
        controls={makeControls()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Run verification' })).toBeEnabled();
    unmount();

    // Auditing a moving target would produce numbers describing no particular moment.
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.RECOVERING })}
        hasCheckpoint={false}
        controls={makeControls()}
      />,
    );
    expect(screen.getByRole('button', { name: /^Run verification —/ })).toBeDisabled();
  });

  it('names the current state and the allowed states in a disabled control', () => {
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.IDLE, metrics: null })}
        hasCheckpoint={false}
        controls={makeControls()}
      />,
    );

    expect(screen.getByRole('button', { name: /^Pause —/ })).toHaveAttribute(
      'title',
      'Cannot pause the backfill while the job is IDLE. Allowed from: RUNNING, RECOVERING.',
    );
  });

  it('refuses to offer checkpoint destruction when there is nothing to destroy', () => {
    /**
     * A destructive action that reports success having done nothing is worse than a disabled one: the demo
     * would appear to have proved recovery works without a checkpoint when no checkpoint ever existed.
     */
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.RUNNING })}
        hasCheckpoint={false}
        controls={makeControls()}
      />,
    );

    const button = screen.getByRole('button', { name: /^Destroy checkpoint —/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'No checkpoint exists yet. Let the backfill process enough records for one to be created.',
    );
  });

  it('keeps Reset available even from a wedged job', () => {
    for (const status of [JOB_STATUS.FAILED, JOB_STATUS.CRASHED, JOB_STATUS.VERIFYING]) {
      const { unmount } = render(
        <ControlPanel job={makeJob({ status })} hasCheckpoint controls={makeControls()} />,
      );
      expect(screen.getByRole('button', { name: 'Reset simulation' })).toBeEnabled();
      unmount();
    }
  });

  it('blocks other controls while one request is in flight', () => {
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.RUNNING })}
        hasCheckpoint
        controls={makeControls({ pending: 'pause' })}
      />,
    );

    // Two lifecycle transitions racing would leave the outcome ambiguous.
    expect(screen.getByRole('button', { name: /^Crash mid-batch —/ })).toBeDisabled();
  });

  it('shows a failed action next to the controls, not as a page error', async () => {
    const clearError = vi.fn();
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.IDLE, metrics: null })}
        hasCheckpoint={false}
        controls={makeControls({
          error: { action: 'pause', message: 'Cannot pause the backfill while the job is IDLE.' },
          clearError,
        })}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('pause failed.');
    expect(alert).toHaveTextContent('Cannot pause the backfill while the job is IDLE.');

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(clearError).toHaveBeenCalled();
  });

  it('invokes the matching control', async () => {
    const controls = makeControls();
    render(
      <ControlPanel
        job={makeJob({ status: JOB_STATUS.RUNNING })}
        hasCheckpoint
        controls={controls}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(controls.pause).toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Lab files a result' }));
    expect(controls.onlineUpdate).toHaveBeenCalledWith('LAB');
  });
});

describe('SettingsForm', () => {
  it('enforces the shared bounds on every field', () => {
    render(
      <SettingsForm
        current={DEFAULT_SIMULATION_SETTINGS}
        status={JOB_STATUS.IDLE}
        busy={false}
        onStart={vi.fn()}
        onReseed={vi.fn()}
        startDisabledReason={null}
      />,
    );

    const speed = screen.getByLabelText(SIMULATION_BOUNDS.backfillSpeed.label);
    expect(speed).toHaveAttribute('min', String(SIMULATION_BOUNDS.backfillSpeed.min));
    expect(speed).toHaveAttribute('max', String(SIMULATION_BOUNDS.backfillSpeed.max));

    const records = screen.getByLabelText(SIMULATION_BOUNDS.totalRecords.label);
    expect(records).toHaveAttribute('min', String(SIMULATION_BOUNDS.totalRecords.min));
    expect(records).toHaveAttribute('max', String(SIMULATION_BOUNDS.totalRecords.max));
  });

  it('locks every field while a job owns the data', () => {
    // Changing batch size mid-run would invalidate the engine's position and any checkpoint from it.
    render(
      <SettingsForm
        current={DEFAULT_SIMULATION_SETTINGS}
        status={JOB_STATUS.RUNNING}
        busy={false}
        onStart={vi.fn()}
        onReseed={vi.fn()}
        startDisabledReason="Cannot start the backfill while the job is RUNNING."
      />,
    );

    expect(screen.getByLabelText(SIMULATION_BOUNDS.batchSize.label)).toBeDisabled();
    expect(screen.getByLabelText(SIMULATION_BOUNDS.totalRecords.label)).toBeDisabled();
    expect(screen.getByText('locked while a job owns the data')).toBeInTheDocument();
  });

  it('unlocks once the job has settled', () => {
    render(
      <SettingsForm
        current={DEFAULT_SIMULATION_SETTINGS}
        status={JOB_STATUS.VERIFIED_SAFE}
        busy={false}
        onStart={vi.fn()}
        onReseed={vi.fn()}
        startDisabledReason={null}
      />,
    );

    expect(screen.getByLabelText(SIMULATION_BOUNDS.batchSize.label)).toBeEnabled();
    expect(screen.queryByText('locked while a job owns the data')).not.toBeInTheDocument();
  });

  it('starts with only the run-scoped settings, never the dataset shape', async () => {
    /**
     * `totalRecords` and `partitionCount` describe the dataset, not the run. Sending them to `/backfill/start`
     * would let a run be configured for a shape the data does not have; the server rejects them outright.
     */
    const onStart = vi.fn();
    render(
      <SettingsForm
        current={DEFAULT_SIMULATION_SETTINGS}
        status={JOB_STATUS.IDLE}
        busy={false}
        onStart={onStart}
        onReseed={vi.fn()}
        startDisabledReason={null}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Start with these settings' }));

    const payload = onStart.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'backfillSpeed',
      'batchSize',
      'checkpointInterval',
      'maxReevaluationAttempts',
      'onlineUpdateFrequency',
    ]);
  });

  it('reseeds with the dataset shape only', async () => {
    const onReseed = vi.fn();
    render(
      <SettingsForm
        current={DEFAULT_SIMULATION_SETTINGS}
        status={JOB_STATUS.IDLE}
        busy={false}
        onStart={vi.fn()}
        onReseed={onReseed}
        startDisabledReason={null}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate dataset' }));
    expect(onReseed).toHaveBeenCalledWith({
      totalRecords: DEFAULT_SIMULATION_SETTINGS.totalRecords,
      partitionCount: DEFAULT_SIMULATION_SETTINGS.partitionCount,
    });
  });

  it('warns that reseeding replaces the patients rather than rescoring them', () => {
    render(
      <SettingsForm
        current={DEFAULT_SIMULATION_SETTINGS}
        status={JOB_STATUS.IDLE}
        busy={false}
        onStart={vi.fn()}
        onReseed={vi.fn()}
        startDisabledReason={null}
      />,
    );

    expect(screen.getByText(/the patients themselves are replaced, not just rescored/)).toBeInTheDocument();
  });
});

describe('DemoRunner', () => {
  const SCENARIO: ScenarioState = {
    running: false,
    name: 'guarded-backfill-under-live-traffic',
    currentStepIndex: null,
    steps: [
      {
        index: 0,
        name: 'Start guarded backfill',
        description: 'Every record queued for re-scoring.',
        status: 'DONE',
        atProcessed: null,
      },
      {
        index: 1,
        name: 'Lab result lands mid-computation',
        description: 'A new glucose reading arrives before the write.',
        status: 'ACTIVE',
        atProcessed: 60,
      },
      {
        index: 2,
        name: 'Crash mid-batch',
        description: 'Results computed but not written are frozen.',
        status: 'PENDING',
        atProcessed: 220,
      },
    ],
    startedAt: '2026-09-05T10:00:00.000Z',
    completedAt: null,
    abortedAt: null,
  };

  it('leads with the one-click action', () => {
    render(<DemoRunner scenario={null} controls={makeControls()} patientCount={1000} />);
    expect(screen.getByRole('button', { name: /RUN WINNING DEMO/ })).toBeEnabled();
  });

  it('lists what the demo guarantees', () => {
    render(<DemoRunner scenario={null} controls={makeControls()} patientCount={1000} />);

    expect(screen.getByText('zero stale overwrites in the independent audit')).toBeInTheDocument();
    expect(screen.getByText('100% coverage — every record accounted for')).toBeInTheDocument();
    expect(screen.getByText(/asserted by the test suite on every build/)).toBeInTheDocument();
  });

  it('refuses to run against an empty dataset and says why', () => {
    render(<DemoRunner scenario={null} controls={makeControls()} patientCount={0} />);

    expect(screen.getByRole('button', { name: /RUN WINNING DEMO/ })).toBeDisabled();
    expect(screen.getByText('The dataset is empty. Seed it before running the demo.')).toBeInTheDocument();
  });

  it('shows each step with its record-count trigger, the basis of determinism', () => {
    render(<DemoRunner scenario={SCENARIO} controls={makeControls()} patientCount={1000} />);

    expect(screen.getByText('at 60 records read')).toBeInTheDocument();
    expect(screen.getByText('at 220 records read')).toBeInTheDocument();
  });

  it('states each step status as text, not colour alone', () => {
    render(<DemoRunner scenario={SCENARIO} controls={makeControls()} patientCount={1000} />);

    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('offers abort only while the demo is running', () => {
    const { unmount } = render(
      <DemoRunner scenario={SCENARIO} controls={makeControls()} patientCount={1000} />,
    );
    expect(screen.queryByRole('button', { name: /Abort/ })).not.toBeInTheDocument();
    unmount();

    render(
      <DemoRunner
        scenario={{ ...SCENARIO, running: true, currentStepIndex: 1 }}
        controls={makeControls()}
        patientCount={1000}
      />,
    );
    expect(screen.getByRole('button', { name: /Abort at next record/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Demo running/ })).toBeDisabled();
  });

  it('announces step progress politely', () => {
    render(
      <DemoRunner
        scenario={{ ...SCENARIO, running: true, currentStepIndex: 1 }}
        controls={makeControls()}
        patientCount={1000}
      />,
    );

    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Step 2 of 3');
  });

  it('starts the demo on click', async () => {
    const controls = makeControls();
    render(<DemoRunner scenario={null} controls={controls} patientCount={1000} />);

    await userEvent.click(screen.getByRole('button', { name: /RUN WINNING DEMO/ }));
    expect(controls.runDemo).toHaveBeenCalled();
  });
});
