/**
 * Seeded pseudo-random number generation.
 *
 * `Math.random()` is banned inside `src/domain` (enforced by a guard test) because the entire demo
 * rests on being replayable: the same seed must produce the same dataset, the same conflicts and the
 * same final scores. Every draw goes through this port so randomness is always an explicit,
 * reproducible input rather than ambient state.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform element from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with the given probability (0..1). */
  chance(probability: number): boolean;
  /** A new independent generator derived from this one's seed plus a label. */
  fork(label: string): Rng;
}

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over a linear congruential generator because LCGs show visible correlation in low bits,
 * which would cluster generated patients in a way a judge might notice.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, used to turn a fork label into a stable numeric offset. */
function hashLabel(label: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);

  const rng: Rng = {
    next,

    int(min: number, max: number): number {
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        throw new Error(`Rng.int called with non-finite bounds: ${min}..${max}`);
      }
      if (min > max) {
        throw new Error(`Rng.int called with min (${min}) greater than max (${max})`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },

    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new Error('Rng.pick called with an empty array');
      }
      // Non-null assertion is safe: the index is bounded by the length check above.
      return items[Math.floor(next() * items.length)]!;
    },

    chance(probability: number): boolean {
      return next() < probability;
    },

    /**
     * Forking keeps independent concerns from perturbing each other. Patient generation and scenario
     * scheduling draw from separate streams, so changing how many values one consumes cannot shift
     * the other's output — which would otherwise make the "same seed, same result" guarantee
     * fragile against unrelated code changes.
     */
    fork(label: string): Rng {
      return createRng((seed ^ hashLabel(label)) >>> 0);
    },
  };

  return rng;
}
