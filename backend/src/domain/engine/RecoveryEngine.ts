import {
  BACKFILL_STATUS,
  CONSIDERATION_OUTCOME,
  EVENT_SEVERITY,
  EVENT_TYPE,
  PENDING_RESULT_STATE,
  type Patient,
  type RecoverySummary,
} from '@bg/shared';
import type { EventSink } from '../ports/EventSink';
import type {
  PatientRepository,
  PendingResultRecord,
} from '../ports/PatientRepository';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { validateGuardedWrite, VERSION_DECISION } from './VersionValidator';
import { ConflictEngine, snapshotOf } from './ConflictEngine';
import type { EngineCounters } from './BackfillEngine';

/**
 * Recovery after an interruption, with no trusted cursor (R9).
 *
 * ## The problem
 *
 * The checkpoint is gone. The engine has no idea where it was. Two obvious responses are both wrong:
 *
 *  - **Skip everything before the lost checkpoint's last known position.** The position is untrustworthy
 *    — that is what "lost" means — and records after it may never have been written. Coverage breaks.
 *  - **Rewrite everything from the start.** Correct but destructive and slow, and it would blindly
 *    overwrite records that online updates have legitimately changed since. Safety breaks.
 *
 * ## The answer: derive the boundary from the data
 *
 * A partition is *provably complete* only if every record in it has a terminal ledger entry **and**
 * every one of those records satisfies `lastBackfillVersion === version`. That is checkable evidence,
 * independent of any cursor. Recovery restarts from the lowest partition that is not provably complete.
 *
 * ## An expected consequence, not a bug
 *
 * Because the proof requires `lastBackfillVersion === version`, an online update landing on an early
 * partition while the engine worked on a later one makes that early partition un-provable again — so the
 * boundary can move *backwards*, possibly to partition 0, far earlier than the lost checkpoint. That is
 * the correct reading of the requirement: the engine has no evidence the record is still current, so it
 * must look.
 *
 * Cost stays bounded because the overwhelming majority of revisits take the no-op path: a read and a
 * comparison, no write. Expect recovery to revisit a large span quickly and rewrite very little. That
 * shape *is* the correctness argument, which is why the summary reports no-ops explicitly.
 */

export interface RecoveryEngineDeps {
  repository: PatientRepository;
  events: EventSink;
  conflicts: ConflictEngine;
  jobId: string;
  partitionCount: number;
  phase: string;
}

export interface RecoveryPlan {
  /** Lowest partition not provably complete. Forward processing resumes here. */
  recoveryStartPartition: number;
  /** Partitions proven complete from data evidence alone. */
  provablyCompletePartitions: number[];
  /** Staged results that survived the crash and must be revalidated before any write. */
  pendingResults: PendingResultRecord[];
  /** Records in the recovery range whose evidence shows they still need work. */
  uncertainRecordCount: number;
}

export class RecoveryEngine {
  private summary: RecoverySummary = {
    recoveryStartPartition: 0,
    recordsRevisited: 0,
    noops: 0,
    recordsReprocessed: 0,
    conflictsFound: 0,
    pendingResultsRevalidated: 0,
    pendingResultsRejected: 0,
  };

  private counters: EngineCounters = {
    processed: 0,
    applied: 0,
    noopAlreadyCurrent: 0,
    conflicts: 0,
    reevaluated: 0,
    protectedUpdates: 0,
    staleBlocked: 0,
    failed: 0,
  };

  /**
   * Records already decided during this recovery pass.
   *
   * Staged results are handled before the range scan, and the scan covers the same partitions. Without
   * this set, a record re-evaluated during staged handling would be revisited moments later, found
   * current, and have its `REEVALUATED_APPLIED` ledger outcome overwritten by
   * `NO_ACTION_ALREADY_CURRENT` — the ledger is keyed per record, so the last writer wins.
   *
   * That silently erased the evidence that a conflict had been resolved: coverage still looked correct,
   * but the report showed zero re-evaluations for work it had genuinely done. Skipping these records also
   * avoids re-reading rows that were decided seconds earlier.
   */
  private decidedThisPass = new Set<number>();

  constructor(private readonly deps: RecoveryEngineDeps) {}

  getSummary(): RecoverySummary {
    return { ...this.summary };
  }

  getCounters(): EngineCounters {
    return { ...this.counters };
  }

  // ------------------------------------------------------------------ planning

