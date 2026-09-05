import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import {
  BACKFILL_STATUS,
  RISK_LEVEL,
  SIMULATION_BOUNDS,
  type BackfillStatus,
  type Patient,
  type RiskLevel,
} from '@bg/shared';
import { EMPTY_FILTERS, type PatientFilters, type PatientsState } from '../../hooks/usePatients';
import { RiskBadge, StatusBadge, STATUS_LABEL } from './StatusBadges';

/**
 * The patient list (R16.1, R16.2).
 *
 * ## Why `lastBackfillVersion` gets its own column
 *
 * It looks like internal bookkeeping and it is the single most informative column on the table. `version`
 * is the source data's version; `lastBackfillVersion` is the version the stored score was derived from.
 * When they match, that row's derived block is current. When they differ, the score is older than the data
 * — which is the entire subject of this project, visible per record without opening anything.
 *
 * The pairing is rendered as `v3 / v3` rather than as two separate columns precisely so the comparison is
 * the thing the eye does first.
 */

const STATUS_OPTIONS = Object.values(BACKFILL_STATUS);
const RISK_OPTIONS = Object.values(RISK_LEVEL);

export interface PatientTableProps {
  state: PatientsState;
  filters: PatientFilters;
  onFiltersChange: (filters: PatientFilters) => void;
  /** Number of partitions in the current dataset, for the partition filter. */
  partitionCount?: number;
  onSelect: (patientCode: string) => void;
  selectedCode?: string | null;
}

function VersionPair({ patient }: { patient: Patient }) {
  const scored = patient.lastBackfillVersion;
  const current = patient.version;

  if (scored === null) {
    return (
      <span className="font-mono text-xs tabular-nums text-slate-500" title="Never scored">
        v{current} / —
      </span>
    );
  }

  const behind = scored < current;

  return (
    <span
      className={`font-mono text-xs tabular-nums ${behind ? 'font-semibold text-amber-800' : 'text-slate-600'}`}
      title={
        behind
          ? `Score derived from v${scored}, source data has reached v${current}: the score is older than the data.`
          : `Score derived from the current source version (v${current}).`
      }
    >
      v{current} / v{scored}
    </span>
  );
}

