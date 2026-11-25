#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const registry = require('../lib/registry');
const cursor = require('../lib/cursor');
const copilot = require('../lib/copilot');
const opencode = require('../lib/opencode');
const engine = require('../lib/engine');
const config = require('../lib/config');
const backends = require('../lib/backends');
const runlib = require('../lib/run');
const herdr = require('../lib/herdr');
const herdrapp = require('../lib/herdrapp');
const orchestrate = require('../lib/orchestrate');
const launch = require('../lib/launch');
const messages = require('../lib/messages');
const docs = require('../lib/docs');
const mcp = require('../lib/mcp');
const projectLib = require('../lib/project');
const projectMeta = require('../lib/project-meta');
const timeline = require('../lib/timeline');
const memory = require('../lib/memory');
const dashboard = require('../lib/dashboard');
const agentDocs = require('../lib/agent-docs');
const setup = require('../lib/setup');
const resolveSession = require('../lib/resolve-session');
const archiveLib = require('../lib/archive');
const purgeLib = require('../lib/purge');
const turns = require('../lib/turns');
const notify = require('../lib/notify');
const loopLib = require('../lib/loop');
const doctorLib = require('../lib/doctor');
const serviceLib = require('../lib/service');
const spaceLib = require('../lib/space');
const evalMeasure = require('../scripts/eval/measure');
const {
  parseArgs,
  resolveCwd,
  gitBranch,
  nowIso,
  shortId,
  displayId,
  pad,
  oscTitle,
  fleetDir,
  registryPath,
  sleep,
  slugify,
  stripSpaceFlag,
  applySpaceSelection,
  currentSpaceName,
} = require('../lib/util');

/** Resolve + attach `project` for a new session row (stores derived name). */
function applyProjectField(entry, flags, { parent = null, cache = null } = {}) {
  const c = cache || projectLib.createLookupCache();
  const flag =
    flags && flags.project != null && flags.project !== true ? flags.project : null;
  entry.project = projectLib.resolveProjectForCreate({
    flag,
    parent,
    cwd: entry.cwd,
    cache: c,
  });
  return entry;
}

const ID_COL = 16;

const PKG_VERSION = (() => {
  try {
    return require('../package.json').version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
})();

const USAGE = `aflt (AgentFleet) — track & resume Cursor / Copilot / OpenCode CLI agent sessions
Aliases: af, agentfleet (same CLI)

Usage:
  aflt --version | -v | version [--json]
                            Print version (aflt ${PKG_VERSION})
  aflt new "<title>" [--cwd DIR] [--prompt "..."] [--model X] [--engine cursor|copilot|opencode]
                            [--project NAME] [--force] [--messaging|--no-messaging]
                            [--tag T]... [--dry-run]
  aflt init <name> [--dir PATH] [--space NAME | --no-space] [--engine cursor|copilot|opencode]
                            [--goal TEXT] [--stack TEXT] [--checks TEXT]
                            [--budget-credits N] [--budget-hours N] [--yes] [--existing]
                            [--isolated] [--force] [--json]
                            Start a looped project: folder (default ./<name>),
                            git init, a space named after it (or --space), and
                            starter SPEC.md / AGENTS.md / .agentfleet.json from a
                            few plain questions (TTY) or flags (--yes). Existing
                            docs are kept unless --force. Refuses a folder with
                            files other than the seed docs unless --existing
                            (or --force). Warns about anything outside the
                            folder the engine could pick up (parent repo,
                            parent/global AGENTS.md or rules, shared space or
                            memory); --isolated turns those into errors.
                            Next: aflt loop init.
  aflt add "<title>" --chat <id> [--cwd DIR] [--model X] [--engine cursor|copilot|opencode]
                            [--project NAME] [--tag T]... [--prompt "..."]
                            For --engine copilot, --chat is the Copilot session UUID
  aflt import [--engine cursor|copilot|opencode] [cursor|copilot|opencode]
                            List local chats/sessions to register. Default engine
                            follows AGENTFLEET_ENGINE/config (builtin: cursor).
                            Cursor: scan ~/.cursor/chats (unchanged). Copilot:
                            list ~/.copilot/session-state (or import by id).
  aflt import --engine copilot [<id|prefix>...] [--title T] [--tag T]...
                            [--cwd DIR] [--limit N] [--json] [--all] [--dry-run]
                            [--allow-missing] [-i|--pick]
                            Copilot: list (newest first) or register by UUID/prefix.
                            --title only with a single id. -i requires a TTY.
  aflt ls [--status S] [--tag T] [--project NAME] [--all] [--archived] [--json]
                            STATUS is lifecycle; HERDR is live runtime
                            (running|shell|exited|missing|unknown|-).
                            --project filters by stored or derived project name.
                            --json includes effective project + parent on every row.
                            Archived sessions are hidden by default; --archived or
                            --all includes them (--json adds archived / archivedAt).
  aflt timeline [<project>] [--all] [--json] [--since <date>]
                            Read-only project session tree (no registry/Herdr writes).
                            Default project = AFLT_PROJECT, else cwd's project. --all groups
                            every project. Chronological roots + indented children;
                            best-effort git commits per session cwd (skipped when
                            missing/not-git; projects need no repo). --since ISO or
                            YYYY-MM-DD. Exit 0 when empty.
  aflt projects [<id>] [--json]
                            Read-only project↔repo mappings from the memory repo
                            (<project>/.agentfleet.json) plus local checkout paths in
                            config.json repositories. Shows validation problems
                            (unmapped/unavailable checkouts, shared remotes, duplicate ids).
                            No registry/Herdr/memory writes. See docs/PROJECT-REPO-METADATA.md.
  aflt dashboard --serve [--port 8787] [--host 127.0.0.1] [--json] [--capture-completions]
                            Live local activity dashboard (read-only by default). Bind
                            127.0.0.1:8787. History tree + Gantt by default; Graph toggle
                            for the star view. Blocks until SIGINT/SIGTERM. Separate from
                            aflt memory dashboard (memory-repo DASHBOARD.md).
                            --capture-completions: save registered Copilot Task Complete
                            events as project status notes in the configured memory repo.
                            Backfills existing events; no commits or Doc Bot launch.
                            Loops tab: "Making of" opens /making-of/<loop>.
  aflt making-of <loop> [--out file.html] [--data file.json] [--serve [--port 8797]]
                            [--build-url URL] [--build-label TEXT] [--seed PATH[,PATH]]
                            [--repo DIR] [--no-diffs] [--with-files] [--json]
                            "Making of" page for one loop in this space: every AI call
                            in order (prompt, reply, reasoning, tool calls + results,
                            tokens, Copilot credits/$ as recorded), every commit in the
                            loop's repo with phase, files and diff, and the artifacts
                            (seed files, files per phase, eval outputs, final build).
                            Self-contained HTML (default <space>/loops/<loop>/making-of.html).
                            --serve serves it live (also at /making-of/<loop> under
                            aflt dashboard --serve). --seed defaults to seed* / *-seed
                            files next to the loop definition. --with-files also writes
                            <out>-files/ (all commit diffs, seed/eval/tracked files as HTML) and
                            links them, for hosting the page without aflt.
  aflt dashboard --snapshot <file.svg|html>
                            Write a standalone SVG or self-contained HTML snapshot
                            of the current activity graph (no server). Parent dirs
                            created as needed. Only .svg / .html(.htm) supported.
  aflt turns backfill [<id|title>...] [--engine copilot|cursor|opencode|all] [--apply] [--json]
                            Import interactive turns into runs/<id>/turns.jsonl from
                            engine stores (Copilot events.jsonl; Cursor transcripts when
                            uniquely mapped). Dry-run by default (counts only); pass
                            --apply to write. Safe to re-run (dedupe). Does not write
                            memory status-notes (that stays --capture-completions).
  aflt memory                 Show resolved project-memory repo path (or hint to init)
  aflt memory where [--json]  Same as aflt memory (path + source: env|config)
  aflt memory init <path> [--force] [--json]
                            Create/register an aflt project-memory git repo (local only;
                            never adds a remote, never commits). Writes README/.gitignore/
                            .aflt-memory.json / DOC-AGENT.md when missing; registers
                            realpath as memoryRepo in $AGENTFLEET_HOME/config.json.
                            Idempotent on an existing memory repo. Refuses a non-empty
                            foreign dir unless --force (then adds files; never overwrites
                            README/.gitignore/DOC-AGENT.md).
  aflt memory sync [<project>...] [--all] [--include-adhoc] [--dry-run] [--json] [--no-redact]
                            [--active-days N] [--commit] [--push]
                            Write <repo>/<project>/_aflt/timeline.md + sessions.jsonl from
                            the registry (read-only), then regenerate root DASHBOARD.md
                            (complete Active/Dormant table for all memory-repo + registry
                            projects). Default: cwd / AFLT_PROJECT project.
                            --all: every registry project except adhoc (one-off home/tmp
                            prompts are often personal; pass --include-adhoc or name adhoc
                            explicitly). Creates <project>/README.md + status-notes/.gitkeep
                            only if missing; never overwrites human notes. Writes only when
                            content differs. Redaction ON by default (--no-redact to disable).
                            --active-days N: Active threshold in calendar days ET (default 14;
                            else config.json memoryActiveDays). Flag > config > 14.
                            --commit: after sync, stage DASHBOARD.md + */_aflt/** and commit
                            (message "memory: sync YYYY-MM-DD"); refuses if the index already
                            has staged changes or anything else would be included; never
                            stages human README / per-project dashboard.md / status-notes;
                            --commit --dry-run is an error. --push requires --commit; pushes
                            to the current branch upstream when a commit was made or the
                            branch is ahead (never adds remotes / never force).
  aflt memory dashboard [--dry-run] [--json] [--no-redact] [--active-days N]
                            Regenerate root DASHBOARD.md only (no per-project _aflt/ writes).
                            Same dry-run / json / redact / active-days semantics as sync.
                            Preserves <!-- doc-bot:summary --> block verbatim when present.
  aflt memory config [--apply] [--json] [--no-redact] [--active-days N] [--commit] [--push]
                            Refresh aflt-template-managed memory-repo root files
                            (DOC-AGENT.md, DOCUMENTATION-PROCESS.md) against package
                            templates. Dry-run by default (reports up-to-date /
                            would-update / missing + short diff). --apply writes the
                            template version (keeps DOC-AGENT.md.bak /
                            DOCUMENTATION-PROCESS.md.bak only when the existing file
                            had local edits). Then regenerates root DASHBOARD.md like
                            memory dashboard (preserves doc-bot summary block). Never
                            touches per-project README / status-notes. Never commits
                            unless --commit (requires --apply; refuses dirty index;
                            stages DASHBOARD.md + managed roots only). --push requires
                            --commit.
  aflt memory doc [--engine cursor|copilot|opencode] [--dry-run] [--json] [--force]
                            Launch a portable Doc Bot session (\`doc-bot\`) in the memory
                            repo with DOC-AGENT.md as the prompt (Cursor CLI or Copilot CLI
                            via --engine). Fails if DOC-AGENT.md is missing. --dry-run does
                            not create a session or start an engine.
  aflt memory status [--json]
                            Read-only: repo path/source, git dirty count, per-project
                            folder/lastSync/sessions/stale (stale = sync would change files).
  aflt sync [--dry-run] [--json]
                            Persist last-known Herdr runtime evidence (does not change status/lastUsed)
  aflt run "<title>" --prompt "..." [--cwd DIR] [--model X] [--engine cursor|copilot|opencode]
                            [--project NAME] [--mode ask|plan] [--force]
                            [--output-format text|json] [--timeout SEC]
                            [--messaging|--no-messaging] [--no-docs]
                            [--dry-run] [--json]
                            Headless one-shot: create or resume, capture output, exit.
                            If the session is role=master and exits 0, may trigger
                            aflt docs (same as headless master; skip with --no-docs).
  aflt run <title|id> --prompt "..." [...]
                            Same, resuming an existing tracked session
  aflt log <title|id> [--path]  Print last captured run output (or its path)
  aflt spawn --parent <id|title> --prompt TEXT [--engine cursor|copilot|opencode] [--cwd DIR]
                            [--project NAME] [--title T] [--task TEXT] [--model X]
                            [--timeout SEC] [--force] [--interactive] [--detach]
                            [--messaging|--no-messaging] [--dry-run] [--json]
                            Create a worker under a master; headless by default
                            (same machinery as aflt run). --interactive launches via Herdr.
                            --detach (headless only): return immediately; a supervisor
                            records exit/handoff. Prefer --detach over shell &.
                            Messaging-enabled masters pass messaging:true to workers
                            unless --no-messaging. Workers inherit the master's project
                            unless --project is set.
  aflt master --goal TEXT [--engine cursor|copilot|opencode] [--cwd DIR] [--title T] [--model X]
                            [--project NAME] [--worker-engine copilot|cursor|opencode]
                            [--headless] [--timeout SEC]
                            [--force] [--messaging|--no-messaging] [--no-docs]
                            [--dry-run] [--json]
                            Create a master session with the orchestrator template as
                            the initial prompt. Default: interactive via Herdr.
                            --headless uses aflt run machinery (workerStatus tracked).
                            On successful headless exit, runs aflt docs once if the
                            project has {"docs": true} (skip with --no-docs).
  aflt docs [<project dir>] [--since <commit>] [--engine cursor|copilot|opencode] [--model X]
                            [--force|--no-force] [--anyway] [--dry-run] [--json]
                            Documentarian: one headless docs worker (role=docs) that
                            updates only configured docs paths. Opt-in via
                            .agentfleet.json {"docs": true}. Optional
                            docsInstructions: file path(s) whose contents are
                            injected into the prompt (still only edit docsPaths).
                            Prompt may include a compact session timeline since the
                            last docs run (cap ~8KB; dry-run/json report timelineBytes).
                            --anyway runs once without enabling. Force/write grant
                            is ON by default (Cursor --force / Copilot
                            --allow-all-tools); opt out with --no-force or
                            {"docsForce": false}. Dry-run prints the plan only.
  aflt docs --status [--json] [--all] [<dir>...]
                            Read-only docs status per project (no engine, no
                            writes). Default: cwd. --all adds distinct registry
                            project dirs. Reports docsEnabled, docsPaths,
                            docsInstructions, lastRun, commitsSince, dirtyDocs,
                            needsDocs, skip/skipReason (dirty-docs: uncommitted
                            docsPaths edits, .DS_Store ignored), ready
                            (needsDocs && !skip; act only on ready), and opt-in
                            agentDocs checkpoint missing/overdue (age ≠ progress).
                            Exit 0 even when needsDocs is true.
  aflt docs checkpoint request|complete [<dir>] [--project NAME] [--reason T]
                            [--note PATH] [--json]
                            Record a documentation checkpoint (opt-in agentDocs).
                            Requests at safe boundaries only; complete requires a
                            dated note under status-notes/ (not archive/). Never
                            interrupts a busy agent. Doc Bot notify is batched
                            after the note is written (messaging optional).
  aflt docs notify flush|ack|status|retry [<dir>] [--project NAME] [--id ID]
                            [--json]
                            Batched Doc Bot queue: flush note-ready items (one
                            message per batch), ack after Doc Bot reports notes
                            written, show queue status, or process checkpoint
                            retries with backoff.
  aflt msg <to> <text...> [--type T] [--reply <msgId>] [--from S] [--json] [--dry-run]
                            Opt-in message (team aliases or cross-session DM).
                            <to> = exact id / unique exact title, or master /
                            all-siblings (team only). Both sides must opt in.
                            With --reply and no <to>, defaults to=reply sender.
                            Never wakes agents or changes lifecycle/role/parent.
  aflt msg enable|disable <session> [--json] [--dry-run]
                            Per-session messaging opt-in / opt-out
  aflt inbox [<session>] [--unread] [--status queued|read|completed]
                            [--mark-read|--mark-complete] [--json]
                            Messages for a session (default: AGENTFLEET_SESSION/ID).
                            Status: queued → read → completed. Plain-shell ok.
  aflt thread <msgId|master> [--json]
                            One thread in order, or whole team log for a master.
  aflt mcp                    Stdio MCP server (tools when messaging enabled)
  aflt mcp install --engine copilot|cursor [--write] [--project] [--cwd DIR]
                            [--dry-run] [--json]
                            Print or merge MCP config. Copilot: ~/.copilot/mcp-config.json
                            with --write. Cursor user: ~/.cursor/mcp.json with --write.
                            Cursor project: --project writes <cwd>/.cursor/mcp.json
                            (backs up first). Messaging-enabled Copilot runs get
                            --additional-mcp-config per launch; Cursor gets
                            --approve-mcps when af is in project/user mcp.json.
  aflt children [<id|title>] [--json] [--all]
                            List a master's workers, or (no arg) resolve master from
                            AGENTFLEET_ID / AGENTFLEET_PARENT, or summarize all masters.
                            --all includes lifecycle-done masters in the summary.
  aflt result <id|title> [--path] [--json] [--require-fresh]
                            Print a worker's handoff file (or its path). If missing,
                            stderr note + last ~40 lines of the run log; exit 1.
                            --require-fresh exits 1 if the handoff exists but is
                            stale (mtime not after runStartedAt / resultMtimeAtStart).
  aflt wait [<id|title>...] [--parent <master>] [--any] [--timeout SEC] [--interval SEC]
                            [--send-grace SEC] [--docs] [--json]
                            Block until listed workers reach done|failed|stopped|waiting.
                            Explicit ids/titles win over --parent. No ids: --parent children,
                            else children of AGENTFLEET_ID (master) or AGENTFLEET_PARENT.
                            Exit: 0 ok, 1 failed/stopped, 2 timeout, 3 waiting.
                            --send-grace: ignore stale Herdr done/idle after aflt send
                            (default 15; env AGENTFLEET_SEND_GRACE).
                            --docs: after exit 0, run aflt docs once for the master's
                            project (same one-shot guard as headless master).
                            Errors if no master can be resolved.
  aflt tail <id|title> [-n N] [-f]
                            Last N lines of run log (or hc read for live Herdr). -f follows
                            until the worker leaves running (or Ctrl-C).
  aflt send <id|title> "text" [--timeout SEC] [--force] [--json]
                            Interactive: hc send (records lastSendAt; workerStatus=running).
                            Headless (not running): continue chat with a short handoff
                            reminder. Refuses if headless runPid live.
  aflt stop <id|title> | aflt stop --all-children <master> [--json]
                            Stop a running worker (SIGTERM process group / hc interrupt+kill).
                            Exact id/title preferred. On a TTY (not --json), no exact match
                            with fuzzy candidates prompts to confirm/pick; Enter/n cancels.
                            Non-TTY / --json / agents: exact-only + did-you-mean hint.
  aflt resume <title|id> [--via herdr|plain] [--here] [--open|--no-open]
                            [--prompt "..."] [--force] [--dry-run] [--no-herdr-app]
                            Resume one session (argv from session.engine). Default:
                            Herdr when hc is on PATH (prints Attach: hc attach <name>).
                            Shell-only live tab (agent stopped after reboot/--keep):
                            relaunches the engine via hc send into that tab (no new
                            terminal). --here / --via plain: this terminal. --open:
                            new iTerm2 tab running hc attach (default in an iTerm TTY;
                            --no-open disables). --force: Copilot --allow-all-tools
                            only (Cursor unchanged). Herdr launches also label
                            herdr.space / herdr.tab (and --keep); --no-herdr-app
                            disables that.
  aflt resume | aflt resume -i | aflt pick
                            Interactive multi-select (TTY only); resume via Herdr
  aflt resume --all [--tag T] [--via tmux|iterm2|wezterm|herdr|plain]
                            [--open|--no-open] [--force] [--dry-run] [--no-herdr-app]
  aflt adopt <title|id ...> | aflt adopt --all [--dry-run] [--json]
                            Move live af Herdr panes into session-group spaces
                            (park→label→keep when needed), then rename space
                            (group title) and tab (session title). Migrates
                            legacy cwd-based spaces. App must be open to move panes.
  aflt cursor | aflt copilot | aflt opencode  Set default engine for new sessions (config.json)
  aflt engine [cursor|copilot|opencode]
                            Print default engine + source, or set it
  aflt rename <title|id> "<new title>"
  aflt cwd <title|id> [path] [--dry-run] [--json]
                            Show or change a session's folder (alias: aflt set-cwd).
                            Path must exist; refreshes branch. Live Herdr tab is
                            not moved — resume (and optionally adopt) after.
  aflt done <title|id>
  aflt archive <title|id> [--with-children] [--force] [--dry-run] [--json]
                            Set archived + archivedAt on the session (status
                            unchanged). Reversible via unarchive. Run logs and
                            history are untouched. --with-children also archives
                            descendants. Refuses running/waiting (live runPid or
                            Herdr working/blocked) unless --force.
  aflt unarchive <title|id> [--with-children] [--dry-run] [--json]
                            Clear archived / archivedAt. --with-children also
                            unarchives archived descendants.
  aflt rm <title|id> [<title|id>...] [--keep-files] [--force] [--dry-run]
                            Remove session(s) and af-owned files under
                            $AGENTFLEET_HOME (results/, plans/). Never deletes
                            runs/<id>/ logs. Clears parent links on remaining
                            children. Exact id/title preferred. On a TTY, no exact
                            match with fuzzy candidates prompts to confirm/pick
                            (same as stop); cancel aborts before any removal.
                            Multiple ids: resolve all first. Prefer --dry-run first
                            (--dry-run still prompts on a TTY for resolution only).
                            Non-TTY / agents: exact-only + did-you-mean.
                            --keep-files: registry only (keeps handoffs/logs).
                            Refuses if running/waiting unless --force (does not
                            stop the process — aflt stop first).
  aflt rm --children <master> [--with-master] [--keep-files] [--force] [--dry-run]
                            Remove all workers of a master; --with-master also
                            removes the master. Master resolution matches rm/stop
                            (TTY picker when no exact match). --dry-run lists actions.
  aflt rm --purge <title|id>… Same as aflt purge (full delete; dry-run unless --apply).
  aflt purge <title|id>... [--with-children] [--apply] [--force] [--yes] [--json]
                            [--no-engine|--aflt-only] [--engine-only] [--no-transcripts]
                            Full delete: registry row, runs/<id>/, results/plans,
                            master messages log, and the engine Copilot/Cursor chat
                            dir when the path mapping is certain. Dry-run by default;
                            pass --apply to mutate. Never touches Herdr panes.
                            Refuses busy sessions unless --force (stop first).
                            --yes skips typed confirm (required for non-TTY apply).
  aflt orphans [--days N] [--engine cursor|copilot|opencode|all] [--category C]...
                            [--json] [--allow-uncertain-engine] [--include-interactive]
                            Scan for orphan/stale sessions and chats (dry-run).
  aflt orphans --purge [--ids id,…] [--category C]... [--apply] [--yes] [--force]
                            [--json] [--days N] [--allow-uncertain-engine]
                            Purge selected orphan items only (never herdr panes).
                            Dry-run unless --apply; --ids required (or TTY pick).
  aflt note <title|id> "<text>"
  aflt export [file]          Write registry JSON (default: stdout)
  aflt import-file <file>     Merge sessions from a backup file
  aflt which-backend          Show auto-detected resume --all backend
  aflt setup [--apply] [--json] [--herdr] [--memory <path>] [--force]
                            Machine setup preview (default) or apply. Checks Node,
                            CLI aliases on PATH, $AGENTFLEET_HOME, engines; never
                            edits shell rc files, never mutates sessions, never
                            installs engines or publishes packages. --apply performs
                            only needed actions (idempotent). --memory <path> runs
                            memory init/register. --herdr installs Herdr templates
                            + af-sessions panel when hc/herdr-app are present.
                            --force replaces foreign ~/.local/bin aliases only.
  aflt herdr-templates [--force] [--dry-run]
                            Install only the Cursor, Copilot, and OpenCode Herdr
                            templates into ~/.config/herdr-core/templates
                            (not DOC-AGENT/documentarian/orchestrator — those
                            stay in the package for aflt itself)
  aflt herdr-app install [--copy] [--force] [--dry-run]
                            Symlink (default) or copy the af-sessions Herdr panel
                            + af layout into ~/.config/herdr-app (or $HERDR_APP_HOME)
  aflt herdr-app status       Report linked/copied/missing for the panel + layout
  aflt doctor [--json] [--strict [--notify]] [--port N] [--loop <file>]
                            Read-only environment checks (hc, engines, home,
                            notify status, memory DOC-AGENT freshness — never
                            prints the notify key; outdated DOC-AGENT hints
                            \`aflt memory config\`). --strict adds preflight:
                            engine CLIs on PATH (+ ~/.local/bin hint), engine
                            sign-in probe (cursor runs \`cursor-agent status\`,
                            copilot/opencode report "unknown (no probe)" warn),
                            notify config (--notify: live round trip), a free
                            ephemeral port, and exits 1 if any check fails
                            (warnings never fail). --port N test-binds
                            127.0.0.1:N and releases it. --loop <file> shows
                            the loop workdir inspection and engine CLIs.
  aflt notify test [--json]
                            Send a sample notify webhook event (requires
                            config.json notify.url or AFLT_NOTIFY_URL)
  aflt loop init [--engine E] [--model M | --build-model M --plan-model M]
                            [--out .agentfleet/loop.json] [--dry-run] [--force]
                            [--no-gate] [--no-dashboard] [--no-agents-pointer]
                            [--budget-credits N] [--budget-hours N] [--isolated] [--json]
                            Draft a loop from SPEC.md / AGENTS.md: the engine
                            (headless) writes the loop JSON + prompts/ following
                            templates/loop-guide.md (m0 builds tests + eval, a
                            real check on every phase, gate after the first
                            milestone, cheap build model / strong planner,
                            budget caps, ≤3 improve rounds). The draft must pass
                            loop validate and the checks policy; problems go
                            back to the engine (up to 2 repairs). On success:
                            phase summary, an aflt-loop section in AGENTS.md,
                            and a copy under loops/definitions for the
                            dashboard editor. Uses the space in .agentfleet.json.
                            Prints isolation warnings; --isolated refuses.
  aflt loop validate <file> [--json]
                            Validate a loop definition JSON file (schema,
                            phases, eval, allow/onPass). Exit 1 on errors.
  aflt loop run <file> [--dry-run] [--json] [--fresh]
                            [--force] [--allow-existing] [--create-worktree]
                            Run a multi-phase loop (plan→develop→eval→fix,
                            optional plan-next). Persists state under
                            $AGENTFLEET_HOME/loops/<name>/.
                            --dry-run prints the plan (resolved cwd, permission
                            mode, model) without locking or running. A cwd that
                            is not a clean empty git repo, or that contains the
                            aflt checkout or the definition, is refused (dry-run
                            still prints the plan, then exits 1).
                            --allow-existing overrides that folder check.
                            workdir.mode "worktree" (definition key) instead
                            accepts a clean non-empty git worktree that is not
                            the running aflt checkout; --create-worktree runs
                            \`git worktree add\` for a missing workdir.path.
                            --force grants full tool permissions for this run
                            (Cursor --force / Copilot --allow-all-tools).
                            Definitions default force to false; set force:true
                            on the loop or phase to opt in without the flag.
                            --fresh starts a new state (0 of N) when the loop
                            already completed (same fleethome; prefer over a
                            new space so the default Loops view still shows it).
                            Model: phase.model, else definition.model, else
                            COPILOT_MODEL when the phase engine is copilot,
                            else config.json defaultModel (alias model).
                            Improve rounds added by plan-next do not inherit the
                            planner's model: they use plan-next improveModel,
                            else definition improveModel, else the chain above.
  aflt loop start <file> [--json]
                            Register a loop as active for the dashboard
                            scheduler (does not run phases in this process).
  aflt loop pause <name> [--json]
                            Pause an active/running loop (runner yields; stays
                            registered until stop).
  aflt loop status [name] [--json]
                            Show one loop's state, or list all loops. A loop
                            waiting at a gate shows the cost so far (credits /
                            $ when recorded, active time, tokens).
  aflt loop stop <name> [--json]
                            Request stop (sets stopRequested; signals live runner).
  aflt loop resume <name> [--json]
                            Resume a paused/stopped/running loop from saved state
                            (runs in this process). Dashboard API resume only
                            re-activates for the scheduler.
  aflt loop approve <name> [--json]
                            Release an approval gate (phase gate: "approve";
                            emits loop.gate.approved and re-activates for the
                            dashboard scheduler).
  aflt service install|uninstall|status [--port N] [--host H] [--print] [--json]
                            macOS LaunchAgent for \`aflt dashboard --serve\`
                            (KeepAlive; logs under $AGENTFLEET_HOME/logs).
                            Default label/plist: dev.aflt.dashboard; named space
                            uses dev.aflt.dashboard.<space>. --print shows the
                            plist without writing. Unsupported on non-macOS.
                            Default --port comes from the space config when set.
  aflt space list|ls [--json]
                            List named spaces under ~/.agentfleet/spaces/ plus
                            the default (no-space) home; marks current.
  aflt space create <name> [--json]
                            Create ~/.agentfleet/spaces/<name> with a space-local
                            config.json (unique dashboard port, notify off,
                            isolated memoryRepo, LaunchAgent label).
  aflt space current [--json]
                            Print the current space name, or (default).
  aflt space remove <name> [--force] [--json]
                            Remove a named space directory. Refuses non-empty
                            without --force. Never removes the default home.
  aflt eval measure [--json] [--out DIR]
                            Hermetic self-measurement: suite summary (pass/fail/
                            skip, per-file duration, flake rerun), best-effort
                            coverage via --experimental-test-coverage + NDJSON reporter,
                            sandboxed CLI smoke, and dashboard /api contract
                            checks. Writes eval/results/<timestamp>.json (or
                            --out DIR). Never touches real ~/.agentfleet, live
                            engines, or Herdr. Opt-in; does not mutate the repo.
  aflt eval score [results-file] [--json] [--history PATH] [--qualitative]
                  [--results-dir DIR] [--write-baseline PATH] [--max-rounds N]
                            Deterministic score (0–100) from a measure JSON +
                            repo rubric (eval/RUBRIC.md). Appends one line to
                            eval/history.jsonl (or --history). Optional
                            --write-baseline records the improve-loop baseline
                            (default path when flag is bare: eval/improve-baseline.json).
                            Qualitative evaluator is opt-in (--qualitative) and
                            skipped under AGENTFLEET_TEST / AFLT_EVAL_SKIP_QUALITATIVE;
                            default path never calls live engines.
  aflt eval report [--json] [--history PATH] [--limit N]
                            Human-readable summary of the latest score + trend
                            from history.jsonl.
  aflt eval gate [--json] [--base REF] [--paths a,b]
                 [--improve] [--baseline PATH] [--results PATH]
                 [--results-dir DIR] [--history PATH] [--score N]
                            RUBRIC GUARD: exit non-zero if protected paths
                            (eval/RUBRIC.md, scripts/eval/score.js,
                            scripts/eval/rubric.js) changed vs --base (default
                            HEAD). With --improve: also require suite green and
                            score >= baseline (self-improve loop gate).
  aflt eval plateau [--json] [--baseline PATH] [--history PATH]
                    [--max-rounds N] [--rounds N]
                            Exit 0 with stop=true when the improve loop should
                            halt (score plateau vs previous round/baseline, or
                            max rounds). Default max rounds: 3.
  aflt help
                            Exit: 0 ok, 1 error, 2 wait timeout, 3 waiting,
                            75 critical registry write failed after a run

Global flags:
  --space NAME            Select a named space (any position). Resolves
                            AGENTFLEET_HOME to ~/.agentfleet/spaces/NAME when
                            AGENTFLEET_HOME is unset. Wins over AFLT_SPACE.
                            Names: [A-Za-z0-9][A-Za-z0-9._-]*

Environment:
  AGENTFLEET_HOME         Registry dir (default: ~/.agentfleet, or
                            ~/.agentfleet/spaces/<name> when a space is selected
                            and this is unset). Explicit value always wins.
  AFLT_SPACE              Named space (overridden by --space). Opt-in isolation
                            so a test space cannot alert/write into the default.
  AGENTFLEET_REGISTRY     Override sessions.json path
  AGENTFLEET_ENGINE       Default engine for NEW sessions (cursor|copilot|opencode);
                            after --engine flag, before config.json / builtin
  AFLT_PROJECT            Default project name for NEW sessions (after --project
                            and parent inheritance; before .agentfleet.json /
                            config.json project / basename). Projects need no git.
  AFLT_MEMORY_REPO        Override project-memory repo path (else config.json
                            memoryRepo from aflt memory init)
  AFLT_NOTIFY_URL         Opt-in webhook URL for run/turn notify (else
                            config.json notify.url). Off unless set.
  AFLT_NOTIFY_KEY         Optional secret for the notify webhook header
                            (else config.json notify.key)
  AFLT_NOTIFY_HEADER      Notify auth header name (default Authorization;
                            value is Bearer <key> for Authorization)
  AFLT_LOOP_HEARTBEAT_SECONDS  Opt-in loop.heartbeat interval in seconds
                            (else config.json loop.heartbeatSeconds; default off)
  AGENTFLEET_CURSOR_BIN   Override cursor-agent binary
  AGENTFLEET_COPILOT_BIN  Override copilot binary
  COPILOT_MODEL           Default Copilot model for loop phases when the
                            phase/definition omit model (wins over config
                            defaultModel for Copilot)
  AGENTFLEET_COPILOT_FALLBACK_MODEL  When Copilot's account default model is
                            unavailable, retry with this model (default auto;
                            set to none/empty to disable)
  AGENTFLEET_OPENCODE_BIN Override opencode binary
  AGENTFLEET_OPENCODE_HOME OpenCode data dir (default ~/.local/share/opencode)
  AGENTFLEET_VIA          Default --via backend (resume --all; also overrides
                            single-session default: herdr vs plain)
  AGENTFLEET_TMUX_SESSION tmux session name (default: agentfleet)
  AGENTFLEET_HERDR_APP    Set to 0/false/off/no to skip herdr.space/tab labels
  AGENTFLEET_HERDR_APP_BIN Override herdr-app binary (default: herdr-app on PATH)
  AGENTFLEET_HC_BIN       Override hc binary (default: hc on PATH / ~/.local/bin/hc)
  AGENTFLEET_HERDR_APP_WAIT_MS  Max ms to wait for herdr-app space/rename (default 5000)
  AGENTFLEET_HERDR_NAMES  Set to 0/false/off/no to skip space.rename + tab.rename
                            (labels still applied; Herdr defaults space names to repo)
  HERDR_APP_HOME          Herdr app config dir (default: ~/.config/herdr-app)
  AGENTFLEET_ID           Set on launched sessions (af id); used by aflt children
  AGENTFLEET_SESSION      Same as AGENTFLEET_ID (messaging / MCP identity)
  AGENTFLEET_MASTER       Team master id when known
  AGENTFLEET_PARENT       Set on spawned workers (master af id)
  AGENTFLEET_RESULT       Set on spawned workers / masters (handoff or summary path)
  AGENTFLEET_PLAN         Set on masters (plan under $AGENTFLEET_HOME/plans/)
  AGENTFLEET_ROLE         Set on masters (master) when launched via aflt master
  AGENTFLEET_SEND_GRACE   Seconds for aflt wait to ignore stale done/idle after send
  AGENTFLEET_MSG_MAX_THREAD  Max messages per thread (default 6)
  AGENTFLEET_MSG_RATE     Max messages per sender per 60s (default 10)
`;

function cmdVersion(rest) {
  const { flags } = parseArgs(rest);
  const asJson = Boolean(flags.json);
  if (asJson) {
    process.stdout.write(JSON.stringify({ version: PKG_VERSION }) + '\n');
  } else {
    process.stdout.write(`aflt ${PKG_VERSION}\n`);
  }
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const stripped = stripSpaceFlag(rawArgv);
  if (stripped.sawSpace) {
    try {
      applySpaceSelection({
        sawSpace: true,
        spaceFlag: stripped.space,
        env: process.env,
      });
    } catch (err) {
      fail(err.message || String(err));
    }
  } else if (require('../lib/util').envNonEmpty(process.env, 'AFLT_SPACE')) {
    try {
      applySpaceSelection({ sawSpace: false, env: process.env });
    } catch (err) {
      fail(err.message || String(err));
    }
  }

  const argv = stripped.argv;
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  // Global version flags before subcommands
  if (argv[0] === '--version' || argv[0] === '-v') {
    cmdVersion(argv.slice(1));
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'version':
      cmdVersion(rest);
      break;
    case 'new':
      await cmdNew(rest);
      break;
    case 'init':
      await cmdInit(rest);
      break;
    case 'run':
      await cmdRun(rest);
      break;
    case 'log':
      cmdLog(rest);
      break;
    case 'spawn':
      await cmdSpawn(rest);
      break;
    case '_supervise-headless':
      await cmdSuperviseHeadless(rest);
      break;
    case 'master':
      await cmdMaster(rest);
      break;
    case 'docs':
      await cmdDocs(rest);
      break;
    case 'msg':
      cmdMsg(rest);
      break;
    case 'inbox':
      cmdInbox(rest);
      break;
    case 'thread':
      cmdThread(rest);
      break;
    case 'mcp':
      await cmdMcp(rest);
      break;
    case 'children':
      cmdChildren(rest);
      break;
    case 'result':
      cmdResult(rest);
      break;
    case 'wait':
      await cmdWait(rest);
      break;
    case 'tail':
      await cmdTail(rest);
      break;
    case 'send':
      await cmdSend(rest);
      break;
    case 'stop':
      await cmdStop(rest);
      break;
    case 'herdr-templates':
      cmdHerdrTemplates(rest);
      break;
    case 'herdr-app':
      cmdHerdrApp(rest);
      break;
    case 'add':
      cmdAdd(rest);
      break;
    case 'import':
      await cmdImport(rest);
      break;
    case 'ls':
    case 'list':
      cmdLs(rest);
      break;
    case 'timeline':
      cmdTimeline(rest);
      break;
    case 'projects':
      cmdProjects(rest);
      break;
    case 'dashboard':
      await cmdDashboard(rest);
      break;
    case 'making-of':
      await cmdMakingOf(rest);
      break;
    case 'turns':
      cmdTurns(rest);
      break;
    case 'memory':
      await cmdMemory(rest);
      break;
    case 'sync':
      cmdSync(rest);
      break;
    case 'adopt':
      cmdAdopt(rest);
      break;
    case 'resume':
      await cmdResume(rest);
      break;
    case 'pick':
      await cmdResume(['-i', ...rest]);
      break;
    case 'cursor':
    case 'copilot':
    case 'opencode':
      cmdSetDefaultEngine(cmd, rest);
      break;
    case 'engine':
      cmdEngine(rest);
      break;
    case 'rename':
      cmdRename(rest);
      break;
    case 'cwd':
    case 'set-cwd':
      cmdCwd(rest);
      break;
    case 'done':
      cmdDone(rest);
      break;
    case 'archive':
      await cmdArchive(rest);
      break;
    case 'unarchive':
      await cmdUnarchive(rest);
      break;
    case 'rm':
    case 'remove':
      await cmdRm(rest);
      break;
    case 'purge':
      await cmdPurge(rest);
      break;
    case 'orphans':
      await cmdOrphans(rest);
      break;
    case 'note':
      cmdNote(rest);
      break;
    case 'export':
      cmdExport(rest);
      break;
    case 'import-file':
      cmdImportFile(rest);
      break;
    case 'which-backend':
      process.stdout.write(backends.detectBackend() + '\n');
      break;
    case 'setup':
      cmdSetup(rest);
      break;
    case 'doctor':
      await cmdDoctor(rest);
      break;
    case 'notify':
      await cmdNotify(rest);
      break;
    case 'loop':
      await cmdLoop(rest);
      break;
    case 'service':
      cmdService(rest);
      break;
    case 'space':
      cmdSpace(rest);
      break;
    case 'eval':
      await cmdEval(rest);
      break;
    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

/**
 * aflt init <name>: start a looped project (folder, git, space, starter
 * SPEC.md / AGENTS.md / .agentfleet.json). Terminal-first; asks a few plain
 * questions on a TTY unless --yes.
 */
async function cmdInit(argv) {
  const { args, flags } = parseArgs(argv || []);
  const positional = args.slice();
  const asJson = recoverBoolFlag(flags, 'json', positional);
  const yes = recoverBoolFlag(flags, 'yes', positional) || recoverBoolFlag(flags, 'y', positional);
  const force = recoverBoolFlag(flags, 'force', positional);
  const noSpace = recoverBoolFlag(flags, 'no-space', positional);
  const existing = recoverBoolFlag(flags, 'existing', positional);
  const isolated = recoverBoolFlag(flags, 'isolated', positional);
  const usage =
    'usage: aflt init <name> [--dir PATH] [--space NAME | --no-space] [--engine cursor|copilot|opencode]\n' +
    '                 [--goal TEXT] [--stack TEXT] [--checks TEXT] [--budget-credits N] [--budget-hours N]\n' +
    '                 [--yes] [--existing] [--isolated] [--force] [--json]';
  if (flags.help || flags.h || positional[0] === 'help') {
    process.stdout.write(usage + '\n');
    return;
  }
  const name = positional[0];
  if (!name) fail(usage, { json: asJson });
  let engineName = null;
  if (flags.engine) {
    try {
      engineName = config.validateEngine(String(flags.engine));
    } catch (err) {
      fail(err.message, { json: asJson });
    }
  }
  const projectInit = require('../lib/project-init');
  const answers = {
    goal: typeof flags.goal === 'string' ? flags.goal : null,
    stack: typeof flags.stack === 'string' ? flags.stack : null,
    checks: typeof flags.checks === 'string' ? flags.checks : null,
    budgetCredits: flags['budget-credits'] != null && flags['budget-credits'] !== true ? flags['budget-credits'] : null,
    budgetHours: flags['budget-hours'] != null && flags['budget-hours'] !== true ? flags['budget-hours'] : null,
  };
  const dir = typeof flags.dir === 'string' ? path.resolve(flags.dir) : path.resolve(process.cwd(), require('../lib/loop-init').slugName(name));
  const docsExist = fs.existsSync(path.join(dir, 'SPEC.md')) && fs.existsSync(path.join(dir, 'AGENTS.md'));
  const interactive = !yes && !asJson && process.stdin.isTTY && (!docsExist || force);
  if (interactive) {
    await projectInit.askQuestions(answers);
  }
  let result;
  try {
    result = projectInit.initProject({
      name,
      dir,
      space: noSpace ? false : currentSpaceName() || null,
      engine: engineName,
      ...answers,
      force,
      existing,
      isolated,
      currentSpace: currentSpaceName() || null,
    });
  } catch (err) {
    fail(err.message || String(err), { json: asJson });
  }
  if (asJson) {
    emitJson(result);
    return;
  }
  const out = [];
  out.push(`project ${result.project} in ${result.dir}${result.createdDir ? ' (new folder)' : ''}`);
  out.push(`  git: ${result.git === 'initialized' ? 'initialized' : 'existing repo'}`);
  if (result.space) {
    out.push(`  space: ${result.space.name}${result.space.created ? ` (created, dashboard port ${result.space.port})` : ' (existing)'}`);
  } else {
    out.push('  space: (current)');
  }
  for (const f of result.files) {
    out.push(`  ${f.action.padEnd(11)} ${path.relative(result.dir, f.path) || f.path}`);
  }
  if (result.isolation && result.isolation.ok) out.push('  isolation: ok (no parent repo, parent or global instructions, or shared space)');
  for (const w of (result.isolation && result.isolation.warnings) || []) out.push(`  WARNING (isolation): ${w.message}`);
  out.push('', 'next:');
  for (const n of result.next) out.push(`  ${n}`);
  process.stdout.write(out.join('\n') + '\n');
}

/** aflt loop init: draft .agentfleet/loop.json from SPEC.md / AGENTS.md. */
async function cmdLoopInit(argvRest) {
  const { args, flags } = parseArgs(argvRest || []);
  const positional = args.slice();
  const asJson = recoverBoolFlag(flags, 'json', positional);
  const dryRun = recoverBoolFlag(flags, 'dry-run', positional);
  const force = recoverBoolFlag(flags, 'force', positional);
  const noDashboard = recoverBoolFlag(flags, 'no-dashboard', positional);
  const noAgents = recoverBoolFlag(flags, 'no-agents-pointer', positional);
  const noGate = recoverBoolFlag(flags, 'no-gate', positional);
  const isolated = recoverBoolFlag(flags, 'isolated', positional);
  const cwd = typeof flags.cwd === 'string' ? path.resolve(flags.cwd) : process.cwd();
  const loopInit = require('../lib/loop-init');
  // A project made by `aflt init` records its space; use it unless one was chosen.
  if (!currentSpaceName() && !require('../lib/util').envNonEmpty(process.env, 'AGENTFLEET_HOME')) {
    const pc = loopInit.readProjectConfig(cwd);
    if (pc.space) {
      try {
        applySpaceSelection({ sawSpace: true, spaceFlag: String(pc.space), env: process.env });
      } catch (err) {
        fail(err.message || String(err), { json: asJson });
      }
    }
  }
  let engineName = null;
  if (flags.engine) {
    try {
      engineName = config.validateEngine(String(flags.engine));
    } catch (err) {
      fail(err.message, { json: asJson });
    }
  }
  const str = (k) => (typeof flags[k] === 'string' ? flags[k] : null);
  const log = asJson ? () => {} : (m) => process.stderr.write(`${m}\n`);
  let result;
  try {
    result = await loopInit.initLoop({
      cwd,
      engine: engineName,
      model: str('model'),
      buildModel: str('build-model'),
      planModel: str('plan-model'),
      out: str('out'),
      dryRun,
      force,
      dashboard: !noDashboard,
      agentsPointer: !noAgents,
      gate: noGate ? false : undefined,
      isolated,
      budgetCredits: str('budget-credits'),
      budgetHours: str('budget-hours'),
      timeoutSec: str('timeout') ? Number(str('timeout')) : undefined,
      maxRepairs: str('max-repairs') != null ? Number(str('max-repairs')) : undefined,
      log,
    });
  } catch (err) {
    fail(err.message || String(err), { json: asJson });
  }
  if (asJson) {
    emitJson({ ...result, space: currentSpaceName() || null });
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (result.dryRun) {
    process.stdout.write(
      `dry-run: would ask ${result.engine} (build model ${result.models.build || 'default'}, plan model ${result.models.plan || 'default'}) to write ${result.outRel} and prompts in ${path.relative(result.cwd, result.promptsDir)}/\n` +
        `prompt (${result.promptChars} chars):\n\n${result.prompt}\n`
    );
    return;
  }
  for (const w of (result.isolation && result.isolation.warnings) || []) {
    process.stderr.write(`WARNING (isolation): ${w.message}\n`);
  }
  if (!result.ok) {
    process.stderr.write(`loop init failed: ${result.error || 'the draft did not pass the checks'}\n`);
    for (const e of result.errors || []) process.stderr.write(`  error: ${e}\n`);
    if (result.attempts && result.attempts.length) {
      process.stderr.write(`  (${result.attempts.length} attempt(s); draft left at ${result.out} for you to fix)\n`);
    }
    process.exitCode = 1;
    return;
  }
  const out = [];
  out.push(`drafted ${result.outRel} (${result.attempts.length} attempt(s)); validated and checks policy ok`);
  for (const line of result.summary) out.push(line);
  for (const w of result.warnings || []) out.push(`WARNING: ${w}`);
  if (result.usage) {
    const u = result.usage;
    const bits = [];
    if (u.totalTokens != null) bits.push(`${u.totalTokens} tok`);
    if (u.credits != null) bits.push(`${Number(u.credits).toFixed(2)} credits`);
    if (u.usd != null) bits.push('$' + Number(u.usd).toFixed(2));
    if (bits.length) out.push(`drafting cost: ${bits.join(' · ')}`);
  }
  if (result.agentsPointer) out.push(`AGENTS.md: ${result.agentsPointer.action} the aflt loop section`);
  if (result.dashboardCopy) out.push(`dashboard copy: ${result.dashboardCopy}`);
  const sp = currentSpaceName();
  out.push('', 'next:');
  for (const n of result.next) out.push(`  ${sp && n.startsWith('aflt ') ? n.replace(/^aflt /, `aflt --space ${sp} `) : n}`);
  process.stdout.write(out.join('\n') + '\n');
}

async function cmdNew(argv) {
  const { args, flags } = parseArgs(argv);
  const title = args[0];
  if (!title) {
    fail('usage: aflt new "<title>" [--cwd DIR] [--prompt "..."] [--model X] [--engine cursor|copilot|opencode]');
  }

  const cwd = resolveCwd(flags.cwd || flags.C);
  const prompt = flags.prompt || '';
  const model = flags.model || null;
  const tags = collectTags(flags);
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);
  const trust = !flags['no-trust'];

  let resolved;
  try {
    resolved = engine.resolveEngine({ flag: flags.engine });
  } catch (err) {
    fail(err.message);
  }
  const engineName = resolved.engine;

  let chatId;
  if (engineName === 'copilot') {
    if (dryRun) {
      chatId = '00000000-0000-4000-8000-000000000000';
      process.stderr.write('[dry-run] would mint a Copilot session id\n');
    } else {
      chatId = copilot.newSessionId();
      process.stderr.write(`Minted Copilot session id ${chatId}\n`);
    }
  } else if (engineName === 'opencode') {
    if (dryRun) {
      chatId = opencode.dryRunSessionId();
      process.stderr.write('[dry-run] would create an OpenCode session via opencode serve\n');
    } else {
      process.stderr.write(`Creating OpenCode session via ${opencode.resolveOpencodeBin()} serve…\n`);
      chatId = await opencode.createSession({ cwd, title });
      process.stderr.write(`Created OpenCode session ${chatId}\n`);
    }
  } else if (dryRun) {
    chatId = '00000000-0000-4000-8000-000000000000';
    process.stderr.write(`[dry-run] would run: ${cursor.resolveCursorBin()} create-chat\n`);
  } else {
    process.stderr.write(`Creating chat via ${cursor.resolveCursorBin()} create-chat…\n`);
    chatId = await cursor.createChat();
  }

  const messagingFlag = messages.normalizeMessagingFlag(flags);
  const entry = {
    title,
    chatId,
    cwd,
    branch: gitBranch(cwd),
    model,
    prompt,
    tags,
    status: 'active',
    engine: engineName,
  };
  if (messagingFlag !== null) entry.messaging = messagingFlag;
  applyProjectField(entry, flags);

  const launchOpts = {
    prompt: prompt || undefined,
    trust,
    force,
  };

  if (dryRun) {
    process.stderr.write(`[dry-run] would register: ${JSON.stringify(entry, null, 2)}\n`);
    const cmd = engine.buildInteractiveCommandString({ ...entry, chatId }, launchOpts);
    process.stdout.write(`cd ${JSON.stringify(cwd)} && ${cmd}\n`);
    return;
  }

  try {
    engine.assertEngineAvailable(entry);
  } catch (err) {
    fail(err.message);
  }

  const saved = registry.add(entry);
  printSession(saved, 'registered');

  // Set tab title then exec into interactive launch
  try {
    process.stdout.write(oscTitle(saved.title));
  } catch (_) {
    /* ignore */
  }

  const prepared = agentDocs.prepareLaunch(saved, {
    prompt: launchOpts.prompt,
    requestReason: 'aflt-new',
  });
  for (const w of prepared.warnings) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }
  const launchOptsPrepared = { ...launchOpts, prompt: prepared.prompt };
  const argvLaunch = engine.buildInteractiveCommand(saved, launchOptsPrepared);
  const launchEnv = { ...process.env, ...prepared.env };
  try {
    const receipt = runlib.recordInteractiveLaunch(saved.id, {
      engine: engineName,
      argv: argvLaunch,
      cwd,
      prompt: prepared.prompt || prompt || null,
      kind: 'interactive',
    });
    if (receipt) {
      registry.bestEffortUpdate(saved.id, {
        lastOutput: receipt,
        lastPrompt: prompt || prepared.prompt || null,
      });
    }
  } catch (_) {
    /* never block launch on receipt write */
  }
  const { code } = await engine.spawnInteractive(argvLaunch, { cwd, env: launchEnv });
  registry.bestEffortTouch(saved.id);
  process.exitCode = code || 0;
}

function cmdAdd(argv) {
  const { args, flags } = parseArgs(argv);
  const title = args[0];
  const chatId = flags.chat || flags.c;
  if (!title || !chatId) {
    fail('usage: aflt add "<title>" --chat <id> [--cwd DIR] [--engine cursor|copilot|opencode]');
  }

  // New row: same precedence as aflt new/run (--engine > AGENTFLEET_ENGINE > config > cursor).
  let engineName;
  try {
    engineName = engine.resolveEngine({ flag: flags.engine }).engine;
  } catch (err) {
    fail(err.message);
  }

  const cwd = resolveCwd(flags.cwd || flags.C);
  const entry = {
    title,
    chatId: String(chatId),
    cwd,
    branch: gitBranch(cwd),
    model: flags.model || null,
    prompt: flags.prompt || '',
    tags: collectTags(flags),
    status: 'active',
    engine: engineName,
  };
  applyProjectField(entry, flags);
  const saved = registry.add(entry);
  printSession(saved, 'added');
}

/**
 * Cursor import — kept byte-for-byte in behavior from the pre-Copilot path.
 * Explicit `aflt import cursor` / `--engine cursor` always lands here.
 */
function cmdImportCursor() {
  process.stdout.write(
    'Note: `cursor-agent ls` is interactive-only (no --print/--output-format).\n' +
      'Scanning local store ~/.cursor/chats/ instead.\n\n'
  );
  const chats = cursor.listLocalChats({ limit: 40 });
  if (chats.length === 0) {
    process.stdout.write(
      'No chats found under ~/.cursor/chats/.\n' +
        'Tips:\n' +
        '  • create-chat alone may not write files until a prompt is sent\n' +
        '  • use: aflt add "<title>" --chat <id> --cwd <dir>\n' +
        '  • or:  aflt new "<title>" to create + register in one step\n'
    );
    return;
  }
  const existing = new Set(registry.list().map((s) => s.chatId));
  process.stdout.write(
    `${pad('CHAT ID', 38)} ${pad('CWD', 40)} ${pad('MTIME', 20)} REG?\n`
  );
  for (const c of chats) {
    const reg = existing.has(c.chatId) ? 'yes' : 'no';
    const when = c.mtime ? new Date(c.mtime).toISOString() : '';
    process.stdout.write(
      `${pad(c.chatId, 38)} ${pad(c.cwd || '(unknown)', 40)} ${pad(when, 20)} ${reg}\n`
    );
  }
  process.stdout.write(
    `\nRegister one with:\n  aflt add "<title>" --chat <chatId> --cwd <dir>\n`
  );
}

function uniqueImportTitle(base, taken, { slug = true } = {}) {
  let candidate = slug
    ? slugify(base).slice(0, 40) || 'copilot'
    : String(base || '').trim() || 'copilot';
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  let title = `${candidate}-${n}`;
  while (taken.has(title)) {
    n++;
    title = `${candidate}-${n}`;
  }
  return title;
}

function formatUpdatedShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function printCopilotSessionTable(sessions, tracked) {
  process.stdout.write(
    `${pad('ID', 8)} ${pad('UPDATED', 20)} ${pad('FOLDER', 20)} ${pad('TRACKED', 7)} TITLE\n`
  );
  for (const s of sessions) {
    const mark = tracked.has(s.id) ? '✓' : '';
    const folder = s.cwd ? path.basename(s.cwd) : '';
    process.stdout.write(
      `${pad(shortId(s.id), 8)} ${pad(formatUpdatedShort(s.updated), 20)} ${pad(folder, 20)} ${pad(mark, 7)} ${s.title || ''}\n`
    );
  }
}

async function cmdImportCopilot(argv, flags) {
  const pick = Boolean(flags.pick || flags.i || flags.interactive);
  const asJson = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const allowMissing = Boolean(flags['allow-missing']);
  const importAll = Boolean(flags.all);
  const limitRaw = flags.limit != null && flags.limit !== true ? Number(flags.limit) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? limitRaw : 20;
  const cwdFilter = flags.cwd || flags.C || null;
  const titleFlag = flags.title != null && flags.title !== true ? String(flags.title) : null;
  const tags = collectTags(flags);

  let ids = Array.isArray(argv) ? [...argv] : [];

  if (pick) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail('interactive import requires a TTY (or pass session id(s) / --all)');
    }
    const sessions = copilot.listLocalSessions({
      limit: Math.max(limit, 50),
      cwd: cwdFilter || undefined,
    });
    if (sessions.length === 0) {
      process.stdout.write('No Copilot sessions found under session-state.\n');
      return;
    }
    const tracked = new Set(registry.list({ includeDone: true }).map((s) => s.chatId));
    process.stdout.write(
      `    ${pad('#', 3)} ${pad('ID', 8)} ${pad('UPDATED', 20)} ${pad('FOLDER', 20)} ${pad('TRACKED', 7)} TITLE\n`
    );
    sessions.forEach((s, i) => {
      const mark = tracked.has(s.id) ? '✓' : '';
      const folder = s.cwd ? path.basename(s.cwd) : '';
      process.stdout.write(
        `    ${pad(String(i + 1), 3)} ${pad(shortId(s.id), 8)} ${pad(formatUpdatedShort(s.updated), 20)} ${pad(folder, 20)} ${pad(mark, 7)} ${s.title || ''}\n`
      );
    });
    const readline = require('readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await rl.question('Select sessions to import (e.g. 1,3 or 1-3; a = all): ');
    } finally {
      rl.close();
    }
    let indexes;
    try {
      indexes = backends.parseResumeSelection(answer, sessions.length);
    } catch (err) {
      fail(err.message);
    }
    ids = indexes.map((i) => sessions[i].id);
    if (ids.length === 0) {
      process.stdout.write('No sessions selected.\n');
      return;
    }
  }

  // List mode: no ids and not --all / not post-pick
  if (ids.length === 0 && !importAll) {
    const sessions = copilot.listLocalSessions({
      limit,
      cwd: cwdFilter || undefined,
    });
    const tracked = new Set(registry.list({ includeDone: true }).map((s) => s.chatId));
    if (asJson) {
      emitJson({
            engine: 'copilot',
            sessions: sessions.map((s) => ({
              id: s.id,
              updated: s.updated,
              cwd: s.cwd,
              folder: s.cwd ? path.basename(s.cwd) : null,
              tracked: tracked.has(s.id),
              title: s.title,
              branch: s.branch,
              repository: s.repository,
              model: s.model,
              created: s.created,
            })),
          });
      return;
    }
    if (sessions.length === 0) {
      process.stdout.write(
        'No Copilot sessions found under ~/.copilot/session-state/.\n' +
          'Tips:\n' +
          '  • set AGENTFLEET_COPILOT_HOME if sessions live elsewhere\n' +
          '  • import by id: aflt import --engine copilot <uuid>\n' +
          '  • or: aflt add "<title>" --chat <uuid> --engine copilot --cwd <dir>\n'
      );
      return;
    }
    printCopilotSessionTable(sessions, tracked);
    process.stdout.write(
      `\nImport with:\n  aflt import --engine copilot <id|prefix> [...]\n  aflt import --engine copilot --all\n`
    );
    return;
  }

  if (importAll) {
    if (titleFlag) {
      fail('--title is only valid when importing a single session id');
    }
    const sessions = copilot.listLocalSessions({
      limit: limit || 10000,
      cwd: cwdFilter || undefined,
    });
    const tracked = new Set(registry.list({ includeDone: true }).map((s) => s.chatId));
    ids = sessions.filter((s) => !tracked.has(s.id)).map((s) => s.id);
    if (ids.length === 0) {
      process.stdout.write('No untracked Copilot sessions to import.\n');
      return;
    }
  }

  if (titleFlag && ids.length !== 1) {
    fail('--title is only valid when importing a single session id');
  }

  const tracked = new Set(registry.list({ includeDone: true }).map((s) => s.chatId));
  const takenTitles = new Set(registry.list({ includeDone: true }).map((s) => s.title));
  const unknown = [];
  let imported = 0;
  let skipped = 0;
  // --cwd overrides registered cwd for explicit id imports / --allow-missing.
  // For --all it only filters the candidate list (metadata cwd wins).
  const cwdOverrides = Boolean(cwdFilter) && !importAll;

  for (const rawId of ids) {
    let local = null;
    try {
      local = copilot.getLocalSession(rawId);
    } catch (err) {
      if (err.code === 'PREFIX_TOO_SHORT' || err.code === 'AMBIGUOUS_PREFIX') {
        fail(err.message);
      }
      throw err;
    }

    if (!local) {
      if (!allowMissing) {
        unknown.push(rawId);
        continue;
      }
      const fullId = String(rawId).trim();
      if (tracked.has(fullId)) {
        process.stdout.write(`already tracked: ${fullId} (skip)\n`);
        skipped++;
        continue;
      }
      const cwd = resolveCwd(cwdFilter);
      const title = titleFlag
        ? uniqueImportTitle(titleFlag, takenTitles, { slug: false })
        : uniqueImportTitle(`copilot-${shortId(fullId)}`, takenTitles, { slug: false });
      takenTitles.add(title);
      const entry = {
        title,
        chatId: fullId,
        cwd,
        branch: gitBranch(cwd),
        model: null,
        prompt: '',
        tags,
        status: 'active',
        engine: 'copilot',
      };
      applyProjectField(entry, flags);
      if (dryRun) {
        process.stdout.write(`[dry-run] would import ${fullId} as ${title} cwd=${cwd}\n`);
        imported++;
        continue;
      }
      const saved = registry.add(entry);
      tracked.add(saved.chatId);
      printSession(saved, 'imported');
      imported++;
      continue;
    }

    if (tracked.has(local.id)) {
      process.stdout.write(`already tracked: ${local.id} (skip)\n`);
      skipped++;
      continue;
    }

    const cwd = cwdOverrides
      ? resolveCwd(cwdFilter)
      : local.cwd
        ? copilot.realpathSafe(local.cwd)
        : resolveCwd();
    const model = typeof local.model === 'string' ? local.model : null;
    let title;
    if (titleFlag) {
      title = uniqueImportTitle(titleFlag, takenTitles, { slug: false });
    } else {
      const base =
        (local.title && String(local.title).trim()) || `copilot-${shortId(local.id)}`;
      title = uniqueImportTitle(base, takenTitles, { slug: true });
    }
    takenTitles.add(title);

    const entry = {
      title,
      chatId: local.id,
      cwd,
      branch: local.branch || gitBranch(cwd),
      model,
      prompt: local.firstPrompt || '',
      tags,
      status: 'active',
      engine: 'copilot',
    };
    applyProjectField(entry, flags);

    if (dryRun) {
      process.stdout.write(
        `[dry-run] would import ${local.id} as ${title} cwd=${cwd}` +
          (model ? ` model=${model}` : '') +
          `\n`
      );
      imported++;
      continue;
    }

    const saved = registry.add(entry);
    tracked.add(saved.chatId);
    printSession(saved, 'imported');
    imported++;
  }

  if (unknown.length) {
    process.stderr.write(
      `unknown Copilot session id(s): ${unknown.join(', ')}\n` +
        `(use --allow-missing to register anyway)\n`
    );
    process.exitCode = 1;
  }
}

