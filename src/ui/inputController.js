/**
 * inputController.js — Handles all user interactions for WarLane.
 *
 * Reads user gestures (click, drag, touch) and calls:
 *   engine.queueUnit()
 *   engine.orderMove()
 *   engine.useAbility()
 *
 * Contains ZERO game logic.
 */

export class InputController {
  /**
   * @param {GameEngine} engine
   * @param {Renderer}   renderer
   */
  constructor(engine, renderer) {
    this.engine = engine;
    this.renderer = renderer;

    // Drag state
    this.drag = null;   // { uid, from }

    // Touch selection state
    this.tsel = null;   // { mode: 'unit'|'group', uid?, uids?, from }

    // Wire renderer callbacks
    renderer._onCellClick = (i) => this._onCellClick(i);
    renderer._onUnitClick = (uid, ci) => this._onUnitClick(uid, ci);
    renderer._onUnitDragStart = (e, uid, ci) => this._onDragStart(e, uid, ci);
    renderer._onCellDrop = (i) => this._onDrop(i);
    renderer._onBuildingClick = (bid, unit) => this._onBuildingClick(bid, unit);
    renderer._onAbilityClick = (type) => this._onAbilityClick(type);
    renderer._onUpgradeClick  = (type) => this._onUpgradeClick(type);

    document.addEventListener('dragend', () => this._onDragEnd());
    document.addEventListener('mousemove', e => {
      const tt = document.getElementById('tt');
      if (tt?.style.display === 'block') {
        tt.style.left = Math.min(e.clientX + 12, innerWidth - 190) + 'px';
        tt.style.top = Math.min(e.clientY + 12, innerHeight - 160) + 'px';
      }
    });
    document.addEventListener('click', () => {
      document.getElementById('tt').style.display = 'none';
    }, true);
    document.addEventListener('touchstart', () => {
      document.getElementById('tt').style.display = 'none';
    }, { capture: true, passive: true });

    // Touch panel cancel button
    document.getElementById('tpcancel')?.addEventListener('click', () => this.cancelTsel());
  }

  // ─────────────────────────────────────────────────
  // Cell & unit clicks
  // ─────────────────────────────────────────────────

  _onCellClick(ci) {
    if (this.tsel) {
      this._onTapCell(ci);
    } else {
      this._onTapCellSel(ci);
    }
  }

  _onUnitClick(uid, ci) {
    if (this.tsel && this.tsel.from === ci &&
        ((this.tsel.mode === 'unit' && this.tsel.uid === uid) || this.tsel.mode === 'group')) {
      this.cancelTsel(); return;
    }
    this.tsel = { mode: 'unit', uid, from: ci };
    this.renderer.clearHighlights();
    this.renderer.clearSelections();
    const unit = this.engine.state.cells[ci]?.units.find(u => u.id === uid);
    if (!unit) return;
    const valids = this._getValidMoves(ci, unit);
    this.renderer.highlightSrc(ci);
    this.renderer.highlightTargets(valids);
    this.renderer.selectUnit(uid);
    this.renderer.showTouchPanel(unit, this.engine.state.moveOrders.has(uid));
  }

  _onTapCellSel(ci) {
    const pu = this.engine.state.cells[ci]?.units.filter(u => u.owner === 'player') || [];
    if (!pu.length) return;
    if (this.tsel?.mode === 'group' && this.tsel.from === ci) { this.cancelTsel(); return; }
    this.tsel = { mode: 'group', uids: pu.map(u => u.id), from: ci };
    this.renderer.clearHighlights();
    this.renderer.clearSelections();
    this.renderer.highlightSrc(ci);
    const allMoves = this._groupValidMoves(ci, pu);
    this.renderer.highlightTargets(allMoves);
    pu.forEach(u => this.renderer.selectUnit(u.id));
    this.renderer.showTouchPanelGroup(pu, ci);
  }

  _onTapCell(to) {
    if (!this.tsel) return;
    const from = this.tsel.from;
    if (to === from) { this.cancelTsel(); return; }
    if (this.tsel.mode === 'unit') {
      const uid = this.tsel.uid;
      this.cancelTsel();
      this._doOrderMove(uid, from, to);
    } else {
      const uids = [...this.tsel.uids];
      this.cancelTsel();
      uids.forEach(uid => this._doOrderMove(uid, from, to));
    }
  }