export function PatientTable({
  state,
  filters,
  onFiltersChange,
  partitionCount = SIMULATION_BOUNDS.partitionCount.default,
  onSelect,
  selectedCode = null,
}: PatientTableProps) {
  const hasFilters =
    filters.status !== '' ||
    filters.riskLevel !== '' ||
    filters.partitionIndex !== '' ||
    filters.q.trim() !== '';

  const from = state.total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const to = Math.min(state.page * state.pageSize, state.total);

  return (
    <section
      aria-labelledby="patients-heading"
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-5 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="patients-heading" className="text-base font-semibold text-slate-900">
            Patient records
          </h2>

          <div className="flex items-center gap-2">
            {state.fetchedAt ? (
              // Staleness made visible: the list refreshes on run lifecycle events, not per record write.
              <span className="text-[11px] text-slate-500">
                loaded {new Date(state.fetchedAt).toLocaleTimeString('en-GB', { hour12: false })}
              </span>
            ) : null}
            <button
              type="button"
              onClick={state.refetch}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${state.loading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              Refresh
            </button>
          </div>
        </div>

        {/* --- filters (R16.2) --- */}
        <div className="mt-3 flex flex-wrap items-end gap-2.5">
          <div className="min-w-[13rem] flex-1">
            <label
              htmlFor="patient-search"
              className="block text-[11px] font-medium text-slate-600"
            >
              Search
            </label>
            <div className="relative mt-0.5">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
                aria-hidden="true"
              />
              <input
                id="patient-search"
                type="search"
                value={filters.q}
                onChange={(event) => onFiltersChange({ ...filters, q: event.target.value })}
                placeholder="Patient code or name"
                maxLength={64}
                className="w-full rounded-md border border-slate-300 py-1 pl-8 pr-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="filter-status" className="block text-[11px] font-medium text-slate-600">
              Status
            </label>
            <select
              id="filter-status"
              value={filters.status}
              onChange={(event) =>
                onFiltersChange({ ...filters, status: event.target.value as BackfillStatus | '' })
              }
              className="mt-0.5 rounded-md border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">Any status</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-risk" className="block text-[11px] font-medium text-slate-600">
              Risk level
            </label>
            <select
              id="filter-risk"
              value={filters.riskLevel}
              onChange={(event) =>
                onFiltersChange({ ...filters, riskLevel: event.target.value as RiskLevel | '' })
              }
              className="mt-0.5 rounded-md border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">Any level</option>
              {RISK_OPTIONS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="filter-partition"
              className="block text-[11px] font-medium text-slate-600"
            >
              Partition
            </label>
            <select
              id="filter-partition"
              value={filters.partitionIndex === '' ? '' : String(filters.partitionIndex)}
              onChange={(event) =>
                onFiltersChange({
                  ...filters,
                  partitionIndex: event.target.value === '' ? '' : Number(event.target.value),
                })
              }
              className="mt-0.5 rounded-md border border-slate-300 px-2 py-1 text-sm"
            >
              <option value="">All partitions</option>
              {Array.from({ length: partitionCount }, (_, index) => (
                <option key={index} value={index}>
                  P{index + 1}
                </option>
              ))}
            </select>
          </div>

          {hasFilters ? (
            <button
              type="button"
              onClick={() => onFiltersChange(EMPTY_FILTERS)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {state.error ? (
        <p className="px-5 py-8 text-sm text-rose-700">{state.error}</p>
      ) : state.patients.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-slate-500">
          {state.loading
            ? 'Loading records…'
            : hasFilters
              ? 'No records match these filters.'
              : 'No patient records. Seed the dataset to generate the synthetic cohort.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Synthetic patient records with their source version, the version their risk score was derived
              from, and their backfill status.
            </caption>
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Code
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Part.
                </th>
                <th scope="col" className="px-4 py-2 font-semibold" title="source version / scored from">
                  Version / scored
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Score
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Level
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {state.patients.map((patient) => (
                <tr
                  key={patient.id}
                  className={`cursor-pointer hover:bg-brand-50/50 ${
                    patient.patientCode === selectedCode ? 'bg-brand-50' : ''
                  }`}
                  onClick={() => onSelect(patient.patientCode)}
                >
                  <th scope="row" className="px-4 py-2 font-normal">
                    {/**
                     * The button is what carries the interaction for keyboard and assistive tech. The row's
                     * click handler is a convenience for pointer users, not the accessible path — a
                     * clickable `<tr>` alone would be unreachable without a mouse.
                     */}
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(patient.patientCode);
                      }}
                      className="rounded font-mono text-xs font-semibold text-brand-700 underline decoration-dotted underline-offset-2 hover:text-brand-900"
                    >
                      {patient.patientCode}
                    </button>
                  </th>
                  <td className="max-w-[14rem] truncate px-4 py-2 text-slate-700">{patient.name}</td>
                  <td className="px-4 py-2 text-xs tabular-nums text-slate-500">
                    P{patient.partitionIndex + 1}
                  </td>
                  <td className="px-4 py-2">
                    <VersionPair patient={patient} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs tabular-nums text-slate-900">
                    {patient.riskScore ?? '—'}
                  </td>
                  <td className="px-4 py-2">
                    <RiskBadge level={patient.riskLevel} />
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={patient.backfillStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-2.5">
          <p className="text-xs text-slate-500 tabular-nums">
            {from}–{to} of {state.total.toLocaleString('en-GB')}
          </p>

          <nav className="flex items-center gap-1" aria-label="Patient list pages">
            <button
              type="button"
              onClick={() => state.setPage(state.page - 1)}
              disabled={state.page <= 1}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 hover:enabled:bg-slate-50"
            >
              <ChevronLeft className="h-3 w-3" aria-hidden="true" />
              Previous
            </button>
            <span className="px-2 text-xs tabular-nums text-slate-600">
              Page {state.page} of {state.totalPages}
            </span>
            <button
              type="button"
              onClick={() => state.setPage(state.page + 1)}
              disabled={state.page >= state.totalPages}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 hover:enabled:bg-slate-50"
            >
              Next
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            </button>
          </nav>
        </div>
      ) : null}
    </section>
  );
}
