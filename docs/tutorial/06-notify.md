# 06 — Notify webhooks

**Goals**

- Configure notify without printing or committing secrets
- Know which events exist
- Remember that a new space starts with notify **off**

## Configuration

Off unless a URL is set. Sources (env overrides config for url/key/header):

| Source | Keys |
|--------|------|
| `$AGENTFLEET_HOME/config.json` | `notify.url`, optional `notify.key`, optional `notify.header` |
| Environment | `AFLT_NOTIFY_URL`, `AFLT_NOTIFY_KEY`, `AFLT_NOTIFY_HEADER` |

Default auth header: `Authorization: Bearer <key>`. A custom `header` / `AFLT_NOTIFY_HEADER` sends the raw key.

**Secrets:** webhook URLs and keys must never be printed, logged into tutorials, or committed. `aflt doctor` reports notify status **without** printing the key.

Named spaces: `aflt space create` writes `notify: { enabled: false }` and does not copy webhook env into that space’s LaunchAgent. Keep tutorial / lab spaces quiet unless you intentionally enable notify there.

## Events

From `lib/notify.js` / USAGE:

| Event | When |
|-------|------|
| `run.completed` | Headless run success |
| `run.failed` | Headless run failure |
| `turn.captured` | Interactive turn capture |
| `loop.started` | Loop runner start |
| `loop.phase.started` / `loop.phase.passed` / `loop.phase.failed` | Phase lifecycle |
| `loop.completed` / `loop.failed` / `loop.stopped` | Loop terminal states |
| `loop.gate.waiting` / `loop.gate.approved` | Approval gates |
| `loop.needs_human` | Loop paused for human attention (`escalation` in the definition); also emits `loop.gate.waiting` with the same diagnostic bundle |
| `loop.engine.failover` | A phase switched to the next engine in `engines` after an infrastructure error (`engine`, `fromEngine`, `errorKind`) |
| `loop.heartbeat` | Opt-in interval (`loop.heartbeatSeconds` / `AFLT_LOOP_HEARTBEAT_SECONDS`; default off) |

Payload fields include `event`, `sessionId`, `title`, `project`, `engine`, redacted `cwd`, `exitStatus`, `timestamp`, redacted `summary`, plus loop fields when relevant. Short HTTP timeout; failures log to stderr and never break the run. Headless `aflt run` / loop paths flush pending notifies before exit.

## Probe

```bash
aflt --space tutorial notify test --json
```

Requires `notify.url` or `AFLT_NOTIFY_URL`. Without config, expect an error such as notify not configured (exact wording from the CLI). Do not paste real URLs or keys into shell history you share.

## Try it

Confirm the tutorial space has notify disabled, without setting any secret:

```bash
aflt space create tutorial   # if needed
aflt --space tutorial doctor --json
# inspect the notify check's detail — it must not contain a key
```

If you experiment with a throwaway webhook later, put the URL only in the **tutorial** space config or a one-shot env var, never in the repo.