async function cmdImport(argv) {
  const { args, flags } = parseArgs(argv || []);
  const positional = [...args];

  let engineFlag = flags.engine;
  if (
    (engineFlag == null || engineFlag === true || engineFlag === '') &&
    positional[0] &&
    (positional[0] === 'cursor' || positional[0] === 'copilot')
  ) {
    engineFlag = positional.shift();
  }

  let resolved;
  try {
    resolved = engine.resolveEngine({ flag: engineFlag });
  } catch (err) {
    fail(err.message);
  }

  if (resolved.engine === 'cursor') {
    // Preserve exact Cursor behavior (ignore copilot-only flags/ids).
    return cmdImportCursor();
  }
  if (resolved.engine !== 'copilot') {
    fail(`unsupported engine for import: ${resolved.engine}`);
  }
  return cmdImportCopilot(positional, flags);
}

function cmdLs(argv) {
  const { flags } = parseArgs(argv);
  const opts = {};
  if (flags.status) opts.status = flags.status;
  if (flags.tag) opts.tag = flags.tag;
  if (!flags.all && !flags.status) opts.includeDone = false;
  // Archived hidden by default; --archived or --all includes them.
  // --archived also includes done so archived-done rows are visible without --all.
  if (flags.archived) opts.includeDone = true;
  if (flags.all || flags.archived) opts.includeArchived = true;

  let sessions = registry.list(opts);
  const projectFilter = projectLib.normalizeProjectFilter(flags.project);
  const projectCache = projectLib.createLookupCache();
  if (projectFilter) {
    sessions = sessions.filter(
      (s) => projectLib.resolveProjectName(s, { cache: projectCache }) === projectFilter
    );
  }
  const activeSpace = currentSpaceName();
  if (sessions.length === 0 && !flags.json) {
    if (activeSpace) process.stdout.write(`space: ${activeSpace}\n`);
    process.stdout.write('(no sessions)\n');
    return;
  }

  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    process.stderr.write(`herdr: ${fetchResult.error || 'query failed'} (showing unknown/-)\n`);
  }
  const enriched = herdr.enrichSessions(sessions, fetchResult);

  if (flags.json) {
    const unreadMap = messages.unreadBySessionId(sessions);
    const rows = enriched.map((e) => {
      const eff = messages.isMessagingEnabled(e.session);
      // Display-only: do not persist reconcile patches. `aflt ls` never writes the registry.
      const derived = orchestrate.deriveWorkerStatus(
        e.session,
        {
          runtime: e.runtime,
          exitCode: e.exitCode,
        },
        { isAlive: orchestrate.defaultIsAlive, hostname: os.hostname() }
      );
      return {
        id: e.session.id,
        title: e.session.title,
        chatId: e.session.chatId,
        engine: e.session.engine || 'cursor',
        cwd: e.session.cwd,
        branch: e.session.branch || null,
        project: projectLib.resolveProjectName(e.session, { cache: projectCache }),
        parent: e.session.parent || null,
        status: e.session.status,
        archived: Boolean(e.session.archived),
        archivedAt: e.session.archivedAt || null,
        lastUsed: e.session.lastUsed || null,
        role: e.session.role || null,
        workerStatus: derived || null,
        messaging: eff.enabled,
        messagingSource: eff.source,
        unread: unreadMap[e.session.id] || 0,
        herdr: {
          runtime: herdr.displayRuntime(e.runtime),
          address: e.address,
          name: e.name,
          exitCode: e.exitCode,
          reason: e.reason,
          checkedAt: e.checkedAt,
        },
        herdrApp: (() => {
          const match =
            fetchResult.ok &&
            (fetchResult.terminals || []).find(
              (t) => t.afId && t.afId === e.session.id && herdr.isLiveTerminal(t)
            );
          const st = herdrapp.herdrAppStatus(e.session, match || null, {
            sessions,
          });
          return {
            space: st.space,
            tab: st.tab,
            spaceTitle: st.spaceTitle,
            ok: st.ok,
            legacy: st.legacy,
            needsAdopt: st.needsAdopt,
          };
        })(),
      };
    });
    emitJson({
      space: activeSpace || null,
      home: fleetDir(),
      sessions: rows,
      queryOk: Boolean(fetchResult.ok),
    });
    return;
  }

  if (activeSpace) process.stdout.write(`space: ${activeSpace}\n`);
  // Text table stays unchanged (already wide; project is in --json).
  process.stdout.write(
    `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('CHAT', 10)} ${pad('ENGINE', 8)} ${pad('FOLDER', 24)} ${pad('BRANCH', 12)} ${pad('STATUS', 8)} ${pad('HERDR', 8)} LAST USED\n`
  );
  for (const e of enriched) {
    const s = e.session;
    const folder = s.cwd ? path.basename(s.cwd) : '';
    process.stdout.write(
      `${pad(s.title, 24)} ${pad(displayId(s.id, ID_COL), ID_COL)} ${pad(shortId(s.chatId), 10)} ${pad(s.engine || 'cursor', 8)} ${pad(folder, 24)} ${pad(s.branch || '', 12)} ${pad(s.status, 8)} ${pad(herdr.displayRuntime(e.runtime), 8)} ${s.lastUsed || ''}\n`
    );
  }
}

/**
 * Read-only project↔repo mappings + validation. Never writes registry/memory/Herdr.
 */
function cmdProjects(argv) {
  const { args: rawArgs, flags } = parseArgs(argv);
  const args = rawArgs.slice();
  const asJson = docsRecoverBoolFlag(flags, 'json', args);
  const projectArg =
    args[0] && String(args[0]).trim() !== ''
      ? String(args[0]).trim()
      : flags.project != null && flags.project !== true
        ? String(flags.project).trim()
        : null;

  const report = projectMeta.buildProjectsReport({
    project: projectArg,
    env: process.env,
  });

  if (!report.ok) {
    fail(report.error || 'projects failed', { json: asJson });
  }

  if (asJson) {
    emitJson(report);
    return;
  }
  process.stdout.write(projectMeta.formatProjectsText(report));
}

/**
 * Read-only project timeline. Never writes registry/state; no Herdr calls.
 */
function cmdTimeline(argv) {
  const { args: rawArgs, flags } = parseArgs(argv);
  const args = rawArgs.slice();
  // parseArgs may bind `--json ops` / `--all ops` as values; recover the project.
  const asJson = docsRecoverBoolFlag(flags, 'json', args);
  const all = docsRecoverBoolFlag(flags, 'all', args);
  const projectArg =
    args[0] && String(args[0]).trim() !== ''
      ? String(args[0]).trim()
      : flags.project != null && flags.project !== true
        ? String(flags.project).trim()
        : projectLib.projectFromEnv(process.env);

  let since = null;
  if (flags.since != null && flags.since !== true) {
    try {
      since = timeline.parseSinceDate(String(flags.since));
    } catch (err) {
      fail(err.message, { json: asJson });
    }
  }

  // Read-only load (same as list); do not touch mtime via save.
  const sessions = registry.list({ includeDone: true });
  const cache = projectLib.createLookupCache();
  const payload = timeline.buildTimeline(sessions, {
    project: all ? null : projectArg,
    all,
    since,
    cwd: process.cwd(),
    cache,
  });

  if (asJson) {
    emitJson(payload);
    return;
  }

  const total = (payload.projects || []).reduce(
    (n, p) => n + timeline.flattenTree(p.sessions || []).length,
    0
  );
  if (total === 0) {
    process.stdout.write(
      all
        ? '(no sessions)\n'
        : `(no sessions for project ${payload.projects[0] ? payload.projects[0].project : projectArg || 'cwd'})\n`
    );
    return;
  }
  process.stdout.write(timeline.formatTimelineText(payload));
}

/**
 * Live local activity dashboard. Background refreshes are read-only by default.
 */
const MAKING_OF_USAGE =
  'usage: aflt making-of <loop> [--out file.html] [--data file.json] [--serve [--port 8797] [--host 127.0.0.1]]\n' +
  '                         [--build-url URL] [--build-label TEXT] [--seed PATH[,PATH...]] [--repo DIR]\n' +
  '                         [--no-diffs] [--with-files] [--json]\n' +
  '  --with-files  also write <out>-files/ (every commit diff + seed/eval/tracked files as small HTML pages) and link them,\n' +
  '                for static hosting without aflt';

/**
 * aflt making-of <loop>: one self-contained HTML page with every AI call
 * (prompt, reply, tool calls + results, tokens, cost), every commit with its
 * diff, and the run's artifacts. Space-scoped like the dashboard.
 */
