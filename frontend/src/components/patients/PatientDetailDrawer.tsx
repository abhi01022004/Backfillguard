import { useEffect, useRef } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { DISCLAIMER, type PatientDetail } from '@bg/shared';
import { RiskBadge, StatusBadge } from './StatusBadges';
import { VersionHistory } from './VersionHistory';

/**
 * One patient in full: current values, the recomputed score breakdown, and the version history (R16.3).
 *
 * ## The most useful thing on this panel
 *
 * `storedScoreMatchesCurrentData`. The breakdown is recomputed live from the row's *current* clinical
 * values, so comparing it to the stored `riskScore` is a per-patient diagnostic that needs no ledger:
 * when they disagree, the stored score was derived from data that has since changed.
 *
 * That is deliberately *not* labelled as an error. It is the visible form of post-consideration drift — the
 * record was considered correctly and nothing stale was written over it; the reading is simply newer than
 * the score. Calling it a fault would misrepresent a normal, expected condition, and verification check C4
 * is what distinguishes drift from a genuine inconsistency (R11.8).
 */

const CLINICAL_ROWS = [
  { key: 'age', label: 'Age', unit: 'years', online: false },
  { key: 'bloodPressureSystolic', label: 'Systolic BP', unit: 'mmHg', online: true },
  { key: 'bloodPressureDiastolic', label: 'Diastolic BP', unit: 'mmHg', online: true },
  { key: 'heartRate', label: 'Heart rate', unit: 'bpm', online: true },
  { key: 'glucose', label: 'Glucose', unit: 'mg/dL', online: true },
] as const;

export interface PatientDetailDrawerProps {
  code: string | null;
  detail: PatientDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
}

