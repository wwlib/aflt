# Copilot live test — hello-aflt on a work Mac

Self-contained guide for a human or another assistant on a **work Mac with GitHub Copilot CLI** (no Cursor CLI, no prior chat history). Goal: validate, dry-run, then live-run [`examples/loops/hello-aflt`](../examples/loops/hello-aflt/) with the Copilot engine, then record what success looked like.

Flags and subcommands below match `aflt help` / `bin/af.js` USAGE. Do not invent flags. Prefer `aflt help` if anything looks stale.

Related: [examples/loops/hello-aflt/README.md](../examples/loops/hello-aflt/README.md), [tutorial/09-loops.md](tutorial/09-loops.md), [tutorial/12-token-usage.md](tutorial/12-token-usage.md). Recorded run (2026-11-23): [reports/2026-11-23-copilot-live-test-report.md](reports/2026-11-23-copilot-live-test-report.md).

---

## Prerequisites

### Node

```bash
node -v   # need >= 20.10 (engines in package.json; npm test needs it)
```

### GitHub Copilot CLI

```bash
npm install -g @github/copilot
copilot version          # e.g. GitHub Copilot CLI 1.0.x
which copilot
```

Auth (first time, or if headless runs fail with auth errors):

```bash
copilot login            # browser / device-code OAuth; stores a credential
# optional smoke: interactive `copilot` then exit, or a short -p prompt
```

Override binary with `AGENTFLEET_COPILOT_BIN` if needed. Cursor CLI is **not** required.

### aflt install and PATH

`npm install -g aflt` 404s until the package is published. Use GitHub or a checkout:

```bash
npm install -g github:wwlib/aflt
```

Or from this checkout:

```bash
cd /path/to/aflt
npm link                 # or: npm install -g . / symlink bin/af.js → ~/.local/bin/aflt
```

Confirm:

```bash
which aflt
aflt --version           # e.g. aflt 1.5.0
aflt --version --json    # {"version":"1.5.0"}
```

Ensure the npm global bin dir (and `~/.local/bin` if you use clone-backed symlinks) is on `PATH`. Do not edit shell rc files for someone else — print PATH instructions only.

Read-only environment check (never prints secrets):

```bash
aflt doctor
aflt doctor --json
```

Expect a soft warn if Cursor is missing (`cursor_bin` does not fail the command). A binary named `agent` counts only when it identifies as Cursor. Copilot should be present when `AGENTFLEET_ENGINE=copilot`.

---

## Isolate the fleet (recommended)

A live hello-aflt run writes sessions under `$AGENTFLEET_HOME`. Use a **named space** so you do not touch the default `~/.agentfleet` home:

```bash
aflt space create copilot-live   # once; picks a free dashboard port (8788+)
aflt space current               # or: aflt --space copilot-live space current
```

Then either export for the shell session:

```bash
export AFLT_SPACE=copilot-live
```

or pass `--space copilot-live` on every `aflt` command (flag wins over `AFLT_SPACE`). Explicit `AGENTFLEET_HOME` always wins over spaces.

Default (no space) dashboard port is **8787**. A new space records its own port in that space’s `config.json` (`dashboard.port`). Inspect with:

```bash
aflt --space copilot-live space current --json
# or read ~/.agentfleet/spaces/copilot-live/config.json → dashboard.port
```

---

## Select the Copilot engine

`hello-aflt.json` **omits** `engine`, so phases inherit:

`--engine` (n/a on loop) → `AGENTFLEET_ENGINE` → `$AGENTFLEET_HOME/config.json` `defaultEngine` → builtin `cursor`

On a Copilot-only Mac, set the default **before** the live run:

```bash
export AGENTFLEET_ENGINE=copilot
# or persist in the space/home config:
aflt --space copilot-live engine copilot
# aliases: aflt --space copilot-live copilot
```

Confirm:

```bash
aflt --space copilot-live engine
```

### Model

