/**
 * gameState.js — Pure data container for a WarLane game instance.
 * No logic, no DOM. Serialisable & clonable.
 */

export class GameState {
  /**
   * @param {object} config - Parsed gameplay.default.json
   * @param {number} [seed]  - RNG seed for deterministic runs
   */
  constructor(config, seed = Math.random() * 1e9 | 0) {
    this.config = config;
    this.seed = seed;

    // Core runtime
    this.running = false;
    this.paused = false;
    this.winner = null;       // null | 'player' | 'enemy'
    this.elapsedMs = 0;       // total real-time elapsed (scaled)

    // Cells: array[NC] of { owner, cq, units[], morale }
    this.cells = [];

    // Projectiles in flight
    this.projectiles = [];

    // Gold
    this.gold = { p: 300, e: 300 };

    // Buildings queues: { [buildingId]: { queue: [{elapsed,total,unit}] } }
    this.buildings = {};   // player
    this.eBuildings = {};  // enemy

    // Active buffs: { player: { frenzy: ms }, enemy: {} }
    this.buffs = { player: {}, enemy: {} };

    // Player ability cooldowns (ms remaining): { warrior:0, archer:0, catapult:0 }
    this.abilityCooldowns = {};

    // Pending move orders: Map<unitId, destCellIndex>
    this.moveOrders = new Map();

    // Internal timers (all in sim-scaled ms)
    this.aiTimer = 0;
    this.moveAccum = 0;   // real-time accumulator for step movement
    this.eventTimer = 0;
    this.nextEventAt = 0;

    // Pending wall placement (player built a wall, waiting to choose a cell)
    this.pendingWall = false;

    // ── Simulation stats ──────────────────────────────────────────
    this.stats = {
      frontlineChanges: 0,
      cellCaptures: 0,
      unitsProduced: { player: {}, enemy: {} },
      kills: { player: {}, enemy: {} },
      abilityUses: {},
      goldHistory: [],          // [{t, p, e}] sampled periodically
      territoryHistory: [],     // [{t, playerCells}] sampled periodically
      frontlineHistory: [],     // [cellIndex] sampled
      stalemateMs: 0,
      lastFrontline: -1,
      lastCaptureSide: null,
    };
  }

  /**
   * Deep-clone the state (for branch / snapshot).
   * Note: config is shared by reference (immutable).
   */
  clone() {
    const s = new GameState(this.config, this.seed);
    s.running = this.running;
    s.paused = this.paused;
    s.winner = this.winner;
    s.elapsedMs = this.elapsedMs;
    s.nextUnitId = this.nextUnitId;

    s.cells = this.cells.map(c => ({
      owner: c.owner,
      cq: c.cq,
      morale: c.morale,
      units: c.units.map(u => ({ ...u })),
    }));

    s.projectiles = this.projectiles.map(p => ({ ...p, tgt: { ...p.tgt } }));
    s.gold = { ...this.gold };

    s.buildings = JSON.parse(JSON.stringify(this.buildings));
    s.eBuildings = JSON.parse(JSON.stringify(this.eBuildings));
    s.buffs = JSON.parse(JSON.stringify(this.buffs));
    s.abilityCooldowns = { ...this.abilityCooldowns };
    s.moveOrders = new Map(this.moveOrders);

    s.aiTimer = this.aiTimer;
    s.moveAccum = this.moveAccum;
    s.eventTimer = this.eventTimer;
    s.nextEventAt = this.nextEventAt;

    s.stats = JSON.parse(JSON.stringify({
      ...this.stats,
      goldHistory: [],
      territoryHistory: [],
      frontlineHistory: [],
    }));
    return s;
  }
}
