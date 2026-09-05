import { describe, expect, it } from 'vitest';
import { BACKFILL_STATUS, CLINICAL_BOUNDS, DIAGNOSIS } from '@bg/shared';
import {
  generatePatients,
  partitionForIndex,
  partitionSizes,
  patientCodeFor,
} from './patientGenerator';

describe('patientGenerator', () => {
  const DEFAULTS = { totalRecords: 1000, partitionCount: 10, seed: 20260905 };

  describe('dataset shape (R2.1, R2.2)', () => {
    it('generates exactly 1000 patients across 10 partitions of 100', () => {
      const patients = generatePatients(DEFAULTS);

      expect(patients).toHaveLength(1000);

      const perPartition = new Map<number, number>();
      for (const patient of patients) {
        perPartition.set(patient.partitionIndex, (perPartition.get(patient.partitionIndex) ?? 0) + 1);
      }

      expect(perPartition.size).toBe(10);
      for (let partition = 0; partition < 10; partition += 1) {
        expect(perPartition.get(partition)).toBe(100);
      }
    });

    it('distributes remainders as evenly as possible', () => {
      // 1007 across 10 partitions: the first 7 take one extra.
      const sizes = partitionSizes(1007, 10);
      expect(sizes).toEqual([101, 101, 101, 101, 101, 101, 101, 100, 100, 100]);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(1007);

      const patients = generatePatients({ totalRecords: 1007, partitionCount: 10, seed: 1 });
      const counts = new Array(10).fill(0);
      for (const patient of patients) counts[patient.partitionIndex] += 1;
      expect(counts).toEqual(sizes);
    });

    it('assigns contiguous blocks so a partition scan is an ordered read', () => {
      expect(partitionForIndex(0, 1000, 10)).toBe(0);
      expect(partitionForIndex(99, 1000, 10)).toBe(0);
      expect(partitionForIndex(100, 1000, 10)).toBe(1);
      expect(partitionForIndex(999, 1000, 10)).toBe(9);
    });

    it('produces stable zero-padded patient codes', () => {
      expect(patientCodeFor(0)).toBe('P0001');
      expect(patientCodeFor(236)).toBe('P0237');
      expect(patientCodeFor(999)).toBe('P1000');

      const patients = generatePatients(DEFAULTS);
      expect(patients[0]?.patientCode).toBe('P0001');
      expect(patients[236]?.patientCode).toBe('P0237');
      expect(new Set(patients.map((p) => p.patientCode)).size).toBe(1000);
    });
  });

  describe('determinism (R2.6)', () => {
    it('produces a byte-identical dataset for the same seed', () => {
      const first = generatePatients(DEFAULTS);
      const second = generatePatients(DEFAULTS);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it('produces a different dataset for a different seed', () => {
      const a = generatePatients(DEFAULTS);
      const b = generatePatients({ ...DEFAULTS, seed: DEFAULTS.seed + 1 });
      expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
    });

    it('is unaffected by how many values other simulation streams consume', () => {
      // Generation draws from a forked stream, so unrelated consumers cannot shift the dataset.
      // Regenerating after creating other datasets must still match the original.
      const baseline = generatePatients(DEFAULTS);
      generatePatients({ totalRecords: 137, partitionCount: 3, seed: DEFAULTS.seed });
      generatePatients({ totalRecords: 500, partitionCount: 5, seed: 999 });
      expect(JSON.stringify(generatePatients(DEFAULTS))).toBe(JSON.stringify(baseline));
    });
  });

  describe('baseline state (R2.7)', () => {
    it('starts every patient unscored at version 1', () => {
      const patients = generatePatients(DEFAULTS);

      for (const patient of patients) {
        expect(patient.riskScore).toBeNull();
        expect(patient.riskLevel).toBeNull();
        expect(patient.lastBackfillVersion).toBeNull();
        expect(patient.backfillStatus).toBe(BACKFILL_STATUS.PENDING);
        expect(patient.version).toBe(1);
      }
    });
  });

  describe('clinical plausibility', () => {
    it('keeps every value inside the bounds an online update must also satisfy', () => {
      const patients = generatePatients(DEFAULTS);

      for (const patient of patients) {
        expect(patient.age).toBeGreaterThanOrEqual(CLINICAL_BOUNDS.age.min);
        expect(patient.age).toBeLessThanOrEqual(CLINICAL_BOUNDS.age.max);
        expect(patient.bloodPressureSystolic).toBeGreaterThanOrEqual(
          CLINICAL_BOUNDS.bloodPressureSystolic.min,
        );
        expect(patient.bloodPressureSystolic).toBeLessThanOrEqual(
          CLINICAL_BOUNDS.bloodPressureSystolic.max,
        );
        expect(patient.heartRate).toBeGreaterThanOrEqual(CLINICAL_BOUNDS.heartRate.min);
        expect(patient.heartRate).toBeLessThanOrEqual(CLINICAL_BOUNDS.heartRate.max);
        expect(patient.glucose).toBeGreaterThanOrEqual(CLINICAL_BOUNDS.glucose.min);
        expect(patient.glucose).toBeLessThanOrEqual(CLINICAL_BOUNDS.glucose.max);
      }
    });

    it('never generates a diastolic value at or above the systolic value', () => {
      for (const patient of generatePatients(DEFAULTS)) {
        expect(patient.bloodPressureDiastolic).toBeLessThan(patient.bloodPressureSystolic);
      }
    });

    it('only uses diagnoses from the shared enum', () => {
      const allowed = new Set<string>(Object.values(DIAGNOSIS));
      for (const patient of generatePatients(DEFAULTS)) {
        expect(allowed.has(patient.diagnosis)).toBe(true);
      }
    });

    it('spreads patients across severities rather than clustering in one band', () => {
      // The dataset should be interesting: a meaningful share of both mild and severe records.
      // Without this the risk distribution chart and the re-evaluation demo lose their point.
      const patients = generatePatients(DEFAULTS);

      const mild = patients.filter((p) => p.age < 40 && p.glucose < 100).length;
      const severe = patients.filter((p) => p.glucose >= 178 || p.bloodPressureSystolic >= 156).length;

      expect(mild).toBeGreaterThan(50);
      expect(severe).toBeGreaterThan(50);
    });
  });

  describe('input validation', () => {
    it('rejects more partitions than records', () => {
      expect(() => generatePatients({ totalRecords: 5, partitionCount: 10, seed: 1 })).toThrow(
        /cannot exceed/i,
      );
    });

    it('rejects non-positive record counts', () => {
      expect(() => generatePatients({ totalRecords: 0, partitionCount: 1, seed: 1 })).toThrow(
        /positive integer/i,
      );
    });
  });
});
