/**
 * main.js — WarLane browser entry point v3
 * New: tab system, wall placement mode, gold flow indicator, RAF progress bars
 */

import { GameEngine }       from './src/core/gameEngine.js';
import { Renderer }         from './src/ui/renderer.js';
import { InputController }  from './src/ui/inputController.js';

const CONFIG_URL = './config/gameplay.default.json?v=1776871052';

let engine, renderer, controller;
let lastTs = 0;
let speedMultiplier = 0.25;
let currentSpeedIndex = 1;

// Gold flow smoothing
let goldFlowP = 0, goldFlowE = 0, lastGoldP = 300, lastGoldE = 300;
let flowSamples = [];

async function bootstrap() {
  let config = await fetch(CONFIG_URL).then(r => r.json());

  // If user injected a custom preset from the optimizer, use it
  const saved = localStorage.getItem('warlane_active_config');
  if (saved) {
    try { config = JSON.parse(saved); } catch(e) {}
  }

  engine   = new GameEngine(config);
  renderer = new Renderer(document.getElementById('bwrap'), engine.state, config);
  renderer.setEngine(engine); // wire engine reference for live state access
  renderer.mount();
  controller = new InputController(engine, renderer);

  // ── Engine events → renderer side effects ──────────────────────
  engine.on('hit', ({ tgt, tci, dmg }) => {
    renderer.spawnDamageFloat(tci, dmg, tgt.owner);
  });
  engine.on('unitReady', ({ owner, unit }) => {
    if (owner === 'player') {
      const def = config.units[unit.type];
      renderer.showLog(def.icon + ' ' + def.name + ' prêt !');
    }
    renderer.refreshBldgs();
  });
  engine.on('wallReady', ({ owner }) => {
    if (owner === 'player') {
      showWallBanner(true);
      renderer.showLog('🧱 MUR PRÊT — Choisissez une case !');
    }
  });
  engine.on('wallPlaced', () => {
    showWallBanner(false);
    renderer.refreshBldgs();
    renderer.render(engine.state, controller.tsel, controller.drag);
  });
  engine.on('wallDestroyed', () => {
    renderer.refreshBldgs();
  });
  engine.on('event', evt => {
    renderer.showEventBanner(evt.txt);
    renderer.showLog(evt.txt.replace(/[🛡💰⚡☠🏰⚔]/g, '').trim());
  });
  engine.on('abilityUsed', ({ type }) => {
    const msgs = {
      warrior:  '💨 CHARGE ! Guerriers en avant !',
      archer:   '🌧️ BARRAGE ! Pluie de flèches !',
      catapult: '🔥 BOMBARDEMENT ! Frappe dévastatrice !',
    };
    renderer.showLog(msgs[type] || type);
    renderer.refreshAbils();
  });
  engine.on('upgradeComplete', ({ owner, type, level }) => {
    if (owner === 'player') {
      const def = config.units[type];
      renderer.showLog(`${def.upgrades[level-1].icon} ${def.upgrades[level-1].name} terminé !`);
    }
    renderer.refreshBldgs();
    refreshUpgradeTab();
  });
  engine.on('gameOver', ({ winner }) => {
    renderer.showGameOver(winner);
  });

  // ── HUD buttons ──────────────────────────────────────────────
  document.getElementById('pbtn').addEventListener('click', togglePause);
  document.getElementById('po').addEventListener('click', () => {
    if (engine.state.paused) togglePause();
  });
  document.getElementById('sp1').addEventListener('click', () => setSpeed(1));
  document.getElementById('sp2').addEventListener('click', () => setSpeed(2));
  document.getElementById('sp3').addEventListener('click', () => setSpeed(3));
  document.getElementById('rbtn').addEventListener('click', initGame);

  // ── Tab system ───────────────────────────────────────────────
  document.querySelectorAll('.btab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.btab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.btab-content').forEach(c =>
        c.classList.toggle('active', c.id === 'tab-' + tab));
      if (tab === 'upgrade') refreshUpgradeTab();
    });
  });

  // ── Wall placement: clicking a cell ──────────────────────────
  // Intercept cell clicks when pendingWall is true
  const origCellClick = controller._onCellClick.bind(controller);
  controller._onCellClick = (ci) => {
    if (engine.state.pendingWall) {
      const result = engine.placeWall(ci);
      if (!result.ok) {
        renderer.showLog('Impossible : ' + result.reason);
      } else {
        showWallBanner(false);
        clearWallHighlights();
      }
      return;
    }
    origCellClick(ci);
  };

  window.addEventListener('resize', () => {
    const canvas = document.getElementById('ac');
    const r = document.getElementById('bwrap').getBoundingClientRect();
    canvas.width = r.width; canvas.height = r.height;
  });

  initGame();
}

