'use strict';

/**
 * `aflt loop` — long-running plan→develop→eval→revise runner.
 *
 * Milestone 1: validate / run / status / stop / resume.
 * Milestone 2: start / pause for the dashboard scheduler; opt-in heartbeat.
 * Milestone 3: dashboard UI, definition save (safe dirs), approval gates.
 * Milestone 4: plan-next phases, goal/acceptance, maxPhases, planned gates.
 *
 * Opt-in, never destructive by default (onPass actions require loop-level
 * `allow` flags). State lives under `$AGENTFLEET_HOME/loops/<name>/`.
 * Notify + memory writes are best-effort and never break the loop.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const config = require('./config');
const engineLib = require('./engine');
const cursor = require('./cursor');
const copilot = require('./copilot');
const opencode = require('./opencode');
const { classifyEngineError } = require('./engine-errors');
const registry = require('./registry');
const runlib = require('./run');
const notify = require('./notify');
const memory = require('./memory');
const projectLib = require('./project');
const protectedPaths = require('./protected-paths');
const evalCoverage = require('./eval-coverage');
const commitGate = require('./commit-gate');
const loopVerify = require('./loop-verify');
const {
  fleetDir,
  nowIso,
  slugify,
  expandUserPath,
  gitBranch,
  resolveCwd,
  envNonEmpty,
} = require('./util');

/** Leading safety lines stripped from prompt *excerpts* only (full prompt kept for runs). */
const PROMPT_PREAMBLE_LINES = [
  /^do not switch to plan mode\b/i,
  /^never use pkill\/killall\b/i,
];
/** Same-line preamble prefixes (e.g. "Do not switch to plan mode. You are running…"). */
const PROMPT_PREAMBLE_PREFIXES = [
  /^do not switch to plan mode\.\s*/i,
  /^never use pkill\/killall or pattern-matched kills; only stop pids you started\.\s*/i,
];

const STATE_VERSION = 1;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const ON_PASS_ACTIONS = new Set(['none', 'commit', 'merge', 'push']);
const LOOP_STATUSES = new Set([
  'pending',
  'running',
  'paused',
  'waiting',
  'needs_human',
  'completed',
  'failed',
  'stopped',
]);
const DEFAULT_ESCALATION_EVENT = notify.EVENTS.LOOP_NEEDS_HUMAN;
const NEEDS_HUMAN_FILENAME = 'needs-human.json';
const PHASE_STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'skipped']);
const PHASE_GATES = new Set(['approve', 'none']);
/** Normal work phase vs planner that appends more phases. */
// run: agent prompt then eval. plan-next: planner writes plan-next.json.
// script: no AI call; the eval command is the step (setup/seed scripts).
const PHASE_TYPES = new Set(['run', 'plan-next', 'script']);
const DEFAULT_PLANNED_PHASE_GATE = 'approve';
const PLAN_NEXT_FILENAME = 'plan-next.json';
const PLAN_NEXT_HISTORY_CAP = 40;
const PLAN_NEXT_NOTES_CAP = 8;
const LOCK_STALE_MS = 60_000;
const EVAL_OUTPUT_CAP = 12_000;
const FIX_OUTPUT_CAP = 8000;
const EVAL_TAIL_CAP = 2000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);
/** Reserved API path segments that are not loop names. */
const RESERVED_LOOP_ROUTE_NAMES = new Set(['start', 'save', 'definitions']);
/** Explicit model tokens (Copilot `auto`, `claude-opus-4.6`, …). */
const MODEL_TOKEN = /^[A-Za-z0-9._:@+/-]{1,128}$/;

/**
 * Validate a model id. null/empty → null. Invalid → `{ error }`.
 * @returns {string|null|{ error: string }}
 */
function normalizeModel(raw, label) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!MODEL_TOKEN.test(s)) {
    return {
      error: `${label}: model must be one token (letters, digits, and . _ : @ + / -), got ${JSON.stringify(s)}`,
    };
  }
  return s;
}

/** config.json `defaultModel`, else `model`. Invalid values are ignored. */
function configDefaultModel() {
  let data;
  try {
    data = config.load();
  } catch (_) {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const raw = data.defaultModel != null ? data.defaultModel : data.model;
  const norm = normalizeModel(raw, 'config.defaultModel');
  if (!norm || typeof norm !== 'string') return null;
  return norm;
}

/**
 * Model for a loop phase.
 * phase.model → definition.model → COPILOT_MODEL (copilot only) → config defaultModel/model.
 */
function resolvePhaseModel(phase, definition, env) {
  const e = env || process.env;
  if (phase && phase.model) return phase.model;
  if (definition && definition.model) return definition.model;
  const engineName = (phase && phase.engine) || (definition && definition.engine) || '';
  if (engineName === 'copilot') {
    const fromEnv = envNonEmpty(e, 'COPILOT_MODEL');
    if (fromEnv) {
      const norm = normalizeModel(fromEnv, 'COPILOT_MODEL');
      if (typeof norm === 'string') return norm;
    }
  }
  return configDefaultModel();
}

/** True when the agent run must not count as a phase pass. */
function agentRunFailed(run) {
  if (!run || typeof run !== 'object') return false;
  if (run.timedOut) return true;
  if (run.code == null || run.code === '') return true;
  const n = Number(run.code);
  if (!Number.isFinite(n)) return true;
  return n !== 0;
}

/**
 * Copilot `--add-dir` errors when results/ or plans/ is missing.
 * `aflt run` / `aflt spawn` already create them; loop sessions must too.
 */
function ensureFleetWorkspaceDirs(session) {
  const dirs = [path.join(fleetDir(), 'results'), path.join(fleetDir(), 'plans')];
  for (const p of [session && session.result, session && session.plan]) {
    if (!p) continue;
    dirs.push(path.dirname(path.resolve(String(p))));
  }
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (_) {
      /* ignore */
    }
  }
}

function pathContains(parent, child) {
  let p;
  let c;
  try {
    p = fs.realpathSync(parent);
  } catch (_) {
    p = path.resolve(parent);
  }
  try {
    c = fs.realpathSync(child);
  } catch (_) {
    c = path.resolve(child);
  }
  return c === p || c.startsWith(p + path.sep);
}

const WORKDIR_MODES = new Set(['fresh', 'worktree', 'project']);

function gitOut(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

function normalizeWorkdir(raw, anchor) {
  if (raw == null) return { ok: true, value: { mode: 'fresh' } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'workdir must be an object like { "mode": "worktree" }' };
  }
  const mode = raw.mode == null ? 'fresh' : String(raw.mode).trim().toLowerCase();
  if (!WORKDIR_MODES.has(mode)) {
    return {
      ok: false,
      error: `workdir.mode must be "fresh", "worktree" or "project" (got "${String(raw.mode)}")`,
    };
  }
  if (mode === 'fresh' || mode === 'project') {
    for (const key of ['base', 'path', 'branch']) {
      if (raw[key] != null) {
        return { ok: false, error: `workdir.${key} only applies to workdir.mode "worktree"` };
      }
    }
    return { ok: true, value: { mode } };
  }
  const value = { mode, base: 'origin/main', path: null, branch: null };
  for (const key of ['base', 'branch']) {
    if (raw[key] == null) continue;
    const v = typeof raw[key] === 'string' ? raw[key].trim() : '';
    if (!v || v.startsWith('-') || /\s/.test(v)) {
      return { ok: false, error: `workdir.${key} must be a git ref name (no spaces, not starting with "-")` };
    }
    value[key] = v;
  }
  if (raw.path != null) {
    const p = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!p) return { ok: false, error: 'workdir.path must be a non-empty string' };
    const expanded = expandUserPath(p);
    value.path = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(anchor, expanded);
  }
  return { ok: true, value };
}

function defaultWorktreeBranch() {
  return `aflt-self-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}`;
}

function worktreeAddCommand(wd, target) {
  const branch = wd.branch || '<branch>';
  return `git worktree add -b ${branch} ${target} ${wd.base || 'origin/main'}`;
}

/**
 * workdir.mode "worktree": the cwd may be a non-empty clean checkout (ideally a
 * linked git worktree) as long as it is not the running aflt package root.
 */
