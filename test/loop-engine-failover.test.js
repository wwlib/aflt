'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/usage',
    '../lib/turns',
    '../lib/registry',
    '../lib/config',
    '../lib/memory',
    '../lib/notify',
    '../lib/engine-errors',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function startCapture() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        /* ignore */
      }
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        hits,
        url: `http://127.0.0.1:${server.address().port}/hook`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}

const USAGE = "b: You've hit your usage limit for Other Models on the Pro plan.";
const RATE = 'Error: 429 Too many requests, rate limit exceeded';

describe('loop engines failover', () => {
  let home;
  let cwd;
  let prev;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-fo-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-fo-cwd-'));
    prev = {
      HOME: process.env.HOME,
      AGENTFLEET_HOME: process.env.AGENTFLEET_HOME,
      AGENTFLEET_ENGINE: process.env.AGENTFLEET_ENGINE,
      COPILOT_MODEL: process.env.COPILOT_MODEL,
    };
    delete process.env.COPILOT_MODEL;
    delete process.env.AGENTFLEET_ENGINE;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    fs.mkdirSync(process.env.AGENTFLEET_HOME, { recursive: true });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    clearMods();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function raw(extra = {}) {
    return {
      name: 'fo',
      cwd,
      project: 'demo',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 20, maxHours: 1 },
      phases: [
        {
          id: 'p1',
          session: 'fo-p1',
          prompt: 'do it',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 2,
          onPass: 'none',
        },
      ],
      ...extra,
    };
  }

  function definition(extra, env) {
    const loop = require('../lib/loop');
    const result = loop.validateDefinition(raw(extra), { env: env || process.env });
    assert.equal(result.ok, true, (result.errors || []).join('; '));
    return result.definition;
  }

  function harness({ runPrompt, runEval, installed }) {
    const ensured = [];
    return {
      ensured,
      opts: {
        env: process.env,
        fresh: true,
        engineInstalled: installed || (() => true),
        ensureSession: async (phase) => {
          ensured.push({ engine: phase.engine, session: phase.session });
          return {
            id: `sess-${phase.engine}`,
            title: phase.session,
            engine: phase.engine,
            cwd,
            status: 'active',
          };
        },
        runPrompt,
        runEval:
          runEval ||
          (async () => ({ code: 0, timedOut: false, stdout: '', stderr: '', cwd })),
      },
    };
  }

  const fail = (text) => ({ code: 1, timedOut: false, stdout: '', stderr: text, engineErrorText: text });
  const ok = () => ({ code: 0, timedOut: false, stdout: 'done', stderr: '' });

  describe('definition precedence', () => {
    it('engines[0] is primary when neither engine nor AGENTFLEET_ENGINE is set', () => {
      const d = definition({ engines: ['copilot', 'cursor', 'opencode'] }, {});
      assert.deepEqual(d.engines, ['copilot', 'cursor', 'opencode']);
      assert.equal(d.engine, 'copilot');
      assert.equal(d.phases[0].engine, 'copilot');
    });

    it('top-level engine > AGENTFLEET_ENGINE > engines[0]; phase.engine wins per phase', () => {
      const env = { AGENTFLEET_ENGINE: 'opencode' };
      assert.equal(definition({ engines: ['copilot', 'cursor'] }, env).engine, 'opencode');
      assert.equal(
        definition({ engine: 'cursor', engines: ['copilot', 'cursor'] }, env).engine,
        'cursor'
      );
      const withPhase = raw({ engines: ['copilot', 'cursor'] });
      withPhase.phases[0].engine = 'cursor';
      const loop = require('../lib/loop');
      const res = loop.validateDefinition(withPhase, { env: {} });
      assert.equal(res.definition.engine, 'copilot');
      assert.equal(res.definition.phases[0].engine, 'cursor');
    });

    it('rejects an empty, non-array, or unknown-engine list', () => {
      const loop = require('../lib/loop');
      for (const engines of [[], 'copilot', ['copilot', 'nope']]) {
        const res = loop.validateDefinition(raw({ engines }), { env: {} });
        assert.equal(res.ok, false, JSON.stringify(engines));
        assert.match(res.errors.join(';'), /engines/);
      }
    });

    it('omits engines when not configured', () => {
      assert.equal(definition({}, {}).engines, undefined);
    });
  });

  it('fails over on a usage limit and reruns the same attempt on the next engine', async () => {
    const loop = require('../lib/loop');
    const capture = await startCapture();
    process.env.AFLT_NOTIFY_URL = capture.url;
    const used = [];
    const h = harness({
      runPrompt: async (session) => {
        used.push(session.engine);
        return session.engine === 'cursor' ? fail(USAGE) : ok();
      },
    });
    try {
      const result = await loop.runLoop(
        definition({ engines: ['cursor', 'copilot', 'opencode'] }),
        h.opts
      );
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.deepEqual(used, ['cursor', 'copilot']);
      assert.deepEqual(h.ensured, [
        { engine: 'cursor', session: 'fo-p1' },
        { engine: 'copilot', session: 'fo-p1-copilot' },
      ]);
      const state = loop.loadState('fo');
      assert.equal(state.status, 'completed');
      assert.equal(state.attempt, 0);
      const ps = state.phases.p1;
      assert.equal(ps.engine, 'copilot');
      assert.equal(ps.sessionTitle, 'fo-p1-copilot');
      assert.equal(ps.failovers.length, 1);
      assert.equal(ps.failovers[0].from, 'cursor');
      assert.equal(ps.failovers[0].to, 'copilot');
      assert.equal(ps.failovers[0].kind, 'usage_limit');
      const ev = state.history.find((e) => e.event === 'loop.engine.failover');
      assert.equal(ev.fromEngine, 'cursor');
      assert.equal(ev.engine, 'copilot');
      assert.equal(ev.errorKind, 'usage_limit');
      assert.ok(!state.history.some((e) => e.event === 'loop.phase.eval_failed'));
      const pipeline = loop.buildPhasePipeline(state);
      assert.equal(pipeline[0].engine, 'copilot');
      await new Promise((r) => setTimeout(r, 100));
      const hit = capture.hits.find((e) => e.event === 'loop.engine.failover');
      assert.ok(hit, JSON.stringify(capture.hits.map((e) => e.event)));
      assert.equal(hit.engine, 'copilot');
      assert.equal(hit.fromEngine, 'cursor');
      assert.equal(hit.errorKind, 'usage_limit');
      assert.equal(hit.phaseId, 'p1');
    } finally {
      delete process.env.AFLT_NOTIFY_URL;
      await capture.close();
    }
  });

  it('keeps the fix attempt number when failing over during a fix run', async () => {
    const loop = require('../lib/loop');
    let evals = 0;
    const used = [];
    const h = harness({
      runPrompt: async (session) => {
        used.push(session.engine);
        if (used.length === 2) return fail(RATE);
        return ok();
      },
      runEval: async () => {
        evals += 1;
        return { code: evals === 1 ? 1 : 0, timedOut: false, stdout: '', stderr: 'red', cwd };
      },
    });
    const result = await loop.runLoop(definition({ engines: ['cursor', 'copilot'] }), h.opts);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(used, ['cursor', 'cursor', 'copilot']);
    const state = loop.loadState('fo');
    const fo = state.history.find((e) => e.event === 'loop.engine.failover');
    assert.equal(fo.attempt, 1);
    assert.equal(state.phases.p1.failovers[0].kind, 'rate_limit');
    assert.equal(
      state.history.filter((e) => e.event === 'loop.phase.eval_failed').length,
      1
    );
  });

  it('never fails over on an eval failure', async () => {
    const loop = require('../lib/loop');
    const used = [];
    const h = harness({
      runPrompt: async (session) => {
        used.push(session.engine);
        return ok();
      },
      runEval: async () => ({ code: 1, timedOut: false, stdout: '', stderr: 'red', cwd }),
    });
    const result = await loop.runLoop(definition({ engines: ['cursor', 'copilot'] }), h.opts);
    assert.equal(result.ok, false);
    assert.deepEqual(used, ['cursor', 'cursor', 'cursor']);
    const state = loop.loadState('fo');
    assert.equal(state.phases.p1.failovers, undefined);
    assert.ok(!state.history.some((e) => e.event === 'loop.engine.failover'));
    assert.match(state.lastError, /fix attempt/);
  });

  it('fails as before when no engines remain', async () => {
    const loop = require('../lib/loop');
    const used = [];
    const h = harness({
      runPrompt: async (session) => {
        used.push(session.engine);
        return session.engine === 'cursor' ? fail(USAGE) : fail(RATE);
      },
    });
    const result = await loop.runLoop(definition({ engines: ['cursor', 'copilot'] }), h.opts);
    assert.equal(result.ok, false);
    assert.deepEqual(used, ['cursor', 'copilot']);
    const state = loop.loadState('fo');
    assert.equal(state.phases.p1.status, 'failed');
    assert.equal(state.phases.p1.errorKind, 'rate_limit');
    assert.match(state.lastError, /not retryable/);
    assert.equal(state.history.filter((e) => e.event === 'loop.engine.failover').length, 1);
  });

  it('skips an engine whose CLI is not installed', async () => {
    const loop = require('../lib/loop');
    const used = [];
    const h = harness({
      installed: (e) => e !== 'copilot',
      runPrompt: async (session) => {
        used.push(session.engine);
        return session.engine === 'cursor' ? fail(USAGE) : ok();
      },
    });
    const result = await loop.runLoop(
      definition({ engines: ['cursor', 'copilot', 'opencode'] }),
      h.opts
    );
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(used, ['cursor', 'opencode']);
  });

  it('starts on the first installed engine when the primary CLI is missing', async () => {
    const loop = require('../lib/loop');
    const used = [];
    const h = harness({
      installed: (e) => e !== 'cursor',
      runPrompt: async (session) => {
        used.push(session.engine);
        return ok();
      },
    });
    const result = await loop.runLoop(definition({ engines: ['cursor', 'copilot'] }), h.opts);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(used, ['copilot']);
    const state = loop.loadState('fo');
    assert.equal(state.phases.p1.failovers[0].kind, 'cli_missing');
  });

  it('does not refuse a live run when only a fallback engine is installed', () => {
    const loop = require('../lib/loop');
    const d = definition({ engines: ['cursor', 'copilot'] });
    const env = {
      PATH: '',
      AGENTFLEET_CURSOR_BIN: path.join(home, 'missing-cursor'),
      AGENTFLEET_COPILOT_BIN: process.execPath,
    };
    assert.deepEqual(loop.engineBinaryProblems(d, env), []);
    const noFailover = definition({ engine: 'cursor' });
    assert.ok(loop.engineBinaryProblems(noFailover, { PATH: '' }).length > 0);
  });
});
