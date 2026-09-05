import {
  BACKFILL_STATUS,
  type ActorType,
  type BackfillStatus,
  type FieldChange,
  type Paginated,
  type Patient,
  type RiskLevel,
  type UpdateSource,
} from '@bg/shared';
import type {
  ClinicalSnapshot,
  ConsiderationEntry,
  DerivedFields,
  GuardedWriteResult,
  OnlineUpdateWrite,
  PatientQuery,
  PatientRepository,
  PendingResultRecord,
  PendingResultWrite,
  WriteLedgerEntry,
} from '../../domain/ports/PatientRepository';

/**
 * In-memory repository with identical semantics to the SQLite one.
 *
 * This exists for two reasons beyond fast tests:
 *
 *  1. **Isolation for the naive comparison (R12.7).** The unsafe engine must never be able to reach
 *     the real demo dataset. Constructing it with an in-memory repository makes that structurally
 *     impossible rather than a rule someone has to remember.
 *  2. **A second implementation keeps the port honest.** Both adapters are held to one shared
 *     contract test suite, so guarded-write semantics cannot quietly diverge.
 *
 * Both adapters must agree on the subtle behaviours, notably: a guarded write leaves `version` and
 * all clinical fields untouched, a zero-change online update does not consume a version, and
 * consideration entries are keyed by (jobId, patientId) so re-deciding updates rather than appends.
 */
export class InMemoryPatientRepository implements PatientRepository {
  private patients = new Map<number, Patient>();
  private considerations = new Map<string, ConsiderationEntry & { decidedAt: string }>();
  private writes: (WriteLedgerEntry & { id: number; createdAt: string })[] = [];
  private onlineUpdates: (OnlineUpdateWrite & { id: number; createdAt: string })[] = [];
  private staged: PendingResultRecord[] = [];

  private nextPatientId = 1;
  private nextWriteId = 1;
  private nextUpdateId = 1;
  private nextStagedId = 1;

  /**
   * A monotonic counter used in place of timestamps.
   *
   * Wall-clock time is unusable here: a full simulation runs in milliseconds, so `Date.now()` would
   * produce ties and make ordering assertions flaky. A counter keeps ordering strict and observable.
   */
  private tick = 0;

