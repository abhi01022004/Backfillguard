import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Users } from 'lucide-react';
import { JOB_STATUS, PARTITION_STATE, VERIFICATION_VERDICT } from '@bg/shared';
import { makeJob, makeMetrics, makePartition, makeReport, makeVerificationMetrics } from '../../test/fixtures';
import { KpiCard } from './KpiCard';
import { KpiGrid } from './KpiGrid';
import { JobStateBadge } from '../layout/JobStateBadge';
import { StatusBar } from '../layout/StatusBar';

/**
 * The "no fake numbers" discipline, tested at the point it can actually be violated (R14.6).
 *
 * Every other guarantee in this project is enforced in the backend and covered by backend tests. This one is a
 * rendering property: a component that defaulted a missing value to `0` would show a confident, plausible
 * number for something nobody measured. "0 stale overwrites" displayed before a backfill has run is not a
 * reassuring result — it is a claim we cannot support, which happens to match the eventual answer.
 *
 * The two audited numbers moved from the KPI grid to the pinned status strip during the dashboard rework, so
 * the assertions about withholding them moved with them. They are the reason this file exists, so losing them
 * in a layout change would have been the worst possible outcome of tidying up.
 */

describe('KpiCard', () => {
  it('renders an em dash, never a zero, when nothing has been measured', () => {
    render(<KpiCard label="Stale overwrites" value={null} icon={Users} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('explains why there is no number', () => {
    render(<KpiCard label="Stale overwrites" value={null} icon={Users} emptyHint="awaiting verification" />);
    expect(screen.getByText('awaiting verification')).toBeInTheDocument();
  });

  it('renders a measured zero as a real zero', () => {
    // The counterpart to the rule above: once measured, zero is a finding and must be shown as one.
    render(<KpiCard label="Stale overwrites" value={0} icon={Users} />);

    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('formats large counts with thousands separators', () => {
    // "1000" reads as a version number at a glance; 1,000 reads as a quantity.
    render(<KpiCard label="Total patients" value={1000} icon={Users} />);
    expect(screen.getByText('1,000')).toBeInTheDocument();
  });

  it('renders a suffix alongside the value', () => {
    render(<KpiCard label="Coverage" value={100} icon={Users} suffix="%" />);
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('%')).toBeInTheDocument();
  });
});

describe('KpiGrid', () => {
  it('shows no numbers at all before a job has run', () => {
    render(<KpiGrid job={null} />);

    // Four cards, four em dashes. Nothing invented.
    expect(screen.getAllByText('—')).toHaveLength(4);
    expect(screen.getAllByText('no job started').length).toBe(4);
  });

  it('renders real counts from job state', () => {
    render(<KpiGrid job={makeJob()} />);

    expect(screen.getByText('1,000')).toBeInTheDocument();
    // Conflicts, re-evaluated and stale-writes-blocked all read 9 in this fixture.
    expect(screen.getAllByText('9')).toHaveLength(3);
  });

  it('collapses protected updates and blocked writes into one card', () => {
    /**
     * They are the same event counted from two directions — the shared type defines a protected update as
     * "one per blocked stale write" — so they are equal by construction. Two cards showing the same number
     * implied two independent measurements.
     */
    render(<KpiGrid job={makeJob()} />);

    expect(screen.getByText('Stale writes blocked')).toBeInTheDocument();
    expect(screen.getByText('= clinical updates protected')).toBeInTheDocument();
    expect(screen.queryByText('Protected updates')).not.toBeInTheDocument();
  });

  it('says the guard is untested rather than implying success at zero conflicts', () => {
    render(<KpiGrid job={makeJob({ metrics: makeMetrics({ conflicts: 0 }) })} />);
    expect(screen.getByText('none yet — the guard is untested')).toBeInTheDocument();
  });

  it('does not show the audited numbers, which belong to the pinned strip', () => {
    // Duplicating them would mean two surfaces that could disagree about the project's central claim.
    render(<KpiGrid job={makeJob()} />);

    expect(screen.queryByText('Stale overwrites')).not.toBeInTheDocument();
    expect(screen.queryByText('Coverage')).not.toBeInTheDocument();
  });
});

describe('StatusBar', () => {
  const base = { onOpenControls: vi.fn(), reportLoaded: true };

  it('withholds the stale-overwrite number until the audit has run', () => {
    /**
     * The most important assertion on the dashboard, and now the most prominent place it could be violated —
     * this strip is pinned to the top of every screen. With a completed job but no report it must say so
     * instead of showing a comfortable zero.
     */
    render(<StatusBar {...base} job={makeJob({ status: JOB_STATUS.COMPLETED })} report={null} />);

    expect(screen.getByText('awaiting audit')).toBeInTheDocument();
    // Two dashes: stale overwrites is unmeasured, coverage falls back to live progress.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the audited zero once verification has run', () => {
    render(<StatusBar {...base} job={makeJob({ status: JOB_STATUS.VERIFIED_SAFE })} report={makeReport()} />);

    expect(screen.queryByText('awaiting audit')).not.toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getAllByText('audited').length).toBe(2);
  });

  it('reports a non-zero stale-overwrite count rather than hiding it', () => {
    render(
      <StatusBar
        {...base}
        job={makeJob({ status: JOB_STATUS.VERIFICATION_FAILED })}
        report={makeReport({
          verdict: VERIFICATION_VERDICT.VERIFICATION_FAILED,
          metrics: makeVerificationMetrics({ staleOverwrites: 3 }),
        })}
      />,
    );

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('labels coverage by its source', () => {
    // Live progress and audited coverage answer different questions, so the strip says which is on screen.
    const { unmount } = render(<StatusBar {...base} job={makeJob()} report={null} />);
    expect(screen.getByText('live')).toBeInTheDocument();
    unmount();

    render(<StatusBar {...base} job={makeJob()} report={makeReport()} />);
    expect(screen.getAllByText('audited').length).toBe(2);
  });

  it('prompts for the demo instead of showing a progress bar with no run', () => {
    render(<StatusBar {...base} job={null} report={null} />);

    expect(screen.getByText(/No run yet/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('exposes progress to assistive technology with real bounds', () => {
    render(
      <StatusBar
        {...base}
        job={makeJob({ metrics: makeMetrics({ processed: 250, eligibleRecords: 1000, percentComplete: 25 }) })}
        report={null}
      />,
    );

    const bar = screen.getByRole('progressbar', { name: 'Records considered' });
    expect(bar).toHaveAttribute('aria-valuenow', '250');
    expect(bar).toHaveAttribute('aria-valuemax', '1000');
  });

  it('hides the colour-only partition strip from assistive technology', () => {
    /**
     * The strip conveys state by colour alone, which is why the labelled partition grid remains the accessible
     * presentation. Announcing a colour-only duplicate would be worse than not announcing it at all (R24.6).
     */
    const { container } = render(
      <StatusBar
        {...base}
        job={makeJob({
          partitions: [makePartition(0, { state: PARTITION_STATE.PROCESSING, percentComplete: 40 })],
        })}
        report={null}
      />,
    );

    expect(container.querySelector('[aria-hidden="true"] .rounded-sm')).not.toBeNull();
    expect(screen.getByText('1 partitions')).toBeInTheDocument();
  });

  it('opens the controls drawer on request', async () => {
    const onOpenControls = vi.fn();
    render(<StatusBar {...base} onOpenControls={onOpenControls} job={makeJob()} report={null} />);

    await userEvent.click(screen.getByRole('button', { name: /Controls/ }));
    expect(onOpenControls).toHaveBeenCalled();
  });

  it('signals an in-flight action while the controls are scrolled away', () => {
    render(<StatusBar {...base} job={makeJob()} report={null} pendingAction="crash" />);
    expect(screen.getByLabelText('action in progress')).toBeInTheDocument();
  });
});

describe('JobStateBadge', () => {
  it('says no job has started rather than showing a status', () => {
    render(<JobStateBadge status={null} />);
    expect(screen.getByText('No job started')).toBeInTheDocument();
  });

  it('conveys state with a text label, not colour alone', () => {
    // A projector at the back of a room, or a colour-vision deficiency, must not hide the state.
    render(<JobStateBadge status={JOB_STATUS.CRASHED} />);
    expect(screen.getByText('Crashed')).toBeInTheDocument();
  });

  it('distinguishes a failed audit from a failed run', () => {
    const { unmount } = render(<JobStateBadge status={JOB_STATUS.VERIFICATION_FAILED} />);
    expect(screen.getByText('Verification failed')).toBeInTheDocument();
    unmount();

    render(<JobStateBadge status={JOB_STATUS.FAILED} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('shows a failure reason when there is one', () => {
    render(<JobStateBadge status={JOB_STATUS.FAILED} detail="3 records had no terminal decision" />);
    expect(screen.getByText(/3 records had no terminal decision/)).toBeInTheDocument();
  });
});
