/**
 * main.js — WarLane browser entry point.
 *
 * Wires together: GameEngine ↔ Renderer ↔ InputController
 * Owns the rAF game loop.
 */

import { GameEngine } from './src/core/gameEngine.js';
import { Renderer } from './src/ui/renderer.js';
import { InputController } from './src/ui/inputController.js';

const CONFIG_URL = './config/gameplay.default.json';

let engine, renderer, controller;
let lastTs = 0;
let speedMultiplier = 0.25; // 1x = 0.25 to match original feel
let currentSpeedIndex = 1;

async function bootstrap() {
  const config = await fetch(CONFIG_URL).then(r => r.json());
  engine = new GameEngine(config);
  renderer = new Renderer(document.getElementById('bwrap'), engine.state, config);
  renderer.mount();
  controller = new InputController(engine, renderer);

  // Wire engine events → renderer side-effects
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
  engine.on('event', evt => {
    renderer.showEventBanner(evt.txt);
    renderer.showLog(evt.txt.replace(/[🛡💰⚡☠🏰]/g, '').trim());
  });
  engine.on('abilityUsed', ({ type, name }) => {
    const def = config.units[type];
    const msgs = {
      warrior: '💨 CHARGE ! Guerriers en avant !',
      archer: '🌧️ BARRAGE ! Pluie de flèches !',
      catapult: '🔥 BOMBARDEMENT ! Frappe dévastatrice !',
    };
    renderer.showLog(msgs[type] || name);
    renderer.refreshAbils();
  });
  engine.on('gameOver', ({ winner }) => {
    renderer.showGameOver(winner);
  });

  // Wire HUD buttons
  document.getElementById('pbtn').addEventListener('click', togglePause);
  // Clicking anywhere on the pause overlay also resumes
  document.getElementById('po').addEventListener('click', () => {
    if (engine.state.paused) togglePause();
  });
  document.getElementById('sp1').addEventListener('click', () => setSpeed(1));
  document.getElementById('sp2').addEventListener('click', () => setSpeed(2));
  document.getElementById('sp3').addEventListener('click', () => setSpeed(3));
  document.getElementById('rbtn').addEventListener('click', initGame);

  window.addEventListener('resize', () => {
    const canvas = document.getElementById('ac');
    const r = document.getElementById('bwrap').getBoundingClientRect();
    canvas.width = r.width; canvas.height = r.height;
  });

  initGame();
}

function initGame() {
  renderer.hideGameOver();
  controller.cancelTsel();
  engine.init();
  renderer.mount();
  lastTs = 0;
  setSpeed(1);
  requestAnimationFrame(loop);
}

function loop(ts) {
  if (!engine.state.running) { lastTs = 0; return; }
  requestAnimationFrame(loop);
  const raw = lastTs ? ts - lastTs : 16;
  lastTs = ts;
  if (engine.state.paused) return;

  const dt = Math.min(raw * speedMultiplier, 150);
  const dtr = Math.min(raw, 50);

  engine.step(dt, dtr);
  renderer.render(engine.state, controller.tsel, controller.drag);
}

function togglePause() {
  engine.state.paused = !engine.state.paused;
  renderer.setPause(engine.state.paused);
  // Reset lastTs so the first frame after unpause doesn't produce a huge dt spike
  if (!engine.state.paused) lastTs = 0;
}

function setSpeed(s) {
  const map = { 1: 0.25, 2: 0.5, 3: 1.0 };
  speedMultiplier = map[s];
  currentSpeedIndex = s;
  renderer.setSpeed(s);
}

// Expose for inline HTML buttons (kept for compatibility)
window.togglePause = togglePause;
window.setSpeed = setSpeed;
window.initGame = initGame;

bootstrap();
