// af sessions: list tracked Cursor/Copilot sessions and focus or resume them.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, spaces, focused, run, theme, notify } from "herdr";
import {
  afltSpaceLabel,
  afltSpaceOptions,
  loadAfltSpace,
  normalizeAfltSpace,
  parseAfltSpaceList,
  resolveAfltSpace,
  saveAfltSpace,
  withAfltSpace,
} from "./afspace.js";

const REFRESH_MS = 8000;
const EXEC_TIMEOUT = 20000;
const RESUME_TIMEOUT = 60000;
const POLL_MS = 1000;
const POLL_MAX_MS = 15000;
const NARROW_PX = 160;

const RUNTIME_RANK = { running: 0, shell: 1, exited: 2, missing: 3, unknown: 4, "-": 5 };

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function basename(p) {
  if (!p) return "";
  const s = String(p).replace(/[/\\]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function relUsed(iso, now) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.floor((now - t) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function truncate(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, Math.max(0, n - 1)) + "…";
}

function runtimeColor(t, runtime) {
  if (runtime === "running") return t.working || t.accent;
  if (runtime === "shell") return t.blocked || t.unknown || t.accent || t.dim;
  if (runtime === "exited") return t.muted || t.dim;
  if (runtime === "missing" || runtime === "unknown") return t.blocked || t.unknown || t.dim;
  return t.dim;
}

function tabPresent(tabId) {
  if (!tabId) return false;
  for (const s of spaces()) {
    for (const tab of s.tabs || []) {
      if (tab.id === tabId) return true;
    }
  }
  return false;
}

function focusHerdr(spaceId, tabId) {
  if (spaceId) run("space.select", { id: String(spaceId) });
  if (tabId) run("tab.select", { id: String(tabId) });
}

/** Resolve and run `aflt` (fallback `af`) even when the app's PATH is minimal. */
async function execAf(args, timeout = EXEC_TIMEOUT) {
  const homeDir = home();
  const candidates = [`${homeDir}/.local/bin/aflt`, `${homeDir}/.local/bin/af`];
  let lastErr = null;
  for (const afBin of candidates) {
    try {
      const r = await exec(afBin, args, { timeout });
      const err = `${r.stderr || ""}${r.stdout || ""}`;
      if (r.code !== 0 && /node[: ].*not found|ENOENT|command not found/i.test(err)) {
        lastErr = new Error("node-not-found");
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      // Timeouts reject too; don't retry via zsh.
      if (/timed out|timeout/i.test(msg) && !/node-not-found/i.test(msg)) {
        return { code: 124, stdout: "", stderr: msg };
      }
      // Try next candidate, then login zsh.
    }
  }
  // Failed to start, or node missing under a shebang: fall back to login zsh.
  const cmdline = ["aflt", ...args].map(shellQuote).join(" ");
  try {
    return await exec("/bin/zsh", ["-lc", cmdline], { timeout });
  } catch (e) {
    const cmdlineAf = ["af", ...args].map(shellQuote).join(" ");
    return exec("/bin/zsh", ["-lc", cmdlineAf], { timeout });
  }
}

/** Herdr's per-mod localStorage (data/af-sessions/store.json), when present. */
function panelStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch (_) {
    return null;
  }
}

function parseLsJson(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") return { sessions: [], queryOk: false, error: "bad json" };
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    return { sessions, queryOk: Boolean(data.queryOk), error: null };
  } catch (e) {
    return { sessions: [], queryOk: false, error: "parse failed" };
  }
}

function sortSessions(list) {
  return [...list].sort((a, b) => {
    const ra = RUNTIME_RANK[a?.herdr?.runtime] ?? 9;
    const rb = RUNTIME_RANK[b?.herdr?.runtime] ?? 9;
    if (ra !== rb) return ra - rb;
    const ta = Date.parse(a?.lastUsed || "") || 0;
    const tb = Date.parse(b?.lastUsed || "") || 0;
    return tb - ta;
  });
}

export default class AfSessions extends View {
  init(_props, cx) {
    this.size = { width: 268, height: 200 };
    this.sessions = [];
    this.queryOk = true;
    this.error = null;
    this.refreshing = false;
    this.starting = {}; // title -> true while resume in flight / polling
    this.pollTask = null;
    // aflt space (named AgentFleet home), not a Herdr space. null = default.
    this.afltSpace = loadAfltSpace(panelStorage());
    this.afltSpaceNames = [];
    this.afltSpacePickerOpen = false;
    this.refreshAgain = false;
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  /** Run aflt in the selected aflt space (every panel command goes through here). */
  af(args, timeout = EXEC_TIMEOUT, afltSpace = this.afltSpace) {
    return execAf(withAfltSpace(args, afltSpace), timeout);
  }

  /** Refresh the aflt space list; fall back to default if the pick vanished. */
  async refreshAfltSpaces() {
    let r;
    try {
      r = await execAf(["space", "ls", "--json"], EXEC_TIMEOUT);
    } catch (_) {
      return;
    }
    if (!r || r.code !== 0) return; // keep the last list; ls will report errors
    const parsed = parseAfltSpaceList(r.stdout || "");
    if (parsed.error) return;
    this.afltSpaceNames = parsed.names;
    const { space, missing } = resolveAfltSpace(this.afltSpace, parsed.names);
    if (missing) {
      const gone = this.afltSpace;
      this.setAfltSpace(space);
      notify({
        title: "af sessions",
        body: `aflt space "${gone}" no longer exists; showing default.`,
        level: "warning",
      });
    }
  }

  setAfltSpace(name) {
    const next = normalizeAfltSpace(name);
    this.afltSpacePickerOpen = false;
    if (next === this.afltSpace) return false;
    this.afltSpace = next;
    this.sessions = [];
    this.error = null;
    this.starting = {};
    saveAfltSpace(panelStorage(), next);
    return true;
  }

  pickAfltSpace(name, cx) {
    if (this.setAfltSpace(name)) {
      // If a refresh is in flight, run another as soon as it finishes.
      if (this.refreshing) this.refreshAgain = true;
      else this.refresh(cx);
    }
    cx.notify();
  }

  refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    this.refreshAgain = false;
    cx.notify();
    cx.spawn(async (cx) => {
      await this.refreshAfltSpaces();
      const afltSpace = this.afltSpace;
      try {
        const r = await this.af(["ls", "--json", "--all"], EXEC_TIMEOUT, afltSpace);
        if (afltSpace !== this.afltSpace) {
          // Picked another aflt space mid-flight: drop this result.
          this.refreshAgain = true;
        } else if (r.code !== 0) {
          const tail = String(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(-200);
          this.error = tail || `aflt ls failed (${r.code})`;
          this.sessions = [];
          this.queryOk = false;
        } else {
          const parsed = parseLsJson(r.stdout || "");
          if (parsed.error && parsed.sessions.length === 0) {
            this.error = parsed.error;
            this.sessions = [];
            this.queryOk = false;
          } else {
            // Tag rows with the aflt space they came from so clicks resume/adopt there.
            this.sessions = sortSessions(parsed.sessions).map((row) => ({ ...row, afltSpace }));
            this.queryOk = parsed.queryOk;
            this.error = parsed.queryOk ? null : "herdr query failed";
          }
        }
      } catch (e) {
        this.error = String(e?.message || e).slice(0, 200);
        this.sessions = [];
        this.queryOk = false;
      }
      this.refreshing = false;
      cx.notify();
      if (this.refreshAgain) this.refresh(cx);
    });
  }

  async adoptAndFocus(row, cx) {
    const title = row.title;
    try {
      const r = await this.af(["adopt", title], EXEC_TIMEOUT, row.afltSpace);
      if (r.code !== 0) {
        notify({
          title: "aflt adopt failed",
          body: String(r.stderr || r.stdout || "").trim().slice(-240),
          level: "error",
        });
        return;
      }
      this.refresh(cx);
      const space = row.herdrApp?.space;
      const tab = row.herdrApp?.tab;
      if (space || tab) focusHerdr(space, tab);
    } catch (e) {
      notify({ title: "aflt adopt failed", body: String(e?.message || e).slice(0, 200), level: "error" });
    }
  }

  startPollFocus(row, cx) {
    const tabId = row.herdrApp?.tab;
    const spaceId = row.herdrApp?.space;
    const started = Date.now();
    if (this.pollTask) {
      try { this.pollTask.cancel(); } catch (_) { /* ignore */ }
      this.pollTask = null;
    }
    this.pollTask = cx.timer.every(POLL_MS, (cx) => {
      if (tabId && tabPresent(tabId)) {
        focusHerdr(spaceId, tabId);
        this.starting[row.title] = false;
        if (this.pollTask) {
          try { this.pollTask.cancel(); } catch (_) { /* ignore */ }
          this.pollTask = null;
        }
        cx.notify();
        return;
      }
      if (Date.now() - started >= POLL_MAX_MS) {
        this.starting[row.title] = false;
        if (this.pollTask) {
          try { this.pollTask.cancel(); } catch (_) { /* ignore */ }
          this.pollTask = null;
        }
        notify({
          title: "aflt resume",
          body: `Started "${row.title}" but the Herdr tab did not appear yet.`,
          level: "warning",
        });
        this.refresh(cx);
        cx.notify();
      }
    });
  }

  onRowClick(row, cx) {
    const runtime = row?.herdr?.runtime;
    const space = row.herdrApp?.space;
    const tab = row.herdrApp?.tab;

    if (runtime === "running") {
      if (tab && tabPresent(tab)) {
        focusHerdr(space, tab);
        return;
      }
      // Running but not labeled into the app yet.
      cx.spawn(async (cx) => {
        await this.adoptAndFocus(row, cx);
        cx.notify();
      });
      return;
    }

    // shell / exited / missing / unknown / -: aflt resume (shell-only relaunches
    // the engine into the existing tab via hc send, then we focus).
    if (this.starting[row.title]) return;
    this.starting[row.title] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await this.af(["resume", row.title, "--no-open"], RESUME_TIMEOUT, row.afltSpace);
        if (r.code !== 0) {
          this.starting[row.title] = false;
          notify({
            title: "aflt resume failed",
            body: String(r.stderr || r.stdout || "").trim().slice(-240) || `exit ${r.code}`,
            level: "error",
          });
          cx.notify();
          return;
        }
        if (runtime === "shell" && tab && tabPresent(tab)) {
          focusHerdr(space, tab);
          this.starting[row.title] = false;
          this.refresh(cx);
          cx.notify();
          return;
        }
        this.startPollFocus(row, cx);
        this.refresh(cx);
      } catch (e) {
        this.starting[row.title] = false;
        notify({ title: "aflt resume failed", body: String(e?.message || e).slice(0, 200), level: "error" });
        cx.notify();
      }
    });
  }

  dot(t, runtime) {
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(4)
      .bg(runtimeColor(t, runtime));
  }

  compactRow(row, t, selected) {
    const runtime = row?.herdr?.runtime || "-";
    return h_flex()
      .id(`af-rail-${row.id}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .justify_center()
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .when(Boolean(row.title), (el) => el.tooltip(String(row.title)))
      .on_click((_e, cx) => this.onRowClick(row, cx))
      .child(this.dot(t, runtime));
  }

  row(row, t, selected, now) {
    const runtime = row?.herdr?.runtime || "-";
    const folder = basename(row.cwd);
    const starting = Boolean(this.starting[row.title]);
    return h_flex()
      .id(`af-${row.id}`)
      .px(8)
      .py(4)
      .h(42)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(8)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .cursor_pointer()
      .on_click((_e, cx) => this.onRowClick(row, cx))
      .child(this.dot(t, runtime))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .child(div().min_w(0).flex_1().truncate().text_color(t.foreground).child(truncate(row.title, 28)))
              .when(Number(row.unread) > 0, (el) =>
                el.child(
                  div()
                    .flex_none()
                    .text_size(10)
                    .text_color(t.accent || t.working || t.foreground)
                    .child(String(row.unread)),
                ),
              )
              .when((row.engine || "cursor") === "copilot", (el) =>
                el.child(
                  div()
                    .flex_none()
                    .text_size(10)
                    .text_color(t.dim)
                    .child("copilot"),
                ),
              )
              .when(starting, (el) =>
                el.child(
                  h_flex()
                    .flex_none()
                    .gap(4)
                    .items_center()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
                    .child("starting…"),
                ),
              ),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .min_w(0)
              .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(folder))
              .when(Boolean(row.branch), (el) =>
                el.child(div().flex_none().text_size(11).text_color(t.dim).child(truncate(row.branch, 16))),
              )
              .child(div().flex_1())
              .child(div().flex_none().text_size(11).text_color(t.dim).child(row.status || ""))
              .child(div().flex_none().text_size(11).text_color(t.dim).child(relUsed(row.lastUsed, now))),
          ),
      );
  }

  /** Header control: current aflt space; click opens the picker. */
  afltSpaceChip(t) {
    const label = afltSpaceLabel(this.afltSpace);
    return h_flex()
      .id("af-space-chip")
      .gap(3)
      .px(6)
      .h(18)
      .min_w(0)
      .rounded(5)
      .items_center()
      .text_size(11)
      .text_color(this.afltSpace ? t.foreground : t.dim)
      .when(this.afltSpacePickerOpen, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .cursor_pointer()
      .tooltip(`aflt space: ${label} (click to switch)`)
      .on_click((_e, cx) => {
        this.afltSpacePickerOpen = !this.afltSpacePickerOpen;
        cx.notify();
      })
      .child(div().min_w(0).truncate().child(truncate(label, 18)))
      .child(div().flex_none().text_color(t.dim).child("▾"));
  }

  /** Inline list: default plus every `aflt space ls` name. */
  afltSpacePicker(t) {
    const opts = afltSpaceOptions(this.afltSpaceNames);
    // Keep the current pick visible even before the first space list arrives.
    if (this.afltSpace && !opts.includes(this.afltSpace)) opts.push(this.afltSpace);
    return v_flex()
      .id("af-space-picker")
      .mx(8)
      .mb(6)
      .p(4)
      .flex_none()
      .max_h(220)
      .overflow_y_scrollbar()
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.raised || t.chrome)
      .children(
        opts.map((name) => {
          const current = name === this.afltSpace;
          return h_flex()
            .id(`af-space-opt-${name || "(default)"}`)
            .h(24)
            .px(8)
            .gap(6)
            .flex_none()
            .rounded(6)
            .items_center()
            .text_size(11.5)
            .when(current, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .cursor_pointer()
            .on_click((_e, cx) => this.pickAfltSpace(name, cx))
            .child(div().w(10).flex_none().text_color(t.accent || t.foreground).child(current ? "✓" : ""))
            .child(div().min_w(0).flex_1().truncate().text_color(name ? t.foreground : t.dim).child(afltSpaceLabel(name)));
        }),
      );
  }

  sectionHeader(label, t) {
    return h_flex()
      .px(8)
      .pt(8)
      .h(28)
      .flex_none()
      .items_center()
      .text_size(11)
      .font_medium()
      .text_color(t.dim)
      .child(label);
  }

  render(cx) {
    const t = theme();
    const narrow = (this.size?.width ?? 268) < NARROW_PX;
    const now = Date.now();
    const currentTab = focused()?.tab;
    const list = this.sessions || [];
    const running = list.filter((s) => s?.herdr?.runtime === "running");
    const shellOnly = list.filter((s) => s?.herdr?.runtime === "shell");
    const other = list.filter(
      (s) => s?.herdr?.runtime !== "running" && s?.herdr?.runtime !== "shell",
    );

    const rows = [];
    if (!narrow) {
      if (running.length) {
        rows.push(this.sectionHeader("Running", t));
        for (const s of running) {
          rows.push(this.row(s, t, currentTab && s.herdrApp?.tab === currentTab, now));
        }
      }
      if (shellOnly.length) {
        rows.push(this.sectionHeader("Shell (agent stopped)", t));
        for (const s of shellOnly) {
          rows.push(this.row(s, t, currentTab && s.herdrApp?.tab === currentTab, now));
        }
      }
      if (other.length) {
        const label =
          running.length || shellOnly.length ? "Other" : "Sessions";
        rows.push(this.sectionHeader(label, t));
        for (const s of other) {
          rows.push(this.row(s, t, currentTab && s.herdrApp?.tab === currentTab, now));
        }
      }
    } else {
      for (const s of list) {
        rows.push(this.compactRow(s, t, currentTab && s.herdrApp?.tab === currentTab));
      }
    }

    return v_flex()
      .id("root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(12.5)
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .when(!narrow, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .child(div().text_size(11.5).font_medium().text_color(t.dim).child("af sessions"))
                .child(div().text_size(11).text_color(t.dim).child(String(list.length)))
                .when(this.refreshing, (el) =>
                  el.child(
                    div()
                      .text_size(11)
                      .text_color(t.dim)
                      .loop("opacity", { from: 0.35, to: 1, period: 1000 })
                      .child("refreshing"),
                  ),
                ),
            )
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .min_w(0)
                .child(this.afltSpaceChip(t))
                .child(
                  div()
                    .id("af-refresh")
                    .text_size(11)
                    .text_color(t.dim)
                    .hover((s) => s.text_color(t.foreground))
                    .tooltip("Refresh now")
                    .on_click((_e, cx) => this.refresh(cx))
                    .child("↻"),
                ),
            ),
        ),
      )
      .when(this.afltSpacePickerOpen && !narrow, (el) => el.child(this.afltSpacePicker(t)))
      .when(Boolean(this.error) && !narrow, (el) =>
        el.child(div().px(12).pb(4).text_size(11).text_color(t.blocked || t.dim).child(truncate(this.error, 80))),
      )
      .when(list.length === 0 && !narrow && !this.error, (el) =>
        el.child(
          div()
            .px(12)
            .text_size(12)
            .text_color(t.dim)
            .child(this.afltSpace ? `No af sessions in space ${this.afltSpace}.` : "No af sessions."),
        ),
      )
      .child(v_flex().id("af-list").flex_1().min_h(0).px(narrow ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows));
  }
}
