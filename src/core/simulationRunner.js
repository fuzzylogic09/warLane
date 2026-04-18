/**
 * simulationRunner.js — Headless batch simulation engine.
 *
 * Runs N games at maximum speed (no rendering, no timers).
 * Compatible with Node.js and Web Workers.
 *
 * Usage:
 *   const results = await runSimulationBatch({
 *     runs: 1000,
 *     baseConfig,
 *     scoringWeights,
 *     paramSpace,
 *     rangeOverrides,
 *     dt: 100,
 *     maxDurationMs: 300000,
 *     seed: 42,
 *     onProgress: (done, total, best) => {}
 *   });
 */

import { GameEngine } from './gameEngine.js';
import { scoreResult, aggregateBatch } from './scoring.js';
import { createRng } from './rng.js';
import { generateRandomConfig, DEFAULT_PARAM_SPACE } from './randomSearch.js';

/**
 * Run a single game to completion.
 *
 * @param {object} config         - Gameplay config
 * @param {object} options        - { dt, maxDurationMs, seed }
 * @returns {{ winner, stats }}
 */
export function runSingleGame(config, { dt = 100, maxDurationMs = 300000, seed, headless = true } = {}) {
  const engine = new GameEngine(config, seed, { headless });
  engine.init();
  const s = engine.state;
  let simTime = 0;

  while (s.running && simTime < maxDurationMs) {
    engine.step(dt, dt); // headless: scaled == real for determinism
    simTime += dt;
  }

  if (s.running) {
    // Timeout — determine winner by territory
    const pc = s.cells.filter(c => c.owner === 'player').length;
    const ec = s.cells.filter(c => c.owner === 'enemy').length;
    s.winner = pc > ec ? 'player' : pc < ec ? 'enemy' : 'draw';
    s.running = false;
  }

  const stats = engine.getStats();
  if (!stats.durationMs) stats.durationMs = simTime;
  return { winner: stats.winner, stats };
}

/**
 * Run a batch of simulations with random configs.
 *
 * @param {object} options
 * @param {number}   options.runs              - Number of runs
 * @param {object}   options.baseConfig        - Base gameplay config
 * @param {object}   options.scoringWeights    - Scoring weights config
 * @param {object}   [options.paramSpace]      - Search space (default: DEFAULT_PARAM_SPACE)
 * @param {object}   [options.rangeOverrides]  - Per-key [min,max] overrides
 * @param {number}   [options.dt=100]          - Sim step size in ms
 * @param {number}   [options.maxDurationMs=300000] - Max game duration
 * @param {number}   [options.seed=Date.now()] - Master RNG seed
 * @param {number}   [options.topN=20]         - Number of top configs to return
 * @param {Function} [options.onProgress]      - (done, total, best) => void
 * @returns {BatchResult}
 */
export function runSimulationBatch(options) {
  const {
    runs = 100,
    baseConfig,
    scoringWeights,
    paramSpace = DEFAULT_PARAM_SPACE,
    rangeOverrides = null,
    dt = 100,
    maxDurationMs = 300000,
    seed = Date.now(),
    topN = 20,
    onProgress = null,
  } = options;

  const masterRng = createRng(seed);
  const results = [];

  for (let i = 0; i < runs; i++) {
    const runSeed = (masterRng() * 1e9) | 0;
    const configRng = createRng(runSeed);

    // Generate random config for this run
    const config = generateRandomConfig(baseConfig, paramSpace, rangeOverrides, configRng);
    const gameSeed = (masterRng() * 1e9) | 0;

    const { winner, stats } = runSingleGame(config, { dt, maxDurationMs, seed: gameSeed });
    const { score, breakdown } = scoreResult(stats, scoringWeights);

    results.push({ config, stats, score, breakdown, seed: gameSeed, runIndex: i });

    if (onProgress && (i % 10 === 0 || i === runs - 1)) {
      const best = results.reduce((b, r) => r.score > b.score ? r : b, results[0]);
      onProgress(i + 1, runs, best);
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  const top = results.slice(0, topN);
  const aggregate = aggregateBatch(results);

  return {
    results,
    top,
    aggregate,
    bestConfig: top[0]?.config ?? baseConfig,
    bestScore: top[0]?.score ?? 0,
    totalRuns: runs,
    masterSeed: seed,
  };
}

/**
 * Run a fixed-config batch (all games use the same config — for statistical stability).
 *
 * @param {object} config
 * @param {object} scoringWeights
 * @param {object} options
 * @returns {BatchResult}
 */
export function runFixedConfigBatch(config, scoringWeights, options = {}) {
  const { runs = 50, dt = 100, maxDurationMs = 300000, seed = Date.now(), onProgress } = options;
  const masterRng = createRng(seed);
  const results = [];

  for (let i = 0; i < runs; i++) {
    const gameSeed = (masterRng() * 1e9) | 0;
    const { winner, stats } = runSingleGame(config, { dt, maxDurationMs, seed: gameSeed });
    const { score, breakdown } = scoreResult(stats, scoringWeights);
    results.push({ config, stats, score, breakdown, seed: gameSeed, runIndex: i });
    if (onProgress && (i % 5 === 0 || i === runs - 1)) {
      onProgress(i + 1, runs, null);
    }
  }

  results.sort((a, b) => b.score - a.score);
  return {
    results,
    top: results.slice(0, 5),
    aggregate: aggregateBatch(results),
    bestConfig: config,
    bestScore: results[0]?.score ?? 0,
    totalRuns: runs,
    masterSeed: seed,
  };
}
