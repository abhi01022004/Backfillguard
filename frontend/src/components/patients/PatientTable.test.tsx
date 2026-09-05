import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BACKFILL_STATUS, RISK_LEVEL, type PatientHistoryEntry } from '@bg/shared';
import { EMPTY_FILTERS, type PatientsState } from '../../hooks/usePatients';
import { makePatient } from '../../test/fixtures';
import { PatientTable } from './PatientTable';
import { PatientDetailDrawer } from './PatientDetailDrawer';
import { VersionHistory } from './VersionHistory';
import { RiskBadge, StatusBadge } from './StatusBadges';

/**
 * The patient browser (R16).
 *
 * The assertions worth having are about the two places this view can quietly mislead: presenting an unscored
 * record as a low-risk one, and presenting a score that is older than its data as if it were current.
 */

function makeState(overrides: Partial<PatientsState> = {}): PatientsState {
  return {
    patients: [makePatient()],
    page: 1,
    pageSize: 25,
    total: 1,
    totalPages: 1,
    loading: false,
    error: null,
    fetchedAt: '2026-09-05T10:00:00.000Z',
    setPage: vi.fn(),
    refetch: vi.fn(),
    ...overrides,
  };
}

describe('RiskBadge', () => {
  it('says "not scored" rather than defaulting an unscored record to LOW', () => {
    // Defaulting null to the lowest band would state a clinical conclusion nobody computed.
    render(<RiskBadge level={null} />);
    expect(screen.getByText('not scored')).toBeInTheDocument();
    expect(screen.queryByText('LOW')).not.toBeInTheDocument();
  });

  it('renders a measured level', () => {
    render(<RiskBadge level={RISK_LEVEL.HIGH} />);
    expect(screen.getByText('HIGH')).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('labels every status in words', () => {
    const { unmount } = render(<StatusBadge status={BACKFILL_STATUS.PROTECTED} />);
    expect(screen.getByText('Protected')).toBeInTheDocument();
    unmount();

    render(<StatusBadge status={BACKFILL_STATUS.REEVALUATED} />);
    expect(screen.getByText('Re-evaluated')).toBeInTheDocument();
  });
});

describe('PatientTable', () => {
  it('pairs the source version with the version the score came from', () => {
    render(
      <PatientTable
        state={makeState({ patients: [makePatient({ version: 3, lastBackfillVersion: 3 })] })}
        filters={EMPTY_FILTERS}
        onFiltersChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('v3 / v3')).toBeInTheDocument();
  });

  it('flags a score that is older than its data, and explains why', () => {
    render(
      <PatientTable
        state={makeState({ patients: [makePatient({ version: 4, lastBackfillVersion: 2 })] })}
        filters={EMPTY_FILTERS}
        onFiltersChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const cell = screen.getByText('v4 / v2');
    expect(cell).toBeInTheDocument();
    expect(cell).toHaveAttribute(
      'title',
      'Score derived from v2, source data has reached v4: the score is older than the data.',
    );
  });

  it('shows an em dash for a record that was never scored', () => {
    render(
      <PatientTable
        state={makeState({
          patients: [makePatient({ version: 1, lastBackfillVersion: null, riskScore: null, riskLevel: null })],
        })}
        filters={EMPTY_FILTERS}
        onFiltersChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('v1 / —')).toBeInTheDocument();
  });

  it('opens a record from the keyboard, not just by clicking the row', async () => {
    // A clickable <tr> with no focusable control is unreachable without a mouse.
    const onSelect = vi.fn();
    render(
      <PatientTable
        state={makeState()}
        filters={EMPTY_FILTERS}
        onFiltersChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();

    const code = screen.getByRole('button', { name: 'P0001' });
    code.focus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith('P0001');
  });

  it('reports each filter change to the caller', async () => {
    const onFiltersChange = vi.fn();
    render(
      <PatientTable
        state={makeState()}
        filters={EMPTY_FILTERS}
        onFiltersChange={onFiltersChange}
        onSelect={vi.fn()}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText('Status'), BACKFILL_STATUS.CONFLICT);
    expect(onFiltersChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, status: 'CONFLICT' });

    await userEvent.selectOptions(screen.getByLabelText('Risk level'), RISK_LEVEL.HIGH);
    expect(onFiltersChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, riskLevel: 'HIGH' });

    await userEvent.selectOptions(screen.getByLabelText('Partition'), '2');
    expect(onFiltersChange).toHaveBeenCalledWith({ ...EMPTY_FILTERS, partitionIndex: 2 });
  });

  it('distinguishes "no matches" from "no data"', () => {
    const { unmount } = render(
      <PatientTable
        state={makeState({ patients: [], total: 0, totalPages: 0 })}
        filters={{ ...EMPTY_FILTERS, riskLevel: RISK_LEVEL.HIGH }}
        onFiltersChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('No records match these filters.')).toBeInTheDocument();
    unmount();

    render(
      <PatientTable
        state={makeState({ patients: [], total: 0, totalPages: 0 })}
        filters={EMPTY_FILTERS}
        onFiltersChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/Seed the dataset/)).toBeInTheDocument();
  });

  it('disables pagination at both ends', () => {
    const { unmount } = render(
      <PatientTable
        state={makeState({ page: 1, totalPages: 3, total: 75 })}
        filters={EMPTY_FILTERS}
        onFiltersChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Next/ })).toBeEnabled();
    unmount();

    render(
      <PatientTable
        state={makeState({ page: 3, totalPages: 3, total: 75 })}
        filters={EMPTY_FILTERS}
        onFiltersChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
  });
});

