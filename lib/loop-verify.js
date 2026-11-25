'use strict';

/**
 * Cheap-first verify tiers for `aflt loop`: run after a phase eval passes
 * and before onPass. Results are recorded on phaseState.verification[] and
 * checkpointed by commit SHA on loop state.
 */

const fs = require('fs');
const net = require('net');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const commitGate = require('./commit-gate');
const notify = require('./notify');
const runlib = require('./run');
const spaceLib = require('./space');
const { spacesRootDir, expandUserPath, nowIso, envNonEmpty } = require('./util');
const dashboardApi = require('../scripts/eval/dashboard-api');

const BLOCKED_PORTS = new Set([8787, 8792]);
const BLOCKED_LO = 8800;
const BLOCKED_HI = 8820;
const TIER_NAMES = ['tier1', 'tier2', 'tier3'];

const DEFAULT_LOOP_ROUTES = [
  { method: 'GET', path: '/api/state', shape: 'state' },
  { method: 'GET', path: '/api/loops', shape: 'loops' },
  { method: 'GET', path: '/api/loops/definitions', shape: 'definitions' },
  { method: 'GET', path: '/api/loops/:name', shape: 'loopDetail' },
];

function isPortBlocked(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1) return true;
  if (BLOCKED_PORTS.has(p)) return true;
  if (p >= BLOCKED_LO && p <= BLOCKED_HI) return true;
  return false;
}

function findFreePort(deps = {}) {
  const createServer = deps.createServer || net.createServer.bind(net);
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close((err) => {
          if (err) reject(err);
          else if (isPortBlocked(port)) tryOnce();
          else resolve(port);
        });
      });
    };
    tryOnce();
  });
}

function normalizeTier1(raw, dashDefault) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    return { command: raw, dashboard: Boolean(dashDefault) };
  }
  if (typeof raw !== 'object') return { error: 'tier1 must be a command array or object' };
  const command = raw.command != null ? raw.command : null;
  if (!Array.isArray(command) || command.length === 0) {
    return { error: 'tier1.command must be a non-empty argv array' };
  }
  return {
    command,
    dashboard: raw.dashboard != null ? Boolean(raw.dashboard) : Boolean(dashDefault),
    timeoutSec:
      raw.timeoutSec != null && Number.isFinite(Number(raw.timeoutSec))
        ? Math.max(1, Math.floor(Number(raw.timeoutSec)))
        : 7200,
  };
}

function normalizeTier2(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'tier2 must be an object like { "loop": "examples/loops/hello-eval.json" }' };
  }
  const loop = raw.loop != null ? String(raw.loop).trim() : '';
  if (!loop) return { error: 'tier2.loop is required' };
  return {
    loop,
    timeoutSec:
      raw.timeoutSec != null && Number.isFinite(Number(raw.timeoutSec))
        ? Math.max(1, Math.floor(Number(raw.timeoutSec)))
        : 600,
    snapshot: raw.snapshot !== false,
  };
}

function normalizeTier3(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'tier3 must be an object like { "tileDungeon": true, "trials": 2 }' };
  }
  if (!raw.tileDungeon) return { error: 'tier3 requires tileDungeon: true' };
  const trials =
    raw.trials != null && Number.isFinite(Number(raw.trials))
      ? Math.max(1, Math.floor(Number(raw.trials)))
      : 2;
  return {
    tileDungeon: true,
    trials,
    timeoutSec:
      raw.timeoutSec != null && Number.isFinite(Number(raw.timeoutSec))
        ? Math.max(1, Math.floor(Number(raw.timeoutSec)))
        : 3600,
  };
}

function normalizeDashboard(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'verify.dashboard must be an object' };
  }
  let routes = null;
  if (raw.routes != null) {
    if (!Array.isArray(raw.routes)) return { error: 'verify.dashboard.routes must be an array' };
    routes = raw.routes.map((r) => {
      if (typeof r === 'string') return { method: 'GET', path: r, shape: 'auto' };
      if (r && typeof r === 'object') return { ...r };
      return null;
    }).filter(Boolean);
  }
  return {
    routes,
    snapshot: raw.snapshot !== false,
    every: raw.every != null ? String(raw.every) : null,
  };
}

