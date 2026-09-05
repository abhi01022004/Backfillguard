import { ArrowRight, ShieldCheck, ShieldX } from 'lucide-react';
import type { ComparisonSpotlight } from '@bg/shared';

/**
 * The one patient who makes the abstract claim legible (R12.5, R12.6).
 *
 * ## Why a single named record
 *
 * Two columns of aggregate metrics are convincing to someone who already believes the problem exists. This
 * panel is for everyone else: one patient, one lab value, two engines, and the value that either survived or
 * did not. Everything on it is read from the two runs rather than written as copy.
 *
 * ## Why the naive side is not always red
 *
 * In the control scenario — the same crash and recovery with no updates during the outage — the naive engine
 * loses nothing, and this panel says so. That is deliberate and it strengthens the argument rather than
 * weakening it: the naive engine is not broken in general, it is broken specifically when something changes
 * underneath it, which is exactly the condition the guard exists for. A panel that showed red regardless
 * would be the strongest possible evidence that the comparison was rigged.
 */

export interface StaleOverwriteCalloutProps {
  spotlight: ComparisonSpotlight;
}

export function StaleOverwriteCallout({ spotlight }: StaleOverwriteCalloutProps) {
  const naiveLost = spotlight.naive.lostTheOnlineUpdate;

  return (
    <section
      aria-labelledby="spotlight-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 id="spotlight-heading" className="text-base font-semibold text-slate-900">
        One patient, both engines
      </h2>

      <p className="mt-1.5 text-sm text-slate-600">
        Patient <span className="font-mono font-semibold">{spotlight.patientCode}</span>. The backfill computed
        a score from <span className="font-mono">{spotlight.field}</span>{' '}
        <span className="font-mono font-semibold">{String(spotlight.originalValue)}</span>, then crashed before
        writing it. During the outage a clinician recorded{' '}
        <span className="font-mono font-semibold">{String(spotlight.onlineUpdatedValue)}</span>. Both engines
        then resumed with the same stale result in hand.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {/* --- naive --- */}
        <div
          className={`rounded-lg border p-4 ${
            naiveLost ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-slate-50'
          }`}
        >
          <div className="flex items-center gap-2">
            {naiveLost ? (
              <ShieldX className="h-4 w-4 text-rose-700" aria-hidden="true" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-slate-500" aria-hidden="true" />
            )}
            <h3 className="text-sm font-semibold text-slate-900">Naive backfill</h3>
          </div>

          <p
            className={`mt-2 text-sm font-bold ${naiveLost ? 'text-rose-800' : 'text-slate-600'}`}
          >
            {naiveLost ? 'STALE OVERWRITE DETECTED ❌' : 'no stale overwrite (nothing changed underneath it)'}
          </p>

          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-slate-600">Final {spotlight.field}</dt>
              <dd className="font-mono font-semibold tabular-nums text-slate-900">
                {String(spotlight.naive.finalValue)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-slate-600">Final score</dt>
              <dd className="font-mono font-semibold tabular-nums text-slate-900">
                {spotlight.naive.finalScore ?? '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-slate-600">Clinician's value</dt>
              <dd className={`font-semibold ${naiveLost ? 'text-rose-800' : 'text-emerald-800'}`}>
                {naiveLost ? 'LOST' : 'preserved'}
              </dd>
            </div>
          </dl>

          {naiveLost ? (
            <p className="mt-3 text-xs leading-relaxed text-rose-900">
              The resumed job wrote the whole row back from its pre-crash snapshot, reverting{' '}
              <span className="font-mono">{spotlight.field}</span> to{' '}
              <span className="font-mono font-semibold">{String(spotlight.originalValue)}</span>. The reading is
              gone from the record — and because the engine then rescored from the reverted value, the score and
              the data agree with each other. The row looks internally consistent, which is what makes this
              failure so hard to notice.
            </p>
          ) : null}
        </div>

        {/* --- guarded --- */}
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-700" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-900">BackfillGuard</h3>
          </div>

          <p className="mt-2 text-sm font-bold text-emerald-800">
            {spotlight.guarded.staleOverwrite
              ? 'STALE OVERWRITE OCCURRED ❌'
              : 'STALE OVERWRITE PREVENTED ✅'}
          </p>

          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-slate-600">Final {spotlight.field}</dt>
              <dd className="font-mono font-semibold tabular-nums text-slate-900">
                {String(spotlight.guarded.finalValue)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-slate-600">Final score</dt>
              <dd className="font-mono font-semibold tabular-nums text-slate-900">
                {spotlight.guarded.finalScore ?? '—'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-slate-600">Clinician's value</dt>
              <dd
                className={`font-semibold ${
                  spotlight.guarded.lostTheOnlineUpdate ? 'text-rose-800' : 'text-emerald-800'
                }`}
              >
                {spotlight.guarded.lostTheOnlineUpdate ? 'LOST' : 'PRESERVED'}
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-xs leading-relaxed text-emerald-900">
            {spotlight.guarded.conflictDetected
              ? `The guarded write was refused because the row had moved. ${
                  spotlight.guarded.reevaluated
                    ? 'The stale result was discarded and the score recomputed from the current reading.'
                    : 'No stale value was written; the record is reported rather than quietly resolved.'
                }`
              : 'The staged result was revalidated against the current version before any write, so nothing stale reached the row.'}
          </p>
        </div>
      </div>

      {/* --- the value itself, traced through --- */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-4 py-3 text-sm">
        <span className="text-slate-500">{spotlight.field}:</span>
        <span className="font-mono text-slate-500">{String(spotlight.originalValue)}</span>
        <ArrowRight className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span className="font-mono font-semibold text-slate-900">
          {String(spotlight.onlineUpdatedValue)}
        </span>
        <span className="text-xs text-slate-500">(clinician)</span>
        <span className="mx-2 text-slate-500" aria-hidden="true">
          │
        </span>
        <span className="text-slate-500">naive ends at</span>
        <span
          className={`font-mono font-semibold ${naiveLost ? 'text-rose-700' : 'text-slate-900'}`}
        >
          {String(spotlight.naive.finalValue)}
        </span>
        <span className="mx-2 text-slate-500" aria-hidden="true">
          │
        </span>
        <span className="text-slate-500">guarded ends at</span>
        <span className="font-mono font-semibold text-emerald-700">
          {String(spotlight.guarded.finalValue)}
        </span>
      </div>
    </section>
  );
}
