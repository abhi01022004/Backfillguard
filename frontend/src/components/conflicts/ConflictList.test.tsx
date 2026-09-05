import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONFLICT_RESOLUTION, EVENT_SEVERITY, EVENT_TYPE } from '@bg/shared';
import { makeConflict, makeEvent } from '../../test/fixtures';
import { ConflictCard } from './ConflictCard';
import { ConflictList } from './ConflictList';
import { EventTimeline } from '../events/EventTimeline';

/**
 * Conflict presentation and the live feed (R10, R13.3).
 *
 * The assertions that matter are about *not overclaiming*. It is easy to write a card that says
 * "PREVENTED" for every conflict and an empty state that shows a green tick for zero conflicts, and both
 * would be dishonest in a way a casual reader would never catch.
 */

describe('ConflictCard', () => {
  it('shows both versions, the field that moved, and both scores', () => {
    render(<ConflictCard conflict={makeConflict()} />);

    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('glucose')).toBeInTheDocument();
    expect(screen.getByText('118 → 210')).toBeInTheDocument();
    expect(screen.getByText(/^48/)).toBeInTheDocument();
    expect(screen.getByText(/^63/)).toBeInTheDocument();
  });

  it('states the headline outcome in words for a resolved conflict', () => {
    render(<ConflictCard conflict={makeConflict()} />);

    expect(screen.getByText('RE-EVALUATED')).toBeInTheDocument();
    expect(screen.getByText('PREVENTED')).toBeInTheDocument();
  });

  it('calls out a risk level change, not just a score change', () => {
    render(<ConflictCard conflict={makeConflict({ oldScore: 48, newScore: 63 })} />);
    expect(screen.getByText(/filed this patient a band lower/)).toBeInTheDocument();
  });

  it('stays quiet about the band when the level did not move', () => {
    render(<ConflictCard conflict={makeConflict({ oldScore: 40, newScore: 48 })} />);
    expect(screen.queryByText(/a band lower/)).not.toBeInTheDocument();
  });

  it('does not claim PREVENTED for an unresolved conflict', () => {
    /**
     * A pending conflict blocked a write but has not been recomputed, so nothing has yet been *preserved*.
     * Saying PREVENTED here would take credit for an outcome that has not happened.
     */
    render(
      <ConflictCard
        conflict={makeConflict({ resolution: CONFLICT_RESOLUTION.PENDING, newScore: null, resolvedAt: null })}
      />,
    );

    expect(screen.queryByText('PREVENTED')).not.toBeInTheDocument();
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByText('write blocked, awaiting recomputation')).toBeInTheDocument();
  });

  it('reports a failed conflict as unresolved rather than hiding it', () => {
    render(
      <ConflictCard
        conflict={makeConflict({ resolution: CONFLICT_RESOLUTION.FAILED, newScore: null })}
      />,
    );

    expect(screen.getByText('FAILED — no stale value written')).toBeInTheDocument();
    expect(screen.getByText('none written')).toBeInTheDocument();
    expect(screen.queryByText('PREVENTED')).not.toBeInTheDocument();
  });

  it('links to the patient when navigation is available', async () => {
    const onSelectPatient = vi.fn();
    render(<ConflictCard conflict={makeConflict()} onSelectPatient={onSelectPatient} />);

    await userEvent.click(screen.getByRole('button', { name: 'P0001' }));
    expect(onSelectPatient).toHaveBeenCalledWith('P0001');
  });

  it('renders the code as plain text when there is nowhere to navigate', () => {
    render(<ConflictCard conflict={makeConflict()} />);
    expect(screen.queryByRole('button', { name: 'P0001' })).not.toBeInTheDocument();
    expect(screen.getByText('P0001')).toBeInTheDocument();
  });
});

