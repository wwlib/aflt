# hello-aflt — tile dungeon from scratch

The default **hello-aflt** loop: the game repo starts with **instructions only**
(no code, no HTML). An agent writes every file, including the M0 scaffold, from
`SPEC.md`.

Everything the loop uses lives **inside the project**: the seed carries the loop
definition, prompts, and check scripts under `.agentfleet/`, so `aflt loop
validate` does not warn about files outside the cwd and runs do not depend on
the aflt checkout.

> **Seeded M0 (non-default):** [`hello-aflt-seeded`](../hello-aflt-seeded/README.md)
> copies a portable `m0-seed/` tree via a script phase instead of an agent build.

![The game a hello-aflt run built (Cursor composer-2.5), seed 42](../../../docs/images/tile-dungeon-scratch.png)

## Quick start

Use a new folder that is not inside another git repo (optionally its own space):

```bash
mkdir -p ~/aflt-projects/tile-dungeon && cd ~/aflt-projects/tile-dungeon
/path/to/aflt/examples/loops/hello-aflt/install.sh
# or: cp -R /path/to/aflt/examples/loops/hello-aflt/seed/. .
git init && git add -A && git commit -m "Seed hello-aflt"
aflt loop validate .agentfleet/loop.json
aflt loop run .agentfleet/loop.json
```

`"workdir": { "mode": "project" }` runs the loop in this repo even though the
repo contains its own definition; commit the seed first so the tree is clean.
`"protected": { "paths": [".agentfleet/**"] }` fails any phase that edits the
loop, prompts, or checks.

**`plannedPhaseGate`: `"none"`** is intentional: plan-next improve phases run
without a human approval gate.

Pick an engine via `AGENTFLEET_ENGINE` / `aflt engine` (Copilot or Cursor).

### Continue improve after M5a

```bash
cd /path/to/existing-game
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt-improve.json --allow-existing
```

Re-run a completed improve loop in the same fleethome with **`--fresh`**.

## Phases

| Phase | Kind | What happens |
|-------|------|----------------|
| `seed-docs` | `script` | `m0-check.cjs --seed-docs` — repo holds only the seed |
| `m0` | agent | Build scaffold from `SPEC.md`; `m0-check.cjs` verifies |
| `m1`–`m4` | agent | Gameplay milestones; `node --test` |
| `m5a` | agent | `scripts/eval/` harness + eval score |
| `plan-next` | planner | ≤3 eval-gated improve rounds via `.agentfleet/checks/improve-gate.cjs` |

## Seed contents

`seed/` may hold only instructions and loop tooling (`AGENTS.md`, `SPEC.md`,
`.agentfleet.json`, `.gitignore`, `.agentfleet/…`). No game code or HTML.

## Making of

`aflt making-of hello-aflt` writes every AI call, commit, diff, and artifact.

## Non-default seeded variant

[`hello-aflt-seeded`](../hello-aflt-seeded/README.md) — M0 is a script phase (`seed-m0.js`).
