'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const evalCoverage = require('../lib/eval-coverage');
const loop = require('../lib/loop');
const loopInit = require('../lib/loop-init');

const TIERS = ['facts', 'updates', 'multihop', 'longgap', 'synthesis', 'persona'];

function makeFixture(dir, opts = {}) {
  const min = opts.minPerTier != null ? opts.minPerTier : 3;
  const probes = [];
  for (const tier of TIERS) {
    for (let i = 0; i < (tier === 'updates' && opts.thinUpdates ? 1 : min); i++) {
      const p = {
        id: `${tier[0]}${i}`,
        tier,
        session: i + 1,
        after_turn: i,
        question: `q-${tier}-${i}`,
        expect_any: ['x'],
        forbid: tier === 'updates' && i < 2 ? ['stale'] : [],
      };
      if (tier === 'updates') {
        p.chain = i < 2 ? 'trip' : 'sync';
        if (i === 2) {
          probes.push({
            id: `${tier[0]}${i}b`,
            tier,
            session: i + 1,
            after_turn: i + 1,
            question: `q-${tier}-${i}-b`,
            expect_any: ['x'],
            forbid: ['stale'],
            chain: 'sync',
          });
        }
      }
      probes.push(p);
    }
  }
  fs.mkdirSync(path.join(dir, 'eval', 'fixtures'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'eval', 'fixtures', 'transcript.json'),
    JSON.stringify({ probes, sessions: [{ id: 1, turns: ['hi'] }] }, null, 2)
  );
}

describe('eval-coverage library', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ecov-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('normalizeCoverage accepts tiers and minCasesPerTier', () => {
    const r = evalCoverage.normalizeCoverage(
      { tiers: ['facts', 'persona'], minCasesPerTier: 2, fixture: 'eval/fixtures/transcript.json' },
      'phases[0].eval'
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.tiers, ['facts', 'persona']);
    assert.equal(r.value.minCasesPerTier, 2);
  });

  it('rejects coverage with neither command nor tiers', () => {
    const r = evalCoverage.normalizeCoverage({ minCasesPerTier: 3 }, 'x');
    assert.equal(r.ok, false);
  });

  it('fails thin fixture tiers', () => {
    makeFixture(tmp, { thinUpdates: true });
    const cov = {
      tiers: TIERS,
      minCasesPerTier: 3,
      minUpdateChains: 2,
      fixture: 'eval/fixtures/transcript.json',
    };
    const r = evalCoverage.checkFixtureCoverage(cov, tmp);
    assert.equal(r.ok, false);
    assert.match(r.message, /updates/);
  });

  it('passes a full fixture', () => {
    makeFixture(tmp);
    const cov = {
      tiers: TIERS,
      minCasesPerTier: 3,
      minUpdateChains: 2,
      fixture: 'eval/fixtures/transcript.json',
    };
    const r = evalCoverage.checkFixtureCoverage(cov, tmp);
    assert.equal(r.ok, true);
    assert.equal(r.counts.facts, 3);
  });

  it('protectedFixturesLockSummary mentions non-protected fixes', () => {
    const s = evalCoverage.protectedFixturesLockSummary({
      protected: { paths: ['eval/fixtures/**'], fromPhase: 'm3' },
    });
    assert.match(s, /locked after phase "m3"/);
    assert.match(s, /non-protected/i);
  });
});

describe('loop init prompt mentions tier coverage', () => {
  it('includes eval fixture coverage section', () => {
    const prompt = loopInit.buildLoopInitPrompt({
      projectName: 'p',
      engine: 'cursor',
      models: { build: 'm', plan: 'm' },
      budget: {},
      paths: { outRel: '.agentfleet/loop.json', promptsRel: '.agentfleet/prompts' },
      docs: { spec: '# x', agents: '', guidance: [] },
      guide: 'guide',
    });
    assert.match(prompt, /eval\.coverage/i);
    assert.match(prompt, /minCasesPerTier/i);
  });
});

describe('plan-next prompt after protected violation', () => {
  it('warns that fixtures are locked', () => {
    const state = {
      definition: {
        name: 'x',
        goal: 'g',
        acceptance: 'a',
        protected: { paths: ['eval/fixtures/**', 'scripts/eval/**'], fromPhase: 'eval' },
        phases: [{ id: 'plan-next', type: 'plan-next', prompt: 'go' }],
      },
      history: [
        {
          event: 'loop.phase.protected_violation',
          phaseId: 'improve-r1',
          summary: 'protected path eval/fixtures/transcript.json changed',
        },
      ],
    };
    const prompt = loop.buildPlanNextPrompt(state, state.definition.phases[0], '/tmp/plan-next.json');
    assert.match(prompt, /Protected eval assets/);
    assert.match(prompt, /protected_violation/);
    assert.match(prompt, /do not edit fixtures/i);
  });
});

