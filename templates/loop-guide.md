# How to write an aflt loop

You are drafting an **aflt loop**: a JSON file that runs a coding project as a
series of phases. Each phase is an agent prompt followed by a check command.
A phase passes only when its check passes; on failure the agent gets the check
output and up to `maxFixAttempts` tries to fix it. These rules come from real
runs. Follow them unless the project docs clearly say otherwise.

When `docs/guidance/*.md` exists (or SPEC.md points at it), **elaborate that
brief** into fixtures, scorer scripts, and phase order. Human guidance wins over
the defaults in this guide.

## 1. Tests and eval come first (M0)

- The **first agent phase (`m0`) builds the test harness and an eval script**
  before any feature work: a test runner that the project's stack supports,
  at least one real smoke test, and an eval script (for example
  `scripts/eval.js`, or the project's equivalent) that measures what the spec
  says "working" means and prints a machine-readable result such as
  `{"overall": 87.5, ...}`.
- `m0`'s check runs the tests **and** the eval, so the harness is proven before
  anything else is built.
- Use the spec's "how do we know it works" section to decide what the eval
  measures. If the spec is vague, the eval should at least run the program
  end-to-end and check its output.

## 2. Every phase has a real check

- Every `run` and `script` phase has an `eval.command` that can actually fail:
  the test suite (`npm test`, `node --test`, `pytest`, `go test ./...`), the
  eval script, a build, or a specific file/grep check.
- **Never** use a check that always passes (`true`, `exit 0`, `echo ok`, `ls`).
  aflt refuses drafts with such checks.
- Later milestones re-run the whole test suite, so earlier work stays green.
  The milestone that matters most for quality also runs the eval
  (`... && node scripts/eval.js --json`) and can require a score with
  `eval.minOverall`, per-tier `eval.minTiers`, and optional `eval.noRegress`
  (or legacy `passRegex`).
- Give slow checks a `timeoutSec` (default 300).

## 3. Script phases need no AI call

- Use `"type": "script"` for steps that are just a command: copying seed files,
  installing dependencies, running a benchmark. A script phase has an `eval`
  command (the step itself) and **no** `prompt`/`promptFile`. It costs nothing.
- Script phases may set `eval.infraRetries` (and optional `infraExitCodes` /
  `infraPattern`) so a single infrastructure timeout (for example a live eval
  backend) retries instead of failing the whole loop.

## 4. Milestones

- Split the spec into 3 to 6 milestones after `m0` (`m1`, `m2`, ...). Each one
  is a coherent slice that leaves the tests green. Prefer fewer, larger
  milestones: every phase re-reads context and costs tokens.
- Put each milestone's prompt in its own file under the prompts folder you
  are told about, and point the phase at it with `promptFile` (path relative
  to the loop JSON). A prompt says what to build, which tests to add, what the
  check runs, and "do not push; do not switch to plan mode".
- Set `"force": true` on phases that edit files (agents need write tools),
  `"onPass": "commit"` to commit after each passed phase (needs
  `"allow": {"commit": true}`), and `maxFixAttempts` 2 or 3.
- Give long milestones a phase `timeoutSec` (for example 1800 to 5400).

## 5. Models: cheap for building, strong for judging

- Set the loop's top-level `"model"` to the **cheap build model** you are
  given. Build milestones inherit it, so leave their `model` unset.
- Set `"model"` on the `plan-next` phase to the **strong planning model** you
  are given. Only judgment phases (planning, reviewing) get the strong model.
- Set top-level `"improveModel"` to the cheap build model, so the improve
  rounds that plan-next creates do not run on the expensive planner model.
- Group phases by model (all builds, then planning). Every switch between
  models loses the prompt cache, so do not alternate.

## 6. Budget caps

- Always set `budget`: `maxRuns` (agent runs, including fix attempts),
  `maxHours` (active run time), and `maxPhases` (total phases including the
  ones plan-next adds). Size them from the budget you are given.
- Copilot bills AI credits per token; keep prompts short and phases few.

## 7. Improve rounds (optional, recommended when there is an eval)

- End with one `"type": "plan-next"` phase (`"onPass": "none"`,
  `"maxFixAttempts": 2`, `"force": true` so it can write its plan file). After the milestones it reads the eval history and
  proposes improvement phases (`improve-r1`, ...).
- Set `"targetOverall": 95` (or `eval.targetOverall`) on plan-next when the
  spec names a target; the loop skips the planner AI call when the last **live**
  line of `eval/history.jsonl` already meets the target.
- Cap improve rounds at **3**: say so in the plan-next prompt ("stop after 3
  improve rounds, or when the eval score stops improving or reaches the
  target") and set `budget.maxPhases` to the number of phases you define
  plus 3 (one per improve round).
- Set `"plannedPhaseGate": "none"` so the improve rounds run unattended,
  unless the user asked to approve every round.

## 8. Eval contract (project eval milestone)

Many projects (see human guidance) use a dedicated **eval milestone** after the
real backend exists:

- Build `eval/fixtures/transcript.json`, `scripts/eval/eval.js`, and tests with
  mock mode (fast, deterministic) and optional `--live` against the real model
  backend.
- Eval JSON shape (printed to stdout on success):

```json
{
  "overall": 87.5,
  "mode": "mock",
  "tiers": { "facts": 100, "updates": 80, "multihop": 75, "longgap": 90, "synthesis": 85, "persona": 95 },
  "probes": [{ "id": "p1", "tier": "facts", "score": 100 }],
  "weakest": "multihop"
}
```

- **Tiers and weights** — define tier names and weights in the project scorer;
  `overall` is the weighted summary (0–100).
- **Checks** — prefer `eval.minOverall`, `eval.minTiers` (per-tier floors), and
  `eval.noRegress` (compare to the previous live line in `eval/history.jsonl`)
  instead of fragile regexes. Legacy `passRegex` still works when the contract
  fields are omitted.
- **Fixture tier coverage (eval milestone)** — before `protected.fromPhase` locks
  paths, the eval milestone must seed **every tier** named in human guidance
  (for chat-agent: `facts`, `updates`, `multihop`, `longgap`, `synthesis`,
  `persona`). Each tier needs at least **3 probes** in
  `eval/fixtures/transcript.json` by default (`eval.coverage.minCasesPerTier`).
  The `updates` tier needs multi-step update chains and partial corrections
  (at least 2 chains and 2 update probes with `forbid` entries). Set on the
  eval phase check:

```json
"eval": {
  "command": "npm test && node scripts/eval/eval.js --json",
  "coverage": {
    "tiers": ["facts", "updates", "multihop", "longgap", "synthesis", "persona"],
    "minCasesPerTier": 3,
    "minUpdateChains": 2,
    "fixture": "eval/fixtures/transcript.json"
  }
}
```

  Optional `eval.coverage.command` runs a project script instead of (or in
  addition to) the built-in probe counter. If any tier is below the minimum, the
  eval phase **fails with fix attempts** so fixtures are complete before
  protected paths take effect.
- **Mock gate** — every feature milestone after the eval milestone runs
  `node scripts/eval/eval.js --json` (mock) in its check.
- **Freeze eval assets** — after the eval milestone, set loop-level
  `"protected": { "paths": ["eval/fixtures/**", "scripts/eval/**"], "fromPhase": "<eval-milestone-id>" }`
  so only that milestone (and earlier phases) could write those paths; later
  phases and improve rounds must not edit them.
- **Live eval script phase** — add `"type": "script"` with
  `eval.command: node scripts/eval/eval.js --json --live --write`,
  `eval.passRegex: "tiers"` (or contract fields), `eval.infraRetries: 1`, and a
  generous `timeoutSec`. It costs no AI tokens.

## 9. Approval gate after the eval milestone

- Put `"gate": "approve"` on the phase **right after the eval milestone** (not
  after `m0` unless there is no separate eval milestone), so a human reviews
  the fixture, mock score, and live baseline before feature work continues.
- Protected-path baselines are recorded **after** approval, so edits to
  `loop.json` during the gate wait are allowed.

## 10. Keep the loop inside the project

- Every check command runs files inside the project (`npm test`,
  `node scripts/eval/eval.js`). No `../` paths and no scripts from other
  folders: when such a file is missing, agents go searching the disk for it.
- Start each phase prompt with: "Work only inside this repository; do not read
  or copy files from other folders on disk."
- Prompt files live under `.agentfleet/prompts/` and are referenced relative
  to the loop JSON.

## 11. Shape

```json
{
  "name": "my-app",
  "project": "my-app",
  "cwd": ".",
  "engine": "cursor",
  "model": "<cheap build model>",
  "improveModel": "<cheap build model>",
  "goal": "<one paragraph from SPEC.md>",
  "acceptance": "<how we know it works, from SPEC.md>",
  "plannedPhaseGate": "none",
  "workdir": { "mode": "project" },
  "protected": { "paths": ["eval/fixtures/**", "scripts/eval/**"], "fromPhase": "eval" },
  "allow": { "commit": true, "merge": false, "push": false },
  "budget": { "maxRuns": 30, "maxHours": 4, "maxPhases": 12 },
  "phases": [
    { "id": "m0", "promptFile": "prompts/m0.md", "force": true, "maxFixAttempts": 3,
      "onPass": "commit", "timeoutSec": 1800,
      "eval": { "command": "npm test && node scripts/eval.js --json", "timeoutSec": 600 } },
    { "id": "eval", "promptFile": "prompts/eval.md", "force": true, "onPass": "commit",
      "eval": { "command": "npm test && node scripts/eval/eval.js --json",
        "coverage": { "tiers": ["facts", "updates", "multihop", "longgap", "synthesis", "persona"],
          "minCasesPerTier": 3 } } },
    { "id": "m1", "promptFile": "prompts/m1.md", "gate": "approve", "force": true,
      "maxFixAttempts": 3, "onPass": "commit",
      "eval": { "command": "npm test && node scripts/eval/eval.js --json" } },
    { "id": "live-eval", "type": "script",
      "eval": { "command": "node scripts/eval/eval.js --json --live --write",
        "passRegex": "tiers", "infraRetries": 1, "timeoutSec": 1800 } },
    { "id": "plan-next", "type": "plan-next", "model": "<strong planning model>",
      "targetOverall": 95, "promptFile": "prompts/plan-next.md", "maxFixAttempts": 2,
      "onPass": "none", "force": true }
  ]
}
```

`cwd` is `"."`: the loop runs in the folder where `aflt loop start` is run
(the project root). Check commands run there too. `"workdir": { "mode":
"project" }` lets the loop run in the project's own repo (non-empty, holding
the loop file) as long as the git tree is clean.