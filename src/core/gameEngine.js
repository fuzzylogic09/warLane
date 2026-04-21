/**
 * gameEngine.js — WarLane core simulation engine v3
 *
 * New in v3:
 *  - Dynamic balance: defender armor/dmg/cqRate bonus when front is deep in home territory
 *  - Wall units: high HP/armor, 0 ATK, one per cell, immovable after placement
 *  - Unit upgrade tree: 3 levels per unit type, researched with gold
 *  - Transit movement: units pass through full cells; if destination captured, retreat to safety
 *  - Symmetric AI: also manages walls and upgrades in headless mode
 */

import { GameState } from './gameState.js';
import { createRng } from './rng.js';

export class GameEngine {
  constructor(config, seed = Math.random() * 1e9 | 0, { headless = false } = {}) {
    this.config  = config;
    this.seed    = seed;
    this.headless = headless;
    this.rng     = createRng(seed);
    this.state   = new GameState(config, seed);
    this._listeners = {};
  }

  // ─────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────

  init() {
    this.rng   = createRng(this.seed);
    this.state = new GameState(this.config, this.seed);
    const cfg = this.config, s = this.state;

    s.running    = true;
    s.nextEventAt = this._rand(cfg.EVT_MIN, cfg.EVT_MAX);

    for (let i = 0; i < cfg.NC; i++) {
      const owner = i < 2 ? 'player' : i >= cfg.NC - 2 ? 'enemy' : 'neutral';
      s.cells.push({ owner, cq: owner === 'player' ? 1 : owner === 'enemy' ? 0 : 0.5,
        units: [], wall: null, morale: 0 });
    }

    this._spawnUnit('player', 'warrior', 0);
    this._spawnUnit('player', 'archer',  1);
    this._spawnUnit('enemy',  'warrior', cfg.NC - 1);
    this._spawnUnit('enemy',  'archer',  cfg.NC - 2);

    cfg.buildings.forEach(b => {
      s.buildings[b.id]  = { queue: [] };
      s.eBuildings[b.id] = { queue: [] };
    });

    // Upgrade state: { [owner]: { [unitType]: level } }
    s.upgrades  = { player: {}, enemy: {} };
    // Upgrade research queues: { [owner]: { [unitType]: { elapsed, total, level } | null } }
    s.upgradeQueues = { player: {}, enemy: {} };

    Object.keys(cfg.units).forEach(type => {
      s.abilityCooldowns[type] = 0;
      s.upgrades.player[type]  = 0;
      s.upgrades.enemy[type]   = 0;
      s.upgradeQueues.player[type] = null;
      s.upgradeQueues.enemy[type]  = null;
    });

    this._emit('init', s);
  }

  step(dt, dtr) {
    const s = this.state;
    if (!s.running || s.paused) return;
    s.elapsedMs += dt;

    this.stepGold(dt);
    this.stepBuildings(dt);
    this.stepUpgrades(dt);
    this.stepConquest(dt);
    this.stepCombat(dt);
    this.stepProjectiles(dt);
    this.stepAbilityCooldowns(dt);
    this.stepBuffs(dt);
    this.stepMovement(dtr ?? dt);
    this.stepAI(dt);
    this.stepEvents(dtr ?? dt);
    this._sampleStats(dt);
    this.checkWin();
  }

  // ─────────────────────────────────────────────────
  // Step methods
  // ─────────────────────────────────────────────────

  stepGold(dt) {
    const { GBASE, GCELL, MAXG } = this.config;
    const s = this.state;
    const pc = s.cells.filter(c => c.owner === 'player').length;
    const ec = s.cells.filter(c => c.owner === 'enemy').length;
    s.gold.p = Math.max(0, Math.min(MAXG, s.gold.p + (GBASE + pc * GCELL) * dt / 1000));
    s.gold.e = Math.max(0, Math.min(MAXG, s.gold.e + (GBASE + ec * GCELL) * dt / 1000));
  }

  stepBuildings(dt) {
    const s = this.state;
    ['buildings', 'eBuildings'].forEach((bk, bi) => {
      const owner = bi === 0 ? 'player' : 'enemy';
      this.config.buildings.forEach(b => {
        const st = s[bk][b.id];
        if (!st?.queue.length) return;
        const it = st.queue[0];
        it.elapsed += dt;
        if (it.elapsed >= it.total) {
          st.queue.shift();
          if (it.unit === 'wall') {
            if (owner === 'player' && !this.headless) {
              // Interactive player places the wall manually
              s.pendingWall = true;
              this._emit('wallReady', { owner });
            } else {
              // AI or headless player: auto-place
              const ci = this._bestWallCell(owner);
              if (ci !== -1) {
                this._placeWall(owner, ci);
                this._emit('wallPlaced', { owner, ci });
              }
            }
          } else {
            const ci = this._bestCell(owner);
            if (ci !== -1) {
              const u = this._spawnUnit(owner, it.unit, ci);
              this._emit('unitReady', { owner, unit: u, ci });
            }
          }
          const ps = s.stats.unitsProduced[owner];
          ps[it.unit] = (ps[it.unit] || 0) + 1;
        }
      });
    });
  }

