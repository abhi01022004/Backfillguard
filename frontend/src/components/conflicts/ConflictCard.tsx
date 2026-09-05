import { ArrowRight, ShieldCheck, ShieldX, Clock } from 'lucide-react';
import { CONFLICT_RESOLUTION, type ConflictRecord } from '@bg/shared';

/**
 * One detected version conflict, and what happened to it (R10.1–R10.5).
 *
 * ## What this card has to prove
 *
 * A conflict count on its own is just a number. This card is where the claim becomes checkable, so it shows
 * the four facts a sceptic would ask for:
 *
 *  - the version the backfill computed from, and the version the row had actually reached
 *  - which clinical field moved in between, with both values
 *  - the score that was computed from the stale data and refused
 *  - the score computed after re-reading, and whether that changed the risk band
 *
 * ## Why the stale-overwrite line is stated explicitly
 *
 * `Stale overwrite: PREVENTED` is the headline of the whole project, and a viewer should not have to infer
 * it from two version numbers. Note it says PREVENTED only when the conflict was actually resolved by
 * recomputation. An unresolved conflict is not a prevented overwrite — nothing was written at all, which is
 * safe but is a different statement, and conflating the two would overclaim.
 */

/** Risk banding, duplicated from the backend config so a rejected score can be labelled. */
function levelOf(score: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (score <= 30) return 'LOW';
  if (score <= 60) return 'MEDIUM';
  return 'HIGH';
}

const LEVEL_CLASS: Record<'LOW' | 'MEDIUM' | 'HIGH', string> = {
  LOW: 'text-emerald-700',
  MEDIUM: 'text-amber-700',
  HIGH: 'text-rose-700',
};

function VersionPill({ label, version, tone }: { label: string; version: number; tone: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1 rounded-md px-2 py-0.5 text-xs ${tone}`}>
      <span className="opacity-70">{label}</span>
      <span className="font-mono font-semibold tabular-nums">v{version}</span>
    </span>
  );
}

export interface ConflictCardProps {
  conflict: ConflictRecord;
  /** Opens the patient detail view. Omitted where there is nowhere to navigate to. */
  onSelectPatient?: (patientCode: string) => void;
}

export function ConflictCard({ conflict, onSelectPatient }: ConflictCardProps) {
  const resolved = conflict.resolution === CONFLICT_RESOLUTION.REEVALUATED;
  const failed = conflict.resolution === CONFLICT_RESOLUTION.FAILED;
  const pending = conflict.resolution === CONFLICT_RESOLUTION.PENDING;

  const oldLevel = levelOf(conflict.oldScore);
  const newLevel = conflict.newScore === null ? null : levelOf(conflict.newScore);
  const levelChanged = newLevel !== null && newLevel !== oldLevel;

  return (
    <article
      className={`rounded-lg border p-3.5 ${
        resolved
          ? 'border-emerald-200 bg-emerald-50/40'
          : failed
            ? 'border-rose-300 bg-rose-50/50'
            : 'border-amber-300 bg-amber-50/50'
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        {onSelectPatient ? (
          <button
            type="button"
            onClick={() => onSelectPatient(conflict.patientCode)}
            className="rounded font-mono text-sm font-semibold text-brand-700 underline decoration-dotted underline-offset-2 hover:text-brand-900"
          >
            {conflict.patientCode}
          </button>
        ) : (
          <span className="font-mono text-sm font-semibold text-slate-900">
            {conflict.patientCode}
          </span>
        )}

        <div className="flex items-center gap-1.5">
          <VersionPill
            label="read"
            version={conflict.sourceVersion}
            tone="bg-white text-slate-600 ring-1 ring-slate-300"
          />
          <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden="true" />
          <VersionPill
            label="database"
            version={conflict.currentVersion}
            tone="bg-white text-slate-900 ring-1 ring-slate-400"
          />
        </div>
      </header>

      {conflict.changedFields.length > 0 ? (
        <ul className="mt-2.5 space-y-0.5">
          {conflict.changedFields.map((change) => (
            <li key={change.field} className="text-xs text-slate-700">
              <span className="font-medium">{change.field}</span>
              <span className="mx-1.5 font-mono text-slate-500">
                {String(change.from)} → {String(change.to)}
              </span>
              <span className="text-slate-500">changed underneath the computation</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2.5 text-xs text-slate-500">
          The row's version moved without a clinical field differing — another writer touched it and the
          guard refused on that basis alone.
        </p>
      )}

      <dl className="mt-3 grid gap-x-4 gap-y-1.5 border-t border-black/5 pt-2.5 text-xs sm:grid-cols-2">
        <div className="flex items-baseline justify-between gap-2 sm:contents">
          <dt className="text-slate-500">Rejected score</dt>
          <dd className="font-mono font-semibold tabular-nums text-slate-700">
            {conflict.oldScore}{' '}
            <span className={`font-sans text-[10px] ${LEVEL_CLASS[oldLevel]}`}>({oldLevel})</span>
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-2 sm:contents">
          <dt className="text-slate-500">Applied score</dt>
          <dd className="font-mono font-semibold tabular-nums text-slate-900">
            {conflict.newScore === null ? (
              <span className="font-sans text-slate-500">none written</span>
            ) : (
              <>
                {conflict.newScore}{' '}
                <span className={`font-sans text-[10px] ${LEVEL_CLASS[newLevel!]}`}>
                  ({newLevel})
                </span>
              </>
            )}
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-2 sm:contents">
          <dt className="text-slate-500">Resolution</dt>
          <dd className="font-semibold">
            {resolved ? (
              <span className="text-emerald-800">RE-EVALUATED</span>
            ) : failed ? (
              <span className="text-rose-800">FAILED — no stale value written</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-800">
                <Clock className="h-3 w-3" aria-hidden="true" />
                PENDING
              </span>
            )}
          </dd>
        </div>

        <div className="flex items-baseline justify-between gap-2 sm:contents">
          <dt className="text-slate-500">Stale overwrite</dt>
          <dd className="font-semibold">
            {resolved ? (
              <span className="inline-flex items-center gap-1 text-emerald-800">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                PREVENTED
              </span>
            ) : pending ? (
              <span className="text-amber-800">write blocked, awaiting recomputation</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-rose-800">
                <ShieldX className="h-3.5 w-3.5" aria-hidden="true" />
                blocked, but unresolved
              </span>
            )}
          </dd>
        </div>
      </dl>

      {levelChanged ? (
        <p className="mt-2.5 rounded-md bg-white/70 px-2.5 py-1.5 text-xs text-slate-700 ring-1 ring-black/5">
          {/* The line that makes the stakes legible: not a different number, a different clinical picture. */}
          Risk level moved <span className="font-semibold">{oldLevel}</span> →{' '}
          <span className="font-semibold">{newLevel}</span>. The stale result would have filed this
          patient a band lower.
        </p>
      ) : null}
    </article>
  );
}