Copilot's account default (for example `claude-opus-4.6`) may be unavailable. A plain `copilot -p` then fails until you pass a model the account can use. `auto` worked on the 2026-11-23 live test.

Resolution for each phase (first hit wins):

1. Phase `model` in the loop definition
2. Loop-level `model`
3. `COPILOT_MODEL` when the phase engine is Copilot
4. `$AGENTFLEET_HOME/config.json` `defaultModel` (alias `model`)
5. Otherwise the CLI's own default (no `--model`). If Copilot answers `Model "…" is not available`, aflt retries that phase once with `--model auto` and uses `auto` for the rest of the run. Change the fallback with `AGENTFLEET_COPILOT_FALLBACK_MODEL=<model>`, or turn it off with `AGENTFLEET_COPILOT_FALLBACK_MODEL=none`.

```bash
export COPILOT_MODEL=auto
# or persist a fleet default (COPILOT_MODEL still overrides this for Copilot):
# printf '%s\n' '{ "defaultEngine": "copilot", "defaultModel": "auto" }' > config via aflt, or edit the space config.json
```

`hello-aflt.json` does not pin `model`. Without `COPILOT_MODEL` or `defaultModel`, each phase starts on the account default and falls back to `auto` if that model is unavailable. Pin a model when you want repeatable runs.

---

## 1. Validate

From any cwd (path to the definition is absolute or relative to your shell):

```bash
AFLT_DEF=/path/to/aflt/examples/loops/hello-aflt/hello-aflt.json

aflt --space copilot-live loop validate "$AFLT_DEF"
aflt --space copilot-live loop validate "$AFLT_DEF" --json
```

Success (text): `ok: loop "hello-aflt" (… phase(s))`. JSON: `"ok": true` and a `definition` object. Exit 1 on schema/phase/eval errors.

Also valid: `hello-aflt-improve.json` (continue-improve only; distinct loop name).

---

## 2. Dry run

Prints the phase plan; **does not** take the runner lock or execute phases. Text and `--json` include the resolved **cwd**, **permission mode** (`force` / `restricted` / `mixed`), and **model**.

`loop run` refuses a cwd that is not a clean empty git repo, or that contains the aflt checkout or the definition file, unless you pass `--allow-existing`. Dry-run prints the plan and exits 1 in that case. Run the dry-run from the empty game repo (next section) so `"cwd": "."` is that repo. From the aflt checkout, pass `--allow-existing` if you only want to inspect the plan.

```bash
aflt --space copilot-live loop run "$AFLT_DEF" --dry-run
aflt --space copilot-live loop run "$AFLT_DEF" --dry-run --json
```

Expect phase lines for `m0` … improve/`plan-next` with engine resolved to `copilot` when the default is set, `force=true` (hello-aflt opts in), and `model=` from `COPILOT_MODEL` / config when set. No `state.json` runner progress for a dry-run.

---

## 3. Live run (`--fresh`)

Create an empty game repo (or use an existing one). `"cwd": "."` in the definition follows **your shell cwd**:

```bash
mkdir -p ~/tmp/tile-dungeon-live && cd ~/tmp/tile-dungeon-live
git init

export AGENTFLEET_ENGINE=copilot
export AFLT_SPACE=copilot-live
# Optional: export COPILOT_MODEL=auto (unpinned runs fall back to auto anyway)

# First run in this fleethome — --fresh is optional but safe.
# Re-running after status=completed REQUIRES --fresh (else: "loop already completed").
# A fresh empty git repo does not need --allow-existing.
# hello-aflt sets force:true on each phase (full Copilot tool access). Omit that
# and the default is restricted unless you pass --force.
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --fresh
# or with explicit space flag:
# aflt --space copilot-live loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --fresh --json
```

`aflt loop run` stays in the foreground. To detach it, log stdout/stderr and keep the pid:

```bash
mkdir -p ~/tmp
nohup aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --fresh \
  > ~/tmp/aflt-copilot-live-run.log 2>&1 &
echo $! > ~/tmp/aflt-copilot-live-run.pid
# later:
aflt loop status hello-aflt
tail -f ~/tmp/aflt-copilot-live-run.log
# stop (exact name; do not pkill):
aflt loop stop hello-aflt
```

An existing tree (hello-aflt-improve, or `--fresh` after the game already has files) is not an empty repo. Pass `--allow-existing`:

```bash
cd /path/to/existing-game
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt-improve.json --allow-existing
```

What this does (see example README):

- Seeds portable M0 when `package.json` is missing (`m0-seed/` + `seed-m0.js`, run as a `type: "script"` phase — no Copilot call)
- Runs M1–M4, M5a, then up to 3 plan-next improve rounds gated by `improve-gate.js` (HEAD vs working tree)
- `aflt loop` is the orchestrator; Copilot is only the worker engine
- Relative `promptFile` / `improve-gate.js` / `seed-m0.js` resolve against the **definition directory**, not the game cwd

Budget (from the definition): `maxRuns` 40, `maxHours` 8, `maxPhases` 16. This can take a long time — leave the process running; do not `pkill`/`killall`. To stop: `aflt --space copilot-live loop stop hello-aflt` (exact name).

Optional second terminal — live UI (port from the space config, default 8787 if not using a space):

```bash
aflt --space copilot-live dashboard --serve
# open http://127.0.0.1:<port>/  → Loops view
```

`--port N` overrides. Bind defaults to `127.0.0.1`.

---

## What success looks like

### Loop status (CLI)

```bash
aflt --space copilot-live loop status hello-aflt
aflt --space copilot-live loop status hello-aflt --json
```

Prefer **`--json`** for metrics. Human text is a short summary; JSON includes (from `lib/loop.js` `statusReport` / `summarizeLoopState` / `buildPhasePipeline`):

| Field | Meaning |
|-------|---------|
| `status` | e.g. `running` → `completed` (or `failed` / `stopped` / `paused` / `waiting`) |
| `elapsedMs` | Active run time: sum of run segments (start/resume → completed/failed/stopped/paused/gate wait); idle gaps between runs are not counted. `wallElapsedMs` is wall time since `startedAt` |
| `budget.hoursUsed` / `runsUsed` | Hours and run counts vs definition caps (`hoursUsed` is active run time, the same number `maxHours` is enforced on) |
| `usage` | Per-loop token rollup, recomputed at read time from each phase session's turns (de-duplicated; `storedTotalTokens` / `recomputed` when the `state.json` rollup disagrees). Copilot `credits` / `usd` come from per-call usage records (`creditsSource: "per-call"`, `calls`, `callsWithCost`) when the turns carry none. Never estimates USD from tokens |
| `pipeline[].id` / `status` / `evalScore` | Phase tree; `evalScore` from stored phase results (`overall` / `after` parsed before `lastEval` truncation) |
| `phases.<id>.evalScore` | Same scores on raw phase state |
| `loopRootSessionId` | Master session for History nesting (`loop-hello-aflt`) |

### Dashboard Loops view

With `aflt dashboard --serve` on the space’s port:

- **List row:** name, status, current phase, attempt, elapsed, budget (`N/M runs · H/h`), tokens and recorded cost (`6.1m tok · 278.8 credits · $2.79`)
- **Detail:** Started / Updated (local time), step pipeline, phase tree with **eval scores**, eval output tails, History session links, **Tokens** rollup (`formatLoopUsage`: e.g. `6.1m tok · 9 turns · reported · 278.8 credits · $2.79`; `cost unknown` only when the engine recorded no cost, e.g. Cursor), plus a note when totals were recomputed from per-session records
- History view: phase workers nest under the loop master; session rows show compact token meta

### Token / cost honesty