function normalizeVerify(raw, label = 'verify') {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label} must be a JSON object` };
  }
  const dash = normalizeDashboard(raw.dashboard);
  if (dash && dash.error) return { ok: false, error: dash.error };
  const dashEvery = dash && dash.every === 'tier';
  const t1 = normalizeTier1(raw.tier1, dashEvery);
  if (t1 && t1.error) return { ok: false, error: `${label}.${t1.error}` };
  const t2 = normalizeTier2(raw.tier2);
  if (t2 && t2.error) return { ok: false, error: `${label}.${t2.error}` };
  const t3 = normalizeTier3(raw.tier3);
  if (t3 && t3.error) return { ok: false, error: `${label}.${t3.error}` };
  if (!t1 && !t2 && !t3) return { ok: true, value: null };
  return { ok: true, value: { tier1: t1, tier2: t2, tier3: t3, dashboard: dash } };
}

function mergeVerify(loopVerify, phaseVerify) {
  if (!loopVerify && !phaseVerify) return null;
  if (!phaseVerify) return loopVerify;
  if (!loopVerify) return phaseVerify;
  const pick = (key) =>
    Object.prototype.hasOwnProperty.call(phaseVerify, key) ? phaseVerify[key] : loopVerify[key];
  return {
    tier1: pick('tier1'),
    tier2: pick('tier2'),
    tier3: pick('tier3'),
    dashboard: pick('dashboard'),
  };
}

function headSha(cwd, env) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: env || process.env,
    timeout: 30_000,
  });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

/**
 * Fingerprint of uncommitted work (tracked diff vs HEAD + untracked files).
 * '' when the tree is clean or cwd is not a git repo. Checkpoints keyed only
 * by HEAD would wrongly reuse a green tier after a worker edits files without
 * committing (onPass "none" phases), so dirty trees get their own key.
 */
function dirtyFingerprint(cwd, env) {
  const run = (args) =>
    spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      env: env || process.env,
      timeout: 60_000,
      maxBuffer: 256 * 1024 * 1024,
    });
  const diff = run(['diff', 'HEAD', '--binary']);
  if (diff.status !== 0) return '';
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']);
  const names = untracked.status === 0 ? String(untracked.stdout || '').split('\0').filter(Boolean) : [];
  if (!diff.stdout.length && !names.length) return '';
  const h = require('crypto').createHash('sha256');
  h.update(diff.stdout);
  for (const name of names.sort()) {
    h.update('\0' + name + '\0');
    try {
      h.update(fs.readFileSync(path.join(cwd, name)));
    } catch (_) {
      /* unreadable or removed: name only */
    }
  }
  return h.digest('hex').slice(0, 16);
}

/** Checkpoint key: HEAD sha, plus a dirty-tree fingerprint when uncommitted work exists. */
function verifyCheckpointKey(cwd, env, headShaFn = headSha, fingerprintFn = dirtyFingerprint) {
  const sha = headShaFn(cwd, env) || 'unknown';
  const fp = fingerprintFn(cwd, env);
  return fp ? `${sha}+dirty-${fp}` : sha;
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : 'none';
}

function buildRoutes(spec, loopName) {
  const routes = (spec && spec.routes) || DEFAULT_LOOP_ROUTES;
  return routes.map((r) => ({
    ...r,
    path: String(r.path).replace(':name', encodeURIComponent(loopName || '')),
    shape:
      r.shape === 'auto'
        ? r.path && String(r.path).includes(':name')
          ? 'loopDetail'
          : 'state'
        : r.shape,
  }));
}

/** " failed: /api/x (detail), ..." for a dashboard check result, or "". */
function failedRouteSummary(dash) {
  const routes = (dash && Array.isArray(dash.routes) ? dash.routes : []).filter((r) => r && !r.ok);
  if (!routes.length) return '';
  const parts = routes.slice(0, 4).map((r) => {
    const bad = Array.isArray(r.checks) ? r.checks.filter((c) => !c.ok).map((c) => c.detail) : [];
    const why = bad.length ? bad.join(', ') : r.error || (r.status != null ? `status ${r.status}` : 'failed');
    return `${r.path} (${why})`;
  });
  return `; failed: ${parts.join('; ')}`;
}

function checkLoopDetailShape(status, body, expectCompleted) {
  const checks = [];
  if (status !== 200) {
    checks.push({ ok: false, detail: `status ${status} != 200` });
    return { ok: false, checks };
  }
  let json;
  try {
    json = JSON.parse(body);
    checks.push({ ok: true, detail: 'json parse' });
  } catch (err) {
    checks.push({ ok: false, detail: `json parse: ${err.message}` });
    return { ok: false, checks };
  }
  const okFlag = json && json.ok === true;
  const hasName = json && (json.name != null || (json.loop && json.loop.name != null));
  checks.push({ ok: Boolean(okFlag), detail: 'ok:true' });
  checks.push({ ok: Boolean(hasName), detail: 'loop name present' });
  if (expectCompleted) {
    const st = json.status || (json.loop && json.loop.status);
    checks.push({ ok: st === 'completed', detail: `status=${st}` });
    const phases = json.phases || (json.loop && json.loop.phases);
    // /api/loops/:name returns phases keyed by id (object); accept arrays too.
    const phaseCount = Array.isArray(phases)
      ? phases.length
      : phases && typeof phases === 'object'
        ? Object.keys(phases).length
        : 0;
    checks.push({ ok: phaseCount > 0, detail: `phases present (${phaseCount})` });
  }
  return { ok: checks.every((c) => c.ok), checks, json };
}

async function httpGetRoot(port, deps = {}) {
  const request = deps.httpRequest || dashboardApi.httpRequest;
  const res = await request(port, '/');
  const html = res.body || '';
  const ok =
    res.status === 200 &&
    (String(res.headers && res.headers['content-type'] || '').includes('text/html') ||
      /<html/i.test(html));
  return { ok, status: res.status, bytes: Buffer.byteLength(html, 'utf8') };
}

async function runDashboardUiCheck(opts = {}) {
  const loopName = opts.loopName || opts.name;
  const spec = opts.dashboard || {};
  const routes = buildRoutes(spec, loopName);
  const expectCompleted = Boolean(opts.expectCompleted);
  const port = opts.port;
  const extraResults = [];

  const mapped = routes.filter((r) => r.shape !== 'loopDetail');

  const base = await dashboardApi.checkDashboardRoutes({ port, routes: mapped });
  for (const route of routes) {
    if (route.shape !== 'loopDetail') continue;
    let res;
    try {
      res = await dashboardApi.httpRequest(port, route.path, { method: route.method || 'GET' });
    } catch (err) {
      extraResults.push({
        path: route.path,
        ok: false,
        error: String(err.message || err),
      });
      continue;
    }
    const shape = checkLoopDetailShape(res.status, res.body, expectCompleted);
    extraResults.push({
      path: route.path,
      ok: shape.ok,
      checks: shape.checks,
      status: res.status,
    });
  }
  const root = await httpGetRoot(port, opts.deps);
  const allOk = base.ok && extraResults.every((r) => r.ok) && root.ok;
  return {
    ok: allOk,
    port,
    routes: [...base.routes, ...extraResults, { path: '/', ok: root.ok, status: root.status }],
    root,
  };
}

async function startDashboardServe(opts = {}) {
  const afJs = opts.afJs || path.join(opts.packageRoot || path.resolve(__dirname, '..'), 'bin', 'af.js');
  const port = opts.port != null ? opts.port : await findFreePort(opts.deps);
  const env = { ...(opts.env || process.env) };
  if (opts.space) env.AFLT_SPACE = opts.space;
  delete env.AGENTFLEET_HOME;

  const spawnFn = (opts.deps && opts.deps.spawn) || spawn;
  const child = spawnFn(
    process.execPath,
    [afJs, 'dashboard', '--serve', '--host', '127.0.0.1', '--port', String(port), '--json'],
    { cwd: opts.cwd || opts.packageRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
  );
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  const meta = await dashboardApi.waitForServeJson(child, () => stdout, opts.readyTimeoutMs || 20_000);
  return {
    child,
    port: meta.port || port,
    stop: () => dashboardApi.stopChild(child),
  };
}

async function withDashboardServe(opts, fn) {
  let handle = null;
  try {
    if (opts.port != null && typeof opts.stop === 'function') {
      return await fn({ port: opts.port, stop: opts.stop });
    }
    handle = await startDashboardServe(opts);
    return await fn(handle);
  } finally {
    if (handle && handle.stop) await handle.stop();
  }
}

/**
 * aflt checkout whose bin/af.js runs tier1 dashboard and tier2 nested loops.
 * When the loop cwd is itself an aflt checkout (the self-improve loop), use
 * it, so the candidate code is what gets smoked; otherwise the running
 * install. spec.aflt: "candidate" | "runner" overrides.
 */
function isAfltCheckout(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'aflt' && fs.existsSync(path.join(dir, 'bin', 'af.js'));
  } catch (_) {
    return false;
  }
}

function afltRootFor(spec, ctx) {
  const mode = spec && spec.aflt;
  if (mode === 'runner') return ctx.packageRoot;
  if (mode === 'candidate') return ctx.cwd;
  return ctx.cwd && isAfltCheckout(ctx.cwd) ? ctx.cwd : ctx.packageRoot;
}

/**
 * Nested loop definition path: absolute as-is; relative tries the loop cwd
 * (the project under test) first, then the definition's directory.
 */
function resolveNestedLoopPath(loopPath, ctx) {
  if (path.isAbsolute(loopPath)) return loopPath;
  const candidates = [ctx.cwd, ctx.definitionDir].filter(Boolean).map((d) => path.resolve(d, loopPath));
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

async function runTier1(spec, ctx) {
  const command = spec.command;
  const cwd = ctx.cwd;
  const timeoutMs = (spec.timeoutSec || 7200) * 1000;
  const result = await (ctx.runCommand || defaultRunCommand)(command, { cwd, env: ctx.env, timeoutMs });
  const ok = result.code === 0 && !result.timedOut;
  let summary;
  const counts = commitGate.parseNodeTestCounts(`${result.stdout}\n${result.stderr}`);
  if (counts) summary = `${command.join(' ')} ${commitGate.formatCounts(counts)}`;
  else summary = ok ? `${command.join(' ')} ok` : `${command.join(' ')} exit ${result.code}`;

  let dash = null;
  if (ok && spec.dashboard) {
    dash = await withDashboardServe(
      {
        packageRoot: afltRootFor(spec, ctx),
        space: ctx.spaceName || envNonEmpty(ctx.env, 'AFLT_SPACE'),
        env: ctx.env,
        deps: ctx.deps,
      },
      async (h) =>
        runDashboardUiCheck({
          port: h.port,
          loopName: ctx.loopName,
          dashboard: ctx.dashboardSpec,
        })
    );
    if (!dash.ok) {
      return {
        ok: false,
        summary: `${summary}; dashboard FAILED`,
        dashboard: dash,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    summary = `${summary}; dashboard ok`;
  }
  return { ok, summary, dashboard: dash, stdout: result.stdout, stderr: result.stderr, code: result.code };
}

async function defaultRunCommand(command, opts) {
  const bin = command[0];
  const argv = command.slice(1);
  return runlib.spawnCaptured(bin, argv, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    detached: false,
    forwardSignals: true,
  }).then((r) => ({
    code: r.timedOut ? 124 : r.code == null ? 1 : r.code,
    timedOut: Boolean(r.timedOut),
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  }));
}

function gitInitRepo(dir, env) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env, encoding: 'utf8' });
}

async function runTier2(spec, ctx) {
  const mkdtemp = (ctx.deps && ctx.deps.mkdtemp) || fs.mkdtempSync.bind(fs);
  const rmSync = (ctx.deps && ctx.deps.rmSync) || fs.rmSync.bind(fs);
  const tmpParent = ctx.tmpDir || os.tmpdir();
  const repoDir = mkdtemp(path.join(tmpParent, 'aflt-verify-loop-'));
  let spaceCreated = null;
  let keepRepo = false;
  const sha = headSha(ctx.cwd, ctx.env) || 'unknown';
  const spaceName = `self-eval-${shortSha(sha)}-t2`;
  const loopDef = resolveNestedLoopPath(spec.loop, ctx);
  const afltRoot = afltRootFor(spec, ctx);
  const loopJson = JSON.parse(fs.readFileSync(loopDef, 'utf8'));
  const innerName = loopJson.name || path.basename(loopDef, '.json');

  try {
    gitInitRepo(repoDir, ctx.env);
    try {
      const created = spaceLib.createSpace(spaceName, { spacesRoot: ctx.spacesRoot });
      spaceCreated = created.name;
    } catch (err) {
      if (err.code !== 'SPACE_EXISTS') throw err;
    }
    const runEnv = {
      ...ctx.env,
      AFLT_SPACE: spaceName,
      AGENTFLEET_TEST_HERMETIC: '1',
    };
    delete runEnv.AGENTFLEET_HOME;
    // Nested eval loops must not page the outer loop's webhook (aflt-loop-alerts).
    notify.stripNotifyEnv(runEnv);
    const afJs = path.join(afltRoot, 'bin', 'af.js');
    const spawnFn = (ctx.deps && ctx.deps.spawnSync) || spawnSync;
    const runArgs = [
      afJs,
      'loop',
      'run',
      loopDef,
      '--allow-existing',
      '--json',
      ...(ctx.engine ? ['--engine', ctx.engine] : []),
    ];
    const runResult = spawnFn(process.execPath, runArgs, {
      cwd: repoDir,
      env: runEnv,
      encoding: 'utf8',
      timeout: (spec.timeoutSec || 600) * 1000,
    });
    const runOk = runResult.status === 0;

    const dash = await withDashboardServe(
      {
        packageRoot: afltRoot,
        space: spaceName,
        env: runEnv,
        deps: ctx.deps,
      },
      async (h) =>
        runDashboardUiCheck({
          port: h.port,
          loopName: innerName,
          dashboard: ctx.dashboardSpec,
          expectCompleted: runOk,
        })
    );

    let snapshotPath = null;
    if (spec.snapshot && ctx.loopDir) {
      snapshotPath = path.join(ctx.loopDir, `tier2-smoke-${Date.now()}.html`);
      const snap = spawnFn(
        process.execPath,
        [afJs, 'dashboard', '--snapshot', snapshotPath],
        { cwd: afltRoot, env: runEnv, encoding: 'utf8', timeout: 120_000 }
      );
      if (snap.status !== 0 || !fs.existsSync(snapshotPath)) {
        keepRepo = true;
        return {
          ok: false,
          summary: 'tier2 smoke: snapshot failed',
          runOk,
          dashboard: dash,
          repoDir,
        };
      }
    }

    const ok = runOk && dash.ok;
    keepRepo = !ok;
    const summary = ok
      ? `hello-eval smoke ok${snapshotPath ? '; snapshot saved' : ''}`
      : `tier2 smoke FAILED (run=${runOk}, dashboard=${dash.ok}${failedRouteSummary(dash)})`;
    return {
      ok,
      summary,
      dashboard: dash,
      snapshot: snapshotPath,
      space: spaceName,
      repoDir: keepRepo ? repoDir : null,
    };
  } finally {
    if (spaceCreated) {
      try {
        spaceLib.removeSpace(spaceCreated, { spacesRoot: ctx.spacesRoot, force: true });
      } catch (_) {
        /* ignore */
      }
    }
    if (!keepRepo && repoDir && fs.existsSync(repoDir)) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }
  }
}

async function runTier3(spec, ctx) {
  const tileDungeon = require('../scripts/eval/tile-dungeon');
  const result = await tileDungeon.runTileDungeon({
    trials: spec.trials,
    timeoutSec: spec.timeoutSec,
    candidate: ctx.cwd,
    base: ctx.packageRoot,
    engine: ctx.engine,
    model: ctx.model,
    env: ctx.env,
    json: true,
    deps: ctx.deps && ctx.deps.tileDungeon,
  });
  const ok = Boolean(result && result.ok);
  const summary = ok
    ? `tile-dungeon avg ${result.mean != null ? result.mean.toFixed(1) : 'n/a'} (n=${result.trials && result.trials.length})`
    : 'tile-dungeon FAILED';
  return { ok, summary, tileDungeon: result };
}

function tierCheckpoint(state, sha, tier) {
  const cp = state && state.verifyCheckpoints && state.verifyCheckpoints[sha];
  if (!cp || !cp.tiers || !cp.tiers[tier]) return null;
  return cp.tiers[tier];
}

function saveTierCheckpoint(state, sha, tier, result) {
  if (!state.verifyCheckpoints) state.verifyCheckpoints = {};
  if (!state.verifyCheckpoints[sha]) {
    state.verifyCheckpoints[sha] = { at: nowIso(), tiers: {} };
  }
  state.verifyCheckpoints[sha].tiers[tier] = {
    ok: Boolean(result.ok),
    summary: result.summary || '',
    at: nowIso(),
  };
}

async function runAfterEvalVerify(opts = {}) {
  const { state, definition, phase, phaseState, recordVerification, saveState } = opts;
  const merged = mergeVerify(definition.verify, phase.verify);
  if (!merged) return { ok: true };
  const cwd = definition.cwd;
  const headShaFn = opts.headSha || headSha;
  const sha = verifyCheckpointKey(cwd, opts.env, headShaFn, opts.dirtyFingerprint || dirtyFingerprint);
  const ctx = {
    cwd,
    env: opts.env,
    loopName: definition.name,
    packageRoot: opts.packageRoot || path.resolve(__dirname, '..'),
    definitionDir: opts.definitionDir,
    loopDir: opts.loopDir,
    dashboardSpec: merged.dashboard,
    engine: opts.engine,
    model: opts.model,
    spacesRoot: opts.spacesRoot,
    deps: opts.deps,
    tmpDir: opts.tmpDir,
    runCommand: opts.runCommand,
  };

  const runners = opts.tierRunners || {
    tier1: runTier1,
    tier2: runTier2,
    tier3: runTier3,
  };
  const tiers = [
    { name: 'tier1', spec: merged.tier1, run: runners.tier1 },
    { name: 'tier2', spec: merged.tier2, run: runners.tier2 },
    { name: 'tier3', spec: merged.tier3, run: runners.tier3 },
  ];

  for (const { name, spec, run } of tiers) {
    if (!spec) continue;
    const cached = tierCheckpoint(state, sha, name);
    if (cached && cached.ok) {
      recordVerification({ tier: name, ok: true, summary: `${cached.summary} (checkpoint)` });
      saveState(state);
      continue;
    }
    let result;
    try {
      result = await run(spec, ctx);
    } catch (err) {
      result = { ok: false, summary: `${name} error: ${err.message || err}` };
    }
    recordVerification({ tier: name, ok: result.ok, summary: result.summary });
    if (result.ok) saveTierCheckpoint(state, sha, name, result);
    saveState(state);
    if (!result.ok) {
      return {
        ok: false,
        tier: name,
        result,
        lastEval: {
          code: 1,
          stderr: `verify ${name} failed: ${result.summary}`,
          stdout: result.stderr || result.stdout || '',
        },
      };
    }
  }
  return { ok: true, sha };
}

module.exports = {
  afltRootFor,
  resolveNestedLoopPath,
  dirtyFingerprint,
  verifyCheckpointKey,
  TIER_NAMES,
  BLOCKED_PORTS,
  isPortBlocked,
  findFreePort,
  normalizeVerify,
  mergeVerify,
  buildRoutes,
  checkLoopDetailShape,
  failedRouteSummary,
  runDashboardUiCheck,
  startDashboardServe,
  withDashboardServe,
  runTier1,
  runTier2,
  runTier3,
  runAfterEvalVerify,
  tierCheckpoint,
  saveTierCheckpoint,
  headSha,
  DEFAULT_LOOP_ROUTES,
};