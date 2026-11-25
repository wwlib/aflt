'use strict';

/**
 * Dashboard API contract checks for `aflt eval measure`.
 * Starts `aflt dashboard --serve` in a sandbox (or uses an injected server),
 * hits stable /api/* routes, then shuts down reliably.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** Stable GET routes covered by test/dashboard.test.js and test/loop-m*.test.js */
const DEFAULT_ROUTES = [
  { method: 'GET', path: '/api/state', shape: 'state' },
  { method: 'GET', path: '/api/loops', shape: 'loops' },
  { method: 'GET', path: '/api/loops/definitions', shape: 'definitions' },
  { method: 'GET', path: '/api/dashboard', shape: 'state' },
  { method: 'GET', path: '/api/history', shape: 'historyMissing', expectStatus: 400 },
];

/**
 * @param {number} port
 * @param {string} pathname
 * @param {object} [opts]
 */
function httpRequest(port, pathname, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body != null ? JSON.stringify(opts.body) : null;
  const headers = Object.assign(
    {
      Host: '127.0.0.1',
      Accept: 'application/json',
    },
    opts.headers || {}
  );
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
        timeout: opts.timeoutMs || 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Validate basic JSON shape for a known route.
 * @param {string} shape
 * @param {number} status
 * @param {string} body
 * @param {number} [expectStatus]
 */
function checkShape(shape, status, body, expectStatus) {
  const checks = [];
  const want = expectStatus != null ? expectStatus : 200;
  if (status !== want) {
    checks.push({ ok: false, detail: `status ${status} != ${want}` });
    return { ok: false, checks };
  }
  checks.push({ ok: true, detail: `status ${status}` });

  let json = null;
  try {
    json = JSON.parse(body);
    checks.push({ ok: true, detail: 'json parse' });
  } catch (err) {
    checks.push({ ok: false, detail: `json parse: ${err.message}` });
    return { ok: false, checks };
  }

  if (shape === 'state') {
    const okSessions = Array.isArray(json.sessions);
    const okProjects = Array.isArray(json.projects);
    checks.push({ ok: okSessions, detail: 'sessions array' });
    checks.push({ ok: okProjects, detail: 'projects array' });
    // /api/state nests loops as { ok, loops[], definitionsDir, error } (not a bare array)
    if (json.loops != null) {
      const nestedOk =
        typeof json.loops === 'object' &&
        !Array.isArray(json.loops) &&
        Array.isArray(json.loops.loops);
      checks.push({ ok: nestedOk, detail: 'loops wrapper object' });
    }
  } else if (shape === 'loops') {
    const ok = json && json.ok === true && Array.isArray(json.loops);
    checks.push({ ok: Boolean(ok), detail: 'ok + loops array' });
  } else if (shape === 'definitions') {
    const ok = json && Array.isArray(json.definitions);
    checks.push({ ok: Boolean(ok), detail: 'definitions array' });
  } else if (shape === 'historyMissing') {
    checks.push({
      ok: json && (json.error != null || json.ok === false),
      detail: 'error payload',
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Run contract checks against an already-listening dashboard.
 * @param {object} opts
 * @param {number} opts.port
 * @param {Array} [opts.routes]
 */
async function checkDashboardRoutes(opts) {
  const port = opts.port;
  const routes = opts.routes || DEFAULT_ROUTES;
  const results = [];
  for (const route of routes) {
    let res;
    try {
      res = await httpRequest(port, route.path, { method: route.method });
    } catch (err) {
      results.push({
        method: route.method,
        path: route.path,
        status: null,
        ok: false,
        error: String(err.message || err),
        checks: [{ ok: false, detail: String(err.message || err) }],
      });
      continue;
    }
    const shape = checkShape(route.shape, res.status, res.body, route.expectStatus);
    results.push({
      method: route.method,
      path: route.path,
      status: res.status,
      ok: shape.ok,
      checks: shape.checks,
      bodyBytes: Buffer.byteLength(res.body, 'utf8'),
    });
  }
  return {
    ok: results.every((r) => r.ok),
    port,
    routes: results,
  };
}

/**
 * Start dashboard via CLI (`aflt dashboard --serve --port 0 --json`) in a sandbox.
 * @param {object} [opts]
 */
async function startDashboardCli(opts = {}) {
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const afJs = opts.afJs || path.join(repoRoot, 'bin', 'af.js');
  const createdHome = !opts.sandboxHome;
  const sandboxHome =
    opts.sandboxHome || fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-eval-dash-'));
  const afHome = path.join(sandboxHome, '.agentfleet');
  fs.mkdirSync(afHome, { recursive: true });

  const hermeticDir = path.join(repoRoot, 'test', 'fixtures', 'hermetic');
  const env = {
    ...process.env,
    ...(opts.env || {}),
    HOME: sandboxHome,
    AGENTFLEET_HOME: afHome,
    AFLT_EVAL_MEASURING: '1',
    AGENTFLEET_HC_BIN:
      process.env.AGENTFLEET_HC_BIN || path.join(hermeticDir, 'hc'),
    AGENTFLEET_HERDR_APP_BIN:
      process.env.AGENTFLEET_HERDR_APP_BIN || path.join(hermeticDir, 'herdr-app'),
  };

  const child = spawn(
    process.execPath,
    [afJs, 'dashboard', '--serve', '--host', '127.0.0.1', '--port', '0', '--json'],
    {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  const meta = await waitForServeJson(child, () => stdout, opts.readyTimeoutMs || 15_000);
  return {
    child,
    port: meta.port,
    url: meta.url,
    sandboxHome: createdHome ? sandboxHome : opts.sandboxHome,
    agentfleetHome: afHome,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => stopChild(child),
  };
}

function waitForServeJson(child, getStdout, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('dashboard --serve did not print ready JSON in time'));
    }, timeoutMs);

    const tryParse = () => {
      const text = getStdout();
      // First JSON object on stdout
      const start = text.indexOf('{');
      if (start < 0) return;
      const end = text.indexOf('}', start);
      if (end < 0) return;
      // May be pretty-printed — try line-based then whole buffer
      let parsed = null;
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('{') && t.includes('"port"')) {
          try {
            parsed = JSON.parse(t);
            break;
          } catch (_) {
            /* continue */
          }
        }
      }
      if (!parsed) {
        try {
          // Accumulate until balanced braces
          let depth = 0;
          let buf = '';
          for (let i = start; i < text.length; i++) {
            const ch = text[i];
            buf += ch;
            if (ch === '{') depth += 1;
            else if (ch === '}') {
              depth -= 1;
              if (depth === 0) {
                parsed = JSON.parse(buf);
                break;
              }
            }
          }
        } catch (_) {
          return;
        }
      }
      if (!parsed || parsed.port == null) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ port: Number(parsed.port), url: parsed.url || `http://127.0.0.1:${parsed.port}/` });
    };

    child.stdout.on('data', tryParse);
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`dashboard exited early code=${code} signal=${signal}`));
    });
    tryParse();
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch (_) {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Start serve (CLI or injected), check routes, always stop.
 * @param {object} [opts]
 * @param {Function} [opts.startServer] async () => { port, stop }
 * @param {number} [opts.port] use existing server
 * @param {Function} [opts.stop] stop existing
 */
async function runDashboardApiChecks(opts = {}) {
  let port = opts.port;
  let stop = opts.stop;
  let started = null;
  try {
    if (port == null) {
      if (typeof opts.startServer === 'function') {
        started = await opts.startServer();
      } else {
        started = await startDashboardCli(opts);
      }
      port = started.port;
      stop = started.stop || stop;
    }
    const result = await checkDashboardRoutes({ port, routes: opts.routes });
    return {
      ...result,
      sandboxHome: started && started.sandboxHome,
      agentfleetHome: started && started.agentfleetHome,
    };
  } finally {
    if (typeof stop === 'function') {
      try {
        await stop();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/**
 * In-process dashboard server (faster hermetic tests).
 * Requires AGENTFLEET_HOME already set for the registry.
 */
async function startInProcessDashboard(opts = {}) {
  // Lazy require so measure can run without loading dashboard when skipped
  const dashboard = require('../../lib/dashboard');
  const handle = dashboard.createDashboardServer({
    sseIntervalMs: opts.sseIntervalMs || 60_000,
    registryPollMs: opts.registryPollMs || 60_000,
    herdrFetch: opts.herdrFetch || {
      ok: false,
      error: 'eval-stub',
      terminals: [],
      checkedAt: new Date().toISOString(),
    },
  });
  await new Promise((resolve, reject) => {
    handle.server.once('error', reject);
    handle.server.listen(0, '127.0.0.1', resolve);
  });
  const port = handle.server.address().port;
  return {
    port,
    stop: () => handle.close(),
  };
}

module.exports = {
  DEFAULT_ROUTES,
  httpRequest,
  checkShape,
  checkDashboardRoutes,
  startDashboardCli,
  startInProcessDashboard,
  runDashboardApiChecks,
  stopChild,
  waitForServeJson,
};
