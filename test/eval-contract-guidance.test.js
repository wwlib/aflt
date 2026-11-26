'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const loop = require('../lib/loop');
const pp = require('../lib/protected-paths');
const projectInit = require('../lib/project-init');
const loopInit = require('../lib/loop-init');

const { evalPassed, isInfraEvalFailure } = loop;
const t = loop._test;

describe('eval contract: evalPassed', () => {
  it('keeps passRegex behavior when no contract fields', () => {
    const spec = { exitCode: 0, passRegex: 'tiers' };
    assert.equal(evalPassed(spec, { code: 0, timedOut: false, stdout: '{"tiers":{}}', stderr: '' }), true);
    assert.equal(evalPassed(spec, { code: 0, timedOut: false, stdout: 'no json', stderr: '' }), false);
  });

  it('enforces minOverall, minTiers, and noRegress', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ec-'));
  try {
    fs.mkdirSync(path.join(tmp, 'eval'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'eval', 'history.jsonl'),
      `${JSON.stringify({ mode: 'live', overall: 90 })}\n${JSON.stringify({ mode: 'live', overall: 92 })}\n`
    );
    const spec = {
      exitCode: 0,
      minOverall: 85,
      minTiers: { facts: 80, persona: 70 },
      noRegress: true,
    };
    const okOut = {
      code: 0,
      timedOut: false,
      stdout: JSON.stringify({ overall: 93, tiers: { facts: 90, persona: 75 } }),
      stderr: '',
    };
    assert.equal(evalPassed(spec, okOut, { cwd: tmp }), true);
    assert.equal(
      evalPassed(spec, { ...okOut, stdout: JSON.stringify({ overall: 91, tiers: { facts: 90, persona: 75 } }) }, { cwd: tmp }),
      false
    );
    assert.equal(
      evalPassed(spec, { ...okOut, stdout: JSON.stringify({ overall: 95, tiers: { facts: 50, persona: 75 } }) }, { cwd: tmp }),
      false
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  });
});

describe('protected fromPhase', () => {
  const definition = {
    protected: { paths: ['eval/**'], fromPhase: 'eval' },
    phases: [
      { id: 'm0' },
      { id: 'eval' },
      { id: 'm1' },
      { id: 'improve-r1', planned: true },
    ],
  };
  it('skips loop paths before and including fromPhase', () => {
    assert.deepEqual(pp.effectivePatterns(definition, { id: 'm0' }, { phaseIndex: 0, fromPhaseIndex: 1 }), []);
    assert.deepEqual(pp.effectivePatterns(definition, { id: 'eval' }, { phaseIndex: 1, fromPhaseIndex: 1 }), []);
    assert.deepEqual(pp.effectivePatterns(definition, { id: 'm1' }, { phaseIndex: 2, fromPhaseIndex: 1 }), ['eval/**']);
    assert.deepEqual(pp.effectivePatterns(definition, { id: 'improve-r1' }, { phaseIndex: 3, fromPhaseIndex: 1 }), [
      'eval/**',
    ]);
  });
});

describe('aflt init --guidance', () => {
  let home;
  let work;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-guid-home-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'af-guid-work-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('copies guidance and adds SPEC pointer', () => {
    const guidance = path.join(work, 'brief.md');
    fs.writeFileSync(guidance, '# Brief\n');
    const res = spawnSync(process.execPath, [afJs, 'init', 'chat-agent', '--yes', '--json', '--guidance', guidance, '--no-space'], {
      cwd: work,
      env: { ...process.env, HOME: home, AGENTFLEET_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const out = JSON.parse(res.stdout);
    const dir = out.dir;
    const rel = out.guidance;
    assert.equal(rel, 'docs/guidance/brief.md');
    assert.ok(fs.existsSync(path.join(dir, rel)));
    const spec = fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8');
    assert.match(spec, /docs\/guidance\/brief\.md/);
  });
});

describe('loop init guidance prompt', () => {
  it('includes docs/guidance in the drafter prompt', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-li-g-'));
    try {
      fs.mkdirSync(path.join(cwd, 'docs', 'guidance'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'docs', 'guidance', 'eval.md'), 'Build transcript eval\n');
      fs.writeFileSync(path.join(cwd, 'SPEC.md'), '# spec\n');
      const docs = loopInit.readProjectDocs(cwd);
      const prompt = loopInit.buildLoopInitPrompt({
        projectName: 'p',
        engine: 'cursor',
        models: { build: 'm', plan: 'm' },
        budget: {},
        paths: { outRel: '.agentfleet/loop.json', promptsRel: '.agentfleet/prompts' },
        docs,
        guide: 'guide text',
      });
      assert.match(prompt, /Human guidance/);
      assert.match(prompt, /transcript eval/i);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('script eval infra retry', () => {
  it('classifies timeout and pattern as infrastructure', () => {
    const spec = { infraExitCodes: [124], infraPattern: 'ai-lb.*unreachable' };
    assert.equal(isInfraEvalFailure({ code: 124, timedOut: true, stderr: '' }, spec), true);
    assert.equal(isInfraEvalFailure({ code: 1, timedOut: false, stderr: 'ai-lb unreachable' }, spec), true);
    assert.equal(isInfraEvalFailure({ code: 1, timedOut: false, stderr: 'assertion failed' }, spec), false);
  });
});

describe('plan-next short-circuit and gate baseSha', () => {
  let home;
  let fleet;
  let repo;
  let stubBin;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pn-home-'));
    fleet = path.join(home, '.agentfleet');
    fs.mkdirSync(fleet, { recursive: true });
    stubBin = path.join(home, 'cursor-agent');
    fs.writeFileSync(stubBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pn-repo-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    spawnSync('git', ['add', '-A'], { cwd: repo });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    fs.mkdirSync(path.join(repo, 'eval'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'eval', 'history.jsonl'),
      `${JSON.stringify({ mode: 'live', overall: 96 })}\n`
    );
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('skips plan-next AI when target is met', async () => {
    const def = {
      name: 'pn-loop',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 5, maxHours: 1, maxPhases: 8 },
      phases: [
        {
          id: 'plan-next',
          type: 'plan-next',
          prompt: 'plan',
          targetOverall: 95,
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 0,
          onPass: 'none',
          force: true,
        },
      ],
    };
    const file = path.join(home, 'pn-loop.json');
    fs.writeFileSync(file, JSON.stringify(def));
    let prompts = 0;
    const result = await loop.runFromFile(file, {
      fresh: true,
      env: { ...process.env, HOME: home, AGENTFLEET_HOME: fleet, AGENTFLEET_CURSOR_BIN: stubBin },
      allowExisting: true,
      ensureSession: async () => ({ id: 's1', title: 't', engine: 'cursor', cwd: repo, status: 'active' }),
      runPrompt: async () => {
        prompts += 1;
        return { code: 0, timedOut: false, stdout: 'ok', stderr: '', outPath: null, runId: 'r1' };
      },
      runEval: async () => ({ code: 0, timedOut: false, stdout: '', stderr: '', cwd: repo }),
    });
    assert.equal(result.ok, true);
    assert.ok(result.state.history.some((h) => h.event === 'loop.plan_next.short_circuit'));
    assert.equal(prompts, 0);
  });

  it('records baseSha after gate approval, not at phase start', async () => {
    const def = {
      name: 'gate-sha',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 10, maxHours: 2 },
      phases: [
        {
          id: 'gated',
          engine: 'cursor',
          prompt: 'noop',
          gate: 'approve',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 0,
          onPass: 'none',
        },
      ],
    };
    const file = path.join(home, 'gate-sha.json');
    fs.writeFileSync(file, JSON.stringify(def));
    const first = await loop.runFromFile(file, {
      fresh: true,
      env: { ...process.env, HOME: home, AGENTFLEET_HOME: fleet, AGENTFLEET_CURSOR_BIN: stubBin },
      allowExisting: true,
      ensureSession: async () => ({ id: 's2', title: 't', engine: 'cursor', cwd: repo, status: 'active' }),
      runPrompt: async () => {
        throw new Error('should not run before approve');
      },
      runEval: async () => ({ code: 0, timedOut: false, stdout: '', stderr: '', cwd: repo }),
    });
    assert.equal(first.status, 'waiting');
    assert.equal(first.state.phases.gated.baseSha, null);
    fs.writeFileSync(path.join(repo, 'during-gate.txt'), 'human edit\n');
    loop.requestApprove('gate-sha');
    const after = loop.loadState('gate-sha');
    assert.ok(after.phases.gated.baseSha);
  });

  it('retries script eval on infrastructure failure', async () => {
    let evalCalls = 0;
    const def = {
      name: 'script-infra',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 5, maxHours: 1 },
      phases: [
        {
          id: 'live',
          type: 'script',
          eval: { command: ['node', '-e', 'process.exit(124)'], exitCode: 0, infraRetries: 1, infraExitCodes: [124] },
          onPass: 'none',
        },
      ],
    };
    const file = path.join(home, 'script-infra.json');
    fs.writeFileSync(file, JSON.stringify(def));
    const result = await loop.runFromFile(file, {
      fresh: true,
      env: { ...process.env, HOME: home, AGENTFLEET_HOME: fleet, AGENTFLEET_CURSOR_BIN: stubBin },
      allowExisting: true,
      runEval: async () => {
        evalCalls += 1;
        if (evalCalls === 1) {
          return { code: 124, timedOut: true, stdout: '', stderr: 'timed out', cwd: repo };
        }
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify({ overall: 90, tiers: { facts: 90 } }),
          stderr: '',
          cwd: repo,
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(evalCalls, 2);
    assert.ok(result.state.history.some((h) => h.event === 'loop.phase.infra_retry'));
  });
});

describe('projectInit.installGuidance', () => {
  it('installs relative path under docs/guidance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ig-'));
    const src = path.join(dir, 'g.md');
    fs.writeFileSync(src, 'hi\n');
    const r = projectInit.installGuidance(dir, src, false);
    assert.equal(r.ok, true);
    assert.equal(r.relative, 'docs/guidance/g.md');
    assert.ok(fs.existsSync(r.dest));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});