function inspectWorktreeWorkdir(abs, wd) {
  const problems = [];
  const pkgRoot = path.resolve(__dirname, '..');
  const hint = worktreeAddCommand(wd, abs);
  let git = false;
  let clean = false;
  let linked = false;
  const inside = gitOut(abs, ['rev-parse', '--is-inside-work-tree']);
  git = inside === 'true';
  if (!git) {
    problems.push(
      `cwd ${abs} is not a git repository or worktree. Create one with \`${hint}\` (run from the repo to improve)`
    );
  } else {
    const status = gitOut(abs, ['status', '--porcelain']);
    clean = status === '';
    if (!clean) problems.push(`cwd git working tree is not clean: ${abs}. Commit or stash first, or use a fresh worktree (\`${hint}\`)`);
    const gitDir = gitOut(abs, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const common = gitOut(abs, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    linked = Boolean(gitDir && common && path.resolve(gitDir) !== path.resolve(common));
  }
  let real;
  let realPkg;
  try {
    real = fs.realpathSync(abs);
  } catch (_) {
    real = abs;
  }
  try {
    realPkg = fs.realpathSync(pkgRoot);
  } catch (_) {
    realPkg = pkgRoot;
  }
  if (real === realPkg) {
    problems.push(
      `cwd is the running aflt checkout (${realPkg}); run the loop in a separate worktree: \`${hint}\``
    );
  } else if (real.startsWith(realPkg + path.sep)) {
    problems.push(`cwd is inside the running aflt checkout (${realPkg}): ${abs}`);
  }
  return { problems, git, clean, linked };
}

/**
 * workdir.mode "project" (written by `aflt loop init`): the cwd is the
 * project's own repo. It may be non-empty and may hold the definition
 * (.agentfleet/loop.json), but must be a clean git repo (commit the docs and
 * the loop first, so each phase's commit holds only that phase's work) and
 * not the aflt checkout.
 */
function inspectProjectWorkdir(abs) {
  const problems = [];
  const git = gitOut(abs, ['rev-parse', '--is-inside-work-tree']) === 'true';
  let clean = false;
  if (!git) {
    problems.push(`cwd ${abs} is not a git repository. Run \`git init\` in it (aflt loops commit each passed phase)`);
  } else {
    clean = gitOut(abs, ['status', '--porcelain']) === '';
    if (!clean) {
      problems.push(
        `cwd git working tree is not clean: ${abs}. Commit the project docs and the loop first: git add -A && git commit -m "Add aflt loop"`
      );
    }
  }
  const pkgRoot = path.resolve(__dirname, '..');
  if (pathContains(abs, pkgRoot) || pathContains(pkgRoot, abs)) {
    problems.push(`cwd contains or is inside the aflt checkout: ${abs}`);
  }
  return { ok: problems.length === 0, problems, cwd: abs, mode: 'project', git, clean };
}

/**
 * A loop cwd must be a clean, empty git repo that is not the aflt checkout
 * and does not contain the definition file. Problems are reasons to refuse.
 * With opts.workdir.mode "worktree" see inspectWorktreeWorkdir.
 */
function inspectLoopWorkdir(cwd, opts = {}) {
  const abs = path.resolve(String(cwd || ''));
  if (opts.workdir && opts.workdir.mode === 'project') {
    return inspectProjectWorkdir(abs);
  }
  if (opts.workdir && opts.workdir.mode === 'worktree') {
    const wt = inspectWorktreeWorkdir(abs, opts.workdir);
    return {
      ok: wt.problems.length === 0,
      problems: wt.problems,
      cwd: abs,
      mode: 'worktree',
      git: wt.git,
      clean: wt.clean,
      linkedWorktree: wt.linked,
      base: opts.workdir.base,
      branch: opts.workdir.branch || null,
    };
  }
  const problems = [];
  let git = false;
  let clean = false;
  let empty = false;
  const inside = spawnSync('git', ['-C', abs, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  git = inside.status === 0 && String(inside.stdout || '').trim() === 'true';
  if (!git) {
    problems.push(
      `cwd ${abs} is not a git repository. Run \`git init\` in it (aflt loops commit each passed phase), or pass --allow-existing`
    );
  } else {
    const status = spawnSync('git', ['-C', abs, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    clean = status.status === 0 && String(status.stdout || '').trim() === '';
    if (!clean) problems.push(`cwd git working tree is not clean: ${abs}`);
    const head = spawnSync('git', ['-C', abs, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    let extra = false;
    try {
      extra = fs.readdirSync(abs).some((name) => name !== '.git');
    } catch (_) {
      extra = true;
    }
    empty = head.status !== 0 && !extra;
    if (!empty) problems.push(`cwd is not an empty dedicated git repository: ${abs}`);
  }

  const pkgRoot = path.resolve(__dirname, '..');
  if (pathContains(abs, pkgRoot) || pathContains(pkgRoot, abs)) {
    problems.push(`cwd contains or is inside the aflt checkout: ${abs}`);
  }
  if (opts.definitionPath && pathContains(abs, opts.definitionPath)) {
    problems.push(`cwd contains the loop definition (${path.resolve(String(opts.definitionPath))})`);
  }

  const seen = new Set();
  const unique = [];
  for (const problem of problems) {
    if (seen.has(problem)) continue;
    seen.add(problem);
    unique.push(problem);
  }
  return { ok: unique.length === 0, problems: unique, cwd: abs, mode: 'fresh', git, clean, empty };
}

/**
 * skip: hermetic tests, or resume of an existing loop.
 * allow: --allow-existing (warn, do not refuse).
 * enforce: refuse a bad cwd on run; dry-run reports the same problems.
 */
function workdirPolicy(opts, state) {
  const env = (opts && opts.env) || process.env;
  if (opts && opts.allowExisting) return 'allow';
  const hermetic =
    (env && env.AGENTFLEET_TEST_HERMETIC === '1') ||
    process.env.AGENTFLEET_TEST_HERMETIC === '1';
  if (hermetic && !(opts && opts.checkWorkdir === true)) {
    return 'skip';
  }
  if (
    opts &&
    !opts.dryRun &&
    state &&
    !opts.fresh &&
    ['running', 'paused', 'waiting', 'needs_human', 'completed', 'failed', 'stopped'].includes(
      state.status
    )
  ) {
    return 'skip';
  }
  return 'enforce';
}

function permissionSummary(phases) {
  const flags = (phases || []).map((p) => (p && p.force === true ? 'force' : 'restricted'));
  if (!flags.length) return 'restricted';
  const set = new Set(flags);
  if (set.size === 1) return [...set][0];
  return 'mixed';
}

function warnStderr(lines) {
  for (const w of lines || []) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }
}

/** Where `git worktree add` would run: the repo that holds the definition file. */
function planWorktreeCreate(definition, opts) {
  const wd = definition.workdir;
  const branch = wd.branch || defaultWorktreeBranch();
  const command = worktreeAddCommand({ ...wd, branch }, wd.path);
  const defDir = opts && opts.definitionPath ? path.dirname(path.resolve(opts.definitionPath)) : null;
  const repo = defDir ? gitOut(defDir, ['rev-parse', '--show-toplevel']) : null;
  return { repo, branch, base: wd.base, path: wd.path, command };
}

function createWorktree(plan) {
  if (!plan.repo) {
    return {
      ok: false,
      error: `cannot create worktree: the definition file is not inside a git repository. Run \`${plan.command}\` from the repo to improve`,
    };
  }
  const r = spawnSync('git', ['-C', plan.repo, 'worktree', 'add', '-b', plan.branch, plan.path, plan.base], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.status !== 0) {
    const detail = String(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ');
    return { ok: false, error: `git worktree add failed: ${detail}` };
  }
  return { ok: true };
}

function applyWorkdirGate(definition, opts, state) {
  const policy = workdirPolicy(opts, state);
  if (policy === 'skip') return { ok: true, skipped: true, warnings: [] };
  const wd = definition.workdir || { mode: 'fresh' };
  const worktreeMode = wd.mode === 'worktree';
  let created = null;
  if (worktreeMode && wd.path && !fs.existsSync(definition.cwd)) {
    const plan = planWorktreeCreate(definition, opts);
    if (opts && opts.createWorktree && !opts.dryRun) {
      const made = createWorktree(plan);
      if (!made.ok) {
        warnStderr([made.error]);
        return { ok: false, errors: [made.error], error: made.error, warnings: [] };
      }
      created = plan.command;
    } else if (opts && opts.createWorktree) {
      created = `would run: ${plan.command}`;
    } else {
      const msg = `workdir.path does not exist: ${definition.cwd}. Create it with \`${plan.command}\` (or pass --create-worktree)`;
      warnStderr([msg]);
      return {
        ok: false,
        errors: [msg],
        error: msg,
        warnings: [],
        workdir: { ok: false, problems: [msg], cwd: definition.cwd, mode: 'worktree', git: false, createCommand: plan.command },
      };
    }
  }
  const inspection =
    created && created.startsWith('would run:')
      ? { ok: true, problems: [], cwd: definition.cwd, mode: 'worktree', git: false, clean: false, linkedWorktree: false, base: wd.base, branch: wd.branch || null }
      : inspectLoopWorkdir(definition.cwd, {
          definitionPath: opts && opts.definitionPath,
          workdir: wd,
        });
  if (created) inspection.created = created;
  if (policy === 'allow') {
    const warnings = inspection.problems.map(
      (p) =>
        `continuing because --allow-existing: ${p.replace(/, or pass --allow-existing$/, '')}`
    );
    warnStderr(warnings);
    return { ok: true, warnings, workdir: { ...inspection, allowed: true } };
  }
  if (inspection.ok) return { ok: true, warnings: [], workdir: inspection };
  const warnings = ['loop run refuses this folder unless you pass --allow-existing'];
  if (worktreeMode) warnings[0] = 'loop run refuses this worktree unless you pass --allow-existing';
  warnStderr(inspection.problems);
  warnStderr(warnings);
  return {
    ok: false,
    errors: inspection.problems,
    warnings,
    error: inspection.problems.join('; '),
    workdir: inspection,
  };
}

function loopsRoot() {
  return path.join(fleetDir(), 'loops');
}

function safeLoopName(name) {
  const s = slugify(String(name || '').trim());
  if (!s || s === 'session') {
    const err = new Error('loop name is required');
    err.code = 'LOOP_NAME';
    throw err;
  }
  return s;
}

function loopDir(name) {
  return path.join(loopsRoot(), safeLoopName(name));
}

function statePath(name) {
  return path.join(loopDir(name), 'state.json');
}

function lockPath(name) {
  return path.join(loopDir(name), 'runner.lock');
}

function definitionSnapshotPath(name) {
  return path.join(loopDir(name), 'definition.json');
}

const ACTIVITY_FILENAME = 'activity.json';
/** Default idle limit for an engine run: no output and no file change for 20 minutes. */
const DEFAULT_IDLE_TIMEOUT_SEC = 1200;

function activityPath(name) {
  return path.join(loopDir(name), ACTIVITY_FILENAME);
}

/** Parse an idleTimeoutSec value: null when unset, integer >= 0 (0 = off), or { error }. */
function parseIdleTimeoutSec(value, label) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return { error: `${label}: idleTimeoutSec must be a number of seconds >= 0 (0 turns it off)` };
  }
  return Math.floor(n);
}

/**
 * Idle limit (seconds) for one engine run: phase > definition >
 * AFLT_LOOP_IDLE_TIMEOUT_SEC > 1200. 0 turns it off.
 */
function resolveIdleTimeoutSec(phase, definition, env = process.env) {
  if (phase && Number.isInteger(phase.idleTimeoutSec)) return phase.idleTimeoutSec;
  if (definition && Number.isInteger(definition.idleTimeoutSec)) return definition.idleTimeoutSec;
  const fromEnv = parseIdleTimeoutSec(env && env.AFLT_LOOP_IDLE_TIMEOUT_SEC, 'AFLT_LOOP_IDLE_TIMEOUT_SEC');
  if (Number.isInteger(fromEnv)) return fromEnv;
  return DEFAULT_IDLE_TIMEOUT_SEC;
}

/**
 * Newest mtime (ms) under a work folder, skipping .git and node_modules and
 * capped so a big tree stays cheap. Used as the engine's file-activity signal.
 */
function newestMtimeMs(root, opts = {}) {
  const maxEntries = opts.maxEntries || 5000;
  const maxDepth = opts.maxDepth || 6;
  let newest = 0;
  let seen = 0;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && seen < maxEntries) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of entries) {
      if (++seen > maxEntries) break;
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const full = path.join(dir, ent.name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (_) {
        continue;
      }
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (ent.isDirectory() && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return newest || null;
}

/** Record the last sign of progress for a loop (best effort). */
function recordLoopActivity(name, info = {}) {
  if (!name) return false;
  try {
    const file = activityPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = info.at ? new Date(info.at).toISOString() : nowIso();
    fs.writeFileSync(
      file,
      JSON.stringify({ at, source: info.source || null, phaseId: info.phaseId || null }, null, 2) + '\n'
    );
    return true;
  } catch (_) {
    return false;
  }
}

function readLoopActivity(name) {
  try {
    const data = JSON.parse(fs.readFileSync(activityPath(name), 'utf8'));
    return data && data.at ? data : null;
  } catch (_) {
    return null;
  }
}

/** Latest of the activity file and the state's updatedAt. */
function lastActivityOf(state) {
  if (!state) return { at: null, source: null };
  const act = state.name ? readLoopActivity(state.name) : null;
  const upd = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
  const actMs = act ? Date.parse(act.at) : NaN;
  if (Number.isFinite(actMs) && (!Number.isFinite(upd) || actMs >= upd)) {
    return { at: new Date(actMs).toISOString(), source: act.source || 'engine' };
  }
  return { at: Number.isFinite(upd) ? new Date(upd).toISOString() : null, source: Number.isFinite(upd) ? 'state' : null };
}

/**
 * Improve round view: the planned phase running now, or the last one that ran.
 * { current, last, number, total } or null when the loop has no planned phases.
 */
function improveRoundOf(state) {
  const phases = (state && state.definition && state.definition.phases) || [];
  const planned = phases.filter((p) => p && p.planned);
  if (!planned.length) return null;
  const cur = phases[state.phaseIndex];
  if (cur && cur.planned) {
    return { current: cur.id, last: cur.id, number: planned.indexOf(cur) + 1, total: planned.length };
  }
  let last = null;
  for (const p of planned) {
    const ps = state.phases && state.phases[p.id];
    if (ps && ps.status && ps.status !== 'pending') last = p;
  }
  if (!last) return { current: null, last: null, number: 0, total: planned.length };
  return { current: null, last: last.id, number: planned.indexOf(last) + 1, total: planned.length };
}

/** Absolute path the plan-next agent must write JSON to. */
function planNextOutputPath(name) {
  return path.join(loopDir(name), PLAN_NEXT_FILENAME);
}

function needsHumanPath(name) {
  return path.join(loopDir(name), NEEDS_HUMAN_FILENAME);
}

function ensureLoopDir(name) {
  const dir = loopDir(name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const body = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function isPidAlive(pid) {
  if (pid == null || !Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function parseLockPayload(raw) {
  const lines = String(raw || '').split(/\n/);
  const pid = Number(String(lines[0] || '').trim());
  const host = String(lines[1] || '').trim() || null;
  const at = String(lines[2] || '').trim() || null;
  let meta = {};
  try {
    const m = JSON.parse(String(lines[3] || '').trim() || '{}');
    if (m && typeof m === 'object' && !Array.isArray(m)) meta = m;
  } catch (_) {
    meta = {};
  }
  const children = Array.isArray(meta.children)
    ? meta.children
        .map((c) => ({
          pid: Number(c && c.pid),
          pgid: Number(c && c.pgid),
          at: c && c.at ? String(c.at) : null,
        }))
        .filter(
          (c) =>
            (Number.isFinite(c.pid) && c.pid > 0) ||
            (Number.isFinite(c.pgid) && c.pgid > 0)
        )
    : [];
  return {
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    host,
    at,
    children,
  };
}

function serializeLockPayload(data) {
  const payload = {
    children: Array.isArray(data.children) ? data.children : [],
  };
  return `${data.pid || ''}\n${data.host || ''}\n${data.at || ''}\n${JSON.stringify(payload)}\n`;
}

function readLockPayloadFile(lp) {
  try {
    if (!fs.existsSync(lp)) return null;
    return parseLockPayload(fs.readFileSync(lp, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeLockPayloadFile(lp, data) {
  try {
    fs.writeFileSync(lp, serializeLockPayload(data));
    return true;
  } catch (_) {
    return false;
  }
}

function reapRecordedRunnerChildren(lock, opts = {}) {
  if (!lock || !Array.isArray(lock.children) || !lock.children.length) return null;
  const isAlive = typeof opts.isPidAlive === 'function' ? opts.isPidAlive : isPidAlive;
  const killPid =
    typeof opts.killPid === 'function'
      ? opts.killPid
      : (pid, signal) => {
          process.kill(pid, signal);
        };
  const killGroup =
    typeof opts.killGroup === 'function'
      ? opts.killGroup
      : (pgid, signal) => runlib.killProcessGroup(pgid, signal);

  const groups = new Set();
  const pids = new Set();
  for (const c of lock.children) {
    const pg = Number(c && c.pgid);
    const pid = Number(c && c.pid);
    if (Number.isFinite(pg) && pg > 0) groups.add(pg);
    else if (Number.isFinite(pid) && pid > 0) pids.add(pid);
  }

  const send = (fn, target, signal) => {
    try {
      fn(target, signal);
      return true;
    } catch (_) {
      return false;
    }
  };

  let groupSignals = 0;
  let pidSignals = 0;
  for (const pgid of groups) {
    if (send(killGroup, pgid, 'SIGTERM')) groupSignals++;
  }
  for (const pid of pids) {
    if (send(killPid, pid, 'SIGTERM')) pidSignals++;
  }

  for (const pgid of groups) {
    if (send(killGroup, pgid, 'SIGKILL')) groupSignals++;
  }
  for (const pid of pids) {
    if (isAlive(pid) && send(killPid, pid, 'SIGKILL')) pidSignals++;
  }

  return {
    groups: [...groups],
    pids: [...pids],
    groupSignals,
    pidSignals,
  };
}

function tryBreakStaleLock(lp, staleOrOpts = LOCK_STALE_MS) {
  const opts =
    staleOrOpts && typeof staleOrOpts === 'object'
      ? staleOrOpts
      : { staleMs: staleOrOpts };
  const staleMs =
    opts.staleMs != null && Number.isFinite(Number(opts.staleMs))
      ? Number(opts.staleMs)
      : LOCK_STALE_MS;
  let st;
  try {
    st = fs.statSync(lp);
  } catch (_) {
    return false;
  }
  let stale = Date.now() - st.mtimeMs > staleMs;
  let parsed = null;
  if (!stale) {
    parsed = readLockPayloadFile(lp);
    if (
      parsed &&
      parsed.host === os.hostname() &&
      Number.isFinite(parsed.pid) &&
      parsed.pid > 0 &&
      !isPidAlive(parsed.pid)
    ) {
      stale = true;
    }
  }
  if (!stale) return false;
  if (!parsed) parsed = readLockPayloadFile(lp);
  if (
    parsed &&
    parsed.host === os.hostname() &&
    Number.isFinite(parsed.pid) &&
    parsed.pid > 0 &&
    !isPidAlive(parsed.pid)
  ) {
    reapRecordedRunnerChildren(parsed, opts);
  }
  try {
    fs.unlinkSync(lp);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Exclusive runner lock. Returns lock path; throws err.code === 'LOOP_BUSY'.
 */
function acquireRunnerLock(name, { staleMs = LOCK_STALE_MS } = {}) {
  ensureLoopDir(name);
  const lp = lockPath(name);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lp, 'wx');
      try {
        const body = serializeLockPayload({
          pid: process.pid,
          host: os.hostname(),
          at: nowIso(),
          children: [],
        });
        fs.writeFileSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      return lp;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (tryBreakStaleLock(lp, staleMs)) continue;
      const busy = new Error(`loop "${safeLoopName(name)}" is already running`);
      busy.code = 'LOOP_BUSY';
      throw busy;
    }
  }
  const busy = new Error(`loop "${safeLoopName(name)}" is already running`);
  busy.code = 'LOOP_BUSY';
  throw busy;
}

function releaseRunnerLock(nameOrPath) {
  const lp =
    nameOrPath && String(nameOrPath).includes(path.sep)
      ? nameOrPath
      : lockPath(nameOrPath);
  try {
    fs.unlinkSync(lp);
  } catch (_) {
    /* ignore */
  }
}

function readLockInfo(name) {
  const lp = lockPath(name);
  try {
    const parsed = readLockPayloadFile(lp);
    if (!parsed) return null;
    const pid = parsed.pid;
    return {
      path: lp,
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      host: parsed.host || null,
      at: parsed.at || null,
      children: parsed.children || [],
      alive: Number.isFinite(pid) && pid > 0 ? isPidAlive(pid) : false,
    };
  } catch (_) {
    return null;
  }
}

function recordLockChildProcess(nameOrPath, child) {
  const lp =
    nameOrPath && String(nameOrPath).includes(path.sep)
      ? nameOrPath
      : lockPath(nameOrPath);
  if (!child || (!child.pid && !child.pgid)) return false;
  const lock = readLockPayloadFile(lp);
  if (!lock) return false;
  if (lock.host !== os.hostname()) return false;
  if (lock.pid !== process.pid) return false;
  const next = {
    pid:
      child.pid != null && Number.isFinite(Number(child.pid)) && Number(child.pid) > 0
        ? Number(child.pid)
        : null,
    pgid:
      child.pgid != null && Number.isFinite(Number(child.pgid)) && Number(child.pgid) > 0
        ? Number(child.pgid)
        : null,
    at: nowIso(),
  };
  if (!next.pid && !next.pgid) return false;
  const key = `${next.pid || '-'}:${next.pgid || '-'}`;
  const existing = new Set(
    (lock.children || []).map((c) => `${Number(c.pid) || '-'}:${Number(c.pgid) || '-'}`)
  );
  if (!existing.has(key)) {
    lock.children = (lock.children || []).concat(next);
  }
  return writeLockPayloadFile(lp, lock);
}

function loadState(name) {
  const p = statePath(name);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return null;
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`invalid loop state at ${p}`);
  }
  return data;
}

function saveState(state) {
  if (!state || !state.name) throw new Error('loop state requires name');
  state.updatedAt = nowIso();
  atomicWriteJson(statePath(state.name), state);
  return state;
}

function listLoopNames() {
  const root = loopsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(statePath(n)))
    .sort();
}

function resolveDefinitionPath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    const err = new Error('loop definition file is required');
    err.code = 'LOOP_DEF';
    throw err;
  }
  const abs = path.resolve(expandUserPath(raw));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    const err = new Error(`loop definition not found: ${abs}`);
    err.code = 'LOOP_DEF';
    throw err;
  }
  return abs;
}

function loadDefinitionFile(filePath) {
  const abs = resolveDefinitionPath(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`invalid JSON in ${abs}: ${err.message}`);
    e.code = 'LOOP_DEF';
    throw e;
  }
  return { path: abs, definition: data };
}

function asNonEmptyString(value, label) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s;
}

function normalizeAllow(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    commit: Boolean(src.commit),
    merge: Boolean(src.merge),
    push: Boolean(src.push),
  };
}

function normalizeBudget(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxRuns =
    src.maxRuns != null && Number.isFinite(Number(src.maxRuns)) && Number(src.maxRuns) > 0
      ? Math.floor(Number(src.maxRuns))
      : null;
  const maxHours =
    src.maxHours != null && Number.isFinite(Number(src.maxHours)) && Number(src.maxHours) > 0
      ? Number(src.maxHours)
      : null;
  const maxPhases =
    src.maxPhases != null && Number.isFinite(Number(src.maxPhases)) && Number(src.maxPhases) > 0
      ? Math.floor(Number(src.maxPhases))
      : null;
  const maxTokens =
    src.maxTokens != null && Number.isFinite(Number(src.maxTokens)) && Number(src.maxTokens) > 0
      ? Math.floor(Number(src.maxTokens))
      : null;
  return { maxRuns, maxHours, maxPhases, maxTokens };
}

function normalizePlannedPhaseGate(raw) {
  if (raw == null || raw === '') return DEFAULT_PLANNED_PHASE_GATE;
  const g = String(raw).trim().toLowerCase();
  if (!PHASE_GATES.has(g)) {
    return { error: 'plannedPhaseGate must be "approve" or "none"' };
  }
  return g;
}

function normalizeEval(raw, phaseLabel) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${phaseLabel}: eval object is required` };
  }
  let command = raw.command;
  if (typeof command === 'string') {
    command = command.trim();
    if (!command) return { ok: false, error: `${phaseLabel}: eval.command is empty` };
  } else if (Array.isArray(command)) {
    if (!command.length || command.some((c) => typeof c !== 'string' || !String(c).trim())) {
      return { ok: false, error: `${phaseLabel}: eval.command array must be non-empty strings` };
    }
    command = command.map((c) => String(c));
  } else {
    return { ok: false, error: `${phaseLabel}: eval.command must be a string or string array` };
  }

  let passRegex = null;
  if (raw.passRegex != null && raw.passRegex !== '') {
    try {
      // Validate compile; store source string.
      // eslint-disable-next-line no-new
      new RegExp(String(raw.passRegex));
      passRegex = String(raw.passRegex);
    } catch (err) {
      return { ok: false, error: `${phaseLabel}: invalid eval.passRegex: ${err.message}` };
    }
  }

  let minOverall = null;
  if (raw.minOverall != null && raw.minOverall !== '') {
    const n = Number(raw.minOverall);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `${phaseLabel}: eval.minOverall must be a number` };
    }
    minOverall = n;
  }

  let minTiers = null;
  if (raw.minTiers != null) {
    if (typeof raw.minTiers !== 'object' || Array.isArray(raw.minTiers)) {
      return { ok: false, error: `${phaseLabel}: eval.minTiers must be an object` };
    }
    minTiers = {};
    for (const [k, v] of Object.entries(raw.minTiers)) {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `${phaseLabel}: eval.minTiers.${k} must be a number` };
      }
      minTiers[k] = n;
    }
    if (!Object.keys(minTiers).length) minTiers = null;
  }

  const noRegress = raw.noRegress === true;

  let targetOverall = null;
  if (raw.targetOverall != null && raw.targetOverall !== '') {
    const n = Number(raw.targetOverall);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `${phaseLabel}: eval.targetOverall must be a number` };
    }
    targetOverall = n;
  }

  let infraRetries = 0;
  if (raw.infraRetries != null && raw.infraRetries !== '') {
    const n = Number(raw.infraRetries);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: `${phaseLabel}: eval.infraRetries must be an integer >= 0` };
    }
    infraRetries = n;
  }

  let infraExitCodes = null;
  if (raw.infraExitCodes != null) {
    if (!Array.isArray(raw.infraExitCodes)) {
      return { ok: false, error: `${phaseLabel}: eval.infraExitCodes must be an array of integers` };
    }
    infraExitCodes = [];
    for (const item of raw.infraExitCodes) {
      const n = Number(item);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, error: `${phaseLabel}: eval.infraExitCodes entries must be integers` };
      }
      infraExitCodes.push(n);
    }
    if (!infraExitCodes.length) infraExitCodes = null;
  }

  let infraPattern = null;
  if (raw.infraPattern != null && raw.infraPattern !== '') {
    try {
      // eslint-disable-next-line no-new
      new RegExp(String(raw.infraPattern), 'i');
      infraPattern = String(raw.infraPattern);
    } catch (err) {
      return { ok: false, error: `${phaseLabel}: invalid eval.infraPattern: ${err.message}` };
    }
  }

  let exitCode = 0;
  if (raw.exitCode != null || raw.exit != null) {
    const n = Number(raw.exitCode != null ? raw.exitCode : raw.exit);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, error: `${phaseLabel}: eval.exitCode must be an integer` };
    }
    exitCode = n;
  }

  const cwd =
    raw.cwd != null && String(raw.cwd).trim() !== '' ? String(raw.cwd).trim() : null;
  const timeoutSec =
    raw.timeoutSec != null && Number.isFinite(Number(raw.timeoutSec)) && Number(raw.timeoutSec) > 0
      ? Math.floor(Number(raw.timeoutSec))
      : 300;

  let coverage = null;
  if (raw.coverage != null) {
    const covNorm = evalCoverage.normalizeCoverage(raw.coverage, phaseLabel);
    if (!covNorm.ok) return covNorm;
    coverage = covNorm.value;
  }

  return {
    ok: true,
    value: {
      command,
      passRegex,
      minOverall,
      minTiers,
      noRegress,
      targetOverall,
      infraRetries,
      infraExitCodes,
      infraPattern,
      coverage,
      exitCode,
      cwd,
      timeoutSec,
    },
  };
}

function normalizeOnPass(raw) {
  if (raw == null || raw === '') return 'none';
  const s = String(raw).trim().toLowerCase();
  if (!ON_PASS_ACTIONS.has(s)) {
    return { error: `onPass must be one of: ${[...ON_PASS_ACTIONS].join(', ')}` };
  }
  return s;
}

function normalizePhase(raw, index, defaults) {
  const label = `phases[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label}: must be an object` };
  }
  const id = asNonEmptyString(raw.id, 'id');
  if (!id) return { ok: false, error: `${label}: id is required` };
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return { ok: false, error: `${label}: id must match [A-Za-z0-9._-]+` };
  }

  let phaseType = 'run';
  if (raw.type != null && String(raw.type).trim() !== '') {
    const t = String(raw.type).trim().toLowerCase();
    if (!PHASE_TYPES.has(t)) {
      return { ok: false, error: `${label}: type must be "run", "plan-next" or "script"` };
    }
    phaseType = t;
  }

  const session =
    asNonEmptyString(raw.session, 'session') ||
    asNonEmptyString(raw.sessionName, 'sessionName') ||
    `loop-${defaults.loopName}-${id}`;

  let engineName = asNonEmptyString(raw.engine, 'engine') || defaults.engine;
  try {
    engineName = config.validateEngine(engineName);
  } catch (err) {
    return { ok: false, error: `${label}: ${err.message}` };
  }

  const prompt = raw.prompt != null ? String(raw.prompt) : null;
  const promptFile =
    raw.promptFile != null && String(raw.promptFile).trim() !== ''
      ? String(raw.promptFile).trim()
      : null;
  if (phaseType === 'run') {
    if ((prompt == null || !String(prompt).trim()) && !promptFile) {
      return { ok: false, error: `${label}: prompt or promptFile is required` };
    }
  }
  if (phaseType === 'script' && ((prompt != null && String(prompt).trim()) || promptFile)) {
    return {
      ok: false,
      error: `${label}: script phases make no AI call; remove prompt/promptFile (the eval command is the step)`,
    };
  }
  if (prompt != null && promptFile && String(prompt).trim()) {
    return { ok: false, error: `${label}: provide prompt or promptFile, not both` };
  }

  let evalNorm;
  if (phaseType === 'plan-next') {
    // plan-next validates $AGENTFLEET_HOME/loops/<name>/plan-next.json instead of
    // a user eval command. Optional eval is accepted for forward-compat but ignored.
    if (raw.eval != null) {
      evalNorm = normalizeEval(raw.eval, label);
      if (!evalNorm.ok) return evalNorm;
    } else {
      evalNorm = {
        ok: true,
        value: {
          command: ['true'],
          passRegex: null,
          minOverall: null,
          minTiers: null,
          noRegress: false,
          targetOverall: null,
          infraRetries: 0,
          infraExitCodes: null,
          infraPattern: null,
          exitCode: 0,
          cwd: null,
          timeoutSec: 300,
        },
      };
    }
  } else {
    evalNorm = normalizeEval(raw.eval, label);
    if (!evalNorm.ok) return evalNorm;
  }

  let maxFixAttempts = phaseType === 'script' ? 0 : DEFAULT_MAX_FIX_ATTEMPTS;
  if (raw.maxFixAttempts != null && phaseType !== 'script') {
    const n = Number(raw.maxFixAttempts);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: `${label}: maxFixAttempts must be an integer >= 0` };
    }
    maxFixAttempts = n;
  }

  const onPassRaw = normalizeOnPass(raw.onPass);
  if (onPassRaw && onPassRaw.error) {
    return { ok: false, error: `${label}: ${onPassRaw.error}` };
  }

  // Full tool grant is opt-in. Omitted force follows the loop default (false
  // unless the definition sets force: true).
  let force = defaults.force === true;
  if (raw.force != null) {
    if (typeof raw.force !== 'boolean') {
      return { ok: false, error: `${label}: force must be a boolean` };
    }
    force = raw.force;
  }
  const mode =
    raw.mode != null && String(raw.mode).trim() !== '' ? String(raw.mode).trim() : null;
  if (mode && mode !== 'ask' && mode !== 'plan') {
    return { ok: false, error: `${label}: mode must be ask or plan when set` };
  }
  if (mode && engineName !== 'cursor') {
    return { ok: false, error: `${label}: --mode is Cursor-only` };
  }

  const timeoutSec =
    raw.timeoutSec != null && Number.isFinite(Number(raw.timeoutSec)) && Number(raw.timeoutSec) > 0
      ? Math.floor(Number(raw.timeoutSec))
      : null;
  const idleTimeoutSec = parseIdleTimeoutSec(raw.idleTimeoutSec, label);
  if (idleTimeoutSec && typeof idleTimeoutSec === 'object') return { ok: false, error: idleTimeoutSec.error };

  let phaseModel = null;
  if (raw.model != null && String(raw.model).trim() !== '') {
    const modelNorm = normalizeModel(raw.model, `${label}.model`);
    if (modelNorm && typeof modelNorm === 'object' && modelNorm.error) {
      return { ok: false, error: modelNorm.error };
    }
    phaseModel = modelNorm;
  }

  let improveModel = null;
  if (raw.improveModel != null && String(raw.improveModel).trim() !== '') {
    if (phaseType !== 'plan-next') {
      return { ok: false, error: `${label}: improveModel is only valid on a plan-next phase` };
    }
    const im = normalizeModel(raw.improveModel, `${label}.improveModel`);
    if (im && typeof im === 'object' && im.error) return { ok: false, error: im.error };
    improveModel = im;
  }

  let targetOverall = null;
  if (phaseType === 'plan-next' && raw.targetOverall != null && raw.targetOverall !== '') {
    const n = Number(raw.targetOverall);
    if (!Number.isFinite(n)) {
      return { ok: false, error: `${label}: targetOverall must be a number` };
    }
    targetOverall = n;
  }

  let gate = null;
  if (raw.gate != null && String(raw.gate).trim() !== '') {
    const g = String(raw.gate).trim().toLowerCase();
    if (!PHASE_GATES.has(g)) {
      return { ok: false, error: `${label}: gate must be "approve" or "none"` };
    }
    gate = g === 'approve' ? 'approve' : null;
  }

  const planned = Boolean(raw.planned) || Boolean(defaults.planned);

  const protNorm = protectedPaths.normalizeProtected(raw.protected, label);
  if (!protNorm.ok) return { ok: false, error: protNorm.error };

  let phaseVerify = null;
  if (raw.verify === false) {
    phaseVerify = false;
  } else if (raw.verify != null) {
    const vn = loopVerify.normalizeVerify(raw.verify, `${label}.verify`);
    if (!vn.ok) return { ok: false, error: vn.error };
    phaseVerify = vn.value;
  }

  return {
    ok: true,
    value: {
      id,
      type: phaseType,
      engine: engineName,
      session,
      prompt: prompt != null && String(prompt).trim() ? String(prompt) : null,
      promptFile,
      eval: evalNorm.value,
      maxFixAttempts,
      onPass: onPassRaw,
      force,
      mode,
      timeoutSec,
      ...(idleTimeoutSec != null ? { idleTimeoutSec } : {}),
      model: phaseModel,
      ...(improveModel ? { improveModel } : {}),
      ...(targetOverall != null ? { targetOverall } : {}),
      gate,
      planned,
      protected: protNorm.value,
      ...(phaseVerify === false ? { verify: false } : phaseVerify ? { verify: phaseVerify } : {}),
    },
  };
}

/**
 * Validate and normalize a loop definition object.
 * @returns {{ ok: true, definition: object, warnings: string[] }|{ ok: false, errors: string[], warnings: string[] }}
 */
function validateDefinition(raw, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['definition must be a JSON object'], warnings };
  }

  const name = asNonEmptyString(raw.name, 'name');
  if (!name) errors.push('name is required');
  let safeName = null;
  if (name) {
    try {
      safeName = safeLoopName(name);
      if (safeName !== slugify(name) && safeName !== name) {
        warnings.push(`name will be stored as "${safeName}"`);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  const project =
    asNonEmptyString(raw.project, 'project') ||
    asNonEmptyString(raw.projectId, 'projectId') ||
    null;

  let defEngine;
  const engineRaw = asNonEmptyString(raw.engine, 'engine');
  let enginesList = null;
  if (raw.engines != null) {
    if (!Array.isArray(raw.engines) || raw.engines.length === 0) {
      errors.push('engines must be a non-empty array of engine names');
    } else {
      enginesList = [];
      for (const item of raw.engines) {
        try {
          const e = config.validateEngine(item);
          if (!enginesList.includes(e)) enginesList.push(e);
        } catch (err) {
          errors.push(`engines: ${err.message}`);
        }
      }
    }
  }
  try {
    // Primary engine precedence (phase.engine overrides per phase):
    //   top-level engine > AGENTFLEET_ENGINE > engines[0] > config defaultEngine > cursor
    if (engineRaw) {
      defEngine = config.validateEngine(engineRaw);
    } else {
      const resolved = engineLib.resolveEngine({ env: opts.env || process.env });
      defEngine =
        resolved.source !== 'env' && enginesList && enginesList.length
          ? enginesList[0]
          : resolved.engine;
    }
  } catch (err) {
    errors.push(err.message);
    defEngine = 'cursor';
  }

  const definitionDir =
    opts.definitionDir || opts.baseDir || null;
  // Relative cwd: explicit cwdBase, else project root for `.agentfleet/loop.json`,
  // else process.cwd() so external definitions can target the shell cwd.
  // promptFile resolves against definitionDir separately.
  const cwdAnchor = opts.cwdBase || process.cwd();
  const wdNorm = normalizeWorkdir(raw.workdir, cwdAnchor);
  if (!wdNorm.ok) errors.push(wdNorm.error);
  const workdir = wdNorm.ok ? wdNorm.value : { mode: 'fresh' };
  const cwdRaw = asNonEmptyString(raw.cwd, 'cwd');
  let cwd;
  if (!cwdRaw && workdir.mode === 'worktree' && workdir.path) {
    cwd = workdir.path;
  } else if (cwdRaw) {
    const expanded = expandUserPath(cwdRaw);
    cwd = path.isAbsolute(expanded)
      ? resolveCwd(expanded)
      : resolveCwd(path.resolve(cwdAnchor, expanded));
    const creatable = workdir.mode === 'worktree' && workdir.path && cwd === resolveCwd(workdir.path);
    if (opts.checkCwd !== false && !creatable && !fs.existsSync(cwd)) {
      errors.push(`cwd does not exist: ${cwd}`);
    }
  } else {
    cwd = resolveCwd(cwdAnchor);
  }

  const allow = normalizeAllow(raw.allow);
  const budget = normalizeBudget(raw.budget);

  let loopForce = false;
  if (raw.force != null) {
    if (typeof raw.force !== 'boolean') errors.push('force must be a boolean');
    else loopForce = raw.force;
  }

  let loopModel = null;
  if (raw.model != null && String(raw.model).trim() !== '') {
    const modelNorm = normalizeModel(raw.model, 'model');
    if (modelNorm && typeof modelNorm === 'object' && modelNorm.error) {
      errors.push(modelNorm.error);
    } else {
      loopModel = modelNorm;
    }
  }

  let improveModel = null;
  if (raw.improveModel != null && String(raw.improveModel).trim() !== '') {
    const im = normalizeModel(raw.improveModel, 'improveModel');
    if (im && typeof im === 'object' && im.error) errors.push(im.error);
    else improveModel = im;
  }

  const loopIdle = parseIdleTimeoutSec(raw.idleTimeoutSec, 'idleTimeoutSec');
  if (loopIdle && typeof loopIdle === 'object') errors.push(loopIdle.error);

  const goal =
    asNonEmptyString(raw.goal, 'goal') ||
    asNonEmptyString(raw.projectGoal, 'projectGoal') ||
    null;
  const acceptance =
    asNonEmptyString(raw.acceptance, 'acceptance') ||
    asNonEmptyString(raw.acceptanceCriteria, 'acceptanceCriteria') ||
    null;

  const plannedGateRaw = normalizePlannedPhaseGate(
    raw.plannedPhaseGate != null ? raw.plannedPhaseGate : raw.plannedPhasesGate
  );
  let plannedPhaseGate = DEFAULT_PLANNED_PHASE_GATE;
  if (plannedGateRaw && plannedGateRaw.error) {
    errors.push(plannedGateRaw.error);
  } else if (typeof plannedGateRaw === 'string') {
    plannedPhaseGate = plannedGateRaw;
  }

  const protNorm = protectedPaths.normalizeProtected(raw.protected, 'definition');
  if (!protNorm.ok) errors.push(protNorm.error);
  const protectedSpec = protNorm.ok ? protNorm.value : null;

  const gateNorm = commitGate.normalizeCommitGate(raw.commitGate);
  if (!gateNorm.ok) errors.push(gateNorm.error);
  const commitGateSpec = gateNorm.ok ? gateNorm.value : null;

  const escNorm = normalizeEscalation(raw.escalation);
  if (escNorm && escNorm.error) errors.push(escNorm.error);
  const escalationSpec = escNorm && escNorm.value ? escNorm.value : null;

  const verifyNorm = loopVerify.normalizeVerify(raw.verify, 'verify');
  if (!verifyNorm.ok) errors.push(verifyNorm.error);
  const verifySpec = verifyNorm.ok ? verifyNorm.value : null;

  let acceptanceEval = null;
  if (raw.acceptanceEval != null) {
    const ae = normalizeEval(raw.acceptanceEval, 'acceptanceEval');
    if (!ae.ok) errors.push(ae.error);
    else acceptanceEval = ae.value;
  }

  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    errors.push('phases must be a non-empty array');
  }

  const phases = [];
  const seenIds = new Set();
  let hasPlanNext = false;
  if (Array.isArray(raw.phases)) {
    for (let i = 0; i < raw.phases.length; i++) {
      const norm = normalizePhase(raw.phases[i], i, {
        loopName: safeName || name || 'loop',
        engine: defEngine,
        force: loopForce,
      });
      if (!norm.ok) {
        errors.push(norm.error);
        continue;
      }
      if (seenIds.has(norm.value.id)) {
        errors.push(`duplicate phase id: ${norm.value.id}`);
        continue;
      }
      seenIds.add(norm.value.id);
      if (norm.value.type === 'plan-next') hasPlanNext = true;

      if (norm.value.promptFile) {
        const pf = resolvePromptFilePath(norm.value.promptFile, {
          definitionDir,
          baseDir: opts.baseDir,
          cwd,
        });
        if (opts.checkPromptFiles !== false && !fs.existsSync(pf)) {
          errors.push(`phases[${i}]: promptFile not found: ${pf}`);
        } else {
          norm.value.promptFile = pf;
        }
      }

      if (norm.value.eval && norm.value.eval.command != null) {
        norm.value.eval.command = resolveEvalCommandPaths(norm.value.eval.command, {
          definitionDir,
          baseDir: opts.baseDir,
        });
      }

      if (norm.value.onPass !== 'none' && !allow[norm.value.onPass]) {
        warnings.push(
          `phases[${i}] onPass=${norm.value.onPass} requires allow.${norm.value.onPass}=true (will skip action)`
        );
      }
      phases.push(norm.value);
    }
  }

  if (hasPlanNext && budget.maxPhases == null) {
    warnings.push(
      'plan-next phases without budget.maxPhases can grow unbounded; set maxPhases to cap planning'
    );
  }
  if (budget.maxPhases != null && phases.length > budget.maxPhases) {
    errors.push(
      `phases length (${phases.length}) exceeds budget.maxPhases (${budget.maxPhases})`
    );
  }

  if (commitGate.activeGate({ commitGate: commitGateSpec })) {
    const gated = (p) => p.onPass === 'commit' || p.onPass === 'merge';
    if (!phases.some(gated)) {
      warnings.push('commitGate has no effect: no phase uses onPass "commit" or "merge"');
    }
  }

  if (errors.length) return { ok: false, errors, warnings };

  const definition = {
    name: safeName,
    displayName: name,
    project,
    cwd,
    workdir,
    engine: defEngine,
    ...(enginesList && enginesList.length ? { engines: enginesList } : {}),
    model: loopModel,
    ...(improveModel ? { improveModel } : {}),
    ...(Number.isInteger(loopIdle) ? { idleTimeoutSec: loopIdle } : {}),
    force: loopForce,
    allow,
    budget,
    goal,
    acceptance,
    plannedPhaseGate,
    acceptanceEval,
    protected: protectedSpec,
    ...(commitGateSpec ? { commitGate: commitGateSpec } : {}),
    ...(escalationSpec ? { escalation: escalationSpec } : {}),
    ...(verifySpec ? { verify: verifySpec } : {}),
    phases,
  };
  const loopSnapshot = require('./loop-snapshot');
  const projectFleetDir = path.join(cwd, '.agentfleet');
  const definitionFleetDir = definitionDir
    ? path.basename(definitionDir) === '.agentfleet'
      ? definitionDir
      : path.join(path.dirname(definitionDir), '.agentfleet')
    : null;
  for (const o of loopSnapshot.outsidePaths(definition)) {
    // Allow project-scoped loop assets under .agentfleet/ (hello-aflt layout).
    if (
      o.path &&
      (loopSnapshot.isInside(o.path, projectFleetDir) ||
        (definitionFleetDir && loopSnapshot.isInside(o.path, definitionFleetDir)))
    ) {
      continue;
    }
    warnings.push(
      `phase ${o.phaseId}: ${o.kind === 'promptFile' ? 'promptFile' : 'check command reads'} ${o.path} outside the project folder ${cwd}; keep loop files in the project (aflt snapshots it into the loop state when the loop starts)`
    );
  }
  return { ok: true, definition, warnings };
}

/**
 * @returns {{ value: object }|{ error: string }|null}
 */
function normalizeEscalation(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'escalation must be a JSON object' };
  }
  let afterFailedRounds = 3;
  if (raw.afterFailedRounds != null) {
    const n = Number(raw.afterFailedRounds);
    if (!Number.isFinite(n) || n < 1) {
      return { error: 'escalation.afterFailedRounds must be a positive number' };
    }
    afterFailedRounds = Math.floor(n);
  }
  const eventRaw =
    raw.event != null && String(raw.event).trim() !== ''
      ? String(raw.event).trim()
      : DEFAULT_ESCALATION_EVENT;
  if (!/^loop\.[a-z0-9_.-]+$/.test(eventRaw)) {
    return { error: `escalation.event must be a loop.* event name, got ${JSON.stringify(eventRaw)}` };
  }
  return { value: { afterFailedRounds, event: eventRaw } };
}

/**
 * Parent folder of a definition under `<project>/.agentfleet/` (in-project loops).
 * @param {string|null|undefined} definitionDir
 * @returns {string|null}
 */
function projectRootFromDefinitionDir(definitionDir) {
  if (!definitionDir) return null;
  if (path.basename(definitionDir) !== '.agentfleet') return null;
  return resolveCwd(path.dirname(definitionDir));
}

function validateFile(filePath, opts = {}) {
  const loaded = loadDefinitionFile(filePath);
  const definitionDir = path.dirname(loaded.path);
  const projectRoot = projectRootFromDefinitionDir(definitionDir);
  const cwdBase =
    opts.cwdBase != null ? opts.cwdBase : projectRoot != null ? projectRoot : process.cwd();
  const result = validateDefinition(loaded.definition, {
    ...opts,
    definitionDir,
    baseDir: opts.baseDir != null ? opts.baseDir : definitionDir,
    cwdBase,
  });
  return { ...result, path: loaded.path };
}

function resolvePhasePrompt(phase) {
  if (phase.prompt != null && String(phase.prompt).trim()) {
    return String(phase.prompt);
  }
  if (phase.promptSnapshot && fs.existsSync(phase.promptSnapshot)) {
    return fs.readFileSync(phase.promptSnapshot, 'utf8');
  }
  if (phase.promptFile) {
    if (!fs.existsSync(phase.promptFile)) {
      throw new Error(
        `phase ${phase.id}: promptFile ${phase.promptFile} no longer exists and this loop has no prompt snapshot (it was started before aflt snapshotted prompts). Restore the file, or re-start the loop from its definition.`
      );
    }
    return fs.readFileSync(phase.promptFile, 'utf8');
  }
  throw new Error(`phase ${phase.id}: missing prompt`);
}

function emptyPhaseState(phase) {
  return {
    id: phase.id,
    status: 'pending',
    attempts: 0,
    sessionId: null,
    sessionTitle: phase.session,
    lastEval: null,
    lastRun: null,
    passedAt: null,
    failedAt: null,
    onPass: null,
    gateApproved: false,
    baseSha: null,
    infraAttempts: 0,
  };
}

function createInitialState(definition, opts = {}) {
  const phases = {};
  for (const p of definition.phases) {
    phases[p.id] = emptyPhaseState(p);
  }
  return {
    version: STATE_VERSION,
    name: definition.name,
    status: 'pending',
    /** When true, the dashboard loop scheduler may pick this loop up. */
    active: Boolean(opts.active),
    definitionPath: opts.definitionPath || null,
    definition,
    phaseIndex: 0,
    phaseId: definition.phases[0] ? definition.phases[0].id : null,
    attempt: 0,
    step: 'run',
    runsUsed: 0,
    startedAt: null,
    /** Active run time (ms) of closed run segments; see activeElapsedMs. */
    activeMs: 0,
    /** Start of the open run segment (runner working), else null. */
    runSegmentStartedAt: null,
    updatedAt: nowIso(),
    completedAt: null,
    stoppedAt: null,
    failedAt: null,
    pausedAt: null,
    stopRequested: false,
    pauseRequested: false,
    lastError: null,
    /** @type {{ phaseId: string, waiting: boolean, at?: string, approvedAt?: string }|null} */
    gate: null,
    phases,
    history: [],
    escalationFailedRounds: 0,
    needsHumanAt: null,
    keptTempRepo: null,
    verifyCheckpoints: {},
  };
}

/**
 * Opt-in heartbeat interval in ms. Default off (0).
 * Env `AFLT_LOOP_HEARTBEAT_SECONDS` overrides `config.json`
 * `loop.heartbeatSeconds` (or `notify.loopHeartbeatSeconds`).
 */
function resolveHeartbeatMs(env = process.env) {
  const envVal = envNonEmpty(env, 'AFLT_LOOP_HEARTBEAT_SECONDS');
  if (envVal != null) {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
    return 0;
  }
  const data = config.load();
  const loopCfg =
    data && data.loop && typeof data.loop === 'object' && !Array.isArray(data.loop)
      ? data.loop
      : {};
  const notifyCfg =
    data && data.notify && typeof data.notify === 'object' && !Array.isArray(data.notify)
      ? data.notify
      : {};
  const sec =
    loopCfg.heartbeatSeconds != null
      ? loopCfg.heartbeatSeconds
      : notifyCfg.loopHeartbeatSeconds != null
        ? notifyCfg.loopHeartbeatSeconds
        : 0;
  const n = Number(sec);
  if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
  return 0;
}

/**
 * Whether the dashboard scheduler should start/resume this loop now.
 * Requires `active`, non-terminal/non-paused/non-waiting status, and no live runner lock.
 */
function isSchedulerCandidate(state, lock = null) {
  if (!state || !state.active) return false;
  if (
    TERMINAL_STATUSES.has(state.status) ||
    state.status === 'paused' ||
    state.status === 'waiting' ||
    state.status === 'needs_human'
  ) {
    return false;
  }
  if (state.stopRequested || state.pauseRequested) return false;
  if (state.gate && state.gate.waiting) return false;
  const info = lock || readLockInfo(state.name);
  if (info && info.alive) return false;
  return state.status === 'pending' || state.status === 'running';
}

function listSchedulerCandidates() {
  const out = [];
  for (const name of listLoopNames()) {
    try {
      const state = loadState(name);
      const lock = readLockInfo(name);
      if (isSchedulerCandidate(state, lock)) {
        out.push({ name, state, lock });
      }
    } catch (_) {
      /* ignore corrupt rows */
    }
  }
  return out;
}

function appendHistory(state, entry) {
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({
    at: nowIso(),
    ...entry,
  });
  if (state.history.length > 500) {
    state.history = state.history.slice(-500);
  }
}

/**
 * End instant for elapsed/budget clocks. Live/running/waiting use Date.now();
 * terminal (and paused) statuses freeze at completedAt / failedAt / stoppedAt / pausedAt.
 */
function elapsedEndMs(state, nowMs = Date.now()) {
  if (!state) return nowMs;
  const status = state.status;
  let endIso = null;
  if (status === 'completed') endIso = state.completedAt;
  else if (status === 'failed') endIso = state.failedAt;
  else if (status === 'stopped') endIso = state.stoppedAt;
  else if (status === 'paused') endIso = state.pausedAt;
  else if (status === 'needs_human') endIso = state.needsHumanAt;
  if (!endIso && TERMINAL_STATUSES.has(status)) {
    endIso =
      state.completedAt || state.failedAt || state.stoppedAt || state.updatedAt || null;
  }
  if (!endIso) return nowMs;
  const t = Date.parse(endIso);
  return Number.isFinite(t) ? t : nowMs;
}

/** History events that open a run segment (the runner starts working). */
const RUN_SEGMENT_START_EVENTS = new Set(['loop.started', 'loop.resumed']);
/** History events that close a run segment (the runner stops working). */
const RUN_SEGMENT_END_EVENTS = new Set([
  'loop.completed',
  'loop.failed',
  'loop.stopped',
  'loop.paused',
  'loop.gate.waiting',
  'loop.needs_human',
  DEFAULT_ESCALATION_EVENT,
]);

/** Wall-clock ms from startedAt to the frozen end (or now). Includes idle gaps. */
function wallElapsedMsOf(state, nowMs = Date.now()) {
  if (!state || !state.startedAt) return 0;
  const t = Date.parse(state.startedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, elapsedEndMs(state, nowMs) - t);
}

/**
 * Active ms reconstructed from history run segments (loop.started/resumed →
 * completed/failed/stopped/paused/gate waiting/needs_human). Used for loop
 * state written before activeMs existed. Returns null when history has no
 * segment start (caller falls back to wall time).
 * @param {{ closedOnly?: boolean }} [opts] closedOnly: ignore a trailing open segment
 */
function historyActiveMs(state, nowMs = Date.now(), opts = {}) {
  const hist = state && Array.isArray(state.history) ? state.history : [];
  const def = (state && state.definition) || {};
  const customEnd = def.escalation && def.escalation.event ? String(def.escalation.event) : null;
  let total = 0;
  let open = null;
  let sawStart = false;
  let lastAt = null;
  for (const h of hist) {
    if (!h || !h.event) continue;
    const at = Date.parse(h.at);
    if (!Number.isFinite(at)) continue;
    if (RUN_SEGMENT_START_EVENTS.has(h.event)) {
      // A start while a segment is still open means the runner died without a
      // closing event: end that segment at its last recorded activity.
      if (open != null && lastAt != null) total += Math.max(0, lastAt - open);
      open = at;
      sawStart = true;
    } else if (RUN_SEGMENT_END_EVENTS.has(h.event) || (customEnd && h.event === customEnd)) {
      if (open != null) total += Math.max(0, at - open);
      else if (!sawStart && state.startedAt) {
        // History was trimmed past the first start: count from startedAt.
        const t = Date.parse(state.startedAt);
        if (Number.isFinite(t) && t <= at) total += at - t;
        sawStart = true;
      }
      open = null;
    }
    lastAt = at;
  }
  if (!sawStart) return null;
  if (open != null && !opts.closedOnly) {
    total += Math.max(0, elapsedEndMs(state, nowMs) - open);
  }
  return total;
}

/**
 * Active run time in ms: the sum of run segments (start/resume → stop,
 * pause, gate wait, failure, completion). Idle gaps between a finished or
 * stopped loop and a later resume are not counted. New state accumulates
 * state.activeMs + the open state.runSegmentStartedAt segment; older state
 * files are reconstructed from history at read time (never rewritten here),
 * falling back to wall time when history has no run events.
 */
function activeElapsedMs(state, nowMs = Date.now()) {
  if (!state) return 0;
  const closed = Number(state.activeMs);
  if (state.activeMs != null && Number.isFinite(closed)) {
    let open = 0;
    const seg = state.runSegmentStartedAt ? Date.parse(state.runSegmentStartedAt) : NaN;
    if (Number.isFinite(seg)) open = Math.max(0, elapsedEndMs(state, nowMs) - seg);
    return Math.max(0, closed) + open;
  }
  const fromHistory = historyActiveMs(state, nowMs);
  if (fromHistory != null) return fromHistory;
  return wallElapsedMsOf(state, nowMs);
}

/** Close the open run segment (if any) into state.activeMs. */
function closeRunSegment(state, endIso = nowIso()) {
  if (!state) return;
  if (state.activeMs == null || !Number.isFinite(Number(state.activeMs))) {
    const prior = historyActiveMs(state, Date.parse(endIso) || Date.now(), { closedOnly: true });
    state.activeMs = prior != null ? prior : 0;
  }
  const seg = state.runSegmentStartedAt ? Date.parse(state.runSegmentStartedAt) : NaN;
  const end = Date.parse(endIso);
  if (Number.isFinite(seg) && Number.isFinite(end)) {
    state.activeMs = Number(state.activeMs) + Math.max(0, end - seg);
  }
  state.runSegmentStartedAt = null;
}

/**
 * Open a run segment when the runner starts or resumes. Legacy state gets
 * activeMs seeded from history; a segment left open by a crashed runner is
 * closed at its last update instead of counting the downtime.
 */
function openRunSegment(state, startIso = nowIso()) {
  if (!state) return;
  if (state.runSegmentStartedAt) {
    closeRunSegment(state, state.updatedAt || startIso);
  } else if (state.activeMs == null || !Number.isFinite(Number(state.activeMs))) {
    const prior = historyActiveMs(state, Date.parse(startIso) || Date.now(), { closedOnly: true });
    state.activeMs = prior != null ? prior : 0;
  }
  state.runSegmentStartedAt = startIso;
}

function hoursElapsed(state, nowMs = Date.now()) {
  return activeElapsedMs(state, nowMs) / (3600 * 1000);
}

function budgetExceeded(state) {
  const budget = (state.definition && state.definition.budget) || {};
  if (budget.maxRuns != null && state.runsUsed >= budget.maxRuns) {
    return `budget maxRuns exceeded (${state.runsUsed}/${budget.maxRuns})`;
  }
  if (budget.maxHours != null && hoursElapsed(state) >= budget.maxHours) {
    return `budget maxHours exceeded (${hoursElapsed(state).toFixed(2)}/${budget.maxHours})`;
  }
  if (budget.maxPhases != null) {
    const n = (state.definition && state.definition.phases && state.definition.phases.length) || 0;
    if (n > budget.maxPhases) {
      return `budget maxPhases exceeded (${n}/${budget.maxPhases})`;
    }
  }
  if (budget.maxTokens != null) {
    if (
      !state.usage ||
      state.usage.totalTokens == null ||
      !Number.isFinite(Number(state.usage.totalTokens))
    ) {
      try {
        refreshLoopUsage(state);
      } catch (_) {
        /* ignore */
      }
    }
    const used =
      state.usage && state.usage.totalTokens != null && Number.isFinite(Number(state.usage.totalTokens))
        ? Math.floor(Number(state.usage.totalTokens))
        : null;
    if (used != null && used >= budget.maxTokens) {
      return `budget maxTokens exceeded (${used}/${budget.maxTokens})`;
    }
  }
  return null;
}

function readRecentStatusNotes(state, opts = {}) {
  const resolved = memory.resolveMemoryRepo(opts.env || process.env);
  if (!resolved || !resolved.path) return [];
  let root;
  try {
    root = fs.realpathSync(resolved.path);
  } catch (_) {
    return [];
  }
  const project =
    (state.definition && state.definition.project) ||
    projectLib.resolveProjectForCreate({
      cwd: state.definition && state.definition.cwd,
    }) ||
    'adhoc';
  const folder = memory.sanitizeFolderName(projectLib.canonicalProjectName(project));
  const notesDir = path.join(root, folder, 'status-notes');
  let names;
  try {
    names = fs.readdirSync(notesDir).filter((n) => n.endsWith('.md') && !n.startsWith('.'));
  } catch (_) {
    return [];
  }
  names.sort();
  const picked = names.slice(-Math.max(1, opts.limit || PLAN_NEXT_NOTES_CAP));
  const out = [];
  for (const name of picked) {
    try {
      const text = fs.readFileSync(path.join(notesDir, name), 'utf8');
      out.push({
        name,
        text: truncateText(memory.redactSensitive(text), 1200),
      });
    } catch (_) {
      /* ignore */
    }
  }
  return out;
}

function formatHistoryForPrompt(state, limit = PLAN_NEXT_HISTORY_CAP) {
  const hist = Array.isArray(state.history) ? state.history : [];
  const slice = hist.slice(-Math.max(1, limit));
  if (!slice.length) return '(no history yet)';
  return slice
    .map((h) => {
      const at = h.at || '';
      const ev = h.event || '';
      const phase = h.phaseId ? ` phase=${h.phaseId}` : '';
      const summary = h.summary ? ` — ${String(h.summary).slice(0, 200)}` : '';
      return `- ${at} ${ev}${phase}${summary}`;
    })
    .join('\n');
}

/**
 * Build the prompt for a plan-next phase. Extra phase.prompt is appended when set.
 */
function buildPlanNextPrompt(state, phase, outputPath, opts = {}) {
  const def = state.definition || {};
  const notes = readRecentStatusNotes(state, opts);
  const notesBlock =
    notes.length === 0
      ? '(no status notes)'
      : notes.map((n) => `### ${n.name}\n${n.text}`).join('\n\n');
  const schema = [
    'Write a single JSON object to the output file (overwrite). Schema:',
    '{',
    '  "done": false,',
    '  "phases": [',
    '    {',
    '      "id": "unique-id",',
    '      "engine": "cursor|copilot|opencode",  // optional; defaults to loop engine',
    '      "session": "optional-session-title",',
    '      "prompt": "...",',
    '      "eval": { "command": ["argv0", "..."], "exitCode": 0 },',
    '      "maxFixAttempts": 3,',
    '      "onPass": "none",',
    '      "force": true,  // optional; default false (no --allow-all-tools). Set true to edit files.',
    '      "gate": "approve" | "none"   // optional; defaults from loop plannedPhaseGate',
    '    }',
    '  ]',
    '}',
    '',
    'When the project goal and acceptance criteria are satisfied and no more',
    'phases are needed, write: { "done": true } (phases may be omitted or []).',
    'Eval commands must use files inside the project folder (no ../ paths or files elsewhere on disk).',
    'Plan from this prompt, the project files, and the loop history above; do not search other folders, other projects, or the aflt install for examples.',
    'Do not switch to plan mode. Do not commit unless the phase prompt requires it.',
  ].join('\n');

  const parts = [
    'You are the plan-next planner for an aflt loop.',
    'Propose the next phase(s) of work as JSON, or signal that the loop is done.',
    '',
    '## Loop',
    def.name || state.name || '',
    '',
    '## Goal',
    def.goal || '(not set)',
    '',
    '## Acceptance criteria',
    def.acceptance || '(not set)',
    '',
    '## Output file (write exactly here)',
    outputPath,
    '',
    '## Loop history (recent)',
    formatHistoryForPrompt(state),
    '',
    '## Recent status notes',
    notesBlock,
    '',
    '## Schema',
    schema,
  ];
  const improveModel = resolveImproveModel(phase, def);
  if (improveModel) {
    parts.push(
      '',
      '## Models',
      `Phases you propose run on model "${improveModel}" unless you set "model" on a phase. Only set one when a phase needs a different model.`
    );
  }
  const lockSummary = evalCoverage.protectedFixturesLockSummary(def);
  if (lockSummary) {
    parts.push(
      '',
      '## Protected eval assets',
      lockSummary,
      'If loop history shows loop.phase.protected_violation, the failure is never fixed by editing fixtures or scripts/eval — improve application/memory code instead.'
    );
  }
  if (phase && phase.prompt && String(phase.prompt).trim()) {
    parts.push('', '## Additional instructions', String(phase.prompt).trim());
  }
  return parts.join('\n');
}

/**
 * Parse and lightly validate plan-next.json contents.
 * @returns {{ ok: true, done: boolean, phases: object[] }|{ ok: false, error: string }}
 */
function parsePlanNextPayload(raw) {
  if (raw == null) return { ok: false, error: 'plan-next file is empty' };
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `invalid JSON: ${err.message}` };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'plan-next root must be a JSON object' };
  }
  const done = Boolean(data.done);
  let phases = [];
  if (data.phases != null) {
    if (!Array.isArray(data.phases)) {
      return { ok: false, error: 'plan-next.phases must be an array when set' };
    }
    phases = data.phases;
  }
  if (!done && phases.length === 0) {
    return {
      ok: false,
      error: 'plan-next must set done:true or include a non-empty phases array',
    };
  }
  return { ok: true, done, phases };
}

function readPlanNextFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `plan-next file missing: ${filePath}` };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return parsePlanNextPayload(raw);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Normalize planned phase objects and insert them before the plan-next sentinel.
 * Applies plannedPhaseGate when gate is unset. Returns error string or null.
 */
function insertPlannedPhases(state, planNextIndex, rawPhases, opts = {}) {
  const definition = state.definition;
  const budget = definition.budget || {};
  const existing = definition.phases || [];
  const planNextPhase = existing[planNextIndex];
  if (!planNextPhase || planNextPhase.type !== 'plan-next') {
    return { ok: false, error: 'insertPlannedPhases: phase at index is not plan-next' };
  }

  const nextCount = existing.length + rawPhases.length;
  if (budget.maxPhases != null && nextCount > budget.maxPhases) {
    return {
      ok: false,
      error: `budget maxPhases exceeded (would be ${nextCount}/${budget.maxPhases})`,
    };
  }

  const seenIds = new Set(existing.map((p) => p.id));
  const normalized = [];
  const defaultGate =
    definition.plannedPhaseGate === 'none' ? null : 'approve';

  for (let i = 0; i < rawPhases.length; i++) {
    const raw = rawPhases[i] && typeof rawPhases[i] === 'object' ? { ...rawPhases[i] } : null;
    if (!raw) {
      return { ok: false, error: `planned phases[${i}]: must be an object` };
    }
    if (raw.gate == null && defaultGate) {
      raw.gate = defaultGate;
    } else if (raw.gate == null && definition.plannedPhaseGate === 'none') {
      // leave unset → no gate
    }
    raw.planned = true;
    // Improve rounds do not inherit the planner's model. They use their own
    // `model`, else plan-next `improveModel`, else definition `improveModel`,
    // else the usual loop model chain (definition.model → env → config).
    const improveModel = resolveImproveModel(planNextPhase, definition);
    if ((raw.model == null || String(raw.model).trim() === '') && improveModel) {
      raw.model = improveModel;
    }
    if (raw.type != null && String(raw.type).trim().toLowerCase() === 'plan-next') {
      return { ok: false, error: `planned phases[${i}]: cannot nest type plan-next` };
    }
    const norm = normalizePhase(raw, existing.length + i, {
      loopName: definition.name,
      engine: definition.engine,
      planned: true,
      force: definition.force === true,
    });
    if (!norm.ok) return { ok: false, error: norm.error };
    if (seenIds.has(norm.value.id)) {
      return { ok: false, error: `duplicate phase id from planner: ${norm.value.id}` };
    }
    seenIds.add(norm.value.id);
    if (norm.value.promptFile) {
      const pf = resolvePromptFilePath(norm.value.promptFile, {
        definitionDir: opts.definitionDir || (state.definitionPath ? path.dirname(state.definitionPath) : null),
        cwd: definition.cwd,
      });
      if (opts.checkPromptFiles !== false && !fs.existsSync(pf)) {
        return { ok: false, error: `planned phase ${norm.value.id}: promptFile not found: ${pf}` };
      }
      norm.value.promptFile = pf;
    }
    if (norm.value.eval && norm.value.eval.command != null) {
      norm.value.eval.command = resolveEvalCommandPaths(norm.value.eval.command, {
        definitionDir:
          opts.definitionDir ||
          (state.definitionPath ? path.dirname(state.definitionPath) : null),
      });
      // A planned check must run files inside the project: a path that climbs
      // out of it sends the agent searching the disk when the file is missing.
      const escaping = require('./loop-snapshot').escapingTokens(norm.value.eval.command, definition.cwd);
      if (escaping.length) {
        return {
          ok: false,
          error: `planned phase ${norm.value.id}: eval command uses ${escaping
            .map((e) => `${e.token} (${e.resolved})`)
            .join(', ')} outside the project folder ${definition.cwd}; use a check script inside the project`,
        };
      }
    }
    normalized.push(norm.value);
  }

  const before = existing.slice(0, planNextIndex);
  const after = existing.slice(planNextIndex + 1);
  definition.phases = [...before, ...normalized, planNextPhase, ...after];

  if (!state.phases || typeof state.phases !== 'object') state.phases = {};
  for (const p of normalized) {
    state.phases[p.id] = emptyPhaseState(p);
  }

  state.phaseIndex = planNextIndex;
  state.phaseId = normalized[0].id;
  state.attempt = 0;
  state.step = 'run';
  state.updatedAt = nowIso();

  return { ok: true, inserted: normalized.map((p) => p.id) };
}

/** Model for planner-inserted phases that set none: plan-next phase, then definition. */
function resolveImproveModel(planNextPhase, definition) {
  if (planNextPhase && planNextPhase.improveModel) return planNextPhase.improveModel;
  if (definition && definition.improveModel) return definition.improveModel;
  return null;
}

function buildPlanNextFixPrompt(phase, outputPath, error, lastEval) {
  const detail = [
    'The previous plan-next output was missing or invalid. Fix it.',
    'Do not switch to plan mode.',
    '',
    `## Output file`,
    outputPath,
    '',
    `## Error`,
    error || '(unknown)',
    '',
  ];
  if (lastEval && (lastEval.stdout || lastEval.stderr)) {
    detail.push(
      '## Previous file contents / notes',
      truncateText([lastEval.stdout, lastEval.stderr].filter(Boolean).join('\n'), FIX_OUTPUT_CAP),
      ''
    );
  }
  if (phase && phase.prompt && String(phase.prompt).trim()) {
    detail.push('## Additional instructions', String(phase.prompt).trim(), '');
  }
  return detail.join('\n');
}

function buildAcceptanceSummary(state) {
  const def = state.definition || {};
  const phases = def.phases || [];
  const lines = [
    `Goal: ${def.goal || '(not set)'}`,
    `Acceptance: ${def.acceptance || '(not set)'}`,
    `Phases: ${phases.length}`,
    '',
    'Phase results:',
  ];
  for (const p of phases) {
    const ps = (state.phases && state.phases[p.id]) || {};
    lines.push(
      `- ${p.id} (${p.type || 'run'}${p.planned ? ', planned' : ''}): ${ps.status || 'pending'}`
    );
  }
  return lines.join('\n');
}

/** Pick up stop requested by `requestStop` / CLI while async steps run. */
function mergeStopRequestedFromDisk(state, name) {
  try {
    const disk = loadState(name);
    if (disk && disk.stopRequested) state.stopRequested = true;
    if (disk && disk.pauseRequested) state.pauseRequested = true;
  } catch (_) {
    /* ignore */
  }
  return Boolean(state.stopRequested);
}

function mergePauseRequestedFromDisk(state, name) {
  try {
    const disk = loadState(name);
    if (disk && disk.pauseRequested) state.pauseRequested = true;
    if (disk && disk.stopRequested) state.stopRequested = true;
  } catch (_) {
    /* ignore */
  }
  return Boolean(state.pauseRequested);
}

async function finishIfStopRequested(state, name, env) {
  mergeStopRequestedFromDisk(state, name);
  if (!state.stopRequested) return null;
  await markLoopStopped(state, 'stop requested', { env });
  return { ok: false, status: 'stopped', state };
}

async function finishIfPauseRequested(state, name, env) {
  mergePauseRequestedFromDisk(state, name);
  if (state.stopRequested) {
    await markLoopStopped(state, 'stop requested', { env });
    return { ok: false, status: 'stopped', state };
  }
  if (!state.pauseRequested) return null;
  await markLoopPaused(state, 'pause requested', { env });
  return { ok: true, status: 'paused', state };
}

function truncateText(text, max = EVAL_OUTPUT_CAP) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max - 14) + '\n…[truncated]';
}

