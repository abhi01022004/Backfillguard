import type { RiskLevel } from './enums';

/**
 * Simulated WhatsApp risk notifications (feature: patient risk alerts).
 *
 * ⚠ Every notification in this system is a **demo artefact**. No message leaves the machine, no real phone
 * number exists anywhere in the codebase, and the message body always carries the synthetic-data disclaimer.
 * The purpose is to demonstrate that an outbound side effect can be attached to a concurrent backfill
 * *without* ever firing on stale data.
 */

/**
 * Lifecycle of one notification.
 *
 * ## Why there is no DELIVERED state
 *
 * The specification for this feature listed one. It is deliberately absent: the demo provider never contacts a
 * network, so it has no way to learn whether anything was delivered. A `DELIVERED` row would be a fabricated
 * measurement — precisely the thing this project refuses elsewhere, where an unmeasured KPI renders as "—"
 * rather than as a plausible zero. A real provider added later can introduce the state along with the webhook
 * that would actually justify it.
 */
export const NOTIFICATION_STATUS = {
  /**
   * Created from a computed-but-uncommitted result. Never transmitted.
   *
   * This state is what makes the version guard *visible* in the notification layer. A result that is refused
   * for staleness leaves behind a cancelled row, so the dashboard can show a doctor's edit preventing an alert
   * rather than showing an absence and asking the viewer to take it on trust.
   */
  QUEUED: 'QUEUED',
  /** Handed to the provider after a version-checked commit. */
  SENT: 'SENT',
  /** The result it was based on was refused by the version guard, so it was never transmitted. */
  CANCELLED: 'CANCELLED',
  /** The provider rejected it. Reported, never silently dropped. */
  FAILED: 'FAILED',
} as const;
export type NotificationStatus =
  (typeof NOTIFICATION_STATUS)[keyof typeof NOTIFICATION_STATUS];

/** Delivery channel. One today; the port exists so another can be added without touching the domain. */
export const NOTIFICATION_CHANNEL = {
  WHATSAPP: 'WHATSAPP',
} as const;
export type NotificationChannel =
  (typeof NOTIFICATION_CHANNEL)[keyof typeof NOTIFICATION_CHANNEL];

/** Why a notification exists, or why it stopped existing. */
export const NOTIFICATION_REASON = {
  /** A committed result reached HIGH for the first time at this version. */
  HIGH_RISK_DETECTED: 'HIGH_RISK_DETECTED',
  /** A conflict was re-evaluated and the recomputed result was still HIGH. */
  HIGH_RISK_RECALCULATED: 'HIGH_RISK_RECALCULATED',
  /** The underlying result was refused by the version guard before it could be transmitted. */
  STALE_NOTIFICATION_CANCELLED: 'STALE_NOTIFICATION_CANCELLED',
  /** Triggered by hand from the dashboard, against synthetic data. */
  MANUAL_TEST: 'MANUAL_TEST',
} as const;
export type NotificationReason =
  (typeof NOTIFICATION_REASON)[keyof typeof NOTIFICATION_REASON];

export interface NotificationRecord {
  id: number;
  jobId: string;
  patientId: number;
  patientCode: string;
  /**
   * The source version the risk result was derived from.
   *
   * On a `SENT` row this is the version the guarded write committed against, so the alert provably describes
   * the data the record held at that moment. On a `CANCELLED` row it is the stale version that was refused,
   * which is what makes the cancellation legible.
   */
  patientVersion: number;
  riskScore: number;
  riskLevel: RiskLevel;
  channel: NotificationChannel;
  status: NotificationStatus;
  /** The full rendered message body, including the mandatory disclaimer. */
  message: string;
  /** Synthetic destination, derived from the patient code. Never a real number. */
  recipient: string;
  /** Provider-assigned id. Null until sent. Demo ids look like `DEMO-WA-000123`. */
  providerMessageId: string | null;
  reason: NotificationReason;
  /**
   * Deterministic deduplication key: `jobId:patientId:version:riskLevel`.
   *
   * Unique in storage, which is what makes duplicate suppression a database constraint rather than a
   * best-effort check. Recovery legitimately revisits records, so without this a recovered run would alert the
   * same patient twice for the same committed result.
   */
  idempotencyKey: string;
  createdAt: string;
  sentAt: string | null;
  cancelledAt: string | null;
  /** Present on a FAILED row. */
  failureReason: string | null;
}

export interface NotificationStats {
  total: number;
  /** Distinct patients that reached HIGH on a committed result. */
  highRiskPatients: number;
  queued: number;
  sent: number;
  cancelled: number;
  failed: number;
  /**
   * Sent as a proportion of everything that was actually attempted (sent + failed).
   *
   * Cancelled rows are excluded from the denominator on purpose. A cancellation is the safety mechanism
   * working, not a delivery failure — folding it in would make the version guard look like unreliability.
   * Null when nothing has been attempted, rather than a flattering 100%.
   */
  successRate: number | null;
}

export interface NotificationListQuery {
  status?: NotificationStatus;
  riskLevel?: RiskLevel;
  patientCode?: string;
  limit?: number;
}
