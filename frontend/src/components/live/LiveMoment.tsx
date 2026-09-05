import {
  Activity,
  CheckCircle2,
  CircleDot,
  LifeBuoy,
  Loader2,
  Pause,
  ShieldCheck,
  ShieldX,
  Snowflake,
  ZapOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  JOB_STATUS,
  type BackfillJobState,
  type ConflictRecord,
  type RecoverySummary,
  type VerificationReport,
} from '@bg/shared';
import { ConflictCard } from '../conflicts/ConflictCard';

/**
 * "What is happening right now", as one panel that changes with the run (R24.2).
 *
 * ## The problem this solves
 *
 * The dashboard previously reacted to the pivotal moment of the demo — the crash — by quietly changing a
 * small badge from "Running" to "Crashed". Everything else on the page looked identical. For an interface
 * whose job is to make a concurrency argument legible, the most dramatic event produced almost no visible
 * change.
 *
 * So this panel reads the run state and states, in one place and in words, what is going on and why it
 * matters. It is the only element on the dashboard that changes colour wholesale, which is what makes it
 * function as a signal rather than as decoration.
 *
 * ## Why the newest conflict is embedded here
 *
 * A conflict card is the single most persuasive object in the project: two versions, the field that moved,
 * the score that was refused and the score that was applied. It used to live in a scrolling list beneath four
 * other panels. Promoting the newest one into this panel means the thing you most want a judge to read is the
 * thing physically largest on screen at the moment it happens.
 *
 * The full list is still below, because the newest is evidence of *one* case and the count is evidence of the
 * mechanism working repeatedly.
 *
 * ## What it does not do
 *
 * No spinner or motion that is not tied to real state, and no invented urgency. `RUNNING` with nothing
 * contended is a calm panel, because that is an accurate description of the situation.
 */

type Tone = 'idle' | 'running' | 'alert' | 'crash' | 'recover' | 'good' | 'bad';

const TONE_CLASS: Record<Tone, { shell: string; icon: string; heading: string }> = {
  idle: { shell: 'border-slate-300 bg-slate-50', icon: 'text-slate-500', heading: 'text-slate-800' },
  running: { shell: 'border-brand-300 bg-brand-50', icon: 'text-brand-700', heading: 'text-brand-900' },
  alert: { shell: 'border-amber-400 bg-amber-50', icon: 'text-amber-700', heading: 'text-amber-900' },
  crash: { shell: 'border-rose-400 bg-rose-50', icon: 'text-rose-700', heading: 'text-rose-900' },
  recover: { shell: 'border-indigo-400 bg-indigo-50', icon: 'text-indigo-700', heading: 'text-indigo-900' },
  good: { shell: 'border-emerald-400 bg-emerald-50', icon: 'text-emerald-700', heading: 'text-emerald-900' },
  bad: { shell: 'border-rose-500 bg-rose-50', icon: 'text-rose-700', heading: 'text-rose-900' },
};

interface Moment {
  tone: Tone;
  icon: LucideIcon;
  spin?: boolean;
  headline: string;
  detail: string;
  /** Short label/value pairs shown as a strip under the detail. */
  facts?: { label: string; value: string }[];
}

export interface LiveMomentProps {
  job: BackfillJobState | null;
  conflicts: ConflictRecord[];
  recovery: RecoverySummary | null;
  report: VerificationReport | null;
}

/**
 * Chooses what the panel is about.
 *
 * Ordered by urgency rather than by chronology: a crash outranks a conflict, and a verdict outranks both,
 * because those are the states where a viewer most needs to be told something specific.
 */
