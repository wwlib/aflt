'use strict';

/**
 * Tile-dungeon eval runner (design doc sketch). Hermetic tests use injectable deps;
 * live runs spawn hello-aflt in a fresh git repo + AFLT_SPACE.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const loopVerify = require('../../lib/loop-verify');
const spaceLib = require('../../lib/space');
const dashboardApi = require('./dashboard-api');

function repoRootFromModule() {
  return path.resolve(__dirname, '..', '..');
}

function parseArgv(argv) {
  const out = {
    json: false,
    dryRun: false,
    trials: 2,
    candidate: null,
    base: null,
    engine: null,
    model: null,
    timeoutSec: 3600,
  };
  const list = Array.isArray(argv) ? argv : process.argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--trials' && list[i + 1]) out.trials = Math.max(1, Number(list[++i]));
    else if (a === '--candidate' && list[i + 1]) out.candidate = list[++i];
    else if (a === '--base' && list[i + 1]) out.base = list[++i];
    else if (a === '--engine' && list[i + 1]) out.engine = list[++i];
    else if (a === '--model' && list[i + 1]) out.model = list[++i];
    else if (a === '--timeout-sec' && list[i + 1]) out.timeoutSec = Math.max(1, Number(list[++i]));
  }
  return out;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function headSha(cwd, env) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: env || process.env,
    timeout: 30_000,
  });
  return r.status === 0 ? String(r.stdout || '').trim() : 'unknown';
}

function readLastHistoryScore(gameRepo) {
  const file = path.join(gameRepo, 'eval', 'history.jsonl');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean);
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (_) {
    return null;
  }
}

function gitInit(dir, env) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env, encoding: 'utf8' });
}

async function pollLoopStatus(port, loopName, deps, timeoutMs) {
  const request = (deps && deps.httpRequest) || dashboardApi.httpRequest;
  const deadline = Date.now() + (timeoutMs || 60_000);
  while (Date.now() < deadline) {
    try {
      const res = await request(port, `/api/loops/${encodeURIComponent(loopName)}`);
      if (res.status === 200) {
        const json = JSON.parse(res.body);
        const st = json.status || (json.loop && json.loop.status);
        if (st === 'completed' || st === 'failed' || st === 'stopped') return { ok: true, status: st, json };
      }
    } catch (_) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: 'poll timeout' };
}

function killProcessGroup(child, signal) {
  if (!child || child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (_) {
    try {
      child.kill(signal);
    } catch (_) {
      /* ignore */
    }
  }
}

