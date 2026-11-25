'use strict';

/**
 * Preflight checks behind `aflt doctor --strict` / `--port` / `--loop`.
 * Every external effect (engine CLI probes, port binds, the notify round trip)
 * goes through an injectable `deps` object so tests never touch real engines,
 * sockets, or the network.
 *
 * Each check is `{ name, ok, status: 'ok'|'warn'|'fail', detail, ... }`;
 * `ok` is true only for status "ok". Only "fail" makes `--strict` exit non-zero.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const cursor = require('./cursor');
const engineLib = require('./engine');
const notify = require('./notify');
const loopLib = require('./loop');
const { which, homeDir } = require('./util');

const ENGINES = ['cursor', 'copilot', 'opencode'];
const PROBE_TIMEOUT_MS = 8000;
const DEFAULT_DASHBOARD_PORT = 8787;
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SIGNED_OUT_RE =
  /not (?:logged|signed)[- ]in|(?:login|sign[- ]?in|authentication) (?:is )?required|please (?:log ?in|sign ?in)|unauthenticated/i;

// Legacy rows that are advisory: a failure there never fails --strict.
const SOFT_LEGACY = new Set([
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
]);
const LEGACY_ENGINE_BIN = {
  cursor_bin: 'cursor',
  copilot_bin: 'copilot',
  opencode_bin: 'opencode',
};

function usableBin(bin) {
  if (!bin) return null;
  if (path.isAbsolute(bin)) return fs.existsSync(bin) ? bin : null;
  return which(bin);
}

function defaultEngineBin(engineName, env) {
  if (engineName === 'cursor') return usableBin(cursor.describeCursorBin(env).bin);
  if (engineName === 'copilot') return usableBin(env.AGENTFLEET_COPILOT_BIN || 'copilot');
  if (engineName === 'opencode') return usableBin(env.AGENTFLEET_OPENCODE_BIN || 'opencode');
  return null;
}

function defaultRun(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || PROBE_TIMEOUT_MS,
    env: opts.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.code || r.error.message : null,
  };
}

/** Test-bind a loopback port (0 = ephemeral) and release it immediately. */
function defaultBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve({ ok: false, error: err.code || err.message }));
    server.listen({ port, host: '127.0.0.1' }, () => {
      const bound = server.address().port;
      server.close(() => resolve({ ok: true, port: bound }));
    });
  });
}

function defaultDeps(env) {
  return {
    engineBin: (engineName) => defaultEngineBin(engineName, env),
    run: defaultRun,
    bindPort: defaultBindPort,
    sendNotifyTest: () => notify.sendTestEvent({ env }),
    pathExists: (p) => fs.existsSync(p),
  };
}

function resolveDefaultEngine(env) {
  try {
    return engineLib.resolveEngine({ env }).engine;
  } catch (_) {
    return 'cursor';
  }
}

function pathDirs(env) {
  return String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.resolve(d));
}

/**
 * Sign-in probe. Only Cursor has a status command; Copilot and OpenCode have no
 * non-interactive probe, so they report "unknown". The detail never includes
 * account names or emails.
 */
function probeAuth(engineName, bin, deps, env) {
  if (engineName !== 'cursor') return { state: 'unknown', detail: 'unknown (no probe)' };
  const r = deps.run(bin, ['status'], { timeoutMs: PROBE_TIMEOUT_MS, env });
  if (r.error) return { state: 'unknown', detail: `unknown (probe failed: ${r.error})` };
  const text = `${r.stdout}\n${r.stderr}`.replace(ANSI_RE, '');
  if (SIGNED_OUT_RE.test(text)) {
    return { state: 'signed_out', detail: 'not signed in; run `cursor-agent login`' };
  }
  if (r.status === 0) return { state: 'signed_in', detail: 'signed in' };
  return { state: 'unknown', detail: `unknown (cursor-agent status exited ${r.status})` };
}

function engineKey(name) {
  return name.replace(/[^a-z0-9]+/gi, '_');
}

function inspectLoop(loopFile, env) {
  const checks = [];
  const engines = [];
  let validated;
  try {
    validated = loopLib.validateFile(loopFile, { env });
  } catch (err) {
    checks.push({
      name: 'loop_workdir',
      ok: false,
      status: 'fail',
      detail: err && err.message ? err.message : String(err),
    });
    return { checks, engines };
  }
  if (!validated.ok) {
    checks.push({
      name: 'loop_workdir',
      ok: false,
      status: 'fail',
      detail: `invalid loop definition: ${(validated.errors || []).join('; ')}`,
    });
    return { checks, engines };
  }
  const def = validated.definition;
  const inspection = loopLib.inspectLoopWorkdir(def.cwd, {
    definitionPath: validated.path,
    workdir: def.workdir,
  });
  const mode = inspection.mode || 'fresh';
  checks.push({
    name: 'loop_workdir',
    ok: inspection.ok,
    status: inspection.ok ? 'ok' : 'fail',
    detail: inspection.ok
      ? `loop "${def.name}" cwd ${inspection.cwd} ok (mode=${mode})`
      : `loop "${def.name}" cwd refused (mode=${mode}): ${inspection.problems.join('; ')}`,
    data: inspection,
  });
  const failover = Array.isArray(def.engines) ? def.engines : [];
  const used = new Set([def.engine, ...def.phases.map((p) => p.engine)].filter(Boolean));
  const problems = loopLib.engineBinaryProblems(def, env);
  checks.push({
    name: 'loop_engines',
    ok: problems.length === 0,
    status: problems.length === 0 ? 'ok' : 'fail',
    detail:
      problems.length === 0
        ? `engines ${[...used].join(', ')}${failover.length ? ` (failover: ${failover.join(' > ')})` : ''} available`
        : problems.join('; '),
  });
  // With a failover list the loop survives a signed-out engine; otherwise every used engine is required.
  if (!failover.length) engines.push(...used);
  return { checks, engines };
}

