import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VERIFICATION_CHECK, VERIFICATION_VERDICT } from '@bg/shared';
import { makeReport, makeVerificationMetrics } from '../../test/fixtures';
import { VerificationReportView } from './VerificationReportView';
import { ComparisonView } from '../compare/ComparisonView';
import { StaleOverwriteCallout } from '../compare/StaleOverwriteCallout';
import type { ComparisonState } from '../../hooks/useComparison';

/**
 * The report and comparison surfaces (R12, R20).
 *
 * The single most important assertion in this file is the first one: an unrun audit must render *nothing*
 * numeric. A report full of zeroes is visually indistinguishable from a passed audit, and this page is where
 * that mistake would do the most damage.
 */

describe('VerificationReportView', () => {
  const noReportProps = {
    report: null,
    loading: false,
    loaded: true,
    error: null,
    onVerify: vi.fn(),
    verifyDisabledReason: null,
    verifyBusy: false,
  };

  it('shows no numbers at all before the audit has run', () => {
    render(<VerificationReportView {...noReportProps} />);

    expect(screen.getByText('Verification has not been run for this job.')).toBeInTheDocument();
    expect(screen.getByText(/would look exactly like a passed audit/)).toBeInTheDocument();

    // No verdict, and no metric table to be mistaken for one.
    expect(screen.queryByText('VERIFIED SAFE')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale overwrites')).not.toBeInTheDocument();
  });

  it('explains why the audit cannot be run yet', () => {
    render(
      <VerificationReportView
        {...noReportProps}
        verifyDisabledReason="Cannot run verification while the job is RUNNING. Allowed from: COMPLETED, VERIFIED_SAFE, VERIFICATION_FAILED."
      />,
    );

    expect(screen.getByRole('button', { name: /Run audit/ })).toBeDisabled();
    expect(screen.getByText(/Allowed from: COMPLETED/)).toBeInTheDocument();
  });

  it('leads with the verdict and the guarantee statement', () => {
    render(<VerificationReportView {...noReportProps} report={makeReport()} />);

    expect(screen.getByText('VERIFIED SAFE')).toBeInTheDocument();
    expect(
      screen.getByText(/no newer clinical update was overwritten by older backfill data/),
    ).toBeInTheDocument();
  });

  it('states a failed verdict as prominently as a passing one', () => {
    render(
      <VerificationReportView
        {...noReportProps}
        report={makeReport({
          verdict: VERIFICATION_VERDICT.VERIFICATION_FAILED,
          metrics: makeVerificationMetrics({ staleOverwrites: 3 }),
        })}
      />,
    );

    expect(screen.getByText('VERIFICATION FAILED')).toBeInTheDocument();
  });

  it('shows each check with the method it used, so its independence can be inspected', () => {
    render(<VerificationReportView {...noReportProps} report={makeReport()} />);

    expect(screen.getByText('Every eligible record was considered')).toBeInTheDocument();
    expect(
      screen.getByText(/Re-read every write-ledger row and compare guard version to row version/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '2 of 2 passed. Each is computed from persisted evidence, not from an engine counter.',
      ),
    ).toBeInTheDocument();
  });

  it('names the offending records on a failed check', () => {
    // A red number a reviewer cannot act on is barely better than no number.
    render(
      <VerificationReportView
        {...noReportProps}
        report={makeReport({
          verdict: VERIFICATION_VERDICT.VERIFICATION_FAILED,
          checks: [
            {
              id: VERIFICATION_CHECK.C2_NO_STALE_OVERWRITE,
              title: 'No stale write was ever applied',
              passed: false,
              detail: '2 applied writes had a guard version below the row version',
              method: 'Re-read every write-ledger row.',
              offendingPatientCodes: ['P0042', 'P0311'],
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('Offending records (2):')).toBeInTheDocument();
    expect(screen.getByText('P0042, P0311')).toBeInTheDocument();
  });

  it('truncates a long offender list rather than flooding the page', () => {
    const codes = Array.from({ length: 40 }, (_, index) => `P${String(index).padStart(4, '0')}`);

    render(
      <VerificationReportView
        {...noReportProps}
        report={makeReport({
          checks: [
            {
              id: VERIFICATION_CHECK.C1_COVERAGE,
              title: 'Coverage',
              passed: false,
              detail: '40 missed',
              method: 'Set difference.',
              offendingPatientCodes: codes,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/… and 15 more/)).toBeInTheDocument();
  });

  it('labels the metrics that must be zero, and flags any that are not', () => {
    render(
      <VerificationReportView
        {...noReportProps}
        report={makeReport({ metrics: makeVerificationMetrics({ staleOverwrites: 2 }) })}
      />,
    );

    expect(screen.getAllByText('must be 0').length).toBeGreaterThanOrEqual(4);

    const row = screen.getByText('Stale overwrites').closest('tr')!;
    expect(row).toHaveTextContent('2');
  });

  it('explains that post-consideration drift is not a violation', () => {
    /**
     * A non-zero number in a report of safety checks invites the reading "something went wrong". Drift is
     * expected and safe, so the report says so next to the number rather than in a footnote.
     */
    render(<VerificationReportView {...noReportProps} report={makeReport()} />);
    expect(screen.getByText(/Not a violation/)).toBeInTheDocument();
  });

  it('offers export and print only once there is something to export', async () => {
    const { unmount } = render(<VerificationReportView {...noReportProps} />);
    expect(screen.queryByRole('link', { name: /Export JSON/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Print/ })).not.toBeInTheDocument();
    unmount();

    render(<VerificationReportView {...noReportProps} report={makeReport()} />);
    expect(screen.getByRole('link', { name: /Export JSON/ })).toHaveAttribute(
      'href',
      '/api/verify/latest/export.json',
    );

    // Printing goes through the browser's own dialogue rather than a bundled PDF renderer.
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await userEvent.click(screen.getByRole('button', { name: /Print/ }));
    expect(print).toHaveBeenCalled();
    print.mockRestore();
  });

  it('runs the audit on request', async () => {
    const onVerify = vi.fn();
    render(<VerificationReportView {...noReportProps} onVerify={onVerify} />);

    await userEvent.click(screen.getByRole('button', { name: /Run audit/ }));
    expect(onVerify).toHaveBeenCalled();
  });
});

describe('ComparisonView', () => {
  function makeState(overrides: Partial<ComparisonState> = {}): ComparisonState {
    return {
      result: null,
      running: false,
      loaded: true,
      error: null,
      run: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  const RESULT = {
    seed: 20260905,
    scenarioName: 'stale-write-after-outage',
    ranAt: '2026-09-05T10:00:00.000Z',
    naive: {
      mode: 'NAIVE' as const,
      label: 'Naive backfill',
      verdict: VERIFICATION_VERDICT.VERIFICATION_FAILED,
      metrics: makeVerificationMetrics({
        staleOverwrites: 3,
        lostOnlineUpdates: 3,
        conflicts: 0,
        reevaluated: 0,
        staleWriteAttemptsBlocked: 0,
        inconsistentRecords: 0,
      }),
    },
    guarded: {
      mode: 'GUARDED' as const,
      label: 'BackfillGuard',
      verdict: VERIFICATION_VERDICT.VERIFIED_SAFE,
      metrics: makeVerificationMetrics({ conflicts: 3, reevaluated: 3, staleWriteAttemptsBlocked: 3 }),
    },
    spotlight: {
      patientCode: 'P0042',
      field: 'glucose',
      originalValue: 118,
      onlineUpdatedValue: 272,
      naive: { finalValue: 118, finalScore: 48, lostTheOnlineUpdate: true, staleOverwrite: true },
      guarded: {
        finalValue: 272,
        finalScore: 63,
        lostTheOnlineUpdate: false,
        staleOverwrite: false,
        conflictDetected: true,
        reevaluated: true,
      },
    },
  };

  it('shows nothing until both engines have actually run', () => {
    render(<ComparisonView state={makeState()} scenario="contended" onScenarioChange={vi.fn()} />);

    expect(screen.getByText('No comparison has been run yet.')).toBeInTheDocument();
    expect(screen.getByText(/a claim about a measurement nobody took/)).toBeInTheDocument();
  });

  it('explains the control scenario before it is run', () => {
    render(<ComparisonView state={makeState()} scenario="control" onScenarioChange={vi.fn()} />);
    expect(screen.getByText(/not broken in general, only when something changes underneath it/)).toBeInTheDocument();
  });

  it('renders both columns with the headline safety rows first', () => {
    render(
      <ComparisonView state={makeState({ result: RESULT })} scenario="contended" onScenarioChange={vi.fn()} />,
    );

    const row = screen.getByText('Stale overwrites').closest('tr')!;
    expect(row).toHaveTextContent('3');
    expect(row).toHaveTextContent('0');
  });

  it('explains why the naive engine scores zero on internal consistency', () => {
    /**
     * The most counter-intuitive number in the whole project. Without this explanation a reader concludes the
     * comparison is broken; with it, they understand why safety cannot be inferred from the final row.
     */
    render(
      <ComparisonView state={makeState({ result: RESULT })} scenario="contended" onScenarioChange={vi.fn()} />,
    );

    expect(
      screen.getByText(/rescores from the value it reverted to, so the row agrees with itself while being wrong/),
    ).toBeInTheDocument();
  });

  it('runs the selected scenario', async () => {
    const state = makeState();
    render(<ComparisonView state={state} scenario="control" onScenarioChange={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run comparison' }));
    expect(state.run).toHaveBeenCalledWith('control');
  });
});

describe('StaleOverwriteCallout', () => {
  const LOST = {
    patientCode: 'P0042',
    field: 'glucose',
    originalValue: 118,
    onlineUpdatedValue: 272,
    naive: { finalValue: 118, finalScore: 48, lostTheOnlineUpdate: true, staleOverwrite: true },
    guarded: {
      finalValue: 272,
      finalScore: 63,
      lostTheOnlineUpdate: false,
      staleOverwrite: false,
      conflictDetected: true,
      reevaluated: true,
    },
  };

  it('states both outcomes in the required words', () => {
    render(<StaleOverwriteCallout spotlight={LOST} />);

    expect(screen.getByText('STALE OVERWRITE DETECTED ❌')).toBeInTheDocument();
    expect(screen.getByText('STALE OVERWRITE PREVENTED ✅')).toBeInTheDocument();
    expect(screen.getByText('LOST')).toBeInTheDocument();
    expect(screen.getByText('PRESERVED')).toBeInTheDocument();
  });

  it('explains why the naive failure is hard to notice', () => {
    render(<StaleOverwriteCallout spotlight={LOST} />);
    expect(screen.getByText(/The row looks internally consistent/)).toBeInTheDocument();
  });

  it('does not claim a naive failure in the uncontended control', () => {
    /**
     * A panel that showed red regardless of the scenario would be the strongest possible evidence that the
     * comparison was rigged. With no contention the naive engine loses nothing, and this says so.
     */
    render(
      <StaleOverwriteCallout
        spotlight={{
          ...LOST,
          onlineUpdatedValue: 118,
          naive: { finalValue: 118, finalScore: 48, lostTheOnlineUpdate: false, staleOverwrite: false },
          guarded: { ...LOST.guarded, finalValue: 118, finalScore: 48, conflictDetected: false, reevaluated: false },
        }}
      />,
    );

    expect(screen.queryByText('STALE OVERWRITE DETECTED ❌')).not.toBeInTheDocument();
    expect(screen.getByText(/no stale overwrite \(nothing changed underneath it\)/)).toBeInTheDocument();
  });
});
