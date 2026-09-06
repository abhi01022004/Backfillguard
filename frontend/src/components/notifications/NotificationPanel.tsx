import { useMemo, useState } from 'react';
import { Ban, BadgeCheck, Clock, Send, Smartphone, TriangleAlert } from 'lucide-react';
import {
  NOTIFICATION_STATUS,
  RISK_LEVEL,
  type NotificationRecord,
} from '@bg/shared';
import type { NotificationsState } from '../../hooks/useNotifications';
import { MessageSimulator } from './MessageSimulator';

/**
 * WhatsApp risk alerts, with the message simulator beside them.
 *
 * ## What this panel is arguing
 *
 * Not "we can send messages" — that is trivial. The claim is that an outbound side effect can be attached to a
 * concurrent backfill *without ever firing on stale data*. Three things on screen carry that argument:
 *
 * 1. Every sent alert names the **source version** it was computed from, which is provably the version the row
 *    held when the guarded write committed.
 * 2. **Cancelled** alerts are shown rather than discarded, so a prevented stale alert is visible evidence
 *    instead of an absence you are asked to take on trust.
 * 3. The **idempotency key** is on display, which is why recovery revisiting a record cannot alert twice.
 *
 * ## Why filtering is client-side
 *
 * The API supports server-side filters and this panel does not use them for tab switching. A run produces a few
 * hundred rows at most, so holding them all makes switching instant, and — the real reason — the counts on the
 * tabs are computed from the same array the tab body renders. A server round trip per tab would let a badge
 * disagree with its own contents.
 */

type Filter = 'all' | 'high' | 'sent' | 'cancelled' | 'failed';

const FILTERS: { id: Filter; label: string; match: (record: NotificationRecord) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'high', label: 'High risk', match: (record) => record.riskLevel === RISK_LEVEL.HIGH },
  { id: 'sent', label: 'Sent', match: (record) => record.status === NOTIFICATION_STATUS.SENT },
  {
    id: 'cancelled',
    label: 'Prevented',
    match: (record) => record.status === NOTIFICATION_STATUS.CANCELLED,
  },
  { id: 'failed', label: 'Failed', match: (record) => record.status === NOTIFICATION_STATUS.FAILED },
];

const ROW_ICON = {
  [NOTIFICATION_STATUS.SENT]: { icon: BadgeCheck, className: 'text-emerald-600' },
  [NOTIFICATION_STATUS.QUEUED]: { icon: Clock, className: 'text-slate-400' },
  [NOTIFICATION_STATUS.CANCELLED]: { icon: Ban, className: 'text-amber-600' },
  [NOTIFICATION_STATUS.FAILED]: { icon: TriangleAlert, className: 'text-rose-600' },
} as const;

export interface NotificationPanelProps {
  notifications: NotificationsState;
  onSelectPatient?: (patientCode: string) => void;
}