// ── Wall placement mode UI ───────────────────────────────────────
function showWallBanner(show) {
  document.getElementById('wall-banner').classList.toggle('show', show);
  if (show) highlightWallTargets();
  else      clearWallHighlights();
}

function highlightWallTargets() {
  const divs = document.getElementById('lane')?.children;
  if (!divs) return;
  const s   = engine.state;
  const cfg = engine.config;
  for (let i = 0; i < cfg.NC; i++) {
    const cell = s.cells[i];
    if (cell.owner !== 'player' || cell.wall) continue;
    const wallSl   = cfg.wall.slots || 2;
    const usedSlots = cell.units.reduce((sum, u) =>
      sum + (cfg.units[u.type]?.slots || 1), 0);
    if (usedSlots + wallSl <= cfg.SLOTS)
      divs[i]?.classList.add('wall-target');
  }
}

function clearWallHighlights() {
  document.querySelectorAll('.cell.wall-target').forEach(el =>
    el.classList.remove('wall-target'));
}

// ── Upgrade tab ──────────────────────────────────────────────────
function refreshUpgradeTab() {
  const row = document.getElementById('upg-row');
  if (!row) return;
  row.innerHTML = '';
  const s   = engine.state;
  const cfg = engine.config;

  Object.entries(cfg.units).forEach(([type, def]) => {
    if (!def.upgrades?.length) return;
    const currentLevel = s.upgrades?.player?.[type] || 0;
    const queue        = s.upgradeQueues?.player?.[type];

    def.upgrades.forEach((upg, idx) => {
      const done        = idx < currentLevel;
      const researching = queue?.level === idx + 1;
      const available   = idx === currentLevel && !queue;
      const locked      = idx > currentLevel || (idx === currentLevel && queue);

      const card = document.createElement('div');
      card.className = 'upg-card' +
        (researching ? ' researching' : '') +
        ((done || locked) && !researching ? ' ucool' : '');

      const stars = '★'.repeat(idx + 1) + '☆'.repeat(2 - idx);
      const cost  = available ? `💰${upg.cost}` : (done ? '✓' : '🔒');

      card.innerHTML = `
        <div class="un">${def.icon} ${upg.icon} ${upg.name}</div>
        <div class="ulvl">${stars} Niv.${idx + 1}</div>
        <div class="udesc">${upg.desc}</div>
        <div class="br" style="margin-top:3px">
          <span class="bs">${(upg.researchTime/1000).toFixed(0)}s</span>
          <span class="bc">${cost}</span>
        </div>
        ${researching ? `<div class="uprog" id="uprog-${type}-${idx}" style="width:0%"></div>` : ''}
      `;

      if (available && s.gold.p >= upg.cost) {
        card.addEventListener('click', () => {
          const res = engine.researchUpgrade(type);
          if (!res.ok) { renderer.showLog(res.reason); return; }
          renderer.showLog(`🔬 Recherche : ${upg.name}`);
          refreshUpgradeTab();
        });
      }

      // Tooltip
      card.addEventListener('mouseenter', e => {
        const tt = document.getElementById('tt');
        tt.innerHTML = `<h4>${upg.icon} ${upg.name}</h4>
          <div>${upg.desc}</div>
          <div class="tr"><span>Coût</span><span class="tv">💰${upg.cost}</span></div>
          <div class="tr"><span>Temps</span><span class="tv">${(upg.researchTime/1000).toFixed(1)}s</span></div>
          <div class="tr"><span>Statut</span><span class="tv">${done?'Terminé':researching?'En cours...':available?'Disponible':'Verrouillé'}</span></div>`;
        tt.style.display = 'block';
        tt.style.left = Math.min(e.clientX+12, innerWidth-190)+'px';
        tt.style.top  = Math.min(e.clientY+12, innerHeight-160)+'px';
      });
      card.addEventListener('mouseleave', () => {
        document.getElementById('tt').style.display = 'none';
      });

      row.appendChild(card);
    });
  });
}