  stepUpgrades(dt) {
    const s = this.state;
    ['player', 'enemy'].forEach(owner => {
      Object.keys(this.config.units).forEach(type => {
        const q = s.upgradeQueues[owner][type];
        if (!q) return;
        q.elapsed += dt;
        if (q.elapsed >= q.total) {
          s.upgrades[owner][type] = q.level;
          s.upgradeQueues[owner][type] = null;
          this._emit('upgradeComplete', { owner, type, level: q.level });
        }
      });
    });
  }

  stepConquest(dt) {
    const s    = this.state;
    const cfg  = this.config;
    const db   = cfg.DYNAMIC_BALANCE;
    const fl   = this._computeFrontline();

    s.cells.forEach((cell, i) => {
      const np = cell.units.filter(u => u.owner === 'player').length;
      const ne = cell.units.filter(u => u.owner === 'enemy').length;
      // Walls count as defenders
      const nw_p = (cell.wall?.owner === 'player') ? 1 : 0;
      const nw_e = (cell.wall?.owner === 'enemy')  ? 1 : 0;

      if (!np && !ne && !nw_p && !nw_e) return;

      // Dynamic balance: how deep into home territory is the front?
      let cqMult = 1;
      if (db?.enabled && fl >= 0) {
        const depth = this._defenseDepth(i, fl);
        if (depth > 0) {
          cqMult = Math.max(1 - db.cqRateReduction * (depth / db.activationDepth), 0.3);
        }
      }

      const moraleDef = cell.owner === 'player' ? (cell.morale || 0) * 0.3 : 0;
      const prevOwner = cell.owner;
      const rate      = cfg.CQRATE * cqMult * dt;

      cell.cq = Math.max(0, Math.min(1,
        cell.cq + ((np + nw_p) - (ne + nw_e) - moraleDef) * rate));

      if (cell.cq >= 1)      { cell.owner = 'player'; }
      else if (cell.cq <= 0) { cell.owner = 'enemy';  cell.morale = 0; }
      else                   { cell.owner = 'neutral'; }

      if (cell.owner !== prevOwner && cell.owner !== 'neutral') {
        s.stats.cellCaptures++;
        s.stats.lastCaptureSide = cell.owner;
        // If a wall is captured, remove it (walls are owner-bound)
        if (cell.wall && cell.wall.owner !== cell.owner) {
          cell.wall = null;
          this._emit('wallDestroyed', { ci: i });
        }
      }
    });
  }

  stepCombat(dt) {
    const s   = this.state;
    const cfg = this.config;
    const db  = cfg.DYNAMIC_BALANCE;
    const fl  = this._computeFrontline();

    s.cells.forEach((cell, ci) => {
      // Units attack
      cell.units.forEach(u => {
        u.acd = Math.max(0, u.acd - dt);
        if (u.acd > 0) return;
        const tgts = this._findTargets(u, ci);
        if (!tgts.length) return;

        const baseDef = this._unitDef(u);
        const spdMult = this._hasBuff(u.owner, 'frenzy') ? 2 : 1;
        u.acd = baseDef.aspd / spdMult;

        // Dynamic balance: dmg bonus when defending deep in home territory
        let dmgBonus = 0;
        if (db?.enabled && fl >= 0) {
          const depth = this._defenseDepth(ci, fl);
          if (depth > 0)
            dmgBonus = db.maxDmgBonus * Math.min(depth / db.activationDepth, 1);
        }

        let dmgMult = 1;
        if (u.type === 'catapult' && u.bombard) { dmgMult = 2; u.bombard = false; }

        const t = tgts[0];
        if (baseDef.proj) this._launchProjectile(u, ci, t.unit, t.ci, baseDef, dmgMult, dmgBonus);
        else              this._applyHit(u, t.unit, t.ci, baseDef, dmgMult, dmgBonus);
      });

      // Walls take hits from enemies on the same cell or adjacent
      if (cell.wall) {
        const enemies = cell.units.filter(u => u.owner !== cell.wall.owner);
        enemies.forEach(eu => {
          const eDef = this._unitDef(eu);
          if (eDef.dmg > 0 && eu.acd <= 0) {
            const dmg = Math.max(1, Math.round(eDef.dmg - cell.wall.armor + (this.rng() - 0.5) * 8));
            cell.wall.hp -= dmg;
            this._emit('wallHit', { ci, dmg });
            if (cell.wall.hp <= 0) {
              cell.wall = null;
              this._emit('wallDestroyed', { ci });
            }
          }
        });
      }
    });
  }

