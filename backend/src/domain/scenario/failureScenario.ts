import { ACTOR_TYPE, DEFAULT_SEED, type ActorType } from '@bg/shared';
import type { ClinicalChanges } from '../online/clinicalMutations';

/**
 * The fixed scenario both engines run (R19.1).
 *
 * Every value here is explicit rather than generated. That is deliberate: the comparison is the project's
 * central evidence, so a change to the mutation heuristics or the seeded generator must not be able to
 * quietly alter it. The script is also the reason both runs are genuinely comparable — they receive the
 * same dataset and the same sequence of external events, differing only in how they write.
 *
 * ## The shape of the scenario
 *
 * ```
 * read records until a checkpoint exists and results are staged but unwritten
 *   → crash, freezing the staged batch durably
 *   → clinical staff update some of those staged patients during the outage
 *   → destroy the checkpoint
 *   → resume
 * ```
 *
 * The staged-but-unwritten window is the whole point. A result computed from version N, an update taking
 * the row to N+1 while the job is down, and then a resume that has to decide what to do with that result.
 * The guarded engine asks. The naive engine does not.
 *
 * ## Why glucose 272
 *
 * Risk contributions are banded, so an update has to cross a threshold to move the score at all. 272 sits
 * in the top glucose band, so wherever the patient started, the score changes — which is what makes the
 * difference between the two engines visible rather than a matter of reading version numbers.
 */

export interface FailureScenarioUpdate {
  /** Index into the staged batch, so the target is whichever patient is actually in flight. */
  stagedIndex: number;
  actorType: ActorType;
  changes: ClinicalChanges;
}

export interface FailureScenario {
  name: string;
  description: string;
  seed: number;
  totalRecords: number;
  partitionCount: number;
  batchSize: number;
  checkpointInterval: number;
  /** Records to read before crashing. Chosen to leave a partial batch staged. */
  crashAfterRead: number;
  /** Updates applied during the outage, targeting patients whose results are staged. */
  outageUpdates: FailureScenarioUpdate[];
  /** Which of the updated patients to feature in the side-by-side view. */
  spotlightStagedIndex: number;
}

/**
 * The comparison scenario.
 *
 * `crashAfterRead` of 58 with a batch of 25 leaves 8 records staged (50 flushed, 8 pending), and the
 * checkpoint interval of 25 guarantees a checkpoint exists by then — so "lose the checkpoint" has
 * something real to destroy rather than failing as a no-op.
 */
export const FAILURE_SCENARIO: FailureScenario = {
  name: 'stale-write-after-outage',
  description:
    'A result is computed, the job crashes before writing it, a laboratory updates the patient during ' +
    'the outage, and the resumed job must decide what to do with the now-stale result.',
  seed: DEFAULT_SEED,
  totalRecords: 200,
  partitionCount: 4,
  batchSize: 25,
  checkpointInterval: 25,
  crashAfterRead: 58,
  outageUpdates: [
    { stagedIndex: 0, actorType: ACTOR_TYPE.LAB, changes: { glucose: 272 } },
    { stagedIndex: 2, actorType: ACTOR_TYPE.DOCTOR, changes: { glucose: 268 } },
    { stagedIndex: 4, actorType: ACTOR_TYPE.NURSE, changes: { heartRate: 132 } },
  ],
  spotlightStagedIndex: 0,
};

/**
 * A control scenario with no updates during the outage.
 *
 * Used to demonstrate something important about honesty: with no contention, the two engines produce
 * *identical* results. The naive engine is not broken in general — it is broken specifically when
 * something changes underneath it, which is exactly the condition the guard exists for. Without this
 * control, a sceptic could reasonably suspect the naive engine was rigged to fail.
 */
export const UNCONTENDED_SCENARIO: FailureScenario = {
  ...FAILURE_SCENARIO,
  name: 'no-contention-control',
  description:
    'The same crash and recovery sequence with no clinical updates during the outage. Both engines ' +
    'should agree exactly, which shows the difference comes from contention rather than from the engines ' +
    'disagreeing about how to score a record.',
  outageUpdates: [],
  spotlightStagedIndex: 0,
};
