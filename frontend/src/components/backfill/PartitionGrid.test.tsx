import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PARTITION_STATE } from '@bg/shared';
import { makeJob, makePartition } from '../../test/fixtures';
import { PartitionGrid } from './PartitionGrid';

/**
 * The partition grid (R15).
 *
 * The assertions worth having here are about *legibility under adverse conditions*, not layout. A grid that
 * encodes state only in a CSS class passes a naive render test and fails the person watching it on a
 * projector, so these tests check that the state is present as text and that the accessible name carries
 * the whole cell.
 */

describe('PartitionGrid', () => {
  it('explains what partitions are instead of rendering an empty grid', () => {
    render(<PartitionGrid job={makeJob({ partitions: [] })} />);
    expect(screen.getByText(/Partitions appear once a backfill starts/)).toBeInTheDocument();
  });

  it('says nothing at all when there is no job', () => {
    render(<PartitionGrid job={null} />);
    expect(screen.getByText(/Partitions appear once a backfill starts/)).toBeInTheDocument();
  });

  it('names every state in text, not colour alone', () => {
    const job = makeJob({
      partitions: [
        makePartition(0, { state: PARTITION_STATE.COMPLETED, processedRecords: 100, percentComplete: 100 }),
        makePartition(1, { state: PARTITION_STATE.PROCESSING, processedRecords: 40, percentComplete: 40 }),
        makePartition(2, { state: PARTITION_STATE.RECOVERING, processedRecords: 60, percentComplete: 60 }),
        makePartition(3, { state: PARTITION_STATE.FAILED }),
        makePartition(4, { state: PARTITION_STATE.PENDING }),
      ],
    });

    render(<PartitionGrid job={job} />);

    // Each label appears twice: once in its cell and once in the legend.
    for (const label of ['Completed', 'Processing', 'Recovering', 'Failed', 'Pending']) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('summarises a whole cell in its accessible name', () => {
    const job = makeJob({
      partitions: [
        makePartition(2, {
          state: PARTITION_STATE.PROCESSING,
          totalRecords: 100,
          processedRecords: 43,
          percentComplete: 43,
        }),
      ],
    });

    render(<PartitionGrid job={job} />);

    // Partition indices are zero-based internally and one-based on screen: "P3", not "P2".
    expect(
      screen.getByLabelText('Partition 3: Processing, 43 of 100 records considered (43%)'),
    ).toBeInTheDocument();
  });

  it('badges unresolved conflicts and includes them in the accessible name', () => {
    const job = makeJob({
      partitions: [makePartition(0, { state: PARTITION_STATE.PROCESSING, openConflicts: 2 })],
    });

    render(<PartitionGrid job={job} />);

    expect(screen.getByLabelText(/2 unresolved conflicts/)).toBeInTheDocument();
    expect(screen.getByText('2 unresolved conflicts')).toBeInTheDocument();
  });

  it('uses singular wording for a single conflict', () => {
    const job = makeJob({
      partitions: [makePartition(0, { openConflicts: 1 })],
    });

    render(<PartitionGrid job={job} />);
    expect(screen.getByText('1 unresolved conflict')).toBeInTheDocument();
  });

  it('shows no conflict badge once every conflict is resolved', () => {
    /**
     * The badge counts *open* conflicts, not total.
     *
     * Badging the total would leave every partition permanently marked after a perfectly healthy run,
     * which teaches the viewer to ignore the badge. Absence of badges after a completed run is exactly
     * what verification check C6 asserts.
     */
    const job = makeJob({
      partitions: [
        makePartition(0, { state: PARTITION_STATE.COMPLETED, percentComplete: 100, openConflicts: 0 }),
      ],
    });

    render(<PartitionGrid job={job} />);
    expect(screen.queryByText(/unresolved conflict/)).not.toBeInTheDocument();
  });

  it('aggregates open conflicts across partitions', () => {
    const job = makeJob({
      partitions: [
        makePartition(0, { openConflicts: 2 }),
        makePartition(1, { openConflicts: 3 }),
        makePartition(2, { openConflicts: 0 }),
      ],
    });

    render(<PartitionGrid job={job} />);
    expect(screen.getByText('5 unresolved conflicts')).toBeInTheDocument();
  });

  it('marks the partition currently being scanned', () => {
    const job = makeJob({
      partitions: [makePartition(0), makePartition(1), makePartition(2)],
    });

    render(<PartitionGrid job={job} currentPartition={1} />);

    const cells = screen.getAllByRole('listitem');
    const current = cells.find((cell) => cell.getAttribute('aria-label')?.startsWith('Partition 2'))!;
    expect(current.className).toContain('ring-brand-500');
  });
});
