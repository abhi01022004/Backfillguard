import {
  BACKFILL_STATUS,
  CONFLICT_RESOLUTION,
  CONSIDERATION_OUTCOME,
  CLINICAL_FIELDS,
  EVENT_SEVERITY,
  EVENT_TYPE,
  type ClinicalField,
  type FieldChange,
  type Patient,
} from '@bg/shared';
import type { EventSink } from '../ports/EventSink';
import type {
  ClinicalSnapshot,
  PatientRepository,
} from '../ports/PatientRepository';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { validateGuardedWrite, VERSION_DECISION } from './VersionValidator';

/**
 * Conflict detection and re-evaluation (R10).
 *
 * When a guarded write is refused, the computed value is stale and the *only* correct response is to
 * start over from current data: re-read the row, recompute, and attempt a fresh guarded write against
 * the newly observed version. There is deliberately no code path that writes the original value after
 * a rejection — that path is what a naive backfill takes, and it is precisely the bug being
 * demonstrated.
 *
 * Re-evaluation can itself lose a race, because another update may land while it is recomputing. That
 * is handled by looping with a bounded attempt limit rather than by trusting the second attempt. If
 * the record stays contended, it ends as FAILED and is reported — never quietly resolved with a value
 * known to be out of date.
 */

export interface ConflictEngineDeps {
  repository: PatientRepository;
  events: EventSink;
  maxAttempts: number;
}

export interface ReevaluationOutcome {
  resolved: boolean;
  attempts: number;
  /** The score computed from stale data, refused. */
  oldScore: number;
  /** The score computed from current data, applied. Null when unresolved. */
  newScore: number | null;
  /** Set when the recomputation changed the risk band, which is the visible impact. */
  levelChanged: boolean;
  reason: string | null;
}

/**
 * Diffs two clinical snapshots.
 *
 * Drives the "old input → current input" display on a conflict card. Comparing the snapshot the
 * computation used against the row as it now stands is what turns an abstract version mismatch into a
 * concrete statement: *this lab value changed underneath us*.
 */
export function diffClinicalFields(
  before: ClinicalSnapshot,
  after: ClinicalSnapshot,
): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const field of CLINICAL_FIELDS) {
    const from = before[field as keyof ClinicalSnapshot];
    const to = after[field as keyof ClinicalSnapshot];
    if (from !== to) {
      changes.push({ field: field as ClinicalField, from, to });
    }
  }

  return changes;
}

export function snapshotOf(patient: Patient | ClinicalSnapshot): ClinicalSnapshot {
  return {
    age: patient.age,
    bloodPressureSystolic: patient.bloodPressureSystolic,
    bloodPressureDiastolic: patient.bloodPressureDiastolic,
    heartRate: patient.heartRate,
    glucose: patient.glucose,
    diagnosis: patient.diagnosis,
  };
}

export class ConflictEngine {
  constructor(private readonly deps: ConflictEngineDeps) {}

  /**
   * Records a refused stale write and resolves it by recomputation.
   *
   * Returns the outcome so the caller can attribute the right consideration entry. Note the ordering:
   * the conflict is persisted *before* re-evaluation is attempted, so a crash midway leaves durable
   * evidence that a conflict existed rather than losing it.
   */
  async handleStaleWrite(params: {
    jobId: string;
    patient: Patient;
    staleSnapshot: ClinicalSnapshot;
    staleScore: number;
    sourceVersion: number;
    currentVersion: number;
    phase: string;
  }): Promise<ReevaluationOutcome> {
    const { jobId, patient, staleSnapshot, staleScore, sourceVersion, currentVersion, phase } =
      params;

    // Re-read so the diff reflects what the row actually holds now, not what we assumed.
    const current = (await this.deps.repository.findById(patient.id)) ?? patient;
    const changedFields = diffClinicalFields(staleSnapshot, snapshotOf(current));

    const conflictId = await this.deps.repository.recordConflict({
      jobId,
      patientId: patient.id,
      sourceVersion,
      currentVersion,
      oldScore: staleScore,
      changedFields,
    });

    // Marks the record as one where a stale write was blocked. Transient: it must become REEVALUATED.
    await this.deps.repository.markStatus(patient.id, BACKFILL_STATUS.PROTECTED);

    this.deps.events.emit({
      type: EVENT_TYPE.CONFLICT_DETECTED,
      severity: EVENT_SEVERITY.WARNING,
      jobId,
      patientCode: patient.patientCode,
      partitionIndex: patient.partitionIndex,
      message:
        `Conflict on ${patient.patientCode}: backfill read v${sourceVersion}, ` +
        `database is now v${currentVersion}.`,
      payload: {
        sourceVersion,
        currentVersion,
        staleScore,
        changedFields,
      },
    });

    this.deps.events.emit({
      type: EVENT_TYPE.STALE_RESULT_REJECTED,
      severity: EVENT_SEVERITY.WARNING,
      jobId,
      patientCode: patient.patientCode,
      partitionIndex: patient.partitionIndex,
      message: `Stale result (score ${staleScore}) refused for ${patient.patientCode} — newer data preserved.`,
      payload: { staleScore, sourceVersion, currentVersion },
    });

    const outcome = await this.reevaluate({
      jobId,
      patientId: patient.id,
      patientCode: patient.patientCode,
      partitionIndex: patient.partitionIndex,
      staleScore,
      phase,
    });

    await this.deps.repository.resolveConflict(
      conflictId,
      outcome.resolved ? CONFLICT_RESOLUTION.REEVALUATED : CONFLICT_RESOLUTION.FAILED,
      outcome.newScore,
    );

    return outcome;
  }