  stepProjectiles(dt) {
    const s = this.state;
    s.projectiles = s.projectiles.filter(p => {
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const dist = Math.hypot(dx, dy);
      const step = p.spd * dt;
      if (step >= dist || dist < 0.01) {
        const cell = s.cells[p.tci];
        if (cell) {
          const hit = cell.units.find(u => u.id === p.tgt.id);
          if (hit) this._applyHit(p.atk, hit, p.tci, p.def, p.mult, p.dmgBonus || 0);
          if (p.splash) {
            for (let i = -p.splash; i <= p.splash; i++) {
              if (!i) continue;
              const si = p.tci + i;
              if (si < 0 || si >= this.config.NC) continue;
              s.cells[si].units
                .filter(u => u.owner !== p.atk.owner)
                .forEach(u => this._applyHit(p.atk, u, si,
                  { ...p.def, dmg: Math.floor(p.def.dmg * 0.4) }, 1, 0));
              // Splash can also hit walls
              const w = s.cells[si].wall;
              if (w && w.owner !== p.atk.owner) {
                const dmg = Math.max(1, Math.floor(p.def.dmg * 0.4 * p.mult));
                w.hp -= dmg;
                if (w.hp <= 0) { s.cells[si].wall = null; this._emit('wallDestroyed', { ci: si }); }
              }
            }
          }
        }
        return false;
      }
      p.x += dx / dist * step;
      p.y += dy / dist * step;
      return true;
    });
  }

  /**
   * Transit movement system:
   * - Units can pass through full cells without stopping (transit mode)
   * - If destination is captured by enemy mid-route, unit retreats to nearest safe cell
   * - MOVE_TICK controls real-time step cadence
   */
  stepMovement(dtr) {
    const { MOVE_TICK } = this.config;
    const s = this.state;
    s.moveAccum += dtr;
    if (s.moveAccum < MOVE_TICK) return;
    s.moveAccum -= MOVE_TICK;

    const done = [];
    s.moveOrders.forEach((destCi, uid) => {
      let unit = null, fromCi = -1;
      for (let i = 0; i < this.config.NC; i++) {
        const u = s.cells[i].units.find(u => u.id === uid);
        if (u) { unit = u; fromCi = i; break; }
      }
      if (!unit) { done.push(uid); return; }
      if (fromCi === destCi) { done.push(uid); return; }

      // --- Destination safety check: retreat if captured ---
      const destCell = s.cells[destCi];
      if (destCell && destCell.owner !== unit.owner && destCell.owner !== 'neutral') {
        // Destination taken by enemy — find nearest safe retreat cell
        const safeCI = this._nearestSafeCell(unit, fromCi);
        if (safeCI === fromCi || safeCI === -1) {
          done.push(uid); return; // already safe, cancel order
        }
        s.moveOrders.set(uid, safeCI); // update destination to retreat
        // Continue moving toward safety below
      }

      const currentDest = s.moveOrders.get(uid);
      if (currentDest === undefined) { done.push(uid); return; }

      const dir    = currentDest > fromCi ? 1 : -1;
      const nextCi = fromCi + dir;
      if (nextCi < 0 || nextCi >= this.config.NC) { done.push(uid); return; }

      const nextCell = s.cells[nextCi];

      // Check movement legality (can't enter cell actively controlled by enemy with full combat)
      if (!this._canStep(unit, fromCi, nextCi)) {
        done.push(uid); return;
      }

      const { SLOTS } = this.config;
      const wallSlots = nextCell.wall ? nextCell.wall.slots : 0;
      const usedSlots = nextCell.units.reduce((sum, u) => sum + this._unitDef(u).slots, 0) + wallSlots;
      const mySlots   = this._unitDef(unit).slots;
      const isFull    = usedSlots + mySlots > SLOTS;
      const isDestination = nextCi === currentDest;

      if (isFull && isDestination) {
        // Can't fit at destination — scan further in the same direction for space
        const alt = this._findAlternativeDestination(unit, fromCi, currentDest, dir);
        if (alt !== -1 && alt !== fromCi) {
          s.moveOrders.set(uid, alt);
          // Don't return — we might still be able to step into nextCi as transit
          // If nextCi is on the way to alt, fall through to move; otherwise wait
          const altDir = alt > fromCi ? 1 : -1;
          if (altDir !== dir) { done.push(uid); return; } // different direction, cancel
        } else {
          done.push(uid); return; // nowhere to go
        }
      }

      // If cell is full and it's NOT the destination, allow transit (unit passes through)
      // Unit physically enters but is marked inTransit — no combat engagement from that cell
      // However, if it can't physically fit (slots overflow), skip this tick and retry next
      if (isFull && !isDestination) {
        // Transit allowed: unit passes through, will keep moving next tick
        // But we still need at least one slot free conceptually — allow overflow for transit
        // (unit is just passing through, not settling)
      }

      // Move one step
      s.cells[fromCi].units = s.cells[fromCi].units.filter(u => u.id !== uid);
      unit.ci = nextCi;
      nextCell.units.push(unit);
      unit.inTransit = isFull && !isDestination; // flag: passing through

      this._emit('unitMoved', { unit, fromCi, toCi: nextCi });

      if (nextCi === currentDest) {
        unit.inTransit = false;
        done.push(uid);
      }
    });
    done.forEach(uid => s.moveOrders.delete(uid));
  }

  stepAbilityCooldowns(dt) {
    const s = this.state;
    Object.keys(s.abilityCooldowns).forEach(k => {
      if (s.abilityCooldowns[k] > 0)
        s.abilityCooldowns[k] = Math.max(0, s.abilityCooldowns[k] - dt);
    });
    s.cells.forEach(c => c.units.forEach(u => {
      if (u.abilCd > 0) u.abilCd = Math.max(0, u.abilCd - dt);
    }));
  }

