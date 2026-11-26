'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function clearMods() {
  for (const m of [
    '../lib/util',
    '../lib/usage',
    '../lib/copilot',
    '../lib/turns',
    '../lib/loop',
    '../lib/registry',
    '../lib/config',
    '../lib/making-of',
    '../lib/making-of-view',
    '../lib/dashboard',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('script phases (no AI call)', () => {
  it('validates: no prompt allowed, no fix attempts', () => {
    clearMods();
    const loop = require('../lib/loop');
    const base = { name: 's', cwd: os.tmpdir(), engine: 'cursor', phases: [] };
    const ok = loop.validateDefinition({ ...base, phases: [{ id: 'seed', type: 'script', eval: { command: ['true'] }, maxFixAttempts: 3 }] }, { checkCwd: false });
    assert.equal(ok.ok, true, (ok.errors || []).join('; '));
    assert.equal(ok.definition.phases[0].type, 'script');
    assert.equal(ok.definition.phases[0].maxFixAttempts, 0);
    const bad = loop.validateDefinition({ ...base, phases: [{ id: 'seed', type: 'script', prompt: 'hi', eval: { command: ['true'] } }] }, { checkCwd: false });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(';'), /script phases make no AI call/);
  });

  it('runs the eval without a session or agent call, then continues', async () => {
    clearMods();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-script-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-script-cwd-'));
    const prev = { HOME: process.env.HOME, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME };
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    try {
      git(cwd, ['init', '-q']);
      const loop = require('../lib/loop');
      const prompts = [];
      const sessions = [];
      const def = {
        name: 'script-demo',
        cwd,
        engine: 'cursor',
        allow: { commit: false, merge: false, push: false },
        budget: { maxRuns: 5, maxHours: 1 },
        phases: [
          { id: 'seed', type: 'script', eval: { command: ['sh', '-c', 'echo seeded > SEED.txt'], exitCode: 0 } },
          { id: 'build', prompt: 'Build on the seed', eval: { command: ['test', '-f', 'SEED.txt'], exitCode: 0 }, maxFixAttempts: 0 },
        ],
      };
      const file = path.join(cwd, 'script-demo.json');
      fs.writeFileSync(file, JSON.stringify(def));
      const result = await loop.runFromFile(file, {
        env: { ...process.env },
        ensureSession: async (phase) => {
          sessions.push(phase.id);
          return { id: `sess-${phase.id}`, title: phase.id, engine: 'cursor', cwd, status: 'active' };
        },
        runPrompt: async (session, prompt, phase) => {
          prompts.push(phase.id);
          return { code: 0, timedOut: false, stdout: 'ok', stderr: '', outPath: null, runId: 'r1' };
        },
      });
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(sessions, ['build'], 'no session for the script phase');
      assert.deepEqual(prompts, ['build'], 'no agent call for the script phase');
      assert.equal(fs.readFileSync(path.join(cwd, 'SEED.txt'), 'utf8'), 'seeded\n');
      const state = loop.loadState('script-demo');
      assert.equal(state.phases.seed.status, 'passed');
      assert.equal(state.phases.seed.sessionId == null, true);
      assert.equal(state.phases.seed.lastRun.kind, 'script');
      assert.equal(state.runsUsed, 1, 'script steps do not use the agent-run budget');

      // A failing script fails the phase without fix attempts or agent calls.
      clearMods();
      const loop2 = require('../lib/loop');
      const failDef = { ...def, name: 'script-fail', phases: [{ id: 'seed', type: 'script', eval: { command: ['false'], exitCode: 0 } }] };
      const failFile = path.join(cwd, 'script-fail.json');
      fs.writeFileSync(failFile, JSON.stringify(failDef));
      const failed = await loop2.runFromFile(failFile, {
        env: { ...process.env },
        ensureSession: async () => {
          throw new Error('must not create a session');
        },
        runPrompt: async () => {
          throw new Error('must not call the agent');
        },
      });
      assert.equal(failed.ok, false);
      assert.equal(loop2.loadState('script-fail').phases.seed.status, 'failed');
    } finally {
      clearMods();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('hello-aflt seeds M0 with a script phase (no agent invocation)', () => {
    clearMods();
    const loop = require('../lib/loop');
    const exampleJson = path.join(__dirname, '..', 'examples', 'loops', 'hello-aflt-seeded', 'hello-aflt.json');
    const r = loop.validateFile(exampleJson, { checkCwd: false, cwdBase: os.tmpdir() });
    assert.equal(r.ok, true, (r.errors || []).join('; '));
    const m0 = r.definition.phases[0];
    assert.equal(m0.id, 'm0');
    assert.equal(m0.type, 'script');
    assert.equal(m0.prompt, null);
    assert.equal(m0.promptFile, null);
    assert.equal(path.basename(m0.eval.command[1]), 'seed-m0.js');
    const plan = loop.planDryRun(r.definition, exampleJson);
    assert.equal(plan.phases[0].promptPreview, '(script step: no AI call)');
    assert.equal(plan.phases[0].engine, null);
  });
});