async function cmdMakingOf(argv) {
  const makingOf = require('../lib/making-of');
  const view = require('../lib/making-of-view');
  const { expandUserPath } = require('../lib/util');
  const { args, flags } = parseArgs(argv);
  const asJson = recoverBoolFlag(flags, 'json', args);
  const loopName = args[0];
  if (!loopName || flags.help || flags.h) {
    const names = makingOf.listLoopNames();
    fail(
      `${MAKING_OF_USAGE}${names.length ? `\nloops in this space: ${names.join(', ')}` : '\n(no loops in this space; set AFLT_SPACE or --space)'}`,
      { json: asJson }
    );
  }
  const strFlag = (name) => (flags[name] != null && flags[name] !== true ? String(flags[name]) : null);
  const collectOpts = {
    withDiffs: !flags['no-diffs'],
    buildUrl: strFlag('build-url'),
    buildLabel: strFlag('build-label'),
    seeds: strFlag('seed')
      ? strFlag('seed').split(',').map((s) => path.resolve(expandUserPath(s.trim()))).filter(Boolean)
      : null,
    repo: strFlag('repo') ? path.resolve(expandUserPath(strFlag('repo'))) : null,
  };

  if (flags.serve) {
    const http = require('http');
    const host = strFlag('host') || '127.0.0.1';
    const port = strFlag('port') ? Number(strFlag('port')) : 8797;
    if (!makingOf.listLoopNames().includes(loopName)) {
      fail(`aflt making-of: no loop "${loopName}" in this space (${fleetDir()})`, { json: asJson });
    }
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', `http://${host}`);
      if (u.pathname === '/') {
        res.writeHead(302, { Location: `/making-of/${encodeURIComponent(loopName)}` });
        res.end();
        return;
      }
      const handled = makingOf.handleMakingOfRequest(req, res, u.pathname, {
        back: '/making-of',
        backLabel: '← all loops',
        collectOpts,
      });
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const url = `http://${host}:${server.address().port}/making-of/${encodeURIComponent(loopName)}`;
    if (asJson) emitJson({ ok: true, url, loop: loopName });
    else process.stdout.write(`aflt making-of: serving ${url} (Ctrl-C to stop)\n`);
    await new Promise((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return;
  }

  let data;
  try {
    data = makingOf.collectLoop(loopName, collectOpts);
  } catch (err) {
    fail(`aflt making-of: ${err.message || err}`, { json: asJson });
  }
  const outPath = strFlag('out')
    ? path.resolve(expandUserPath(strFlag('out')))
    : path.join(fleetDir(), 'loops', loopName, 'making-of.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  let exported = null;
  if (recoverBoolFlag(flags, 'with-files', args) || flags['with-files']) exported = makingOf.exportFiles(data, outPath);
  fs.writeFileSync(outPath, view.renderHtml(data));
  let dataPath = null;
  if (strFlag('data')) {
    dataPath = path.resolve(expandUserPath(strFlag('data')));
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    fs.writeFileSync(dataPath, JSON.stringify(data));
  }
  const T = data.totals;
  const summary = {
    ok: true,
    loop: loopName,
    path: outPath,
    data: dataPath,
    engine: data.run.engine,
    model: data.run.model,
    phases: data.phases.length,
    calls: T.calls,
    toolCalls: T.toolCalls,
    tokensIn: T.tokensIn || (T.aflt && T.aflt.totalInput) || null,
    tokensOut: T.tokensOut || (T.aflt && T.aflt.outputTokens) || null,
    credits: T.credits,
    usd: T.usd,
    costBasis: data.pricing.basis === 'recorded' ? 'recorded by Copilot' : 'not recorded',
    billedPrompts: T.billedPrompts,
    commits: data.commits.length,
    seeds: data.artifacts.seeds.length,
    prs: data.prs.length,
    files: exported,
  };
  if (asJson) {
    emitJson(summary);
    return;
  }
  const money =
    T.credits != null
      ? ` · ${T.credits.toFixed(1)} credits ($${T.usd.toFixed(2)}, recorded by Copilot)`
      : ' · cost not recorded';
  process.stdout.write(
    `${outPath}\n${data.run.engine || '?'} · ${data.run.model || '?'} · ${data.phases.length} phases · ` +
      `${T.calls} AI calls · ${T.toolCalls} tool calls${money} · ${data.commits.length} commits\n` +
      (exported ? `${exported.dir} (${exported.diffs} diffs, ${exported.files} files)\n` : '')
  );
}

async function cmdDashboard(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = recoverBoolFlag(flags, 'json', args);
  const serve = Boolean(flags.serve);
  const captureCompletions = Boolean(flags['capture-completions']);
  const snapshot =
    flags.snapshot != null && flags.snapshot !== true
      ? String(flags.snapshot)
      : args[0] && !serve
        ? String(args[0])
        : null;

  if (!serve && !snapshot) {
    fail(
      'usage: aflt dashboard --serve [--port 8787] [--host 127.0.0.1] [--json] [--capture-completions]\n' +
        '       aflt dashboard --snapshot <file.svg|html>',
      { json: asJson }
    );
  }

  if (serve && snapshot) {
    fail('aflt dashboard: use either --serve or --snapshot, not both', { json: asJson });
  }

  if (captureCompletions && !serve) {
    fail('--capture-completions requires --serve; snapshots never write completion notes', { json: asJson });
  }
  if (captureCompletions && !memory.resolveMemoryRepo()) {
    fail('--capture-completions requires a memory repo; run `aflt memory init <path>` first', { json: asJson });
  }

  if (snapshot) {
    let state;
    try {
      state = dashboard.collectState();
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    let outPath;
    try {
      outPath = dashboard.writeSnapshot(snapshot, state);
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    if (asJson) {
      emitJson({ ok: true, path: outPath, generatedAt: state.generatedAt });
    } else {
      process.stdout.write(outPath + '\n');
    }
    return;
  }

  let host = dashboard.DEFAULT_HOST;
  if (flags.host != null && flags.host !== true) {
    host = String(flags.host);
  }
  let port;
  try {
    port = spaceLib.resolveDashboardPort({
      port: flags.port != null && flags.port !== true ? flags.port : undefined,
    });
  } catch (err) {
    fail(err.message || String(err), { json: asJson });
  }

  try {
    await dashboard.serveDashboard({ host, port, json: asJson, captureCompletions });
  } catch (err) {
    fail(err.message || String(err), { json: asJson });
  }
}

/**
 * Interactive turn capture helpers. Default is dry-run; --apply writes turns.jsonl.
 */
function cmdTurns(argv) {
  const { args: rawArgs, flags } = parseArgs(argv);
  const args = rawArgs.slice();
  let sub = null;
  if (args[0] && !String(args[0]).startsWith('-')) {
    sub = String(args.shift());
  }
  const asJson = recoverBoolFlag(flags, 'json', args);
  const apply = recoverBoolFlag(flags, 'apply', args);
  const dryRunFlag = recoverBoolFlag(flags, 'dry-run', args);
  if (dryRunFlag && apply) {
    fail('--apply cannot be combined with --dry-run', { json: asJson });
  }

  if (!sub || sub === 'help') {
    fail(
      'usage: aflt turns backfill [<id|title>...] [--engine copilot|cursor|opencode|all] [--apply] [--json]\n' +
        '  Dry-run by default (report counts). Pass --apply to write runs/<id>/turns.jsonl.',
      { json: asJson }
    );
  }
  if (sub !== 'backfill') {
    fail(`unknown turns subcommand: ${sub}\nusage: aflt turns backfill …`, { json: asJson });
  }

  let engineFilter = 'all';
  if (flags.engine != null && flags.engine !== true) {
    engineFilter = String(flags.engine).toLowerCase();
    if (!['copilot', 'cursor', 'opencode', 'all'].includes(engineFilter)) {
      fail('--engine must be copilot, cursor, opencode, or all', { json: asJson });
    }
  }

  const queries = args.filter((a) => a && !String(a).startsWith('-'));
  let sessions;
  try {
    sessions = registry.list({ includeDone: true, includeArchived: true });
  } catch (err) {
    fail(err.message || String(err), { json: asJson });
  }

  let targets = sessions;
  if (queries.length) {
    targets = [];
    for (const q of queries) {
      const exact = registry.findExact(q);
      if (!exact) {
        const fuzzy = resolveSession.collectFuzzyCandidates(q, sessions);
        fail(
          fuzzy.length
            ? `no session matches "${q}" (did you mean ${fuzzy.map((s) => `${s.title} (${s.id})`).join(', ')}? turns backfill requires an exact id or title)`
            : `no session matches "${q}"`,
          { json: asJson }
        );
      }
      targets.push(exact);
    }
  }

  const result = turns.backfillTurns(targets, {
    apply,
    engine: engineFilter,
    env: process.env,
  });

  if (asJson) {
    emitJson(result);
    return;
  }

  const mode = apply ? 'apply' : 'dry-run';
  process.stdout.write(
    `turns backfill (${mode}, engine=${result.engine}): ` +
      `${result.totals.sessions} session(s), scanned ${result.totals.scanned}, ` +
      (apply
        ? `wrote ${result.totals.written}, skipped ${result.totals.skipped}\n`
        : `would write ${result.totals.wouldWrite}, skipped ${result.totals.skipped}\n`)
  );
  for (const row of result.sessions) {
    const detail = apply
      ? `written=${row.written} skipped=${row.skipped}`
      : `wouldWrite=${row.wouldWrite} skipped=${row.skipped}`;
    const skip = row.skippedReason ? ` (${row.skippedReason})` : '';
    process.stdout.write(
      `  ${row.id}  ${row.title}  ${row.engine}  scanned=${row.scanned}  ${detail}${skip}\n`
    );
  }
  if (result.errors && result.errors.length) {
    for (const err of result.errors) {
      process.stderr.write(`turns: ${err}\n`);
    }
  }
}

/**
 * Opt-in project memory repo: init / where / sync / dashboard / status.
 * Sync is read-only on the af registry; optional --commit/--push touches only
 * the memory git repo (generated paths: DASHBOARD.md and per-project _aflt/).
 */
async function cmdMemory(argv) {
  const { args: rawArgs, flags } = parseArgs(argv);
  const MEMORY_SUBS = new Set([
    'where',
    'init',
    'sync',
    'dashboard',
    'config',
    'refresh',
    'doc',
    'status',
  ]);
  const args = rawArgs.slice();
  // Take subcommand first so --json/--force before a path do not reorder it
  // (e.g. `memory init --json /path` → flags.json="/path", args=["init"]).
  let sub = null;
  if (args[0] && MEMORY_SUBS.has(String(args[0]))) {
    sub = args.shift();
  }
  const restArgs = args;
  const asJson = recoverBoolFlag(flags, 'json', restArgs);

  function parseActiveDaysFlag() {
    const v = flags['active-days'];
    if (v == null || v === false) return undefined;
    if (v === true) {
      fail('--active-days requires a positive integer', { json: asJson });
    }
    const n = parseInt(String(v), 10);
    if (!Number.isInteger(n) || n < 1 || String(n) !== String(v).trim()) {
      fail('--active-days must be a positive integer', { json: asJson });
    }
    return n;
  }

  function dashboardJson(dash) {
    if (!dash) return undefined;
    return {
      path: dash.path,
      changed: dash.changed,
      activeDays: dash.activeDays,
      active: dash.active,
      dormant: dash.dormant,
    };
  }

  if (!sub || sub === 'where') {
    const resolved = memory.resolveMemoryRepo();
    if (!resolved) {
      fail(
        'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.',
        { json: asJson }
      );
    }
    if (asJson) {
      emitJson({ ok: true, repo: resolved.path, source: resolved.source });
      return;
    }
    process.stdout.write(`${resolved.path} (${resolved.source})\n`);
    return;
  }

  if (sub === 'init') {
    const force = recoverBoolFlag(flags, 'force', restArgs);
    const target = restArgs[0];
    if (!target) {
      fail('usage: aflt memory init <path> [--force] [--json]', { json: asJson });
    }
    try {
      const result = memory.initMemoryRepo(target, { force });
      if (asJson) {
        emitJson(result);
        return;
      }
      process.stdout.write(
        result.created
          ? `initialized memory repo: ${result.repo}\n`
          : `registered memory repo: ${result.repo}\n`
      );
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    return;
  }

  if (sub === 'sync') {
    const dryRun = recoverBoolFlag(flags, 'dry-run', restArgs);
    const all = recoverBoolFlag(flags, 'all', restArgs);
    const includeAdhoc = recoverBoolFlag(flags, 'include-adhoc', restArgs);
    const noRedact = recoverBoolFlag(flags, 'no-redact', restArgs);
    const doCommit = recoverBoolFlag(flags, 'commit', restArgs);
    const doPush = recoverBoolFlag(flags, 'push', restArgs);
    const activeDays = parseActiveDaysFlag();
    const projects = restArgs.filter((a) => a && !String(a).startsWith('-'));

    if (doPush && !doCommit) {
      fail('--push requires --commit', { json: asJson });
    }
    if (doCommit && dryRun) {
      fail('--commit cannot be used with --dry-run', { json: asJson });
    }

    const sessions = registry.list({ includeDone: true });
    try {
      const result = memory.syncMemory(sessions, {
        projects,
        all,
        includeAdhoc,
        dryRun,
        redact: !noRedact,
        activeDays,
        cwd: process.cwd(),
      });

      let commitInfo = null;
      if (doCommit) {
        commitInfo = memory.commitGenerated(result.repo, { push: doPush });
      }

      const commitJson = commitInfo
        ? {
            committed: commitInfo.committed,
            hash: commitInfo.hash,
            files: commitInfo.files,
            message: commitInfo.message,
            reason: commitInfo.reason,
          }
        : undefined;
      const pushJson = commitInfo && commitInfo.push
        ? {
            pushed: commitInfo.push.pushed,
            upstream: commitInfo.push.upstream,
            reason: commitInfo.push.reason,
          }
        : undefined;

      const pushFailed =
        Boolean(doPush) &&
        commitInfo &&
        commitInfo.push &&
        commitInfo.push.pushed === false &&
        commitInfo.push.reason !== 'nothing to push';

      if (asJson) {
        const payload = {
          ok: !pushFailed,
          repo: result.repo,
          projects: result.projects.map((p) => ({
            project: p.project,
            folder: p.folder,
            sessions: p.sessions,
            files: p.files.map((f) => ({ path: f.path, changed: f.changed })),
          })),
          dashboard: dashboardJson(result.dashboard),
        };
        if (commitJson) payload.commit = commitJson;
        if (pushJson) payload.push = pushJson;
        emitJson(payload);
        if (pushFailed) process.exit(1);
        return;
      }
      if (dryRun) {
        for (const p of result.projects) {
          process.stdout.write(`# ${p.project} → ${p.folder}/ (${p.sessions} sessions)\n`);
          for (const f of p.files) {
            const mark = f.changed ? 'write' : 'skip';
            process.stdout.write(
              `  [${mark}] ${f.path}${f.bytes != null ? ` (${f.bytes} bytes)` : ''}\n`
            );
          }
        }
        if (result.dashboard) {
          const mark = result.dashboard.changed ? 'write' : 'skip';
          process.stdout.write(
            `  [${mark}] ${result.dashboard.path}` +
              `${result.dashboard.bytes != null ? ` (${result.dashboard.bytes} bytes)` : ''}` +
              ` (active ${result.dashboard.active}, dormant ${result.dashboard.dormant})\n`
          );
        }
        return;
      }
      let changed = 0;
      for (const p of result.projects) {
        for (const f of p.files) {
          if (f.changed) changed++;
        }
      }
      if (result.dashboard && result.dashboard.changed) changed++;
      process.stdout.write(
        `memory sync: ${result.projects.length} project(s), ${changed} file(s) updated → ${result.repo}\n`
      );
      if (result.dashboard) {
        process.stdout.write(
          `memory dashboard: ${result.dashboard.path}` +
            ` (active ${result.dashboard.active}, dormant ${result.dashboard.dormant}` +
            `, ${result.dashboard.activeDays}d)\n`
        );
      }
      if (commitInfo) {
        if (commitInfo.committed) {
          process.stdout.write(
            `memory commit: ${commitInfo.hash} (${commitInfo.files} file(s)) "${commitInfo.message}"\n`
          );
        } else {
          process.stdout.write(`memory commit: no changes\n`);
        }
        if (commitInfo.push) {
          if (commitInfo.push.pushed) {
            process.stdout.write(`memory push: ok (${commitInfo.push.upstream})\n`);
          } else if (commitInfo.push.reason === 'nothing to push') {
            process.stdout.write(`memory push: nothing to push\n`);
          } else if (commitInfo.push.reason === 'no upstream') {
            process.stderr.write(
              `memory push: failed (no upstream)` +
                (commitInfo.committed && commitInfo.hash
                  ? `; commit ${commitInfo.hash} kept`
                  : '') +
                '\n'
            );
          } else {
            process.stderr.write(
              `memory push: failed (${commitInfo.push.reason})` +
                (commitInfo.committed && commitInfo.hash
                  ? `; commit ${commitInfo.hash} kept`
                  : '') +
                '\n'
            );
          }
        }
      }
      if (pushFailed) process.exit(1);
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    return;
  }

  if (sub === 'dashboard') {
    const dryRun = recoverBoolFlag(flags, 'dry-run', restArgs);
    const noRedact = recoverBoolFlag(flags, 'no-redact', restArgs);
    const includeAdhoc = recoverBoolFlag(flags, 'include-adhoc', restArgs);
    const activeDays = parseActiveDaysFlag();
    const sessions = registry.list({ includeDone: true });
    try {
      const result = memory.syncDashboard(sessions, {
        dryRun,
        redact: !noRedact,
        includeAdhoc,
        activeDays,
        cwd: process.cwd(),
      });
      if (asJson) {
        emitJson({
          ok: true,
          repo: result.repo,
          source: result.source,
          dashboard: dashboardJson(result.dashboard),
        });
        return;
      }
      if (dryRun) {
        const d = result.dashboard;
        const mark = d.changed ? 'write' : 'skip';
        process.stdout.write(
          `[${mark}] ${d.path}${d.bytes != null ? ` (${d.bytes} bytes)` : ''}` +
            ` (active ${d.active}, dormant ${d.dormant}, ${d.activeDays}d)\n`
        );
        return;
      }
      const d = result.dashboard;
      process.stdout.write(
        `memory dashboard: ${d.path}` +
          `${d.changed ? ' updated' : ' unchanged'}` +
          ` (active ${d.active}, dormant ${d.dormant}, ${d.activeDays}d) → ${result.repo}\n`
      );
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    return;
  }

  if (sub === 'config' || sub === 'refresh') {
    const apply = recoverBoolFlag(flags, 'apply', restArgs);
    const noRedact = recoverBoolFlag(flags, 'no-redact', restArgs);
    const includeAdhoc = recoverBoolFlag(flags, 'include-adhoc', restArgs);
    const doCommit = recoverBoolFlag(flags, 'commit', restArgs);
    const doPush = recoverBoolFlag(flags, 'push', restArgs);
    const activeDays = parseActiveDaysFlag();

    if (doPush && !doCommit) {
      fail('--push requires --commit', { json: asJson });
    }
    if (doCommit && !apply) {
      fail('--commit requires --apply', { json: asJson });
    }

    const sessions = registry.list({ includeDone: true });
    try {
      const result = memory.configMemory(sessions, {
        apply,
        redact: !noRedact,
        includeAdhoc,
        activeDays,
        cwd: process.cwd(),
      });

      let commitInfo = null;
      if (doCommit) {
        commitInfo = memory.commitGenerated(result.repo, {
          push: doPush,
          mode: 'config',
        });
      }

      const commitJson = commitInfo
        ? {
            committed: commitInfo.committed,
            hash: commitInfo.hash,
            files: commitInfo.files,
            message: commitInfo.message,
            reason: commitInfo.reason,
          }
        : undefined;
      const pushJson =
        commitInfo && commitInfo.push
          ? {
              pushed: commitInfo.push.pushed,
              upstream: commitInfo.push.upstream,
              reason: commitInfo.push.reason,
            }
          : undefined;

      const pushFailed =
        Boolean(doPush) &&
        commitInfo &&
        commitInfo.push &&
        commitInfo.push.pushed === false &&
        commitInfo.push.reason !== 'nothing to push';

      if (asJson) {
        const payload = {
          ok: !pushFailed,
          repo: result.repo,
          source: result.source,
          apply: result.apply,
          dryRun: result.dryRun,
          needsUpdate: result.needsUpdate,
          files: result.files.map((f) => ({
            path: f.path,
            status: f.status,
            diff: f.diff,
            backedUp: f.backedUp,
            bak: f.bak,
            written: f.written,
          })),
          dashboard: dashboardJson(result.dashboard),
        };
        if (commitJson) payload.commit = commitJson;
        if (pushJson) payload.push = pushJson;
        emitJson(payload);
        if (pushFailed) process.exit(1);
        return;
      }

      for (const f of result.files) {
        const bakNote = f.backedUp && f.bak ? ` (backup ${f.bak})` : '';
        process.stdout.write(`[${f.status}] ${f.path}: ${f.diff}${bakNote}\n`);
      }
      if (result.dashboard) {
        const d = result.dashboard;
        if (result.dryRun) {
          const mark = d.changed ? 'write' : 'skip';
          process.stdout.write(
            `[${mark}] ${d.path}` +
              `${d.bytes != null ? ` (${d.bytes} bytes)` : ''}` +
              ` (active ${d.active}, dormant ${d.dormant}, ${d.activeDays}d)\n`
          );
        } else {
          process.stdout.write(
            `memory dashboard: ${d.path}` +
              `${d.changed ? ' updated' : ' unchanged'}` +
              ` (active ${d.active}, dormant ${d.dormant}, ${d.activeDays}d) → ${result.repo}\n`
          );
        }
      }
      if (result.dryRun && result.needsUpdate) {
        process.stdout.write('hint: re-run with --apply to write template files\n');
      }
      if (commitInfo) {
        if (commitInfo.committed) {
          process.stdout.write(
            `memory commit: ${commitInfo.hash} (${commitInfo.files} file(s)) "${commitInfo.message}"\n`
          );
        } else {
          process.stdout.write(`memory commit: no changes\n`);
        }
        if (commitInfo.push) {
          if (commitInfo.push.pushed) {
            process.stdout.write(`memory push: ok (${commitInfo.push.upstream})\n`);
          } else if (commitInfo.push.reason === 'nothing to push') {
            process.stdout.write(`memory push: nothing to push\n`);
          } else if (commitInfo.push.reason === 'no upstream') {
            process.stderr.write(
              `memory push: failed (no upstream)` +
                (commitInfo.committed && commitInfo.hash
                  ? `; commit ${commitInfo.hash} kept`
                  : '') +
                '\n'
            );
          } else {
            process.stderr.write(
              `memory push: failed (${commitInfo.push.reason})` +
                (commitInfo.committed && commitInfo.hash
                  ? `; commit ${commitInfo.hash} kept`
                  : '') +
                '\n'
            );
          }
        }
      }
      if (pushFailed) process.exit(1);
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    return;
  }

  if (sub === 'doc') {
    const dryRun = recoverBoolFlag(flags, 'dry-run', restArgs);
    const force = recoverBoolFlag(flags, 'force', restArgs);
    const engineFlag = flags.engine && flags.engine !== true ? String(flags.engine) : null;
    const modelFlag = flags.model && flags.model !== true ? String(flags.model) : null;
    const timeoutFlag = flags.timeout != null && flags.timeout !== true ? String(flags.timeout) : null;

    const resolved = memory.resolveMemoryRepo();
    if (!resolved) {
      fail(
        'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.',
        { json: asJson }
      );
    }
    const docPath = path.join(resolved.path, memory.DOC_AGENT_REL);
    if (!fs.existsSync(docPath)) {
      fail(
        `missing ${memory.DOC_AGENT_REL} in ${resolved.path}. Re-run \`aflt memory init\` on this repo or copy templates/${memory.DOC_AGENT_REL} from the aflt package.`,
        { json: asJson }
      );
    }
    let prompt;
    try {
      prompt = fs.readFileSync(docPath, 'utf8');
    } catch (err) {
      fail(`cannot read ${docPath}: ${err.message || err}`, { json: asJson });
    }
    if (!String(prompt || '').trim()) {
      fail(`${memory.DOC_AGENT_REL} is empty: ${docPath}`, { json: asJson });
    }

    const docSession = registry.findExact('doc-bot') || registry.findExact('memory-doc');
    const runArgv = [
      docSession ? docSession.id : 'doc-bot',
      '--cwd',
      resolved.path,
      '--project',
      'aflt-memory',
      '--prompt',
      prompt,
      '--no-docs',
    ];
    if (engineFlag) runArgv.push('--engine', engineFlag);
    if (modelFlag) runArgv.push('--model', modelFlag);
    if (timeoutFlag) runArgv.push('--timeout', timeoutFlag);
    if (force) runArgv.push('--force');
    if (dryRun) runArgv.push('--dry-run');
    if (asJson) runArgv.push('--json');
    await cmdRun(runArgv);
    return;
  }

  if (sub === 'status') {
    const sessions = registry.list({ includeDone: true });
    try {
      const result = memory.memoryStatus(sessions, { cwd: process.cwd() });
      if (asJson) {
        emitJson(result);
        return;
      }
      process.stdout.write(`repo: ${result.repo} (${result.source})\n`);
      process.stdout.write(
        `git: ${result.isGit ? 'yes' : 'no'}` +
          (result.dirtyCount != null ? `  dirty: ${result.dirtyCount}` : '') +
          '\n'
      );
      for (const p of result.projects) {
        process.stdout.write(
          `${p.project}  folder=${p.folderExists ? 'yes' : 'no'}  sessions=${p.sessions}  stale=${p.stale ? 'yes' : 'no'}  lastSync=${p.lastSync || '-'}\n`
        );
      }
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    return;
  }

  fail(
    `unknown memory subcommand: ${sub}\nusage: aflt memory [where|init|sync|dashboard|config|doc|status] …`,
    { json: asJson }
  );
}

function backupRegistryPath() {
  // YYYYMMDDTHHMMSSZ
  const compact = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.dirname(registryPath());
  let candidate = path.join(dir, `sessions.json.bak-${compact}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `sessions.json.bak-${compact}-${n}`);
    n++;
  }
  return candidate;
}

function cmdSync(argv) {
  const { flags } = parseArgs(argv);
  const dryRun = Boolean(flags['dry-run']);
  const asJson = Boolean(flags.json);

  const sessions = registry.list({ includeDone: true });
  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    process.stderr.write(`herdr sync failed: ${fetchResult.error || 'query failed'}\n`);
    process.exitCode = 1;
    if (asJson) {
      emitJson({ ok: false, error: fetchResult.error, dryRun, updated: [] });
    }
    return;
  }

  const enriched = herdr.enrichSessions(sessions, fetchResult);
  const toPersist = enriched.filter((e) => e.persistable);

  if (!dryRun && toPersist.length > 0) {
    const bak = backupRegistryPath();
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(registryPath(), bak);
    process.stderr.write(`backup: ${bak}\n`);
    let cosmeticWarned = false;
    for (const e of toPersist) {
      const wr = registry.bestEffortUpdate(e.session.id, { herdr: herdr.herdrEvidence(e) });
      if (!wr.ok && !cosmeticWarned) {
        cosmeticWarned = true;
        if (!asJson) {
          process.stderr.write(`warning: cosmetic registry write failed: ${wr.error}\n`);
        }
      }
    }
  }

  const rows = toPersist.map((e) => ({
    title: e.session.title,
    id: e.session.id,
    runtime: e.runtime,
    address: e.address,
    name: e.name,
    exitCode: e.exitCode,
    reason: e.reason,
    status: e.session.status,
    lastUsed: e.session.lastUsed,
    checkedAt: e.checkedAt,
  }));

  if (asJson) {
    emitJson({
          ok: true,
          dryRun,
          checkedAt: fetchResult.checkedAt,
          updated: rows,
        });
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(dryRun ? '(nothing would be persisted)\n' : '(nothing to sync)\n');
    return;
  }

  process.stdout.write(
    `${dryRun ? '[dry-run] would persist' : 'synced'} ${rows.length} session${rows.length === 1 ? '' : 's'}:\n`
  );
  for (const r of rows) {
    const where = r.address || r.name || '-';
    const exit =
      r.runtime === 'exited' && (r.exitCode != null || r.reason)
        ? ` exit=${r.exitCode != null ? r.exitCode : '?'} reason=${r.reason || '?'}`
        : '';
    process.stdout.write(
      `  ${r.title} (${shortId(r.id)})  ${r.runtime}  ${where}${exit}\n`
    );
  }
}

async function cmdResume(argv) {
  const { args, flags } = parseArgs(argv);
  if (flags.all) {
    await cmdResumeAll(flags);
    return;
  }

  const pick = Boolean(flags.i || flags.interactive || flags.pick);
  if (pick || args.length === 0) {
    await cmdResumePick(flags);
    return;
  }

  const query = args[0];
  if (!query) fail('usage: aflt resume <title|id>  OR  aflt resume --all [--via …]');

  const session = registry.find(query);
  if (!session) fail(`session not found: ${query}`);

  // Resume restores chat context via --resume; do not resend session.prompt.
  // An explicit --prompt on this invocation may still be passed.
  const resumeOpts = buildResumeOpts(flags);

  let resolved;
  try {
    resolved = backends.resolveSingleResumeVia(flags);
  } catch (err) {
    fail(err.message);
  }
  if (resolved.note) process.stderr.write(`${resolved.note}\n`);

  if (resolved.via === 'herdr') {
    if (!flags['dry-run']) {
      try {
        engine.assertEngineAvailable(session);
      } catch (err) {
        fail(err.message);
      }
    }
    const plan = launchViaHerdr([session], {
      dryRun: Boolean(flags['dry-run']),
      resumeOpts,
      flags,
      json: Boolean(flags.json),
    });
    reportHerdr(plan, flags);
    return;
  }

  if (flags['dry-run']) {
    process.stderr.write(
      `Resuming "${session.title}" (${shortId(session.chatId)}, ${session.engine || 'cursor'}) in ${session.cwd}\n`
    );
    process.stdout.write(
      `cd ${JSON.stringify(session.cwd)} && ${engine.buildInteractiveCommandString(session, resumeOpts)}\n`
    );
    return;
  }

  try {
    process.stdout.write(oscTitle(session.title));
  } catch (_) {
    /* ignore */
  }

  process.stderr.write(
    `Resuming "${session.title}" (${shortId(session.chatId)}, ${session.engine || 'cursor'}) in ${session.cwd}\n`
  );
  registry.bestEffortTouch(session.id);
  try {
    engine.assertEngineAvailable(session);
  } catch (err) {
    fail(err.message);
  }
  const prepared = agentDocs.prepareLaunch(session, {
    prompt: resumeOpts.prompt,
    requestReason: 'aflt-resume',
  });
  for (const w of prepared.warnings) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }
  const resumeOptsPrepared = { ...resumeOpts, prompt: prepared.prompt };
  const argvLaunch = engine.buildInteractiveCommand(session, resumeOptsPrepared);
  const launchEnv = { ...process.env, ...prepared.env };
  try {
    const receipt = runlib.recordInteractiveLaunch(session.id, {
      engine: session.engine || 'cursor',
      argv: argvLaunch,
      cwd: session.cwd,
      prompt: prepared.prompt || resumeOpts.prompt || null,
      kind: 'interactive',
    });
    if (receipt) {
      registry.bestEffortUpdate(session.id, {
        lastOutput: receipt,
        lastPrompt: resumeOpts.prompt || prepared.prompt || null,
      });
    }
  } catch (_) {
    /* never block launch on receipt write */
  }
  const { code } = await engine.spawnInteractive(argvLaunch, {
    cwd: session.cwd,
    env: launchEnv,
  });
  process.exitCode = code || 0;
}

function buildResumeOpts(flags = {}) {
  const resumeOpts = {
    trust: !flags['no-trust'],
    force: Boolean(flags.force),
    herdrApp: herdrapp.herdrAppEnabled(flags),
    // Pool for worker → master space title lookup.
    sessions: registry.list({ includeDone: true }),
  };
  if (typeof flags.prompt === 'string' && flags.prompt) resumeOpts.prompt = flags.prompt;
  return resumeOpts;
}

function cmdSetDefaultEngine(name, argv) {
  const { args } = parseArgs(argv);
  if (args.length > 0) fail(`usage: aflt ${name}`);
  let engineName;
  try {
    engineName = config.setDefaultEngine(name);
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(`default engine set to ${engineName} (${config.configPath()})\n`);
}

function cmdEngine(argv) {
  const { args } = parseArgs(argv);
  if (args.length === 0) {
    let resolved;
    try {
      resolved = engine.resolveEngine({});
    } catch (err) {
      fail(err.message);
    }
    process.stdout.write(
      `default engine: ${resolved.engine} (from ${resolved.source})\n` +
        `config: ${config.configPath()}\n`
    );
    return;
  }
  if (args.length !== 1) fail('usage: aflt engine [cursor|copilot|opencode]');
  let engineName;
  try {
    engineName = config.setDefaultEngine(args[0]);
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(`default engine set to ${engineName} (${config.configPath()})\n`);
}

async function cmdResumeAll(flags) {
  const via = flags.via || undefined;
  const tag = flags.tag || undefined;
  const dryRun = Boolean(flags['dry-run']);
  let sessions = registry.list({ status: 'active', tag });
  if (sessions.length === 0) {
    process.stdout.write('No active sessions to resume.\n');
    return;
  }

  if (!dryRun) {
    for (const s of sessions) {
      try {
        engine.assertEngineAvailable(s);
      } catch (err) {
        fail(`${s.title}: ${err.message}`);
      }
    }
  }

  const resumeOpts = buildResumeOpts(flags);
  const detected = via || backends.detectBackend();
  const planDry = dryRun || detected === 'plain';
  let plan;
  if (detected === 'herdr') {
    plan = launchViaHerdr(sessions, {
      dryRun: planDry,
      resumeOpts,
      flags,
      json: Boolean(flags.json),
    });
  } else {
    plan = backends.executeResumeAll(sessions, {
      via,
      tmuxSession: flags['tmux-session'],
      dryRun: planDry,
      resumeOpts,
    });
  }

  process.stderr.write(
    `resume --all via ${plan.backend} (${sessions.length} session${sessions.length === 1 ? '' : 's'})${dryRun || !plan.executed ? ' [dry]' : ''}\n`
  );

  if (plan.backend === 'herdr') {
    reportHerdr(plan, { ...flags, 'dry-run': dryRun || !plan.executed });
    return;
  }

  if (plan.backend === 'plain' || dryRun) {
    if (plan.backend === 'iterm2' && plan.applescript) {
      process.stdout.write('# AppleScript:\n');
      process.stdout.write(plan.applescript);
      process.stdout.write('\n# Or per-session:\n');
    }
    for (const c of plan.commands) {
      if (c.shell) process.stdout.write(c.shell + '\n');
      else if (c.command) process.stdout.write(c.command + '\n');
    }
    if (plan.backend === 'tmux') {
      const attach = plan.commands.find((c) => c.kind === 'attach-hint');
      if (attach) process.stdout.write(`# then: ${attach.shell}\n`);
    }
    return;
  }

  // Mark lastUsed
  for (const s of sessions) {
    try {
      registry.bestEffortTouch(s.id);
    } catch (_) {
      /* ignore */
    }
  }

  if (plan.backend === 'tmux') {
    const hint = (plan.results || []).find((r) => r.step === 'attach-hint');
    process.stdout.write(
      `Opened ${sessions.length} window(s) in tmux session "${plan.tmuxSession}".\n` +
        `Attach with: tmux attach -t ${plan.tmuxSession}\n`
    );
    if (hint?.message) process.stderr.write(`${hint.message}\n`);
  } else if (plan.backend === 'wezterm') {
    process.stdout.write(`Spawned ${sessions.length} WezTerm tab(s).\n`);
  } else if (plan.backend === 'iterm2') {
    process.stdout.write(`Opened ${sessions.length} iTerm2 tab(s).\n`);
  }
}

function reportHerdr(plan, flags = {}) {
  const dryRun = Boolean(flags['dry-run'] || flags.dryRun) || !plan.executed;
  const asJson = Boolean(flags.json);
  if (dryRun || !plan.executed) {
    if (!asJson) {
      for (const c of plan.commands || []) {
        process.stdout.write(c.shell + '\n');
        if (c.name) process.stdout.write(backends.herdrAttachLine(c.name) + '\n');
      }
      maybeOpenITermAttach(plan, flags, { executed: false, dryRun: true });
    }
    return;
  }
  let ok = 0;
  let relaunched = 0;
  for (const r of plan.results || []) {
    if (r.busy) {
      process.stderr.write(`skip "${r.title}": already running/launching\n`);
      continue;
    }
    if (r.skipped) {
      process.stderr.write(`skip "${r.title}": already live in herdr\n`);
      if (!asJson && r.name) process.stdout.write(backends.herdrAttachLine(r.name) + '\n');
    } else if (r.status === 0) {
      ok++;
      if (r.relaunch) relaunched++;
      try {
        const cmd = (plan.commands || []).find((c) => c.title === r.title);
        if (cmd && cmd.id) {
          const runId = crypto.randomUUID();
          const runStartedAt = nowIso();
          let resultMtimeAtStart = null;
          try {
            const sess = registry.find(cmd.id);
            const rp = sess && (sess.result || orchestrate.defaultResultPath(sess.id));
            if (rp && fs.existsSync(rp)) resultMtimeAtStart = fs.statSync(rp).mtimeMs;
          } catch (_) {}
          registry.criticalUpdate(
            cmd.id,
            { runId, runStartedAt, resultMtimeAtStart, resultRunId: null },
            { phase: 'after-spawn' }
          );
          registry.bestEffortTouch(cmd.id);
        }
      } catch (_) { /* ignore */ }
      if (!asJson && r.name) process.stdout.write(backends.herdrAttachLine(r.name) + '\n');
      if (r.tabRename && r.tabRename.ok === false && !r.tabRename.skipped) {
        process.stderr.write(
          `herdr-app tab.rename failed for "${r.title}": ${r.tabRename.reason || r.tabRename.error || ''}\n`
        );
      }
      if (r.spaceRename && r.spaceRename.ok === false && !r.spaceRename.skipped) {
        process.stderr.write(
          `herdr-app space.rename failed for "${r.title}": ${r.spaceRename.reason || r.spaceRename.error || ''}\n`
        );
      }
    } else {
      const kind = r.relaunch ? 'hc send' : 'hc run';
      process.stderr.write(`${kind} failed for "${r.title}": ${r.stderr || ''}\n`);
    }
  }
  if (!asJson) {
    if (relaunched && relaunched === ok) {
      process.stdout.write(`Relaunched agent in ${ok} shell-only Herdr terminal(s).\n`);
    } else if (relaunched) {
      process.stdout.write(
        `Launched ${ok - relaunched} Herdr terminal(s); relaunched agent in ${relaunched} shell-only tab(s).\n`
      );
    } else {
      process.stdout.write(`Launched ${ok} Herdr terminal(s).\n`);
    }
    maybeOpenITermAttach(plan, flags, { executed: true, dryRun: false });
  }
  if ((plan.results || []).some((r) => r.busy || (!r.skipped && r.status != null && r.status !== 0))) {
    process.exitCode = 1;
  }
}

function maybeOpenITermAttach(plan, flags, { executed, dryRun }) {
  if (!backends.wantITermOpen(flags)) return;
  const entries = backends.herdrAttachEntries(plan, { executed });
  if (entries.length === 0) return;
  const script = backends.buildITermAttachAppleScript(entries);
  if (dryRun) {
    process.stdout.write('# would open iTerm2 tab(s) running hc attach (absolute hc path):\n');
    process.stdout.write(script);
    return;
  }
  if (!backends.canOpenITerm()) {
    process.stderr.write('iTerm/osascript unavailable; printed attach commands instead\n');
    return;
  }
  const { spawnSync } = require('child_process');
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`osascript failed; printed attach commands instead: ${r.stderr || r.stdout || ''}\n`);
  } else {
    process.stdout.write(`Opened ${entries.length} iTerm2 tab(s).\n`);
  }
}

async function cmdResumePick(flags) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      'usage: aflt resume <title|id>  OR  aflt resume --all [--via …]\n' +
        'interactive selection requires a TTY (or pass a title / --all)'
    );
  }

  let resolved;
  try {
    resolved = backends.resolveSingleResumeVia({ ...flags, here: false, via: flags.via });
  } catch (err) {
    fail(err.message);
  }
  // Picker always uses the Herdr path (skip if already live, print attach lines).
  if (flags.here || flags.via === 'plain' || flags.via === 'here') {
    fail('interactive resume uses Herdr; drop --here / --via plain, or resume one title with --here');
  }
  if (resolved.via !== 'herdr') {
    fail('interactive resume requires Herdr (hc on PATH); use aflt resume <title> --here for this terminal');
  }

  const sessions = registry.list({ status: 'active', tag: flags.tag });
  if (sessions.length === 0) {
    process.stdout.write('No active sessions to resume.\n');
    return;
  }

  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    process.stderr.write(`herdr: ${fetchResult.error || 'query failed'} (showing unknown/-)\n`);
  }
  const enriched = herdr.enrichSessions(sessions, fetchResult);

  process.stdout.write(
    `    ${pad('#', 3)} ${pad('TITLE', 24)} ${pad('ENGINE', 8)} ${pad('FOLDER', 24)} ${pad('HERDR', 8)} LAST USED\n`
  );
  enriched.forEach((e, i) => {
    const s = e.session;
    const folder = s.cwd ? path.basename(s.cwd) : '';
    process.stdout.write(
      `    ${pad(String(i + 1), 3)} ${pad(s.title, 24)} ${pad(s.engine || 'cursor', 8)} ${pad(folder, 24)} ${pad(herdr.displayRuntime(e.runtime), 8)} ${s.lastUsed || ''}\n`
    );
  });

  const readline = require('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await rl.question('Select sessions (e.g. 1,3 or 1-3; a = all): ');
  } finally {
    rl.close();
  }

  let indexes;
  try {
    indexes = backends.parseResumeSelection(answer, sessions.length);
  } catch (err) {
    fail(err.message);
  }
  const selected = indexes.map((i) => sessions[i]);
  if (selected.length === 0) {
    process.stdout.write('No sessions selected.\n');
    return;
  }

  const resumeOpts = buildResumeOpts(flags);
  if (!flags['dry-run']) {
    for (const s of selected) {
      try {
        engine.assertEngineAvailable(s);
      } catch (err) {
        fail(`${s.title}: ${err.message}`);
      }
    }
  }
  const plan = launchViaHerdr(selected, {
    dryRun: Boolean(flags['dry-run']),
    resumeOpts,
    flags,
    json: Boolean(flags.json),
  });
  reportHerdr(plan, flags);
}

function cmdAdopt(argv) {
  const { args, flags } = parseArgs(argv);
  const dryRun = Boolean(flags['dry-run']);
  const asJson = Boolean(flags.json);
  const all = Boolean(flags.all);

  if (!all && args.length === 0) {
    fail('usage: aflt adopt <title|id ...> | aflt adopt --all [--dry-run] [--json]');
  }

  let sessions;
  if (all) {
    sessions = registry.list({ includeDone: true });
  } else {
    sessions = [];
    const seen = new Set();
    for (const q of args) {
      let s;
      try {
        s = registry.find(q);
      } catch (err) {
        fail(err.message);
      }
      if (!s) fail(`session not found: ${q}`);
      if (!seen.has(s.id)) {
        seen.add(s.id);
        sessions.push(s);
      }
    }
  }

  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    fail(launch.discoveryRefuseMessage(fetchResult.error), { json: asJson });
  }

  const plan = herdrapp.planAdopt(sessions, fetchResult.terminals || []);
  if (!plan.ok) fail(plan.error || 'adopt failed', { json: asJson });

  if (plan.items.length === 0) {
    if (asJson) {
      emitJson({ ok: true, dryRun, adopted: [] });
      return;
    }
    process.stdout.write('(no live af Herdr terminals to adopt)\n');
    return;
  }

  const rows = [];
  for (const item of plan.items) {
    const row = herdrapp.executeAdoptItem(item, {
      dryRun,
      maxWaitMs: herdrapp.herdrAppWaitMs(process.env, 5000),
      intervalMs: 250,
    });
    rows.push(row);

    if (!dryRun) {
      if (row.tabRename && !row.tabRename.ok && !row.tabRename.skipped) {
        process.stderr.write(
          `herdr-app tab.rename failed for ${item.title}: ${row.tabRename.error}\n`
        );
      }
      if (row.spaceRename && !row.spaceRename.ok && !row.spaceRename.skipped) {
        process.stderr.write(
          `herdr-app space.rename failed for ${item.title}: ${row.spaceRename.error}\n`
        );
      }
      if (row.error && !asJson) {
        process.stderr.write(`adopt error for ${item.title}: ${row.error}\n`);
      }
    }

    if (!asJson) {
      if (dryRun) {
        const legacyNote = item.legacy ? '  (legacy cwd space → session-group)' : '';
        process.stdout.write(
          `[dry-run] adopt  ${item.address}  ${item.title}  ${item.spaceId}  ${item.tabId}${legacyNote}\n`
        );
        for (const step of row.steps || []) {
          process.stdout.write(`  ${step.join(' ')}\n`);
        }
        continue;
      }

      if (row.appMove && row.appMove.skipped) {
        process.stdout.write(
          `labeled  ${item.address}  ${item.title}  (Herdr app not running — re-run aflt adopt --all after starting the app)\n`
        );
      } else if (row.appMove && row.appMove.parked) {
        const fromName =
          (row.appMove.from && (row.appMove.from.spaceName || row.appMove.from.spaceId)) || '?';
        const toName = item.spaceTitle || item.title;
        process.stdout.write(
          `moved ${item.address} ${item.title}: ${fromName} → ${toName}\n`
        );
      } else if (row.appMove && row.appMove.ok && !row.appMove.parked) {
        process.stdout.write(
          `adopted  ${item.address}  ${item.title}  ${item.spaceId}  ${item.tabId}\n`
        );
      } else {
        process.stdout.write(
          `adopt  ${item.address}  ${item.title}  ${row.ok ? 'ok' : 'FAILED'}\n`
        );
      }
    }
  }

  const anyFail = rows.some((r) => r.ok === false);
  if (asJson) {
    emitJson({
      ok: !anyFail,
      dryRun,
      adopted: rows.map((r) => ({
        title: r.title,
        id: r.id,
        address: r.address,
        name: r.name,
        spaceId: r.spaceId,
        tabId: r.tabId,
        spaceTitle: r.spaceTitle,
        alreadyAdopted: r.alreadyAdopted,
        legacy: r.legacy,
        labeled: r.labeled,
        kept: r.kept,
        parked: r.parked,
        ok: r.ok,
        error: r.error,
        appMove: r.appMove,
        spaceRename: r.spaceRename,
        tabRename: r.tabRename,
        steps: dryRun ? r.steps : undefined,
      })),
    });
    if (anyFail) process.exitCode = 1;
    return;
  }

  if (!dryRun) {
    process.stdout.write(
      'Hint: empty old Herdr spaces may remain — close them in the app if unused.\n'
    );
  }
  if (anyFail) {
    process.exitCode = 1;
  }
}

function cmdRename(argv) {
  const { args } = parseArgs(argv);
  if (args.length < 2) fail('usage: aflt rename <title|id> "<new title>"');
  const updated = registry.update(args[0], { title: args[1] });
  printSession(updated, 'renamed');
}

function cmdCwd(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  if (!args[0]) {
    fail('usage: aflt cwd <title|id> [path] [--dry-run] [--json]\n       aflt set-cwd <title|id> [path] [--dry-run] [--json]', {
      json: asJson,
    });
  }
  const session = requireSession(args[0]);
  const pathArg = args[1];

  if (!pathArg) {
    if (asJson) {
      emitJson({ id: session.id, title: session.title, cwd: session.cwd });
    } else {
      process.stdout.write(`${session.cwd}\n`);
    }
    return;
  }

  let newCwd;
  try {
    newCwd = herdrapp.requireSessionCwd(pathArg);
  } catch (err) {
    fail(err && err.message ? err.message : String(err), { json: asJson });
  }

  const oldCwd = session.cwd;
  const oldNorm = (() => {
    try {
      return herdrapp.normalizeCwd(oldCwd);
    } catch (_) {
      return oldCwd;
    }
  })();
  const unchanged = oldNorm === newCwd;
  const newBranch = unchanged ? session.branch || null : gitBranch(newCwd);

  const notes = [];
  notes.push(
    'Chat history is keyed by session id; the same chat continues in the new folder.'
  );
  if ((session.engine || 'cursor') === 'copilot') {
    notes.push(
      'Copilot session-state workspace.yaml still records the old cwd (af does not edit it); resume uses -C <new folder> (may ask to trust once — answer with: aflt send <id> "1").'
    );
  } else {
    notes.push('Cursor resume passes --workspace <new folder>.');
  }

  let herdrInfo = null;
  const fetchResult = herdr.fetchHerdrTerminals();
  if (fetchResult.ok) {
    const enriched = herdr.enrichSessions([session], fetchResult)[0];
    if (enriched && (enriched.runtime === 'running' || enriched.runtime === 'shell')) {
      herdrInfo = {
        runtime: enriched.runtime,
        address: enriched.address || null,
        name: enriched.name || null,
      };
      if (enriched.runtime === 'shell') {
        notes.push(
          `Live Herdr terminal is shell-only (program still in the old folder). Run: aflt resume ${session.id} (relaunches into that tab with cd <new folder>). Herdr space is session-based (not folder-based), so adopt is not required for the space.`
        );
      } else {
        notes.push(
          `Live Herdr terminal is still running (program still in the old folder). Run: aflt stop ${session.id} then aflt resume ${session.id} (or aflt resume after the agent exits). Herdr space is session-based (not folder-based), so adopt is not required for the space.`
        );
      }
    }
  }

  if (unchanged) {
    const msg = `cwd unchanged: ${newCwd}`;
    if (asJson) {
      emitJson({
        ok: true,
        id: session.id,
        title: session.title,
        engine: session.engine || 'cursor',
        oldCwd,
        cwd: newCwd,
        branch: session.branch || null,
        herdr: herdrInfo,
        notes,
        unchanged: true,
      });
    } else {
      process.stdout.write(`${msg}\n`);
      for (const n of notes) process.stderr.write(`note: ${n}\n`);
    }
    return;
  }

  if (dryRun) {
    if (asJson) {
      emitJson({
        ok: true,
        dryRun: true,
        id: session.id,
        title: session.title,
        engine: session.engine || 'cursor',
        oldCwd,
        cwd: newCwd,
        branch: newBranch,
        herdr: herdrInfo,
        notes,
      });
    } else {
      process.stdout.write(`cwd: ${oldCwd} → ${newCwd}\n`);
      process.stdout.write(`branch: ${session.branch || '(none)'} → ${newBranch || '(none)'}\n`);
      for (const n of notes) process.stderr.write(`note: ${n}\n`);
    }
    return;
  }

  const wr = registry.criticalUpdate(
    session.id,
    { cwd: newCwd, branch: newBranch },
    { phase: 'cwd-change' }
  );
  if (!wr.ok) {
    fail(`critical registry write failed: ${wr.error}`, { json: asJson });
  }
  const updated = wr.session;
  if (asJson) {
    emitJson({
      ok: true,
      id: updated.id,
      title: updated.title,
      engine: updated.engine || 'cursor',
      oldCwd,
      cwd: updated.cwd,
      branch: updated.branch || null,
      herdr: herdrInfo,
      notes,
    });
  } else {
    process.stdout.write(`cwd: ${oldCwd} → ${updated.cwd}\n`);
    process.stdout.write(`branch: ${session.branch || '(none)'} → ${updated.branch || '(none)'}\n`);
    printSession(updated, 'cwd');
    for (const n of notes) process.stderr.write(`note: ${n}\n`);
  }
}

function cmdDone(argv) {
  const { args } = parseArgs(argv);
  if (!args[0]) fail('usage: aflt done <title|id>');
  const updated = registry.update(args[0], { status: 'done', lastUsed: nowIso() });
  printSession(updated, 'done');
}

function sessionLooksRunning(session) {
  // Prefer the archive/delete busy check: live runPid or Herdr working/blocked.
  // Idle live panes no longer block rm/archive.
  const fetchResult = herdr.fetchHerdrTerminals();
  let enrichment = null;
  if (fetchResult && fetchResult.ok) {
    const enriched = herdr.enrichSessions([session], fetchResult)[0];
    enrichment = enriched || null;
  }
  const busy = archiveLib.sessionBusyForMutation(session, {
    enrichment,
    isAlive: orchestrate.defaultIsAlive,
    hostname: os.hostname(),
  });
  if (busy.busy) {
    return { running: true, via: busy.via || busy.reason || 'busy', reason: busy.reason };
  }
  return { running: false, via: null, reason: null };
}

async function cmdArchive(argv) {
  const { args, flags } = parseArgs(argv);
  const withChildren = recoverBoolFlag(flags, 'with-children', args);
  const force =
    recoverBoolFlag(flags, 'force', args) || recoverBoolFlag(flags, 'f', args);
  const dryRun = recoverBoolFlag(flags, 'dry-run', args);
  const asJson = recoverBoolFlag(flags, 'json', args);
  if (!args[0]) {
    fail('usage: aflt archive <title|id> [--with-children] [--force] [--dry-run] [--json]');
  }
  const session = await requireSessionExact(args[0], {
    command: 'archive',
    verb: 'Archive',
    json: asJson,
  });
  const enrichmentById = {};
  const fetchResult = herdr.fetchHerdrTerminals();
  if (fetchResult && fetchResult.ok) {
    const targets = withChildren
      ? archiveLib.collectWithDescendants(session)
      : [session];
    const enriched = herdr.enrichSessions(targets, fetchResult);
    for (const e of enriched) {
      if (e && e.session && e.session.id) enrichmentById[e.session.id] = e;
    }
  }
  const result = archiveLib.archiveSessions(session, {
    withChildren,
    force,
    dryRun,
    enrichmentById,
  });
  if (!result.ok) {
    fail(
      `aflt archive: ${result.error}. Stop it first with \`aflt stop\`, or pass --force.`
    );
  }
  if (asJson) {
    emitJson({
      ok: true,
      dryRun: Boolean(dryRun),
      archived: result.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        archived: Boolean(s.archived),
        archivedAt: s.archivedAt || null,
      })),
      skipped: result.skipped || [],
    });
    return;
  }
  if (dryRun) {
    for (const s of result.sessions) {
      process.stdout.write(`[dry-run] would archive ${s.title} (${s.id})\n`);
    }
    for (const sk of result.skipped || []) {
      process.stdout.write(`[dry-run] skip ${sk.title || sk.id} (${sk.reason})\n`);
    }
    return;
  }
  if (result.sessions.length === 0) {
    process.stdout.write('(nothing to archive)\n');
    return;
  }
  for (const s of result.sessions) {
    process.stdout.write(`archived ${s.title} (${s.id})\n`);
  }
}

