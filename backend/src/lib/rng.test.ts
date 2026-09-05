import { describe, expect, it } from 'vitest';
import { createRng } from './rng';

describe('createRng', () => {
  it('is reproducible for a given seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const drawsA = Array.from({ length: 100 }, () => a.next());
    const drawsB = Array.from({ length: 100 }, () => b.next());
    expect(drawsB).toEqual(drawsA);
  });

  it('differs between seeds', () => {
    const a = Array.from({ length: 20 }, ((r) => () => r.next())(createRng(1)));
    const b = Array.from({ length: 20 }, ((r) => () => r.next())(createRng(2)));
    expect(b).not.toEqual(a);
  });

  it('stays within [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces inclusive integer bounds and hits both ends', () => {
    const rng = createRng(11);
    const seen = new Set<number>();

    for (let i = 0; i < 5_000; i += 1) {
      const value = rng.int(3, 7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      seen.add(value);
    }

    expect([...seen].sort()).toEqual([3, 4, 5, 6, 7]);
  });

  it('handles a single-value integer range', () => {
    expect(createRng(1).int(5, 5)).toBe(5);
  });

  it('rejects an inverted integer range rather than returning nonsense', () => {
    expect(() => createRng(1).int(9, 2)).toThrow(/greater than max/i);
  });

  it('rejects picking from an empty array', () => {
    expect(() => createRng(1).pick([])).toThrow(/empty array/i);
  });

  it('distributes uniformly enough that no band dominates', () => {
    // Guards against a low-bit correlation bug that would visibly cluster generated patients.
    const rng = createRng(20260905);
    const buckets = new Array(10).fill(0);
    const draws = 100_000;

    for (let i = 0; i < draws; i += 1) {
      buckets[Math.floor(rng.next() * 10)] += 1;
    }

    for (const count of buckets) {
      // Each bucket should hold ~10%; allow a generous margin so the test is not flaky.
      expect(count).toBeGreaterThan(draws * 0.085);
      expect(count).toBeLessThan(draws * 0.115);
    }
  });

  describe('reset', () => {
  it('returns the stream to its seeded start', () => {
    /**
     * The property a long-lived server needs. Without it a second run continues from wherever the first left
     * the stream, so "same seed, same run" holds only for a fresh process — and four consecutive live demo runs
     * measured 6, 8, 7 and 7 conflicts.
     */
    const rng = createRng(1234);
    const first = [rng.next(), rng.next(), rng.next()];

    rng.reset();
    expect([rng.next(), rng.next(), rng.next()]).toEqual(first);
  });

  it('resets every fork it handed out, not just the root', () => {
    const rng = createRng(1234);
    const child = rng.fork('online-updates');

    const rootFirst = [rng.next(), rng.next()];
    const childFirst = [child.next(), child.next()];

    rng.reset();

    expect([rng.next(), rng.next()]).toEqual(rootFirst);
    // A child left advanced would keep producing different values, which is exactly the bug.
    expect([child.next(), child.next()]).toEqual(childFirst);
  });

  it('returns the same generator for a repeated fork label', () => {
    // Two generators from one label would produce identical sequences while looking independent.
    const rng = createRng(99);
    expect(rng.fork('a')).toBe(rng.fork('a'));
    expect(rng.fork('a')).not.toBe(rng.fork('b'));
  });
});

describe('fork', () => {
    it('gives an independent, reproducible stream per label', () => {
      const first = createRng(100).fork('patients');
      const second = createRng(100).fork('patients');
      expect(Array.from({ length: 10 }, () => second.next())).toEqual(
        Array.from({ length: 10 }, () => first.next()),
      );
    });

    it('gives different streams for different labels', () => {
      const patients = createRng(100).fork('patients');
      const scenario = createRng(100).fork('scenario');
      expect(Array.from({ length: 10 }, () => scenario.next())).not.toEqual(
        Array.from({ length: 10 }, () => patients.next()),
      );
    });

    it('is unaffected by draws taken from the parent stream', () => {
      // This is the property that makes "same seed, same result" robust: consuming values in one
      // concern must not shift another concern's output.
      const parentA = createRng(500);
      const forkA = parentA.fork('dataset');

      const parentB = createRng(500);
      for (let i = 0; i < 37; i += 1) parentB.next();
      const forkB = parentB.fork('dataset');

      expect(Array.from({ length: 10 }, () => forkB.next())).toEqual(
        Array.from({ length: 10 }, () => forkA.next()),
      );
    });
  });
});
