import {
  CheckCircle2,
  MinusCircle,
  PenLine,
  RefreshCw,
  ShieldAlert,
  ShieldX,
} from 'lucide-react';
import type { PatientHistoryEntry } from '@bg/shared';

/**
 * One record's chronological history (R16.4).
 *
 * ## What this view is for
 *
 * It is the per-patient form of the project's central claim, assembled from four independent tables. On a
 * contended record it reads as a narrative:
 *
 * ```
 * Lab updated glucose 118 → 210 (v1 → v2)
 * Stale write blocked — computed from v1, record had reached v2
 * Conflict detected — glucose 118 → 210
 * Backfill wrote risk score 63, derived from v2
 * Re-evaluated: 48 → 63. Stale overwrite prevented.
 * ```
 *
 * Every line comes from a different place in storage, which is why the sequence is evidence rather than
 * narration. The backend builds it; this component only presents it.
 */

interface KindPresentation {
  label: string;
  icon: typeof PenLine;
  /** Dot and rail colour. */
  marker: string;
  text: string;
}

const PRESENTATION: Record<PatientHistoryEntry['kind'], KindPresentation> = {
  ONLINE_UPDATE: {
    label: 'Clinical update',
    icon: PenLine,
    marker: 'bg-amber-500 ring-amber-100',
    text: 'text-amber-900',
  },
  WRITE_APPLIED: {
    label: 'Backfill write',
    icon: CheckCircle2,
    marker: 'bg-brand-600 ring-brand-100',
    text: 'text-slate-800',
  },
  WRITE_REJECTED: {
    label: 'Stale write blocked',
    icon: ShieldX,
    marker: 'bg-rose-500 ring-rose-100',
    text: 'text-rose-900',
  },
  CONFLICT: {
    label: 'Conflict detected',
    icon: ShieldAlert,
    marker: 'bg-amber-600 ring-amber-100',
    text: 'text-amber-900',
  },
  REEVALUATION: {
    label: 'Re-evaluated',
    icon: RefreshCw,
    marker: 'bg-emerald-600 ring-emerald-100',
    text: 'text-emerald-900',
  },
  NO_ACTION: {
    label: 'Left untouched',
    icon: MinusCircle,
    marker: 'bg-slate-400 ring-slate-100',
    text: 'text-slate-700',
  },
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('en-GB', { hour12: false, fractionalSecondDigits: 3 });
}

export interface VersionHistoryProps {
  history: PatientHistoryEntry[];
}

export function VersionHistory({ history }: VersionHistoryProps) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        Nothing has happened to this record yet. Once a backfill reads it, or a clinician updates it, every
        write, conflict and re-evaluation appears here in order.
      </p>
    );
  }

  return (
    <ol className="relative space-y-3 border-l border-slate-200 pl-5">
      {history.map((entry, index) => {
        const presentation = PRESENTATION[entry.kind];
        const Icon = presentation.icon;

        return (
          <li key={`${entry.kind}-${entry.at}-${index}`} className="relative">
            {/* The rail dot. Decorative: the label below carries the same information as text. */}
            <span
              className={`absolute -left-[1.4375rem] top-1 h-2.5 w-2.5 rounded-full ring-4 ${presentation.marker}`}
              aria-hidden="true"
            />

            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className={`inline-flex items-center gap-1 text-xs font-semibold ${presentation.text}`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {presentation.label}
              </span>
              <span className="rounded bg-slate-100 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-slate-600">
                v{entry.version}
              </span>
              <time
                className="ml-auto font-mono text-[10px] tabular-nums text-slate-500"
                dateTime={entry.at}
              >
                {formatTimestamp(entry.at)}
              </time>
            </div>

            <p className="mt-0.5 text-xs leading-relaxed text-slate-700">{entry.summary}</p>

            {/* Score movement, shown only where both ends are known. */}
            {entry.scoreBefore !== undefined &&
            entry.scoreBefore !== null &&
            entry.scoreAfter !== undefined &&
            entry.scoreAfter !== null ? (
              <p className="mt-1 font-mono text-[11px] tabular-nums text-slate-500">
                score {entry.scoreBefore} → <span className="font-semibold text-slate-800">{entry.scoreAfter}</span>
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
