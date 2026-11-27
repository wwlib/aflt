'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function clearMods() {
  for (const m of ['../lib/util', '../lib/loop', '../lib/loop-init', '../lib/registry', '../lib/config', '../lib/turns', '../lib/usage']) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function goodDraft(name = 'demo') {
  return {
    name,
    project: name,
    cwd: '.',
    engine: 'cursor',
    model: 'composer-2.5',
    improveModel: 'composer-2.5',
    plannedPhaseGate: 'none',
    allow: { commit: true, merge: false, push: false },
    budget: { maxRuns: 30, maxHours: 4, maxPhases: 9 },
    phases: [
      {
        id: 'm0',
        promptFile: 'prompts/m0.md',
        force: true,
        maxFixAttempts: 3,
        onPass: 'commit',
        eval: { command: 'node --test && node scripts/eval.js --json' },
      },
      { id: 'm1', promptFile: 'prompts/m1.md', gate: 'approve', force: true, onPass: 'commit', eval: { command: 'node --test' } },
      { id: 'plan-next', type: 'plan-next', model: 'gpt-5.3-codex', promptFile: 'prompts/plan-next.md', maxFixAttempts: 2, onPass: 'none', force: true },
    ],
  };
}

const PROMPTS = {
  'm0.md': 'Build the test harness (node:test smoke test) and an eval script scripts/eval.js that prints {"overall": n}.',
  'm1.md': 'Build the first feature. Keep the tests green.',
  'plan-next.md': 'Plan improve rounds from the eval. Stop after 3 improve rounds.',
};

function writeDraft(cwd, draft, prompts = PROMPTS) {
  const dir = path.join(cwd, '.agentfleet');
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  for (const [f, text] of Object.entries(prompts)) fs.writeFileSync(path.join(dir, 'prompts', f), text);
  fs.writeFileSync(path.join(dir, 'loop.json'), JSON.stringify(draft, null, 2));
}