  cancelTsel() {
    this.tsel = null;
    this.renderer.clearHighlights();
    this.renderer.clearSelections();
    this.renderer.hideTouchPanel();
  }

  // ─────────────────────────────────────────────────
  // Drag & drop
  // ─────────────────────────────────────────────────

  _onDragStart(e, uid, ci) {
    this.drag = { uid, from: ci };
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => {
      const unit = this.engine.state.cells[ci]?.units.find(u => u.id === uid);
      if (unit) {
        const valids = this._getValidMoves(ci, unit);
        this.renderer.highlightSrc(ci);
        this.renderer.highlightTargets(valids);
      }
    }, 0);
  }

  _onDrop(to) {
    if (!this.drag) return;
    const { uid, from } = this.drag;
    this.drag = null;
    this._doOrderMove(uid, from, to);
  }

  _onDragEnd() {
    this.renderer.clearHighlights();
    document.querySelectorAll('.utok.dragging').forEach(t => t.classList.remove('dragging'));
    this.drag = null;
  }

  // ─────────────────────────────────────────────────
  // Building & ability buttons
  // ─────────────────────────────────────────────────

  _onBuildingClick(bid, unit) {
    const result = this.engine.queueUnit(bid, unit);
    if (!result.ok) {
      const msgs = { 'queue full': 'File pleine !', 'insufficient gold': 'Or insuffisant !' };
      this.renderer.showLog(msgs[result.reason] || result.reason);
    }
    this.renderer.refreshBldgs();
  }

  _onAbilityClick(type) {
    const result = this.engine.useAbility(type);
    if (!result.ok) {
      const msgs = { 'on cooldown': 'Capacité en recharge !', 'no units': 'Aucune unité disponible !' };
      this.renderer.showLog(msgs[result.reason] || result.reason);
    }
    this.renderer.refreshAbils();
  }

  _onUpgradeClick(type) {
    const result = this.engine.researchUpgrade(type);
    if (!result.ok) {
      const msgs = {
        'no upgrades': 'Aucune amélioration disponible !',
        'max level reached': 'Niveau maximum atteint !',
        'already researching': 'Recherche déjà en cours !',
        'insufficient gold': 'Or insuffisant !',
      };
      this.renderer.showLog(msgs[result.reason] || result.reason);
    } else {
      this.renderer.showLog(result.upgrade.icon + ' Recherche : ' + result.upgrade.name + ' !');
    }
    this.renderer.refreshBldgs();
  }

  // ─────────────────────────────────────────────────
  // Order helpers
  // ─────────────────────────────────────────────────

  _doOrderMove(uid, from, to) {
    const result = this.engine.orderMove(uid, from, to);
    if (!result.ok) this.renderer.showLog('Destination invalide !');
    this.renderer.updateCell(from);
  }

  _getValidMoves(fromCi, unit) {
    const res = [];
    for (let i = 0; i < this.engine.config.NC; i++) {
      if (i === fromCi || unit.owner !== 'player') continue;
      const dir = i > fromCi ? 1 : -1;
      let reachable = true;
      for (let ci = fromCi + dir; ci !== i; ci += dir) {
        if (this.engine.state.cells[ci].owner !== 'player') { reachable = false; break; }
      }
      if (!reachable) continue;
      const dest = this.engine.state.cells[i];
      if (dest.owner !== 'player' && dest.units.some(u => u.owner === 'enemy')) continue;
      res.push(i);
    }
    return res;
  }

  _groupValidMoves(fromCi, units) {
    const needed = units.reduce((s, u) => s + this.engine.config.units[u.type].slots, 0);
    const allMoves = new Set(units.flatMap(u => this._getValidMoves(fromCi, u)));
    return [...allMoves].filter(ci => {
      const used = this.engine.state.cells[ci].units.reduce((s, u) => s + this.engine.config.units[u.type].slots, 0);
      return used + needed <= this.engine.config.SLOTS;
    });
  }
}
