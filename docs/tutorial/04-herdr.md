# 04 — Herdr integration

**Goals**

- Know what the af-sessions panel is and where it lives in this repo
- See how Herdr relates to the aflt registry
- Install via documented commands without disturbing unrelated Herdr config
- Follow [SETUP.md](../SETUP.md) and [RECIPE.md](../../herdr/mods/af-sessions/RECIPE.md) for depth

Screenshot: [herdr.png](../images/herdr.png).

## What Herdr is here

**Herdr** (`hc` = herdr-core, optional desktop app) hosts long-lived **interactive** agent terminals. When `hc` is on PATH, `aflt new` / `resume` / `master` / `spawn --interactive` prefer Herdr. Headless `aflt run` does **not** go through Herdr.

aflt labels terminals with `af_id=<id>`, and (by default) `herdr.space` / `herdr.tab` plus `--keep` so the app shows one space per session group and one tab per session. Opt out: `--no-herdr-app` or `AGENTFLEET_HERDR_APP=0`.

## Panel and layout in this repo

| Path | Role |
|------|------|
| `herdr/mods/af-sessions/` | Herdr desktop panel mod (`mod.json`, `main.js`, [RECIPE.md](../../herdr/mods/af-sessions/RECIPE.md)) |
| `herdr/layouts/af.json` | Layout that includes the panel in the sidebar |

The panel lists tracked sessions (via `aflt ls --json --all`), shows lifecycle and live runtime, and focuses / adopts / resumes on click. It is read-only for done/delete/rename.

**aflt spaces in the panel:** the header shows the current aflt space (“default ▾” or a space name). Click it to pick “default” or any space from `aflt space ls`; the panel then runs `aflt --space <name> ls|resume|adopt …`. The pick is remembered across Herdr restarts (the mod's `localStorage`), and a space that is later removed falls back to default with a toast. See [11 — Spaces](11-spaces.md).

**Do not** dock the mod into Herdr’s shipped `main` layout — switch to the `af` layout instead.

## Install (high level)

```bash
# Preview machine setup including Herdr pieces
aflt setup --herdr --json

# Or targeted:
aflt herdr-templates --dry-run
aflt herdr-app install --dry-run
aflt herdr-app status
```

Apply when ready:

```bash
aflt setup --apply --herdr
# or: aflt herdr-app install
# then in the app: herdr-app do layout.switch --name af
```

`aflt herdr-templates` installs only Cursor/Copilot/OpenCode Herdr templates into `~/.config/herdr-core/templates`. Documentarian / orchestrator / DOC-AGENT templates stay in the package for aflt itself.

Full environment recipe (PATH, hc version, reboot recovery): [docs/SETUP.md](../SETUP.md). Panel behavior and watch-outs: [herdr/mods/af-sessions/RECIPE.md](../../herdr/mods/af-sessions/RECIPE.md).

## Registry relationship

- Registry lives under `$AGENTFLEET_HOME` (`sessions.json`, `runs/`, …)
- Herdr panes are **not** the registry — `aflt sync` persists last-known Herdr evidence without changing lifecycle `status` / `lastUsed`
- `aflt adopt` moves live af panes into the right session-group spaces (app should be open)
- After reboot, `--keep` tabs may return as shell-only; `aflt resume` relaunches into the existing tab
- `aflt purge` / `rm` never touch Herdr panes

Capability details for wait/completion: [CAPABILITIES.md](../CAPABILITIES.md).

## What not to disturb

- Do not pattern-kill Herdr or agent processes (`pkill` / `killall`) — use `aflt stop <exact-id>` for sessions you manage
- Do not overwrite unrelated mods/layouts under `~/.config/herdr-app`
- Do not point hermetic tests or tutorial experiments at the live Herdr on a shared machine without a throwaway space

## Try it

In the tutorial space, dry-run the panel install plan (no writes):

```bash
aflt space create tutorial   # if needed
aflt --space tutorial herdr-app status
aflt --space tutorial herdr-app install --dry-run
aflt --space tutorial herdr-templates --dry-run
```

Read [RECIPE.md](../../herdr/mods/af-sessions/RECIPE.md) before applying anything to a machine you share with a real fleet.
