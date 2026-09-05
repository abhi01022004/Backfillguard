import { GitCompareArrows, Loader2, Play } from 'lucide-react';
import type { VerificationMetrics } from '@bg/shared';
import type { ComparisonScenario, ComparisonState } from '../../hooks/useComparison';
import { StaleOverwriteCallout } from './StaleOverwriteCallout';

/**
 * Naive backfill versus BackfillGuard, side by side (R12.3, R12.4).
 *
 * ## What the comparison isolates
 *
 * Both engines run the same fixed scenario over identical freshly generated datasets and receive the same
 * sequence of external events. They differ in exactly one respect: how they write. So a difference in outcome
 * is attributable to the write strategy and nothing else.
 *
 * ## The row that matters most, and the one that surprises people
 *
 * `staleOverwrites` is the headline. But note `inconsistentRecords`: the naive engine scores **zero** there,
 * the same as the guarded one. That is not a mistake in the comparison — the naive engine reverts the clinical
 * value and then rescores *from the reverted value*, so the row ends internally consistent. Its score matches
 * its data; both are simply wrong. A consistency check alone would pass this run, which is precisely why
 * safety has to be measured against the write ledger rather than inferred from the final row.
 */

interface MetricRow {
  key: keyof VerificationMetrics;
  label: string;
  /** How to read a difference between the two columns. */
  interpretation: string;
  /** True when a higher number is worse. */
  lowerIsBetter: boolean;
  headline?: boolean;
}

const ROWS: readonly MetricRow[] = [
  {
    key: 'staleOverwrites',
    label: 'Stale overwrites',
    interpretation: 'Writes that landed carrying data older than the row. Must be zero.',
    lowerIsBetter: true,
    headline: true,
  },
  {
    key: 'lostOnlineUpdates',
    label: 'Lost clinical updates',
    interpretation: 'Values a clinician wrote that were later clobbered by older backfill data.',
    lowerIsBetter: true,
    headline: true,
  },
  {
    key: 'coveragePercent',
    label: 'Coverage',
    interpretation: 'Both engines reach 100%, so the comparison isolates safety rather than liveness.',
    lowerIsBetter: false,
  },
  {
    key: 'conflicts',
    label: 'Conflicts detected',
    interpretation: 'The naive engine detects none because it never checks.',
    lowerIsBetter: false,
  },
  {
    key: 'staleWriteAttemptsBlocked',
    label: 'Stale writes blocked',
    interpretation: 'The guard firing. Zero on the naive side because there is no guard.',
    lowerIsBetter: false,
  },
  {
    key: 'reevaluated',
    label: 'Re-evaluated',
    interpretation: 'Records recomputed from current data after a refused write.',
    lowerIsBetter: false,
  },
  {
    key: 'inconsistentRecords',
    label: 'Internally inconsistent rows',
    interpretation:
      'Zero for both — the naive engine rescores from the value it reverted to, so the row agrees with itself while being wrong.',
    lowerIsBetter: true,
  },
];

function formatMetric(row: MetricRow, metrics: VerificationMetrics): string {
  const value = metrics[row.key];
  if (row.key === 'coveragePercent') return `${value}%`;
  return typeof value === 'number' ? value.toLocaleString('en-GB') : String(value);
}

export interface ComparisonViewProps {
  state: ComparisonState;
  scenario: ComparisonScenario;
  onScenarioChange: (scenario: ComparisonScenario) => void;
}

