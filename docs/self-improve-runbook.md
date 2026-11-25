# Self-improving loop runbook

Short guide to run `examples/loops/self-improve.json` in a dedicated git worktree with isolated AgentFleet state. Design background and implementation status: [self-improving-loop-design.md](self-improving-loop-design.md).

**CLI-only quick start** (hello-aflt tile dungeon on a fresh Mac): [cli-quickstart-loops.md](cli-quickstart-loops.md).

## Prerequisites

- Node ≥ 20.10
- A **stable** `aflt` install on `PATH` (npm global, `npm link`, or symlink) pointing at a checkout you do **not** ask the loop to edit (for example `~/github/wwlib/aflt` or a release install)
- Engine CLIs: Copilot (`copilot`), and/or Cursor (`cursor-agent` on `PATH`, often under `~/.local/bin`), and/or OpenCode
- Optional webhook: `AFLT_NOTIFY_URL`, `AFLT_NOTIFY_KEY` (see `aflt notify test`)

## 1. Create the worktree

From your main aflt clone (not the stable shim’s source if that is the same tree you edit):

```bash
cd ~/github/wwlib/aflt   # or your upstream clone
git fetch origin
git worktree add ~/tmp/aflt-self -b "aflt-self/$(date +%Y-%m-%d)" main
```

The loop definition sets `"cwd": "~/tmp/aflt-self"` and `workdir: { "mode": "worktree", "base": "main" }`.

## 2. Isolate fleet state

```bash
export AFLT_SPACE=self-improve
export AGENTFLEET_ENGINE=copilot   # or cursor / opencode
# Optional model (Copilot): export COPILOT_MODEL=...
# Optional heartbeat while the runner is live (seconds):
export AFLT_LOOP_HEARTBEAT_SECONDS=300
# Optional notify
export AFLT_NOTIFY_URL=https://hooks.example.com/aflt
export AFLT_NOTIFY_KEY=your-secret
```

Fleet home becomes `~/.agentfleet/spaces/self-improve` when `AGENTFLEET_HOME` is unset.

## 3. Preflight

Run from the **stable** install (any cwd):

```bash
aflt doctor --strict --loop ~/github/wwlib/aflt/examples/loops/self-improve.json
```

With notify wired:

```bash
aflt doctor --strict --notify --loop ~/github/wwlib/aflt/examples/loops/self-improve.json
```

Fix PATH if doctor warns that `~/.local/bin` is missing while `cursor-agent` lives there.

The loop’s first phase runs the same check inside the worktree (`node ./bin/af.js doctor --strict`).

## 4. Validate and dry-run

```bash
aflt loop validate ~/github/wwlib/aflt/examples/loops/self-improve.json --json
aflt loop run ~/github/wwlib/aflt/examples/loops/self-improve.json --dry-run --json
```

Dry-run prints cwd, permission mode, model, and workdir inspection.

## 5. Run the loop

```bash
aflt loop run ~/github/wwlib/aflt/examples/loops/self-improve.json
```

Use `AFLT_SPACE=self-improve` on every command. The runner uses the worktree as `cwd`, ordered engine failover (`copilot` → `cursor` → `opencode`), protected paths, cheap-first **verify** tiers, local **commit** on improve-gate (`allow.push` / `allow.merge` stay false), and **commitGate** `observe` with `Verified-by` trailers.

### Watch progress

```bash
AFLT_SPACE=self-improve aflt dashboard --serve --port 8789
```

Open `http://127.0.0.1:8789/` (Loops view). Avoid 8787 if another dashboard already uses it. **Making of** on the loop (or `http://127.0.0.1:8789/making-of/self-improve`) shows every AI call, commit, diff and artifact.

### Review a run (making of)

```bash
AFLT_SPACE=self-improve aflt making-of self-improve            # self-contained HTML in the loop folder
AFLT_SPACE=self-improve aflt making-of self-improve --json     # calls, credits/$, commits summary
```

Each phase archives its engine record under `runs/<session>/engine/` and writes `runs/<session>/calls.jsonl`, so the review still works after Copilot/Cursor prune their own logs. Copilot costs are as Copilot recorded them; Cursor shows tokens only (no cost is estimated).

### Unattended (scheduler)

```bash
AFLT_SPACE=self-improve aflt loop start ~/github/wwlib/aflt/examples/loops/self-improve.json
AFLT_SPACE=self-improve aflt dashboard --serve --port 8789
```

## 6. needs_human and recovery

After three failed improve rounds (or a non-retryable failure with `escalation` configured), status becomes **`needs_human`** instead of `failed`. Notify event **`loop.needs_human`** (and `loop.gate.waiting`) fires with a diagnostic bundle. State is under `$AGENTFLEET_HOME/loops/self-improve/needs-human.json`.

| Action | Command |
|--------|---------|
| Inspect | `AFLT_SPACE=self-improve aflt loop status self-improve --json` |
| Continue | `AFLT_SPACE=self-improve aflt loop resume self-improve` |
| Stop | `AFLT_SPACE=self-improve aflt loop stop self-improve` |
| Pause | `AFLT_SPACE=self-improve aflt loop pause self-improve` |

Verify tier checkpoints are stored in loop state keyed by commit SHA, plus a fingerprint of uncommitted work when the tree is dirty (`<sha>+dirty-<fingerprint>`); resume skips only tiers already green for exactly that tree.

## 7. What the definition runs

| Step | Purpose |
|------|---------|
| preflight | `aflt doctor --strict` |
| measure / score-baseline | Hermetic eval measure + baseline (`verify: false`) |
| plan-next | One small fix per round; planner instructs build phases to use verify tier1–2 only and **improve-gate** to run **tier3** (tile-dungeon, 2 trials) |
| planned build | npm test + dashboard (tier1), hello-eval smoke (tier2); tier3 only on improve-gate |

Protected paths include `eval/RUBRIC.md`, `scripts/eval/**`, hello-aflt improve gate + prompts, and this definition file.

## 8. Still Phase 3 (not in this loop yet)

- Paired multi-trial acceptance with `minDelta` / `maxStdDev` medians
- Automatic rule learning and monthly pruning into `AGENTS.md` / memory
- Full `commitGate` **enforce** mode in production (currently **observe**)

See [self-improving-loop-design.md](self-improving-loop-design.md) phased rollout.