function resolveMoment(
  job: BackfillJobState | null,
  conflicts: ConflictRecord[],
  recovery: RecoverySummary | null,
  report: VerificationReport | null,
): Moment {
  const status = job?.status ?? null;
  const metrics = job?.metrics ?? null;

  if (status === null || status === JOB_STATUS.IDLE) {
    return {
      tone: 'idle',
      icon: CircleDot,
      headline: 'Nothing running',
      detail:
        'Press RUN DEMO to score every record while clinical staff keep editing them, crash the job mid-batch, ' +
        'destroy its checkpoint, recover from the data alone, and audit the result. This panel narrates each stage.',
    };
  }

  if (status === JOB_STATUS.CRASHED) {
    return {
      tone: 'crash',
      icon: ZapOff,
      headline: 'Crashed mid-batch',
      detail:
        `The process died with ${job?.pendingResultCount ?? 0} result(s) computed but never written. Those are ` +
        'frozen in durable storage — not lost, and not applied. No committed patient data was touched. Any clinical ' +
        'update that lands now makes one of those frozen results provably stale.',
      facts: [
        { label: 'Frozen results', value: String(job?.pendingResultCount ?? 0) },
        { label: 'Records decided before crash', value: (metrics?.processed ?? 0).toLocaleString('en-GB') },
        {
          label: 'Checkpoint',
          value: job?.checkpoint ? (job.checkpoint.status === 'LOST' ? 'destroyed' : job.checkpoint.status.toLowerCase()) : 'none',
        },
      ],
    };
  }

  if (status === JOB_STATUS.RECOVERING) {
    return {
      tone: 'recover',
      icon: LifeBuoy,
      spin: true,
      headline: 'Recovering from the data, not a checkpoint',
      detail:
        'Resume position is being derived by asking which records already carry a score computed from the version ' +
        'they currently hold. Records found already correct are left untouched rather than rewritten.',
      ...(recovery
        ? {
            facts: [
              { label: 'Boundary partition', value: `P${recovery.recoveryStartPartition + 1}` },
              { label: 'Left untouched', value: String(recovery.noops) },
              { label: 'Stale results refused', value: String(recovery.pendingResultsRejected) },
            ],
          }
        : {}),
    };
  }

  if (status === JOB_STATUS.VERIFIED_SAFE || status === JOB_STATUS.VERIFICATION_FAILED) {
    const passed = status === JOB_STATUS.VERIFIED_SAFE;
    return {
      tone: passed ? 'good' : 'bad',
      icon: passed ? ShieldCheck : ShieldX,
      headline: passed ? 'Independently verified safe' : 'Verification failed',
      detail: report
        ? report.guaranteeStatement
        : 'The audit has finished. See the verification page for the detail.',
      ...(report
        ? {
            facts: [
              { label: 'Stale overwrites', value: String(report.metrics.staleOverwrites) },
              { label: 'Lost clinical updates', value: String(report.metrics.lostOnlineUpdates) },
              { label: 'Coverage', value: `${report.metrics.coveragePercent}%` },
              {
                label: 'Checks passed',
                value: `${report.checks.filter((check) => check.passed).length}/${report.checks.length}`,
              },
            ],
          }
        : {}),
    };
  }

  if (status === JOB_STATUS.FAILED) {
    return {
      tone: 'bad',
      icon: ShieldX,
      headline: 'Run failed',
      detail:
        job?.failureReason ??
        'The job stopped without completing. The reason is reported rather than swallowed — check the activity feed.',
    };
  }

  if (status === JOB_STATUS.PAUSED) {
    return {
      tone: 'idle',
      icon: Pause,
      headline: 'Paused at a record boundary',
      detail:
        'Stopped between records, never mid-write. This is a good moment to trigger a clinical update by hand: ' +
        'anything staged and unwritten is now a candidate for a conflict when the run resumes.',
      facts: [{ label: 'Staged, unwritten', value: String(job?.pendingResultCount ?? 0) }],
    };
  }

  if (status === JOB_STATUS.VERIFYING) {
    return {
      tone: 'running',
      icon: Loader2,
      spin: true,
      headline: 'Auditing',
      detail:
        'A separate engine is re-reading the database and the ledgers and recomputing every number. It receives no ' +
        'counter from the backfill.',
    };
  }

  // RUNNING, and either contended or not.
  const newest = conflicts.at(-1) ?? null;

  if (newest) {
    return {
      tone: 'alert',
      icon: Activity,
      headline: 'Conflict detected — stale write refused',
      detail:
        `A clinical update landed on ${newest.patientCode} between the backfill reading it and writing the result. ` +
        'The guarded write matched zero rows, so nothing stale reached the record. The score below was recomputed ' +
        'from the current reading.',
      facts: [
        { label: 'Conflicts so far', value: String(metrics?.conflicts ?? conflicts.length) },
        { label: 'Stale writes blocked', value: String(metrics?.staleWriteAttemptsBlocked ?? 0) },
        { label: 'Staged, unwritten', value: String(job?.pendingResultCount ?? 0) },
      ],
    };
  }

  return {
    tone: 'running',
    icon: Loader2,
    spin: true,
    headline: 'Scoring records',
    detail:
      'Reading each record, computing a score, and writing it only if the record has not changed in the meantime. ' +
      'Nothing has been contended yet — trigger a clinical update to force a collision.',
    facts: [
      { label: 'Partition', value: `P${(metrics?.currentPartition ?? 0) + 1}` },
      { label: 'Staged, unwritten', value: String(job?.pendingResultCount ?? 0) },
    ],
  };
}

