# WarLane — Architecture v2

## Vue d'ensemble

WarLane a été refactorisé d'un fichier HTML monolithique vers une architecture modulaire ES Modules, permettant :
- **Jeu jouable** en navigateur (GitHub Pages + PWA)
- **Simulation headless** en Node.js (des milliers de parties)
- **Optimisation automatique** des paramètres via une webapp dédiée

---

## Structure des fichiers

```
warlane/
├── index.html                  # Jeu principal
├── optimizer.html              # Webapp d'optimisation
├── main.js                     # Entrée navigateur (boucle rAF)
├── run-simulation.js           # CLI Node.js headless
├── manifest.json               # PWA manifest
├── package.json
│
├── config/
│   ├── gameplay.default.json   # Toutes les constantes gameplay
│   └── scoring.default.json    # Poids de la fonction de score
│
└── src/
    ├── core/                   # 🔥 Moteur pur — ZERO DOM
    │   ├── gameState.js        # Conteneur de données
    │   ├── gameEngine.js       # Logique de simulation
    │   ├── rng.js              # RNG déterministe (mulberry32)
    │   ├── scoring.js          # Fonction de score multi-objectifs
    │   ├── randomSearch.js     # Générateur de configs aléatoires
    │   └── simulationRunner.js # Runner de batch
    │
    ├── ui/                     # 🖼  Couche UI passive
    │   ├── renderer.js         # Rendu HTML/Canvas (lit engine.state)
    │   └── inputController.js  # Gestion des entrées utilisateur
    │
    └── optimizer-ui/           # ⚗  Webapp d'optimisation
        ├── workers/
        │   └── simWorker.js    # Web Worker pour simulations
        └── (app.js, charts.js — intégrés dans optimizer.html)
```

---

## Architecture en couches

```
┌─────────────────────────────────────────┐
│  BROWSER / NODE.JS                      │
├────────────────┬────────────────────────┤
│  UI Layer      │  Headless Layer        │
│  (browser only)│  (browser + Node.js)  │
│                │                        │
│  renderer.js   │  gameEngine.js         │
│  inputCtrl.js  │  ├─ GameState          │
│  main.js       │  ├─ stepGold()         │
│  (rAF loop)    │  ├─ stepCombat()       │
│                │  ├─ stepAI()           │
│                │  └─ stepMovement()     │
│                │                        │
│                │  simulationRunner.js   │
│                │  scoring.js            │
│                │  randomSearch.js       │
│                │  rng.js                │
└────────────────┴────────────────────────┘
          ↑ reads config ↑
┌─────────────────────────────────────────┐
│  config/gameplay.default.json           │
│  config/scoring.default.json            │
└─────────────────────────────────────────┘
```

---

## Modules clés

### `GameEngine` (src/core/gameEngine.js)

Le cœur de la simulation. Entièrement pur, zéro DOM.

```js
const engine = new GameEngine(config, seed);
engine.init();
engine.step(dt, dtr);  // avance la simulation
const state = engine.state;  // lecture état
```

**Actions joueur :**
```js
engine.queueUnit('barracks', 'warrior');
engine.orderMove(unitId, fromCi, toCi);
engine.useAbility('archer');
```

**Événements :**
```js
engine.on('hit', ({ atk, tgt, tci, dmg }) => { /* effet visuel */ });
engine.on('gameOver', ({ winner, stats }) => { /* fin de partie */ });
engine.on('event', (evt) => { /* event aléatoire */ });
```

---

### `GameState` (src/core/gameState.js)

Conteneur de données pur. Sérialisable, clonable.

```js
const clone = state.clone();
```

Contient : `cells`, `projectiles`, `gold`, `buildings`, `buffs`, `abilityCooldowns`, `moveOrders`, `stats`.

---

### `Renderer` (src/ui/renderer.js)

**Passive** : lit `engine.state`, ne contient aucune logique gameplay.

```js
const renderer = new Renderer(wrapEl, engine.state, config);
renderer.mount();
renderer.render(state, tsel, drag);  // appelé chaque frame
```

---

### `InputController` (src/ui/inputController.js)

**Dispatcher** : transforme les gestes en appels `engine.*()`.

Aucune logique de jeu. Gère drag&drop, tap mobile, sélection de groupes.

---

### `simulationRunner.js`

```js
// Batch aléatoire (random search)
const result = runSimulationBatch({
  runs: 1000,
  baseConfig,
  scoringWeights,
  dt: 100,
  maxDurationMs: 300000,
  seed: 42,
  onProgress: (done, total, best) => {}
});

// Partie unique
const { winner, stats } = runSingleGame(config, { dt, maxDurationMs, seed });
```

