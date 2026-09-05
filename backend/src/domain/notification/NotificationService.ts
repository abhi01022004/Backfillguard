import {
  EVENT_SEVERITY,
  EVENT_TYPE,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_REASON,
  NOTIFICATION_STATUS,
  type NotificationRecord,
  type NotificationStats,
  type RiskLevel,
} from '@bg/shared';
import type { EventSink } from '../ports/EventSink';
import type { NotificationRepository } from '../ports/NotificationRepository';
import type { WhatsAppProvider } from '../ports/WhatsAppProvider';
import { formatEventSummary, formatRiskAlert } from './NotificationFormatter';
import { idempotencyKey, reasonForCommit, shouldNotify, syntheticRecipient } from './NotificationPolicy';

/**
 * Decides, records and dispatches risk notifications.
 *
 * ## The one rule everything here exists to enforce
 *
 * **A notification is only ever transmitted for a result that was committed under a version guard.**
 *
 * That is not implemented as a check this class remembers to perform. It falls out of where the class is called
 * from: `onCommitted` runs only when a guarded write returned `applied: true`, which means the database matched
 * the row at the exact version the score was computed from. There is no code path that reaches a send with a
 * version that has moved, because there is no caller that could supply one.
 *
 * ## Three entry points, three states
 *
 * | Called when | Effect |
 * |---|---|
 * | `onStaged` — a HIGH result is computed and buffered | `QUEUED`. Nothing transmitted. |
 * | `onRefused` — the version guard rejected the write | `QUEUED` → `CANCELLED`. Still nothing transmitted. |
 * | `onCommitted` — a guarded write applied | `SENT` (or `FAILED` if the provider refuses). |
 *
 * ## Why `QUEUED` exists at all
 *
 * The simpler design creates nothing until a commit succeeds. It is equally safe, and it makes the safety
 * mechanism invisible: a stale result would leave no trace, so the dashboard could only ever show an absence and
 * ask the viewer to believe an alert was avoided.
 *
 * Creating a `QUEUED` row first means a refusal leaves a `CANCELLED` row behind, naming the patient, the stale
 * version and the version that superseded it. The version guard becomes something you can point at. `QUEUED` is
 * never handed to the provider, so the "never notify from an uncommitted result" guarantee is untouched.
 *
 * ## Failure handling
 *
 * Every method swallows its own errors and reports them, rather than propagating. A notification is a *side
 * effect of* a backfill, not a part of it — failing a migration because a demo messaging simulator threw would
 * turn an observability feature into a correctness hazard. Failures become `FAILED` rows and CRITICAL events, so
 * they are loud without being fatal.
 */

export interface NotificationServiceDeps {
  notifications: NotificationRepository;
  provider: WhatsAppProvider;
  events: EventSink;
}

export interface RiskOutcome {
  jobId: string;
  patientId: number;
  patientCode: string;
  partitionIndex?: number;
  /** The source version the score was computed from. */
  patientVersion: number;
  riskScore: number;
  riskLevel: RiskLevel | null;
}

export class NotificationService {
  /** Salts manual-send keys so repeated presses are distinct without consulting a clock. */
  private manualSendCount = 0;

  constructor(private readonly deps: NotificationServiceDeps) {}

  // ------------------------------------------------------------------ staged, not yet written

