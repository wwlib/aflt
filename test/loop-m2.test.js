'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/loop-scheduler',
    '../lib/service',
    '../lib/notify',
    '../lib/config',
    '../lib/memory',
    '../lib/dashboard',
    '../lib/registry',
    '../lib/util',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function writeLoopFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return file;
}

function startCaptureServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch (_) {
        body = raw;
      }
      hits.push({ method: req.method, url: req.url, body });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        hits,
        url: `http://127.0.0.1:${addr.port}/hook`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

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
    if (body) req.write(body);
    req.end();
  });
}

describe('aflt loop milestone 2', () => {
  let home;
  let cwd;
  let stubDir;
  let stubCursor;
  let prevHome;
  let prevAfHome;
  let prevCursor;
  let prevUrl;
  let prevHb;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-m2-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-m2-cwd-'));
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-m2-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'const c=require("crypto"); process.stdout.write(c.randomUUID()+"\\n");'
  exit 0
fi
prompt="\${*: -1}"
if echo "\$prompt" | grep -q "HELLO.txt"; then
  printf 'hello from aflt loop\\n' > "\$PWD/HELLO.txt"
fi
echo "stub-ok"
exit 0
`,
      { mode: 0o755 }
    );
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevCursor = process.env.AGENTFLEET_CURSOR_BIN;
    prevUrl = process.env.AFLT_NOTIFY_URL;
    prevHb = process.env.AFLT_LOOP_HEARTBEAT_SECONDS;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    process.env.AGENTFLEET_CURSOR_BIN = stubCursor;
    delete process.env.AFLT_NOTIFY_URL;
    delete process.env.AFLT_LOOP_HEARTBEAT_SECONDS;
  });

  afterEach(() => {
    clearMods();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevCursor === undefined) delete process.env.AGENTFLEET_CURSOR_BIN;
    else process.env.AGENTFLEET_CURSOR_BIN = prevCursor;
    if (prevUrl === undefined) delete process.env.AFLT_NOTIFY_URL;
    else process.env.AFLT_NOTIFY_URL = prevUrl;
    if (prevHb === undefined) delete process.env.AFLT_LOOP_HEARTBEAT_SECONDS;
    else process.env.AFLT_LOOP_HEARTBEAT_SECONDS = prevHb;
  });

  function afEnv(extra = {}) {
    return {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: afEnv(extraEnv),
      cwd,
      timeout: 30000,
    });
  }

  function baseDef(overrides = {}) {
    return {
      name: 'sched-loop',
      project: 'demo',
      cwd,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 20, maxHours: 2 },
      phases: [
        {
          id: 'write-greeting',
          engine: 'cursor',
          session: 'loop-sched',
          prompt:
            'Create HELLO.txt with exactly: hello from aflt loop\nDo not switch to plan mode.',
          eval: {
            command: ['grep', '-x', 'hello from aflt loop', 'HELLO.txt'],
            exitCode: 0,
          },
          maxFixAttempts: 3,
          onPass: 'none',
          force: true,
        },
      ],
      ...overrides,
    };
  }

  it('start registers active without running phases', () => {
    const loop = require('../lib/loop');
    const file = writeLoopFile(cwd, 'start.json', baseDef());
    const result = loop.startFromFile(file);
    assert.equal(result.ok, true);
    assert.equal(result.state.active, true);
    assert.equal(result.state.status, 'pending');
    assert.equal(fs.existsSync(path.join(cwd, 'HELLO.txt')), false);
    const status = loop.statusReport('sched-loop');
    assert.equal(status.active, true);
    assert.equal(status.schedulerCandidate, true);
  });

  it('CLI loop start / pause / status', () => {
    const file = writeLoopFile(cwd, 'cli-start.json', baseDef({ name: 'cli-loop' }));
    const start = af(['loop', 'start', file, '--json']);
    assert.equal(start.status, 0, start.stderr);
    const started = JSON.parse(start.stdout);
    assert.equal(started.ok, true);
    assert.equal(started.state.active, true);

    const pause = af(['loop', 'pause', 'cli-loop', '--json']);
    assert.equal(pause.status, 0, pause.stderr);
    const paused = JSON.parse(pause.stdout);
    assert.equal(paused.status, 'paused');

    const status = af(['loop', 'status', 'cli-loop', '--json']);
    assert.equal(status.status, 0);
    const st = JSON.parse(status.stdout);
    assert.equal(st.status, 'paused');
    assert.equal(st.active, true);
  });

  it('pause and requestResume toggle scheduler candidacy', () => {
    const loop = require('../lib/loop');
    const file = writeLoopFile(cwd, 'pause.json', baseDef({ name: 'pause-loop' }));
    loop.startFromFile(file);
    const paused = loop.requestPause('pause-loop');
    assert.equal(paused.status, 'paused');
    assert.equal(loop.isSchedulerCandidate(loop.loadState('pause-loop')), false);

    const resumed = loop.requestResume('pause-loop');
    assert.equal(resumed.ok, true);
    assert.equal(resumed.state.active, true);
    assert.equal(resumed.status, 'pending');
    assert.equal(loop.isSchedulerCandidate(loop.loadState('pause-loop')), true);
  });

  it('scheduler picks up an active loop and runs it', async () => {
    const loop = require('../lib/loop');
    const { createLoopScheduler } = require('../lib/loop-scheduler');
    const file = writeLoopFile(cwd, 'sched.json', baseDef({ name: 'runner-loop' }));
    loop.startFromFile(file);

    const sched = createLoopScheduler({ pollMs: 50 });
    try {
      const tick = await sched.tick();
      assert.ok(tick.started.includes('runner-loop'), JSON.stringify(tick));
      const info = sched.runnerSnapshot().find((r) => r.name === 'runner-loop');
      assert.ok(info);
      await Promise.race([
        new Promise((r) => setTimeout(r, 15000)),
        (async () => {
          while (sched.isRunning('runner-loop')) {
            await new Promise((r) => setTimeout(r, 50));
          }
        })(),
      ]);
      const state = loop.loadState('runner-loop');
      assert.equal(state.status, 'completed');
      assert.equal(state.active, false);
      assert.ok(fs.existsSync(path.join(cwd, 'HELLO.txt')));
    } finally {
      await sched.stop();
    }
  });

  it('scheduler resumes after a crashed runner (stale lock)', async () => {
    const loop = require('../lib/loop');
    const { createLoopScheduler } = require('../lib/loop-scheduler');
    const file = writeLoopFile(cwd, 'crash.json', baseDef({ name: 'crash-loop' }));
    const started = loop.startFromFile(file);
    const state = started.state;
    state.status = 'running';
    state.startedAt = new Date().toISOString();
    state.active = true;
    loop.saveState(state);
    // Write a dead-pid lock that tryBreakStaleLock / readLockInfo treat as not alive.
    // Avoid pid 1 (often alive on Unix); use an unused high pid.
    fs.writeFileSync(
      loop.lockPath('crash-loop'),
      `2147483646\n${os.hostname()}\n${Date.now() - 120_000}\n`,
      'utf8'
    );
    // Age the lock mtime so stale breaker can clear it if needed.
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(loop.lockPath('crash-loop'), past, past);

    assert.equal(loop.isSchedulerCandidate(loop.loadState('crash-loop')), true);

    const sched = createLoopScheduler({ pollMs: 50 });
    try {
      await sched.tick();
      await Promise.race([
        new Promise((r) => setTimeout(r, 15000)),
        (async () => {
          while (sched.isRunning('crash-loop')) {
            await new Promise((r) => setTimeout(r, 50));
          }
        })(),
      ]);
      const after = loop.loadState('crash-loop');
      assert.equal(after.status, 'completed');
    } finally {
      await sched.stop();
    }
  });

  it('stale lock cleanup reaps only recorded runner children', () => {
    const loop = require('../lib/loop');
    const name = 'stale-reap';
    const lp = loop.lockPath(name);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    const runnerPid = 424242;
    const lonePid = 515151;
    const groupPid = 616161;
    const groupId = 717171;
    const payload = {
      children: [
        { pid: lonePid, pgid: null },
        { pid: groupPid, pgid: groupId },
      ],
    };
    fs.writeFileSync(
      lp,
      `${runnerPid}\n${os.hostname()}\n${new Date(Date.now() - 120_000).toISOString()}\n${JSON.stringify(payload)}\n`,
      'utf8'
    );
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lp, past, past);

    const calls = [];
    const alive = new Set([lonePid, groupPid]);
    const broke = loop._test.tryBreakStaleLock(lp, {
      staleMs: 0,
      isPidAlive: (pid) => alive.has(Number(pid)),
      killPid: (pid, signal) => {
        calls.push({ kind: 'pid', pid: Number(pid), signal });
      },
      killGroup: (pgid, signal) => {
        calls.push({ kind: 'group', pgid: Number(pgid), signal });
      },
    });
    assert.equal(broke, true);
    assert.equal(fs.existsSync(lp), false);
    assert.ok(calls.some((c) => c.kind === 'pid' && c.pid === lonePid && c.signal === 'SIGTERM'));
    assert.ok(calls.some((c) => c.kind === 'pid' && c.pid === lonePid && c.signal === 'SIGKILL'));
    assert.ok(calls.some((c) => c.kind === 'group' && c.pgid === groupId && c.signal === 'SIGTERM'));
    assert.ok(calls.some((c) => c.kind === 'group' && c.pgid === groupId && c.signal === 'SIGKILL'));
    assert.equal(calls.some((c) => c.pid === 999999 || c.pgid === 999999), false);
  });

  it('runner lock tracks spawned child pids for stale-lock reaping', () => {
    const loop = require('../lib/loop');
    const lock = loop.acquireRunnerLock('lock-children');
    try {
      const ok = loop._test.recordLockChildProcess('lock-children', {
        pid: 2222,
        pgid: 3333,
      });
      assert.equal(ok, true);
      const info = loop.readLockInfo('lock-children');
      assert.ok(Array.isArray(info.children));
      assert.ok(info.children.some((c) => c.pid === 2222 && c.pgid === 3333));
    } finally {
      loop.releaseRunnerLock(lock);
    }
  });

  it('dashboard /api/loops list and pause/resume/stop', async () => {
    const loop = require('../lib/loop');
    const dash = require('../lib/dashboard');
    const file = writeLoopFile(cwd, 'api.json', baseDef({ name: 'api-loop' }));
    loop.startFromFile(file);

    const handle = dash.createDashboardServer({
      loopScheduler: false,
      sseIntervalMs: 60_000,
      registryPollMs: 60_000,
    });
    await new Promise((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    const port = handle.server.address().port;
    try {
      const list = await httpRequest(port, '/api/loops');
      assert.equal(list.status, 200);
      const listed = JSON.parse(list.body);
      assert.ok(listed.loops.some((l) => l.name === 'api-loop' && l.active));

      const one = await httpRequest(port, '/api/loops/api-loop');
      assert.equal(one.status, 200);
      const detail = JSON.parse(one.body);
      assert.equal(detail.name, 'api-loop');
      assert.equal(detail.active, true);

      const state = JSON.parse((await httpRequest(port, '/api/state')).body);
      const token = state.actions.actionToken;
      const headers = { 'x-aflt-action-token': token };

      const pause = await httpRequest(port, '/api/loops/api-loop/pause', {
        method: 'POST',
        headers,
        body: {},
      });
      assert.equal(pause.status, 200, pause.body);
      assert.equal(JSON.parse(pause.body).status, 'paused');

      const resume = await httpRequest(port, '/api/loops/api-loop/resume', {
        method: 'POST',
        headers,
        body: {},
      });
      assert.equal(resume.status, 200, resume.body);
      assert.equal(JSON.parse(resume.body).status, 'pending');

      const stop = await httpRequest(port, '/api/loops/api-loop/stop', {
        method: 'POST',
        headers,
        body: {},
      });
      assert.equal(stop.status, 200, stop.body);
      assert.equal(JSON.parse(stop.body).status, 'stopped');
      assert.equal(loop.loadState('api-loop').active, false);
    } finally {
      await handle.close();
    }
  });

  it('emits loop.heartbeat when interval is configured', async () => {
    const loop = require('../lib/loop');
    const capture = await startCaptureServer();
    process.env.AFLT_NOTIFY_URL = capture.url;
    process.env.AFLT_LOOP_HEARTBEAT_SECONDS = '0.05';
    clearMods();
    const loop2 = require('../lib/loop');

    const file = writeLoopFile(
      cwd,
      'hb.json',
      baseDef({
        name: 'hb-loop',
        phases: [
          {
            id: 'slow',
            engine: 'cursor',
            session: 'hb-sess',
            prompt: 'Create HELLO.txt with exactly: hello from aflt loop',
            eval: {
              command: ['grep', '-x', 'hello from aflt loop', 'HELLO.txt'],
              exitCode: 0,
            },
            maxFixAttempts: 1,
            onPass: 'none',
            force: true,
          },
        ],
      })
    );

    try {
      const result = await loop2.runFromFile(file, {
        env: afEnv({
          AFLT_NOTIFY_URL: capture.url,
          AFLT_LOOP_HEARTBEAT_SECONDS: '0.05',
        }),
        heartbeatMs: 50,
        runPrompt: async () => {
          await new Promise((r) => setTimeout(r, 180));
          fs.writeFileSync(path.join(cwd, 'HELLO.txt'), 'hello from aflt loop\n');
          return { code: 0, timedOut: false };
        },
      });
      assert.equal(result.ok, true);
      await new Promise((r) => setTimeout(r, 100));
      const events = capture.hits.map((h) => h.body && h.body.event).filter(Boolean);
      assert.ok(events.includes('loop.heartbeat'), events.join(','));
      assert.ok(events.includes('loop.started'), events.join(','));
      assert.ok(events.includes('loop.completed'), events.join(','));
    } finally {
      await capture.close();
      delete process.env.AFLT_NOTIFY_URL;
      delete process.env.AFLT_LOOP_HEARTBEAT_SECONDS;
    }
  });

  it('service install --print and fake launchctl; non-darwin unsupported', () => {
    const service = require('../lib/service');
    const loads = [];
    const fake = {
      load(plist) {
        loads.push(['load', plist]);
        return { status: 0, stdout: '', stderr: '' };
      },
      unload(plist) {
        loads.push(['unload', plist]);
        return { status: 0, stdout: '', stderr: '' };
      },
      list() {
        return { status: 0, stdout: '0\t0\tdev.aflt.dashboard\n', stderr: '' };
      },
    };

    const printed = service.install({
      platform: 'darwin',
      print: true,
      env: afEnv(),
      host: '127.0.0.1',
      port: 8799,
      launchctl: fake,
    });
    assert.equal(printed.ok, true);
    assert.equal(printed.print, true);
    assert.match(printed.plist, /dev\.aflt\.dashboard/);
    assert.match(printed.plist, /--port<\/string>\n\s*<string>8799/);
    assert.match(printed.plist, /KeepAlive/);
    assert.equal(loads.length, 0);

    const agentsDir = path.join(home, 'Library', 'LaunchAgents');
    const installed = service.install({
      platform: 'darwin',
      env: afEnv(),
      host: '127.0.0.1',
      port: 8799,
      launchctl: fake,
      plistPath: path.join(agentsDir, 'dev.aflt.dashboard.plist'),
    });
    assert.equal(installed.ok, true);
    assert.equal(installed.written, true);
    assert.equal(installed.loaded, true);
    assert.ok(fs.existsSync(installed.path));
    assert.ok(loads.some((x) => x[0] === 'load'));

    const st = service.status({
      platform: 'darwin',
      env: afEnv(),
      launchctl: fake,
      plistPath: installed.path,
    });
    assert.equal(st.loaded, true);
    assert.equal(st.exists, true);

    const un = service.uninstall({
      platform: 'darwin',
      env: afEnv(),
      launchctl: fake,
      plistPath: installed.path,
    });
    assert.equal(un.ok, true);
    assert.equal(un.removed, true);
    assert.equal(fs.existsSync(installed.path), false);

    const bad = service.install({ platform: 'linux', env: afEnv(), launchctl: fake });
    assert.equal(bad.ok, false);
    assert.equal(bad.supported, false);
    assert.match(bad.error, /macOS/i);
  });

  it('CLI service --print does not write', () => {
    const r = af(['service', 'install', '--print', '--port', '8801'], {
      // Force darwin path even on CI linux by going through lib with platform —
      // CLI uses process.platform; on non-darwin expect exit 1.
    });
    if (process.platform === 'darwin') {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /dev\.aflt\.dashboard/);
      assert.match(r.stdout, /8801/);
      assert.equal(
        fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'dev.aflt.dashboard.plist')),
        false
      );
    } else {
      assert.equal(r.status, 1);
      assert.match(r.stderr, /macOS/i);
    }
  });

  it('resolveHeartbeatMs defaults off', () => {
    const loop = require('../lib/loop');
    assert.equal(loop.resolveHeartbeatMs({}), 0);
    assert.equal(loop.resolveHeartbeatMs({ AFLT_LOOP_HEARTBEAT_SECONDS: '30' }), 30000);
  });
});
