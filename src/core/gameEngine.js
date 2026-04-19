/**
 * gameEngine.js — Pure headless simulation engine for WarLane.
 *
 * ✓ Zero DOM access
 * ✓ Zero requestAnimationFrame / setTimeout
 * ✓ Zero canvas
 * ✓ Deterministic with seeded RNG
 *
 * Usage:
 *   const engine = new GameEngine(config, seed);
 *   engine.init();
 *   engine.step(dt);          // advance simulation by dt ms
 *   const state = engine.state; // read-only snapshot
 */

import { GameState } from './gameState.js';
import { createRng } from './rng.js';

export class GameEngine {
  /**
   * @param {object} config - Parsed gameplay JSON
   * @param {number} [seed]  - RNG seed
   */
  constructor(config, seed = Math.random() * 1e9 | 0, { headless = false } = {}) {
    this.config = config;
    this.seed = seed;
    this.headless = headless; // true = player side also managed by mirror AI
    this.rng = createRng(seed);
    this.state = new GameState(config, seed);
    // Listeners for UI events (optional)
    this._listeners = {};
  }

  // ─────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────

  /** Full reset + starting units placement */
  init() {
    this.rng = createRng(this.seed);
    this.state = new GameState(this.config, this.seed);
    const cfg = this.config;
    const s = this.state;

    s.running = true;
    s.nextEventAt = this._rand(cfg.EVT_MIN, cfg.EVT_MAX);

    // Initialise cells
    for (let i = 0; i < cfg.NC; i++) {
      const owner = i < 2 ? 'player' : i >= cfg.NC - 2 ? 'enemy' : 'neutral';
      s.cells.push({ owner, cq: owner === 'player' ? 1 : owner === 'enemy' ? 0 : 0.5, units: [], morale: 0 });
    }

    // Starting units
    this._spawnUnit('player', 'warrior', 0);
    this._spawnUnit('player', 'archer', 1);
    this._spawnUnit('enemy', 'warrior', cfg.NC - 1);
    this._spawnUnit('enemy', 'archer', cfg.NC - 2);

    // Buildings
    cfg.buildings.forEach(b => {
      s.buildings[b.id] = { queue: [] };
      s.eBuildings[b.id] = { queue: [] };
    });

    // Ability cooldowns init
    Object.keys(cfg.units).forEach(type => {
      s.abilityCooldowns[type] = 0;
    });

    this._emit('init', s);
  }