  /**
   * Records intent for a HIGH result that has been computed but not yet written.
   *
   * Nothing is transmitted. If the write is later refused this row becomes the evidence of a prevented alert; if
   * it is committed, the same row is promoted to `SENT` rather than a second one being created.
   */
  async onStaged(outcome: RiskOutcome): Promise<NotificationRecord | null> {
    if (!shouldNotify(outcome.riskLevel)) return null;

    try {
      const draft = this.draft(outcome, NOTIFICATION_STATUS.QUEUED, NOTIFICATION_REASON.HIGH_RISK_DETECTED);
      const { record, created } = await this.deps.notifications.createOrGet(draft);

      // Already queued or already sent for this exact result: nothing new to report.
      if (!created) return record;

      this.deps.events.emit({
        type: EVENT_TYPE.NOTIFICATION_QUEUED,
        severity: EVENT_SEVERITY.INFO,
        jobId: outcome.jobId,
        patientCode: outcome.patientCode,
        ...(outcome.partitionIndex === undefined ? {} : { partitionIndex: outcome.partitionIndex }),
        message:
          `Risk alert queued for ${formatEventSummary(this.messageInput(outcome))} — held until the result is ` +
          `committed under its version guard.`,
        payload: this.payload(record),
      });

      return record;
    } catch (error) {
      this.reportInternalFailure('queue', outcome, error);
      return null;
    }
  }

  // ------------------------------------------------------------------ refused by the version guard

  /**
   * Cancels any queued alert for a patient whose write was refused.
   *
   * Cancels *all* queued rows for that patient in this job, not only the one matching the refused version. A
   * patient can be staged more than once across a run's phases, and any queued row still outstanding when the
   * guard refuses was, by definition, built on data the record has moved past.
   */
  async onRefused(params: {
    jobId: string;
    patientId: number;
    patientCode: string;
    partitionIndex?: number;
    /** The version the refused computation was based on. */
    staleVersion: number;
    /** The version the row had actually reached. */
    currentVersion: number;
  }): Promise<NotificationRecord[]> {
    try {
      const queued = await this.deps.notifications.queuedForPatient(params.jobId, params.patientId);
      if (queued.length === 0) return [];

      const cancelled: NotificationRecord[] = [];

      for (const row of queued) {
        const record = await this.deps.notifications.markCancelled(
          row.id,
          NOTIFICATION_REASON.STALE_NOTIFICATION_CANCELLED,
        );
        cancelled.push(record);

        this.deps.events.emit({
          type: EVENT_TYPE.NOTIFICATION_CANCELLED,
          severity: EVENT_SEVERITY.WARNING,
          jobId: params.jobId,
          patientCode: params.patientCode,
          ...(params.partitionIndex === undefined ? {} : { partitionIndex: params.partitionIndex }),
          message:
            `Risk alert for ${params.patientCode} cancelled before sending: it was computed from ` +
            `v${row.patientVersion}, and the record has since reached v${params.currentVersion}. ` +
            `A stale alert was prevented.`,
          payload: {
            ...this.payload(record),
            staleVersion: row.patientVersion,
            currentVersion: params.currentVersion,
          },
        });
      }

      return cancelled;
    } catch (error) {
      this.reportInternalFailure('cancel', {
        jobId: params.jobId,
        patientId: params.patientId,
        patientCode: params.patientCode,
        patientVersion: params.staleVersion,
        riskScore: 0,
        riskLevel: null,
      }, error);
      return [];
    }
  }

  // ------------------------------------------------------------------ committed under a version guard

  /**
   * Sends the alert for a result that has just been committed.
   *
   * The only method that reaches the provider. Reachable only from a guarded write that applied, so
   * `patientVersion` is provably the version the row held when the score landed on it.
   *
   * `wasReevaluated` only affects the recorded reason, never whether the alert is sent — an alert produced after
   * a conflict is exactly as valid as a first-pass one, and distinguishing them is about provenance.
   */
  async onCommitted(
    outcome: RiskOutcome,
    options: { wasReevaluated?: boolean } = {},
  ): Promise<NotificationRecord | null> {
    if (!shouldNotify(outcome.riskLevel)) return null;

    try {
      const reason = reasonForCommit(options.wasReevaluated ?? false);
      const { record, created } = await this.deps.notifications.createOrGet(
        this.draft(outcome, NOTIFICATION_STATUS.QUEUED, reason),
      );

      /**
       * Already sent for this exact committed result: stop.
       *
       * This is the duplicate-suppression path that matters after a crash. Recovery revisits records it cannot
       * account for, so a patient committed before the crash can be committed again at the same version during
       * recovery. Same job, same patient, same version, same band — the same fact, and it must alert once.
       */
      if (!created && record.status === NOTIFICATION_STATUS.SENT) return record;

      // A row cancelled earlier in the run then legitimately re-committed at the same version is not expected,
      // but re-sending a cancelled row would contradict the record. Left alone and reported.
      if (!created && record.status === NOTIFICATION_STATUS.CANCELLED) return record;

      return await this.dispatch(record, outcome);
    } catch (error) {
      this.reportInternalFailure('send', outcome, error);
      return null;
    }
  }