  /**
   * Decides where recovery must begin, using only durable evidence.
   *
   * Deliberately takes no checkpoint argument. Not "ignores it if lost" — it cannot consult one at all,
   * which makes it structurally impossible for a cursor to influence the boundary.
   */
  async computePlan(): Promise<RecoveryPlan> {
    const considered = new Set(await this.deps.repository.consideredPatientIds(this.deps.jobId));

    const provablyComplete: number[] = [];
    let firstIncomplete: number | null = null;
    let uncertainRecordCount = 0;

    for (let partition = 0; partition < this.deps.partitionCount; partition += 1) {
      const records = await this.deps.repository.findByPartition(partition);

      const uncertain = records.filter((record) => !this.isProvablyCurrent(record, considered));

      if (uncertain.length === 0 && records.length > 0) {
        provablyComplete.push(partition);
        continue;
      }

      uncertainRecordCount += uncertain.length;
      if (firstIncomplete === null) firstIncomplete = partition;
    }

    const pendingResults = await this.deps.repository.pendingResults(
      this.deps.jobId,
      PENDING_RESULT_STATE.PENDING,
    );

    this.summary.recoveryStartPartition = firstIncomplete ?? this.deps.partitionCount;

    return {
      recoveryStartPartition: firstIncomplete ?? this.deps.partitionCount,
      provablyCompletePartitions: provablyComplete,
      pendingResults,
      uncertainRecordCount,
    };
  }

  /**
   * Whether a record's stored result is provably derived from its current data.
   *
   * Three conditions, all necessary. It must have been decided upon at all; its score must derive from
   * the version the row currently holds; and recomputing must reproduce the stored score. The last check
   * catches the case a version comparison alone would miss — a corrupted or partially written derived
   * value whose bookkeeping looks correct.
   */
  private isProvablyCurrent(record: Patient, considered: Set<number>): boolean {
    if (!considered.has(record.id)) return false;
    if (record.riskScore === null || record.lastBackfillVersion === null) return false;
    if (record.lastBackfillVersion !== record.version) return false;

    const recomputed = calculateRiskScore(toRiskInput(record));
    return recomputed.score === record.riskScore && recomputed.level === record.riskLevel;
  }

  // ------------------------------------------------------------------ execution

  /**
   * Runs recovery over the plan: staged results first, then the uncertain range.
   *
   * Staged results are handled before the range scan because they are the only genuinely dangerous
   * artefact — a computed value from before the interruption that a careless resume would write over
   * newer data.
   */
  async recover(plan: RecoveryPlan): Promise<RecoverySummary> {
    this.deps.events.emit({
      type: EVENT_TYPE.RECOVERY_STARTED,
      severity: EVENT_SEVERITY.WARNING,
      jobId: this.deps.jobId,
      partitionIndex: plan.recoveryStartPartition,
      message:
        `Recovery started with no usable checkpoint. Boundary derived from data evidence: ` +
        `partition ${plan.recoveryStartPartition}. ` +
        `${plan.provablyCompletePartitions.length} partition(s) provably complete, ` +
        `${plan.uncertainRecordCount} record(s) uncertain, ` +
        `${plan.pendingResults.length} staged result(s) to revalidate.`,
      payload: {
        recoveryStartPartition: plan.recoveryStartPartition,
        provablyCompletePartitions: plan.provablyCompletePartitions,
        uncertainRecordCount: plan.uncertainRecordCount,
        pendingResultCount: plan.pendingResults.length,
      },
    });

    await this.revalidateStagedResults(plan.pendingResults);
    await this.revisitRange(plan.recoveryStartPartition);

    return this.getSummary();
  }

