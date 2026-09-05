/**
 * Time and pacing, as an injectable port.
 *
 * `Date.now()` and `setTimeout` are banned inside `src/domain` (enforced by a guard test). The reason
 * is the same as for randomness, but sharper: the whole determinism strategy depends on simulation
 * ordering being driven by *processed-record counts* rather than wall-clock timing. A stray
 * `setTimeout` in the engine would reintroduce exactly the race the tick loop exists to remove, and
 * it would fail intermittently — passing in testing and breaking during a live demo.
 *
 * Tests inject `createManualClock()`, which advances only when told to, so the suite needs no sleeps.
 */

export interface Clock {
  /** Current wall-clock time in epoch milliseconds. */
  now(): number;
  /** Current time as an ISO-8601 string, for timestamps written to the database. */
  nowIso(): string;
  /** Resolves after the given delay. Used only for pacing, never for ordering. */
  sleep(ms: number): Promise<void>;
}

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    sleep: (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

export interface ManualClock extends Clock {
  /** Advance simulated time and resolve any sleeps that are now due. */
  advance(ms: number): void;
  /** Resolve every pending sleep immediately, regardless of its delay. */
  drain(): void;
  pendingSleeps(): number;
}

/**
 * A clock that never touches real time.
 *
 * Sleeps queue up and resolve when `advance()` or `drain()` is called, which is what lets the test
 * suite run a full 1,000-record simulation in milliseconds and assert on ordering without a single
 * arbitrary delay.
 */
export function createManualClock(startMs = Date.UTC(2026, 0, 1, 9, 0, 0)): ManualClock {
  let current = startMs;
  let pending: { dueAt: number; resolve: () => void }[] = [];

  function releaseDue(): void {
    const due = pending.filter((entry) => entry.dueAt <= current);
    pending = pending.filter((entry) => entry.dueAt > current);
    for (const entry of due) entry.resolve();
  }

  return {
    now: () => current,
    nowIso: () => new Date(current).toISOString(),

    sleep(ms: number) {
      // A zero-or-negative delay should not force the caller to advance the clock to proceed.
      if (ms <= 0) {
        current += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        pending.push({ dueAt: current + ms, resolve });
      });
    },

    advance(ms: number) {
      current += ms;
      releaseDue();
    },

    drain() {
      const all = pending;
      pending = [];
      // Keep timestamps strictly increasing so event ordering stays observable in assertions.
      current += 1;
      for (const entry of all) entry.resolve();
    },

    pendingSleeps: () => pending.length,
  };
}
