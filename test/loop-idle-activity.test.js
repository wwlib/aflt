'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runlib = require('../lib/run');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

describe('engine idle timeout', () => {
  it('stops a silent engine and its children in other process groups', async () => {
    // The "engine" starts a child in its own process group (like a shell tool
    // blocked on stdin), prints its pid once, then goes silent.
    const script = [
      "const { spawn } = require('child_process');",
      "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      'process.stdout.write(String(c.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const started = Date.now();
    const res = await runlib.spawnCaptured(process.execPath, ['-e', script], {
      detached: true,
      idleTimeoutMs: 700,
      idleCheckMs: 100,
      signalKillAfterMs: 300,
    });
    assert.equal(res.idleTimedOut, true);
    assert.equal(res.timedOut, true);
    assert.ok(Date.now() - started < 10000);
    const grandchild = Number(String(res.stdout).trim());
    assert.ok(grandchild > 0, res.stdout);
    for (let i = 0; i < 40 && alive(grandchild); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(grandchild), false, 'child in its own process group was left running');
  });

  it('file activity keeps a quiet engine alive; no idle stop when it finishes', async () => {
    const seen = [];
    const res = await runlib.spawnCaptured(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {
      detached: true,
      idleTimeoutMs: 600,
      idleCheckMs: 100,
      activityProbe: () => Date.now(),
      onActivity: (ms, source) => seen.push(source),
    });
    assert.equal(res.idleTimedOut, false);
    assert.equal(res.timedOut, false);
    assert.equal(res.code, 0);
    assert.ok(seen.includes('files'));
  });

  it('descendantPids lists children', () => {
    assert.deepEqual(runlib.descendantPids(999999999), []);
  });
});

describe('loop idle settings, activity and improve rounds', () => {
  let home;
  let prevHome;
  before(() => {
    prevHome = process.env.AGENTFLEET_HOME;
    home = tmp('af-idle-');
    process.env.AGENTFLEET_HOME = home;
  });
  after(() => {
    if (prevHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const loop = require('../lib/loop');

  it('idleTimeoutSec: phase > definition > env > 1200 default; 0 turns it off', () => {
    assert.equal(loop.DEFAULT_IDLE_TIMEOUT_SEC, 1200);
    assert.equal(loop.resolveIdleTimeoutSec({}, {}, {}), 1200);
    assert.equal(loop.resolveIdleTimeoutSec({}, {}, { AFLT_LOOP_IDLE_TIMEOUT_SEC: '90' }), 90);
    assert.equal(loop.resolveIdleTimeoutSec({}, { idleTimeoutSec: 300 }, { AFLT_LOOP_IDLE_TIMEOUT_SEC: '90' }), 300);
    assert.equal(loop.resolveIdleTimeoutSec({ idleTimeoutSec: 0 }, { idleTimeoutSec: 300 }, {}), 0);
  });

  it('definitions accept idleTimeoutSec on the loop and phases, and reject bad values', () => {
    const cwd = tmp('af-idle-def-');
    const base = {
      name: 'idle-def',
      cwd,
      idleTimeoutSec: 600,
      phases: [{ id: 'a', prompt: 'do it', idleTimeoutSec: 120, eval: { command: ['node', '-e', '0'] } }],
    };
    const ok = loop.validateDefinition(base);
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(ok.definition.idleTimeoutSec, 600);
    assert.equal(ok.definition.phases[0].idleTimeoutSec, 120);
    const badLoop = loop.validateDefinition({ ...base, idleTimeoutSec: -1 });
    assert.equal(badLoop.ok, false);
    assert.match(badLoop.errors.join('\n'), /idleTimeoutSec/);
    const badPhase = loop.validateDefinition({
      ...base,
      phases: [{ ...base.phases[0], idleTimeoutSec: 'soon' }],
    });
    assert.equal(badPhase.ok, false);
  });

  function stateWithRounds(phaseIndex, statuses) {
    const ids = ['m0', 'improve-r1', 'improve-r2', 'plan-next'];
    return {
      name: 'idle-rounds',
      status: 'running',
      phaseIndex,
      phaseId: ids[phaseIndex] || 'plan-next',
      step: 'run',
      updatedAt: '2026-01-01T00:00:00.000Z',
      definition: {
        name: 'idle-rounds',
        phases: [
          { id: 'm0' },
          { id: 'improve-r1', planned: true },
          { id: 'improve-r2', planned: true },
          { id: 'plan-next', type: 'plan-next' },
        ],
      },
      phases: statuses,
    };
  }

  it('reports the improve round running, not plan-next', () => {
    const state = stateWithRounds(2, {
      m0: { status: 'passed' },
      'improve-r1': { status: 'passed' },
      'improve-r2': { status: 'running' },
      'plan-next': { status: 'running' },
    });
    assert.deepEqual(loop.improveRoundOf(state), { current: 'improve-r2', last: 'improve-r2', number: 2, total: 2 });
    const pipe = loop.buildPhasePipeline(state);
    const pn = pipe.find((p) => p.id === 'plan-next');
    assert.equal(pn.status, 'waiting');
    assert.equal(pn.roundRunning, 'improve-r2');
    const sum = loop.summarizeLoopState(state, { alive: false });
    assert.equal(sum.round.current, 'improve-r2');
  });

  it('a finished loop reports the last round run', () => {
    const state = stateWithRounds(4, {
      m0: { status: 'passed' },
      'improve-r1': { status: 'passed' },
      'improve-r2': { status: 'passed' },
      'plan-next': { status: 'passed' },
    });
    state.status = 'completed';
    assert.deepEqual(loop.improveRoundOf(state), { current: null, last: 'improve-r2', number: 2, total: 2 });
    assert.equal(loop.improveRoundOf({ definition: { phases: [{ id: 'm0' }] }, phaseIndex: 0 }), null);
  });

  it('last activity comes from the activity file when newer than the state', () => {
    const state = stateWithRounds(1, {});
    let sum = loop.summarizeLoopState(state, { alive: false });
    assert.equal(sum.lastActivityAt, '2026-01-01T00:00:00.000Z');
    assert.equal(sum.lastActivitySource, 'state');
    assert.equal(loop.recordLoopActivity('idle-rounds', { at: Date.parse('2026-01-01T00:05:00Z'), source: 'files', phaseId: 'improve-r1' }), true);
    sum = loop.summarizeLoopState(state, { alive: false });
    assert.equal(sum.lastActivityAt, '2026-01-01T00:05:00.000Z');
    assert.equal(sum.lastActivitySource, 'files');
  });

  it('newestMtimeMs skips .git and node_modules', () => {
    const dir = tmp('af-idle-mtime-');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '1');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(dir, 'src', 'a.js'), old, old);
    fs.utimesSync(path.join(dir, 'src'), old, old);
    fs.writeFileSync(path.join(dir, '.git', 'index'), 'x');
    fs.utimesSync(dir, old, old);
    assert.equal(loop.newestMtimeMs(dir), old.getTime());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the dashboard shows the round and last activity', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'templates', 'dashboard', 'dashboard.js'), 'utf8');
    assert.match(js, /k: 'Round'/);
    assert.match(js, /k: 'Last activity'/);
    assert.match(js, /'last activity ' \+ formatAgo/);
    assert.match(js, /p\.roundRunning/);
  });
});

describe('isolation: AGENTFLEET_HOME override', () => {
  const iso = require('../lib/isolation');
  it('warns when AGENTFLEET_HOME points somewhere other than the space', () => {
    const proj = tmp('af-iso-home-');
    const home = tmp('af-iso-userhome-');
    const spaceHome = path.join(home, '.agentfleet', 'spaces', 'p');
    fs.mkdirSync(spaceHome, { recursive: true });
    const other = tmp('af-iso-other-');
    let res = iso.checkIsolation(proj, { space: 'p', spaceHome, sessions: [], env: { AGENTFLEET_HOME: other }, home });
    assert.ok(res.warnings.some((w) => w.code === 'fleet-home-override' && w.path === other));
    res = iso.checkIsolation(proj, { space: 'p', spaceHome, sessions: [], env: { AGENTFLEET_HOME: spaceHome }, home });
    assert.ok(!res.warnings.some((w) => w.code === 'fleet-home-override'));
    res = iso.checkIsolation(proj, { space: 'p', spaceHome, sessions: [], env: {}, home });
    assert.ok(!res.warnings.some((w) => w.code === 'fleet-home-override'));
  });
});
