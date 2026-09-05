import {
  BACKFILL_STATUS,
  CONFLICT_RESOLUTION,
  CONSIDERATION_OUTCOME,
  DISCLAIMER,
  EVENT_SEVERITY,
  EVENT_TYPE,
  VERIFICATION_CHECK,
  VERIFICATION_VERDICT,
  type BackfillMode,
  type Patient,
  type VerificationCheckResult,
  type VerificationMetrics,
  type VerificationReport,
} from '@bg/shared';
import type { Clock } from '../../lib/clock';
import type { EventSink } from '../ports/EventSink';
import type { JobRepository } from '../ports/JobRepository';
import type { PatientRepository } from '../ports/PatientRepository';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { RISK_CONFIG } from '../risk/riskConfig';

/**
 * The independent audit (R11).
 *
 * ## Why this exists separately from the engine
 *
 * An engine reporting its own success is worth very little. If a counter is incremented in the wrong
 * branch, the engine reports a clean run and nothing contradicts it. So this module deliberately takes
 * no engine, no counters and no in-memory state — only the repositories. Every number it produces is
 * derived by re-reading persisted rows and recomputing.
 *
 * The strongest example is check C4: it recomputes each risk score from the clinical values currently in
 * the database and compares against what is stored. If a stale value had ever landed, C4 would catch it
 * even if every counter in the system said zero, because the arithmetic simply would not agree.
 *
 * ## Falsifiability
 *
 * A check that cannot fail proves nothing. Each of these has a companion test that deliberately breaks
 * the invariant — corrupt a stored score, delete a ledger row, inject an unguarded write, revert a
 * clinical value — and asserts the verdict flips to failed. "Stale overwrites = 0" is only meaningful
 * because a non-zero is reachable.
 *
 * There is deliberately no clamping, flooring or defaulting anywhere in this file (R11.12).
 */

export interface VerificationEngineDeps {
  patients: PatientRepository;
  jobs: JobRepository;
  events: EventSink;
  clock: Clock;
}

/** How many offending records to name in a failure. Enough to act on, not a wall of text. */
const MAX_REPORTED_CODES = 25;

export class VerificationEngine {
  constructor(private readonly deps: VerificationEngineDeps) {}

