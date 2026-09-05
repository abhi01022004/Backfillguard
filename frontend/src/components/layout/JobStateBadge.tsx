import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Loader2,
  LifeBuoy,
  Pause,
  ShieldCheck,
  ShieldX,
  XCircle,
  ZapOff,
} from 'lucide-react';
import { JOB_STATUS, type JobStatus } from '@bg/shared';

/**
 * The current job state, shown prominently at all times (R14.4).
 *
 * State is conveyed by icon, colour *and* text label. Colour alone would fail anyone with a colour-vision
 * deficiency, and on a projector at the back of a room the label is often the only thing legible (R24.6).
 */

interface StatusPresentation {
  label: string;
  className: string;
  icon: typeof CircleDot;
  /** Whether the icon should spin, reserved for genuinely in-progress states (R24.3). */
  animate?: boolean;
}

const PRESENTATION: Record<JobStatus, StatusPresentation> = {
  [JOB_STATUS.IDLE]: {
    label: 'Idle',
    className: 'bg-slate-100 text-slate-700 ring-slate-300',
    icon: CircleDot,
  },
  [JOB_STATUS.RUNNING]: {
    label: 'Running',
    className: 'bg-brand-50 text-brand-800 ring-brand-300',
    icon: Loader2,
    animate: true,
  },
  [JOB_STATUS.PAUSED]: {
    label: 'Paused',
    className: 'bg-amber-50 text-amber-800 ring-amber-300',
    icon: Pause,
  },
  [JOB_STATUS.CRASHED]: {
    label: 'Crashed',
    className: 'bg-rose-50 text-rose-800 ring-rose-300',
    icon: ZapOff,
  },
  [JOB_STATUS.RECOVERING]: {
    label: 'Recovering',
    className: 'bg-indigo-50 text-indigo-800 ring-indigo-300',
    icon: LifeBuoy,
    animate: true,
  },
  [JOB_STATUS.COMPLETED]: {
    label: 'Completed',
    className: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
    icon: CheckCircle2,
  },
  [JOB_STATUS.VERIFYING]: {
    label: 'Verifying',
    className: 'bg-indigo-50 text-indigo-800 ring-indigo-300',
    icon: Loader2,
    animate: true,
  },
  [JOB_STATUS.VERIFIED_SAFE]: {
    label: 'Verified safe',
    className: 'bg-emerald-100 text-emerald-900 ring-emerald-400',
    icon: ShieldCheck,
  },
  [JOB_STATUS.VERIFICATION_FAILED]: {
    label: 'Verification failed',
    className: 'bg-rose-100 text-rose-900 ring-rose-400',
    icon: ShieldX,
  },
  [JOB_STATUS.FAILED]: {
    label: 'Failed',
    className: 'bg-rose-100 text-rose-900 ring-rose-400',
    icon: XCircle,
  },
};

export interface JobStateBadgeProps {
  /** Null before any job has been started. */
  status: JobStatus | null;
  /** Shown alongside the label, e.g. a failure reason. */
  detail?: string | null;
  size?: 'sm' | 'lg';
}

export function JobStateBadge({ status, detail, size = 'lg' }: JobStateBadgeProps) {
  // No job yet is its own state, not an error and not a zero.
  if (!status) {
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-300"
        role="status"
      >
        <CircleDot className="h-3.5 w-3.5" aria-hidden="true" />
        No job started
      </span>
    );
  }

  const presentation = PRESENTATION[status];
  const Icon = presentation.icon;

  const sizing =
    size === 'lg' ? 'px-3.5 py-1.5 text-sm gap-2' : 'px-2.5 py-1 text-xs gap-1.5';
  const iconSize = size === 'lg' ? 'h-4 w-4' : 'h-3.5 w-3.5';

  return (
    <span
      className={`inline-flex items-center rounded-full font-semibold ring-1 ${presentation.className} ${sizing}`}
      role="status"
      aria-live="polite"
    >
      <Icon
        className={`${iconSize} ${presentation.animate ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      {presentation.label}
      {detail ? (
        <span className="ml-1 font-normal opacity-80" title={detail}>
          — {detail.length > 60 ? `${detail.slice(0, 60)}…` : detail}
        </span>
      ) : null}
    </span>
  );
}
