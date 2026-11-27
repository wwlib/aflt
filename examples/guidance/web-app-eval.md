# Eval guidance (web app / API). ELABORATE this brief.

## What the eval measures
End-to-end checks against a running app or handler layer (no brittle
DOM selectors in the loop checks unless the spec demands them):
- HTTP or CLI scenarios in `eval/fixtures/scenarios.json` (or similar);
- at least 3 cases per tier (for example `health`, `auth`, `crud`, `errors`,
  `performance-smoke`);
- chains for flows that span multiple requests (shared `chain` id on related
  probes, or ordered steps in one scenario).

## Scorer
`node scripts/eval/eval.js --json [--live] [--write]`:
- **Mock**: in-process server with stubbed external services; deterministic.
- **Live**: real server + test database; `eval.infraRetries` for startup races.
- JSON shape `{ overall, mode, tiers, probes, weakest }`; mock scores must
  reflect missing features (not 100 on hello-world only).

## Loop requirements
- **eval milestone** once routes and tests exist; `eval.coverage` on that phase.
- `protected.fromPhase` = eval milestone id; gate on the following phase.
- `live-eval` script uses `eval.minOverall` / `eval.minTiers` / `eval.noRegress`
  and `eval.infraRetries: 1`.
- Later milestones: `npm test && node scripts/eval/eval.js --json`.