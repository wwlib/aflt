'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const afJs = path.join(repoRoot, 'bin', 'af.js');

function clearMods() {
  for (const m of [
    '../scripts/eval/improve',
    '../scripts/eval/gate',
    '../scripts/eval/score',
    '../scripts/eval/report',
    '../scripts/eval/rubric',
    '../scripts/eval/index',
    '../lib/loop',
    '../lib/notify',
    '../lib/config',
    '../lib/memory',
    '../lib/registry',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function fixtureMeasureResults(overrides = {}) {
  return {
    version: 1,
    measuredAt: '2026-11-21T12:00:00.000Z',
    ok: true,
    suite: {
      ok: true,
      pass: 10,
      fail: 0,
      skip: 0,
      flakes: [],
      hardFails: [],
      skipped: false,
    },
    coverage: {
      available: true,
      reason: null,
      totals: {
        lines: { total: 100, covered: 80, percent: 80 },
        functions: { total: 50, covered: 40, percent: 80 },
        branches: { total: 20, covered: 10, percent: 50 },
      },
    },
    cliSmoke: {
      ok: true,
      failures: 0,
      commandCount: 5,
      commands: [
        { id: 'version', mode: 'run', ok: true, exitCode: 0 },
        { id: 'help', mode: 'run', ok: true, exitCode: 0 },
      ],
    },
    dashboardApi: {
      ok: true,
      routes: [{ path: '/api/state', ok: true }],
    },
    ...overrides,
  };
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function appendHistory(historyPath, rows) {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  for (const row of rows) {
    fs.appendFileSync(historyPath, JSON.stringify(row) + '\n');
  }
}

describe('aflt eval improve loop (E3)', () => {
  let prevHome;
  let prevAfHome;
  let prevTest;
  let prevMemory;
  let home;
  let tmp;
  let memoryRepo;

  beforeEach(() => {
    clearMods();
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevTest = process.env.AGENTFLEET_TEST;
    prevMemory = process.env.AFLT_MEMORY_REPO;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-eval-e3-'));
    tmp = path.join(home, 'work');
    memoryRepo = path.join(home, 'memory');
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(path.join(home, '.agentfleet'), { recursive: true });
    fs.mkdirSync(memoryRepo, { recursive: true });
    fs.writeFileSync(
      path.join(memoryRepo, '.aflt-memory.json'),
      JSON.stringify({ version: 1 }) + '\n'
    );
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    process.env.AGENTFLEET_TEST = '1';
    process.env.AFLT_MEMORY_REPO = memoryRepo;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevTest === undefined) delete process.env.AGENTFLEET_TEST;
    else process.env.AGENTFLEET_TEST = prevTest;
    if (prevMemory === undefined) delete process.env.AFLT_MEMORY_REPO;
    else process.env.AFLT_MEMORY_REPO = prevMemory;
    clearMods();
  });

  it('improveGate passes when suite green, score >= baseline, rubric clean', () => {
    const { improveGate, recordBaseline } = require('../scripts/eval/improve');
    const resultsPath = path.join(tmp, 'results', 'ok.json');
    writeJson(resultsPath, fixtureMeasureResults());
    const historyPath = path.join(tmp, 'history.jsonl');
    appendHistory(historyPath, [
      { scoredAt: '2026-11-21T12:00:00.000Z', overall: 80, resultsPath },
      { scoredAt: '2026-11-21T13:00:00.000Z', overall: 85, resultsPath },
    ]);
    const baselinePath = path.join(tmp, 'baseline.json');
    recordBaseline({
      baselinePath,
      overall: 80,
      scoredAt: '2026-11-21T12:00:00.000Z',
      resultsPath,
      maxRounds: 3,
    });

    const out = improveGate({
      repoRoot,
      baselinePath,
      resultsPath,
      historyPath,
      changedFiles: ['README.md', 'lib/loop.js'],
    });
    assert.equal(out.ok, true, JSON.stringify(out.failures));
    assert.deepEqual(out.failures, []);
    const byId = Object.fromEntries(out.checks.map((c) => [c.id, c]));
    assert.equal(byId.rubric_guard.ok, true);
    assert.equal(byId.suite_green.ok, true);
    assert.equal(byId.score_vs_baseline.ok, true);
    assert.equal(byId.score_vs_baseline.overall, 85);
    assert.equal(byId.score_vs_baseline.baseline, 80);
  });

  it('improveGate fails when score drops below baseline', () => {
    const { improveGate, recordBaseline } = require('../scripts/eval/improve');
    const resultsPath = path.join(tmp, 'results', 'ok.json');
    writeJson(resultsPath, fixtureMeasureResults());
    const historyPath = path.join(tmp, 'history.jsonl');
    appendHistory(historyPath, [
      { scoredAt: '2026-11-21T13:00:00.000Z', overall: 70, resultsPath },
    ]);
    const baselinePath = path.join(tmp, 'baseline.json');
    recordBaseline({
      baselinePath,
      overall: 80,
      scoredAt: '2026-11-21T12:00:00.000Z',
      maxRounds: 3,
    });

    const out = improveGate({
      repoRoot,
      baselinePath,
      resultsPath,
      historyPath,
      changedFiles: ['lib/util.js'],
    });
    assert.equal(out.ok, false);
    assert.ok(out.failures.includes('score_vs_baseline'));
    const scoreCheck = out.checks.find((c) => c.id === 'score_vs_baseline');
    assert.match(scoreCheck.detail, /70 < baseline 80/);
  });

  it('improveGate fails when a protected rubric/scorer path is touched', () => {
    const { improveGate, recordBaseline } = require('../scripts/eval/improve');
    const resultsPath = path.join(tmp, 'results', 'ok.json');
    writeJson(resultsPath, fixtureMeasureResults());
    const historyPath = path.join(tmp, 'history.jsonl');
    appendHistory(historyPath, [
      { scoredAt: '2026-11-21T13:00:00.000Z', overall: 90, resultsPath },
    ]);
    const baselinePath = path.join(tmp, 'baseline.json');
    recordBaseline({ baselinePath, overall: 80, scoredAt: '2026-11-21T12:00:00.000Z' });

    const out = improveGate({
      repoRoot,
      baselinePath,
      resultsPath,
      historyPath,
      changedFiles: ['eval/RUBRIC.md', 'README.md'],
    });
    assert.equal(out.ok, false);
    assert.ok(out.failures.includes('rubric_guard'));
    assert.deepEqual(out.rubric.violations, ['eval/RUBRIC.md']);
  });

  it('improveGate fails when suite is not green', () => {
    const { improveGate, recordBaseline } = require('../scripts/eval/improve');
    const resultsPath = path.join(tmp, 'results', 'bad-suite.json');
    writeJson(
      resultsPath,
      fixtureMeasureResults({
        ok: false,
        suite: {
          ok: false,
          pass: 8,
          fail: 2,
          skip: 0,
          flakes: [],
          hardFails: ['test/x.test.js'],
          skipped: false,
        },
      })
    );
    const historyPath = path.join(tmp, 'history.jsonl');
    appendHistory(historyPath, [{ scoredAt: '2026-11-21T13:00:00.000Z', overall: 90 }]);
    const baselinePath = path.join(tmp, 'baseline.json');
    recordBaseline({ baselinePath, overall: 80, scoredAt: '2026-11-21T12:00:00.000Z' });

    const out = improveGate({
      repoRoot,
      baselinePath,
      resultsPath,
      historyPath,
      changedFiles: [],
    });
    assert.equal(out.ok, false);
    assert.ok(out.failures.includes('suite_green'));
  });

  it('shouldStopImprove on plateau and max rounds', () => {
    const { shouldStopImprove, recordBaseline } = require('../scripts/eval/improve');
    const baselinePath = path.join(tmp, 'baseline.json');
    const historyPath = path.join(tmp, 'history.jsonl');
    recordBaseline({
      baselinePath,
      overall: 80,
      scoredAt: '2026-11-21T12:00:00.000Z',
      maxRounds: 3,
    });

    appendHistory(historyPath, [
      { scoredAt: '2026-11-21T12:00:00.000Z', overall: 80 },
      { scoredAt: '2026-11-21T13:00:00.000Z', overall: 80 },
    ]);
    const plateau = shouldStopImprove({
      baselinePath,
      historyPath,
      maxRounds: 3,
    });
    assert.equal(plateau.stop, true);
    assert.equal(plateau.reason, 'plateau');
    assert.equal(plateau.latest, 80);
    assert.equal(plateau.previous, 80);

    const history2 = path.join(tmp, 'history2.jsonl');
    appendHistory(history2, [
      { scoredAt: '2026-11-21T12:00:00.000Z', overall: 80 },
      { scoredAt: '2026-11-21T13:00:00.000Z', overall: 82 },
      { scoredAt: '2026-11-21T14:00:00.000Z', overall: 84 },
      { scoredAt: '2026-11-21T15:00:00.000Z', overall: 86 },
    ]);
    const capped = shouldStopImprove({
      baselinePath,
      historyPath: history2,
      maxRounds: 3,
    });
    assert.equal(capped.stop, true);
    assert.equal(capped.reason, 'max-rounds');
    assert.equal(capped.rounds, 3);

    const history3 = path.join(tmp, 'history3.jsonl');
    appendHistory(history3, [
      { scoredAt: '2026-11-21T12:00:00.000Z', overall: 80 },
      { scoredAt: '2026-11-21T13:00:00.000Z', overall: 85 },
    ]);
    const cont = shouldStopImprove({
      baselinePath,
      historyPath: history3,
      maxRounds: 3,
    });
    assert.equal(cont.stop, false);
    assert.equal(cont.reason, null);
    assert.equal(cont.rounds, 1);
  });

  it('CLI: score --write-baseline + gate --improve + plateau', () => {
    const resultsDir = path.join(tmp, 'cli-results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const resultsPath = path.join(resultsDir, '2026-11-21T16-00-00-000Z.json');
    writeJson(
      resultsPath,
      fixtureMeasureResults({
        errorSamples: [
          {
            message: 'unknown eval subcommand: nope\nusage: aflt eval',
            command: 'eval',
            expectCommand: true,
          },
        ],
      })
    );
    const historyPath = path.join(tmp, 'cli-history.jsonl');
    const baselinePath = path.join(tmp, 'cli-baseline.json');
    const env = {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      AGENTFLEET_TEST: '1',
      AFLT_EVAL_SKIP_QUALITATIVE: '1',
    };

    const scoreRun = spawnSync(
      process.execPath,
      [
        afJs,
        'eval',
        'score',
        resultsPath,
        '--json',
        '--history',
        historyPath,
        '--write-baseline',
        baselinePath,
        '--max-rounds',
        '3',
      ],
      { encoding: 'utf8', env, cwd: repoRoot, timeout: 60_000 }
    );
    assert.equal(scoreRun.status, 0, scoreRun.stderr + scoreRun.stdout);
    const scored = JSON.parse(scoreRun.stdout);
    assert.equal(scored.ok, true);
    assert.ok(scored.baseline);
    assert.equal(scored.baseline.path, baselinePath);
    assert.equal(scored.baseline.maxRounds, 3);
    assert.ok(fs.existsSync(baselinePath));

    const gatePass = spawnSync(
      process.execPath,
      [
        afJs,
        'eval',
        'gate',
        '--improve',
        '--json',
        '--baseline',
        baselinePath,
        '--results',
        resultsPath,
        '--history',
        historyPath,
        '--paths',
        'eval/RUBRIC.md,scripts/eval/score.js,scripts/eval/rubric.js',
      ],
      { encoding: 'utf8', env, cwd: repoRoot, timeout: 30_000 }
    );
    // Working tree may touch protected paths; inject score-only path via unit
    // tests above. Here we only assert JSON shape for --improve.
    assert.ok(gatePass.stdout, gatePass.stderr);
    const gatePayload = JSON.parse(gatePass.stdout);
    assert.equal(gatePayload.improve, true);
    assert.ok(Array.isArray(gatePayload.checks));
    assert.ok(Array.isArray(gatePayload.failures));

    const plateauRun = spawnSync(
      process.execPath,
      [
        afJs,
        'eval',
        'plateau',
        '--json',
        '--baseline',
        baselinePath,
        '--history',
        historyPath,
        '--max-rounds',
        '3',
      ],
      { encoding: 'utf8', env, cwd: repoRoot, timeout: 15_000 }
    );
    assert.equal(plateauRun.status, 0, plateauRun.stderr + plateauRun.stdout);
    const plateau = JSON.parse(plateauRun.stdout);
    assert.equal(plateau.ok, true);
    assert.equal(typeof plateau.stop, 'boolean');
  });

  it('example self-improve.json validates and normalizes integration fields', () => {
    const loop = require('../lib/loop');
    const example = path.join(repoRoot, 'examples', 'loops', 'self-improve.json');
    assert.ok(fs.existsSync(example));
    const raw = JSON.parse(fs.readFileSync(example, 'utf8'));
    raw.cwd = tmp;
    const file = path.join(tmp, 'self-improve.json');
    writeJson(file, raw);
    const result = loop.validateFile(file, { checkPromptFiles: false, checkCwd: false });
    assert.equal(result.ok, true, (result.errors || []).join('; '));
    const def = result.definition;
    assert.equal(def.plannedPhaseGate, 'none');
    assert.equal(def.allow.commit, true);
    assert.equal(def.allow.merge, false);
    assert.equal(def.allow.push, false);
    assert.equal(def.budget.maxPhases, 16);
    assert.deepEqual(def.engines, ['copilot', 'cursor', 'opencode']);
    assert.equal(def.workdir.mode, 'worktree');
    assert.equal(def.workdir.base, 'main');
    assert.ok(def.protected && def.protected.paths.includes('scripts/eval/**'));
    assert.ok(def.verify && def.verify.tier3 && def.verify.tier3.tileDungeon);
    assert.equal(def.commitGate.mode, 'observe');
    assert.deepEqual(def.commitGate.requireTiers, ['tier1']);
    assert.equal(def.escalation.afterFailedRounds, 3);
    assert.equal(def.escalation.event, 'loop.needs_human');
    const preflight = def.phases.find((p) => p.id === 'preflight');
    assert.ok(preflight);
    assert.equal(preflight.verify, false);
    const measure = def.phases.find((p) => p.id === 'measure');
    assert.equal(measure.verify, false);
    const plan = def.phases.find((p) => p.type === 'plan-next');
    assert.ok(plan);
    assert.match(plan.prompt || '', /RUBRIC|baseline|plateau|verify|tier3/i);
  });

  it('example self-improve.json CLI validate and dry-run', () => {
    const example = path.join(repoRoot, 'examples', 'loops', 'self-improve.json');

    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-self-wt-'));
    const wtDir = path.join(wtRoot, 'aflt-self');
    const branch = `test/self-improve-${Date.now()}`;
    const add = spawnSync('git', ['worktree', 'add', '-b', branch, wtDir, 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr);
    const raw = JSON.parse(fs.readFileSync(example, 'utf8'));
    raw.cwd = wtDir;
    const file = path.join(wtRoot, 'self-improve-dry.json');
    writeJson(file, raw);

    const val = spawnSync(process.execPath, [afJs, 'loop', 'validate', file, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTFLEET_TEST: '1' },
    });
    assert.equal(val.status, 0, val.stderr + val.stdout);
    const vj = JSON.parse(val.stdout);
    assert.equal(vj.ok, true, (vj.errors || []).join('; '));
    assert.equal(vj.definition.engines.length, 3);

    const dry = spawnSync(
      process.execPath,
      [afJs, 'loop', 'run', file, '--dry-run', '--json'],
      { encoding: 'utf8', env: { ...process.env, AGENTFLEET_ENGINE: 'copilot', AGENTFLEET_TEST: '1' } }
    );
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    const dj = JSON.parse(dry.stdout);
    assert.equal(dj.ok, true, dj.error || (dj.errors || []).join('; '));
    assert.equal(dj.dryRun, true);
    assert.equal(dj.name, 'self-improve');
    spawnSync('git', ['worktree', 'remove', '--force', wtDir], { cwd: repoRoot, encoding: 'utf8' });
    spawnSync('git', ['branch', '-D', branch], { cwd: repoRoot, encoding: 'utf8' });
  });

  it('example self-improve.json is unpinned and follows AGENTFLEET_ENGINE', () => {
    const loop = require('../lib/loop');
    const example = path.join(repoRoot, 'examples', 'loops', 'self-improve.json');
    const raw = JSON.parse(fs.readFileSync(example, 'utf8'));
    assert.equal(raw.engine, undefined);
    for (const p of raw.phases) assert.equal(p.engine, undefined, p.id);
    raw.cwd = tmp;
    const file = path.join(tmp, 'self-improve-unpinned.json');
    writeJson(file, raw);
    for (const engine of ['copilot', 'cursor', 'opencode']) {
      const result = loop.validateFile(file, {
        checkPromptFiles: false,
        env: { ...process.env, AGENTFLEET_ENGINE: engine },
      });
      assert.equal(result.ok, true, (result.errors || []).join('; '));
      assert.equal(result.definition.engine, engine);
      assert.ok(result.definition.phases.length > 0);
      for (const p of result.definition.phases) assert.equal(p.engine, engine, p.id);
    }
  });

  it('hermetic fake engine: one improve round, passing gate, stop on plateau', async () => {
    const loop = require('../lib/loop');
    const {
      improveGate,
      recordBaseline,
      shouldStopImprove,
    } = require('../scripts/eval/improve');

    const resultsDir = path.join(tmp, 'results');
    const historyPath = path.join(tmp, 'history.jsonl');
    const baselinePath = path.join(tmp, 'baseline.json');
    fs.mkdirSync(resultsDir, { recursive: true });

    const def = {
      name: 'self-improve-e3',
      project: 'aflt',
      cwd: tmp,
      engine: 'cursor',
      goal: 'One small fix then stop on plateau.',
      acceptance: 'Suite green, score >= baseline, stop on plateau.',
      plannedPhaseGate: 'none',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 30, maxHours: 2, maxPhases: 12 },
      phases: [
        {
          id: 'measure',
          session: 'loop-e3',
          prompt: 'READY measure',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 0,
          onPass: 'none',
          force: false,
        },
        {
          id: 'score-baseline',
          session: 'loop-e3',
          prompt: 'READY score',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 0,
          onPass: 'none',
          force: false,
        },
        {
          id: 'plan-next',
          type: 'plan-next',
          session: 'loop-e3-planner',
          prompt:
            'Pick ONE fix. Do not edit RUBRIC. Stop on plateau. Autonomous: plannedPhaseGate none.',
          maxFixAttempts: 1,
          onPass: 'none',
          force: true,
        },
      ],
    };

    const file = path.join(tmp, 'e3-loop.json');
    writeJson(file, def);

    let planRounds = 0;
    let buildTouched = false;
    const env = {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      AFLT_MEMORY_REPO: memoryRepo,
      AGENTFLEET_TEST: '1',
    };

    const result = await loop.runFromFile(file, {
      env,
      ensureSession: async (phase) => ({
        id: `sess-${phase.id}`,
        title: phase.session,
        engine: 'cursor',
        cwd: tmp,
      }),
      runPrompt: async (session, prompt, phase) => {
        if (phase.id === 'measure') {
          writeJson(
            path.join(resultsDir, '2026-11-21T12-00-00-000Z.json'),
            fixtureMeasureResults()
          );
        } else if (phase.id === 'score-baseline') {
          const resultsPath = path.join(resultsDir, '2026-11-21T12-00-00-000Z.json');
          appendHistory(historyPath, [
            {
              scoredAt: '2026-11-21T12:00:00.000Z',
              overall: 80,
              resultsPath,
            },
          ]);
          recordBaseline({
            baselinePath,
            overall: 80,
            scoredAt: '2026-11-21T12:00:00.000Z',
            resultsPath,
            maxRounds: 3,
          });
        } else if (phase.type === 'plan-next') {
          planRounds += 1;
          const out = loop.planNextOutputPath('self-improve-e3');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          if (planRounds === 1) {
            fs.writeFileSync(
              out,
              JSON.stringify(
                {
                  done: false,
                  phases: [
                    {
                      id: 'round-1-build',
                      session: 'loop-e3-build',
                      prompt: 'Apply one small fix with tests.',
                      eval: {
                        command: [
                          process.execPath,
                          '-e',
                          'process.exit(require("fs").existsSync("FIX.txt")?0:1)',
                        ],
                        exitCode: 0,
                      },
                      maxFixAttempts: 1,
                      onPass: 'none',
                      force: true,
                      gate: 'none',
                    },
                    {
                      id: 'round-1-gate',
                      session: 'loop-e3',
                      prompt: 'READY gate',
                      eval: { command: ['true'], exitCode: 0 },
                      maxFixAttempts: 0,
                      onPass: 'none',
                      force: false,
                      gate: 'none',
                    },
                  ],
                },
                null,
                2
              ) + '\n'
            );
          } else {
            const stop = shouldStopImprove({
              baselinePath,
              historyPath,
              maxRounds: 3,
            });
            assert.equal(stop.stop, true);
            assert.equal(stop.reason, 'plateau');
            fs.writeFileSync(out, JSON.stringify({ done: true }, null, 2) + '\n');
          }
          assert.match(String(prompt), /RUBRIC|baseline|plateau/i);
        } else if (phase.id === 'round-1-build') {
          fs.writeFileSync(path.join(tmp, 'FIX.txt'), 'fixed\n');
          buildTouched = true;
        } else if (phase.id === 'round-1-gate') {
          // Remeasure/score fixtures: same score → plateau next plan-next.
          const resultsPath = path.join(resultsDir, '2026-11-21T13-00-00-000Z.json');
          writeJson(resultsPath, fixtureMeasureResults());
          appendHistory(historyPath, [
            {
              scoredAt: '2026-11-21T13:00:00.000Z',
              overall: 80,
              resultsPath,
            },
          ]);
          const gate = improveGate({
            repoRoot,
            baselinePath,
            resultsPath,
            historyPath,
            changedFiles: ['FIX.txt'],
          });
          assert.equal(gate.ok, true, JSON.stringify(gate.failures));
        }

        return {
          code: 0,
          timedOut: false,
          stdout: `ok:${phase.id}`,
          stderr: '',
          outPath: null,
          runId: `r-${phase.id}`,
        };
      },
      runEval: async (evalSpec, opts) => {
        // Default argv eval for build check; others are `true`.
        if (Array.isArray(evalSpec.command) && evalSpec.command[0] === process.execPath) {
          return loop.runEval(evalSpec, opts);
        }
        return {
          code: 0,
          timedOut: false,
          stdout: 'ok',
          stderr: '',
          signal: null,
        };
      },
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.status, 'completed');
    assert.equal(buildTouched, true);
    assert.ok(planRounds >= 2);
    assert.ok(fs.existsSync(path.join(tmp, 'FIX.txt')));
    assert.ok(fs.existsSync(baselinePath));

    const state = loop.loadState('self-improve-e3');
    assert.equal(state.status, 'completed');
    assert.equal(state.phases['round-1-build'].status, 'passed');
    assert.equal(state.phases['round-1-gate'].status, 'passed');
    assert.equal(state.phases['plan-next'].status, 'passed');

    const timeline = path.join(memoryRepo, 'aflt', '_aflt', 'loop-timeline.jsonl');
    assert.ok(fs.existsSync(timeline));
    const lines = fs
      .readFileSync(timeline, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.ok(lines.some((e) => e.event === 'loop.completed'));
  });

  it('hermetic: improve gate failure when score drops aborts the planned gate phase', async () => {
    const loop = require('../lib/loop');
    const { improveGate, recordBaseline } = require('../scripts/eval/improve');

    const resultsDir = path.join(tmp, 'drop-results');
    const historyPath = path.join(tmp, 'drop-history.jsonl');
    const baselinePath = path.join(tmp, 'drop-baseline.json');
    fs.mkdirSync(resultsDir, { recursive: true });
    writeJson(path.join(resultsDir, 'base.json'), fixtureMeasureResults());
    appendHistory(historyPath, [
      { scoredAt: '2026-11-21T12:00:00.000Z', overall: 90 },
    ]);
    recordBaseline({
      baselinePath,
      overall: 90,
      scoredAt: '2026-11-21T12:00:00.000Z',
      maxRounds: 3,
    });

    const def = {
      name: 'self-improve-drop',
      project: 'aflt',
      cwd: tmp,
      engine: 'cursor',
      plannedPhaseGate: 'none',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 20, maxHours: 1, maxPhases: 8 },
      phases: [
        {
          id: 'seed',
          prompt: 'seed',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 0,
          onPass: 'none',
        },
        {
          id: 'plan-next',
          type: 'plan-next',
          prompt: 'one fix',
          maxFixAttempts: 0,
          onPass: 'none',
          force: true,
        },
      ],
    };
    const file = path.join(tmp, 'drop-loop.json');
    writeJson(file, def);

    let planRounds = 0;
    let failNextEval = false;
    const env = {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      AFLT_MEMORY_REPO: memoryRepo,
      AGENTFLEET_TEST: '1',
    };

    const result = await loop.runFromFile(file, {
      env,
      ensureSession: async (phase) => ({
        id: `sess-${phase.id}`,
        title: phase.session || phase.id,
        engine: 'cursor',
        cwd: tmp,
      }),
      runPrompt: async (session, prompt, phase) => {
        if (phase.type === 'plan-next') {
          planRounds += 1;
          const out = loop.planNextOutputPath('self-improve-drop');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(
            out,
            JSON.stringify({
              done: false,
              phases: [
                {
                  id: 'bad-gate',
                  prompt: 'gate',
                  eval: { command: ['true'], exitCode: 0 },
                  maxFixAttempts: 0,
                  onPass: 'none',
                  gate: 'none',
                },
              ],
            }) + '\n'
          );
        } else if (phase.id === 'bad-gate') {
          failNextEval = true;
        }
        return {
          code: 0,
          timedOut: false,
          stdout: 'ok',
          stderr: '',
          outPath: null,
          runId: 'r',
        };
      },
      runEval: async () => {
        if (failNextEval) {
          failNextEval = false;
          appendHistory(historyPath, [
            { scoredAt: '2026-11-21T14:00:00.000Z', overall: 70 },
          ]);
          const gate = improveGate({
            repoRoot,
            baselinePath,
            results: fixtureMeasureResults(),
            historyPath,
            changedFiles: ['lib/util.js'],
          });
          assert.equal(gate.ok, false);
          assert.ok(gate.failures.includes('score_vs_baseline'));
          return {
            code: 1,
            timedOut: false,
            stdout: JSON.stringify(gate),
            stderr: 'score dropped',
            signal: null,
          };
        }
        return {
          code: 0,
          timedOut: false,
          stdout: 'ok',
          stderr: '',
          signal: null,
        };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.ok(planRounds >= 1);
    const state = loop.loadState('self-improve-drop');
    assert.equal(state.phases['bad-gate'].status, 'failed');
  });
});