  /**
   * Re-reads, recomputes and re-applies under a fresh guard, retrying while the row keeps moving.
   *
   * Each attempt reads the version it will guard against, so a retry is never a blind repeat: it is a
   * new computation from newer data.
   */
  async reevaluate(params: {
    jobId: string;
    patientId: number;
    patientCode: string;
    partitionIndex: number;
    staleScore: number;
    phase: string;
  }): Promise<ReevaluationOutcome> {
    const { jobId, patientId, patientCode, partitionIndex, staleScore, phase } = params;

    this.deps.events.emit({
      type: EVENT_TYPE.RE_EVALUATION_STARTED,
      severity: EVENT_SEVERITY.INFO,
      jobId,
      patientCode,
      partitionIndex,
      message: `Re-evaluating ${patientCode} from current data.`,
      payload: { rejectedScore: staleScore },
    });

    let attempts = 0;
    let lastReason: string | null = null;

    while (attempts < this.deps.maxAttempts) {
      attempts += 1;

      const fresh = await this.deps.repository.findById(patientId);
      if (!fresh) {
        lastReason = `Patient ${patientCode} disappeared during re-evaluation.`;
        break;
      }

      const staleLevel = fresh.riskLevel;
      const recomputed = calculateRiskScore(toRiskInput(fresh));

      const result = await this.deps.repository.applyGuarded(
        patientId,
        fresh.version,
        {
          riskScore: recomputed.score,
          riskLevel: recomputed.level,
          backfillStatus: BACKFILL_STATUS.REEVALUATED,
        },
        { jobId, guarded: true, wroteSourceFields: false, scoreWritten: recomputed.score, phase },
      );

      const validation = validateGuardedWrite(result);

      if (validation.decision === VERSION_DECISION.APPLIED) {
        await this.deps.repository.recordConsideration({
          jobId,
          patientId,
          outcome: CONSIDERATION_OUTCOME.REEVALUATED_APPLIED,
          sourceVersion: fresh.version,
          appliedVersion: fresh.version,
          attempts,
          phase,
          reason: null,
        });

        const levelChanged = staleLevel !== null && staleLevel !== recomputed.level;

        this.deps.events.emit({
          type: EVENT_TYPE.RE_EVALUATION_COMPLETED,
          severity: EVENT_SEVERITY.SUCCESS,
          jobId,
          patientCode,
          partitionIndex,
          message:
            `${patientCode} re-evaluated: score ${staleScore} → ${recomputed.score}` +
            `${levelChanged ? ` (${staleLevel} → ${recomputed.level})` : ''}. ` +
            `Stale overwrite prevented.`,
          payload: {
            oldScore: staleScore,
            newScore: recomputed.score,
            newLevel: recomputed.level,
            levelChanged,
            appliedVersion: fresh.version,
            attempts,
            resolution: CONFLICT_RESOLUTION.REEVALUATED,
            staleOverwrite: 'PREVENTED',
          },
        });

        return {
          resolved: true,
          attempts,
          oldScore: staleScore,
          newScore: recomputed.score,
          levelChanged,
          reason: null,
        };
      }

      // Another update landed while we were recomputing. Loop and recompute from the newer data.
      lastReason =
        `Row moved again during re-evaluation (guarded v${validation.sourceVersion}, ` +
        `found v${validation.currentVersion}).`;
    }

    /**
     * Bounded retries exhausted. The record is recorded as FAILED and surfaced.
     *
     * Deliberately *not* falling back to writing the stale value: an unresolved record is a visible,
     * honest gap, whereas a stale write would be a silent correctness violation that verification
     * would then have to catch.
     */
    await this.deps.repository.recordConsideration({
      jobId,
      patientId,
      outcome: CONSIDERATION_OUTCOME.FAILED,
      sourceVersion: 0,
      appliedVersion: null,
      attempts,
      phase,
      reason: lastReason,
    });

    this.deps.events.emit({
      type: EVENT_TYPE.RECORD_FAILED,
      severity: EVENT_SEVERITY.CRITICAL,
      jobId,
      patientCode,
      partitionIndex,
      message:
        `${patientCode} could not be re-evaluated after ${attempts} attempts. ` +
        `No stale value was written.`,
      payload: { attempts, reason: lastReason, rejectedScore: staleScore },
    });

    return {
      resolved: false,
      attempts,
      oldScore: staleScore,
      newScore: null,
      levelChanged: false,
      reason: lastReason,
    };
  }
}
