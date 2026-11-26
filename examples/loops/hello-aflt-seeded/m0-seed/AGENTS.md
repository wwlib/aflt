# AGENTS.md — Tile Dungeon

Guidance for AI coding agents working on `tile-dungeon`.

## Stack & Constraints

- **Zero runtime dependencies.** Use plain Node.js (`>= 18`) and plain browser HTML5 `<canvas>` + ES modules (`"type": "module"` in `package.json`).
- **Pure state vs. rendering.** Keep game rules, RNG, dungeon generation, FOV, AI, combat, inventory, and progression in pure ES modules under `src/` with zero DOM/`window`/`document` dependencies so `node:test` can drive every mechanic headlessly.
- **Deterministic RNG.** Use an explicit seeded PRNG (`src/rng.js`) for every random roll in gameplay and generation. Never rely on unseeded `Math.random()` inside simulation logic.
- **Testing.** Run `npm test` (`node --test test/*.test.js`). Keep all tests fast, deterministic, and hermetic.
- **Server.** `server.js` binds `127.0.0.1` on `process.env.PORT || 8792` (override with `HOST`). Do not bind 8790 or 8791.

## Safety & Workflow Rules

- **Never use `pkill`, `killall`, or pattern-matched kills.** Only stop specific PIDs that you started.
- **Do not commit** inside `aflt run` worker tasks unless explicitly instructed; the loop orchestrator handles commits after verifying tests when `allow.commit` + `onPass` permit it.
- **Never weaken tests or eval scorers** (`scripts/eval/eval.js`, `scripts/eval/scorer.js`) to raise scores during improvement rounds.
- Keep `README.md` and `AGENTS.md` updated as milestones land.

## Milestones

1. **M1:** Grid tile map, canvas rendering, keyboard movement, wall collision, seeded RNG, pure state module, headless tests.
2. **M2:** Seeded procedural dungeon generation, FOV + fog of war, multi-seed connectivity/solvability tests.
3. **M3:** Monsters with AI, turn-based combat, HP, message log, death and restart, headless tests.
4. **M4:** Potions, weapons/armor, inventory, stairs to deeper levels, difficulty scaling, headless tests.
5. **M5a:** `scripts/eval/` headless bot + scorer + iterative balance/gameplay improvement loop.
