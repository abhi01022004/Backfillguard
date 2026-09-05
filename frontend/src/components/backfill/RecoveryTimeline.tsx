import {
  CheckCircle2,
  CircleDashed,
  KeyRound,
  LifeBuoy,
  Play,
  ShieldCheck,
  ZapOff,
} from 'lucide-react';
import { EVENT_TYPE, type BackfillJobState, type SimulationEvent } from '@bg/shared';

/**
 * The recovery narrative (R14.3).
 *
 * Shows the sequence a judge needs to follow — started, crashed, checkpoint lost, recovered, verified — and
 * whether each beat has actually happened. Derived from the event stream rather than from a script, so a
 * step only lights up when the system genuinely did it.
 *
 * The recovery step deliberately leads with how many records were *left untouched*. That number is the
 * argument: it shows recovery reasoned from version evidence rather than rewriting everything it could not
 * account for.
 */

export interface RecoveryTimelineProps {
  job: BackfillJobState | null;
  events: SimulationEvent[];
}

interface Beat {
  key: string;
  label: string;
  icon: typeof Play;
  reached: boolean;
  detail: string | null;
  tone: 'pending' | 'done' | 'alarm';
}

function findLast(events: SimulationEvent[], type: string): SimulationEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === type) return events[i]!;
  }
  return null;
}

function numberFrom(event: SimulationEvent | null, key: string): number | null {
  const value = event?.payload?.[key];
  return typeof value === 'number' ? value : null;
}

export function RecoveryTimeline({ job, events }: RecoveryTimelineProps) {
  const started = findLast(events, EVENT_TYPE.BACKFILL_STARTED);
  const crashed = findLast(events, EVENT_TYPE.BACKFILL_CRASHED);
  const lost = findLast(events, EVENT_TYPE.CHECKPOINT_LOST);
  const recovered = findLast(events, EVENT_TYPE.RECOVERY_COMPLETED);
  const verifiedPass = findLast(events, EVENT_TYPE.VERIFICATION_PASSED);
  const verifiedFail = findLast(events, EVENT_TYPE.VERIFICATION_FAILED);

  const stagedAtCrash = numberFrom(crashed, 'stagedResultCount');
  const noops = numberFrom(recovered, 'noops');
  const revisited = numberFrom(recovered, 'recordsRevisited');
  const refusedStaged = numberFrom(recovered, 'pendingResultsRejected');

  const beats: Beat[] = [
    {
      key: 'started',
      label: 'Backfill started',
      icon: Play,
      reached: started !== null,
      detail: job?.metrics
        ? `${job.metrics.eligibleRecords.toLocaleString('en-GB')} records in scope`
        : null,
      tone: started ? 'done' : 'pending',
    },
    {
      key: 'crashed',
      label: 'Crashed',
      icon: ZapOff,
      reached: crashed !== null,
      detail:
        stagedAtCrash !== null
          ? `${stagedAtCrash} result(s) computed but never written`
          : null,
      tone: crashed ? 'alarm' : 'pending',
    },
    {
      key: 'lost',
      label: 'Checkpoint lost',
      icon: KeyRound,
      reached: lost !== null,
      detail: lost ? 'no usable resume cursor remains' : null,
      tone: lost ? 'alarm' : 'pending',
    },
    {
      key: 'recovered',
      label: 'Recovered from version evidence',
      icon: LifeBuoy,
      reached: recovered !== null,
      detail:
        recovered && noops !== null && revisited !== null
          ? `${revisited.toLocaleString('en-GB')} revisited · ${noops.toLocaleString('en-GB')} left untouched` +
            (refusedStaged ? ` · ${refusedStaged} stale result(s) refused` : '')
          : null,
      tone: recovered ? 'done' : 'pending',
    },
    {
      key: 'verified',
      label: verifiedFail && !verifiedPass ? 'Verification failed' : 'Verified safe',
      icon: verifiedFail && !verifiedPass ? CircleDashed : ShieldCheck,
      reached: verifiedPass !== null || verifiedFail !== null,
      detail: (verifiedPass ?? verifiedFail)?.message ?? null,
      tone: verifiedFail && !verifiedPass ? 'alarm' : verifiedPass ? 'done' : 'pending',
    },
  ];

  const anyReached = beats.some((beat) => beat.reached);

  return (
    <section
      aria-labelledby="recovery-heading"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 id="recovery-heading" className="text-base font-semibold text-slate-900">
        Recovery timeline
      </h2>

      {!anyReached ? (
        <p className="mt-3 text-sm text-slate-500">
          Nothing has happened yet. Start a backfill, then crash it and lose its checkpoint to see how
          recovery reasons about what still needs doing.
        </p>
      ) : (
        <ol className="mt-4 space-y-0">
          {beats.map((beat, index) => {
            const Icon = beat.icon;
            const last = index === beats.length - 1;

            const iconClass = beat.reached
              ? beat.tone === 'alarm'
                ? 'bg-rose-100 text-rose-700 ring-rose-300'
                : 'bg-emerald-100 text-emerald-700 ring-emerald-300'
              : 'bg-slate-100 text-slate-500 ring-slate-200';

            return (
              <li key={beat.key} className="relative flex gap-3 pb-5 last:pb-0">
                {/* Connector, drawn behind the icons. */}
                {!last ? (
                  <span
                    className={`absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px ${
                      beat.reached ? 'bg-slate-300' : 'bg-slate-200'
                    }`}
                    aria-hidden="true"
                  />
                ) : null}

                <span
                  className={`relative z-10 mt-0.5 flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full ring-1 ${iconClass}`}
                >
                  {beat.reached && beat.tone === 'done' && beat.key !== 'started' ? (
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </span>

                <div className="min-w-0 pt-0.5">
                  <p
                    className={`text-sm font-medium ${
                      beat.reached ? 'text-slate-900' : 'text-slate-500'
                    }`}
                  >
                    {beat.label}
                    {/* Never state alone by colour or position. */}
                    {!beat.reached ? (
                      <span className="ml-2 text-xs font-normal italic text-slate-500">
                        not yet
                      </span>
                    ) : null}
                  </p>
                  {beat.detail ? (
                    <p className="mt-0.5 text-xs text-slate-600">{beat.detail}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