async function cmdUnarchive(argv) {
  const { args, flags } = parseArgs(argv);
  const withChildren = recoverBoolFlag(flags, 'with-children', args);
  const dryRun = recoverBoolFlag(flags, 'dry-run', args);
  const asJson = recoverBoolFlag(flags, 'json', args);
  if (!args[0]) {
    fail('usage: aflt unarchive <title|id> [--with-children] [--dry-run] [--json]');
  }
  const session = await requireSessionExact(args[0], {
    command: 'unarchive',
    verb: 'Unarchive',
    json: asJson,
  });
  const result = archiveLib.unarchiveSessions(session, { withChildren, dryRun });
  if (!result.ok) {
    fail(`aflt unarchive: ${result.error || 'failed'}`);
  }
  if (asJson) {
    emitJson({
      ok: true,
      dryRun: Boolean(dryRun),
      unarchived: result.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        archived: Boolean(s.archived),
        archivedAt: s.archivedAt || null,
      })),
      skipped: result.skipped || [],
    });
    return;
  }
  if (dryRun) {
    for (const s of result.sessions) {
      process.stdout.write(`[dry-run] would unarchive ${s.title} (${s.id})\n`);
    }
    return;
  }
  if (result.sessions.length === 0) {
    process.stdout.write('(nothing to unarchive)\n');
    return;
  }
  for (const s of result.sessions) {
    process.stdout.write(`unarchived ${s.title} (${s.id})\n`);
  }
}

async function collectRmTargets(argvFlags, args, resolveOpts = {}) {
  const childrenFlag = argvFlags.children;
  const withMaster = Boolean(argvFlags['with-master']);
  if (childrenFlag && childrenFlag !== true) {
    const master = await requireSessionExact(String(childrenFlag), {
      command: 'rm',
      verb: 'Remove',
      ...resolveOpts,
    });
    const kids = listChildrenOf(master.id);
    const targets = kids.slice();
    if (withMaster) targets.push(master);
    if (targets.length === 0 && !withMaster) {
      fail(`aflt rm --children: master "${master.title}" has no workers`);
    }
    return { targets, master };
  }
  if (!args[0]) {
    fail(
      'usage: aflt rm <title|id> [<title|id>...] [--keep-files] [--force] [--dry-run]\n' +
        '       aflt rm --children <master> [--with-master] [--keep-files] [--force] [--dry-run]'
    );
  }
  if (withMaster) {
    fail('--with-master requires --children <master>');
  }
  // Resolve every target first (exact or TTY picker); fail/cancel before removing any.
  const targets = [];
  const seen = new Set();
  for (const q of args) {
    const s = await requireSessionExact(q, {
      command: 'rm',
      verb: 'Remove',
      ...resolveOpts,
    });
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    targets.push(s);
  }
  return { targets, master: null };
}

async function cmdRm(argv) {
  const { args, flags } = parseArgs(argv);
  // Boolean flags must not swallow following ids (`rm --keep-files a b`).
  const keepFiles = recoverBoolFlag(flags, 'keep-files', args);
  const force =
    recoverBoolFlag(flags, 'force', args) || recoverBoolFlag(flags, 'f', args);
  const dryRun = recoverBoolFlag(flags, 'dry-run', args);
  const asJson = recoverBoolFlag(flags, 'json', args);
  const doPurge = recoverBoolFlag(flags, 'purge', args);
  flags['with-master'] = recoverBoolFlag(flags, 'with-master', args);
  if (doPurge) {
    // Synonym: aflt rm --purge … → same as aflt purge
    const purgeArgv = [];
    for (const a of argv) {
      if (a === '--purge') continue;
      purgeArgv.push(a);
    }
    return cmdPurge(purgeArgv);
  }
  const { targets } = await collectRmTargets(flags, args, { json: asJson });

  const home = fleetDir();
  const plan = [];
  for (const s of targets) {
    const run = sessionLooksRunning(s);
    if (run.running && !force) {
      const kind = run.reason || 'running';
      fail(
        `aflt rm: "${s.title}" appears to be ${kind} (${run.via}). ` +
          `Stop it first with \`aflt stop ${s.title}\`, or pass --force to remove the record/files without stopping.`
      );
    }
    const owned = keepFiles
      ? { files: [], dirs: [], skipped: [] }
      : orchestrate.sessionOwnedPaths(s, { home });
    plan.push({ session: s, owned, running: run.running });
  }

  if (dryRun) {
    for (const item of plan) {
      const s = item.session;
      process.stdout.write(`[dry-run] would remove session ${s.title} (${s.id})\n`);
      if (item.running) process.stdout.write(`[dry-run]   (currently running; --force would be required)\n`);
      for (const f of item.owned.files) process.stdout.write(`[dry-run]   file ${f}\n`);
      for (const d of item.owned.dirs) process.stdout.write(`[dry-run]   dir  ${d}\n`);
      for (const sk of item.owned.skipped) {
        process.stderr.write(`[dry-run]   skip ${sk.path} (${sk.reason})\n`);
      }
    }
    return;
  }

  for (const item of plan) {
    const s = item.session;
    for (const sk of item.owned.skipped) {
      process.stderr.write(`aflt rm: skip ${sk.path} (${sk.reason})\n`);
    }
    for (const f of item.owned.files) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (err) {
        process.stderr.write(`aflt rm: could not remove ${f}: ${err.message}\n`);
      }
    }
    for (const d of item.owned.dirs) {
      try {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      } catch (err) {
        process.stderr.write(`aflt rm: could not remove ${d}: ${err.message}\n`);
      }
    }
    const removed = registry.remove(s.id);
    process.stdout.write(`removed ${removed.title} (${removed.id})\n`);
  }
}

async function confirmPurgeApply(targets, { yes, asJson }) {
  if (yes) return true;
  if (asJson || !process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      'aflt purge --apply requires --yes when not on a TTY (or pass --json with --yes)',
      { json: asJson }
    );
  }
  const readline = require('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const expect =
      targets.length === 1
        ? String(targets[0].id)
        : 'PURGE';
    const prompt =
      targets.length === 1
        ? `Type the session id (${targets[0].id}) to permanently purge "${targets[0].title}": `
        : `Type PURGE to permanently purge ${targets.length} sessions: `;
    const answer = String(await rl.question(prompt)).trim();
    if (answer !== expect) {
      fail('confirmation did not match; aborted');
    }
    return true;
  } finally {
    rl.close();
  }
}

async function cmdPurge(argv) {
  const { args, flags } = parseArgs(argv);
  const force =
    recoverBoolFlag(flags, 'force', args) || recoverBoolFlag(flags, 'f', args);
  const apply = recoverBoolFlag(flags, 'apply', args);
  const dryRunFlag = recoverBoolFlag(flags, 'dry-run', args);
  const yes = recoverBoolFlag(flags, 'yes', args) || recoverBoolFlag(flags, 'y', args);
  const asJson = recoverBoolFlag(flags, 'json', args);
  const withChildren = recoverBoolFlag(flags, 'with-children', args);
  const noEngine = recoverBoolFlag(flags, 'no-engine', args);
  const afltOnly = recoverBoolFlag(flags, 'aflt-only', args);
  const engineOnly = recoverBoolFlag(flags, 'engine-only', args);
  const noTranscripts = recoverBoolFlag(flags, 'no-transcripts', args);

  if (dryRunFlag && apply) {
    fail('--apply cannot be combined with --dry-run', { json: asJson });
  }
  if (engineOnly && (afltOnly || noEngine)) {
    fail('--engine-only cannot be combined with --aflt-only/--no-engine', { json: asJson });
  }
  if (!args[0]) {
    fail(
      'usage: aflt purge <title|id>... [--with-children] [--apply] [--force] [--yes] [--json]\n' +
        '       [--no-engine|--aflt-only] [--engine-only] [--no-transcripts]\n' +
        '  Dry-run by default. Pass --apply to delete registry + runs/ + engine chat.',
      { json: asJson }
    );
  }

  const targets = [];
  const seen = new Set();
  for (const q of args) {
    const s = await requireSessionExact(q, {
      command: 'purge',
      verb: 'Purge',
      json: asJson,
    });
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    targets.push(s);
  }

  if (apply) {
    await confirmPurgeApply(targets, { yes, asJson });
  }

  const allResults = [];
  let ok = true;
  let lastError = null;
  for (const s of targets) {
    const run = sessionLooksRunning(s);
    const result = purgeLib.purgeSession(s, {
      apply,
      force,
      withChildren,
      noEngine: noEngine || afltOnly,
      afltOnly: afltOnly || noEngine,
      engineOnly,
      noTranscripts,
      home: fleetDir(),
      env: process.env,
      enrichment: run.running
        ? { status: run.reason === 'waiting' ? 'blocked' : 'working' }
        : null,
    });
    allResults.push(result);
    if (!result.ok) {
      ok = false;
      lastError = result.error;
      if (!apply) {
        // still report dry-run paths for others? fail closed on busy
        break;
      }
    }
  }

  const payload = {
    ok,
    apply: Boolean(apply),
    dryRun: !apply,
    error: lastError,
    results: allResults,
  };

  if (asJson) {
    emitJson(payload);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (!ok && lastError) {
    fail(`aflt purge: ${lastError}`);
  }

  const mode = apply ? 'apply' : 'dry-run';
  for (const result of allResults) {
    for (const row of result.results || []) {
      const s = row.session;
      process.stdout.write(
        `[${mode}] ${apply ? 'purged' : 'would purge'} ${s.title} (${s.id}) engine=${s.engine || '?'} chatId=${s.chatId || '-'}\n`
      );
      for (const pr of row.pathResults || []) {
        const label = pr.action || 'path';
        const p = pr.path != null ? pr.path : '-';
        const extra = pr.reason ? ` (${pr.reason})` : pr.error ? ` ERROR: ${pr.error}` : '';
        process.stdout.write(`  ${label}  ${p}${extra}\n`);
      }
      if (row.paths && row.paths.engine && row.paths.engine.chat) {
        const chat = row.paths.engine.chat;
        process.stdout.write(
          `  engineChat: ${chat.status}${chat.path ? ` ${chat.path}` : ''}\n`
        );
      }
    }
  }
  if (!ok) process.exitCode = 1;
}

async function cmdOrphans(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = recoverBoolFlag(flags, 'json', args);
  const apply = recoverBoolFlag(flags, 'apply', args);
  const dryRunFlag = recoverBoolFlag(flags, 'dry-run', args);
  const doPurge = recoverBoolFlag(flags, 'purge', args);
  const yes = recoverBoolFlag(flags, 'yes', args) || recoverBoolFlag(flags, 'y', args);
  const force =
    recoverBoolFlag(flags, 'force', args) || recoverBoolFlag(flags, 'f', args);
  const allowUncertain = recoverBoolFlag(flags, 'allow-uncertain-engine', args);
  const includeInteractive = recoverBoolFlag(flags, 'include-interactive', args);

  if (dryRunFlag && apply) {
    fail('--apply cannot be combined with --dry-run', { json: asJson });
  }

  let days = purgeLib.DEFAULT_ORPHAN_DAYS;
  if (flags.days != null && flags.days !== true) {
    days = Number(flags.days);
    if (!Number.isFinite(days) || days < 0) {
      fail('--days must be a non-negative number', { json: asJson });
    }
  }

  let engineFilter = 'all';
  if (flags.engine != null && flags.engine !== true) {
    engineFilter = String(flags.engine).toLowerCase();
    if (!['cursor', 'copilot', 'all'].includes(engineFilter)) {
      fail('--engine must be cursor, copilot, or all', { json: asJson });
    }
  }

  const categories = [];
  if (flags.category != null && flags.category !== true) {
    for (const part of String(flags.category).split(',')) {
      const c = part.trim();
      if (c) categories.push(c);
    }
  }
  // parseArgs keeps last --category; also accept repeated via comma
  for (const a of args) {
    if (a && !String(a).startsWith('-')) {
      // positional unused in scan mode
    }
  }

  const ids = [];
  if (flags.ids != null && flags.ids !== true) {
    for (const part of String(flags.ids).split(',')) {
      const id = part.trim();
      if (id) ids.push(id);
    }
  }

  const scan = purgeLib.scanOrphans({
    days,
    engine: engineFilter,
    categories: categories.length ? categories : undefined,
    home: fleetDir(),
    env: process.env,
    allowUncertainEngine: allowUncertain,
    includeInteractive,
  });

  if (!doPurge) {
    if (asJson) {
      emitJson({
        ok: true,
        dryRun: true,
        ...scan,
        items: scan.items.map(purgeLib.summarizeOrphan),
      });
      return;
    }
    process.stdout.write(
      `orphans scan (days=${scan.days}, engine=${scan.engine}): ${scan.count} item(s)\n`
    );
    if (scan.count === 0) return;
    const cols = ['CATEGORY', 'AF_ID', 'ENGINE', 'CHAT_ID', 'AGE_DAYS', 'RISK', 'PURGEABLE', 'NOTES'];
    process.stdout.write(cols.join('\t') + '\n');
    for (const it of scan.items) {
      process.stdout.write(
        [
          it.category,
          it.afId || '-',
          it.engine || '-',
          it.chatId || '-',
          it.ageDays != null ? String(it.ageDays) : '-',
          it.risk || '-',
          it.purgeable ? 'yes' : 'no',
          (it.notes || '').replace(/\s+/g, ' '),
        ].join('\t') + '\n'
      );
    }
    process.stdout.write(
      '\nPurge selected items: aflt orphans --purge --ids <id,…> [--apply] [--yes]\n'
    );
    return;
  }

  if (ids.length === 0) {
    fail(
      'aflt orphans --purge requires --ids <id,…> (select from scan). Never purges all orphans blindly.',
      { json: asJson }
    );
  }

  if (apply && !yes && (!process.stdin.isTTY || asJson)) {
    fail('aflt orphans --purge --apply requires --yes when not on a TTY', { json: asJson });
  }
  if (apply && !yes && process.stdin.isTTY && process.stdout.isTTY) {
    const readline = require('readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = String(
        await rl.question(`Type PURGE to delete ${ids.length} selected orphan item(s): `)
      ).trim();
      if (answer !== 'PURGE') fail('confirmation did not match; aborted');
    } finally {
      rl.close();
    }
  }

  const result = purgeLib.purgeOrphanItems(scan.items, {
    apply,
    force,
    ids,
    home: fleetDir(),
    env: process.env,
  });

  if (asJson) {
    emitJson({ ok: result.ok, ...result, scanCount: scan.count });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const mode = apply ? 'apply' : 'dry-run';
  process.stdout.write(
    `orphans purge (${mode}): selected ${result.selected} of ${scan.count}\n`
  );
  for (const row of result.results || []) {
    const it = row.item || {};
    process.stdout.write(
      `  ${it.category}  ${it.afId || it.chatId || '-'}  ${row.purge && row.purge.ok ? 'ok' : 'FAIL'}\n`
    );
    const prs = (row.purge && (row.purge.pathResults || (row.purge.results || []).flatMap((r) => r.pathResults || []))) || [];
    for (const pr of prs) {
      process.stdout.write(`    ${pr.action}  ${pr.path || '-'}${pr.error ? ` ERROR: ${pr.error}` : ''}\n`);
    }
  }
  if (!result.ok) {
    fail(`aflt orphans --purge: ${result.error || 'failed'}`);
  }
}

function cmdNote(argv) {
  const { args } = parseArgs(argv);
  if (args.length < 2) fail('usage: aflt note <title|id> "<text>"');
  const updated = registry.update(args[0], { notes: args.slice(1).join(' ') });
  printSession(updated, 'noted');
}

function cmdExport(argv) {
  const { args } = parseArgs(argv);
  const data = registry.exportAll();
  const json = JSON.stringify(data, null, 2) + '\n';
  if (args[0]) {
    fs.writeFileSync(args[0], json, 'utf8');
    process.stderr.write(`wrote ${args[0]} (${data.sessions.length} sessions)\n`);
  } else {
    process.stdout.write(json);
  }
}

function cmdImportFile(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: aflt import-file <file>');
  const payload = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const result = registry.importAll(payload, { merge: !flags.replace });
  process.stdout.write(`import-file: added ${result.added}, updated ${result.updated}, total ${result.total}\n`);
}

function collectTags(flags) {
  const tags = [];
  if (flags.tag === true) return tags;
  if (typeof flags.tag === 'string') tags.push(flags.tag);
  // parseArgs only keeps last --tag; support comma-separated
  if (tags.length === 1 && tags[0].includes(',')) {
    return tags[0].split(',').map((t) => t.trim()).filter(Boolean);
  }
  return tags;
}

function printSession(s, verb, { stream } = {}) {
  const out = stream || process.stdout;
  out.write(
    `${verb}: ${s.title}\n` +
      `  id:      ${s.id}\n` +
      `  chatId:  ${s.chatId}\n` +
      `  engine:  ${s.engine || 'cursor'}\n` +
      `  cwd:     ${s.cwd}\n` +
      `  branch:  ${s.branch || '(none)'}\n` +
      `  status:  ${s.status}\n` +
      (s.lastOutput ? `  output:  ${s.lastOutput}\n` : '') +
      `  registry:${fleetDir()}/sessions.json\n`
  );
}

/**
 * Mint / create an engine-native session id for a new aflt registry row.
 * Cursor: create-chat UUID. Copilot: local UUID. OpenCode: ses_* via serve API.
 */
async function createEngineChatId(engineName, { cwd, title, quiet = false } = {}) {
  if (engineName === 'copilot') {
    return copilot.newSessionId();
  }
  if (engineName === 'opencode') {
    if (!quiet) {
      process.stderr.write(`Creating OpenCode session via ${opencode.resolveOpencodeBin()} serve…\n`);
    }
    const id = await opencode.createSession({ cwd, title });
    if (!quiet) process.stderr.write(`Created OpenCode session ${id}\n`);
    return id;
  }
  if (!quiet) {
    process.stderr.write(`Creating chat via ${cursor.resolveCursorBin()} create-chat…\n`);
  }
  return cursor.createChat();
}

/**
 * Headless print-mode run for an already-registered session.
 * Shared by `aflt run`, `aflt spawn`, and headless `aflt send` continuations.
 * Spawns the engine detached in its own process group (still awaited; not
 * unref'd) and records runPid/runPgid/runHost so `aflt stop` can kill the group.
 * Streams stdout into the run log as data arrives.
 * @returns {{ code, timedOut, outPath, result, stopped }}
 */
/**
 * Resolve engine vs user-facing output format for headless runs.
 * Cursor: when the user did not explicitly pass --output-format, request
 * `json` from cursor-agent so result.usage is available, then present the
 * extracted result text as user-facing stdout (unless they asked for json).
 */
function resolveHeadlessOutputFormats(engineName, outputFormat, opts = {}) {
  const userFormat = outputFormat || 'text';
  const explicit = Boolean(opts.outputFormatExplicit);
  let engineFormat = userFormat;
  let presentAsText = false;
  if (engineName === 'cursor' && !explicit && (userFormat === 'text' || !userFormat)) {
    engineFormat = 'json';
    presentAsText = true;
  } else if (engineName === 'opencode' && !explicit && (userFormat === 'text' || !userFormat)) {
    // Prefer json stream so step_finish tokens are available; present text.
    engineFormat = 'json';
    presentAsText = true;
  } else if (engineName === 'copilot' && !explicit && (userFormat === 'text' || !userFormat)) {
    // Copilot tokens live in events.jsonl; keep text for user-facing stdout.
    engineFormat = 'text';
    presentAsText = false;
  }
  if (userFormat === 'json' || userFormat === 'stream-json') {
    presentAsText = false;
    engineFormat = userFormat;
  }
  return { userFormat, engineFormat, presentAsText, explicit };
}

async function executeHeadlessRun(session, opts = {}) {
  const {
    prompt,
    mode = null,
    force = false,
    outputFormat = 'text',
    trust = true,
    timeoutSec = 0,
    silent = true,
    env = null,
    quietCopilotHints = false,
    trackRun = true,
  } = opts;

  const engineName = session.engine || 'cursor';
  if (mode && engineName === 'copilot') {
    fail('--mode ask|plan is a Cursor flag; Copilot has no equivalent here');
  }
  if (mode && engineName === 'opencode') {
    fail('--mode ask|plan is a Cursor flag; OpenCode has no equivalent here');
  }

  const formats = resolveHeadlessOutputFormats(engineName, outputFormat, {
    outputFormatExplicit: Boolean(opts.outputFormatExplicit),
  });
  const engineOutputFormat = formats.engineFormat;

  const prepared = agentDocs.prepareLaunch(session, {
    prompt,
    extraEnv: {},
    requestReason: 'aflt-run',
  });
  for (const w of prepared.warnings) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }
  const effectivePrompt = prepared.prompt != null ? prepared.prompt : prompt;

  let bin;
  let argvRun;
  if (engineName === 'cursor') {
    bin = cursor.resolveCursorBin();
    argvRun = cursor.buildPrintArgs(session, {
      prompt: effectivePrompt,
      mode,
      force,
      outputFormat: engineOutputFormat,
      trust,
    });
  } else if (engineName === 'copilot') {
    bin = copilot.resolveCopilotBin();
    argvRun = copilot.buildPrintArgs(session, {
      prompt: effectivePrompt,
      force,
      outputFormat: engineOutputFormat,
      silent,
    });
  } else if (engineName === 'opencode') {
    bin = opencode.resolveOpencodeBin();
    argvRun = opencode.buildPrintArgs(session, {
      prompt: effectivePrompt,
      force,
      outputFormat: engineOutputFormat,
    });
  } else {
    fail(`unsupported engine: ${engineName}`);
  }

  if (!quietCopilotHints) {
    if (engineName === 'copilot' && force) {
      process.stderr.write(
        'warning: --force adds Copilot --allow-all-tools (tools run without confirmation; not --allow-all/--yolo).\n'
      );
    } else if (engineName === 'copilot') {
      if (session.result || session.plan) {
        process.stderr.write(
          'Copilot run without --force: no --allow-all-tools. Handoff/plan write path(s) are pre-approved via --allow-tool=write(…); other tools need confirmation or --force.\n'
        );
      } else {
        process.stderr.write(
          'Copilot run without --force: no --allow-all-tools. Tool calls will not auto-approve.\n'
        );
      }
    } else if (engineName === 'opencode' && force) {
      process.stderr.write(
        'warning: --force is currently a no-op for OpenCode (no stable CLI permission-grant flag mapped yet).\n'
      );
    }
  }

  process.stderr.write(
    `Running "${session.title}" via ${bin} (${engineName}${mode ? `, mode=${mode}` : ''}${force ? ', force' : ''}) in ${session.cwd}\n`
  );
  const childEnv = env
    ? { ...env, ...prepared.env }
    : { ...process.env, ...prepared.env };
  const outPath = runlib.newRunLogPath(session.id, engineName);
  runlib.writeRunLogHeader(outPath, {
    argv: [bin, ...argvRun],
    cwd: session.cwd,
    kind: 'headless',
    prompt: effectivePrompt,
  });

  const asJson = Boolean(opts.json);
  const runId = crypto.randomUUID();
  const runStartedAt = nowIso();
  let resultMtimeAtStart = null;
  const resultPathHint = session.result || null;
  if (resultPathHint) {
    try {
      if (fs.existsSync(resultPathHint)) resultMtimeAtStart = fs.statSync(resultPathHint).mtimeMs;
    } catch (_) {
      resultMtimeAtStart = null;
    }
  }

  let registryWriteError = null;
  if (trackRun) {
    const before = registry.criticalUpdate(
      session.id,
      {
        lastOutput: outPath,
        lastPrompt: prompt,
        runHost: os.hostname(),
        runStartedAt,
        runId,
        resultMtimeAtStart,
        resultRunId: null,
        stopRequested: false,
        runPid: null,
        runPgid: null,
      },
      { phase: 'before-launch' }
    );
    if (!before.ok) {
      fail(
        `critical registry write failed before launch: ${before.error}`,
        { json: asJson }
      );
    }
  }

  let spawnIdentityError = null;
  // When we rewrite stdout (Cursor/OpenCode internal json → text), avoid
  // streaming raw JSON into the run log; rewrite the file after parse.
  const deferLogBody = Boolean(formats.presentAsText);
  const result = await runlib.spawnCaptured(bin, argvRun, {
    cwd: session.cwd,
    timeoutMs: timeoutSec ? timeoutSec * 1000 : 0,
    env: childEnv,
    detached: true,
    forwardSignals: true,
    logPath: deferLogBody ? null : outPath,
    onSpawn: ({ pid, pgid }) => {
      if (!trackRun) return;
      const idWrite = registry.criticalUpdate(
        session.id,
        {
          runPid: pid,
          runPgid: pgid,
          runHost: os.hostname(),
          runStartedAt,
          runId,
          lastOutput: outPath,
        },
        { phase: 'after-spawn' }
      );
      if (!idWrite.ok) spawnIdentityError = idWrite.error;
    },
  });

  let stopped = false;
  try {
    const fresh = registry.find(session.id);
    if (fresh && fresh.stopRequested) stopped = true;
  } catch (_) {
    /* ignore */
  }
  if (result.interruptedBy) stopped = true;

  const exitFromSignal = result.interruptedBy
    ? runlib.signalExitCode(result.interruptedBy)
    : null;
  const lastExit = result.timedOut ? 124 : exitFromSignal != null ? exitFromSignal : result.code;

  // Extract usage + user-facing text from engine stdout when applicable.
  let displayStdout = result.stdout || '';
  let capturedUsage = null;
  let parsedModel = session.model || null;
  try {
    if (engineName === 'cursor' && (engineOutputFormat === 'json' || engineOutputFormat === 'stream-json')) {
      const parsed = cursor.parseCursorPrintOutput(result.stdout || '', {
        format: engineOutputFormat,
        model: session.model || null,
      });
      if (formats.presentAsText || formats.userFormat === 'text') {
        displayStdout = parsed.result != null ? parsed.result : displayStdout;
      }
      capturedUsage = parsed.usage;
      if (parsed.model) parsedModel = parsed.model;
    } else if (engineName === 'opencode' && engineOutputFormat === 'json') {
      const parsed = opencode.parseOpenCodeJsonOutput(result.stdout || '', {
        model: session.model || null,
      });
      if (formats.presentAsText || formats.userFormat === 'text') {
        displayStdout = parsed.result != null ? parsed.result : displayStdout;
      }
      capturedUsage = parsed.usage;
      if (parsed.model) parsedModel = parsed.model;
    } else if (engineName === 'copilot') {
      // Prefer events.jsonl / JSON stdout usage_record over a char estimate.
      if (engineOutputFormat === 'json') {
        const parsed = copilot.parseCopilotJsonOutput(result.stdout || '', {
          model: session.model || null,
        });
        if (formats.userFormat === 'text' && parsed.assistantText) {
          displayStdout = parsed.assistantText;
        }
        capturedUsage = parsed.usage;
        if (parsed.model) parsedModel = parsed.model;
      }
      try {
        const fromEvents = copilot.usageFromSessionEvents(session, {
          since: runStartedAt,
          env: childEnv,
          model: parsedModel,
        });
        const usageLib = require('../lib/usage');
        capturedUsage = usageLib.preferRicherUsage(capturedUsage, fromEvents);
        if (fromEvents && fromEvents.model) parsedModel = fromEvents.model;
      } catch (_) {
        /* keep stdout usage */
      }
    }
  } catch (_) {
    /* keep raw stdout */
  }

  if (!capturedUsage && (effectivePrompt || displayStdout)) {
    try {
      const usageLib = require('../lib/usage');
      capturedUsage = usageLib.estimateUsageFromText({
        prompt: effectivePrompt,
        reply: displayStdout,
        cli: engineName,
        model: parsedModel,
      });
    } catch (_) {
      /* ignore */
    }
  }

  // Rewrite / finalize run log with user-facing text + optional usage footer.
  try {
    if (deferLogBody) {
      runlib.writeRunLog(outPath, {
        argv: [bin, ...argvRun],
        cwd: session.cwd,
        stdout: displayStdout,
        stderr: result.stderr || '',
        code: lastExit,
        signal: result.interruptedBy || result.signal || null,
        timedOut: result.timedOut,
        kind: 'headless',
        prompt: effectivePrompt,
        usage: capturedUsage,
      });
    } else if (capturedUsage) {
      // Footer already written without usage — append a usage line for parsers.
      try {
        fs.appendFileSync(outPath, `# usage: ${JSON.stringify(capturedUsage)}\n`, {
          encoding: 'utf8',
        });
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ignore log rewrite errors */
  }

  // Record headless turn + usage-summary (deduped vs run-log markers later).
  // skipEmit: run.completed / run.failed already cover the webhook; avoid a
  // duplicate turn.captured that would break notify flush expectations.
  try {
    const turnsLib = require('../lib/turns');
    const at = runStartedAt || nowIso();
    turnsLib.appendTurn(
      {
        sessionId: session.id,
        chatId: session.chatId || null,
        engine: engineName,
        source: 'headless-run',
        at,
        prompt: effectivePrompt,
        reply: displayStdout,
        promptSource: 'headless-prompt',
        replySource: 'headless-stdout',
        engineEventId: `headless:${session.id}:${runId || at}`,
        usage: capturedUsage || undefined,
      },
      { meta: { project: session.project || null }, skipEmit: true }
    );
    if (engineName === 'copilot') {
      // Enrich from events.jsonl when available (real token counts).
      turnsLib.syncCopilotSession(session, {
        apply: true,
        fullScan: true,
        source: 'copilot-events',
        meta: { project: session.project || null },
      });
    } else if (engineName === 'opencode' && !capturedUsage) {
      turnsLib.syncOpencodeSession(session, {
        apply: true,
        fullScan: true,
        source: 'opencode-db',
        meta: { project: session.project || null },
      });
    }
  } catch (_) {
    /* ignore turn capture errors */
  }

  // Present extracted text to callers (preserve aflt --json / log semantics).
  result.stdout = displayStdout;
  result.usage = capturedUsage;

  const patch = {
    lastRunAt: nowIso(),
    lastExit,
    lastOutput: outPath,
    lastPrompt: prompt,
    runPid: null,
    runPgid: null,
    runId,
    runStartedAt,
    resultMtimeAtStart,
  };
  if (result.interruptedBy && (session.role === 'worker' || session.role === 'master')) {
    patch.workerStatus = 'stopped';
    patch.stopRequested = true;
  }
  registry.bestEffortUpdate(session.id, { lastUsed: nowIso() });
  if (trackRun) {
    const after = registry.criticalUpdate(session.id, patch, { phase: 'after-exit' });
    if (!after.ok) {
      registryWriteError = after.error;
      process.stderr.write(
        `ERROR: critical registry write failed after run (exit will be ${registry.REGISTRY_WRITE_EXIT}): ${after.error}\n`
      );
    }
  }
  if (spawnIdentityError && !registryWriteError) {
    registryWriteError = spawnIdentityError;
    process.stderr.write(
      `ERROR: critical registry write failed recording runPid (exit will be ${registry.REGISTRY_WRITE_EXIT}): ${spawnIdentityError}\n`
    );
  }

  if (!asJson) {
    if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
    if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  } else if (result.stderr) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  }
  process.stderr.write(`output: ${outPath}\n`);
  if (result.interruptedBy) {
    process.stderr.write(
      `interrupted (${result.interruptedBy}): forwarded SIGTERM to engine process group\n`
    );
  }
  let code = result.timedOut ? 124 : exitFromSignal != null ? exitFromSignal : result.code || 0;
  if (result.timedOut) {
    process.stderr.write(`timed out after ${timeoutSec}s (signal ${result.signal || 'SIGTERM'})\n`);
  }
  if (registryWriteError) {
    code = registry.REGISTRY_WRITE_EXIT;
  }

  // Opt-in webhook: await briefly (notify timeout) so the POST can finish
  // before the CLI exits. Never breaks the run or changes its exit code.
  try {
    const fresh = registry.find(session.id) || session;
    const queued = notify.notifyRunFinished(fresh, {
      exitStatus: code,
      timedOut: result.timedOut,
      stopped,
      summary: runlib.outputExcerpt((result && result.stdout) || '', notify.SUMMARY_CAP),
      unref: false,
    });
    await notify.settleNotify(queued);
  } catch (_) {
    /* ignore */
  }

  // Opt-in agentDocs: request a checkpoint at the run-exit safe boundary only
  // when the agent is no longer busy. Never treats elapsed time as progress.
  try {
    const fresh = registry.find(session.id) || session;
    if (!stopped) {
      agentDocs.maybeRequestAtBoundary(fresh, 'run-exit', {
        reason: 'run-exit',
      });
    }
    agentDocs.processCheckpointRetries({});
  } catch (_) {
    /* ignore */
  }

  return {
    code,
    timedOut: result.timedOut,
    outPath,
    result,
    stopped,
    interruptedBy: result.interruptedBy || null,
    registryWriteError,
    runId,
    runStartedAt,
    resultMtimeAtStart,
    usage: capturedUsage,
  };
}

function headlessCommandPreview(session, { prompt, mode, force, outputFormat, trust, silent }) {
  const engineName = session.engine || 'cursor';
  let bin;
  let argvRun;
  if (engineName === 'cursor') {
    bin = cursor.resolveCursorBin();
    argvRun = cursor.buildPrintArgs(session, { prompt, mode, force, outputFormat, trust });
  } else if (engineName === 'copilot') {
    bin = copilot.resolveCopilotBin();
    argvRun = copilot.buildPrintArgs(session, { prompt, force, outputFormat, silent });
  } else if (engineName === 'opencode') {
    bin = opencode.resolveOpencodeBin();
    argvRun = opencode.buildPrintArgs(session, { prompt, force, outputFormat });
  } else {
    fail(`unsupported engine: ${engineName}`);
  }
  return runlib.commandString(bin, argvRun);
}

async function cmdRun(argv) {
  const { args, flags } = parseArgs(argv);
  const titleOrId = args[0];
  const prompt = flags.prompt;
  if (!titleOrId || !prompt || prompt === true) {
    fail(
      'usage: aflt run "<title>" --prompt "..." [--cwd DIR] [--engine cursor|copilot|opencode] [--mode ask|plan] [--force] [--messaging|--no-messaging] [--dry-run] [--json]'
    );
  }

  const engineFlag = flags.engine ? String(flags.engine) : null;
  if (engineFlag) {
    try {
      config.validateEngine(engineFlag);
    } catch (err) {
      fail(err.message);
    }
  }
  const mode = flags.mode ? String(flags.mode) : null;
  if (mode && mode !== 'ask' && mode !== 'plan') {
    fail(`unknown --mode: ${mode} (want ask or plan)`);
  }
  const outputFormatExplicit = Boolean(flags['output-format']);
  const outputFormat = flags['output-format'] ? String(flags['output-format']) : 'text';
  const force = Boolean(flags.force);
  const dryRun = Boolean(flags['dry-run']);
  const asJson = Boolean(flags.json);
  const trust = !flags['no-trust'];
  const timeoutSec = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }

  let session = null;
  try {
    session = registry.find(titleOrId);
  } catch (err) {
    fail(err.message);
  }

  if (session) {
    if (engineFlag && (session.engine || 'cursor') !== engineFlag) {
      fail(`session "${session.title}" is engine=${session.engine || 'cursor'}, not ${engineFlag}`);
    }
  } else {
    let resolved;
    try {
      resolved = engine.resolveEngine({ flag: engineFlag });
    } catch (err) {
      fail(err.message);
    }
    const engineName = resolved.engine;
    if (mode && engineName === 'copilot') {
      fail('--mode ask|plan is a Cursor flag; Copilot has no equivalent here');
    }
    if (mode && engineName === 'opencode') {
      fail('--mode ask|plan is a Cursor flag; OpenCode has no equivalent here');
    }
    const cwd = resolveCwd(flags.cwd || flags.C);
    let chatId;
    if (dryRun) {
      chatId =
        engineName === 'opencode'
          ? opencode.dryRunSessionId()
          : '00000000-0000-4000-8000-000000000000';
      process.stderr.write(`[dry-run] would create a ${engineName} session in ${cwd}\n`);
    } else {
      chatId = await createEngineChatId(engineName, { cwd, title: titleOrId });
    }
    const messagingFlag = messages.normalizeMessagingFlag(flags);
    const entry = {
      title: titleOrId,
      chatId,
      cwd,
      branch: gitBranch(cwd),
      model: flags.model || null,
      prompt,
      tags: collectTags(flags),
      status: 'active',
      engine: engineName,
    };
    if (messagingFlag !== null) entry.messaging = messagingFlag;
    applyProjectField(entry, flags);
    if (dryRun) {
      session = { ...entry, id: 'dry-run' };
    } else {
      session = registry.add(entry);
      if (!asJson) printSession(session, 'registered');
      else printSession(session, 'registered', { stream: process.stderr });
    }
  }

  const engineName = session.engine || 'cursor';
  if (mode && engineName === 'copilot') {
    fail('--mode ask|plan is a Cursor flag; Copilot has no equivalent here');
  }
  if (mode && engineName === 'opencode') {
    fail('--mode ask|plan is a Cursor flag; OpenCode has no equivalent here');
  }

  const runOpts = {
    prompt,
    mode,
    force,
    outputFormat,
    outputFormatExplicit,
    trust,
    timeoutSec,
    silent: !flags['no-silent'],
  };

  if (dryRun) {
    const previewOpts = {
      ...runOpts,
      outputFormat: resolveHeadlessOutputFormats(engineName, outputFormat, {
        outputFormatExplicit,
      }).engineFormat,
    };
    if (asJson) {
      emitJson({
        ok: true,
        dryRun: true,
        session: { id: session.id, title: session.title, engine: session.engine || 'cursor' },
        command: headlessCommandPreview(session, previewOpts),
      });
      return;
    }
    const shell = headlessCommandPreview(session, previewOpts);
    process.stdout.write(`cd ${JSON.stringify(session.cwd)} && ${shell}\n`);
    return;
  }

  // Copilot --help says --allow-all-tools is required for non-interactive mode,
  // but a no-tool text prompt succeeded without it (Mini, 2026-11-10, 1.0.83).
  // Do not add that grant unless the caller passes --force.
  const { code, timedOut, outPath, result, runId, registryWriteError } = await executeHeadlessRun(session, {
    ...runOpts,
    json: asJson,
  });
  let docsResult = null;
  if (!timedOut && code === 0 && session.role === 'master' && !flags['no-docs']) {
    const fresh = registry.find(session.id) || session;
    docsResult = await maybeTriggerDocsForMaster(fresh, {
      runId,
      engine: fresh.engine || 'cursor',
      flags,
      asJson,
      quiet: asJson,
    });
  }
  if (asJson) {
    const excerptSrc = (result && result.stdout) || '';
    const payload = {
      ok: code === 0 && !timedOut && !registryWriteError,
      session: {
        id: session.id,
        title: session.title,
        engine: session.engine || 'cursor',
      },
      lastExit: timedOut ? 124 : code,
      outputPath: outPath,
      outputExcerpt: runlib.outputExcerpt(excerptSrc),
    };
    if (registryWriteError) payload.registryWriteError = registryWriteError;
    const docsJson = docsTriggerJson(docsResult);
    if (docsJson) payload.docs = docsJson;
    emitJson(payload);
  }
  process.exitCode = code;
}

