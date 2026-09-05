import { DIAGNOSIS, RISK_LEVEL, type Diagnosis, type RiskLevel } from '@bg/shared';

/**
 * The synthetic risk formula, in one auditable place (R3.1).
 *
 * ⚠ This is an invented scoring formula built to demonstrate concurrent data-migration safety. It has
 * no clinical meaning whatsoever and must never be used for any medical purpose.
 *
 * Every threshold and weight lives in `RISK_CONFIG` so the formula can be reviewed as data rather
 * than read out of branching code. The calculator itself contains no numbers.
 *
 * ## Why bands are an ordered predicate list
 *
 * The blood-pressure rules need different logical connectives at different severities:
 *
 *   high     = systolic ≥ 130 **or**  diastolic ≥ 80
 *   elevated = systolic ≥ 120 **and** diastolic <  80
 *
 * A shape like `{ systolicMin, diastolicMin }` cannot express that difference — it silently forces
 * one connective for every band. So each band carries its own predicate and the bands are evaluated
 * in order, first match wins. The final band in every list is unconditional, which makes the result
 * total: there is no input for which a factor has no band.
 */

/** One severity band for a single factor. */
export interface RiskBand<TInput> {
  /** Stable identifier, surfaced in the breakdown and asserted by tests. */
  label: string;
  points: number;
  /** Evaluated in array order; the first band whose predicate holds is the one that applies. */
  test: (input: TInput) => boolean;
}

export interface BloodPressureInput {
  systolic: number;
  diastolic: number;
}

export interface RiskLevelBand {
  level: RiskLevel;
  min: number;
  max: number;
}

/**
 * Bumped whenever a threshold or weight changes.
 *
 * Stored alongside computed scores so a score can always be traced to the formula that produced it —
 * without it, changing a weight would silently invalidate every previously stored score with no way
 * to tell which formula each one came from.
 */
export const RISK_CONFIG_VERSION = 'risk-v1';

export const RISK_CONFIG = {
  version: RISK_CONFIG_VERSION,

  age: {
    unit: 'years',
    bands: [
      { label: 'under40', points: 5, test: (age: number) => age < 40 },
      { label: '40to59', points: 10, test: (age: number) => age <= 59 },
      { label: '60to69', points: 20, test: (age: number) => age <= 69 },
      { label: '70plus', points: 25, test: () => true },
    ] as RiskBand<number>[],
  },

  bloodPressure: {
    unit: 'mmHg',
    bands: [
      {
        label: 'veryHigh',
        points: 25,
        test: ({ systolic, diastolic }: BloodPressureInput) => systolic >= 160 || diastolic >= 100,
      },
      {
        label: 'high',
        points: 20,
        test: ({ systolic, diastolic }: BloodPressureInput) => systolic >= 130 || diastolic >= 80,
      },
      {
        label: 'elevated',
        points: 10,
        test: ({ systolic, diastolic }: BloodPressureInput) => systolic >= 120 && diastolic < 80,
      },
      { label: 'normal', points: 5, test: () => true },
    ] as RiskBand<BloodPressureInput>[],
  },

  glucose: {
    unit: 'mg/dL',
    bands: [
      { label: 'normal', points: 5, test: (glucose: number) => glucose < 100 },
      { label: 'elevated', points: 10, test: (glucose: number) => glucose <= 125 },
      { label: 'high', points: 20, test: (glucose: number) => glucose <= 199 },
      { label: 'veryHigh', points: 25, test: () => true },
    ] as RiskBand<number>[],
  },

  heartRate: {
    unit: 'bpm',
    bands: [
      { label: 'normal', points: 5, test: (bpm: number) => bpm >= 50 && bpm <= 90 },
      { label: 'elevated', points: 10, test: (bpm: number) => bpm >= 91 && bpm <= 110 },
      // Catches both tachycardia (> 110) and bradycardia (< 50).
      { label: 'high', points: 15, test: () => true },
    ] as RiskBand<number>[],
  },

  /**
   * Diagnosis modifier.
   *
   * Included so a diagnosis-only online update still moves the score. Without it, a doctor changing
   * only the diagnosis would produce a version bump with no score change, which would make the
   * conflict demo far less legible.
   */
  diagnosis: {
    points: {
      [DIAGNOSIS.NONE]: 0,
      [DIAGNOSIS.ASTHMA]: 3,
      [DIAGNOSIS.OBESITY]: 4,
      [DIAGNOSIS.POST_SURGICAL_RECOVERY]: 5,
      [DIAGNOSIS.HYPERTENSION]: 6,
      [DIAGNOSIS.CHRONIC_KIDNEY_DISEASE]: 8,
      [DIAGNOSIS.DIABETES_TYPE_2]: 8,
      [DIAGNOSIS.CARDIAC_ARRHYTHMIA]: 10,
    } as Record<Diagnosis, number>,
  },

  levels: [
    { level: RISK_LEVEL.LOW, min: 0, max: 30 },
    { level: RISK_LEVEL.MEDIUM, min: 31, max: 60 },
    { level: RISK_LEVEL.HIGH, min: 61, max: 100 },
  ] as RiskLevelBand[],

  clamp: { min: 0, max: 100 },
} as const;

/**
 * Attainable score range: **20 to 100**.
 *
 * The minimum is 20, not 0, because every non-diagnosis factor has a floor of 5 points. Two
 * consequences worth knowing rather than discovering later:
 *
 *  1. `LOW` (0–30) is effectively a narrow 20–30 window, so LOW patients are the healthiest tail
 *     rather than a third of the population. The seeded dataset's profile weights account for this.
 *  2. The clamp at 0/100 is a guard against a future config change, not something routine inputs hit.
 *     The maximum, 25 + 25 + 25 + 15 + 10, lands on exactly 100.
 */
export const ATTAINABLE_SCORE_RANGE = { min: 20, max: 100 } as const;

/**
 * Band boundaries that matter when designing the scripted demo.
 *
 * Because contributions are banded rather than continuous, an online update only changes the score if
 * it crosses one of these. A glucose change of 165 → 190, for instance, stays inside the `high` band
 * (126–199) and would leave the score identical — producing a version conflict with no visible score
 * difference, which would undercut the whole point of showing a re-evaluation.
 *
 * The scripted scenario therefore targets crossings such as 165 → 210 (high → veryHigh). This is
 * asserted by the demo test so the property cannot be lost by a later tweak.
 */
export const BAND_CROSSING_THRESHOLDS = {
  glucose: [100, 126, 200],
  systolic: [120, 130, 160],
  diastolic: [80, 100],
  heartRate: [50, 91, 111],
  age: [40, 60, 70],
} as const;