function buildFixPrompt(phase, evalResult) {
  const out = truncateText(
    [evalResult.stdout, evalResult.stderr].filter(Boolean).join('\n'),
    FIX_OUTPUT_CAP
  );
  const coverageHint =
    evalResult.coverageFailure && evalResult.coverageFailure.message
      ? `\nFixture coverage must include every scoring tier (enough probes per tier) before eval assets are protected. ${evalResult.coverageFailure.message}\n`
      : '';
  return [
    'The previous evaluation for this loop phase failed. Fix the issues so the eval passes.',
    coverageHint,
    'Do not switch to plan mode. Do not commit, push, stash, reset, or delete files unless the phase prompt explicitly requires it.',
    'Work only inside the project folder. If the eval command points at a file outside it that is missing, do not search the disk or create files elsewhere; say so in your reply and stop.',
    '',
    `## Phase`,
    phase.id,
    '',
    `## Eval exit code`,
    String(evalResult.code),
    '',
    `## Eval timed out`,
    evalResult.timedOut ? 'yes' : 'no',
    '',
    `## Eval output`,
    out || '(no output)',
    '',
  ].join('\n');
}

/**
 * Parse eval JSON from command output (stdout then trailing JSON in mixed output).
 * @returns {object|null}
 */
function parseEvalJsonFromResult(result) {
  if (!result) return null;
  const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (!text) return null;
  const tryParse = (s) => {
    try {
      const data = JSON.parse(s);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (_) {
      return null;
    }
  };
  const direct = tryParse(text);
  if (direct) return direct;
  const matches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (matches) {
    for (let i = matches.length - 1; i >= 0; i--) {
      const obj = tryParse(matches[i]);
      if (obj && (obj.overall != null || obj.tiers != null || obj.score != null)) return obj;
    }
  }
  return null;
}

/**
 * Last line of project eval/history.jsonl with an overall score (optional live-only).
 */
function readLastProjectEvalOverall(cwd, opts = {}) {
  if (!cwd) return null;
  const file = path.join(cwd, 'eval', 'history.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (!row || typeof row !== 'object') continue;
      if (opts.liveOnly && row.mode != null && String(row.mode).toLowerCase() !== 'live') continue;
      if (row.overall != null && Number.isFinite(Number(row.overall))) {
        return Math.round(Number(row.overall) * 1000) / 1000;
      }
    } catch (_) {
      /* skip bad line */
    }
  }
  return null;
}