async function cmdSpawn(argv) {
  const { flags } = parseArgs(argv);
  const parentQuery = flags.parent;
  const prompt = flags.prompt;
  if (!parentQuery || parentQuery === true || !prompt || prompt === true) {
    fail(
      'usage: aflt spawn --parent <id|title> --prompt TEXT [--engine cursor|copilot|opencode] [--cwd DIR] [--title T] [--task TEXT] [--interactive] [--detach] [--force] [--messaging|--no-messaging] [--dry-run] [--json]'
    );
  }

  let parent;
  try {
    parent = registry.find(String(parentQuery));
  } catch (err) {
    fail(err.message);
  }
  if (!parent) fail(`parent session not found: ${parentQuery}`);

  const engineFlag = flags.engine ? String(flags.engine) : null;
  if (engineFlag) {
    try {
      config.validateEngine(engineFlag);
    } catch (err) {
      fail(err.message);
    }
  }
  let resolved;
  try {
    resolved = engine.resolveEngine({ flag: engineFlag });
  } catch (err) {
    fail(err.message);
  }
  const engineName = resolved.engine;

  const force = Boolean(flags.force);
  const dryRun = Boolean(flags['dry-run']);
  const interactive = Boolean(flags.interactive);
  const detach = Boolean(flags.detach);
  const trust = !flags['no-trust'];
  const asJson = Boolean(flags.json);
  const timeoutSec = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }
  if (detach && interactive) {
    fail('--detach is headless only (cannot combine with --interactive)', { json: asJson });
  }

  const cwd = flags.cwd || flags.C ? resolveCwd(flags.cwd || flags.C) : parent.cwd;
  const task =
    typeof flags.task === 'string' && flags.task
      ? String(flags.task)
      : orchestrate.taskFromPrompt(prompt);
  const messagingFlag = messages.normalizeMessagingFlag(flags, { inheritFrom: parent });

  const explicitTitle =
    typeof flags.title === 'string' && flags.title ? String(flags.title) : null;
  // Preview / dry-run title only; real uniqueness for default titles is decided
  // inside registry.add under the cross-process lock (autoTitle).
  const allSessions = registry.list({ includeDone: true });
  const children = allSessions.filter((s) => s.parent === parent.id);
  const title =
    explicitTitle ||
    orchestrate.nextWorkerTitle(
      parent.title,
      children.length,
      allSessions.map((s) => s.title)
    );

  if (!parent.role && !dryRun) {
    try {
      parent = registry.update(parent.id, { role: 'master' });
    } catch (err) {
      fail(err.message);
    }
  }

  if (dryRun) {
    const dryId = 'dry-run-worker';
    const previewEntry = {
      id: dryId,
      title,
      chatId: '00000000-0000-4000-8000-000000000000',
      cwd,
      engine: engineName,
      model: flags.model || null,
      parent: parent.id,
      role: 'worker',
      task,
      result: orchestrate.defaultResultPath(dryId),
      workerStatus: interactive ? 'running' : 'queued',
      messaging: messagingFlag,
    };
    applyProjectField(previewEntry, flags, { parent });
    const previewMessaging = messages.isMessagingEnabled({
      ...previewEntry,
      messaging: messagingFlag,
      cwd,
    }).enabled;
    const previewWrapped = orchestrate.wrapWorkerPrompt({
      parentTitle: parent.title,
      parentId: parent.id,
      task,
      resultPath: previewEntry.result,
      prompt,
      messagingEnabled: previewMessaging,
    });
    if (asJson) {
      emitJson({
            dryRun: true,
            parent: { id: parent.id, title: parent.title, role: parent.role || 'master' },
            worker: previewEntry,
            interactive,
            prompt: previewWrapped,
          });
    } else {
      process.stderr.write(
        `[dry-run] would spawn worker "${title}" under "${parent.title}" (${parent.id})\n` +
          `[dry-run] engine=${engineName} cwd=${cwd} interactive=${interactive}\n` +
          `[dry-run] result=${previewEntry.result}\n`
      );
      if (interactive) {
        const cmd = engine.buildInteractiveCommandString(previewEntry, {
          prompt: previewWrapped,
          trust,
          force,
        });
        process.stdout.write(`cd ${JSON.stringify(cwd)} && ${cmd}\n`);
      } else {
        const shell = headlessCommandPreview(previewEntry, {
          prompt: previewWrapped,
          force,
          outputFormat: 'text',
          trust,
          silent: true,
        });
        process.stdout.write(`cd ${JSON.stringify(cwd)} && ${shell}\n`);
      }
    }
    return;
  }

  const chatId = await createEngineChatId(engineName, { cwd, title });

  const resultsDir = path.join(fleetDir(), 'results');
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });

  // Create with role=worker so normalizeEntry sets default result path from id.
  // Default titles are finalized under the registry lock so parallel
  // `aflt spawn ... &` cannot collide on `<master>-wN`.
  let worker;
  try {
    const addOpts = explicitTitle
      ? {}
      : { autoTitle: { parentTitle: parent.title, parentId: parent.id } };
    const addPartial = {
      title: explicitTitle || title,
      chatId,
      cwd,
      branch: gitBranch(cwd),
      model: flags.model || null,
      prompt: '',
      tags: [],
      status: 'active',
      engine: engineName,
      parent: parent.id,
      role: 'worker',
      task,
      workerStatus: 'queued',
    };
    if (messagingFlag !== null) addPartial.messaging = messagingFlag;
    applyProjectField(addPartial, flags, { parent });
    worker = registry.add(addPartial, addOpts);
  } catch (err) {
    fail(err.message);
  }

  const finalResult = worker.result || orchestrate.defaultResultPath(worker.id);
  const workerMessagingOn = messages.isMessagingEnabled(worker).enabled;
  const finalWrapped = orchestrate.wrapWorkerPrompt({
    parentTitle: parent.title,
    parentId: parent.id,
    task,
    resultPath: finalResult,
    prompt,
    messagingEnabled: workerMessagingOn,
  });
  worker = registry.update(worker.id, {
    prompt: finalWrapped,
    result: finalResult,
    force,
    stopRequested: false,
  });

  const preparedSpawn = agentDocs.prepareLaunch(worker, {
    prompt: finalWrapped,
    extraEnv: {
      AGENTFLEET_PARENT: parent.id,
      AGENTFLEET_RESULT: finalResult,
    },
    requestReason: 'aflt-spawn',
  });
  for (const w of preparedSpawn.warnings) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }
  const envOverlay = preparedSpawn.env;
  const spawnPrompt =
    preparedSpawn.prompt != null ? preparedSpawn.prompt : finalWrapped;

  if (interactive) {
    try {
      engine.assertEngineAvailable(worker);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    const resumeOpts = {
      prompt: spawnPrompt,
      trust,
      force,
      herdrApp: herdrapp.herdrAppEnabled(flags),
      envOverlay,
      sessions: registry.list({ includeDone: true }),
    };
    const plan = launchViaHerdr([worker], {
      dryRun: false,
      resumeOpts,
      flags,
      json: asJson,
    });
    const launchErr = herdrLaunchFailed(plan);
    if (launchErr) {
      try {
        worker = registry.update(worker.id, {
          workerStatus: 'failed',
          lastError: launchErr,
          lastUsed: nowIso(),
        });
      } catch (_) { /* ignore */ }
      if (asJson) {
        emitJson({
          ok: false,
          error: launchErr,
          worker: {
            id: worker.id,
            title: worker.title,
            engine: worker.engine,
            result: finalResult,
            workerStatus: 'failed',
            lastError: launchErr,
          },
          parent: { id: parent.id, title: parent.title },
          herdr: plan,
        });
      } else {
        process.stderr.write(`spawn failed: ${launchErr}\n`);
        reportHerdr(plan, flags);
      }
      process.exitCode = 1;
      return;
    }
    try {
      worker = registry.update(worker.id, {
        workerStatus: 'running',
        lastUsed: nowIso(),
        force,
        stopRequested: false,
        lastError: null,
      });
    } catch (_) { /* ignore */ }
    if (asJson) {
      emitJson({
        ok: true,
        worker: {
          id: worker.id,
          title: worker.title,
          engine: worker.engine,
          result: finalResult,
          workerStatus: 'running',
        },
        parent: { id: parent.id, title: parent.title },
        herdr: plan,
      });
      reportHerdr(plan, { ...flags, json: true });
    } else {
      printSession(worker, 'spawned');
      process.stdout.write(`  result:  ${finalResult}\n`);
      reportHerdr(plan, flags);
    }
    return;
  }

  worker = registry.update(worker.id, {
    workerStatus: 'running',
    lastUsed: nowIso(),
    force,
    stopRequested: false,
  });

  if (detach) {
    const superviseArgv = [__filename, '_supervise-headless', worker.id];
    if (force) superviseArgv.push('--force');
    if (timeoutSec) superviseArgv.push('--timeout', String(timeoutSec));
    if (trust === false) superviseArgv.push('--no-trust');
    const child = spawn(process.execPath, superviseArgv, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    if (asJson) {
      emitJson({
        ok: true,
        detached: true,
        supervisorPid: child.pid || null,
        worker: {
          id: worker.id,
          title: worker.title,
          engine: worker.engine,
          result: finalResult,
          workerStatus: 'running',
        },
        parent: { id: parent.id, title: parent.title },
      });
    } else {
      process.stdout.write(`${worker.id}\n`);
      process.stderr.write(
        `detached worker: ${worker.title} (${worker.id}) supervisorPid=${child.pid || '?'}\n` +
          `result: ${finalResult}\n`
      );
    }
    return;
  }

  const { code, timedOut, outPath, stopped, result, runId, registryWriteError } = await executeHeadlessRun(worker, {
    prompt: finalWrapped,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: false,
    json: asJson,
  });

  let workerStatus;
  if (stopped) workerStatus = 'stopped';
  else if (!timedOut && code === 0) workerStatus = 'done';
  else workerStatus = 'failed';
  worker = applyResultHandoffFallback(worker, {
    code,
    timedOut,
    stopped,
    stdout: result && result.stdout,
    resultPath: finalResult,
    runId,
    workerStatus,
    clearRunPid: true,
  });

  if (asJson) {
    emitJson({
      ok: code === 0 && !timedOut,
      worker: {
        id: worker.id,
        title: worker.title,
        engine: worker.engine,
        result: finalResult,
        workerStatus: worker.workerStatus || workerStatus,
        resultSource: worker.resultSource || null,
        lastExit: timedOut ? 124 : code,
        lastOutput: outPath,
      },
      parent: { id: parent.id, title: parent.title },
      outputPath: outPath,
      outputExcerpt: runlib.outputExcerpt((result && result.stdout) || ''),
    });
  } else {
    process.stderr.write(
      `worker: ${worker.title} (${worker.id})\n` +
        `result: ${finalResult}\n` +
        `log: ${outPath}\n`
    );
  }
  process.exitCode = code;
}

/**
 * Internal: detached supervisor for `aflt spawn --detach`.
 * Runs the engine and records lastExit / workerStatus / handoff like the blocking path.
 */
async function cmdSuperviseHeadless(argv) {
  const { args, flags } = parseArgs(argv);
  const id = args[0];
  if (!id) {
    process.stderr.write('usage: aflt _supervise-headless <sessionId>\n');
    process.exitCode = 2;
    return;
  }
  let session;
  try {
    session = registry.find(id);
  } catch (err) {
    process.stderr.write(String(err.message) + '\n');
    process.exitCode = 2;
    return;
  }
  if (!session) {
    process.stderr.write(`session not found: ${id}\n`);
    process.exitCode = 2;
    return;
  }
  const force = flags.force != null ? Boolean(flags.force) : Boolean(session.force);
  const trust = !flags['no-trust'];
  const timeoutSec = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  const prompt = session.prompt || '';
  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  const envOverlay = agentDocs.sessionLaunchEnv(session, {
    ...(session.parent ? { AGENTFLEET_PARENT: session.parent } : {}),
    ...(resultPath ? { AGENTFLEET_RESULT: resultPath } : {}),
  });
  try {
    registry.update(session.id, {
      workerStatus: 'running',
      stopRequested: false,
      force,
      lastUsed: nowIso(),
    });
  } catch (_) {
    /* ignore */
  }
  const { code, timedOut, stopped, result, runId } = await executeHeadlessRun(session, {
    prompt,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 0,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: true,
    json: false,
  });
  let workerStatus;
  if (stopped) workerStatus = 'stopped';
  else if (!timedOut && code === 0) workerStatus = 'done';
  else workerStatus = 'failed';
  // One atomic after-exit write: never publish done before resultSource/resultRunId.
  applyResultHandoffFallback(session, {
    code,
    timedOut,
    stopped,
    stdout: result && result.stdout,
    resultPath,
    runId,
    workerStatus,
    clearRunPid: true,
  });
  process.exitCode = code;
}

async function cmdMaster(argv) {
  const { flags } = parseArgs(argv);
  const goal = flags.goal;
  if (!goal || goal === true) {
    fail(
      'usage: aflt master --goal TEXT [--engine cursor|copilot|opencode] [--cwd DIR] [--title T] [--model X] [--worker-engine copilot|cursor|opencode] [--headless] [--timeout SEC] [--force] [--messaging|--no-messaging] [--no-docs] [--dry-run] [--json]'
    );
  }
  const goalText = String(goal);

  const engineFlag = flags.engine ? String(flags.engine) : null;
  if (engineFlag) {
    try {
      config.validateEngine(engineFlag);
    } catch (err) {
      fail(err.message);
    }
  }
  let resolved;
  try {
    resolved = engine.resolveEngine({ flag: engineFlag });
  } catch (err) {
    fail(err.message);
  }
  const engineName = resolved.engine;

  let workerEngine = flags['worker-engine'] ? String(flags['worker-engine']) : 'copilot';
  try {
    config.validateEngine(workerEngine);
  } catch (err) {
    fail(`--worker-engine: ${err.message}`);
  }

  const force = Boolean(flags.force);
  const dryRun = Boolean(flags['dry-run']);
  const headless = Boolean(flags.headless);
  const trust = !flags['no-trust'];
  const asJson = Boolean(flags.json);
  const timeoutSec = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }

  const cwd = resolveCwd(flags.cwd || flags.C);
  const task = orchestrate.taskFromPrompt(goalText);
  const allSessions = dryRun ? [] : registry.list({ includeDone: true });
  const title =
    typeof flags.title === 'string' && flags.title
      ? String(flags.title)
      : orchestrate.nextMasterTitle(
          goalText,
          allSessions.map((s) => s.title)
        );

  const resultsDir = path.join(fleetDir(), 'results');
  const previewId = 'dry-run-master';
  const previewResult = orchestrate.defaultResultPath(previewId);

  const messagingFlag = messages.normalizeMessagingFlag(flags);

  function buildPromptFor(masterId, masterTitle, resultPath, planPath, messagingEnabled) {
    const tpl = orchestrate.loadOrchestratorTemplate();
    return orchestrate.renderTemplate(tpl, {
      GOAL: goalText,
      MASTER_ID: masterId,
      MASTER_TITLE: masterTitle,
      CWD: cwd,
      DEFAULT_WORKER_ENGINE: workerEngine,
      PLAN: planPath || '',
      MESSAGING: messages.messagingPromptBlock(Boolean(messagingEnabled), { role: 'master' }),
    });
  }

  function masterEnvOverlay(session) {
    const overlay = agentDocs.sessionLaunchEnv(session, {
      AGENTFLEET_RESULT: session.result,
      AGENTFLEET_ROLE: 'master',
      PATH: orchestrate.pathWithAf(process.env),
    });
    if (session.plan) overlay.AGENTFLEET_PLAN = session.plan;
    return overlay;
  }

  const previewPlan = orchestrate.defaultPlanPath(previewId);

  if (dryRun) {
    const previewMessagingOn = messages.isMessagingEnabled({
      id: previewId,
      title,
      cwd,
      role: 'master',
      messaging: messagingFlag,
    }).enabled;
    const prompt = buildPromptFor(previewId, title, previewResult, previewPlan, previewMessagingOn);
    const previewEntry = {
      id: previewId,
      title,
      chatId: '00000000-0000-4000-8000-000000000000',
      cwd,
      engine: engineName,
      model: flags.model || null,
      role: 'master',
      task,
      result: previewResult,
      plan: previewPlan,
      workerStatus: headless ? 'queued' : 'running',
      messaging: messagingFlag,
      prompt,
    };
    applyProjectField(previewEntry, flags);
    if (asJson) {
      emitJson({
            dryRun: true,
            master: previewEntry,
            headless,
            prompt,
          });
    } else {
      process.stderr.write(
        `[dry-run] would create master "${title}" (${engineName})\n` +
          `[dry-run] cwd=${cwd} headless=${headless}\n` +
          `[dry-run] result=${previewResult}\n` +
          `[dry-run] plan=${previewPlan}\n` +
          `[dry-run] worker-engine=${workerEngine}\n`
      );
      if (headless) {
        const shell = headlessCommandPreview(previewEntry, {
          prompt,
          force,
          outputFormat: 'text',
          trust,
          silent: true,
        });
        process.stdout.write(`cd ${JSON.stringify(cwd)} && ${shell}\n`);
      } else {
        const cmd = engine.buildInteractiveCommandString(previewEntry, {
          prompt,
          trust,
          force,
        });
        process.stdout.write(`cd ${JSON.stringify(cwd)} && ${cmd}\n`);
      }
    }
    return;
  }

  const chatId = await createEngineChatId(engineName, { cwd, title });

  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  const plansDir = path.join(fleetDir(), 'plans');
  fs.mkdirSync(plansDir, { recursive: true, mode: 0o700 });

  let master;
  try {
    const masterPartial = {
      title,
      chatId,
      cwd,
      branch: gitBranch(cwd),
      model: flags.model || null,
      prompt: '',
      tags: [],
      status: 'active',
      engine: engineName,
      role: 'master',
      task,
      workerStatus: 'queued',
      force,
      stopRequested: false,
    };
    if (messagingFlag !== null) masterPartial.messaging = messagingFlag;
    applyProjectField(masterPartial, flags);
    master = registry.add(masterPartial);
  } catch (err) {
    fail(err.message);
  }

  const finalResult = master.result || orchestrate.defaultResultPath(master.id);
  const finalPlan = master.plan || orchestrate.defaultPlanPath(master.id);
  const masterMessagingOn = messages.isMessagingEnabled(master).enabled;
  const finalPrompt = buildPromptFor(
    master.id,
    master.title,
    finalResult,
    finalPlan,
    masterMessagingOn
  );
  master = registry.update(master.id, {
    prompt: finalPrompt,
    result: finalResult,
    plan: finalPlan,
    force,
    stopRequested: false,
  });

  const envOverlay = masterEnvOverlay(master);

  try {
    engine.assertEngineAvailable(master);
  } catch (err) {
    fail(err.message);
  }

  if (!headless) {
    const resumeOpts = {
      prompt: finalPrompt,
      trust,
      force,
      herdrApp: herdrapp.herdrAppEnabled(flags),
      envOverlay,
      sessions: registry.list({ includeDone: true }),
    };
    const plan = launchViaHerdr([master], {
      dryRun: false,
      resumeOpts,
      flags,
      json: asJson,
    });
    const launchErr = herdrLaunchFailed(plan);
    if (launchErr) {
      try {
        master = registry.update(master.id, {
          workerStatus: 'failed',
          lastError: launchErr,
          lastUsed: nowIso(),
        });
      } catch (_) { /* ignore */ }
      if (asJson) {
        emitJson({
          ok: false,
          error: launchErr,
          master: {
            id: master.id,
            title: master.title,
            engine: master.engine,
            result: finalResult,
            plan: finalPlan,
            workerStatus: 'failed',
            role: 'master',
            lastError: launchErr,
          },
          herdr: plan,
        });
      } else {
        process.stderr.write(`master launch failed: ${launchErr}\n`);
        reportHerdr(plan, flags);
      }
      process.exitCode = 1;
      return;
    }
    try {
      master = registry.update(master.id, {
        workerStatus: 'running',
        lastUsed: nowIso(),
        lastError: null,
      });
    } catch (_) { /* ignore */ }
    if (asJson) {
      emitJson({
        ok: true,
        master: {
          id: master.id,
          title: master.title,
          engine: master.engine,
          result: finalResult,
          plan: finalPlan,
          workerStatus: 'running',
          role: 'master',
        },
        herdr: plan,
      });
      reportHerdr(plan, { ...flags, json: true });
    } else {
      printSession(master, 'master');
      process.stdout.write(`  result:  ${finalResult}\n`);
      process.stdout.write(`  plan:    ${finalPlan}\n`);
      process.stdout.write(`  role:    master\n`);
      reportHerdr(plan, flags);
    }
    return;
  }

  master = registry.update(master.id, {
    workerStatus: 'running',
    lastUsed: nowIso(),
  });
  const { code, timedOut, outPath, stopped, result, runId, registryWriteError } = await executeHeadlessRun(master, {
    prompt: finalPrompt,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: false,
    json: asJson,
  });

  let workerStatus;
  if (stopped) workerStatus = 'stopped';
  else if (!timedOut && code === 0) workerStatus = 'done';
  else workerStatus = 'failed';
  master = applyResultHandoffFallback(master, {
    code,
    timedOut,
    stopped,
    stdout: result && result.stdout,
    resultPath: finalResult,
    runId,
    workerStatus,
    clearRunPid: true,
  });

  let docsResult = null;
  if (!stopped && !timedOut && code === 0 && !flags['no-docs']) {
    docsResult = await maybeTriggerDocsForMaster(master, {
      runId,
      engine: master.engine || engineName,
      flags,
      asJson,
      quiet: asJson,
    });
  }

  if (asJson) {
    const payload = {
      ok: code === 0 && !timedOut,
      master: {
        id: master.id,
        title: master.title,
        engine: master.engine,
        result: finalResult,
        plan: finalPlan,
        workerStatus,
        role: 'master',
        resultSource: master.resultSource || null,
        lastExit: timedOut ? 124 : code,
        lastOutput: outPath,
        docsTriggeredRunId: (registry.find(master.id) || master).docsTriggeredRunId || null,
      },
      outputPath: outPath,
      outputExcerpt: runlib.outputExcerpt((result && result.stdout) || ''),
    };
    const docsJson = docsTriggerJson(docsResult);
    if (docsJson) payload.docs = docsJson;
    emitJson(payload);
  } else {
    printSession(master, 'master');
    process.stdout.write(`  result:  ${finalResult}\n`);
    process.stdout.write(`  plan:    ${finalPlan}\n`);
    process.stdout.write(`  role:    master\n`);
    process.stderr.write(`log: ${outPath}\n`);
  }
  process.exitCode = code;
}

/** Shape auto-trigger result for master/run --json (`docs` field). */
function docsTriggerJson(docsResult) {
  if (!docsResult) return undefined;
  if (docsResult.skipped) {
    return { skipped: true, reason: docsResult.reason || 'skipped' };
  }
  if (docsResult.ok === false) {
    return {
      ok: false,
      error: docsResult.error || 'docs run failed',
    };
  }
  return docsResult.summary || { ok: true };
}

