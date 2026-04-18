/**
 * scoring.js — Multi-objective scoring for WarLane simulation results.
 *
 * Converts raw simulation stats into a single quality score [0..1]
 * used by the random-search and genetic optimiser.
 */

/**
 * Compute score for a single simulation result.
 *
 * @param {object} stats     - result from engine.getStats()
 * @param {object} weights   - scoring.default.json
 * @returns {{ score, breakdown }}
 */
export function scoreResult(stats, weights) {
  const {
    balanceWeight = 0.35,
    durationWeight = 0.25,
    diversityWeight = 0.20,
    frontlineWeight = 0.20,
    idealDurationMs = 90000,
    maxDurationMs = 300000,
    stalemateThresholdMs = 15000,
  } = weights;

  // ── 1. Balance score ──────────────────────────────────────────
  // Reward close games (neither side stomped immediately)
  // Based on final territory ratio (use winner as proxy)
  let balanceScore = 0;
  if (stats.durationMs > 5000) {
    const th = stats.territoryHistory;
    if (th.length > 0) {
      const last = th[th.length - 1];
      const total = 10; // NC
      const ratio = last.playerCells / total; // 0..1
      // Ideal ratio = 0.5 (even game). Score peaks at 0.5.
      balanceScore = 1 - Math.abs(ratio - 0.5) * 2;
    } else {
      // Fallback: draw between winners is considered perfectly balanced
      balanceScore = stats.winner ? 0.5 : 1;
    }
  }

  // ── 2. Duration score ─────────────────────────────────────────
  // Games that last near idealDurationMs score highest
  const d = Math.min(stats.durationMs, maxDurationMs);
  const dRatio = d / maxDurationMs;
  const idealRatio = idealDurationMs / maxDurationMs;
  const durationScore = Math.max(0, 1 - Math.abs(dRatio - idealRatio) / idealRatio);

  // ── 3. Diversity score ────────────────────────────────────────
  // Reward usage of multiple unit types and abilities
  const allKills = { ...stats.kills.player, ...stats.kills.enemy };
  const allProduced = { ...stats.unitsProduced.player, ...stats.unitsProduced.enemy };
  const typeCount = Object.keys(allProduced).length;
  const abilCount = Object.keys(stats.abilityUses || {}).length;
  const diversityScore = Math.min(1, (typeCount / 3) * 0.6 + (abilCount / 3) * 0.4);

  // ── 4. Frontline dynamics score ───────────────────────────────
  // Reward high frontline movement (not static)
  const flChanges = stats.frontlineChanges || 0;
  const flHistory = stats.frontlineHistory || [];
  const flVariance = _variance(flHistory);
  const frontlineDynamicsScore = Math.min(1, flChanges / 20 * 0.5 + Math.min(flVariance, 4) / 4 * 0.5);

  // ── Stalemate penalty ─────────────────────────────────────────
  const stalematePenalty = stats.stalemateMs > stalemateThresholdMs
    ? Math.min(0.3, (stats.stalemateMs - stalemateThresholdMs) / maxDurationMs * 0.5)
    : 0;

  // ── Final weighted score ─────────────────────────────────────
  const raw =
    balanceWeight * balanceScore +
    durationWeight * durationScore +
    diversityWeight * diversityScore +
    frontlineWeight * frontlineDynamicsScore;

  const score = Math.max(0, Math.min(1, raw - stalematePenalty));

  return {
    score,
    breakdown: {
      balance: _r(balanceScore),
      duration: _r(durationScore),
      diversity: _r(diversityScore),
      frontline: _r(frontlineDynamicsScore),
      stalematePenalty: _r(stalematePenalty),
    },
  };
}

/**
 * Aggregate scores across a batch of results.
 * @param {Array<{stats, score}>} results
 * @returns {{ meanScore, winRatePlayer, avgDurationMs, topPreset }}
 */
export function aggregateBatch(results) {
  if (!results.length) return {};
  const scores = results.map(r => r.score);
  const playerWins = results.filter(r => r.stats.winner === 'player').length;
  const durations = results.map(r => r.stats.durationMs);

  return {
    meanScore: _mean(scores),
    stdScore: _std(scores),
    winRatePlayer: playerWins / results.length,
    avgDurationMs: _mean(durations),
    count: results.length,
  };
}

// ─────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────

function _mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function _variance(arr) {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  return _mean(arr.map(v => (v - m) ** 2));
}
function _std(arr) { return Math.sqrt(_variance(arr)); }
function _r(v) { return Math.round(v * 1000) / 1000; }
