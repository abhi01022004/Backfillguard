import { describe, expect, it } from 'vitest';
import { DIAGNOSIS, RISK_LEVEL, type Diagnosis, type RiskInput } from '@bg/shared';
import { calculateRiskScore, toRiskInput } from './riskCalculator';
import {
  ATTAINABLE_SCORE_RANGE,
  BAND_CROSSING_THRESHOLDS,
  RISK_CONFIG,
  RISK_CONFIG_VERSION,
} from './riskConfig';

/**
 * Boundary coverage is the point of this suite (R21.2).
 *
 * An off-by-one in any threshold would silently misscore a slice of the population, and because the
 * verification engine recomputes with this same function, the error would be invisible — both sides of
 * the comparison would be wrong in the same way. So every band edge is asserted explicitly.
 */

/** A baseline scoring 20, the minimum attainable: every factor at its floor. */
const FLOOR: RiskInput = {
  age: 25,
  bloodPressureSystolic: 110,
  bloodPressureDiastolic: 70,
  heartRate: 70,
  glucose: 90,
  diagnosis: DIAGNOSIS.NONE,
};

function score(overrides: Partial<RiskInput> = {}): number {
  return calculateRiskScore({ ...FLOOR, ...overrides }).score;
}

function bandFor(factor: string, overrides: Partial<RiskInput>): string {
  const result = calculateRiskScore({ ...FLOOR, ...overrides });
  return result.breakdown.find((c) => c.factor === factor)!.band;
}

function pointsFor(factor: string, overrides: Partial<RiskInput>): number {
  const result = calculateRiskScore({ ...FLOOR, ...overrides });
  return result.breakdown.find((c) => c.factor === factor)!.points;
}