  async verify(jobId: string): Promise<VerificationReport> {
    this.deps.events.emit({
      type: EVENT_TYPE.VERIFICATION_STARTED,
      severity: EVENT_SEVERITY.INFO,
      jobId,
      message: 'Independent verification started — recomputing from stored data.',
    });

    const job = await this.deps.jobs.find(jobId);

    // Everything below reads persisted state. No engine counters are consulted.
    const patients = (await this.deps.patients.findPage({ page: 1, pageSize: 100_000 })).items;
    const eligibleIds = await this.deps.patients.allIds();
    const ledger = await this.deps.patients.listConsiderations(jobId);
    const writes = await this.deps.patients.listWriteLedger(jobId);
    const conflicts = await this.deps.patients.listConflicts(jobId);
    const updates = await this.deps.patients.listOnlineUpdates();

    const byId = new Map<number, Patient>(patients.map((patient) => [patient.id, patient]));

    const c1 = this.checkCoverage(eligibleIds, ledger, byId);
    const c2 = this.checkNoStaleOverwrite(writes, byId);
    const c3 = this.checkNoLostOnlineUpdate(updates, byId);
    const c4 = this.checkDerivedConsistency(patients);
    const c5 = this.checkValidOutputs(patients);
    const c6 = this.checkConflictsResolved(conflicts, patients);

    const checks = [c1, c2, c3, c4, c5, c6];

    const drift = this.measurePostConsiderationDrift(updates, ledger, byId);

    /**
     * Stale writes that were prevented, counted from both places the prevention can happen.
     *
     * A refused guarded write leaves a ledger row with `applied = false` — that covers the case where the
     * engine attempted a flush and the database rejected it.
     *
     * But recovery catches some staleness *before* attempting anything: it compares a staged result's
     * source version against the row and, on a mismatch, routes straight to re-evaluation. No write is
     * attempted, so no refused row exists. Counting only the ledger would under-report protection on that
     * path — a real gap this audit had until a crash-recovery test exposed it.
     *
     * The two are disjoint by construction. A rejected staged result is resolved by a *fresh* guarded
     * write against the current version, which succeeds, so it never also produces a refused row.
     *
     * `protectedUpdates` is the same quantity viewed from the other side: each prevented stale write is
     * one online update that kept its value. The report states that rather than implying two independent
     * measurements.
     */
    const refusedWrites = writes.filter((write) => !write.applied).length;
    const rejectedStagedResults = (await this.deps.patients.pendingResults(jobId, 'REJECTED')).length;
    const blockedWrites = refusedWrites + rejectedStagedResults;

    const metrics: VerificationMetrics = {
      eligibleRecords: eligibleIds.length,
      consideredRecords: new Set(ledger.map((entry) => entry.patientId)).size,
      completedRecords: patients.filter(
        (patient) =>
          patient.backfillStatus === BACKFILL_STATUS.COMPLETED ||
          patient.backfillStatus === BACKFILL_STATUS.REEVALUATED,
      ).length,
      conflicts: conflicts.length,
      /**
       * Counted from resolved conflicts, not from ledger outcomes.
       *
       * The consideration ledger holds each record's *final* decision, and that is the right semantics for
       * coverage — but it means a later phase legitimately overwrites an earlier outcome. A record
       * re-evaluated before a crash and then found already-current by recovery ends as
       * `NO_ACTION_ALREADY_CURRENT`, because that genuinely is the final decision about it.
       *
       * Reading re-evaluations from the ledger therefore under-reported them (a live run showed 9
       * conflicts but 7 re-evaluations). Re-evaluation is an *event*, exactly like a conflict, so it is
       * measured where events live. Both numbers now come from the same table and can be compared
       * meaningfully.
       */
      reevaluated: conflicts.filter(
        (conflict) => conflict.resolution === CONFLICT_RESOLUTION.REEVALUATED,
      ).length,
      protectedUpdates: blockedWrites,
      staleWriteAttemptsBlocked: blockedWrites,
      staleOverwrites: c2.offendingPatientCodes.length,
      lostOnlineUpdates: c3.offendingPatientCodes.length,
      missedRecords: c1.offendingPatientCodes.length,
      inconsistentRecords: c4.offendingPatientCodes.length,
      postConsiderationDrift: drift.count,
      coveragePercent:
        eligibleIds.length === 0
          ? 0
          : Math.round(
              (new Set(ledger.map((entry) => entry.patientId)).size / eligibleIds.length) * 1000,
            ) / 10,
    };

    const passed = checks.every((check) => check.passed);
    const verdict = passed ? VERIFICATION_VERDICT.VERIFIED_SAFE : VERIFICATION_VERDICT.VERIFICATION_FAILED;

    const startedAt = job?.startedAt ?? null;
    const completedAt = job?.completedAt ?? null;

    const report: VerificationReport = {
      jobId,
      mode: (job?.mode ?? 'GUARDED') as BackfillMode,
      datasetDescription: `Synthetic Hospital Patients (${eligibleIds.length} records)`,
      seed: job?.seed ?? 0,
      verdict,
      metrics,
      checks,
      guaranteeStatement: passed
        ? 'Every eligible record was considered. Version conflicts were detected and re-evaluated. ' +
          'No newer online update was overwritten by stale backfill data.'
        : 'Verification failed. The checks below name the records that break the guarantee.',
      jobStartedAt: startedAt,
      jobCompletedAt: completedAt,
      verifiedAt: this.deps.clock.nowIso(),
      durationMs:
        startedAt && completedAt
          ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
          : null,
    };

    this.deps.events.emit({
      type: passed ? EVENT_TYPE.VERIFICATION_PASSED : EVENT_TYPE.VERIFICATION_FAILED,
      severity: passed ? EVENT_SEVERITY.SUCCESS : EVENT_SEVERITY.CRITICAL,
      jobId,
      message: passed
        ? `BACKFILL VERIFIED SAFE — ${metrics.consideredRecords}/${metrics.eligibleRecords} records ` +
          `considered (${metrics.coveragePercent}%), ${metrics.staleOverwrites} stale overwrite(s), ` +
          `${metrics.lostOnlineUpdates} lost online update(s).`
        : `VERIFICATION FAILED — ${checks
            .filter((check) => !check.passed)
            .map((check) => check.title)
            .join('; ')}.`,
      payload: { verdict, metrics: { ...metrics } },
    });

    await this.deps.events.flush();

    return report;
  }

