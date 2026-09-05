import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Users } from 'lucide-react';
import {
  JOB_STATUS,
  VERIFICATION_VERDICT,
  type BackfillJobState,
  type VerificationReport,
} from '@bg/shared';
import { KpiCard } from './KpiCard';
import { KpiGrid } from './KpiGrid';
import { JobStateBadge } from '../layout/JobStateBadge';

/**
 * The "no fake numbers" discipline, tested at the point it can actually be violated (R14.6).
 *
 * Every other guarantee in this project is enforced in the backend and covered by backend tests. This one
 * is a rendering property: a component that defaults a missing value to `0` would show a confident,
 * plausible number for something nobody measured. "0 stale overwrites" displayed before a backfill has run
 * is not a reassuring result — it is a claim we cannot support, which happens to match the eventual answer.
 */

const JOB: BackfillJobState = {
  jobId: 'BG-DEMO-001',
  status: JOB_STATUS.COMPLETED,
  mode: 'GUARDED',
  seed: 20260905,
  settings: {
    totalRecords: 1000,
    partitionCount: 10,
    backfillSpeed: 25,
    onlineUpdateFrequency: 8,
    checkpointInterval: 50,
    batchSize: 25,
    maxReevaluationAttempts: 3,
  },
  metrics: {
    eligibleRecords: 1000,
    processed: 1000,
    applied: 925,
    noopAlreadyCurrent: 66,
    conflicts: 9,
    reevaluated: 9,
    protectedUpdates: 9,
    staleWriteAttemptsBlocked: 9,
    failed: 0,
    currentPartition: 9,
    currentRecordIndex: 100,
    percentComplete: 100,
  },
  partitions: [],
  pendingResultCount: 0,
  checkpoint: null,
  startedAt: '2026-09-05T10:00:00.000Z',
  crashedAt: null,
  recoveredAt: null,
  completedAt: '2026-09-05T10:00:40.000Z',
  failureReason: null,
};

const REPORT: VerificationReport = {
  jobId: 'BG-DEMO-001',
  mode: 'GUARDED',
  datasetDescription: 'Synthetic Hospital Patients (1000 records)',
  seed: 20260905,
  verdict: VERIFICATION_VERDICT.VERIFIED_SAFE,
  metrics: {
    eligibleRecords: 1000,
    consideredRecords: 1000,
    completedRecords: 1000,
    conflicts: 9,
    reevaluated: 9,
    protectedUpdates: 9,
    staleWriteAttemptsBlocked: 9,
    staleOverwrites: 0,
    lostOnlineUpdates: 0,
    missedRecords: 0,
    inconsistentRecords: 0,
    postConsiderationDrift: 0,
    coveragePercent: 100,
  },
  checks: [],
  guaranteeStatement: 'Every eligible record was considered.',
  jobStartedAt: null,
  jobCompletedAt: null,
  verifiedAt: '2026-09-05T10:01:00.000Z',
  durationMs: 40_000,
};

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
    render(<KpiGrid job={null} report={null} reportLoaded />);

    // Seven cards, seven em dashes. Nothing invented.
    expect(screen.getAllByText('—')).toHaveLength(7);
    expect(screen.getAllByText('no job started').length).toBeGreaterThan(0);
  });

  it('withholds the stale-overwrite number until the audit has run', () => {
    /**
     * The most important assertion on the dashboard.
     *
     * Stale overwrites is the project's central claim, so it is sourced from the independent verification
     * report rather than from the engine that did the writing. With a completed job but no report, the card
     * must say so instead of showing a comfortable zero.
     */
    render(<KpiGrid job={JOB} report={null} reportLoaded />);

    expect(screen.getByText('awaiting verification')).toBeInTheDocument();

    // Other cards are populated, so the withholding is specific to the unaudited number rather than the
    // grid simply having no data. Both "Total patients" and "Processed" are 1,000 in this fixture.
    expect(screen.getAllByText('1,000')).toHaveLength(2);
    // And exactly one card is still unmeasured.
    expect(screen.getAllByText('—')).toHaveLength(1);
  });

  it('shows the audited zero once verification has run', () => {
    render(<KpiGrid job={JOB} report={REPORT} reportLoaded />);

    expect(screen.queryByText('awaiting verification')).not.toBeInTheDocument();
    expect(screen.getByText('none — verified')).toBeInTheDocument();
  });

  it('labels coverage by its source', () => {
    // Live progress and audited coverage answer different questions, so the card says which is on screen.
    const { unmount } = render(<KpiGrid job={JOB} report={null} reportLoaded />);
    expect(screen.getByText('live progress')).toBeInTheDocument();
    unmount();

    render(<KpiGrid job={JOB} report={REPORT} reportLoaded />);
    expect(screen.getByText('independently verified')).toBeInTheDocument();
  });

  it('renders real metrics from job state', () => {
    render(<KpiGrid job={JOB} report={REPORT} reportLoaded />);

    // Conflicts, re-evaluated and protected updates all read 9 in this fixture.
    expect(screen.getAllByText('9')).toHaveLength(3);
    expect(screen.getByText('925 applied · 66 already current')).toBeInTheDocument();
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
