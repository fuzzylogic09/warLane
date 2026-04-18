#!/usr/bin/env node
/**
 * run-simulation.js — Node.js CLI for headless WarLane simulations.
 *
 * Usage:
 *   node run-simulation.js [options]
 *
 * Options:
 *   --runs N           Number of runs (default: 100)
 *   --dt N             Sim step ms (default: 100)
 *   --max-dur N        Max game duration in seconds (default: 300)
 *   --seed N           Master RNG seed (default: random)
 *   --config PATH      Path to gameplay JSON (default: ./config/gameplay.default.json)
 *   --scoring PATH     Path to scoring JSON (default: ./config/scoring.default.json)
 *   --output PATH      Output JSON file for results (default: ./results.json)
 *   --top N            Number of top configs to export (default: 20)
 *   --single           Run a single game with the base config and print stats
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { runSimulationBatch, runSingleGame } from './src/core/simulationRunner.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Parse args ──────────────────────────────────
const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const hasFlag = f => args.includes(f);

const RUNS = parseInt(get('--runs', '100'));
const DT = parseInt(get('--dt', '100'));
const MAX_DUR = parseInt(get('--max-dur', '300')) * 1000;
const SEED = parseInt(get('--seed', '0')) || Date.now();
const CFG_PATH = resolve(__dir, get('--config', './config/gameplay.default.json'));
const SCORE_PATH = resolve(__dir, get('--scoring', './config/scoring.default.json'));
const OUT_PATH = resolve(__dir, get('--output', './results.json'));
const TOP = parseInt(get('--top', '20'));
const SINGLE = hasFlag('--single');

// ─── Load config ─────────────────────────────────
const baseConfig = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
const scoringWeights = JSON.parse(readFileSync(SCORE_PATH, 'utf8'));

// ─── Single game mode ─────────────────────────────
if (SINGLE) {
  console.log('\n⚔  WarLane — Single Game Run');
  console.log('─'.repeat(40));
  const start = Date.now();
  const { winner, stats } = runSingleGame(baseConfig, { dt: DT, maxDurationMs: MAX_DUR, seed: SEED });
  const elapsed = Date.now() - start;

  console.log(`Winner:         ${winner}`);
  console.log(`Duration:       ${(stats.durationMs / 1000).toFixed(1)}s`);
  console.log(`Wall clock:     ${elapsed}ms`);
  console.log(`Cell captures:  ${stats.cellCaptures}`);
  console.log(`Front changes:  ${stats.frontlineChanges}`);
  console.log(`Units produced: ${JSON.stringify(stats.unitsProduced)}`);
  console.log(`Kills:          ${JSON.stringify(stats.kills)}`);
  console.log(`Ability uses:   ${JSON.stringify(stats.abilityUses)}`);
  console.log(`Stalemate ms:   ${stats.stalemateMs}`);
  process.exit(0);
}

// ─── Batch run ────────────────────────────────────
console.log(`\n⚗  WarLane Optimizer — ${RUNS} runs`);
console.log(`   DT: ${DT}ms  |  Max: ${MAX_DUR / 1000}s  |  Seed: ${SEED}`);
console.log('─'.repeat(50));

const startTime = Date.now();
let lastReport = 0;

const result = runSimulationBatch({
  runs: RUNS,
  baseConfig,
  scoringWeights,
  dt: DT,
  maxDurationMs: MAX_DUR,
  seed: SEED,
  topN: TOP,
  onProgress: (done, total, best) => {
    const now = Date.now();
    if (now - lastReport > 2000 || done === total) {
      const pct = (done / total * 100).toFixed(0);
      const elapsed = ((now - startTime) / 1000).toFixed(1);
      const eta = done > 0 ? (((now - startTime) / done * (total - done)) / 1000).toFixed(0) : '?';
      process.stdout.write(`\r  [${pct.padStart(3)}%] ${done}/${total}  Elapsed: ${elapsed}s  ETA: ${eta}s  Best: ${best?.score?.toFixed(4) ?? '—'}  `);
      lastReport = now;
    }
  }
});

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log('\n\n✓ Done!');
console.log('─'.repeat(50));
console.log(`Total runs:       ${result.totalRuns}`);
console.log(`Wall clock:       ${totalTime}s`);
console.log(`Mean score:       ${result.aggregate.meanScore?.toFixed(4) ?? '—'}`);
console.log(`Std score:        ${result.aggregate.stdScore?.toFixed(4) ?? '—'}`);
console.log(`Player win rate:  ${(result.aggregate.winRatePlayer * 100).toFixed(1)}%`);
console.log(`Avg duration:     ${(result.aggregate.avgDurationMs / 1000).toFixed(1)}s`);
console.log(`Best score:       ${result.bestScore?.toFixed(5)}`);
console.log('\nTop 5 presets:');
result.top.slice(0, 5).forEach((r, i) => {
  console.log(`  ${i + 1}. Score ${r.score.toFixed(4)}  Winner: ${r.stats.winner}  Dur: ${(r.stats.durationMs/1000).toFixed(0)}s`);
});

// ─── Write output ────────────────────────────────
const output = {
  meta: {
    runs: RUNS,
    dt: DT,
    maxDurationMs: MAX_DUR,
    seed: SEED,
    wallClockMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  },
  aggregate: result.aggregate,
  bestConfig: result.bestConfig,
  bestScore: result.bestScore,
  top: result.top,
};

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`\nResults written to: ${OUT_PATH}`);