- Copilot `cost` stays **`null`** (provider “cost” on usage records is stored as `premiumRequests`, not USD).
- Copilot AI credits are recorded separately: `credits` / `usd` / `costBasis: "copilot-nano-aiu"` from `copilotUsage.totalNanoAiu` (1e9 nano-AIU = 1 credit = $0.01). The Loops view shows them (rows and detail; read from the per-call records when older turns lack them), and `aflt --space copilot-live making-of hello-aflt` shows credits and dollars per call, per phase and for the whole run.
- `usage-summary.json` counts a headless run once (`dedupedTurns`). Loop rollups stored in `state.json` before this fix are double-counted; `loop status` and the dashboard recompute them from the phase sessions' turns at read time (the state file is not rewritten) and say so in the Loops detail.
- Prefer **`reported`** counts from Copilot `usage_record` (JSON stdout or `events.jsonl`). Some turns are still **`accuracy: "estimated"`** (char/4 of prompt + final reply only) or rollups **`partial`** when mixed with reported turns. Do not treat estimates as API-reported.
- Planner / loop-root sessions on a **fresh** run mint **new** session ids (no title reuse of completed/failed peers). Mid-run resume still reuses bound `sessionId`s.

### Post–PR #8 success checks

- A phase whose agent exits non-zero or times out must **fail or retry**, even if the eval command was already green (no more false passes on seed tests alone).
- A brand-new space/home must not fail on missing `results/` / `plans/` (`--add-dir` is prepared automatically).
- Dry-run text/JSON shows resolved **cwd**, **permissions**, and **model** before any live work.

---

## Recording results

### Files to capture

Under the space home (example: `~/.agentfleet/spaces/copilot-live/`):

| Path | What |
|------|------|
| `loops/hello-aflt/state.json` | Full loop state: phases, `evalScore`, `usage`, timestamps, history |
| `loops/hello-aflt/plan-next.json` | Last planner output (when plan-next ran) |
| `runs/<phase-session-id>/usage-summary.json` | Per-session token rollup |
| `runs/<phase-session-id>/turns.jsonl` | Per-turn usage rows (optional deep dive) |
| `sessions.json` | Registry (loop master + phase workers) |

Game repo (shell cwd): `eval/history.jsonl`, `eval/latest-score.json`, optional `eval/plateau.json` from `improve-gate.js`.

### Commands to archive

```bash
SPACE=copilot-live
HOME_DIR="$HOME/.agentfleet/spaces/$SPACE"
OUT=~/Desktop/aflt-copilot-live-$(date +%Y%m%d)

mkdir -p "$OUT"
aflt --space "$SPACE" loop status hello-aflt --json > "$OUT/loop-status.json"
aflt --space "$SPACE" --version --json > "$OUT/aflt-version.json"
cp "$HOME_DIR/loops/hello-aflt/state.json" "$OUT/state.json"
# optional: copy phase usage summaries
find "$HOME_DIR/runs" -name usage-summary.json -print0 | while IFS= read -r -d '' f; do
  id=$(basename "$(dirname "$f")")
  cp "$f" "$OUT/usage-summary-$id.json"
done

copilot version > "$OUT/copilot-version.txt" 2>&1
node -v > "$OUT/node-version.txt"
uname -a > "$OUT/uname.txt"
```

### Results template

Fill in after the run (paste into `$OUT/RESULTS.md` or a ticket):

