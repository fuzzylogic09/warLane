/**
 * rng.js — Seeded pseudo-random number generator (mulberry32).
 * Produces deterministic sequences given the same seed.
 * Drop-in replacement for Math.random() in simulation contexts.
 */

/**
 * Create a seeded RNG function.
 * @param {number} seed - integer seed
 * @returns {() => number} rng() returns [0, 1)
 */
export function createRng(seed) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0; s = s + 0x6d2b79f5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform float in [min, max)
 */
export function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

/**
 * Random integer in [min, max]
 */
export function randInt(rng, min, max) {
  return Math.floor(randRange(rng, min, max + 1));
}

/**
 * Random element from array
 */
export function randChoice(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}
