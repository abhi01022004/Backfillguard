import { RISK_LEVEL, type BackfillStatus, type Paginated, type Patient } from '@bg/shared';
import type {
  ClinicalSnapshot,
  ConflictEntry,
  ConsiderationEntry,
  DerivedFields,
  GuardedWriteResult,
  PatientEvidence,
  PatientQuery,
  PatientRepository,
  PendingResultRecord,
  PendingResultWrite,
  WriteLedgerEntry,
} from '../../domain/ports/PatientRepository';
import type { NotificationService } from '../../domain/notification/NotificationService';
import { logger } from '../../lib/logger';

/**
 * Wraps a `PatientRepository` and raises risk notifications as a side effect of persistence.
 *
 * ## Why a decorator, and not a call inside the engines
 *
 * Every safe commit in this system already funnels through exactly one method: `applyGuarded`. Four places call
 * it — the initial pass, the conflict re-evaluation, and two paths in recovery — and the naive comparison engine
 * deliberately does not, because it uses `applyUnguardedWholeRow` instead.
 *
 * So the correct place to observe commits is the port, not the callers. That buys four things:
 *
 * 1. **No engine is modified.** `BackfillEngine`, `ConflictEngine` and `RecoveryEngine` are untouched, so the
 *    concurrency logic this project is actually about carries no notification code and cannot be broken by it.
 * 2. **All four commit paths are covered by construction**, including any added later. A hook per call site would
 *    have been four chances to forget one — and the one most likely to be forgotten is recovery, which is exactly
 *    where a duplicate or stale alert would be hardest to notice.
 * 3. **The naive engine is excluded automatically**, because it does not go through the guarded write. An unsafe
 *    engine that also fired alerts would muddle the comparison badly.
 * 4. **The wiring is opt-in.** Only the composition root wraps the repository, so tests and the comparison
 *    harness get a plain repository with no notification behaviour unless they ask for it.
 *
 * ## The safety property, and where it comes from
 *
 * A notification is transmitted only when `applied === true`, which means the database matched the row at the
 * exact version the score was computed from. There is no branch here that could send on a refused write, because
 * `applied === false` routes to cancellation instead. The guarantee is structural rather than checked.
 *
 * Staged results reach `stagePendingResults`, never `applyGuarded`, so a crash with results in flight cannot
 * produce a sent alert — the rows it created are `QUEUED`, and recovery either commits them or cancels them.
 *
 * ## Failure isolation
 *
 * Every hook is wrapped so a notification failure cannot fail a write. The repository's job is persistence; if
 * the alerting side effect throws, the write has already succeeded and reversing it would turn an observability
 * problem into data loss. Failures are logged and, where the service is reachable, recorded as `FAILED` rows.
 */
export class NotifyingPatientRepository implements PatientRepository {
  constructor(
    private readonly inner: PatientRepository,
    private readonly notifications: NotificationService,
  ) {}

  // ------------------------------------------------------------------ observed writes

  /**
   * Delegates the write, then reports the outcome to the notification service.
   *
   * The lookup of the patient code is deliberately conditional. On a clean 1,000-record run almost every write is
   * an applied non-HIGH result, and those need nothing — so the extra read happens only for HIGH commits and for
   * refusals that actually have something queued to cancel. Looking up unconditionally would have doubled the
   * read count of the hot path to serve a minority of records.
   */
  async applyGuarded(
    patientId: number,
    guardVersion: number,
    derived: DerivedFields,
    ledger: Omit<
      WriteLedgerEntry,
      'patientId' | 'guardVersion' | 'rowVersionAtWrite' | 'applied' | 'resultingLastBfVer'
    >,
  ): Promise<GuardedWriteResult> {
    const result = await this.inner.applyGuarded(patientId, guardVersion, derived, ledger);

    try {
      if (result.applied) {
        await this.onCommitted(ledger.jobId, patientId, guardVersion, derived, ledger.phase);
      } else {
        await this.onRefused(ledger.jobId, patientId, guardVersion, result.currentVersion);
      }
    } catch (error) {
      // The write already succeeded. Never let the side effect undo or fail it.
      this.logSuppressed('applyGuarded', patientId, error);
    }

    return result;
  }

  /**
   * Records intent for HIGH results that have been computed but not yet written.
   *
   * These become `QUEUED` rows: never transmitted, but present, so a subsequent refusal leaves a visible
   * cancellation rather than an absence. This is the only hook that runs before a commit, and it is precisely why
   * a crash at this point produces no alert — `QUEUED` is not `SENT`.
   */
  async stagePendingResults(entries: PendingResultWrite[]): Promise<void> {
    await this.inner.stagePendingResults(entries);

    try {
      for (const entry of entries) {
        if (entry.computedLevel !== RISK_LEVEL.HIGH) continue;

        const patient = await this.inner.findById(entry.patientId);
        if (!patient) continue;

        await this.notifications.onStaged({
          jobId: entry.jobId,
          patientId: entry.patientId,
          patientCode: patient.patientCode,
          partitionIndex: patient.partitionIndex,
          patientVersion: entry.sourceVersion,
          riskScore: entry.computedScore,
          riskLevel: entry.computedLevel,
        });
      }
    } catch (error) {
      this.logSuppressed('stagePendingResults', entries[0]?.patientId ?? -1, error);
    }
  }

  // ------------------------------------------------------------------ lifecycle, kept in step

  /**
   * Clears one job's notifications alongside its run evidence.
   *
   * Hooked here rather than in the orchestrator so notification lifetime automatically matches ledger lifetime. A
   * second run inheriting the previous run's alerts would report a success rate and a high-risk count belonging to
   * a job whose evidence had already been discarded.
   */
  async clearRunEvidence(jobId: string): Promise<void> {
    await this.inner.clearRunEvidence(jobId);
    await this.notifications.clearForJob(jobId);
  }

