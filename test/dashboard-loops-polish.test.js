'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/loop-scheduler',
    '../lib/notify',
    '../lib/config',
    '../lib/memory',
    '../lib/dashboard',
    '../lib/registry',
    '../lib/util',
    '../lib/engine',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, headers: { Host: '127.0.0.1' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('dashboard loops polish', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevEngine;

  function definition(overrides) {
    return Object.assign(
      {
        name: 'polish',
        project: 'demo',
        cwd: home,
        engine: 'copilot',
        allow: { commit: false, merge: false, push: false },
        budget: { maxRuns: 10, maxHours: 1 },
        phases: [
          { id: 'm1', engine: 'copilot', session: 'polish-m1', prompt: 'x', maxFixAttempts: 1 },
          { id: 'm2', engine: 'copilot', session: 'polish-m2', prompt: 'y', maxFixAttempts: 1 },
        ],
      },
      overrides || {}
    );
  }

  function seedLoop(loop, def, patch) {
    const state = loop.createInitialState(def);
    Object.assign(state, patch || {});
    loop.saveState(state);
    return state;
  }

  async function withServer(fn) {
    const dash = require('../lib/dashboard');
    const handle = dash.createDashboardServer({
      loopScheduler: false,
      sseIntervalMs: 60_000,
      registryPollMs: 60_000,
      captureTurns: false,
    });
    await new Promise((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    try {
      return await fn(handle.server.address().port);
    } finally {
      await handle.close();
    }
  }

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dash-loops-'));
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevEngine = process.env.AGENTFLEET_ENGINE;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    delete process.env.AGENTFLEET_ENGINE;
    fs.mkdirSync(process.env.AGENTFLEET_HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    if (prevAfHome == null) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevEngine == null) delete process.env.AGENTFLEET_ENGINE;
    else process.env.AGENTFLEET_ENGINE = prevEngine;
    clearMods();
  });

  it('a: /api/loops and /api/loops/:name report engine and model', async () => {
    const loop = require('../lib/loop');
    seedLoop(loop, definition({ model: 'claude-test-1' }));
    const noModelDef = definition({
      name: 'phase-model',
      phases: [
        { id: 'p1', engine: 'cursor', session: 's1', prompt: 'x', model: 'phase-m', maxFixAttempts: 1 },
      ],
    });
    delete noModelDef.engine;
    seedLoop(loop, noModelDef);

    await withServer(async (port) => {
      const list = JSON.parse((await httpGet(port, '/api/loops')).body);
      const byName = Object.fromEntries(list.loops.map((l) => [l.name, l]));
      assert.equal(byName.polish.engine, 'copilot');
      assert.equal(byName.polish.model, 'claude-test-1');
      // Definition engine missing → first phase engine / model.
      assert.equal(byName['phase-model'].engine, 'cursor');
      assert.equal(byName['phase-model'].model, 'phase-m');

      const detail = JSON.parse((await httpGet(port, '/api/loops/polish')).body);
      assert.equal(detail.engine, 'copilot');
      assert.equal(detail.model, 'claude-test-1');
      assert.equal(detail.definition.engine, 'copilot');
      assert.equal(detail.definition.model, 'claude-test-1');
    });
  });

  it('a: engine/model fall back to worker sessions, then env default engine', () => {
    const loop = require('../lib/loop');
    const registry = require('../lib/registry');
    const session = registry.add({
      title: 'polish-m1',
      chatId: 'chat-polish-1',
      cwd: home,
      engine: 'opencode',
      model: 'session-model',
      status: 'active',
    });
    const bare = definition();
    delete bare.engine;
    bare.phases = bare.phases.map((p) => ({ ...p, engine: undefined }));
    const state = loop.createInitialState(bare);
    state.definition.engine = null;
    state.definition.model = null;
    state.phases.m1.sessionId = session.id;
    assert.deepEqual(loop.resolveLoopEngineModel(state, {}), {
      engine: 'opencode',
      model: 'session-model',
    });

    state.phases.m1.sessionId = null;
    const resolved = loop.resolveLoopEngineModel(state, { AGENTFLEET_ENGINE: 'copilot' });
    assert.equal(resolved.engine, 'copilot');
  });

  it('b: in-process runner (live lock pid) shows active; dead/terminal does not', () => {
    const loop = require('../lib/loop');
    seedLoop(loop, definition(), { status: 'running', startedAt: new Date().toISOString() });

    let report = loop.statusReport(null);
    assert.equal(report.loops[0].status, 'running');
    assert.equal(report.loops[0].active, false);
    assert.equal(report.loops[0].runnerPid, null);

    const lock = loop.acquireRunnerLock('polish');
    try {
      report = loop.statusReport(null);
      assert.equal(report.loops[0].active, true);
      assert.equal(report.loops[0].runnerPid, process.pid);
      assert.equal(loop.statusReport('polish').active, true);

      // A finished loop never reads as active, even if the lock lingers.
      const state = loop.loadState('polish');
      state.status = 'completed';
      loop.saveState(state);
      assert.equal(loop.statusReport(null).loops[0].active, false);
    } finally {
      loop.releaseRunnerLock(lock);
    }
  });

  it('c: finished and failed loop sessions count as Completed / Failed', () => {
    const loop = require('../lib/loop');
    const dash = require('../lib/dashboard');
    const registry = require('../lib/registry');
    const mk = (title, extra) =>
      registry.add({
        title,
        chatId: 'chat-' + title,
        cwd: home,
        engine: 'copilot',
        status: 'active',
        lastExit: 0,
        ...extra,
      });
    const root = mk('loop-polish', { role: 'master' });
    const ok = mk('polish-m1', { role: 'worker', parent: root.id });
    const bad = mk('polish-m2', { role: 'worker', parent: root.id });
    const busy = mk('polish-m3', { role: 'worker', parent: root.id });

    const def = definition({
      phases: [
        { id: 'm1', engine: 'copilot', session: 'polish-m1', prompt: 'x', maxFixAttempts: 1 },
        { id: 'm2', engine: 'copilot', session: 'polish-m2', prompt: 'x', maxFixAttempts: 1 },
        { id: 'm3', engine: 'copilot', session: 'polish-m3', prompt: 'x', maxFixAttempts: 1 },
      ],
    });
    const state = seedLoop(loop, def, { status: 'running', loopRootSessionId: root.id });
    state.phases.m1.sessionId = ok.id;
    state.phases.m1.status = 'passed';
    state.phases.m2.sessionId = bad.id;
    state.phases.m2.status = 'failed';
    state.phases.m3.sessionId = busy.id;
    state.phases.m3.status = 'running';
    loop.saveState(state);

    const outcomes = loop.collectSessionOutcomes();
    assert.equal(outcomes[ok.id], 'completed');
    assert.equal(outcomes[bad.id], 'failed');
    assert.equal(outcomes[busy.id], undefined);
    assert.equal(outcomes[root.id], undefined);

    const live = dash.collectState({ enrichmentById: {}, isAlive: () => false });
    assert.equal(live.stats.completed, 1);
    assert.equal(live.stats.failed, 1);
    assert.equal(live.stats.idle, 2);
    const byId = Object.fromEntries(live.sessions.map((s) => [s.id, s]));
    assert.equal(byId[ok.id].activityState, 'completed');
    assert.equal(byId[bad.id].activityState, 'failed');

    // Loop ends: root session reflects the terminal loop status.
    const done = loop.loadState('polish');
    done.status = 'failed';
    done.phases.m3.status = 'failed';
    loop.saveState(done);
    const after = dash.collectState({ enrichmentById: {}, isAlive: () => false });
    assert.equal(after.stats.failed, 3);
    assert.equal(after.stats.completed, 1);

    // A live session is never overridden by a loop outcome.
    const working = dash.collectState({
      enrichmentById: {},
      isAlive: () => true,
      loopSessionOutcomes: { [ok.id]: 'completed' },
    });
    const okView = working.sessions.find((s) => s.id === ok.id);
    assert.equal(okView.activityState, 'working');
  });

  it('d: lands on Loops when loops exist, History otherwise; serves a favicon', async () => {
    const loop = require('../lib/loop');
    const dash = require('../lib/dashboard');
    assert.equal(dash.collectState({ enrichmentById: {} }).defaultView, 'history');
    seedLoop(loop, definition());
    assert.equal(dash.collectState({ enrichmentById: {} }).defaultView, 'loops');

    await withServer(async (port) => {
      const icon = await httpGet(port, '/favicon.ico');
      assert.equal(icon.status, 200);
      assert.match(icon.headers['content-type'], /image\/svg\+xml/);
      assert.match(icon.body, /^<svg /);
      const page = await httpGet(port, '/');
      assert.match(page.body, /<link rel="icon"/);
    });

    const ui = require('../templates/dashboard/dashboard.js');
    assert.ok(ui.loopSyncSignature);
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'dashboard', 'dashboard.js'),
      'utf8'
    );
    assert.match(src, /defaultView === 'loops'/);
  });

  it('e: detail pane re-syncs when the polled loop row changes', () => {
    const ui = require('../templates/dashboard/dashboard.js');
    const row = {
      name: 'tile',
      status: 'running',
      phaseId: 'm3',
      phaseIndex: 2,
      attempt: 1,
      step: 'run',
      updatedAt: '2026-11-23T10:00:00.000Z',
      elapsedMs: 17 * 60_000 + 16_000,
      budget: { runsUsed: 3, maxRuns: 40 },
    };
    const synced = { name: 'tile', signature: ui.loopSyncSignature(row) };

    assert.equal(ui.loopDetailNeedsSync(row, null, 'tile'), true);
    assert.equal(ui.loopDetailNeedsSync(row, synced, 'tile'), false);
    assert.equal(ui.loopDetailNeedsSync(row, { ...synced, name: 'other' }, 'tile'), true);
    // Not the selected loop / no row → nothing to do (selection is preserved).
    assert.equal(ui.loopDetailNeedsSync(row, synced, 'other'), false);
    assert.equal(ui.loopDetailNeedsSync(null, synced, 'tile'), false);
    assert.equal(ui.loopDetailNeedsSync(row, synced, null), false);

    const moved = [
      { phaseId: 'm4', phaseIndex: 3 },
      { budget: { runsUsed: 4, maxRuns: 40 } },
      { status: 'failed' },
      { elapsedMs: 18 * 60_000 + 28_000 },
      { step: 'eval' },
    ];
    for (const patch of moved) {
      assert.equal(
        ui.loopDetailNeedsSync({ ...row, ...patch }, synced, 'tile'),
        true,
        JSON.stringify(patch)
      );
    }
    // Sub-second jitter does not trigger a refetch.
    assert.equal(ui.loopDetailNeedsSync({ ...row, elapsedMs: row.elapsedMs + 300 }, synced, 'tile'), false);
  });

  it('e: applyState re-syncs the selected loop detail from SSE ticks', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'dashboard', 'dashboard.js'),
      'utf8'
    );
    const apply = src.slice(src.indexOf('function applyState('));
    assert.match(apply.slice(0, apply.indexOf('updateSim(opts)')), /syncSelectedLoopDetail\(\)/);
  });

  it('f: loops hint sits in flow below the panels instead of overlapping them', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'dashboard', 'dashboard.css'),
      'utf8'
    );
    const block = css.match(/\.hint\.loops-hint\s*\{([^}]*)\}/);
    assert.ok(block, 'expected a .hint.loops-hint rule');
    assert.match(block[1], /position:\s*static/);
    assert.match(block[1], /flex:\s*none/);
    // The loops panels keep scrolling inside the flex layout (min-height: 0).
    assert.match(css, /\.loops-layout\s*\{[^}]*min-height:\s*0/);
  });

  it('list/detail render live marker, engine and model', () => {
    const ui = require('../templates/dashboard/dashboard.js');
    const list = ui.renderLoopsListHtml(
      [{ name: 'tile', status: 'running', active: true, engine: 'copilot', model: 'm1' }],
      null
    );
    assert.match(list, /live/);
    assert.match(list, /copilot\/m1/);
    const detail = ui.renderLoopDetailHtml({
      name: 'tile',
      status: 'running',
      engine: 'copilot',
      model: 'm1',
    });
    assert.match(detail, /Engine<\/span><span class="v">copilot/);
    assert.match(detail, /Model<\/span><span class="v">m1/);
  });
});
