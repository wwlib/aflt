# AGENTS.md — using AgentFleet (`aflt`) from an AI coding agent

This guide is for **AI coding agents** (GitHub Copilot CLI, Cursor CLI / `cursor-agent`, and orchestrators that shell out to them). It is the practical companion to the human-oriented [README](README.md). Flag lists and exit codes come from `aflt help` (`bin/af.js` `USAGE`) and the implementation; do not invent flags.

`aflt` is the **primary command**. `af` and `agentfleet` are aliases for the same CLI (`bin/af.js`). The product name is **AgentFleet**. Internal names are unchanged: `~/.agentfleet`, `AGENTFLEET_*`, `.agentfleet.json`, MCP server name `af`, Herdr mod `af-sessions`. The npm package name is **`aflt`** (homepage [aflt.dev](https://aflt.dev)).

Prefer **`aflt help`** (or `aflt` with no args) for the full usage text. **`aflt <command> --help` is not a dedicated help path** — some commands print a short usage error, and others (`ls`, `sync`, `import`, `doctor`, `setup`, `version`) may **run the command**.

Human overview: [README.md](README.md) (dashboard screenshots in `docs/images/`; regenerate with `npm run screenshots` against a running `aflt dashboard --serve`). Release notes: [CHANGELOG.md](CHANGELOG.md).

**Tutorial for humans (and agents helping them):** [docs/tutorial/README.md](docs/tutorial/README.md) — beginner → advanced; create a throwaway `aflt space create tutorial` first so you never touch the real default home.

## What's new (2026-11-24)

- **`aflt making-of <loop> [--out file.html] [--data file.json] [--serve [--port 8797]] [--build-url URL] [--build-label TEXT] [--seed PATH[,PATH]] [--repo DIR] [--no-diffs] [--with-files] [--json]`** — self-contained page per loop: every AI call in order (prompt, reply, reasoning, tool calls + results, tokens, Copilot credits / $ as recorded), every commit in the loop's repo with phase, files and diff, seed files, files per phase, eval outputs. Default output `$AGENTFLEET_HOME/loops/<loop>/making-of.html`; `aflt dashboard --serve` also serves `/making-of/<loop>` (Loops tab **Making of** button).
- **Recording** — after each loop phase: `runs/<session>/engine/` (archived Copilot `events.jsonl`, Cursor `stream-json` events + agent transcript), `runs/<session>/calls.jsonl` (one normalized line per model call), `runs/<session>/session-context.json`. Loop phases run Cursor with `--output-format stream-json`.
- **Usage** — `usage-summary.json` counts a headless run once (`dedupedTurns`); Copilot usage adds `credits` / `usd` / `costBasis` from `copilotUsage.totalNanoAiu` (1e9 nano-AIU = 1 credit = $0.01). `cost` stays provider-reported only; nothing is estimated from tokens.
- **`type: "script"` phases** — `eval.command` is the step; no prompt, session, fix attempts or `maxRuns`. hello-aflt `m0` and hello-aflt-scratch `seed-docs` use it.
- **`examples/loops/hello-aflt-scratch/`** — tile dungeon from a docs-only seed (no code / HTML); M0 is an agent build checked by `.agentfleet/checks/m0-check.cjs`.
- **`aflt space ls [--json]`** (alias of `list`) and the Herdr af sessions **space picker** (passes `--space` to `ls` / `resume` / `adopt`).

## What's new (2026-11-23)

- **Copilot live-test fixes** — failed agent runs no longer pass a green eval; fresh Copilot homes get `results/` before `--add-dir`; loop `model` / `config.json` `defaultModel` / `COPILOT_MODEL`; Copilot `usage_record` counts (`estimated` stays char/4 of prompt + final reply); `force` defaults off (`--force` or `"force": true`); `loop run` refuses a non-empty/dirty cwd or one that contains the aflt checkout or the definition unless `--allow-existing`; `--dry-run` prints cwd, permission mode, and model; `aflt doctor` ignores a non-Cursor `agent`; Node `>=20.10`; report in `docs/reports/2026-11-23-copilot-live-test-report.md`.

## What's new (2026-11-22)

- **hello-aflt audit follow-ups** — `--fresh` / new loop runs mint new planner + loop-root sessions (no title reuse of completed/failed peers; mid-run still reuses bound session ids); Cursor transcript sync aggregates multi-step assistant + tool_use and can enrich sparse headless `estimated` usage (still never invents `reported` or USD); prompt teasers strip same-line plan-mode preambles (timeline / memory / History / dashboard); terminal loops freeze the step pipeline so `develop`/`plan` are never left `active`.
- **`aflt loop` UX fixes + portable hello-aflt** — freeze elapsed/budget hours on completed/failed/stopped/paused loops; per-loop token rollup on `state.json` / `loop status` / Loops view (reuse `lib/usage.js`, never invent USD); phase sessions get `parent`/`role` under a `loop-<name>` master so History trees nest; Loops phase tree shows eval scores from stored phase results (`overall` parsed from full eval stdout before truncation); prompt previews skip the plan-mode/pkill preamble (full prompt unchanged for runs); `promptFile` + companion scripts resolve relative to the definition directory. Example: `examples/loops/hello-aflt/` (one-command empty-repo quick start with M0 seed, Copilot-friendly, `improve-gate.js` compares committed HEAD vs working tree; continue with `hello-aflt-improve.json`). **`aflt loop run … --fresh`** restarts a completed loop in the same fleethome (prefer over a new space so the default Loops view still shows it).

## What's new (2026-11-21)

- **`aflt eval measure` coverage (Node 24)** — `node --test --experimental-test-coverage` + path-based `scripts/eval/ndjson-reporter.js`; nested spawns clear `NODE_TEST_CONTEXT` so coverage is not skipped. Best-effort if unsupported.
- **Token usage** — optional `usage` on `runs/<id>/turns.jsonl` + `usage-summary.json` rollups (`lib/usage.js`). Cursor/OpenCode headless request JSON internally when `--output-format` omitted (user-facing text unchanged); Copilot uses `usage_record`/checkpoint/shutdown. Dashboard History shows token meta + chart; memory sessions.jsonl gets a compact rollup. Never invents USD from tokens.
- **Named spaces** — `--space NAME` / `AFLT_SPACE` isolate a fleet under `$HOME/.agentfleet/spaces/<name>` when `AGENTFLEET_HOME` is unset (`aflt space list|create|current|remove`). Explicit `AGENTFLEET_HOME` still wins. New spaces get a unique dashboard port, notify off, isolated memory, and LaunchAgent `dev.aflt.dashboard.<space>` (default label unchanged).
- **`aflt eval` self-improve (E3)** — `examples/loops/self-improve.json`: measure → score + baseline → plan-next (one small fix) → build → `aflt eval gate --improve` (suite green + score ≥ baseline + RUBRIC GUARD); stop via `aflt eval plateau` (plateau or max rounds, default 3). Autonomous profile: `plannedPhaseGate: "none"`, `allow.*` false (opt in commit/merge via allow + onPass). Helpers: `scripts/eval/improve.js`.
- **`aflt eval measure` (E1)** — hermetic self-measurement (`scripts/eval/`): suite summary + flake rerun, best-effort coverage via `--experimental-test-coverage` + NDJSON reporter, sandboxed CLI smoke, dashboard `/api` contracts; writes `eval/results/<timestamp>.json` (`--json` / `--out DIR`). Never touches real `~/.agentfleet`, live engines, or Herdr.
- **`aflt eval score` / `report` / `gate` (E2)** — deterministic 0–100 score from measure JSON + human-owned `eval/RUBRIC.md`; appends `eval/history.jsonl`; `report` shows latest + trend; `gate` (RUBRIC GUARD) fails if rubric/scoring impl paths change. Qualitative opt-in only; skipped in tests; never calls live engines by default.
- **`aflt loop` (M4)** — multi-phase projects: `type: "plan-next"` planner writes next phases (or `done: true`) to `$AGENTFLEET_HOME/loops/<name>/plan-next.json`; `budget.maxPhases`; loop `goal` / `acceptance` + optional `acceptanceEval`; `plannedPhaseGate` (default `approve` for planned phases). Example: `examples/loops/plan-next.json`.
- **`aflt loop` (M3)** — Loops view in `aflt dashboard --serve` (list, phase pipeline, eval tails, History session links, start/pause/resume/stop/approve, define/edit form). Definitions save only under `$AGENTFLEET_HOME/loops/definitions` (or configured loops dir). Phase `gate: "approve"` → `loop.gate.waiting` + `POST /api/loops/:name/approve` / `aflt loop approve`.
- **`aflt loop` (M2)** — unattended loops via dashboard scheduler (`start` / `pause` + API); `aflt service` macOS LaunchAgent for `dashboard --serve`; opt-in `loop.heartbeat` notify (default off).
- **`aflt loop` (M1)** — multi-phase plan→develop→eval→fix runner (`validate` / `run [--dry-run]` / `status` / `stop` / `resume`). Definition JSON under `examples/loops/`; state in `$AGENTFLEET_HOME/loops/<name>/`; opt-in `loop.*` notify events; memory timeline + status notes when `memoryRepo` is set.

## What's new (2026-11-20)

- **OpenCode engine** — `--engine opencode` for `new` / `run` / `resume` / `spawn` / `memory doc` etc.; headless `opencode run`; resume with `--session`; turn capture from `opencode.db` (read-only); soft `aflt doctor` check.
- **Direct messaging** — opt-in `aflt msg` / `aflt inbox` / `aflt thread` + MCP `read_inbox` / `post_message` (`aflt msg enable`, `--messaging`, or `.agentfleet.json` `{"messaging": true}`).
- **Project↔repo metadata** — portable mappings in `<memoryRepo>/<project>/.agentfleet.json`; inspect with `aflt projects [--json]`.
- **Interactive turn capture** — redacted turns in `runs/<id>/turns.jsonl`; backfill with `aflt turns backfill [--apply]` (Copilot / Cursor / OpenCode).
- **`aflt purge` / `aflt orphans`** — full delete (dry-run unless `--apply`) and orphan/stale scan (`orphans --purge --ids … [--apply]`).
- **Agent docs lifecycle (issue #3)** — safe-boundary checkpoints, note ack, retry/backoff, batched Doc Bot notify after notes (`aflt docs notify …`); archive convention in reporting.
- **Turns → Doc Bot** — `emitTurnCaptured` enqueues turns for batched Doc Bot notify (messaging optional).
- **Notify webhook** — opt-in `config.json` `notify` or `AFLT_NOTIFY_URL`/`KEY`/`HEADER`; events `run.completed` / `run.failed` / `turn.captured` / `loop.*`; `aflt notify test`; flushed before `aflt run` / `aflt loop` exits.
- **Dashboard UX** — Graph zoom/pan/Fit/Spread; History Gantt presets (24h/7d/30d/all), zoom/scroll, marker stacking and count badges (`aflt dashboard --serve`).
- **`aflt memory config`** — refresh template-managed memory root files (`DOC-AGENT.md`, `DOCUMENTATION-PROCESS.md`) after upgrades (dry-run default; `--apply`; optional `--commit`/`--push`); `aflt doctor` hints when `DOC-AGENT.md` is outdated.

---

## What AgentFleet is

AgentFleet tracks, resumes, and orchestrates **Cursor CLI** and **GitHub Copilot CLI** sessions. Chat IDs live in engine-local stores and terminals die on reboot; `aflt` keeps a small local registry under `~/.agentfleet`, launches or resumes the right engine argv into Herdr/tmux/iTerm/WezTerm (or this terminal), runs **headless one-shots** that capture output, and can run a **master → workers** fleet (`spawn`, `wait`, `result`, `send`, `stop`) with optional task messaging and an optional documentarian pass.

It does **not** replace the engines. You (the agent) call `aflt` to create sessions, delegate work, poll status, and collect handoffs.

---

## Install and linking

Requires **Node ≥ 20.10** (`package.json` `engines`; `npm test` needs it). Zero npm runtime dependencies.

Keep **install**, **machine setup**, **project onboarding**, and **workflows** separate:

```bash
# npm install -g aflt 404s until the package is published.
npm install -g github:wwlib/aflt

# Contributors / checkout:
#   cd ~/github/wwlib/aflt && npm link
#   # or: npm install -g .
#   # or: ln -sfn "$(pwd)/bin/af.js" ~/.local/bin/{aflt,af,agentfleet}
```

Ensure the npm global bin dir (and `~/.local/bin` if you use clone-backed symlinks) is on `PATH`. **Do not** edit users' shell startup files for them — print PATH instructions only. Until the first `npm publish`, the GitHub install is the working path.

**Migration** from older clone-backed `~/.local/bin/{aflt,af,agentfleet}` symlinks: after a global npm install, point `which aflt` at the npm binary (remove or replace checkout symlinks). `aflt setup` refuses to overwrite an unrelated `~/.local/bin` name unless `--force`.

```bash
aflt --version            # e.g. "aflt 1.5.0"
aflt --version --json     # {"version":"1.5.0"}

# Machine setup (preview by default; --apply to mutate)
aflt setup                # non-mutating plan
aflt setup --apply        # create $AGENTFLEET_HOME if missing; link aliases if needed
aflt setup --apply --herdr
aflt setup --apply --memory ~/aflt-memory
aflt setup --json

aflt doctor               # read-only: node, home, hc, engines, MCP hints, notify, DOC-AGENT freshness
aflt doctor --json
aflt notify test          # sample webhook POST (requires notify.url / AFLT_NOTIFY_URL)
```

Also install the engine(s) you will use (`aflt setup` reports missing engines but never installs them):

- Cursor CLI: `curl https://cursor.com/install -fsS | bash` (`cursor-agent` / `agent` on PATH). Override with `AGENTFLEET_CURSOR_BIN`.
- Copilot CLI (optional): `npm install -g @github/copilot`. Override with `AGENTFLEET_COPILOT_BIN`.
- OpenCode CLI (optional): [opencode.ai](https://opencode.ai) (`curl -fsSL https://opencode.ai/v2/install | bash`). Override with `AGENTFLEET_OPENCODE_BIN`; data home override `AGENTFLEET_OPENCODE_HOME` (default `~/.local/share/opencode`).
- Herdr (`hc` + optional `herdr-app`) is recommended for interactive sessions but is not required for headless `aflt run` / `spawn`. Pass `--herdr` to `aflt setup` only when you want templates/panel installed.

Optional bash completion: `source /path/to/aflt/completions/af.bash` (completes `aflt`, `af`, and `agentfleet`).

---

## Recommended workflows

Use `--json` when you will parse output. Use `--dry-run` to print the plan without mutating the registry or launching anything. Bound long runs with `--timeout SEC`.

### 1. Delegate a headless task and collect the result

```bash
# Read-only probe (Cursor --mode ask). Omit --force.
aflt run "pong-check" --prompt "Reply with the single word pong and nothing else." \
  --mode ask --cwd "$PWD" --timeout 180 --json

# Editing task — only when you intend file/tool changes. Include --force.
# In the prompt: do not switch to plan mode; do not commit/push/stash/reset/delete
# unless the user explicitly authorized that.
aflt run "fix-tests" --prompt "Fix the failing unit tests in … Acceptance: npm test passes. Do not switch to plan mode. Do not commit." \
  --force --cwd "$PWD" --timeout 600 --json

aflt log fix-tests              # last captured stdout
aflt log fix-tests --path       # path under ~/.agentfleet/runs/<id>/
```

Stdout is the engine's print-mode response. Stderr has progress plus `output: <path>`. Resume the same title later with another `aflt run <title> --prompt "…"`.

### 2. Check status

```bash
aflt ls --json                  # STATUS = lifecycle; HERDR = live runtime; includes project + parent
aflt ls --status active
aflt ls --project my-app --json # filter by stored or derived project name
aflt timeline                   # read-only session tree for cwd's project
aflt timeline --all --json      # every project, grouped
aflt projects --json            # project↔repo mappings + validation problems
aflt dashboard --serve          # live local activity UI (default http://127.0.0.1:8787/)
aflt dashboard --snapshot /tmp/aflt.svg  # read-only SVG/HTML snapshot (≠ memory dashboard)
aflt memory sync                # opt-in: write cwd project timeline + root DASHBOARD.md
aflt memory dashboard           # regenerate root DASHBOARD.md only
aflt memory config [--apply]    # refresh DOC-AGENT.md / DOCUMENTATION-PROCESS.md (dry-run default)
aflt memory doc [--engine cursor|copilot|opencode]  # Doc Bot session (DOC-AGENT.md)
aflt memory sync --all --commit --push  # nightly: sync + commit generated + push
aflt children --json            # workers of this master, or a summary of masters
```

`STATUS` is saved lifecycle (`active` | `paused` | `done`). A process exit does **not** mark the task done — use `aflt done`. `HERDR` is live runtime from `hc ls`: `running` | `shell` | `exited` | `missing` | `unknown` | `-`. `aflt ls --json` also includes derived `workerStatus` (same rules as `aflt children --json`) plus effective `project` and `parent`. `aflt ls` never writes the registry. `aflt timeline` is strictly read-only (no registry/Herdr writes). `aflt dashboard` does not mutate the registry/Herdr by default (local UI / snapshot; not `aflt memory dashboard`); it always may append local interactive turns under `runs/<id>/turns.jsonl`. `--capture-completions` explicitly writes memory-repo completion notes and receipts. Default UI is a collapsible history tree with an activity-only Gantt (completed/failed turn markers) and a shared state filter (star graph remains a selectable view). History and Graph share one vocabulary and colors: **Working** (green), **Waiting** (orange), **Idle** (gray), **Completed** (blue), **Failed** (red). History matches graph interactions for badges/waiting/working markers, click → detail, SSE updates, double-click → Herdr focus (loopback-only; remote clients get a Mini-only note); History row hover popups are off — only Gantt marker hover shows prompt/reply. Timeline scale is controllable (zoom buttons + ctrl/⌘-wheel or pinch, drag-to-pan, presets 24h / 7d / 30d / all); overlapping markers stack or collapse into a count badge that expands on click so every turn stays selectable. Click a row for “where we left off” + prompt/reply history from `runs/<id>/` (plus status notes / completions). Interactive launches record a prompt receipt into `runs/` without scraping Herdr. Live graph positions persist across SSE updates and settle; Graph supports zoom (buttons + wheel/pinch), drag-to-pan, Fit-to-view, and a Spread slider for force-layout elasticity (defaults to a tighter fit-to-view layout). **Working** / **open** mean the agent is actually working (Herdr OSC 7501 `status=working`, or a live headless `runPid`) — not merely `herdr.runtime=running` (pane/process alive; Herdr’s Agents panel shows those as idle). Registry-`active` alone does not count; a completed/idle turn on a still-live pane is **Idle** (registry `status` unchanged). Project badges/rings/filters roll up from session live states only (`waiting > working > failed > idle > completed`; no sessions → idle), never from a project-level open/active flag. Memory-only folders with **no sessions** (`fromMemoryOnly`) are grouped at the bottom of History under **No sessions (N)** (collapsed by default; expand/collapse is kept across SSE); they stay clickable for notes/docs, are omitted from the Graph, and do not count toward Active projects. A **Hide dormant** toggle (default on, persisted in `localStorage`) hides projects whose roll-up is idle/completed and whose last activity is older than the same 24h Active window — working/waiting/failed are never hidden; a count like “12 dormant hidden” is shown. **Show archived** (off by default, `localStorage`) reveals `archived` sessions (dimmed); Graph Spread and timeline preset/view also persist in `localStorage`. Row/detail actions Archive / Unarchive / Delete and project “Archive all idle/completed sub-agents” use loopback-only POSTs with the same `x-aflt-action-token` as Herdr focus (remote clients get the Mini-only note). Legacy project `af` aliases to `aflt` for dashboard hubs and memory sync/dashboard folders.

### 3. Orchestrate workers from a master

```bash
aflt master --goal "Split auth into helpers + tests" --cwd "$PWD" --headless --force --json
# or interactive (default): drops into Herdr with templates/orchestrator.md

aflt spawn --parent <master> --engine copilot --task "helpers" --prompt "…" --force --detach --json
aflt spawn --parent <master> --engine cursor  --task "tests"   --prompt "…" --force --detach --json

aflt wait --parent <master> --timeout 900 --json
# exit 0=all done, 1=failed/stopped, 2=timeout, 3=waiting (needs input)

aflt children <master> --json
aflt result <worker-id> --json
aflt result <worker-id> --require-fresh   # exit 1 if handoff is stale
aflt tail <worker-id> -n 80
aflt send <worker-id> "Please also cover edge case X"
aflt stop <worker-id>                     # or: aflt stop --all-children <master>
```

`aflt spawn` **blocks** until a headless worker finishes unless you pass **`--detach`**. Prefer `--detach` over shell `&` (backgrounded wrappers can die while the engine keeps running). Prompts must be **self-contained**: exact paths, acceptance criteria, and what not to touch. Workers do not share the master's context.

If you *are* the master (launched via `aflt master`), your env already has `AGENTFLEET_ID`, `AGENTFLEET_PLAN`, `AGENTFLEET_RESULT`, `AGENTFLEET_ROLE=master`. Re-read `$AGENTFLEET_PLAN` and run `aflt children --json` on restart. Write the plan only at `$AGENTFLEET_PLAN` and the final summary at `$AGENTFLEET_RESULT`. Do not edit project files yourself.

---

## Gotchas and safety rules

- **Do not switch to / prompt for plan mode** unless the user asked for a plan. For Cursor headless read-only work use `--mode ask`. Omit `--mode` (and pass `--force` only when edits are intended) for implementation work. Never add “enter plan mode” to a worker prompt.
- **Parse `--json`**, not table text. Confirm flags with `aflt help` or `--dry-run`.
- **`--force` is an explicit tool/write grant**, not “skip the prompt.” Cursor: `--force` auto-approves tools/shell. Copilot: `--force` maps to `--allow-all-tools`. Interactive Cursor `new`/`resume` does **not** change Cursor `--force` behavior. Omit `--force` for text-only / read-only prompts.
- **`--trust` is not `--force`.** `aflt run` / `aflt resume` pass Cursor `--trust` by default (skips the workspace-trust dialog). Use `--no-trust` to keep the dialog.
- **Do not commit, push, stash, reset, switch branches, or delete files** unless the user explicitly authorized that exact action. `aflt rm` removes registry rows and af-owned files under `$AGENTFLEET_HOME` (results/, plans/) only — never `runs/<id>/` logs, the project, `~/.cursor`, or `~/.copilot`. Prefer `aflt rm --dry-run` first. **`aflt purge`** (or `aflt rm --purge`) is the full-delete path: registry + `runs/<id>/` + engine chat when mapping is certain; **dry-run by default**, pass `--apply` to mutate; never touches Herdr. Prefer `aflt purge` dry-run before `--apply --yes`. `aflt orphans` scans for orphan/stale artifacts (non-destructive); selective purge requires `--purge --ids … [--apply]`. `aflt archive` / `aflt unarchive` soft-hide sessions without deleting logs. If a session is running/waiting (live `runPid` or Herdr working/blocked), `aflt stop` first; `--force` on `rm`/`archive`/`purge` does **not** stop the process. **`aflt rm` / `aflt purge` / `aflt stop` prefer an exact id or title.** On a human TTY, a fuzzy-only query may prompt to confirm/pick; **agents and scripts never get prompts** (non-TTY / `--json` stay exact-only with a did-you-mean hint) — always pass exact ids/titles. Pass multiple `rm`/`purge` targets as separate args.
- **Never print secrets** (tokens, `CURSOR_API_KEY`, MCP auth, `.env`).
- **Keep tests hermetic** if you work in this repo: use a temp `AGENTFLEET_HOME`. Never point tests at the real `~/.agentfleet` or the live Herdr.
- **Resume with the same cwd/workspace** the chat was created in. `aflt cwd` updates the registry folder/branch but does **not** move a live Herdr tab — `aflt resume` (and optionally `aflt adopt`) after.
- **Cursor interactive `aflt wait` cannot see turn-complete** (no OSC 7501). Wait will stay `running` until timeout (exit 2) or the terminal exits. Use `aflt tail` / `aflt result`, or Copilot interactive if you need `waiting`.
- **Copilot folder-trust prompt:** answer with `aflt send <id> "1"`.
- **Do not send `aflt run` through Herdr.** Headless print-mode only.
- **`--mode plan`** is a Cursor headless flag (read-only plan). Do not use it as a substitute for implementation, and do not tell an interactive Cursor agent to enter plan mode.
- After `aflt send` to an interactive worker, `aflt wait` ignores stale Herdr `done`/`idle` for `--send-grace` seconds (default 15, or `AGENTFLEET_SEND_GRACE`).
- Exit **75** = critical registry write failed after a run (result may still be printed; `--json` includes `registryWriteError`).

---

## Commands and flags

Global exit codes: `0` ok · `1` error · `2` wait timeout · `3` waiting · `75` critical registry write after a run.

Supporting commands accept **`--json`** and/or **`--dry-run`** as noted. `--dry-run` must not mutate registry or state.

### Version and help

```bash
aflt --version | -v | version [--json]
aflt help
```

### Create, register, list

```bash
aflt new "<title>" [--cwd DIR] [--prompt "..."] [--model X] [--engine cursor|copilot|opencode]
                   [--project NAME] [--force] [--messaging|--no-messaging] [--tag T]... [--dry-run]
# create-chat / mint UUID → register → interactive launch

aflt add "<title>" --chat <id> [--cwd DIR] [--model X] [--engine cursor|copilot|opencode]
                   [--project NAME] [--tag T]... [--prompt "..."]
# For --engine copilot, --chat is the Copilot session UUID

aflt import [--engine cursor|copilot] [cursor|copilot]
# List local chats to register. Default engine follows AGENTFLEET_ENGINE/config (builtin: cursor).
# Cursor: scan ~/.cursor/chats. Copilot: list ~/.copilot/session-state (or import by id).

aflt import --engine copilot [<id|prefix>...] [--title T] [--tag T]...
            [--cwd DIR] [--limit N] [--json] [--all] [--dry-run]
            [--allow-missing] [-i|--pick]
# --title only with a single id. -i requires a TTY.

aflt ls [--status S] [--tag T] [--project NAME] [--all] [--archived] [--json]
# --json includes effective project + parent on every row
# Archived hidden by default; --archived or --all includes them

aflt timeline [<project>] [--all] [--json] [--since <date>]
# Read-only project session tree (no registry/Herdr writes). Default project =
# AFLT_PROJECT, else cwd project. Chronological roots + indented children; best-effort
# git commits in each session window (location-filtered when project↔repo metadata
# exists; inferred vs confirmed attribution; deduped per project). --since ISO or
# YYYY-MM-DD. Exit 0 when empty.

aflt projects [<id>] [--json]
# Read-only project↔repo mappings + checkout validation (memory
# <project>/.agentfleet.json + config.json repositories). No writes.
# Schema: docs/PROJECT-REPO-METADATA.md

aflt dashboard --serve [--port 8787] [--host 127.0.0.1] [--json] [--capture-completions]
# Live local activity dashboard (read-only by default). Default bind 127.0.0.1:8787.
# History-first UI (tree + activity-only Gantt markers with zoom/pan/presets);
# Graph toggle keeps the star view (zoom/pan/fit + Spread slider). Shared states:
# Working/Waiting/Idle/Completed/Failed. Click a row for prompt/reply history
# (GET /api/history). Blocks until SIGINT/SIGTERM.
# Not the same as aflt memory dashboard.
# --capture-completions opts into redacted Task Complete status notes in memory.
# Interactive turn capture always appends redacted rows to runs/<id>/turns.jsonl
# (Gantt markers); memory notes stay gated by --capture-completions.

aflt dashboard --snapshot <file.svg|html>
# Standalone SVG or self-contained HTML snapshot of the activity UI (no server).

aflt turns backfill [<id|title>...] [--engine copilot|cursor|opencode|all] [--apply] [--json]
# Import interactive Copilot (events.jsonl user↔assistant loops and optional
# session.task_complete) / Cursor (unique transcript) turns into
# runs/<id>/turns.jsonl. Dry-run by default; --apply writes. Idempotent (dedupe);
# also patches existing rows that lack a prompt. Does not write memory
# status-notes. emitTurnCaptured enqueues redacted turns for batched Doc Bot
# notify (flush after a dated note; messaging optional).

aflt memory | aflt memory where [--json]
# Resolved memory repo path + source (env|config), or hint to run init (exit 1).

aflt memory init <path> [--force] [--json]
# Create/register a local project-memory git repo (never remote, never commit).
# Writes README/.gitignore/.aflt-memory.json/DOC-AGENT.md/DOCUMENTATION-PROCESS.md
# when missing; sets config memoryRepo.

aflt memory sync [<project>...] [--all] [--include-adhoc] [--dry-run] [--json] [--no-redact]
 [--active-days N] [--commit] [--push]
# Write <repo>/<project>/_aflt/timeline.md + sessions.jsonl (registry read-only), then
# regenerate root DASHBOARD.md (complete Active/Dormant table for all memory-repo +
# registry projects — a one-project sync does not wipe other rows). Sessions
# (open/idle/total): open=running only; Herdr-exited active → idle. Legacy af→aflt.
# Default: cwd / AFLT_PROJECT. --all skips adhoc unless --include-adhoc or named.
# Human README/dashboard.md/status-notes created only if missing; never overwritten.
# Redaction ON for generated files. --active-days N (ET calendar days; default 14;
# else config.json memoryActiveDays; flag > config > 14). Doc-bot summary block in
# DASHBOARD.md is preserved verbatim when markers exist.
# --commit: stage DASHBOARD.md + */_aflt/** and commit ("memory: sync YYYY-MM-DD");
# refuses if the index already has staged changes; never stages human README /
# per-project dashboard.md / status-notes. --commit --dry-run is an error. --push
# requires --commit; pushes to @{u} when a commit was made or the branch is ahead
# (never force / never add remotes). Nightly: aflt memory sync --all --commit --push.

aflt memory dashboard [--dry-run] [--json] [--no-redact] [--active-days N]
# Regenerate root DASHBOARD.md only (no per-project _aflt/ writes). Same dry-run /
# json / redact / active-days semantics as sync.

aflt memory config [--apply] [--json] [--no-redact] [--active-days N] [--commit] [--push]
# Refresh template-managed memory-repo root files (DOC-AGENT.md,
# DOCUMENTATION-PROCESS.md) against package templates. Dry-run by default
# (up-to-date / would-update / missing + short diff). --apply writes the template
# (keeps *.bak only when the existing file had local edits). Then regenerates
# root DASHBOARD.md like memory dashboard (doc-bot summary block preserved).
# Never touches per-project README / status-notes. --commit requires --apply
# (refuses dirty index; stages DASHBOARD.md + managed roots only); --push
# requires --commit. Never commits unless asked.

aflt memory doc [--engine cursor|copilot|opencode] [--dry-run] [--json] [--force]
# Launch a portable Doc Bot `aflt run` session (title doc-bot) in the memory
# repo using DOC-AGENT.md as the prompt. Works with Cursor CLI or Copilot CLI.
# --dry-run does not create a session or start an engine.

aflt memory status [--json]
# Read-only: repo + git dirty count + per-project folder/lastSync/sessions/stale.

aflt sync [--dry-run] [--json]
# Persist last-known Herdr runtime evidence (does not change status/lastUsed)
```

`aflt timeline` is read-only. Default project: `<project>` arg → `AFLT_PROJECT` → cwd's derived project. Text shows local times (JSON keeps ISO UTC). Commits come from each session's own cwd (`commitsReason`: `not-git` / `missing-cwd`); an open-ended row that is not a live run is bounded at `lastUsed` (`open-ended` when it never ran).

`aflt dashboard` is a separate top-level command from `aflt memory dashboard`. It serves a local activity UI (`--serve`, default `127.0.0.1:8787`) or writes an SVG/HTML snapshot (`--snapshot`). Default view is a collapsible project/session tree with an **activity-only** Gantt timeline (most recent activity first; dormant projects collapsed; state filter: Working / Waiting / Idle / Completed / Failed — same labels and CSS `--state-*` colors as the Graph legend, detail badges, and stats). The timeline shows markers only for finished turns (blue = completed, red = failed) at each turn’s completion time; no working/idle span bars. Time scale is zoomable (buttons + ctrl/⌘-wheel/pinch), pannable (drag), and has quick presets (24h / 7d / 30d / all); overlapping markers stack or group into a count badge that expands on click/hover so every turn stays selectable. Hover a marker for that turn’s prompt + reply (truncated, redacted like `/api/history`); markers appear only on the session that produced them (project rows never roll up child markers). The star graph is optional and defaults to a tighter fit-to-view layout with zoom (buttons + wheel/pinch), drag-to-pan, Fit-to-view, and a Spread slider controlling force-layout link distance / repulsion (`localStorage`). History rows share Graph badges (waiting `?` / working spinner) and click → detail / Esc / SSE / double-click → Herdr focus (same loopback-only `/api/herdr/focus` token flow; remote LAN clients see a Mini-only note) — **no History row hover popups** (Graph node tooltips stay). Selecting a row opens a history panel (latest completion / status note / open doc checkpoints, then prompt↔reply pairs from run logs, newest first). Issue #2 cross-session messages appear in the history panel and as simple row markers (`messages` / per-row `messageMarkers`; queued→waiting, read→idle, completed→completed). Background refreshes never mutate the registry or Herdr; they may append local interactive turns under `runs/<id>/turns.jsonl` (History Gantt). Memory status-note writes require `--capture-completions`. All served text is redacted; write/action endpoints remain loopback-only. It never resumes or launches agents; errors appear in the sidebar. Snapshots cannot focus Herdr. The graph keeps node positions across SSE ticks and cools the force layout until it settles (reheat on node add/remove or resize). Stats Working / Waiting / Idle / Completed / Failed follow the same live filter state as History/Graph (OSC working or live `runPid`, not bare `herdr.runtime` or registry `active`). Project hubs, History project rows, detail badges, and state filters share one roll-up: `waiting > working > failed > idle > completed` from member sessions only. Sessionless memory projects are History-only (bottom **No sessions** group) and never inflate Active project counts or Graph hubs. **Hide dormant** (Graph + History) uses the same 24h threshold as Active projects and re-lays out the Graph on toggle and SSE. **Show archived** reveals soft-archived sessions; Archive/Delete POSTs are loopback + action-token only (same as `/api/herdr/focus`). Timeline preset/view and Graph Spread prefs persist in `localStorage` with Hide dormant / Show archived.

Session activity is separate from lifecycle: green spinning ring = Working,
blue = Completed, orange dashed ring / `?` = Waiting, gray = Idle, red = Failed.
Herdr `done` indicates a completed turn, not an input request. Completion survives a following
idle signal but clears on new work or a new send; send grace suppresses stale
completion. `herdr.runtime` pane-alive with OSC idle/null (typical Cursor) is **Idle** for Working counts — same as Herdr’s Agents panel. Headless workers use live pid. Spinners respect
reduced motion. Registry lifecycle is unchanged.

Long session-node labels use the first nine and last six ID characters
(e.g. `pla-funne...29c501`); the full ID remains in Graph popups and actions. Graph session popups contain
only activity state, session ID, engine, saved lifecycle status, and Herdr
runtime status. Project popups show only the Doc Bot summary. A 450 ms rollout
grace period lets the pointer enter a Graph popup to select/copy text; hovered popup
content and position stay stable across live updates. Empty graph clicks and
Escape immediately dismiss popups, including focused or pending hints.

Native Copilot `session.task_complete` summaries appear in session/project
details (and optionally as memory status notes — see below). History Gantt turns
are separate: live refresh and `aflt turns backfill` record ordinary Copilot
user↔assistant loops from `events.jsonl` even when `session.task_complete` is
absent. `aflt dashboard --serve --capture-completions` opts into writing each
successful Task Complete event to a dated project `status-notes/` file in the
configured memory repo. Existing events are backfilled, then new events are
captured on refresh. `_aflt/task-completions/` holds generated receipts: never
hand-edit them. They prevent duplicates, including after a note is archived.
Capture redacts sensitive values, never overwrites human notes, never changes
registry/Herdr state, and never commits, pushes or automatically runs Doc Bot.
Failures are visible in the dashboard. Default serving and all snapshots stay
read-only; do not use `--capture-completions` with `--snapshot`. Messages require
actual successful native events, not just an idle or completed runtime signal.

`aflt memory doc` creates a `doc-bot` session in project `aflt-memory`.
It also recognizes legacy `memory-doc` sessions to avoid duplicates; use
`aflt rename memory-doc doc-bot` to rename an existing session without changing
its ID or chat history. If both names exist, `doc-bot` takes precedence.

`aflt memory` is opt-in and never auto-syncs. Resolution: `AFLT_MEMORY_REPO` → `config.json` `memoryRepo`. Optional `--commit` / `--push` on `sync` stages root `DASHBOARD.md` and `*/_aflt/**` (human files stay unstaged). Layout: root `DASHBOARD.md` is generated (Active/Dormant; default 14-day ET window via `--active-days` / `memoryActiveDays`; doc-bot summary markers preserved verbatim); `<repo>/<project>/_aflt/` is generated (never hand-edit); `<project>/README.md`, `dashboard.md`, `status-notes/` are human/Doc Bot files that aflt creates only if missing and never commits (never write `DASHBOARD.md` inside a project folder — that name is root-only). Redaction (default on) covers generated files only: home → `~`, private IPs, `*.local`, emails, token-like strings, long hex/base64 (not the preserved doc-bot block). `adhoc` (home/tmp one-offs) is excluded from `--all` unless `--include-adhoc`. Nightly flow on the Mini: `aflt memory sync --all --commit --push` (commits `memory: sync YYYY-MM-DD` only when something changed; exits non-zero if push fails or there is no upstream), then optionally `aflt memory doc` to update the Doc Bot summary in `DASHBOARD.md` (separate commit, only when instructed). `DOC-AGENT.md` in the memory repo is the portable documentarian prompt; `aflt memory init` writes it (and `DOCUMENTATION-PROCESS.md`) when missing; refresh after upgrades with `aflt memory config` / `--apply` (`aflt doctor` hints when outdated). `aflt memory doc --engine copilot` is the same role on a work laptop that has Copilot CLI instead of Cursor.

With a configured memory repo, the live dashboard's **Project status & docs**
selector shows each project's Doc Bot progress/blockers and opens its README,
project dashboard, and ten latest dated live status notes as read-only Markdown
(redacted, max 32 KiB per document). The reader renders Markdown locally with a
source-view toggle; raw HTML is escaped, images are not loaded, and relative
links can open only included documents. Selecting a graph/session node selects its
project's context. Changes appear on the existing live refresh; it does not run
sync or Doc Bot. HTML snapshots embed this reader for offline use; SVG project
tooltips include the summary and document titles. Memory-only projects are
included, and document read errors are surfaced without hiding session activity.

### Headless run and logs

```bash
aflt run "<title>" --prompt "..." [--cwd DIR] [--model X] [--engine cursor|copilot|opencode]
 [--project NAME] [--mode ask|plan] [--force]
 [--output-format text|json] [--timeout SEC]
 [--messaging|--no-messaging] [--no-docs]
 [--dry-run] [--json]
# Create or resume, capture output, exit. --mode is Cursor-only.
# If the session is role=master and exits 0, may trigger aflt docs (skip with --no-docs).

aflt log <title|id> [--path]
```

Timeout on a headless run exits **124**.

### Eval measure + score + improve (milestones E1–E3)

Hermetic self-measurement, deterministic scoring, and an opt-in self-improve loop. Never mutates the real registry or calls live engines from measure/score/gate/plateau.

```bash
aflt eval measure [--json] [--out DIR]
# Writes eval/results/<timestamp>.json (suite + flakes + coverage + CLI smoke + dashboard API).
# Sandbox: throwaway AGENTFLEET_HOME. Coverage via --experimental-test-coverage + NDJSON reporter; unavailable → recorded, measure still ok.

aflt eval score [results-file] [--json] [--history PATH] [--qualitative] [--results-dir DIR]
            [--write-baseline PATH] [--max-rounds N]
# Score latest (or given) measure JSON against eval/RUBRIC.md (0–100).
# Appends one JSON line to eval/history.jsonl (gitignore; override with --history).
# --write-baseline records improve baseline (bare flag → eval/improve-baseline.json).
# --qualitative is opt-in and always skipped when AGENTFLEET_TEST=1 or
# AFLT_EVAL_SKIP_QUALITATIVE=1; default path never spawns engines.

aflt eval report [--json] [--history PATH] [--limit N]
# Human-readable latest score + trend (delta) from history.jsonl.

aflt eval gate [--json] [--base REF] [--paths a,b]
           [--improve] [--baseline PATH] [--results PATH] [--results-dir DIR]
           [--history PATH] [--score N]
# RUBRIC GUARD: exit 1 if protected paths changed vs --base (default HEAD).
# Protected: eval/RUBRIC.md, scripts/eval/score.js, scripts/eval/rubric.js.
# --improve also requires suite green + score >= baseline (self-improve gate).

aflt eval plateau [--json] [--baseline PATH] [--history PATH] [--max-rounds N] [--rounds N]
# stop=true when score plateaued vs previous round/baseline or rounds >= max (default 3).

aflt loop validate examples/loops/self-improve.json
aflt loop run examples/loops/self-improve.json --dry-run
# E3 improve loop: measure → score+baseline → plan-next (one fix) → build → gate --improve.
# Autonomous profile: plannedPhaseGate "none"; allow.commit/merge/push false (document-only
# until a human enables them for onPass commit/merge). Reuses loop.* notify + memory notes.
```

Implementation: `scripts/eval/` (no new npm deps). Generated `eval/results/`, `eval/history.jsonl`, and `eval/improve-baseline.json` are gitignored. Hermetic tests: `test/eval-e1.test.js`, `test/eval-e2.test.js`, `test/eval-e3.test.js`.

### Loop runner (milestones 1–4)

Long-running phases without a bot waking aflt: each phase runs a prompt in a Cursor/Copilot/OpenCode session, then an eval command; on failure the eval output is sent back as a fix prompt (up to `maxFixAttempts`). State is atomic under `$AGENTFLEET_HOME/loops/<name>/state.json`; a runner lock prevents two runners on one loop. Prompts are always argv data (no shell interpolation). `onPass` (`none`|`commit`|`merge`|`push`) only runs when loop-level `allow` flags permit (default all false).

```bash
aflt init <name> [--dir PATH] [--engine E] [--yes] [--existing] [--isolated]   # new looped project
aflt loop init [--engine E] [--build-model M --plan-model M] [--dry-run] [--force] [--isolated] [--json]   # draft .agentfleet/loop.json from SPEC.md/AGENTS.md
aflt loop validate <file.json> [--json]
aflt loop run <file.json> [--dry-run] [--json] [--fresh] [--force] [--allow-existing] [--create-worktree]
aflt loop start <file.json> [--json]   # register active for dashboard scheduler
aflt loop pause <name> [--json]
aflt loop status [name] [--json]
aflt loop stop <name> [--json]
aflt loop resume <name> [--json]       # run in this process from saved state
aflt loop approve <name> [--json]      # release gate: "approve"
aflt making-of <name> [--out file.html] [--serve] [--with-files] [--json]   # review every AI call + commit
```

`--fresh` on `run` starts a new state (0 of N phases) when the loop already completed in this fleethome (without it, completed loops return `loop already completed` and do no work). Prefer `--fresh` over creating a space so the default dashboard Loops view still shows the run.

Definition keys: `name`, `project`, `cwd`, `engine` (optional — omit to follow `AGENTFLEET_ENGINE` / config / cursor), optional ordered failover `engines` (primary precedence: phase `engine` > `engine` > `AGENTFLEET_ENGINE` > `engines[0]` > config > cursor; on `cli_missing`/`auth_required`/`usage_limit`/`rate_limit`/`model_unavailable` a phase reruns the same attempt on the next installed engine with session `<session>-<engine>`, never on an eval failure; notify/history `loop.engine.failover`), `allow`, `budget` (`maxRuns` / `maxHours` / `maxPhases`), optional `goal` / `acceptance` (or `acceptanceCriteria`) / `acceptanceEval` / `plannedPhaseGate` (`approve`|`none`, default `approve` for phases appended by plan-next), `phases[]` (`id`, optional `type: "run"|"plan-next"|"script"` (`script`: `eval.command` is the whole step — no AI call, prompt, session or fix attempts; not counted in `maxRuns`), `engine`, `session`, `model`, `prompt`|`promptFile`, `eval.command` string|argv, `eval.passRegex` / `eval.exitCode`, `maxFixAttempts`, `onPass`, optional `force` boolean default **false**, optional `gate: "approve"`). Loop-level `model` and `force` apply when a phase omits them. Resolved model: phase → definition → `COPILOT_MODEL` (Copilot only) → `config.json` `defaultModel` (alias `model`). `loop run` refuses a cwd that is not a clean empty git repo, or that contains the aflt checkout or the definition, unless `--allow-existing`. `--dry-run` prints cwd, permission mode, and model. A non-zero agent exit or timeout fails or retries the phase even when the eval is already green. `workdir: { mode: "worktree", base?, path?, branch? }` (default `"fresh"` = the strict guard above) accepts a clean non-empty git worktree that is not the running aflt package root or inside it; `aflt loop run --create-worktree` runs `git worktree add -b <branch> <path> <base>` for a missing `workdir.path` (never implicit; `--dry-run` only reports it) and `--dry-run` prints the `workdir:` inspection. Optional `protected: { paths: [globs], source?: "base" }` (loop-level, plus per-phase `protected.paths` additions) fails a phase outright — no fix attempts, history `loop.phase.protected_violation`, notify `protectedViolation: [paths]` — when the worker's diff against the phase's base commit (committed, staged, unstaged, untracked) matches a glob (`*`, `**`, `?`, exact paths or directory prefixes, relative to the loop cwd); needs a git cwd. Optional loop-level `commitGate: { mode: "off"|"observe"|"enforce", trailer?: "Verified-by", requireTiers?: [...] }` (default off = unchanged) stamps `onPass: "commit"`/`"merge"` commits with `Verified-by: <eval summary, e.g. npm test 681/681 (1 skipped)>; <tier summaries>` (or `none`) and `Aflt-Loop: <loop> phase <id> attempt <n>, engine <e>[, model <m>]` trailers from `phaseState.verification[]` (`recordVerification(phaseState, { tier, ok, summary })`; the phase eval is recorded as tier `eval`). `observe` warns (history `loop.commit_gate.warning` + stderr) on a missing required tier or a tree still dirty after the commit but still commits; `enforce` refuses (phase fails, no fix attempt, history `loop.commit_gate.refused`) unless every `requireTiers` entry is recorded ok and the tree is clean afterward. Relative `promptFile` (and companion eval scripts like `improve-gate.js` / `seed-m0.js`) resolve against the definition file’s directory first, then the loop cwd. Examples: `examples/loops/hello-eval.json`, `examples/loops/plan-next.json`, `examples/loops/self-improve.json`, `examples/loops/hello-aflt/`, `examples/loops/hello-aflt-scratch/`. UI-saved definitions: `$AGENTFLEET_HOME/loops/definitions/<name>.json` (override with `config.json` `loop.definitionsDir` / `loop.dir` / `loopsDir`).

**hello-aflt quick start (Copilot work Mac):** one command from an empty git repo — no Grok Bot, no `AGENTFLEET_CURSOR_BIN`, no engine pin, no `/tmp` paths. `aflt loop` orchestrates; Copilot/Cursor are workers only:

```bash
mkdir tile-dungeon && cd tile-dungeon && git init
export AGENTFLEET_ENGINE=copilot   # once; or: aflt engine copilot
# optional: export COPILOT_MODEL=auto  # when the account default model is unavailable
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json
```

That run seeds portable M0 when the tree is empty (`m0-seed/` + `seed-m0.js`, a `type: "script"` phase with no AI call), then M1–M4, M5a, and up to 3 plan-next improve rounds. To continue improve-only on a repo that already has M5a (distinct loop name `hello-aflt-improve`; the existing game repo is not empty, so pass `--allow-existing`):

```bash
cd /path/to/existing-game
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt-improve.json --allow-existing
```

To run that completed improve definition again in the same fleethome (fair second attempt; prefer over a new space):

```bash
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt-improve.json --fresh --allow-existing
```

Docs-only seed variant (an agent writes M0 from `SPEC.md`; no code or HTML is copied in): copy `examples/loops/hello-aflt-scratch/seed/.` into an empty folder, `git init`, commit, then `aflt loop run .agentfleet/loop.json` (the loop, prompts and check scripts live in the project's `.agentfleet/`). Review any run with `aflt making-of <loop>` (same space). CLI walkthrough: [`docs/cli-quickstart-loops.md`](docs/cli-quickstart-loops.md).

Details: [`examples/loops/hello-aflt/README.md`](examples/loops/hello-aflt/README.md). Work-Mac Copilot live-test guide (validate → dry-run → `--fresh` live run, dashboard success signals, results template): [`docs/copilot-live-test.md`](docs/copilot-live-test.md).

**Plan-next (M4):** a phase with `type: "plan-next"` builds a planner prompt (goal, acceptance, recent history, status notes) and requires the engine to write JSON to `$AGENTFLEET_HOME/loops/<name>/plan-next.json`. `{ "done": true }` completes planning (loop finishes after remaining phases / optional `acceptanceEval`); `{ "phases": [ … ] }` validates and inserts phases **before** the plan-next sentinel (then continues, returning to plan-next later). Newly planned phases get `gate: "approve"` unless they set `gate` or the loop sets `plannedPhaseGate: "none"`. Cap growth with `budget.maxPhases`. When `goal` / `acceptance` are set, completion writes an acceptance-summary status note to memory.

**Unattended (M2):** `aflt loop start` sets `active: true` without running phases. `aflt dashboard --serve` hosts an in-process scheduler that picks up active loops (one runner per name; lock respected), resumes `running` loops with a dead lock on server start, and re-queues after a runner crash. Dashboard API: `GET /api/loops`, `GET /api/loops/:name`, `POST /api/loops/:name/{pause,resume,stop}` (loopback + action token, same as archive/focus). CLI `pause` / API pause yield between steps (`status=paused`); API resume re-activates for the scheduler; CLI `resume` still runs in-process.

**Dashboard UI (M3):** Loops view (with History / Graph) lists loops with live status via the existing SSE refresh; phase + step pipeline; eval output tails; links into History for the phase session; **Making of** button (`GET /making-of/<name>`, raw diffs at `/making-of/<name>/commit/<sha>`); start from a path under the allowed loops dirs; define/edit form (server validates with `validateDefinition`, writes only under the definitions dir — no arbitrary path writes). Approval checkpoints: phase `gate: "approve"` sets `status=waiting` and emits `loop.gate.waiting`; `POST /api/loops/:name/approve` / `aflt loop approve` releases it (`loop.gate.approved`). Also: `POST /api/loops` (save), `GET /api/loops/definitions`, `POST /api/loops/start`, `GET|POST /api/loops/:name/definition`.

**Service:** `aflt service install|uninstall|status [--port N] [--host H] [--print] [--json]` — macOS LaunchAgent `~/Library/LaunchAgents/dev.aflt.dashboard.plist` runs `aflt dashboard --serve` with KeepAlive; logs under `$AGENTFLEET_HOME/logs`. Named space uses `dev.aflt.dashboard.<space>.plist` (never overwrites the default). Default `--port` from space `config.json` when set. `--print` shows the plist without writing. Non-macOS prints a clear unsupported message (exit 1). Never call real `launchctl` from tests (inject a fake).

**Named spaces:** global `--space NAME` (any position) or `AFLT_SPACE`; flag wins. When selected and `AGENTFLEET_HOME` is unset → `$HOME/.agentfleet/spaces/NAME`. Explicit `AGENTFLEET_HOME` wins for the directory. `aflt space list|ls|create|current|remove` (`ls` is an alias; `--json` on each; `remove` refuses non-empty without `--force`; never removes the default home). New spaces: next free dashboard port (8788+), notify off, isolated `memoryRepo`, recorded LaunchAgent label.

Opt-in notify events (same `notify` / `AFLT_NOTIFY_*` config): `loop.started`, `loop.phase.started`, `loop.phase.passed`, `loop.phase.failed`, `loop.completed`, `loop.failed`, `loop.stopped`, `loop.gate.waiting`, `loop.gate.approved`, `loop.engine.failover`, and opt-in `loop.heartbeat` — payload fields: `event`, `sessionId`, `title`, `project`, `engine`, `cwd` (redacted), `exitStatus`, `timestamp`, `summary` (redacted), `loop`, `phaseId`, `attempt`. Heartbeat interval: `config.json` `loop.heartbeatSeconds` (or `notify.loopHeartbeatSeconds`) / `AFLT_LOOP_HEARTBEAT_SECONDS` (default off / 0). To wake a Grok Bot on loop progress, point `notify.url` / `AFLT_NOTIFY_URL` at that bot’s webhook/routine ingest URL (optional `notify.key` / `AFLT_NOTIFY_KEY`); the loop never needs the bot to continue. Memory: appends `<project>/_aflt/loop-timeline.jsonl` and writes a status note per phase result when `memoryRepo` is configured; no-op otherwise.

### Master / worker orchestration

```bash
aflt master --goal TEXT [--engine cursor|copilot|opencode] [--cwd DIR] [--title T] [--model X]
            [--project NAME] [--worker-engine copilot|cursor|opencode] [--headless] [--timeout SEC]
            [--force] [--messaging|--no-messaging] [--no-docs]
            [--dry-run] [--json]
# Initial prompt is templates/orchestrator.md. Default: interactive via Herdr.
# --headless uses aflt run machinery (workerStatus tracked).
# Successful headless exit may run aflt docs if the project has {"docs": true}.

aflt spawn --parent <id|title> --prompt TEXT [--engine cursor|copilot|opencode] [--cwd DIR]
           [--project NAME] [--title T] [--task TEXT] [--model X] [--timeout SEC]
           [--force] [--interactive] [--detach]
           [--messaging|--no-messaging] [--dry-run] [--json]
# Headless by default. --interactive launches via Herdr.
# --detach (headless only): return immediately; a supervisor records exit/handoff.
# Messaging-enabled masters pass messaging:true to workers unless --no-messaging.
# Workers inherit the master's project unless --project is set.

aflt children [<id|title>] [--json] [--all]
# No arg: resolve master from AGENTFLEET_ID / AGENTFLEET_PARENT, or summarize all masters.
# --all includes lifecycle-done masters in the summary.

aflt wait [<id|title>...] [--parent <master>] [--any] [--timeout SEC] [--interval SEC]
          [--send-grace SEC] [--docs] [--json]
# Block until listed workers reach done|failed|stopped|waiting.
# Explicit ids/titles win over --parent. No ids: --parent children, else
# children of AGENTFLEET_ID (master) or AGENTFLEET_PARENT.
# --docs: after exit 0, run aflt docs once for the master's project (errors if no master).

aflt result <id|title> [--path] [--json] [--require-fresh]
# Print the worker handoff file. If missing: stderr note + last ~40 lines of the run log; exit 1.
# --require-fresh exits 1 if the file is stale (mtime not after runStartedAt / resultMtimeAtStart).

aflt tail <id|title> [-n N] [-f]
# Last N lines of the run log (or hc read for live Herdr). -f follows until the worker leaves running.

aflt send <id|title> "text" [--timeout SEC] [--force] [--json]
# Interactive: hc send (records lastSendAt; workerStatus=running).
# Headless (not running): continue the same chat with a short handoff reminder.
# Refuses if a headless runPid is still live.

aflt stop <id|title> | aflt stop --all-children <master> [--json]
# SIGTERM process group / hc interrupt+kill.
# Exact id/title preferred. TTY + fuzzy candidates → confirm/pick; agents use exact ids.
```

`workerStatus`: `queued` | `running` | `waiting` | `done` | `failed` | `stopped`.

`aflt wait` exit precedence: timeout → failed/stopped → waiting → ok.

HANDOFF column on listings: `yes` / `af` (af-fallback from stdout) / `stale` / `no`.

### Resume, adopt, cwd

```bash
aflt resume <title|id> [--via herdr|plain] [--here] [--open|--no-open]
                       [--prompt "..."] [--force] [--dry-run] [--no-herdr-app]
# Default: Herdr when hc is on PATH (prints Attach: hc attach <name>).
# Shell-only live tab (agent stopped after reboot/--keep): relaunches into that tab
# via hc send (no new terminal). --here / --via plain: this terminal.
# --open: new iTerm2 tab running hc attach (default in an iTerm TTY; --no-open disables).
# --force: Copilot --allow-all-tools only (Cursor unchanged).
# --no-herdr-app: skip herdr.space / herdr.tab labels.

aflt resume | aflt resume -i | aflt pick     # TTY multi-select; resume via Herdr

aflt resume --all [--tag T] [--via tmux|iterm2|wezterm|herdr|plain]
                  [--open|--no-open] [--force] [--dry-run] [--no-herdr-app]

aflt adopt <title|id ...> | aflt adopt --all [--dry-run] [--json]
# Move live af Herdr panes into session-group spaces (park→label→keep when needed),
# then rename space (group title) and tab (session title). App must be open to move panes.

aflt cwd <title|id> [path] [--dry-run] [--json]
aflt set-cwd <title|id> [path] [--dry-run] [--json]   # alias
# Show or change a session's folder. Path must exist; refreshes branch.
```

### Remove and metadata

```bash
aflt archive <title|id> [--with-children] [--force] [--dry-run] [--json]
aflt unarchive <title|id> [--with-children] [--dry-run] [--json]
# Soft-hide / restore (archived + archivedAt). Status and runs/ logs unchanged.
# --with-children includes descendants. Refuses running/waiting unless --force.

aflt rm <title|id> [<title|id>...] [--keep-files] [--force] [--dry-run]
# Exact id/title preferred; TTY may confirm/pick fuzzy matches (agents: use exact ids).
# Multiple ids: resolve all first; cancel/fail before removing any. Removes the session
# and af-owned files under $AGENTFLEET_HOME (results/, plans/). Never deletes runs/<id>/.
# Clears parent on remaining children. --keep-files: registry row only (keeps handoffs/logs).
# Refuses if running/waiting unless --force (does not stop the process).

aflt rm --children <master> [--with-master] [--keep-files] [--force] [--dry-run]
# Master resolution matches rm/stop (TTY picker when no exact match). --with-master
# also removes the master.

aflt rm --purge <title|id>…           # synonym for aflt purge
aflt purge <title|id>... [--with-children] [--apply] [--force] [--yes] [--json]
           [--no-engine|--aflt-only] [--engine-only] [--no-transcripts]
# Full delete: registry + runs/<id>/ + results/plans + master messages log +
# engine Copilot/Cursor chat dir when mapping is certain. Dry-run by default;
# --apply mutates. Never touches Herdr. Refuses busy unless --force.
# --yes skips typed confirm (required for non-TTY / agent apply).

aflt orphans [--days N] [--engine cursor|copilot|opencode|all] [--category C]... [--json]
           [--allow-uncertain-engine] [--include-interactive]
aflt orphans --purge --ids id,… [--apply] [--yes] [--force] [--json]
           [--days N] [--allow-uncertain-engine]
# Scan orphan/stale artifacts (default non-destructive). --purge requires --ids
# selection; never auto-kills herdr-orphan-pane. Dry-run unless --apply.

aflt rename <title|id> "<new title>"
aflt note <title|id> "<text>"
aflt done <title|id>                  # set lifecycle status to done
aflt export [file]                    # registry JSON (default: stdout)
aflt import-file <file>               # merge sessions from a backup
```

### Engine default

New-session precedence: **`--engine` → `AGENTFLEET_ENGINE` → `~/.agentfleet/config.json` `defaultEngine` → builtin `cursor`**. Existing sessions always keep their recorded `engine`.

```bash
aflt engine                 # print default + source
aflt engine cursor|copilot|opencode  # persist defaultEngine
aflt cursor | aflt copilot | aflt opencode  # aliases
```

### Messaging (opt-in)

Off by default. Enable with `aflt msg enable <session>`, `--messaging` on `new`/`run`/`master`/`spawn`, or project `.agentfleet.json` `{"messaging": true}` (ancestor walk to the git root). Session `messaging: false` overrides the project. Messaging-enabled masters pass `messaging: true` to workers unless `--no-messaging`. **Both sender and recipient must be opted in** (explicit `messaging: false` always wins). Team aliases (`master` / `all-siblings`) stay team-scoped; direct targets use **exact id or unique exact title** (ambiguous rejected) and may be cross-session DMs. Messages are durable context only — never wake agents, inject prompts, change lifecycle/role/parent/project, or grant permissions. Status: `queued` → `read` → `completed`. Library: `messages.sendDirectMessage(from, to, body, meta)` (turn-capture → Doc Bot via `emitTurnCaptured`, and `notifyDocBot`).

```bash
aflt msg <to> <text...> [--type T] [--reply <msgId>] [--from S] [--json] [--dry-run]
# <to> = exact id | unique exact title | master | all-siblings
# With --reply and no <to>, defaults to= the reply sender.
# Types: question | answer | note (default) | blocked

aflt msg enable|disable <session> [--json] [--dry-run]

aflt inbox [<session>] [--unread] [--status queued|read|completed]
           [--mark-read|--mark-complete] [--json]
# Default session: AGENTFLEET_SESSION / AGENTFLEET_ID

aflt thread <msgId|master> [--json]
```

Limits: `AGENTFLEET_MSG_MAX_THREAD` (default 6), `AGENTFLEET_MSG_RATE` (default 10 per 60s).

From a non-af shell you must pass `--from <session>`. Inside an af-launched session, identity comes from `AGENTFLEET_SESSION` / `AGENTFLEET_ID`.

**Doc Bot inbox:** enable messaging on `doc-bot` (or legacy `memory-doc`); poll `aflt inbox` / MCP `read_inbox` when idle; mark handled with `--mark-complete`. Checkpoints and turns enqueue under `doc-bot-pending.json` and flush as one batched message **after** a dated note is written (`aflt docs notify flush`); ack with `aflt docs notify ack`. Messaging optional (context only; never interrupts busy agents).

### MCP server

```bash
aflt mcp
# Stdio MCP server. Tools (post_message, read_inbox, list_team) are advertised
# only when messaging is enabled for the inherited identity. Server name: af.
# post_message: exact id/title or master/all-siblings. read_inbox: status
# queued|read|completed; optional mark_complete.

aflt mcp install --engine copilot|cursor [--write] [--project] [--cwd DIR]
                 [--dry-run] [--json]
# Print or merge MCP config (backs up first).
# Copilot + --write → ~/.copilot/mcp-config.json
# Cursor + --write → ~/.cursor/mcp.json (user)
# Cursor + --project → <cwd>/.cursor/mcp.json  (preferred)
```

Typical agent/project setup:

```bash
aflt mcp install --engine copilot                 # preview
aflt mcp install --engine copilot --write         # merge user Copilot config
aflt mcp install --engine cursor --project --cwd "$PWD"
```

Cursor install writes `"${env:AGENTFLEET_SESSION}"` (and related) so `cursor-agent` forwards identity into the MCP child (Cursor does not inherit process env into MCP servers). Messaging-enabled Copilot runs get `--additional-mcp-config` + `--allow-tool=af` per launch (no `~/.copilot` write on launch). Cursor launches get `--approve-mcps` when an `af` server is present in project/user `mcp.json`. If an older Cursor `af` entry lacks the `${env:…}` mapping, re-run install (`aflt doctor` flags `mcp_cursor`).

### Documentarian (opt-in)

Off by default. Enable with `.agentfleet.json` `{"docs": true}`.

```bash
aflt docs [<project dir>] [--since <commit>] [--engine cursor|copilot|opencode] [--model X]
          [--force|--no-force] [--anyway] [--dry-run] [--json]
aflt docs --status [--json] [--all] [<dir>...]
```

- One headless worker (`role=docs`, title `docs-<folder>`, reused). Template: `templates/documentarian.md`.
- Force/write is **on by default** (Cursor `--force` / Copilot `--allow-all-tools`); opt out with `--no-force` or `{"docsForce": false}`.
- `--anyway` runs once without enabling docs in config.
- Updates **only** configured docs paths. Warns on non-doc edits (including a new `CHANGELOG.md` when not allowed); does not revert.
- Optional `.agentfleet.json` `docsInstructions`: file path(s) (string or array; `~` / repo-relative / absolute) injected into the prompt as project-specific instructions; edit restriction still applies. Missing/unreadable files warn + skip; size caps apply. Dry-run/`--json` report used and skipped files.
- Prompt may include a compact **Session timeline since last docs run** (same builder as `aflt timeline`, cap ~8KB with `[truncated]` marker). Dry-run/`--json` report `timelineBytes` (0 when skipped).
- **`aflt docs --status`:** read-only status (no engine, no registry/state writes). Default cwd; `--all` adds distinct registry project dirs. Reports `needsDocs` (`docsEnabled && (no lastRun || commitsSince>0 || unknown lastCommit)`); also `skip` / `skipReason` / `skipFiles` and `ready`; when `agentDocs` is enabled, includes checkpoint missing/overdue (age is status only, not progress). **Doc Bot rule:** skip repos with uncommitted docs edits — any dirty `docsPaths` file (`.DS_Store` ignored) sets `skip: true`, `skipReason: "dirty-docs"`; `needsDocs` is unchanged. Only run `aflt docs` on projects where `ready` (`needsDocs && !skip`) is true. `aflt docs` itself does not check this. Exit 0 even when `needsDocs` is true.
- Auto-runs once after a successful headless master (`aflt master --headless` or `aflt run` on `role=master`) when docs are enabled; skip with `--no-docs`. Docs failure → WARNING + JSON `docs:{ok:false}` but the master exit stays 0. `aflt wait --docs` is the same after wait exit 0, and **errors** if no master can be resolved. Guard: `docsTriggeredRunId` (once per master run).

### Agent documentation + checkpoints (opt-in, issue #3)

Off by default. Enable with `.agentfleet.json` `{"agentDocs": true}` (optional `docCheckpointHours`, default 4). Fleet knobs in `config.json` `"agentDocs"`: `boundaries` (default `turn-complete`, `run-exit`), `requireNote` (default true), `retryMax` / `retryBackoffMinutes`, `batchNotify`.

```bash
aflt docs checkpoint request|complete [<dir>] [--project NAME] [--reason T] [--note PATH] [--json]
aflt docs notify flush|ack|status|retry [--project NAME] [--id ID] [--json]
aflt docs --status --json
```

- Templates: `templates/DOCUMENTATION-PROCESS.md` (shared; also copied by `aflt memory init` when missing) and `templates/AGENT-DOCS.md` (copy into the project root).
- On launch/resume (`new` / `resume` / `run` / Herdr backends) for **Cursor and Copilot**: when enabled, sets `AFLT_PROJECT`, `AFLT_MEMORY_REPO`, `AFLT_DOCS_PROCESS`, `AFLT_AGENT_DOCS`, `AFLT_AGENTS_MD` and may prepend a short preamble. Existing `AGENTS.md` instructions are preserved (pointed at, not replaced). Works with no memory repo; missing required memory is reported (`AFLT_MEMORY_MISSING=1` + WARNING).
- Checkpoints live under `$AGENTFLEET_HOME/doc-checkpoints/`. **Cadence:** request only at safe boundaries (turn complete / run exit); never while busy; elapsed time alone is not a request trigger. Progress is **requested → completed** only; overdue/retry use age for labels only. **Ack:** `complete` requires a dated live note under memory `status-notes/` (not `archive/`). **Retry:** bounded backoff via `processCheckpointRetries` / `aflt docs notify retry`. Dashboard / docs status / `aflt doctor` expose checkpoint + `docBotQueue` state.
- Archive convention: live status notes ignore `status-notes/archive/`; reporting may label archived counts; **aflt never auto-moves or deletes documents**.
- **Batched Doc Bot:** pending items in `doc-bot-pending.json`; notes written before notify; one message per batch; ack after Doc Bot reports notes written. Messaging optional (context, not permissions). Do not reimplement Copilot completion capture (`aflt dashboard --capture-completions` / `lib/task-completions.js`) — that is a separate opt-in note writer. Interactive Gantt history uses `lib/turns.js` → `runs/<id>/turns.jsonl` (always local): Copilot pairs `user.message` with the final `assistant.message` of each completed agent loop (and merges `session.task_complete` when present, always attaching the most recent preceding user prompt; mid-turn steering joins onto the open loop; backfill patches rows missing a prompt); Cursor uses a unique transcript when mapped. `turns.emitTurnCaptured` enqueues turns for the batch path (never wakes agents). History Gantt markers stay on the producing session row only (project rows do not roll up children).

### Doctor and Herdr helpers

```bash
aflt setup [--apply] [--json] [--herdr] [--memory <path>] [--force]
# Machine setup preview (default) or apply; never edits shell rc / sessions
aflt doctor [--json]                 # read-only environment checks (notify + DOC-AGENT + agent_docs; never prints key)
aflt doctor --strict [--notify] [--port N] [--loop <file>] [--json]
# Preflight: engine CLIs on PATH (+ ~/.local/bin hint), sign-in probe (cursor: `cursor-agent status`;
# copilot/opencode: "unknown (no probe)" warning), notify config (--notify = live round trip),
# free-port test-bind (--port N; default 8787 only reported), --loop inspects the workdir + engine CLIs.
# Checks carry status ok|warn|fail; exit 1 only when a check fails.
aflt notify test [--json]            # sample notify webhook POST (requires url config/env)
aflt which-backend                   # auto-detected resume --all backend
aflt herdr-templates [--force] [--dry-run]
# Install only Cursor/Copilot/OpenCode Herdr templates into ~/.config/herdr-core/templates
# (DOC-AGENT.md, documentarian.md, orchestrator.md stay in the package for aflt)

aflt herdr-app install [--copy] [--force] [--dry-run]
# Symlink (default) or copy the af-sessions panel + af layout into
# ~/.config/herdr-app (or $HERDR_APP_HOME)

aflt herdr-app status
```

---

## Engines, permissions, and handoffs

| | Cursor | Copilot | OpenCode |
|---|--------|---------|----------|
| Binary | `cursor-agent` / `agent` (`AGENTFLEET_CURSOR_BIN`) | `copilot` (`AGENTFLEET_COPILOT_BIN`) | `opencode` (`AGENTFLEET_OPENCODE_BIN`) |
| Session id | `create-chat` UUID; resume `--resume` | Local UUID; `--session-id=` (create-or-resume; do **not** use `--resume=` for a fresh id) | `ses_*` via short-lived `opencode serve` + `POST /session`; resume `--session` |
| Workspace | `--workspace` / `--trust` (default on; `--no-trust` keeps the dialog) | `-C <cwd>` | spawn `cwd` (OpenCode project directory) |
| Headless | `-p`, `--output-format`, `--mode ask\|plan`, `--force` | `-p`, `--output-format`; `--force` → `--allow-all-tools` | `opencode run [--format json] [--session]`; `--force` currently a no-op (no stable permission-grant flag) |
| Interactive `--force` | Unchanged for Cursor on `new`/`resume` | `--allow-all-tools` | Currently a no-op (same as Cursor interactive) |
| Import / turns | Scan `~/.cursor/chats/` + agent transcripts | `~/.copilot/session-state/` events.jsonl | Read-only `~/.local/share/opencode/opencode.db` (`AGENTFLEET_OPENCODE_HOME`) |
| Completion signal (interactive) | No OSC 7501 — `aflt wait` cannot detect turn-complete while the engine is live | OSC 7501 via Herdr (`idle` / `working` / `done` / `blocked` / `error`) | Same as Cursor interactive (no OSC assumed); Herdr template still available |

OpenCode Herdr template remains installable via `aflt herdr-templates` (`opencode.md`).

**Handoffs:** workers should write `$AGENTFLEET_RESULT` (default `$AGENTFLEET_HOME/results/<id>.md`) with Summary, Files changed, and Open questions. After a successful **headless** run, if the file is missing or stale, `aflt` may write an **af-fallback** from stdout. There is no automatic fallback for interactive runs. Freshness: the file is fresh iff it exists and `mtime` is after `runStartedAt` or `resultMtimeAtStart`. `aflt result --require-fresh` exits 1 if stale.

**Copilot write grant without `--force`:** `aflt` passes `--add-dir` for results/plans and pre-approves the handoff/plan via `--allow-tool=write(…)`. New folders may still show a trust prompt — `aflt send <id> "1"`.

**Cursor `--force`:** allows tool/command approval. Workspace trust is `--trust` (passed by default). Without `--force`, Cursor may not write the handoff; `aflt` will fall back from final stdout on headless success.

Cost hint from the orchestrator template: Copilot for routine/mechanical work; Cursor for hard or multi-file reasoning. Max 2 retries per task on failure, with a better prompt.

Engine × mode details (liveness, `aflt wait` outcomes, shell-only tabs): [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

---

## Registry and configuration

Home: **`$AGENTFLEET_HOME`** (default `~/.agentfleet`). Override the registry file with **`AGENTFLEET_REGISTRY`**.

| Path | Role |
|------|------|
| `sessions.json` | Atomic registry (temp + rename; cross-process `.lock` for RMW). Mode `0600`. |
| `config.json` | Fleet defaults (`defaultEngine`, optional `memoryRepo`, `project`, `notify`, `repositories` checkout map) |
| `runs/<id>/` | Captured headless stdout + interactive `turns.jsonl` / `turns-index.json` |
| `results/` | Worker/master handoffs (`$AGENTFLEET_RESULT`) |
| `plans/` | Master plans (`$AGENTFLEET_PLAN`) |
| `messages/<masterId>.jsonl` | Team message log |
| `messages/dm__<idA>__<idB>.jsonl` | Cross-session direct-message log (sorted ids) |
| `docs/<hash>.json` | Documentarian since-tracking (`lastCommit`) |
| `doc-checkpoints/<project>.json` | Opt-in agentDocs checkpoint request/complete state |
| `doc-bot-pending.json` | Batched Doc Bot pending items + batch ack records |
| `loops/<name>/` | `aflt loop` state (`state.json`) + `runner.lock` (+ definition snapshot) |

Each session stores identity (`id`, `title`, `chatId`, `cwd`, `branch`, `model`, `engine`), optional `project`, lifecycle `status` (`active` | `paused` | `done`), `tags` / `notes` / `prompt`, optional `herdr` evidence from `aflt sync`, and orchestration fields (`parent`, `role`, `task`, `result`, `workerStatus`, run pid metadata, `messaging`, …).

**Project name (`session.project`):** optional string for grouping. **Projects never require git** — one-off agents in `/tmp` or `$HOME` can share a name. Legacy alias map (`lib/project.js` `PROJECT_ALIASES` / `canonicalProjectName`): `af` → `aflt` for grouping, live dashboard hubs, and memory sync/dashboard folders (registry `project` is not rewritten; existing `af/` memory folders are left alone).

**New sessions** store the resolved name (`--project` on `new`/`add`/`run`/`master`/`spawn`/import). Precedence: `--project` → parent/master project → `AFLT_PROJECT` → source `.agentfleet.json` `"project"` / `"projectId"` → `$AGENTFLEET_HOME/config.json` `"project"` → **unambiguous** project↔repo mapping inference (memory `<project>/.agentfleet.json` + local `config.repositories`; skip when ambiguous or no memory repo) → git-root basename → cwd basename, except `$HOME` / `os.tmpdir()` (+ realpath) / `/tmp` / `/private/tmp` → `"adhoc"`. Workers inherit the master's project (unless `--project` overrides); docs sessions inherit when triggered from a master (and set `parent` when that path runs). Assigned identity stays separate from cwd; unavailable checkouts are reported (`aflt projects`), not invented.

**Existing rows** without `project`: derive at read time with cwd-based rules only (source `.agentfleet.json` → unambiguous mapping inference → git basename → cwd basename/`adhoc`) — never env/global config, and **never rewrite** the registry to backfill. Helper: `lib/project.js` + `lib/project-meta.js` (git-root lookups cached per command; missing cwd must not throw). Schema: [docs/PROJECT-REPO-METADATA.md](docs/PROJECT-REPO-METADATA.md).

### Project: source `.agentfleet.json`

Resolved by walking cwd → ancestors until the git root (or filesystem root). Optional launch default only — references the project id, does not store checkout paths.

```json
{
 "project": "my-app",
 "messaging": true,
 "docs": true,
 "docsPaths": ["README.md", "docs/"],
 "docsInstructions": ["docs/DOCS_STYLE.md"],
 "docsEngine": "cursor",
 "docsForce": false,
 "agentDocs": true,
 "docCheckpointHours": 4
}
```

| Key | Meaning |
|-----|---------|
| `project` / `projectId` | optional create-time default project id (stored on new rows when `--project` is omitted); `projectId` synonym |
| `messaging` | `true` to opt in for sessions in this project (session `messaging: false` wins) |
| `docs` | `true` to enable the documentarian |
| `docsPaths` | default `README.md` + `docs/` (+ `CHANGELOG.md` only if it already exists) |
| `docsInstructions` | optional file path(s) injected into the documentarian prompt (`~` / repo-relative / absolute; still only edit `docsPaths`) |
| `docsEngine` | `cursor` \| `copilot` |
| `docsForce` | `false` to opt out of the default write grant |
| `agentDocs` | `true` to deliver docs-process / AGENT-DOCS paths on launch and track checkpoints |
| `docCheckpointHours` | overdue threshold hours for status/dashboard only (default 4; not a progress metric) |

### Memory project metadata: `<memoryRepo>/<project>/.agentfleet.json`

Portable mappings (many-to-many projects↔repos). Template: `templates/project-agentfleet.example.json`.

```json
{
  "id": "my-app",
  "name": "My App",
  "repositories": [
    { "remote": "github.com/example/my-app", "locations": ["."] },
    { "remote": "github.com/example/monorepo", "locations": ["packages/my-app"] }
  ],
  "relationships": [{ "type": "related", "project": "my-app-docs" }]
}
```

### Fleet: `~/.agentfleet/config.json`

```json
{
  "defaultEngine": "cursor",
  "project": "ops",
  "memoryRepo": "/path/to/aflt-memory",
  "memoryActiveDays": 14,
  "agentDocs": {
    "boundaries": ["turn-complete", "run-exit"],
    "requireNote": true,
    "retryMax": 3,
    "retryBackoffMinutes": [30, 120, 360],
    "batchNotify": true
  },
  "notify": {
    "url": "https://hooks.example.com/aflt",
    "key": "optional-secret",
    "header": "Authorization"
  },
  "repositories": {
    "github.com/example/my-app": { "path": "~/github/example/my-app" }
  }
}
```

Optional `"project"` is a create-time default when `--project` / `AFLT_PROJECT` / source `.agentfleet.json` are unset (useful for non-repo agent groups). Optional `"memoryRepo"` comes from `aflt memory init` (override with `AFLT_MEMORY_REPO`). Optional `"memoryActiveDays"` sets the Active/Dormant threshold for root `DASHBOARD.md` (positive integer; overridden by `--active-days`; default 14). Optional `"repositories"` maps normalized remotes → machine-local checkout paths (not portable; inspect with `aflt projects`). Optional `"agentDocs"` configures checkpoint cadence / note ack / retry / Doc Bot batching for projects that opt in via `.agentfleet.json` `{"agentDocs": true}` (`aflt doctor` reports the resolved knobs + pending queue).

Optional `"notify"` (or `AFLT_NOTIFY_URL` / `AFLT_NOTIFY_KEY` / `AFLT_NOTIFY_HEADER`) enables fire-and-forget webhook POSTs on headless run completion/failure (`run.completed` / `run.failed`), interactive turn capture (`turn.captured` via `emitTurnCaptured`), and `aflt loop` lifecycle (`loop.started` / `loop.phase.*` / `loop.completed` / `loop.failed` / `loop.stopped` / `loop.gate.waiting` / `loop.gate.approved` / opt-in `loop.heartbeat`). Off unless a URL is set. Default auth header is `Authorization: Bearer <key>`; a custom `header` / `AFLT_NOTIFY_HEADER` sends the raw key. Bodies include event, session id, title, project, engine, redacted cwd, exit status, timestamp, and a short redacted summary (reuses `memory.redactSensitive`; never include secrets). Short timeout; failures log to stderr and never break the run. Headless `aflt run` awaits the webhook before exit; pending `turn.captured` posts are flushed on CLI shutdown. `aflt notify test` sends a sample event; `aflt doctor` reports notify status without printing the key.

---

## Herdr integration

Requires **herdr-core** (`hc` on PATH or `AGENTFLEET_HC_BIN`) and optionally the **Herdr desktop app**.

- Interactive launches (`aflt new`, `aflt resume`, `aflt master`, `aflt spawn --interactive`) default to Herdr when `hc` is on PATH.
- Labels: `af_id=<id>`, `title=…`, and (by default) `--keep` + `herdr.space` / `herdr.tab` so the app shows one **space per session group** (workers join the master) and one **tab per session**. Renames set Agents list titles. Opt out of labels: `--no-herdr-app` or `AGENTFLEET_HERDR_APP=0`. Skip renames only: `AGENTFLEET_HERDR_NAMES=0`.
- **`aflt adopt`** moves already-live panes into the right space. The app should be open to move panes.
- After reboot, `--keep` terminals come back as a login shell (`HERDR=shell`). `aflt resume` relaunches the engine **into the existing tab**. Prefer herdr-core ≥ 0.1.20 (`aflt doctor` warns when older). Shell-only (live tab, agent stopped) is `workerStatus=stopped` for `aflt wait` (exit 1) — fix with `aflt resume <id>`.
- Panel: `aflt herdr-app install` then `herdr-app do layout.switch --name af`. Panel clicks focus / adopt / resume. Header space picker (“default ▾”) lists `aflt space ls --json` and passes `--space <name>` to `ls` / `resume` / `adopt` (persists in the mod's `localStorage`).
- `resume --all` backends: `tmux` | `iterm2` (macOS) | `wezterm` | `herdr` | `plain`. Auto-detect: `AGENTFLEET_VIA` → inside Herdr → tmux → `TERM_PROGRAM` → … → plain. `aflt which-backend` prints the choice.

---

## Environment variables

Set by the caller or the environment:

| Variable | Purpose |
|----------|---------|
| `AGENTFLEET_HOME` | Registry dir (default `~/.agentfleet`, or `~/.agentfleet/spaces/<name>` when a space is selected and this is unset). Explicit value always wins. |
| `AFLT_SPACE` | Named space (overridden by global `--space`). Opt-in isolation so a test space cannot alert/write into the default home. |
| `AGENTFLEET_REGISTRY` | Override `sessions.json` path |
| `AGENTFLEET_ENGINE` | Default engine for **new** sessions |
| `AFLT_PROJECT` | Default project name for **new** sessions (after `--project` / parent; before `.agentfleet.json` / config.json / basename). Projects need no git. Also set on launch when `agentDocs` is enabled. |
| `AFLT_MEMORY_REPO` | Override project-memory repo path (else `config.json` `memoryRepo` from `aflt memory init`). Also injected on launch when `agentDocs` is enabled. |
| `AFLT_DOCS_PROCESS` / `AFLT_AGENT_DOCS` / `AFLT_AGENTS_MD` / `AFLT_MEMORY_PROJECT` | Set on launch/resume when `agentDocs` is enabled (paths to process doc, project AGENT-DOCS.md, AGENTS.md, memory project folder). |
| `AFLT_MEMORY_MISSING` | `1` when `agentDocs` is enabled but no memory repo is configured |
| `AFLT_NOTIFY_URL` | Opt-in webhook URL for run/turn notify (else `config.json` `notify.url`). Off unless set. |
| `AFLT_NOTIFY_KEY` | Optional notify webhook secret (else `notify.key`); sent as auth header |
| `AFLT_NOTIFY_HEADER` | Notify auth header name (default `Authorization` with `Bearer <key>`) |
| `AFLT_LOOP_HEARTBEAT_SECONDS` | Opt-in `loop.heartbeat` interval while a loop runner is live (else `config.json` `loop.heartbeatSeconds`; default off / 0) |
| `AGENTFLEET_CURSOR_BIN` | Override `cursor-agent` |
| `AGENTFLEET_COPILOT_BIN` | Override `copilot` |
| `COPILOT_MODEL` | Default Copilot model for loop phases when phase/definition omit `model` (wins over config `defaultModel` for Copilot) |
| `AGENTFLEET_COPILOT_FALLBACK_MODEL` | When Copilot’s account default model is unavailable, retry with this model (default `auto`; `none`/empty disables) |
| `AGENTFLEET_OPENCODE_BIN` | Override `opencode` |
| `AGENTFLEET_OPENCODE_HOME` | OpenCode data dir (default `~/.local/share/opencode`) |
| `AGENTFLEET_OPENCODE_DB` | Override path to `opencode.db` (tests) |
| `AGENTFLEET_COPILOT_HOME` | Copilot home for import (else `COPILOT_HOME` / `~/.copilot`) |
| `AGENTFLEET_VIA` | Default `--via` / single-resume herdr vs plain |
| `AGENTFLEET_TMUX_SESSION` | tmux session name (default `agentfleet`) |
| `AGENTFLEET_HERDR_APP` | `0/false/off/no` → skip space/tab labels |
| `AGENTFLEET_HERDR_APP_BIN` | Override `herdr-app` |
| `AGENTFLEET_HC_BIN` | Override `hc` (default: `hc` on PATH / `~/.local/bin/hc`) |
| `AGENTFLEET_HERDR_APP_WAIT_MS` | Max ms wait for space/rename (default 5000) |
| `AGENTFLEET_HERDR_NAMES` | `0/false/off/no` → skip rename (labels still applied) |
| `HERDR_APP_HOME` | Herdr app config dir (default `~/.config/herdr-app`) |
| `AGENTFLEET_SEND_GRACE` | `aflt wait` grace after send (default 15s) |
| `AGENTFLEET_MSG_MAX_THREAD` / `AGENTFLEET_MSG_RATE` | Messaging limits (defaults 6 / 10 per 60s) |

Injected on launch (do not overwrite casually inside a session):

| Variable | Purpose |
|----------|---------|
| `AGENTFLEET_ID` | This session's af id (also used by `aflt children`) |
| `AGENTFLEET_SESSION` | Same as `AGENTFLEET_ID` (messaging / MCP identity) |
| `AGENTFLEET_MASTER` | Team master id when known |
| `AGENTFLEET_PARENT` | Set on spawned workers (master af id) |
| `AGENTFLEET_RESULT` | Handoff or summary path |
| `AGENTFLEET_PLAN` | Master plan under `$AGENTFLEET_HOME/plans/` |
| `AGENTFLEET_ROLE` | `master` or `docs` when launched via those commands |

`CURSOR_API_KEY` is a headless Cursor auth alternative to `agent login`. Never print it.

---

## Versioning and releases

- Semver: patch = fixes, minor = backward-compatible features, major = breaking changes (CLI flags, registry/config formats, removed commands).
- Every merged change adds a line under `## Unreleased` in CHANGELOG.md. Do not bump `package.json` in feature branches.
- Releases are cut deliberately by the maintainer following RELEASING.md (`npm version`, tag `vX.Y.Z`, GitHub release).
- `aflt --version` / `aflt doctor` report the installed version.

## Further reading

- [README.md](README.md) — product overview and command summary
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md) — engine × mode matrix and `aflt wait` outcomes
- [docs/SETUP.md](docs/SETUP.md) — environment setup, Herdr, work-computer install, troubleshooting
- [docs/PROJECT-REPO-METADATA.md](docs/PROJECT-REPO-METADATA.md) — project↔repo schema (issue #1)
- [docs/copilot-live-test.md](docs/copilot-live-test.md) — Copilot-only work Mac: validate / dry-run / live `hello-aflt` with `--fresh`, dashboard Loops success signals, results template
- `aflt help` — authoritative flag list
- `templates/orchestrator.md` / `templates/documentarian.md` — prompts injected for master and docs workers