---

### `scoring.js`

Fonction multi-objectifs :

```
score = balanceWeight    × balanceScore       (jeu équilibré)
      + durationWeight   × durationScore      (durée idéale)
      + diversityWeight  × diversityScore     (variété d'unités)
      + frontlineWeight  × frontlineDynamics  (front actif)
      - stalematePenalty
```

Poids configurables dans `config/scoring.default.json`.

---

### `randomSearch.js`

Génère des configs aléatoires dans un espace de paramètres défini :

```js
const config = generateRandomConfig(baseConfig, DEFAULT_PARAM_SPACE, rangeOverrides, rng);
```

`DEFAULT_PARAM_SPACE` couvre ~25 paramètres (économie, IA, unités, mouvement).

---

## Utilisation Node.js

```bash
# Installer les dépendances (serveur de dev seulement)
npm install

# Lancer une simulation rapide
node run-simulation.js --runs 100 --dt 200

# Simulation complète 1000 runs
node run-simulation.js --runs 1000 --dt 100 --max-dur 300 --output results.json

# Partie unique avec stats
node run-simulation.js --single --seed 42

# Via scripts npm
npm run sim:fast
npm run sim:thorough
```

---

## Webapp d'optimisation (`optimizer.html`)

### Fonctionnalités
- Lancer N simulations via Web Worker (non-bloquant)
- Configurer plages min/max par paramètre
- Suivi de progression en temps réel
- Visualisations : scores, durées, win rate, radar composantes
- Tableau Top 20 presets avec détail breakdown
- Export JSON du meilleur preset
- Injection du preset dans le jeu via localStorage
- Historique des batches (localStorage)

### Flux d'injection de preset
1. Optimiser → sélectionner un preset → cliquer "Injecter"
2. Le preset est sauvegardé dans `localStorage('warlane_active_config')`
3. `main.js` peut lire ce preset au démarrage (à activer si souhaité)

---

## Config JSON

### gameplay.default.json

Toutes les constantes gameplay sont externalisées :

```json
{
  "NC": 10, "SLOTS": 6, "GBASE": 18, "GCELL": 1.2,
  "CQRATE": 0.012, "MAXG": 999,
  "AITICK": 550, "AI_MOVES": 3, "AI_BUILDS": 2,
  "MOVE_TICK": 900,
  "units": {
    "warrior": { "hp": 130, "dmg": 24, "cost": 60, "abil": { "cd": 12000 } },
    ...
  },
  "buildings": [...],
  "events": [...]
}
```

---

## RNG déterministe

Toutes les simulations utilisent `mulberry32` (src/core/rng.js) :

```js
const rng = createRng(seed);
// rng() → [0, 1) déterministe
```

Le même `seed` + `config` produit toujours la même partie. Prêt pour algorithme génétique.

---

## Extension future : Algorithme génétique

L'infrastructure est prête :

```js
import { interpolateConfigs } from './src/core/randomSearch.js';

// Croisement
const child = interpolateConfigs(parentA, parentB, 0.5, DEFAULT_PARAM_SPACE);

// Mutation
const mutant = generateRandomConfig(child, SMALL_MUTATION_SPACE, null, rng);

// Évaluation
const { score } = scoreResult(stats, weights);
```

---

## GitHub Pages

Compatible sans bundler. Chargement via ES Modules natif.

```yaml
# .github/workflows/deploy.yml
- name: Deploy
  uses: peaceiris/actions-gh-pages@v3
  with:
    publish_dir: ./warlane
```

---

## Guide de migration depuis v1

| v1 (monolithique) | v2 (modulaire) |
|---|---|
| `UDEF` global | `config.units` (JSON) |
| `cells[]` global | `engine.state.cells` |
| `gold` global | `engine.state.gold` |
| `moveOrders` Map global | `engine.state.moveOrders` |
| `updCombat(dt)` fonction | `engine.stepCombat(dt)` |
| `updAI(dt)` fonction | `engine.stepAI(dt)` |
| `queueUnit()` UI | `engine.queueUnit()` |
| `useAbil()` UI | `engine.useAbility()` |
| `orderMove()` UI | `engine.orderMove()` |
| `renderAll()` partout | `renderer.render(state)` |
| `Math.random()` | `this.rng()` (déterministe) |

---

## Performance headless

Sur Node.js moderne, les performances attendues :

| DT | Vitesse sim | 1000 runs × 300s |
|---|---|---|
| 100ms | ~3000x | ~100s wall clock |
| 200ms | ~6000x | ~50s wall clock |
| 500ms | ~15000x | ~20s wall clock |

*(estimations — dépend du hardware et de la complexité des parties)*