  /**
   * Revalidates each staged result against the version the row holds now (R9.5).
   *
   * This is the fork in the road that the whole naive comparison turns on. The staged value was computed
   * from `sourceVersion`; if the row has moved since, that value is stale and writing it would destroy
   * whatever changed it. The guarded engine checks first and recomputes when necessary. The naive engine
   * flushes the same rows without looking.
   */
  private async revalidateStagedResults(staged: PendingResultRecord[]): Promise<void> {
    for (const entry of staged) {
      const patient = await this.deps.repository.findById(entry.patientId);

      if (!patient) {
        await this.deps.repository.setPendingResultState(entry.id, PENDING_RESULT_STATE.REJECTED);
        this.summary.pendingResultsRejected += 1;
        continue;
      }

      /**
       * Marked here, covering every branch below.
       *
       * Each remaining path records a terminal decision for this record, so the range scan must not
       * revisit it and overwrite that outcome with a no-op.
       */
      this.decidedThisPass.add(entry.patientId);

      if (patient.version !== entry.sourceVersion) {
        // Stale. Refuse it, then resolve the record properly by recomputing from current data.
        await this.deps.repository.setPendingResultState(entry.id, PENDING_RESULT_STATE.REJECTED);
        this.summary.pendingResultsRejected += 1;
        this.summary.conflictsFound += 1;

        this.counters.staleBlocked += 1;
        this.counters.protectedUpdates += 1;
        this.counters.conflicts += 1;

        const outcome = await this.deps.conflicts.handleStaleWrite({
          jobId: this.deps.jobId,
          patient,
          staleSnapshot: entry.inputSnapshot,
          staleScore: entry.computedScore,
          sourceVersion: entry.sourceVersion,
          currentVersion: patient.version,
          phase: this.deps.phase,
        });

        if (outcome.resolved) {
          this.counters.reevaluated += 1;
        } else {
          this.counters.failed += 1;
        }

        this.counters.processed += 1;
        this.summary.recordsReprocessed += 1;
        continue;
      }

      // Still current, so the staged computation is safe to flush under its original version.
      const result = await this.deps.repository.applyGuarded(
        entry.patientId,
        entry.sourceVersion,
        {
          riskScore: entry.computedScore,
          riskLevel: entry.computedLevel,
          backfillStatus: BACKFILL_STATUS.COMPLETED,
        },
        {
          jobId: this.deps.jobId,
          guarded: true,
          wroteSourceFields: false,
          scoreWritten: entry.computedScore,
          phase: this.deps.phase,
        },
      );

      const validation = validateGuardedWrite(result);

      if (validation.decision === VERSION_DECISION.APPLIED) {
        await this.deps.repository.setPendingResultState(entry.id, PENDING_RESULT_STATE.FLUSHED);
        await this.deps.repository.recordConsideration({
          jobId: this.deps.jobId,
          patientId: entry.patientId,
          outcome: CONSIDERATION_OUTCOME.APPLIED,
          sourceVersion: entry.sourceVersion,
          appliedVersion: entry.sourceVersion,
          attempts: 1,
          phase: this.deps.phase,
          reason: 'staged result revalidated and flushed',
        });

        this.summary.pendingResultsRevalidated += 1;
        this.counters.applied += 1;
        this.counters.processed += 1;
        continue;
      }

      /**
       * The row moved between the check above and this write.
       *
       * Rare but real, and precisely why the guard is on the write rather than on a preceding read. The
       * check alone would have said "safe" and a naive implementation would have written stale data here.
       */
      await this.deps.repository.setPendingResultState(entry.id, PENDING_RESULT_STATE.REJECTED);
      this.summary.pendingResultsRejected += 1;
      this.summary.conflictsFound += 1;

      this.counters.staleBlocked += 1;
      this.counters.protectedUpdates += 1;
      this.counters.conflicts += 1;

      const outcome = await this.deps.conflicts.handleStaleWrite({
        jobId: this.deps.jobId,
        patient,
        staleSnapshot: entry.inputSnapshot,
        staleScore: entry.computedScore,
        sourceVersion: entry.sourceVersion,
        currentVersion: validation.currentVersion,
        phase: this.deps.phase,
      });

      if (outcome.resolved) {
        this.counters.reevaluated += 1;
      } else {
        this.counters.failed += 1;
      }

      this.counters.processed += 1;
    }
  }

  /**
   * Revisits every record from the boundary to the end of the dataset (R9.2–R9.4, R9.6).
   *
   * Each record takes exactly one of three paths, decided purely from evidence:
   *
   *  - already provably current → leave untouched, record `NO_ACTION_ALREADY_CURRENT`
   *  - never scored, or scored from an older version → recompute and write under a fresh guard
   *  - the guarded write is refused → hand to the conflict engine
   *
   * The first path is the one that matters for the "does not blindly rewrite" requirement: it is a
   * genuine no-op that still counts as considered, so coverage is satisfied without touching the row.
   */
  private async revisitRange(startPartition: number): Promise<void> {
    const considered = new Set(await this.deps.repository.consideredPatientIds(this.deps.jobId));

    for (let partition = startPartition; partition < this.deps.partitionCount; partition += 1) {
      const records = await this.deps.repository.findByPartition(partition);

      for (const record of records) {
        // Already decided moments ago while revalidating staged results. Revisiting would overwrite that
        // record's outcome with a no-op and erase the evidence that a conflict was resolved.
        if (this.decidedThisPass.has(record.id)) continue;

        this.summary.recordsRevisited += 1;

        // Re-read: an earlier step in this same recovery pass may have changed the row.
        const fresh = (await this.deps.repository.findById(record.id)) ?? record;

        if (this.isProvablyCurrent(fresh, considered)) {
          await this.deps.repository.recordConsideration({
            jobId: this.deps.jobId,
            patientId: fresh.id,
            outcome: CONSIDERATION_OUTCOME.NO_ACTION_ALREADY_CURRENT,
            sourceVersion: fresh.version,
            appliedVersion: fresh.version,
            attempts: 1,
            phase: this.deps.phase,
            reason: 'stored result already derived from the current version',
          });

          this.summary.noops += 1;
          this.counters.noopAlreadyCurrent += 1;
          this.counters.processed += 1;

          this.deps.events.emit({
            type: EVENT_TYPE.RECORD_NO_ACTION,
            jobId: this.deps.jobId,
            patientCode: fresh.patientCode,
            partitionIndex: fresh.partitionIndex,
            message: `${fresh.patientCode} already current at v${fresh.version} — left untouched.`,
            payload: { version: fresh.version, riskScore: fresh.riskScore },
          });

          continue;
        }

        await this.reprocess(fresh);
      }
    }
  }

