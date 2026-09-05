import {
  BACKFILL_MODE,
  BACKFILL_STATUS,
  CONFLICT_RESOLUTION,
  DEFAULT_SIMULATION_SETTINGS,
  DIAGNOSIS,
  JOB_STATUS,
  PARTITION_STATE,
  RISK_LEVEL,
  VERIFICATION_CHECK,
  VERIFICATION_VERDICT,
  type BackfillJobState,
  type ConflictRecord,
  type JobMetrics,
  type PartitionProgress,
  type Patient,
  type SimulationEvent,
  type VerificationMetrics,
  type VerificationReport,
} from '@bg/shared';

/**
 * Shared test fixtures.
 *
 * Deliberately built as `make*` functions taking overrides rather than exported constants. A shared mutable
 * object is a well-known source of tests that pass alone and fail in a suite, and the override pattern also
 * keeps each test's *interesting* values visible at the call site instead of buried in a fixture file the
 * reader has to go and open.
 */

export function makeMetrics(overrides: Partial<JobMetrics> = {}): JobMetrics {
  return {
    eligibleRecords: 1000,
    processed: 1000,
    applied: 925,
    noopAlreadyCurrent: 66,
    conflicts: 9,
    reevaluated: 9,
    protectedUpdates: 9,
    staleWriteAttemptsBlocked: 9,
    failed: 0,
    currentPartition: 9,
    currentRecordIndex: 100,
    percentComplete: 100,
    ...overrides,
  };
}

export function makePartition(
  partitionIndex: number,
  overrides: Partial<PartitionProgress> = {},
): PartitionProgress {
  return {
    partitionIndex,
    state: PARTITION_STATE.PENDING,
    totalRecords: 100,
    processedRecords: 0,
    openConflicts: 0,
    percentComplete: 0,
    ...overrides,
  };
}

export function makeJob(overrides: Partial<BackfillJobState> = {}): BackfillJobState {
  return {
    jobId: 'BG-DEMO-001',
    status: JOB_STATUS.RUNNING,
    mode: BACKFILL_MODE.GUARDED,
    seed: 20260905,
    settings: { ...DEFAULT_SIMULATION_SETTINGS },
    metrics: makeMetrics(),
    partitions: [],
    pendingResultCount: 0,
    checkpoint: null,
    startedAt: '2026-09-05T10:00:00.000Z',
    crashedAt: null,
    recoveredAt: null,
    completedAt: null,
    failureReason: null,
    ...overrides,
  };
}

export function makeVerificationMetrics(
  overrides: Partial<VerificationMetrics> = {},
): VerificationMetrics {
  return {
    eligibleRecords: 1000,
    consideredRecords: 1000,
    completedRecords: 1000,
    conflicts: 9,
    reevaluated: 9,
    protectedUpdates: 9,
    staleWriteAttemptsBlocked: 9,
    staleOverwrites: 0,
    lostOnlineUpdates: 0,
    missedRecords: 0,
    inconsistentRecords: 0,
    postConsiderationDrift: 0,
    coveragePercent: 100,
    ...overrides,
  };
}

export function makeReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    jobId: 'BG-DEMO-001',
    mode: BACKFILL_MODE.GUARDED,
    datasetDescription: 'Synthetic Hospital Patients (1000 records)',
    seed: 20260905,
    verdict: VERIFICATION_VERDICT.VERIFIED_SAFE,
    metrics: makeVerificationMetrics(),
    checks: [
      {
        id: VERIFICATION_CHECK.C1_COVERAGE,
        title: 'Every eligible record was considered',
        passed: true,
        detail: '1000 / 1000 records considered',
        method: 'Set difference between all patient ids and the consideration ledger.',
        offendingPatientCodes: [],
      },
      {
        id: VERIFICATION_CHECK.C2_NO_STALE_OVERWRITE,
        title: 'No stale write was ever applied',
        passed: true,
        detail: '0 applied writes had a guard version below the row version',
        method: 'Re-read every write-ledger row and compare guard version to row version.',
        offendingPatientCodes: [],
      },
    ],
    guaranteeStatement:
      'Every eligible record was considered exactly once, and no newer clinical update was ' +
      'overwritten by older backfill data.',
    jobStartedAt: '2026-09-05T10:00:00.000Z',
    jobCompletedAt: '2026-09-05T10:00:40.000Z',
    verifiedAt: '2026-09-05T10:01:00.000Z',
    durationMs: 40_000,
    ...overrides,
  };
}

export function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 1,
    patientCode: 'P0001',
    name: 'Ada Nakamura',
    age: 62,
    bloodPressureSystolic: 112,
    bloodPressureDiastolic: 72,
    heartRate: 84,
    glucose: 118,
    diagnosis: DIAGNOSIS.CHRONIC_KIDNEY_DISEASE,
    partitionIndex: 0,
    version: 1,
    riskScore: 48,
    riskLevel: RISK_LEVEL.MEDIUM,
    backfillStatus: BACKFILL_STATUS.COMPLETED,
    lastBackfillVersion: 1,
    createdAt: '2026-09-05T09:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}

export function makeConflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: 1,
    jobId: 'BG-DEMO-001',
    patientId: 1,
    patientCode: 'P0001',
    sourceVersion: 1,
    currentVersion: 2,
    oldScore: 48,
    newScore: 63,
    changedFields: [{ field: 'glucose', from: 118, to: 210 }],
    resolution: CONFLICT_RESOLUTION.REEVALUATED,
    detectedAt: '2026-09-05T10:00:10.000Z',
    resolvedAt: '2026-09-05T10:00:10.500Z',
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<SimulationEvent> = {}): SimulationEvent {
  return {
    sequence: 1,
    type: 'RECORD_UPDATED',
    severity: 'INFO',
    message: 'P0001 scored 48 (MEDIUM).',
    jobId: 'BG-DEMO-001',
    createdAt: '2026-09-05T10:00:00.000Z',
    ...overrides,
  };
}