  // ================================================================== C1

  /**
   * Coverage: every eligible record reached a terminal decision.
   *
   * A set difference, not a counter comparison. That distinction matters — a counter could be
   * incremented twice for one record and once for none, and still total correctly.
   */
  private checkCoverage(
    eligibleIds: number[],
    ledger: { patientId: number }[],
    byId: Map<number, Patient>,
  ): VerificationCheckResult {
    const considered = new Set(ledger.map((entry) => entry.patientId));
    const missing = eligibleIds.filter((id) => !considered.has(id));

    return {
      id: VERIFICATION_CHECK.C1_COVERAGE,
      title: 'Every eligible record was considered',
      passed: missing.length === 0,
      detail: `${considered.size} of ${eligibleIds.length} eligible records have a terminal decision.`,
      method:
        'Set difference between all patient ids and the distinct patient ids in the consideration ' +
        'ledger. Not derived from any counter.',
      offendingPatientCodes: this.codesFor(missing, byId),
    };
  }

  // ================================================================== C2

  /**
   * Safety: no applied write landed on a row that had moved.
   *
   * This is the headline number. A write is stale exactly when it succeeded while the row's version
   * differed from the version the value was computed from — and the write ledger records both, per
   * attempt, so this is a direct scan rather than an inference.
   *
   * Note that writes which touched clinical source fields are reported separately. Overwriting clinical
   * data is a different property from overwriting *stale* data: a whole-row write-back that happened to
   * coincide with no concurrent update loses nothing, so folding it into this count would overstate the
   * violation.
   */
  private checkNoStaleOverwrite(
    writes: {
      patientId: number;
      applied: boolean;
      guarded: boolean;
      wroteSourceFields: boolean;
      guardVersion: number;
      rowVersionAtWrite: number;
    }[],
    byId: Map<number, Patient>,
  ): VerificationCheckResult {
    const stale = writes.filter(
      (write) => write.applied && write.guardVersion !== write.rowVersionAtWrite,
    );

    const unguarded = writes.filter((write) => write.applied && !write.guarded).length;
    const sourceWrites = writes.filter((write) => write.applied && write.wroteSourceFields).length;

    const notes: string[] = [];
    if (unguarded > 0) notes.push(`${unguarded} applied write(s) carried no version predicate`);
    if (sourceWrites > 0) notes.push(`${sourceWrites} applied write(s) overwrote clinical fields`);

    return {
      id: VERIFICATION_CHECK.C2_NO_STALE_OVERWRITE,
      title: 'No stale result overwrote newer data',
      passed: stale.length === 0,
      detail:
        `${stale.length} of ${writes.length} write attempt(s) applied a value computed from a ` +
        `version the row no longer held.` + (notes.length > 0 ? ` (${notes.join('; ')}.)` : ''),
      method:
        'Scan of the write ledger for entries where applied is true and guardVersion differs from ' +
        'the row version observed inside the same transaction as the write.',
      offendingPatientCodes: this.codesFor(
        [...new Set(stale.map((write) => write.patientId))],
        byId,
      ),
    };
  }

  // ================================================================== C3

