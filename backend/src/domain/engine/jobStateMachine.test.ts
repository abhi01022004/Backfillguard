import { describe, expect, it } from 'vitest';
import { JOB_STATUS, type JobStatus } from '@bg/shared';
import { InvalidJobStateError } from '../../lib/errors';
import {
  allowedFrom,
  canTransition,
  isActivelyProcessing,
  isDatasetLocked,
  JOB_ACTION,
  resolveVerificationResult,
  transition,
} from './jobStateMachine';

describe('job state machine', () => {
  it('walks the happy path from idle to verified', () => {
    let status: JobStatus = JOB_STATUS.IDLE;

    status = transition(JOB_ACTION.START, status);
    expect(status).toBe(JOB_STATUS.RUNNING);

    status = transition(JOB_ACTION.COMPLETE, status);
    expect(status).toBe(JOB_STATUS.COMPLETED);

    status = transition(JOB_ACTION.VERIFY, status);
    expect(status).toBe(JOB_STATUS.VERIFYING);

    status = resolveVerificationResult(true);
    expect(status).toBe(JOB_STATUS.VERIFIED_SAFE);
  });

  it('walks the crash and recovery path', () => {
    let status: JobStatus = transition(JOB_ACTION.START, JOB_STATUS.IDLE);

    status = transition(JOB_ACTION.CRASH, status);
    expect(status).toBe(JOB_STATUS.CRASHED);

    status = transition(JOB_ACTION.RECOVER, status);
    expect(status).toBe(JOB_STATUS.RECOVERING);

    status = transition(JOB_ACTION.COMPLETE, status);
    expect(status).toBe(JOB_STATUS.COMPLETED);
  });

  it('supports pause and resume from both running and recovering', () => {
    expect(transition(JOB_ACTION.PAUSE, JOB_STATUS.RUNNING)).toBe(JOB_STATUS.PAUSED);
    expect(transition(JOB_ACTION.PAUSE, JOB_STATUS.RECOVERING)).toBe(JOB_STATUS.PAUSED);
    expect(transition(JOB_ACTION.RESUME, JOB_STATUS.PAUSED)).toBe(JOB_STATUS.RUNNING);
  });

  describe('illegal transitions', () => {
    it('refuses to start a job that is already running', () => {
      expect(() => transition(JOB_ACTION.START, JOB_STATUS.RUNNING)).toThrow(InvalidJobStateError);
    });

    it('refuses to recover a job that has not crashed', () => {
      expect(() => transition(JOB_ACTION.RECOVER, JOB_STATUS.RUNNING)).toThrow(
        InvalidJobStateError,
      );
    });

    it('refuses to pause an idle job', () => {
      expect(() => transition(JOB_ACTION.PAUSE, JOB_STATUS.IDLE)).toThrow(InvalidJobStateError);
    });

    it('refuses to verify a job that is still running', () => {
      // Verification is an audit of a finished run. Auditing a moving target would produce numbers
      // that describe no particular moment.
      expect(() => transition(JOB_ACTION.VERIFY, JOB_STATUS.RUNNING)).toThrow(
        InvalidJobStateError,
      );
      expect(() => transition(JOB_ACTION.VERIFY, JOB_STATUS.RECOVERING)).toThrow(
        InvalidJobStateError,
      );
    });

    it('names the current state and the allowed states in the error', () => {
      // This is what lets the UI disable a control with a real explanation instead of failing on click.
      try {
        transition(JOB_ACTION.RECOVER, JOB_STATUS.RUNNING);
        expect.unreachable('expected the transition to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidJobStateError);
        const appError = error as InvalidJobStateError;
        expect(appError.message).toContain('RUNNING');
        expect(appError.message).toContain(JOB_STATUS.CRASHED);
        expect(appError.details?.currentStatus).toBe(JOB_STATUS.RUNNING);
        expect(appError.details?.allowedFrom).toEqual([JOB_STATUS.CRASHED]);
        expect(appError.httpStatus).toBe(409);
      }
    });
  });

  describe('replayability', () => {
    it('allows a fresh start from every settled state', () => {
      // A judge must be able to replay the demo without restarting the server.
      for (const status of [
        JOB_STATUS.IDLE,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.VERIFIED_SAFE,
        JOB_STATUS.VERIFICATION_FAILED,
        JOB_STATUS.FAILED,
      ]) {
        expect(canTransition(JOB_ACTION.START, status)).toBe(true);
      }
    });

    it('allows reset from literally every state', () => {
      // Reset is the escape hatch and must never be blocked, including out of a wedged job mid-demo.
      for (const status of Object.values(JOB_STATUS)) {
        expect(transition(JOB_ACTION.RESET, status)).toBe(JOB_STATUS.IDLE);
      }
    });
  });

  describe('derived predicates', () => {
    it('treats only running and recovering as actively processing', () => {
      expect(isActivelyProcessing(JOB_STATUS.RUNNING)).toBe(true);
      expect(isActivelyProcessing(JOB_STATUS.RECOVERING)).toBe(true);

      for (const status of [
        JOB_STATUS.IDLE,
        JOB_STATUS.PAUSED,
        JOB_STATUS.CRASHED,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.VERIFYING,
        JOB_STATUS.VERIFIED_SAFE,
        JOB_STATUS.FAILED,
      ]) {
        expect(isActivelyProcessing(status)).toBe(false);
      }
    });

    it('locks the dataset while a run is in flight, including while crashed', () => {
      // A crashed job still owns staged results and a partially written dataset, so reseeding under it
      // would destroy the evidence recovery needs.
      for (const status of [
        JOB_STATUS.RUNNING,
        JOB_STATUS.PAUSED,
        JOB_STATUS.CRASHED,
        JOB_STATUS.RECOVERING,
        JOB_STATUS.VERIFYING,
      ]) {
        expect(isDatasetLocked(status)).toBe(true);
      }

      for (const status of [JOB_STATUS.IDLE, JOB_STATUS.COMPLETED, JOB_STATUS.VERIFIED_SAFE]) {
        expect(isDatasetLocked(status)).toBe(false);
      }
    });

    it('maps a failed verification to its own status rather than to FAILED', () => {
      // A job that ran correctly but failed its audit is a different situation from one that crashed,
      // and the report needs to distinguish them.
      expect(resolveVerificationResult(false)).toBe(JOB_STATUS.VERIFICATION_FAILED);
      expect(resolveVerificationResult(true)).toBe(JOB_STATUS.VERIFIED_SAFE);
    });
  });

  it('exposes the allowed source states for UI tooltips', () => {
    expect(allowedFrom(JOB_ACTION.RECOVER)).toEqual([JOB_STATUS.CRASHED]);
    expect(allowedFrom(JOB_ACTION.RESUME)).toEqual([JOB_STATUS.PAUSED]);
  });
});