  private stamp(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + this.tick).toISOString();
  }

  private clone(patient: Patient): Patient {
    return { ...patient };
  }

  private key(jobId: string, patientId: number): string {
    return `${jobId}::${patientId}`;
  }

  // ---------------------------------------------------------------- reads

  async findById(id: number): Promise<Patient | null> {
    const patient = this.patients.get(id);
    return patient ? this.clone(patient) : null;
  }

  async findByCode(patientCode: string): Promise<Patient | null> {
    for (const patient of this.patients.values()) {
      if (patient.patientCode === patientCode) return this.clone(patient);
    }
    return null;
  }

  async findByPartition(partitionIndex: number): Promise<Patient[]> {
    return [...this.patients.values()]
      .filter((patient) => patient.partitionIndex === partitionIndex)
      .sort((a, b) => a.id - b.id)
      .map((patient) => this.clone(patient));
  }

  async findPage(query: PatientQuery): Promise<Paginated<Patient>> {
    const needle = query.q?.toLowerCase();

    const filtered = [...this.patients.values()]
      .filter((patient) => {
        if (query.status && patient.backfillStatus !== query.status) return false;
        if (query.riskLevel && patient.riskLevel !== query.riskLevel) return false;
        if (query.partitionIndex !== undefined && patient.partitionIndex !== query.partitionIndex) {
          return false;
        }
        if (needle) {
          const matches =
            patient.patientCode.toLowerCase().includes(needle) ||
            patient.name.toLowerCase().includes(needle);
          if (!matches) return false;
        }
        return true;
      })
      .sort((a, b) => a.id - b.id);

    const start = (query.page - 1) * query.pageSize;

    return {
      items: filtered.slice(start, start + query.pageSize).map((patient) => this.clone(patient)),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / query.pageSize)),
    };
  }

  async countAll(): Promise<number> {
    return this.patients.size;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const patient of this.patients.values()) {
      counts[patient.backfillStatus] = (counts[patient.backfillStatus] ?? 0) + 1;
    }
    return counts;
  }

  async allIds(): Promise<number[]> {
    return [...this.patients.keys()].sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- guarded write

  async applyGuarded(
    patientId: number,
    guardVersion: number,
    derived: DerivedFields,
    ledger: Omit<
      WriteLedgerEntry,
      'patientId' | 'guardVersion' | 'rowVersionAtWrite' | 'applied' | 'resultingLastBfVer'
    >,
  ): Promise<GuardedWriteResult> {
    const patient = this.patients.get(patientId);
    if (!patient) {
      throw new Error(`InMemoryPatientRepository: patient ${patientId} does not exist`);
    }

    // Compare-and-set: the predicate is evaluated as part of the write, not before it.
    const applied = patient.version === guardVersion;

    if (applied) {
      patient.riskScore = derived.riskScore;
      patient.riskLevel = derived.riskLevel;
      patient.backfillStatus = derived.backfillStatus;
      patient.lastBackfillVersion = guardVersion;
      patient.updatedAt = this.stamp();
      // `version` and every clinical field are deliberately untouched.
    }

    this.writes.push({
      id: this.nextWriteId++,
      jobId: ledger.jobId,
      patientId,
      guardVersion,
      rowVersionAtWrite: patient.version,
      applied,
      guarded: true,
      wroteSourceFields: false,
      scoreWritten: applied ? derived.riskScore : null,
      resultingLastBfVer: applied ? guardVersion : null,
      phase: ledger.phase,
      createdAt: this.stamp(),
    });

    return { applied, guardVersion, currentVersion: patient.version };
  }

  async applyUnguardedWholeRow(
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
  ): Promise<GuardedWriteResult> {
    const patient = this.patients.get(patientId);
    if (!patient) {
      throw new Error(`InMemoryPatientRepository: patient ${patientId} does not exist`);
    }

    const versionAtWrite = patient.version;

    // No predicate, and the stale snapshot overwrites current clinical values: the lost update.
    patient.age = staleSnapshot.age;
    patient.bloodPressureSystolic = staleSnapshot.bloodPressureSystolic;
    patient.bloodPressureDiastolic = staleSnapshot.bloodPressureDiastolic;
    patient.heartRate = staleSnapshot.heartRate;
    patient.glucose = staleSnapshot.glucose;
    patient.diagnosis = staleSnapshot.diagnosis;
    patient.riskScore = derived.riskScore;
    patient.riskLevel = derived.riskLevel;
    patient.backfillStatus = derived.backfillStatus;
    patient.lastBackfillVersion = sourceVersion;
    patient.updatedAt = this.stamp();

    this.writes.push({
      id: this.nextWriteId++,
      jobId: ledger.jobId,
      patientId,
      guardVersion: sourceVersion,
      rowVersionAtWrite: versionAtWrite,
      applied: true,
      guarded: false,
      wroteSourceFields: true,
      scoreWritten: derived.riskScore,
      resultingLastBfVer: sourceVersion,
      phase: ledger.phase,
      createdAt: this.stamp(),
    });

    return { applied: true, guardVersion: sourceVersion, currentVersion: versionAtWrite };
  }

  async markStatus(patientId: number, status: BackfillStatus): Promise<void> {
    const patient = this.patients.get(patientId);
    if (!patient) {
      throw new Error(`InMemoryPatientRepository: patient ${patientId} does not exist`);
    }
    patient.backfillStatus = status;
    patient.updatedAt = this.stamp();
  }

  // ---------------------------------------------------------------- online updates

  async applyOnlineUpdate(
    patientId: number,
    expectedVersion: number,
    changes: Partial<ClinicalSnapshot>,
    actorType: ActorType,
    source: UpdateSource,
  ): Promise<{ patient: Patient; changedFields: FieldChange[] } | null> {
    const patient = this.patients.get(patientId);
    if (!patient) return null;

    const changedFields: FieldChange[] = [];
    for (const [field, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      const previous = patient[field as keyof Patient];
      if (previous === value) continue;
      changedFields.push({
        field: field as FieldChange['field'],
        from: previous as string | number,
        to: value as string | number,
      });
    }

    if (changedFields.length === 0) {
      return { patient: this.clone(patient), changedFields: [] };
    }

    if (patient.version !== expectedVersion) return null;

    Object.assign(patient, changes);
    patient.version += 1;
    patient.updatedAt = this.stamp();

    this.onlineUpdates.push({
      id: this.nextUpdateId++,
      patientId,
      actorType,
      changedFields,
      previousVersion: expectedVersion,
      newVersion: patient.version,
      source,
      createdAt: this.stamp(),
    });

    return { patient: this.clone(patient), changedFields };
  }

  async listOnlineUpdates(
    patientId?: number,
  ): Promise<(OnlineUpdateWrite & { id: number; createdAt: string })[]> {
    return this.onlineUpdates
      .filter((update) => patientId === undefined || update.patientId === patientId)
      .sort((a, b) => a.patientId - b.patientId || a.newVersion - b.newVersion)
      .map((update) => ({ ...update, changedFields: [...update.changedFields] }));
  }

  // ---------------------------------------------------------------- ledgers

  async recordConsideration(entry: ConsiderationEntry): Promise<void> {
    // Keyed, not appended: recovery re-deciding a record must not inflate coverage.
    this.considerations.set(this.key(entry.jobId, entry.patientId), {
      ...entry,
      decidedAt: this.stamp(),
    });
  }

  async consideredPatientIds(jobId: string): Promise<number[]> {
    return [...this.considerations.values()]
      .filter((entry) => entry.jobId === jobId)
      .map((entry) => entry.patientId)
      .sort((a, b) => a - b);
  }

  async listConsiderations(
    jobId: string,
  ): Promise<(ConsiderationEntry & { decidedAt: string })[]> {
    return [...this.considerations.values()]
      .filter((entry) => entry.jobId === jobId)
      .sort((a, b) => a.patientId - b.patientId)
      .map((entry) => ({ ...entry }));
  }

  async listWriteLedger(
    jobId: string,
  ): Promise<(WriteLedgerEntry & { id: number; createdAt: string })[]> {
    return this.writes.filter((write) => write.jobId === jobId).map((write) => ({ ...write }));
  }

  // ---------------------------------------------------------------- staged results

  async stagePendingResults(entries: PendingResultWrite[]): Promise<void> {
    for (const entry of entries) {
      this.staged.push({
        ...entry,
        inputSnapshot: { ...entry.inputSnapshot },
        id: this.nextStagedId++,
        state: 'PENDING',
        createdAt: this.stamp(),
      });
    }
  }

  async pendingResults(jobId: string, state?: string): Promise<PendingResultRecord[]> {
    return this.staged
      .filter((entry) => entry.jobId === jobId && (state === undefined || entry.state === state))
      .map((entry) => ({ ...entry, inputSnapshot: { ...entry.inputSnapshot } }));
  }

  async setPendingResultState(id: number, state: string): Promise<void> {
    const entry = this.staged.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new Error(`InMemoryPatientRepository: staged result ${id} does not exist`);
    }
    entry.state = state;
  }

  // ---------------------------------------------------------------- lifecycle

  async replaceAll(
    patients: Omit<Patient, 'id' | 'createdAt' | 'updatedAt'>[],
  ): Promise<void> {
    this.patients.clear();
    this.considerations.clear();
    this.writes = [];
    this.onlineUpdates = [];
    this.staged = [];
    this.nextPatientId = 1;
    this.nextWriteId = 1;
    this.nextUpdateId = 1;
    this.nextStagedId = 1;

    for (const patient of patients) {
      const id = this.nextPatientId++;
      const stamp = this.stamp();
      this.patients.set(id, { ...patient, id, createdAt: stamp, updatedAt: stamp });
    }
  }

  async clearSimulationState(): Promise<void> {
    this.considerations.clear();
    this.writes = [];
    this.onlineUpdates = [];
    this.staged = [];

    for (const patient of this.patients.values()) {
      patient.riskScore = null;
      patient.riskLevel = null;
      patient.backfillStatus = BACKFILL_STATUS.PENDING;
      patient.lastBackfillVersion = null;
    }
  }

  /** Test helper: seed directly from full patient objects without going through the generator. */
  seedDirect(patients: Patient[]): void {
    this.patients.clear();
    for (const patient of patients) {
      this.patients.set(patient.id, { ...patient });
      this.nextPatientId = Math.max(this.nextPatientId, patient.id + 1);
    }
  }
}

/** Convenience for tests and the comparison harness. */
export function createInMemoryRepository(): InMemoryPatientRepository {
  return new InMemoryPatientRepository();
}

/** Re-exported so callers can construct a repository without importing the risk level type. */
export type { RiskLevel };
