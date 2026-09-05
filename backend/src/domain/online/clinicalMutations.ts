import {
  ACTOR_TYPE,
  CLINICAL_BOUNDS,
  DIAGNOSIS,
  type ActorType,
  type ClinicalField,
  type Diagnosis,
} from '@bg/shared';
import type { Rng } from '../../lib/rng';
import type { ClinicalSnapshot } from '../ports/PatientRepository';
import { BAND_CROSSING_THRESHOLDS, RISK_CONFIG } from '../risk/riskConfig';

/**
 * Generates the clinical changes an online update applies.
 *
 * Two properties matter here, and both are deliberate rather than incidental.
 *
 * ## 1. Changes cross a scoring band
 *
 * Risk contributions are banded, so nudging glucose from 165 to 190 leaves the score *identical* — both
 * sit inside the `high` band. An update like that still bumps the version and still causes a conflict,
 * but the re-evaluated score comes out the same as the rejected one, which makes the demo look like
 * nothing happened.
 *
 * So mutations escalate into the next band up wherever headroom exists. The version conflict then has
 * a visible consequence: the score moves, and often the risk level with it.
 *
 * ## 2. Each actor touches plausible fields
 *
 * A laboratory reports glucose; a nurse records observations; a doctor revises a diagnosis. Restricting
 * each actor to its own fields costs nothing and makes the live activity feed read like a hospital
 * rather than a random number generator.
 */

/** Which fields each actor is allowed to change. A subset of the shared whitelist (R6.2). */
export const ACTOR_FIELDS: Record<ActorType, readonly ClinicalField[]> = {
  [ACTOR_TYPE.LAB]: ['glucose'],
  [ACTOR_TYPE.NURSE]: ['heartRate', 'bloodPressureSystolic', 'bloodPressureDiastolic'],
  [ACTOR_TYPE.DOCTOR]: ['diagnosis', 'bloodPressureSystolic', 'bloodPressureDiastolic', 'glucose'],
};

/**
 * Picks a value in the next band above `current`.
 *
 * Thresholds are the lower edges of each band. Landing just inside the next one guarantees the score
 * changes; a small random offset keeps successive updates from producing identical values while staying
 * reproducible, since the offset comes from the seeded generator.
 *
 * Returns null when the value already sits in the top band, so the caller can choose another field
 * rather than emit a no-op update that would burn a version for nothing.
 */
export function escalateAcrossBand(
  current: number,
  thresholds: readonly number[],
  bound: { min: number; max: number },
  rng: Rng,
): number | null {
  const nextThreshold = thresholds.find((threshold) => current < threshold);
  if (nextThreshold === undefined) return null;

  // Land 0-8 above the boundary, clamped to the field's server-side bounds.
  const target = nextThreshold + rng.int(0, 8);
  const value = Math.min(bound.max, Math.max(bound.min, target));

  return value === current ? null : value;
}

/** Picks a diagnosis with a strictly higher risk weight, or null if already at the top. */
export function escalateDiagnosis(current: Diagnosis, rng: Rng): Diagnosis | null {
  const currentWeight = RISK_CONFIG.diagnosis.points[current] ?? 0;

  const heavier = (Object.values(DIAGNOSIS) as Diagnosis[]).filter(
    (candidate) => (RISK_CONFIG.diagnosis.points[candidate] ?? 0) > currentWeight,
  );

  if (heavier.length === 0) return null;
  return rng.pick(heavier);
}

/**
 * The fields an online update may set, precisely typed.
 *
 * Spelled out rather than derived as `Partial<Record<ClinicalField, string | number>>`, because that
 * looser form loses the fact that `diagnosis` is a `Diagnosis` and the rest are numbers — which would
 * push the distinction into a runtime cast at the repository boundary. Note the absence of `age`: it is
 * not in the online-updatable whitelist, and the type says so.
 */
export interface ClinicalChanges {
  bloodPressureSystolic?: number;
  bloodPressureDiastolic?: number;
  heartRate?: number;
  glucose?: number;
  diagnosis?: Diagnosis;
}

/**
 * Builds an escalating change set for the given actor.
 *
 * Tries each of the actor's fields in a shuffled order and returns the first that can escalate. Null
 * means this patient is already at the ceiling on every field the actor controls — rare, but real for
 * the most severe synthetic records, and worth handling explicitly rather than emitting an update that
 * changes nothing.
 */
export function buildEscalatingChanges(
  actor: ActorType,
  patient: ClinicalSnapshot,
  rng: Rng,
): ClinicalChanges | null {
  const fields = [...ACTOR_FIELDS[actor]];

  // Deterministic shuffle so the chosen field varies between updates but is reproducible from the seed.
  for (let i = fields.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [fields[i], fields[j]] = [fields[j]!, fields[i]!];
  }

  for (const field of fields) {
    switch (field) {
      case 'glucose': {
        const value = escalateAcrossBand(
          patient.glucose,
          BAND_CROSSING_THRESHOLDS.glucose,
          CLINICAL_BOUNDS.glucose,
          rng,
        );
        if (value !== null) return { glucose: value };
        break;
      }

      case 'heartRate': {
        const value = escalateAcrossBand(
          patient.heartRate,
          BAND_CROSSING_THRESHOLDS.heartRate,
          CLINICAL_BOUNDS.heartRate,
          rng,
        );
        if (value !== null) return { heartRate: value };
        break;
      }

      case 'bloodPressureSystolic': {
        const value = escalateAcrossBand(
          patient.bloodPressureSystolic,
          BAND_CROSSING_THRESHOLDS.systolic,
          CLINICAL_BOUNDS.bloodPressureSystolic,
          rng,
        );
        // Diastolic follows systolic upward, since a realistic reading moves together and a systolic
        // jump alone can leave the pair physiologically odd.
        if (value !== null) {
          const diastolic = Math.min(
            CLINICAL_BOUNDS.bloodPressureDiastolic.max,
            Math.max(patient.bloodPressureDiastolic, Math.round(value * 0.62)),
          );
          return diastolic === patient.bloodPressureDiastolic
            ? { bloodPressureSystolic: value }
            : { bloodPressureSystolic: value, bloodPressureDiastolic: diastolic };
        }
        break;
      }

      case 'bloodPressureDiastolic': {
        const value = escalateAcrossBand(
          patient.bloodPressureDiastolic,
          BAND_CROSSING_THRESHOLDS.diastolic,
          CLINICAL_BOUNDS.bloodPressureDiastolic,
          rng,
        );
        // Keep diastolic below systolic; a pair that inverts would be obvious nonsense on screen.
        if (value !== null && value < patient.bloodPressureSystolic) {
          return { bloodPressureDiastolic: value };
        }
        break;
      }

      case 'diagnosis': {
        const value = escalateDiagnosis(patient.diagnosis, rng);
        if (value !== null) return { diagnosis: value };
        break;
      }
    }
  }

  return null;
}

/** Short human-readable label for the event feed, e.g. "Lab" or "Doctor". */
export function actorLabel(actor: ActorType): string {
  return actor.charAt(0) + actor.slice(1).toLowerCase();
}
