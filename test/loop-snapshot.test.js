'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-snap-')));
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    const outside = path.join(root, 'outside-checkout', 'examples', 'loops', 'demo');
    for (const d of [home, cwd, outside]) fs.mkdirSync(d, { recursive: true });
    spawnSync('git', ['init', '-q', cwd]);
    const prev = { HOME: process.env.HOME, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME, AFLT_NOTIFY_URL: process.env.AFLT_NOTIFY_URL };
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AFLT_NOTIFY_URL;
    try {
      await fn({ root, home, cwd, outside });
    } finally {
      clearMods();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/** A loop JSON outside the project (like examples/loops/x) with prompts and a check script that reads a sibling. */
function writeOutsideLoop(outside, cwd) {
  fs.mkdirSync(path.join(outside, 'prompts'));
  fs.writeFileSync(path.join(outside, 'prompts', 'M0.txt'), 'PROMPT M0 original');
  fs.writeFileSync(path.join(outside, 'prompts', 'M1.txt'), 'PROMPT M1 original');
  fs.mkdirSync(path.join(outside, 'seed'));
  fs.writeFileSync(path.join(outside, 'seed', 'marker.txt'), 'seed ok');
  fs.writeFileSync(
    path.join(outside, 'check.js'),
    "const fs=require('fs');const p=require('path');process.stdout.write(fs.readFileSync(p.join(__dirname,'seed','marker.txt'),'utf8'));\n"
  );
  const def = {
    name: 'snap',
    cwd,
    engine: 'cursor',
    allow: { commit: false, merge: false, push: false },
    budget: { maxRuns: 6, maxHours: 1 },
    phases: [
      { id: 'm0', promptFile: 'prompts/M0.txt', eval: { command: ['node', 'check.js'], passRegex: 'seed ok' }, maxFixAttempts: 0 },
      { id: 'm1', promptFile: 'prompts/M1.txt', gate: 'approve', eval: { command: ['node', 'check.js'], passRegex: 'seed ok' }, maxFixAttempts: 0 },
    ],
  };
  const file = path.join(outside, 'snap.json');
  fs.writeFileSync(file, JSON.stringify(def));
  return file;
}

describe('loop snapshots prompt files and outside check scripts', () => {
  it(
    'validate warns about files outside the project folder',
    withHome(async ({ cwd, outside }) => {
      const loop = require('../lib/loop');
      const file = writeOutsideLoop(outside, cwd);
      const v = loop.validateFile(file);
      assert.equal(v.ok, true, (v.errors || []).join('; '));
      const w = v.warnings.join('\n');
      assert.match(w, /phase m0: promptFile .*prompts\/M0\.txt outside the project folder/);
      assert.match(w, /phase m0: check command reads .*check\.js outside the project folder/);
    })
  );

  it(
    'start copies prompts and the check folder into the loop dir; resume works after the originals are gone',
    withHome(async ({ cwd, outside, home }) => {
      const loop = require('../lib/loop');
      const file = writeOutsideLoop(outside, cwd);
      const seen = [];
      const hooks = {
        ensureSession: async (phase) => ({ id: `sess-${phase.id}`, title: phase.id, engine: 'cursor', cwd, status: 'active' }),
        runPrompt: async (_s, prompt) => {
          seen.push(String(prompt));
          return { code: 0, timedOut: false, stdout: 'ok', stderr: '', outPath: null, runId: 'r' };
        },
      };
      const first = await loop.runFromFile(file, hooks);
      assert.equal(first.status, 'waiting', first.error);
      assert.ok(seen.some((p) => p.includes('PROMPT M0 original')));

      const state = loop.loadState('snap');
      const loopDirAbs = path.join(home, 'loops', 'snap');
      const m1 = state.definition.phases.find((p) => p.id === 'm1');
      assert.ok(m1.promptSnapshot.startsWith(path.join(loopDirAbs, 'prompts')), m1.promptSnapshot);
      assert.equal(m1.promptFileSource, path.join(outside, 'prompts', 'M1.txt'));
      assert.ok(m1.eval.command[1].startsWith(path.join(loopDirAbs, 'files')), m1.eval.command.join(' '));
      assert.deepEqual(m1.eval.commandSource, ['node', path.join(outside, 'check.js')]);
      assert.ok(fs.existsSync(path.join(path.dirname(m1.eval.command[1]), 'seed', 'marker.txt')));
      const snapDef = JSON.parse(fs.readFileSync(path.join(loopDirAbs, 'definition.json'), 'utf8'));
      assert.ok(snapDef.phases[1].promptSnapshot, 'definition.json snapshot records the copy');

      // The checkout the loop came from disappears (e.g. a removed worktree).
      fs.rmSync(path.join(outside, '..', '..', '..'), { recursive: true, force: true });
      assert.equal(fs.existsSync(outside), false);

      const ap = loop.requestApprove('snap', {});
      assert.equal(ap.ok, true, ap.error);
      const second = await loop.resumeLoop('snap', hooks);
      assert.equal(second.ok, true, second.error);
      assert.equal(second.status, 'completed');
      assert.ok(seen.some((p) => p.includes('PROMPT M1 original')), 'resume used the prompt snapshot');
    })
  );

  it(
    'a loop saved before snapshots fails with a clear message when its prompt file is gone',
    withHome(async () => {
      const loop = require('../lib/loop');
      assert.throws(
        () => loop.resolvePhasePrompt({ id: 'm0', promptFile: '/nonexistent/aflt-scratch-variant/prompts/M0.txt' }),
        /promptFile \/nonexistent\/aflt-scratch-variant\/prompts\/M0\.txt no longer exists and this loop has no prompt snapshot/
      );
    })
  );

  it('saved definitions store project prompts relative to the project', () => {
    const loop = require('../lib/loop');
    const cwd = path.join(os.tmpdir(), 'proj-x');
    const out = loop.definitionToWritable(
      { name: 'x', cwd, engine: 'cursor', allow: {}, budget: {}, phases: [{ id: 'm0', promptFile: path.join(cwd, '.agentfleet', 'prompts', 'm0.md'), eval: { command: ['true'], exitCode: 0 } }] },
      { phases: [{ promptFile: path.join(cwd, '.agentfleet', 'prompts', 'm0.md') }] }
    );
    assert.equal(out.phases[0].promptFile, path.join('.agentfleet', 'prompts', 'm0.md'));
  });
  it('rejects planned checks that climb out of the project (the scratch run\'s ../hello-aflt/improve-gate.js)', () => {
    clearMods();
    const loop = require('../lib/loop');
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-snap-plan-')));
    try {
      const v = loop.validateDefinition(
        {
          name: 'p',
          cwd,
          engine: 'cursor',
          budget: { maxRuns: 9, maxPhases: 9 },
          phases: [
            { id: 'm0', prompt: 'x', eval: { command: ['node', '--test'] } },
            { id: 'plan-next', type: 'plan-next', force: true },
          ],
        },
        { checkCwd: false }
      );
      assert.equal(v.ok, true, (v.errors || []).join('; '));
      const state = loop.createInitialState(v.definition);
      state.definitionPath = path.join(cwd, '..', 'defs-elsewhere', 'loop.json');
      const bad = loop.insertPlannedPhases(state, 1, [{ id: 'improve-r1', prompt: 'improve', eval: { command: ['node', '../hello-aflt/improve-gate.js'] } }], { checkPromptFiles: false });
      assert.equal(bad.ok, false);
      assert.match(bad.error, /improve-r1: eval command uses \.\.\/hello-aflt\/improve-gate\.js .* outside the project folder/);
      const badStr = loop.insertPlannedPhases(state, 1, [{ id: 'improve-r1', prompt: 'improve', eval: { command: 'npm test && node ../x/gate.js' } }], { checkPromptFiles: false });
      assert.equal(badStr.ok, false);
      const ok = loop.insertPlannedPhases(state, 1, [{ id: 'improve-r1', prompt: 'improve', eval: { command: 'npm test && node scripts/eval/eval.js --json' } }], { checkPromptFiles: false });
      assert.equal(ok.ok, true, ok.error);
      const pv = loop.validateDefinition(
        { name: 'q', cwd, engine: 'cursor', budget: { maxRuns: 3 }, phases: [{ id: 'm0', prompt: 'x', eval: { command: 'node ../shared/check.js' } }] },
        { checkCwd: false }
      );
      assert.ok(pv.warnings.some((w) => /phase m0: check command reads .*shared\/check\.js outside the project folder/.test(w)), pv.warnings.join('; '));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('planner and fix prompts tell the agent to stay inside the project', () => {
    clearMods();
    const loop = require('../lib/loop');
    const fix = loop.buildFixPrompt({ id: 'r1' }, { code: 1, stdout: 'Cannot find module /x/improve-gate.js', stderr: '' });
    assert.match(fix, /Work only inside the project folder/);
    const plan = loop.buildPlanNextPrompt({ name: 'p', definition: { name: 'p', phases: [] }, history: [], phases: {} }, { id: 'plan-next' }, '/tmp/out.json');
    assert.match(plan, /Eval commands must use files inside the project folder/);
    assert.match(plan, /do not search other folders, other projects, or the aflt install/);
  });
});
