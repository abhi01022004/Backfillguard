import {
  BACKFILL_STATUS,
  CONFLICT_RESOLUTION,
  type ActorType,
  type BackfillStatus,
  type ConflictRecord,
  type ConflictResolution,
  type Diagnosis,
  type FieldChange,
  type Paginated,
  type Patient,
  type RiskLevel,
  type UpdateSource,
} from '@bg/shared';
import type { Patient as PrismaPatient, PrismaClient } from '../../generated/prisma/client';
import type {
  ClinicalSnapshot,
  ConflictEntry,
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
import { DatabaseError } from '../../lib/errors';

/**
 * SQLite-backed repository (R5.1, R5.6).
 *
 * The important method here is `applyGuarded`. Everything else is bookkeeping.
 */
export class PrismaPatientRepository implements PatientRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------------------------------------------------------------- mapping

  private toPatient(row: PrismaPatient): Patient {
    return {
      id: row.id,
      patientCode: row.patientCode,
      name: row.name,
      age: row.age,
      bloodPressureSystolic: row.bloodPressureSystolic,
      bloodPressureDiastolic: row.bloodPressureDiastolic,
      heartRate: row.heartRate,
      glucose: row.glucose,
      diagnosis: row.diagnosis as Diagnosis,
      partitionIndex: row.partitionIndex,
      version: row.version,
      riskScore: row.riskScore,
      riskLevel: row.riskLevel as RiskLevel | null,
      backfillStatus: row.backfillStatus as BackfillStatus,
      lastBackfillVersion: row.lastBackfillVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------- reads

  async findById(id: number): Promise<Patient | null> {
    const row = await this.prisma.patient.findUnique({ where: { id } });
    return row ? this.toPatient(row) : null;
  }

  async findByCode(patientCode: string): Promise<Patient | null> {
    const row = await this.prisma.patient.findUnique({ where: { patientCode } });
    return row ? this.toPatient(row) : null;
  }

  async findByPartition(partitionIndex: number): Promise<Patient[]> {
    const rows = await this.prisma.patient.findMany({
      where: { partitionIndex },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => this.toPatient(row));
  }

  async findPage(query: PatientQuery): Promise<Paginated<Patient>> {
    const where = {
      ...(query.status ? { backfillStatus: query.status } : {}),
      ...(query.riskLevel ? { riskLevel: query.riskLevel } : {}),
      ...(query.partitionIndex === undefined ? {} : { partitionIndex: query.partitionIndex }),
      ...(query.q
        ? {
            OR: [
              { patientCode: { contains: query.q } },
              { name: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.patient.count({ where }),
      this.prisma.patient.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map((row) => this.toPatient(row)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async countAll(): Promise<number> {
    return this.prisma.patient.count();
  }

  async countByStatus(): Promise<Record<string, number>> {
    const grouped = await this.prisma.patient.groupBy({
      by: ['backfillStatus'],
      _count: { _all: true },
    });

    const counts: Record<string, number> = {};
    for (const group of grouped) {
      counts[group.backfillStatus] = group._count._all;
    }
    return counts;
  }

  async allIds(): Promise<number[]> {
    const rows = await this.prisma.patient.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  // ---------------------------------------------------------------- guarded write

  /**
   * The safety mechanism, in one place.
   *
   * `updateMany` is used deliberately: Prisma's `update` requires a where clause of unique fields
   * only, so it cannot carry the version predicate. `updateMany` can, and it returns the affected
   * row count — which is exactly the compare-and-set signal we need. A count of 0 means the row moved
   * between the read and the write, and that is treated as authoritative rather than re-checked.
   *
   * Note what is absent from `data`: no clinical field and no `version`. A backfill write can only
   * ever change the derived block, so it is structurally incapable of losing a clinical update.
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
    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = await tx.patient.updateMany({
          where: { id: patientId, version: guardVersion },
          data: {
            riskScore: derived.riskScore,
            riskLevel: derived.riskLevel,
            backfillStatus: derived.backfillStatus,
            lastBackfillVersion: guardVersion,
          },
        });

        const applied = result.count === 1;

        // Read inside the same transaction so the recorded version is the one the write actually saw.
        const row = await tx.patient.findUniqueOrThrow({
          where: { id: patientId },
          select: { version: true },
        });

        await tx.writeLedger.create({
          data: {
            jobId: ledger.jobId,
            patientId,
            guardVersion,
            rowVersionAtWrite: row.version,
            applied,
            guarded: true,
            wroteSourceFields: false,
            scoreWritten: applied ? derived.riskScore : null,
            resultingLastBfVer: applied ? guardVersion : null,
            phase: ledger.phase,
          },
        });

        return { applied, guardVersion, currentVersion: row.version };
      });
    } catch (cause) {
      throw new DatabaseError(`guarded write for patient ${patientId}`, cause);
    }
  }

  /**
   * The unsafe path, for the naive comparison only.
   *
   * Two things make it unsafe, and both are the point: there is no version predicate, and it writes
   * the *whole row* back from a stale snapshot, so clinical values that changed after the read are
   * reverted. This is what a backfill built on "load entity, mutate, save entity" does.
   */
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
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.patient.findUniqueOrThrow({
          where: { id: patientId },
          select: { version: true },
        });

        await tx.patient.update({
          where: { id: patientId },
          data: {
            // Reverting clinical values from the stale snapshot: the lost update.
            age: staleSnapshot.age,
            bloodPressureSystolic: staleSnapshot.bloodPressureSystolic,
            bloodPressureDiastolic: staleSnapshot.bloodPressureDiastolic,
            heartRate: staleSnapshot.heartRate,
            glucose: staleSnapshot.glucose,
            diagnosis: staleSnapshot.diagnosis,
            riskScore: derived.riskScore,
            riskLevel: derived.riskLevel,
            backfillStatus: derived.backfillStatus,
            lastBackfillVersion: sourceVersion,
          },
        });

        await tx.writeLedger.create({
          data: {
            jobId: ledger.jobId,
            patientId,
            guardVersion: sourceVersion,
            rowVersionAtWrite: before.version,
            applied: true,
            guarded: false,
            wroteSourceFields: true,
            scoreWritten: derived.riskScore,
            resultingLastBfVer: sourceVersion,
            phase: ledger.phase,
          },
        });

        return { applied: true, guardVersion: sourceVersion, currentVersion: before.version };
      });
    } catch (cause) {
      throw new DatabaseError(`unguarded write for patient ${patientId}`, cause);
    }
  }

  async markStatus(patientId: number, status: BackfillStatus): Promise<void> {
    await this.prisma.patient.update({
      where: { id: patientId },
      data: { backfillStatus: status },
    });
  }

  // ---------------------------------------------------------------- online updates

  async applyOnlineUpdate(
    patientId: number,
    expectedVersion: number,
    changes: Partial<ClinicalSnapshot>,
    actorType: ActorType,
    source: UpdateSource,
  ): Promise<{ patient: Patient; changedFields: FieldChange[] } | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.patient.findUnique({ where: { id: patientId } });
        if (!before) return null;

        const changedFields: FieldChange[] = [];
        for (const [field, value] of Object.entries(changes)) {
          if (value === undefined) continue;
          const previous = before[field as keyof PrismaPatient];
          if (previous === value) continue;
          changedFields.push({
            field: field as FieldChange['field'],
            from: previous as string | number,
            to: value as string | number,
          });
        }

        // A no-op update must not burn a version: the version sequence should mean something.
        if (changedFields.length === 0) {
          return { patient: this.toPatient(before), changedFields: [] };
        }

        const result = await tx.patient.updateMany({
          where: { id: patientId, version: expectedVersion },
          data: { ...changes, version: { increment: 1 } },
        });

        if (result.count !== 1) return null;

        const after = await tx.patient.findUniqueOrThrow({ where: { id: patientId } });

        await tx.onlineUpdate.create({
          data: {
            patientId,
            actorType,
            changedFields: JSON.stringify(changedFields),
            previousVersion: expectedVersion,
            newVersion: after.version,
            source,
          },
        });

        return { patient: this.toPatient(after), changedFields };
      });
    } catch (cause) {
      throw new DatabaseError(`online update for patient ${patientId}`, cause);
    }
  }

  async listOnlineUpdates(
    patientId?: number,
  ): Promise<(OnlineUpdateWrite & { id: number; createdAt: string })[]> {
    const rows = await this.prisma.onlineUpdate.findMany({
      ...(patientId === undefined ? {} : { where: { patientId } }),
      orderBy: [{ patientId: 'asc' }, { newVersion: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      patientId: row.patientId,
      actorType: row.actorType as ActorType,
      changedFields: JSON.parse(row.changedFields) as FieldChange[],
      previousVersion: row.previousVersion,
      newVersion: row.newVersion,
      source: row.source as UpdateSource,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ---------------------------------------------------------------- ledgers

  /**
   * Upsert rather than insert: recovery legitimately revisits records, and re-deciding one must
   * update its outcome instead of adding a second row that would inflate the coverage count.
   */
  async recordConsideration(entry: ConsiderationEntry): Promise<void> {
    await this.prisma.considerationLedger.upsert({
      where: { jobId_patientId: { jobId: entry.jobId, patientId: entry.patientId } },
      create: {
        jobId: entry.jobId,
        patientId: entry.patientId,
        outcome: entry.outcome,
        sourceVersion: entry.sourceVersion,
        appliedVersion: entry.appliedVersion,
        attempts: entry.attempts,
        phase: entry.phase,
        reason: entry.reason,
      },
      update: {
        outcome: entry.outcome,
        sourceVersion: entry.sourceVersion,
        appliedVersion: entry.appliedVersion,
        attempts: entry.attempts,
        phase: entry.phase,
        reason: entry.reason,
      },
    });
  }

  async consideredPatientIds(jobId: string): Promise<number[]> {
    const rows = await this.prisma.considerationLedger.findMany({
      where: { jobId },
      select: { patientId: true },
      orderBy: { patientId: 'asc' },
    });
    return rows.map((row) => row.patientId);
  }

  async listConsiderations(
    jobId: string,
  ): Promise<(ConsiderationEntry & { decidedAt: string })[]> {
    const rows = await this.prisma.considerationLedger.findMany({
      where: { jobId },
      orderBy: { patientId: 'asc' },
    });

    return rows.map((row) => ({
      jobId: row.jobId,
      patientId: row.patientId,
      outcome: row.outcome as ConsiderationEntry['outcome'],
      sourceVersion: row.sourceVersion,
      appliedVersion: row.appliedVersion,
      attempts: row.attempts,
      phase: row.phase,
      reason: row.reason,
      decidedAt: row.decidedAt.toISOString(),
    }));
  }

  async listWriteLedger(
    jobId: string,
  ): Promise<(WriteLedgerEntry & { id: number; createdAt: string })[]> {
    const rows = await this.prisma.writeLedger.findMany({
      where: { jobId },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      patientId: row.patientId,
      guardVersion: row.guardVersion,
      rowVersionAtWrite: row.rowVersionAtWrite,
      applied: row.applied,
      guarded: row.guarded,
      wroteSourceFields: row.wroteSourceFields,
      scoreWritten: row.scoreWritten,
      resultingLastBfVer: row.resultingLastBfVer,
      phase: row.phase,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ---------------------------------------------------------------- conflicts

  async recordConflict(entry: ConflictEntry): Promise<number> {
    const row = await this.prisma.conflict.create({
      data: {
        jobId: entry.jobId,
        patientId: entry.patientId,
        sourceVersion: entry.sourceVersion,
        currentVersion: entry.currentVersion,
        oldScore: entry.oldScore,
        changedFields: JSON.stringify(entry.changedFields),
        resolution: CONFLICT_RESOLUTION.PENDING,
      },
      select: { id: true },
    });
    return row.id;
  }

  async resolveConflict(
    conflictId: number,
    resolution: ConflictResolution,
    newScore: number | null,
  ): Promise<void> {
    await this.prisma.conflict.update({
      where: { id: conflictId },
      data: { resolution, newScore, resolvedAt: new Date() },
    });
  }

  async listConflicts(jobId: string): Promise<ConflictRecord[]> {
    const rows = await this.prisma.conflict.findMany({
      where: { jobId },
      orderBy: { id: 'asc' },
      include: { patient: { select: { patientCode: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      patientId: row.patientId,
      patientCode: row.patient.patientCode,
      sourceVersion: row.sourceVersion,
      currentVersion: row.currentVersion,
      oldScore: row.oldScore,
      newScore: row.newScore,
      changedFields: JSON.parse(row.changedFields) as FieldChange[],
      resolution: row.resolution as ConflictResolution,
      detectedAt: row.detectedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    }));
  }

  async openConflictCount(jobId: string): Promise<number> {
    return this.prisma.conflict.count({
      where: { jobId, resolution: CONFLICT_RESOLUTION.PENDING },
    });
  }

  // ---------------------------------------------------------------- staged results

  async stagePendingResults(entries: PendingResultWrite[]): Promise<void> {
    if (entries.length === 0) return;

    await this.prisma.pendingResult.createMany({
      data: entries.map((entry) => ({
        jobId: entry.jobId,
        patientId: entry.patientId,
        sourceVersion: entry.sourceVersion,
        computedScore: entry.computedScore,
        computedLevel: entry.computedLevel,
        inputSnapshot: JSON.stringify(entry.inputSnapshot),
      })),
    });
  }

  async pendingResults(jobId: string, state?: string): Promise<PendingResultRecord[]> {
    const rows = await this.prisma.pendingResult.findMany({
      where: { jobId, ...(state ? { state } : {}) },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      patientId: row.patientId,
      sourceVersion: row.sourceVersion,
      computedScore: row.computedScore,
      computedLevel: row.computedLevel as RiskLevel,
      inputSnapshot: JSON.parse(row.inputSnapshot) as ClinicalSnapshot,
      state: row.state,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async setPendingResultState(id: number, state: string): Promise<void> {
    await this.prisma.pendingResult.update({ where: { id }, data: { state } });
  }

  // ---------------------------------------------------------------- lifecycle

  async replaceAll(
    patients: Omit<Patient, 'id' | 'createdAt' | 'updatedAt'>[],
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // Cascades clear the dependent ledger, conflict, update and staged-result rows.
        await tx.patient.deleteMany();

        const CHUNK = 200;
        for (let offset = 0; offset < patients.length; offset += CHUNK) {
          await tx.patient.createMany({
            data: patients.slice(offset, offset + CHUNK).map((patient) => ({
              patientCode: patient.patientCode,
              name: patient.name,
              age: patient.age,
              bloodPressureSystolic: patient.bloodPressureSystolic,
              bloodPressureDiastolic: patient.bloodPressureDiastolic,
              heartRate: patient.heartRate,
              glucose: patient.glucose,
              diagnosis: patient.diagnosis,
              partitionIndex: patient.partitionIndex,
              version: patient.version,
              riskScore: patient.riskScore,
              riskLevel: patient.riskLevel,
              backfillStatus: patient.backfillStatus,
              lastBackfillVersion: patient.lastBackfillVersion,
            })),
          });
        }
      });
    } catch (cause) {
      throw new DatabaseError('replacing the patient dataset', cause);
    }
  }

  async clearSimulationState(): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.eventLog.deleteMany();
        await tx.writeLedger.deleteMany();
        await tx.considerationLedger.deleteMany();
        await tx.conflict.deleteMany();
        await tx.pendingResult.deleteMany();
        await tx.checkpoint.deleteMany();
        await tx.onlineUpdate.deleteMany();
        await tx.backfillJob.deleteMany();

        // Return every patient to an unscored baseline so coverage is measured from a clean start.
        await tx.patient.updateMany({
          data: {
            riskScore: null,
            riskLevel: null,
            backfillStatus: BACKFILL_STATUS.PENDING,
            lastBackfillVersion: null,
          },
        });
      });
    } catch (cause) {
      throw new DatabaseError('clearing simulation state', cause);
    }
  }
}
