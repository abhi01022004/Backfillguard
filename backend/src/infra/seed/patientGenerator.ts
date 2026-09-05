import {
  BACKFILL_STATUS,
  CLINICAL_BOUNDS,
  DIAGNOSIS,
  type Diagnosis,
} from '@bg/shared';
import { createRng, type Rng } from '../../lib/rng';
import { FIRST_NAMES, LAST_NAMES } from './namePools';

/**
 * Deterministic synthetic patient generation (R2.1, R2.2, R2.5, R2.6).
 *
 * Everything is derived from a single seed, so the same seed reproduces the dataset exactly. All
 * randomness flows through the injected `Rng` port; there is no `Math.random()` anywhere.
 */

/** A generated patient, before it is persisted. Derived fields are deliberately empty. */
export interface GeneratedPatient {
  patientCode: string;
  name: string;
  age: number;
  bloodPressureSystolic: number;
  bloodPressureDiastolic: number;
  heartRate: number;
  glucose: number;
  diagnosis: Diagnosis;
  partitionIndex: number;
  version: number;
  riskScore: null;
  riskLevel: null;
  backfillStatus: typeof BACKFILL_STATUS.PENDING;
  lastBackfillVersion: null;
}

export interface GenerateOptions {
  totalRecords: number;
  partitionCount: number;
  seed: number;
}

/**
 * Clinical value profiles.
 *
 * Patients are generated across a deliberate spread of severity rather than uniformly at random, so
 * the dataset produces a realistic mix of LOW/MEDIUM/HIGH scores. A dataset where every record
 * landed in one band would make the risk distribution chart and the re-evaluation demo far less
 * legible.
 *
 * `weight` values are relative and need not sum to anything in particular.
 */
interface ClinicalProfile {
  label: string;
  weight: number;
  ageRange: [number, number];
  systolicRange: [number, number];
  diastolicRange: [number, number];
  heartRateRange: [number, number];
  glucoseRange: [number, number];
  diagnoses: readonly Diagnosis[];
}

const PROFILES: readonly ClinicalProfile[] = [
  {
    label: 'healthy-young',
    weight: 26,
    ageRange: [18, 39],
    systolicRange: [102, 119],
    diastolicRange: [62, 79],
    heartRateRange: [58, 88],
    glucoseRange: [72, 98],
    diagnoses: [DIAGNOSIS.NONE, DIAGNOSIS.ASTHMA],
  },
  {
    label: 'healthy-midlife',
    weight: 20,
    ageRange: [40, 59],
    systolicRange: [108, 126],
    diastolicRange: [66, 82],
    heartRateRange: [60, 92],
    glucoseRange: [80, 110],
    diagnoses: [DIAGNOSIS.NONE, DIAGNOSIS.OBESITY, DIAGNOSIS.ASTHMA],
  },
  {
    label: 'borderline',
    weight: 22,
    ageRange: [45, 69],
    systolicRange: [124, 142],
    diastolicRange: [78, 92],
    heartRateRange: [70, 104],
    glucoseRange: [104, 138],
    diagnoses: [DIAGNOSIS.HYPERTENSION, DIAGNOSIS.OBESITY, DIAGNOSIS.POST_SURGICAL_RECOVERY],
  },
  {
    label: 'elevated-senior',
    weight: 20,
    ageRange: [60, 79],
    systolicRange: [134, 158],
    diastolicRange: [84, 98],
    heartRateRange: [72, 108],
    glucoseRange: [128, 186],
    diagnoses: [
      DIAGNOSIS.HYPERTENSION,
      DIAGNOSIS.DIABETES_TYPE_2,
      DIAGNOSIS.CHRONIC_KIDNEY_DISEASE,
    ],
  },
  {
    label: 'high-acuity',
    weight: 12,
    ageRange: [66, 94],
    systolicRange: [156, 196],
    diastolicRange: [96, 118],
    heartRateRange: [96, 132],
    glucoseRange: [178, 268],
    diagnoses: [
      DIAGNOSIS.CARDIAC_ARRHYTHMIA,
      DIAGNOSIS.DIABETES_TYPE_2,
      DIAGNOSIS.CHRONIC_KIDNEY_DISEASE,
    ],
  },
];

const TOTAL_PROFILE_WEIGHT = PROFILES.reduce((sum, p) => sum + p.weight, 0);

function pickProfile(rng: Rng): ClinicalProfile {
  let roll = rng.next() * TOTAL_PROFILE_WEIGHT;
  for (const profile of PROFILES) {
    roll -= profile.weight;
    if (roll < 0) return profile;
  }
  // Unreachable in practice; keeps the return type non-optional without a non-null assertion.
  return PROFILES[PROFILES.length - 1]!;
}

