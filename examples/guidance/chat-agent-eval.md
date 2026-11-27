# Eval guidance (conversation memory agent). ELABORATE this brief; do not copy it literally.

## What the eval must be
A long, scripted, multi-session conversation that a real user might have with
the assistant over a few weeks. The user shares facts, preferences, plans and
ideas, later corrects some of them, and asks questions that get harder.

Write `eval/fixtures/transcript.json` with:
- at least 40 user turns over at least 4 sessions; each session is a fresh
  agent/process and only the persistent memory file carries over;
- a believable named user (job, family, a side project with two ideas, food
  likes and an allergy, a trip being planned, a pet, ...);
- probe questions interleaved through ALL sessions, at least 3 per scoring tier,
  20+ in total. Probe fields: `id`, `tier`, `session`, `after_turn`,
  `question`, `expect_any` (keywords/phrases; any one counts), `forbid`
  (stale or wrong values), and `rubric` for synthesis and persona probes.

Define difficulty tiers and weights in the project scorer (typical names:
`facts`, `updates`, `multihop`, `longgap`, `synthesis`, `persona`).

## How it is scored
`node scripts/eval/eval.js --json [--live] [--write]` prints
`{ overall, mode, tiers:{...}, probes:[{id,tier,score,reply?,reason?}], weakest }`.
It exits 0 whenever the eval ran (whatever the score) and 1 only on a crash
or, in live mode, when the model backend is unreachable.

- The scorer talks to the app ONLY through its public interface
  (for example `createAgent` and `agent.chat(text)`). It must not
  read the memory store's internal keys or format.
- Mock mode (default; offline, deterministic, fast): replays the transcript
  with a recording mock backend. For each probe it checks the messages the
  agent SENT: required facts appear in the prompt; stale values listed
  in `forbid` do not (negation-aware: warnings like "no shrimp paste" are not
  hits). This gates every milestone.
- Live mode (`--live`): replays the same transcript against the configured
  model backend and scores real replies: `expect_any` / `forbid` keyword checks
  per probe, plus an LLM judge for synthesis and persona probes (temperature 0,
  structured JSON score against the probe rubric). Cache judge answers under
  `eval/.cache/` keyed by reply+rubric (gitignored).
- Mock mode must not score 100 before persona and memory exist; live baseline
  should be well below the improve target so the eval can fail.
- `--write` appends one line to `eval/history.jsonl`.

## Make it hard enough
Aim for a live baseline well below 90:
- 80+ user turns over 6+ sessions, with distractors between a fact and its probe.
- Update **chains** (`chain` or `update_chain` on 2+ update probes, or ordered
  fact→correction in the same session) and partial corrections with `forbid`.
- Multi-hop probes combining several remembered facts.
- Conflicting preferences that need judgement.
- More facts than naive "inject everything" prompts handle well.

## Loop requirements (for `aflt loop init`)
- `protected.fromPhase` = the eval milestone id; paths
  `eval/fixtures/**` and `scripts/eval/**`.
- Script phase `live-eval` **immediately after** the eval milestone; approval
  gate on the phase **right after** `live-eval`. Phase fields:
  `node scripts/eval/eval.js --json --live --write` with
  `eval.minOverall` / `eval.minTiers` / `eval.noRegress`, `eval.infraRetries: 1`,
  generous `timeoutSec`.
- plan-next reads the last live line of `eval/history.jsonl` (does not re-run
  the eval), proposes ONE improve phase per call aimed at the weakest live tier,
  at most 2–3 improve rounds, `done: true` when live overall meets target.
- `budget.maxPhases` = defined phases + improve cap.