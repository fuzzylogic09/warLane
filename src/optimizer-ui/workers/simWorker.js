/**
 * simWorker.js — Web Worker for headless simulation batches.
 *
 * Receives a message: { type: 'run', options }
 * Posts progress:     { type: 'progress', done, total, best }
 * Posts result:       { type: 'done', result }
 */

// Web Worker scope: importScripts / ES module depending on bundler
// Using dynamic import for ES module compatibility
let runSimulationBatch, runFixedConfigBatch;

async function init() {
  const mod = await import('../../core/simulationRunner.js');
  runSimulationBatch = mod.runSimulationBatch;
  runFixedConfigBatch = mod.runFixedConfigBatch;
}

const ready = init();

self.addEventListener('message', async (e) => {
  await ready;
  const { type, options } = e.data;

  if (type === 'run') {
    // Ensure seed is non-zero and unique even if multiple workers start at same millisecond
    const seed = options.seed && options.seed !== 0
      ? options.seed
      : (Date.now() ^ (Math.random() * 0xFFFFFFFF >>> 0)) >>> 0;

    const result = runSimulationBatch({
      ...options,
      seed,
      onProgress: (done, total, best) => {
        self.postMessage({ type: 'progress', done, total, best: best ? _safeResult(best) : null });
      },
    });
    self.postMessage({ type: 'done', result: _safeResult(result) });
  }

  if (type === 'runFixed') {
    const seed = options.seed && options.seed !== 0
      ? options.seed
      : (Date.now() ^ (Math.random() * 0xFFFFFFFF >>> 0)) >>> 0;

    const result = runFixedConfigBatch(options.config, options.scoringWeights, {
      ...options,
      seed,
      onProgress: (done, total) => {
        self.postMessage({ type: 'progress', done, total, best: null });
      },
    });
    self.postMessage({ type: 'done', result: _safeResult(result) });
  }
});

/** Strip non-serialisable fields before postMessage */
function _safeResult(r) {
  if (!r) return r;
  // Top results only for transfer size
  const safe = {
    aggregate: r.aggregate,
    bestScore: r.bestScore,
    totalRuns: r.totalRuns,
    masterSeed: r.masterSeed,
    bestConfig: r.bestConfig,
    top: (r.top || []).map(item => ({
      score: item.score,
      breakdown: item.breakdown,
      seed: item.seed,
      runIndex: item.runIndex,
      stats: _safeStats(item.stats),
      config: item.config,
    })),
  };
  return safe;
}

function _safeStats(stats) {
  if (!stats) return {};
  return {
    winner: stats.winner,
    durationMs: stats.durationMs,
    frontlineChanges: stats.frontlineChanges,
    cellCaptures: stats.cellCaptures,
    unitsProduced: stats.unitsProduced,
    kills: stats.kills,
    abilityUses: stats.abilityUses,
    stalemateMs: stats.stalemateMs,
  };
}