describe('calculateRiskScore', () => {
  describe('age bands (R3.3)', () => {
    it.each([
      [18, 'under40', 5],
      [39, 'under40', 5],
      [40, '40to59', 10],
      [59, '40to59', 10],
      [60, '60to69', 20],
      [69, '60to69', 20],
      [70, '70plus', 25],
      [100, '70plus', 25],
    ])('age %i -> %s (%i points)', (age, band, points) => {
      expect(bandFor('age', { age })).toBe(band);
      expect(pointsFor('age', { age })).toBe(points);
    });
  });

  describe('blood pressure bands', () => {
    it.each([
      // normal: below every elevated threshold
      [110, 70, 'normal', 5],
      [119, 79, 'normal', 5],
      // elevated requires systolic >= 120 AND diastolic < 80
      [120, 79, 'elevated', 10],
      [129, 79, 'elevated', 10],
      // high is an OR: either systolic >= 130 or diastolic >= 80
      [130, 70, 'high', 20],
      [119, 80, 'high', 20],
      [159, 99, 'high', 20],
      // veryHigh is also an OR
      [160, 70, 'veryHigh', 25],
      [119, 100, 'veryHigh', 25],
      [200, 118, 'veryHigh', 25],
    ])('%i/%i -> %s (%i points)', (systolic, diastolic, band, points) => {
      const overrides = {
        bloodPressureSystolic: systolic,
        bloodPressureDiastolic: diastolic,
      };
      expect(bandFor('bloodPressure', overrides)).toBe(band);
      expect(pointsFor('bloodPressure', overrides)).toBe(points);
    });

    it('treats elevated as AND, so a low systolic with high diastolic is not elevated', () => {
      // 118/85: systolic is under 120 so it cannot be "elevated", but diastolic >= 80 makes it high.
      // This is the case a { systolicMin, diastolicMin } config shape would get wrong.
      expect(
        bandFor('bloodPressure', {
          bloodPressureSystolic: 118,
          bloodPressureDiastolic: 85,
        }),
      ).toBe('high');
    });

    it('treats high as OR, so either reading alone is sufficient', () => {
      expect(
        bandFor('bloodPressure', { bloodPressureSystolic: 135, bloodPressureDiastolic: 70 }),
      ).toBe('high');
      expect(
        bandFor('bloodPressure', { bloodPressureSystolic: 115, bloodPressureDiastolic: 88 }),
      ).toBe('high');
    });

    it('prefers the more severe band when both could match', () => {
      // 165/105 satisfies veryHigh and high; order must give veryHigh.
      expect(
        bandFor('bloodPressure', { bloodPressureSystolic: 165, bloodPressureDiastolic: 105 }),
      ).toBe('veryHigh');
    });
  });

  describe('glucose bands', () => {
    it.each([
      [40, 'normal', 5],
      [99, 'normal', 5],
      [100, 'elevated', 10],
      [125, 'elevated', 10],
      [126, 'high', 20],
      [199, 'high', 20],
      [200, 'veryHigh', 25],
      [500, 'veryHigh', 25],
    ])('glucose %i -> %s (%i points)', (glucose, band, points) => {
      expect(bandFor('glucose', { glucose })).toBe(band);
      expect(pointsFor('glucose', { glucose })).toBe(points);
    });
  });

  describe('heart rate bands', () => {
    it.each([
      [50, 'normal', 5],
      [90, 'normal', 5],
      [91, 'elevated', 10],
      [110, 'elevated', 10],
      [111, 'high', 15],
      [200, 'high', 15],
      // Bradycardia falls into the same high band as tachycardia.
      [49, 'high', 15],
      [30, 'high', 15],
    ])('heart rate %i -> %s (%i points)', (heartRate, band, points) => {
      expect(bandFor('heartRate', { heartRate })).toBe(band);
      expect(pointsFor('heartRate', { heartRate })).toBe(points);
    });
  });

  describe('diagnosis modifier', () => {
    it('assigns a weight to every diagnosis in the shared enum', () => {
      // Guards against adding a diagnosis to the enum without a weight, which would throw at runtime.
      for (const diagnosis of Object.values(DIAGNOSIS) as Diagnosis[]) {
        expect(RISK_CONFIG.diagnosis.points[diagnosis]).toBeTypeOf('number');
        expect(() => score({ diagnosis })).not.toThrow();
      }
    });

    it('lets a diagnosis-only change move the score', () => {
      // Required so a doctor updating only the diagnosis produces a visible score change rather than
      // a version bump with no effect.
      const none = score({ diagnosis: DIAGNOSIS.NONE });
      const arrhythmia = score({ diagnosis: DIAGNOSIS.CARDIAC_ARRHYTHMIA });
      expect(arrhythmia).toBe(none + 10);
    });

    it('throws a clear error for an unknown diagnosis rather than scoring it as zero', () => {
      expect(() => calculateRiskScore({ ...FLOOR, diagnosis: 'MADE_UP' as Diagnosis })).toThrow(
        /no entry for "MADE_UP"/,
      );
    });
  });

  describe('total, clamp and level mapping (R3.4, R3.5)', () => {
    it('sums the floor case to the minimum attainable score', () => {
      expect(score()).toBe(ATTAINABLE_SCORE_RANGE.min);
      expect(score()).toBe(20);
    });

    it('reaches exactly 100 at maximum severity without needing the clamp', () => {
      const maxed = calculateRiskScore({
        age: 95,
        bloodPressureSystolic: 190,
        bloodPressureDiastolic: 115,
        heartRate: 130,
        glucose: 260,
        diagnosis: DIAGNOSIS.CARDIAC_ARRHYTHMIA,
      });

      expect(maxed.score).toBe(100);
      expect(maxed.score).toBe(ATTAINABLE_SCORE_RANGE.max);
      expect(maxed.level).toBe(RISK_LEVEL.HIGH);
    });

    it('never returns a score outside the clamp for any plausible input', () => {
      for (const age of [18, 39, 40, 70, 100]) {
        for (const glucose of [40, 99, 126, 200, 500]) {
          for (const heartRate of [30, 50, 91, 111, 200]) {
            const value = score({ age, glucose, heartRate });
            expect(value).toBeGreaterThanOrEqual(RISK_CONFIG.clamp.min);
            expect(value).toBeLessThanOrEqual(RISK_CONFIG.clamp.max);
          }
        }
      }
    });

    it.each([
      [0, RISK_LEVEL.LOW],
      [20, RISK_LEVEL.LOW],
      [30, RISK_LEVEL.LOW],
      [31, RISK_LEVEL.MEDIUM],
      [45, RISK_LEVEL.MEDIUM],
      [60, RISK_LEVEL.MEDIUM],
      [61, RISK_LEVEL.HIGH],
      [100, RISK_LEVEL.HIGH],
    ])('maps score %i to %s', (target, expectedLevel) => {
      // Drive the level directly off the config so the mapping is tested independently of whether a
      // particular input can actually produce that score.
      const band = RISK_CONFIG.levels.find((l) => target >= l.min && target <= l.max);
      expect(band?.level).toBe(expectedLevel);
    });

    it('covers the whole clamp range with level bands and leaves no gaps', () => {
      for (let value = RISK_CONFIG.clamp.min; value <= RISK_CONFIG.clamp.max; value += 1) {
        const matching = RISK_CONFIG.levels.filter((l) => value >= l.min && value <= l.max);
        expect(matching, `score ${value} should map to exactly one level`).toHaveLength(1);
      }
    });

    it('produces a real LOW/MEDIUM/HIGH spread across representative patients', () => {
      expect(calculateRiskScore(FLOOR).level).toBe(RISK_LEVEL.LOW);

      expect(
        calculateRiskScore({
          age: 54,
          bloodPressureSystolic: 126,
          bloodPressureDiastolic: 79,
          heartRate: 85,
          glucose: 112,
          diagnosis: DIAGNOSIS.OBESITY,
        }).level,
      ).toBe(RISK_LEVEL.MEDIUM);

      expect(
        calculateRiskScore({
          age: 71,
          bloodPressureSystolic: 148,
          bloodPressureDiastolic: 92,
          heartRate: 96,
          glucose: 168,
          diagnosis: DIAGNOSIS.DIABETES_TYPE_2,
        }).level,
      ).toBe(RISK_LEVEL.HIGH);
    });
  });

  describe('breakdown (R3.6)', () => {
    it('reports every factor, and the points sum to the score', () => {
      const result = calculateRiskScore({
        age: 64,
        bloodPressureSystolic: 138,
        bloodPressureDiastolic: 86,
        heartRate: 78,
        glucose: 165,
        diagnosis: DIAGNOSIS.DIABETES_TYPE_2,
      });

      expect(result.breakdown.map((c) => c.factor)).toEqual([
        'age',
        'bloodPressure',
        'glucose',
        'heartRate',
        'diagnosis',
      ]);

      const summed = result.breakdown.reduce((total, c) => total + c.points, 0);
      expect(summed).toBe(result.score);
    });

    it('includes a human-readable input summary per factor', () => {
      const result = calculateRiskScore({ ...FLOOR, bloodPressureSystolic: 138, bloodPressureDiastolic: 86 });
      const bp = result.breakdown.find((c) => c.factor === 'bloodPressure')!;
      expect(bp.inputSummary).toBe('138/86 mmHg');

      const diagnosis = calculateRiskScore({ ...FLOOR, diagnosis: DIAGNOSIS.DIABETES_TYPE_2 })
        .breakdown.find((c) => c.factor === 'diagnosis')!;
      expect(diagnosis.inputSummary).toBe('diabetes type 2');
    });

    it('stamps the config version so a stored score is traceable to its formula', () => {
      expect(calculateRiskScore(FLOOR).configVersion).toBe(RISK_CONFIG_VERSION);
    });
  });

  describe('purity and determinism (R3.2, R3.8)', () => {
    it('returns identical results across repeated calls', () => {
      const input: RiskInput = {
        age: 64,
        bloodPressureSystolic: 138,
        bloodPressureDiastolic: 86,
        heartRate: 78,
        glucose: 165,
        diagnosis: DIAGNOSIS.HYPERTENSION,
      };

      const first = calculateRiskScore(input);
      for (let i = 0; i < 50; i += 1) {
        expect(calculateRiskScore(input)).toEqual(first);
      }
    });

    it('does not mutate its input', () => {
      const input: RiskInput = { ...FLOOR };
      const snapshot = JSON.stringify(input);
      calculateRiskScore(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    });

    it('rejects non-numeric inputs instead of producing NaN', () => {
      // A NaN score would propagate into the database and quietly break every later comparison.
      expect(() =>
        calculateRiskScore({ ...FLOOR, glucose: undefined as unknown as number }),
      ).toThrow(/non-numeric glucose/);
      expect(() =>
        calculateRiskScore({ ...FLOOR, age: Number.NaN }),
      ).toThrow(/non-numeric age/);
    });
  });

  describe('band-crossing thresholds used by the scripted demo', () => {
    it('confirms a within-band change leaves the score untouched', () => {
      // The spec's illustrative example (glucose 165 -> 190) stays inside the `high` band, so it
      // produces a version conflict with no score movement. Documented here because the scripted
      // demo must cross a boundary for the re-evaluation to be visible.
      expect(score({ glucose: 165 })).toBe(score({ glucose: 190 }));
    });

    it('confirms the documented thresholds are the real band edges', () => {
      for (const threshold of BAND_CROSSING_THRESHOLDS.glucose) {
        expect(score({ glucose: threshold - 1 })).not.toBe(score({ glucose: threshold }));
      }
      for (const threshold of BAND_CROSSING_THRESHOLDS.heartRate) {
        expect(score({ heartRate: threshold - 1 })).not.toBe(score({ heartRate: threshold }));
      }
      for (const threshold of BAND_CROSSING_THRESHOLDS.age) {
        expect(score({ age: threshold - 1 })).not.toBe(score({ age: threshold }));
      }
    });

    it('can escalate MEDIUM to HIGH via a single boundary-crossing glucose change', () => {
      // The property the demo depends on: one online update visibly changing the risk level.
      // Deliberately keeps blood pressure normal. With BP in the `high` band, age 60+ and any
      // diagnosis weight, the patient is already HIGH before the update and the escalation cannot be
      // demonstrated — a constraint the scripted demo has to respect when picking its target.
      const base: RiskInput = {
        age: 62, //                       60to69   -> 20
        bloodPressureSystolic: 112, //    normal   ->  5
        bloodPressureDiastolic: 72,
        heartRate: 84, //                 normal   ->  5
        glucose: 118, //                  elevated -> 10
        diagnosis: DIAGNOSIS.CHRONIC_KIDNEY_DISEASE, //     ->  8
      };

      const before = calculateRiskScore(base);
      const after = calculateRiskScore({ ...base, glucose: 210 }); // elevated -> veryHigh (+15)

      expect(before.score).toBe(48);
      expect(before.level).toBe(RISK_LEVEL.MEDIUM);
      expect(after.score).toBe(63);
      expect(after.level).toBe(RISK_LEVEL.HIGH);
    });
  });

  describe('toRiskInput', () => {
    it('narrows a patient-shaped object to scoring inputs only', () => {
      const patientLike = {
        ...FLOOR,
        id: 1,
        patientCode: 'P0001',
        riskScore: 999,
        lastBackfillVersion: 7,
      };

      expect(Object.keys(toRiskInput(patientLike)).sort()).toEqual([
        'age',
        'bloodPressureDiastolic',
        'bloodPressureSystolic',
        'diagnosis',
        'glucose',
        'heartRate',
      ]);
    });

    it('produces the same score as passing the object directly', () => {
      const patientLike = { ...FLOOR, riskScore: 999 };
      expect(calculateRiskScore(toRiskInput(patientLike))).toEqual(calculateRiskScore(FLOOR));
    });
  });
});
