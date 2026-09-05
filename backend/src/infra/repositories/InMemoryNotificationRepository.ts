import {
  NOTIFICATION_STATUS,
  type NotificationReason,
  type NotificationRecord,
  type NotificationStats,
} from '@bg/shared';
import type {
  NotificationDraft,
  NotificationQuery,
  NotificationRepository,
} from '../../domain/ports/NotificationRepository';

/**
 * In-memory notification storage, for tests and any run that should not touch SQLite.
 *
 * Held to the same contract suite as the Prisma adapter. That matters more than usual here: the duplicate
 * suppression the whole feature depends on is a *uniqueness* property, and if the two adapters disagreed about
 * whether a second insert is rejected, the tests proving "no duplicate alerts" would prove it only of a store the
 * application never uses.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  private rows: NotificationRecord[] = [];
  private nextId = 1;

  /**
   * Timestamps advance by a fixed step per write.
   *
   * Same approach as the other in-memory adapters: `new Date()` is banned in this project's deterministic paths,
   * and a monotonic counter also guarantees two rows written in the same millisecond still order predictably.
   */
  private tick = 0;

  private stamp(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 8, 5, 12, 0, 0) + this.tick * 10).toISOString();
  }

  /**
   * Inserts, or returns the row already holding this key.
   *
   * The Prisma adapter gets this property from a unique index; here it is a lookup, which is safe because this
   * adapter is only ever driven from a single-threaded test or harness. The observable behaviour is identical,
   * which is what the shared contract pins down.
   */
  async createOrGet(
    draft: NotificationDraft,
  ): Promise<{ record: NotificationRecord; created: boolean }> {
    const existing = this.rows.find((row) => row.idempotencyKey === draft.idempotencyKey);
    if (existing) return { record: { ...existing }, created: false };

    const record: NotificationRecord = {
      id: this.nextId++,
      ...draft,
      providerMessageId: null,
      createdAt: this.stamp(),
      sentAt: null,
      cancelledAt: null,
      failureReason: null,
    };

    this.rows.push(record);
    return { record: { ...record }, created: true };
  }

  async findById(id: number): Promise<NotificationRecord | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? { ...row } : null;
  }

  async findByIdempotencyKey(key: string): Promise<NotificationRecord | null> {
    const row = this.rows.find((candidate) => candidate.idempotencyKey === key);
    return row ? { ...row } : null;
  }

  async queuedForPatient(jobId: string, patientId: number): Promise<NotificationRecord[]> {
    return this.rows
      .filter(
        (row) =>
          row.jobId === jobId &&
          row.patientId === patientId &&
          row.status === NOTIFICATION_STATUS.QUEUED,
      )
      .map((row) => ({ ...row }));
  }

  async markSent(id: number, providerMessageId: string): Promise<NotificationRecord> {
    return this.mutate(id, (row) => {
      row.status = NOTIFICATION_STATUS.SENT;
      row.providerMessageId = providerMessageId;
      row.sentAt = this.stamp();
    });
  }

  async markCancelled(id: number, reason: NotificationReason): Promise<NotificationRecord> {
    return this.mutate(id, (row) => {
      row.status = NOTIFICATION_STATUS.CANCELLED;
      row.reason = reason;
      row.cancelledAt = this.stamp();
    });
  }

  async markFailed(id: number, failureReason: string): Promise<NotificationRecord> {
    return this.mutate(id, (row) => {
      row.status = NOTIFICATION_STATUS.FAILED;
      row.failureReason = failureReason;
    });
  }

  async list(query: NotificationQuery): Promise<NotificationRecord[]> {
    return this.rows
      .filter((row) => {
        if (query.jobId && row.jobId !== query.jobId) return false;
        if (query.status && row.status !== query.status) return false;
        if (query.riskLevel && row.riskLevel !== query.riskLevel) return false;
        if (query.patientCode && row.patientCode !== query.patientCode) return false;
        return true;
      })
      // Newest first, matching the SQLite adapter.
      .sort((a, b) => b.id - a.id)
      .slice(0, query.limit ?? 200)
      .map((row) => ({ ...row }));
  }

  async stats(jobId?: string): Promise<NotificationStats> {
    const scoped = jobId ? this.rows.filter((row) => row.jobId === jobId) : this.rows;

    const count = (status: string) => scoped.filter((row) => row.status === status).length;

    const sent = count(NOTIFICATION_STATUS.SENT);
    const failed = count(NOTIFICATION_STATUS.FAILED);
    const attempted = sent + failed;

    // Distinct patients with a *sent* alert; a cancelled-only patient never had a committed HIGH result.
    const highRisk = new Set(
      scoped.filter((row) => row.status === NOTIFICATION_STATUS.SENT).map((row) => row.patientId),
    );

    return {
      total: scoped.length,
      highRiskPatients: highRisk.size,
      queued: count(NOTIFICATION_STATUS.QUEUED),
      sent,
      cancelled: count(NOTIFICATION_STATUS.CANCELLED),
      failed,
      successRate: attempted === 0 ? null : Math.round((sent / attempted) * 1000) / 10,
    };
  }

  async clearForJob(jobId: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.jobId !== jobId);
  }

  async clearAll(): Promise<void> {
    this.rows = [];
    this.nextId = 1;
  }

  private mutate(id: number, apply: (row: NotificationRecord) => void): NotificationRecord {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) {
      throw new Error(`InMemoryNotificationRepository: notification ${id} does not exist`);
    }
    apply(row);
    return { ...row };
  }
}
