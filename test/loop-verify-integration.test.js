'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function clearMods() {
  for (const m of ['../lib/loop', '../lib/registry', '../lib/config', '../lib/memory', '../lib/notify', '../lib/loop-verify']) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

describe('runLoop + verify tiers', () => {
  let home;
  let cwd;
  let prev;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-verify-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-verify-cwd-'));
    spawnSync('git', ['init', '-q'], { cwd });
    spawnSync('git', ['-C', cwd, 'config', 'user.email', 't@example.com']);
    spawnSync('git', ['-C', cwd, 'config', 'user.name', 'T']);
    fs.writeFileSync(path.join(cwd, 'README.md'), '# v\n');
    spawnSync('git', ['-C', cwd, 'add', '-A']);
    spawnSync('git', ['-C', cwd, 'commit', '-q', '-m', 'init']);
    prev = { HOME: process.env.HOME, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME, AFLT_NOTIFY_URL: process.env.AFLT_NOTIFY_URL };
    delete process.env.AFLT_NOTIFY_URL;
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

  function def(name) {
    return {
      name,
      cwd,
      project: 'demo',
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 20, maxHours: 1 },
      verify: { tier1: { command: ['npm', 'test'], timeoutSec: 60 } },
      phases: [
        {
          id: 'build',
          session: `${name}-build`,
          prompt: 'do it',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 1,
          onPass: 'none',
        },
      ],
    };
  }

  function harness(tier1Code, calls) {
    return {
      env: process.env,
      fresh: true,
      ensureSession: async () => ({ id: 'sess-v', title: 'v-build', engine: 'cursor', cwd, status: 'active' }),
      runPrompt: async () => ({ code: 0, timedOut: false, stdout: 'ok', stderr: '' }),
      runEval: async () => ({ code: 0, timedOut: false, stdout: 'ok', stderr: '', cwd }),
      runVerifyCommand: async (command) => {
        calls.push(command.join(' '));
        return tier1Code === 0
          ? { code: 0, stdout: 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ skipped 0\n', stderr: '' }
          : { code: 1, stdout: 'ℹ tests 3\nℹ pass 2\nℹ fail 1\nℹ skipped 0\n', stderr: '' };
      },
    };
  }

  it('a failing tier fails the phase and names the tier in history and lastError', async () => {
    const loop = require('../lib/loop');
    const calls = [];
    const result = await loop.runLoop(def('verify-red'), harness(1, calls));
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2, 'tier1 runs on the first attempt and the fix attempt');
    const state = loop.loadState('verify-red');
    const evalFailed = state.history.find((h) => h.event === 'loop.phase.eval_failed');
    assert.match(evalFailed.summary, /^verify tier1 failed: npm test/);
    assert.match(state.lastError, /verify tier1 failed: npm test 2\/3 \(1 failed\)|verify tier1 failed: npm test/);
    assert.doesNotMatch(state.lastError, /last eval exit 0/);
  });

  it('a green tier passes the phase and is recorded on phase verification', async () => {
    const loop = require('../lib/loop');
    const calls = [];
    const result = await loop.runLoop(def('verify-green'), harness(0, calls));
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const state = loop.loadState('verify-green');
    const tier1 = (state.phases.build.verification || []).find((v) => v.tier === 'tier1');
    assert.ok(tier1 && tier1.ok, JSON.stringify(state.phases.build.verification));
    assert.equal(state.phases.build.verifyFailure, null);
  });
});