  stepBuffs(dt) {
    const s = this.state;
    ['player', 'enemy'].forEach(o => {
      Object.keys(s.buffs[o]).forEach(k => {
        s.buffs[o][k] = Math.max(0, s.buffs[o][k] - dt);
      });
    });
  }

  stepAI(dt) {
    const { AITICK, AI_MOVES, AI_BUILDS, AI_MAX_UNITS, AI_CATAPULT_CHANCE,
            AI_WALL_CHANCE, AI_UPGRADE_CHANCE } = this.config;
    const s = this.state;
    s.aiTimer += dt;
    if (s.aiTimer < AITICK) return;
    s.aiTimer = 0;

    // Enemy AI runs at full strength
    this._runSideAI('enemy', AI_BUILDS, AI_MOVES, AI_MAX_UNITS, AI_CATAPULT_CHANCE,
                    AI_WALL_CHANCE, AI_UPGRADE_CHANCE);

    // Headless player AI runs with a small random handicap to break symmetry
    if (this.headless) {
      // Randomly skip ~20% of AI ticks for player to create variance
      if (this.rng() > 0.2) {
        this._runSideAI('player', AI_BUILDS, AI_MOVES, AI_MAX_UNITS, AI_CATAPULT_CHANCE,
                        AI_WALL_CHANCE, AI_UPGRADE_CHANCE);
      }
    }
  }

  stepEvents(dtr) {
    const { EVT_MIN, EVT_MAX } = this.config;
    const s = this.state;
    s.eventTimer += dtr;
    if (s.eventTimer < s.nextEventAt) return;
    s.eventTimer = 0;
    s.nextEventAt = this._rand(EVT_MIN, EVT_MAX);
    const evt = this.config.events[Math.floor(this.rng() * this.config.events.length)];
    this._applyEvent(evt);
    this._emit('event', evt);
  }

  checkWin() {
    const s  = this.state;
    if (!s.running) return;
    const pc = s.cells.filter(c => c.owner === 'player').length;
    const ec = s.cells.filter(c => c.owner === 'enemy').length;
    if (ec === 0) this._endGame('player');
    else if (pc === 0) this._endGame('enemy');
  }

  // ─────────────────────────────────────────────────
  // Player actions
  // ─────────────────────────────────────────────────

  /** Count active walls for an owner */
  _wallCount(owner) {
    return this.state.cells.filter(c => c.wall?.owner === owner).length;
  }

  queueUnit(buildingId, unitType) {
    const s = this.state, cfg = this.config;
    const st = s.buildings[buildingId];
    if (!st)              return { ok: false, reason: 'unknown building' };
    if (st.queue.length >= 3) return { ok: false, reason: 'queue full' };

    const uDef = unitType === 'wall' ? cfg.wall : cfg.units[unitType];
    if (!uDef)            return { ok: false, reason: 'unknown unit' };
    if (s.gold.p < uDef.cost) return { ok: false, reason: 'insufficient gold' };

    // Wall: check max active limit — count walls already on field + in queue
    if (unitType === 'wall') {
      const activeWalls = this._wallCount('player');
      const queuedWalls = st.queue.filter(q => q.unit === 'wall').length;
      const maxWalls = cfg.wall.maxActive ?? 1;
      if (activeWalls + queuedWalls >= maxWalls)
        return { ok: false, reason: `wall limit reached (max ${maxWalls})` };
    }

    s.gold.p -= uDef.cost;
    st.queue.push({ elapsed: 0, total: uDef.buildTime, unit: unitType,
      pendingPlacement: unitType === 'wall' }); // wall needs explicit placement
    return { ok: true, pendingPlacement: unitType === 'wall' };
  }

  /** Place the pending wall on a specific cell (player action, triggered after wall finishes building) */
  placeWall(ci) {
    const s = this.state, cfg = this.config;
    if (!s.pendingWall)   return { ok: false, reason: 'no wall ready to place' };
    const cell = s.cells[ci];
    if (!cell)            return { ok: false, reason: 'invalid cell' };
    if (cell.owner !== 'player') return { ok: false, reason: 'not your cell' };
    if (cell.wall)        return { ok: false, reason: 'wall already here' };
    const wallSl   = cfg.wall.slots || 2;
    const usedSlots = cell.units.reduce((sum, u) => sum + (cfg.units[u.type]?.slots || 1), 0);
    if (usedSlots + wallSl > cfg.SLOTS)
      return { ok: false, reason: 'not enough slots on this cell' };
    s.pendingWall = false;
    this._placeWall('player', ci);
    this._emit('wallPlaced', { owner: 'player', ci });
    return { ok: true };
  }

  orderMove(unitId, fromCi, toCi) {
    const s = this.state;
    if (fromCi === toCi) return { ok: false, reason: 'same cell' };
    const unit = s.cells[fromCi]?.units.find(u => u.id === unitId);
    if (!unit || unit.owner !== 'player') return { ok: false, reason: 'unit not found' };
    if (unit.type === 'wall')             return { ok: false, reason: 'walls are immovable' };
    // Validate general direction — don't need strict path check, transit handles the rest
    if (toCi < 0 || toCi >= this.config.NC) return { ok: false, reason: 'out of bounds' };
    s.moveOrders.set(unitId, toCi);
    return { ok: true };
  }

