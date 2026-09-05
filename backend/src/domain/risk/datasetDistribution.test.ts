import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, RISK_LEVEL, type RiskLevel } from '@bg/shared';
import { generatePatients } from '../../infra/seed/patientGenerator';
import { calculateRiskScore, toRiskInput } from './riskCalculator';

/**
 * Ties the dataset generator to the scoring formula.
 *
 * Each is tested in isolation elsewhere, but neither test would catch the failure that matters here:
 * a config change or a profile tweak that collapses the population into a single risk band. That
 * would leave the risk-distribution chart flat and make the re-evaluation demo far less legible, while
 * every unit test still passed.
 *
 * The thresholds are deliberately loose. This asserts "the dataset is usable", not exact proportions,
 * so it does not become a brittle snapshot of tuning decisions.
 */
describe('seeded dataset risk distribution', () => {
  const patients = generatePatients({
    totalRecords: 1000,
    partitionCount: 10,
    seed: DEFAULT_SEED,
  });

  const scores = patients.map((patient) => calculateRiskScore(toRiskInput(patient)));

  const counts = scores.reduce<Record<RiskLevel, number>>(
    (acc, result) => {
      acc[result.level] += 1;
      return acc;
    },
    { LOW: 0, MEDIUM: 0, HIGH: 0 },
  );

  it('populates all three risk levels', () => {
    expect(counts[RISK_LEVEL.LOW]).toBeGreaterThan(0);
    expect(counts[RISK_LEVEL.MEDIUM]).toBeGreaterThan(0);
    expect(counts[RISK_LEVEL.HIGH]).toBeGreaterThan(0);
  });

  it('gives every level a meaningful share rather than a token handful', () => {
    for (const level of Object.values(RISK_LEVEL)) {
      expect(
        counts[level],
        `${level} holds ${counts[level]} of 1000 patients, too few to be visible in the UI`,
      ).toBeGreaterThan(80);
    }
  });

  it('does not let any single level dominate the population', () => {
    for (const level of Object.values(RISK_LEVEL)) {
      expect(counts[level], `${level} holds ${counts[level]} of 1000 patients`).toBeLessThan(650);
    }
  });

  it('produces scores only within the attainable range', () => {
    const values = scores.map((result) => result.score);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...values)).toBeLessThanOrEqual(100);
  });

  it('spans a wide score range, so the population is genuinely varied', () => {
    const values = scores.map((result) => result.score);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(50);
  });

  it('is deterministic for a fixed seed', () => {
    const repeat = generatePatients({ totalRecords: 1000, partitionCount: 10, seed: DEFAULT_SEED })
      .map((patient) => calculateRiskScore(toRiskInput(patient)).score);
    expect(repeat).toEqual(scores.map((result) => result.score));
  });
});
