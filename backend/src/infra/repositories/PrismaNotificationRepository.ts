import {
  NOTIFICATION_STATUS,
  type NotificationChannel,
  type NotificationReason,
  type NotificationRecord,
  type NotificationStats,
  type NotificationStatus,
  type RiskLevel,
} from '@bg/shared';
import type { PrismaClient } from '../../generated/prisma/client';
import type {
  NotificationDraft,
  NotificationQuery,
  NotificationRepository,
} from '../../domain/ports/NotificationRepository';
import { DatabaseError } from '../../lib/errors';

/**
 * SQLite-backed notification storage.
 *
 * The interesting method is `createOrGet`, which relies on the unique constraint rather than on a read followed
 * by a write. See its docblock for why that distinction matters here specifically.
 */
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Inserts, or returns the row that already holds this idempotency key.
   *
   * ## Why this catches a unique violation instead of checking first
   *
   * `SELECT` then `INSERT` leaves a window between the two. Recovery revisits records concurrently with nothing
   * preventing the same patient being processed twice in quick succession, and in that window both callers would
   * see "no existing row" and both would insert — producing exactly the duplicate alert this key exists to
   * prevent.
   *
   * Letting the database reject the second insert closes the window entirely: uniqueness is decided by the index,
   * atomically, and the loser reads back the winner's row. P2002 is Prisma's unique-constraint code.
   */
  async createOrGet(
    draft: NotificationDraft,
  ): Promise<{ record: NotificationRecord; created: boolean }> {
    try {
      const row = await this.prisma.notification.create({
        data: {
          jobId: draft.jobId,
          patientId: draft.patientId,
          patientCode: draft.patientCode,
          patientVersion: draft.patientVersion,
          riskScore: draft.riskScore,
          riskLevel: draft.riskLevel,
          channel: draft.channel,
          status: draft.status,
          message: draft.message,
          recipient: draft.recipient,
          reason: draft.reason,
          idempotencyKey: draft.idempotencyKey,
        },
      });

      return { record: this.toRecord(row), created: true };
    } catch (cause) {
      const existing = await this.prisma.notification.findUnique({
        where: { idempotencyKey: draft.idempotencyKey },
      });

      // Present means the insert lost a uniqueness race, which is the expected outcome, not a fault.
      if (existing) return { record: this.toRecord(existing), created: false };

      throw new DatabaseError(`creating notification for patient ${draft.patientId}`, cause);
    }
  }

  async findById(id: number): Promise<NotificationRecord | null> {
    const row = await this.prisma.notification.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async findByIdempotencyKey(key: string): Promise<NotificationRecord | null> {
    const row = await this.prisma.notification.findUnique({ where: { idempotencyKey: key } });
    return row ? this.toRecord(row) : null;
  }

  async queuedForPatient(jobId: string, patientId: number): Promise<NotificationRecord[]> {
    const rows = await this.prisma.notification.findMany({
      where: { jobId, patientId, status: NOTIFICATION_STATUS.QUEUED },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => this.toRecord(row));
  }

  async markSent(id: number, providerMessageId: string): Promise<NotificationRecord> {
    const row = await this.prisma.notification.update({
      where: { id },
      data: { status: NOTIFICATION_STATUS.SENT, providerMessageId, sentAt: new Date() },
    });
    return this.toRecord(row);
  }

  async markCancelled(id: number, reason: NotificationReason): Promise<NotificationRecord> {
    const row = await this.prisma.notification.update({
      where: { id },
      data: { status: NOTIFICATION_STATUS.CANCELLED, reason, cancelledAt: new Date() },
    });
    return this.toRecord(row);
  }

  async markFailed(id: number, failureReason: string): Promise<NotificationRecord> {
    const row = await this.prisma.notification.update({
      where: { id },
      data: { status: NOTIFICATION_STATUS.FAILED, failureReason },
    });
    return this.toRecord(row);
  }

  async list(query: NotificationQuery): Promise<NotificationRecord[]> {
    const rows = await this.prisma.notification.findMany({
      where: {
        ...(query.jobId ? { jobId: query.jobId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.riskLevel ? { riskLevel: query.riskLevel } : {}),
        ...(query.patientCode ? { patientCode: query.patientCode } : {}),
      },
      // Newest first: during a run the alert you want is the one that just happened.
      orderBy: { id: 'desc' },
      take: query.limit ?? 200,
    });
    return rows.map((row) => this.toRecord(row));
  }

  /**
   * Aggregated counts, computed in the database.
   *
   * `groupBy` rather than loading every row and counting in JavaScript: on a contended 5,000-record run this is
   * polled by the dashboard, and pulling the full table each time to derive four integers would be wasteful in
   * the one place performance is actually observable.
   */
  async stats(jobId?: string): Promise<NotificationStats> {
    const where = jobId ? { jobId } : {};

    const byStatus = await this.prisma.notification.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });

    const counts: Record<string, number> = {};
    for (const group of byStatus) counts[group.status] = group._count._all;

    /**
     * Distinct patients that reached HIGH on a *sent* alert.
     *
     * Deliberately not counting cancelled rows: a patient whose only alert was cancelled did not have a
     * committed HIGH result, so including them would overstate the number of genuinely high-risk records.
     */
    const highRisk = await this.prisma.notification.findMany({
      where: { ...where, status: NOTIFICATION_STATUS.SENT },
      select: { patientId: true },
      distinct: ['patientId'],
    });

    const sent = counts[NOTIFICATION_STATUS.SENT] ?? 0;
    const failed = counts[NOTIFICATION_STATUS.FAILED] ?? 0;
    const attempted = sent + failed;

    return {
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      highRiskPatients: highRisk.length,
      queued: counts[NOTIFICATION_STATUS.QUEUED] ?? 0,
      sent,
      cancelled: counts[NOTIFICATION_STATUS.CANCELLED] ?? 0,
      failed,
      // Null rather than 100% when nothing was attempted: an unmeasured rate is not a perfect one.
      successRate: attempted === 0 ? null : Math.round((sent / attempted) * 1000) / 10,
    };
  }

  async clearForJob(jobId: string): Promise<void> {
    await this.prisma.notification.deleteMany({ where: { jobId } });
  }

  async clearAll(): Promise<void> {
    await this.prisma.notification.deleteMany();
  }

  private toRecord(row: {
    id: number;
    jobId: string;
    patientId: number;
    patientCode: string;
    patientVersion: number;
    riskScore: number;
    riskLevel: string;
    channel: string;
    status: string;
    message: string;
    recipient: string;
    providerMessageId: string | null;
    reason: string;
    idempotencyKey: string;
    createdAt: Date;
    sentAt: Date | null;
    cancelledAt: Date | null;
    failureReason: string | null;
  }): NotificationRecord {
    return {
      id: row.id,
      jobId: row.jobId,
      patientId: row.patientId,
      patientCode: row.patientCode,
      patientVersion: row.patientVersion,
      riskScore: row.riskScore,
      riskLevel: row.riskLevel as RiskLevel,
      channel: row.channel as NotificationChannel,
      status: row.status as NotificationStatus,
      message: row.message,
      recipient: row.recipient,
      providerMessageId: row.providerMessageId,
      reason: row.reason as NotificationReason,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      failureReason: row.failureReason,
    };
  }
}
