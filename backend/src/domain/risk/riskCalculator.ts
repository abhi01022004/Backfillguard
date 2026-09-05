import type {
  RiskFactorContribution,
  RiskInput,
  RiskLevel,
  RiskResult,
} from '@bg/shared';
import {
  RISK_CONFIG,
  RISK_CONFIG_VERSION,
  type BloodPressureInput,
  type RiskBand,
} from './riskConfig';

/**
 * The synthetic risk score (R3.2–R3.6).
 *
 * ⚠ Synthetic Hackathon Risk Score — Not for Clinical Use.
 *
 * Pure by construction: no I/O, no database, no clock, no randomness. Identical inputs always produce
 * an identical result, which is what makes the score usable as *evidence*. The verification engine
 * later re-runs this function against the row currently in the database and compares it to the stored
 * score; if the two disagree, the stored value was derived from data that has since changed. That
 * check only means something because this function is deterministic and depends on nothing else.
 *
 * All thresholds and weights live in `riskConfig.ts`. There are deliberately no numeric literals here.
 */

/**
 * Resolves the first matching band.
 *
 * Every band list ends with an unconditional predicate, so a miss is impossible for valid config. The
 * throw guards against a future edit removing that catch-all — failing loudly at the point of the bug
 * rather than silently scoring a factor as zero.
 */
function resolveBand<T>(bands: readonly RiskBand<T>[], input: T, factorName: string): RiskBand<T> {
  for (const band of bands) {
    if (band.test(input)) return band;
  }

  throw new Error(
    `RISK_CONFIG.${factorName} has no band matching ${JSON.stringify(input)}. ` +
      `The last band in every factor must be unconditional.`,
  );
}

function resolveLevel(score: number): RiskLevel {
  for (const band of RISK_CONFIG.levels) {
    if (score >= band.min && score <= band.max) return band.level;
  }

  throw new Error(
    `RISK_CONFIG.levels does not cover score ${score}. Level bands must span the clamp range ` +
      `${RISK_CONFIG.clamp.min}–${RISK_CONFIG.clamp.max}.`,
  );
}

function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`calculateRiskScore received a non-numeric ${field}: ${String(value)}`);
  }
  return value;
}

/**
 * Computes the score, its level, and a per-factor breakdown explaining how it was reached.
 *
 * The breakdown exists because a bare number is not defensible. When a conflict is re-evaluated and
 * the score moves, the UI needs to show *which* factor moved and why, otherwise the demo asks a judge
 * to take the change on faith.
 */
export function calculateRiskScore(input: RiskInput): RiskResult {
  const age = assertFiniteNumber(input.age, 'age');
  const systolic = assertFiniteNumber(input.bloodPressureSystolic, 'bloodPressureSystolic');
  const diastolic = assertFiniteNumber(input.bloodPressureDiastolic, 'bloodPressureDiastolic');
  const heartRate = assertFiniteNumber(input.heartRate, 'heartRate');
  const glucose = assertFiniteNumber(input.glucose, 'glucose');

  const bloodPressure: BloodPressureInput = { systolic, diastolic };

  const ageBand = resolveBand(RISK_CONFIG.age.bands, age, 'age');
  const bpBand = resolveBand(RISK_CONFIG.bloodPressure.bands, bloodPressure, 'bloodPressure');
  const glucoseBand = resolveBand(RISK_CONFIG.glucose.bands, glucose, 'glucose');
  const heartRateBand = resolveBand(RISK_CONFIG.heartRate.bands, heartRate, 'heartRate');

  const diagnosisPoints = RISK_CONFIG.diagnosis.points[input.diagnosis];
  if (diagnosisPoints === undefined) {
    throw new Error(
      `RISK_CONFIG.diagnosis.points has no entry for "${String(input.diagnosis)}". ` +
        `Every diagnosis in the shared enum needs a weight.`,
    );
  }

  const breakdown: RiskFactorContribution[] = [
    {
      factor: 'age',
      band: ageBand.label,
      points: ageBand.points,
      inputSummary: `${age} ${RISK_CONFIG.age.unit}`,
    },
    {
      factor: 'bloodPressure',
      band: bpBand.label,
      points: bpBand.points,
      inputSummary: `${systolic}/${diastolic} ${RISK_CONFIG.bloodPressure.unit}`,
    },
    {
      factor: 'glucose',
      band: glucoseBand.label,
      points: glucoseBand.points,
      inputSummary: `${glucose} ${RISK_CONFIG.glucose.unit}`,
    },
    {
      factor: 'heartRate',
      band: heartRateBand.label,
      points: heartRateBand.points,
      inputSummary: `${heartRate} ${RISK_CONFIG.heartRate.unit}`,
    },
    {
      factor: 'diagnosis',
      band: input.diagnosis,
      points: diagnosisPoints,
      inputSummary: input.diagnosis.replace(/_/g, ' ').toLowerCase(),
    },
  ];

  const raw = breakdown.reduce((total, contribution) => total + contribution.points, 0);
  const score = Math.min(RISK_CONFIG.clamp.max, Math.max(RISK_CONFIG.clamp.min, raw));

  return {
    score,
    level: resolveLevel(score),
    breakdown,
    configVersion: RISK_CONFIG_VERSION,
  };
}

/**
 * Narrows a patient-shaped object to just the scoring inputs.
 *
 * Used so callers cannot accidentally hand the calculator a whole patient row and have derived fields
 * (`riskScore`, `lastBackfillVersion`) leak into a computation that is supposed to depend only on
 * clinical source data.
 */
export function toRiskInput(patient: RiskInput): RiskInput {
  return {
    age: patient.age,
    bloodPressureSystolic: patient.bloodPressureSystolic,
    bloodPressureDiastolic: patient.bloodPressureDiastolic,
    heartRate: patient.heartRate,
    glucose: patient.glucose,
    diagnosis: patient.diagnosis,
  };
}