describe('ConflictList', () => {
  it('treats zero conflicts as an untested guard, not a passed test', () => {
    render(<ConflictList conflicts={[]} total={0} open={0} loading={false} error={null} />);

    expect(screen.getByText('No conflicts detected yet.')).toBeInTheDocument();
    expect(screen.getByText(/not the same as a safe run/)).toBeInTheDocument();
    expect(screen.getByText(/has not yet been exercised/)).toBeInTheDocument();
  });

  it('summarises detected, re-evaluated and open counts', () => {
    const conflicts = [
      makeConflict({ id: 1 }),
      makeConflict({ id: 2 }),
      makeConflict({
        id: 3,
        resolution: CONFLICT_RESOLUTION.PENDING,
        newScore: null,
        resolvedAt: null,
      }),
    ];

    render(<ConflictList conflicts={conflicts} total={3} open={1} loading={false} error={null} />);

    // Asserted on the summary line as a whole: the counts are interleaved with their labels, and pinning
    // individual text nodes would break on any wording change without testing anything real.
    const summary = screen.getByText(/detected/).closest('p')!;
    expect(summary).toHaveTextContent('3 detected · 2 re-evaluated · 1 open');
  });

  it('shows the newest conflicts first', () => {
    const conflicts = [
      makeConflict({ id: 1, patientCode: 'P0001' }),
      makeConflict({ id: 2, patientCode: 'P0002' }),
      makeConflict({ id: 3, patientCode: 'P0003' }),
    ];

    render(<ConflictList conflicts={conflicts} total={3} open={0} loading={false} error={null} />);

    const codes = screen.getAllByText(/^P000\d$/).map((node) => node.textContent);
    expect(codes).toEqual(['P0003', 'P0002', 'P0001']);
  });

  it('collapses a long list and expands on request', async () => {
    const conflicts = Array.from({ length: 9 }, (_, index) =>
      makeConflict({ id: index + 1, patientCode: `P00${String(index + 1).padStart(2, '0')}` }),
    );

    render(
      <ConflictList
        conflicts={conflicts}
        total={9}
        open={0}
        loading={false}
        error={null}
        initialVisible={4}
      />,
    );

    expect(screen.getAllByText(/^P00\d\d$/)).toHaveLength(4);

    await userEvent.click(screen.getByRole('button', { name: 'Show all 9 conflicts' }));
    expect(screen.getAllByText(/^P00\d\d$/)).toHaveLength(9);
  });

  it('surfaces a fetch error rather than showing an empty state', () => {
    render(
      <ConflictList
        conflicts={[]}
        total={0}
        open={0}
        loading={false}
        error="Cannot reach the BackfillGuard backend."
      />,
    );

    expect(screen.getByText('Cannot reach the BackfillGuard backend.')).toBeInTheDocument();
    expect(screen.queryByText('No conflicts detected yet.')).not.toBeInTheDocument();
  });
});

describe('EventTimeline', () => {
  it('explains what will appear rather than showing an empty box', () => {
    render(<EventTimeline events={[]} />);
    expect(screen.getByText(/Events appear here as the backfill runs/)).toBeInTheDocument();
    expect(screen.getByText('No events yet.')).toBeInTheDocument();
  });

  it('renders newest first', () => {
    const events = [
      makeEvent({ sequence: 1, message: 'first' }),
      makeEvent({ sequence: 2, message: 'second' }),
      makeEvent({ sequence: 3, message: 'third' }),
    ];

    render(<EventTimeline events={events} />);

    const messages = screen
      .getAllByText(/first|second|third/)
      .map((node) => node.textContent);
    expect(messages).toEqual(['third', 'second', 'first']);
  });

  it('caps the rendered list', () => {
    const events = Array.from({ length: 50 }, (_, index) =>
      makeEvent({ sequence: index + 1, message: `event ${index + 1}` }),
    );

    render(<EventTimeline events={events} limit={10} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    // The cap keeps the newest, not the oldest — the opposite would hide what just happened.
    expect(screen.getByText('event 50')).toBeInTheDocument();
    expect(screen.queryByText('event 40')).not.toBeInTheDocument();
  });

  it('announces a rollup, not every event', async () => {
    /**
     * One polite live region carrying a summary.
     *
     * An assertive region, or one wrapping the list, would announce dozens of events a second during a run
     * and make the rest of the page unusable with a screen reader.
     */
    const events = [
      makeEvent({ sequence: 1, severity: EVENT_SEVERITY.INFO }),
      makeEvent({ sequence: 2, severity: EVENT_SEVERITY.WARNING }),
      makeEvent({ sequence: 3, severity: EVENT_SEVERITY.CRITICAL }),
    ];

    render(<EventTimeline events={events} />);

    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('3 events in the live window, 1 conflict-level, 1 critical.');
  });

  it('filters to conflict level and above', async () => {
    const events = [
      makeEvent({ sequence: 1, severity: EVENT_SEVERITY.INFO, message: 'routine read' }),
      makeEvent({
        sequence: 2,
        severity: EVENT_SEVERITY.WARNING,
        type: EVENT_TYPE.CONFLICT_DETECTED,
        message: 'conflict on P0001',
      }),
      makeEvent({
        sequence: 3,
        severity: EVENT_SEVERITY.CRITICAL,
        type: EVENT_TYPE.BACKFILL_CRASHED,
        message: 'backfill crashed',
      }),
    ];

    render(<EventTimeline events={events} />);

    await userEvent.selectOptions(
      screen.getByLabelText('Filter events by severity'),
      EVENT_SEVERITY.WARNING,
    );

    expect(screen.queryByText('routine read')).not.toBeInTheDocument();
    expect(screen.getByText('conflict on P0001')).toBeInTheDocument();
    expect(screen.getByText('backfill crashed')).toBeInTheDocument();
  });

  it('says a filter matched nothing rather than looking empty', async () => {
    render(<EventTimeline events={[makeEvent({ severity: EVENT_SEVERITY.INFO })]} />);

    await userEvent.selectOptions(
      screen.getByLabelText('Filter events by severity'),
      EVENT_SEVERITY.CRITICAL,
    );

    expect(screen.getByText('No events match this filter.')).toBeInTheDocument();
  });
});
