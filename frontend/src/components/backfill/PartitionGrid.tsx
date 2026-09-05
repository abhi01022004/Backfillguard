import { AlertTriangle, Check, Circle, LifeBuoy, Loader2, XCircle } from 'lucide-react';
import {
  PARTITION_STATE,
  type BackfillJobState,
  type PartitionProgress,
  type PartitionState,
} from '@bg/shared';

/**
 * Per-partition progress (R15).
 *
 * ## Why every cell carries a text label
 *
 * State is encoded three ways: colour, icon and a written label. Colour alone is the obvious design
 * choice and the wrong one — `PROCESSING` and `RECOVERING` are the two states a viewer most needs to
 * distinguish, and teal against indigo is exactly the pair that collapses under the most common form of
 * colour-vision deficiency. It also collapses on a washed-out projector, which is the actual viewing
 * condition this grid was built for (R24.6).
 *
 * ## Why the conflict badge counts open conflicts only
 *
 * A resolved conflict is a success story, not an outstanding problem. Badging the total would leave every
 * partition permanently marked after a healthy run, which trains the viewer to ignore the badge. The badge
 * means "something here still needs resolving", and after a completed run it should be absent everywhere —
 * which is itself the claim verification check C6 makes.
 */

interface StatePresentation {
  label: string;
  /** Cell background and border. */
  cell: string;
  /** Fill colour of the mini progress bar. */
  bar: string;
  icon: typeof Circle;
  animate?: boolean;
}

const PRESENTATION: Record<PartitionState, StatePresentation> = {
  [PARTITION_STATE.PENDING]: {
    label: 'Pending',
    cell: 'border-slate-200 bg-slate-50 text-slate-600',
    bar: 'bg-slate-300',
    icon: Circle,
  },
  [PARTITION_STATE.PROCESSING]: {
    label: 'Processing',
    cell: 'border-brand-300 bg-brand-50 text-brand-900 ring-1 ring-brand-200',
    bar: 'bg-brand-600',
    icon: Loader2,
    animate: true,
  },
  [PARTITION_STATE.COMPLETED]: {
    label: 'Completed',
    cell: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    bar: 'bg-emerald-600',
    icon: Check,
  },
  [PARTITION_STATE.RECOVERING]: {
    label: 'Recovering',
    cell: 'border-indigo-300 bg-indigo-50 text-indigo-900 ring-1 ring-indigo-200',
    bar: 'bg-indigo-600',
    icon: LifeBuoy,
    animate: true,
  },
  [PARTITION_STATE.FAILED]: {
    label: 'Failed',
    cell: 'border-rose-300 bg-rose-50 text-rose-900',
    bar: 'bg-rose-600',
    icon: XCircle,
  },
};

/** Display order for the legend: the lifecycle a partition actually moves through. */
const LEGEND_ORDER: readonly PartitionState[] = [
  PARTITION_STATE.PENDING,
  PARTITION_STATE.PROCESSING,
  PARTITION_STATE.COMPLETED,
  PARTITION_STATE.RECOVERING,
  PARTITION_STATE.FAILED,
];

export interface PartitionGridProps {
  job: BackfillJobState | null;
  /** Highlights the partition currently being scanned. */
  currentPartition?: number | null;
}

function PartitionCell({
  partition,
  isCurrent,
}: {
  partition: PartitionProgress;
  isCurrent: boolean;
}) {
  const presentation = PRESENTATION[partition.state];
  const Icon = presentation.icon;

  /**
   * The accessible name carries everything the visual cell conveys.
   *
   * A screen reader user should not have to infer state from a colour class or piece together three
   * separate text nodes, so the whole cell is summarised in one sentence.
   */
  const summary =
    `Partition ${partition.partitionIndex + 1}: ${presentation.label}, ` +
    `${partition.processedRecords} of ${partition.totalRecords} records considered ` +
    `(${partition.percentComplete}%)` +
    (partition.openConflicts > 0
      ? `, ${partition.openConflicts} unresolved conflict${partition.openConflicts === 1 ? '' : 's'}`
      : '');

  return (
    <li
      className={`relative rounded-lg border p-2.5 ${presentation.cell} ${
        isCurrent ? 'ring-2 ring-brand-500 ring-offset-1' : ''
      }`}
      aria-label={summary}
    >
      {/* Visual detail is hidden from assistive tech; the label above says it all in one go. */}
      <div aria-hidden="true">
        <div className="flex items-center justify-between gap-1">
          <span className="text-xs font-semibold tabular-nums">
            P{partition.partitionIndex + 1}
          </span>

          {partition.openConflicts > 0 ? (
            <span
              className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900 ring-1 ring-amber-400"
              title={`${partition.openConflicts} unresolved conflict(s)`}
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              {partition.openConflicts}
            </span>
          ) : (
            <Icon className={`h-3 w-3 ${presentation.animate ? 'animate-spin' : ''}`} />
          )}
        </div>

        <p className="mt-1 truncate text-[10px] font-medium uppercase tracking-wide opacity-80">
          {presentation.label}
        </p>

        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/70">
          <div
            className={`h-full rounded-full ${presentation.bar} transition-[width] duration-200 ease-out`}
            style={{ width: `${Math.min(100, partition.percentComplete)}%` }}
          />
        </div>

        <p className="mt-1 text-[10px] tabular-nums opacity-75">
          {partition.processedRecords}/{partition.totalRecords}
        </p>
      </div>
    </li>
  );
}

export function PartitionGrid({ job, currentPartition = null }: PartitionGridProps) {
  const partitions = job?.partitions ?? [];

  const totalOpenConflicts = partitions.reduce(
    (sum, partition) => sum + partition.openConflicts,
    0,
  );

  return (
    <section
      aria-labelledby="partitions-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="partitions-heading" className="text-base font-semibold text-slate-900">
          Partitions
        </h2>

        {totalOpenConflicts > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {totalOpenConflicts} unresolved conflict{totalOpenConflicts === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {partitions.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          Partitions appear once a backfill starts. The dataset is divided into partitions so progress,
          recovery and conflicts can each be located to a specific slice of the data.
        </p>
      ) : (
        <>
          <ul
            className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5"
            // Partition states change frequently during a run; announcing each would be unusable noise,
            // so this is a plain list and the aggregate lives in the heading row above.
          >
            {partitions.map((partition) => (
              <PartitionCell
                key={partition.partitionIndex}
                partition={partition}
                isCurrent={partition.partitionIndex === currentPartition}
              />
            ))}
          </ul>

          <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-slate-100 pt-3">
            {LEGEND_ORDER.map((state) => {
              const presentation = PRESENTATION[state];
              const Icon = presentation.icon;
              return (
                <li key={state} className="flex items-center gap-1.5 text-xs text-slate-600">
                  <span
                    className={`inline-flex h-4 w-4 items-center justify-center rounded border ${presentation.cell}`}
                    aria-hidden="true"
                  >
                    <Icon className="h-2.5 w-2.5" />
                  </span>
                  {presentation.label}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
