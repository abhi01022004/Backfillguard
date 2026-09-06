import { useState } from 'react';
import type { ConflictRecord, SimulationEvent } from '@bg/shared';
import { EventTimeline } from './EventTimeline';
import { ConflictList } from '../conflicts/ConflictList';

/**
 * The activity feed and the conflict list, as two tabs in one panel.
 *
 * ## Why tabs rather than side by side
 *
 * They were two panels in a row, each scrolling internally at half width. Two consequences, both bad: a
 * conflict card at half width wraps its version pills onto three lines, and the row cost a full screen of
 * height for content that is largely the same story told twice — the activity feed *contains* the conflict
 * events.
 *
 * As tabs they get the full width, so a conflict card reads on one line, and the panel costs one screen
 * instead of two. The conflict count sits on the tab itself, so nothing is hidden by not being the active
 * tab — you can see there are eleven conflicts without switching to them.
 *
 * Conflicts is the default tab, because it is the persuasive one. The raw event stream is the corroborating
 * detail you show when someone asks whether the conflicts are real.
 */

export type ActivityTab = 'conflicts' | 'events';

export interface ActivityPanelProps {
  events: SimulationEvent[];
  conflicts: ConflictRecord[];
  conflictTotal: number;
  conflictOpen: number;
  conflictsLoading: boolean;
  conflictsError: string | null;
  onSelectPatient?: (patientCode: string) => void;
}

export function ActivityPanel({
  events,
  conflicts,
  conflictTotal,
  conflictOpen,
  conflictsLoading,
  conflictsError,
  onSelectPatient,
}: ActivityPanelProps) {
  const [tab, setTab] = useState<ActivityTab>('conflicts');

  const tabs: { id: ActivityTab; label: string; count: number | null }[] = [
    { id: 'conflicts', label: 'Version conflicts', count: conflictTotal },
    { id: 'events', label: 'Live activity', count: events.length },
  ];

  return (
    <div className="flex min-h-0 flex-col">
      {/*
       * A real tablist, so the selected state is announced rather than only shown.
       *
       * Styled as a segmented control floating above the card rather than as browser-style attached tabs: the
       * panels below are shared components that carry their own rounded border, and attached tabs would
       * produce two competing sets of rounded corners.
       */}
      <div
        role="tablist"
        aria-label="Activity and conflicts"
        className="mb-2 inline-flex gap-1 self-start rounded-lg bg-slate-200/70 p-0.5"
      >
        {tabs.map((entry) => {
          const selected = entry.id === tab;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${entry.id}`}
              id={`tab-${entry.id}`}
              onClick={() => setTab(entry.id)}
              className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                selected
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {entry.label}
              {entry.count !== null ? (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                    selected ? 'bg-slate-100 text-slate-700' : 'bg-white/70 text-slate-600'
                  }`}
                >
                  {entry.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/*
       * Both panels stay mounted, with the inactive one hidden.
       *
       * Unmounting would reset the conflict list's expand state and the event filter every time you switch,
       * and it would make the event list re-render its whole window on every tab change during a live run.
       */}
      <div
        role="tabpanel"
        id="panel-conflicts"
        aria-labelledby="tab-conflicts"
        hidden={tab !== 'conflicts'}
        /*
         * `overflow-hidden` is load-bearing, not decoration.
         *
         * `max-h` alone does not contain the child: the panel inside grows to its natural height and simply
         * paints over whatever follows it on the page. With eight conflict cards that is roughly 470px of
         * overspill, which silently collided with the sections below.
         */
        className="max-h-[30rem] min-h-0 overflow-hidden"
      >
        <ConflictList
          conflicts={conflicts}
          total={conflictTotal}
          open={conflictOpen}
          loading={conflictsLoading}
          error={conflictsError}
          {...(onSelectPatient ? { onSelectPatient } : {})}
          initialVisible={8}
        />
      </div>

      <div
        role="tabpanel"
        id="panel-events"
        aria-labelledby="tab-events"
        hidden={tab !== 'events'}
        className="max-h-[30rem] min-h-0 overflow-hidden"
      >
        <EventTimeline events={events} />
      </div>
    </div>
  );
}