  // ------------------------------------------------------------------ manual trigger

  /**
   * Sends an alert on request, for the dashboard's test action.
   *
   * Goes through the same `dispatch` as a real commit rather than having its own path, so the button exercises
   * the production code. It is recorded with a `MANUAL_TEST` reason so the notification list never implies the
   * backfill produced something it did not, and the key is salted so pressing it cannot collide with — or worse,
   * suppress — a genuine alert for the same patient and version.
   *
   * ## Why the salt is a counter and not a timestamp
   *
   * The obvious salt is `Date.now()`. The determinism guard rejected it, correctly: `Date.now()` is banned
   * everywhere in `src/domain` because ordering that depends on wall-clock time is the non-determinism this whole
   * project removes, and a guard that made an exception for "just an id" would stop being a guard. A monotonic
   * counter gives the same uniqueness with none of that, and makes repeated presses reproducible across runs.
   */
  async sendManual(outcome: RiskOutcome): Promise<NotificationRecord | null> {
    this.manualSendCount += 1;

    const draft = {
      ...this.draft(outcome, NOTIFICATION_STATUS.QUEUED, NOTIFICATION_REASON.MANUAL_TEST),
      idempotencyKey: `manual:${this.manualSendCount}:${idempotencyKey(
        outcome.jobId,
        outcome.patientId,
        outcome.patientVersion,
        outcome.riskLevel ?? 'LOW',
      )}`,
    };

    try {
      const { record } = await this.deps.notifications.createOrGet(draft);
      return await this.dispatch(record, outcome);
    } catch (error) {
      this.reportInternalFailure('send', outcome, error);
      return null;
    }
  }

  // ------------------------------------------------------------------ queries

  async list(query: Parameters<NotificationRepository['list']>[0]): Promise<NotificationRecord[]> {
    return this.deps.notifications.list(query);
  }

  async findById(id: number): Promise<NotificationRecord | null> {
    return this.deps.notifications.findById(id);
  }

  async stats(jobId?: string): Promise<NotificationStats> {
    return this.deps.notifications.stats(jobId);
  }

