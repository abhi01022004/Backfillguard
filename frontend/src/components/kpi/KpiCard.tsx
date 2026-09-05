import type { LucideIcon } from 'lucide-react';

/**
 * A single KPI tile (R14.2, R14.6).
 *
 * ## The one rule this component enforces
 *
 * `value` is `number | null` with **no default**. A component that defaulted to `0` would render a
 * confident, plausible zero before anything had been measured — and "0 stale overwrites" shown before a
 * backfill has run is not a reassuring result, it is a lie that happens to match the eventual answer.
 *
 * So `null` renders an em dash plus a short reason. The distinction between "measured zero" and "not
 * measured" is visible at a glance, which is the whole point: every number on this dashboard should be
 * something a judge could ask us to justify.
 */

export type KpiTone = 'neutral' | 'good' | 'warning' | 'critical' | 'brand';

const TONES: Record<KpiTone, { value: string; icon: string; ring: string }> = {
  neutral: { value: 'text-slate-900', icon: 'text-slate-400', ring: 'ring-slate-200' },
  brand: { value: 'text-brand-800', icon: 'text-brand-500', ring: 'ring-brand-200' },
  good: { value: 'text-emerald-700', icon: 'text-emerald-500', ring: 'ring-emerald-200' },
  warning: { value: 'text-amber-700', icon: 'text-amber-500', ring: 'ring-amber-200' },
  critical: { value: 'text-rose-700', icon: 'text-rose-500', ring: 'ring-rose-200' },
};

export interface KpiCardProps {
  label: string;
  /** Null means not measured yet. There is deliberately no default. */
  value: number | null;
  icon: LucideIcon;
  tone?: KpiTone;
  /** Appended to a numeric value, e.g. '%'. */
  suffix?: string;
  /** Shown under the value when a number is present. */
  hint?: string;
  /** Shown instead of a value when `value` is null. Explains *why* there is no number. */
  emptyHint?: string;
  /** Emphasises the tile, used for the two headline safety numbers. */
  emphasis?: boolean;
}

function formatValue(value: number): string {
  // Thousands separators matter at 1,000 records: "1000" reads as a version number at a glance.
  return Number.isInteger(value) ? value.toLocaleString('en-GB') : value.toFixed(1);
}

export function KpiCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
  suffix,
  hint,
  emptyHint = 'not measured yet',
  emphasis = false,
}: KpiCardProps) {
  const palette = TONES[tone];
  const measured = value !== null;

  return (
    <div
      className={
        'rounded-xl border bg-white p-4 shadow-sm ring-1 ' +
        (emphasis ? 'border-slate-300 ring-2 ' : 'border-slate-200 ') +
        palette.ring
      }
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <Icon className={`h-4 w-4 shrink-0 ${measured ? palette.icon : 'text-slate-300'}`} aria-hidden="true" />
      </div>

      {measured ? (
        <>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${palette.value}`}>
            {formatValue(value)}
            {suffix ? <span className="ml-0.5 text-base font-medium">{suffix}</span> : null}
          </p>
          {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
        </>
      ) : (
        <>
          {/* An em dash, not a zero. The absence of a measurement is itself information. */}
          <p className="mt-2 text-2xl font-semibold text-slate-300" aria-label="not measured yet">
            —
          </p>
          <p className="mt-1 text-xs italic text-slate-400">{emptyHint}</p>
        </>
      )}
    </div>
  );
}
