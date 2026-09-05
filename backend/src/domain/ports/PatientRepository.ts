import type {
  ActorType,
  BackfillStatus,
  ConsiderationOutcome,
  Diagnosis,
  FieldChange,
  Paginated,
  Patient,
  RiskLevel,
  UpdateSource,
} from '@bg/shared';

/**
 * The persistence port the simulation domain depends on (R4.9).
 *
 * The domain never imports Prisma. Two adapters implement this interface and both are held to one
 * shared contract test suite:
 *
 *  - `PrismaPatientRepository` — SQLite, used by the running application
 *  - `InMemoryPatientRepository` — used by the test suite and, crucially, by the naive-versus-guarded
 *    comparison, where each engine must run against a completely isolated copy of the same dataset
 *    so that the unsafe engine can never touch the real demo data (R12.7)
 *
 * Keeping the port narrow and explicit is also what makes the guarded write auditable: there is
 * exactly one method that persists derived fields, and it cannot be called without a guard version.
 */

/** The clinical fields a risk score is computed from. */
export interface ClinicalSnapshot {
  age: number;
  bloodPressureSystolic: number;
  bloodPressureDiastolic: number;
  heartRate: number;
  glucose: number;
  diagnosis: Diagnosis;
}

/** The derived block a backfill engine writes. Never includes a clinical field or `version`. */
export interface DerivedFields {
  riskScore: number;
  riskLevel: RiskLevel;
  backfillStatus: BackfillStatus;
}

/**
 * Outcome of a version-guarded write.
 *
 * `applied === false` is authoritative evidence of concurrent modification: the conditional update
 * matched zero rows. `currentVersion` reports what the row actually holds, read inside the same
 * transaction, so the caller can explain the conflict precisely.
 */
export interface GuardedWriteResult {
  applied: boolean;
  guardVersion: number;
  currentVersion: number;
}

export interface WriteLedgerEntry {
  jobId: string;
  patientId: number;
  guardVersion: number;
  rowVersionAtWrite: number;
  applied: boolean;
  guarded: boolean;
  wroteSourceFields: boolean;
  scoreWritten: number | null;
  resultingLastBfVer: number | null;
  phase: string;
}

export interface ConsiderationEntry {
  jobId: string;
  patientId: number;
  outcome: ConsiderationOutcome;
  sourceVersion: number;
  appliedVersion: number | null;
  attempts: number;
  phase: string;
  reason: string | null;
}

export interface OnlineUpdateWrite {
  patientId: number;
  actorType: ActorType;
  changedFields: FieldChange[];
  previousVersion: number;
  newVersion: number;
  source: UpdateSource;
}

export interface PendingResultWrite {
  jobId: string;
  patientId: number;
  sourceVersion: number;
  computedScore: number;
  computedLevel: RiskLevel;
  inputSnapshot: ClinicalSnapshot;
}

export interface PendingResultRecord extends PendingResultWrite {
  id: number;
  state: string;
  createdAt: string;
}

export interface PatientQuery {
  page: number;
  pageSize: number;
  status?: BackfillStatus;
  riskLevel?: RiskLevel;
  partitionIndex?: number;
  q?: string;
}

export interface PatientRepository {
  // --- reads ---

  findById(id: number): Promise<Patient | null>;
  findByCode(patientCode: string): Promise<Patient | null>;

  /** Ordered by id, so a partition scan is a stable, resumable sequence. */
  findByPartition(partitionIndex: number): Promise<Patient[]>;

  findPage(query: PatientQuery): Promise<Paginated<Patient>>;

  countAll(): Promise<number>;
  countByStatus(): Promise<Record<string, number>>;

  /** All patient ids in scope, ordered — the denominator for the coverage proof. */
  allIds(): Promise<number[]>;

  // --- the guarded write: the single path by which derived fields may be persisted ---

  /**
   * Conditionally writes the derived block only if the row is still at `guardVersion`.
   *
   * The version predicate travels *with* the write; safety is never inferred from a separate
   * re-read. Also records a `WriteLedger` row for every attempt, applied or not, which is what lets
   * verification detect a stale overwrite independently of any engine counter.
   */
  applyGuarded(
    patientId: number,
    guardVersion: number,
    derived: DerivedFields,
    ledger: Omit<
      WriteLedgerEntry,
      'patientId' | 'guardVersion' | 'rowVersionAtWrite' | 'applied' | 'resultingLastBfVer'
    >,
  ): Promise<GuardedWriteResult>;

  /**
   * Unguarded whole-row write-back, used *only* by the naive comparison engine (R12.1).
   *
   * Deliberately a separate, explicitly named method rather than an option on `applyGuarded`: the
   * unsafe path should be impossible to reach by accident, and trivially greppable in review.
   */
  applyUnguardedWholeRow(
    patientId: number,
    staleSnapshot: ClinicalSnapshot,
    derived: DerivedFields,
    sourceVersion: number,
    ledger: Omit<
      WriteLedgerEntry,
      | 'patientId'
      | 'guardVersion'
      | 'rowVersionAtWrite'
      | 'applied'
      | 'resultingLastBfVer'
      | 'guarded'
      | 'wroteSourceFields'
    >,
  ): Promise<GuardedWriteResult>;

  /** Marks a record as being processed. Does not touch `version` or any clinical field. */
  markStatus(patientId: number, status: BackfillStatus): Promise<void>;

  // --- online updates: the only path that may change clinical data ---

  /**
   * Applies a clinical update and increments `version` by exactly one, under its own version guard so
   * two concurrent online updates cannot silently lose one another (R5.7).
   *
   * Returns null when the guard fails, letting the caller surface a concurrent-update error.
   */
  applyOnlineUpdate(
    patientId: number,
    expectedVersion: number,
    changes: Partial<ClinicalSnapshot>,
    actorType: ActorType,
    source: UpdateSource,
  ): Promise<{ patient: Patient; changedFields: FieldChange[] } | null>;

  listOnlineUpdates(patientId?: number): Promise<
    (OnlineUpdateWrite & { id: number; createdAt: string })[]
  >;

  // --- ledgers: the durable evidence verification audits ---

  recordConsideration(entry: ConsiderationEntry): Promise<void>;
  /** Ids that have a terminal decision for this job — the numerator for coverage. */
  consideredPatientIds(jobId: string): Promise<number[]>;
  listConsiderations(jobId: string): Promise<(ConsiderationEntry & { decidedAt: string })[]>;

  listWriteLedger(jobId: string): Promise<(WriteLedgerEntry & { id: number; createdAt: string })[]>;

  // --- staged results: the durable source of staleness across a crash ---

  stagePendingResults(entries: PendingResultWrite[]): Promise<void>;
  pendingResults(jobId: string, state?: string): Promise<PendingResultRecord[]>;
  setPendingResultState(id: number, state: string): Promise<void>;

  // --- lifecycle ---

  /** Replaces the entire dataset. Used by seeding and reset (R2.8). */
  replaceAll(patients: Omit<Patient, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<void>;

  /** Clears jobs, events, checkpoints, ledgers, conflicts, online updates and staged results. */
  clearSimulationState(): Promise<void>;
}
