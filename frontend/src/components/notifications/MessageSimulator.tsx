import { BadgeCheck, Ban, Clock, MessageCircle, TriangleAlert } from 'lucide-react';
import {
  NOTIFICATION_STATUS,
  type NotificationRecord,
  type NotificationStatus,
} from '@bg/shared';

/**
 * A phone-style preview of one notification's exact message body.
 *
 * ## Why it renders the stored body verbatim
 *
 * The temptation is to rebuild a prettier message from the record's fields. That would make the panel a
 * *second* formatter, free to drift from the one that produced what was actually sent — and then the screen
 * would be showing a message that never existed. So this renders `record.message` as-is, whitespace preserved.
 * What you read here is byte-for-byte what the provider was handed.
 *
 * ## Why it is deliberately not a convincing WhatsApp mock
 *
 * It is styled as a chat bubble because that communicates the channel instantly, but it carries a simulated
 * badge, the demo provider's message id, and the synthetic recipient. A pixel-perfect clone of a real client
 * would be a more impressive screenshot and a worse artefact: someone glancing at it should not be able to come
 * away believing a message was delivered to a real phone.
 */

const STATUS_STYLES: Record<
  NotificationStatus,
  { label: string; bubble: string; badge: string; icon: typeof MessageCircle; note: string }
> = {
  [NOTIFICATION_STATUS.SENT]: {
    label: 'Sent',
    bubble: 'bg-emerald-50 border-emerald-200',
    badge: 'bg-emerald-100 text-emerald-800',
    icon: BadgeCheck,
    note: 'Handed to the provider after the result was committed under its version guard.',
  },
  [NOTIFICATION_STATUS.QUEUED]: {
    label: 'Queued',
    bubble: 'bg-slate-50 border-slate-200',
    badge: 'bg-slate-200 text-slate-700',
    icon: Clock,
    note: 'Computed but not yet committed. Nothing has been transmitted.',
  },
  [NOTIFICATION_STATUS.CANCELLED]: {
    label: 'Cancelled',
    bubble: 'bg-amber-50 border-amber-200',
    badge: 'bg-amber-100 text-amber-900',
    icon: Ban,
    note: 'The record changed before this could be sent, so it was withheld. This is the guard working.',
  },
  [NOTIFICATION_STATUS.FAILED]: {
    label: 'Failed',
    bubble: 'bg-rose-50 border-rose-200',
    badge: 'bg-rose-100 text-rose-800',
    icon: TriangleAlert,
    note: 'The provider rejected it. Reported rather than silently dropped.',
  },
};

export interface MessageSimulatorProps {
  record: NotificationRecord | null;
  providerName: string | null;
  simulated: boolean;
}

export function MessageSimulator({ record, providerName, simulated }: MessageSimulatorProps) {
  return (
    <section
      aria-labelledby="simulator-heading"
      className="flex min-h-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
        <h3
          id="simulator-heading"
          className="flex items-center gap-2 text-sm font-semibold text-slate-900"
        >
          <MessageCircle className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          Message simulator
        </h3>

        {simulated ? (
          <span className="rounded-full bg-slate-200/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700">
            simulated · {providerName ?? 'demo'}
          </span>
        ) : null}
      </div>

      {!record ? (
        <div className="px-5 py-6">
          <p className="text-sm text-slate-600">Select an alert to see the exact message body.</p>
          <p className="mt-1.5 text-xs text-slate-500">
            Nothing is ever transmitted. The demo provider opens no socket and reads no credential, which is
            why this runs with no account and no network.
          </p>
        </div>
      ) : (
        <Bubble record={record} />
      )}
    </section>
  );
}

function Bubble({ record }: { record: NotificationRecord }) {
  const style = STATUS_STYLES[record.status];
  const Icon = style.icon;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <p className="text-xs text-slate-500">
          To <span className="font-medium text-slate-700">{record.recipient}</span>
        </p>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.badge}`}
        >
          <Icon className="h-3 w-3" aria-hidden="true" />
          {style.label}
        </span>
      </div>

      {/*
       * `whitespace-pre-wrap`, because the formatter's line breaks are part of the message.
       * Reflowing it would show something subtly different from what was sent.
       */}
      <div className={`rounded-2xl rounded-tl-sm border p-3.5 ${style.bubble}`}>
        <p className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-slate-800">
          {record.message}
        </p>
      </div>

      <p className="mt-2.5 px-1 text-xs text-slate-600">{style.note}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-slate-100 px-1 pt-3 text-xs">
        <Field label="Patient" value={record.patientCode} />
        <Field label="Source version" value={`v${record.patientVersion}`} />
        <Field label="Risk" value={`${record.riskLevel} · ${record.riskScore}`} />
        <Field label="Reason" value={record.reason.replaceAll('_', ' ').toLowerCase()} />
        <Field label="Provider id" value={record.providerMessageId ?? 'not sent'} />
        <Field label="Channel" value={record.channel.toLowerCase()} />
        {record.failureReason ? (
          <div className="col-span-2">
            <dt className="text-slate-500">Failure</dt>
            <dd className="font-medium text-rose-700">{record.failureReason}</dd>
          </div>
        ) : null}
        <div className="col-span-2">
          <dt className="text-slate-500">Idempotency key</dt>
          {/*
           * Shown, not hidden as an implementation detail. It is the reason recovery cannot alert twice for
           * the same committed result, and reading `job:patient:version:level` makes that mechanism obvious
           * in a way a paragraph of prose does not.
           */}
          <dd className="break-all font-mono text-[11px] text-slate-600">
            {record.idempotencyKey}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  );
}
