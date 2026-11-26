# aflt tutorial

A beginner-to-advanced walkthrough of **aflt** (AgentFleet): install, first run, dashboard, Herdr, memory, notify, messaging, cleanup, loops, eval, and named spaces.

This tutorial is for humans and for agents that help humans. Flag lists and defaults come from `aflt help` (`bin/af.js` USAGE) and the implementation — not from guesswork. Prefer **`aflt help`** (or `aflt` with no args) for the full usage text. **Do not run `aflt <command> --help`** — that is not a dedicated help path and may run the command.

## How to follow along

Create a **throwaway space** first so you never touch your real fleet home:

```bash
aflt space create tutorial
# then either:
export AFLT_SPACE=tutorial
# or pass --space tutorial on every command
```

That isolates registry, config, memory, dashboard port, and LaunchAgent label under `~/.agentfleet/spaces/tutorial`. Notify starts **off**. When you are done, see [11 — Named spaces](11-spaces.md) for safe removal (`aflt space remove tutorial --force` only after you intend to delete that throwaway tree).

## Suggested reading order

| # | Chapter | Topics |
|---|---------|--------|
| 00 | [Overview](00-overview.md) | What aflt is / is not; sessions, engines, spaces, memory, dashboard, loops, eval |
| 01 | [Install and setup](01-install.md) | npm install, PATH, `aflt doctor`, `aflt setup`, engines, completion |
| 02 | [First session and run](02-first-run.md) | `new` / `run` / `resume` / `ls` / logs / timeouts / headless vs interactive |
| 03 | [Dashboard](03-dashboard.md) | `dashboard --serve`, History/Graph/Loops, Gantt, snapshot, `aflt service` |
| 04 | [Herdr](04-herdr.md) | Panel, mod/layout paths, registry relationship; link to SETUP / RECIPE |
| 05 | [Memory and docs](05-memory.md) | Memory repo, timeline, turns backfill, Doc Bot, documentarian / agentDocs |
| 06 | [Notify](06-notify.md) | Webhooks, events, secrets, space default off |
| 07 | [Messaging](07-messaging.md) | Opt-in `msg` / `inbox` / `thread` / MCP |
| 08 | [Purge and orphans](08-purge.md) | `purge` / `archive` / `orphans`; dry-run first |
| 09 | [Loops](09-loops.md) | validate / dry-run / status; examples; script phases; gates; plan-next; making-of |
| 10 | [Eval](10-eval.md) | measure / score / report / gate / plateau; RUBRIC GUARD |
| 11 | [Named spaces](11-spaces.md) | `--space` / `AFLT_SPACE`; create / list (ls) / current / remove; Herdr space picker |
| 12 | [Token usage](12-token-usage.md) | Per-turn `usage`, `usage-summary.json`, Copilot credits, recorded calls, History, memory rollup |
| 13 | [Troubleshooting](13-troubleshooting.md) | Timeouts, PATH, no pkill, prompts from files, FAQ |
| 14 | [New looped project](14-new-project.md) | `aflt init`, `aflt loop init`, checks policy, the gate's cost so far, isolation |

## Deeper docs (do not duplicate here)

- [docs/SETUP.md](../SETUP.md) — environment, Herdr, work-computer install, troubleshooting depth
- [docs/CAPABILITIES.md](../CAPABILITIES.md) — engine × mode matrix and `aflt wait` outcomes
- [docs/PROJECT-REPO-METADATA.md](../PROJECT-REPO-METADATA.md) — project↔repo schema
- [docs/cli-quickstart-loops.md](../cli-quickstart-loops.md) — run the hello-aflt tile-dungeon loop for real, watch it, review it with `aflt making-of`
- [docs/self-improve-runbook.md](../self-improve-runbook.md) — self-improving loop in a worktree
- [docs/copilot-live-test.md](../copilot-live-test.md) — Copilot-only work Mac: validate / dry-run / live `hello-aflt`
- [AGENTS.md](../../AGENTS.md) — agent-oriented command guide
- [CHANGELOG.md](../../CHANGELOG.md) — release notes
- [README.md](../../README.md) — product overview; dashboard screenshots in [docs/images/](../images/)

Screenshots that may help while you read:

- [dashboard-graph.png](../images/dashboard-graph.png) — Graph view
- [dashboard-history.png](../images/dashboard-history.png) — History Gantt
- [dashboard-sessions.png](../images/dashboard-sessions.png) — Sessions overview (project usage with Copilot credits and $)
- [herdr.png](../images/herdr.png) — Herdr with the af sessions panel (predates the space picker)
- [dashboard-loops.png](../images/dashboard-loops.png) — Loops view (hello-aflt run)
- [dashboard-loops-copilot.png](../images/dashboard-loops-copilot.png) — Loops view with Copilot credits and $
- [dashboard-history-loop.png](../images/dashboard-history-loop.png) — a loop's phase sessions in History
- [making-of.png](../images/making-of.png) — `aflt making-of` page (Cursor run)
- [making-of-copilot-costs.png](../images/making-of-copilot-costs.png) — making-of with Copilot credits and $ per phase
- [tile-dungeon-scratch.png](../images/tile-dungeon-scratch.png) — the game the hello-aflt loop built