export function LiveMoment({ job, conflicts, recovery, report }: LiveMomentProps) {
  const moment = resolveMoment(job, conflicts, recovery, report);
  const palette = TONE_CLASS[moment.tone];
  const Icon = moment.icon;

  // Only shown while the run is live and contended; a settled run's own verdict is the more useful message.
  const showConflict = moment.tone === 'alert';
  const newest = conflicts.at(-1) ?? null;

  return (
    <section
      aria-labelledby="moment-heading"
      className={`rounded-xl border-2 p-5 shadow-sm transition-colors duration-300 ${palette.shell}`}
    >
      <div className="flex items-start gap-3.5">
        <Icon
          className={`mt-0.5 h-6 w-6 shrink-0 ${palette.icon} ${moment.spin ? 'animate-spin' : ''}`}
          aria-hidden="true"
        />

        <div className="min-w-0 flex-1">
          {/*
           * Polite, and scoped to this heading and detail only. A state change is worth announcing; the
           * per-record telemetry underneath it is not, which is why the activity feed announces a rollup
           * instead of individual events.
           */}
          <div role="status" aria-live="polite">
            <h2 id="moment-heading" className={`text-base font-bold ${palette.heading}`}>
              {moment.headline}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-700">{moment.detail}</p>
          </div>

          {moment.facts && moment.facts.length > 0 ? (
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5">
              {moment.facts.map((fact) => (
                <div key={fact.label} className="flex items-baseline gap-1.5">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-600">{fact.label}</dt>
                  <dd className="font-mono text-sm font-bold tabular-nums text-slate-900">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>

      {showConflict && newest ? (
        <div className="mt-4 border-t border-amber-300/70 pt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
            Most recent conflict
          </p>
          <ConflictCard conflict={newest} />
        </div>
      ) : null}

      {/* Frozen results are the crash's whole significance, so they get a line of their own. */}
      {moment.tone === 'crash' && (job?.pendingResultCount ?? 0) > 0 ? (
        <p className="mt-4 flex items-start gap-2 border-t border-rose-300/70 pt-3 text-xs text-rose-900">
          <Snowflake className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Those frozen results are exactly what a naive resume would write back. Destroy the checkpoint, then
            recover, and watch them be revalidated against the current version before anything is written.
          </span>
        </p>
      ) : null}

      {moment.tone === 'good' ? (
        <p className="mt-4 flex items-start gap-2 border-t border-emerald-300/70 pt-3 text-xs text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Every number above was produced by re-reading stored rows and recomputing — not copied from any
            counter the backfill kept about itself.
          </span>
        </p>
      ) : null}
    </section>
  );
}
