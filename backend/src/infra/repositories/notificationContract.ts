import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CHANNEL,
  NOTIFICATION_REASON,
  NOTIFICATION_STATUS,
  RISK_LEVEL,
} from '@bg/shared';
import type {
  NotificationDraft,
  NotificationRepository,
} from '../../domain/ports/NotificationRepository';

/**
 * One contract, both notification adapters.
 *
 * The property this exists to pin down is **uniqueness on the idempotency key**. Duplicate suppression is the
 * feature's hardest guarantee, and it is delegated entirely to storage. If SQLite rejected a second insert but the
 * in-memory adapter silently accepted one, every test asserting "no duplicate alerts" would be proving it of a
 * store the application never runs against.
 *
 * The other assertions cover the state transitions and the derived statistics, both of which a reimplementation
 * could plausibly get subtly wrong — particularly the decision to exclude cancelled rows from the success rate.
 */

export interface NotificationContractHarness {
  name: string;
  create: () => Promise<NotificationRepository>;
  /** Creates the job and patient rows the notification references, where referential integrity demands it. */
  seed?: (jobId: string, patientIds: number[]) => Promise<void>;
  teardown?: () => Promise<void>;
}

const JOB = 'CONTRACT-JOB';

export function runNotificationRepositoryContract(harness: NotificationContractHarness): void {
  describe(`NotificationRepository contract: ${harness.name}`, () => {
    let repository: NotificationRepository;

    function draft(overrides: Partial<NotificationDraft> = {}): NotificationDraft {
      const patientId = overrides.patientId ?? 1;
      const patientVersion = overrides.patientVersion ?? 3;
      const riskLevel = overrides.riskLevel ?? RISK_LEVEL.HIGH;

      return {
        jobId: JOB,
        patientId,
        patientCode: `P${String(patientId).padStart(4, '0')}`,
        patientVersion,
        riskScore: 78,
        riskLevel,
        channel: NOTIFICATION_CHANNEL.WHATSAPP,
        status: NOTIFICATION_STATUS.QUEUED,
        message: 'demo body',
        recipient: `+91 90000${String(patientId).padStart(5, '0')}`,
        reason: NOTIFICATION_REASON.HIGH_RISK_DETECTED,
        idempotencyKey: `${JOB}:${patientId}:${patientVersion}:${riskLevel}`,
        ...overrides,
      };
    }

    beforeEach(async () => {
      repository = await harness.create();
      await harness.seed?.(JOB, [1, 2, 3, 4, 5]);
    });

    afterEach(async () => {
      await harness.teardown?.();
    });

    // ------------------------------------------------------------------ uniqueness

    it('creates a notification and reports it as new', async () => {
      const { record, created } = await repository.createOrGet(draft());

      expect(created).toBe(true);
      expect(record.id).toBeGreaterThan(0);
      expect(record.status).toBe(NOTIFICATION_STATUS.QUEUED);
      expect(record.providerMessageId).toBeNull();
      expect(record.sentAt).toBeNull();
    });

    it('returns the existing row for a repeated idempotency key, without creating a second', async () => {
      /**
       * The single most important assertion in this file. Recovery revisits records it cannot account for, so the
       * same patient can be committed twice at the same version within one job. Without this, that would produce
       * two alerts for one fact.
       */
      const first = await repository.createOrGet(draft());
      const second = await repository.createOrGet(draft());

      expect(second.created).toBe(false);
      expect(second.record.id).toBe(first.record.id);
      expect(await repository.list({ jobId: JOB })).toHaveLength(1);
    });

    it('preserves the original row when a repeated key arrives with different content', async () => {
      // The key identifies the fact; a later attempt to describe the same fact differently must not overwrite it.
      await repository.createOrGet(draft({ riskScore: 78 }));
      const second = await repository.createOrGet(draft({ riskScore: 99 }));

      expect(second.created).toBe(false);
      expect(second.record.riskScore).toBe(78);
    });

    it('treats a different version as a different notification', async () => {
      // A clinician moved the record, so the recomputed result is genuinely new and must alert again.
      await repository.createOrGet(draft({ patientVersion: 3 }));
      const next = await repository.createOrGet(draft({ patientVersion: 4 }));

      expect(next.created).toBe(true);
      expect(await repository.list({ jobId: JOB })).toHaveLength(2);
    });

    it('treats a different risk level as a different notification', async () => {
      await repository.createOrGet(draft({ riskLevel: RISK_LEVEL.HIGH }));
      const next = await repository.createOrGet(
        draft({ riskLevel: RISK_LEVEL.MEDIUM, idempotencyKey: `${JOB}:1:3:MEDIUM` }),
      );

      expect(next.created).toBe(true);
    });

    // ------------------------------------------------------------------ transitions

    it('marks a notification sent with its provider id and timestamp', async () => {
      const { record } = await repository.createOrGet(draft());
      const sent = await repository.markSent(record.id, 'DEMO-WA-000001');

      expect(sent.status).toBe(NOTIFICATION_STATUS.SENT);
      expect(sent.providerMessageId).toBe('DEMO-WA-000001');
      expect(sent.sentAt).not.toBeNull();
      expect(sent.cancelledAt).toBeNull();
    });

    it('marks a notification cancelled with its reason and timestamp', async () => {
      const { record } = await repository.createOrGet(draft());
      const cancelled = await repository.markCancelled(
        record.id,
        NOTIFICATION_REASON.STALE_NOTIFICATION_CANCELLED,
      );

      expect(cancelled.status).toBe(NOTIFICATION_STATUS.CANCELLED);
      expect(cancelled.reason).toBe(NOTIFICATION_REASON.STALE_NOTIFICATION_CANCELLED);
      expect(cancelled.cancelledAt).not.toBeNull();
      // Never transmitted, so it must not carry a provider id.
      expect(cancelled.providerMessageId).toBeNull();
    });

    it('marks a notification failed with the reason attached', async () => {
      const { record } = await repository.createOrGet(draft());
      const failed = await repository.markFailed(record.id, 'provider refused');

      expect(failed.status).toBe(NOTIFICATION_STATUS.FAILED);
      expect(failed.failureReason).toBe('provider refused');
    });

    // ------------------------------------------------------------------ queries

    it('lists only queued rows for a patient, which is what a refused write cancels', async () => {
      await repository.createOrGet(draft({ patientId: 1, patientVersion: 3 }));
      const second = await repository.createOrGet(draft({ patientId: 1, patientVersion: 4 }));
      await repository.markSent(second.record.id, 'DEMO-WA-000002');
      await repository.createOrGet(draft({ patientId: 2, patientVersion: 3 }));

      const queued = await repository.queuedForPatient(JOB, 1);

      expect(queued).toHaveLength(1);
      expect(queued[0]!.patientVersion).toBe(3);
    });

    it('filters by status, risk level and patient code', async () => {
      const a = await repository.createOrGet(draft({ patientId: 1 }));
      await repository.markSent(a.record.id, 'DEMO-WA-000003');
      await repository.createOrGet(draft({ patientId: 2 }));

      expect(await repository.list({ status: NOTIFICATION_STATUS.SENT })).toHaveLength(1);
      expect(await repository.list({ status: NOTIFICATION_STATUS.QUEUED })).toHaveLength(1);
      expect(await repository.list({ riskLevel: RISK_LEVEL.HIGH })).toHaveLength(2);
      expect(await repository.list({ patientCode: 'P0002' })).toHaveLength(1);
    });

    it('returns the newest notifications first and honours the limit', async () => {
      for (const patientId of [1, 2, 3]) {
        await repository.createOrGet(draft({ patientId }));
      }

      const listed = await repository.list({ limit: 2 });

      expect(listed).toHaveLength(2);
      expect(listed[0]!.patientCode).toBe('P0003');
    });

    it('finds a notification by id and by idempotency key', async () => {
      const { record } = await repository.createOrGet(draft());

      expect((await repository.findById(record.id))?.id).toBe(record.id);
      expect((await repository.findByIdempotencyKey(record.idempotencyKey))?.id).toBe(record.id);
      expect(await repository.findById(999_999)).toBeNull();
      expect(await repository.findByIdempotencyKey('nope')).toBeNull();
    });

    // ------------------------------------------------------------------ statistics

    it('counts each status and the distinct patients actually alerted', async () => {
      const sent1 = await repository.createOrGet(draft({ patientId: 1 }));
      await repository.markSent(sent1.record.id, 'DEMO-WA-000004');

      const sent2 = await repository.createOrGet(draft({ patientId: 2 }));
      await repository.markSent(sent2.record.id, 'DEMO-WA-000005');

      const cancelled = await repository.createOrGet(draft({ patientId: 3 }));
      await repository.markCancelled(
        cancelled.record.id,
        NOTIFICATION_REASON.STALE_NOTIFICATION_CANCELLED,
      );

      await repository.createOrGet(draft({ patientId: 4 }));

      const stats = await repository.stats(JOB);

      expect(stats.total).toBe(4);
      expect(stats.sent).toBe(2);
      expect(stats.cancelled).toBe(1);
      expect(stats.queued).toBe(1);
      expect(stats.failed).toBe(0);
      // Only the two sent: a cancelled-only patient never had a committed HIGH result.
      expect(stats.highRiskPatients).toBe(2);
    });

    it('excludes cancelled rows from the success rate', async () => {
      /**
       * A cancellation is the version guard working, not a delivery failure. Counting it against the success rate
       * would make the safety mechanism look like unreliability — the opposite of what the number should say.
       */
      const sent = await repository.createOrGet(draft({ patientId: 1 }));
      await repository.markSent(sent.record.id, 'DEMO-WA-000006');

      const cancelled = await repository.createOrGet(draft({ patientId: 2 }));
      await repository.markCancelled(
        cancelled.record.id,
        NOTIFICATION_REASON.STALE_NOTIFICATION_CANCELLED,
      );

      expect((await repository.stats(JOB)).successRate).toBe(100);
    });

    it('counts a failure against the success rate', async () => {
      const sent = await repository.createOrGet(draft({ patientId: 1 }));
      await repository.markSent(sent.record.id, 'DEMO-WA-000007');

      const failed = await repository.createOrGet(draft({ patientId: 2 }));
      await repository.markFailed(failed.record.id, 'provider refused');

      expect((await repository.stats(JOB)).successRate).toBe(50);
    });

    it('reports a null success rate when nothing has been attempted', async () => {
      // Not 100%: an unmeasured rate is not a perfect one.
      await repository.createOrGet(draft());
      expect((await repository.stats(JOB)).successRate).toBeNull();
    });

    // ------------------------------------------------------------------ clearing

    it('clears one job without touching another', async () => {
      await repository.createOrGet(draft({ patientId: 1 }));
      await repository.createOrGet(
        draft({ patientId: 2, jobId: 'OTHER-JOB', idempotencyKey: 'OTHER-JOB:2:3:HIGH' }),
      );

      await repository.clearForJob(JOB);

      expect(await repository.list({ jobId: JOB })).toHaveLength(0);
      expect(await repository.list({ jobId: 'OTHER-JOB' })).toHaveLength(1);
    });

    it('clears everything', async () => {
      await repository.createOrGet(draft({ patientId: 1 }));
      await repository.createOrGet(draft({ patientId: 2 }));

      await repository.clearAll();

      expect(await repository.list({})).toHaveLength(0);
      expect((await repository.stats()).total).toBe(0);
    });
  });
}
