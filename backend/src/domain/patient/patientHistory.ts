import {
  CONFLICT_RESOLUTION,
  CONSIDERATION_OUTCOME,
  type ActorType,
  type FieldChange,
  type PatientHistoryEntry,
} from '@bg/shared';
import type { PatientEvidence } from '../ports/PatientRepository';
import { actorLabel } from '../online/clinicalMutations';

/**
 * Builds one patient's chronological timeline from durable evidence (R16.4).
 *
 * ## Why this is a pure function
 *
 * It takes the four ledger lists and returns entries — no repository, no clock, no job id. That makes
 * the interesting cases (a rejected write followed by a re-evaluation that changed the risk band)
 * unit-testable without a database, and it keeps the merge logic out of both adapters, so the SQLite
 * and in-memory paths cannot produce different narratives from the same facts.
 *
 * ## What the timeline is for
 *
 * This is the per-record form of the headline claim. On a contended patient it reads:
 *
 * ```
 * Lab updated glucose 165 → 210        (v2 → v3)
 * Stale write blocked                   computed from v2, record had reached v3
 * Conflict detected                     glucose 165 → 210
 * Backfill wrote risk score 63          guarded at v3
 * Re-evaluated                          48 → 63, MEDIUM → HIGH
 * ```
 *
 * Every line is read back from a different table, so the sequence is evidence rather than narration.
 */

/**
 * Tie-break order for entries sharing a timestamp.
 *
 * Stored timestamps have millisecond resolution, and a rejected write, its conflict row and the
 * re-evaluation that follows can all land inside the same millisecond. Sorting by time alone would
 * then order them arbitrarily and the timeline would read as nonsense. This restores causal order in
 * exactly that case and has no effect otherwise.
 */
const CAUSAL_RANK: Record<PatientHistoryEntry['kind'], number> = {
  ONLINE_UPDATE: 0,
  WRITE_REJECTED: 1,
  CONFLICT: 2,
  WRITE_APPLIED: 3,
  REEVALUATION: 4,
  NO_ACTION: 5,
};

function describeChanges(changes: FieldChange[]): string {
  if (changes.length === 0) return 'no field values changed';
  return changes.map((change) => `${change.field} ${change.from} → ${change.to}`).join(', ');
}

export function buildPatientHistory(evidence: PatientEvidence): PatientHistoryEntry[] {
  const entries: { entry: PatientHistoryEntry; rank: number; tieId: number }[] = [];

  const push = (entry: PatientHistoryEntry, tieId: number): void => {
    entries.push({ entry, rank: CAUSAL_RANK[entry.kind], tieId });
  };

  for (const update of evidence.onlineUpdates) {
    push(
      {
        kind: 'ONLINE_UPDATE',
        version: update.newVersion,
        at: update.createdAt,
        summary:
          `${actorLabel(update.actorType as ActorType)} updated ` +
          `${describeChanges(update.changedFields)} ` +
          `(v${update.previousVersion} → v${update.newVersion}).`,
        actorType: update.actorType as ActorType,
        changedFields: update.changedFields,
      },
      update.id,
    );
  }

  for (const write of evidence.writes) {
    if (write.applied) {
      push(
        {
          kind: 'WRITE_APPLIED',
          version: write.guardVersion,
          at: write.createdAt,
          summary:
            `Backfill wrote risk score ${write.scoreWritten ?? '—'}, derived from v${write.guardVersion}` +
            `${write.guarded ? '' : ' (UNGUARDED — naive engine)'}.`,
          scoreAfter: write.scoreWritten,
        },
        write.id,
      );
      continue;
    }

    /**
     * A refused write is the safety mechanism firing, so the summary says what was prevented rather
     * than merely that something failed. `rowVersionAtWrite` is read inside the same transaction as
     * the refused update, which is what makes this a measurement and not an inference.
     *
     * Deliberately silent about the score. Both adapters record `scoreWritten` as null on a refused
     * write — the column means "what landed", and a refused write landed nothing. The refused *value*
     * lives on the conflict row as `oldScore`, and the CONFLICT entry that follows carries it. A live
     * check caught the alternative: this line read "Score — was refused", an em dash exactly where a
     * reader expects the number, which looks like a missing value rather than a deliberate one.
     */
    push(
      {
        kind: 'WRITE_REJECTED',
        version: write.guardVersion,
        at: write.createdAt,
        summary:
          `Stale write blocked: the result computed from v${write.guardVersion} was refused because ` +
          `the record had already reached v${write.rowVersionAtWrite}.`,
      },
      write.id,
    );
  }

  for (const conflict of evidence.conflicts) {
    push(
      {
        kind: 'CONFLICT',
        version: conflict.sourceVersion,
        at: conflict.detectedAt,
        summary:
          `Conflict detected: backfill read v${conflict.sourceVersion}, database had reached ` +
          `v${conflict.currentVersion} (${describeChanges(conflict.changedFields)}).`,
        changedFields: conflict.changedFields,
        rejectedScore: conflict.oldScore,
      },
      conflict.id,
    );

    // Only resolved conflicts produce a resolution entry; a PENDING one has nothing to report yet.
    if (conflict.resolvedAt === null) continue;

    const reevaluated = conflict.resolution === CONFLICT_RESOLUTION.REEVALUATED;

    push(
      {
        kind: 'REEVALUATION',
        version: conflict.currentVersion,
        at: conflict.resolvedAt,
        summary: reevaluated
          ? `Re-evaluated from current data: score ${conflict.oldScore} → ${conflict.newScore}. ` +
            `Stale overwrite prevented.`
          : `Could not be re-evaluated within the retry limit. No stale value was written; the ` +
            `record is reported as failed rather than silently resolved.`,
        scoreBefore: conflict.oldScore,
        scoreAfter: conflict.newScore,
        rejectedScore: conflict.oldScore,
      },
      conflict.id,
    );
  }

  /**
   * Only no-op considerations become entries.
   *
   * The other outcomes are already represented by a write-ledger row, and duplicating them would pad
   * the timeline with rows carrying no new information. A no-op is different: it is the *absence* of a
   * write, so nothing else in the evidence records it — and it is the single best piece of evidence
   * that recovery reasoned about the data rather than blindly rewriting it (R9.4).
   */
  for (const consideration of evidence.considerations) {
    if (consideration.outcome !== CONSIDERATION_OUTCOME.NO_ACTION_ALREADY_CURRENT) continue;

    push(
      {
        kind: 'NO_ACTION',
        version: consideration.sourceVersion,
        at: consideration.decidedAt,
        summary:
          `Revisited during ${consideration.phase.toLowerCase()} and left untouched: the stored ` +
          `score was already derived from v${consideration.sourceVersion}, the current version.`,
      },
      consideration.patientId,
    );
  }

  return entries
    .sort((a, b) => {
      const timeDelta = Date.parse(a.entry.at) - Date.parse(b.entry.at);
      if (timeDelta !== 0) return timeDelta;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.tieId - b.tieId;
    })
    .map((wrapped) => wrapped.entry);
}
