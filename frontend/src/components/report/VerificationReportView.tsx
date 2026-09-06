import {
  CheckCircle2,
  Download,
  Loader2,
  MessageCircle,
  Printer,
  ShieldCheck,
  ShieldX,
  XCircle,
} from 'lucide-react';
import {
  DISCLAIMER,
  VERIFICATION_VERDICT,
  type NotificationAdvisory,
  type VerificationCheckResult,
  type VerificationMetrics,
  type VerificationReport,
} from '@bg/shared';

/**
 * The independent verification report (R20).
 *
 * ## What makes this an audit rather than a summary
 *
 * Every number here is produced by re-reading persisted state and recomputing. The verification engine
 * receives repositories only — never the orchestrator, never a counter — so the thing that did the writing does
 * not grade its own work. Each check therefore carries its *method* alongside its result, because a check
 * whose independence you cannot inspect is just an assertion with a tick next to it.
 *
 * ## Why nothing renders before the audit has run
 *
 * A report with zeroes in it looks like a passed audit. Until verification has actually run there is no report,
 * and the page says exactly that and offers to run one (R20.7).
 */

interface MetricRow {
  key: keyof VerificationMetrics;
  label: string;
  /** Non-null when the value has a required outcome. */
  mustBe?: number;
  suffix?: string;
  note?: string;
}

/** The safety block: every one of these must be zero for the verdict to be VERIFIED_SAFE. */
const SAFETY_ROWS: readonly MetricRow[] = [
  {
    key: 'staleOverwrites',
    label: 'Stale overwrites',
    mustBe: 0,
    note: 'Measured from the write ledger: applied writes whose guard version was below the row version.',
  },
  {
    key: 'lostOnlineUpdates',
    label: 'Lost clinical updates',
    mustBe: 0,
    note: 'Values written by a clinician and later clobbered by older backfill data.',
  },
  {
    key: 'missedRecords',
    label: 'Records never considered',
    mustBe: 0,
    note: 'Set difference between all patient ids and the consideration ledger.',
  },
  {
    key: 'inconsistentRecords',
    label: 'Rows inconsistent with their own data',
    mustBe: 0,
    note: 'Stored score recomputed from current values and compared.',
  },
];

/** Activity: these describe what happened, and none of them has a "correct" value. */
const ACTIVITY_ROWS: readonly MetricRow[] = [
  { key: 'eligibleRecords', label: 'Eligible records' },
  { key: 'consideredRecords', label: 'Records considered' },
  { key: 'coveragePercent', label: 'Coverage', suffix: '%' },
  { key: 'conflicts', label: 'Version conflicts detected' },
  { key: 'reevaluated', label: 'Conflicts resolved by re-evaluation' },
  {
    key: 'staleWriteAttemptsBlocked',
    label: 'Stale writes blocked',
    note: 'The guard firing. Zero here would mean the safety mechanism was never exercised.',
  },
  { key: 'protectedUpdates', label: 'Clinical updates protected' },
  {
    key: 'postConsiderationDrift',
    label: 'Post-consideration drift',
    note: 'Records updated after their own consideration. Not a violation: the record was considered and nothing stale was written over it, the score is simply older than the newest reading.',
  },
];

