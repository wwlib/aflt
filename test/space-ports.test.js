'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const util = require('../lib/util');
const spaceLib = require('../lib/space');

function listen() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

describe('dashboard port allocation avoids ports in use', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevSpace;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevSpace = process.env.AFLT_SPACE;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ports-'));
    process.env.HOME = home;
    delete process.env.AGENTFLEET_HOME;
    delete process.env.AFLT_SPACE;
    util.resetSpaceSelection();
  });

  afterEach(() => {
    util.resetSpaceSelection();
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevSpace === undefined) delete process.env.AFLT_SPACE;
    else process.env.AFLT_SPACE = prevSpace;
  });

  it('skips ports something is listening on (injected check)', () => {
    const busy = new Set([8788, 8789, 8790]);
    const port = spaceLib.allocateDashboardPort({ isPortBusy: (p) => busy.has(p) });
    assert.equal(port, 8791);
  });

  it('createSpace never hands out a listening port', () => {
    const created = spaceLib.createSpace('busy-ports', { isPortBusy: (p) => p === 8788 || p === 8798 });
    assert.equal(created.port, 8789);
    const second = spaceLib.createSpace('busy-ports-2', { isPortBusy: (p) => p === 8788 });
    assert.equal(second.port, 8790);
  });

  it('probeBusyPorts sees a real listener, and allocation skips it', async () => {
    const srv = await listen();
    const port = srv.address().port;
    try {
      const busy = spaceLib.probeBusyPorts([port]);
      assert.ok(busy.has(port), `expected ${port} to be reported busy`);
      const used = new Set();
      for (let p = 8787; p < port; p += 1) used.add(p);
      const picked = spaceLib.allocateDashboardPort({ used });
      assert.notEqual(picked, port);
      assert.ok(picked > port);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    assert.equal(spaceLib.probeBusyPorts([port]).has(port), false);
  });

  it('skips the served port of a space that has no config.json', () => {
    const root = path.join(home, '.agentfleet', 'spaces');
    const bare = path.join(root, 'no-config');
    fs.mkdirSync(path.join(bare, 'results'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'sessions.json'), '[]\n');
    assert.equal(fs.existsSync(path.join(bare, 'config.json')), false);
    assert.equal(spaceLib.recordServedPort(bare, { port: 8788, host: '127.0.0.1', pid: process.pid }), true);
    assert.equal(spaceLib.servedPortFromHome(bare), 8788);
    const used = spaceLib.collectRecordedPorts ? spaceLib.collectRecordedPorts() : null;
    if (used) assert.ok(used.has(8788));
    const created = spaceLib.createSpace('after-bare', { probe: false });
    assert.equal(created.port, 8789);
  });

  it('ignores a served port whose process is gone', () => {
    const bare = path.join(home, '.agentfleet', 'spaces', 'stale');
    fs.mkdirSync(bare, { recursive: true });
    spaceLib.recordServedPort(bare, { port: 8788, pid: 1 });
    assert.equal(spaceLib.servedPortFromHome(bare, { pidAlive: () => false }), null);
    const created = spaceLib.createSpace('after-stale', { probe: false, pidAlive: () => false });
    assert.equal(created.port, 8788);
  });

  it('dashboard --serve records its port for the space', async () => {
    const { spawn } = require('child_process');
    const srv = await listen();
    const free = srv.address().port;
    await new Promise((r) => srv.close(r));
    const afJs = path.join(__dirname, '..', 'bin', 'af.js');
    const child = spawn(process.execPath, [afJs, 'dashboard', '--serve', '--port', String(free)], {
      env: { ...process.env, HOME: home },
      stdio: 'ignore',
    });
    try {
      const file = path.join(home, '.agentfleet', spaceLib.DASHBOARD_SERVE_FILE);
      for (let i = 0; i < 150 && !fs.existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 50));
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(data.port, free);
      assert.equal(data.pid, child.pid);
      assert.ok(spaceLib.collectRecordedPorts().has(free));
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
  });
});