function liveOverallScoresFromHistory(cwd) {
  if (!cwd) return [];
  const file = path.join(cwd, 'eval', 'history.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object') continue;
      if (row.mode != null && String(row.mode).toLowerCase() !== 'live') continue;
      if (row.overall != null && Number.isFinite(Number(row.overall))) {
        out.push(Math.round(Number(row.overall) * 1000) / 1000);
      }
    } catch (_) {
      /* skip */
    }
  }
  return out;
}

function baselineOverallForNoRegress(cwd, currentOverall) {
  const live = liveOverallScoresFromHistory(cwd);
  if (!live.length) return null;
  const cur =
    currentOverall != null && Number.isFinite(Number(currentOverall))
      ? Math.round(Number(currentOverall) * 1000) / 1000
      : null;
  if (live.length >= 2 && cur != null && live[live.length - 1] === cur) {
    return live[live.length - 2];
  }
  return live[live.length - 1];
}

function evalContractActive(evalSpec) {
  if (!evalSpec) return false;
  return (
    evalSpec.minOverall != null ||
    (evalSpec.minTiers && Object.keys(evalSpec.minTiers).length) ||
    evalSpec.noRegress === true
  );
}

function evalPassed(evalSpec, result, opts = {}) {
  if (result.timedOut) return false;
  if (result.code !== evalSpec.exitCode) return false;
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (evalContractActive(evalSpec)) {
    const data = parseEvalJsonFromResult(result);
    if (!data) return false;
    if (evalSpec.minOverall != null) {
      if (data.overall == null || !Number.isFinite(Number(data.overall))) return false;
      if (Number(data.overall) < Number(evalSpec.minOverall)) return false;
    }
    if (evalSpec.minTiers && typeof evalSpec.minTiers === 'object') {
      const tiers = data.tiers && typeof data.tiers === 'object' ? data.tiers : null;
      if (!tiers) return false;
      for (const [tier, min] of Object.entries(evalSpec.minTiers)) {
        if (tiers[tier] == null || !Number.isFinite(Number(tiers[tier]))) return false;
        if (Number(tiers[tier]) < Number(min)) return false;
      }
    }
    if (evalSpec.noRegress === true) {
      const current =
        data.overall != null && Number.isFinite(Number(data.overall)) ? Number(data.overall) : null;
      if (current == null) return false;
      const baseline =
        opts.baselineOverall != null
          ? Number(opts.baselineOverall)
          : baselineOverallForNoRegress(opts.cwd, current);
      if (baseline != null && current < baseline) return false;
    }
    if (evalSpec.passRegex) {
      try {
        if (!new RegExp(evalSpec.passRegex).test(combined)) return false;
      } catch (_) {
        return false;
      }
    }
    return true;
  }
  if (evalSpec.passRegex) {
    const re = new RegExp(evalSpec.passRegex);
    if (!re.test(combined)) return false;
  }
  return true;
}

function isInfraEvalFailure(result, evalSpec) {
  if (!result) return false;
  if (result.timedOut) return true;
  if (evalSpec && Array.isArray(evalSpec.infraExitCodes) && evalSpec.infraExitCodes.includes(result.code)) {
    return true;
  }
  if (evalSpec && evalSpec.infraPattern) {
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    try {
      if (new RegExp(evalSpec.infraPattern, 'i').test(text)) return true;
    } catch (_) {
      /* ignore */
    }
  }
  if (result.timedOut === false && result.code === 124) return true;
  return false;
}

function capturePhaseBaseSha(cwd) {
  return protectedPaths.headSha(cwd);
}

function resolvePlanNextTarget(phase) {
  if (!phase) return null;
  if (phase.targetOverall != null && Number.isFinite(Number(phase.targetOverall))) {
    return Number(phase.targetOverall);
  }
  if (phase.eval && phase.eval.targetOverall != null && Number.isFinite(Number(phase.eval.targetOverall))) {
    return Number(phase.eval.targetOverall);
  }
  return null;
}

/**
 * Run eval command. `command` is argv data (string → sh -c with one data arg).
 */
async function runEval(evalSpec, opts = {}) {
  const cwd = evalSpec.cwd
    ? path.resolve(opts.baseCwd || process.cwd(), expandUserPath(evalSpec.cwd))
    : opts.baseCwd || process.cwd();
  const timeoutMs = (evalSpec.timeoutSec || 300) * 1000;
  const command = resolveEvalCommandPaths(evalSpec.command, {
    definitionDir: opts.definitionDir || opts.baseDir || null,
  });
  let bin;
  let argv;
  if (Array.isArray(command)) {
    bin = command[0];
    argv = command.slice(1);
  } else {
    bin = '/bin/sh';
    argv = ['-c', String(command)];
  }
  const result = await runlib.spawnCaptured(bin, argv, {
    cwd,
    timeoutMs,
    env: opts.env || process.env,
    detached: false,
    forwardSignals: true,
  });
  return {
    code: result.timedOut ? 124 : result.code == null ? 1 : result.code,
    timedOut: Boolean(result.timedOut),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: Array.isArray(evalSpec.command) ? evalSpec.command : ['/bin/sh', '-c', evalSpec.command],
    cwd,
  };
}

async function createEngineChatId(engineName, { cwd, title } = {}) {
  if (engineName === 'copilot') return copilot.newSessionId();
  if (engineName === 'opencode') return opencode.createSession({ cwd, title });
  return cursor.createChat();
}

/**
 * Load a registry session by exact id when this run already bound one.
 * Fresh / new runs pass null and must create a new session (never reuse a
 * completed/failed peer by title across attempts).
 */
function loadBoundSession(existingSessionId) {
  if (!existingSessionId) return null;
  try {
    return registry.findExact(String(existingSessionId));
  } catch (_) {
    return null;
  }
}

/**
 * Ensure a stable loop-root registry session (role=master) so phase sessions
 * nest under it in History.
 *
 * Reuses `opts.existingSessionId` (state.loopRootSessionId) within a run /
 * resume. On a fresh run with no bound id, always creates a new root — never
 * reuses an old completed/failed `loop-<name>` by title.
 */
async function ensureLoopRootSession(definition, opts = {}) {
  const title = `loop-${definition.name}`;
  let session = loadBoundSession(opts.existingSessionId);
  if (session) {
    // Best-effort: fill parent/role if an older root was created without them.
    const patch = {};
    if (!session.role) patch.role = 'master';
    if (!session.tags || !session.tags.includes('loop-root')) {
      const tags = Array.isArray(session.tags) ? session.tags.slice() : [];
      if (!tags.includes('loop')) tags.push('loop');
      if (!tags.includes(definition.name)) tags.push(definition.name);
      if (!tags.includes('loop-root')) tags.push('loop-root');
      patch.tags = tags;
    }
    if (Object.keys(patch).length) {
      try {
        session = registry.update(session.id, patch) || session;
      } catch (_) {
        /* ignore */
      }
    }
    return session;
  }

  const cwd = definition.cwd;
  const engineName = definition.engine || 'cursor';
  const chatId = await createEngineChatId(engineName, { cwd, title });
  const entry = {
    title,
    chatId,
    cwd,
    branch: gitBranch(cwd),
    model: resolvePhaseModel(null, definition, opts.env) || null,
    prompt: null,
    tags: ['loop', definition.name, 'loop-root'],
    status: 'active',
    engine: engineName,
    role: 'master',
    parent: null,
  };
  if (definition.project) {
    entry.project = projectLib.canonicalProjectName(definition.project);
  } else {
    entry.project = projectLib.resolveProjectForCreate({
      cwd,
      cache: opts.projectCache || projectLib.createLookupCache(),
    });
  }
  return registry.add(entry);
}

/**
 * Ensure a registry session exists for the phase session title.
 * New phase sessions are workers parented to the loop root.
 *
 * Reuses `opts.existingSessionId` (phaseState.sessionId) within the same run
 * (including plan-next loops and mid-run resume). When unbound (fresh run),
 * always creates a new session — never reuses a completed/failed peer by title.
 */
async function ensureSession(phase, definition, opts = {}) {
  let session = loadBoundSession(opts.existingSessionId);
  if (session) {
    if ((session.engine || 'cursor') !== phase.engine) {
      throw new Error(
        `session "${phase.session}" is engine=${session.engine || 'cursor'}, phase wants ${phase.engine}`
      );
    }
    // Do not rewrite historical parent/role from tests or re-runs unless missing
    // and a loop root is available (opt-in fill for newly linked loops only).
    if ((!session.parent || !session.role) && opts.loopRoot && opts.loopRoot.id) {
      const patch = {};
      if (!session.parent) patch.parent = opts.loopRoot.id;
      if (!session.role) patch.role = 'worker';
      if (Object.keys(patch).length) {
        try {
          session = registry.update(session.id, patch) || session;
        } catch (_) {
          /* ignore */
        }
      }
    }
    const boundModel = resolvePhaseModel(phase, definition, opts.env);
    if (boundModel && session.model !== boundModel) {
      try {
        session = registry.update(session.id, { model: boundModel }) || session;
      } catch (_) {
        session = { ...session, model: boundModel };
      }
    }
    return session;
  }

  const cwd = definition.cwd;
  const chatId = await createEngineChatId(phase.engine, {
    cwd,
    title: phase.session,
  });
  const loopRoot = opts.loopRoot || null;
  const entry = {
    title: phase.session,
    chatId,
    cwd,
    branch: gitBranch(cwd),
    model: resolvePhaseModel(phase, definition, opts.env) || null,
    prompt: null,
    tags: ['loop', definition.name, 'loop-phase'],
    status: 'active',
    engine: phase.engine,
    role: 'worker',
    parent: loopRoot && loopRoot.id ? loopRoot.id : null,
  };
  if (definition.project) {
    entry.project = projectLib.canonicalProjectName(definition.project);
  } else {
    entry.project = projectLib.resolveProjectForCreate({
      cwd,
      cache: opts.projectCache || projectLib.createLookupCache(),
    });
  }
  return registry.add(entry);
}

/**
 * Files outside the worker cwd that a phase must write. Only plan-next writes
 * into the loop state dir (plan-next.json).
 */
function loopPhaseWriteGrants(phase, definition) {
  if (!phase || phase.type !== 'plan-next' || !definition || !definition.name) {
    return { addDirs: [], allowWritePaths: [] };
  }
  return {
    addDirs: [loopDir(definition.name)],
    allowWritePaths: [planNextOutputPath(definition.name)],
  };
}

/** Set when the Copilot account default model was unavailable this process. */
let copilotDefaultModelUnavailable = null;

/**
 * Headless one-shot for a loop phase (create/resume via registry + engine print).
 */
async function runSessionPrompt(session, prompt, phase, opts = {}) {
  const engineName = session.engine || phase.engine || 'cursor';
  const force = phase.force === true;
  const mode = phase.mode || null;
  const timeoutSec = phase.timeoutSec || opts.timeoutSec || 0;
  const idleTimeoutSec = resolveIdleTimeoutSec(phase, opts.definition, opts.env || process.env);
  const loopName = opts.definition && opts.definition.name ? opts.definition.name : null;
  let lastActivityWrite = 0;
  const onActivity = (ms, source) => {
    if (!loopName || ms - lastActivityWrite < 15000) return;
    lastActivityWrite = ms;
    recordLoopActivity(loopName, { at: ms, source, phaseId: phase.id || null });
  };
  let model =
    resolvePhaseModel(phase, opts.definition, opts.env) ||
    (session && session.model) ||
    null;
  // A previous phase in this process found the Copilot account default
  // unavailable: start on the fallback instead of failing again.
  if (!model && engineName === 'copilot' && copilotDefaultModelUnavailable) {
    model = copilotDefaultModelUnavailable.fallback;
    registry.bestEffortUpdate(session.id, { model });
  }
  let sessionForEngine = model ? { ...session, model } : session;
  // Capture usage when possible. Cursor/OpenCode/Copilot request json
  // internally; the run log stores extracted text (same as aflt run).
  // Cursor uses stream-json so every event (thinking, tool calls + results,
  // replies) is kept for the making-of record (runs/<id>/engine/).
  const captureJson =
    engineName === 'cursor' || engineName === 'opencode' || engineName === 'copilot';
  const outputFormat = engineName === 'cursor' ? 'stream-json' : captureJson ? 'json' : 'text';
  ensureFleetWorkspaceDirs(sessionForEngine);
  const grants = loopPhaseWriteGrants(phase, opts.definition);
  for (const dir of grants.addDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (_) {
      /* ignore */
    }
  }

  let bin;
  let argvRun;
  if (engineName === 'cursor') {
    bin = cursor.resolveCursorBin();
    argvRun = cursor.buildPrintArgs(sessionForEngine, {
      prompt,
      mode,
      force,
      outputFormat,
      trust: true,
    });
  } else if (engineName === 'copilot') {
    bin = copilot.resolveCopilotBin();
    argvRun = copilot.buildPrintArgs(sessionForEngine, {
      prompt,
      force,
      outputFormat,
      silent: true,
      ...grants,
    });
  } else if (engineName === 'opencode') {
    bin = opencode.resolveOpencodeBin();
    argvRun = opencode.buildPrintArgs(sessionForEngine, {
      prompt,
      force,
      outputFormat,
    });
  } else {
    throw new Error(`unsupported engine: ${engineName}`);
  }

  const outPath = runlib.newRunLogPath(session.id, engineName);
  runlib.writeRunLogHeader(outPath, {
    argv: [bin, ...argvRun],
    cwd: session.cwd,
    kind: 'headless',
    prompt,
  });

  const runId = crypto.randomUUID();
  const runStartedAt = nowIso();
  registry.bestEffortUpdate(session.id, {
    lastOutput: outPath,
    lastPrompt: prompt,
    runHost: os.hostname(),
    runStartedAt,
    runId,
    stopRequested: false,
    runPid: null,
    runPgid: null,
    lastUsed: runStartedAt,
  });

  const spawnOpts = {
    cwd: session.cwd,
    timeoutMs: timeoutSec ? timeoutSec * 1000 : 0,
    idleTimeoutMs: idleTimeoutSec > 0 ? idleTimeoutSec * 1000 : 0,
    idleCheckMs: opts.idleCheckMs || 0,
    activityProbe: idleTimeoutSec > 0 && session.cwd ? () => newestMtimeMs(session.cwd) : null,
    onActivity,
    env: opts.env || process.env,
    detached: true,
    forwardSignals: true,
    logPath: captureJson ? null : outPath,
    onSpawn: ({ pid, pgid }) => {
      registry.bestEffortUpdate(session.id, {
        runPid: pid,
        runPgid: pgid,
        runHost: os.hostname(),
        runStartedAt,
        runId,
        lastOutput: outPath,
      });
      if (loopName) {
        recordLockChildProcess(loopName, { pid, pgid });
      }
    },
  };
  const spawnOrMissing = async (args) => {
    try {
      return await runlib.spawnCaptured(bin, args, spawnOpts);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
      // Missing CLI: surface as a failed run so the loop can classify it.
      return { code: 127, stdout: '', stderr: `spawn ${bin} ENOENT: ${err.message || ''}`, timedOut: false };
    }
  };
  if (loopName) recordLoopActivity(loopName, { source: 'start', phaseId: phase.id || null });
  let result = await spawnOrMissing(argvRun);
  if (result && result.idleTimedOut) {
    const mins = Math.round((idleTimeoutSec / 60) * 10) / 10;
    const note = `aflt loop: ${phase.id || 'phase'}: no engine output or file change for ${mins} min (idleTimeoutSec ${idleTimeoutSec}); stopped the engine and its child processes`;
    result.stderr = `${result.stderr || ''}\n${note}\n`;
    try {
      process.stderr.write(note + '\n');
    } catch (_) {
      /* ignore */
    }
  }

  // Copilot with no pinned model uses the account default, which may not be
  // available to this account. Retry once on the fallback (default auto).
  if (engineName === 'copilot' && !model && !result.timedOut && result.code !== 0) {
    const unavailable = copilot.unavailableModelFromOutput(
      `${result.stdout || ''}\n${result.stderr || ''}`
    );
    const fallback = copilot.fallbackModel(opts.env || process.env);
    if (unavailable && fallback && unavailable !== fallback) {
      copilotDefaultModelUnavailable = { model: unavailable, fallback };
      try {
        process.stderr.write(
          `aflt loop: Copilot model "${unavailable}" is not available; retrying ${phase.id || 'phase'} with --model ${fallback} (pin one with COPILOT_MODEL or config defaultModel)\n`
        );
      } catch (_) {
        /* ignore */
      }
      model = fallback;
      sessionForEngine = { ...session, model };
      argvRun = copilot.buildPrintArgs(sessionForEngine, {
        prompt,
        force,
        outputFormat,
        silent: true,
        ...grants,
      });
      registry.bestEffortUpdate(session.id, { model });
      result = await spawnOrMissing(argvRun);
      result.modelFallback = { from: unavailable, to: fallback };
    }
  }

  // Raw engine output (before JSON parsing) for non-retryable error detection.
  const engineErrorText = `${result.stderr || ''}\n${result.stdout || ''}`.slice(-20000);

  // Best-effort usage capture for loop phases (does not change phase success).
  let loopDisplayStdout = result.stdout || '';
  let loopUsage = null;
  try {
    const usageLib = require('./usage');
    if (engineName === 'cursor' && captureJson) {
      const parsed = cursor.parseCursorPrintOutput(result.stdout || '', {
        format: outputFormat,
        model: model || null,
      });
      loopDisplayStdout = parsed.result != null ? parsed.result : loopDisplayStdout;
      loopUsage = parsed.usage;
    } else if (engineName === 'opencode' && captureJson) {
      const parsed = opencode.parseOpenCodeJsonOutput(result.stdout || '', {
        model: model || null,
      });
      loopDisplayStdout = parsed.result != null ? parsed.result : loopDisplayStdout;
      loopUsage = parsed.usage;
    } else if (engineName === 'copilot') {
      const parsed = copilot.parseCopilotJsonOutput(result.stdout || '', {
        model: model || null,
      });
      if (parsed.assistantText) loopDisplayStdout = parsed.assistantText;
      else if (parsed.usage && parsed.result) loopDisplayStdout = parsed.result;
      loopUsage = parsed.usage && parsed.usage.accuracy === 'reported' ? parsed.usage : loopUsage;
      const fromEvents = copilot.usageFromSessionEvents(sessionForEngine, {
        since: runStartedAt,
        env: opts.env,
        model: model || null,
      });
      loopUsage = usageLib.preferRicherUsage(loopUsage, fromEvents);
    }
    if (!loopUsage) {
      loopUsage = usageLib.estimateUsageFromText({
        prompt,
        reply: loopDisplayStdout,
        cli: engineName,
        model: model || null,
      });
    }
    if (captureJson) {
      runlib.writeRunLog(outPath, {
        argv: [bin, ...argvRun],
        cwd: session.cwd,
        stdout: loopDisplayStdout,
        stderr: result.stderr || '',
        code: result.timedOut ? 124 : result.code,
        signal: result.interruptedBy || result.signal || null,
        timedOut: result.timedOut,
        kind: 'headless',
        prompt,
        usage: loopUsage,
      });
    }
    try {
      const turnsLib = require('./turns');
      turnsLib.appendTurn(
        {
          sessionId: session.id,
          chatId: session.chatId || null,
          engine: engineName,
          source: 'headless-run',
          at: runStartedAt,
          prompt,
          reply: loopDisplayStdout,
          promptSource: 'loop-prompt',
          replySource: 'loop-stdout',
          engineEventId: `loop:${session.id}:${runId}`,
          usage: loopUsage || undefined,
        },
        // Avoid turn.captured notify/Doc Bot enqueue from loop phases — those
        // payloads lack loop.* fields and can keep the event loop pending.
        { skipEmit: true }
      );
    } catch (_) {
      /* ignore */
    }
    // Making-of: archive the engine's native record and write calls.jsonl.
    if (opts.recordMakingOf !== false) {
      require('./making-of').recordPhase({
        sessionId: session.id,
        chatId: sessionForEngine.chatId || session.chatId || null,
        engine: engineName,
        stdout: result.stdout || '',
        runStartedAt,
        phase: phase.id || null,
        env: opts.env || process.env,
      });
    }
    result.stdout = loopDisplayStdout;
    result.usage = loopUsage;
  } catch (_) {
    /* ignore usage capture */
  }

  const lastExit = result.timedOut
    ? 124
    : result.interruptedBy
      ? runlib.signalExitCode(result.interruptedBy)
      : result.code == null
        ? 1
        : result.code;

  registry.bestEffortUpdate(session.id, {
    lastRunAt: nowIso(),
    lastExit,
    lastOutput: outPath,
    lastPrompt: prompt,
    runPid: null,
    runPgid: null,
    runId,
    runStartedAt,
    lastUsed: nowIso(),
  });

  return {
    code: lastExit,
    timedOut: Boolean(result.timedOut),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    engineErrorText,
    outPath,
    runId,
    interruptedBy: result.interruptedBy || null,
  };
}

function noteStamp(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at instanceof Date ? at : new Date(at));
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}${value('minute')}${value('second')}`;
}

/**
 * Append loop transition + optional status note. No-op without memoryRepo.
 */
function recordMemoryTransition(state, entry, opts = {}) {
  const resolved = memory.resolveMemoryRepo(opts.env || process.env);
  if (!resolved || !resolved.path) {
    return { skipped: true, reason: 'no-memory-repo' };
  }
  let root;
  try {
    root = fs.realpathSync(resolved.path);
  } catch (_) {
    return { skipped: true, reason: 'memory-repo-missing' };
  }

  const project =
    (state.definition && state.definition.project) ||
    projectLib.resolveProjectForCreate({
      cwd: state.definition && state.definition.cwd,
    }) ||
    'adhoc';
  const folder = memory.sanitizeFolderName(projectLib.canonicalProjectName(project));
  const projectDir = path.join(root, folder);
  const afltDir = path.join(projectDir, memory.GENERATED_DIR);
  const notesDir = path.join(projectDir, 'status-notes');
  fs.mkdirSync(afltDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(notesDir, { recursive: true, mode: 0o700 });

  const event = {
    at: entry.at || nowIso(),
    loop: state.name,
    event: entry.event,
    phaseId: entry.phaseId || null,
    attempt: entry.attempt != null ? entry.attempt : null,
    summary: memory.redactSensitive(String(entry.summary || '')),
    status: state.status,
  };
  const timelinePath = path.join(afltDir, 'loop-timeline.jsonl');
  fs.appendFileSync(timelinePath, JSON.stringify(event) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });

  let notePath = null;
  if (entry.writeNote) {
    const slug = String(entry.noteSlug || entry.event || 'event')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    const filename = `${noteStamp(event.at)}-loop-${slug}.md`;
    const body = memory.redactSensitive(
      [
        `# Loop ${state.name}: ${entry.event}`,
        '',
        `At: ${event.at}`,
        `Project: ${folder}`,
        `Phase: ${event.phaseId || '—'}`,
        `Attempt: ${event.attempt != null ? event.attempt : '—'}`,
        `Loop status: ${state.status}`,
        '',
        event.summary || '_No summary._',
        '',
      ].join('\n')
    );
    notePath = path.join(notesDir, filename);
    fs.writeFileSync(notePath, body, { encoding: 'utf8', mode: 0o600 });
  }

  return {
    skipped: false,
    timelinePath,
    notePath: notePath
      ? path.relative(root, notePath).split(path.sep).join('/')
      : null,
    project: folder,
  };
}

function buildLoopNotifyPayload(event, state, opts = {}) {
  const def = state.definition || {};
  const cwdRaw = def.cwd != null ? String(def.cwd) : null;
  const phaseId = opts.phaseId != null ? opts.phaseId : state.phaseId;
  const payload = {
    event: String(event),
    sessionId: opts.sessionId != null ? String(opts.sessionId) : null,
    title: state.name,
    project: def.project || null,
    engine: opts.engine || def.engine || null,
    cwd: cwdRaw ? memory.redactSensitive(cwdRaw) : null,
    exitStatus: opts.exitStatus != null ? opts.exitStatus : null,
    timestamp: opts.timestamp || nowIso(),
    summary: notify.summarize(opts.summary != null ? opts.summary : ''),
    loop: state.name,
    phaseId: phaseId != null ? String(phaseId) : null,
    attempt: opts.attempt != null ? opts.attempt : state.attempt,
  };
  if (opts.errorKind) {
    payload.errorKind = String(opts.errorKind);
    payload.nonRetryable = opts.nonRetryable !== false;
  }
  if (opts.fromEngine) payload.fromEngine = String(opts.fromEngine);
  if (Array.isArray(opts.protectedViolation) && opts.protectedViolation.length) {
    payload.protectedViolation = opts.protectedViolation.map(String);
  }
  if (opts.bundle && typeof opts.bundle === 'object' && !Array.isArray(opts.bundle)) {
    for (const [k, v] of Object.entries(opts.bundle)) {
      if (v == null) continue;
      if (k === 'lastError' && typeof v === 'string') {
        payload[k] = notify.summarize(v, 2000);
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        payload[k] = v;
      } else if (Array.isArray(v)) {
        payload[k] = v.map(String);
      }
    }
  }
  return payload;
}

