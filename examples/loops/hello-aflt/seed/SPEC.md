# SPEC.md — Tile Dungeon (from scratch)

A browser-playable, tile-based dungeon roguelike in plain Node.js and HTML5
Canvas with zero runtime dependencies. Built milestone by milestone by AI
agents driven by the `aflt` loop in `.agentfleet/loop.json` (hello-aflt).

This file is the contract. The repo ships with no code; agents create all of it.

## M0 — Scaffold (built by the agent, not copied)

The M0 phase must leave exactly this minimal, working scaffold:

| Path | Contract |
|------|----------|
| `package.json` | `"name": "tile-dungeon"`, `"private": true`, `"type": "module"`, scripts `"start": "node server.js"` and `"test": "node --test test/*.test.js"`. No `dependencies` or `devDependencies`. |
| `server.js` | Minimal `node:http` static server. Has a **named** export `createServer()` (`export function createServer`, not a default export) that returns an un-listened `http.Server`. When run directly (`node server.js`) it listens on `process.env.HOST \|\| '127.0.0.1'` and `Number(process.env.PORT \|\| 8792)` and logs the URL. Routes: `GET /health` → `200` JSON `{"ok":true}`; `GET /` and `/index.html` → `public/index.html`; `/src/*` → files under `src/`; other paths → files under `public/`. Path-traversal safe (403 outside those dirs), 404 for missing files, correct `Content-Type` for `.html`, `.js`, `.css`, `.json`, `.svg`, `.png`, and `Cache-Control: no-store`. Never bind 8790 or 8791. |
| `public/index.html` | HTML5 page with `<canvas id="game" width="800" height="600">` and `<script type="module" src="/src/main.js">`. Dark background, crisp pixelated canvas. |
| `src/main.js` | Browser entry module: gets the `#game` canvas, clears it, and draws a "Tile Dungeon initializing..." placeholder. No game logic yet. |
| `test/smoke.test.js` | `node:test` + `node:assert/strict`. Imports `createServer` from `../server.js`, listens on port `0` on `127.0.0.1`, asserts `/health` returns `200` + `{ ok: true }`, `/` returns `200` HTML containing `<canvas id="game"`, and a path-traversal request does not escape the served dirs. Closes the server. |
| `README.md` | Title, Quick Start (`npm start`, open `http://127.0.0.1:8792`), Testing (`npm test`), Architecture (files above), and the milestone plan below. |

M0 must **not** implement M1 features (no RNG, game state, renderer, or input
modules). Keep `AGENTS.md` and this `SPEC.md`.

## Milestone plan

- **M1 — Core Grid & Movement:** seeded RNG (`src/rng.js`), pure game state (`src/game-state.js`), canvas tile map renderer, keyboard movement (arrows + WASD), wall collision, HUD, headless state tests.
- **M2 — Procedural Dungeon & FOV:** deterministic rooms + corridors, guaranteed connectivity, stairs tile, FOV with wall occlusion, unseen / explored / visible fog of war, 50-seed solvability tests.
- **M3 — Monsters & Turn-Based Combat:** monster archetypes and AI, bump-to-attack melee, HP, bounded message log, death and restart.
- **M4 — Items, Inventory & Deeper Levels:** potions, weapons, armor, bounded inventory, stairs to deeper floors, depth-based difficulty scaling.
- **M5a — Headless Bot & Eval:** `scripts/eval/bot.js`, `scorer.js`, `eval.js` with the fixed metrics (crash_free 0.25, solvability 0.20, avg_depth 0.20, turns_survived 0.15, balance_sanity 0.20; avg_depth target 3.5) writing `eval/history.jsonl`; then eval-gated improve rounds until plateau.

Each milestone keeps `npm test` green and updates `README.md` / `AGENTS.md`.