  async clearSimulationState(): Promise<void> {
    await this.inner.clearSimulationState();
    await this.notifications.clearAll();
  }

  /** A regenerated dataset invalidates every alert, since the patients they referred to no longer exist. */
  async replaceAll(patients: Omit<Patient, 'id' | 'createdAt' | 'updatedAt'>[]): Promise<void> {
    await this.inner.replaceAll(patients);
    await this.notifications.clearAll();
  }

  // ------------------------------------------------------------------ notification decisions

  private async onCommitted(
    jobId: string,
    patientId: number,
    committedVersion: number,
    derived: DerivedFields,
    phase: string,
  ): Promise<void> {
    if (derived.riskLevel !== RISK_LEVEL.HIGH) return;

    const patient = await this.inner.findById(patientId);
    if (!patient) return;

    /**
     * Phase distinguishes provenance, not eligibility.
     *
     * `RECOVERY` and the conflict engine's re-evaluated writes both produce alerts that are exactly as valid as a
     * first-pass one. The reason recorded differs so the timeline can show an alert was the *outcome of* a
     * re-evaluation — the case where a naive implementation would have alerted on stale data.
     */
    await this.notifications.onCommitted(
      {
        jobId,
        patientId,
        patientCode: patient.patientCode,
        partitionIndex: patient.partitionIndex,
        patientVersion: committedVersion,
        riskScore: derived.riskScore,
        riskLevel: derived.riskLevel,
      },
      { wasReevaluated: phase !== 'INITIAL' },
    );
  }

  private async onRefused(
    jobId: string,
    patientId: number,
    staleVersion: number,
    currentVersion: number,
  ): Promise<void> {
    // Cheap indexed lookup first: most refusals have nothing queued, and there is no point reading the patient
    // row to build a cancellation that would cancel nothing.
    const queued = await this.notifications.queuedForPatient(jobId, patientId);
    if (queued.length === 0) return;

    const patient = await this.inner.findById(patientId);
    if (!patient) return;

    await this.notifications.onRefused({
      jobId,
      patientId,
      patientCode: patient.patientCode,
      partitionIndex: patient.partitionIndex,
      staleVersion,
      currentVersion,
    });
  }

  private logSuppressed(hook: string, patientId: number, error: unknown): void {
    logger.warn('notification hook failed; the write itself succeeded', {
      hook,
      patientId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ------------------------------------------------------------------ plain delegation

  findById(id: number): Promise<Patient | null> {
    return this.inner.findById(id);
  }

  findByCode(patientCode: string): Promise<Patient | null> {
    return this.inner.findByCode(patientCode);
  }

  findByPartition(partitionIndex: number): Promise<Patient[]> {
    return this.inner.findByPartition(partitionIndex);
  }

  findPage(query: PatientQuery): Promise<Paginated<Patient>> {
    return this.inner.findPage(query);
  }

  countAll(): Promise<number> {
    return this.inner.countAll();
  }

  countByStatus(): Promise<Record<string, number>> {
    return this.inner.countByStatus();
  }

  allIds(): Promise<number[]> {
    return this.inner.allIds();
  }

  /**
   * Passed straight through with **no** notification hook.
   *
   * The unsafe path belongs to the naive comparison engine. Alerting from it would mean the demonstrably broken
   * engine also produced alerts, which would confuse the one comparison the project exists to make.
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
  ): Promise<GuardedWriteResult> {
    return this.inner.applyUnguardedWholeRow(
      patientId,
      staleSnapshot,
      derived,
      sourceVersion,
      ledger,
    );
  }

  markStatus(patientId: number, status: BackfillStatus): Promise<void> {
    return this.inner.markStatus(patientId, status);
  }

  applyOnlineUpdate(
    ...args: Parameters<PatientRepository['applyOnlineUpdate']>
  ): ReturnType<PatientRepository['applyOnlineUpdate']> {
    return this.inner.applyOnlineUpdate(...args);
  }

  listOnlineUpdates(
    patientId?: number,
  ): ReturnType<PatientRepository['listOnlineUpdates']> {
    return this.inner.listOnlineUpdates(patientId);
  }

  recordConsideration(entry: ConsiderationEntry): Promise<void> {
    return this.inner.recordConsideration(entry);
  }

  consideredPatientIds(jobId: string): Promise<number[]> {
    return this.inner.consideredPatientIds(jobId);
  }

  listConsiderations(
    jobId: string,
  ): ReturnType<PatientRepository['listConsiderations']> {
    return this.inner.listConsiderations(jobId);
  }

  listWriteLedger(jobId: string): ReturnType<PatientRepository['listWriteLedger']> {
    return this.inner.listWriteLedger(jobId);
  }

  patientEvidence(patientId: number): Promise<PatientEvidence> {
    return this.inner.patientEvidence(patientId);
  }

  recordConflict(entry: ConflictEntry): Promise<number> {
    return this.inner.recordConflict(entry);
  }

  resolveConflict(
    ...args: Parameters<PatientRepository['resolveConflict']>
  ): Promise<void> {
    return this.inner.resolveConflict(...args);
  }

  listConflicts(jobId: string): ReturnType<PatientRepository['listConflicts']> {
    return this.inner.listConflicts(jobId);
  }

  openConflictCount(jobId: string): Promise<number> {
    return this.inner.openConflictCount(jobId);
  }

  pendingResults(jobId: string, state?: string): Promise<PendingResultRecord[]> {
    return this.inner.pendingResults(jobId, state);
  }

  setPendingResultState(id: number, state: string): Promise<void> {
    return this.inner.setPendingResultState(id, state);
  }
}
