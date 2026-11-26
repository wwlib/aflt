# Tile Dungeon

A browser-playable tile-based dungeon roguelike built with plain Node.js and HTML5 Canvas, with zero runtime dependencies. Built with [AgentFleet (`aflt`)](https://github.com/wwlib/aflt) via the portable `examples/loops/hello-aflt` loop.

## Quick Start

```bash
npm start
```

Open `http://127.0.0.1:8792` (or `http://<lan-ip>:8792` on the local network).

> **Port note:** The server binds `127.0.0.1` on port `8792` by default (`PORT` / `HOST`). Ports `8790` and `8791` are commonly taken.

## Testing

```bash
npm test
```

Uses Node's built-in `node:test` runner against headless tests in `test/`.

## Architecture

- `server.js` — minimal Node HTTP static server (`127.0.0.1`, default port `8792`) serving `public/`, `src/`, and `/health`.
- `public/index.html` — browser entry point hosting the `<canvas>` and HUD.
- `src/` — native ES modules shared directly between the browser and Node tests.
- `test/` — headless `node:test` suites.
- `scripts/eval/` — headless bot + deterministic scorer (added in M5a).

## Milestone Plan

- **M1 — Core Grid & Movement:** Seeded RNG, pure game-state, canvas tile map, keyboard movement, wall collision, headless state tests.
- **M2 — Procedural Dungeon & FOV:** Deterministic generation, field of view and fog of war, multi-seed solvability tests.
- **M3 — Monsters & Turn-Based Combat:** Monster AI, turn-based melee, HP, message log, death/restart.
- **M4 — Items, Inventory & Deeper Levels:** Potions, weapons/armor, inventory, stairs, depth scaling.
- **M5a — Headless Bot & Eval:** `scripts/eval/` bot + scorer, then eval-gated improve rounds until plateau.
