/**
 * renderer.js — Pure passive rendering layer for WarLane.
 *
 * Reads engine.state and updates DOM + Canvas.
 * Contains ZERO game logic.
 *
 * @param {HTMLElement} root  - Container element
 * @param {object} state      - engine.state reference
 * @param {object} config     - engine.config reference
 */
export class Renderer {
  constructor(root, state, config) {
    this.root = root;
    this.state = state;
    this.config = config;
    this.canvas = null;
    this.ctx = null;
    // Callbacks dispatched to the controller
    this._onCellClick = null;
    this._onUnitClick = null;
    this._onUnitDragStart = null;
    this._onCellDrop = null;
    this._drag = null; // drag state reference passed in from controller
    this._tsel = null; // touch selection reference
  }

  /** Mount DOM skeleton */
  mount() {
    this.canvas = this.root.querySelector('#ac');
    this.ctx = this.canvas?.getContext('2d');
    this._renderCells();
    this._renderBldgs();
    this._renderAbils();
    this._updateGoldUI();
  }

  /** Full render pass — called each animation frame */
  render(state, tsel, drag) {
    this.state = state;
    this._tsel = tsel;
    this._drag = drag;
    this._syncCells();
    this._draw();
    this._updateGoldUI();
  }

  /** Partial cell update (called on specific cell changes) */
  updateCell(i) {
    this._updateCellDOM(i);
  }

  /** Rebuild bottom building cards */
  refreshBldgs() {
    this._renderBldgs();
  }

  /** Rebuild ability row */
  refreshAbils() {
    this._renderAbils();
  }

  showEventBanner(txt) {
    const banner = document.getElementById('evt-banner');
    if (!banner) return;
    banner.textContent = txt;
    banner.classList.add('show');
    setTimeout(() => banner.classList.remove('show'), 4000);
  }