/**
 * Run documentarian once per master runId when the project has docs enabled.
 * Best-effort: master exit stays 0; stderr WARNING + --json docs:{ok:false,error}.
 */
async function maybeTriggerDocsForMaster(master, opts = {}) {
  if (!master || master.role !== 'master') return { skipped: true, reason: 'not-master' };
  const runId = opts.runId || master.runId;
  if (!runId) return { skipped: true, reason: 'no-runId' };
  const fresh = registry.find(master.id) || master;
  if (fresh.docsTriggeredRunId && fresh.docsTriggeredRunId === runId) {
    return { skipped: true, reason: 'already-triggered', runId };
  }
  let projectRoot;
  try {
    projectRoot = docs.resolveGitRoot(master.cwd);
  } catch (_) {
    return { skipped: true, reason: 'not-git' };
  }
  const project = docs.readProjectDocs(projectRoot);
  if (!project.enabled && !opts.anyway) {
    return { skipped: true, reason: 'disabled' };
  }
  try {
    registry.update(master.id, { docsTriggeredRunId: runId });
  } catch (_) {
    /* ignore */
  }
  const engineName =
    project.docsEngine || opts.engine || master.engine || 'cursor';
  const force =
    opts.force != null
      ? Boolean(opts.force)
      : docs.resolveDocsForce(opts.flags || {}, project);
  try {
    const summary = await runDocsForProject(projectRoot, {
      engine: engineName,
      force,
      anyway: true, // already checked enablement / trigger path
      asJson: Boolean(opts.asJson),
      quiet: opts.quiet !== false,
      trigger: opts.trigger || 'master',
      parentSession: master,
      project: master.project || null,
    });
    if (summary.ok === false) {
      const errMsg =
        summary.error ||
        `docs worker exited ${summary.lastExit != null ? summary.lastExit : 'nonzero'}`;
      process.stderr.write(`WARNING: docs run failed: ${errMsg}\n`);
      return {
        ok: false,
        error: errMsg,
        summary,
        runId,
      };
    }
    return { ok: true, summary, runId };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`WARNING: docs run failed: ${msg}\n`);
    return { ok: false, error: msg, runId };
  }
}

/**
 * Core docs run used by `aflt docs` and auto-triggers. When dryRun, writes nothing.
 */
async function runDocsForProject(projectRoot, opts = {}) {
  const asJson = Boolean(opts.asJson);
  const dryRun = Boolean(opts.dryRun);
  const anyway = Boolean(opts.anyway);
  const quiet = Boolean(opts.quiet);

  const project = docs.readProjectDocs(projectRoot);
  if (!project.enabled && !anyway) {
    const err = new Error(docs.DOCS_NOT_ENABLED(projectRoot));
    err.code = 'DOCS_DISABLED';
    throw err;
  }

  const force =
    opts.force != null
      ? Boolean(opts.force)
      : docs.resolveDocsForce(opts.flags || {}, project);

  let engineName = opts.engine || project.docsEngine || null;
  if (engineName) {
    try {
      config.validateEngine(engineName);
    } catch (err) {
      throw err;
    }
  } else {
    const resolved = engine.resolveEngine({ flag: null });
    engineName = resolved.engine;
  }

  const state = docs.loadState(projectRoot);
  const sinceInfo = docs.resolveSince(projectRoot, {
    sinceFlag: opts.since,
    state,
  });
  const title = docs.docsTitleFor(projectRoot);
  // Always load sessions for timeline (read-only); dry-run still includes timeline.
  const sessions = registry.list({ includeDone: true });
  const previewId = 'dry-run-docs';
  const previewResult = orchestrate.defaultResultPath(previewId);

  const resolvedInstructions = docs.resolveDocsInstructions(
    projectRoot,
    project.docsInstructions
  );
  const instructionFiles = {
    used: resolvedInstructions.used.map((u) => ({
      path: u.path,
      bytes: u.bytes,
      truncated: u.truncated,
    })),
    skipped: resolvedInstructions.skipped.map((s) => ({
      path: s.path,
      reason: s.reason,
    })),
  };

  const projectCache = projectLib.createLookupCache();
  const docsProjectName = projectLib.resolveProjectForCreate({
    flag: opts.project,
    parent: opts.parentSession || null,
    cwd: projectRoot,
    cache: projectCache,
  });
  const timelineInfo = timeline.buildDocsTimelineSection(sessions, {
    projectRoot,
    project: docsProjectName,
    sinceIso: state && state.lastRunAt ? state.lastRunAt : null,
    cache: projectCache,
  });

  if (dryRun) {
    const built = docs.buildPrompt(projectRoot, {
      docsPaths: project.docsPaths,
      instructions: resolvedInstructions,
      changelogAllowed: project.changelogAllowed,
      sinceInfo,
      state,
      sessions: opts.sessions || sessions,
      resultPath: previewResult,
      timeline: timelineInfo,
    });
    const plan = {
      ok: true,
      dryRun: true,
      projectRoot,
      since: sinceInfo.since,
      sinceSource: sinceInfo.source,
      head: sinceInfo.head,
      docsPaths: project.docsPaths,
      docsInstructions: project.docsInstructions.slice(),
      instructionFiles,
      changelogAllowed: project.changelogAllowed,
      engine: engineName,
      model: opts.model || null,
      title,
      promptBytes: built.promptBytes,
      timelineBytes: built.timelineBytes || 0,
      force,
      anyway,
    };
    if (asJson) {
      emitJson(plan);
    } else {
      process.stderr.write(
        `[dry-run] docs for ${projectRoot}\n` +
          `[dry-run] since=${sinceInfo.since || '-'} (${sinceInfo.source}) engine=${engineName} force=${force}\n` +
          `[dry-run] docsPaths=${project.docsPaths.join(', ')} changelog=${project.changelogAllowed}\n` +
          `[dry-run] promptBytes=${built.promptBytes} timelineBytes=${built.timelineBytes || 0} title=${title}\n`
      );
      if (instructionFiles.used.length || instructionFiles.skipped.length) {
        for (const u of instructionFiles.used) {
          process.stderr.write(
            `[dry-run] docsInstructions used ${u.path} (${u.bytes} bytes${u.truncated ? ', truncated' : ''})\n`
          );
        }
        for (const s of instructionFiles.skipped) {
          process.stderr.write(
            `[dry-run] docsInstructions skipped ${s.path}: ${s.reason}\n`
          );
        }
      }
      process.stdout.write(built.prompt.slice(0, 500) + (built.prompt.length > 500 ? '\n…\n' : '\n'));
    }
    return plan;
  }

  const beforeSnap = docs.snapshotWorkingTree(projectRoot);
  const headAtStart = sinceInfo.head || docs.headCommit(projectRoot);

  let session = null;
  try {
    session = registry.find(title);
  } catch (_) {
    session = null;
  }
  if (session && session.role && session.role !== 'docs') {
    throw new Error(`session title "${title}" exists with role=${session.role}; refuse to reuse`);
  }

  if (!session) {
    const chatId = await createEngineChatId(engineName, {
      cwd: projectRoot,
      title,
      quiet,
    });
    fs.mkdirSync(path.join(fleetDir(), 'results'), { recursive: true, mode: 0o700 });
    const docsEntry = {
      title,
      chatId,
      cwd: projectRoot,
      branch: gitBranch(projectRoot),
      model: opts.model || null,
      prompt: '',
      tags: [],
      status: 'active',
      engine: engineName,
      role: 'docs',
      task: 'documentarian',
      workerStatus: 'queued',
      force,
      stopRequested: false,
      project: docsProjectName,
    };
    // When triggered from a master, set parent so the docs session joins the tree.
    if (opts.parentSession && opts.parentSession.id) {
      docsEntry.parent = opts.parentSession.id;
    }
    session = registry.add(docsEntry);
  } else {
    const patch = {
      cwd: projectRoot,
      branch: gitBranch(projectRoot),
      role: 'docs',
      task: 'documentarian',
      workerStatus: 'queued',
      force,
      stopRequested: false,
      status: 'active',
      project: docsProjectName,
    };
    if (opts.parentSession && opts.parentSession.id && !session.parent) {
      patch.parent = opts.parentSession.id;
    }
    if (opts.model) patch.model = opts.model;
    if (engineName && (session.engine || 'cursor') !== engineName) {
      // Keep existing engine unless caller overrides via --engine
      if (opts.engine) patch.engine = engineName;
      else engineName = session.engine || 'cursor';
    } else if (opts.engine) {
      patch.engine = engineName;
    }
    session = registry.update(session.id, patch);
  }

  const finalResult = session.result || orchestrate.defaultResultPath(session.id);
  const rebuilt = docs.buildPrompt(projectRoot, {
    docsPaths: project.docsPaths,
    instructions: resolvedInstructions,
    changelogAllowed: project.changelogAllowed,
    sinceInfo,
    state,
    sessions,
    resultPath: finalResult,
    timeline: timelineInfo,
  });
  session = registry.update(session.id, {
    prompt: rebuilt.prompt,
    result: finalResult,
    workerStatus: 'running',
    lastUsed: nowIso(),
  });

  try {
    engine.assertEngineAvailable(session);
  } catch (err) {
    throw err;
  }

  const envOverlay = agentDocs.sessionLaunchEnv(session, {
    AGENTFLEET_RESULT: finalResult,
    AGENTFLEET_ROLE: 'docs',
    PATH: orchestrate.pathWithAf(process.env),
  });

  const { code, timedOut, outPath, stopped, result, runId, registryWriteError } =
    await executeHeadlessRun(session, {
      prompt: rebuilt.prompt,
      force,
      outputFormat: 'text',
      trust: true,
      timeoutSec: opts.timeoutSec || 0,
      silent: true,
      env: { ...process.env, ...envOverlay },
      quietCopilotHints: quiet,
      json: asJson,
    });

  let workerStatus;
  if (stopped) workerStatus = 'stopped';
  else if (!timedOut && code === 0) workerStatus = 'done';
  else workerStatus = 'failed';
  session = applyResultHandoffFallback(session, {
    code,
    timedOut,
    stopped,
    stdout: result && result.stdout,
    resultPath: finalResult,
    runId,
    workerStatus,
    clearRunPid: true,
  });

  const { changed } = docs.changedPathsSince(projectRoot, beforeSnap);
  const { docFiles, nonDocFiles } = docs.classifyChangedFiles(changed, project.docsPaths);
  const warnings = docs.warningsForNonDocs(nonDocFiles);
  for (const w of warnings) {
    process.stderr.write(`WARNING: ${w}\n`);
  }

  const ok = !stopped && !timedOut && code === 0;
  if (ok) {
    docs.saveState(projectRoot, {
      lastRunAt: nowIso(),
      lastCommit: headAtStart,
      lastSessionId: session.id,
      lastChangedFiles: docFiles,
      lastWarnings: warnings,
    });
  }

  const summary = {
    ok,
    projectRoot,
    since: sinceInfo.since,
    sinceSource: sinceInfo.source,
    head: headAtStart,
    docsPaths: project.docsPaths,
    changelogAllowed: project.changelogAllowed,
    force,
    docFilesChanged: docFiles,
    warnings,
    promptBytes: rebuilt.promptBytes,
    timelineBytes: rebuilt.timelineBytes || 0,
    session: {
      id: session.id,
      title: session.title,
      engine: session.engine || engineName,
      result: finalResult,
      workerStatus,
      role: 'docs',
      project: session.project || docsProjectName,
      parent: session.parent || null,
    },
    handoff: finalResult,
    outputPath: outPath,
    lastExit: timedOut ? 124 : code,
  };
  if (!ok) {
    summary.error = `docs worker exited ${summary.lastExit}`;
  }
  if (registryWriteError) summary.registryWriteError = registryWriteError;

  if (!quiet) {
    if (asJson) {
      emitJson(summary);
    } else {
      printSession(session, 'docs');
      process.stdout.write(`  result:  ${finalResult}\n`);
      process.stdout.write(`  role:    docs\n`);
      process.stdout.write(`  since:   ${sinceInfo.since || '-'} .. ${headAtStart || '-'}\n`);
      process.stdout.write(
        `  docs:    ${docFiles.length ? docFiles.join(', ') : '(none detected)'}\n`
      );
      if (warnings.length) {
        process.stdout.write(`  warnings:${warnings.length}\n`);
      }
      process.stderr.write(`log: ${outPath}\n`);
    }
  }

  summary._exitCode = timedOut ? 124 : code;
  return summary;
}

/**
 * parseArgs treats `--flag value` as a valued flag. For boolean flags
 * (`--status`, `--keep-files`, `--json`, …), recover a consumed positional.
 */
function recoverBoolFlag(flags, key, positionalArgs) {
  const v = flags[key];
  if (v == null || v === false) return false;
  if (v === true) return true;
  positionalArgs.unshift(String(v));
  return true;
}

function docsRecoverBoolFlag(flags, key, dirArgs) {
  return recoverBoolFlag(flags, key, dirArgs);
}

function cmdDocsStatus({ asJson, wantAll }, dirArgsIn) {
  const dirArgs = Array.isArray(dirArgsIn) ? dirArgsIn.slice() : [];

  /** @type {string[]} */
  const targets = [];
  const seen = new Set();
  const addTarget = (dir) => {
    let abs;
    try {
      abs = path.resolve(dir);
    } catch (_) {
      abs = String(dir);
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    targets.push(abs);
  };

  for (const d of dirArgs) {
    if (d == null || d === '') continue;
    addTarget(d);
  }

  if (wantAll) {
    let sessions = [];
    try {
      sessions = registry.list({ includeDone: true });
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    for (const root of docs.projectDirsFromSessions(sessions)) {
      addTarget(root);
    }
  }

  if (!targets.length) {
    addTarget(process.cwd());
  }

  const projects = targets.map((dir) => {
    const status = docs.collectProjectDocsStatus(dir, {
      warn: (msg) => {
        try {
          process.stderr.write(`WARNING: ${msg}\n`);
        } catch (_) {
          /* ignore */
        }
      },
    });
    if (status.error) return status;
    const ctx = agentDocs.resolveAgentDocsContext(
      { cwd: status.root, project: null },
      { cwd: status.root }
    );
    let checkpoint = null;
    if (ctx.enabled) {
      checkpoint = agentDocs.summarizeCheckpoint(ctx.project, {
        hours: ctx.checkpointHours,
        retryMax: ctx.retryMax,
        retryBackoffMinutes: ctx.retryBackoffMinutes,
      });
    }
    return {
      ...status,
      agentDocs: {
        enabled: ctx.enabled,
        project: ctx.project,
        memoryRepo: ctx.memoryRepo,
        memoryMissing: ctx.missing.includes('memoryRepo'),
        processDocPath: ctx.processDocPath,
        agentDocsPath: ctx.agentDocsPath,
        agentsMdPath: ctx.agentsMdPath,
        warnings: ctx.warnings,
        boundaries: ctx.boundaries,
        requireNote: ctx.requireNote,
        statusNotes: ctx.statusNotes,
        archivePolicy: ctx.archivePolicy,
        checkpoint,
        docBotQueue: agentDocs.summarizeDocBotQueue(),
        docBotNotify: agentDocs.DOC_BOT_NOTIFY_DEFERRED,
      },
    };
  });

  if (asJson) {
    emitJson({ ok: true, projects });
  } else {
    for (const p of projects) {
      if (p.error) {
        process.stdout.write(`docs-status  ${p.root}\n`);
        process.stdout.write(`  error:     ${p.error}\n`);
        continue;
      }
      const last =
        p.lastRun && (p.lastRun.commit || p.lastRun.at)
          ? `${p.lastRun.commit || '-'} @ ${p.lastRun.at || '-'}`
          : '(none)';
      const cs = p.commitsSince || {};
      let sinceLine;
      if (cs.unknown) {
        sinceLine = `unknown lastCommit (${(p.lastRun && p.lastRun.commit) || '?'})`;
      } else if (cs.count == null) {
        sinceLine = '-';
      } else {
        const sample =
          Array.isArray(cs.commits) && cs.commits.length
            ? `; ${cs.commits.slice(0, 3).join(' | ')}${cs.commits.length > 3 ? ' …' : ''}`
            : '';
        sinceLine = `${cs.count}${cs.source === 'all' ? ' (all)' : ''}${sample}`;
      }
      const usedN =
        p.docsInstructions && p.docsInstructions.used ? p.docsInstructions.used.length : 0;
      const skipN =
        p.docsInstructions && p.docsInstructions.skipped
          ? p.docsInstructions.skipped.length
          : 0;
      process.stdout.write(`docs-status  ${p.root}\n`);
      process.stdout.write(
        `  enabled:   ${p.docsEnabled}  needsDocs: ${p.needsDocs}  ready: ${p.ready}  head: ${p.headCommit || '-'}\n`
      );
      process.stdout.write(`  docsPaths: ${(p.docsPaths || []).join(', ') || '-'}\n`);
      process.stdout.write(`  lastRun:   ${last}\n`);
      process.stdout.write(`  since:     ${sinceLine}\n`);
      process.stdout.write(
        `  dirtyDocs: ${(p.dirtyDocs && p.dirtyDocs.length ? p.dirtyDocs.join(', ') : '(none)')}` +
          `\n`
      );
      if (p.skip) {
        process.stdout.write(`  skip:      ${p.skipReason} (commit or discard docs edits first)\n`);
      }
      process.stdout.write(`  instr:     used=${usedN} skipped=${skipN}\n`);
      if (p.agentDocs && p.agentDocs.enabled) {
        const cp = p.agentDocs.checkpoint;
        const cpLine = cp
          ? `progress=${cp.progress} missing=${cp.missing} overdue=${cp.overdue}` +
            (cp.ageHours != null ? ` ageHours=${cp.ageHours.toFixed(2)}` : '')
          : '-';
        process.stdout.write(`  agentDocs: project=${p.agentDocs.project}  ${cpLine}\n`);
        if (p.agentDocs.memoryMissing) {
          process.stdout.write(
            `  memory:    MISSING (run aflt memory init <path> or set AFLT_MEMORY_REPO)\n`
          );
        }
      }
    }
  }
  process.exitCode = 0;
}

function cmdDocsCheckpoint(argv) {
  const { args, flags } = parseArgs(argv);
  const action = args[0] ? String(args[0]) : '';
  const dirArg = args[1] || flags.cwd || flags.C || process.cwd();
  const asJson = Boolean(flags.json);
  if (action !== 'request' && action !== 'complete') {
    fail(
      'usage: aflt docs checkpoint request|complete [<dir>] [--project NAME] [--reason T] [--note PATH] [--json]',
      { json: asJson }
    );
  }
  const cwd = resolveCwd(dirArg);
  const projectFlag =
    flags.project && flags.project !== true ? String(flags.project).trim() : null;
  const ctx = agentDocs.resolveAgentDocsContext(
    { cwd, project: projectFlag },
    { cwd, project: projectFlag }
  );
  if (!ctx.enabled && !projectFlag) {
    fail(
      `agentDocs not enabled for ${cwd} (add {"agentDocs": true} to .agentfleet.json)`,
      { json: asJson }
    );
  }
  const project = projectFlag || ctx.project;
  let summary;
  if (action === 'request') {
    const reason =
      flags.reason && flags.reason !== true ? String(flags.reason) : 'manual';
    summary = agentDocs.requestCheckpoint(project, {
      sessionId: process.env.AGENTFLEET_ID || process.env.AGENTFLEET_SESSION || null,
      reason,
      boundary: 'manual',
      hours: ctx.checkpointHours,
    });
  } else {
    const note =
      flags.note && flags.note !== true ? String(flags.note) : null;
    try {
      summary = agentDocs.completeCheckpoint(project, {
        sessionId: process.env.AGENTFLEET_ID || process.env.AGENTFLEET_SESSION || null,
        notePath: note,
        cwd,
        requireNote: ctx.requireNote,
      });
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
  }
  const docBotNotify = summary.docBotNotify || {
    sent: false,
    issue: 2,
    reason: 'no notify result',
  };
  const { docBotNotify: _drop, ...checkpoint } = summary;
  const payload = {
    ok: true,
    action,
    project,
    checkpoint,
    docBotNotify,
    docBotQueue: agentDocs.summarizeDocBotQueue(),
    warnings: ctx.warnings,
    missing: ctx.missing,
  };
  if (asJson) {
    emitJson(payload);
    return;
  }
  process.stdout.write(
    `docs-checkpoint  ${action}  project=${project}  progress=${summary.progress}` +
      `  missing=${summary.missing}  overdue=${summary.overdue}\n`
  );
  for (const w of ctx.warnings) {
    process.stderr.write(`WARNING: ${w}\n`);
  }
  if (docBotNotify.sent) {
    process.stderr.write(
      `note: Doc Bot batch notified (${docBotNotify.batchId || (docBotNotify.message && docBotNotify.message.id)}).\n`
    );
  } else if (docBotNotify.reason) {
    process.stderr.write(`note: Doc Bot notify (${docBotNotify.reason}).\n`);
  }
}

function cmdDocsNotify(argv) {
  const { args, flags } = parseArgs(argv);
  const action = args[0] ? String(args[0]) : '';
  const asJson = Boolean(flags.json);
  if (!['flush', 'ack', 'status', 'retry'].includes(action)) {
    fail(
      'usage: aflt docs notify flush|ack|status|retry [<dir>] [--project NAME] [--id ID] [--json]',
      { json: asJson }
    );
  }
  const dirArg = args[1] || flags.cwd || flags.C || process.cwd();
  const cwd = resolveCwd(dirArg);
  const projectFlag =
    flags.project && flags.project !== true ? String(flags.project).trim() : null;
  const idFlag = flags.id && flags.id !== true ? String(flags.id).trim() : null;

  if (action === 'status') {
    const queue = agentDocs.summarizeDocBotQueue();
    const fleet = agentDocs.resolveFleetAgentDocsConfig();
    const payload = { ok: true, action, queue, fleet };
    if (asJson) {
      emitJson(payload);
      return;
    }
    process.stdout.write(
      `docs-notify  status  pending=${queue.pending} ready=${queue.pendingNoteReady}` +
        ` batches=${queue.batches} acked=${queue.batchesAcked}\n`
    );
    return;
  }

  if (action === 'ack') {
    const id = idFlag || (args[1] && !args[1].startsWith('-') ? String(args[1]) : null);
    if (!id) {
      fail('usage: aflt docs notify ack --id <batchId|messageId> [--json]', { json: asJson });
    }
    const result = agentDocs.ackDocBotBatch(id);
    if (!result.ok) fail(result.reason || 'ack failed', { json: asJson });
    if (asJson) {
      emitJson({ ok: true, action, batch: result.batch, already: Boolean(result.already) });
      return;
    }
    process.stdout.write(
      `docs-notify  ack  batch=${result.batch.id}  status=${result.batch.status}\n`
    );
    return;
  }

  if (action === 'retry') {
    const result = agentDocs.processCheckpointRetries({
      projects: projectFlag ? [projectFlag] : undefined,
    });
    if (asJson) {
      emitJson({ ok: true, action, ...result });
      return;
    }
    const n = (result.results || []).filter((r) => r.retried).length;
    process.stdout.write(`docs-notify  retry  retried=${n}\n`);
    return;
  }

  // flush
  const ctx = agentDocs.resolveAgentDocsContext(
    { cwd, project: projectFlag },
    { cwd, project: projectFlag }
  );
  const project = projectFlag || ctx.project;
  const result = agentDocs.flushDocBotBatch({
    project: projectFlag || undefined,
    sessionId: process.env.AGENTFLEET_ID || process.env.AGENTFLEET_SESSION || null,
  });
  if (asJson) {
    emitJson({ ok: true, action, project, ...result, queue: agentDocs.summarizeDocBotQueue() });
    return;
  }
  process.stdout.write(
    `docs-notify  flush  project=${project}  flushed=${result.flushed || 0}` +
      `  sent=${Boolean(result.sent)}` +
      (result.batch ? `  batch=${result.batch.id}` : '') +
      `\n`
  );
  if (result.reason && !result.sent) {
    process.stderr.write(`note: ${result.reason}\n`);
  }
}

async function cmdDocs(argv) {
  const { args, flags } = parseArgs(argv);
  const dirArgs = args.slice();
  const wantStatus = docsRecoverBoolFlag(flags, 'status', dirArgs);

  if (wantStatus) {
    const wantAll = docsRecoverBoolFlag(flags, 'all', dirArgs);
    const statusJson = docsRecoverBoolFlag(flags, 'json', dirArgs);
    cmdDocsStatus({ asJson: statusJson, wantAll }, dirArgs);
    return;
  }

  if (args[0] === 'checkpoint') {
    const idx = argv.indexOf('checkpoint');
    cmdDocsCheckpoint(idx >= 0 ? argv.slice(idx + 1) : args.slice(1));
    return;
  }

  if (args[0] === 'notify') {
    const idx = argv.indexOf('notify');
    cmdDocsNotify(idx >= 0 ? argv.slice(idx + 1) : args.slice(1));
    return;
  }

  const asJson = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const anyway = Boolean(flags.anyway);
  const dirArg = args[0] || flags.cwd || flags.C || process.cwd();
  const cwd = resolveCwd(dirArg);

  let projectRoot;
  try {
    projectRoot = docs.resolveGitRoot(cwd);
  } catch (err) {
    fail(err.message, { json: asJson });
  }

  const engineFlag = flags.engine ? String(flags.engine) : null;
  if (engineFlag) {
    try {
      config.validateEngine(engineFlag);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
  }

  const timeoutSec = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds', { json: asJson });
  }

  let summary;
  try {
    summary = await runDocsForProject(projectRoot, {
      since: flags.since,
      engine: engineFlag,
      model: flags.model && flags.model !== true ? String(flags.model) : null,
      flags,
      anyway,
      dryRun,
      asJson,
      quiet: false,
      timeoutSec,
    });
  } catch (err) {
    fail(err.message, { json: asJson });
  }
  if (!dryRun && summary && summary._exitCode != null) {
    process.exitCode = summary._exitCode;
  }
}

function cmdMsgEnableDisable(action, query, flags) {
  const asJson = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  if (!query) fail(`usage: aflt msg ${action} <session> [--json] [--dry-run]`, { json: asJson });
  let session;
  try {
    session = registry.find(query);
  } catch (err) {
    fail(err.message, { json: asJson });
  }
  if (!session) fail(`session not found: ${query}`, { json: asJson });
  const next = action === 'enable' ? true : false;
  if (dryRun) {
    if (asJson) {
      emitJson({
        ok: true,
        dryRun: true,
        session: { id: session.id, title: session.title },
        messaging: next,
      });
    } else {
      process.stdout.write(
        `[dry-run] would set messaging=${next} on ${session.title} (${session.id})\n`
      );
    }
    return;
  }
  session = registry.update(session.id, { messaging: next });
  if (asJson) {
    emitJson({
      ok: true,
      session: { id: session.id, title: session.title },
      messaging: session.messaging,
    });
  } else {
    process.stdout.write(`messaging ${next ? 'enabled' : 'disabled'} for ${session.title}\n`);
  }
}

function cmdMsg(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);

  if (args[0] === 'enable' || args[0] === 'disable') {
    cmdMsgEnableDisable(args[0], args[1], flags);
    return;
  }

  const fromQuery = messages.resolveFromId(flags, process.env);
  if (!fromQuery) {
    fail(
      'sender unknown: pass --from <session> or run inside an af-launched session (AGENTFLEET_SESSION/AGENTFLEET_ID)',
      { json: asJson }
    );
  }

  let fromSession;
  try {
    fromSession = registry.find(fromQuery);
  } catch (err) {
    fail(err.message, { json: asJson });
  }
  if (!fromSession) fail(`sender session not found: ${fromQuery}`, { json: asJson });

  let to = null;
  let textParts = [];
  const replyTo =
    flags.reply != null && flags.reply !== true ? String(flags.reply) : null;

  if (replyTo && args.length >= 1) {
    // With --reply: if first arg is an alias or exact session, treat as <to>; else all args are text.
    if (args[0] === 'master' || args[0] === 'all-siblings') {
      to = args[0];
      textParts = args.slice(1);
    } else {
      let maybeTo = null;
      try {
        maybeTo = messages.resolveExactSession(
          args[0],
          registry.list({ includeDone: true, includeArchived: true })
        );
      } catch (_) {
        maybeTo = null;
      }
      if (maybeTo) {
        to = args[0];
        textParts = args.slice(1);
      } else {
        to = null; // default to reply sender inside postMessage
        textParts = args;
      }
    }
  } else {
    to = args[0] || null;
    textParts = args.slice(1);
  }

  const text = textParts.join(' ');
  if (!replyTo && !to) {
    fail(
      'usage: aflt msg <to> <text...> [--type T] [--reply <msgId>] [--from S] [--json] [--dry-run]\n' +
        '       aflt msg --reply <msgId> <text...>  (defaults to=reply sender)\n' +
        '       <to> = exact id | unique exact title | master | all-siblings',
      { json: asJson }
    );
  }
  if (!text.trim()) {
    fail('message text is required', { json: asJson });
  }

  try {
    const result = messages.postMessage({
      fromSession,
      to,
      text,
      type: flags.type,
      replyTo,
      sessions: registry.list({ includeDone: true, includeArchived: true }),
      dryRun,
    });
    if (asJson) {
      emitJson({
        ok: true,
        dryRun: Boolean(result.dryRun),
        message: result.message,
        skipped: (result.skipped || []).map((s) => ({ id: s.id, title: s.title })),
      });
    } else if (dryRun) {
      process.stdout.write(`${result.message.id}\n`);
      process.stderr.write('[dry-run] validated; wrote nothing\n');
      if (result.skipped && result.skipped.length) {
        process.stderr.write(
          `skipped (messaging off): ${result.skipped.map((s) => s.title).join(', ')}\n`
        );
      }
    } else {
      process.stdout.write(`${result.message.id}\n`);
      if (result.skipped && result.skipped.length) {
        process.stderr.write(
          `skipped (messaging off): ${result.skipped.map((s) => s.title).join(', ')}\n`
        );
      }
    }
  } catch (err) {
    fail(err.message, { json: asJson });
  }
}

function cmdInbox(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const unreadOnly = Boolean(flags.unread);
  const markRead = Boolean(flags['mark-read']);
  const markComplete = Boolean(flags['mark-complete']);
  const statusFilter =
    flags.status != null && flags.status !== true ? String(flags.status).trim() : null;
  if (statusFilter && !messages.MSG_STATUSES.has(statusFilter)) {
    fail('invalid --status (want queued|read|completed)', { json: asJson });
  }
  const query = args[0] || messages.resolveEnvSessionId(process.env);
  if (!query) {
    fail(
      'usage: aflt inbox [<session>] [--unread] [--status queued|read|completed]\n' +
        '                  [--mark-read|--mark-complete] [--json]\n' +
        '(default session: AGENTFLEET_SESSION / AGENTFLEET_ID)',
      { json: asJson }
    );
  }

  let session;
  try {
    session = registry.find(query);
  } catch (err) {
    fail(err.message, { json: asJson });
  }
  if (!session) fail(`session not found: ${query}`, { json: asJson });

  // Human viewing from a plain shell (no AGENTFLEET_SESSION) is allowed without enablement.
  const envId = messages.resolveEnvSessionId(process.env);
  const viewingAsHuman = !envId;
  if (!viewingAsHuman) {
    try {
      messages.assertEnabled(session);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
  }

  const inbox = messages.inboxForSession(session, {
    unreadOnly,
    status: statusFilter,
  });
  if (!viewingAsHuman && inbox.length && (markRead || markComplete)) {
    messages.markMessages(
      inbox.map((m) => m.id),
      session.id,
      { complete: markComplete }
    );
    for (const m of inbox) {
      m.status = markComplete ? 'completed' : 'read';
      m.read = true;
    }
  }

  if (asJson) {
    emitJson({ session: { id: session.id, title: session.title }, messages: inbox });
    return;
  }
  if (inbox.length === 0) {
    process.stdout.write('(no messages)\n');
    return;
  }
  process.stdout.write(
    `${pad('STATUS', 9)} ${pad('ID', 12)} ${pad('FROM', 16)} ${pad('TYPE', 8)} ${pad('THREAD', 12)} TEXT\n`
  );
  for (const m of inbox) {
    process.stdout.write(
      `${pad(m.status || 'queued', 9)} ${pad(m.id, 12)} ${pad(displayId(m.from, 16), 16)} ${pad(m.type || 'note', 8)} ${pad(m.thread || '', 12)} ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 80)}\n`
    );
  }
}

function cmdThread(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const query = args[0];
  if (!query) fail('usage: aflt thread <msgId|master> [--json]', { json: asJson });

  const envId = messages.resolveEnvSessionId(process.env);
  // Human plain-shell viewing is allowed; an in-session identity must be messaging-enabled.
  if (envId) {
    let self;
    try {
      self = registry.find(envId);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    if (self) {
      try {
        messages.assertEnabled(self);
      } catch (err) {
        fail(err.message, { json: asJson });
      }
    }
  }

  // Prefer master/session lookup for whole-team log.
  let asSession = null;
  try {
    asSession = registry.find(query);
  } catch (_) {
    asSession = null;
  }

  if (asSession && (asSession.role === 'master' || messages.teamIdOf(asSession) === asSession.id)) {
    const teamId = asSession.id;
    const records = messages.readLog(teamId).filter((r) => r && r.kind === 'msg');
    if (asJson) {
      emitJson({ team: teamId, messages: records });
      return;
    }
    if (records.length === 0) {
      process.stdout.write('(no messages)\n');
      return;
    }
    for (const m of records) {
      process.stdout.write(
        `${m.ts || ''} ${m.id} ${m.from} → ${m.to} [${m.type}] ${String(m.text || '').replace(/\s+/g, ' ')}\n`
      );
    }
    return;
  }

  const hit = messages.findMessageAnywhere(query);
  if (!hit) fail(`message or master not found: ${query}`, { json: asJson });
  const thread = messages.threadMessages(hit.records, hit.msg.thread || hit.msg.id);
  if (asJson) {
    emitJson({ thread: hit.msg.thread || hit.msg.id, messages: thread });
    return;
  }
  for (const m of thread) {
    process.stdout.write(
      `${m.ts || ''} ${m.id} ${m.from} → ${m.to} [${m.type}] ${String(m.text || '').replace(/\s+/g, ' ')}\n`
    );
  }
}

async function cmdMcp(argv) {
  const { args, flags } = parseArgs(argv);
  if (args[0] === 'install') {
    const asJson = Boolean(flags.json);
    const engineName = flags.engine ? String(flags.engine) : null;
    if (!engineName) {
      fail(
        'usage: aflt mcp install --engine copilot|cursor [--write] [--project] [--cwd DIR] [--dry-run] [--json]',
        { json: asJson }
      );
    }
    try {
      const result = mcp.installMcp({
        engine: engineName,
        write: Boolean(flags.write),
        project: Boolean(flags.project),
        cwd: flags.cwd && flags.cwd !== true ? resolveCwd(flags.cwd) : process.cwd(),
        dryRun: Boolean(flags['dry-run']),
      });
      if (asJson) {
        emitJson(result);
      } else if (result.wrote) {
        process.stderr.write(
          `wrote ${result.path}${result.backup ? ` (backup ${result.backup})` : ''}\n`
        );
        process.stdout.write(JSON.stringify(result.snippet, null, 2) + '\n');
      } else {
        process.stdout.write(JSON.stringify(result.snippet, null, 2) + '\n');
      }
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    return;
  }
  if (args.length > 0) {
    fail(
      'usage: aflt mcp | aflt mcp install --engine copilot|cursor [--write] [--project] [--cwd DIR] [--dry-run] [--json]'
    );
  }
  await mcp.runServer();
}

function listChildrenOf(masterId) {
  return registry
    .list({ includeDone: true, includeArchived: true })
    .filter((s) => s.parent === masterId)
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
}

function resolveChildrenMaster(args, flags) {
  if (args[0]) {
    let s;
    try {
      s = registry.find(args[0]);
    } catch (err) {
      fail(err.message);
    }
    if (!s) fail(`session not found: ${args[0]}`);
    return s;
  }
  const idEnv = process.env.AGENTFLEET_ID;
  if (idEnv) {
    const self = registry.find(idEnv);
    if (self && (self.role === 'master' || listChildrenOf(self.id).length > 0)) {
      return self;
    }
  }
  const parentEnv = process.env.AGENTFLEET_PARENT;
  if (parentEnv) {
    const p = registry.find(parentEnv);
    if (p) return p;
  }
  return null;
}

function cmdChildren(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const includeDoneMasters = Boolean(flags.all);

  const master = resolveChildrenMaster(args, flags);
  if (!master && !args[0]) {
    // Summarize all masters
    const sessions = registry.list({ includeDone: true });
    const childParentIds = new Set(sessions.filter((s) => s.parent).map((s) => s.parent));
    let masters = sessions.filter(
      (s) => s.role === 'master' || childParentIds.has(s.id)
    );
    if (!includeDoneMasters) {
      masters = masters.filter((s) => s.status !== 'done');
    }
    masters.sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));

    const rows = masters.map((m) => {
      const kids = listChildrenOf(m.id);
      const counts = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 };
      for (const k of kids) {
        const st = k.workerStatus || 'stopped';
        if (counts[st] != null) counts[st]++;
        else counts.stopped++;
      }
      return {
        id: m.id,
        title: m.title,
        engine: m.engine || 'cursor',
        status: m.status,
        childCount: kids.length,
        workerStatusCounts: counts,
      };
    });

    if (asJson) {
      emitJson({ masters: rows });
      return;
    }
    if (rows.length === 0) {
      process.stdout.write('(no masters)\n');
      return;
    }
    process.stdout.write(
      `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('ENGINE', 8)} ${pad('KIDS', 5)} ${pad('RUN', 4)} ${pad('DONE', 5)} ${pad('FAIL', 5)} STATUS\n`
    );
    for (const r of rows) {
      process.stdout.write(
        `${pad(r.title, 24)} ${pad(displayId(r.id, ID_COL), ID_COL)} ${pad(r.engine, 8)} ${pad(String(r.childCount), 5)} ${pad(String(r.workerStatusCounts.running), 4)} ${pad(String(r.workerStatusCounts.done), 5)} ${pad(String(r.workerStatusCounts.failed), 5)} ${r.status}\n`
      );
    }
    return;
  }

  if (!master) fail(`session not found: ${args[0]}`);

  const children = listChildrenOf(master.id);
  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    process.stderr.write(`herdr: ${fetchResult.error || 'query failed'} (showing stored workerStatus)\n`);
  }
  const enriched = herdr.enrichSessions(children, fetchResult);

  const rows = enriched.map((e) => {
    const s = e.session;
    const agentState = orchestrate.agentStateFromHerdr(e);
    const waitInfo = orchestrate.detectWaitingTransition({
      agentState,
      seenWorking: Boolean(s._seenWorking),
      idleTicks: 0,
    });
    const liveOpts = { isAlive: orchestrate.defaultIsAlive, hostname: os.hostname() };
    const recon = orchestrate.reconcileDeadRunPid(s, liveOpts);
    const derived = orchestrate.deriveWorkerStatus(
      s,
      {
        runtime: e.runtime,
        exitCode: e.exitCode,
        waitingHint: waitInfo.hint === 'waiting' ? 'waiting' : null,
      },
      liveOpts
    );
    const resultPath = s.result || orchestrate.defaultResultPath(s.id);
    const hand = orchestrate.handoffInfo(s, resultPath);
    const meta = orchestrate.waitOutcomeMeta(s, {
      runtime: e.runtime,
      exitCode: e.exitCode,
      agentState,
      derivedStatus: derived,
      ...liveOpts,
    });
    if (recon && recon.persist && recon.patch) {
      const wr = registry.bestEffortUpdate(s.id, recon.patch);
      if (wr.ok && wr.session) Object.assign(s, wr.session);
    }
    const eff = messages.isMessagingEnabled(s);
    return {
      id: s.id,
      title: s.title,
      engine: s.engine || 'cursor',
      cwd: s.cwd,
      task: s.task || '',
      workerStatus: derived,
      outcome: meta.outcome,
      stateSource: meta.stateSource,
      conclusive: meta.conclusive,
      result: hand.result,
      resultExists: hand.resultExists,
      fresh: hand.fresh,
      stale: hand.stale,
      resultSource: hand.resultSource,
      handoff: hand.handoff,
      lastExit: s.lastExit != null ? s.lastExit : null,
      lastOutput: s.lastOutput || null,
      messaging: eff.enabled,
      messagingSource: eff.source,
      unread: 0,
      herdr: {
        runtime: herdr.displayRuntime(e.runtime),
        address: e.address,
        name: e.name,
        exitCode: e.exitCode,
        agentState,
      },
    };
  });

  if (asJson) {
    const unreadMap = messages.unreadBySessionId(children);
    for (const r of rows) r.unread = unreadMap[r.id] || 0;
    emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`(no workers under "${master.title}")\n`);
    return;
  }
  process.stdout.write(
    `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} ${pad('FOLDER', 20)} TASK\n`
  );
  for (const r of rows) {
    const folder = r.cwd ? path.basename(r.cwd) : '';
    process.stdout.write(
      `${pad(r.title, 24)} ${pad(displayId(r.id, ID_COL), ID_COL)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.handoff, 7)} ${pad(folder, 20)} ${r.task || ''}\n`
    );
  }
}