function conservativeSweepWorkers(t0, repoDir, deps) {
  const exec = (deps && deps.execSync) || require('child_process').execSync;
  try {
    const ps = exec('ps -ax -o pid=,ppid=,lstart=,command=', { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const lines = ps.split('\n').filter(Boolean);
  const repoReal = fs.realpathSync(repoDir);
  for (const line of lines) {
      if (!/cursor-agent|worker-server/i.test(line)) continue;
      if (!line.includes(repoReal)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[0]);
      if (!Number.isFinite(pid) || pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ps unavailable in hermetic env */
  }
}

function buildPlan(opts) {
  const base = opts.base || repoRootFromModule();
  const candidate = opts.candidate || process.cwd();
  const sha = headSha(candidate, opts.env);
  const loopDef = path.join(
    base,
    'examples',
    'loops',
    'hello-aflt',
    'seed',
    '.agentfleet',
    'loop.json'
  );
  const seedDir = path.join(base, 'examples', 'loops', 'hello-aflt', 'seed');
  return {
    candidate,
    base,
    sha,
    loopDef,
    seedDir,
    afJs: path.join(candidate, 'bin', 'af.js'),
    trials: opts.trials,
    engine: opts.engine,
    model: opts.model,
    timeoutSec: opts.timeoutSec,
  };
}

async function runOneTrial(n, plan, opts, deps) {
  const mkdtemp = (deps && deps.mkdtempSync) || fs.mkdtempSync.bind(fs);
  const spawnFn = (deps && deps.spawn) || spawn;
  const tmpDir = mkdtemp(path.join(os.tmpdir(), `aflt-td-${plan.sha}-${n}-`));
  const spaceName = `self-eval-${String(plan.sha).slice(0, 12)}-${n}`;
  let spaceCreated = null;
  const t0 = Date.now();
  const gamePort = await loopVerify.findFreePort(deps);
  const trial = {
    n,
    repo: tmpDir,
    space: spaceName,
    gamePort,
    ok: false,
    overall: null,
    metrics: null,
    durationMs: null,
    dashboard: null,
    snapshot: null,
  };

  try {
    gitInit(tmpDir, opts.env);
    fs.cpSync(plan.seedDir, tmpDir, { recursive: true });
    spawnSync('git', ['-C', tmpDir, 'add', '-A'], {
      encoding: 'utf8',
      env: opts.env || process.env,
    });
    spawnSync(
      'git',
      ['-C', tmpDir, '-c', 'user.name=aflt', '-c', 'user.email=aflt@test', 'commit', '-qm', 'seed'],
      { encoding: 'utf8', env: opts.env || process.env }
    );
    try {
      const created = spaceLib.createSpace(spaceName, { spacesRoot: opts.spacesRoot });
      spaceCreated = created.name;
    } catch (err) {
      if (err.code !== 'SPACE_EXISTS') throw err;
    }
    const runEnv = {
      ...(opts.env || process.env),
      AFLT_SPACE: spaceName,
      PORT: String(gamePort),
      AGENTFLEET_TEST_HERMETIC: '1',
    };
    delete runEnv.AGENTFLEET_HOME;
    // Nested eval loops must not page the outer loop's webhook (aflt-loop-alerts).
    require('../../lib/notify').stripNotifyEnv(runEnv);
    if (plan.engine) runEnv.AGENTFLEET_ENGINE = plan.engine;
    if (plan.model) runEnv.COPILOT_MODEL = plan.model;

    const afJs = fs.existsSync(plan.afJs) ? plan.afJs : path.join(plan.base, 'bin', 'af.js');
    const loopChild = spawnFn(
      process.execPath,
      [afJs, 'loop', 'run', plan.loopDef, '--allow-existing', '--json'],
      {
        cwd: tmpDir,
        env: runEnv,
        detached: true,
        stdio: 'ignore',
      }
    );
    loopChild.unref();

    const dashHandle = await loopVerify.startDashboardServe({
      packageRoot: plan.base,
      space: spaceName,
      env: runEnv,
      deps,
    });
    try {
      const polled = await pollLoopStatus(
        dashHandle.port,
        'hello-aflt',
        deps,
        Math.min(plan.timeoutSec * 1000, 3_600_000)
      );
      const ui = await loopVerify.runDashboardUiCheck({
        port: dashHandle.port,
        loopName: 'hello-aflt',
        expectCompleted: polled.ok && polled.status === 'completed',
      });
      const snapPath = path.join(opts.stateDir || tmpDir, `trial-${n}.html`);
      spawnSync(
        process.execPath,
        [afJs, 'dashboard', '--snapshot', snapPath],
        { cwd: plan.base, env: runEnv, encoding: 'utf8', timeout: 120_000 }
      );
      trial.snapshot = fs.existsSync(snapPath) ? snapPath : null;
      trial.dashboard = { ok: ui.ok, routes: ui.routes, snapshot: trial.snapshot };
      trial.loopStatus = polled.status;
      trial.ok = polled.status === 'completed' && ui.ok;
    } finally {
      await dashHandle.stop();
    }

    killProcessGroup(loopChild, 'SIGTERM');
    conservativeSweepWorkers(t0, tmpDir, deps);

    const hist = readLastHistoryScore(tmpDir);
    if (hist && typeof hist.overall === 'number') {
      trial.overall = hist.overall;
      trial.metrics = hist.metrics || null;
    }
    trial.durationMs = Date.now() - t0;
    trial.ok = trial.ok && trial.overall != null;
  } finally {
    if (spaceCreated && String(spaceCreated).startsWith('self-eval-')) {
      try {
        spaceLib.removeSpace(spaceCreated, { spacesRoot: opts.spacesRoot, force: true });
      } catch (_) {
        /* ignore */
      }
    }
    if (!trial.ok && tmpDir && fs.existsSync(tmpDir)) {
      trial.keptRepo = tmpDir;
    } else if (trial.ok && tmpDir && fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }
  }
  return trial;
}

async function runTileDungeon(opts = {}) {
  const deps = opts.deps || {};
  const flags = opts.flags || parseArgv(opts.argv);
  const plan = buildPlan({
    ...flags,
    env: opts.env,
    trials: opts.trials != null ? opts.trials : flags.trials,
    candidate: opts.candidate || flags.candidate,
    base: opts.base || flags.base,
    engine: opts.engine || flags.engine,
    model: opts.model || flags.model,
    timeoutSec: opts.timeoutSec != null ? opts.timeoutSec : flags.timeoutSec,
  });

  if (opts.dryRun || flags.dryRun) {
    return {
      ok: true,
      dryRun: true,
      plan,
      engine: plan.engine,
      model: plan.model,
      sha: plan.sha,
    };
  }

  if (deps.fakeTrials) {
    const trials = deps.fakeTrials(plan.trials);
    const scores = trials.map((t) => t.overall).filter((v) => typeof v === 'number');
    return {
      ok: trials.every((t) => t.ok),
      trials,
      mean: mean(scores),
      median: median(scores),
      stdDev: stdDev(scores),
      engine: plan.engine,
      model: plan.model,
      sha: plan.sha,
      dashboard: trials[0] && trials[0].dashboard,
    };
  }

  const trials = [];
  for (let i = 1; i <= plan.trials; i++) {
    trials.push(await runOneTrial(i, plan, { ...opts, env: opts.env }, deps));
  }
  const scores = trials.map((t) => t.overall).filter((v) => typeof v === 'number');
  const ok = trials.length > 0 && trials.every((t) => t.ok);
  return {
    ok,
    trials,
    mean: mean(scores),
    median: median(scores),
    stdDev: stdDev(scores),
    engine: plan.engine,
    model: plan.model,
    sha: plan.sha,
    dashboard: trials[0] && trials[0].dashboard,
  };
}

async function main(argv) {
  const flags = parseArgv(argv);
  const result = await runTileDungeon({ ...flags, argv, flags });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.dryRun) {
    process.stdout.write(`tile-dungeon dry-run: ${result.plan.trials} trial(s) sha=${result.plan.sha}\n`);
  } else {
    process.stdout.write(
      `tile-dungeon: ok=${result.ok} mean=${result.mean} median=${result.median} stdDev=${result.stdDev}\n`
    );
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.message || err}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgv,
  mean,
  median,
  stdDev,
  buildPlan,
  runTileDungeon,
  readLastHistoryScore,
  runOneTrial,
};