function CheckRow({ check }: { check: VerificationCheckResult }) {
  const Icon = check.passed ? CheckCircle2 : XCircle;

  return (
    <li
      className={`rounded-lg border p-3.5 ${
        check.passed ? 'border-emerald-200 bg-emerald-50/40' : 'border-rose-300 bg-rose-50/60'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${check.passed ? 'text-emerald-700' : 'text-rose-700'}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h4 className="text-sm font-semibold text-slate-900">{check.title}</h4>
            <span className="font-mono text-[10px] text-slate-500">{check.id}</span>
            {/* Outcome as a word, not only as an icon and a colour. */}
            <span
              className={`ml-auto text-[11px] font-bold uppercase ${
                check.passed ? 'text-emerald-800' : 'text-rose-800'
              }`}
            >
              {check.passed ? 'pass' : 'fail'}
            </span>
          </div>

          <p className="mt-1 text-xs text-slate-700">{check.detail}</p>

          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            <span className="font-medium">Method: </span>
            {check.method}
          </p>

          {check.offendingPatientCodes.length > 0 ? (
            <div className="mt-2">
              {/* Naming the records is what makes a failure actionable rather than just a red number. */}
              <p className="text-[11px] font-medium text-rose-900">
                Offending records ({check.offendingPatientCodes.length}):
              </p>
              <p className="mt-0.5 break-words font-mono text-[11px] text-rose-800">
                {check.offendingPatientCodes.slice(0, 25).join(', ')}
                {check.offendingPatientCodes.length > 25
                  ? ` … and ${check.offendingPatientCodes.length - 25} more`
                  : ''}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function MetricTable({
  rows,
  metrics,
  title,
  description,
}: {
  rows: readonly MetricRow[];
  metrics: VerificationMetrics;
  title: string;
  description: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-0.5 text-xs text-slate-500">{description}</p>

      <table className="mt-2 w-full text-left text-sm">
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const value = metrics[row.key] as number;
            const violated = row.mustBe !== undefined && value !== row.mustBe;

            return (
              <tr key={row.key}>
                <th scope="row" className="py-2 pr-3 font-normal align-top">
                  <span className="text-slate-700">{row.label}</span>
                  {row.mustBe !== undefined ? (
                    <span className="ml-1.5 font-mono text-[10px] text-slate-500">
                      must be {row.mustBe}
                    </span>
                  ) : null}
                  {row.note ? (
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">
                      {row.note}
                    </span>
                  ) : null}
                </th>
                <td
                  className={`py-2 text-right align-top font-mono font-semibold tabular-nums ${
                    violated ? 'text-rose-700' : 'text-slate-900'
                  }`}
                >
                  {value.toLocaleString('en-GB')}
                  {row.suffix ?? ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface VerificationReportViewProps {
  report: VerificationReport | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Runs the audit. Disabled with a reason when the job has not settled. */
  onVerify: () => void;
  verifyDisabledReason: string | null;
  verifyBusy: boolean;
}

/**
 * The notification advisory, rendered as explicitly **not** part of the verdict.
 *
 * The visual language is deliberately different from the checks above: no pass/fail icon in the heading, a
 * neutral border, and a sentence saying in plain words that nothing here changes the verdict. A reader
 * skimming the page should not be able to mistake an advisory anomaly for a data-safety failure — the whole
 * reason this is a separate section rather than a seventh check.
 *
 * The two must-be-zero figures are still highlighted when non-zero, because a defect that is reported quietly
 * may as well not be reported.
 */
function NotificationAdvisorySection({ advisory }: { advisory: NotificationAdvisory }) {
  return (
    <section
      aria-labelledby="advisory-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id="advisory-heading" className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <MessageCircle className="h-4 w-4 text-slate-500" aria-hidden="true" />
            Risk alerts — advisory
          </h2>
          <p className="mt-1.5 text-sm text-slate-600">
            Observations about the run&rsquo;s outbound notifications.{' '}
            <span className="font-medium text-slate-800">
              None of this affects the verdict above.
            </span>{' '}
            The verdict is a statement about patient data; a fault in a messaging simulator is a different kind
            of problem and should not be able to make a provably correct migration look unsafe.
          </p>
        </div>

        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
            advisory.clean ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
          }`}
        >
          {advisory.clean ? 'no anomalies' : 'anomaly found'}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <AdvisoryFigure label="Alerts sent" value={advisory.sent} />
        <AdvisoryFigure
          label="Stale alerts prevented"
          value={advisory.cancelled}
          note="the guard refused the write before the alert could go out"
        />
        <AdvisoryFigure
          label="Still queued at end"
          value={advisory.queuedAtEnd}
          alarming={advisory.queuedAtEnd > 0}
          note="should be zero: every staged alert should have been sent or cancelled"
        />
        <AdvisoryFigure
          label="Sent without a committed write"
          value={advisory.staleNotifications}
          alarming={advisory.staleNotifications > 0}
          note="must be zero"
        />
        <AdvisoryFigure
          label="Duplicate alerts"
          value={advisory.duplicateNotifications}
          alarming={advisory.duplicateNotifications > 0}
          note="must be zero"
        />
        <AdvisoryFigure
          label="Provider failures"
          value={advisory.failed}
          alarming={advisory.failed > 0}
        />
      </dl>

      <p className="mt-4 border-t border-slate-100 pt-3 text-xs leading-relaxed text-slate-500">
        <span className="font-medium text-slate-600">Method:</span> {advisory.method}
      </p>

      {advisory.offendingPatientCodes.length > 0 ? (
        <p className="mt-2 text-xs text-amber-900">
          <span className="font-medium">Records involved:</span>{' '}
          <span className="font-mono">{advisory.offendingPatientCodes.join(', ')}</span>
        </p>
      ) : null}
    </section>
  );
}