  /**
   * Advance the simulation by dt milliseconds.
   * dt is already speed-scaled by the caller.
   * dtr is real-time delta (for MOVE_TICK which ignores speed scaling).
   * @param {number} dt  - scaled sim delta ms
   * @param {number} dtr - real-time delta ms (for movement)
   */
  step(dt, dtr) {
    const s = this.state;
    if (!s.running || s.paused) return;
    s.elapsedMs += dt;

    this.stepGold(dt);
    this.stepBuildings(dt);
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
        if (!st || !st.queue.length) return;
        const it = st.queue[0];
        it.elapsed += dt;
        if (it.elapsed >= it.total) {
          st.queue.shift();
          const ci = this._bestCell(owner);
          if (ci !== -1) {
            const u = this._spawnUnit(owner, it.unit, ci);
            this._emit('unitReady', { owner, unit: u, ci });
          }
          // Track production stats
          const ps = s.stats.unitsProduced[owner];
          ps[it.unit] = (ps[it.unit] || 0) + 1;
        }
      });
    });
  }

  stepConquest(dt) {
    const { CQRATE } = this.config;
    const s = this.state;
    s.cells.forEach((cell, i) => {
      const np = cell.units.filter(u => u.owner === 'player').length;
      const ne = cell.units.filter(u => u.owner === 'enemy').length;
      if (!np && !ne) return;
      const defBonus = cell.owner === 'player' ? (cell.morale || 0) * 0.3 : 0;
      const prevOwner = cell.owner;
      cell.cq = Math.max(0, Math.min(1, cell.cq + (np - ne - defBonus) * CQRATE * dt));
      if (cell.cq >= 1) cell.owner = 'player';
      else if (cell.cq <= 0) { cell.owner = 'enemy'; cell.morale = 0; }
      else cell.owner = 'neutral';
      if (cell.owner !== prevOwner && cell.owner !== 'neutral') {
        s.stats.cellCaptures++;
        s.stats.lastCaptureSide = cell.owner;
      }
    });
  }

  stepCombat(dt) {
    const s = this.state;
    s.cells.forEach((cell, ci) => {
      cell.units.forEach(u => {
        u.acd = Math.max(0, u.acd - dt);
        if (u.acd > 0) return;
        const targets = this._findTargets(u, ci);
        if (!targets.length) return;
        const target = targets[0];
        const def = this.config.units[u.type];
        const speedMult = this._hasBuff(u.owner, 'frenzy') ? 2 : 1;
        u.acd = def.aspd / speedMult;
        let dmgMult = 1;
        if (u.type === 'catapult' && u.bombard) { dmgMult = 2; u.bombard = false; }
        if (def.proj) this._launchProjectile(u, ci, target.unit, target.ci, def, dmgMult);
        else this._applyHit(u, target.unit, target.ci, def, dmgMult);
      });
    });
  }

  stepProjectiles(dt) {
    const s = this.state;
    s.projectiles = s.projectiles.filter(p => {
      // Use logical positions (0..NC) for headless; renderer maps to pixels
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const dist = Math.hypot(dx, dy);
      const step = p.spd * dt;
      if (step >= dist || dist < 0.01) {
        const targetCell = s.cells[p.tci];
        if (targetCell) {
          const hit = targetCell.units.find(u => u.id === p.tgt.id);
          if (hit) this._applyHit(p.atk, hit, p.tci, p.def, p.mult);
          if (p.splash) {
            for (let i = -p.splash; i <= p.splash; i++) {
              if (!i) continue;
              const si = p.tci + i;
              if (si < 0 || si >= this.config.NC) continue;
              s.cells[si].units
                .filter(u => u.owner !== p.atk.owner)
                .forEach(u => this._applyHit(p.atk, u, si, { ...p.def, dmg: Math.floor(p.def.dmg * 0.4) }));
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

      const dir = destCi > fromCi ? 1 : -1;
      const nextCi = fromCi + dir;
      if (nextCi < 0 || nextCi >= this.config.NC) { done.push(uid); return; }
      if (!this._canStep(unit, fromCi, nextCi)) { done.push(uid); return; }

      const { SLOTS } = this.config;
      const nextCell = s.cells[nextCi];
      const used = nextCell.units.reduce((sum, u) => sum + this.config.units[u.type].slots, 0);
      if (used + this.config.units[unit.type].slots > SLOTS) { done.push(uid); return; }

      // Move one step
      s.cells[fromCi].units = s.cells[fromCi].units.filter(u => u.id !== uid);
      unit.ci = nextCi;
      nextCell.units.push(unit);
      this._emit('unitMoved', { unit, fromCi, toCi: nextCi });

      if (nextCi === destCi) done.push(uid);
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
    const { AITICK, AI_MOVES, AI_BUILDS, AI_MAX_UNITS, AI_CATAPULT_CHANCE } = this.config;
    const s = this.state;
    s.aiTimer += dt;
    if (s.aiTimer < AITICK) return;
    s.aiTimer = 0;

    // Run AI for both sides (enemy always, player if headless mode)
    this._runSideAI('enemy', AI_BUILDS, AI_MOVES, AI_MAX_UNITS, AI_CATAPULT_CHANCE);
    if (this.headless) {
      this._runSideAI('player', AI_BUILDS, AI_MOVES, AI_MAX_UNITS, AI_CATAPULT_CHANCE);
    }
  }

  _runSideAI(owner, AI_BUILDS, AI_MOVES, AI_MAX_UNITS, AI_CATAPULT_CHANCE) {
    const s = this.state;
    const uDefs = this.config.units;
    const isPlayer = owner === 'player';
    const bldgStore = isPlayer ? s.buildings : s.eBuildings;
    const goldKey = isPlayer ? 'p' : 'e';
    const dir = isPlayer ? 1 : -1; // player moves right, enemy moves left

    const ownedCells = s.cells.map((_, i) => i).filter(i => s.cells[i].owner === owner);
    if (!ownedCells.length) return;
    const total = s.cells.reduce((sum, c) => sum + c.units.filter(u => u.owner === owner).length, 0);
    const g = Math.floor(s.gold[goldKey]);

    // Build
    let builds = 0;
    const tryBuild = (bldgId, unitType, maxTotal, maxQ, condFn) => {
      if (builds >= AI_BUILDS) return;
      if (total >= maxTotal) return;
      // Re-read gold each time to prevent overdraft from multiple builds in one tick
      if (s.gold[goldKey] < uDefs[unitType].cost) return;
      if (bldgStore[bldgId].queue.length >= maxQ) return;
      if (condFn && !condFn()) return;
      s.gold[goldKey] = Math.max(0, s.gold[goldKey] - uDefs[unitType].cost);
      bldgStore[bldgId].queue.push({ elapsed: 0, total: uDefs[unitType].buildTime, unit: unitType });
      builds++;
    };

    tryBuild('barracks', 'warrior', 8, 3);
    tryBuild('range', 'archer', AI_MAX_UNITS, 3);
    tryBuild('foundry', 'catapult', AI_MAX_UNITS, 2, () => total >= 2 && this.rng() < AI_CATAPULT_CHANCE);

    // Move — advance toward opponent (identical logic for both sides)
    let moves = 0;
    // Both sides: sort cells closest to the frontline first
    const sorted = isPlayer
      ? [...ownedCells].sort((a, b) => b - a)  // player: rightmost (closest to enemy) first
      : [...ownedCells].sort((a, b) => a - b);  // enemy: leftmost (closest to player) first

    for (const ci of sorted) {
      if (moves >= AI_MOVES) break;
      const myUnits = s.cells[ci].units.filter(u => u.owner === owner);
      if (!myUnits.length) continue;
      if (s.cells[ci].units.some(u => u.owner !== owner)) continue; // fighting

      const tci = ci + dir;
      if (tci < 0 || tci >= this.config.NC) continue;
      if (!this._canStep({ owner }, ci, tci)) continue;

      const order = ['warrior', 'archer', 'catapult'];
      const cands = [...myUnits].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
      for (const u of cands) {
        if (moves >= AI_MOVES) break;
        const used = s.cells[tci].units.reduce((sum, u2) => sum + uDefs[u2.type].slots, 0);
        if (used + uDefs[u.type].slots > this.config.SLOTS) continue;
        s.cells[ci].units = s.cells[ci].units.filter(x => x.id !== u.id);
        u.ci = tci;
        s.cells[tci].units.push(u);
        moves++;
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

    const events = this.config.events;
    const evt = events[Math.floor(this.rng() * events.length)];
    this._applyEvent(evt);
    this._emit('event', evt);
  }

  checkWin() {
    const s = this.state;
    if (!s.running) return;
    const pc = s.cells.filter(c => c.owner === 'player').length;
    const ec = s.cells.filter(c => c.owner === 'enemy').length;
    if (ec === 0) this._endGame('player');
    else if (pc === 0) this._endGame('enemy');
  }

  // ─────────────────────────────────────────────────
  // Player actions (called by UI or AI-optimizer)
  // ─────────────────────────────────────────────────

  /** Queue a unit for production in a player building */
  queueUnit(buildingId, unitType) {
    const s = this.state;
    const cfg = this.config;
    const st = s.buildings[buildingId];
    if (!st) return { ok: false, reason: 'unknown building' };
    if (st.queue.length >= 3) return { ok: false, reason: 'queue full' };
    const uDef = cfg.units[unitType];
    if (!uDef) return { ok: false, reason: 'unknown unit' };
    if (s.gold.p < uDef.cost) return { ok: false, reason: 'insufficient gold' };
    s.gold.p -= uDef.cost;
    st.queue.push({ elapsed: 0, total: uDef.buildTime, unit: unitType });
    return { ok: true };
  }

  /** Assign a move order to a player unit */
  orderMove(unitId, fromCi, toCi) {
    const s = this.state;
    if (fromCi === toCi) return { ok: false, reason: 'same cell' };
    const unit = s.cells[fromCi]?.units.find(u => u.id === unitId);
    if (!unit || unit.owner !== 'player') return { ok: false, reason: 'unit not found' };
    const valids = this._getValidMoves(fromCi, unit);
    if (!valids.includes(toCi)) return { ok: false, reason: 'invalid destination' };
    s.moveOrders.set(unitId, toCi);
    return { ok: true };
  }

  /** Activate a special ability for a unit type */
  useAbility(unitType) {
    const s = this.state;
    const cfg = this.config;
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
          enemies.forEach(eu => this._applyHit(u, eu, nextCi, def, 1.5));
        } else {
          const used = dest.units.reduce((sum, u2) => sum + cfg.units[u2.type].slots, 0);
          if (used + 1 <= cfg.SLOTS) {
            s.cells[u.ci].units = s.cells[u.ci].units.filter(x => x.id !== u.id);
            const prevCi = u.ci;
            u.ci = nextCi;
            dest.units.push(u);
            this._emit('unitMoved', { unit: u, fromCi: prevCi, toCi: nextCi });
          }
        }
      });
      this._emit('abilityUsed', { type: unitType, name: def.abil.name });
    } else if (unitType === 'archer') {
      units.forEach(u => {
        for (let r = u.ci + 1; r <= u.ci + def.range && r < cfg.NC; r++) {
          s.cells[r].units.filter(eu => eu.owner === 'enemy').forEach(eu => {
            this._launchProjectile(u, u.ci, eu, r, def, 1);
          });
        }
      });
      this._emit('abilityUsed', { type: unitType, name: def.abil.name });
    } else if (unitType === 'catapult') {
      units.forEach(u => { u.bombard = true; u.acd = 0; });
      this._emit('abilityUsed', { type: unitType, name: def.abil.name });
    }

    s.abilityCooldowns[unitType] = def.abil.cd;
    const au = s.stats.abilityUses;
    au[unitType] = (au[unitType] || 0) + 1;
    return { ok: true };
  }

  // ─────────────────────────────────────────────────
  // Stats & reporting
  // ─────────────────────────────────────────────────

  /** Return a final stats snapshot (call after game ends) */
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
    };
  }

  // ─────────────────────────────────────────────────
  // Event emitter (lightweight)
  // ─────────────────────────────────────────────────

  on(event, cb) { (this._listeners[event] = this._listeners[event] || []).push(cb); }
  off(event, cb) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(f => f !== cb);
  }
  _emit(event, data) {
    (this._listeners[event] || []).forEach(f => f(data));
  }

  // ─────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────

  _hasBuff(owner, name) { return (this.state.buffs[owner][name] || 0) > 0; }

  _rand(min, max) { return min + this.rng() * (max - min); }

  _spawnUnit(owner, type, ci) {
    const def = this.config.units[type];
    const u = { id: this.state.nextUnitId++, type, owner, hp: def.hp, mhp: def.hp, acd: 0, ci, abilCd: 0 };
    this.state.cells[ci].units.push(u);
    return u;
  }

  _bestCell(owner) {
    const { NC, SLOTS } = this.config;
    const start = owner === 'player' ? 0 : NC - 1;
    const dir = owner === 'player' ? 1 : -1;
    for (let i = 0; i < NC; i++) {
      const ci = start + dir * i;
      if (ci < 0 || ci >= NC) break;
      if (this.state.cells[ci].owner !== owner) break;
      const used = this.state.cells[ci].units.reduce((s, u) => s + this.config.units[u.type].slots, 0);
      if (used < SLOTS) return ci;
    }
    return -1;
  }

  _findTargets(atk, aci) {
    const def = this.config.units[atk.type];
    const dir = atk.owner === 'player' ? 1 : -1;
    const res = [];
    for (let r = 0; r <= def.range; r++) {
      const ci = aci + r * dir;
      if (ci < 0 || ci >= this.config.NC) break;
      if (r < def.rMin) continue;
      this.state.cells[ci].units
        .filter(u => u.owner !== atk.owner)
        .forEach(u => res.push({ unit: u, ci, dist: r }));
      if (res.length) break;
    }
    return res;
  }

  _applyHit(atk, tgt, tci, def, mult = 1) {
    const tgtDef = this.config.units[tgt.type];
    const dmg = Math.max(1, Math.round((def.dmg - tgtDef.armor + (this.rng() - 0.5) * 8) * mult));
    tgt.hp -= dmg;
    this._emit('hit', { atk, tgt, tci, dmg });
    if (tgt.hp <= 0) {
      this.state.cells[tci].units = this.state.cells[tci].units.filter(u => u.id !== tgt.id);
      this.state.moveOrders.delete(tgt.id);
      const kills = this.state.stats.kills[atk.owner];
      kills[tgt.type] = (kills[tgt.type] || 0) + 1;
      this._emit('unitDied', { unit: tgt, tci, killer: atk });
    }
  }

  _launchProjectile(atk, fci, tgt, tci, def, mult = 1) {
    // Use logical cell indices as proxy coordinates for headless
    this.state.projectiles.push({
      x: fci, y: 0, tx: tci, ty: 0,
      tgt, tci, atk, def, mult,
      spd: def.proj.spd,
      col: def.proj.col,
      sz: def.proj.sz,
      splash: def.splash || 0,
    });
  }

  _canStep(unit, fromCi, nextCi) {
    const dest = this.state.cells[nextCi];
    if (unit.owner === 'player') {
      if (dest.owner === 'player') return true;
      return !dest.units.some(u => u.owner === 'enemy');
    } else {
      if (dest.owner === 'enemy') return true;
      return !dest.units.some(u => u.owner === 'player');
    }
  }

  _getValidMoves(fromCi, unit) {
    const res = [];
    for (let i = 0; i < this.config.NC; i++) {
      if (i === fromCi || unit.owner !== 'player') continue;
      const dir = i > fromCi ? 1 : -1;
      let reachable = true;
      for (let ci = fromCi + dir; ci !== i; ci += dir) {
        if (this.state.cells[ci].owner !== 'player') { reachable = false; break; }
      }
      if (!reachable) continue;
      const dest = this.state.cells[i];
      if (dest.owner !== 'player' && dest.units.some(u => u.owner === 'enemy')) continue;
      res.push(i);
    }
    return res;
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
          .forEach(u => { u.hp = Math.max(1, u.hp - evt.params.damage); })
        );
        break;
      }
      case 'fortify': {
        const owner = evt.params.owner;
        // Find the frontmost cell for this owner
        let frontCi = -1;
        if (owner === 'player') {
          for (let i = this.config.NC - 1; i >= 0; i--) {
            if (this.state.cells[i].owner === 'player') { frontCi = i; break; }
          }
        } else {
          for (let i = 0; i < this.config.NC; i++) {
            if (this.state.cells[i].owner === 'enemy') { frontCi = i; break; }
          }
        }
        if (frontCi !== -1) this.state.cells[frontCi].morale = Math.min(3, (this.state.cells[frontCi].morale || 0) + 1);
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
    s.winner = winner;
    this._emit('gameOver', { winner, stats: this.getStats() });
  }

  _sampleStats(dt) {
    const s = this.state;
    // Accumulator-based sampling every 2000ms of sim time (robust to any dt)
    s.stats._sampleAccum = (s.stats._sampleAccum || 0) + dt;
    if (s.stats._sampleAccum < 2000) return;
    s.stats._sampleAccum -= 2000;

    const pc = s.cells.filter(c => c.owner === 'player').length;
    s.stats.territoryHistory.push({ t: s.elapsedMs, playerCells: pc });
    s.stats.goldHistory.push({ t: s.elapsedMs, p: Math.floor(s.gold.p), e: Math.floor(s.gold.e) });

    // Frontline tracking
    const fl = this._computeFrontline();
    if (fl !== s.stats.lastFrontline) {
      if (s.stats.lastFrontline !== -1) s.stats.frontlineChanges++;
      s.stats.lastFrontline = fl;
    }
    s.stats.frontlineHistory.push(fl);

    // Stalemate: territory neither fully player nor fully enemy
    if (pc > 0 && pc < this.config.NC) {
      s.stats.stalemateMs += 2000;
    }
  }

  _computeFrontline() {
    const s = this.state;
    for (let i = 0; i < this.config.NC - 1; i++) {
      if ((s.cells[i].owner === 'player' || s.cells[i].owner === 'neutral') &&
          (s.cells[i + 1].owner === 'enemy' || s.cells[i + 1].owner === 'neutral')) {
        return i;
      }
    }
    return -1;
  }
}
