import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  ListFilter,
  Radio,
  ShieldAlert,
} from 'lucide-react';
import {
  EVENT_SEVERITY,
  TRANSPORT,
  type EventSeverity,
  type SimulationEvent,
} from '@bg/shared';

/**
 * The live event stream (R13.3, R14.3).
 *
 * ## Ordering and the cap
 *
 * Rendered newest first, because during a run the interesting thing just happened and a viewer should not
 * have to scroll. The list is capped at `TRANSPORT.timelineWindow`; the same cap is applied server-side and
 * again in `useLiveStream`, so this is a display guarantee rather than the enforcement point. Making it
 * explicit here matters anyway: a 1,000-record run emits thousands of events, and an uncapped list would
 * turn into a memory and layout problem precisely when the demo is being watched.
 *
 * ## Why `aria-live` is polite and scoped to a summary
 *
 * An assertive region, or one wrapping the whole list, would interrupt a screen reader continuously during a
 * run — dozens of announcements a second, which is worse than silence because it makes the rest of the page
 * unusable. Instead the list itself is a plain feed and a single summary line is the live region, so
 * assistive tech gets a periodic count and severity rollup rather than a firehose (R24.6).
 */

interface SeverityPresentation {
  label: string;
  row: string;
  badge: string;
  icon: typeof Info;
}

const PRESENTATION: Record<EventSeverity, SeverityPresentation> = {
  [EVENT_SEVERITY.INFO]: {
    label: 'Info',
    row: 'border-l-slate-300',
    badge: 'bg-slate-100 text-slate-700 ring-slate-300',
    icon: Info,
  },
  [EVENT_SEVERITY.SUCCESS]: {
    label: 'Success',
    row: 'border-l-emerald-400',
    badge: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
    icon: CheckCircle2,
  },
  [EVENT_SEVERITY.WARNING]: {
    label: 'Warning',
    row: 'border-l-amber-400 bg-amber-50/40',
    badge: 'bg-amber-50 text-amber-900 ring-amber-300',
    icon: AlertTriangle,
  },
  [EVENT_SEVERITY.CRITICAL]: {
    label: 'Critical',
    row: 'border-l-rose-500 bg-rose-50/50',
    badge: 'bg-rose-50 text-rose-900 ring-rose-400',
    icon: ShieldAlert,
  },
};

const FILTERS = ['ALL', EVENT_SEVERITY.WARNING, EVENT_SEVERITY.CRITICAL] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_LABEL: Record<Filter, string> = {
  ALL: 'Everything',
  [EVENT_SEVERITY.WARNING]: 'Conflicts and above',
  [EVENT_SEVERITY.CRITICAL]: 'Critical only',
};

/** Severity ranking, so "warning and above" is a threshold rather than an equality test. */
const RANK: Record<EventSeverity, number> = {
  [EVENT_SEVERITY.INFO]: 0,
  [EVENT_SEVERITY.SUCCESS]: 1,
  [EVENT_SEVERITY.WARNING]: 2,
  [EVENT_SEVERITY.CRITICAL]: 3,
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

export interface EventTimelineProps {
  events: SimulationEvent[];
  /** Overridable so a narrower panel can show fewer without changing the transport window. */
  limit?: number;
}

export function EventTimeline({ events, limit = TRANSPORT.timelineWindow }: EventTimelineProps) {
  const [filter, setFilter] = useState<Filter>('ALL');

  const visible = useMemo(() => {
    // Inclusive of the selected level: "conflicts and above" must show conflicts. A strict comparison
    // here silently excluded the exact severity the operator asked for.
    const threshold = filter === 'ALL' ? 0 : RANK[filter];

    return events
      .filter((event) => RANK[event.severity] >= threshold)
      // Newest first: during a run the relevant event is the one that just happened.
      .slice(-limit)
      .reverse();
  }, [events, filter, limit]);

  const counts = useMemo(() => {
    let warning = 0;
    let critical = 0;
    for (const event of events) {
      if (event.severity === EVENT_SEVERITY.WARNING) warning += 1;
      if (event.severity === EVENT_SEVERITY.CRITICAL) critical += 1;
    }
    return { warning, critical };
  }, [events]);

  return (
    <section
      aria-labelledby="events-heading"
      className="flex h-full min-h-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
        <h2
          id="events-heading"
          className="flex items-center gap-2 text-base font-semibold text-slate-900"
        >
          <Radio className="h-4 w-4 text-brand-600" aria-hidden="true" />
          Live activity
        </h2>

        <div className="flex items-center gap-1.5">
          <ListFilter className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
          <label htmlFor="event-filter" className="sr-only">
            Filter events by severity
          </label>
          <select
            id="event-filter"
            value={filter}
            onChange={(changeEvent) => setFilter(changeEvent.target.value as Filter)}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
          >
            {FILTERS.map((option) => (
              <option key={option} value={option}>
                {FILTER_LABEL[option]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/**
       * The single live region. A periodic rollup rather than every event, so assistive technology gets
       * something useful instead of an uninterruptible stream.
       */}
      <p
        className="border-b border-slate-100 px-5 py-2 text-xs text-slate-500"
        role="status"
        aria-live="polite"
      >
        {events.length === 0
          ? 'No events yet.'
          : `${events.length} event${events.length === 1 ? '' : 's'} in the live window` +
            `${counts.warning > 0 ? `, ${counts.warning} conflict-level` : ''}` +
            `${counts.critical > 0 ? `, ${counts.critical} critical` : ''}.`}
      </p>

      {visible.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">
          {events.length === 0
            ? 'Events appear here as the backfill runs: records read, conflicts detected, stale writes blocked.'
            : 'No events match this filter.'}
        </p>
      ) : (
        <ol className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
          {visible.map((event) => {
            const presentation = PRESENTATION[event.severity];
            const Icon = presentation.icon;

            return (
              <li
                key={event.sequence}
                className={`flex gap-2.5 border-l-4 px-4 py-2.5 ${presentation.row}`}
              >
                <Icon
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ring-1 ${presentation.badge}`}
                    >
                      {event.type}
                    </span>
                    {event.patientCode ? (
                      <span className="font-mono text-[10px] text-slate-500">
                        {event.patientCode}
                      </span>
                    ) : null}
                    <time
                      className="ml-auto font-mono text-[10px] tabular-nums text-slate-500"
                      dateTime={event.createdAt}
                    >
                      {formatTime(event.createdAt)}
                    </time>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-700">{event.message}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
