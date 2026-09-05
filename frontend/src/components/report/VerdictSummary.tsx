import { ArrowRight, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import { VERIFICATION_VERDICT, type VerificationReport } from '@bg/shared';
import { hrefFor, ROUTES } from '../../routes';

/**
 * The audited verdict, on the dashboard (R24.1).
 *
 * ## Why this is duplicated from the report page
 *
 * R24.1 requires the dashboard to convey the final proof without navigation, and a judge who never leaves the
 * first screen should still see whether the run was independently verified. The full report — six checks, their
 * methods, the offending records — stays on its own page, because that is a reading surface rather than a
 * glance surface.
 *
 * ## Why "not verified yet" is stated rather than left blank
 *
 * An absent verdict is the most dangerous thing this panel could render. A blank space reads as "nothing wrong",
 * and the whole point of the audit is that safety is *established* rather than assumed. So an unverified run says
 * so explicitly, and says what to do about it.
 */

export interface VerdictSummaryProps {
  report: VerificationReport | null;
  /** True once a fetch has completed, so "no report" is distinguishable from "not yet asked". */
  loaded: boolean;
}

export function VerdictSummary({ report, loaded }: VerdictSummaryProps) {
  if (!report) {
    return (
      <section
        aria-labelledby="verdict-summary-heading"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-slate-300 bg-white px-5 py-3.5 shadow-sm"
      >
        <ShieldQuestion className="h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
        <h2 id="verdict-summary-heading" className="text-sm font-semibold text-slate-800">
          {loaded ? 'Not independently verified yet' : 'Checking for an audit…'}
        </h2>
        <p className="text-xs text-slate-600">
          The safety claim is not asserted until a separate engine has re-read the data and checked it. Finish a
          run, then run the audit.
        </p>
        <a
          href={hrefFor(ROUTES.report)}
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-900"
        >
          Verification
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </a>
      </section>
    );
  }

  const passed = report.verdict === VERIFICATION_VERDICT.VERIFIED_SAFE;

  return (
    <section
      aria-labelledby="verdict-summary-heading"
      className={`rounded-xl border-2 px-5 py-4 shadow-sm ${
        passed ? 'border-emerald-400 bg-emerald-50' : 'border-rose-400 bg-rose-50'
      }`}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        {passed ? (
          <ShieldCheck className="h-7 w-7 shrink-0 text-emerald-700" aria-hidden="true" />
        ) : (
          <ShieldX className="h-7 w-7 shrink-0 text-rose-700" aria-hidden="true" />
        )}

        <div className="min-w-0 flex-1">
          {/* Verdict as a word, never colour alone (R24.6). */}
          <h2
            id="verdict-summary-heading"
            className={`text-base font-bold ${passed ? 'text-emerald-900' : 'text-rose-900'}`}
          >
            {passed ? 'VERIFIED SAFE' : 'VERIFICATION FAILED'}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-700">
            {report.guaranteeStatement}
          </p>

          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-slate-600">Stale overwrites</dt>
              <dd className="font-mono font-bold tabular-nums text-slate-900">
                {report.metrics.staleOverwrites}
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-slate-600">Lost clinical updates</dt>
              <dd className="font-mono font-bold tabular-nums text-slate-900">
                {report.metrics.lostOnlineUpdates}
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-slate-600">Coverage</dt>
              <dd className="font-mono font-bold tabular-nums text-slate-900">
                {report.metrics.coveragePercent}%
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-slate-600">Stale writes blocked</dt>
              <dd className="font-mono font-bold tabular-nums text-slate-900">
                {report.metrics.staleWriteAttemptsBlocked}
              </dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-slate-600">Checks passed</dt>
              <dd className="font-mono font-bold tabular-nums text-slate-900">
                {report.checks.filter((check) => check.passed).length}/{report.checks.length}
              </dd>
            </div>
          </dl>
        </div>

        <a
          href={hrefFor(ROUTES.report)}
          className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
        >
          Full report and export
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
