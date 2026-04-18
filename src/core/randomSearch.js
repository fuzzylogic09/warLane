/**
 * randomSearch.js — Random search over the gameplay parameter space.
 *
 * Generates random configs within defined ranges.
 * Designed to be extended to genetic algorithms later.
 */

import { createRng, randRange, randInt } from './rng.js';

/**
 * Default parameter search space definition.
 * Each key maps to [min, max] or an array of discrete choices.
 */
export const DEFAULT_PARAM_SPACE = {
  // Economy
  GBASE:       [10,  30],
  GCELL:       [0.5, 2.5],
  CQRATE:      [0.005, 0.025],
  MAXG:        [600, 1200],

  // AI
  AITICK:      [300, 900],
  AI_MOVES:    [1,   5],
  AI_BUILDS:   [1,   4],
  AI_CATAPULT_CHANCE: [0.2, 0.7],

  // Movement
  MOVE_TICK:   [500, 1500],

  // Events
  EVT_MIN:     [10000, 30000],
  EVT_MAX:     [25000, 60000],

  // Unit: warrior
  'units.warrior.hp':    [80,  200],
  'units.warrior.armor': [8,   22],
  'units.warrior.dmg':   [14,  38],
  'units.warrior.aspd':  [900, 2500],
  'units.warrior.cost':  [40,  100],
  'units.warrior.buildTime': [3000, 9000],
  'units.warrior.abil.cd':   [8000, 20000],

  // Unit: archer
  'units.archer.hp':    [45,  110],
  'units.archer.armor': [2,   8],
  'units.archer.dmg':   [12,  32],
  'units.archer.aspd':  [1400, 3500],
  'units.archer.cost':  [55,  130],
  'units.archer.buildTime': [5000, 12000],
  'units.archer.abil.cd':   [12000, 28000],

  // Unit: catapult
  'units.catapult.hp':    [150, 320],
  'units.catapult.armor': [5,   16],
  'units.catapult.dmg':   [40,  100],
  'units.catapult.aspd':  [2500, 7000],
  'units.catapult.cost':  [150, 300],
  'units.catapult.buildTime': [10000, 24000],
  'units.catapult.abil.cd':   [18000, 40000],
};

/**
 * Generate a random config by mutating the base config.
 *
 * @param {object} baseConfig     - The full gameplay JSON config
 * @param {object} paramSpace     - Space to sample from (see DEFAULT_PARAM_SPACE)
 * @param {object} [ranges]       - Optional { paramKey: [min, max] } overrides
 * @param {Function} rng          - RNG function from createRng()
 * @returns {object}              - New config object (deep copy, mutated)
 */
export function generateRandomConfig(baseConfig, paramSpace, ranges, rng) {
  const config = JSON.parse(JSON.stringify(baseConfig));
  const space = ranges ? mergeRanges(paramSpace, ranges) : paramSpace;

  for (const [key, range] of Object.entries(space)) {
    const value = sampleParam(rng, range);
    _setNestedKey(config, key, value);
  }

  // Enforce EVT_MAX > EVT_MIN
  if (config.EVT_MAX <= config.EVT_MIN) config.EVT_MAX = config.EVT_MIN + 5000;

  return config;
}

/**
 * Sample a single parameter from its range spec.
 * @param {Function} rng
 * @param {Array} range  - [min, max] float, [min, max, 'int'], or array of choices
 */
export function sampleParam(rng, range) {
  if (!Array.isArray(range)) return range;
  if (typeof range[0] === 'string') {
    // Discrete choices
    return range[Math.floor(rng() * range.length)];
  }
  const [min, max, type] = range;
  if (type === 'int') return randInt(rng, min, max);
  return Math.round(randRange(rng, min, max) * 100) / 100;
}

/**
 * Merge user-supplied range overrides into the default space.
 */
export function mergeRanges(base, overrides) {
  return { ...base, ...overrides };
}

/**
 * Set a potentially nested key like 'units.warrior.hp' on an object.
 */
function _setNestedKey(obj, dotKey, value) {
  const parts = dotKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Interpolate between two configs (used for genetic crossover prep).
 * @param {object} a
 * @param {object} b
 * @param {number} t  - 0=a, 1=b
 * @param {object} paramSpace
 */
export function interpolateConfigs(a, b, t, paramSpace) {
  const result = JSON.parse(JSON.stringify(a));
  for (const key of Object.keys(paramSpace)) {
    const va = _getNestedKey(a, key);
    const vb = _getNestedKey(b, key);
    if (typeof va === 'number' && typeof vb === 'number') {
      _setNestedKey(result, key, va + (vb - va) * t);
    }
  }
  return result;
}

function _getNestedKey(obj, dotKey) {
  return dotKey.split('.').reduce((cur, k) => cur?.[k], obj);
}
