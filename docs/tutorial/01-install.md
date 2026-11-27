# 01 — Install and setup

**Goals**

- Install `aflt` the same ways README / AGENTS.md describe
- Fix PATH (`~/.local/bin` and the npm global bin)
- Use `aflt doctor` and `aflt setup` (preview vs `--apply`)
- Install engines yourself — setup never does

For environment depth (Herdr, work laptop, tmux/WezTerm), use [docs/SETUP.md](../SETUP.md) instead of repeating it here.

## Requirements

- **Node ≥ 20.10** (`package.json` `engines`; `npm test` needs it)
- Zero npm runtime dependencies beyond Node

## Install the CLI

Keep **install**, **machine setup**, **project onboarding**, and **workflows** separate.

```bash
# npm install -g aflt 404s — the name is not on the registry yet.
npm install -g github:wwlib/aflt

# Contributors / checkout:
#   cd /path/to/aflt && npm link
#   # or: npm install -g .
#   # or: ln -sfn "$(pwd)/bin/af.js" ~/.local/bin/{aflt,af,agentfleet}
```

Bin entries are `aflt`, `af`, and `agentfleet` (same CLI). Ensure the npm global bin dir (and `~/.local/bin` if you use clone-backed symlinks) is on **PATH**. The CLI never edits your shell rc — print PATH instructions only; you edit them yourself.

**Migration** from older `~/.local/bin/{aflt,af,agentfleet}` checkout symlinks: after a global npm install, point `which aflt` at the npm binary. `aflt setup` refuses to overwrite an unrelated `~/.local/bin` name unless `--force`.

```bash
aflt --version
# e.g. aflt 1.5.0

aflt --version --json
# {"version":"1.5.0"}
```

## Machine setup (preview vs apply)

```bash
aflt setup                 # non-mutating plan
aflt setup --apply         # create $AGENTFLEET_HOME if missing; link aliases if needed
aflt setup --apply --herdr
aflt setup --apply --memory ~/aflt-memory
aflt setup --json
```

Default is **preview**. `--apply` performs only needed actions (idempotent). Setup never edits shell rc, never mutates sessions, never installs engines, never publishes packages.

Text preview ends with a line like:

```text
aflt setup (preview)
…
Preview only. Re-run with --apply to perform needed actions.
```

JSON includes `"mode": "preview"` or `"apply"`, plus `actions`, `engines`, `herdr`, etc.

## Doctor (read-only)

```bash
aflt doctor
aflt doctor --json
```

Checks Node, home, `hc`, engines, MCP hints, notify status (never prints the key), and DOC-AGENT freshness. Human lines look like:

```text
ok  node: …
ok  home: …
!!  cursor_bin: …   # example of a failing check
```

JSON: `{ "ok": true|false, "checks": [ { "name", "ok", "detail" }, … ] }`.

## Engines (install yourself)

`aflt setup` reports missing engines but **never installs them**:

| Engine | Typical install | Override |
|--------|-----------------|----------|
| Cursor CLI | `curl https://cursor.com/install -fsS \| bash` (`cursor-agent` / `agent`) | `AGENTFLEET_CURSOR_BIN` |
| Copilot CLI | `npm install -g @github/copilot` | `AGENTFLEET_COPILOT_BIN` |
| OpenCode | [opencode.ai](https://opencode.ai) install | `AGENTFLEET_OPENCODE_BIN`; data home `AGENTFLEET_OPENCODE_HOME` |

Herdr (`hc` + optional `herdr-app`) is recommended for interactive sessions but not required for headless `aflt run` / `spawn`. Pass `--herdr` to `aflt setup` only when you want templates/panel installed. Details: [SETUP.md](../SETUP.md), [CAPABILITIES.md](../CAPABILITIES.md).

## Bash completion (optional)

```bash
# source manually — the CLI does not wire this for you
source /path/to/aflt/completions/af.bash
```

Completes `aflt`, `af`, and `agentfleet`.

## Try it

Projects created with aflt init record a **space** in `.agentfleet.json`. For
day-to-day loop commands you can omit `--space` and AGENTFLEET_HOME as long as
you run from the project folder (or pass a loop path under it): **loop run**,
**loop status**, **loop resume**, and **loop approve** apply that space
automatically, the same way loop init does. An explicit AGENTFLEET_HOME still wins
over the recorded space; when both conflict, the CLI prints a warning.

For tutorials, use a throwaway space so doctor/setup inspect that home, not your
default — **unset `AGENTFLEET_HOME`** unless you mean to override:

```bash
unset AGENTFLEET_HOME
npm install -g github:wwlib/aflt
aflt space create tutorial   # if needed
aflt --space tutorial doctor --json | head -c 400
aflt --space tutorial setup --json
```

Confirm `"mode":"preview"` on setup and that you did **not** pass `--apply` unless you intend to create files under the tutorial space home.