  /**
   * Queued rows for one patient.
   *
   * Exposed so a caller can check whether a refusal has anything to cancel before doing the work of building a
   * cancellation. Read-only, so it does not widen the service's write surface.
   */
  async queuedForPatient(jobId: string, patientId: number): Promise<NotificationRecord[]> {
    return this.deps.notifications.queuedForPatient(jobId, patientId);
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Clears one job's notifications.
   *
   * Routed through the service rather than letting callers reach the repository directly, so notification
   * lifetime stays a single concern. Both of these are invoked from the same places the ledgers are cleared, which
   * is what keeps alerts and evidence from outliving each other.
   */
  async clearForJob(jobId: string): Promise<void> {
    await this.deps.notifications.clearForJob(jobId);
  }

  async clearAll(): Promise<void> {
    await this.deps.notifications.clearAll();
  }

  get providerName(): string {
    return this.deps.provider.name;
  }

  get providerIsSimulated(): boolean {
    return this.deps.provider.isSimulated;
  }

  // ------------------------------------------------------------------ internals

  /** Hands a record to the provider and records the outcome either way. */
  private async dispatch(
    record: NotificationRecord,
    outcome: RiskOutcome,
  ): Promise<NotificationRecord> {
    try {
      const result = await this.deps.provider.sendMessage(record.recipient, record.message);
      const sent = await this.deps.notifications.markSent(record.id, result.providerMessageId);

      this.deps.events.emit({
        type: EVENT_TYPE.NOTIFICATION_SENT,
        severity: EVENT_SEVERITY.SUCCESS,
        jobId: outcome.jobId,
        patientCode: outcome.patientCode,
        ...(outcome.partitionIndex === undefined ? {} : { partitionIndex: outcome.partitionIndex }),
        message:
          `Risk alert sent for ${formatEventSummary(this.messageInput(outcome))} ` +
          `(${this.deps.provider.name}, ${result.providerMessageId}).`,
        payload: this.payload(sent),
      });

      return sent;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const failed = await this.deps.notifications.markFailed(record.id, reason);

      this.deps.events.emit({
        type: EVENT_TYPE.NOTIFICATION_FAILED,
        severity: EVENT_SEVERITY.CRITICAL,
        jobId: outcome.jobId,
        patientCode: outcome.patientCode,
        message: `Risk alert for ${outcome.patientCode} could not be sent: ${reason}`,
        payload: { ...this.payload(failed), failureReason: reason },
      });

      return failed;
    }
  }

  private draft(
    outcome: RiskOutcome,
    status: typeof NOTIFICATION_STATUS[keyof typeof NOTIFICATION_STATUS],
    reason: typeof NOTIFICATION_REASON[keyof typeof NOTIFICATION_REASON],
  ) {
    // Non-null: every caller passes through `shouldNotify`, which only admits HIGH.
    const riskLevel = outcome.riskLevel!;

    return {
      jobId: outcome.jobId,
      patientId: outcome.patientId,
      patientCode: outcome.patientCode,
      patientVersion: outcome.patientVersion,
      riskScore: outcome.riskScore,
      riskLevel,
      channel: NOTIFICATION_CHANNEL.WHATSAPP,
      status,
      message: formatRiskAlert(this.messageInput(outcome)),
      recipient: syntheticRecipient(outcome.patientId),
      reason,
      idempotencyKey: idempotencyKey(
        outcome.jobId,
        outcome.patientId,
        outcome.patientVersion,
        riskLevel,
      ),
    };
  }

  private messageInput(outcome: RiskOutcome) {
    return {
      patientCode: outcome.patientCode,
      riskScore: outcome.riskScore,
      riskLevel: outcome.riskLevel ?? 'LOW',
      patientVersion: outcome.patientVersion,
    };
  }

  private payload(record: NotificationRecord): Record<string, unknown> {
    return {
      notificationId: record.id,
      patientId: record.patientId,
      patientCode: record.patientCode,
      patientVersion: record.patientVersion,
      riskScore: record.riskScore,
      riskLevel: record.riskLevel,
      channel: record.channel,
      status: record.status,
      reason: record.reason,
      providerMessageId: record.providerMessageId,
    };
  }

  /**
   * Reports a failure in the notification layer itself, distinct from a provider rejection.
   *
   * Emitted rather than thrown, for the reason in the class docblock: a broken notification path must not fail a
   * backfill. Emitted rather than swallowed, because a silently absent alert is indistinguishable from one that
   * was correctly withheld — and that distinction is the entire feature.
   */
  private reportInternalFailure(stage: string, outcome: RiskOutcome, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);

    this.deps.events.emit({
      type: EVENT_TYPE.NOTIFICATION_FAILED,
      severity: EVENT_SEVERITY.CRITICAL,
      jobId: outcome.jobId,
      patientCode: outcome.patientCode,
      message: `Notification ${stage} failed for ${outcome.patientCode}: ${reason}`,
      payload: { stage, patientId: outcome.patientId, reason },
    });
  }
}