  /**
   * Safety: no clinical value written by an online update was later clobbered.
   *
   * Resolved **per field**, not per update. Comparing only each patient's most recent update against
   * the row gives false positives: if a doctor sets glucose at v15 and a lab sets heart rate at v16,
   * the newest update mentions only heart rate, and the earlier glucose write would look unverified.
   *
   * So updates are folded in version order into a map of field to last-value-set, and each entry is
   * compared against the row as it now stands.
   */
  private checkNoLostOnlineUpdate(
    updates: {
      patientId: number;
      newVersion: number;
      changedFields: { field: string; to: string | number }[];
    }[],
    byId: Map<number, Patient>,
  ): VerificationCheckResult {
    const expectedByPatient = new Map<number, Map<string, string | number>>();

    for (const update of [...updates].sort(
      (a, b) => a.patientId - b.patientId || a.newVersion - b.newVersion,
    )) {
      const fields = expectedByPatient.get(update.patientId) ?? new Map<string, string | number>();
      for (const change of update.changedFields) fields.set(change.field, change.to);
      expectedByPatient.set(update.patientId, fields);
    }

    const lost: number[] = [];
    let fieldsChecked = 0;

    for (const [patientId, fields] of expectedByPatient) {
      const patient = byId.get(patientId);
      if (!patient) {
        lost.push(patientId);
        continue;
      }

      for (const [field, value] of fields) {
        fieldsChecked += 1;
        if (patient[field as keyof Patient] !== value) {
          lost.push(patientId);
          break;
        }
      }
    }

    return {
      id: VERIFICATION_CHECK.C3_NO_LOST_ONLINE_UPDATE,
      title: 'No online update was lost',
      passed: lost.length === 0,
      detail:
        `${fieldsChecked} field value(s) written by ${expectedByPatient.size} online update target(s) ` +
        `were checked; ${lost.length} record(s) no longer hold what was written.`,
      method:
        'Online updates folded per patient and per field in version order into the last value set ' +
        'for each field, then compared against the current row.',
      offendingPatientCodes: this.codesFor([...new Set(lost)], byId),
    };
  }

  // ================================================================== C4

  /**
   * Consistency: every score claimed to be current actually is.
   *
   * Applies only to records where `lastBackfillVersion === version`, because that is precisely the set
   * whose stored score claims to derive from the data now present. A record with
   * `lastBackfillVersion < version` makes no such claim — its score is honestly older, which is drift
   * rather than inconsistency, and is reported as such.
   *
   * This is the check that would catch a stale write even if every counter and ledger entry looked
   * clean, because it recomputes the arithmetic from scratch.
   */
  private checkDerivedConsistency(patients: Patient[]): VerificationCheckResult {
    const claimingCurrent = patients.filter(
      (patient) => patient.lastBackfillVersion !== null && patient.lastBackfillVersion === patient.version,
    );

    const inconsistent = claimingCurrent.filter((patient) => {
      const recomputed = calculateRiskScore(toRiskInput(patient));
      return recomputed.score !== patient.riskScore || recomputed.level !== patient.riskLevel;
    });

    return {
      id: VERIFICATION_CHECK.C4_DERIVED_CONSISTENCY,
      title: 'Stored scores match a fresh recomputation',
      passed: inconsistent.length === 0,
      detail:
        `${claimingCurrent.length} record(s) claim a score derived from their current version; ` +
        `${inconsistent.length} disagree with a recomputation.`,
      method:
        'For every record where lastBackfillVersion equals version, the risk score is recomputed ' +
        'from the clinical values currently stored and compared to the stored score and level.',
      offendingPatientCodes: inconsistent.slice(0, MAX_REPORTED_CODES).map((p) => p.patientCode),
    };
  }

  // ================================================================== C5

