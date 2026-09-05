import { beforeAll, describe, expect, it } from 'vitest';
import { BACKFILL_MODE, VERIFICATION_VERDICT, type ComparisonResult } from '@bg/shared';
import { calculateRiskScore, toRiskInput } from '../risk/riskCalculator';
import { FAILURE_SCENARIO, UNCONTENDED_SCENARIO } from '../scenario/failureScenario';
import { ComparisonHarness } from './ComparisonHarness';

/**
 * The comparison, and the honesty checks around it (R12, R19).
 *
 * The headline assertions are that the naive engine loses clinical data on the same scenario the guarded
 * engine survives. Just as important is the control run: with no contention the two engines agree exactly,
 * which shows the difference comes from the guard rather than from the naive engine being rigged.
 */

const harness = new ComparisonHarness({ nowIso: () => '2026-09-05T12:00:00.000Z' });

describe('naive versus guarded comparison', () => {
  let result: ComparisonResult;

  beforeAll(async () => {
    result = await harness.run(FAILURE_SCENARIO);
  }, 60_000);

  it('runs both engines on the same scenario and seed', () => {
    expect(result.scenarioName).toBe(FAILURE_SCENARIO.name);
    expect(result.seed).toBe(FAILURE_SCENARIO.seed);
    expect(result.guarded.mode).toBe(BACKFILL_MODE.GUARDED);
    expect(result.naive.mode).toBe(BACKFILL_MODE.NAIVE);
  });

  it('gives both engines full coverage, so the comparison is about safety alone', () => {
    // Deliberate: if the naive engine also lost on liveness, the point about safety would be muddied.
    expect(result.guarded.metrics.coveragePercent).toBe(100);
    expect(result.naive.metrics.coveragePercent).toBe(100);
    expect(result.guarded.metrics.missedRecords).toBe(0);
    expect(result.naive.metrics.missedRecords).toBe(0);
  });

  it('shows the naive engine committing stale overwrites', () => {
    expect(result.naive.metrics.staleOverwrites).toBeGreaterThan(0);
  });

  it('shows the naive engine losing clinical data', () => {
    expect(result.naive.metrics.lostOnlineUpdates).toBeGreaterThan(0);
  });

  it('shows BackfillGuard with zero on both safety metrics', () => {
    expect(result.guarded.metrics.staleOverwrites).toBe(0);
    expect(result.guarded.metrics.lostOnlineUpdates).toBe(0);
  });

  it('produces opposite verdicts from the same auditor', () => {
    // Same VerificationEngine scoring both sides. If the guarded engine were flattered by a friendlier
    // auditor the whole comparison would be worthless.
    expect(result.guarded.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(result.naive.verdict).toBe(VERIFICATION_VERDICT.VERIFICATION_FAILED);
  });

  it('shows the guarded engine detecting and re-evaluating conflicts', () => {
    expect(result.guarded.metrics.conflicts).toBeGreaterThan(0);
    expect(result.guarded.metrics.reevaluated).toBe(result.guarded.metrics.conflicts);
    expect(result.guarded.metrics.staleWriteAttemptsBlocked).toBeGreaterThan(0);
  });

  it('shows the naive engine detecting no conflicts at all', () => {
    // Not because none occurred — because it never looks.
    expect(result.naive.metrics.conflicts).toBe(0);
    expect(result.naive.metrics.staleWriteAttemptsBlocked).toBe(0);
  });

  describe('spotlight patient', () => {
    it('names a real patient and a real field', () => {
      expect(result.spotlight.patientCode).toMatch(/^P\d{4}$/);
      expect(result.spotlight.field).toBeTruthy();
      expect(result.spotlight.originalValue).not.toBe(result.spotlight.onlineUpdatedValue);
    });

    it('shows the naive engine reverting the clinician value', () => {
      expect(result.spotlight.naive.lostTheOnlineUpdate).toBe(true);
      expect(result.spotlight.naive.finalValue).toBe(result.spotlight.originalValue);
      expect(result.spotlight.naive.finalValue).not.toBe(result.spotlight.onlineUpdatedValue);
    });

    it('shows BackfillGuard preserving it and re-evaluating', () => {
      expect(result.spotlight.guarded.lostTheOnlineUpdate).toBe(false);
      expect(result.spotlight.guarded.finalValue).toBe(result.spotlight.onlineUpdatedValue);
      expect(result.spotlight.guarded.conflictDetected).toBe(true);
      expect(result.spotlight.guarded.reevaluated).toBe(true);
      expect(result.spotlight.guarded.staleOverwrite).toBe(false);
    });

    it('gives the two engines different final scores for the same patient', () => {
      expect(result.spotlight.guarded.finalScore).not.toBe(result.spotlight.naive.finalScore);
    });
  });

  it('is reproducible from the same seed', async () => {
    const second = await harness.run(FAILURE_SCENARIO);

    expect(second.guarded.metrics).toEqual(result.guarded.metrics);
    expect(second.naive.metrics).toEqual(result.naive.metrics);
    expect(second.spotlight.patientCode).toBe(result.spotlight.patientCode);
    expect(second.spotlight.naive.finalScore).toBe(result.spotlight.naive.finalScore);
    expect(second.spotlight.guarded.finalScore).toBe(result.spotlight.guarded.finalScore);
  }, 60_000);
});

describe('what the naive failure actually looks like', () => {
  it('leaves the naive dataset internally consistent despite having lost data', async () => {
    /**
     * The most instructive result in the project.
     *
     * The naive run does not end in an obvious mess. It reverts a lab value, then re-reads and rescores
     * from the reverted value — so every stored score matches its stored data perfectly and the
     * consistency check passes. Nothing looks wrong. A laboratory result has simply vanished.
     *
     * This is precisely why check C3 exists: internal consistency is not the same as correctness, and a
     * verifier that only recomputed scores would have declared this run healthy.
     */
    const { naive } = await harness.runSides(FAILURE_SCENARIO);

    const consistency = naive.report.checks.find((check) => check.id === 'C4_DERIVED_CONSISTENCY')!;
    const lostUpdates = naive.report.checks.find(
      (check) => check.id === 'C3_NO_LOST_ONLINE_UPDATE',
    )!;

    expect(consistency.passed).toBe(true);
    expect(lostUpdates.passed).toBe(false);
    expect(naive.report.metrics.inconsistentRecords).toBe(0);
    expect(naive.report.metrics.lostOnlineUpdates).toBeGreaterThan(0);
  }, 60_000);

  it('records the naive writes as unguarded in the ledger', async () => {
    const { naive } = await harness.runSides(FAILURE_SCENARIO);
    const c2 = naive.report.checks.find((check) => check.id === 'C2_NO_STALE_OVERWRITE')!;

    expect(c2.passed).toBe(false);
    expect(c2.detail).toContain('no version predicate');
    expect(c2.detail).toContain('overwrote clinical fields');
    expect(c2.offendingPatientCodes.length).toBeGreaterThan(0);
  }, 60_000);

  it('names the patients whose data was lost', async () => {
    const { naive } = await harness.runSides(FAILURE_SCENARIO);
    const c3 = naive.report.checks.find((check) => check.id === 'C3_NO_LOST_ONLINE_UPDATE')!;

    expect(c3.offendingPatientCodes.length).toBeGreaterThan(0);
    for (const code of c3.offendingPatientCodes) {
      expect(code).toMatch(/^P\d{4}$/);
    }
  }, 60_000);
});

describe('control: no contention', () => {
  it('makes both engines agree exactly', async () => {
    /**
     * The honesty check.
     *
     * With no updates during the outage there is nothing for the guard to protect, and the two engines
     * must produce the same scores for every record. Without this, a sceptic could reasonably suspect the
     * naive engine had been written to fail rather than merely written without a guard.
     */
    const { guarded, naive } = await harness.runSides(UNCONTENDED_SCENARIO);

    expect(guarded.report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);
    expect(naive.report.verdict).toBe(VERIFICATION_VERDICT.VERIFIED_SAFE);

    expect(naive.report.metrics.staleOverwrites).toBe(0);
    expect(naive.report.metrics.lostOnlineUpdates).toBe(0);
    expect(guarded.report.metrics.staleOverwrites).toBe(0);

    // Every record scored identically by both engines.
    const guardedScores = [...guarded.patientsByCode.entries()]
      .map(([code, patient]) => `${code}:${patient.riskScore}`)
      .sort();
    const naiveScores = [...naive.patientsByCode.entries()]
      .map(([code, patient]) => `${code}:${patient.riskScore}`)
      .sort();

    expect(naiveScores).toEqual(guardedScores);
  }, 60_000);

  it('produces correct scores from both engines when uncontended', async () => {
    const { guarded, naive } = await harness.runSides(UNCONTENDED_SCENARIO);

    for (const patient of guarded.patientsByCode.values()) {
      expect(patient.riskScore).toBe(calculateRiskScore(toRiskInput(patient)).score);
    }
    for (const patient of naive.patientsByCode.values()) {
      expect(patient.riskScore).toBe(calculateRiskScore(toRiskInput(patient)).score);
    }
  }, 60_000);
});
