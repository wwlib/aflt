'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function clearMods() {
  for (const m of ['../lib/util', '../lib/loop', '../lib/registry', '../lib/config', '../lib/turns', '../lib/usage', '../lib/notify', '../lib/making-of']) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function withHome(fn) {
  return async () => {
    clearMods();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-gc-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-gc-cwd-'));
    const prev = { HOME: process.env.HOME, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME, AFLT_NOTIFY_URL: process.env.AFLT_NOTIFY_URL };
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AFLT_NOTIFY_URL;
    try {
      await fn({ home, cwd });
    } finally {
      clearMods();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  };
}

function captureServer() {
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
    server.listen(0, '127.0.0.1', () => {
      resolve({ hits, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

describe('approval gate reports cost so far', () => {
  it('costSoFar: credits and dollars when recorded, else cost unknown', () => {
    const loop = require('../lib/loop');
    const state = {
      name: 'x',
      definition: { engine: 'copilot', phases: [{ id: 'm0', engine: 'copilot' }] },
      phases: { m0: { sessionId: 's1' } },
      history: [],
      runsUsed: 2,
    };
    const c = loop.costSoFar(state, { usage: { credits: 12.4, usd: 0.124, totalTokens: 1530000 } });
    assert.equal(c.costKnown, true);
    assert.match(c.text, /^12\.4 credits · \$0\.12 · \d+m active · 1\.5M tok$/);
    const cursorState = { ...state, definition: { engine: 'cursor', phases: [{ id: 'm0', engine: 'cursor' }] } };
    const u = loop.costSoFar(cursorState, { usage: { totalTokens: 4200 } });
    assert.equal(u.costKnown, false);
    assert.match(u.text, /^cost unknown \(cursor recorded no cost\) · \d+m active · 4k tok$/);
    assert.equal(u.runsUsed, 2);
  });

  it(
    'gate waiting: state, history, loop status and the loop.gate.waiting payload carry the cost',
    withHome(async ({ cwd }) => {
      const capture = await captureServer();
      try {
        const loop = require('../lib/loop');
        const def = {
          name: 'gated',
          cwd,
          engine: 'cursor',
          allow: { commit: false, merge: false, push: false },
          budget: { maxRuns: 5, maxHours: 1 },
          phases: [
            { id: 'm0', prompt: 'build tests', eval: { command: ['true'] }, maxFixAttempts: 0 },
            { id: 'm1', prompt: 'next', gate: 'approve', eval: { command: ['true'] }, maxFixAttempts: 0 },
          ],
        };
        const file = path.join(cwd, 'gated.json');
        fs.writeFileSync(file, JSON.stringify(def));
        const env = { ...process.env, AFLT_NOTIFY_URL: capture.url };
        const result = await loop.runFromFile(file, {
          env,
          ensureSession: async (phase) => ({ id: `sess-${phase.id}`, title: phase.id, engine: 'cursor', cwd, status: 'active' }),
          runPrompt: async () => ({ code: 0, timedOut: false, stdout: 'ok', stderr: '', outPath: null, runId: 'r' }),
        });
        assert.equal(result.status, 'waiting', result.error);
        const state = loop.loadState('gated');
        assert.equal(state.gate.waiting, true);
        assert.ok(state.gate.costSoFar, 'cost recorded on the gate');
        assert.equal(state.gate.costSoFar.costKnown, false);
        const h = state.history.filter((e) => e.event === 'loop.gate.waiting').pop();
        assert.match(h.summary, /waiting for approval before phase m1; cost so far: cost unknown \(cursor recorded no cost\)/);

        const report = loop.statusReport('gated');
        assert.equal(report.gate.waiting, true);
        assert.match(report.gate.costSoFar.text, /cost unknown/);

        await new Promise((r) => setTimeout(r, 200));
        const hit = capture.hits.find((b) => b.event === 'loop.gate.waiting');
        assert.ok(hit, capture.hits.map((b) => b.event).join(','));
        assert.match(hit.costSoFar, /cost unknown/);
        assert.equal(hit.costKnown, false);
        assert.equal(typeof hit.activeHours, 'number');
        assert.match(hit.summary, /cost so far/);

        const cli = spawnSync(process.execPath, [afJs, 'loop', 'status', 'gated'], {
          cwd,
          env: { ...process.env },
          encoding: 'utf8',
        });
        assert.equal(cli.status, 0, cli.stderr);
        assert.match(cli.stdout, /gate: waiting for approval before phase m1 \(aflt loop approve gated\)/);
        assert.match(cli.stdout, /cost so far: cost unknown/);
        const list = spawnSync(process.execPath, [afJs, 'loop', 'status'], { cwd, env: { ...process.env }, encoding: 'utf8' });
        assert.match(list.stdout, /gated\s+waiting .* cost=cost unknown/);
      } finally {
        await capture.close();
      }
    })
  );

  it('dashboard: gate banner shows phase and cost; detail includes it while waiting', () => {
    const d = require('../templates/dashboard/dashboard.js');
    const banner = d.renderLoopGateBanner({ phaseId: 'm1', gate: { waiting: true, phaseId: 'm1', costSoFar: { text: '12.4 credits · $0.12 · 9m active' } } });
    assert.match(banner, /Waiting for approval before phase m1\. Cost so far: 12\.4 credits · \$0\.12 · 9m active\./);
    const html = d.renderLoopDetailHtml({ name: 'g', status: 'waiting', gate: { waiting: true, phaseId: 'm1', costSoFar: { text: 'cost unknown (cursor recorded no cost) · 3m active' } } });
    assert.match(html, /loops-gate-banner/);
    assert.match(html, /cost unknown \(cursor recorded no cost\)/);
    const done = d.renderLoopDetailHtml({ name: 'g', status: 'completed', gate: { waiting: false } });
    assert.doesNotMatch(done, /loops-gate-banner/);
  });

  it('dashboard editor keeps fields it has no input for', () => {
    const d = require('../templates/dashboard/dashboard.js');
    const orig = { id: 'm0', promptFile: '/p/m0.md', timeoutSec: 900, eval: { command: ['node', 'check.js'], timeoutSec: 120 }, force: true };
    const edited = { id: 'm0', engine: 'cursor', prompt: '', eval: { command: 'node check.js', exitCode: 0 }, maxFixAttempts: 3, onPass: 'commit', force: true };
    const m = d.mergeEditedLoopPhase(orig, edited);
    assert.equal(m.promptFile, '/p/m0.md');
    assert.equal('prompt' in m, false);
    assert.equal(m.timeoutSec, 900);
    assert.deepEqual(m.eval.command, ['node', 'check.js']);
    assert.equal(m.eval.timeoutSec, 120);
    const plan = d.mergeEditedLoopPhase(
      { id: 'plan-next', type: 'plan-next', model: 'big', improveModel: 'small' },
      { id: 'plan-next', engine: 'cursor', prompt: '', eval: { command: 'true', exitCode: 0 }, model: 'big' }
    );
    assert.equal(plan.type, 'plan-next');
    assert.equal('eval' in plan, false);
    assert.equal(plan.improveModel, 'small');
    const script = d.mergeEditedLoopPhase({ id: 's', type: 'script', eval: { command: 'cp a b' } }, { id: 's', prompt: '', eval: { command: 'cp a b' } });
    assert.equal('prompt' in script, false);
    assert.equal(script.type, 'script');
  });
});

describe('improve rounds and models', () => {
  const base = (extra = {}) => ({
    name: 'im',
    cwd: os.tmpdir(),
    engine: 'cursor',
    model: 'cheap',
    budget: { maxRuns: 9, maxPhases: 8 },
    phases: [
      { id: 'm0', prompt: 'tests', eval: { command: 'npm test' } },
      { id: 'plan-next', type: 'plan-next', model: 'strong', ...extra },
    ],
  });

  it('planned phases never inherit the planner model; improveModel sets theirs', () => {
    clearMods();
    const loop = require('../lib/loop');
    for (const [label, defExtra, phaseExtra, want] of [
      ['no improveModel → loop model chain', {}, {}, 'cheap'],
      ['definition improveModel', { improveModel: 'mini' }, {}, 'mini'],
      ['plan-next improveModel wins', { improveModel: 'mini' }, { improveModel: 'nano' }, 'nano'],
    ]) {
      const v = loop.validateDefinition({ ...base(phaseExtra), ...defExtra }, { checkCwd: false });
      assert.equal(v.ok, true, (v.errors || []).join('; '));
      const state = loop.createInitialState(v.definition);
      const ins = loop.insertPlannedPhases(
        state,
        1,
        [
          { id: 'improve-r1', prompt: 'improve', eval: { command: 'npm test' } },
          { id: 'improve-r1b', prompt: 'improve', model: 'explicit', eval: { command: 'npm test' } },
        ],
        { checkPromptFiles: false }
      );
      assert.equal(ins.ok, true, ins.error);
      const r1 = state.definition.phases.find((p) => p.id === 'improve-r1');
      const r1b = state.definition.phases.find((p) => p.id === 'improve-r1b');
      assert.equal(loop.resolvePhaseModel(r1, state.definition, {}), want, label);
      assert.notEqual(loop.resolvePhaseModel(r1, state.definition, {}), 'strong', label);
      assert.equal(loop.resolvePhaseModel(r1b, state.definition, {}), 'explicit', label);
    }
  });

  it('validates improveModel and keeps it when saved; planner prompt names it', () => {
    clearMods();
    const loop = require('../lib/loop');
    const bad = loop.validateDefinition(
      { ...base(), phases: [{ id: 'm0', prompt: 'x', improveModel: 'mini', eval: { command: 'npm test' } }] },
      { checkCwd: false }
    );
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(';'), /improveModel is only valid on a plan-next phase/);
    const badTok = loop.validateDefinition({ ...base(), improveModel: 'has space' }, { checkCwd: false });
    assert.equal(badTok.ok, false);

    const v = loop.validateDefinition({ ...base({ improveModel: 'nano' }), improveModel: 'mini' }, { checkCwd: false });
    const w = loop.definitionToWritable(v.definition, null);
    assert.equal(w.improveModel, 'mini');
    assert.equal(w.phases[1].improveModel, 'nano');
    const state = loop.createInitialState(v.definition);
    const prompt = loop.buildPlanNextPrompt(state, v.definition.phases[1], '/tmp/plan-next.json');
    assert.match(prompt, /run on model "nano" unless you set "model"/);
  });
});
