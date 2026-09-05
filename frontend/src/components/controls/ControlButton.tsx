import { Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * A single simulation control.
 *
 * ## Why a disabled control still explains itself
 *
 * `disabledReason` is rendered as the button's `title` *and* appended to its accessible name. A disabled
 * button with no explanation is one of the most common ways a UI wastes someone's time — they click, nothing
 * happens, and they have no way to find out why. Here the reason comes from the shared job-state table, so
 * it names the current state and the states the action is actually allowed from (R8.7).
 *
 * Note the button stays in the DOM rather than being hidden. Hiding controls as state changes makes the
 * panel jump around and hides the shape of the state machine from someone trying to understand it.
 */

export type ControlTone = 'primary' | 'neutral' | 'warning' | 'danger';

const TONE_CLASS: Record<ControlTone, string> = {
  primary:
    'bg-brand-600 text-white ring-brand-600 hover:enabled:bg-brand-700 disabled:bg-slate-200 disabled:text-slate-500 disabled:ring-slate-200',
  neutral:
    'bg-white text-slate-700 ring-slate-300 hover:enabled:bg-slate-50 disabled:bg-slate-50 disabled:text-slate-500',
  warning:
    'bg-amber-50 text-amber-900 ring-amber-300 hover:enabled:bg-amber-100 disabled:bg-slate-50 disabled:text-slate-500 disabled:ring-slate-200',
  danger:
    'bg-rose-50 text-rose-900 ring-rose-300 hover:enabled:bg-rose-100 disabled:bg-slate-50 disabled:text-slate-500 disabled:ring-slate-200',
};

export interface ControlButtonProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  /** Why this control cannot be used right now. Null when it can. */
  disabledReason?: string | null;
  /** True while this control's request is in flight. */
  busy?: boolean;
  tone?: ControlTone;
  /** What the control does, shown beneath the label. */
  hint?: string;
}

export function ControlButton({
  label,
  icon: Icon,
  onClick,
  disabledReason = null,
  busy = false,
  tone = 'neutral',
  hint,
}: ControlButtonProps) {
  const disabled = disabledReason !== null || busy;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabledReason ?? hint ?? label}
      // The reason travels with the accessible name, so a screen reader user learns it without hovering.
      aria-label={disabledReason ? `${label} — unavailable: ${disabledReason}` : label}
      className={`inline-flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium ring-1 transition-colors disabled:cursor-not-allowed ${TONE_CLASS[tone]}`}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && !disabledReason ? (
          <span className="block truncate text-[11px] font-normal opacity-70">{hint}</span>
        ) : null}
        {disabledReason ? (
          <span className="block truncate text-[11px] font-normal opacity-70">
            {/* Trimmed to the actionable half; the full sentence is in the title and accessible name. */}
            {disabledReason.replace(/^Cannot .*? while the job is /, 'not while ')}
          </span>
        ) : null}
      </span>
    </button>
  );
}
