# af sessions

![Herdr with the af sessions panel in the sidebar (screenshot predates the space picker)](../../../docs/images/herdr.png)

A Herdr sidebar panel that lists AgentFleet (`aflt`) tracked sessions, shows
lifecycle and live Herdr runtime, and focuses or resumes them. A space picker
switches between the default aflt home and any named aflt space.

## What you see

A chrome-background panel under Agents (in the `af` layout). Header: “af
sessions”, session count, a subtle “refreshing” indicator while `aflt ls
--json` runs, the current aflt space (“default ▾” or the space name), and a
refresh control. Rows show title, folder basename, branch,
lifecycle status, a colored runtime dot, and relative last-used. Group headers
“Running” / “Other”. Narrower than 160px: a compact rail of dots only.

## How it behaves

- Refresh every 8s and on the header button. Each refresh first runs
  `aflt space ls --json` (space list), then `aflt [--space <name>] ls --json --all`.
- aflt space picker: click the space name in the header to open an inline list
  of “default” plus every named space; click one to switch. The panel passes
  `--space <name>` to every aflt command it runs (`ls`, `resume`, `adopt`);
  nothing for default. Rows remember the space they were listed in, so a click
  always resumes/adopts in that space.
- The pick is saved in the mod's `localStorage` (key `afltSpace`; Herdr keeps
  it in `~/.config/herdr-app/data/af-sessions/store.json`) and restored on start.
- If the saved space disappears (`aflt space remove`), the panel falls back to
  default, saves that, and shows a warning toast.
- Sort: running first, then lastUsed descending.
- Dot colors: running = working/accent; exited = muted; missing/unknown =
  blocked-ish; otherwise dim.
- Click a running row: `space.select` + `tab.select` via `herdrApp` ids. If the
  tab is absent, `aflt adopt <title>` then retry focus.
- Click a non-running row: `aflt resume <title> --no-open`, show “starting…”,
  poll `spaces()` ~1s for up to ~15s, then focus; toast on failure.
- Read-only: no done/delete/rename controls.
- Selected when `focused().tab` matches the row’s tab id.

## Built from

- Layout `layouts/af.json`: clone of `main` with an `af-sessions` block after
  `agents` in `sidebar-lists`.
- Mod `mods/af-sessions/` (`place: none`): gpui-kit `View`, `exec`/`run`/
  `spaces`/`focused`/`theme`/`notify`/`home` from `herdr`; `afspace.js` holds
  the pure aflt-space helpers (tested by `test/herdr-af-sessions-space.test.js`).
- Runs `aflt space ls --json` and `aflt [--space <name>] ls --json --all` (prefer `~/.local/bin/aflt` (else `af`), else `/bin/zsh -lc`).

## Watch out

- App PATH may omit `aflt` / `af` / `node`; resolve via `~/.local/bin/aflt` (else `af`) then zsh `-lc`.
- Never keep a `cx`; use `cx.timer.every` (no `setTimeout`).
- Animate “refreshing” with `.loop`, not a notify timer.
- Do not dock into shipped `main`; use the `af` layout (`layout.switch`).
- aflt space ≠ Herdr space: Herdr's `spaces()` are app workspaces. Panel code
  names the aflt one `afltSpace`.
- Herdr's `exec` uses your real environment: `AGENTFLEET_HOME` still wins over
  `--space` for the directory, and `AFLT_SPACE` (if exported in your login env)
  applies when the picker is on “default” (no flag is passed then).

## Done when

- `herdr-app check herdr/mods/af-sessions` passes.
- `npm test` passes in the af repo.
- `aflt herdr-app install --dry-run` plans links into `$HERDR_APP_HOME`.