describe('loop init: checks policy', () => {
  it('flags checks that always pass', () => {
    const li = require('../lib/loop-init');
    for (const c of ['true', 'echo ok', ['true'], 'sh -c "true"', 'npm test || true', 'exit 0', ':']) {
      assert.equal(li.isTrivialCheck(c), true, JSON.stringify(c));
    }
    for (const c of ['npm test', 'node --test test/*.test.js', ['grep', '-x', 'a', 'A.txt'], 'ls dist/app.js']) {
      assert.equal(li.isTrivialCheck(c), false, JSON.stringify(c));
    }
  });

  it('accepts a good draft and rejects missing checks, tests/eval, gate and budget', () => {
    const li = require('../lib/loop-init');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-li-pol-'));
    try {
      writeDraft(tmp, goodDraft());
      const defDir = path.join(tmp, '.agentfleet');
      const ok = li.checkLoopPolicy(goodDraft(), { definitionDir: defDir });
      assert.deepEqual(ok.errors, []);

      const bad = goodDraft();
      bad.phases[1].eval.command = 'true';
      delete bad.phases[1].gate;
      delete bad.budget.maxRuns;
      delete bad.budget.maxHours;
      delete bad.budget.maxPhases;
      const r = li.checkLoopPolicy(bad, { definitionDir: defDir });
      const all = r.errors.join('\n');
      assert.match(all, /phase m1: check "true" always passes/);
      assert.match(all, /phase m1: set "gate": "approve"/);
      assert.match(all, /budget\.maxRuns/);
      assert.match(all, /maxPhases/);
      const noForce = goodDraft();
      delete noForce.phases[2].force;
      assert.match(li.checkLoopPolicy(noForce, { definitionDir: defDir }).errors.join('\n'), /plan-next: set "force": true/);

      fs.writeFileSync(path.join(defDir, 'prompts', 'm0.md'), 'Build the server.');
      const noHarness = li.checkLoopPolicy(goodDraft(), { definitionDir: defDir });
      assert.match(noHarness.errors.join('\n'), /test harness/);
      assert.match(noHarness.errors.join('\n'), /eval script/);

      const gateOff = li.checkLoopPolicy({ ...goodDraft(), phases: goodDraft().phases.map((p) => ({ ...p, gate: undefined })) }, { definitionDir: defDir, gate: false });
      assert.equal(gateOff.errors.some((e) => /gate/.test(e)), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('enforces live-eval before the approval gate when an eval milestone exists', () => {
    const li = require('../lib/loop-init');
    const d = {
      name: 'x',
      budget: { maxRuns: 10, maxHours: 2 },
      protected: { fromPhase: 'eval', paths: ['eval/**'] },
      phases: [
        {
          id: 'm0',
          prompt: 'Build tests and eval script.',
          eval: { command: 'npm test' },
        },
        {
          id: 'eval',
          prompt: 'Build eval coverage fixtures.',
          eval: {
            command: 'npm test && node scripts/eval/eval.js --json',
            coverage: { tiers: ['a'], minCasesPerTier: 3 },
          },
        },
        {
          id: 'm1',
          gate: 'approve',
          prompt: 'Feature',
          eval: { command: 'npm test' },
        },
        {
          id: 'live-eval',
          type: 'script',
          eval: {
            command: 'node scripts/eval/eval.js --json --live --write',
            minOverall: 0,
            noRegress: true,
            infraRetries: 1,
          },
        },
      ],
    };
    const r = li.checkLoopPolicy(d, { definitionDir: '/x' });
    assert.match(r.errors.join('\n'), /immediately after eval milestone/);
    assert.match(r.errors.join('\n'), /after live-eval.*not before/);
  });

  it('warns when build phases switch model back and forth', () => {
    const li = require('../lib/loop-init');
    const d = goodDraft();
    d.phases.splice(2, 0, { id: 'm2', prompt: 'x tests', model: 'big', eval: { command: 'npm test' } }, { id: 'm3', prompt: 'y', eval: { command: 'npm test' } });
    const r = li.checkLoopPolicy(d, {});
    assert.ok(r.warnings.some((w) => /group phases by model/.test(w)), r.warnings.join('; '));
  });

  it('summarizes a draft readably', () => {
    const li = require('../lib/loop-init');
    const lines = li.summarizeDraft(goodDraft()).join('\n');
    assert.match(lines, /loop "demo" — engine cursor, model composer-2.5, improve rounds on composer-2.5/);
    assert.match(lines, /2\. m1 \[⏸ approve first\] — check: node --test/);
    assert.match(lines, /3\. plan-next \[plan-next, model gpt-5.3-codex\]/);
  });

  it('resolves cheap/strong models per engine with overrides', () => {
    const li = require('../lib/loop-init');
    assert.deepEqual(li.resolveModels('cursor'), li.DEFAULT_MODELS.cursor);
    assert.deepEqual(li.resolveModels('copilot', { model: 'auto' }), { build: 'auto', plan: 'auto' });
    assert.deepEqual(li.resolveModels('cursor', { buildModel: 'a', planModel: 'b' }), { build: 'a', plan: 'b' });
  });
});

describe('loop init: drafting (mock engine)', () => {
  let home;
  let cwd;
  const prev = {};

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-li-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-li-cwd-'));
    for (const k of ['HOME', 'AGENTFLEET_HOME', 'AGENTFLEET_CURSOR_BIN']) prev[k] = process.env[k];
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    fs.writeFileSync(path.join(cwd, 'SPEC.md'), '# demo\n\nA tiny CLI. Tests: node:test. Eval: run it end to end.\n');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# demo agents\n\nKeep it small.\n');
  });

  afterEach(() => {
    clearMods();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('builds the prompt from the guide and the docs (dry run, no engine call)', async () => {
    const li = require('../lib/loop-init');
    let called = false;
    const r = await li.initLoop({ cwd, engine: 'cursor', dryRun: true, runAgent: async () => { called = true; } });
    assert.equal(r.ok, true);
    assert.equal(called, false);
    assert.match(r.prompt, /How to write an aflt loop/);
    assert.match(r.prompt, /A tiny CLI/);
    assert.match(r.prompt, /Keep it small/);
    assert.match(r.prompt, /Cheap build model: composer-2\.5/);
    assert.match(r.prompt, /\.agentfleet\/loop\.json/);
    assert.equal(fs.existsSync(path.join(cwd, '.agentfleet', 'loop.json')), false);
  });

  it('drafts, validates, adds the AGENTS.md pointer and a dashboard copy', async () => {
    const li = require('../lib/loop-init');
    const prompts = [];
    const r = await li.initLoop({
      cwd,
      engine: 'cursor',
      runAgent: async ({ prompt, model }) => {
        prompts.push({ prompt, model });
        writeDraft(cwd, goodDraft());
        return { code: 0, stdout: 'done', sessionId: null };
      },
    });
    assert.equal(r.ok, true, (r.errors || []).join('; '));
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].model, 'composer-2.5');
    assert.equal(r.attempts.length, 1);
    assert.match(r.summary.join('\n'), /m1 \[⏸ approve first\]/);
    const agents = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Keep it small/);
    assert.match(agents, /This project uses an aflt loop; see `\.agentfleet\/loop\.json`/);
    // Pointer is not appended twice.
    li.ensureAgentsPointer(cwd, '.agentfleet/loop.json');
    assert.equal(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8').split('## aflt loop').length, 2);
    // Dashboard copy: absolute project cwd, project-relative prompt paths; valid from the definitions dir.
    assert.ok(r.dashboardCopy && r.dashboardCopy.startsWith(path.join(home, 'loops', 'definitions')), r.dashboardCopy);
    const copy = JSON.parse(fs.readFileSync(r.dashboardCopy, 'utf8'));
    assert.equal(path.isAbsolute(copy.cwd), true);
    assert.equal(copy.phases[0].promptFile, path.join('.agentfleet', 'prompts', 'm0.md'));
    assert.equal(copy.improveModel, 'composer-2.5');
    assert.equal(copy.phases[2].type, 'plan-next');
    const loop = require('../lib/loop');
    assert.ok(loop.listSavedDefinitions().definitions.some((d) => d.name === 'demo'));
    const v = loop.validateFile(r.dashboardCopy, { cwdBase: os.tmpdir() });
    assert.equal(v.ok, true, (v.errors || []).join('; '));
    assert.equal((v.warnings || []).filter((w) => /outside the project folder/.test(w)).length, 0, v.warnings.join('; '));
  });

  it('feeds validator and policy errors back for a repair, up to 2 times', async () => {
    const li = require('../lib/loop-init');
    const seen = [];
    const r = await li.initLoop({
      cwd,
      engine: 'cursor',
      dashboard: false,
      runAgent: async ({ prompt, attempt }) => {
        seen.push(prompt);
        const d = goodDraft();
        if (attempt === 0) {
          delete d.phases[1].gate;
          d.phases[1].eval.command = 'echo ok';
        }
        writeDraft(cwd, d);
        return { code: 0, stdout: '' };
      },
    });
    assert.equal(r.ok, true, (r.errors || []).join('; '));
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0].ok, false);
    assert.match(seen[1], /has problems/);
    assert.match(seen[1], /always passes/);
    assert.match(seen[1], /"gate": "approve"/);
  });

  it('gives up after the repair attempts and reports the errors', async () => {
    const li = require('../lib/loop-init');
    let calls = 0;
    const r = await li.initLoop({
      cwd,
      engine: 'cursor',
      runAgent: async () => {
        calls++;
        const d = goodDraft();
        d.phases[0].eval.command = 'true';
        writeDraft(cwd, d);
        return { code: 0, stdout: '' };
      },
    });
    assert.equal(r.ok, false);
    assert.equal(calls, 3);
    assert.match(r.errors.join('\n'), /always passes/);
    assert.equal(r.dashboardCopy, undefined);
    assert.doesNotMatch(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8'), /aflt loop/);
  });

  it('saves a JSON block from the reply when the engine did not write the file', async () => {
    const li = require('../lib/loop-init');
    const r = await li.initLoop({
      cwd,
      engine: 'cursor',
      dashboard: false,
      runAgent: async () => {
        writeDraft(cwd, goodDraft());
        fs.rmSync(path.join(cwd, '.agentfleet', 'loop.json'));
        return { code: 0, stdout: 'Here it is:\n```json\n' + JSON.stringify(goodDraft()) + '\n```\n' };
      },
    });
    assert.equal(r.ok, true, (r.errors || []).join('; '));
  });

  it('refuses to replace an existing loop.json without --force; --force keeps a .bak', async () => {
    const li = require('../lib/loop-init');
    writeDraft(cwd, goodDraft('old'));
    const r = await li.initLoop({ cwd, engine: 'cursor', runAgent: async () => ({ code: 0 }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /already exists/);
    const r2 = await li.initLoop({
      cwd,
      engine: 'cursor',
      force: true,
      dashboard: false,
      runAgent: async () => {
        writeDraft(cwd, goodDraft('new'));
        return { code: 0 };
      },
    });
    assert.equal(r2.ok, true, (r2.errors || []).join('; '));
    assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.agentfleet', 'loop.json.bak'), 'utf8')).name, 'old');
  });

  it('needs SPEC.md or AGENTS.md', async () => {
    const li = require('../lib/loop-init');
    fs.rmSync(path.join(cwd, 'SPEC.md'));
    fs.rmSync(path.join(cwd, 'AGENTS.md'));
    const r = await li.initLoop({ cwd, engine: 'cursor', runAgent: async () => ({ code: 0 }) });
    assert.equal(r.ok, false);
    assert.match(r.error, /no SPEC\.md or AGENTS\.md/);
  });

  it('CLI: aflt loop init drives the engine through the loop plumbing (stub cursor)', () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-li-stub-'));
    const fixture = path.join(stubDir, 'fixture');
    writeDraft(fixture, goodDraft('cli-demo'));
    const stub = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'process.stdout.write(require("crypto").randomUUID()+"\\n")'
  exit 0
fi
mkdir -p "$PWD/.agentfleet"
cp -R "$AFLT_TEST_FIXTURE/.agentfleet/." "$PWD/.agentfleet/"
echo '{"type":"result","result":"drafted"}'
`,
      { mode: 0o755 }
    );
    try {
      const env = {
        ...process.env,
        HOME: home,
        AGENTFLEET_HOME: home,
        AGENTFLEET_CURSOR_BIN: stub,
        AFLT_TEST_FIXTURE: fixture,
      };
      const res = spawnSync(process.execPath, [afJs, 'loop', 'init', '--engine', 'cursor', '--json'], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.equal(res.status, 0, res.stderr + res.stdout);
      const out = JSON.parse(res.stdout);
      assert.equal(out.ok, true, JSON.stringify(out.errors));
      assert.equal(out.engine, 'cursor');
      assert.ok(out.sessionId, 'registered a session for the drafting run');
      assert.ok(fs.existsSync(path.join(cwd, '.agentfleet', 'loop.json')));
      const text = spawnSync(process.execPath, [afJs, 'loop', 'validate', '.agentfleet/loop.json'], { cwd, env, encoding: 'utf8' });
      assert.equal(text.status, 0, text.stderr);
      const help = spawnSync(process.execPath, [afJs, 'loop'], { cwd, env, encoding: 'utf8' });
      assert.match(help.stderr + help.stdout, /loop init/);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

describe('loop init: project workdir', () => {
  function git(cwd, args) {
    return spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' },
    });
  }

  it('workdir.mode "project" accepts the clean project repo that holds the loop file', () => {
    clearMods();
    const loop = require('../lib/loop');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-li-proj-'));
    try {
      git(cwd, ['init', '-q']);
      writeDraft(cwd, { ...goodDraft(), workdir: { mode: 'project' } });
      fs.writeFileSync(path.join(cwd, 'SPEC.md'), '# spec\n');
      const def = path.join(cwd, '.agentfleet', 'loop.json');
      const dirty = loop.inspectLoopWorkdir(cwd, { definitionPath: def, workdir: { mode: 'project' } });
      assert.equal(dirty.ok, false);
      assert.match(dirty.problems.join('\n'), /git add -A && git commit/);
      git(cwd, ['add', '-A']);
      git(cwd, ['commit', '-q', '-m', 'seed']);
      const clean = loop.inspectLoopWorkdir(cwd, { definitionPath: def, workdir: { mode: 'project' } });
      assert.equal(clean.ok, true, clean.problems.join('; '));
      assert.equal(clean.mode, 'project');
      // The default (fresh) mode still refuses the same folder.
      assert.equal(loop.inspectLoopWorkdir(cwd, { definitionPath: def }).ok, false);
      const v = loop.validateFile(def, { cwdBase: cwd });
      assert.equal(v.ok, true, (v.errors || []).join('; '));
      assert.deepEqual(v.definition.workdir, { mode: 'project' });
      const bad = loop.validateDefinition({ ...goodDraft(), cwd, workdir: { mode: 'project', path: 'x' } }, { checkPromptFiles: false });
      assert.equal(bad.ok, false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('initLoop marks the draft workdir.mode "project" and says to commit first', async () => {
    clearMods();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-li-home2-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-li-cwd2-'));
    const prev = { HOME: process.env.HOME, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME };
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    try {
      fs.writeFileSync(path.join(cwd, 'SPEC.md'), '# s\n');
      const li = require('../lib/loop-init');
      const r = await li.initLoop({
        cwd,
        engine: 'cursor',
        runAgent: async () => {
          writeDraft(cwd, goodDraft());
          return { code: 0 };
        },
      });
      assert.equal(r.ok, true, (r.errors || []).join('; '));
      const written = JSON.parse(fs.readFileSync(path.join(cwd, '.agentfleet', 'loop.json'), 'utf8'));
      assert.deepEqual(written.workdir, { mode: 'project' });
      assert.match(r.next[0], /git add -A && git commit/);
      const copy = JSON.parse(fs.readFileSync(r.dashboardCopy, 'utf8'));
      assert.deepEqual(copy.workdir, { mode: 'project' });
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
});
