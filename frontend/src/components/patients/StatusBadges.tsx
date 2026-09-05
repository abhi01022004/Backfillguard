import {
  BACKFILL_STATUS,
  RISK_LEVEL,
  type BackfillStatus,
  type RiskLevel,
} from '@bg/shared';

/**
 * Risk-level and backfill-status pills.
 *
 * Shared between the table, the drawer and the conflict views so a status always looks the same. Both use
 * text plus colour rather than colour alone (R24.6).
 */

const RISK_CLASS: Record<RiskLevel, string> = {
  [RISK_LEVEL.LOW]: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  [RISK_LEVEL.MEDIUM]: 'bg-amber-50 text-amber-900 ring-amber-300',
  [RISK_LEVEL.HIGH]: 'bg-rose-50 text-rose-900 ring-rose-300',
};

export function RiskBadge({ level }: { level: RiskLevel | null }) {
  // Null is "never scored", which is a real state and not a missing value to be styled as LOW.
  if (!level) {
    return (
      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-300">
        not scored
      </span>
    );
  }

  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${RISK_CLASS[level]}`}
    >
      {level}
    </span>
  );
}

/**
 * Status presentation.
 *
 * `PROTECTED` is worth a second look: it means a stale write was blocked here and the record is mid
 * re-evaluation. It is a transient state — surviving as a terminal status is a verification failure (check
 * C6) — so it is styled as attention-worthy rather than as a success.
 */
const STATUS_CLASS: Record<BackfillStatus, string> = {
  [BACKFILL_STATUS.PENDING]: 'bg-slate-100 text-slate-600 ring-slate-300',
  [BACKFILL_STATUS.PROCESSING]: 'bg-brand-50 text-brand-800 ring-brand-300',
  [BACKFILL_STATUS.COMPLETED]: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  [BACKFILL_STATUS.CONFLICT]: 'bg-amber-50 text-amber-900 ring-amber-300',
  [BACKFILL_STATUS.REEVALUATED]: 'bg-emerald-50 text-emerald-900 ring-emerald-400',
  [BACKFILL_STATUS.PROTECTED]: 'bg-amber-100 text-amber-900 ring-amber-400',
  [BACKFILL_STATUS.FAILED]: 'bg-rose-50 text-rose-900 ring-rose-400',
};

const STATUS_LABEL: Record<BackfillStatus, string> = {
  [BACKFILL_STATUS.PENDING]: 'Pending',
  [BACKFILL_STATUS.PROCESSING]: 'Processing',
  [BACKFILL_STATUS.COMPLETED]: 'Completed',
  [BACKFILL_STATUS.CONFLICT]: 'Conflict',
  [BACKFILL_STATUS.REEVALUATED]: 'Re-evaluated',
  [BACKFILL_STATUS.PROTECTED]: 'Protected',
  [BACKFILL_STATUS.FAILED]: 'Failed',
};

export function StatusBadge({ status }: { status: BackfillStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export { STATUS_LABEL };