async function emitLoopNotify(event, state, opts = {}) {
  try {
    const cfg = opts.config || notify.resolveNotifyConfig(opts.env || process.env);
    if (!cfg.enabled) return { skipped: true };
    const payload = buildLoopNotifyPayload(event, state, opts);
    const queued = notify.enqueue(cfg, payload, {
      timeoutMs: opts.timeoutMs,
      unref: opts.unref === undefined ? false : opts.unref,
    });
    await notify.settleNotify(queued);
    return { ...queued, event, payload };
  } catch (err) {
    return {
      skipped: true,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * onPass commit/merge under an active commitGate. Returns the usual onPass
 * result plus gate: { mode, warnings[], trailers, refused }. A refused result
 * is ok:false with refused:true (enforce only); the caller fails the phase.
 */
function runGatedOnPass(action, gate, definition, phase, opts = {}) {
  const env = opts.env || process.env;
  const cwd = definition.cwd;
  const phaseState = opts.phaseState || {};
  const warnings = [];
  const result = {
    ok: true,
    action,
    skipped: false,
    gate: { mode: gate.mode, warnings, trailers: null, refused: false },
  };
  const refuse = (error) => {
    result.ok = false;
    result.error = error;
    result.gate.refused = true;
    return result;
  };

  const missing = commitGate.missingTiers(gate, phaseState.verification);
  if (missing.length) {
    const msg = `commit gate: required tier(s) not recorded ok: ${missing.join(', ')}`;
    warnings.push(msg);
    if (gate.mode === 'enforce') return refuse(`${msg}; ${action} refused`);
  }

  const trailers = commitGate.buildTrailers(gate, {
    loop: definition.name,
    phaseId: phase.id,
    attempt: opts.attempt != null ? opts.attempt : 0,
    engine: opts.engine || phase.engine || definition.engine,
    model: phase.model || definition.model || null,
    verification: phaseState.verification,
  });
  const run = (args, timeout) =>
    spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, timeout });

  if (action === 'commit') {
    const add = run(['add', '-A'], 60_000);
    if (add.status !== 0) {
      result.ok = false;
      result.error = (add.stderr || add.stdout || 'git add failed').trim();
      return result;
    }
    const subject = `aflt loop ${definition.name} phase ${phase.id} passed`;
    const commit = run(['commit', '-m', subject, '-m', trailers], 60_000);
    const out = `${commit.stdout || ''}\n${commit.stderr || ''}`;
    if (commit.status !== 0 && !/nothing to commit/i.test(out)) {
      result.ok = false;
      result.error = out.trim() || 'git commit failed';
      return result;
    }
    if (commit.status === 0) result.gate.trailers = trailers;
  } else {
    const before = commitGate.headSha(cwd, env);
    const merge = run(['merge', '--no-edit'], 120_000);
    if (merge.status !== 0) {
      result.ok = false;
      result.error = (merge.stderr || merge.stdout || 'git merge failed').trim();
      return result;
    }
    const after = commitGate.headSha(cwd, env);
    if (after && after !== before && commitGate.isMergeCommit(cwd, env)) {
      const amended = commitGate.amendTrailers(cwd, trailers, env);
      if (amended.ok) result.gate.trailers = trailers;
      else warnings.push(`commit gate: could not add trailers to merge commit: ${amended.error}`);
    }
  }

  const dirty = commitGate.dirtyPaths(cwd, env);
  if (dirty && dirty.length) {
    const msg = `commit gate: ${commitGate.describeDirty(dirty)}`;
    warnings.push(msg);
    if (gate.mode === 'enforce') return refuse(`${msg}; ${action} was made but phase is refused`);
  }
  return result;
}

function runOnPassAction(action, definition, phase, opts = {}) {
  if (!action || action === 'none') {
    return { ok: true, skipped: true, action: 'none' };
  }
  const allow = definition.allow || {};
  if (!allow[action]) {
    return {
      ok: true,
      skipped: true,
      action,
      reason: `allow.${action} is false`,
    };
  }
  const gate = commitGate.activeGate(definition);
  if (gate && (action === 'commit' || action === 'merge')) {
    return runGatedOnPass(action, gate, definition, phase, opts);
  }
  const cwd = definition.cwd;
  const msg = `aflt loop ${definition.name} phase ${phase.id} passed`;
  if (action === 'commit') {
    const add = spawnSync('git', ['-C', cwd, 'add', '-A'], {
      encoding: 'utf8',
      env: opts.env || process.env,
      timeout: 60_000,
    });
    if (add.status !== 0) {
      return {
        ok: false,
        action,
        error: (add.stderr || add.stdout || 'git add failed').trim(),
      };
    }
    const commit = spawnSync('git', ['-C', cwd, 'commit', '-m', msg], {
      encoding: 'utf8',
      env: opts.env || process.env,
      timeout: 60_000,
    });
    // exit 1 with "nothing to commit" is fine
    const out = `${commit.stdout || ''}\n${commit.stderr || ''}`;
    if (commit.status !== 0 && !/nothing to commit/i.test(out)) {
      return { ok: false, action, error: out.trim() || 'git commit failed' };
    }
    return { ok: true, action, skipped: false };
  }
  if (action === 'push') {
    const push = spawnSync('git', ['-C', cwd, 'push'], {
      encoding: 'utf8',
      env: opts.env || process.env,
      timeout: 120_000,
    });
    if (push.status !== 0) {
      return {
        ok: false,
        action,
        error: (push.stderr || push.stdout || 'git push failed').trim(),
      };
    }
    return { ok: true, action, skipped: false };
  }
  if (action === 'merge') {
    // Conservative: only merge when allow.merge; caller must be on a feature branch.
    const merge = spawnSync('git', ['-C', cwd, 'merge', '--no-edit'], {
      encoding: 'utf8',
      env: opts.env || process.env,
      timeout: 120_000,
    });
    if (merge.status !== 0) {
      return {
        ok: false,
        action,
        error: (merge.stderr || merge.stdout || 'git merge failed').trim(),
      };
    }
    return { ok: true, action, skipped: false };
  }
  return { ok: false, action, error: `unknown onPass action: ${action}` };
}

function markLoopFailed(state, reason, opts = {}) {
  state.status = 'failed';
  state.active = false;
  state.failedAt = nowIso();
  closeRunSegment(state, state.failedAt);
  state.pauseRequested = false;
  state.stopRequested = false;
  if (state.gate) state.gate = { ...state.gate, waiting: false };
  state.lastError = reason;
  appendHistory(state, {
    event: 'loop.failed',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: reason,
    ...(opts.errorKind ? { errorKind: opts.errorKind, nonRetryable: opts.nonRetryable !== false } : {}),
    ...(opts.protectedViolation ? { protectedViolation: opts.protectedViolation } : {}),
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.failed',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: reason,
      writeNote: true,
      noteSlug: 'failed',
    },
    opts
  );
  return emitLoopNotify(notify.EVENTS.LOOP_FAILED, state, {
    summary: reason,
    exitStatus: 1,
    ...opts,
  });
}

function definitionHasPlanNext(definition) {
  return Boolean(
    definition &&
      Array.isArray(definition.phases) &&
      definition.phases.some((p) => p && p.type === 'plan-next')
  );
}

function tailLines(text, maxLines = 40) {
  const lines = String(text == null ? '' : text)
    .split(/\r?\n/)
    .filter((l) => l.length || text === '\n');
  if (lines.length <= maxLines) return lines.join('\n').trim();
  return lines.slice(-maxLines).join('\n').trim();
}

function gitDiffStat(cwd, baseSha) {
  if (!cwd || !baseSha) return null;
  try {
    const r = spawnSync('git', ['-C', cwd, 'diff', '--stat', String(baseSha)], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const out = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

function resolveFailureTier(phaseState) {
  if (!phaseState || !Array.isArray(phaseState.verification) || !phaseState.verification.length) {
    return null;
  }
  const last = phaseState.verification[phaseState.verification.length - 1];
  return last && last.tier != null ? String(last.tier) : null;
}

/**
 * @param {object} state
 * @param {object} ctx
 * @returns {object}
 */
function buildNeedsHumanBundle(state, ctx = {}) {
  const name = state.name;
  const phaseId = ctx.phaseId != null ? String(ctx.phaseId) : state.phaseId;
  const phaseState = phaseId && state.phases ? state.phases[phaseId] : null;
  const def = state.definition || {};
  const cwd = def.cwd || null;
  const baseSha = (phaseState && phaseState.baseSha) || state.baseSha || null;
  const lastEval = phaseState && phaseState.lastEval;
  const lastRun = phaseState && phaseState.lastRun;
  let lastOutput = '';
  if (lastEval && (lastEval.stdout || lastEval.stderr)) {
    lastOutput = [lastEval.stdout, lastEval.stderr].filter(Boolean).join('\n');
  } else if (lastRun && (lastRun.stdout || lastRun.stderr)) {
    lastOutput = [lastRun.stdout, lastRun.stderr].filter(Boolean).join('\n');
  }
  if (ctx.lastOutput != null) lastOutput = String(ctx.lastOutput);
  const engine =
    ctx.engine != null
      ? String(ctx.engine)
      : (phaseState && phaseState.engine) || def.engine || null;
  let model = ctx.model != null ? ctx.model : null;
  if (!model) {
    try {
      const phases = def.phases || [];
      const idx = phases.findIndex((p) => p && p.id === phaseId);
      model = resolvePhaseModel(phases[idx] || null, def, ctx.env || process.env);
    } catch (_) {
      model = null;
    }
  }
  return {
    loop: name,
    phaseId,
    tier: ctx.tier != null ? ctx.tier : resolveFailureTier(phaseState),
    attempt: ctx.attempt != null ? ctx.attempt : state.attempt,
    engine,
    model: model || null,
    errorKind: ctx.errorKind != null ? String(ctx.errorKind) : phaseState && phaseState.errorKind,
    lastError: tailLines(lastOutput, 40),
    diffStat: gitDiffStat(cwd, baseSha),
    logPath: statePath(name),
    keptTempRepo: state.keptTempRepo || null,
    failedRounds: state.escalationFailedRounds || 0,
    nextStep: {
      resume: `aflt loop resume ${name}`,
      stop: `aflt loop stop ${name}`,
    },
  };
}

function recordPlanRoundFailure(state, phase) {
  if (!phase || !phase.planned) return;
  state.escalationFailedRounds = (state.escalationFailedRounds || 0) + 1;
}

function resetPlanRoundFailures(state, definition) {
  if (!definitionHasPlanNext(definition)) return;
  state.escalationFailedRounds = 0;
}

function escalationConfigured(definition) {
  return Boolean(definition && definition.escalation && typeof definition.escalation === 'object');
}

function shouldEscalateToHuman(state, ctx = {}) {
  const def = state.definition;
  if (!escalationConfigured(def)) return false;
  const esc = def.escalation;
  const immediate =
    ctx.exhaustedFixes ||
    ctx.nonRetryable ||
    ctx.commitGateRefused ||
    (Array.isArray(ctx.protectedViolation) && ctx.protectedViolation.length);
  if (immediate) return true;
  const limit =
    esc.afterFailedRounds != null && Number.isFinite(Number(esc.afterFailedRounds))
      ? Math.floor(Number(esc.afterFailedRounds))
      : 3;
  return (
    definitionHasPlanNext(def) &&
    (state.escalationFailedRounds || 0) >= limit
  );
}

function prepareResumeFromNeedsHuman(state) {
  if (!state || state.status !== 'needs_human') return;
  const phaseId = state.phaseId;
  const ps = phaseId && state.phases ? state.phases[phaseId] : null;
  if (ps && ps.status === 'failed') {
    ps.status = 'pending';
    ps.failedAt = null;
  }
  state.attempt = 0;
  if (state.step === 'eval' || state.step === 'fix') state.step = 'run';
  state.needsHumanAt = null;
  state.active = true;
  state.stopRequested = false;
  state.pauseRequested = false;
}

async function markLoopNeedsHuman(state, reason, ctx = {}, opts = {}) {
  const def = state.definition || {};
  const eventName =
    (def.escalation && def.escalation.event) || DEFAULT_ESCALATION_EVENT;
  const bundle = buildNeedsHumanBundle(state, { ...ctx, env: opts.env });
  state.status = 'needs_human';
  state.active = false;
  state.needsHumanAt = nowIso();
  closeRunSegment(state, state.needsHumanAt);
  state.pauseRequested = false;
  state.stopRequested = false;
  if (state.gate) state.gate = { ...state.gate, waiting: false };
  state.lastError = reason;
  state.lastNeedsHumanBundle = bundle;
  appendHistory(state, {
    event: eventName,
    phaseId: bundle.phaseId,
    attempt: bundle.attempt,
    summary: reason,
    failedRounds: bundle.failedRounds,
    ...(ctx.errorKind ? { errorKind: ctx.errorKind, nonRetryable: ctx.nonRetryable !== false } : {}),
    ...(Array.isArray(ctx.protectedViolation) ? { protectedViolation: ctx.protectedViolation } : {}),
  });
  saveState(state);
  try {
    atomicWriteJson(needsHumanPath(state.name), bundle);
  } catch (err) {
    process.stderr.write(
      `WARNING: loop ${state.name}: could not write needs-human.json: ${err.message}\n`
    );
  }
  recordMemoryTransition(
    state,
    {
      event: eventName,
      phaseId: bundle.phaseId,
      attempt: bundle.attempt,
      summary: reason,
      writeNote: true,
      noteSlug: 'needs-human',
    },
    opts
  );
  const notifyOpts = {
    ...opts,
    phaseId: bundle.phaseId,
    attempt: bundle.attempt,
    engine: bundle.engine,
    summary: reason,
    exitStatus: 1,
    bundle,
    errorKind: bundle.errorKind,
    ...(ctx.protectedViolation ? { protectedViolation: ctx.protectedViolation } : {}),
  };
  await emitLoopNotify(eventName, state, notifyOpts);
  await emitLoopNotify(notify.EVENTS.LOOP_GATE_WAITING, state, {
    ...notifyOpts,
    summary: reason,
  });
  return { ok: false, status: 'needs_human', state, error: reason, bundle };
}

async function finishLoopAfterPhaseFailure(state, reason, ctx, opts = {}) {
  const phase = ctx.phase || null;
  recordPlanRoundFailure(state, phase);
  saveState(state);
  if (shouldEscalateToHuman(state, ctx)) {
    return markLoopNeedsHuman(state, reason, ctx, opts);
  }
  await markLoopFailed(state, reason, opts);
  return { ok: false, status: 'failed', state, error: reason };
}

function markLoopStopped(state, reason, opts = {}) {
  state.status = 'stopped';
  state.active = false;
  state.stoppedAt = nowIso();
  closeRunSegment(state, state.stoppedAt);
  state.stopRequested = false;
  state.pauseRequested = false;
  if (state.gate) state.gate = { ...state.gate, waiting: false };
  state.lastError = reason || 'stopped';
  appendHistory(state, {
    event: 'loop.stopped',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: reason || 'stopped',
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.stopped',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: reason || 'stopped',
      writeNote: false,
    },
    opts
  );
  return emitLoopNotify(notify.EVENTS.LOOP_STOPPED, state, {
    summary: reason || 'stopped',
    exitStatus: null,
    ...opts,
  });
}

function markLoopPaused(state, reason, opts = {}) {
  state.status = 'paused';
  state.pausedAt = nowIso();
  closeRunSegment(state, state.pausedAt);
  state.pauseRequested = false;
  state.lastError = reason || 'paused';
  appendHistory(state, {
    event: 'loop.paused',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: reason || 'paused',
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.paused',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: reason || 'paused',
      writeNote: false,
    },
    opts
  );
  return { ok: true, status: 'paused', state };
}

function markLoopCompleted(state, opts = {}) {
  state.status = 'completed';
  state.active = false;
  state.completedAt = nowIso();
  closeRunSegment(state, state.completedAt);
  state.pauseRequested = false;
  state.stopRequested = false;
  state.lastError = null;
  const summary =
    opts.summary != null && String(opts.summary).trim()
      ? String(opts.summary).trim()
      : 'all phases passed';
  appendHistory(state, {
    event: 'loop.completed',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary,
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.completed',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary,
      writeNote: true,
      noteSlug: opts.noteSlug || 'completed',
    },
    opts
  );
  return emitLoopNotify(notify.EVENTS.LOOP_COMPLETED, state, {
    summary,
    exitStatus: 0,
    ...opts,
  });
}

/**
 * Dry-run plan for a validated definition.
 */
function planDryRun(definition, definitionPath, opts = {}) {
  const env = opts.env || process.env;
  const phases = definition.phases.map((p) => {
    const force = p.force === true;
    const model = resolvePhaseModel(p, definition, env);
    return {
      id: p.id,
      type: p.type || 'run',
      engine: p.type === 'script' ? null : p.engine,
      session: p.type === 'script' ? null : p.session,
      maxFixAttempts: p.maxFixAttempts,
      onPass: p.onPass,
      force,
      permission: p.type === 'script' ? 'no-agent' : force ? 'force' : 'restricted',
      model: model || null,
      gate: p.gate || null,
      planned: Boolean(p.planned),
      protected: protectedPaths.effectivePatterns(definition, p),
      eval:
        p.type === 'plan-next'
          ? { kind: 'plan-next-file' }
          : {
              command: p.eval.command,
              exitCode: p.eval.exitCode,
              passRegex: p.eval.passRegex,
            },
      promptPreview: p.prompt
        ? promptExcerpt(p.prompt, 200)
        : p.promptFile
          ? `(file) ${p.promptFile}`
          : p.type === 'plan-next'
            ? '(auto plan-next prompt)'
            : p.type === 'script'
              ? '(script step: no AI call)'
              : null,
    };
  });
  return {
    ok: true,
    dryRun: true,
    name: definition.name,
    definitionPath: definitionPath || null,
    cwd: definition.cwd,
    workdirMode: (definition.workdir && definition.workdir.mode) || 'fresh',
    project: definition.project,
    engine: definition.engine,
    ...(definition.engines && definition.engines.length ? { engines: definition.engines } : {}),
    model: definition.model || null,
    resolvedModel: resolvePhaseModel(null, definition, env),
    permissions: permissionSummary(definition.phases),
    allow: definition.allow,
    budget: definition.budget,
    goal: definition.goal || null,
    acceptance: definition.acceptance || null,
    plannedPhaseGate: definition.plannedPhaseGate || DEFAULT_PLANNED_PHASE_GATE,
    phases,
  };
}

/** Readable problem when the engine's CLI is not installed, else null. */
function engineBinaryProblem(engineName, env = process.env) {
  const { which } = require('./util');
  if (engineName === 'cursor') {
    const info = cursor.describeCursorBin(env);
    if (!info.bin) {
      const ignored = info.ignoredAgent ? ` (ignored ${info.ignoredAgent}; not Cursor)` : '';
      return `engine cursor: cursor-agent not on PATH${ignored}. Install the Cursor CLI, set AGENTFLEET_CURSOR_BIN, or pick another engine (AGENTFLEET_ENGINE=copilot). See aflt doctor.`;
    }
  } else if (engineName === 'copilot') {
    if (!(env.AGENTFLEET_COPILOT_BIN || which('copilot', env))) {
      return 'engine copilot: copilot not on PATH. Install GitHub Copilot CLI (npm install -g @github/copilot) or set AGENTFLEET_COPILOT_BIN. See aflt doctor.';
    }
  } else if (engineName === 'opencode') {
    if (!(env.AGENTFLEET_OPENCODE_BIN || which('opencode', env))) {
      return 'engine opencode: opencode not on PATH. Install OpenCode or set AGENTFLEET_OPENCODE_BIN. See aflt doctor.';
    }
  }
  return null;
}

/**
 * Engine CLIs a live run needs that are not installed. Returns readable
 * problems (empty when every phase engine resolves). With a failover list
 * (`definition.engines`), a missing CLI is only a problem when no listed engine
 * is installed, because phases fail over to the next installed engine.
 */
function engineBinaryProblems(definition, env = process.env) {
  const engines = new Set(
    (definition.phases || []).map((p) => (p && p.engine) || definition.engine || 'cursor')
  );
  const failover = Array.isArray(definition.engines) ? definition.engines : [];
  for (const e of failover) engines.add(e);
  const problems = [];
  for (const engineName of engines) {
    const problem = engineBinaryProblem(engineName, env);
    if (problem) problems.push(problem);
  }
  if (failover.length && failover.some((e) => !engineBinaryProblem(e, env))) {
    return [];
  }
  return problems;
}

const FAILOVER_ERROR_KINDS = new Set([
  'cli_missing',
  'auth_required',
  'usage_limit',
  'rate_limit',
  'model_unavailable',
]);

/** Engine a phase is currently running on (after any failover). */
function phaseEffectiveEngine(phase, phaseState) {
  return (phaseState && phaseState.engine) || phase.engine;
}

/**
 * The phase as it runs now: after a failover the engine and session title are
 * swapped (sessions are engine-bound) and phase-level model is dropped, since
 * model names are engine-specific.
 */
function effectivePhase(phase, phaseState) {
  const engine = phaseEffectiveEngine(phase, phaseState);
  if (engine === phase.engine) return phase;
  return { ...phase, engine, session: `${phase.session}-${engine}`, model: null };
}

/**
 * Next installed engine from `definition.engines` that this phase has not tried.
 * Returns null when failover is not configured or no engine remains.
 */
function nextFailoverEngine(definition, phase, phaseState, isInstalled) {
  const list = Array.isArray(definition.engines) ? definition.engines : [];
  if (!list.length) return null;
  const tried = new Set([phase.engine, ...((phaseState && phaseState.triedEngines) || [])]);
  tried.add(phaseEffectiveEngine(phase, phaseState));
  return list.find((e) => !tried.has(e) && isInstalled(e)) || null;
}

/** Switch a phase to `toEngine` (fresh engine-bound session) and record it. */
async function applyEngineFailover(state, basePhase, phaseState, toEngine, info = {}) {
  const env = info.env;
  const from = phaseEffectiveEngine(basePhase, phaseState);
  const kind = info.kind || null;
  phaseState.triedEngines = Array.from(
    new Set([...(phaseState.triedEngines || []), basePhase.engine, from])
  );
  phaseState.failoverEngine = toEngine;
  phaseState.engine = toEngine;
  phaseState.sessionId = null;
  phaseState.sessionTitle = `${basePhase.session}-${toEngine}`;
  const detail = info.line ? `: ${info.line}` : '';
  const summary = `phase ${basePhase.id}: ${from} ${kind || 'error'}${detail}; failing over to ${toEngine}`;
  phaseState.failovers = [
    ...(phaseState.failovers || []),
    { at: nowIso(), from, to: toEngine, kind, line: info.line || null },
  ];
  appendHistory(state, {
    event: 'loop.engine.failover',
    phaseId: basePhase.id,
    attempt: state.attempt,
    summary,
    fromEngine: from,
    engine: toEngine,
    ...(kind ? { errorKind: kind } : {}),
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.engine.failover',
      phaseId: basePhase.id,
      attempt: state.attempt,
      summary,
      writeNote: false,
    },
    { env }
  );
  await emitLoopNotify(notify.EVENTS.LOOP_ENGINE_FAILOVER, state, {
    phaseId: basePhase.id,
    attempt: state.attempt,
    summary,
    engine: toEngine,
    fromEngine: from,
    ...(kind ? { errorKind: kind } : {}),
    env,
  });
}

/**
 * Core runner. Holds the runner lock for the duration.
 */
async function runLoop(definition, opts = {}) {
  const name = definition.name;
  const dryRun = Boolean(opts.dryRun);
  const env = opts.env || process.env;
  if (opts.forceTools) {
    for (const phase of definition.phases || []) phase.force = true;
    definition.force = true;
  }
  if (dryRun) {
    const plan = planDryRun(definition, opts.definitionPath, { env });
    const gate = applyWorkdirGate(definition, { ...opts, dryRun: true, env }, null);
    if (gate.skipped) return plan;
    if (!gate.ok) {
      return {
        ...plan,
        ok: false,
        errors: gate.errors,
        error: gate.error,
        warnings: gate.warnings,
        workdir: gate.workdir,
      };
    }
    // Warn (do not fail) when a phase engine CLI is missing; a live run refuses.
    const missingBins = gate.skipped ? [] : engineBinaryProblems(definition, env);
    warnStderr(missingBins);
    const dryWarnings = [].concat(gate.warnings || [], missingBins);
    return {
      ...plan,
      warnings: dryWarnings.length ? dryWarnings : undefined,
      workdir: gate.workdir,
    };
  }

  let existingForGate = null;
  if (!opts.fresh) {
    try {
      existingForGate = loadState(name);
    } catch (_) {
      existingForGate = null;
    }
  }
  const gate = applyWorkdirGate(definition, { ...opts, dryRun: false, env }, existingForGate);
  if (gate.ok && !gate.skipped) {
    const missing = engineBinaryProblems(definition, env);
    if (missing.length) {
      warnStderr(missing);
      return {
        ok: false,
        status: 'refused',
        errors: missing,
        error: missing.join('; '),
        cwd: definition.cwd,
        permissions: permissionSummary(definition.phases),
        workdir: gate.workdir,
      };
    }
  }
  if (!gate.ok) {
    return {
      ok: false,
      status: 'refused',
      errors: gate.errors,
      error: gate.error,
      warnings: gate.warnings,
      cwd: definition.cwd,
      permissions: permissionSummary(definition.phases),
      workdir: gate.workdir,
    };
  }

  let lock = null;
  try {
    lock = acquireRunnerLock(name);
  } catch (err) {
    if (err && err.code === 'LOOP_BUSY') throw err;
    throw err;
  }

  const runPromptFn = typeof opts.runPrompt === 'function' ? opts.runPrompt : runSessionPrompt;
  const runEvalFn = typeof opts.runEval === 'function' ? opts.runEval : runEval;
  const ensureSessionFn =
    typeof opts.ensureSession === 'function' ? opts.ensureSession : ensureSession;
  const engineInstalledFn =
    typeof opts.engineInstalled === 'function'
      ? opts.engineInstalled
      : (engineName) => !engineBinaryProblem(engineName, env);
  // When tests inject ensureSession (no real engine), synthesize a loop root
  // without calling create-chat. Production uses ensureLoopRootSession.
  const ensureLoopRootFn =
    typeof opts.ensureLoopRootSession === 'function'
      ? opts.ensureLoopRootSession
      : typeof opts.ensureSession === 'function'
        ? async (definition) => ({
            id: `loop-root-${definition.name}`,
            title: `loop-${definition.name}`,
            engine: definition.engine || 'cursor',
            role: 'master',
            cwd: definition.cwd,
            status: 'active',
          })
        : ensureLoopRootSession;

  try {
    ensureLoopDir(name);
    if (opts.definitionPath) {
      try {
        atomicWriteJson(definitionSnapshotPath(name), definition);
      } catch (_) {
        /* ignore */
      }
    }

    let state = loadState(name);
    const resuming = Boolean(opts.resume) || (state && state.status === 'running');
    if (!state || opts.fresh) {
      state = createInitialState(definition, { definitionPath: opts.definitionPath });
    } else {
      // Keep definition from the new file when explicitly re-running; resume keeps stored def.
      if (!opts.resume && opts.definitionPath) {
        state.definition = definition;
        state.definitionPath = opts.definitionPath;
        // Ensure phase map covers new phases
        for (const p of definition.phases) {
          if (!state.phases[p.id]) state.phases[p.id] = emptyPhaseState(p);
        }
      }
    }

    // Copy prompt files and outside check scripts into the loop state dir so
    // resume never depends on files outside the project or the space.
    try {
      const snap = require('./loop-snapshot');
      const targets = [state.definition];
      if (definition && definition !== state.definition) targets.push(definition);
      for (const d of targets) {
        const r = snap.snapshotLoopFiles(d, loopDir(name));
        for (const w of r.warnings) {
          try {
            process.stderr.write(`WARNING: ${w}\n`);
          } catch (_) {
            /* ignore */
          }
        }
      }
      saveState(state);
      atomicWriteJson(definitionSnapshotPath(name), state.definition);
    } catch (_) {
      /* best-effort; prompts still resolve from promptFile */
    }

    const definitionDir =
      opts.definitionDir ||
      (opts.definitionPath
        ? path.dirname(opts.definitionPath)
        : state.definitionPath
          ? path.dirname(state.definitionPath)
          : null);

    let loopRoot = null;
    try {
      loopRoot = await ensureLoopRootFn(state.definition || definition, {
        env,
        existingSessionId: state.loopRootSessionId || null,
      });
      if (loopRoot && loopRoot.id) {
        state.loopRootSessionId = loopRoot.id;
        state.loopRootSessionTitle = loopRoot.title || `loop-${name}`;
        saveState(state);
      }
    } catch (_) {
      /* best-effort; phases can still run without a root */
    }

    if (state.status === 'completed' && !opts.fresh && !opts.forceRerun) {
      return { ok: true, status: 'completed', state, message: 'loop already completed' };
    }

    if (state.stopRequested && (state.status === 'running' || state.status === 'paused')) {
      await markLoopStopped(state, 'stop requested before resume', { env });
      return { ok: false, status: 'stopped', state };
    }

    if (state.pauseRequested && state.status !== 'paused') {
      await markLoopPaused(state, 'pause requested before resume', { env });
      return { ok: true, status: 'paused', state };
    }

    const starting = state.status !== 'running' || !state.startedAt;
    state.status = 'running';
    state.stopRequested = false;
    state.pauseRequested = false;
    state.lastError = null;
    if (starting || !state.startedAt) state.startedAt = state.startedAt || nowIso();
    openRunSegment(state);
    if (starting || !state.baseSha) {
      state.baseSha = protectedPaths.headSha(state.definition.cwd);
    }
    appendHistory(state, {
      event: starting && !resuming ? 'loop.started' : 'loop.resumed',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: starting && !resuming ? 'loop started' : 'loop resumed',
    });
    saveState(state);

    if (starting && !resuming) {
      recordMemoryTransition(
        state,
        {
          event: 'loop.started',
          phaseId: state.phaseId,
          attempt: 0,
          summary: 'loop started',
          writeNote: false,
        },
        { env }
      );
      await emitLoopNotify(notify.EVENTS.LOOP_STARTED, state, {
        summary: 'loop started',
        env,
      });
    }

    const heartbeatMs =
      opts.heartbeatMs != null ? Number(opts.heartbeatMs) : resolveHeartbeatMs(env);
    let heartbeatTimer = null;
    if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
      const tick = () => {
        emitLoopNotify(notify.EVENTS.LOOP_HEARTBEAT, state, {
          summary: `heartbeat phase=${state.phaseId || '-'} attempt=${state.attempt} step=${state.step}`,
          env,
          unref: true,
        }).catch(() => {});
      };
      heartbeatTimer = setInterval(tick, heartbeatMs);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    }

    try {
    // Re-read phases each iteration — plan-next may replace the array.
    while (state.phaseIndex < state.definition.phases.length) {
      const phases = state.definition.phases;
      const stoppedEarly = await finishIfStopRequested(state, name, env);
      if (stoppedEarly) return stoppedEarly;
      const pausedEarly = await finishIfPauseRequested(state, name, env);
      if (pausedEarly) return pausedEarly;

      const budgetErr = budgetExceeded(state);
      if (budgetErr) {
        await markLoopFailed(state, budgetErr, { env });
        return { ok: false, status: 'failed', state, error: budgetErr };
      }

      const basePhase = phases[state.phaseIndex];
      state.phaseId = basePhase.id;
      const phaseState = state.phases[basePhase.id] || emptyPhaseState(basePhase);
      state.phases[basePhase.id] = phaseState;
      // After an infrastructure failover the phase runs on another engine.
      const phase = effectivePhase(basePhase, phaseState);

      if (phaseState.status === 'passed') {
        state.phaseIndex += 1;
        state.attempt = 0;
        state.step = 'run';
        saveState(state);
        continue;
      }

      if (phaseState.status !== 'running') {
        phaseState.status = 'running';
        const deferBaseSha = phase.gate === 'approve' && !phaseState.gateApproved;
        if (!deferBaseSha) {
          phaseState.baseSha = capturePhaseBaseSha(state.definition.cwd);
        }
        appendHistory(state, {
          event: 'loop.phase.started',
          phaseId: phase.id,
          attempt: state.attempt,
          summary: `phase ${phase.id} started`,
        });
        saveState(state);
        recordMemoryTransition(
          state,
          {
            event: 'loop.phase.started',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: `phase ${phase.id} started`,
            writeNote: false,
          },
          { env }
        );
        await emitLoopNotify(notify.EVENTS.LOOP_PHASE_STARTED, state, {
          phaseId: phase.id,
          attempt: state.attempt,
          summary: `phase ${phase.id} started`,
          engine: phase.engine,
          env,
        });
      }

      // --- approval gate (before run/fix/eval for this phase) ---
      if (phase.gate === 'approve' && !phaseState.gateApproved) {
        try {
          const disk = loadState(name);
          if (
            disk &&
            disk.phases &&
            disk.phases[phase.id] &&
            disk.phases[phase.id].gateApproved
          ) {
            phaseState.gateApproved = true;
            if (disk.gate) state.gate = disk.gate;
          }
        } catch (_) {
          /* ignore */
        }
      }
      if (phase.gate === 'approve' && !phaseState.gateApproved) {
        const stoppedAtGate = await finishIfStopRequested(state, name, env);
        if (stoppedAtGate) return stoppedAtGate;
        const pausedAtGate = await finishIfPauseRequested(state, name, env);
        if (pausedAtGate) return pausedAtGate;

        state.status = 'waiting';
        state.step = 'gate';
        state.gate = {
          phaseId: phase.id,
          waiting: true,
          at: nowIso(),
        };
        // Waiting for a human is not run time.
        closeRunSegment(state, state.gate.at);
        let gateCost = null;
        try {
          gateCost = costSoFar(state);
        } catch (_) {
          gateCost = null;
        }
        if (gateCost) state.gate.costSoFar = gateCost;
        const gateSummary =
          `waiting for approval before phase ${phase.id}` +
          (gateCost ? `; cost so far: ${gateCost.text}` : '');
        state.active = true;
        appendHistory(state, {
          event: 'loop.gate.waiting',
          phaseId: phase.id,
          attempt: state.attempt,
          summary: gateSummary,
        });
        saveState(state);
        recordMemoryTransition(
          state,
          {
            event: 'loop.gate.waiting',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: `waiting for approval before phase ${phase.id}`,
            writeNote: false,
          },
          { env }
        );
        await emitLoopNotify(notify.EVENTS.LOOP_GATE_WAITING, state, {
          phaseId: phase.id,
          attempt: state.attempt,
          summary: gateSummary,
          engine: phase.engine,
          env,
          bundle: gateCost
            ? {
                costSoFar: gateCost.text,
                costKnown: gateCost.costKnown,
                credits: gateCost.credits,
                usd: gateCost.usd,
                activeHours: gateCost.activeHours,
                totalTokens: gateCost.totalTokens,
                runsUsed: gateCost.runsUsed,
              }
            : null,
        });
        return { ok: true, status: 'waiting', state, gate: state.gate };
      }

      if (phaseState.gateApproved && !phaseState.baseSha) {
        phaseState.baseSha = capturePhaseBaseSha(state.definition.cwd);
        saveState(state);
      }

      // Script phase: no engine, session or prompt. Its eval command is the
      // step (e.g. seed a scaffold); a failure fails the phase (no fix attempts).
      const isScript = phase.type === 'script';
      if (isScript && (state.step === 'run' || state.step === 'fix' || state.step === 'gate')) {
        phaseState.lastRun = {
          at: nowIso(),
          code: 0,
          timedOut: false,
          stdout: '',
          stderr: '',
          outPath: null,
          runId: null,
          kind: 'script',
        };
        phaseState.engine = null;
        state.step = 'eval';
        saveState(state);
      }

      // Start on the next installed engine when this phase's CLI is missing.
      if (!isScript && !engineInstalledFn(phase.engine)) {
        const nextEngine = nextFailoverEngine(
          state.definition,
          basePhase,
          phaseState,
          engineInstalledFn
        );
        if (nextEngine) {
          await applyEngineFailover(state, basePhase, phaseState, nextEngine, {
            kind: 'cli_missing',
            line: `${phase.engine} CLI not found`,
            env,
          });
          continue;
        }
      }

      let session;
      try {
        if (isScript) {
          session = { id: null, title: null, engine: null, cwd: state.definition.cwd };
        } else {
          session = await ensureSessionFn(phase, state.definition, {
            env,
            loopRoot,
            existingSessionId: phaseState.sessionId || null,
          });
          phaseState.sessionId = session.id;
          phaseState.sessionTitle = session.title;
          phaseState.engine = session.engine || phase.engine;
          saveState(state);
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        phaseState.status = 'failed';
        phaseState.failedAt = nowIso();
        await markLoopFailed(state, `phase ${phase.id}: session error: ${msg}`, { env });
        return { ok: false, status: 'failed', state, error: msg };
      }

      // After gate approval, continue from run (not gate).
      if (state.step === 'gate') {
        state.step = 'run';
        saveState(state);
      }

      const isPlanNext = phase.type === 'plan-next';
      const planOutPath = isPlanNext ? planNextOutputPath(name) : null;
      const phaseIndex = state.definition.phases.findIndex((p) => p && p.id === phase.id);
      const fromPhaseId =
        state.definition.protected && state.definition.protected.fromPhase
          ? state.definition.protected.fromPhase
          : null;
      const fromPhaseIndex = fromPhaseId
        ? protectedPaths.indexOfPhase(state.definition, fromPhaseId)
        : -1;
      const protectedGlobs = protectedPaths.effectivePatterns(state.definition, phase, {
        phaseIndex,
        fromPhaseIndex,
      });

      if (protectedGlobs.length && !phaseState.baseSha) {
        const reason = protectedPaths.baseShaFailureReason(state.definition.cwd);
        const msg = reason
          ? `phase ${phase.id}: protected paths need a git cwd with a base commit (${state.definition.cwd}; ${reason})`
          : `phase ${phase.id}: protected paths need a git cwd with a base commit (${state.definition.cwd})`;
        phaseState.status = 'failed';
        phaseState.failedAt = nowIso();
        await markLoopFailed(state, msg, { env });
        return { ok: false, status: 'failed', state, error: msg };
      }

      // --- run / fix prompt ---
      if (state.step === 'run' || state.step === 'fix') {
        let prompt;
        try {
          if (isPlanNext && state.step === 'run') {
            const target = resolvePlanNextTarget(phase);
            if (target != null) {
              const last = readLastProjectEvalOverall(state.definition.cwd, { liveOnly: true });
              if (last != null && last >= target) {
                ensureLoopDir(name);
                fs.writeFileSync(planOutPath, `${JSON.stringify({ done: true })}\n`);
                phaseState.lastRun = {
                  at: nowIso(),
                  code: 0,
                  timedOut: false,
                  stdout: `plan-next short-circuit: live overall ${last} >= target ${target}`,
                  stderr: '',
                  outPath: null,
                  runId: null,
                  kind: 'plan-next-short-circuit',
                };
                appendHistory(state, {
                  event: 'loop.plan_next.short_circuit',
                  phaseId: phase.id,
                  attempt: state.attempt,
                  summary: `plan-next skipped: live overall ${last} >= target ${target}`,
                });
                state.step = 'eval';
                saveState(state);
              }
            }
          }
          if (state.step === 'run' || state.step === 'fix') {
            if (isPlanNext) {
              ensureLoopDir(name);
              if (state.step === 'fix' && phaseState.lastEval) {
                prompt = buildPlanNextFixPrompt(
                  phase,
                  planOutPath,
                  phaseState.lastEval.stderr || phaseState.lastEval.stdout || 'invalid plan-next',
                  phaseState.lastEval
                );
              } else {
                prompt = buildPlanNextPrompt(state, phase, planOutPath, { env });
              }
            } else {
              prompt =
                state.step === 'fix' && phaseState.lastEval
                  ? buildFixPrompt(phase, phaseState.lastEval)
                  : resolvePhasePrompt(phase);
            }
          }
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          phaseState.status = 'failed';
          phaseState.failedAt = nowIso();
          await markLoopFailed(state, msg, { env });
          return { ok: false, status: 'failed', state, error: msg };
        }

        if (state.step !== 'run' && state.step !== 'fix') {
          /* e.g. plan-next short-circuit moved to eval */
        } else {
        const stepBeforeRun = state.step;
        const runResult = await runPromptFn(session, prompt, phase, {
          env,
          definition: state.definition,
        });
        const stoppedAfterRun = await finishIfStopRequested(state, name, env);
        if (stoppedAfterRun) return stoppedAfterRun;
        const pausedAfterRun = await finishIfPauseRequested(state, name, env);
        if (pausedAfterRun) return pausedAfterRun;
        state.runsUsed += 1;
        phaseState.attempts = (phaseState.attempts || 0) + 1;
        // A new worker run invalidates earlier verification results.
        phaseState.verification = [];
        phaseState.lastRun = {
          at: nowIso(),
          code: runResult.code,
          timedOut: runResult.timedOut,
          stdout: truncateText(runResult.stdout || '', 4000),
          stderr: truncateText(runResult.stderr || '', 2000),
          outPath: runResult.outPath || null,
          runId: runResult.runId || null,
          kind: state.step,
        };
        if (agentRunFailed(phaseState.lastRun) && !runResult.interruptedBy) {
          const cls = classifyEngineError(
            runResult.engineErrorText != null
              ? runResult.engineErrorText
              : `${runResult.stderr || ''}\n${runResult.stdout || ''}`,
            { engine: session.engine || phase.engine }
          );
          if (cls) {
            phaseState.lastRun.errorKind = cls.kind;
            phaseState.lastRun.errorLine = cls.line;
            phaseState.lastRun.errorMessage = cls.message;
          }
        }
        state.step = 'eval';
        try {
          refreshLoopUsage(state);
        } catch (_) {
          /* ignore */
        }
        saveState(state);

        if (runResult.interruptedBy) {
          await markLoopStopped(state, `interrupted (${runResult.interruptedBy})`, { env });
          return { ok: false, status: 'stopped', state };
        }

        // Infrastructure error (never an eval failure): rerun this same attempt
        // on the next engine in definition.engines, without using a fix attempt.
        if (phaseState.lastRun.errorKind && FAILOVER_ERROR_KINDS.has(phaseState.lastRun.errorKind)) {
          const nextEngine = nextFailoverEngine(
            state.definition,
            basePhase,
            phaseState,
            engineInstalledFn
          );
          if (nextEngine) {
            state.step = stepBeforeRun;
            await applyEngineFailover(state, basePhase, phaseState, nextEngine, {
              kind: phaseState.lastRun.errorKind,
              line: phaseState.lastRun.errorLine,
              env,
            });
            continue;
          }
        }
        }
      }

      // --- protected-path diff guard (never retryable, no fix attempt) ---
      if (state.step === 'eval' && protectedGlobs.length) {
        const violations = protectedPaths.findViolations(
          state.definition.cwd,
          phaseState.baseSha,
          protectedGlobs
        );
        if (violations == null || violations.length) {
          const lockNote = evalCoverage.protectedFixturesLockSummary(state.definition);
          const failSummary = violations
            ? `phase ${phase.id} failed: protected path(s) changed since base ${String(
                phaseState.baseSha
              ).slice(0, 12)}: ${violations.join(', ')}.${lockNote ? ` ${lockNote}` : ''}`
            : `phase ${phase.id} failed: could not compute changed paths against base ${phaseState.baseSha}`;
          phaseState.status = 'failed';
          phaseState.failedAt = nowIso();
          if (violations) phaseState.protectedViolation = violations;
          phaseState.lastEval = {
            at: nowIso(),
            code: 1,
            timedOut: false,
            stdout: '',
            stderr: truncateText(failSummary, 2000),
            cwd: state.definition.cwd,
          };
          const extra = violations ? { protectedViolation: violations } : {};
          appendHistory(state, {
            event: 'loop.phase.protected_violation',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: failSummary,
            ...extra,
          });
          appendHistory(state, {
            event: 'loop.phase.failed',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: failSummary,
            nonRetryable: true,
            ...extra,
          });
          saveState(state);
          recordMemoryTransition(
            state,
            {
              event: 'loop.phase.failed',
              phaseId: phase.id,
              attempt: state.attempt,
              summary: failSummary,
              writeNote: true,
              noteSlug: `${phase.id}-failed`,
            },
            { env }
          );
          await emitLoopNotify(notify.EVENTS.LOOP_PHASE_FAILED, state, {
            phaseId: phase.id,
            attempt: state.attempt,
            summary: failSummary,
            engine: phase.engine,
            sessionId: session.id,
            exitStatus: 1,
            ...extra,
            env,
          });
          const terminal = await finishLoopAfterPhaseFailure(state, failSummary, {
            phase,
            phaseId: phase.id,
            attempt: state.attempt,
            engine: phase.engine,
            protectedViolation: extra.protectedViolation,
            nonRetryable: true,
            ...extra,
          }, { env, ...extra });
          return {
            ok: false,
            status: terminal.status,
            state,
            error: failSummary,
          };
        }
      }

      // --- eval ---
      if (state.step === 'eval') {
        let evalResult;
        let planPayload = null;
        const agentRun = phaseState.lastRun;
        const agentFailed = agentRunFailed(agentRun);

        if (agentFailed) {
          // A green eval must not pass the phase when the agent exited
          // non-zero or timed out. Skip eval and retry or fail.
          const why = agentRun.timedOut
            ? `agent timed out (exit ${agentRun.code})`
            : `agent exited ${agentRun.code}`;
          evalResult = {
            code: agentRun.code == null ? 1 : agentRun.code,
            timedOut: Boolean(agentRun.timedOut),
            stdout: truncateText(agentRun.stdout || '', 4000),
            stderr:
              `${why}. A green eval does not pass this phase when the agent run failed.\n` +
              (agentRun.stderr || ''),
            cwd: (session && session.cwd) || state.definition.cwd,
          };
        } else if (isPlanNext) {
          planPayload = readPlanNextFile(planOutPath);
          let filePreview = '';
          try {
            if (fs.existsSync(planOutPath)) {
              filePreview = truncateText(fs.readFileSync(planOutPath, 'utf8'), 4000);
            }
          } catch (_) {
            /* ignore */
          }
          evalResult = {
            code: planPayload.ok ? 0 : 1,
            timedOut: false,
            stdout: filePreview,
            stderr: planPayload.ok ? '' : planPayload.error || 'plan-next invalid',
            cwd: state.definition.cwd,
          };
        } else {
          const evalStartedMs = Date.now();
          evalResult = await runEvalFn(phase.eval, {
            baseCwd: state.definition.cwd,
            definitionDir,
            env,
          });
          if (evalResult && evalResult.durationMs == null) {
            evalResult.durationMs = Date.now() - evalStartedMs;
          }
        }

        const stoppedAfterEval = await finishIfStopRequested(state, name, env);
        if (stoppedAfterEval) return stoppedAfterEval;
        const pausedAfterEval = await finishIfPauseRequested(state, name, env);
        if (pausedAfterEval) return pausedAfterEval;
        // Score from full eval output before truncating tails for state/UI.
        // M5a often prints lengthy node:test output then a trailing {"overall":…}.
        const scored = extractEvalScore({
          stdout: evalResult.stdout,
          stderr: evalResult.stderr,
        });
        phaseState.lastEval = {
          at: nowIso(),
          code: evalResult.code,
          timedOut: evalResult.timedOut,
          stdout: truncateText(evalResult.stdout, 4000),
          stderr: truncateText(evalResult.stderr, 2000),
          cwd: evalResult.cwd,
        };
        if (scored != null) phaseState.evalScore = scored;
        try {
          refreshLoopUsage(state);
        } catch (_) {
          /* ignore */
        }
        saveState(state);

        let passed =
          !agentFailed &&
          (isPlanNext
            ? Boolean(planPayload && planPayload.ok)
            : evalPassed(phase.eval, evalResult, { cwd: state.definition.cwd }));
        if (passed && !agentFailed && !isPlanNext && phase.eval && phase.eval.coverage) {
          const cov = evalCoverage.checkEvalCoverage(phase.eval.coverage, {
            cwd: state.definition.cwd,
            env,
            runCommand: opts.runCoverageCommand,
          });
          if (!cov.ok) {
            passed = false;
            phaseState.coverageFailure = cov;
            const msg = cov.message || 'fixture tier coverage check failed';
            evalResult = {
              ...evalResult,
              code: 1,
              stderr: `${evalResult.stderr || ''}\n${msg}`.trim(),
              coverageFailure: cov,
            };
            phaseState.lastEval = {
              ...phaseState.lastEval,
              code: 1,
              stderr: truncateText(evalResult.stderr, 2000),
              coverageFailure: cov,
            };
            saveState(state);
          }
        }
        if (!agentFailed && !isPlanNext) {
          commitGate.recordEvalVerification(phaseState, phase.eval, evalResult, { ok: passed });
          phaseState.verifyFailure = null;
          if (passed && phase.verify !== false && (state.definition.verify || phase.verify)) {
            const verifyOutcome = await loopVerify.runAfterEvalVerify({
              state,
              definition: state.definition,
              phase,
              phaseState,
              recordVerification: (entry) => commitGate.recordVerification(phaseState, entry),
              saveState: () => saveState(state),
              env,
              loopDir: loopDir(name),
              definitionDir,
              packageRoot: path.resolve(__dirname, '..'),
              engine: (session && session.engine) || phase.engine || state.definition.engine,
              model: resolvePhaseModel(phase, state.definition, env),
              runCommand: opts.runVerifyCommand,
              deps: opts.verifyDeps,
            });
            if (!verifyOutcome.ok) {
              passed = false;
              phaseState.verifyFailure = {
                tier: verifyOutcome.tier || 'tier',
                summary: (verifyOutcome.result && verifyOutcome.result.summary) || '',
              };
              if (verifyOutcome.lastEval) {
                phaseState.lastEval = { ...phaseState.lastEval, ...verifyOutcome.lastEval };
              }
              appendHistory(state, {
                event: 'loop.phase.verify_failed',
                phaseId: phase.id,
                attempt: state.attempt,
                summary: `verify ${verifyOutcome.tier || 'tier'} failed`,
              });
            }
          }
          saveState(state);
        }

        if (passed) {
          if (isPlanNext) {
            if (planPayload.done) {
              phaseState.status = 'passed';
              phaseState.passedAt = nowIso();
              appendHistory(state, {
                event: 'loop.phase.passed',
                phaseId: phase.id,
                attempt: state.attempt,
                summary: `plan-next ${phase.id}: done=true`,
              });
              saveState(state);
              recordMemoryTransition(
                state,
                {
                  event: 'loop.phase.passed',
                  phaseId: phase.id,
                  attempt: state.attempt,
                  summary: `plan-next ${phase.id}: planner signaled done`,
                  writeNote: true,
                  noteSlug: `${phase.id}-passed`,
                },
                { env }
              );
              await emitLoopNotify(notify.EVENTS.LOOP_PHASE_PASSED, state, {
                phaseId: phase.id,
                attempt: state.attempt,
                summary: `plan-next ${phase.id}: done`,
                engine: phase.engine,
                sessionId: session.id,
                exitStatus: 0,
                env,
              });
              state.phaseIndex += 1;
              state.attempt = 0;
              state.step = 'run';
              state.phaseId =
                state.phaseIndex < state.definition.phases.length
                  ? state.definition.phases[state.phaseIndex].id
                  : phase.id;
              saveState(state);
              continue;
            }

            const inserted = insertPlannedPhases(
              state,
              state.phaseIndex,
              planPayload.phases,
              { env }
            );
            if (!inserted.ok) {
              phaseState.lastEval.stderr = inserted.error;
              phaseState.lastEval.code = 1;
              const attemptNumber = state.attempt;
              if (attemptNumber < phase.maxFixAttempts) {
                state.attempt = attemptNumber + 1;
                state.step = 'fix';
                appendHistory(state, {
                  event: 'loop.phase.eval_failed',
                  phaseId: phase.id,
                  attempt: attemptNumber,
                  summary: `plan-next append failed: ${inserted.error}; fix attempt ${state.attempt}/${phase.maxFixAttempts}`,
                });
                saveState(state);
                continue;
              }
              phaseState.status = 'failed';
              phaseState.failedAt = nowIso();
              const failSummary = `plan-next ${phase.id} failed: ${inserted.error}`;
              appendHistory(state, {
                event: 'loop.phase.failed',
                phaseId: phase.id,
                attempt: state.attempt,
                summary: failSummary,
              });
              saveState(state);
              recordMemoryTransition(
                state,
                {
                  event: 'loop.phase.failed',
                  phaseId: phase.id,
                  attempt: state.attempt,
                  summary: failSummary,
                  writeNote: true,
                  noteSlug: `${phase.id}-failed`,
                },
                { env }
              );
              await emitLoopNotify(notify.EVENTS.LOOP_PHASE_FAILED, state, {
                phaseId: phase.id,
                attempt: state.attempt,
                summary: failSummary,
                engine: phase.engine,
                sessionId: session.id,
                exitStatus: 1,
                env,
              });
              const terminal = await finishLoopAfterPhaseFailure(
                state,
                failSummary,
                { phase, phaseId: phase.id, exhaustedFixes: true },
                { env }
              );
              return {
                ok: false,
                status: terminal.status,
                state,
                error: failSummary,
              };
            }

            appendHistory(state, {
              event: 'loop.phase.planned',
              phaseId: phase.id,
              attempt: state.attempt,
              summary: `plan-next inserted: ${inserted.inserted.join(', ')}`,
            });
            try {
              require('./loop-snapshot').snapshotLoopFiles(state.definition, loopDir(name));
            } catch (_) {
              /* best-effort */
            }
            saveState(state);
            try {
              atomicWriteJson(definitionSnapshotPath(name), state.definition);
            } catch (_) {
              /* ignore */
            }
            recordMemoryTransition(
              state,
              {
                event: 'loop.phase.planned',
                phaseId: phase.id,
                attempt: state.attempt,
                summary: `plan-next inserted phases: ${inserted.inserted.join(', ')}`,
                writeNote: true,
                noteSlug: `${phase.id}-planned`,
              },
              { env }
            );
            // Do not mark plan-next passed; run inserted phases then return here.
            continue;
          }

          // onPass (normal phases)
          const onPassResult = runOnPassAction(phase.onPass, state.definition, phase, {
            env,
            phaseState,
            attempt: state.attempt,
            engine: (session && session.engine) || phase.engine,
          });
          phaseState.onPass = onPassResult;
          if (onPassResult.gate) {
            for (const warning of onPassResult.gate.warnings) {
              appendHistory(state, {
                event: 'loop.commit_gate.warning',
                phaseId: phase.id,
                attempt: state.attempt,
                summary: warning,
              });
              process.stderr.write(`WARNING: loop ${name} phase ${phase.id}: ${warning}\n`);
            }
          }
          if (onPassResult.gate && onPassResult.gate.refused) {
            // Never retryable: the worker's result was verified, the gate said no.
            const failSummary = `phase ${phase.id} failed: ${onPassResult.error}`;
            phaseState.status = 'failed';
            phaseState.failedAt = nowIso();
            appendHistory(state, {
              event: 'loop.commit_gate.refused',
              phaseId: phase.id,
              attempt: state.attempt,
              summary: failSummary,
            });
            appendHistory(state, {
              event: 'loop.phase.failed',
              phaseId: phase.id,
              attempt: state.attempt,
              summary: failSummary,
              nonRetryable: true,
            });
            saveState(state);
            recordMemoryTransition(
              state,
              {
                event: 'loop.phase.failed',
                phaseId: phase.id,
                attempt: state.attempt,
                summary: failSummary,
                writeNote: true,
                noteSlug: `${phase.id}-failed`,
              },
              { env }
            );
            await emitLoopNotify(notify.EVENTS.LOOP_PHASE_FAILED, state, {
              phaseId: phase.id,
              attempt: state.attempt,
              summary: failSummary,
              engine: phase.engine,
              sessionId: session.id,
              exitStatus: 1,
              env,
            });
            const terminal = await finishLoopAfterPhaseFailure(
              state,
              failSummary,
              { phase, phaseId: phase.id, commitGateRefused: true, nonRetryable: true },
              { env }
            );
            return {
              ok: false,
              status: terminal.status,
              state,
              error: failSummary,
            };
          }
          phaseState.status = 'passed';
          phaseState.passedAt = nowIso();
          appendHistory(state, {
            event: 'loop.phase.passed',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: `phase ${phase.id} passed`,
          });
          saveState(state);
          recordMemoryTransition(
            state,
            {
              event: 'loop.phase.passed',
              phaseId: phase.id,
              attempt: state.attempt,
              summary: `phase ${phase.id} passed` +
                (onPassResult.skipped
                  ? onPassResult.reason
                    ? ` (onPass skipped: ${onPassResult.reason})`
                    : ''
                  : ` (onPass=${onPassResult.action})`),
              writeNote: true,
              noteSlug: `${phase.id}-passed`,
            },
            { env }
          );
          await emitLoopNotify(notify.EVENTS.LOOP_PHASE_PASSED, state, {
            phaseId: phase.id,
            attempt: state.attempt,
            summary: `phase ${phase.id} passed`,
            engine: phase.engine,
            sessionId: session.id,
            exitStatus: 0,
            env,
          });

          state.phaseIndex += 1;
          state.attempt = 0;
          state.step = 'run';
          state.phaseId =
            state.phaseIndex < state.definition.phases.length
              ? state.definition.phases[state.phaseIndex].id
              : phase.id;
          const nextPhase = state.definition.phases[state.phaseIndex];
          if (nextPhase && nextPhase.type === 'plan-next') {
            resetPlanRoundFailures(state, state.definition);
          }
          saveState(state);
          continue;
        }

        // eval failed
        const attemptNumber = state.attempt;
        const nonRetryable = agentFailed && agentRun.errorKind ? agentRun : null;
        if (
          isScript &&
          !passed &&
          isInfraEvalFailure(evalResult, phase.eval) &&
          (phase.eval.infraRetries || 0) > 0
        ) {
          phaseState.infraAttempts = (phaseState.infraAttempts || 0) + 1;
          if (phaseState.infraAttempts <= phase.eval.infraRetries) {
            state.step = 'eval';
            appendHistory(state, {
              event: 'loop.phase.infra_retry',
              phaseId: phase.id,
              attempt: attemptNumber,
              summary: `script eval infrastructure failure; retry ${phaseState.infraAttempts}/${phase.eval.infraRetries}`,
            });
            saveState(state);
            continue;
          }
        }
        if (!nonRetryable && attemptNumber < phase.maxFixAttempts) {
          state.attempt = attemptNumber + 1;
          state.step = 'fix';
          appendHistory(state, {
            event: 'loop.phase.eval_failed',
            phaseId: phase.id,
            attempt: attemptNumber,
            summary: agentFailed
            ? `${agentRun.timedOut ? 'agent timed out' : `agent exited ${agentRun.code}`}; fix attempt ${state.attempt}/${phase.maxFixAttempts}`
            : isPlanNext
              ? `plan-next invalid; fix attempt ${state.attempt}/${phase.maxFixAttempts}`
              : phaseState.verifyFailure
                ? `verify ${phaseState.verifyFailure.tier} failed: ${phaseState.verifyFailure.summary}; fix attempt ${state.attempt}/${phase.maxFixAttempts}`
                : phaseState.coverageFailure
                  ? `fixture tier coverage failed: ${phaseState.coverageFailure.message || 'incomplete probes'}; fix attempt ${state.attempt}/${phase.maxFixAttempts}`
                  : `eval failed (exit ${evalResult.code}); fix attempt ${state.attempt}/${phase.maxFixAttempts}`,
          });
          saveState(state);
          continue;
        }

        phaseState.status = 'failed';
        phaseState.failedAt = nowIso();
        if (nonRetryable) {
          phaseState.errorKind = nonRetryable.errorKind;
          phaseState.errorLine = nonRetryable.errorLine || null;
        }
        const failSummary = nonRetryable
          ? `phase ${phase.id} failed (${nonRetryable.errorKind}, not retryable): ${
              nonRetryable.errorLine || nonRetryable.errorMessage
            }`
          : agentFailed
          ? `phase ${phase.id} failed after ${phase.maxFixAttempts} fix attempt(s); agent ${
              agentRun.timedOut ? 'timed out' : `exited ${agentRun.code}`
            }`
          : isPlanNext
            ? `plan-next ${phase.id} failed after ${phase.maxFixAttempts} fix attempt(s): ${
                (planPayload && planPayload.error) || evalResult.stderr || 'invalid'
              }`
            : phaseState.verifyFailure
              ? `phase ${phase.id} failed after ${phase.maxFixAttempts} fix attempt(s); verify ${phaseState.verifyFailure.tier} failed: ${phaseState.verifyFailure.summary}`
              : phaseState.coverageFailure
                ? `phase ${phase.id} failed after ${phase.maxFixAttempts} fix attempt(s); fixture tier coverage: ${phaseState.coverageFailure.message || 'incomplete'}`
                : `phase ${phase.id} failed after ${phase.maxFixAttempts} fix attempt(s); last eval exit ${evalResult.code}`;
        appendHistory(state, {
          event: 'loop.phase.failed',
          phaseId: phase.id,
          attempt: state.attempt,
          summary: failSummary,
          ...(nonRetryable ? { errorKind: nonRetryable.errorKind, nonRetryable: true } : {}),
        });
        saveState(state);
        recordMemoryTransition(
          state,
          {
            event: 'loop.phase.failed',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: failSummary,
            writeNote: true,
            noteSlug: `${phase.id}-failed`,
          },
          { env }
        );
        await emitLoopNotify(notify.EVENTS.LOOP_PHASE_FAILED, state, {
          phaseId: phase.id,
          attempt: state.attempt,
          summary: failSummary,
          engine: phase.engine,
          sessionId: session.id,
          exitStatus: evalResult.code,
          ...(nonRetryable ? { errorKind: nonRetryable.errorKind, nonRetryable: true } : {}),
          env,
        });
        const terminal = await finishLoopAfterPhaseFailure(
          state,
          failSummary,
          {
            phase,
            phaseId: phase.id,
            attempt: state.attempt,
            engine: phase.engine,
            exhaustedFixes: !nonRetryable,
            nonRetryable: Boolean(nonRetryable),
            errorKind: nonRetryable ? nonRetryable.errorKind : undefined,
          },
          {
            env,
            ...(nonRetryable ? { errorKind: nonRetryable.errorKind, nonRetryable: true } : {}),
          }
        );
        return { ok: false, status: terminal.status, state, error: failSummary };
      }
    }

    // Final acceptance eval (optional) + summary status note when goal/acceptance set.
    if (state.definition.acceptanceEval) {
      const acc = await runEvalFn(state.definition.acceptanceEval, {
        baseCwd: state.definition.cwd,
        definitionDir,
        env,
      });
      if (!evalPassed(state.definition.acceptanceEval, acc)) {
        const failSummary = `acceptanceEval failed (exit ${acc.code})`;
        await markLoopFailed(state, failSummary, { env });
        return { ok: false, status: 'failed', state, error: failSummary };
      }
    }

    const acceptanceSummary = buildAcceptanceSummary(state);
    const completeSummary =
      state.definition.goal || state.definition.acceptance
        ? acceptanceSummary
        : 'all phases passed';
    await markLoopCompleted(state, {
      env,
      summary: completeSummary,
      noteSlug:
        state.definition.goal || state.definition.acceptance ? 'acceptance-summary' : 'completed',
    });
    return { ok: true, status: 'completed', state };
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  } finally {
    releaseRunnerLock(lock || name);
  }
}

async function runFromFile(filePath, opts = {}) {
  const validated = validateFile(filePath, opts);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors,
      warnings: validated.warnings || [],
      path: validated.path,
    };
  }
  for (const w of validated.warnings || []) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }
  try {
    const result = await runLoop(validated.definition, {
      ...opts,
      definitionPath: validated.path,
    });
    const warnings = []
      .concat(validated.warnings || [])
      .concat(result.warnings || []);
    return { ...result, warnings, path: validated.path };
  } catch (err) {
    if (err && err.code === 'LOOP_BUSY') {
      return { ok: false, error: err.message, code: 'LOOP_BUSY', path: validated.path };
    }
    throw err;
  }
}

/**
 * Register a loop as active for the dashboard scheduler (does not run phases).
 */
function startFromFile(filePath, opts = {}) {
  const validated = validateFile(filePath, opts);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors,
      warnings: validated.warnings || [],
      path: validated.path,
    };
  }
  for (const w of validated.warnings || []) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }

  const definition = validated.definition;
  const name = definition.name;
  ensureLoopDir(name);
  try {
    atomicWriteJson(definitionSnapshotPath(name), definition);
  } catch (_) {
    /* ignore */
  }

  let state = loadState(name);
  const lock = readLockInfo(name);
  if (lock && lock.alive && state && state.status === 'running') {
    state.active = true;
    state.definition = definition;
    state.definitionPath = validated.path;
    state.pauseRequested = false;
    state.stopRequested = false;
    appendHistory(state, {
      event: 'loop.activated',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: 'marked active for scheduler (runner already live)',
    });
    saveState(state);
    return {
      ok: true,
      status: state.status,
      state,
      path: validated.path,
      message: 'marked active; runner already live',
      warnings: validated.warnings || [],
    };
  }

  if (!state || TERMINAL_STATUSES.has(state.status) || opts.fresh) {
    state = createInitialState(definition, {
      definitionPath: validated.path,
      active: true,
    });
  } else {
    state.definition = definition;
    state.definitionPath = validated.path;
    for (const p of definition.phases) {
      if (!state.phases[p.id]) state.phases[p.id] = emptyPhaseState(p);
    }
    state.active = true;
    state.pauseRequested = false;
    state.stopRequested = false;
    if (state.status === 'paused') {
      state.status = 'pending';
      state.pausedAt = null;
    }
  }

  appendHistory(state, {
    event: 'loop.activated',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: 'registered as active for scheduler',
  });
  saveState(state);

  return {
    ok: true,
    status: state.status,
    state,
    path: validated.path,
    message: 'registered as active for scheduler',
    warnings: validated.warnings || [],
  };
}

