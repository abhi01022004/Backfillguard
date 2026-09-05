import type {
  NotificationChannel,
  NotificationReason,
  NotificationRecord,
  NotificationStats,
  NotificationStatus,
  RiskLevel,
} from '@bg/shared';

/**
 * Persistence for risk notifications.
 *
 * Kept as its own port alongside `PatientRepository` and `JobRepository` rather than folded into either. The
 * reason is the same one that separated those two: they answer different questions with different lifetimes.
 * Notifications belong to a *run's outbound side effects*, not to the dataset and not to the migration attempt.
 *
 * Two adapters implement this and both are held to one shared contract suite, for the same reason as the patient
 * repositories: if SQLite and in-memory disagree about whether a duplicate insert is rejected, every conclusion
 * the tests reach about duplicate suppression stops applying to the running system.
 */

/** What the service supplies when creating a row. Identity and timestamps are the adapter's job. */
export interface NotificationDraft {
  jobId: string;
  patientId: number;
  patientCode: string;
  patientVersion: number;
  riskScore: number;
  riskLevel: RiskLevel;
  channel: NotificationChannel;
  status: NotificationStatus;
  message: string;
  recipient: string;
  reason: NotificationReason;
  idempotencyKey: string;
}

export interface NotificationQuery {
  jobId?: string;
  status?: NotificationStatus;
  riskLevel?: RiskLevel;
  patientCode?: string;
  limit?: number;
}

export interface NotificationRepository {
  /**
   * Inserts a notification, or returns the existing row when the idempotency key is already taken.
   *
   * Returning the existing row rather than throwing is what makes duplicate suppression usable at the call
   * site: the service asks for a notification and gets one, without having to distinguish "created" from
   * "already existed" unless it wants to. `created` reports which happened, so the service knows whether to
   * attempt a send.
   *
   * The uniqueness must be enforced by the storage engine, not by a read-then-write in the adapter. Recovery
   * can revisit the same record while a previous attempt is still in flight, and a check-then-insert would
   * leave a window for exactly the duplicate this is meant to prevent.
   */
  createOrGet(draft: NotificationDraft): Promise<{ record: NotificationRecord; created: boolean }>;

  findById(id: number): Promise<NotificationRecord | null>;
  findByIdempotencyKey(key: string): Promise<NotificationRecord | null>;

  /** QUEUED rows for one patient in one job — the candidates a refused write cancels. */
  queuedForPatient(jobId: string, patientId: number): Promise<NotificationRecord[]>;

  markSent(id: number, providerMessageId: string): Promise<NotificationRecord>;
  markCancelled(id: number, reason: NotificationReason): Promise<NotificationRecord>;
  markFailed(id: number, failureReason: string): Promise<NotificationRecord>;

  list(query: NotificationQuery): Promise<NotificationRecord[]>;

  /** Aggregated counts. Computed in storage rather than by loading every row. */
  stats(jobId?: string): Promise<NotificationStats>;

  /** Removes one job's notifications. Called from the same place run evidence is cleared. */
  clearForJob(jobId: string): Promise<void>;

  /** Removes every notification. Called from the full simulation reset. */
  clearAll(): Promise<void>;
}
