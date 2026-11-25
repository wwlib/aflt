# 11 — Named spaces

**Goals**

- Isolate a throwaway fleet with `--space` / `AFLT_SPACE`
- Create, list, show current, and safely remove a space
- Switch the Herdr af sessions panel between spaces
- Know per-space home, port, LaunchAgent label, memory, and notify-off default
- Leave default / no-space behavior unchanged when you omit `--space`

## Selection

```bash
aflt --space tutorial <command> …
# or
export AFLT_SPACE=tutorial
aflt <command> …
```

- Global `--space NAME` may appear in any position; flag wins over `AFLT_SPACE`
- When a space is selected and `AGENTFLEET_HOME` is **unset** → `$HOME/.agentfleet/spaces/<NAME>`
- Explicit `AGENTFLEET_HOME` still wins for the directory; the space name can still be tracked
- Names: `[A-Za-z0-9][A-Za-z0-9._-]*`
- **No `--space` / no `AFLT_SPACE`** → today’s default home (`~/.agentfleet`)

## Commands

```bash
aflt space list [--json]      # alias: aflt space ls
aflt space create <name> [--json]
aflt space current [--json]
aflt space remove <name> [--force] [--json]
```

### Create

```bash
aflt space create tutorial
```

Text:

```text
created space tutorial
  path: …/.agentfleet/spaces/tutorial
  port: 8788          # first free ≥8788 not recorded by a space and not listening now; 8787 reserved for default
  memoryRepo: …/.agentfleet/spaces/tutorial/memory
  service: dev.aflt.dashboard.tutorial
  notify: off
```

JSON fields include `ok`, `name`, `path`, `port`, `memoryRepo`, `serviceLabel`, `notifyEnabled: false`. Creating a name that already exists fails with `space already exists: <name> (…)`.

Selecting a space with `--space` / `AFLT_SPACE` does not create its folder by itself; `space create` (or the first command that writes state) does.

New space config records: unique dashboard port, `notify.enabled: false`, isolated `memoryRepo`, LaunchAgent label `dev.aflt.dashboard.<space>` (default label `dev.aflt.dashboard` unchanged).

### List / current

```bash
aflt space list
aflt --space tutorial space current
```

```text
current: (default)
* (default)  …/.agentfleet  port=8787  label=dev.aflt.dashboard
  tutorial  …/.agentfleet/spaces/tutorial  port=8788  label=dev.aflt.dashboard.tutorial
```

```text
tutorial
```

Without a space selected, `space current` prints `(default)`.

`aflt space ls` is an alias of `space list`. `aflt space ls --json` returns `{ current, default: { name: null, label: "(default)", path, current, port, serviceLabel }, spaces: [ { name, path, current, port, … } ] }` — the Herdr panel's space picker reads this.

### Remove (safe cleanup of this tutorial)

`remove` refuses a non-empty space without `--force`. It **never** removes the default home. A space made by `space create` already holds a `config.json`, so plain `remove` reports `space "tutorial" is not empty (has config or other files); pass --force to remove` and exits 1; use `--force` once you are sure.

```bash
# After you are done with the throwaway tutorial space:
aflt space remove tutorial
# if it still has files:
aflt space remove tutorial --force --json
```

```text
removed space tutorial
```

Only force-remove the **tutorial** (or other throwaway) space you created for this guide — never your default fleet as a “cleanup” step.

## Test-space workflow

1. `aflt space create tutorial`
2. Export `AFLT_SPACE=tutorial` or pass `--space tutorial`
3. Run doctor / dry-runs / dashboard experiments there
4. `aflt --space tutorial ls` / `orphans` / `loop status` as needed
5. `aflt space remove tutorial --force` when finished

In the Herdr **af sessions** panel, click the space name in the header (“default ▾”) to switch the panel to a named space (the panel lists them with `aflt space ls --json` and then passes `--space` on each command it runs; the pick survives Herdr restarts). See [04 — Herdr](04-herdr.md).

## Try it

```bash
aflt space create tutorial   # ok if already exists from earlier chapters — or pick tutorial2
aflt --space tutorial space current --json
aflt space list --json
aflt --space tutorial doctor --json | head -c 200
```

When the whole tutorial is done and you verified you are not targeting the default home:

```bash
aflt space remove tutorial --force
aflt space current
# expect: (default)
```