  showLog(msg) {
    const el = document.getElementById('log');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2500);
  }

  spawnDamageFloat(ci, dmg, owner) {
    const wrap = document.getElementById('bwrap');
    const divs = document.getElementById('lane')?.children;
    if (!divs?.[ci] || !wrap) return;
    const r = divs[ci].getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'dmgf';
    el.textContent = '-' + dmg;
    el.style.color = owner === 'player' ? '#ff4444' : '#44aaff';
    el.style.left = (r.left - wr.left + r.width * (0.2 + Math.random() * 0.6)) + 'px';
    el.style.top = (r.top - wr.top + 14) + 'px';
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }

  showGameOver(winner) {
    const go = document.getElementById('go');
    const t = document.getElementById('got');
    const sub = document.getElementById('gosub');
    if (!go || !t || !sub) return;
    if (winner === 'player') {
      t.textContent = 'VICTOIRE'; t.className = 'win';
      sub.textContent = 'Vous avez conquis tout le territoire ennemi !';
    } else {
      t.textContent = 'DÉFAITE'; t.className = 'lose';
      sub.textContent = 'Votre territoire a été anéanti.';
    }
    go.classList.add('show');
  }

  hideGameOver() { document.getElementById('go')?.classList.remove('show'); }

  setPause(paused) {
    document.getElementById('po')?.classList.toggle('show', paused);
    document.getElementById('pbtn')?.classList.toggle('on', paused);
  }

  setSpeed(s) {
    [1, 2, 3].forEach(n => document.getElementById('sp' + n)?.classList.toggle('on', n === s));
  }

  highlightSrc(ci) {
    document.getElementById('lane')?.children[ci]?.classList.add('drag-src');
  }

  highlightTargets(ciArr) {
    const divs = document.getElementById('lane')?.children;
    if (!divs) return;
    ciArr.forEach(ci => divs[ci]?.classList.add('vtgt'));
  }

  clearHighlights() {
    document.querySelectorAll('.cell.drag-src,.cell.vtgt').forEach(el =>
      el.classList.remove('drag-src', 'vtgt'));
  }

  selectUnit(uid) {
    document.querySelector(`.utok[data-uid="${uid}"]`)?.classList.add('sel');
  }

  clearSelections() {
    document.querySelectorAll('.utok.sel').forEach(t => t.classList.remove('sel'));
  }

  showTouchPanel(unit, hasMoveOrder) {
    const d = this.config.units[unit.type];
    document.getElementById('tpicon').textContent = d.icon;
    document.getElementById('tpname').textContent = d.name;
    document.getElementById('tpstats').textContent =
      `PV: ${unit.hp}/${unit.mhp} · ⚔${d.dmg} · 🛡${d.armor}`;
    document.getElementById('tpsub').textContent =
      hasMoveOrder ? 'En route — nouvelle destination ?' : 'Choisir une case ✦ de destination';
    document.getElementById('tp').classList.add('show');
  }

  showTouchPanelGroup(units, fromCi) {
    const icons = [...new Set(units.map(u => this.config.units[u.type].icon))].join(' ');
    document.getElementById('tpicon').textContent = icons;
    document.getElementById('tpname').textContent = `${units.length} unité${units.length > 1 ? 's' : ''}`;
    document.getElementById('tpstats').textContent = `Case ${fromCi + 1} · Groupe`;
    document.getElementById('tpsub').textContent =
      'Cases ✦ = destinations · Les unités avancent case par case';
    document.getElementById('tp').classList.add('show');
  }

  hideTouchPanel() { document.getElementById('tp').classList.remove('show'); }

  // ─────────────────────────────────────────────────
  // Canvas drawing
  // ─────────────────────────────────────────────────

  _draw() {
    if (!this.ctx || !this.canvas) return;
    const { ctx, canvas, state } = this;
    // Sync canvas size
    const wr = document.getElementById('bwrap')?.getBoundingClientRect();
    if (wr && (canvas.width !== wr.width || canvas.height !== wr.height)) {
      canvas.width = wr.width;
      canvas.height = wr.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this._drawProjectiles(state.projectiles);
    this._drawFrontLine();
  }

  _drawProjectiles(projs) {
    const wrap = document.getElementById('bwrap');
    const divs = document.getElementById('lane')?.children;
    if (!wrap || !divs) return;
    const wr = wrap.getBoundingClientRect();
    const { ctx } = this;

    projs.forEach(p => {
      // Map logical cell index → pixel position
      const fp = this._cellCenter(p.x, divs, wr);  // p.x is cell index in headless coords
      const tp = this._cellCenter(p.tx, divs, wr);
      if (!fp || !tp) return;

      ctx.save();
      ctx.beginPath(); ctx.moveTo(fp.x, fp.y);
      ctx.lineTo(fp.x - (tp.x - fp.x) * 0.28, fp.y - (tp.y - fp.y) * 0.28);
      ctx.strokeStyle = p.col + '55'; ctx.lineWidth = p.sz * 0.55; ctx.stroke();
      ctx.beginPath(); ctx.arc(fp.x, fp.y, p.sz, 0, Math.PI * 2);
      ctx.fillStyle = p.col; ctx.shadowBlur = 10; ctx.shadowColor = p.col; ctx.fill();
      ctx.restore();
    });
  }

  _cellCenter(ci, divs, wr) {
    const idx = Math.round(ci); // ci may be fractional during flight
    if (!divs[idx]) return null;
    const r = divs[idx].getBoundingClientRect();
    return { x: r.left - wr.left + r.width / 2, y: r.top - wr.top + r.height / 2 };
  }

  _drawFrontLine() {
    const { state, ctx } = this;
    let frontCi = -1;
    for (let i = 0; i < this.config.NC - 1; i++) {
      if ((state.cells[i].owner === 'player' || state.cells[i].owner === 'neutral') &&
          (state.cells[i + 1].owner === 'enemy' || state.cells[i + 1].owner === 'neutral')) {
        frontCi = i; break;
      }
    }
    if (frontCi < 0) return;
    const divs = document.getElementById('lane')?.children;
    const wr = document.getElementById('bwrap')?.getBoundingClientRect();
    if (!divs?.[frontCi] || !divs[frontCi + 1] || !wr) return;
    const r1 = divs[frontCi].getBoundingClientRect();
    const r2 = divs[frontCi + 1].getBoundingClientRect();
    const x = (r1.right + r2.left) / 2 - wr.left;
    const top = r1.top - wr.top, bot = r1.bottom - wr.top;
    const grad = ctx.createLinearGradient(x, top, x, bot);
    grad.addColorStop(0, 'rgba(201,168,76,0)');
    grad.addColorStop(0.5, 'rgba(201,168,76,.7)');
    grad.addColorStop(1, 'rgba(201,168,76,0)');
    ctx.save();
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot);
    ctx.strokeStyle = grad; ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.shadowBlur = 6; ctx.shadowColor = 'rgba(201,168,76,.5)';
    ctx.stroke(); ctx.restore();
  }

  // ─────────────────────────────────────────────────
  // DOM building
  // ─────────────────────────────────────────────────

  _renderCells() {
    const cont = document.getElementById('lane');
    if (!cont) return;
    cont.innerHTML = '';
    this.state.cells.forEach((cell, i) => {
      const div = this._buildCellDiv(cell, i);
      cont.appendChild(div);
    });
  }

  _syncCells() {
    const cont = document.getElementById('lane');
    if (!cont) return;
    const divs = cont.children;
    if (divs.length !== this.config.NC) { this._renderCells(); return; }
    for (let i = 0; i < this.config.NC; i++) this._updateCellDOM(i);
  }

  _buildCellDiv(cell, i) {
    const div = document.createElement('div');
    this._setCellClass(div, cell);
    div.dataset.idx = i;
    div.appendChild(this._buildSlotBadge(cell));
    if (cell.morale > 0) div.appendChild(this._buildMorale(cell));
    const stk = document.createElement('div'); stk.className = 'ustack';
    this._fillUnitStack(stk, cell, i);
    div.appendChild(stk);
    div.appendChild(this._buildCqBar(cell));
    const ix = document.createElement('div'); ix.className = 'cell-idx'; ix.textContent = i + 1;
    div.appendChild(ix);
    this._attachCellEvents(div, i);
    return div;
  }

  _updateCellDOM(i) {
    const cont = document.getElementById('lane');
    const div = cont?.children[i];
    if (!div) return;
    const cell = this.state.cells[i];
    const wasSrc = div.classList.contains('drag-src');
    const wasTgt = div.classList.contains('vtgt');
    this._setCellClass(div, cell);
    if (wasSrc) div.classList.add('drag-src');
    if (wasTgt) div.classList.add('vtgt');

    div.querySelector('.cell-slots').textContent =
      cell.units.reduce((s, u) => s + this.config.units[u.type].slots, 0) + '/' + this.config.SLOTS;

    let ml = div.querySelector('.cell-morale');
    if (cell.morale > 0) {
      if (!ml) { ml = document.createElement('div'); ml.className = 'cell-morale'; div.appendChild(ml); }
      ml.textContent = '🛡'.repeat(cell.morale);
    } else if (ml) ml.remove();

    const stk = div.querySelector('.ustack'); stk.innerHTML = '';
    this._fillUnitStack(stk, cell, i);

    // Restore selection highlights
    const tsel = this._tsel;
    if (tsel) {
      const uids = tsel.mode === 'unit' ? [tsel.uid] : (tsel.uids || []);
      uids.forEach(uid => {
        const t = div.querySelector(`.utok[data-uid="${uid}"]`);
        if (t) t.classList.add('sel');
      });
    }

    const bar = div.querySelector('.cell-cq-bar');
    if (bar) { bar.style.width = cell.cq * 100 + '%'; bar.style.background = _cqGrad(cell.cq); }
  }

  _setCellClass(div, cell) {
    const oc = cell.owner === 'player' ? 'po' : cell.owner === 'enemy' ? 'eo' : 'no';
    div.className = 'cell ' + oc + (cell.morale > 0 ? ' fort' : '');
  }

  _buildSlotBadge(cell) {
    const sd = document.createElement('div'); sd.className = 'cell-slots';
    sd.textContent = cell.units.reduce((s, u) => s + this.config.units[u.type].slots, 0) + '/' + this.config.SLOTS;
    return sd;
  }

  _buildMorale(cell) {
    const m = document.createElement('div'); m.className = 'cell-morale';
    m.textContent = '🛡'.repeat(cell.morale);
    return m;
  }

  _buildCqBar(cell) {
    const cq = document.createElement('div'); cq.className = 'cell-cq';
    const bar = document.createElement('div'); bar.className = 'cell-cq-bar';
    bar.style.cssText = `width:${cell.cq * 100}%;background:${_cqGrad(cell.cq)}`;
    cq.appendChild(bar);
    return cq;
  }

  _fillUnitStack(stk, cell, i) {
    const all = [...cell.units.filter(u => u.owner === 'player'), ...cell.units.filter(u => u.owner === 'enemy')];
    all.forEach(u => stk.appendChild(this._buildUnitToken(u, i)));
  }

  _buildUnitToken(unit, ci) {
    const tok = document.createElement('div');
    const marching = this.state.moveOrders.has(unit.id);
    tok.className = 'utok ' + (unit.owner === 'player' ? 'pu' : 'eu') +
      (marching ? ' marching' : '') + (unit.owner === 'enemy' && marching ? ' ep' : '');
    tok.dataset.uid = unit.id; tok.dataset.ci = ci;
    const hp = unit.hp / unit.mhp;
    const hpc = hp > 0.6 ? 'hi' : hp > 0.3 ? 'md' : 'lo';
    const def = this.config.units[unit.type];
    tok.innerHTML = `<span class="ui">${def.icon}</span><span class="uh">${unit.hp}</span>
      <div class="uhbar"><div class="uhfill ${hpc}" style="width:${hp * 100}%"></div></div>`;
    if (unit.owner === 'player') {
      tok.draggable = true;
      tok.addEventListener('dragstart', e => this._onUnitDragStart?.(e, unit.id, ci));
      tok.addEventListener('mouseenter', e => this._showUnitTip(e, unit));
      tok.addEventListener('mouseleave', () => hideTip());
      tok.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); this._onUnitClick?.(unit.id, ci); });
      tok.addEventListener('click', e => { e.stopPropagation(); this._onUnitClick?.(unit.id, ci); });
    }
    return tok;
  }

  _attachCellEvents(div, i) {
    div.addEventListener('dragover', e => { e.preventDefault(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault(); div.classList.remove('drag-over');
      document.querySelectorAll('.utok.dragging').forEach(t => t.classList.remove('dragging'));
      this.clearHighlights();
      this._onCellDrop?.(i);
    });
    div.addEventListener('touchend', e => { e.preventDefault(); this._onCellClick?.(i); });
    div.addEventListener('click', () => this._onCellClick?.(i));
  }

  // ─────────────────────────────────────────────────
  // Buildings
  // ─────────────────────────────────────────────────

  _renderBldgs() {
    const row = document.getElementById('brow');
    if (!row) return;
    row.innerHTML = '';
    this.config.buildings.forEach(b => {
      const def = this.config.units[b.unit];
      const st = this.state.buildings[b.id];
      if (!st) return;
      const full = st.queue.length >= 3;
      const card = document.createElement('div');
      card.className = 'bcard' + (full ? ' bcool' : '');
      const prog = st.queue.length ? (st.queue[0].elapsed / st.queue[0].total * 100) : 0;
      card.innerHTML = `<div class="bn">${b.icon} ${b.name}</div>
        <div class="br"><span class="bs">${def.icon} ${def.slots}🔲 ⚔${def.dmg} ❤${def.hp}</span>
        <span class="bc">💰${def.cost}</span></div>
        <div class="bq">${st.queue.length ? `En cours (${st.queue.length}/3)` : 'Disponible'}</div>
        <div class="bp" id="bp-${b.id}" style="width:${prog}%"></div>`;
      card.addEventListener('click', () => this._onBuildingClick?.(b.id, b.unit));
      card.addEventListener('mouseenter', e => this._showBldgTip(e, b, def));
      card.addEventListener('mouseleave', () => hideTip());
      row.appendChild(card);
    });
    this._renderAbils();
  }

  // ─────────────────────────────────────────────────
  // Abilities
  // ─────────────────────────────────────────────────

  _renderAbils() {
    const row = document.getElementById('abil-row');
    if (!row) return;
    row.innerHTML = '';
    Object.keys(this.config.units).forEach(type => {
      const d = this.config.units[type];
      const cd = this.state.abilityCooldowns[type] || 0;
      const pct = cd <= 0 ? 100 : (1 - cd / d.abil.cd) * 100;
      const btn = document.createElement('div');
      btn.className = 'abil-btn ' + (cd <= 0 ? 'ready' : 'cooling');
      btn.innerHTML = `<span class="abil-icon">${d.abil.icon}</span><span>${d.abil.name}</span>
        <div class="abil-cd" style="width:${pct}%"></div>`;
      if (cd <= 0) btn.addEventListener('click', () => this._onAbilityClick?.(type));
      btn.addEventListener('mouseenter', e => this._showAbilTip(e, d));
      btn.addEventListener('mouseleave', () => hideTip());
      row.appendChild(btn);
    });
  }

  // ─────────────────────────────────────────────────
  // Gold UI
  // ─────────────────────────────────────────────────

  _updateGoldUI() {
    document.getElementById('pgold').textContent = Math.floor(this.state.gold.p);
    document.getElementById('egold').textContent = Math.floor(this.state.gold.e);
  }

  // ─────────────────────────────────────────────────
  // Tooltips
  // ─────────────────────────────────────────────────

  _showUnitTip(e, unit) {
    const d = this.config.units[unit.type];
    const tt = document.getElementById('tt');
    tt.innerHTML = `<h4>${d.icon} ${d.name}</h4>
      <div class="tr"><span>PV</span><span class="tv">${unit.hp}/${unit.mhp}</span></div>
      <div class="tr"><span>Armure</span><span class="tv">${d.armor}</span></div>
      <div class="tr"><span>Dégâts</span><span class="tv">${d.dmg}</span></div>
      <div class="tr"><span>Portée</span><span class="tv">${d.rMin > 0 ? d.rMin + '–' : ''}${d.range} case${d.range > 1 ? 's' : ''}</span></div>
      ${this.state.moveOrders.has(unit.id) ? '<div class="tr"><span>Statut</span><span class="tv" style="color:var(--gold-l)">En marche →</span></div>' : ''}`;
    tt.style.display = 'block';
    _mvTip(e);
  }

  _showBldgTip(e, b, d) {
    const tt = document.getElementById('tt');
    tt.innerHTML = `<h4>${b.icon} ${b.name}</h4>
      <div class="tr"><span>Unité</span><span class="tv">${d.icon} ${d.name}</span></div>
      <div class="tr"><span>Coût</span><span class="tv">💰${d.cost}</span></div>
      <div class="tr"><span>Temps</span><span class="tv">${(d.buildTime / 1000).toFixed(1)}s</span></div>
      <div class="tr"><span>PV</span><span class="tv">${d.hp}</span></div>
      <div class="tr"><span>Portée</span><span class="tv">${d.rMin > 0 ? d.rMin + '–' : ''}${d.range}</span></div>
      <div class="tr"><span>Capacité</span><span class="tv">${d.abil.icon} ${d.abil.name}</span></div>`;
    tt.style.display = 'block';
    _mvTip(e);
  }

  _showAbilTip(e, d) {
    const tt = document.getElementById('tt');
    tt.innerHTML = `<h4>${d.abil.icon} ${d.abil.name}</h4><div>${d.abil.desc}</div>
      <div class="tr"><span>Recharge</span><span class="tv">${d.abil.cd / 1000}s</span></div>`;
    tt.style.display = 'block';
    _mvTip(e);
  }
}

// ─────────────────────────────────────────────────
// Module-level tooltip helpers
// ─────────────────────────────────────────────────

function _mvTip(e) {
  const tt = document.getElementById('tt');
  tt.style.left = Math.min(e.clientX + 12, innerWidth - 190) + 'px';
  tt.style.top = Math.min(e.clientY + 12, innerHeight - 160) + 'px';
}

export function hideTip() { document.getElementById('tt').style.display = 'none'; }

function _cqGrad(v) {
  const p = v * 100;
  return `linear-gradient(90deg,rgba(42,100,150,.8) ${p}%,rgba(139,26,26,.55) ${p}%)`;
}