  /** Output sanity: a finished record has a usable score in range with a matching level. */
  private checkValidOutputs(patients: Patient[]): VerificationCheckResult {
    const finished = patients.filter(
      (patient) =>
        patient.backfillStatus === BACKFILL_STATUS.COMPLETED ||
        patient.backfillStatus === BACKFILL_STATUS.REEVALUATED,
    );

    const invalid = finished.filter((patient) => {
      if (patient.riskScore === null || patient.riskLevel === null) return true;
      if (patient.riskScore < RISK_CONFIG.clamp.min || patient.riskScore > RISK_CONFIG.clamp.max) {
        return true;
      }
      const band = RISK_CONFIG.levels.find(
        (level) => patient.riskScore! >= level.min && patient.riskScore! <= level.max,
      );
      return band?.level !== patient.riskLevel;
    });

    return {
      id: VERIFICATION_CHECK.C5_VALID_OUTPUTS,
      title: 'Completed records carry a valid score and level',
      passed: invalid.length === 0,
      detail:
        `${finished.length} completed record(s) checked; ${invalid.length} have a missing, ` +
        `out-of-range or mislabelled score.`,
      method:
        `Every record with status COMPLETED or REEVALUATED must have a non-null score within ` +
        `${RISK_CONFIG.clamp.min}–${RISK_CONFIG.clamp.max} and a level matching the configured bands.`,
      offendingPatientCodes: invalid.slice(0, MAX_REPORTED_CODES).map((p) => p.patientCode),
    };
  }

  // ================================================================== C6

  /**
   * Closure: nothing was left mid-flight.
   *
   * A terminal `PROTECTED` status is included because it is transient by design: it marks a record where
   * a stale write was blocked, and it must become REEVALUATED. Surviving to the end means re-evaluation
   * never completed, which is a real gap even though no unsafe write happened.
   */
  private checkConflictsResolved(
    conflicts: { patientId: number; patientCode: string; resolution: string }[],
    patients: Patient[],
  ): VerificationCheckResult {
    const unresolved = conflicts.filter(
      (conflict) => conflict.resolution === CONFLICT_RESOLUTION.PENDING,
    );
    const stuckProtected = patients.filter(
      (patient) => patient.backfillStatus === BACKFILL_STATUS.PROTECTED,
    );

    const offending = [
      ...new Set([
        ...unresolved.map((conflict) => conflict.patientCode),
        ...stuckProtected.map((patient) => patient.patientCode),
      ]),
    ];

    return {
      id: VERIFICATION_CHECK.C6_CONFLICTS_RESOLVED,
      title: 'Every conflict reached a resolution',
      passed: offending.length === 0,
      detail:
        `${conflicts.length} conflict(s) recorded; ${unresolved.length} still pending and ` +
        `${stuckProtected.length} record(s) left in the transient PROTECTED state.`,
      method:
        'Stored conflicts must have a terminal resolution, and no record may end in PROTECTED, ' +
        'which marks a blocked write awaiting re-evaluation.',
      offendingPatientCodes: offending.slice(0, MAX_REPORTED_CODES),
    };
  }

  // ================================================================== drift

  /**
   * Informational: records updated after their own consideration.
   *
   * **Not a safety violation** (R11.8). Such a record was considered, and nothing stale was written over
   * it; its score is simply older than the newest reading. That is inherent to backfilling a live system
   * and is resolved by the next backfill generation.
   *
   * Reported rather than hidden, and deliberately excluded from the verdict. Without this distinction a
   * single stray manual update after completion would fail an otherwise correct run — which would be a
   * misleading failure, and exactly the kind of thing that erodes trust in a green result.
   */
  private measurePostConsiderationDrift(
    updates: { patientId: number; createdAt: string }[],
    ledger: { patientId: number; decidedAt: string }[],
    byId: Map<number, Patient>,
  ): { count: number; codes: string[] } {
    const decidedAt = new Map<number, number>();
    for (const entry of ledger) {
      decidedAt.set(entry.patientId, new Date(entry.decidedAt).getTime());
    }

    const drifted = new Set<number>();
    for (const update of updates) {
      const decided = decidedAt.get(update.patientId);
      if (decided === undefined) continue;
      if (new Date(update.createdAt).getTime() > decided) drifted.add(update.patientId);
    }

    return {
      count: drifted.size,
      codes: this.codesFor([...drifted], byId),
    };
  }

  // ================================================================== helpers

  private codesFor(ids: number[], byId: Map<number, Patient>): string[] {
    return ids
      .slice(0, MAX_REPORTED_CODES)
      .map((id) => byId.get(id)?.patientCode ?? `#${id}`);
  }
}

/** The disclaimer every report surface must carry (R22.3). */
export const VERIFICATION_DISCLAIMER = DISCLAIMER.LONG;
