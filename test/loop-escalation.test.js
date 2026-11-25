'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/registry',
    '../lib/config',
    '../lib/memory',
    '../lib/notify',
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

describe('loop escalation (needs_human)', () => {
  let home;
  let cwd;
  let prev;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-esc-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-esc-cwd-'));
    spawnSync('git', ['init'], { cwd, encoding: 'utf8' });
    fs.writeFileSync(path.join(cwd, 'README.md'), '# esc\n');
    spawnSync('git', ['-C', cwd, 'add', 'README.md'], { encoding: 'utf8' });
    spawnSync('git', ['-C', cwd, 'commit', '-m', 'init'], { encoding: 'utf8' });
    prev = {
      HOME: process.env.HOME,
      AGENTFLEET_HOME: process.env.AGENTFLEET_HOME,
    };
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

  function def(name, extra = {}) {
    return {
      name,
      cwd,
      project: 'demo',
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 20, maxHours: 1 },
      escalation: { afterFailedRounds: 3, event: 'loop.needs_human' },
      phases: [
        {
          id: 'p1',
          session: `${name}-p1`,
          prompt: 'do it',
          eval: { command: ['false'], exitCode: 0 },
          maxFixAttempts: 1,
          onPass: 'none',
        },
      ],
      ...extra,
    };
  }

  function harness(runPrompt, runEval) {
    return {
      env: process.env,
      fresh: true,
      ensureSession: async () => ({
        id: 'sess-esc',
        title: 'esc-p1',
        engine: 'cursor',
        cwd,
        status: 'active',
      }),
      runPrompt: runPrompt || (async () => ({
        code: 0,
        timedOut: false,
        stdout: 'done',
        stderr: '',
      })),
      runEval:
        runEval ||
        (async () => ({
          code: 1,
          timedOut: false,
          stdout: 'line1\nline2\nRED EVAL',
          stderr: 'eval stderr tail',
          cwd,
        })),
    };
  }

  it('escalates after exhausted fix attempts when escalation is configured', async () => {
    const loop = require('../lib/loop');
    const capture = await startCapture();
    process.env.AFLT_NOTIFY_URL = capture.url;
    let promptCalls = 0;
    try {
      const result = await loop.runLoop(
        def('esc-human'),
        harness(async () => {
          promptCalls += 1;
          return { code: 0, timedOut: false, stdout: 'ok', stderr: '' };
        })
      );
      assert.equal(result.ok, false);
      assert.equal(result.status, 'needs_human');
      assert.equal(promptCalls, 2);
      const state = loop.loadState('esc-human');
      assert.equal(state.status, 'needs_human');
      assert.equal(state.phases.p1.status, 'failed');
      assert.ok(state.needsHumanAt);
      const bundlePath = loop.needsHumanPath('esc-human');
      assert.ok(fs.existsSync(bundlePath));
      const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      assert.equal(bundle.loop, 'esc-human');
      assert.equal(bundle.phaseId, 'p1');
      assert.match(bundle.lastError, /RED EVAL/);
      assert.equal(bundle.nextStep.resume, 'aflt loop resume esc-human');
      assert.equal(bundle.nextStep.stop, 'aflt loop stop esc-human');
      assert.ok(bundle.logPath.endsWith('state.json'));
      await new Promise((r) => setTimeout(r, 120));
      const events = capture.hits.map((h) => h.event);
      assert.ok(events.includes('loop.needs_human'), events.join(','));
      assert.ok(events.includes('loop.gate.waiting'), events.join(','));
      assert.ok(!events.includes('loop.failed'));
      const human = capture.hits.find((h) => h.event === 'loop.needs_human');
      assert.equal(human.loop, 'esc-human');
      assert.equal(human.phaseId, 'p1');
      assert.match(human.lastError, /RED EVAL/);
    } finally {
      delete process.env.AFLT_NOTIFY_URL;
      await capture.close();
    }
  });

  it('resume restarts the failed phase with a fresh attempt counter', async () => {
    const loop = require('../lib/loop');
    await loop.runLoop(def('esc-resume'), harness());
    let state = loop.loadState('esc-resume');
    assert.equal(state.status, 'needs_human');
    assert.equal(state.attempt, 1);

    let prompts = 0;
  const resumed = await loop.resumeLoop('esc-resume', {
      ...harness(async () => {
        prompts += 1;
        return { code: 0, timedOut: false, stdout: 'ok', stderr: '' };
      }, async () => ({
        code: 0,
        timedOut: false,
        stdout: 'green',
        stderr: '',
        cwd,
      })),
      resume: true,
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.status, 'completed');
    assert.equal(prompts, 1);
    state = loop.loadState('esc-resume');
    assert.equal(state.phases.p1.status, 'passed');
    assert.equal(state.attempt, 0);
  });

  it('stop works from needs_human', async () => {
    const loop = require('../lib/loop');
    await loop.runLoop(def('esc-stop'), harness());
    const state = loop.loadState('esc-stop');
    assert.equal(state.status, 'needs_human');
    const stopped = loop.requestStop('esc-stop', { env: process.env });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.status, 'stopped');
  });

  it('without escalation config the loop fails as before', async () => {
    const loop = require('../lib/loop');
    const capture = await startCapture();
    process.env.AFLT_NOTIFY_URL = capture.url;
    try {
      const noEsc = { ...def('esc-plain') };
      delete noEsc.escalation;
      const result = await loop.runLoop(noEsc, harness());
      assert.equal(result.status, 'failed');
      assert.equal(loop.loadState('esc-plain').status, 'failed');
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(capture.hits.some((h) => h.event === 'loop.failed'));
      assert.ok(!capture.hits.some((h) => h.event === 'loop.needs_human'));
      assert.ok(!fs.existsSync(loop.needsHumanPath('esc-plain')));
    } finally {
      delete process.env.AFLT_NOTIFY_URL;
      await capture.close();
    }
  });

  it('statusReport lists needs_human', async () => {
    const loop = require('../lib/loop');
    await loop.runLoop(def('esc-status'), harness());
    const report = loop.statusReport(null);
    assert.ok(report.loops.some((l) => l.name === 'esc-status' && l.status === 'needs_human'));
  });
});