export function NotificationPanel({ notifications, onSelectPatient }: NotificationPanelProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { notifications: records, provider, loading, error, sending, sendError, sendTest } =
    notifications;

  // Newest first, without mutating the hook's array.
  const ordered = useMemo(() => [...records].reverse(), [records]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((entry) => [entry.id, ordered.filter(entry.match).length]),
      ) as Record<Filter, number>,
    [ordered],
  );

  const visible = useMemo(() => {
    const active = FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0]!;
    return ordered.filter(active.match);
  }, [ordered, filter]);

  /**
   * The selection falls back to the newest visible row.
   *
   * Without the fallback the simulator would empty itself whenever a filter excluded the selected row, which
   * reads as a bug rather than as a filter.
   */
  const selected =
    visible.find((record) => record.id === selectedId) ?? visible[0] ?? null;

  return (
    <section aria-labelledby="alerts-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="alerts-heading"
          className="flex items-center gap-2 text-base font-semibold text-slate-900"
        >
          <Smartphone className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          WhatsApp risk alerts
          {provider?.simulated ? (
            <span className="rounded-full bg-slate-200/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700">
              simulated
            </span>
          ) : null}
        </h2>

        <button
          type="button"
          onClick={() => void sendTest()}
          disabled={sending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Send className="h-3.5 w-3.5" aria-hidden="true" />
          {sending ? 'Sending…' : 'Send test WhatsApp'}
        </button>
      </div>

      {sendError ? (
        <p role="alert" className="text-sm text-rose-700">
          {sendError}
        </p>
      ) : null}

      <div
        role="tablist"
        aria-label="Filter risk alerts"
        className="inline-flex flex-wrap gap-1 rounded-lg bg-slate-200/70 p-0.5"
      >
        {FILTERS.map((entry) => {
          const active = entry.id === filter;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(entry.id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {entry.label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                  active ? 'bg-slate-100 text-slate-700' : 'bg-white/70 text-slate-600'
                }`}
              >
                {counts[entry.id]}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 xl:grid-cols-5">
        <div className="min-w-0 xl:col-span-3">
          {/*
            * Both columns share one height cap so the row cannot end up ragged.
            *
            * 34rem rather than something smaller because the simulator beside this has to fit a full message
            * body *and* its metadata — the provider id, source version and idempotency key are the evidence the
            * panel exists to show, and a cap that hid them below a scroll line defeated the point. At 26rem the
            * card was cut mid-sentence, which read as a rendering fault rather than as a scroll region.
            */}
          <div className="flex max-h-[34rem] min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {error ? (
              <p className="px-5 py-6 text-sm text-rose-700">{error}</p>
            ) : loading && records.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500">Loading alerts…</p>
            ) : records.length === 0 ? (
              <EmptyState />
            ) : visible.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-600">
                No alerts match this filter.
              </p>
            ) : (
              <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto">
                {visible.map((record) => (
                  <Row
                    key={record.id}
                    record={record}
                    selected={selected?.id === record.id}
                    onSelect={() => setSelectedId(record.id)}
                    {...(onSelectPatient ? { onSelectPatient } : {})}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="min-w-0 xl:col-span-2">
          <div className="max-h-[34rem] min-h-0 overflow-hidden">
            <MessageSimulator
              record={selected}
              providerName={provider?.name ?? null}
              simulated={provider?.simulated ?? true}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({
  record,
  selected,
  onSelect,
  onSelectPatient,
}: {
  record: NotificationRecord;
  selected: boolean;
  onSelect: () => void;
  onSelectPatient?: (patientCode: string) => void;
}) {
  const { icon: Icon, className } = ROW_ICON[record.status];

  return (
    <li>
      <div
        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          selected ? 'bg-brand-50/70' : 'hover:bg-slate-50'
        }`}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <Icon className={`h-4 w-4 shrink-0 ${className}`} aria-hidden="true" />

          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-xs font-semibold text-slate-900">
                {record.patientCode}
              </span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                v{record.patientVersion}
              </span>
              <span className="text-xs font-medium tabular-nums text-slate-700">
                {record.riskLevel} {record.riskScore}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-slate-500">
              {record.status === NOTIFICATION_STATUS.CANCELLED
                ? 'stale alert prevented — the record moved before sending'
                : record.reason.replaceAll('_', ' ').toLowerCase()}
            </span>
          </span>
        </button>

        {onSelectPatient ? (
          <button
            type="button"
            onClick={() => onSelectPatient(record.patientCode)}
            className="shrink-0 text-xs font-medium text-brand-700 hover:text-brand-900"
          >
            History
          </button>
        ) : null}
      </div>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="px-5 py-6">
      <p className="text-sm text-slate-600">No risk alerts yet.</p>
      <p className="mt-1.5 text-xs text-slate-500">
        An alert is raised only when a <span className="font-medium">HIGH</span> risk result is committed under
        its version guard. Run the backfill to produce them, or send a test message to see the flow without
        waiting. Nothing is ever transmitted — the demo provider contacts no network.
      </p>
    </div>
  );
}
