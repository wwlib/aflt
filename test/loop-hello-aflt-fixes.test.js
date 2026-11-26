'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const exampleDir = path.join(repoRoot, 'examples', 'loops', 'hello-aflt');
const seedDir = path.join(exampleDir, 'seed');
const loopJson = path.join(seedDir, '.agentfleet', 'loop.json');
const seededDir = path.join(repoRoot, 'examples', 'loops', 'hello-aflt-seeded');
const seededJson = path.join(seededDir, 'hello-aflt.json');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/usage',
    '../lib/turns',
    '../lib/run-history',
    '../lib/registry',
    '../lib/config',
    '../lib/memory',
    '../lib/project',
    '../lib/util',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

describe('hello-aflt loop fixes', () => {
  let home;
  let cwd;
  let prevHome;
  let prevAfHome;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-fix-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-fix-cwd-'));
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    fs.mkdirSync(process.env.AGENTFLEET_HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    if (prevAfHome == null) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    clearMods();
  });

  it('freezes elapsed time on completed / failed / stopped / paused loops', () => {
    const loop = require('../lib/loop');
    const startedAt = '2026-11-22T18:43:10.534Z';
    const completedAt = '2026-11-22T19:02:03.620Z';
    const expectedMs = Date.parse(completedAt) - Date.parse(startedAt);
    const laterMs = Date.parse('2026-11-23T00:00:00.000Z');

    const completed = {
      status: 'completed',
      startedAt,
      completedAt,
      failedAt: null,
      stoppedAt: null,
      pausedAt: null,
      definition: { budget: { maxHours: 8 } },
      runsUsed: 7,
    };
    assert.equal(loop._test.elapsedMsOf(completed, laterMs), expectedMs);
    assert.ok(
      Math.abs(loop._test.hoursElapsed(completed, laterMs) - expectedMs / 3600000) < 1e-9
    );
    const snap = loop._test.budgetSnapshot(completed, laterMs);
    assert.equal(snap.hoursUsed, Math.round((expectedMs / 3600000) * 1000) / 1000);

    const failed = {
      status: 'failed',
      startedAt,
      failedAt: completedAt,
      definition: { budget: {} },
      runsUsed: 1,
    };
    assert.equal(loop._test.elapsedMsOf(failed, laterMs), expectedMs);

    const stopped = {
      status: 'stopped',
      startedAt,
      stoppedAt: completedAt,
      definition: { budget: {} },
      runsUsed: 1,
    };
    assert.equal(loop._test.elapsedMsOf(stopped, laterMs), expectedMs);

    const paused = {
      status: 'paused',
      startedAt,
      pausedAt: completedAt,
      definition: { budget: {} },
      runsUsed: 1,
    };
    assert.equal(loop._test.elapsedMsOf(paused, laterMs), expectedMs);

    const running = {
      status: 'running',
      startedAt,
      definition: { budget: {} },
      runsUsed: 1,
    };
    assert.equal(loop._test.elapsedMsOf(running, laterMs), laterMs - Date.parse(startedAt));
  });

  it('promptExcerpt strips plan-mode + pkill preamble', () => {
    const loop = require('../lib/loop');
    const rh = require('../lib/run-history');
    const timeline = require('../lib/timeline');
    const full = [
      'Do not switch to plan mode.',
      'Never use pkill/killall or pattern-matched kills; only stop PIDs you started.',
      'Build Milestone 1 of tile-dungeon.',
    ].join('\n');
    assert.match(loop._test.stripPromptPreamble(full), /^Build Milestone 1/);
    assert.match(loop._test.promptExcerpt(full, 80), /^Build Milestone 1/);
    assert.match(rh.promptExcerpt(full, 80), /^Build Milestone 1/);
    // Same-line preamble (improve-r* prompts).
    const sameLine =
      'Do not switch to plan mode. You are running improve-r1 for loop hello-aflt-improve on the repo.';
    assert.match(loop._test.stripPromptPreamble(sameLine), /^You are running improve-r1/);
    assert.match(rh.promptExcerpt(sameLine, 120), /^You are running improve-r1/);
    assert.match(
      timeline.promptSummary({ prompt: sameLine }, 120),
      /^You are running improve-r1/
    );
    // Full prompt must remain available for engine runs (helper does not mutate).
    assert.match(full, /^Do not switch to plan mode/);
  });

  it('buildStepPipeline freezes active stages on completed loops', () => {
    const loop = require('../lib/loop');
    const completed = {
      status: 'completed',
      step: 'run',
      phaseIndex: 0,
      definition: { phases: [{ id: 'm1' }] },
      phases: { m1: { status: 'passed' } },
    };
    const stages = loop.buildStepPipeline(completed);
    assert.ok(stages.every((s) => s.active === false));
    assert.ok(stages.every((s) => s.done === true));
    const failed = { ...completed, status: 'failed' };
    const failedStages = loop.buildStepPipeline(failed);
    assert.ok(failedStages.every((s) => s.active === false));
  });

  it('planDryRun promptPreview skips the preamble', () => {
    const loop = require('../lib/loop');
    const validated = loop.validateDefinition(
      {
        name: 'preview-loop',
        cwd,
        phases: [
          {
            id: 'p1',
            prompt:
              'Do not switch to plan mode.\nNever use pkill/killall or pattern-matched kills; only stop PIDs you started.\nImplement the dungeon renderer.',
            eval: { command: ['true'], exitCode: 0 },
          },
        ],
      },
      { checkCwd: false }
    );
    assert.equal(validated.ok, true, (validated.errors || []).join('; '));
    const plan = loop.planDryRun(validated.definition, null);
    assert.match(plan.phases[0].promptPreview, /^Implement the dungeon renderer/);
    assert.ok(!plan.phases[0].promptPreview.startsWith('Do not switch'));
  });

  it('rolls up per-loop token usage from phase sessions', () => {
    const loop = require('../lib/loop');
    const turns = require('../lib/turns');
    const usage = require('../lib/usage');

    const s1 = 'sess-loop-a';
    const s2 = 'sess-loop-b';
    turns.writeUsageSummary(
      s1,
      usage.summarizeSessionUsage([
        {
          usage: usage.normalizeCursorUsage(
            {
              inputTokens: 100,
              outputTokens: 10,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            { model: 'test-model-a' }
          ),
        },
      ])
    );
    turns.writeUsageSummary(
      s2,
      usage.summarizeSessionUsage([
        {
          usage: usage.normalizeCursorUsage(
            {
              inputTokens: 50,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            { model: 'test-model-b' }
          ),
        },
      ])
    );

    const state = {
      name: 'usage-loop',
      status: 'completed',
      startedAt: '2026-11-22T18:00:00.000Z',
      completedAt: '2026-11-22T18:20:00.000Z',
      loopRootSessionId: null,
      phases: {
        m1: { sessionId: s1, status: 'passed' },
        m2: { sessionId: s2, status: 'passed' },
      },
      definition: { budget: {}, phases: [{ id: 'm1' }, { id: 'm2' }] },
      runsUsed: 2,
    };
    const rolled = loop.refreshLoopUsage(state);
    assert.ok(rolled);
    assert.equal(rolled.totalInput, 150);
    assert.equal(rolled.outputTokens, 15);
    assert.equal(rolled.turnCount, 2);
    assert.ok(rolled.cost == null); // never invent USD (omitted or null)
    assert.ok(Array.isArray(rolled.models));
    assert.ok(rolled.models.includes('test-model-a'));
    assert.ok(rolled.models.includes('test-model-b'));

    const summary = loop.summarizeLoopState(state);
    assert.ok(summary.usage);
    assert.equal(summary.usage.totalInput, 150);
    assert.equal(summary.elapsedMs, 20 * 60 * 1000);
  });

  it('extractEvalScore reads overall from lastEval stdout', () => {
    const loop = require('../lib/loop');
    assert.equal(
      loop.extractEvalScore({ stdout: JSON.stringify({ overall: 92.4, weakest: 'avg_depth' }) }),
      92.4
    );
    assert.equal(
      loop.extractEvalScore({ stdout: 'noise\n{"previous":90,"after":91.5,"result":"improved"}\n' }),
      91.5
    );
    assert.equal(loop.extractEvalScore({ stdout: 'no score here' }), null);
    // Trailing overall after lengthy node:test noise (M5a shape).
    const long = `${'ok\n'.repeat(2500)}{"overall":87.5,"weakest":"avg_depth"}\n`;
    assert.ok(long.length > 4000);
    assert.equal(loop.extractEvalScore({ stdout: long }), 87.5);
  });

  it('runLoop stores evalScore from full stdout before lastEval truncation', async () => {
    const loop = require('../lib/loop');
    const longStdout = `${'pass\n'.repeat(3000)}{"overall":88.25,"weakest":"avg_depth"}\n`;
    assert.ok(longStdout.length > 4000);

    const def = {
      name: 'score-trunc-loop',
      cwd,
      project: 'demo',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 5, maxHours: 1 },
      phases: [
        {
          id: 'm5a',
          session: 'score-trunc-m5a',
          prompt: 'READY',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 1,
          onPass: 'none',
          force: false,
        },
      ],
    };
    const result = await loop.runLoop(def, {
      env: process.env,
      fresh: true,
      ensureSession: async () => ({
        id: 'sess-score-trunc',
        title: 'score-trunc-m5a',
        engine: 'cursor',
        cwd,
        status: 'active',
      }),
      runPrompt: async () => ({
        code: 0,
        timedOut: false,
        stdout: 'ready',
        stderr: '',
        outPath: null,
        runId: 'r1',
      }),
      runEval: async () => ({
        code: 0,
        timedOut: false,
        stdout: longStdout,
        stderr: '',
        cwd,
      }),
    });
    assert.equal(result.ok, true, result.error || result.status);
    assert.equal(result.status, 'completed');
    const state = loop.loadState('score-trunc-loop');
    assert.equal(state.phases.m5a.evalScore, 88.3);
    assert.ok(String(state.phases.m5a.lastEval.stdout).length <= 4010);
    assert.ok(!String(state.phases.m5a.lastEval.stdout).includes('"overall":88.25'));
    const pipe = loop.buildPhasePipeline(state);
    assert.equal(pipe[0].evalScore, 88.3);
  });

  it('buildPhasePipeline exposes evalScore + parent session', () => {
    const loop = require('../lib/loop');
    const state = {
      name: 'tree-loop',
      status: 'completed',
      phaseIndex: 1,
      step: 'run',
      loopRootSessionId: 'root-1',
      definition: {
        phases: [
          { id: 'm1', session: 'hello-aflt-m1', type: 'run' },
          { id: 'm5a', session: 'hello-aflt-m5a', type: 'run' },
        ],
      },
      phases: {
        m1: {
          status: 'passed',
          sessionId: 's1',
          sessionTitle: 'hello-aflt-m1',
          lastEval: { stdout: '{"overall":80}', code: 0 },
        },
        m5a: {
          status: 'passed',
          sessionId: 's2',
          sessionTitle: 'hello-aflt-m5a',
          evalScore: 92.4,
          lastEval: { stdout: '{"overall":92.4}', code: 0 },
        },
      },
    };
    const pipe = loop.buildPhasePipeline(state);
    assert.equal(pipe[0].evalScore, 80);
    assert.equal(pipe[0].parentSessionId, 'root-1');
    assert.equal(pipe[0].role, 'worker');
    assert.equal(pipe[1].evalScore, 92.4);
  });

  it('ensureSession sets parent/role under loop root for bound sessions', async () => {
    const loop = require('../lib/loop');
    const registry = require('../lib/registry');
    const root = registry.add({
      title: 'loop-parent-test',
      chatId: 'chat-root',
      cwd,
      engine: 'cursor',
      role: 'master',
      tags: ['loop', 'parent-test', 'loop-root'],
      status: 'active',
    });
    const existing = registry.add({
      title: 'hello-phase-existing',
      chatId: 'chat-phase',
      cwd,
      engine: 'cursor',
      status: 'active',
    });
    // Within a run, reuse phaseState.sessionId (existingSessionId) — not title find.
    const got = await loop.ensureSession(
      { id: 'm1', session: 'hello-phase-existing', engine: 'cursor' },
      { name: 'parent-test', cwd, engine: 'cursor', project: 'demo' },
      { loopRoot: root, existingSessionId: existing.id }
    );
    assert.equal(got.id, existing.id);
    assert.equal(got.parent, root.id);
    assert.equal(got.role, 'worker');
  });

  it('ensureSession / ensureLoopRootSession do not reuse completed peers by title', async () => {
    const loop = require('../lib/loop');
    const registry = require('../lib/registry');
    const oldRoot = registry.add({
      title: 'loop-fresh-reuse',
      chatId: 'chat-old-root',
      cwd,
      engine: 'cursor',
      role: 'master',
      status: 'done',
      tags: ['loop', 'fresh-reuse', 'loop-root'],
    });
    const oldPhase = registry.add({
      title: 'fresh-reuse-planner',
      chatId: 'chat-old-phase',
      cwd,
      engine: 'cursor',
      status: 'done',
      parent: oldRoot.id,
      role: 'worker',
    });
    // Fresh run: no existingSessionId → create new (stub createEngineChatId via add after
    // injecting by calling ensure* with a fake create — use registry.add through monkeypatch).
    const cursor = require('../lib/cursor');
    const prev = cursor.createChat;
    let created = 0;
    cursor.createChat = async () => {
      created += 1;
      return `chat-new-${created}`;
    };
    try {
      const root = await loop.ensureLoopRootSession(
        { name: 'fresh-reuse', cwd, engine: 'cursor', project: 'demo' },
        { existingSessionId: null }
      );
      assert.notEqual(root.id, oldRoot.id);
      assert.equal(root.title, 'loop-fresh-reuse');
      assert.equal(root.status, 'active');

      const phase = await loop.ensureSession(
        { id: 'plan-next', session: 'fresh-reuse-planner', engine: 'cursor' },
        { name: 'fresh-reuse', cwd, engine: 'cursor', project: 'demo' },
        { loopRoot: root, existingSessionId: null }
      );
      assert.notEqual(phase.id, oldPhase.id);
      assert.equal(phase.title, 'fresh-reuse-planner');
      assert.equal(phase.parent, root.id);

      // Mid-run reuse: bound id returns the same session.
      const again = await loop.ensureSession(
        { id: 'plan-next', session: 'fresh-reuse-planner', engine: 'cursor' },
        { name: 'fresh-reuse', cwd, engine: 'cursor', project: 'demo' },
        { loopRoot: root, existingSessionId: phase.id }
      );
      assert.equal(again.id, phase.id);
    } finally {
      cursor.createChat = prev;
    }
  });

  it('resolves promptFile relative to the definition directory', () => {
    const loop = require('../lib/loop');
    const defDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-def-'));
    const prompts = path.join(defDir, 'prompts');
    fs.mkdirSync(prompts);
    const promptFile = path.join(prompts, 'M1.txt');
    fs.writeFileSync(promptFile, 'Build M1.\n');
    const gameCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-game-'));

    const resolved = loop.resolvePromptFilePath('prompts/M1.txt', {
      definitionDir: defDir,
      cwd: gameCwd,
    });
    assert.equal(resolved, promptFile);

    const validated = loop.validateDefinition(
      {
        name: 'rel-prompts',
        cwd: gameCwd,
        phases: [
          {
            id: 'm1',
            promptFile: 'prompts/M1.txt',
            eval: { command: ['true'], exitCode: 0 },
          },
        ],
      },
      { definitionDir: defDir, cwdBase: gameCwd, checkCwd: true }
    );
    assert.equal(validated.ok, true, (validated.errors || []).join('; '));
    assert.equal(validated.definition.phases[0].promptFile, promptFile);
    assert.equal(
      fs.realpathSync(validated.definition.cwd),
      fs.realpathSync(gameCwd)
    );
  });

  it('resolves improve-gate.js relative to the definition directory', () => {
    const loop = require('../lib/loop');
    const defDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-gate-'));
    const gate = path.join(defDir, 'improve-gate.js');
    fs.writeFileSync(gate, '#!/usr/bin/env node\nprocess.exit(0);\n');
    const cmd = loop.resolveEvalCommandPaths(['node', 'improve-gate.js'], {
      definitionDir: defDir,
    });
    assert.deepEqual(cmd, ['node', gate]);
  });

  it('validate quiets outside-cwd warnings for files inside project .agentfleet only', () => {
    const loop = require('../lib/loop');
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-dotfleet-'));
    const projectCwd = path.join(project, 'app');
    const definitionDir = path.join(project, '.agentfleet');
    const promptsDir = path.join(definitionDir, 'prompts');
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    const inFleet = path.join(promptsDir, 'M1.txt');
    fs.writeFileSync(inFleet, 'Build M1.\n');
    const outside = path.join(os.tmpdir(), `af-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'outside\n');
    try {
      const quiet = loop.validateDefinition(
        {
          name: 'fleet-inside',
          cwd: projectCwd,
          phases: [{ id: 'm1', promptFile: inFleet, eval: { command: ['true'], exitCode: 0 } }],
        },
        { definitionDir, checkCwd: false, checkPromptFiles: false }
      );
      assert.equal(quiet.ok, true, (quiet.errors || []).join('; '));
      assert.equal((quiet.warnings || []).some((w) => /outside the project folder/.test(w)), false);

      const warned = loop.validateDefinition(
        {
          name: 'fleet-outside',
          cwd: projectCwd,
          phases: [{ id: 'm1', promptFile: outside, eval: { command: ['true'], exitCode: 0 } }],
        },
        { definitionDir, checkCwd: false, checkPromptFiles: false }
      );
      assert.equal(warned.ok, true, (warned.errors || []).join('; '));
      assert.ok((warned.warnings || []).some((w) => /outside the project folder/.test(w)));
    } finally {
      try {
        fs.unlinkSync(outside);
      } catch (_) {
        /* ignore */
      }
    }
  });

  it('hello-aflt from-scratch seed validates in-project; seeded variant still dry-runs', () => {
    assert.ok(fs.existsSync(loopJson));
    assert.ok(fs.existsSync(path.join(exampleDir, 'install.sh')));
    assert.ok(fs.existsSync(path.join(exampleDir, 'hello-aflt-improve.json')));
    assert.ok(fs.existsSync(path.join(seedDir, '.agentfleet', 'checks', 'm0-check.cjs')));
    assert.ok(fs.existsSync(path.join(seedDir, '.agentfleet', 'prompts', 'M5a.txt')));

    const loop = require('../lib/loop');
    const raw = JSON.parse(fs.readFileSync(loopJson, 'utf8'));
    assert.equal(raw.name, 'hello-aflt');
    assert.equal(raw.project, 'hello-aflt');
    assert.equal(raw.phases[0].id, 'seed-docs');
    assert.equal(raw.plannedPhaseGate, 'none');

    const gameCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-game-')));
    fs.cpSync(seedDir, gameCwd, { recursive: true });
    const { spawnSync } = require('child_process');
    spawnSync('git', ['init', '-q'], { cwd: gameCwd });
    const result = loop.validateFile(path.join(gameCwd, '.agentfleet', 'loop.json'), {
      cwdBase: gameCwd,
    });
    assert.equal(result.ok, true, (result.errors || []).join('; '));
    for (const p of result.definition.phases.filter((x) => x.type !== 'script' && x.promptFile)) {
      assert.ok(p.promptFile.startsWith(gameCwd + path.sep), p.promptFile);
    }

    const improveJson = path.join(exampleDir, 'hello-aflt-improve.json');
    const improveRaw = JSON.parse(fs.readFileSync(improveJson, 'utf8'));
    assert.equal(improveRaw.project, 'hello-aflt');
    assert.equal(improveRaw.plannedPhaseGate, 'none');
    const improve = loop.validateFile(improveJson, { checkCwd: false, cwdBase: cwd });
    assert.equal(improve.ok, true, (improve.errors || []).join('; '));

    const planNext = fs.readFileSync(path.join(exampleDir, 'prompts', 'plan-next.txt'), 'utf8');
    assert.match(planNext, /improve-gate\.cjs/);

    const seeded = loop.validateFile(seededJson, { checkCwd: false, cwdBase: cwd });
    assert.equal(seeded.ok, true, (seeded.errors || []).join('; '));
    assert.equal(seeded.definition.phases[0].id, 'm0');
    assert.equal(seeded.definition.project, 'hello-aflt-seeded');

    const m5a = fs.readFileSync(path.join(seedDir, '.agentfleet', 'prompts', 'M5a.txt'), 'utf8');
    assert.match(m5a, /Do not copy files from any other folder/);
    assert.ok(!m5a.includes('wwlib/tile-dungeon'));
  });

  it('seed-m0 copies portable M0 into an empty cwd and passes smoke', () => {
    const { spawnSync } = require('child_process');
    const seed = path.join(seededDir, 'seed-m0.js');
    const game = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-m0-'));
    const r = spawnSync(process.execPath, [seed], {
      cwd: game,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(fs.existsSync(path.join(game, 'package.json')));
    assert.ok(fs.existsSync(path.join(game, 'server.js')));
    assert.ok(fs.existsSync(path.join(game, 'test', 'smoke.test.js')));
    assert.match(r.stdout || '', /seeded \+ smoke green|ok \(seeded/);

    const again = spawnSync(process.execPath, [seed], {
      cwd: game,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(again.status, 0, again.stderr || again.stdout);
    assert.match(again.stdout || '', /leaving tree unchanged/);
  });

  it('improve-gate: dirty working tree scoring higher than HEAD is improved (not plateau)', () => {
    const { spawnSync } = require('child_process');
    const gate = path.join(seededDir, 'improve-gate.js');
    const src = fs.readFileSync(gate, 'utf8');
    assert.match(src, /committed-head/);
    assert.match(src, /working-tree/);
    assert.match(src, /Do not read eval\/history\.jsonl/);
    assert.ok(!src.includes("'/tmp/") && !src.includes('"/tmp/'));
    assert.ok(!/before and after itself/i.test(src));

    const game = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-gate-game-'));
    const git = (args) =>
      spawnSync('git', args, {
        cwd: game,
        encoding: 'utf8',
        env: process.env,
      });
    const gitCommit = (msg) =>
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg], {
        cwd: game,
        encoding: 'utf8',
        env: process.env,
      });

    fs.writeFileSync(path.join(game, 'package.json'), JSON.stringify({ name: 'g' }) + '\n');
    fs.mkdirSync(path.join(game, 'scripts', 'eval'), { recursive: true });
    fs.mkdirSync(path.join(game, 'src'), { recursive: true });
    fs.mkdirSync(path.join(game, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(game, 'test', 'smoke.test.js'),
      `const { describe, it } = require('node:test');\nconst assert = require('node:assert/strict');\ndescribe('smoke', () => { it('ok', () => assert.equal(1, 1)); });\n`
    );
    // Score follows gameplay: HEAD has no src/boost.js → 88.2; dirty tree with boost → 92.4.
    // Call-count "before/after itself" on the dirty tree would see 92.4→92.4 and falsely plateau.
    fs.writeFileSync(
      path.join(game, 'scripts', 'eval', 'eval.js'),
      `const fs=require('fs');
const overall = fs.existsSync('src/boost.js') ? 92.4 : 88.2;
const out={overall,weakest:'avg_depth',metrics:{}};
fs.mkdirSync('eval',{recursive:true});
if(process.argv.includes('--write')){
  fs.writeFileSync('eval/latest-score.json', JSON.stringify(out)+'\\n');
  fs.appendFileSync('eval/history.jsonl', JSON.stringify(out)+'\\n');
}
process.stdout.write(JSON.stringify(out)+'\\n');
`
    );
    fs.writeFileSync(path.join(game, 'src', 'monsters.js'), 'module.exports = {};\n');

    assert.equal(git(['init']).status, 0);
    assert.equal(git(['add', '-A']).status, 0);
    assert.equal(gitCommit('HEAD baseline').status, 0, 'git commit');

    // Worker improvement (uncommitted) + misleading history/latest left at the new score.
    fs.writeFileSync(path.join(game, 'src', 'boost.js'), '// worker gain\n');
    fs.mkdirSync(path.join(game, 'eval'), { recursive: true });
    fs.writeFileSync(
      path.join(game, 'eval', 'history.jsonl'),
      JSON.stringify({ overall: 92.4 }) + '\n'
    );
    fs.writeFileSync(
      path.join(game, 'eval', 'latest-score.json'),
      JSON.stringify({ overall: 92.4 }) + '\n'
    );

    const r = spawnSync(process.execPath, [gate], {
      cwd: game,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout || '', /improved 88\.2 -> 92\.4/);
    assert.match(r.stdout || '', /"overall"\s*:\s*92\.4/);
    assert.ok(fs.existsSync(path.join(game, 'src', 'boost.js')), 'kept worker changes');
    const plateau = JSON.parse(fs.readFileSync(path.join(game, 'eval', 'plateau.json'), 'utf8'));
    assert.equal(plateau.previous, 88.2);
    assert.equal(plateau.after, 92.4);
    assert.equal(plateau.result, 'improved');
    assert.equal(plateau.keep_changes, true);
    assert.equal(plateau.beforeSource, 'committed-head');
    assert.equal(plateau.afterSource, 'working-tree');
    assert.equal(
      require('../lib/loop').extractEvalScore({ stdout: r.stdout }),
      92.4
    );
  });

  it('improve-gate: plateau restores HEAD and does not leave discarded latest-score', () => {
    const { spawnSync } = require('child_process');
    const gate = path.join(seededDir, 'improve-gate.js');
    const game = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-gate-plat-'));
    const git = (args) =>
      spawnSync('git', args, {
        cwd: game,
        encoding: 'utf8',
        env: process.env,
      });
    const gitCommit = (msg) =>
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', msg], {
        cwd: game,
        encoding: 'utf8',
        env: process.env,
      });

    fs.writeFileSync(path.join(game, 'package.json'), JSON.stringify({ name: 'g' }) + '\n');
    fs.mkdirSync(path.join(game, 'scripts', 'eval'), { recursive: true });
    fs.mkdirSync(path.join(game, 'src'), { recursive: true });
    fs.mkdirSync(path.join(game, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(game, 'test', 'smoke.test.js'),
      `const { describe, it } = require('node:test');\nconst assert = require('node:assert/strict');\ndescribe('smoke', () => { it('ok', () => assert.equal(1, 1)); });\n`
    );
    // Same score with or without worker file → plateau; stale latest-score must not stick at 92.4.
    fs.writeFileSync(
      path.join(game, 'scripts', 'eval', 'eval.js'),
      `const fs=require('fs');
const overall = 88.2;
const out={overall,weakest:'avg_depth',metrics:{}};
fs.mkdirSync('eval',{recursive:true});
if(process.argv.includes('--write')){
  fs.writeFileSync('eval/latest-score.json', JSON.stringify(out)+'\\n');
  fs.appendFileSync('eval/history.jsonl', JSON.stringify(out)+'\\n');
}
process.stdout.write(JSON.stringify(out)+'\\n');
`
    );
    fs.writeFileSync(path.join(game, 'src', 'monsters.js'), 'module.exports = { orcs: true };\n');
    assert.equal(git(['init']).status, 0);
    assert.equal(git(['add', '-A']).status, 0);
    assert.equal(gitCommit('HEAD').status, 0);

    fs.writeFileSync(path.join(game, 'src', 'noop.js'), '// no score change\n');
    fs.mkdirSync(path.join(game, 'eval'), { recursive: true });
    fs.writeFileSync(
      path.join(game, 'eval', 'latest-score.json'),
      JSON.stringify({ overall: 92.4 }) + '\n'
    );

    const r = spawnSync(process.execPath, [gate], {
      cwd: game,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout || '', /plateau 88\.2 -> 88\.2/);
    assert.ok(!fs.existsSync(path.join(game, 'src', 'noop.js')), 'reverted worker file');
    const plateau = JSON.parse(fs.readFileSync(path.join(game, 'eval', 'plateau.json'), 'utf8'));
    assert.equal(plateau.previous, 88.2);
    assert.equal(plateau.after, 88.2);
    assert.equal(plateau.result, 'plateau');
    assert.equal(plateau.keep_changes, false);
    assert.equal(plateau.overall, 88.2);
    const latest = JSON.parse(fs.readFileSync(path.join(game, 'eval', 'latest-score.json'), 'utf8'));
    assert.equal(latest.overall, 88.2);
  });
});