export function PatientDetailDrawer({
  code,
  detail,
  loading,
  error,
  onClose,
  onRefresh,
}: PatientDetailDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  /**
   * Escape closes, and focus moves into the panel on open.
   *
   * A dialog that traps a keyboard user outside itself is unusable, and one that cannot be dismissed from
   * the keyboard is worse. Focus goes to the close button specifically, so the first Tab lands somewhere
   * predictable and Enter does the obvious thing (R24.6).
   */
  useEffect(() => {
    if (!code) return;

    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [code, onClose]);

  if (!code) return null;

  const drift =
    detail && detail.storedScoreMatchesCurrentData === false && detail.patient.riskScore !== null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/* Clicking away closes. Not focusable: the close button is the keyboard route out. */}
      <div
        className="absolute inset-0 bg-slate-900/30"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="patient-drawer-heading"
        className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div className="min-w-0">
            <h2
              id="patient-drawer-heading"
              className="font-mono text-lg font-semibold text-slate-900"
            >
              {code}
            </h2>
            {detail ? (
              <p className="mt-0.5 truncate text-sm text-slate-600">
                {detail.patient.name} · partition P{detail.patient.partitionIndex + 1}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              aria-label="Refresh this record"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              aria-label="Close patient detail"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        {error ? (
          <p className="px-5 py-6 text-sm text-rose-700">{error}</p>
        ) : !detail ? (
          <p className="px-5 py-6 text-sm text-slate-500">Loading record…</p>
        ) : (
          <div className="space-y-5 px-5 py-4">
            {/* --- versions and derived block --- */}
            <section aria-labelledby="drawer-versions">
              <h3
                id="drawer-versions"
                className="text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Versions
              </h3>
              <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <dt className="text-[11px] text-slate-500">Source version</dt>
                  <dd className="font-mono text-sm font-semibold tabular-nums text-slate-900">
                    v{detail.patient.version}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-500">Scored from</dt>
                  <dd className="font-mono text-sm font-semibold tabular-nums text-slate-900">
                    {detail.patient.lastBackfillVersion === null
                      ? '—'
                      : `v${detail.patient.lastBackfillVersion}`}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-500">Stored score</dt>
                  <dd className="font-mono text-sm font-semibold tabular-nums text-slate-900">
                    {detail.patient.riskScore ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-500">Level</dt>
                  <dd className="mt-0.5">
                    <RiskBadge level={detail.patient.riskLevel} />
                  </dd>
                </div>
              </dl>

              <div className="mt-2.5">
                <StatusBadge status={detail.patient.backfillStatus} />
              </div>

              {drift ? (
                <p className="mt-3 flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    The stored score ({detail.patient.riskScore}) no longer matches a recomputation from
                    this record's current values ({detail.risk?.score}). This is drift, not a fault: the
                    record was scored from v{detail.patient.lastBackfillVersion} and has since reached v
                    {detail.patient.version}. Nothing stale was written over it — the reading is simply
                    newer than the score.
                  </span>
                </p>
              ) : null}
            </section>

            {/* --- clinical values --- */}
            <section aria-labelledby="drawer-clinical">
              <h3
                id="drawer-clinical"
                className="text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Clinical values
              </h3>
              <dl className="mt-2 divide-y divide-slate-100">
                {CLINICAL_ROWS.map((row) => (
                  <div key={row.key} className="flex items-baseline justify-between gap-3 py-1.5">
                    <dt className="text-xs text-slate-600">
                      {row.label}
                      {/* Age is not in the online-updatable whitelist; saying so explains why. */}
                      {row.online ? null : (
                        <span className="ml-1.5 text-[10px] text-slate-400">not updatable online</span>
                      )}
                    </dt>
                    <dd className="font-mono text-sm tabular-nums text-slate-900">
                      {detail.patient[row.key]}
                      <span className="ml-1 text-[10px] text-slate-400">{row.unit}</span>
                    </dd>
                  </div>
                ))}
                <div className="flex items-baseline justify-between gap-3 py-1.5">
                  <dt className="text-xs text-slate-600">Diagnosis</dt>
                  <dd className="text-sm text-slate-900">
                    {detail.patient.diagnosis.replaceAll('_', ' ').toLowerCase()}
                  </dd>
                </div>
              </dl>
            </section>

            {/* --- score breakdown --- */}
            {detail.risk ? (
              <section aria-labelledby="drawer-breakdown">
                <h3
                  id="drawer-breakdown"
                  className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                >
                  Score from current values
                </h3>
                <p className="mt-1 text-[11px] text-slate-500">{detail.disclaimer}</p>

                <ul className="mt-2 space-y-1">
                  {detail.risk.breakdown.map((factor) => (
                    <li
                      key={factor.factor}
                      className="flex items-baseline justify-between gap-3 rounded bg-slate-50 px-2.5 py-1.5"
                    >
                      <span className="text-xs text-slate-700">
                        {factor.factor}
                        <span className="ml-1.5 text-[10px] text-slate-500">
                          {factor.band} · {factor.inputSummary}
                        </span>
                      </span>
                      <span className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                        +{factor.points}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="mt-2 flex items-baseline justify-between border-t border-slate-200 pt-2 text-sm">
                  <span className="font-medium text-slate-700">
                    Recomputed total
                    <span className="ml-1.5 font-mono text-[10px] text-slate-400">
                      {detail.risk.configVersion}
                    </span>
                  </span>
                  <span className="font-mono font-semibold tabular-nums text-slate-900">
                    {detail.risk.score} ({detail.risk.level})
                  </span>
                </p>
              </section>
            ) : null}

            {/* --- history --- */}
            <section aria-labelledby="drawer-history">
              <h3
                id="drawer-history"
                className="text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Version history
              </h3>
              <p className="mt-1 text-[11px] text-slate-500">
                Merged from the online-update log, the write ledger, the conflict table and the
                consideration ledger — four independent records, in chronological order.
              </p>
              <div className="mt-3">
                <VersionHistory history={detail.history} />
              </div>
            </section>

            <p className="border-t border-slate-100 pt-3 text-[11px] text-slate-400">
              {DISCLAIMER.LONG}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