```markdown
# Copilot live test — hello-aflt

- Date (local):
- Machine:
- Node (`node -v`):
- Copilot CLI (`copilot version`):
- aflt (`aflt --version`):
- Space / AGENTFLEET_HOME:
- Dashboard URL / port:
- Engine selection: AGENTFLEET_ENGINE= / `aflt engine` output:
- Model: `COPILOT_MODEL` / config `defaultModel` / fallback to `auto` (yes/no):
- Definition path:
- Game cwd:
- Command: `aflt loop run … --fresh` (exact argv; note `--allow-existing` / `--force` if used):

## Outcome

- Final `status` (from `loop status --json`):
- `elapsedMs` / human elapsed:
- `budget.runsUsed` / `budget.hoursUsed`:
- Phases passed / failed (ids):
- Any agent non-zero/timeout that correctly failed or retried (not a false pass):
- Per-phase `evalScore` (from `pipeline` or `state.phases`):
  - m0:
  - m1:
  - m2:
  - m3:
  - m4:
  - m5a:
  - improve-* (if any):
  - plan-next (wrote `plan-next.json`? attempts?):
- Loop `usage.totalTokens` / `accuracy` / `turnCount`:
- `usage.cost` (expect null):
- AI credits / $ (`usage.credits` / `usage.usd` in `loop status --json`, or `aflt making-of hello-aflt --json`):
- Estimated vs reported notes:
- Planner / loop-root session ids (confirm fresh per `--fresh` run):

## Artifacts

- [ ] loop-status.json
- [ ] state.json
- [ ] plan-next.json (if planner ran)
- [ ] usage-summary-*.json
- [ ] making-of.html (`aflt making-of hello-aflt`)
- [ ] screenshot of Loops view (optional)

## Issues / gaps observed

- (See Known gaps — especially Copilot plan-next non-interactive write TODO)
-
```

---

## Known gaps (do not “fix” in the write-up)

1. **USD on the dashboard** — Copilot keeps `cost: null`; the Loops view shows recorded AI credits and `usd` (as in `usage-summary.json` and the making-of page). Cursor records no cost, so Cursor loops show “cost unknown”. Never derive dollars from tokens.
2. **Estimated usage** — some turns/rollups are `estimated` or `partial`, not fully API-reported. Even with `usage_record`, a long edit can still look small if the record is missing and the fallback is chars/4 of prompt + final reply only.
3. **Fresh planner sessions** — `--fresh` / new runs mint new planner + loop-root sessions; do not expect title reuse of completed peers.
4. **Long wall clock** — budget allows up to 8 hours; success is green phases + scores, not a short runtime.
5. **No Cursor** — if `aflt doctor` warns about missing Cursor, that is expected on a Copilot-only Mac. A non-Cursor binary named `agent` is ignored (PR #8).
6. **Copilot plan-next cannot yet write its plan file non-interactively** — the planner must write `$AGENTFLEET_HOME/loops/<name>/plan-next.json`, which sits outside the game `-C` cwd. Headless Copilot still has no reliable non-interactive path to that file (follow-up TODO from PR #8). Expect retries, manual intervention, or Cursor for plan-next until that lands. Do not treat a stuck/missing `plan-next.json` as a docs or harness bug in the write-up.

Fixed by PR #8 (do **not** re-list as open gaps): agent non-zero/timeout no longer passes a green eval; fresh homes get `results/` / `plans/` before `--add-dir`; loop `model` / `COPILOT_MODEL` / `defaultModel` + unavailable-model → `auto` fallback; `force` defaults off; cwd guard + `--allow-existing`; `--dry-run` prints cwd / permissions / model.

---

## Quick command checklist

```bash
# prereqs
node -v && copilot version && aflt --version && aflt doctor

# space + engine
aflt space create copilot-live
export AFLT_SPACE=copilot-live AGENTFLEET_ENGINE=copilot
# optional but recommended when the account default model is unavailable:
export COPILOT_MODEL=auto
aflt engine copilot

# empty game repo first (cwd guard), then validate → dry-run → live
DEF=/path/to/aflt/examples/loops/hello-aflt/hello-aflt.json
mkdir -p ~/tmp/tile-dungeon-live && cd ~/tmp/tile-dungeon-live && git init
aflt loop validate "$DEF" --json
aflt loop run "$DEF" --dry-run --json
aflt loop run "$DEF" --fresh

# observe
aflt loop status hello-aflt --json
aflt dashboard --serve   # Loops view @ space dashboard.port
```

Stop a runaway runner with `aflt loop stop hello-aflt` only (exact name). Never use `pkill` / `killall` or pattern-matched kills.