  /** Recomputes from current data and writes under a fresh guard. */
  private async reprocess(patient: Patient): Promise<void> {
    try {
      const snapshot = snapshotOf(patient);
      const recomputed = calculateRiskScore(toRiskInput(snapshot));

      const result = await this.deps.repository.applyGuarded(
        patient.id,
        patient.version,
        {
          riskScore: recomputed.score,
          riskLevel: recomputed.level,
          backfillStatus: BACKFILL_STATUS.COMPLETED,
        },
        {
          jobId: this.deps.jobId,
          guarded: true,
          wroteSourceFields: false,
          scoreWritten: recomputed.score,
          phase: this.deps.phase,
        },
      );

      const validation = validateGuardedWrite(result);

      if (validation.decision === VERSION_DECISION.APPLIED) {
        await this.deps.repository.recordConsideration({
          jobId: this.deps.jobId,
          patientId: patient.id,
          outcome: CONSIDERATION_OUTCOME.APPLIED,
          sourceVersion: patient.version,
          appliedVersion: patient.version,
          attempts: 1,
          phase: this.deps.phase,
          reason: null,
        });

        this.summary.recordsReprocessed += 1;
        this.counters.applied += 1;
        this.counters.processed += 1;

        this.deps.events.emit({
          type: EVENT_TYPE.RECORD_UPDATED,
          severity: EVENT_SEVERITY.SUCCESS,
          jobId: this.deps.jobId,
          patientCode: patient.patientCode,
          partitionIndex: patient.partitionIndex,
          message: `${patient.patientCode} reprocessed during recovery: score ${recomputed.score}.`,
          payload: { score: recomputed.score, level: recomputed.level, version: patient.version },
        });

        return;
      }

      this.summary.conflictsFound += 1;
      this.counters.staleBlocked += 1;
      this.counters.protectedUpdates += 1;
      this.counters.conflicts += 1;

      const outcome = await this.deps.conflicts.handleStaleWrite({
        jobId: this.deps.jobId,
        patient,
        staleSnapshot: snapshot,
        staleScore: recomputed.score,
        sourceVersion: patient.version,
        currentVersion: validation.currentVersion,
        phase: this.deps.phase,
      });

      if (outcome.resolved) {
        this.counters.reevaluated += 1;
      } else {
        this.counters.failed += 1;
      }

      this.summary.recordsReprocessed += 1;
      this.counters.processed += 1;
    } catch (error) {
      // Even in recovery, a record must end with a terminal decision rather than vanish.
      const reason = error instanceof Error ? error.message : String(error);

      await this.deps.repository.recordConsideration({
        jobId: this.deps.jobId,
        patientId: patient.id,
        outcome: CONSIDERATION_OUTCOME.FAILED,
        sourceVersion: patient.version,
        appliedVersion: null,
        attempts: 1,
        phase: this.deps.phase,
        reason,
      });

      this.counters.failed += 1;
      this.counters.processed += 1;

      this.deps.events.emit({
        type: EVENT_TYPE.RECORD_FAILED,
        severity: EVENT_SEVERITY.CRITICAL,
        jobId: this.deps.jobId,
        patientCode: patient.patientCode,
        partitionIndex: patient.partitionIndex,
        message: `${patient.patientCode} failed during recovery: ${reason}`,
        payload: { reason },
      });
    }
  }

  /** Emits the completion event with the shape that makes the no-op argument visible (R9.7). */
  emitCompleted(): void {
    this.deps.events.emit({
      type: EVENT_TYPE.RECOVERY_COMPLETED,
      severity: EVENT_SEVERITY.SUCCESS,
      jobId: this.deps.jobId,
      message:
        `Recovery complete: ${this.summary.recordsRevisited} record(s) revisited, ` +
        `${this.summary.noops} already current and left untouched, ` +
        `${this.summary.recordsReprocessed} reprocessed, ` +
        `${this.summary.conflictsFound} conflict(s) found, ` +
        `${this.summary.pendingResultsRevalidated} staged result(s) still valid, ` +
        `${this.summary.pendingResultsRejected} staged result(s) refused as stale.`,
      payload: { ...this.summary },
    });
  }
}
