import { PARTITION_STATE, type PartitionProgress, type PartitionState } from '@bg/shared';

/**
 * Partition progress compressed into a strip of bars, for the sticky status bar.
 *
 * ## Why a second view of the same data
 *
 * The full `PartitionGrid` is the readable one — labels, counts, a legend, a conflict badge. It is also
 * ~200px tall, which is too much to keep pinned to the top of the window. This is the glanceable form: one
 * thin bar per partition, filled in proportion to progress and tinted by state.
 *
 * It carries no text, so it is *not* a replacement. Colour alone is insufficient (R24.6), which is why the
 * strip is `aria-hidden` and the grid below remains the accessible presentation. What the strip adds is
 * peripheral vision: you can see the run advancing without looking away from the conflict feed.
 */

const FILL: Record<PartitionState, string> = {
  [PARTITION_STATE.PENDING]: 'bg-slate-300',
  [PARTITION_STATE.PROCESSING]: 'bg-brand-500',
  [PARTITION_STATE.COMPLETED]: 'bg-emerald-500',
  [PARTITION_STATE.RECOVERING]: 'bg-indigo-500',
  [PARTITION_STATE.FAILED]: 'bg-rose-500',
};

export interface PartitionStripProps {
  partitions: PartitionProgress[];
  /** Outlines the partition currently being scanned. */
  currentPartition?: number | null;
}

export function PartitionStrip({ partitions, currentPartition = null }: PartitionStripProps) {
  if (partitions.length === 0) return null;

  const totalOpenConflicts = partitions.reduce((sum, p) => sum + p.openConflicts, 0);

  return (
    <div className="flex items-center gap-2">
      {/*
       * Hidden from assistive technology on purpose: this is a duplicate, colour-only rendering of data the
       * partition grid already presents with labels. Announcing it twice would be noise, and announcing the
       * colour-only version would be worse than useless.
       */}
      <div className="flex items-end gap-[3px]" aria-hidden="true">
        {partitions.map((partition) => (
          <div
            key={partition.partitionIndex}
            title={`P${partition.partitionIndex + 1}: ${partition.state.toLowerCase()}, ${partition.percentComplete}%`}
            className={`relative h-7 w-[7px] overflow-hidden rounded-sm bg-slate-200 ${
              partition.partitionIndex === currentPartition ? 'ring-1 ring-brand-600 ring-offset-1' : ''
            }`}
          >
            {/* Fills bottom-up, so a column of bars reads like a progress meter rather than a bar chart. */}
            <div
              className={`absolute bottom-0 left-0 w-full transition-[height] duration-200 ease-out ${FILL[partition.state]}`}
              style={{ height: `${Math.min(100, partition.percentComplete)}%` }}
            />
            {partition.openConflicts > 0 ? (
              <span className="absolute left-0 top-0 h-[3px] w-full bg-amber-500" />
            ) : null}
          </div>
        ))}
      </div>

      <span className="text-[10px] leading-tight text-slate-500">
        {partitions.length} partitions
        {totalOpenConflicts > 0 ? (
          <>
            <br />
            <span className="font-semibold text-amber-700">{totalOpenConflicts} open</span>
          </>
        ) : null}
      </span>
    </div>
  );
}