function cmdResult(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: aflt result <id|title> [--path] [--json] [--require-fresh]');
  let session;
  try {
    session = registry.find(args[0]);
  } catch (err) {
    fail(err.message);
  }
  if (!session) fail(`session not found: ${args[0]}`);

  const asJson = Boolean(flags.json);
  const requireFresh = Boolean(flags['require-fresh']);
  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  const hand = orchestrate.handoffInfo(session, resultPath);

  if (flags.path) {
    if (asJson) emitJson({ path: resultPath, ...hand });
    else process.stdout.write(resultPath + '\n');
    return;
  }

  if (hand.resultExists) {
    if (hand.stale) {
      process.stderr.write(
        `warning: handoff at ${resultPath} is stale (mtime not after latest run)\n`
      );
    }
    const body = fs.readFileSync(resultPath, 'utf8');
    if (asJson) {
      emitJson({
        ok: !(requireFresh && hand.stale),
        path: resultPath,
        body,
        ...hand,
      });
    } else {
      process.stdout.write(body.endsWith('\n') ? body : body + '\n');
    }
    process.exitCode = requireFresh && hand.stale ? 1 : 0;
    return;
  }

  process.stderr.write(`no handoff yet at ${resultPath}\n`);
  const logFile = session.lastOutput;
  let tail = '';
  if (logFile && fs.existsSync(logFile)) {
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split(/\r?\n/);
    tail = lines.slice(-40).join('\n');
    if (!asJson) process.stdout.write(tail.endsWith('\n') ? tail : tail + '\n');
  }
  if (asJson) {
    emitJson({ ok: false, path: resultPath, body: tail || null, ...hand });
  }
  process.exitCode = 1;
}

function requireSession(query) {
  let session;
  try {
    session = registry.find(query);
  } catch (err) {
    fail(err.message);
  }
  if (!session) fail(`session not found: ${query}`);
  return session;
}

/**
 * Resolve a session for destructive commands (rm, stop).
 * Exact id/chatId/title first; on a TTY (not --json) offers a confirm/pick for
 * fuzzy candidates. Non-TTY / --json stay exact-only with a did-you-mean hint.
 * @param {string} query
 * @param {{ command?: string, verb?: string, json?: boolean, io?: object }} [opts]
 */
async function requireSessionExact(query, opts = {}) {
  const command = opts.command || 'this command';
  const verb =
    opts.verb || (command === 'rm' ? 'Remove' : command === 'stop' ? 'Stop' : 'Select');
  try {
    return await resolveSession.resolveSessionInteractive(query, {
      verb,
      command,
      json: opts.json,
      io: opts.io,
    });
  } catch (err) {
    if (err && err.code === 'CANCELLED') {
      process.stderr.write('cancelled\n');
      process.exit(1);
    }
    fail(err.message, { json: opts.json });
  }
}

function runHcCli(argv, { timeoutMs } = {}) {
  return herdr.defaultRunHc(argv, { timeoutMs });
}

/**
 * Resolve the live Herdr terminal for a session by af_id (same as aflt ls/resume).
 * Never falls back to an unrelated terminal.
 * @returns {{ key: string, address: string|null, name: string|null, enriched: object }|null}
 */
function resolveLiveHerdrForSession(session, fetchResult) {
  if (!fetchResult || !fetchResult.ok) return null;
  const enriched = herdr.enrichSessions([session], fetchResult)[0];
  if (!enriched || enriched.runtime !== 'running') return null;
  const key = enriched.address || enriched.name;
  if (!key) return null;
  return { key, address: enriched.address, name: enriched.name, enriched };
}

function snapshotWorkerRow(session, { herdrInfo = null, waitingHint = null, agentState = null } = {}) {
  const runtime = herdrInfo ? herdrInfo.runtime : null;
  const effectiveHint =
    runtime === 'running' && (agentState == null || agentState === '') ? null : waitingHint;
  const liveOpts = { isAlive: orchestrate.defaultIsAlive, hostname: os.hostname() };
  const recon = orchestrate.reconcileDeadRunPid(session, liveOpts);
  const derived = orchestrate.deriveWorkerStatus(
    session,
    {
      runtime,
      exitCode: herdrInfo ? herdrInfo.exitCode : null,
      waitingHint: effectiveHint,
    },
    liveOpts
  );
  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  const hand = orchestrate.handoffInfo(session, resultPath);
  const meta = orchestrate.waitOutcomeMeta(session, {
    runtime,
    exitCode: herdrInfo ? herdrInfo.exitCode : null,
    agentState,
    derivedStatus: derived,
    ...liveOpts,
  });
  if (recon && recon.persist && recon.patch) {
    const wr = registry.bestEffortUpdate(session.id, recon.patch);
    if (wr.ok && wr.session) Object.assign(session, wr.session);
  }
  return {
    id: session.id,
    title: session.title,
    engine: session.engine || 'cursor',
    workerStatus: derived,
    outcome: meta.outcome,
    stateSource: meta.stateSource,
    conclusive: meta.conclusive,
    agentState: meta.agentState,
    resultExists: hand.resultExists,
    fresh: hand.fresh,
    stale: hand.stale,
    resultSource: hand.resultSource,
    handoff: hand.handoff,
    result: hand.result,
    lastExit: session.lastExit != null ? session.lastExit : null,
    lastOutput: session.lastOutput || null,
  };
}

function waitNothingError() {
  let msg =
    'aflt wait: nothing to wait on. Pass worker ids/titles, or --parent <master>, or run inside a master (AGENTFLEET_ID) / worker (AGENTFLEET_PARENT).';
  try {
    const sessions = registry.list({ includeDone: true });
    const childParentIds = new Set(sessions.filter((s) => s.parent).map((s) => s.parent));
    const masters = sessions.filter(
      (s) => s.role === 'master' || childParentIds.has(s.id)
    );
    const active = [];
    for (const m of masters) {
      const kids = listChildrenOf(m.id);
      if (
        kids.some((k) => {
          const st = k.workerStatus || '';
          return st === 'queued' || st === 'running' || st === 'waiting';
        })
      ) {
        active.push(m);
      }
    }
    if (active.length === 1) {
      msg += `\ne.g. aflt wait --parent ${active[0].title}`;
    }
  } catch (_) {
    /* ignore */
  }
  fail(msg);
}

function resolveWaitTargets(args, flags = {}) {
  // Explicit worker ids/titles win over --parent.
  if (args.length > 0) {
    return args.map((q) => requireSession(q));
  }
  if (flags.parent && flags.parent !== true) {
    const master = requireSession(String(flags.parent));
    const kids = listChildrenOf(master.id);
    if (kids.length === 0) {
      fail(`aflt wait: master "${master.title}" has no workers`);
    }
    return kids;
  }
  const master = resolveChildrenMaster([], {});
  if (!master) {
    waitNothingError();
  }
  const kids = listChildrenOf(master.id);
  if (kids.length === 0) {
    fail(`aflt wait: master "${master.title}" has no workers`);
  }
  return kids;
}

/**
 * Resolve the master for an aflt wait --docs trigger.
 */
function resolveWaitDocsMaster(targets, flags = {}) {
  if (flags.parent && flags.parent !== true) {
    try {
      const m = registry.find(String(flags.parent));
      if (m) return m;
    } catch (_) {
      /* ignore */
    }
  }
  for (const t of targets || []) {
    const s = registry.find(t.id) || t;
    if (s.role === 'master') return s;
    if (s.parent) {
      const m = registry.find(s.parent);
      if (m) return m;
    }
  }
  return null;
}

const WAIT_DOCS_NO_MASTER =
  'wait --docs: could not resolve a master (pass --parent <master>, or wait on workers that have a parent)';

async function triggerDocsAfterWait(master, flags, { asJson } = {}) {
  if (!master || master.role !== 'master') {
    fail(WAIT_DOCS_NO_MASTER, { json: asJson });
  }
  const fresh = registry.find(master.id) || master;
  return maybeTriggerDocsForMaster(fresh, {
    runId: fresh.runId,
    engine: fresh.engine || 'cursor',
    flags,
    asJson,
    quiet: true,
    trigger: 'wait',
  });
}

/**
 * After a successful headless worker/master run, ensure a result handoff exists
 * (af writes a fallback from stdout when the agent did not).
 *
 * When `workerStatus` is provided, status + handoff attribution are written in
 * one critical update so pollers never observe `done` without resultSource /
 * resultRunId (detach supervisor race).
 */
function applyResultHandoffFallback(
  session,
  { code, timedOut, stopped, stdout, resultPath, runId, workerStatus, clearRunPid } = {}
) {
  const patch = {};
  if (workerStatus != null) patch.workerStatus = workerStatus;
  if (clearRunPid) {
    patch.runPid = null;
    patch.runPgid = null;
  }
  if (!stopped && !timedOut && code === 0) {
    const dest = resultPath || session.result;
    const source = orchestrate.ensureResultHandoff(session, {
      code,
      timedOut,
      stdout,
      resultPath: dest,
      runId: runId || session.runId,
    });
    if (source) {
      patch.resultSource = source;
      if (source === 'worker' || source === 'af-fallback') {
        patch.resultRunId = runId || session.runId || null;
      }
    }
  }
  if (!Object.keys(patch).length) return session;
  const wr = registry.criticalUpdate(session.id, patch, { phase: 'after-exit' });
  return wr.ok && wr.session ? wr.session : session;
}

async function cmdWait(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const anyMode = Boolean(flags.any);
  const timeoutSec =
    flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  const intervalSec =
    flags.interval != null && flags.interval !== true ? Number(flags.interval) : 2;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }
  if (Number.isNaN(intervalSec) || intervalSec <= 0) {
    fail('--interval must be a positive number of seconds');
  }
  let sendGraceMs;
  try {
    sendGraceMs = orchestrate.resolveSendGraceMs({
      flag: flags['send-grace'],
      env: process.env,
    });
  } catch (_) {
    sendGraceMs = orchestrate.DEFAULT_SEND_GRACE_SEC * 1000;
  }
  if (flags['send-grace'] != null && flags['send-grace'] !== true) {
    const n = Number(flags['send-grace']);
    if (Number.isNaN(n) || n < 0) fail('--send-grace must be a non-negative number of seconds');
  }

  const targets = resolveWaitTargets(args, flags);
  const waitState = new Map(); // id -> { seenWorking, idleTicks }
  const lastPrinted = new Map();
  const started = Date.now();
  const deadline = timeoutSec > 0 ? started + timeoutSec * 1000 : null;

  function pollOnce() {
    const fetchResult = herdr.fetchHerdrTerminals();
    const enrichedList = fetchResult.ok
      ? herdr.enrichSessions(targets.map((t) => registry.find(t.id) || t), fetchResult)
      : targets.map((t) => ({
          session: registry.find(t.id) || t,
          runtime: '-',
          exitCode: null,
          status: null,
        }));

    const rows = [];
    for (const e of enrichedList) {
      const s = registry.find(e.session.id) || e.session;
      let st = waitState.get(s.id) || {
        seenWorking: false,
        idleTicks: 0,
        noStateWarned: false,
        shellWarned: false,
      };
      let waitingHint = null;
      let agentState = null;
      if (e.runtime === 'running') {
        let statusObj = e.status;
        if ((e.address || e.name) && fetchResult.ok) {
          const got = runHcCli(['get', '--json', e.address || e.name], { timeoutMs: 3000 });
          if (got.status === 0 && got.stdout) {
            try {
              const parsed = JSON.parse(got.stdout);
              if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'status')) {
                statusObj = parsed.status;
              }
            } catch (_) {
              /* ignore */
            }
          }
        }
        agentState = orchestrate.agentStateFromHerdr({ status: statusObj });
        const next = orchestrate.detectWaitingTransition({
          agentState,
          seenWorking: st.seenWorking,
          idleTicks: st.idleTicks,
          lastSendAt: s.lastSendAt || null,
          sendGraceMs,
          now: Date.now(),
        });
        st = {
          seenWorking: next.seenWorking,
          idleTicks: next.idleTicks,
          noStateWarned: st.noStateWarned,
        };
        waitingHint = next.hint === 'waiting' ? 'waiting' : null;
      }
      waitState.set(s.id, st);
      const row = snapshotWorkerRow(s, {
        herdrInfo: { runtime: e.runtime, exitCode: e.exitCode },
        waitingHint,
        agentState,
      });
      rows.push(row);

      if (row.stateSource === 'none' && !st.noStateWarned) {
        process.stderr.write(
          `no agent state from Herdr for ${s.id}; cannot detect completion — use aflt tail / aflt result\n`
        );
        st.noStateWarned = true;
        waitState.set(s.id, st);
      }
      if (row.stateSource === 'shell' && !st.shellWarned) {
        process.stderr.write(
          `agent not running in its terminal (shell only); run aflt resume ${s.id}\n`
        );
        st.shellWarned = true;
        waitState.set(s.id, st);
      }

      if (!asJson) {
        const prev = lastPrinted.get(s.id);
        if (prev !== row.workerStatus) {
          process.stderr.write(
            `wait: ${row.title} → ${row.workerStatus || '-'}\n`
          );
          lastPrinted.set(s.id, row.workerStatus);
        }
      }
    }
    return rows;
  }

  let rows = pollOnce();
  for (;;) {
    const statuses = rows.map((r) => r.workerStatus);
    const doneCount = statuses.filter((s) => orchestrate.isWaitTerminalStatus(s)).length;
    const finished = anyMode
      ? doneCount > 0
      : doneCount === statuses.length;
    if (finished) {
      const code = orchestrate.waitExitCode(statuses, { timedOut: false });
      let docsMaster = null;
      if (code === 0 && flags.docs) {
        docsMaster = resolveWaitDocsMaster(targets, flags);
        if (!docsMaster || docsMaster.role !== 'master') {
          fail(WAIT_DOCS_NO_MASTER, { json: asJson });
        }
      }
      if (asJson) {
        emitJson(rows);
      } else {
        process.stdout.write(
          `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} EXIT\n`
        );
        for (const r of rows) {
          process.stdout.write(
            `${pad(r.title, 24)} ${pad(displayId(r.id, ID_COL), ID_COL)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.handoff || (r.resultExists ? 'yes' : 'no'), 7)} ${r.lastExit != null ? r.lastExit : '-'}\n`
          );
        }
      }
      if (code === 0 && flags.docs) {
        await triggerDocsAfterWait(docsMaster, flags, { asJson });
      }
      process.exitCode = code;
      return;
    }
    if (deadline != null && Date.now() >= deadline) {
      const code = orchestrate.waitExitCode(
        rows.map((r) => r.workerStatus),
        { timedOut: true }
      );
      if (asJson) {
        emitJson(rows);
      } else {
        process.stderr.write(`wait: timed out after ${timeoutSec}s\n`);
        process.stdout.write(
          `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} EXIT\n`
        );
        for (const r of rows) {
          process.stdout.write(
            `${pad(r.title, 24)} ${pad(displayId(r.id, ID_COL), ID_COL)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.handoff || (r.resultExists ? 'yes' : 'no'), 7)} ${r.lastExit != null ? r.lastExit : '-'}\n`
          );
        }
      }
      process.exitCode = code;
      return;
    }
    await sleep(Math.max(50, intervalSec * 1000));
    // Refresh target list from registry (status fields change)
    for (let i = 0; i < targets.length; i++) {
      const fresh = registry.find(targets[i].id);
      if (fresh) targets[i] = fresh;
    }
    rows = pollOnce();
  }
}

function lastNLines(text, n) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-Math.max(0, n));
}

async function cmdTail(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: aflt tail <id|title> [-n N] [-f]');
  const session = requireSession(args[0]);
  const n =
    flags.n != null && flags.n !== true
      ? Number(flags.n)
      : flags.lines != null && flags.lines !== true
        ? Number(flags.lines)
        : 50;
  if (Number.isNaN(n) || n < 0) fail('-n must be a non-negative number');
  const follow = Boolean(flags.f || flags.follow);

  const fetchResult = herdr.fetchHerdrTerminals();
  const live = resolveLiveHerdrForSession(session, fetchResult);

  if (live) {
    let lastLineCount = 0;
    let lastTail = '';
    const readOnce = (printAll) => {
      const r = runHcCli(['read', live.key, '--lines', String(Math.max(n, 200))], {
        timeoutMs: 5000,
      });
      if (r.status !== 0) {
        if (!follow) fail(`hc read failed: ${(r.stderr || '').trim() || r.status}`);
        return null;
      }
      const text = r.stdout || '';
      const lines = text.split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (printAll || lastLineCount === 0) {
        const out = lines.slice(-n);
        if (out.length) process.stdout.write(out.join('\n') + '\n');
      } else if (lines.length > lastLineCount) {
        const neu = lines.slice(lastLineCount);
        if (neu.length) process.stdout.write(neu.join('\n') + '\n');
      } else if (lines.length === lastLineCount && lines.join('\n') !== lastTail) {
        // Same count but content shifted: print last line if new.
        const curTail = lines.slice(-1).join('\n');
        if (curTail && curTail !== lastTail.split(/\r?\n/).slice(-1)[0]) {
          process.stdout.write(curTail + '\n');
        }
      }
      lastLineCount = lines.length;
      lastTail = lines.join('\n');
      return text;
    };

    readOnce(true);
    if (!follow) return;

    while (true) {
      await sleep(1000);
      const fresh = registry.find(session.id) || session;
      const fr = herdr.fetchHerdrTerminals();
      const still = resolveLiveHerdrForSession(fresh, fr);
      if (!still) {
        readOnce(false);
        return;
      }
      live.key = still.key;
      readOnce(false);
    }
  }

  // Headless (or interactive with no live Herdr terminal): follow run log.
  const logPath = () => {
    const s = registry.find(session.id) || session;
    return s.lastOutput;
  };
  let file = logPath();
  if (!file || !fs.existsSync(file)) {
    fail(`no run log for "${session.title}" (lastOutput unset or missing)`);
  }

  const printTail = (fromStart) => {
    const text = fs.readFileSync(file, 'utf8');
    if (fromStart) {
      const lines = lastNLines(text, n);
      if (lines.length) process.stdout.write(lines.join('\n') + '\n');
      return text.length;
    }
    return text.length;
  };

  let pos = 0;
  const initial = fs.readFileSync(file, 'utf8');
  const lines = lastNLines(initial, n);
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  pos = initial.length;

  if (!follow) return;

  while (true) {
    await sleep(500);
    const s = registry.find(session.id) || session;
    file = s.lastOutput || file;
    if (file && fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (st.size < pos) pos = 0; // truncated / new file
      if (st.size > pos) {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(st.size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          process.stdout.write(buf.toString('utf8'));
          pos = st.size;
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    const derived = orchestrate.deriveWorkerStatus(s, null, {
      isAlive: orchestrate.defaultIsAlive,
      hostname: os.hostname(),
    });
    if (derived !== 'running' && derived !== 'queued') {
      // Drain any remaining bytes once more.
      if (file && fs.existsSync(file)) {
        const st = fs.statSync(file);
        if (st.size > pos) {
          const fd = fs.openSync(file, 'r');
          try {
            const buf = Buffer.alloc(st.size - pos);
            fs.readSync(fd, buf, 0, buf.length, pos);
            process.stdout.write(buf.toString('utf8'));
          } finally {
            fs.closeSync(fd);
          }
        }
      }
      return;
    }
  }
}

async function cmdSend(argv) {
  const { args, flags } = parseArgs(argv);
  const asJsonEarly = Boolean(flags.json);
  if (args.length < 2) fail('usage: aflt send <id|title> "text" [--timeout SEC] [--force] [--json]', { json: asJsonEarly });
  let session = requireSession(args[0]);
  const text = args.slice(1).join(' ');
  if (!text) fail('usage: aflt send <id|title> "text" [--timeout SEC] [--force] [--json]', { json: asJsonEarly });
  const forceFlag = flags.force != null ? Boolean(flags.force) : null;
  const timeoutSec =
    flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }

  const fetchResult = herdr.fetchHerdrTerminals();
  const live = resolveLiveHerdrForSession(session, fetchResult);
  if (live) {
    const r = runHcCli(['send', live.key, text], { timeoutMs: 15000 });
    if (r.status !== 0) {
      fail(`hc send failed: ${(r.stderr || r.stdout || '').trim() || r.status}`);
    }
    const runId = crypto.randomUUID();
    const runStartedAt = nowIso();
    let resultMtimeAtStart = null;
    const rp = session.result || orchestrate.defaultResultPath(session.id);
    try {
      if (fs.existsSync(rp)) resultMtimeAtStart = fs.statSync(rp).mtimeMs;
    } catch (_) {}
    const wr = registry.criticalUpdate(
      session.id,
      {
        workerStatus: 'running',
        lastSendAt: nowIso(),
        runId,
        runStartedAt,
        resultMtimeAtStart,
        resultRunId: null,
      },
      { phase: 'before-launch' }
    );
    registry.bestEffortUpdate(session.id, { lastUsed: nowIso() });
    if (!wr.ok) {
      fail(`critical registry write failed before send: ${wr.error}`, { json: asJsonEarly });
    }
    process.stderr.write(`sent to ${session.title} via hc send ${live.key}\n`);
    return;
  }

  // Headless path (or interactive with no live terminal).
  const alive =
    session.runPid != null &&
    (!session.runHost || session.runHost === os.hostname()) &&
    orchestrate.defaultIsAlive(session.runPid);
  const status = orchestrate.deriveWorkerStatus(session, null, {
    isAlive: orchestrate.defaultIsAlive,
    hostname: os.hostname(),
  });
  if (alive || status === 'running') {
    fail(
      `worker "${session.title}" is still running (pid ${session.runPid}); refuse send. Use aflt stop first or wait.`
    );
  }

  const force = forceFlag != null ? forceFlag : Boolean(session.force);
  const trust = !flags['no-trust'];
  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  const prompt =
    session.role === 'worker'
      ? orchestrate.continueWorkerPrompt(resultPath, text)
      : text;

  const envOverlay = agentDocs.sessionLaunchEnv(session, {
    ...(resultPath ? { AGENTFLEET_RESULT: resultPath } : {}),
  });

  const asJson = Boolean(flags.json);

  registry.update(session.id, {
    workerStatus: session.role === 'worker' ? 'running' : session.workerStatus,
    lastUsed: nowIso(),
    stopRequested: false,
    force,
  });

  const { code, timedOut, outPath, stopped, result, runId, registryWriteError } = await executeHeadlessRun(session, {
    prompt,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: session.engine === 'copilot',
    json: asJson,
  });

  let workerStatus = null;
  if (session.role === 'worker' || session.role === 'master') {
    if (stopped) workerStatus = 'stopped';
    else if (!timedOut && code === 0) workerStatus = 'done';
    else workerStatus = 'failed';
    session = applyResultHandoffFallback(session, {
      code,
      timedOut,
      stopped,
      stdout: result && result.stdout,
      resultPath,
      runId,
      workerStatus,
      clearRunPid: true,
    });
    workerStatus = session.workerStatus || workerStatus;
    if (session.role === 'worker' && !asJson) {
      process.stderr.write(`send: ${session.title} → ${workerStatus} (log ${outPath})\n`);
    }
  }
  if (asJson) {
    emitJson({
      ok: code === 0 && !timedOut,
      session: {
        id: session.id,
        title: session.title,
        engine: session.engine || 'cursor',
        workerStatus,
      },
      lastExit: timedOut ? 124 : code,
      outputPath: outPath,
      outputExcerpt: runlib.outputExcerpt((result && result.stdout) || ''),
    });
  }
  process.exitCode = code;
}

function signalProcessGroup(pgid, signal) {
  if (pgid == null) return false;
  try {
    process.kill(-Number(pgid), signal);
    return true;
  } catch (_) {
    return false;
  }
}

async function stopOneSession(session, { asJson } = {}) {
  const fresh = registry.find(session.id) || session;
  const fetchResult = herdr.fetchHerdrTerminals();
  const live = resolveLiveHerdrForSession(fresh, fetchResult);

  const derived = orchestrate.deriveWorkerStatus(fresh, live ? { runtime: 'running' } : null, {
    isAlive: orchestrate.defaultIsAlive,
    hostname: os.hostname(),
  });

  if (
    derived === 'done' ||
    derived === 'failed' ||
    derived === 'stopped' ||
    (derived !== 'running' && derived !== 'queued' && derived !== 'waiting' && !live && !fresh.runPid)
  ) {
    const msg = `already terminal: ${fresh.title} (${derived || fresh.workerStatus || 'unknown'})`;
    if (asJson) {
      return { id: fresh.id, title: fresh.title, workerStatus: derived || fresh.workerStatus, noop: true, message: msg };
    }
    process.stderr.write(msg + '\n');
    return { id: fresh.id, title: fresh.title, workerStatus: derived || fresh.workerStatus, noop: true };
  }

  if (live) {
    runHcCli(['interrupt', live.key], { timeoutMs: 15000 });
    const kill = runHcCli(['kill', live.key], { timeoutMs: 15000 });
    if (kill.status !== 0) {
      process.stderr.write(
        `hc kill warning: ${(kill.stderr || kill.stdout || '').trim() || kill.status}\n`
      );
    }
    const updated = registry.update(fresh.id, {
      workerStatus: 'stopped',
      stopRequested: true,
      lastUsed: nowIso(),
    });
    return {
      id: updated.id,
      title: updated.title,
      workerStatus: 'stopped',
      mode: 'herdr',
      terminal: live.key,
      noop: false,
    };
  }

  // Headless
  if (fresh.runHost && fresh.runHost !== os.hostname()) {
    fail(
      `cannot stop "${fresh.title}": runHost ${fresh.runHost} ≠ this host ${os.hostname()}`
    );
  }

  registry.update(fresh.id, { stopRequested: true });

  const pgid = fresh.runPgid != null ? fresh.runPgid : fresh.runPid;
  const pid = fresh.runPid;
  if (pid != null && orchestrate.defaultIsAlive(pid)) {
    signalProcessGroup(pgid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && orchestrate.defaultIsAlive(pid)) {
      await sleep(100);
    }
    if (orchestrate.defaultIsAlive(pid)) {
      signalProcessGroup(pgid, 'SIGKILL');
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }
  }

  const updated = registry.update(fresh.id, {
    workerStatus: 'stopped',
    stopRequested: true,
    runPid: null,
    runPgid: null,
    lastUsed: nowIso(),
  });
  return {
    id: updated.id,
    title: updated.title,
    workerStatus: 'stopped',
    mode: 'headless',
    noop: false,
  };
}

async function cmdStop(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = recoverBoolFlag(flags, 'json', args);
  const allChildren = Boolean(flags['all-children']);

  let targets = [];
  if (allChildren) {
    const masterQuery = args[0] || flags['all-children'];
    if (!masterQuery || masterQuery === true) {
      fail('usage: aflt stop --all-children <master>');
    }
    const master = await requireSessionExact(String(masterQuery), {
      command: 'stop',
      verb: 'Stop',
      json: asJson,
    });
    targets = listChildrenOf(master.id);
    if (targets.length === 0) {
      fail(`no workers under "${master.title}"`);
    }
  } else {
    if (!args[0]) fail('usage: aflt stop <id|title> | aflt stop --all-children <master>');
    targets = [
      await requireSessionExact(args[0], { command: 'stop', verb: 'Stop', json: asJson }),
    ];
  }

  const results = [];
  for (const t of targets) {
    results.push(await stopOneSession(t, { asJson }));
  }

  if (asJson) {
    emitJson(allChildren ? results : results[0]);
  } else if (!results.every((r) => r.noop)) {
    for (const r of results) {
      if (r.noop) continue;
      process.stderr.write(`stopped: ${r.title} (${r.workerStatus})\n`);
    }
  }
  process.exitCode = 0;
}

function cmdLog(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: aflt log <title|id> [--path]');
  const session = registry.find(args[0]);
  if (!session) fail(`session not found: ${args[0]}`);
  const file = session.lastOutput;
  if (!file) fail(`no captured run output for "${session.title}"`);
  if (flags.path) {
    process.stdout.write(file + '\n');
    return;
  }
  if (!fs.existsSync(file)) fail(`output file missing: ${file}`);
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

function cmdSetup(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = recoverBoolFlag(flags, 'json', args);
  const apply = recoverBoolFlag(flags, 'apply', args);
  const wantHerdr = recoverBoolFlag(flags, 'herdr', args);
  const force = recoverBoolFlag(flags, 'force', args);
  let memoryPath = null;
  if (flags.memory != null && flags.memory !== false) {
    if (flags.memory === true) {
      fail('usage: aflt setup [--apply] [--json] [--herdr] [--memory <path>] [--force]', {
        json: asJson,
      });
    }
    memoryPath = String(flags.memory);
  }
  const result = setup.runSetup({
    apply,
    herdr: wantHerdr,
    memory: memoryPath,
    force,
    env: process.env,
  });
  if (asJson) {
    emitJson(result);
  } else {
    process.stdout.write(setup.formatText(result));
  }
  process.exitCode = result.ok ? 0 : 1;
}

function cmdHerdrTemplates(argv) {
  const { flags } = parseArgs(argv);
  const dryRun = Boolean(flags['dry-run']);
  const srcDir = path.join(__dirname, '..', 'templates');
  const destDir = path.join(require('../lib/util').homeDir(), '.config', 'herdr-core', 'templates');
  if (!fs.existsSync(srcDir)) fail(`bundled templates not found at ${srcDir}`);
  const files = herdr.HERDR_TEMPLATE_FILES;
  for (const f of files) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src)) fail(`bundled Herdr template missing: ${src}`);
  }
  let copied = 0;
  let skipped = 0;
  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const dest = path.join(destDir, f);
    if (fs.existsSync(dest) && !flags.force) {
      process.stderr.write(`skip ${dest} (exists; pass --force to overwrite)\n`);
      skipped++;
      continue;
    }
    if (dryRun) {
      process.stdout.write(`[dry-run] would install ${dest}\n`);
      copied++;
      continue;
    }
    fs.copyFileSync(path.join(srcDir, f), dest);
    process.stdout.write(`installed ${dest}\n`);
    copied++;
  }
  process.stderr.write(
    `herdr templates: ${dryRun ? 'would install' : 'installed'} ${copied}, skipped ${skipped}. Then: hc templates\n`
  );
}

function cmdHerdrApp(argv) {
  const herdrappinstall = require('../lib/herdrappinstall');
  const { args, flags } = parseArgs(argv);
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(
      'usage: aflt herdr-app install [--copy] [--force] [--dry-run]\n' +
        '       aflt herdr-app status\n'
    );
    return;
  }
  if (sub === 'status') {
    const st = herdrappinstall.status();
    for (const item of st.items) {
      process.stdout.write(`${item.kind.padEnd(8)} ${item.state.padEnd(10)} ${item.dest}\n`);
      if (item.detail) process.stdout.write(`         ${item.detail}\n`);
    }
    process.stdout.write(`home: ${st.home}\n`);
    return;
  }
  if (sub === 'install') {
    const result = herdrappinstall.install({
      copy: Boolean(flags.copy),
      force: Boolean(flags.force),
      dryRun: Boolean(flags['dry-run']),
    });
    for (const a of result.actions) {
      const prefix = result.dryRun ? '[dry-run] ' : '';
      process.stdout.write(`${prefix}${a.action}  ${a.kind}  ${a.dest}\n`);
      if (a.detail) process.stdout.write(`  ${a.detail}\n`);
    }
    if (!result.ok) {
      process.exitCode = 1;
      if (result.error) process.stderr.write(`${result.error}\n`);
    }
    return;
  }
  fail(`unknown herdr-app subcommand: ${sub}\nusage: aflt herdr-app install|status`);
}


function parseHcSemver(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: `${m[1]}.${m[2]}.${m[3]}` };
}