  useAbility(unitType) {
    const s = this.state, cfg = this.config;
    const def = cfg.units[unitType];
    if (!def) return { ok: false, reason: 'unknown type' };
    if (s.abilityCooldowns[unitType] > 0) return { ok: false, reason: 'on cooldown' };
    const units = s.cells.flatMap(c => c.units.filter(u => u.owner === 'player' && u.type === unitType));
    if (!units.length) return { ok: false, reason: 'no units' };

    if (unitType === 'warrior') {
      units.forEach(u => {
        const nextCi = u.ci + 1;
        if (nextCi >= cfg.NC) return;
        const dest = s.cells[nextCi];
        const enemies = dest.units.filter(eu => eu.owner === 'enemy');
        if (enemies.length) {
          enemies.forEach(eu => this._applyHit(u, eu, nextCi, this._unitDef(u), 1.5, 0));
        } else {
          const wallSl = dest.wall ? dest.wall.slots : 0;
          const used   = dest.units.reduce((sum, u2) => sum + this._unitDef(u2).slots, 0) + wallSl;
          if (used + 1 <= cfg.SLOTS) {
            s.cells[u.ci].units = s.cells[u.ci].units.filter(x => x.id !== u.id);
            const prev = u.ci; u.ci = nextCi; dest.units.push(u);
            this._emit('unitMoved', { unit: u, fromCi: prev, toCi: nextCi });
          }
        }
      });
    } else if (unitType === 'archer') {
      units.forEach(u => {
        const d = this._unitDef(u);
        for (let r = u.ci + 1; r <= u.ci + d.range && r < cfg.NC; r++) {
          s.cells[r].units.filter(eu => eu.owner === 'enemy')
            .forEach(eu => this._launchProjectile(u, u.ci, eu, r, d, 1, 0));
        }
      });
    } else if (unitType === 'catapult') {
      units.forEach(u => { u.bombard = true; u.acd = 0; });
    }

    s.abilityCooldowns[unitType] = def.abil.cd;
    const au = s.stats.abilityUses;
    au[unitType] = (au[unitType] || 0) + 1;
    this._emit('abilityUsed', { type: unitType, name: def.abil.name });
    return { ok: true };
  }

  /** Start researching an upgrade for a unit type */
  researchUpgrade(unitType) {
    const s = this.state, cfg = this.config;
    const def = cfg.units[unitType];
    if (!def?.upgrades) return { ok: false, reason: 'no upgrades' };

    const currentLevel = s.upgrades.player[unitType] || 0;
    const nextLevel    = currentLevel + 1;
    const upgrade      = def.upgrades[currentLevel]; // index = current level
    if (!upgrade) return { ok: false, reason: 'max level reached' };
    if (s.upgradeQueues.player[unitType]) return { ok: false, reason: 'already researching' };
    if (s.gold.p < upgrade.cost) return { ok: false, reason: 'insufficient gold' };

    s.gold.p -= upgrade.cost;
    s.upgradeQueues.player[unitType] = { elapsed: 0, total: upgrade.researchTime, level: nextLevel };
    return { ok: true, upgrade };
  }

  getStats() {
    const s = this.state;
    return {
      winner: s.winner,
      durationMs: s.elapsedMs,
      frontlineChanges: s.stats.frontlineChanges,
      cellCaptures: s.stats.cellCaptures,
      unitsProduced: s.stats.unitsProduced,
      kills: s.stats.kills,
      abilityUses: s.stats.abilityUses,
      goldHistory: s.stats.goldHistory,
      territoryHistory: s.stats.territoryHistory,
      frontlineHistory: s.stats.frontlineHistory,
      stalemateMs: s.stats.stalemateMs,
      upgradesReached: { player: { ...s.upgrades.player }, enemy: { ...s.upgrades.enemy } },
    };
  }

  // ─────────────────────────────────────────────────
  // Event emitter
  // ─────────────────────────────────────────────────