// ── Gold flow calculation ────────────────────────────────────────
function updateGoldFlow(dt) {
  const s   = engine.state;
  const cfg = engine.config;
  const pc  = s.cells.filter(c => c.owner === 'player').length;
  const ec  = s.cells.filter(c => c.owner === 'enemy').length;

  const flowP = (cfg.GBASE + pc * cfg.GCELL);
  const flowE = (cfg.GBASE + ec * cfg.GCELL);

  // Smooth with EMA
  goldFlowP = goldFlowP * 0.9 + flowP * 0.1;
  goldFlowE = goldFlowE * 0.9 + flowE * 0.1;

  document.getElementById('pgflow').textContent = `+${goldFlowP.toFixed(0)}/s`;
  document.getElementById('egflow').textContent = `+${goldFlowE.toFixed(0)}/s`;
}

// ── RAF-driven progress bar updates ─────────────────────────────
function updateProgressBars() {
  const s   = engine.state;
  const cfg = engine.config;

  // Building queues
  cfg.buildings.forEach(b => {
    const el = document.getElementById('bp-' + b.id);
    if (!el) return;
    const st = s.buildings[b.id];
    const pct = st?.queue.length ? (st.queue[0].elapsed / st.queue[0].total * 100) : 0;
    el.style.width = pct + '%';
  });

  // Upgrade queues
  if (s.upgradeQueues?.player) {
    Object.entries(s.upgradeQueues.player).forEach(([type, q]) => {
      if (!q) return;
      const el = document.getElementById(`uprog-${type}-${q.level - 1}`);
      if (el) el.style.width = (q.elapsed / q.total * 100) + '%';
    });
  }
}

// ── Game loop ────────────────────────────────────────────────────
function initGame() {
  renderer.hideGameOver();
  controller.cancelTsel();
  engine.init();
  renderer.setEngine(engine); // CRITICAL: update state reference after init() replaces state
  renderer.mount();
  // Must be called AFTER engine.init() so state.buildings is populated
  renderer.refreshBldgs();
  renderer.refreshAbils();
  lastTs = 0;
  lastGoldP = 300; lastGoldE = 300; goldFlowP = 18; goldFlowE = 18;
  showWallBanner(false);
  setSpeed(1);
  refreshUpgradeTab();
  requestAnimationFrame(loop);
}

function loop(ts) {
  if (!engine.state.running) { lastTs = 0; return; }
  requestAnimationFrame(loop);
  const raw = lastTs ? ts - lastTs : 16;
  lastTs = ts;
  if (engine.state.paused) return;

  const dt  = Math.min(raw * speedMultiplier, 150);
  const dtr = Math.min(raw, 50);

  engine.step(dt, dtr);
  renderer.render(engine.state, controller.tsel, controller.drag);

  // RAF-driven UI updates (not gated on game logic)
  updateProgressBars();
  updateGoldFlow(dt);

  // Refresh ability row only every ~200ms real time to avoid DOM thrash
  if (!loop._abilTimer) loop._abilTimer = 0;
  loop._abilTimer += raw;
  if (loop._abilTimer >= 200) {
    loop._abilTimer = 0;
    renderer.refreshAbils();
    // Also refresh upgrade progress if tab is active
    if (document.getElementById('tab-upgrade')?.classList.contains('active')) {
      refreshUpgradeTab();
    }
  }
}

function togglePause() {
  engine.state.paused = !engine.state.paused;
  renderer.setPause(engine.state.paused);
  if (!engine.state.paused) lastTs = 0;
}

function setSpeed(s) {
  const map = { 1: 0.25, 2: 0.5, 3: 1.0 };
  speedMultiplier = map[s];
  currentSpeedIndex = s;
  renderer.setSpeed(s);
}

// Expose for compatibility
window.togglePause = togglePause;
window.setSpeed = setSpeed;
window.initGame = initGame;

bootstrap();