describe('loop runner eval.coverage', () => {
  let home;
  let fleet;
  let repo;
  let stubBin;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ecov-home-'));
    fleet = path.join(home, '.agentfleet');
    fs.mkdirSync(fleet, { recursive: true });
    stubBin = path.join(home, 'cursor-agent');
    fs.writeFileSync(stubBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ecov-repo-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    makeFixture(repo, { thinUpdates: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('retries eval phase on thin fixture coverage (fix attempts)', async () => {
    let prompts = 0;
    const def = {
      name: 'cov-loop',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 5, maxHours: 1, maxPhases: 4 },
      phases: [
        {
          id: 'eval',
          prompt: 'seed eval',
          eval: {
            command: ['true'],
            exitCode: 0,
            coverage: { tiers: TIERS, minCasesPerTier: 3, minUpdateChains: 2 },
          },
          maxFixAttempts: 2,
          onPass: 'none',
          force: true,
        },
      ],
    };
    const file = path.join(home, 'cov-loop.json');
    fs.writeFileSync(file, JSON.stringify(def));
    const result = await loop.runFromFile(file, {
      fresh: true,
      env: { ...process.env, HOME: home, AGENTFLEET_HOME: fleet, AGENTFLEET_CURSOR_BIN: stubBin },
      allowExisting: true,
      ensureSession: async () => ({ id: 's1', title: 't', engine: 'cursor', cwd: repo, status: 'active' }),
      runPrompt: async () => {
        prompts += 1;
        if (prompts === 2) makeFixture(repo);
        return { code: 0, timedOut: false, stdout: 'ok', stderr: '', outPath: null, runId: `r${prompts}` };
      },
      runEval: async () => ({ code: 0, timedOut: false, stdout: '{}', stderr: '', cwd: repo }),
    });
    assert.equal(result.ok, true);
    assert.equal(prompts, 2, 'one fix attempt after coverage failure');
    const st = loop.loadState('cov-loop');
    assert.ok(st.history.some((h) => h.event === 'loop.phase.eval_failed' && /coverage/i.test(h.summary)));
    assert.equal(st.phases.eval.status, 'passed');
  });

  it('protected violation summary mentions locked fixtures', async () => {
    makeFixture(repo);
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-q', '-m', 'eval seed'], { cwd: repo });
    const def = {
      name: 'prot-cov',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      protected: { paths: ['eval/fixtures/**'], fromPhase: 'eval' },
      budget: { maxRuns: 5, maxHours: 1, maxPhases: 4 },
      phases: [
        {
          id: 'eval',
          prompt: 'done',
          eval: { command: ['true'], exitCode: 0 },
          onPass: 'none',
          force: true,
        },
        {
          id: 'm1',
          prompt: 'build',
          eval: { command: ['true'], exitCode: 0 },
          onPass: 'none',
          force: true,
        },
      ],
    };
    const file = path.join(home, 'prot-cov.json');
    fs.writeFileSync(file, JSON.stringify(def));
    const result = await loop.runFromFile(file, {
      fresh: true,
      env: { ...process.env, HOME: home, AGENTFLEET_HOME: fleet, AGENTFLEET_CURSOR_BIN: stubBin },
      allowExisting: true,
      ensureSession: async () => ({ id: 's2', title: 't', engine: 'cursor', cwd: repo, status: 'active' }),
      runPrompt: async () => {
        fs.appendFileSync(path.join(repo, 'eval', 'fixtures', 'transcript.json'), '\n');
        return { code: 0, timedOut: false, stdout: 'ok', stderr: '', outPath: null, runId: 'r1' };
      },
      runEval: async () => ({ code: 0, timedOut: false, stdout: '', stderr: '', cwd: repo }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /non-protected/i);
    assert.match(result.error, /eval\/fixtures/);
  });
});

describe('validateDefinition accepts eval.coverage', () => {
  it('normalizes coverage on a phase eval', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ecov-val-'));
    try {
      const def = {
        name: 'v',
        cwd,
        engine: 'cursor',
        budget: { maxRuns: 1, maxHours: 1, maxPhases: 2 },
        phases: [
          {
            id: 'eval',
            prompt: 'x',
            eval: {
              command: 'true',
              coverage: { tiers: ['facts'], minCasesPerTier: 2 },
            },
          },
        ],
      };
      const v = loop.validateDefinition(def);
      assert.equal(v.ok, true);
      assert.deepEqual(v.definition.phases[0].eval.coverage.tiers, ['facts']);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});