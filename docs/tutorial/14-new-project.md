# 14 — Start a looped project from scratch

**Goals**

- Create a project folder, git repo, space and starter docs with `aflt init`
- Draft a loop from the docs with `aflt loop init` and read what it made
- Review the draft (terminal first; the dashboard editor is optional)
- Know what the approval gate after the first milestone shows, including the cost so far
- Keep a from-scratch project isolated from other files on disk

## 1. Pick a clean folder

A from-scratch project should start from its docs and nothing else. Use a new,
empty folder that is **not** inside another git repo and does not sit next to
similar projects; agents can search sibling folders when they get stuck.

```bash
mkdir -p ~/aflt-projects && cd ~/aflt-projects      # or: cd "$(mktemp -d /tmp/aflt-new.XXXX)"
```

## 2. `aflt init`

```bash
aflt init tile-dungeon --engine cursor --budget-hours 4
# or non-interactively with your answers as flags:
aflt init tile-dungeon --yes --engine cursor \
  --goal "A browser roguelike in plain Node and canvas" \
  --stack "Node 20, no dependencies" \
  --checks "npm test; node scripts/eval/eval.js --json" \
  --budget-credits 300 --budget-hours 4

# Optional: seed eval requirements from a human brief (copied to docs/guidance/ and linked in SPEC.md)
aflt init chat-agent --yes --guidance ~/path/to/eval-guidance.md
```

It creates `./tile-dungeon` (or `--dir PATH`), runs `git init`, creates a space
named after the project (or `--space NAME`; `--no-space` uses the current one)
and writes starter `SPEC.md`, `AGENTS.md` and `.agentfleet.json`
(`project`, `space`, `engine`, `budget`, `loop`). On a terminal it asks five
plain questions (goal, stack, how we know it works, credits, hours); `--yes`
skips them.

- Existing `SPEC.md` / `AGENTS.md` are kept unless `--force`; existing
  `.agentfleet.json` keys are kept too.
- A folder that holds anything besides the seed docs (`SPEC.md`, `AGENTS.md`,
  `README.md`, `.agentfleet.json`, `.agentfleet/`, `.gitignore`, `.git`) is
  refused. Pass `--existing` to set up a loop in an existing project anyway
  (`--force` also allows it and overwrites the docs).
- `aflt init` was chosen over `aflt new`, which already creates a session.

Edit `SPEC.md` and `AGENTS.md` before the next step: what to build, the
milestones, and how we know it works.

## 3. `aflt loop init`

```bash
cd tile-dungeon
aflt loop init                       # uses the engine and space in .agentfleet.json
aflt loop init --dry-run             # print the drafting prompt; no engine call
aflt loop init --engine copilot --build-model auto --plan-model claude-sonnet-5.5
```

The engine runs headless with the loop-writing guide
([`templates/loop-guide.md`](../../templates/loop-guide.md)), your docs, and every
`docs/guidance/*.md` file (human guidance **overrides** guide defaults when they
conflict), and writes `.agentfleet/loop.json` plus one prompt file per phase under
`.agentfleet/prompts/`. Defaults: Cursor builds on `composer-2.5` and plans on
`gpt-5.3-codex`; Copilot builds on `auto` and plans on `claude-sonnet-5.5`.

The draft must pass `aflt loop validate` **and** the checks policy:

| Rule | Why |
|------|-----|
| M0 builds the test harness and an eval script, and its prompt says so | everything after it is judged by them |
| every phase has a real check (`true`, `exit 0`, `echo`, `… \|\| true` are refused) | a phase that cannot fail teaches nothing |
| checks run files inside the project (no `../` or outside scripts) | a missing outside file sends agents searching the disk |
| an approval gate after the harness (after M0, or after a dedicated eval milestone when guidance says so) | you see fixtures/scores and the cost before feature work |
| `budget.maxRuns` or `budget.maxHours` is set; plan-next has `budget.maxPhases` | runaway protection |
| plan-next has `"force": true` | the planner must write its plan file |

Warnings (not errors): more than 3 improve rounds of room in `maxPhases`, no
planner model, no `improveModel`, build models switching back and forth.

Problems go back to the same engine session for up to two repairs
(`--max-repairs N`). On success you get a phase summary, the drafting cost,
an `aflt loop` section appended to `AGENTS.md` (`--no-agents-pointer` to skip),
and a copy under the space's `loops/definitions/` for the dashboard editor
(`--no-dashboard` to skip). The draft gets `"workdir": { "mode": "project" }`
so it runs in its own (non-empty) project repo, next to its definition.

Example summary from a live run (Cursor, `composer-2.5`, about 20 s, 56k tokens):

```
loop "tile-dungeon-iso" — engine cursor, model composer-2.5, improve rounds on composer-2.5
budget: maxRuns=45 maxHours=4 maxPhases=10
   1. m0 — check: npm test && node scripts/eval/eval.js --json
   2. m1 [⏸ approve first] — check: npm test
   3. m2 — check: npm test
   ...
   6. m5a — check: npm test && node scripts/eval/eval.js --json
   7. plan-next [plan-next, model gpt-5.3-codex] — plans improve rounds from the eval
```

## 4. Review, commit, run

```bash
aflt loop validate .agentfleet/loop.json
git add -A && git commit -m "Add aflt loop"     # the loop needs a clean repo
aflt loop run .agentfleet/loop.json --dry-run
aflt loop start .agentfleet/loop.json           # or: aflt loop run … in this terminal
```

The dashboard (`aflt dashboard --serve`, Loops → Saved definitions) shows the
same definition: phase ids, checks, gates, models, prompt files and
`improveModel`. Editing there keeps fields the form has no input for.

## 5. The gate after M0

When the loop reaches the gated phase it stops with `status=waiting`:

```
$ aflt loop status tile-dungeon
gate: waiting for approval before phase m1 (aflt loop approve tile-dungeon)
cost so far: 12.4 credits · $0.12 · 9m active · 1.5M tok
```

Copilot records credits and dollars; Cursor records no cost, so you see
`cost unknown (cursor recorded no cost) · 9m active · 1.5M tok`. The same
line is in the history, the dashboard banner, and the `loop.gate.waiting`
notify payload (`costSoFar`, `costKnown`, `credits`, `usd`, `activeHours`,
`totalTokens`, `runsUsed`). Approve with `aflt loop approve <name>`.

## 6. Isolation

`aflt init` and `aflt loop init` print an isolation line. Warnings name
anything outside the folder that the engine could pick up:

- a parent git repo, or `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` /
  `.github/copilot-instructions.md` in a parent folder;
- global instructions (`~/.copilot/copilot-instructions.md`, `~/.cursor/rules`);
- `AFLT_MEMORY_REPO` or a memory repo outside the space;
- the default space, or a space that also holds sessions for other folders
  (its `results/` folder is passed to the engine with `--add-dir`).

`--isolated` turns those warnings into errors. Not covered by these checks:
Cursor account **User Rules** and installed skills, which Cursor adds to every
chat, and the fact that Cursor's tools can read any path on disk. The drafting
prompt, the planner prompt, the fix prompt and the starter `AGENTS.md` all tell
the agent to stay inside the project.

When a loop starts, the runner copies each `promptFile` (and any check script
outside the project, with its folder) into `$AGENTFLEET_HOME/loops/<name>/`
and resume reads the copies, so removing the checkout a loop came from does
not break it. `aflt loop validate` warns about prompt files or check commands
outside the project.

Next: [09 — Loops](09-loops.md) for the full definition format.