/** Clamp to the same server-side clinical bounds an online update must satisfy (R22.7). */
function clampToClinicalBounds(patient: {
  bloodPressureSystolic: number;
  bloodPressureDiastolic: number;
  heartRate: number;
  glucose: number;
  age: number;
}): void {
  const clamp = (value: number, bound: { min: number; max: number }): number =>
    Math.min(bound.max, Math.max(bound.min, value));

  patient.age = clamp(patient.age, CLINICAL_BOUNDS.age);
  patient.bloodPressureSystolic = clamp(
    patient.bloodPressureSystolic,
    CLINICAL_BOUNDS.bloodPressureSystolic,
  );
  patient.bloodPressureDiastolic = clamp(
    patient.bloodPressureDiastolic,
    CLINICAL_BOUNDS.bloodPressureDiastolic,
  );
  patient.heartRate = clamp(patient.heartRate, CLINICAL_BOUNDS.heartRate);
  patient.glucose = clamp(patient.glucose, CLINICAL_BOUNDS.glucose);
}

/**
 * Assigns a record index to a partition, distributing as evenly as possible (R2.2).
 *
 * Contiguous blocks rather than round-robin, because the engine scans partition by partition and
 * contiguous ranges make that scan a simple ordered read. When the record count does not divide
 * evenly, the first `remainder` partitions each take one extra record.
 */
export function partitionForIndex(
  index: number,
  totalRecords: number,
  partitionCount: number,
): number {
  const base = Math.floor(totalRecords / partitionCount);
  const remainder = totalRecords % partitionCount;

  let cursor = 0;
  for (let partition = 0; partition < partitionCount; partition += 1) {
    const size = base + (partition < remainder ? 1 : 0);
    if (index < cursor + size) return partition;
    cursor += size;
  }

  throw new Error(
    `Cannot assign index ${index} to a partition (totalRecords=${totalRecords}, partitionCount=${partitionCount})`,
  );
}

/** Expected record count for each partition, used to validate distribution and drive the UI. */
export function partitionSizes(totalRecords: number, partitionCount: number): number[] {
  const base = Math.floor(totalRecords / partitionCount);
  const remainder = totalRecords % partitionCount;
  return Array.from(
    { length: partitionCount },
    (_, partition) => base + (partition < remainder ? 1 : 0),
  );
}

/** Zero-padded, stable patient code: record 0 becomes `P0001`. */
export function patientCodeFor(index: number): string {
  return `P${String(index + 1).padStart(4, '0')}`;
}

/**
 * Generates the full synthetic dataset.
 *
 * Every patient starts unscored (`riskScore` null, `backfillStatus` PENDING,
 * `lastBackfillVersion` null) at `version` 1, which is what makes the backfill have real work to do
 * and lets coverage be measured from a clean baseline (R2.7).
 */
export function generatePatients(options: GenerateOptions): GeneratedPatient[] {
  const { totalRecords, partitionCount, seed } = options;

  if (!Number.isInteger(totalRecords) || totalRecords < 1) {
    throw new Error(`totalRecords must be a positive integer, received ${totalRecords}`);
  }
  if (!Number.isInteger(partitionCount) || partitionCount < 1) {
    throw new Error(`partitionCount must be a positive integer, received ${partitionCount}`);
  }
  if (partitionCount > totalRecords) {
    throw new Error(
      `partitionCount (${partitionCount}) cannot exceed totalRecords (${totalRecords}); ` +
        `every partition must hold at least one record.`,
    );
  }

  // A dedicated stream, so changes elsewhere in the simulation cannot shift generated data.
  const rng = createRng(seed).fork('patient-generator');

  const patients: GeneratedPatient[] = [];

  for (let index = 0; index < totalRecords; index += 1) {
    const profile = pickProfile(rng);

    const patient: GeneratedPatient = {
      patientCode: patientCodeFor(index),
      name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      age: rng.int(profile.ageRange[0], profile.ageRange[1]),
      bloodPressureSystolic: rng.int(profile.systolicRange[0], profile.systolicRange[1]),
      bloodPressureDiastolic: rng.int(profile.diastolicRange[0], profile.diastolicRange[1]),
      heartRate: rng.int(profile.heartRateRange[0], profile.heartRateRange[1]),
      glucose: rng.int(profile.glucoseRange[0], profile.glucoseRange[1]),
      diagnosis: rng.pick(profile.diagnoses),
      partitionIndex: partitionForIndex(index, totalRecords, partitionCount),
      version: 1,
      riskScore: null,
      riskLevel: null,
      backfillStatus: BACKFILL_STATUS.PENDING,
      lastBackfillVersion: null,
    };

    clampToClinicalBounds(patient);

    // Guard against a profile producing a physiologically nonsensical pair after clamping.
    if (patient.bloodPressureDiastolic >= patient.bloodPressureSystolic) {
      patient.bloodPressureDiastolic = patient.bloodPressureSystolic - 20;
    }

    patients.push(patient);
  }

  return patients;
}