/**
 * @param {object} opts
 * @param {boolean} [opts.strict]  engine CLIs, sign-in, notify, free-port checks
 * @param {boolean} [opts.notifyLive] live notify round trip (with strict)
 * @param {number|string} [opts.port] dashboard port to test-bind
 * @param {string} [opts.loopFile] loop definition to inspect
 * @param {object} [opts.env]
 * @param {object} [opts.deps] injectable engineBin/run/bindPort/sendNotifyTest/pathExists
 * @returns {Promise<{checks: object[], requiredEngines: string[]}>}
 */
async function runPreflightChecks(opts = {}) {
  const env = opts.env || process.env;
  const deps = { ...defaultDeps(env), ...(opts.deps || {}) };
  const checks = [];
  const add = (name, status, detail, extra = {}) =>
    checks.push({ name, ok: status === 'ok', status, detail, ...extra });

  let loopChecks = [];
  let required = [resolveDefaultEngine(env)];
  if (opts.loopFile) {
    const info = inspectLoop(opts.loopFile, env);
    loopChecks = info.checks;
    if (info.engines.length) required = info.engines;
  }
  const requiredSet = new Set(required);
  const levelFor = (engineName) => (requiredSet.has(engineName) ? 'fail' : 'warn');

  if (opts.strict) {
    const bins = {};
    for (const engineName of ENGINES) {
      const bin = deps.engineBin(engineName);
      bins[engineName] = bin;
      if (bin) add(`engine_cli_${engineName}`, 'ok', bin);
      else add(`engine_cli_${engineName}`, levelFor(engineName), `${engineName} CLI not on PATH`);
    }

    const localCursor = path.join(env.HOME || homeDir(), '.local', 'bin', 'cursor-agent');
    if (deps.pathExists(localCursor)) {
      const localBin = path.dirname(localCursor);
      const onPath = pathDirs(env).includes(path.resolve(localBin));
      add(
        'path_local_bin',
        onPath ? 'ok' : 'warn',
        onPath
          ? `${localBin} is on PATH`
          : `cursor-agent exists at ${localCursor} but ${localBin} is not on PATH; add it to PATH (aflt will not edit shell startup files)`
      );
    }

    for (const engineName of ENGINES) {
      if (!bins[engineName]) continue;
      const probe = probeAuth(engineName, bins[engineName], deps, env);
      const status =
        probe.state === 'signed_in'
          ? 'ok'
          : probe.state === 'signed_out'
            ? levelFor(engineName)
            : 'warn';
      add(`auth_${engineName}`, status, probe.detail);
    }

    const ncfg = notify.resolveNotifyConfig(env);
    const nst = notify.doctorStatus(env);
    if (!ncfg.enabled) {
      add(
        'notify_config',
        opts.notifyLive ? 'fail' : 'warn',
        'not configured (set config.json notify.url or AFLT_NOTIFY_URL)'
      );
    } else {
      add('notify_config', 'ok', nst.detail);
      if (opts.notifyLive) {
        let result;
        try {
          result = await deps.sendNotifyTest();
        } catch (err) {
          result = { ok: false, error: err && err.message ? err.message : String(err) };
        }
        add(
          'notify_roundtrip',
          result && result.ok ? 'ok' : 'fail',
          result && result.ok
            ? `HTTP ${result.status != null ? result.status : '?'}`
            : String((result && result.error) || 'notify test failed')
        );
      }
    }
  }

  const portGiven = opts.port != null && opts.port !== true && String(opts.port).trim() !== '';
  if (portGiven) {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      add('dashboard_port', 'fail', `invalid --port: ${opts.port}`);
    } else {
      const r = await deps.bindPort(port);
      add(
        'dashboard_port',
        r.ok ? 'ok' : 'fail',
        r.ok
          ? `port ${port} is free`
          : r.error === 'EADDRINUSE'
            ? `port ${port} is already in use`
            : `cannot bind port ${port}: ${r.error}`
      );
    }
  } else if (opts.strict) {
    add(
      'dashboard_port',
      'ok',
      `default dashboard port ${DEFAULT_DASHBOARD_PORT} (not probed; pass --port N to check)`
    );
  }
  if (opts.strict) {
    const r = await deps.bindPort(0);
    add(
      'free_port',
      r.ok ? 'ok' : 'fail',
      r.ok ? `ephemeral port ${r.port} is bindable (use for a game/server)` : `cannot bind a port: ${r.error}`
    );
  }

  checks.push(...loopChecks);
  return { checks, requiredEngines: [...requiredSet] };
}

/**
 * Give every legacy check (no status yet) a severity. Advisory rows (herdr,
 * MCP, notify, docs) only warn; engine CLI rows fail only for required engines.
 */
function classifyLegacy(checks, requiredEngines) {
  const required = new Set(requiredEngines || []);
  for (const c of checks) {
    if (c.status) continue;
    if (c.ok) c.status = 'ok';
    else if (SOFT_LEGACY.has(c.name)) c.status = 'warn';
    else if (LEGACY_ENGINE_BIN[c.name]) {
      c.status = required.has(LEGACY_ENGINE_BIN[c.name]) ? 'fail' : 'warn';
    } else c.status = 'fail';
  }
  return checks;
}

module.exports = {
  runPreflightChecks,
  classifyLegacy,
  probeAuth,
  defaultDeps,
  DEFAULT_DASHBOARD_PORT,
};