async function resumeLoop(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (state.status === 'completed') {
    return { ok: true, status: 'completed', state, message: 'loop already completed' };
  }
  if (state.status === 'failed' && !opts.force) {
    return {
      ok: false,
      status: 'failed',
      state,
      error: 'loop failed; re-run with the definition file or pass force via API',
    };
  }
  if (state.status === 'needs_human') {
    prepareResumeFromNeedsHuman(state);
    saveState(state);
  }
  const definition = state.definition;
  if (!definition || !Array.isArray(definition.phases)) {
    return { ok: false, error: `loop "${safe}" state is missing definition` };
  }
  // Clear failed/stopped/paused → allow resume; for failed need opts.force
  if (
    state.status === 'stopped' ||
    state.status === 'failed' ||
    state.status === 'paused' ||
    state.status === 'needs_human'
  ) {
    state.status = state.status === 'paused' ? 'pending' : 'running';
    state.stopRequested = false;
    state.pauseRequested = false;
    state.active = opts.active != null ? Boolean(opts.active) : state.active;
    state.lastError = null;
    state.pausedAt = null;
    saveState(state);
  }
  return runLoop(definition, {
    ...opts,
    resume: true,
    definitionPath: state.definitionPath,
  });
}

/**
 * Mark a paused/pending loop active again without running phases (scheduler path).
 */
