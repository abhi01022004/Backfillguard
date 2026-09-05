import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  CONFLICT_RESOLUTION,
  CONSIDERATION_OUTCOME,
  UPDATE_SOURCE,
} from '@bg/shared';
import type { PatientEvidence } from '../ports/PatientRepository';
import { buildPatientHistory } from './patientHistory';

/**
 * The per-patient timeline (R16.4).
 *
 * These cases are written against hand-built evidence rather than a live run, deliberately: the
 * interesting orderings — a rejected write, its conflict and the re-evaluation all inside one
 * millisecond — are awkward to provoke reliably from a real engine but trivial to state directly. That
 * makes the merge's contract explicit instead of incidental.
 */

const JOB = 'BG-DEMO-001';
const PATIENT = 42;

function emptyEvidence(): PatientEvidence {
  return { onlineUpdates: [], writes: [], conflicts: [], considerations: [] };
}

describe('buildPatientHistory', () => {
  it('returns nothing for a patient with no recorded activity', () => {
    expect(buildPatientHistory(emptyEvidence())).toEqual([]);
  });

  it('narrates a clean write with the version it was derived from', () => {
    const history = buildPatientHistory({
      ...emptyEvidence(),
      writes: [
        {
          id: 1,
          jobId: JOB,
          patientId: PATIENT,
          guardVersion: 3,
          rowVersionAtWrite: 3,
          applied: true,
          guarded: true,
          wroteSourceFields: false,
          scoreWritten: 48,
          resultingLastBfVer: 3,
          phase: 'INITIAL',
          createdAt: '2026-09-05T10:00:00.000Z',
        },
      ],
    });

    expect(history).toHaveLength(1);
    expect(history[0]!.kind).toBe('WRITE_APPLIED');
    expect(history[0]!.version).toBe(3);
    expect(history[0]!.scoreAfter).toBe(48);
    expect(history[0]!.summary).toContain('48');
    expect(history[0]!.summary).toContain('v3');
  });

  it('says what a refused write prevented, naming both versions', () => {
    const history = buildPatientHistory({
      ...emptyEvidence(),
      writes: [
        {
          id: 1,
          jobId: JOB,
          patientId: PATIENT,
          guardVersion: 2,
          rowVersionAtWrite: 3,
          applied: false,
          guarded: true,
          wroteSourceFields: false,
          scoreWritten: 48,
          resultingLastBfVer: null,
          phase: 'INITIAL',
          createdAt: '2026-09-05T10:00:01.000Z',
        },
      ],
    });

    expect(history[0]!.kind).toBe('WRITE_REJECTED');
    expect(history[0]!.rejectedScore).toBe(48);
    expect(history[0]!.summary).toContain('v2');
    expect(history[0]!.summary).toContain('v3');
    expect(history[0]!.summary).toMatch(/blocked/i);
  });

  it('flags an unguarded write, so a naive-engine run cannot be mistaken for a safe one', () => {
    const history = buildPatientHistory({
      ...emptyEvidence(),
      writes: [
        {
          id: 1,
          jobId: JOB,
          patientId: PATIENT,
          guardVersion: 2,
          rowVersionAtWrite: 3,
          applied: true,
          guarded: false,
          wroteSourceFields: true,
          scoreWritten: 48,
          resultingLastBfVer: 2,
          phase: 'RECOVERY',
          createdAt: '2026-09-05T10:00:02.000Z',
        },
      ],
    });

    expect(history[0]!.kind).toBe('WRITE_APPLIED');
    expect(history[0]!.summary).toContain('UNGUARDED');
  });

  it('reads as a causal narrative when every entry shares one millisecond', () => {
    // The whole conflict sequence can complete inside a single stored timestamp. Sorting by time alone
    // would order these arbitrarily and the timeline would be nonsense.
    const at = '2026-09-05T10:00:00.000Z';

    const history = buildPatientHistory({
      onlineUpdates: [
        {
          id: 7,
          patientId: PATIENT,
          actorType: ACTOR_TYPE.LAB,
          changedFields: [{ field: 'glucose', from: 118, to: 210 }],
          previousVersion: 2,
          newVersion: 3,
          source: UPDATE_SOURCE.SCRIPTED,
          createdAt: at,
        },
      ],
      writes: [
        {
          id: 1,
          jobId: JOB,
          patientId: PATIENT,
          guardVersion: 2,
          rowVersionAtWrite: 3,
          applied: false,
          guarded: true,
          wroteSourceFields: false,
          scoreWritten: 48,
          resultingLastBfVer: null,
          phase: 'INITIAL',
          createdAt: at,
        },
        {
          id: 2,
          jobId: JOB,
          patientId: PATIENT,
          guardVersion: 3,
          rowVersionAtWrite: 3,
          applied: true,
          guarded: true,
          wroteSourceFields: false,
          scoreWritten: 63,
          resultingLastBfVer: 3,
          phase: 'INITIAL',
          createdAt: at,
        },
      ],
      conflicts: [
        {
          id: 5,
          jobId: JOB,
          patientId: PATIENT,
          patientCode: 'P0042',
          sourceVersion: 2,
          currentVersion: 3,
          oldScore: 48,
          newScore: 63,
          changedFields: [{ field: 'glucose', from: 118, to: 210 }],
          resolution: CONFLICT_RESOLUTION.REEVALUATED,
          detectedAt: at,
          resolvedAt: at,
        },
      ],
      considerations: [],
    });

    expect(history.map((entry) => entry.kind)).toEqual([
      'ONLINE_UPDATE',
      'WRITE_REJECTED',
      'CONFLICT',
      'WRITE_APPLIED',
      'REEVALUATION',
    ]);

    const reevaluation = history.at(-1)!;
    expect(reevaluation.scoreBefore).toBe(48);
    expect(reevaluation.scoreAfter).toBe(63);
    expect(reevaluation.summary).toMatch(/prevented/i);
  });

  it('orders by timestamp ahead of causal rank when timestamps differ', () => {
    const history = buildPatientHistory({
      ...emptyEvidence(),
      onlineUpdates: [
        {
          id: 7,
          patientId: PATIENT,
          actorType: ACTOR_TYPE.NURSE,
          changedFields: [{ field: 'heartRate', from: 84, to: 115 }],
          previousVersion: 3,
          newVersion: 4,
          source: UPDATE_SOURCE.AUTO,
          createdAt: '2026-09-05T10:00:05.000Z',
        },
      ],
      writes: [
        {
          id: 1,
          jobId: JOB,
          patientId: PATIENT,
          guardVersion: 3,
          rowVersionAtWrite: 3,
          applied: true,
          guarded: true,
          wroteSourceFields: false,
          scoreWritten: 48,
          resultingLastBfVer: 3,
          phase: 'INITIAL',
          createdAt: '2026-09-05T10:00:01.000Z',
        },
      ],
    });

    // The write happened first even though ONLINE_UPDATE outranks it in the tie-break table.
    expect(history.map((entry) => entry.kind)).toEqual(['WRITE_APPLIED', 'ONLINE_UPDATE']);
  });

  it('reports an unresolvable conflict as failed rather than silently resolved', () => {
    const history = buildPatientHistory({
      ...emptyEvidence(),
      conflicts: [
        {
          id: 5,
          jobId: JOB,
          patientId: PATIENT,
          patientCode: 'P0042',
          sourceVersion: 2,
          currentVersion: 6,
          oldScore: 48,
          newScore: null,
          changedFields: [{ field: 'glucose', from: 118, to: 210 }],
          resolution: CONFLICT_RESOLUTION.FAILED,
          detectedAt: '2026-09-05T10:00:00.000Z',
          resolvedAt: '2026-09-05T10:00:03.000Z',
        },
      ],
    });

    const resolution = history.find((entry) => entry.kind === 'REEVALUATION')!;
    expect(resolution.scoreAfter).toBeNull();
    expect(resolution.summary).toMatch(/no stale value was written/i);
  });

  it('omits a resolution entry while a conflict is still open', () => {
    const history = buildPatientHistory({
      ...emptyEvidence(),
      conflicts: [
        {
          id: 5,
          jobId: JOB,
          patientId: PATIENT,
          patientCode: 'P0042',
          sourceVersion: 2,
          currentVersion: 3,
          oldScore: 48,
          newScore: null,
          changedFields: [],
          resolution: CONFLICT_RESOLUTION.PENDING,
          detectedAt: '2026-09-05T10:00:00.000Z',
          resolvedAt: null,
        },
      ],
    });

    expect(history.map((entry) => entry.kind)).toEqual(['CONFLICT']);
  });

  it('surfaces a recovery no-op, the evidence that recovery did not blindly rewrite', () => {
    const history = buildPatientHistory({
      ...emptyEvidence(),
      considerations: [
        {
          jobId: JOB,
          patientId: PATIENT,
          outcome: CONSIDERATION_OUTCOME.NO_ACTION_ALREADY_CURRENT,
          sourceVersion: 3,
          appliedVersion: 3,
          attempts: 1,
          phase: 'RECOVERY',
          reason: null,
          decidedAt: '2026-09-05T10:00:04.000Z',
        },
      ],
    });

    expect(history).toHaveLength(1);
    expect(history[0]!.kind).toBe('NO_ACTION');
    expect(history[0]!.summary).toMatch(/left untouched/i);
    expect(history[0]!.summary).toContain('v3');
  });

  it('does not duplicate outcomes already evidenced by a write-ledger row', () => {
    // An APPLIED consideration says nothing the write row does not, so padding the timeline with it
    // would make the same fact look like two.
    const history = buildPatientHistory({
      ...emptyEvidence(),
      considerations: [
        {
          jobId: JOB,
          patientId: PATIENT,
          outcome: CONSIDERATION_OUTCOME.APPLIED,
          sourceVersion: 3,
          appliedVersion: 3,
          attempts: 1,
          phase: 'INITIAL',
          reason: null,
          decidedAt: '2026-09-05T10:00:04.000Z',
        },
      ],
    });

    expect(history).toEqual([]);
  });
});