  on(event, cb) { (this._listeners[event] = this._listeners[event] || []).push(cb); }
  off(event, cb) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(f => f !== cb);
  }
  _emit(event, data) { (this._listeners[event] || []).forEach(f => f(data)); }

  // ─────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────

  _rand(min, max) { return min + this.rng() * (max - min); }

  /** Get effective unit def with upgrade bonuses applied */
  _unitDef(unit) {
    const cfg  = this.config;
    if (unit.type === 'wall') return cfg.wall;
    const base = cfg.units[unit.type];
    if (!base) return {};
    const level = this.state.upgrades[unit.owner]?.[unit.type] || 0;
    if (!level) return base;
    // Apply cumulative upgrade stats
    const result = { ...base };
    for (let i = 0; i < level; i++) {
      const upg = base.upgrades?.[i];
      if (!upg) break;
      Object.entries(upg.stat).forEach(([k, v]) => {
        result[k] = (result[k] || 0) + v;
      });
    }
    result.aspd = Math.max(300, result.aspd); // floor on attack speed
    return result;
  }

  _spawnUnit(owner, type, ci) {
    const def = type === 'wall' ? this.config.wall : this.config.units[type];
    const u   = { id: this.state.nextUnitId++, type, owner,
      hp: def.hp, mhp: def.hp, acd: 0, ci, abilCd: 0, inTransit: false };
    this.state.cells[ci].units.push(u);
    return u;
  }

  _placeWall(owner, ci) {
    const cfg  = this.config;
    const cell = this.state.cells[ci];
    cell.wall  = {
      owner, hp: cfg.wall.hp, mhp: cfg.wall.hp,
      armor: cfg.wall.armor, slots: cfg.wall.slots,
      id: this.state.nextUnitId++,
    };
  }

  _bestCell(owner) {
    const { NC, SLOTS } = this.config;
    const start = owner === 'player' ? 0 : NC - 1;
    const dir   = owner === 'player' ? 1 : -1;
    for (let i = 0; i < NC; i++) {
      const ci = start + dir * i;
      if (ci < 0 || ci >= NC) break;
      if (this.state.cells[ci].owner !== owner) break;
      const wallSl = this.state.cells[ci].wall ? this.config.wall.slots : 0;
      const used   = this.state.cells[ci].units.reduce((s, u) => s + this._unitDef(u).slots, 0) + wallSl;
      if (used < SLOTS) return ci;
    }
    return -1;
  }

  _bestWallCell(owner) {
    // Place wall at the frontmost owned cell that doesn't already have a wall
    const { NC } = this.config;
    const start  = owner === 'player' ? NC - 1 : 0;
    const dir    = owner === 'player' ? -1 : 1;
    for (let i = 0; i < NC; i++) {
      const ci = start + dir * i;
      if (ci < 0 || ci >= NC) break;
      const cell = this.state.cells[ci];
      if (cell.owner !== owner) continue;
      if (!cell.wall) return ci;
    }
    return -1;
  }

  _findTargets(atk, aci) {
    const def = this._unitDef(atk);
    const dir = atk.owner === 'player' ? 1 : -1;
    const res = [];
    for (let r = 0; r <= def.range; r++) {
      const ci = aci + r * dir;
      if (ci < 0 || ci >= this.config.NC) break;
      if (r < (def.rMin || 0)) continue;
      this.state.cells[ci].units
        .filter(u => u.owner !== atk.owner)
        .forEach(u => res.push({ unit: u, ci, dist: r }));
      // Walls are also valid targets
      const w = this.state.cells[ci].wall;
      if (w && w.owner !== atk.owner)
        res.push({ unit: w, ci, dist: r, isWall: true });
      if (res.length) break;
    }
    return res;
  }

  _applyHit(atk, tgt, tci, def, mult = 1, dmgBonus = 0) {
    const tgtDef = this.state.cells[tci]?.wall?.id === tgt.id
      ? this.config.wall
      : this._unitDef(tgt);
    const armor  = tgtDef?.armor || 0;

    // Dynamic balance: armor bonus when defending deep in home territory
    const db   = this.config.DYNAMIC_BALANCE;
    const fl   = this._computeFrontline();
    let armorBonus = 0;
    if (db?.enabled && fl >= 0) {
      const depth = this._defenseDepth(tci, fl);
      if (depth > 0)
        armorBonus = db.maxArmorBonus * Math.min(depth / db.activationDepth, 1);
    }

    const dmg = Math.max(1, Math.round(
      (def.dmg + dmgBonus - armor - armorBonus + (this.rng() - 0.5) * 8) * mult
    ));
    tgt.hp -= dmg;
    this._emit('hit', { atk, tgt, tci, dmg });

    if (tgt.hp <= 0) {
      // Check if it's a wall
      const cell = this.state.cells[tci];
      if (cell?.wall?.id === tgt.id) {
        cell.wall = null;
        this._emit('wallDestroyed', { ci: tci });
        return;
      }
      cell.units = cell.units.filter(u => u.id !== tgt.id);
      this.state.moveOrders.delete(tgt.id);
      const kills = this.state.stats.kills[atk.owner];
      kills[tgt.type] = (kills[tgt.type] || 0) + 1;
      this._emit('unitDied', { unit: tgt, tci, killer: atk });
    }
  }

  _launchProjectile(atk, fci, tgt, tci, def, mult = 1, dmgBonus = 0) {
    this.state.projectiles.push({
      x: fci, y: 0, tx: tci, ty: 0,
      tgt, tci, atk, def, mult, dmgBonus,
      spd: def.proj.spd, col: def.proj.col, sz: def.proj.sz,
      splash: def.splash || 0,
    });
  }

  _canStep(unit, fromCi, nextCi) {
    const dest = this.state.cells[nextCi];
    if (unit.owner === 'player') {
      if (dest.owner === 'player')  return true;
      if (dest.owner === 'neutral') return true;
      // Enemy cell: blocked if enemy units present OR enemy wall present
      const hasEnemyWall = dest.wall && dest.wall.owner === 'enemy';
      return !dest.units.some(u => u.owner === 'enemy') && !hasEnemyWall;
    } else {
      if (dest.owner === 'enemy')   return true;
      if (dest.owner === 'neutral') return true;
      // Player cell: blocked if player units present OR player wall present
      const hasPlayerWall = dest.wall && dest.wall.owner === 'player';
      return !dest.units.some(u => u.owner === 'player') && !hasPlayerWall;
    }
  }

  _nearestSafeCell(unit, fromCi) {
    // Find nearest cell in home direction that is safe
    const dir = unit.owner === 'player' ? -1 : 1; // retreat direction
    for (let i = 1; i < this.config.NC; i++) {
      const ci = fromCi + dir * i;
      if (ci < 0 || ci >= this.config.NC) break;
      const cell = this.state.cells[ci];
      if (cell.owner === unit.owner) return ci;
    }
    return fromCi; // stay put
  }

  _findAlternativeDestination(unit, fromCi, intendedDest, dir) {
    const { NC, SLOTS } = this.config;
    // Look for the nearest cell in the intended direction that has space
    for (let ci = intendedDest; ci >= 0 && ci < NC; ci -= dir) {
      if (ci === fromCi) break;
      const cell = this.state.cells[ci];
      if (cell.owner !== unit.owner) continue;
      const wallSl = cell.wall ? this.config.wall.slots : 0;
      const used   = cell.units.reduce((s, u) => s + this._unitDef(u).slots, 0) + wallSl;
      if (used + this._unitDef(unit).slots <= SLOTS) return ci;
    }
    return -1;
  }

  _hasBuff(owner, name) { return (this.state.buffs[owner][name] || 0) > 0; }

  _computeFrontline() {
    const s = this.state;
    for (let i = 0; i < this.config.NC - 1; i++) {
      if ((s.cells[i].owner === 'player' || s.cells[i].owner === 'neutral') &&
          (s.cells[i + 1].owner === 'enemy' || s.cells[i + 1].owner === 'neutral'))
        return i;
    }
    return -1;
  }

  /** How many cells deep into home territory is a given cell, given the frontline */
  _defenseDepth(ci, frontline) {
    if (frontline < 0) return 0;
    const s    = this.state;
    const cell = s.cells[ci];
    if (!cell) return 0;
    // Player's home: low indices. Depth = how far from frontline toward index 0
    if (cell.owner === 'player' && ci < frontline) return frontline - ci;
    // Enemy's home: high indices. Depth = how far from frontline toward NC-1
    if (cell.owner === 'enemy' && ci > frontline + 1) return ci - (frontline + 1);
    return 0;
  }

  _runSideAI(owner, AI_BUILDS, AI_MOVES, AI_MAX_UNITS, AI_CATAPULT_CHANCE,
             AI_WALL_CHANCE = 0, AI_UPGRADE_CHANCE = 0) {
    const s         = this.state;
    const uDefs     = this.config.units;
    const isPlayer  = owner === 'player';
    const bldgStore = isPlayer ? s.buildings : s.eBuildings;
    const goldKey   = isPlayer ? 'p' : 'e';
    const dir       = isPlayer ? 1 : -1;

    const ownedCells = s.cells.map((_, i) => i).filter(i => s.cells[i].owner === owner);
    if (!ownedCells.length) return;
    const total = s.cells.reduce((sum, c) =>
      sum + c.units.filter(u => u.owner === owner).length, 0);

    const tryBuild = (bldgId, unitType, maxTotal, maxQ, condFn) => {
      if (s.gold[goldKey] < (unitType === 'wall' ? this.config.wall.cost : uDefs[unitType].cost)) return false;
      if (bldgStore[bldgId].queue.length >= maxQ) return false;
      if (condFn && !condFn()) return false;
      const cost = unitType === 'wall' ? this.config.wall.cost : uDefs[unitType].cost;
      const time = unitType === 'wall' ? this.config.wall.buildTime : uDefs[unitType].buildTime;
      s.gold[goldKey] = Math.max(0, s.gold[goldKey] - cost);
      bldgStore[bldgId].queue.push({ elapsed: 0, total: time, unit: unitType });
      return true;
    };

    let builds = 0;
    if (builds < AI_BUILDS && total < 8)
      { if (tryBuild('barracks', 'warrior', 8, 3)) builds++; }
    if (builds < AI_BUILDS && total < AI_MAX_UNITS)
      { if (tryBuild('range', 'archer', AI_MAX_UNITS, 3)) builds++; }
    if (builds < AI_BUILDS && total >= 2 && this.rng() < AI_CATAPULT_CHANCE)
      { if (tryBuild('foundry', 'catapult', AI_MAX_UNITS, 2)) builds++; }

    // AI: place walls on front cell if under pressure
    if (this.rng() < AI_WALL_CHANCE && this.config.buildings.some(b => b.id === 'mason')) {
      const maxWalls = this.config.wall.maxActive ?? 1;
      const activeWalls = this._wallCount(owner);
      const queuedWalls = bldgStore['mason']?.queue.filter(q => q.unit === 'wall').length || 0;
      if (activeWalls + queuedWalls < maxWalls) {
        const wallCell = this._bestWallCell(owner);
        if (wallCell !== -1 && !s.cells[wallCell].wall) {
          tryBuild('mason', 'wall', 99, 2);
        }
      }
    }

    // AI: research upgrades
    if (this.rng() < AI_UPGRADE_CHANCE) {
      const types = Object.keys(uDefs);
      const type  = types[Math.floor(this.rng() * types.length)];
      const level = s.upgrades[owner][type] || 0;
      const upg   = uDefs[type]?.upgrades?.[level];
      if (upg && !s.upgradeQueues[owner][type] && s.gold[goldKey] >= upg.cost) {
        s.gold[goldKey] = Math.max(0, s.gold[goldKey] - upg.cost);
        s.upgradeQueues[owner][type] = {
          elapsed: 0, total: upg.researchTime, level: level + 1,
        };
      }
    }

    // Move
    let moves = 0;
    const sorted = isPlayer
      ? [...ownedCells].sort((a, b) => b - a)
      : [...ownedCells].sort((a, b) => a - b);

    for (const ci of sorted) {
      if (moves >= AI_MOVES) break;
      const myUnits = s.cells[ci].units.filter(u => u.owner === owner);
      if (!myUnits.length) continue;
      if (s.cells[ci].units.some(u => u.owner !== owner)) continue;

      const tci = ci + dir;
      if (tci < 0 || tci >= this.config.NC) continue;
      if (!this._canStep({ owner }, ci, tci)) continue;

      const dest = s.cells[tci];
      const wallSl = dest.wall ? this.config.wall.slots : 0;
      const usedSl = dest.units.reduce((sum, u) =>
        sum + this._unitDef(u).slots, 0) + wallSl;

      const order = ['warrior', 'archer', 'catapult'];
      const cands = [...myUnits].sort((a, b) =>
        order.indexOf(a.type) - order.indexOf(b.type));

      for (const u of cands) {
        if (moves >= AI_MOVES) break;
        if (u.type === 'wall') continue; // walls don't move
        if (usedSl + this._unitDef(u).slots > this.config.SLOTS) continue;
        s.cells[ci].units = s.cells[ci].units.filter(x => x.id !== u.id);
        u.ci = tci;
        dest.units.push(u);
        moves++;
      }
    }
  }

  _applyEvent(evt) {
    const s = this.state;
    switch (evt.type) {
      case 'reinforce': {
        const ci = this._bestCell(evt.params.owner);
        if (ci !== -1) this._spawnUnit(evt.params.owner, evt.params.unit, ci);
        break;
      }
      case 'goldBonus': {
        const key = evt.params.owner === 'player' ? 'p' : 'e';
        s.gold[key] = Math.min(this.config.MAXG, s.gold[key] + evt.params.amount);
        break;
      }
      case 'buff': {
        const b = s.buffs[evt.params.owner];
        b[evt.params.buffName] = (b[evt.params.buffName] || 0) + evt.params.duration;
        break;
      }
      case 'plague': {
        s.cells.forEach(c => c.units
          .filter(u => u.owner === evt.params.owner)
          .forEach(u => { u.hp = Math.max(1, u.hp - evt.params.damage); }));
        break;
      }
      case 'fortify': {
        const owner = evt.params.owner;
        let frontCi = -1;
        if (owner === 'player') {
          for (let i = this.config.NC - 1; i >= 0; i--)
            if (s.cells[i].owner === 'player') { frontCi = i; break; }
        } else {
          for (let i = 0; i < this.config.NC; i++)
            if (s.cells[i].owner === 'enemy') { frontCi = i; break; }
        }
        if (frontCi !== -1)
          s.cells[frontCi].morale = Math.min(3, (s.cells[frontCi].morale || 0) + 1);
        break;
      }
    }
  }

  _playerFront() {
    for (let i = this.config.NC - 1; i >= 0; i--)
      if (this.state.cells[i].owner === 'player') return i;
    return -1;
  }

  _endGame(winner) {
    const s = this.state;
    s.running = false;
    s.winner  = winner;
    this._emit('gameOver', { winner, stats: this.getStats() });
  }

  _sampleStats(dt) {
    const s = this.state;
    s.stats._sampleAccum = (s.stats._sampleAccum || 0) + dt;
    if (s.stats._sampleAccum < 2000) return;
    s.stats._sampleAccum -= 2000;

    const pc = s.cells.filter(c => c.owner === 'player').length;
    s.stats.territoryHistory.push({ t: s.elapsedMs, playerCells: pc });
    s.stats.goldHistory.push({ t: s.elapsedMs, p: Math.floor(s.gold.p), e: Math.floor(s.gold.e) });

    const fl = this._computeFrontline();
    if (fl !== s.stats.lastFrontline) {
      if (s.stats.lastFrontline !== -1) s.stats.frontlineChanges++;
      s.stats.lastFrontline = fl;
    }
    s.stats.frontlineHistory.push(fl);

    if (pc > 0 && pc < this.config.NC) s.stats.stalemateMs += 2000;
  }
}
