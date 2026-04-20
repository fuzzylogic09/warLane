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
  // Reward close games throughout their duration.
  // Uses the MEAN territory ratio across all samples (not just the final snapshot,
  // which is always 0 or 10 when someone wins).
  let balanceScore = 0;
  if (stats.durationMs > 5000) {
    const th = stats.territoryHistory;
    if (th.length >= 2) {
      const NC = 10;
      // Mean ratio over time (excludes the final sample where one side has 0 cells)
      const samples = th.slice(0, -1); // drop last sample (end-state)
      const meanRatio = samples.reduce((s, p) => s + p.playerCells / NC, 0) / samples.length;
      // Peak at 0.5 → score 1.0; at 0 or 1 → score 0.0
      balanceScore = 1 - Math.abs(meanRatio - 0.5) * 2;
    } else {
      // No history yet — short game, consider it unbalanced
      balanceScore = 0.1;
    }
  }

  // ── 2. Duration score ─────────────────────────────────────────
  // Games that last near idealDurationMs score highest
  const d = Math.min(stats.durationMs, maxDurationMs);
  const dRatio = d / maxDurationMs;
  const idealRatio = idealDurationMs / maxDurationMs;
  const durationScore = Math.max(0, 1 - Math.abs(dRatio - idealRatio) / idealRatio);

  // ── 3. Diversity score ────────────────────────────────────────
  // Measures how varied the combat actually was:
  //   - typeKillDiversity : how many unit types were killed by each side (0-3 each)
  //   - combatBalance     : ratio kills player/enemy (closer to 0.5 = more mutual combat)
  //   - unitMixScore      : were catapults actually used? (slots=3 so expensive, reward it)
  const pKills = stats.kills?.player || {};
  const eKills = stats.kills?.enemy  || {};
  const pProd  = stats.unitsProduced?.player || {};
  const eProd  = stats.unitsProduced?.enemy  || {};

  // Types killed by each side (reflects actual combat encounters)
  const pKillTypes = Object.keys(pKills).filter(t => pKills[t] > 0).length;
  const eKillTypes = Object.keys(eKills).filter(t => eKills[t] > 0).length;
  const killTypeDiversity = (pKillTypes + eKillTypes) / 6; // max = 3+3

  // Were catapults involved in combat?
  const catUsed = (pProd.catapult || 0) + (eProd.catapult || 0) > 0 ? 1 : 0;

  // Total kills on each side — reward mutual attrition over one-sided stomps
  const totalPKills = Object.values(pKills).reduce((s,v) => s+v, 0);
  const totalEKills = Object.values(eKills).reduce((s,v) => s+v, 0);
  const totalKills  = totalPKills + totalEKills;
  const killBalance = totalKills > 0
    ? 1 - Math.abs(totalPKills / totalKills - 0.5) * 2
    : 0;

  const diversityScore = Math.min(1,
    killTypeDiversity * 0.5 +
    killBalance       * 0.3 +
    catUsed           * 0.2
  );

  // ── 4. Frontline dynamics score ───────────────────────────────
  // Reward high frontline movement (not static).
  // Scale changes relative to game duration to avoid penalising short games.
  const flChanges = stats.frontlineChanges || 0;
  const flHistory = stats.frontlineHistory || [];
  const flVariance = _variance(flHistory.filter(v => v >= 0)); // ignore -1 (no frontline)
  // Normalise: expect ~1 change per 10s of sim time
  const expectedChanges = Math.max(1, stats.durationMs / 10000);
  const changeScore = Math.min(1, flChanges / expectedChanges);
  // Variance across NC=10 cells: max meaningful variance ~6
  const varScore = Math.min(1, flVariance / 6);
  const frontlineDynamicsScore = changeScore * 0.6 + varScore * 0.4;

  // ── Stalemate penalty ─────────────────────────────────────────
  // Draws are not stalemates if the frontline was active — check frontline variance
  const flHistory2  = stats.frontlineHistory || [];
  const flVar2      = _variance(flHistory2.filter(v => v >= 0));
  const isDynDraw   = stats.winner === 'draw' || stats.winner === null;
  // Only penalise truly static stalemates (low frontline variance + long duration)
  const stalematePenalty = (stats.stalemateMs > stalemateThresholdMs && flVar2 < 1.5)
    ? Math.min(0.25, (stats.stalemateMs - stalemateThresholdMs) / maxDurationMs * 0.4)
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