export function ComparisonView({ state, scenario, onScenarioChange }: ComparisonViewProps) {
  const { result, running, loaded, error } = state;

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <GitCompareArrows className="h-5 w-5 text-brand-600" aria-hidden="true" />
              Naive backfill versus BackfillGuard
            </h1>
            <p className="mt-1.5 text-sm text-slate-600">
              Both engines run the same fixed scenario over identical freshly generated datasets and receive the
              same external events. They differ in exactly one respect: whether a write carries a version
              predicate. Every run happens in memory, so the unsafe engine can never touch the demo data.
            </p>
          </div>

          <div className="flex shrink-0 flex-col gap-2">
            <fieldset>
              <legend className="text-[11px] font-medium text-slate-600">Scenario</legend>
              <div className="mt-1 flex gap-1 rounded-lg bg-slate-100 p-0.5">
                {(['contended', 'control'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onScenarioChange(option)}
                    aria-pressed={scenario === option}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                      scenario === option
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {option === 'contended' ? 'With contention' : 'Control (no contention)'}
                  </button>
                ))}
              </div>
            </fieldset>

            <button
              type="button"
              onClick={() => void state.run(scenario)}
              disabled={running}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white ring-1 ring-brand-700 hover:enabled:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 disabled:ring-slate-300"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4" aria-hidden="true" />
              )}
              {running ? 'Running both engines…' : 'Run comparison'}
            </button>
          </div>
        </div>

        {/**
         * The control scenario needs explaining before it is run, not after.
         *
         * "Was the naive engine just written to fail?" is the first fair question anyone asks, and this is the
         * answer — so it is worth stating plainly rather than leaving someone to infer it from two identical
         * columns.
         */}
        {scenario === 'control' ? (
          <p className="mt-3 rounded-lg bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600 ring-1 ring-slate-200">
            The control runs the same crash and recovery with <span className="font-medium">no</span> clinical
            updates during the outage. Both engines should agree exactly. That is the point: the naive engine is
            not broken in general, only when something changes underneath it — which is the condition the guard
            exists for.
          </p>
        ) : null}

        {error ? <p className="mt-3 text-sm text-rose-700">{error}</p> : null}
      </section>

      {!result ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-8 text-center">
          <p className="text-sm text-slate-600">
            {loaded ? 'No comparison has been run yet.' : 'Checking for a previous comparison…'}
          </p>
          <p className="mx-auto mt-1.5 max-w-xl text-xs text-slate-500">
            Nothing is shown until both engines have actually run. Pre-filled columns would be a claim about a
            measurement nobody took.
          </p>
        </section>
      ) : (
        <>
          <StaleOverwriteCallout spotlight={result.spotlight} />

          <section
            aria-labelledby="metrics-heading"
            className="rounded-xl border border-slate-200 bg-white shadow-sm"
          >
            <div className="border-b border-slate-100 px-5 py-3.5">
              <h2 id="metrics-heading" className="text-base font-semibold text-slate-900">
                Audited metrics, both engines
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Scenario <span className="font-mono">{result.scenarioName}</span> · seed{' '}
                <span className="font-mono tabular-nums">{result.seed}</span> · run{' '}
                {new Date(result.ranAt).toLocaleTimeString('en-GB', { hour12: false })}. Each column is produced
                by the same independent verification engine reading that run's own persisted state.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">
                  Verification metrics for the naive engine and BackfillGuard on the same scenario.
                </caption>
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-semibold">
                      Metric
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-semibold">
                      {result.naive.label}
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-semibold">
                      {result.guarded.label}
                    </th>
                    <th scope="col" className="px-4 py-2 font-semibold">
                      How to read it
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ROWS.map((row) => {
                    const naiveValue = result.naive.metrics[row.key] as number;
                    const guardedValue = result.guarded.metrics[row.key] as number;
                    const naiveWorse = row.lowerIsBetter
                      ? naiveValue > guardedValue
                      : naiveValue < guardedValue;

                    return (
                      <tr key={row.key} className={row.headline ? 'bg-slate-50/60' : ''}>
                        <th
                          scope="row"
                          className={`px-4 py-2 font-normal ${
                            row.headline ? 'font-semibold text-slate-900' : 'text-slate-700'
                          }`}
                        >
                          {row.label}
                        </th>
                        <td
                          className={`px-4 py-2 text-right font-mono tabular-nums ${
                            naiveWorse ? 'font-bold text-rose-700' : 'text-slate-700'
                          }`}
                        >
                          {formatMetric(row, result.naive.metrics)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-emerald-700">
                          {formatMetric(row, result.guarded.metrics)}
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-500">{row.interpretation}</td>
                      </tr>
                    );
                  })}

                  <tr className="bg-slate-50">
                    <th scope="row" className="px-4 py-2.5 font-semibold text-slate-900">
                      Verdict
                    </th>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${
                          result.naive.verdict === 'VERIFIED_SAFE'
                            ? 'bg-emerald-50 text-emerald-800 ring-emerald-300'
                            : 'bg-rose-50 text-rose-900 ring-rose-400'
                        }`}
                      >
                        {result.naive.verdict.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 ${
                          result.guarded.verdict === 'VERIFIED_SAFE'
                            ? 'bg-emerald-50 text-emerald-800 ring-emerald-300'
                            : 'bg-rose-50 text-rose-900 ring-rose-400'
                        }`}
                      >
                        {result.guarded.verdict.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      Both graded by the same audit, from each run's own stored evidence.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {result.scenarioDescription ? (
              <p className="border-t border-slate-100 px-5 py-3 text-xs leading-relaxed text-slate-500">
                {result.scenarioDescription}
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