describe('VersionHistory', () => {
  const HISTORY: PatientHistoryEntry[] = [
    {
      kind: 'ONLINE_UPDATE',
      version: 2,
      at: '2026-09-05T10:00:00.000Z',
      summary: 'Lab updated glucose 118 → 210 (v1 → v2).',
      changedFields: [{ field: 'glucose', from: 118, to: 210 }],
    },
    {
      kind: 'WRITE_REJECTED',
      version: 1,
      at: '2026-09-05T10:00:00.100Z',
      summary: 'Stale write blocked: computed from v1, but the record had already reached v2.',
      rejectedScore: 48,
    },
    {
      kind: 'REEVALUATION',
      version: 2,
      at: '2026-09-05T10:00:00.300Z',
      summary: 'Re-evaluated from current data: score 48 → 63. Stale overwrite prevented.',
      scoreBefore: 48,
      scoreAfter: 63,
    },
  ];

  it('explains what will appear rather than rendering an empty rail', () => {
    render(<VersionHistory history={[]} />);
    expect(screen.getByText(/Nothing has happened to this record yet/)).toBeInTheDocument();
  });

  it('labels each entry kind in words and shows its version', () => {
    render(<VersionHistory history={HISTORY} />);

    expect(screen.getByText('Clinical update')).toBeInTheDocument();
    expect(screen.getByText('Stale write blocked')).toBeInTheDocument();
    expect(screen.getByText('Re-evaluated')).toBeInTheDocument();
    expect(screen.getAllByText('v2')).toHaveLength(2);
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('preserves the order it was given', () => {
    // Ordering is the backend's job; re-sorting here would risk two surfaces telling different stories.
    render(<VersionHistory history={HISTORY} />);

    // Read the first line of each entry rather than text-matching the labels, which would also hit the
    // summary paragraphs that quote the same words.
    const labels = screen
      .getAllByRole('listitem')
      .map((item) => item.querySelector('span.inline-flex')?.textContent?.trim());

    expect(labels).toEqual(['Clinical update', 'Stale write blocked', 'Re-evaluated']);
  });

  it('shows score movement only where both ends are known', () => {
    /**
     * Located structurally rather than by text.
     *
     * The movement line splits its value across two elements, and the entry's summary quotes the same two
     * numbers, so a text matcher would either miss it or match the wrong node.
     */
    const movementLine = () =>
      screen
        .getAllByRole('listitem')
        .flatMap((item) => [...item.querySelectorAll('p.font-mono')])
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim());

    const { unmount } = render(<VersionHistory history={HISTORY} />);
    expect(movementLine()).toEqual(['score 48 → 63']);
    unmount();

    render(<VersionHistory history={[{ ...HISTORY[2]!, scoreAfter: null }]} />);
    expect(movementLine()).toEqual([]);
  });
});

describe('PatientDetailDrawer', () => {
  const DETAIL = {
    patient: makePatient({ version: 4, lastBackfillVersion: 2, riskScore: 48 }),
    risk: {
      score: 63,
      level: RISK_LEVEL.HIGH,
      breakdown: [
        { factor: 'glucose' as const, band: 'veryHigh', points: 25, inputSummary: '210 mg/dL' },
      ],
      configVersion: 'risk-v1',
    },
    history: [],
    disclaimer: 'Synthetic Hackathon Risk Score — Not for Clinical Use',
    storedScoreMatchesCurrentData: false,
  };

  it('renders nothing when no patient is selected', () => {
    const { container } = render(
      <PatientDetailDrawer
        code={null}
        detail={null}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('describes a score/data mismatch as drift, not a fault', () => {
    /**
     * The important wording judgement on this panel. A stored score older than the data is expected and
     * safe; labelling it an error would misrepresent normal behaviour and undermine the real safety claim.
     */
    render(
      <PatientDetailDrawer
        code="P0001"
        detail={DETAIL}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText(/This is drift, not a fault/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing stale was written over it/)).toBeInTheDocument();
  });

  it('says nothing about drift when the score matches current data', () => {
    render(
      <PatientDetailDrawer
        code="P0001"
        detail={{ ...DETAIL, storedScoreMatchesCurrentData: true }}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.queryByText(/drift, not a fault/)).not.toBeInTheDocument();
  });

  it('marks age as not updatable online, matching the server whitelist', () => {
    render(
      <PatientDetailDrawer
        code="P0001"
        detail={DETAIL}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('not updatable online')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <PatientDetailDrawer
        code="P0001"
        detail={DETAIL}
        loading={false}
        error={null}
        onClose={onClose}
        onRefresh={vi.fn()}
      />,
    );

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('moves focus into the panel on open', () => {
    render(
      <PatientDetailDrawer
        code="P0001"
        detail={DETAIL}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Close patient detail' })).toHaveFocus();
  });

  it('is announced as a modal dialog with the patient code as its name', () => {
    render(
      <PatientDetailDrawer
        code="P0001"
        detail={DETAIL}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('P0001');
  });

  it('shows an error instead of an empty panel', () => {
    render(
      <PatientDetailDrawer
        code="P0001"
        detail={null}
        loading={false}
        error="Patient P0001 does not exist."
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('Patient P0001 does not exist.')).toBeInTheDocument();
  });
});