function AdvisoryFigure({
  label,
  value,
  note,
  alarming = false,
}: {
  label: string;
  value: number;
  note?: string;
  alarming?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${alarming ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={`mt-1 text-xl font-semibold tabular-nums ${
          alarming ? 'text-amber-800' : 'text-slate-900'
        }`}
      >
        {value.toLocaleString('en-GB')}
      </dd>
      {note ? <p className="mt-0.5 text-[11px] text-slate-500">{note}</p> : null}
    </div>
  );
}

export function VerificationReportView({
  report,
  loading,
  loaded,
  error,
  onVerify,
  verifyDisabledReason,
  verifyBusy,
}: VerificationReportViewProps) {
  const passed = report?.verdict === VERIFICATION_VERDICT.VERIFIED_SAFE;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="text-lg font-semibold text-slate-900">Independent verification</h1>
            <p className="mt-1.5 text-sm text-slate-600">
              A separate engine re-reads the database and the ledgers and recomputes every number below. It
              receives no counter from the backfill — repositories only — so the code that did the writing does
              not grade its own work. Each check states its method so its independence can be inspected rather
              than taken on trust.
            </p>
          </div>

          {/* Actions are hidden from print: a paper copy of a button is noise. */}
          <div className="flex shrink-0 flex-wrap gap-2 print:hidden">
            <button
              type="button"
              onClick={onVerify}
              disabled={verifyDisabledReason !== null || verifyBusy}
              title={verifyDisabledReason ?? 'Run the independent audit'}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white ring-1 ring-brand-700 hover:enabled:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:ring-slate-300"
            >
              {verifyBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              )}
              {report ? 'Re-run audit' : 'Run audit'}
            </button>

            {report ? (
              <>
                {/**
                 * A plain link, not a fetch-and-blob.
                 *
                 * The server already sets `Content-Disposition: attachment` with a filename naming the job and
                 * the verdict, so the browser handles the download natively. Recreating that client-side would
                 * add code, lose the server's filename, and hold the whole report in memory for no benefit.
                 */}
                <a
                  href="/api/verify/latest/export.json"
                  className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Export JSON
                </a>

                {/**
                 * Print rather than a generated PDF.
                 *
                 * `window.print()` plus a print stylesheet produces a PDF through the browser's own dialogue,
                 * with correct fonts and no extra dependency. Bundling a PDF library or a headless browser to
                 * do the same thing would add tens of megabytes and a second rendering path to keep in step
                 * with this one.
                 */}
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="inline-flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
                >
                  <Printer className="h-4 w-4" aria-hidden="true" />
                  Print / save PDF
                </button>
              </>
            ) : null}
          </div>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
      </section>

      {!report ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-8 text-center">
          <p className="text-sm font-medium text-slate-700">
            {loading && !loaded ? 'Checking for a report…' : 'Verification has not been run for this job.'}
          </p>
          <p className="mx-auto mt-1.5 max-w-xl text-xs text-slate-500">
            Nothing is shown until the audit has actually run. A report full of zeroes would look exactly like a
            passed audit, which is the one thing this page must never do. Finish a backfill, then run the audit.
          </p>
          {verifyDisabledReason ? (
            <p className="mt-3 text-xs text-slate-500">{verifyDisabledReason}</p>
          ) : null}
        </section>
      ) : (
        <>
          {/* --- verdict --- */}
          <section
            aria-labelledby="verdict-heading"
            className={`rounded-xl border-2 p-5 ${
              passed ? 'border-emerald-400 bg-emerald-50' : 'border-rose-400 bg-rose-50'
            }`}
          >
            <div className="flex flex-wrap items-start gap-4">
              {passed ? (
                <ShieldCheck className="h-10 w-10 shrink-0 text-emerald-700" aria-hidden="true" />
              ) : (
                <ShieldX className="h-10 w-10 shrink-0 text-rose-700" aria-hidden="true" />
              )}

              <div className="min-w-0 flex-1">
                <h2
                  id="verdict-heading"
                  className={`text-xl font-bold ${passed ? 'text-emerald-900' : 'text-rose-900'}`}
                >
                  {passed ? 'VERIFIED SAFE' : 'VERIFICATION FAILED'}
                </h2>

                <p className="mt-1.5 text-sm leading-relaxed text-slate-700">
                  {report.guaranteeStatement}
                </p>

                <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-slate-500">Job</dt>
                    <dd className="font-mono font-medium text-slate-800">{report.jobId}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Mode</dt>
                    <dd className="font-medium text-slate-800">{report.mode}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Seed</dt>
                    <dd className="font-mono font-medium tabular-nums text-slate-800">{report.seed}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Run duration</dt>
                    <dd className="font-mono font-medium tabular-nums text-slate-800">
                      {report.durationMs === null
                        ? '—'
                        : `${(report.durationMs / 1000).toFixed(1)}s`}
                    </dd>
                  </div>
                </dl>

                <p className="mt-2 text-xs text-slate-500">
                  {report.datasetDescription} · audited{' '}
                  {new Date(report.verifiedAt).toLocaleString('en-GB', { hour12: false })}
                </p>
              </div>
            </div>
          </section>

          {/* --- checks --- */}
          <section
            aria-labelledby="checks-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h2 id="checks-heading" className="text-base font-semibold text-slate-900">
              Independent checks
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {report.checks.filter((check) => check.passed).length} of {report.checks.length} passed. Each is
              computed from persisted evidence, not from an engine counter.
            </p>

            <ul className="mt-3 space-y-2">
              {report.checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          </section>

          {/* --- metrics --- */}
          <section
            aria-labelledby="report-metrics-heading"
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h2 id="report-metrics-heading" className="text-base font-semibold text-slate-900">
              Audited metrics
            </h2>

            <div className="mt-3 grid gap-6 lg:grid-cols-2">
              <MetricTable
                title="Safety"
                description="Every one of these must be zero for the verdict to be VERIFIED SAFE."
                rows={SAFETY_ROWS}
                metrics={report.metrics}
              />
              <MetricTable
                title="Activity"
                description="What actually happened during the run. None of these has a single correct value."
                rows={ACTIVITY_ROWS}
                metrics={report.metrics}
              />
            </div>
          </section>

          {report.advisory ? (
            <NotificationAdvisorySection advisory={report.advisory.notifications} />
          ) : null}

          <p className="pb-2 text-xs leading-relaxed text-slate-500">{DISCLAIMER.LONG}</p>
        </>
      )}
    </div>
  );
}
