import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CONFLICT_RESOLUTION, JOB_STATUS, VERIFICATION_VERDICT, type RecoverySummary } from '@bg/shared';
import { makeConflict, makeJob, makeMetrics, makeReport, makeVerificationMetrics } from '../../test/fixtures';
import { LiveMoment } from './LiveMoment';

/**
 * The state-driven hero (R24.2).
 *
 * ## What is worth testing here
 *
 * Not the styling — the *priority ordering*. This panel has to choose one message from seven possible states,
 * and getting that order wrong produces a specific failure: the dashboard describing a conflict while the job
 * is actually crashed, which is exactly the moment a viewer most needs to be told the truth.
 *
 * The second thing worth pinning is that every state states its meaning in words. This is the one panel that
 * changes colour wholesale, so it would be easy to let the colour carry the message — and then it would carry
 * nothing on a projector.
 */

const RECOVERY: RecoverySummary = {
  recoveryStartPartition: 2,
  recordsRevisited: 780,
  noops: 640,
  recordsReprocessed: 140,
  conflictsFound: 3,
  pendingResultsRevalidated: 5,
  pendingResultsRejected: 2,
};

describe('LiveMoment', () => {
  it('invites the demo when nothing has run', () => {
    render(<LiveMoment job={null} conflicts={[]} recovery={null} report={null} />);

    expect(screen.getByText('Nothing running')).toBeInTheDocument();
    expect(screen.getByText(/Press RUN DEMO/)).toBeInTheDocument();
  });

  it('describes a calm running state as calm, without inventing urgency', () => {
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.RUNNING, metrics: makeMetrics({ conflicts: 0 }) })}
        conflicts={[]}
        recovery={null}
        report={null}
      />,
    );

    expect(screen.getByText('Scoring records')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been contended yet/)).toBeInTheDocument();
  });

  it('promotes the newest conflict to full size while running', () => {
    /**
     * The reason this panel exists. A conflict card is the most persuasive object in the project and it used to
     * sit in a scrolling list beneath four other panels.
     */
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.RUNNING })}
        conflicts={[makeConflict({ id: 1, patientCode: 'P0001' }), makeConflict({ id: 2, patientCode: 'P0042' })]}
        recovery={null}
        report={null}
      />,
    );

    expect(screen.getByText('Conflict detected — stale write refused')).toBeInTheDocument();
    expect(screen.getByText('Most recent conflict')).toBeInTheDocument();
    // The newest, not the first.
    expect(screen.getByText(/A clinical update landed on P0042/)).toBeInTheDocument();
    // And the embedded card renders its evidence.
    expect(screen.getByText('PREVENTED')).toBeInTheDocument();
  });

  it('lets a crash outrank a conflict', () => {
    /**
     * The ordering bug this guards against: with conflicts present and the job crashed, describing the conflict
     * would leave a viewer unaware that the process had died.
     */
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.CRASHED, pendingResultCount: 7 })}
        conflicts={[makeConflict()]}
        recovery={null}
        report={null}
      />,
    );

    expect(screen.getByText('Crashed mid-batch')).toBeInTheDocument();
    expect(screen.queryByText('Conflict detected — stale write refused')).not.toBeInTheDocument();
  });

  it('explains what the frozen results mean, and what happens next', () => {
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.CRASHED, pendingResultCount: 7 })}
        conflicts={[]}
        recovery={null}
        report={null}
      />,
    );

    expect(screen.getByText(/7 result\(s\) computed but never written/)).toBeInTheDocument();
    expect(screen.getByText(/No committed patient data was touched/)).toBeInTheDocument();
    expect(screen.getByText(/exactly what a naive resume would write back/)).toBeInTheDocument();
  });

  it('leads recovery with the records it left alone', () => {
    // That number is the argument: it shows recovery reasoned rather than rewrote.
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.RECOVERING })}
        conflicts={[]}
        recovery={RECOVERY}
        report={null}
      />,
    );

    expect(screen.getByText('Recovering from the data, not a checkpoint')).toBeInTheDocument();
    expect(screen.getByText('Left untouched')).toBeInTheDocument();
    expect(screen.getByText('640')).toBeInTheDocument();
    expect(screen.getByText('P3')).toBeInTheDocument();
  });

  it('lets a verdict outrank everything else', () => {
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.VERIFIED_SAFE })}
        conflicts={[makeConflict()]}
        recovery={RECOVERY}
        report={makeReport()}
      />,
    );

    expect(screen.getByText('Independently verified safe')).toBeInTheDocument();
    expect(screen.getByText(/no newer clinical update was overwritten/)).toBeInTheDocument();
    expect(screen.getByText(/not copied from any counter/)).toBeInTheDocument();
  });

  it('states a failed verdict as plainly as a passing one', () => {
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.VERIFICATION_FAILED })}
        conflicts={[]}
        recovery={null}
        report={makeReport({
          verdict: VERIFICATION_VERDICT.VERIFICATION_FAILED,
          metrics: makeVerificationMetrics({ staleOverwrites: 3 }),
        })}
      />,
    );

    expect(screen.getByText('Verification failed')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('reports a failure reason rather than a bare failed state', () => {
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.FAILED, failureReason: '3 records had no terminal decision' })}
        conflicts={[]}
        recovery={null}
        report={null}
      />,
    );

    expect(screen.getByText('Run failed')).toBeInTheDocument();
    expect(screen.getByText('3 records had no terminal decision')).toBeInTheDocument();
  });

  it('suggests the useful next action while paused', () => {
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.PAUSED, pendingResultCount: 4 })}
        conflicts={[]}
        recovery={null}
        report={null}
      />,
    );

    expect(screen.getByText('Paused at a record boundary')).toBeInTheDocument();
    expect(screen.getByText(/trigger a clinical update by hand/)).toBeInTheDocument();
  });

  it('announces state changes politely, and only the headline', () => {
    // A state change is worth announcing; the per-record telemetry underneath it is not.
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.CRASHED, pendingResultCount: 2 })}
        conflicts={[]}
        recovery={null}
        report={null}
      />,
    );

    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Crashed mid-batch');
  });

  it('conveys every state in words, never colour alone', () => {
    const cases = [
      [JOB_STATUS.IDLE, 'Nothing running'],
      [JOB_STATUS.RUNNING, 'Scoring records'],
      [JOB_STATUS.PAUSED, 'Paused at a record boundary'],
      [JOB_STATUS.CRASHED, 'Crashed mid-batch'],
      [JOB_STATUS.RECOVERING, 'Recovering from the data, not a checkpoint'],
      [JOB_STATUS.VERIFYING, 'Auditing'],
    ] as const;

    for (const [status, headline] of cases) {
      const { unmount } = render(
        <LiveMoment
          job={makeJob({ status, metrics: makeMetrics({ conflicts: 0 }) })}
          conflicts={[]}
          recovery={null}
          report={null}
        />,
      );
      expect(screen.getByText(headline)).toBeInTheDocument();
      unmount();
    }
  });

  it('does not embed a conflict card once the run has settled', () => {
    // A settled run's own verdict is the more useful message; the full list is still below.
    render(
      <LiveMoment
        job={makeJob({ status: JOB_STATUS.VERIFIED_SAFE })}
        conflicts={[makeConflict({ resolution: CONFLICT_RESOLUTION.REEVALUATED })]}
        recovery={null}
        report={makeReport()}
      />,
    );

    expect(screen.queryByText('Most recent conflict')).not.toBeInTheDocument();
  });
});