function requestResume(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (state.status === 'completed') {
    return { ok: true, status: 'completed', state, message: 'loop already completed' };
  }
  if (state.status === 'waiting' || (state.gate && state.gate.waiting)) {
    return {
      ok: false,
      status: 'waiting',
      state,
      error: 'loop is waiting for approval; use approve',
    };
  }
  if (state.status === 'needs_human') {
    return {
      ok: false,
      status: 'needs_human',
      state,
      error: 'loop needs human attention; use aflt loop resume',
    };
  }
  if (state.status === 'failed' && !opts.force) {
    return {
      ok: false,
      status: 'failed',
      state,
      error: 'loop failed; pass force to resume',
    };
  }
  if (state.status === 'stopped' && !opts.force) {
    return {
      ok: false,
      status: 'stopped',
      state,
      error: 'loop stopped; pass force to resume or re-start the definition',
    };
  }

  state.active = true;
  state.pauseRequested = false;
  state.stopRequested = false;
  state.lastError = null;
  if (
    state.status === 'paused' ||
    state.status === 'stopped' ||
    state.status === 'failed' ||
    state.status === 'needs_human'
  ) {
    if (state.status === 'needs_human') prepareResumeFromNeedsHuman(state);
    state.status = 'pending';
    state.pausedAt = null;
  }
  appendHistory(state, {
    event: 'loop.resume_requested',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: 'resume requested for scheduler',
  });
  saveState(state);
  return { ok: true, status: state.status, state, active: true };
}

/**
 * Release an approval gate (`gate: "approve"`). Marks the phase approved and
 * re-activates the loop for the dashboard scheduler.
 */
function requestApprove(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  const waiting =
    state.status === 'waiting' || Boolean(state.gate && state.gate.waiting);
  if (!waiting && !opts.force) {
    return {
      ok: false,
      status: state.status,
      state,
      error: 'loop is not waiting for approval',
    };
  }

  const phaseId =
    (opts.phaseId != null && String(opts.phaseId).trim()) ||
    (state.gate && state.gate.phaseId) ||
    state.phaseId;
  if (!phaseId || !state.phases || !state.phases[phaseId]) {
    return { ok: false, error: `unknown phase for approval: ${phaseId || '(none)'}`, state };
  }

  const phaseState = state.phases[phaseId];
  phaseState.gateApproved = true;
  if (!phaseState.baseSha && state.definition && state.definition.cwd) {
    phaseState.baseSha = capturePhaseBaseSha(state.definition.cwd);
    if (!phaseState.baseSha) {
      const reason = protectedPaths.baseShaFailureReason(state.definition.cwd);
      // Non-git loop cwd is allowed; missing commits on a git repo is not.
      if (reason && reason !== 'not a git repository') {
        return {
          ok: false,
          error: `could not record base commit for phase ${phaseId}: ${reason}`,
          state,
        };
      }
    }
  }
  state.gate = {
    phaseId,
    waiting: false,
    at: state.gate && state.gate.at ? state.gate.at : null,
    approvedAt: nowIso(),
  };
  state.status = 'pending';
  state.active = true;
  state.pauseRequested = false;
  state.stopRequested = false;
  state.lastError = null;
  if (state.step === 'gate') state.step = 'run';
  appendHistory(state, {
    event: 'loop.gate.approved',
    phaseId,
    attempt: state.attempt,
    summary: `approval granted for phase ${phaseId}`,
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.gate.approved',
      phaseId,
      attempt: state.attempt,
      summary: `approval granted for phase ${phaseId}`,
      writeNote: false,
    },
    opts
  );
  const notifyPromise = emitLoopNotify(notify.EVENTS.LOOP_GATE_APPROVED, state, {
    phaseId,
    attempt: state.attempt,
    summary: `approval granted for phase ${phaseId}`,
    env: opts.env,
    ...opts,
  });
  return {
    ok: true,
    status: state.status,
    state,
    active: true,
    phaseId,
    notify: notifyPromise,
  };
}

function requestPause(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (TERMINAL_STATUSES.has(state.status)) {
    return { ok: true, status: state.status, state, message: `loop already ${state.status}` };
  }
  if (state.status === 'paused') {
    return { ok: true, status: 'paused', state, message: 'loop already paused' };
  }

  state.pauseRequested = true;
  saveState(state);

  const lock = readLockInfo(safe);
  let signaled = false;
  // Soft signal: do not SIGTERM on pause (runner yields between steps).
  if (!lock || !lock.alive) {
    markLoopPaused(state, 'paused (no live runner)', opts);
  }

  return {
    ok: true,
    status: state.status,
    pauseRequested: state.pauseRequested,
    signaled,
    lock,
    state,
  };
}

function requestStop(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'stopped') {
    state.active = false;
    saveState(state);
    return { ok: true, status: state.status, state, message: `loop already ${state.status}` };
  }
  state.stopRequested = true;
  state.pauseRequested = false;
  state.active = false;
  saveState(state);

  const lock = readLockInfo(safe);
  let signaled = false;
  if (lock && lock.alive && lock.pid && lock.pid !== process.pid) {
    try {
      process.kill(lock.pid, 'SIGTERM');
      signaled = true;
    } catch (_) {
      /* ignore */
    }
  }

  // If no runner holds the lock, mark stopped immediately.
  if (!lock || !lock.alive) {
    state.status = 'stopped';
    state.stoppedAt = nowIso();
    state.stopRequested = false;
    state.active = false;
    appendHistory(state, {
      event: 'loop.stopped',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: 'stopped (no live runner)',
    });
    saveState(state);
  }

  return {
    ok: true,
    status: state.status,
    stopRequested: state.stopRequested,
    signaled,
    lock,
    state,
  };
}

function formatEvalTail(lastEval, cap = EVAL_TAIL_CAP) {
  if (!lastEval || typeof lastEval !== 'object') return null;
  const parts = [];
  if (lastEval.stdout) parts.push(String(lastEval.stdout));
  if (lastEval.stderr) parts.push(String(lastEval.stderr));
  const combined = parts.join('\n').trim();
  if (!combined) {
    return {
      at: lastEval.at || null,
      code: lastEval.code != null ? lastEval.code : null,
      timedOut: Boolean(lastEval.timedOut),
      text: '',
    };
  }
  return {
    at: lastEval.at || null,
    code: lastEval.code != null ? lastEval.code : null,
    timedOut: Boolean(lastEval.timedOut),
    text: truncateText(combined, cap),
  };
}

function buildStepPipeline(state) {
  const phases = (state.definition && state.definition.phases) || [];
  const phase = phases[state.phaseIndex] || null;
  const step = state.step || 'run';
  const isPlanNext = Boolean(phase && phase.type === 'plan-next');
  const mode =
    isPlanNext || (phase && phase.mode === 'plan') ? 'plan' : 'develop';
  const hasGate = Boolean(phase && phase.gate === 'approve');
  const waitingGate = Boolean(state.gate && state.gate.waiting) || step === 'gate';
  const stages = [
    {
      id: 'plan',
      label: 'plan',
      active: step === 'run' && mode === 'plan' && !waitingGate,
      done: false,
    },
    {
      id: 'develop',
      label: 'develop',
      active: step === 'run' && mode !== 'plan' && !waitingGate,
      done: step === 'eval' || step === 'fix' || (step === 'gate' && false),
    },
    {
      id: 'evaluate',
      label: 'evaluate',
      active: step === 'eval',
      done: step === 'fix',
    },
    {
      id: 'revise',
      label: 'revise',
      active: step === 'fix',
      done: false,
    },
  ];
  if (hasGate || waitingGate) {
    stages.push({
      id: 'approve',
      label: 'approve',
      active: waitingGate,
      done: Boolean(phase && state.phases && state.phases[phase.id] && state.phases[phase.id].gateApproved),
    });
  }
  stages.push({
    id: 'next',
    label: 'next',
    active: false,
    done: false,
  });
  // Mark earlier stages done when later ones are active.
  const activeIdx = stages.findIndex((s) => s.active);
  if (activeIdx > 0) {
    for (let i = 0; i < activeIdx; i++) {
      if (stages[i].id === 'plan' && mode !== 'plan') continue;
      if (stages[i].id === 'develop' && mode === 'plan' && step === 'run') continue;
      stages[i].done = true;
      stages[i].active = false;
    }
  }
  // Freeze on terminal / paused loops — never leave plan/develop "active".
  const status = state && state.status ? String(state.status) : '';
  if (TERMINAL_STATUSES.has(status) || status === 'paused' || status === 'needs_human') {
    for (const s of stages) {
      s.active = false;
      if (status === 'completed') s.done = true;
    }
  }
  return stages;
}

function buildPhasePipeline(state) {
  const phases = (state.definition && state.definition.phases) || [];
  return phases.map((p, i) => {
    const ps = (state.phases && state.phases[p.id]) || {};
    const current = i === state.phaseIndex;
    // plan-next stays "running" while the rounds it planned run; show that.
    const cur = phases[state.phaseIndex];
    const roundRunning =
      p.type === 'plan-next' && !current && ps.status === 'running' && cur && cur.planned ? cur.id : null;
    const evalScore =
      ps.evalScore != null && Number.isFinite(Number(ps.evalScore))
        ? Number(ps.evalScore)
        : extractEvalScore(ps.lastEval);
    return {
      id: p.id,
      index: i,
      type: p.type || 'run',
      planned: Boolean(p.planned),
      status: roundRunning ? 'waiting' : ps.status || 'pending',
      ...(roundRunning ? { roundRunning } : {}),
      gate: p.gate || null,
      gateApproved: Boolean(ps.gateApproved),
      sessionId: ps.sessionId || null,
      sessionTitle: ps.sessionTitle || p.session || null,
      parentSessionId: state.loopRootSessionId || null,
      role: 'worker',
      attempts: ps.attempts || 0,
      engine: ps.engine || p.engine || null,
      failovers: Array.isArray(ps.failovers) ? ps.failovers.map((f) => ({ ...f })) : [],
      current,
      step: current ? state.step : ps.status === 'passed' ? 'done' : 'pending',
      evalScore: evalScore != null ? evalScore : null,
      lastEval: formatEvalTail(ps.lastEval),
    };
  });
}

function budgetSnapshot(state, nowMs = Date.now()) {
  const budget = (state.definition && state.definition.budget) || {};
  const hoursUsed = hoursElapsed(state, nowMs);
  const phaseCount =
    (state.definition && state.definition.phases && state.definition.phases.length) || 0;
  let tokensUsed = null;
  if (state.usage && state.usage.totalTokens != null && Number.isFinite(Number(state.usage.totalTokens))) {
    tokensUsed = Math.floor(Number(state.usage.totalTokens));
  }
  return {
    maxRuns: budget.maxRuns != null ? budget.maxRuns : null,
    maxHours: budget.maxHours != null ? budget.maxHours : null,
    maxPhases: budget.maxPhases != null ? budget.maxPhases : null,
    maxTokens: budget.maxTokens != null ? budget.maxTokens : null,
    runsUsed: state.runsUsed || 0,
    hoursUsed: Math.round(hoursUsed * 1000) / 1000,
    phasesUsed: phaseCount,
    tokensUsed,
  };
}

/** Elapsed ms shown for a loop: active run time (idle gaps excluded). */
function elapsedMsOf(state, nowMs = Date.now()) {
  if (!state || !state.startedAt) return 0;
  return activeElapsedMs(state, nowMs);
}

/**
 * Strip leading plan-mode / pkill safety phrases from a single line.
 * Handles both whole-line preambles and same-line prefixes
 * ("Do not switch to plan mode. You are running…").
 */
function stripLeadingPreambleFromLine(line) {
  let s = String(line == null ? '' : line).trim();
  if (!s) return '';
  for (let n = 0; n < 4 && s; n++) {
    let hit = false;
    for (const re of PROMPT_PREAMBLE_PREFIXES) {
      if (re.test(s)) {
        s = s.replace(re, '').trim();
        hit = true;
        break;
      }
    }
    if (hit) continue;
    // Whole-line only (no trailing body).
    if (/^do not switch to plan mode\.?$/i.test(s)) return '';
    if (/^never use pkill\/killall\b[^.]*\.?$/i.test(s)) return '';
    break;
  }
  return s;
}

/**
 * Strip the standard plan-mode / pkill safety preamble from prompt excerpts.
 * Keeps the full prompt intact for engine runs — display/preview only.
 */
function stripPromptPreamble(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);
  let i = 0;
  // Skip a leading blank line, then consecutive known preamble lines / prefixes.
  while (i < lines.length && !String(lines[i]).trim()) i += 1;
  let stripped = 0;
  while (i < lines.length && stripped < PROMPT_PREAMBLE_LINES.length + 2) {
    const original = String(lines[i]);
    const trimmed = original.trim();
    if (!trimmed) break;
    const rest = stripLeadingPreambleFromLine(trimmed);
    if (rest === trimmed) break; // no preamble on this line
    stripped += 1;
    if (rest) {
      // Same-line case: keep the remainder and stop stripping further lines.
      lines[i] = rest;
      break;
    }
    i += 1;
  }
  while (i < lines.length && !String(lines[i]).trim()) i += 1;
  return lines.slice(i).join('\n');
}

function promptExcerpt(text, max = 200) {
  return truncateText(stripPromptPreamble(text), max);
}

/**
 * Resolve a promptFile path: absolute as-is; relative prefers the definition
 * directory, then the loop cwd, then process.cwd().
 */
function resolvePromptFilePath(promptFile, opts = {}) {
  const expanded = expandUserPath(String(promptFile || '').trim());
  if (!expanded) return null;
  if (path.isAbsolute(expanded)) return expanded;
  const bases = [];
  if (opts.definitionDir) bases.push(opts.definitionDir);
  if (opts.baseDir) bases.push(opts.baseDir);
  if (opts.cwd) bases.push(opts.cwd);
  bases.push(process.cwd());
  const seen = new Set();
  for (const base of bases) {
    if (!base) continue;
    const absBase = path.resolve(base);
    if (seen.has(absBase)) continue;
    seen.add(absBase);
    const candidate = path.resolve(absBase, expanded);
    if (fs.existsSync(candidate)) return resolveCwd(candidate);
  }
  const fallbackBase =
    opts.definitionDir || opts.baseDir || opts.cwd || process.cwd();
  return resolveCwd(path.resolve(fallbackBase, expanded));
}

/**
 * Resolve relative companion scripts in eval.command against the definition dir
 * when the file exists there (e.g. improve-gate.js next to the loop JSON).
 */
function resolveEvalCommandPaths(command, opts = {}) {
  const definitionDir = opts.definitionDir || opts.baseDir || null;
  if (!definitionDir) return command;
  const resolveOne = (token) => {
    const s = String(token);
    if (!s || s.startsWith('-') || path.isAbsolute(s)) return s;
    // Only rewrite path-like tokens (has slash or known script suffix).
    if (!/[\\/]/.test(s) && !/\.(js|mjs|cjs|sh|bash|py)$/i.test(s)) return s;
    const candidate = path.resolve(definitionDir, expandUserPath(s));
    if (fs.existsSync(candidate)) return candidate;
    return s;
  };
  if (Array.isArray(command)) return command.map(resolveOne);
  if (typeof command === 'string') {
    // String form runs via sh -c — leave intact unless the whole string is a path.
    const trimmed = command.trim();
    if (!trimmed.includes(' ') && !trimmed.includes('\t')) {
      return resolveOne(trimmed);
    }
    return command;
  }
  return command;
}

/**
 * Best-effort parse of an eval overall score from phase lastEval output.
 * Never invents numbers — only extracts when present.
 */
function extractEvalScore(lastEval) {
  if (!lastEval || typeof lastEval !== 'object') return null;
  const text = [lastEval.stdout, lastEval.stderr].filter(Boolean).join('\n');
  if (!text.trim()) return null;
  const tryObj = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.overall != null && Number.isFinite(Number(obj.overall))) {
      return Math.round(Number(obj.overall) * 10) / 10;
    }
    if (obj.after != null && Number.isFinite(Number(obj.after))) {
      return Math.round(Number(obj.after) * 10) / 10;
    }
    if (obj.score != null && Number.isFinite(Number(obj.score))) {
      return Math.round(Number(obj.score) * 10) / 10;
    }
    return null;
  };
  try {
    const direct = tryObj(JSON.parse(text));
    if (direct != null) return direct;
  } catch (_) {
    /* not pure JSON */
  }
  // Find the last JSON object in the text that carries a score field.
  const matches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (matches) {
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const scored = tryObj(JSON.parse(matches[i]));
        if (scored != null) return scored;
      } catch (_) {
        /* skip */
      }
    }
  }
  const m = text.match(/"overall"\s*:\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return Math.round(n * 10) / 10;
  }
  return null;
}

/**
 * Roll up usage-summary.json from phase (and loop-root) sessions onto state.usage.
 */
function refreshLoopUsage(state) {
  if (!state) return null;
  let usageLib;
  let turnsLib;
  try {
    usageLib = require('./usage');
    turnsLib = require('./turns');
  } catch (_) {
    return state.usage || null;
  }
  const summaries = [];
  const seen = new Set();
  const addSession = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    try {
      const summary = turnsLib.readUsageSummary(id);
      if (summary) summaries.push(summary);
    } catch (_) {
      /* ignore */
    }
  };
  if (state.loopRootSessionId) addSession(state.loopRootSessionId);
  const phases = state.phases && typeof state.phases === 'object' ? state.phases : {};
  for (const ps of Object.values(phases)) {
    if (ps && ps.sessionId) addSession(ps.sessionId);
  }
  const merged = usageLib.mergeUsageSummaries(summaries, {
    updatedAt: nowIso(),
  });
  state.usage = merged
    ? usageLib.compactUsageSummary(merged) || merged
    : null;
  return state.usage;
}

const _sessionUsageCache = new Map();

