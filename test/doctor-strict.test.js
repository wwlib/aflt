'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const doctorLib = require('../lib/doctor');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function byName(checks, name) {
  return checks.find((c) => c.name === name);
}

function makeDeps(overrides = {}) {
  const calls = { run: [], bind: [], notify: 0 };
  const deps = {
    engineBin: (e) => (e === 'cursor' || e === 'copilot' ? `/fake/bin/${e}` : null),
    run: (bin, args) => {
      calls.run.push([bin, ...args]);
      return { status: 0, stdout: '✓ Logged in as someone@example.com\n', stderr: '', error: null };
    },
    bindPort: async (port) => {
      calls.bind.push(port);
      return { ok: true, port: port || 54321 };
    },
    sendNotifyTest: async () => {
      calls.notify += 1;
      return { ok: true, status: 200 };
    },
    pathExists: () => false,
    ...overrides,
  };
  return { deps, calls };
}

describe('doctor preflight checks (injected probes)', () => {
  let home;
  let prevHome;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-doctor-strict-'));
    prevHome = process.env.AGENTFLEET_HOME;
    process.env.AGENTFLEET_HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function envFor(extra = {}) {
    const env = { ...process.env, AGENTFLEET_HOME: home, AGENTFLEET_ENGINE: 'cursor', ...extra };
    delete env.AFLT_NOTIFY_URL;
    delete env.AFLT_NOTIFY_KEY;
    return { ...env, ...extra };
  }

  it('reports engine CLIs: missing default engine fails, other missing engines warn', async () => {
    const { deps } = makeDeps();
    const ok = await doctorLib.runPreflightChecks({ strict: true, env: envFor(), deps });
    assert.equal(byName(ok.checks, 'engine_cli_cursor').status, 'ok');
    assert.equal(byName(ok.checks, 'engine_cli_copilot').status, 'ok');
    assert.equal(byName(ok.checks, 'engine_cli_opencode').status, 'warn');

    const { deps: missing } = makeDeps({ engineBin: () => null });
    const bad = await doctorLib.runPreflightChecks({ strict: true, env: envFor(), deps: missing });
    assert.equal(byName(bad.checks, 'engine_cli_cursor').status, 'fail');
    assert.equal(byName(bad.checks, 'engine_cli_copilot').status, 'warn');
    // A missing CLI is never probed for sign-in.
    assert.equal(byName(bad.checks, 'auth_cursor'), undefined);
  });

  it('flags cursor-agent in ~/.local/bin when that dir is not on PATH', async () => {
    const fakeHome = path.join(home, 'home');
    const localBin = path.join(fakeHome, '.local', 'bin');
    const { deps } = makeDeps({ pathExists: (p) => p === path.join(localBin, 'cursor-agent') });

    const off = await doctorLib.runPreflightChecks({
      strict: true,
      env: envFor({ HOME: fakeHome, PATH: '/usr/bin' }),
      deps,
    });
    const warn = byName(off.checks, 'path_local_bin');
    assert.equal(warn.status, 'warn');
    assert.match(warn.detail, /not on PATH/);

    const on = await doctorLib.runPreflightChecks({
      strict: true,
      env: envFor({ HOME: fakeHome, PATH: `/usr/bin${path.delimiter}${localBin}` }),
      deps,
    });
    assert.equal(byName(on.checks, 'path_local_bin').status, 'ok');

    const none = await doctorLib.runPreflightChecks({
      strict: true,
      env: envFor({ HOME: fakeHome }),
      deps: makeDeps().deps,
    });
    assert.equal(byName(none.checks, 'path_local_bin'), undefined);
  });

  it('probes cursor sign-in with a short timeout and never echoes the account', async () => {
    const { deps, calls } = makeDeps();
    const r = await doctorLib.runPreflightChecks({ strict: true, env: envFor(), deps });
    assert.deepEqual(calls.run, [['/fake/bin/cursor', 'status']]);
    const auth = byName(r.checks, 'auth_cursor');
    assert.equal(auth.status, 'ok');
    assert.ok(!/example\.com/.test(auth.detail));
  });

  it('signed-out default engine fails; signed-out optional engine and probe errors only warn', async () => {
    const { deps } = makeDeps({
      run: () => ({ status: 1, stdout: 'Not logged in\n', stderr: '', error: null }),
    });
    const required = await doctorLib.runPreflightChecks({ strict: true, env: envFor(), deps });
    assert.equal(byName(required.checks, 'auth_cursor').status, 'fail');

    const optional = await doctorLib.runPreflightChecks({
      strict: true,
      env: envFor({ AGENTFLEET_ENGINE: 'copilot' }),
      deps,
    });
    assert.equal(byName(optional.checks, 'auth_cursor').status, 'warn');

    const { deps: timeout } = makeDeps({
      run: () => ({ status: null, stdout: '', stderr: '', error: 'ETIMEDOUT' }),
    });
    const t = await doctorLib.runPreflightChecks({ strict: true, env: envFor(), deps: timeout });
    const auth = byName(t.checks, 'auth_cursor');
    assert.equal(auth.status, 'warn');
    assert.match(auth.detail, /unknown/);
  });

  it('copilot has no sign-in probe: "unknown (no probe)" is a warning, not a failure', async () => {
    const { deps, calls } = makeDeps();
    const r = await doctorLib.runPreflightChecks({
      strict: true,
      env: envFor({ AGENTFLEET_ENGINE: 'copilot' }),
      deps,
    });
    const auth = byName(r.checks, 'auth_copilot');
    assert.equal(auth.status, 'warn');
    assert.equal(auth.detail, 'unknown (no probe)');
    assert.ok(!calls.run.some((c) => c[0] === '/fake/bin/copilot'), 'copilot must not be spawned');
  });

  it('notify: unconfigured warns; --notify live round trip succeeds or fails', async () => {
    const { deps, calls } = makeDeps();
    const off = await doctorLib.runPreflightChecks({ strict: true, env: envFor(), deps });
    assert.equal(byName(off.checks, 'notify_config').status, 'warn');
    assert.equal(calls.notify, 0);

    const env = envFor({ AFLT_NOTIFY_URL: 'http://127.0.0.1:9/hook', AFLT_NOTIFY_KEY: 'sekret' });
    const configured = await doctorLib.runPreflightChecks({ strict: true, env, deps });
    assert.equal(byName(configured.checks, 'notify_config').status, 'ok');
    assert.ok(!JSON.stringify(configured.checks).includes('sekret'));
    assert.equal(calls.notify, 0, 'no live POST without --notify');

    const live = await doctorLib.runPreflightChecks({ strict: true, notifyLive: true, env, deps });
    assert.equal(calls.notify, 1);
    assert.equal(byName(live.checks, 'notify_roundtrip').status, 'ok');

    const { deps: bad } = makeDeps({
      sendNotifyTest: async () => ({ ok: false, error: 'HTTP 500' }),
    });
    const failed = await doctorLib.runPreflightChecks({
      strict: true,
      notifyLive: true,
      env,
      deps: bad,
    });
    const rt = byName(failed.checks, 'notify_roundtrip');
    assert.equal(rt.status, 'fail');
    assert.match(rt.detail, /HTTP 500/);

    const unconfiguredLive = await doctorLib.runPreflightChecks({
      strict: true,
      notifyLive: true,
      env: envFor(),
      deps,
    });
    assert.equal(byName(unconfiguredLive.checks, 'notify_config').status, 'fail');
  });

  it('port check: free, busy and invalid; default 8787 is reported but never probed', async () => {
    const { deps, calls } = makeDeps({
      bindPort: async (port) => {
        if (port === 4242) return { ok: false, error: 'EADDRINUSE' };
        return { ok: true, port: port || 54321 };
      },
    });
    const free = await doctorLib.runPreflightChecks({ port: 4343, env: envFor(), deps });
    assert.equal(byName(free.checks, 'dashboard_port').status, 'ok');
    // --port alone does not turn on the strict checks.
    assert.equal(byName(free.checks, 'engine_cli_cursor'), undefined);

    const busy = await doctorLib.runPreflightChecks({ port: '4242', env: envFor(), deps });
    const b = byName(busy.checks, 'dashboard_port');
    assert.equal(b.status, 'fail');
    assert.match(b.detail, /already in use/);

    const bad = await doctorLib.runPreflightChecks({ port: 'abc', env: envFor(), deps });
    assert.equal(byName(bad.checks, 'dashboard_port').status, 'fail');

    const { deps: d2, calls: c2 } = makeDeps();
    const strict = await doctorLib.runPreflightChecks({ strict: true, env: envFor(), deps: d2 });
    const def = byName(strict.checks, 'dashboard_port');
    assert.equal(def.status, 'ok');
    assert.match(def.detail, /8787/);
    assert.ok(!c2.bind.includes(8787), 'default port is not bound');
    assert.deepEqual(c2.bind, [0]);
    assert.ok(byName(strict.checks, 'free_port'));
    assert.equal(calls.bind.includes(8787), false);
  });

  it('default bindPort refuses an occupied port without taking it over, and releases a free one', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const { port } = server.address();
    try {
      const busy = await doctorLib.defaultDeps(process.env).bindPort(port);
      assert.equal(busy.ok, false);
      assert.equal(busy.error, 'EADDRINUSE');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const free = await doctorLib.defaultDeps(process.env).bindPort(port);
    assert.equal(free.ok, true);
    // The probe closed its listener, so the port can be bound again.
    const again = await doctorLib.defaultDeps(process.env).bindPort(port);
    assert.equal(again.ok, true);
  });

  it('--loop reports inspectLoopWorkdir for the definition', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'af-doctor-loop-'));
    const dirty = path.join(work, 'dirty');
    const fresh = path.join(work, 'fresh');
    fs.mkdirSync(dirty);
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(dirty, 'keep.txt'), 'x');
    spawnSync('git', ['init', '-q'], { cwd: fresh });
    const writeDef = (name, cwd) => {
      const file = path.join(work, `${name}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          name,
          cwd,
          engine: 'cursor',
          budget: { maxRuns: 3, maxHours: 1 },
          phases: [{ id: 'p1', prompt: 'do it', eval: { command: ['true'], exitCode: 0 } }],
        })
      );
      return file;
    };
    try {
      const { deps } = makeDeps();
      const bad = await doctorLib.runPreflightChecks({
        loopFile: writeDef('dirty-loop', dirty),
        env: envFor(),
        deps,
      });
      const wd = byName(bad.checks, 'loop_workdir');
      assert.equal(wd.status, 'fail');
      assert.equal(wd.data.ok, false);
      assert.ok(wd.data.problems.length > 0);

      const good = await doctorLib.runPreflightChecks({
        loopFile: writeDef('fresh-loop', fresh),
        env: envFor(),
        deps,
      });
      assert.equal(byName(good.checks, 'loop_workdir').status, 'ok');
      assert.equal(byName(good.checks, 'loop_workdir').data.mode, 'fresh');

      const missing = await doctorLib.runPreflightChecks({
        loopFile: path.join(work, 'nope.json'),
        env: envFor(),
        deps,
      });
      assert.equal(byName(missing.checks, 'loop_workdir').status, 'fail');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('classifyLegacy: advisory rows only warn; required engine CLI rows fail', () => {
    const checks = [
      { name: 'node', ok: true },
      { name: 'hc_on_path', ok: false },
      { name: 'cursor_bin', ok: false },
      { name: 'copilot_bin', ok: false },
      { name: 'registry', ok: false },
    ];
    doctorLib.classifyLegacy(checks, ['cursor']);
    const status = Object.fromEntries(checks.map((c) => [c.name, c.status]));
    assert.deepEqual(status, {
      node: 'ok',
      hc_on_path: 'warn',
      cursor_bin: 'fail',
      copilot_bin: 'warn',
      registry: 'fail',
    });
  });
});

describe('aflt doctor --strict (CLI)', () => {
  let home;
  let stubDir;

  function writeStub(name, body) {
    const p = path.join(stubDir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  }

  function run(args, extraEnv = {}) {
    const env = {
      ...process.env,
      AGENTFLEET_HOME: home,
      HOME: home,
      AGENTFLEET_ENGINE: 'cursor',
      AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
      AGENTFLEET_COPILOT_BIN: path.join(stubDir, 'copilot'),
      AGENTFLEET_OPENCODE_BIN: path.join(stubDir, 'missing-opencode'),
      ...extraEnv,
    };
    delete env.AFLT_NOTIFY_URL;
    return spawnSync(process.execPath, [afJs, 'doctor', ...args], {
      encoding: 'utf8',
      env: { ...env, ...extraEnv },
    });
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-doctor-cli-home-'));
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-doctor-cli-stub-'));
    writeStub('cursor-agent', 'echo "Logged in"; exit 0');
    writeStub('copilot', 'echo copilot-stub; exit 0');
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('passes with warnings (exit 0) and lists structured checks in --json', () => {
    const r = run(['--strict', '--json']);
    const body = JSON.parse(r.stdout);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(body.ok, true);
    assert.equal(body.strict, true);
    assert.deepEqual(body.failed, []);
    for (const c of body.checks) {
      assert.ok(['ok', 'warn', 'fail'].includes(c.status), JSON.stringify(c));
      assert.equal(typeof c.ok, 'boolean');
    }
    assert.equal(byName(body.checks, 'auth_cursor').status, 'ok');
    assert.equal(byName(body.checks, 'auth_copilot').detail, 'unknown (no probe)');
    assert.equal(byName(body.checks, 'engine_cli_opencode').status, 'warn');
    assert.equal(byName(body.checks, 'notify_config').status, 'warn');
    assert.ok(byName(body.checks, 'free_port'));
  });

  it('exits non-zero when a check fails (signed-out default engine)', () => {
    writeStub('cursor-agent', 'echo "Not logged in"; exit 1');
    const r = run(['--strict', '--json']);
    assert.equal(r.status, 1);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.ok(body.failed.includes('auth_cursor'));
    // Without --strict the same machine still exits 0 and adds no preflight rows.
    const plain = run(['--json']);
    assert.equal(plain.status, 0);
    assert.equal(byName(JSON.parse(plain.stdout).checks, 'auth_cursor'), undefined);
  });

  it('--port fails when the port is occupied and passes when free', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const { port } = server.address();
    try {
      const busy = run(['--json', '--port', String(port)]);
      assert.equal(busy.status, 1);
      const check = byName(JSON.parse(busy.stdout).checks, 'dashboard_port');
      assert.equal(check.status, 'fail');
      assert.match(check.detail, /already in use/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const free = run(['--json', '--port', String(port)]);
    assert.equal(free.status, 0, free.stdout + free.stderr);
    assert.equal(byName(JSON.parse(free.stdout).checks, 'dashboard_port').status, 'ok');
  });

  it('--strict --notify does a live round trip against the configured webhook', async () => {
    const http = require('http');
    const { spawn } = require('child_process');
    const bodies = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (d) => (data += d));
      req.on('end', () => {
        bodies.push(data);
        res.writeHead(req.url === '/bad' ? 500 : 200).end('ok');
      });
    });
    await new Promise((resolve) => server.listen({ port: 0, host: '127.0.0.1' }, resolve));
    const { port } = server.address();
    const runAsync = (urlPath) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [afJs, 'doctor', '--strict', '--notify', '--json'], {
          env: {
            ...process.env,
            AGENTFLEET_HOME: home,
            AGENTFLEET_ENGINE: 'cursor',
            AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
            AGENTFLEET_COPILOT_BIN: path.join(stubDir, 'copilot'),
            AGENTFLEET_OPENCODE_BIN: path.join(stubDir, 'missing-opencode'),
            AFLT_NOTIFY_URL: `http://127.0.0.1:${port}${urlPath}`,
          },
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ code, body: JSON.parse(out) }));
      });
    try {
      const good = await runAsync('/hook');
      assert.equal(good.code, 0, JSON.stringify(good.body.failed));
      assert.equal(byName(good.body.checks, 'notify_roundtrip').status, 'ok');
      assert.equal(bodies.length, 1);
      const bad = await runAsync('/bad');
      assert.equal(bad.code, 1);
      assert.ok(bad.body.failed.includes('notify_roundtrip'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('--notify requires --strict', () => {
    const r = run(['--notify']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--notify requires --strict/);
  });
});