function cmpSemver(a, b) {
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

async function cmdDoctor(argv) {
  const { flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const strict = Boolean(flags.strict);
  if (flags.notify && !strict) fail('doctor: --notify requires --strict', { json: asJson });
  for (const f of ['port', 'loop']) {
    if (flags[f] === true) fail(`doctor: --${f} requires a value`, { json: asJson });
  }
  const checks = [];
  function add(name, ok, detail) {
    checks.push({ name, ok: Boolean(ok), detail: detail || null });
  }
  add('aflt', true, PKG_VERSION);
  add('node', true, process.version);
  const spaceName = currentSpaceName();
  add('space', true, spaceName || '(default)');
  add('agentfleet_home', true, fleetDir());
  add('registry', true, fs.existsSync(registryPath()) ? registryPath() : `${registryPath()} (will create on first write)`);
  try {
    const eng = engine.resolveEngine({});
    add('default_engine', true, `${eng.engine} (from ${eng.source})`);
  } catch (err) {
    add('default_engine', false, err.message);
  }
  const hcPath = backends.resolveHcBin();
  const hcPresent = herdr.hcOnPath();
  add('hc_on_path', hcPresent, hcPath);
  if (hcPresent) {
    const ver = herdr.defaultRunHc(['--version'], { timeoutMs: 3000 });
    const verText = `${ver.stdout || ''}${ver.stderr || ''}`.trim();
    const parsed = parseHcSemver(verText);
    const min = { major: 0, minor: 1, patch: 20, raw: '0.1.20' };
    if (!parsed) {
      add(
        'herdr_core_version',
        false,
        (verText || `exit ${ver.status}`).slice(0, 120) +
          '; could not parse version (want >= 0.1.20)'
      );
    } else {
      const ge = cmpSemver(parsed, min) >= 0;
      add(
        'herdr_core_version',
        ge,
        ge
          ? parsed.raw
          : `${parsed.raw}; terminals restored after a reboot may come back as a shell in ~; update with \`hc update\``
      );
    }
    const st = herdr.defaultRunHc(['server', 'status'], { timeoutMs: 3000 });
    add(
      'hc_server_status',
      st.status === 0,
      st.status === 0 ? (st.stdout || '').trim().slice(0, 200) : (st.stderr || st.stdout || `exit ${st.status}`).trim().slice(0, 200)
    );
    const ls = herdr.fetchHerdrTerminals({ timeoutMs: 3000 });
    add('hc_ls', ls.ok, ls.ok ? `${(ls.terminals || []).length} terminals` : ls.error);
  } else {
    add('herdr_core_version', false, 'hc not on PATH');
    add('hc_server_status', false, 'hc not on PATH');
    add('hc_ls', false, 'hc not on PATH');
  }
  try {
    const info = cursor.describeCursorBin();
    if (info.bin) {
      const present = path.isAbsolute(info.bin)
        ? fs.existsSync(info.bin)
        : Boolean(require('../lib/util').which(info.bin));
      add('cursor_bin', present, present ? info.bin : `${info.bin} (not found)`);
    } else if (info.ignoredAgent) {
      add(
        'cursor_bin',
        false,
        `cursor-agent not on PATH (ignored ${info.ignoredAgent}; not Cursor)`
      );
    } else {
      add('cursor_bin', false, 'cursor-agent not on PATH');
    }
  } catch (err) {
    add('cursor_bin', false, err.message);
  }
  try {
    const bin = copilot.resolveCopilotBin();
    const present = Boolean(
      process.env.AGENTFLEET_COPILOT_BIN || require('../lib/util').which('copilot') || (bin && fs.existsSync(bin))
    );
    add('copilot_bin', present, bin);
  } catch (err) {
    add('copilot_bin', false, err.message);
  }
  try {
    const bin = opencode.resolveOpencodeBin();
    const present = Boolean(
      process.env.AGENTFLEET_OPENCODE_BIN ||
        require('../lib/util').which('opencode') ||
        (bin && fs.existsSync(bin))
    );
    add('opencode_bin', present, bin);
  } catch (err) {
    add('opencode_bin', false, err.message);
  }
  try {
    const sessions = registry.list({ includeDone: true });
    const wiring = mcp.doctorMcpWiring(sessions, process.env);
    if (wiring) {
      add('mcp_copilot', true, wiring.copilot.detail);
      add('mcp_cursor', Boolean(wiring.cursor.ok), wiring.cursor.detail);
    }
  } catch (err) {
    add('mcp_wiring', false, err.message);
  }
  try {
    const st = notify.doctorStatus(process.env);
    add(st.name, st.ok, st.detail);
  } catch (err) {
    add('notify', true, `status unavailable: ${err.message}`);
  }
  try {
    const st = memory.doctorDocAgentStatus(process.env);
    add(st.name, st.ok, st.detail);
  } catch (err) {
    add('memory_doc_agent', true, `status unavailable: ${err.message}`);
  }
  try {
    const st = agentDocs.doctorAgentDocsStatus(process.env);
    add(st.name, st.ok, st.detail);
  } catch (err) {
    add('agent_docs', true, `status unavailable: ${err.message}`);
  }
  // copilot/hc optional for plain-only workflows — warn on old herdr-core but do not fail exit
  const legacyOk = checks
    .filter(
      (c) =>
        ![
          'cursor_bin',
          'copilot_bin',
          'opencode_bin',
          'hc_on_path',
          'hc_server_status',
          'hc_ls',
          'herdr_core_version',
          'mcp_copilot',
          'mcp_cursor',
          'mcp_wiring',
          'notify',
          'memory_doc_agent',
          'agent_docs',
        ].includes(c.name)
    )
    .every((c) => c.ok);
  let ok = legacyOk;
  let failed = [];
  const extended = strict || flags.port != null || flags.loop != null;
  if (extended) {
    const pre = await doctorLib.runPreflightChecks({
      strict,
      notifyLive: Boolean(flags.notify),
      port: flags.port,
      loopFile: flags.loop ? String(flags.loop) : null,
      env: process.env,
    });
    doctorLib.classifyLegacy(checks, pre.requiredEngines);
    for (const c of pre.checks) {
      checks.push({ name: c.name, ok: c.ok, status: c.status, detail: c.detail || null, ...(c.data ? { data: c.data } : {}) });
    }
    failed = checks.filter((c) => c.status === 'fail').map((c) => c.name);
    // Strict mode fails on any failed check, including the advisory legacy rows that are required.
    if (strict) ok = failed.length === 0;
    else ok = legacyOk && !pre.checks.some((c) => c.status === 'fail');
  }
  if (asJson) {
    emitJson({ ok, checks, ...(strict ? { strict: true, failed } : {}) });
  } else {
    for (const c of checks) {
      const mark = c.ok ? 'ok ' : c.status === 'warn' ? 'warn' : '!! ';
      process.stdout.write(`${mark} ${c.name}: ${c.detail || ''}\n`);
    }
    process.stdout.write(
      '\nHerdr smoke: hc server status && hc ls --json | head -c 200 && aflt ls\n'
    );
  }
  process.exitCode = ok ? 0 : 1;
}

function formatWorkdirLine(result) {
  const wd = result.workdir;
  if (!wd || wd.mode !== 'worktree') return '';
  const bits = [
    'mode=worktree',
    `base=${wd.base || '-'}`,
    `git=${wd.git}`,
    `clean=${wd.clean}`,
    `linked=${Boolean(wd.linkedWorktree)}`,
    wd.ok ? 'ok' : 'refused',
  ];
  if (wd.created) bits.push(wd.created);
  if (wd.createCommand) bits.push(`create: ${wd.createCommand}`);
  return `  workdir: ${bits.join(' ')}\n`;
}

async function cmdLoop(argv) {
  const { args, flags } = parseArgs(argv || []);
  const sub = args[0];
  const asJson = Boolean(flags.json);
  const usage =
    'usage: aflt loop init [--engine E] [--model M | --build-model M --plan-model M] [--out FILE] [--dry-run] [--force] [--json] | validate <file> | run <file> [--dry-run] [--json] [--fresh] [--force] [--allow-existing] [--create-worktree] | start <file> | pause <name> | status [name] | stop <name> | resume <name> | approve <name> [--json]';
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    fail(usage);
  }

  if (sub === 'init') {
    await cmdLoopInit((argv || []).slice((argv || []).indexOf('init') + 1));
    return;
  }

  if (sub === 'validate') {
    const file = args[1];
    if (!file) fail('usage: aflt loop validate <file> [--json]');
    let result;
    try {
      result = loopLib.validateFile(file);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    if (asJson) {
      emitJson({
        ok: result.ok,
        path: result.path,
        errors: result.errors || [],
        warnings: result.warnings || [],
        definition: result.ok ? result.definition : null,
      });
    } else if (result.ok) {
      process.stdout.write(
        `ok: loop "${result.definition.name}" (${result.definition.phases.length} phase(s))` +
          (result.warnings && result.warnings.length
            ? `; ${result.warnings.length} warning(s)`
            : '') +
          '\n'
      );
      for (const w of result.warnings || []) {
        process.stderr.write(`WARNING: ${w}\n`);
      }
    } else {
      for (const e of result.errors || []) process.stderr.write(`error: ${e}\n`);
      for (const w of result.warnings || []) process.stderr.write(`WARNING: ${w}\n`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (sub === 'run') {
    const file = args[1];
    if (!file) {
      fail(
        'usage: aflt loop run <file> [--dry-run] [--json] [--fresh] [--force] [--allow-existing] [--create-worktree]'
      );
    }
    const dryRun = Boolean(flags['dry-run']);
    const fresh = Boolean(flags.fresh);
    let result;
    try {
      result = await loopLib.runFromFile(file, {
        dryRun,
        fresh,
        forceTools: Boolean(flags.force),
        allowExisting: Boolean(flags['allow-existing']),
        createWorktree: Boolean(flags['create-worktree']),
      });
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    if (asJson) {
      emitJson({
        ok: Boolean(result.ok),
        dryRun: Boolean(result.dryRun),
        status: result.status || null,
        path: result.path || null,
        name: result.state ? result.state.name : result.name || null,
        message: result.message || null,
        error: result.error || (result.errors && result.errors.join('; ')) || null,
        errors: result.errors || null,
        warnings: result.warnings || null,
        cwd: result.cwd || (result.workdir && result.workdir.cwd) || null,
        permissions: result.permissions || null,
        model: result.model || null,
        resolvedModel: result.resolvedModel || null,
        workdir: result.workdir || null,
        plan: result.dryRun ? result : null,
        state: result.state
          ? {
              name: result.state.name,
              status: result.state.status,
              phaseId: result.state.phaseId,
              phaseIndex: result.state.phaseIndex,
              attempt: result.state.attempt,
              step: result.state.step,
              runsUsed: result.state.runsUsed,
            }
          : null,
      });
    } else if (result.dryRun) {
      process.stdout.write(
        `dry-run: loop "${result.name}" — ${result.phases.length} phase(s)\n` +
          `  cwd: ${result.cwd}\n` +
          formatWorkdirLine(result) +
          `  permissions: ${result.permissions || 'restricted'}\n` +
          `  model: ${result.resolvedModel || result.model || '(engine default)'}\n`
      );
      for (const p of result.phases) {
        process.stdout.write(
          `  - ${p.id} engine=${p.engine} session=${p.session} maxFix=${p.maxFixAttempts} onPass=${p.onPass} force=${p.force ? 'true' : 'false'} permission=${p.permission || (p.force ? 'force' : 'restricted')} model=${p.model || '-'}\n`
        );
      }
      if (!result.ok) {
        for (const e of result.errors || []) process.stderr.write(`error: ${e}\n`);
      }
    } else if (result.errors) {
      for (const e of result.errors) process.stderr.write(`error: ${e}\n`);
    } else if (result.ok) {
      process.stdout.write(
        `loop "${result.state.name}" ${result.status}` +
          (result.message ? ` (${result.message})` : '') +
          '\n'
      );
    } else {
      process.stderr.write(
        `loop failed: ${result.error || result.status || 'unknown'}\n`
      );
    }
    await notify.flushPendingNotifies();
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (sub === 'start') {
    const file = args[1];
    if (!file) fail('usage: aflt loop start <file> [--json]');
    let result;
    try {
      result = loopLib.startFromFile(file);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    if (asJson) {
      emitJson({
        ok: Boolean(result.ok),
        path: result.path || null,
        status: result.status || null,
        message: result.message || null,
        error: result.error || (result.errors && result.errors.join('; ')) || null,
        errors: result.errors || null,
        warnings: result.warnings || null,
        state: result.state
          ? {
              name: result.state.name,
              status: result.state.status,
              active: Boolean(result.state.active),
              phaseId: result.state.phaseId,
            }
          : null,
      });
    } else if (result.errors) {
      for (const e of result.errors) process.stderr.write(`error: ${e}\n`);
    } else if (result.ok) {
      process.stdout.write(
        `loop "${result.state.name}" registered active (status=${result.status})` +
          (result.message ? ` — ${result.message}` : '') +
          '\n'
      );
    } else {
      process.stderr.write(`loop start failed: ${result.error || 'unknown'}\n`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (sub === 'pause') {
    const name = args[1];
    if (!name) fail('usage: aflt loop pause <name> [--json]');
    let result;
    try {
      result = loopLib.requestPause(name);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    if (!result.ok) fail(result.error || 'loop pause failed', { json: asJson });
    if (asJson) {
      emitJson({
        ok: true,
        name: result.state && result.state.name,
        status: result.status,
        pauseRequested: result.pauseRequested,
        active: result.state ? Boolean(result.state.active) : undefined,
      });
    } else {
      process.stdout.write(
        `loop "${result.state.name}" pause requested (status=${result.status})\n`
      );
    }
    return;
  }

  if (sub === 'status') {
    const name = args[1] || null;
    let result;
    try {
      result = loopLib.statusReport(name);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    if (!result.ok) fail(result.error || 'loop status failed', { json: asJson });
    if (asJson) {
      emitJson(result);
    } else if (result.loops) {
      if (!result.loops.length) {
        process.stdout.write('(no loops)\n');
      } else {
        for (const row of result.loops) {
          process.stdout.write(
            `${pad(row.name, 24)} ${pad(row.status, 10)} active=${row.active ? 'y' : 'n'} phase=${row.phaseId || '-'} updated=${row.updatedAt || '-'}` +
              (row.gate && row.gate.waiting && row.gate.costSoFar ? ` cost=${row.gate.costSoFar.text}` : '') +
              '\n'
          );
        }
      }
    } else {
      process.stdout.write(
        [
          `name: ${result.name}`,
          `status: ${result.status}`,
          `active: ${result.active}`,
          `phase: ${result.phaseId || '-'} (index ${result.phaseIndex}) attempt=${result.attempt} step=${result.step}`,
          `runsUsed: ${result.runsUsed}`,
          `cwd: ${result.cwd || '-'}`,
          `project: ${result.project || '-'}`,
          `stopRequested: ${result.stopRequested}`,
          `pauseRequested: ${result.pauseRequested}`,
          result.gate && result.gate.waiting
            ? `gate: waiting for approval before phase ${result.gate.phaseId || '-'} (aflt loop approve ${result.name})`
            : null,
          result.gate && result.gate.waiting && result.gate.costSoFar
            ? `cost so far: ${result.gate.costSoFar.text}`
            : null,
          result.lastError ? `lastError: ${result.lastError}` : null,
          result.lock
            ? `lock: pid=${result.lock.pid} alive=${result.lock.alive}`
            : 'lock: none',
        ]
          .filter(Boolean)
          .join('\n') + '\n'
      );
    }
    return;
  }

  if (sub === 'stop') {
    const name = args[1];
    if (!name) fail('usage: aflt loop stop <name> [--json]');
    let result;
    try {
      result = loopLib.requestStop(name);
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    if (!result.ok) fail(result.error || 'loop stop failed', { json: asJson });
    if (asJson) {
      emitJson({
        ok: true,
        name: result.state && result.state.name,
        status: result.status,
        stopRequested: result.stopRequested,
        signaled: result.signaled,
      });
    } else {
      process.stdout.write(
        `loop "${result.state.name}" stop requested (status=${result.status}` +
          (result.signaled ? ', signaled runner' : '') +
          ')\n'
      );
    }
    return;
  }

  if (sub === 'resume') {
    const name = args[1];
    if (!name) fail('usage: aflt loop resume <name> [--json]');
    let result;
    try {
      result = await loopLib.resumeLoop(name, { force: Boolean(flags.force) });
    } catch (err) {
      if (err && err.code === 'LOOP_BUSY') fail(err.message, { json: asJson });
      fail(err.message, { json: asJson });
    }
    if (asJson) {
      emitJson({
        ok: Boolean(result.ok),
        status: result.status || null,
        error: result.error || null,
        message: result.message || null,
        state: result.state
          ? {
              name: result.state.name,
              status: result.state.status,
              phaseId: result.state.phaseId,
              phaseIndex: result.state.phaseIndex,
              attempt: result.state.attempt,
              step: result.state.step,
              runsUsed: result.state.runsUsed,
            }
          : null,
      });
    } else if (result.ok) {
      process.stdout.write(
        `loop "${result.state ? result.state.name : name}" ${result.status}` +
          (result.message ? ` (${result.message})` : '') +
          '\n'
      );
    } else {
      process.stderr.write(`loop resume failed: ${result.error || result.status}\n`);
    }
    await notify.flushPendingNotifies();
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (sub === 'approve') {
    const name = args[1];
    if (!name) fail('usage: aflt loop approve <name> [--json]');
    let result;
    try {
      result = loopLib.requestApprove(name, { force: Boolean(flags.force) });
    } catch (err) {
      fail(err.message, { json: asJson });
    }
    if (result && result.notify && typeof result.notify.then === 'function') {
      try {
        await result.notify;
      } catch (_) {
        /* ignore */
      }
    }
    if (!result.ok) fail(result.error || 'loop approve failed', { json: asJson });
    if (asJson) {
      emitJson({
        ok: true,
        name: result.state && result.state.name,
        status: result.status,
        phaseId: result.phaseId,
        active: result.active,
        gate: result.state && result.state.gate,
      });
    } else {
      process.stdout.write(
        `loop "${result.state.name}" approved (phase=${result.phaseId || '-'}, status=${result.status})\n`
      );
    }
    await notify.flushPendingNotifies();
    return;
  }

  fail(`unknown loop subcommand: ${sub}\n${usage}`);
}

function cmdSpace(argv) {
  const { args, flags } = parseArgs(argv || []);
  const sub = args[0];
  const asJson = Boolean(flags.json);
  const usage =
    'usage: aflt space list|ls|create|current|remove [--json]\n' +
    '  aflt space list|ls [--json]\n' +
    '  aflt space create <name> [--json]\n' +
    '  aflt space current [--json]\n' +
    '  aflt space remove <name> [--force] [--json]';
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    fail(usage);
  }

  if (sub === 'list' || sub === 'ls') {
    const result = spaceLib.listSpaces();
    if (asJson) {
      emitJson(result);
      return;
    }
    const cur = result.current ? result.current : '(default)';
    process.stdout.write(`current: ${cur}\n`);
    process.stdout.write(
      `${result.default.current ? '* ' : '  '}(default)  ${result.default.path}  port=${result.default.port}  label=${result.default.serviceLabel}\n`
    );
    for (const s of result.spaces) {
      process.stdout.write(
        `${s.current ? '* ' : '  '}${s.name}  ${s.path}  port=${s.port != null ? s.port : '-'}  label=${s.serviceLabel}\n`
      );
    }
    return;
  }

  if (sub === 'current') {
    const info = spaceLib.currentSpaceInfo();
    if (asJson) {
      emitJson(info);
      return;
    }
    process.stdout.write(info.space ? `${info.space}\n` : '(default)\n');
    return;
  }

  if (sub === 'create') {
    const name = args[1];
    if (!name) fail('usage: aflt space create <name> [--json]', { json: asJson });
    let result;
    try {
      result = spaceLib.createSpace(name);
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    if (asJson) {
      emitJson(result);
      return;
    }
    process.stdout.write(
      `created space ${result.name}\n` +
        `  path: ${result.path}\n` +
        `  port: ${result.port}\n` +
        `  memoryRepo: ${result.memoryRepo}\n` +
        `  service: ${result.serviceLabel}\n` +
        `  notify: off\n`
    );
    return;
  }

  if (sub === 'remove') {
    const name = args[1];
    if (!name) fail('usage: aflt space remove <name> [--force] [--json]', { json: asJson });
    let result;
    try {
      result = spaceLib.removeSpace(name, { force: Boolean(flags.force) });
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    if (asJson) {
      emitJson(result);
      return;
    }
    process.stdout.write(`removed space ${result.name}\n`);
    return;
  }

  fail(`unknown space subcommand: ${sub}\n${usage}`, { json: asJson });
}

function cmdService(argv) {
  const { args, flags } = parseArgs(argv || []);
  const sub = args[0];
  const asJson = Boolean(flags.json);
  const usage =
    'usage: aflt service install|uninstall|status [--port N] [--host H] [--print] [--json]';
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    fail(usage);
  }

  let port;
  if (flags.port != null && flags.port !== true) {
    port = Number(flags.port);
  } else {
    try {
      port = spaceLib.resolveDashboardPort({});
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
  }

  const common = {
    print: Boolean(flags.print),
    host: flags.host,
    port,
    env: process.env,
    space: currentSpaceName(),
  };

  let result;
  try {
    if (sub === 'install') {
      result = serviceLib.install(common);
    } else if (sub === 'uninstall') {
      result = serviceLib.uninstall(common);
    } else if (sub === 'status') {
      result = serviceLib.status(common);
    } else {
      fail(`unknown service subcommand: ${sub}\n${usage}`);
    }
  } catch (err) {
    fail(err.message, { json: asJson });
  }

  if (asJson) {
    emitJson(result);
  } else if (!result.supported) {
    process.stderr.write(`${result.error}\n`);
  } else if (flags.print && result.plist) {
    process.stdout.write(result.plist);
    if (!result.plist.endsWith('\n')) process.stdout.write('\n');
  } else if (sub === 'status') {
    process.stdout.write(
      [
        `label: ${result.label}`,
        `path: ${result.path}`,
        `exists: ${result.exists}`,
        `loaded: ${result.loaded}`,
        result.logsDir ? `logs: ${result.logsDir}` : null,
        result.listError ? `list: ${result.listError}` : null,
      ]
        .filter(Boolean)
        .join('\n') + '\n'
    );
  } else if (sub === 'install') {
    if (result.print) {
      process.stdout.write(result.plist);
    } else {
      process.stdout.write(
        `service ${result.written ? 'installed' : 'planned'}: ${result.path}` +
          ` (host=${result.host} port=${result.port}` +
          `${result.loaded ? ', loaded' : ''})\n`
      );
    }
  } else if (sub === 'uninstall') {
    process.stdout.write(
      `service uninstall: ${result.path}` +
        `${result.removed ? ' (removed)' : result.exists ? '' : ' (not present)'}` +
        `${result.unloaded ? ', unloaded' : ''}\n`
    );
  }

  if (!result.ok || result.supported === false) {
    process.exitCode = 1;
  }
}

async function cmdEval(argv) {
  const { args, flags } = parseArgs(argv || []);
  const sub = args[0];
  const asJson = Boolean(flags.json);
  const usage =
    'usage: aflt eval measure|score|report|gate|plateau|tile-dungeon [--json] …\n' +
    '  aflt eval measure [--json] [--out DIR]\n' +
    '  aflt eval score [results-file] [--json] [--history PATH] [--qualitative] [--results-dir DIR] [--write-baseline PATH] [--max-rounds N]\n' +
    '  aflt eval report [--json] [--history PATH] [--limit N]\n' +
    '  aflt eval gate [--json] [--base REF] [--paths a,b] [--improve] [--baseline PATH] [--results PATH] [--results-dir DIR] [--history PATH] [--score N]\n' +
    '  aflt eval plateau [--json] [--baseline PATH] [--history PATH] [--max-rounds N] [--rounds N]\n' +
    '  aflt eval tile-dungeon [--json] [--dry-run] [--trials N] [--candidate DIR] [--base DIR] [--engine NAME] [--model NAME] [--timeout-sec N]';
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    fail(usage);
  }

  if (sub === 'measure') {
    const outDir =
      flags.out != null && flags.out !== true ? String(flags.out) : undefined;

    let result;
    try {
      result = await evalMeasure.measure({
        outDir,
        // Nested suite spawn is expensive; allow hermetic overrides via env.
        skipSuite: process.env.AFLT_EVAL_SKIP_SUITE === '1',
        skipCoverage: process.env.AFLT_EVAL_SKIP_COVERAGE === '1',
        skipSmoke: process.env.AFLT_EVAL_SKIP_SMOKE === '1',
        skipDashboardApi: process.env.AFLT_EVAL_SKIP_DASHBOARD_API === '1',
        useInProcessDashboard: process.env.AFLT_EVAL_INPROCESS_DASHBOARD === '1',
      });
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }

    if (asJson) {
      emitJson({
        ok: Boolean(result.ok),
        path: result.path,
        measuredAt: result.measuredAt,
        suite: {
          ok: Boolean(result.suite && result.suite.ok),
          pass: result.suite && result.suite.pass,
          fail: result.suite && result.suite.fail,
          skip: result.suite && result.suite.skip,
          flakes: (result.suite && result.suite.flakes && result.suite.flakes.length) || 0,
          hardFails: (result.suite && result.suite.hardFails && result.suite.hardFails.length) || 0,
          skipped: Boolean(result.suite && result.suite.skipped),
        },
        coverage: result.coverage,
        cliSmoke: {
          ok: Boolean(result.cliSmoke && result.cliSmoke.ok),
          failures: result.cliSmoke && result.cliSmoke.failures,
          commandCount: result.cliSmoke && result.cliSmoke.commandCount,
        },
        dashboardApi: {
          ok: Boolean(result.dashboardApi && result.dashboardApi.ok),
          port: result.dashboardApi && result.dashboardApi.port,
          routeCount: result.dashboardApi && result.dashboardApi.routes
            ? result.dashboardApi.routes.length
            : 0,
        },
      });
    } else {
      process.stdout.write(`eval measure ${result.ok ? 'ok' : 'FAILED'}: ${result.path}\n`);
      const s = result.suite || {};
      process.stdout.write(
        `  suite: pass=${s.pass || 0} fail=${s.fail || 0} skip=${s.skip || 0}` +
          (s.skipped ? ' (skipped)' : '') +
          ` flakes=${(s.flakes && s.flakes.length) || 0}` +
          ` hardFails=${(s.hardFails && s.hardFails.length) || 0}\n`
      );
      const cov = result.coverage || {};
      process.stdout.write(
        `  coverage: ${cov.available ? 'available' : 'unavailable'}` +
          (cov.reason ? ` (${cov.reason})` : '') +
          '\n'
      );
      const smoke = result.cliSmoke || {};
      process.stdout.write(
        `  cliSmoke: ${smoke.ok ? 'ok' : 'FAILED'} commands=${smoke.commandCount || 0}` +
          (smoke.failures ? ` failures=${smoke.failures}` : '') +
          '\n'
      );
      const api = result.dashboardApi || {};
      process.stdout.write(
        `  dashboardApi: ${api.ok ? 'ok' : 'FAILED'}` +
          (api.port != null ? ` port=${api.port}` : '') +
          ` routes=${(api.routes && api.routes.length) || 0}\n`
      );
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (sub === 'score') {
    const evalScore = require('../scripts/eval/score');
    const evalImprove = require('../scripts/eval/improve');
    const resultsFile = args[1];
    const historyPath =
      flags.history != null && flags.history !== true
        ? String(flags.history)
        : undefined;
    const resultsDir =
      flags['results-dir'] != null && flags['results-dir'] !== true
        ? String(flags['results-dir'])
        : undefined;
    const qualitative = Boolean(flags.qualitative);
    const writeBaselineFlag = flags['write-baseline'];
    const maxRounds =
      flags['max-rounds'] != null && flags['max-rounds'] !== true
        ? Number(flags['max-rounds'])
        : undefined;

    let result;
    try {
      result = evalScore.score({
        resultsPath: resultsFile,
        resultsDir,
        historyPath,
        qualitative,
        env: process.env,
      });
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }

    let baseline = null;
    if (writeBaselineFlag != null) {
      try {
        const baselinePath =
          writeBaselineFlag === true
            ? evalImprove.defaultBaselinePath()
            : String(writeBaselineFlag);
        baseline = evalImprove.recordBaseline({
          baselinePath,
          score: result,
          maxRounds,
        });
      } catch (err) {
        fail(err.message || String(err), { json: asJson });
      }
    }

    if (asJson) {
      emitJson({
        ok: Boolean(result.ok),
        overall: result.overall,
        criteria: result.criteria,
        qualitative: result.qualitative,
        historyPath: result.historyPath,
        scoredAt: result.scoredAt,
        resultsPath: result.resultsPath,
        rubricVersion: result.rubricVersion,
        baseline: baseline
          ? {
              path: baseline.path,
              overall: baseline.overall,
              maxRounds: baseline.maxRounds,
            }
          : null,
      });
    } else {
      process.stdout.write(
        `eval score overall=${result.overall} rubric=v${result.rubricVersion}` +
          ` scoredAt=${result.scoredAt}\n`
      );
      if (result.resultsPath) {
        process.stdout.write(`  results: ${result.resultsPath}\n`);
      }
      process.stdout.write(`  history: ${result.historyPath}\n`);
      for (const c of result.criteria || []) {
        process.stdout.write(
          `  ${c.id}: ${c.score} (w=${c.weight})` +
            (c.detail ? ` — ${c.detail}` : '') +
            '\n'
        );
      }
      if (result.qualitative && result.qualitative.skipped) {
        process.stdout.write(
          `  qualitative: skipped (${result.qualitative.reason || 'n/a'})\n`
        );
      }
      if (baseline) {
        process.stdout.write(
          `  baseline: ${baseline.path} overall=${baseline.overall}` +
            ` maxRounds=${baseline.maxRounds}\n`
        );
      }
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (sub === 'report') {
    const evalReport = require('../scripts/eval/report');
    const historyPath =
      flags.history != null && flags.history !== true
        ? String(flags.history)
        : undefined;
    const limit =
      flags.limit != null && flags.limit !== true
        ? Number(flags.limit)
        : undefined;
    let result;
    try {
      result = evalReport.report({ historyPath, limit });
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    if (asJson) {
      emitJson({
        ok: Boolean(result.ok),
        latest: result.latest,
        previous: result.previous,
        trend: result.trend,
        historyPath: result.historyPath,
        entryCount: result.trend && result.trend.count,
      });
    } else {
      process.stdout.write(result.text);
    }
    process.exitCode = 0;
    return;
  }

  if (sub === 'gate') {
    const evalGate = require('../scripts/eval/gate');
    const evalImprove = require('../scripts/eval/improve');
    const base =
      flags.base != null && flags.base !== true ? String(flags.base) : 'HEAD';
    let protectedPaths;
    if (flags.paths != null && flags.paths !== true) {
      protectedPaths = String(flags.paths)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const improve = Boolean(flags.improve);

    if (improve) {
      const baselinePath =
        flags.baseline != null && flags.baseline !== true
          ? String(flags.baseline)
          : undefined;
      const resultsPath =
        flags.results != null && flags.results !== true
          ? String(flags.results)
          : args[1] || undefined;
      const resultsDir =
        flags['results-dir'] != null && flags['results-dir'] !== true
          ? String(flags['results-dir'])
          : undefined;
      const historyPath =
        flags.history != null && flags.history !== true
          ? String(flags.history)
          : undefined;
      const overall =
        flags.score != null && flags.score !== true
          ? Number(flags.score)
          : undefined;
      const result = evalImprove.improveGate({
        base,
        protectedPaths,
        baselinePath,
        resultsPath,
        resultsDir,
        historyPath,
        overall: Number.isFinite(overall) ? overall : undefined,
      });
      if (asJson) {
        emitJson({
          ok: Boolean(result.ok),
          improve: true,
          failures: result.failures,
          checks: result.checks,
          baseline: result.baseline,
          resultsPath: result.resultsPath,
          violations: result.rubric && result.rubric.violations,
          protectedPaths: result.rubric && result.rubric.protectedPaths,
          changedFiles: result.rubric && result.rubric.changedFiles,
        });
      } else if (result.ok) {
        process.stdout.write('eval gate --improve ok\n');
        for (const c of result.checks || []) {
          process.stdout.write(`  ${c.id}: ${c.ok ? 'ok' : 'FAIL'} — ${c.detail}\n`);
        }
      } else {
        process.stderr.write(
          `eval gate --improve FAILED (${(result.failures || []).join(', ')})\n`
        );
        for (const c of result.checks || []) {
          process.stderr.write(
            `  ${c.id}: ${c.ok ? 'ok' : 'FAIL'} — ${c.detail}\n`
          );
        }
      }
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    const result = evalGate.gate({
      base,
      protectedPaths,
    });
    if (asJson) {
      emitJson({
        ok: Boolean(result.ok),
        violations: result.violations,
        protectedPaths: result.protectedPaths,
        changedFiles: result.changedFiles,
      });
    } else if (result.ok) {
      process.stdout.write(
        `eval gate ok: no protected-path changes (${result.protectedPaths.length} watched)\n`
      );
    } else {
      process.stderr.write(
        `eval gate FAILED: protected paths changed:\n` +
          result.violations.map((v) => `  ${v}`).join('\n') +
          '\n'
      );
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (sub === 'plateau') {
    const evalImprove = require('../scripts/eval/improve');
    const baselinePath =
      flags.baseline != null && flags.baseline !== true
        ? String(flags.baseline)
        : undefined;
    const historyPath =
      flags.history != null && flags.history !== true
        ? String(flags.history)
        : undefined;
    const maxRounds =
      flags['max-rounds'] != null && flags['max-rounds'] !== true
        ? Number(flags['max-rounds'])
        : undefined;
    const rounds =
      flags.rounds != null && flags.rounds !== true
        ? Number(flags.rounds)
        : undefined;
    let result;
    try {
      result = evalImprove.shouldStopImprove({
        baselinePath,
        historyPath,
        maxRounds: Number.isFinite(maxRounds) ? maxRounds : undefined,
        rounds: Number.isFinite(rounds) ? rounds : undefined,
      });
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    if (asJson) {
      emitJson({ ok: true, ...result });
    } else {
      process.stdout.write(
        `eval plateau: stop=${result.stop}` +
          (result.reason ? ` reason=${result.reason}` : '') +
          ` rounds=${result.rounds}/${result.maxRounds}` +
          (result.latest != null ? ` latest=${result.latest}` : '') +
          `\n  ${result.detail}\n`
      );
    }
    // Exit 0 always when the check ran; callers inspect stop=true (or use
    // passRegex). Non-zero only on hard errors above.
    process.exitCode = 0;
    return;
  }

  if (sub === 'tile-dungeon') {
    const tileDungeon = require('../scripts/eval/tile-dungeon');
    const tdArgs = (argv || []).slice(1);
    const flags = tileDungeon.parseArgv(tdArgs);
    let result;
    try {
      result = await tileDungeon.runTileDungeon({
        argv: tdArgs,
        flags,
        json: asJson || flags.json,
        dryRun: Boolean(flags.dryRun),
        trials: flags.trials,
        candidate: flags.candidate,
        base: flags.base,
        engine: flags.engine,
        model: flags.model,
        timeoutSec: flags.timeoutSec,
      });
    } catch (err) {
      fail(err.message || String(err), { json: asJson });
    }
    if (asJson || flags.json) {
      emitJson({ ok: Boolean(result.ok), ...result });
    } else if (result.dryRun) {
      process.stdout.write(
        `eval tile-dungeon dry-run: ${result.plan.trials} trial(s) sha=${result.plan.sha}\n`
      );
    } else {
      process.stdout.write(
        `eval tile-dungeon: ${result.ok ? 'ok' : 'FAILED'} mean=${result.mean} median=${result.median} stdDev=${result.stdDev}\n`
      );
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  fail(`unknown eval subcommand: ${sub}\n${usage}`, { json: asJson });
}

async function cmdNotify(argv) {
  const { args, flags } = parseArgs(argv || []);
  const sub = args[0];
  const asJson = Boolean(flags.json);
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    fail('usage: aflt notify test [--json]');
  }
  if (sub !== 'test') {
    fail(`unknown notify subcommand: ${sub}\nusage: aflt notify test [--json]`);
  }
  const result = await notify.sendTestEvent({ env: process.env });
  if (asJson) {
    emitJson({
      ok: Boolean(result.ok),
      event: result.payload && result.payload.event,
      status: result.status != null ? result.status : null,
      error: result.error || null,
      config: result.config || null,
      payload: result.payload || null,
    });
  } else if (result.ok) {
    process.stdout.write(
      `notify test ok (HTTP ${result.status != null ? result.status : '?'})\n`
    );
  } else {
    process.stderr.write(String(result.error || 'notify test failed') + '\n');
  }
  process.exitCode = result.ok ? 0 : 1;
}

function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(msg, opts = {}) {
  const asJson = Boolean(opts && opts.json);
  if (asJson) {
    emitJson({ ok: false, error: String(msg) });
  } else {
    process.stderr.write(String(msg) + '\n');
  }
  process.exit(1);
}

/**
 * Launch sessions via Herdr with discovery refuse + per-id launch locks.
 * Dry-run never executes hc run / labels; discovery failure on dry-run plans as empty live.
 */
function launchViaHerdr(sessions, { dryRun = false, resumeOpts, flags = {}, json = false } = {}) {
  const discovery = herdr.fetchHerdrTerminals();
  if (!discovery.ok) {
    if (!dryRun) {
      fail(launch.discoveryRefuseMessage(discovery.error), { json });
    }
    process.stderr.write(`herdr: ${discovery.error || 'query failed'} (dry-run assuming none live)\n`);
  }
  const live = discovery.ok
    ? (discovery.terminals || [])
        .filter((t) => herdr.isLiveTerminal(t))
        .map((t) => ({
          name: t.name || null,
          labels: {
            ...(t.labels || {}),
            ...(t.afId ? { af_id: t.afId } : {}),
          },
          address: t.address || null,
          afId: t.afId || null,
          agent: t.agent != null ? t.agent : null,
          argv: Array.isArray(t.argv) ? t.argv : null,
          foreground: t.foreground || null,
          state: t.state || null,
          reason: t.reason || null,
          exitCode: t.exitCode != null ? t.exitCode : null,
        }))
    : [];

  if (dryRun) {
    try {
      return backends.executeResumeAll(sessions, {
        via: 'herdr',
        dryRun: true,
        resumeOpts,
        herdrLive: live,
      });
    } catch (err) {
      fail(err && err.message ? err.message : String(err), { json });
    }
  }

  const allResults = [];
  const allCommands = [];
  for (const s of sessions) {
    let held = null;
    try {
      held = launch.tryAcquireLaunchLock(s.id);
      if (!held) {
        allResults.push({
          title: s.title,
          id: s.id,
          skipped: true,
          busy: true,
          name: null,
          error: 'already running/launching',
        });
        process.stderr.write(`skip "${s.title}": already running/launching\n`);
        continue;
      }
      const again = backends.fetchHerdrLive();
      if (!again.ok) {
        fail(launch.discoveryRefuseMessage(again.error), { json });
      }
      let plan;
      try {
        plan = backends.executeResumeAll([s], {
          via: 'herdr',
          dryRun: false,
          resumeOpts,
          herdrLive: again.terminals,
        });
      } catch (err) {
        fail(err && err.message ? err.message : String(err), { json });
      }
      if (plan.commands) allCommands.push(...plan.commands);
      if (plan.results) allResults.push(...plan.results);
    } finally {
      if (held) launch.releaseLaunchLock(held);
    }
  }
  return {
    backend: 'herdr',
    executed: true,
    commands: allCommands,
    results: allResults,
    discoveryOk: true,
    discoveryError: null,
  };
}

function herdrLaunchFailed(plan) {
  if (!plan || !plan.results) return null;
  for (const r of plan.results) {
    if (r.busy) return r.error || 'already running/launching';
    if (!r.skipped && r.status != null && r.status !== 0) {
      return (r.stderr && String(r.stderr).trim()) || `hc run failed (exit ${r.status})`;
    }
  }
  return null;
}

// `aflt ls | head` closes stdout early; exit quietly instead of crashing with EPIPE.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

main()
  .catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exitCode = 1;
  })
  .finally(async () => {
    // Drain turn.captured (and any leftover) webhooks before the process exits.
    try {
      await notify.flushPendingNotifies();
    } catch (_) {
      /* never fail the CLI for notify flush */
    }
  });
