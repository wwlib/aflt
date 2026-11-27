# Eval guidance (game / interactive app). ELABORATE this brief.

## What the eval measures
A deterministic **play-through fixture**: scripted inputs (moves, clicks, or
commands) and expected world state snapshots. The fixture lives under
`eval/fixtures/` (JSON or similar) with:
- at least 3 scenarios per scoring tier you define (for example `movement`,
  `combat`, `inventory`, `win-path`, `regression`);
- at least 2 multi-step **chains** (explicit `chain` ids on related probes, or
  ordered state transitions in one scenario);
- sessions or runs that restart the game between scenarios when the spec requires
  a clean save.

## Scorer
`node scripts/eval/eval.js --json [--live] [--write]`:
- **Mock**: headless driver against a stub or recorded RNG/IO; fast, no GPU.
- **Live** (optional): run the real client with the same fixture; use
  `eval.infraRetries` for flaky IO.
- Print `{ overall, mode, tiers, probes, weakest }`; mock must not return 100
  on an empty build.

## Loop requirements
- Dedicated **eval milestone** after core gameplay exists: writes fixtures +
  scorer + tests; `eval.coverage` lists every tier with `minCasesPerTier: 3`.
- `protected.fromPhase` = that milestone id.
- Gate **approve** on the next phase (human reviews fixture + mock score).
- Script `live-eval` with contract fields (`minOverall` / `minTiers` /
  `noRegress`), not `passRegex` alone.
- Feature milestones run `npm test && node scripts/eval/eval.js --json` (mock).