/** De-duplicated usage for one session from turns.jsonl (read-only, mtime-cached). */
function sessionUsageReadOnly(sessionId, usageLib, turnsLib) {
  let file;
  try {
    file = path.join(fleetDir(), 'runs', String(sessionId), 'turns.jsonl');
  } catch (_) {
    return null;
  }
  let sig = '-';
  try {
    const st = fs.statSync(file);
    sig = st.size + ':' + st.mtimeMs;
  } catch (_) {
    /* no turns file */
  }
  const hit = _sessionUsageCache.get(file);
  if (hit && hit.sig === sig) return hit.value;
  let value = null;
  if (sig !== '-') {
    try {
      value = usageLib.summarizeSessionUsage(turnsLib.readTurns(sessionId));
    } catch (_) {
      value = null;
    }
  } else {
    try {
      value = turnsLib.readUsageSummary(sessionId);
    } catch (_) {
      value = null;
    }
  }
  _sessionUsageCache.set(file, { sig, value });
  return value;
}

/**
 * Usage shown for a loop (dashboard / loop status). Recomputed at read time
 * from each phase session's turns (de-duplicated, so loops recorded before
 * the double-count fix show corrected totals) and never written back. When
 * the turns carry no credits (Copilot runs synced before credits were
 * recorded), credits / usd come from the per-call usage records the making-of
 * page uses (Copilot events.jsonl / calls.jsonl). Nothing is estimated.
 * storedTotalTokens is set when the state file's rollup disagrees.
 */
function loopUsageForDisplay(state, opts = {}) {
  if (!state) return null;
  const usageLib = require('./usage');
  const turnsLib = require('./turns');
  const ids = loopSessionIds(state);
  const summaries = [];
  for (const id of ids) {
    const s = sessionUsageReadOnly(id, usageLib, turnsLib);
    if (s && (s.turnCount || s.totalTokens != null)) summaries.push(s);
  }
  const merged = summaries.length ? usageLib.mergeUsageSummaries(summaries) : null;
  let out = merged ? usageLib.compactUsageSummary(merged) || merged : state.usage ? { ...state.usage } : null;
  let calls = null;
  try {
    calls = require('./making-of').costTotalsForSessions(ids, { env: opts.env || process.env });
  } catch (_) {
    calls = null;
  }
  if (calls && calls.credits != null) {
    if (!out) out = { totalTokens: calls.totalTokens, accuracy: 'reported', turnCount: 0 };
    if (out.credits == null) {
      out.credits = calls.credits;
      out.usd = calls.usd;
      out.costBasis = calls.costBasis;
      out.creditsSource = 'per-call';
    }
    out.calls = calls.calls;
    out.callsWithCost = calls.callsWithCost;
  }
  if (out && merged) {
    const stored = state.usage && state.usage.totalTokens != null ? Number(state.usage.totalTokens) : null;
    if (stored != null && out.totalTokens != null && stored !== Number(out.totalTokens)) {
      out.storedTotalTokens = stored;
      out.recomputed = true;
    }
  }
  return out;
}

/**
 * Cost so far for a loop: recorded credits / dollars (Copilot), active run
 * time, and tokens. Nothing is estimated: engines that record no cost
 * (Cursor) report costKnown=false and "cost unknown".
 */
function costSoFar(state, opts = {}) {
  if (!state) return null;
  let usage = null;
  try {
    usage = opts.usage !== undefined ? opts.usage : loopUsageForDisplay(state, opts);
  } catch (_) {
    usage = state.usage || null;
  }
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const credits = usage ? num(usage.credits) : null;
  const usd = usage ? num(usage.usd) : null;
  const totalTokens = usage ? num(usage.totalTokens) : null;
  let activeMs = 0;
  try {
    activeMs = activeElapsedMs(state, opts.nowMs != null ? opts.nowMs : Date.now());
  } catch (_) {
    activeMs = 0;
  }
  const engines = [];
  const def = state.definition || {};
  for (const p of def.phases || []) {
    const ps = state.phases && state.phases[p.id];
    if (!ps || !ps.sessionId) continue;
    const e = ps.engine || p.engine || def.engine;
    if (e && !engines.includes(e)) engines.push(e);
  }
  if (!engines.length && def.engine) engines.push(def.engine);
  const costKnown = credits != null || usd != null;
  const activeHours = Math.round((activeMs / 3600000) * 100) / 100;
  const bits = [];
  if (credits != null) {
    bits.push(`${credits < 10 ? credits.toFixed(2) : credits.toFixed(1)} credits` + (usd != null ? ' · $' + usd.toFixed(2) : ''));
  } else if (usd != null) {
    bits.push('$' + usd.toFixed(2));
  } else {
    bits.push(`cost unknown (${engines.join('/') || 'engine'} recorded no cost)`);
  }
  const mins = activeMs / 60000;
  bits.push(mins < 90 ? `${Math.round(mins)}m active` : `${(mins / 60).toFixed(1)}h active`);
  if (totalTokens != null) {
    bits.push(
      (totalTokens >= 1e6
        ? `${(totalTokens / 1e6).toFixed(1)}M`
        : totalTokens >= 1e3
          ? `${Math.round(totalTokens / 1e3)}k`
          : String(totalTokens)) + ' tok'
    );
  }
  return {
    costKnown,
    credits,
    usd,
    totalTokens,
    activeMs,
    activeHours,
    runsUsed: state.runsUsed || 0,
    engines,
    text: bits.join(' · '),
  };
}

function loopSessionIds(state) {
  const ids = [];
  const add = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(state && state.loopRootSessionId);
  const phases = state && state.phases && typeof state.phases === 'object' ? state.phases : {};
  for (const ps of Object.values(phases)) add(ps && ps.sessionId);
  return ids;
}

/**
 * Engine/model shown for a loop: the engine the current phase actually runs
 * on (after any `engines` failover), else definition, else first phase, else
 * the worker sessions the loop actually created, else env/config defaults.
 */
function resolveLoopEngineModel(state, env = process.env) {
  const def = (state && state.definition) || {};
  const phases = Array.isArray(def.phases) ? def.phases : [];
  const phaseStates = (state && state.phases) || {};
  const current = state && state.phaseId ? phaseStates[state.phaseId] : null;
  let engine = (current && current.engine) || def.engine || null;
  if (!engine) {
    const hit = phases.find((p) => p && p.engine);
    engine = hit ? hit.engine : null;
  }
  let model = def.model || null;
  if (!model) {
    const hit = phases.find((p) => p && p.model);
    model = hit ? hit.model : null;
  }
  if (!engine || !model) {
    for (const id of loopSessionIds(state)) {
      const session = loadBoundSession(id);
      if (!session) continue;
      if (!engine && session.engine) engine = session.engine;
      if (!model && session.model) model = session.model;
      if (engine && model) break;
    }
  }
  if (!engine) {
    try {
      engine = engineLib.resolveEngine({ env }).engine;
    } catch (_) {
      engine = null;
    }
  }
  if (!model) {
    try {
      model = resolvePhaseModel(phases[0] || null, { ...def, engine }, env) || null;
    } catch (_) {
      model = null;
    }
  }
  return { engine: engine || null, model: model || null };
}

/**
 * In-process `aflt loop run` never sets `active`; a live runner lock pid on a
 * non-terminal loop means the loop is running right now.
 */
function isRunnerLive(state, info) {
  if (!state || TERMINAL_STATUSES.has(state.status)) return false;
  return Boolean(info && info.alive);
}

/**
 * Registry session id → 'completed' | 'failed' for sessions whose loop work is
 * finished (all their phases passed/failed, or a terminal loop root). Used by
 * the dashboard so idle worker sessions show their real outcome.
 */
function collectSessionOutcomes(names = null) {
  const outcomes = {};
  for (const name of names || listLoopNames()) {
    let state;
    try {
      state = loadState(name);
    } catch (_) {
      continue;
    }
    if (!state) continue;
    const bySession = new Map();
    const phases = state.phases && typeof state.phases === 'object' ? state.phases : {};
    for (const ps of Object.values(phases)) {
      if (!ps || !ps.sessionId) continue;
      if (!bySession.has(ps.sessionId)) bySession.set(ps.sessionId, []);
      bySession.get(ps.sessionId).push(ps.status);
    }
    for (const [id, statuses] of bySession) {
      if (statuses.some((st) => st === 'pending' || st === 'running')) continue;
      if (statuses.includes('failed')) outcomes[id] = 'failed';
      else if (statuses.includes('passed')) outcomes[id] = 'completed';
    }
    if (state.loopRootSessionId) {
      if (state.status === 'completed') outcomes[state.loopRootSessionId] = 'completed';
      else if (
        state.status === 'failed' ||
        state.status === 'stopped' ||
        state.status === 'needs_human'
      ) {
        outcomes[state.loopRootSessionId] = 'failed';
      }
    }
  }
  return outcomes;
}

function summarizeLoopState(state, lock = null) {
  const info = lock || (state ? readLockInfo(state.name) : null);
  const runnerLive = isRunnerLive(state, info);
  const engineModel = resolveLoopEngineModel(state);
  const budget = budgetSnapshot(state);
  let usage = null;
  try {
    usage = loopUsageForDisplay(state);
  } catch (_) {
    usage = state.usage || null;
  }
  const activity = lastActivityOf(state);
  return {
    name: state.name,
    status: state.status,
    active: Boolean(state.active) || runnerLive,
    runnerPid: runnerLive ? info.pid : null,
    engine: engineModel.engine,
    model: engineModel.model,
    phaseId: state.phaseId,
    phaseIndex: state.phaseIndex,
    round: improveRoundOf(state),
    lastActivityAt: activity.at,
    lastActivitySource: activity.source,
    attempt: state.attempt,
    step: state.step,
    runsUsed: state.runsUsed,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt || null,
    failedAt: state.failedAt || null,
    stoppedAt: state.stoppedAt || null,
    pausedAt: state.pausedAt || null,
    needsHumanAt: state.needsHumanAt || null,
    escalationFailedRounds: state.escalationFailedRounds || 0,
    elapsedMs: elapsedMsOf(state),
    wallElapsedMs: wallElapsedMsOf(state),
    budget,
    usage: usage || null,
    gate:
      state.gate && state.gate.waiting
        ? { ...state.gate, costSoFar: costSoFar(state, { usage }) || state.gate.costSoFar || null }
        : state.gate || null,
    loopRootSessionId: state.loopRootSessionId || null,
    loopRootSessionTitle: state.loopRootSessionTitle || null,
    project: state.definition && state.definition.project,
    goal: state.definition && state.definition.goal ? state.definition.goal : null,
    acceptance:
      state.definition && state.definition.acceptance
        ? state.definition.acceptance
        : null,
    plannedPhaseGate:
      (state.definition && state.definition.plannedPhaseGate) ||
      DEFAULT_PLANNED_PHASE_GATE,
    cwd: state.definition && state.definition.cwd
      ? memory.redactSensitive(String(state.definition.cwd))
      : null,
    phaseCount: state.definition && Array.isArray(state.definition.phases)
      ? state.definition.phases.length
      : 0,
    stopRequested: Boolean(state.stopRequested),
    pauseRequested: Boolean(state.pauseRequested),
    lastError: state.lastError
      ? memory.redactSensitive(String(state.lastError))
      : null,
    lockAlive: Boolean(info && info.alive),
    schedulerCandidate: isSchedulerCandidate(state, info),
    definitionPath: state.definitionPath || null,
  };
}

/**
 * Resolve the directory where UI-saved loop definitions are written.
 * Default: `$AGENTFLEET_HOME/loops/definitions`. Override with
 * `config.json` `loop.definitionsDir` / `loop.dir` / top-level `loopsDir`,
 * or `opts.definitionsDir`.
 */
function resolveDefinitionsDir(opts = {}) {
  if (opts.definitionsDir != null && String(opts.definitionsDir).trim()) {
    return path.resolve(expandUserPath(String(opts.definitionsDir).trim()));
  }
  const data = config.load();
  const loopCfg =
    data && data.loop && typeof data.loop === 'object' && !Array.isArray(data.loop)
      ? data.loop
      : {};
  const configured =
    (loopCfg.definitionsDir != null && String(loopCfg.definitionsDir).trim()) ||
    (loopCfg.dir != null && String(loopCfg.dir).trim()) ||
    (data && data.loopsDir != null && String(data.loopsDir).trim()) ||
    null;
  if (configured) {
    return path.resolve(expandUserPath(configured));
  }
  return path.join(loopsRoot(), 'definitions');
}

function allowedLoopRoots(opts = {}) {
  const roots = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!roots.includes(abs)) roots.push(abs);
  };
  add(loopsRoot());
  add(resolveDefinitionsDir(opts));
  return roots;
}

/**
 * Resolve a path for containment checks. Walks up to an existing ancestor so
 * not-yet-created files still normalize like their parent (macOS /var →
 * /private/var via realpath).
 */
function realpathOrSelf(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch (_) {
    /* fall through */
  }
  let cur = abs;
  const parts = [];
  while (cur && cur !== path.dirname(cur)) {
    parts.unshift(path.basename(cur));
    cur = path.dirname(cur);
    try {
      return path.join(fs.realpathSync(cur), ...parts);
    } catch (_) {
      /* keep walking */
    }
  }
  return abs;
}

function isPathInsideRoot(filePath, rootPath) {
  const file = realpathOrSelf(filePath);
  const root = realpathOrSelf(rootPath);
  if (file === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return file.startsWith(prefix);
}

function assertPathInAllowedRoots(filePath, opts = {}) {
  const abs = path.resolve(expandUserPath(String(filePath || '')));
  const roots = allowedLoopRoots(opts);
  if (roots.some((root) => isPathInsideRoot(abs, root))) {
    return abs;
  }
  const err = new Error(
    'path must be under $AGENTFLEET_HOME/loops or the configured loops/definitions dir'
  );
  err.code = 'LOOP_PATH';
  throw err;
}

/**
 * Serialize a validated definition to a portable JSON object for disk.
 */
function definitionToWritable(definition, raw) {
  const phases = (definition.phases || []).map((p, i) => {
    const src = raw && Array.isArray(raw.phases) ? raw.phases[i] : null;
    const out = {
      id: p.id,
      engine: p.engine,
      session: p.session,
      maxFixAttempts: p.maxFixAttempts,
      onPass: p.onPass,
      force: p.force,
    };
    if (p.type && p.type !== 'run') out.type = p.type;
    if (p.planned) out.planned = true;
    if (p.type !== 'plan-next') {
      out.eval = {
        command: p.eval.command,
        exitCode: p.eval.exitCode,
      };
      if (p.eval.passRegex) out.eval.passRegex = p.eval.passRegex;
      if (p.eval.cwd) out.eval.cwd = p.eval.cwd;
      if (p.eval.timeoutSec != null && p.eval.timeoutSec !== 300) {
        out.eval.timeoutSec = p.eval.timeoutSec;
      }
    }
    if (p.mode) out.mode = p.mode;
    if (p.model) out.model = p.model;
    if (p.improveModel) out.improveModel = p.improveModel;
    if (p.timeoutSec != null) out.timeoutSec = p.timeoutSec;
    if (p.idleTimeoutSec != null) out.idleTimeoutSec = p.idleTimeoutSec;
    if (p.gate) out.gate = p.gate;
    if (p.protected) out.protected = { paths: p.protected.paths };
    if (p.prompt != null) {
      out.prompt = p.prompt;
    } else if (p.promptFile) {
      // Prefer the original relative promptFile when provided.
      if (src && src.promptFile) {
        out.promptFile = String(src.promptFile);
        // Never store an absolute path into the project; keep it project-relative.
        if (path.isAbsolute(out.promptFile) && definition.cwd && require('./loop-snapshot').isInside(out.promptFile, definition.cwd)) {
          out.promptFile = path.relative(definition.cwd, out.promptFile);
        }
      } else {
        try {
          out.promptFile = path.relative(definition.cwd, p.promptFile) || p.promptFile;
        } catch (_) {
          out.promptFile = p.promptFile;
        }
      }
    }
    return out;
  });

  const out = {
    name: definition.name,
    engine: definition.engine,
    allow: definition.allow,
    budget: definition.budget,
    plannedPhaseGate: definition.plannedPhaseGate || DEFAULT_PLANNED_PHASE_GATE,
    phases,
  };
  if (definition.project) out.project = definition.project;
  if (definition.engines && definition.engines.length) out.engines = definition.engines;
  if (definition.model) out.model = definition.model;
  if (definition.improveModel) out.improveModel = definition.improveModel;
  if (definition.idleTimeoutSec != null) out.idleTimeoutSec = definition.idleTimeoutSec;
  if (definition.force === true) out.force = true;
  if (definition.goal) out.goal = definition.goal;
  if (definition.acceptance) out.acceptance = definition.acceptance;
  if (definition.acceptanceEval) {
    out.acceptanceEval = {
      command: definition.acceptanceEval.command,
      exitCode: definition.acceptanceEval.exitCode,
    };
    if (definition.acceptanceEval.passRegex) {
      out.acceptanceEval.passRegex = definition.acceptanceEval.passRegex;
    }
  }
  if (definition.protected) out.protected = definition.protected;
  if (definition.commitGate) out.commitGate = definition.commitGate;
  if (definition.verify) out.verify = definition.verify;
  if (definition.workdir && definition.workdir.mode !== 'fresh') {
    out.workdir = raw && raw.workdir && typeof raw.workdir === 'object' ? raw.workdir : definition.workdir;
  }
  if (raw && raw.cwd != null && String(raw.cwd).trim()) out.cwd = String(raw.cwd).trim();
  else if (definition.cwd && !(out.workdir && out.workdir.path)) out.cwd = definition.cwd;
  return out;
}

/**
 * Validate and write a loop definition under the allowed loops/definitions dir.
 * Never writes outside those roots.
 */
function saveDefinition(raw, opts = {}) {
  const validated = validateDefinition(raw, {
    ...opts,
    // Saving from the UI may happen before cwd exists on another machine; still
    // require a resolvable shape but allow missing cwd when checkCwd is false.
    checkCwd: opts.checkCwd !== undefined ? opts.checkCwd : true,
    checkPromptFiles:
      opts.checkPromptFiles !== undefined ? opts.checkPromptFiles : true,
  });
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, warnings: validated.warnings || [] };
  }
  const dir = resolveDefinitionsDir(opts);
  // Ensure the resolved dir itself is under an allowed root (or *is* the configured root).
  const roots = allowedLoopRoots(opts);
  const dirAllowed = roots.some(
    (root) => isPathInsideRoot(dir, root) || path.resolve(dir) === path.resolve(root)
  );
  if (!dirAllowed) {
    return {
      ok: false,
      errors: ['definitions directory is outside the allowed loops roots'],
    };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${validated.definition.name}.json`);
  try {
    assertPathInAllowedRoots(file, opts);
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
  const body = definitionToWritable(validated.definition, raw);
  atomicWriteJson(file, body);
  // Also refresh the per-loop snapshot when state already exists.
  try {
    if (fs.existsSync(statePath(validated.definition.name))) {
      atomicWriteJson(definitionSnapshotPath(validated.definition.name), validated.definition);
    }
  } catch (_) {
    /* ignore */
  }
  return {
    ok: true,
    path: file,
    definition: validated.definition,
    writable: body,
    warnings: validated.warnings || [],
  };
}

function listSavedDefinitions(opts = {}) {
  const dir = resolveDefinitionsDir(opts);
  const out = [];
  if (!fs.existsSync(dir)) {
    return { ok: true, dir, definitions: out };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: err.message, dir, definitions: out };
  }
  for (const ent of entries) {
    if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue;
    const file = path.join(dir, ent.name);
    try {
      assertPathInAllowedRoots(file, opts);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({
        name: raw && raw.name ? String(raw.name) : path.basename(ent.name, '.json'),
        path: file,
        phaseCount: raw && Array.isArray(raw.phases) ? raw.phases.length : 0,
        project: raw && raw.project ? String(raw.project) : null,
        engine: raw && raw.engine ? String(raw.engine) : null,
        updatedAt: (() => {
          try {
            return fs.statSync(file).mtime.toISOString();
          } catch (_) {
            return null;
          }
        })(),
      });
    } catch (_) {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { ok: true, dir, definitions: out };
}

function loadSavedDefinition(name, opts = {}) {
  const safe = safeLoopName(name);
  const file = path.join(resolveDefinitionsDir(opts), `${safe}.json`);
  try {
    assertPathInAllowedRoots(file, opts);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!fs.existsSync(file)) {
    // Fall back to per-loop snapshot.
    const snap = definitionSnapshotPath(safe);
    if (fs.existsSync(snap)) {
      try {
        const raw = JSON.parse(fs.readFileSync(snap, 'utf8'));
        return { ok: true, path: snap, definition: raw, source: 'snapshot' };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: `no saved definition for "${safe}"` };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, path: file, definition: raw, source: 'definitions' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Start a loop from a definition path. When `opts.requireAllowedPath` is true
 * (dashboard), the file must live under an allowed loops root.
 */
function startFromPath(filePath, opts = {}) {
  let abs;
  try {
    abs =
      opts.requireAllowedPath === false
        ? resolveDefinitionPath(filePath)
        : assertPathInAllowedRoots(resolveDefinitionPath(filePath), opts);
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || 'LOOP_PATH' };
  }
  return startFromFile(abs, opts);
}

function statusReport(name, opts = {}) {
  if (name) {
    const safe = safeLoopName(name);
    const state = loadState(safe);
    if (!state) {
      return { ok: false, error: `no loop state for "${safe}"` };
    }
    const lock = readLockInfo(safe);
    const summary = summarizeLoopState(state, lock);
    const currentPhase =
      state.definition &&
      Array.isArray(state.definition.phases) &&
      state.definition.phases[state.phaseIndex]
        ? state.definition.phases[state.phaseIndex]
        : null;
    const currentPhaseState =
      currentPhase && state.phases ? state.phases[currentPhase.id] : null;
    return {
      ok: true,
      ...summary,
      lock,
      phases: state.phases,
      pipeline: buildPhasePipeline(state),
      steps: buildStepPipeline(state),
      currentEval: formatEvalTail(currentPhaseState && currentPhaseState.lastEval),
      historyTail: Array.isArray(state.history) ? state.history.slice(-10) : [],
      definition: state.definition
        ? {
            name: state.definition.name,
            project: state.definition.project,
            cwd: state.definition.cwd
              ? memory.redactSensitive(String(state.definition.cwd))
              : null,
            engine: summary.engine,
            model: summary.model,
            allow: state.definition.allow,
            budget: state.definition.budget,
            phases: (state.definition.phases || []).map((p) => ({
              id: p.id,
              engine: p.engine,
              session: p.session,
              gate: p.gate || null,
              maxFixAttempts: p.maxFixAttempts,
              onPass: p.onPass,
              mode: p.mode || null,
              force: p.force,
              hasPrompt: Boolean(p.prompt),
              promptFile: p.promptFile || null,
              eval: p.eval
                ? {
                    command: p.eval.command,
                    exitCode: p.eval.exitCode,
                    passRegex: p.eval.passRegex || null,
                  }
                : null,
            })),
          }
        : null,
    };
  }

  const names = listLoopNames();
  const loops = names.map((n) => {
    try {
      const s = loadState(n);
      if (!s) return { name: n, status: 'unknown' };
      return summarizeLoopState(s, readLockInfo(n));
    } catch (err) {
      return { name: n, status: 'error', error: err.message };
    }
  });
  return { ok: true, loops };
}

module.exports = {
  resolveIdleTimeoutSec,
  parseIdleTimeoutSec,
  newestMtimeMs,
  recordLoopActivity,
  readLoopActivity,
  lastActivityOf,
  improveRoundOf,
  activityPath,
  DEFAULT_IDLE_TIMEOUT_SEC,
  recordVerification: commitGate.recordVerification,
  STATE_VERSION,
  DEFAULT_MAX_FIX_ATTEMPTS,
  ON_PASS_ACTIONS,
  LOOP_STATUSES,
  PHASE_STATUSES,
  PHASE_GATES,
  PHASE_TYPES,
  DEFAULT_PLANNED_PHASE_GATE,
  PLAN_NEXT_FILENAME,
  TERMINAL_STATUSES,
  RESERVED_LOOP_ROUTE_NAMES,
  EVAL_TAIL_CAP,
  loopsRoot,
  safeLoopName,
  loopDir,
  statePath,
  lockPath,
  definitionSnapshotPath,
  planNextOutputPath,
  needsHumanPath,
  acquireRunnerLock,
  releaseRunnerLock,
  readLockInfo,
  loadState,
  saveState,
  listLoopNames,
  listSchedulerCandidates,
  isSchedulerCandidate,
  loadDefinitionFile,
  projectRootFromDefinitionDir,
  validateDefinition,
  validateFile,
  createInitialState,
  planDryRun,
  engineBinaryProblems,
  runLoop,
  runFromFile,
  startFromFile,
  startFromPath,
  resumeLoop,
  requestResume,
  requestPause,
  requestStop,
  requestApprove,
  statusReport,
  summarizeLoopState,
  collectSessionOutcomes,
  resolveLoopEngineModel,
  buildPhasePipeline,
  buildStepPipeline,
  formatEvalTail,
  resolveDefinitionsDir,
  allowedLoopRoots,
  assertPathInAllowedRoots,
  saveDefinition,
  listSavedDefinitions,
  loadSavedDefinition,
  definitionToWritable,
  resolveHeartbeatMs,
  resolvePhasePrompt,
  buildFixPrompt,
  buildPlanNextPrompt,
  buildPlanNextFixPrompt,
  parsePlanNextPayload,
  readPlanNextFile,
  insertPlannedPhases,
  buildAcceptanceSummary,
  evalPassed,
  isInfraEvalFailure,
  parseEvalJsonFromResult,
  readLastProjectEvalOverall,
  resolvePlanNextTarget,
  runEval,
  runSessionPrompt,
  loopPhaseWriteGrants,
  ensureSession,
  resolvePhaseModel,
  inspectLoopWorkdir,
  agentRunFailed,
  normalizeModel,
  ensureLoopRootSession,
  recordMemoryTransition,
  buildLoopNotifyPayload,
  emitLoopNotify,
  runOnPassAction,
  budgetExceeded,
  markLoopPaused,
  buildNeedsHumanBundle,
  finishLoopAfterPhaseFailure,
  prepareResumeFromNeedsHuman,
  normalizeEscalation,
  stripPromptPreamble,
  promptExcerpt,
  resolvePromptFilePath,
  resolveEvalCommandPaths,
  extractEvalScore,
  refreshLoopUsage,
  loopUsageForDisplay,
  costSoFar,
  resolveImproveModel,
  elapsedEndMs,
  activeElapsedMs,
  // test hooks
  _test: {
    normalizeAllow,
    normalizeBudget,
    normalizePhase,
    normalizePlannedPhaseGate,
    truncateText,
    hoursElapsed,
    elapsedEndMs,
    tryBreakStaleLock,
    parseLockPayload,
    reapRecordedRunnerChildren,
    recordLockChildProcess,
    isPathInsideRoot,
    budgetSnapshot,
    budgetExceeded,
    elapsedMsOf,
    activeElapsedMs,
    wallElapsedMsOf,
    historyActiveMs,
    openRunSegment,
    closeRunSegment,
    parsePlanNextPayload,
    insertPlannedPhases,
    stripPromptPreamble,
    promptExcerpt,
    resolvePromptFilePath,
    resolveEvalCommandPaths,
    extractEvalScore,
    refreshLoopUsage,
    resolvePhaseModel,
    inspectLoopWorkdir,
    normalizeWorkdir,
    applyWorkdirGate,
    normalizeModel,
    agentRunFailed,
    permissionSummary,
    evalPassed,
    parseEvalJsonFromResult,
    readLastProjectEvalOverall,
    baselineOverallForNoRegress,
    isInfraEvalFailure,
    resolvePlanNextTarget,
    capturePhaseBaseSha,
    checkEvalCoverage: evalCoverage.checkEvalCoverage,
    protectedFixturesLockSummary: evalCoverage.protectedFixturesLockSummary,
  },
};
