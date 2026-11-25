'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pp = require('../lib/protected-paths');

function git(dir, args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function mod(name) {
  for (const m of ['../lib/loop', '../lib/notify', '../lib/config', '../lib/memory', '../lib/registry']) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
  return require(name);
}

describe('protected-paths glob matcher', () => {
  const hit = (patterns, file) => pp.matchProtected([file], patterns).length === 1;

  it('matches exact paths and anything below a plain directory path', () => {
    assert.equal(hit(['scripts/eval/bot.js'], 'scripts/eval/bot.js'), true);
    assert.equal(hit(['scripts/eval/bot.js'], 'scripts/eval/bot.jsx'), false);
    assert.equal(hit(['scripts/eval'], 'scripts/eval/a/b.js'), true);
    assert.equal(hit(['scripts/eval/'], 'scripts/eval/a/b.js'), true);
    assert.equal(hit(['scripts/eval'], 'scripts/evaluate.js'), false);
  });

  it('* stays within a segment, ** crosses directories', () => {
    assert.equal(hit(['test/*.test.js'], 'test/eval.test.js'), true);
    assert.equal(hit(['test/*.test.js'], 'test/sub/eval.test.js'), false);
    assert.equal(hit(['scripts/**'], 'scripts/eval/bot.js'), true);
    assert.equal(hit(['scripts/**'], 'lib/scripts/x.js'), false);
    assert.equal(hit(['**/eval.js'], 'eval.js'), true);
    assert.equal(hit(['**/eval.js'], 'a/b/eval.js'), true);
    assert.equal(hit(['**/eval.js'], 'a/b/myeval.js'), false);
    assert.equal(hit(['a/**/c.js'], 'a/c.js'), true);
    assert.equal(hit(['a/**/c.js'], 'a/x/y/c.js'), true);
    assert.equal(hit(['file?.js'], 'file1.js'), true);
    assert.equal(hit(['file?.js'], 'file/.js'), false);
  });

  it('escapes regex metacharacters and ignores a leading ./', () => {
    assert.equal(hit(['a.b'], 'axb'), false);
    assert.equal(hit(['./a.b'], 'a.b'), true);
    assert.equal(hit(['x+(y)'], 'x+(y)'), true);
  });

  it('normalizeProtected validates shape and paths', () => {
    assert.deepEqual(pp.normalizeProtected(undefined, 'd'), { ok: true, value: null });
    const ok = pp.normalizeProtected({ paths: ['a/**', './a/**', 'b'], source: 'base' }, 'd');
    assert.deepEqual(ok.value, { paths: ['a/**', 'b'], source: 'base' });
    for (const bad of [
      [],
      { paths: [] },
      { paths: [''] },
      { paths: ['/etc/x'] },
      { paths: ['../x'] },
      { paths: ['a'], source: 'head' },
    ]) {
      assert.equal(pp.normalizeProtected(bad, 'd').ok, false, JSON.stringify(bad));
    }
  });
});

describe('protected-paths git helpers', () => {
  let tmp;
  let repo;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-prot-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'scripts', 'eval'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'scripts', 'eval', 'bot.js'), 'base\n');
    fs.writeFileSync(path.join(repo, 'app.js'), 'x\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports modified, staged, deleted, committed and untracked paths', () => {
    const base = pp.headSha(repo);
    assert.match(base, /^[0-9a-f]{40}$/);
    assert.deepEqual(pp.changedPathsSince(repo, base), []);
    fs.writeFileSync(path.join(repo, 'app.js'), 'y\n');
    fs.writeFileSync(path.join(repo, 'scripts', 'eval', 'new.js'), 'n\n');
    fs.writeFileSync(path.join(repo, 'staged.js'), 's\n');
    git(repo, ['add', 'staged.js']);
    assert.deepEqual(pp.changedPathsSince(repo, base), ['app.js', 'scripts/eval/new.js', 'staged.js']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'more']);
    fs.rmSync(path.join(repo, 'scripts', 'eval', 'bot.js'));
    assert.ok(pp.changedPathsSince(repo, base).includes('scripts/eval/bot.js'));
  });

  it('findViolations fails closed without a base sha', () => {
    assert.equal(pp.findViolations(repo, null, ['scripts/**']), null);
    assert.deepEqual(pp.findViolations(repo, pp.headSha(repo), []), []);
  });

  it('materializeBaseTree checks out the base commit and cleans up', () => {
    const base = pp.headSha(repo);
    fs.writeFileSync(path.join(repo, 'scripts', 'eval', 'bot.js'), 'tampered\n');
    const tree = pp.materializeBaseTree(repo, base);
    assert.equal(fs.readFileSync(path.join(tree.path, 'scripts', 'eval', 'bot.js'), 'utf8'), 'base\n');
    tree.cleanup();
    assert.equal(fs.existsSync(tree.path), false);
    assert.equal(git(repo, ['worktree', 'list']).split('\n').length, 1);
    tree.cleanup();
  });

  it('materializeBaseTree honors an explicit dest', () => {
    const dest = path.join(tmp, 'base-tree');
    const tree = pp.materializeBaseTree(repo, pp.headSha(repo), dest);
    assert.equal(tree.path, dest);
    assert.ok(fs.existsSync(path.join(dest, 'app.js')));
    tree.cleanup();
    assert.equal(fs.existsSync(dest), false);
  });
});

describe('aflt loop protected paths', () => {
  let home;
  let repo;
  let prevHome;
  let prevAfHome;
  let prevUrl;
  let prevMemory;
  let stubBin;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-prot-home-')));
    stubBin = path.join(home, 'cursor-agent');
    fs.writeFileSync(stubBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-prot-cwd-')));
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevUrl = process.env.AFLT_NOTIFY_URL;
    prevMemory = process.env.AFLT_MEMORY_REPO;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AFLT_NOTIFY_URL;
    delete process.env.AFLT_MEMORY_REPO;
    git(repo, ['init', '-q', '-b', 'main']);
    fs.mkdirSync(path.join(repo, 'scripts', 'eval'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'scripts', 'eval', 'bot.js'), 'base\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    for (const [k, v] of [
      ['HOME', prevHome],
      ['AGENTFLEET_HOME', prevAfHome],
      ['AFLT_NOTIFY_URL', prevUrl],
      ['AFLT_MEMORY_REPO', prevMemory],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function def(overrides = {}) {
    return {
      name: 'prot-loop',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 20, maxHours: 2 },
      protected: { paths: ['scripts/eval/**', 'test/eval.test.js'] },
      phases: [
        {
          id: 'build',
          engine: 'cursor',
          prompt: 'make a change',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 3,
          onPass: 'none',
        },
      ],
      ...overrides,
    };
  }

  function opts(onRun, extra = {}) {
    const calls = { prompts: 0, evals: 0 };
    return {
      calls,
      opts: {
        env: { ...process.env, HOME: home, AGENTFLEET_HOME: home, AGENTFLEET_CURSOR_BIN: stubBin },
        allowExisting: true,
        ensureSession: async () => ({ id: 's1', title: 't', engine: 'cursor', cwd: repo, status: 'active' }),
        runPrompt: async () => {
          calls.prompts += 1;
          onRun(calls.prompts);
          return { code: 0, timedOut: false, stdout: 'ok', stderr: '', outPath: null, runId: `r${calls.prompts}` };
        },
        runEval: async () => {
          calls.evals += 1;
          return { code: 0, timedOut: false, stdout: 'pass', stderr: '', cwd: repo };
        },
        ...extra,
      },
    };
  }

  function writeDef(body) {
    const file = path.join(home, 'prot-loop.json');
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  }

  it('fails a phase that edits a protected file with no fix attempts', async () => {
    const loop = mod('../lib/loop');
    const { opts: o, calls } = opts(() => {
      fs.writeFileSync(path.join(repo, 'scripts', 'eval', 'bot.js'), 'tampered\n');
    });
    const r = await loop.runFromFile(writeDef(def()), o);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
    assert.equal(calls.prompts, 1, 'no fix attempt');
    assert.equal(calls.evals, 0, 'eval is skipped');
    const state = loop.loadState('prot-loop');
    assert.match(state.lastError, /protected path\(s\) changed/);
    assert.match(state.lastError, /scripts\/eval\/bot\.js/);
    assert.equal(state.phases.build.status, 'failed');
    assert.deepEqual(state.phases.build.protectedViolation, ['scripts/eval/bot.js']);
    assert.match(state.baseSha, /^[0-9a-f]{40}$/);
    assert.equal(state.phases.build.baseSha, state.baseSha);
    const events = state.history.map((h) => h.event);
    assert.ok(events.includes('loop.phase.protected_violation'));
    assert.ok(events.includes('loop.phase.failed'));
    assert.ok(!events.includes('loop.phase.eval_failed'));
    const violation = state.history.find((h) => h.event === 'loop.phase.protected_violation');
    assert.deepEqual(violation.protectedViolation, ['scripts/eval/bot.js']);
  });

  it('catches an untracked new file under a protected directory', async () => {
    const loop = mod('../lib/loop');
    const { opts: o, calls } = opts(() => {
      fs.writeFileSync(path.join(repo, 'scripts', 'eval', 'extra.js'), 'new\n');
    });
    const r = await loop.runFromFile(writeDef(def()), o);
    assert.equal(r.status, 'failed');
    assert.equal(calls.prompts, 1);
    assert.deepEqual(loop.loadState('prot-loop').phases.build.protectedViolation, ['scripts/eval/extra.js']);
  });

  it('honors per-phase protected additions', async () => {
    const loop = mod('../lib/loop');
    const d = def({ protected: undefined });
    d.phases[0].protected = { paths: ['locked.txt'] };
    const { opts: o, calls } = opts(() => {
      fs.writeFileSync(path.join(repo, 'locked.txt'), 'x\n');
    });
    const r = await loop.runFromFile(writeDef(d), o);
    assert.equal(r.status, 'failed');
    assert.equal(calls.prompts, 1);
  });

  it('passes a phase that only edits non-protected files', async () => {
    const loop = mod('../lib/loop');
    const { opts: o, calls } = opts(() => {
      fs.writeFileSync(path.join(repo, 'app.js'), 'ok\n');
    });
    const r = await loop.runFromFile(writeDef(def()), o);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.status, 'completed');
    assert.equal(calls.evals, 1);
    assert.equal(loop.loadState('prot-loop').phases.build.protectedViolation, undefined);
  });

  it('a later phase is judged against its own base commit', async () => {
    const loop = mod('../lib/loop');
    const d = def({ protected: { paths: ['app.js'] } });
    d.phases.push({ ...d.phases[0], id: 'second' });
    const { opts: o } = opts((n) => {
      fs.writeFileSync(path.join(repo, `file${n}.txt`), 'x\n');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '-m', `phase ${n}`]);
    });
    const r = await loop.runFromFile(writeDef(d), o);
    assert.equal(r.status, 'completed');
    const state = loop.loadState('prot-loop');
    assert.notEqual(state.phases.second.baseSha, state.phases.build.baseSha);
    assert.equal(state.phases.second.baseSha, git(repo, ['rev-parse', 'HEAD~1']));
  });

  it('fails closed when protected paths are set but the cwd is not a git repo', async () => {
    const loop = mod('../lib/loop');
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-prot-plain-')));
    try {
      const { opts: o, calls } = opts(() => {});
      const r = await loop.runFromFile(writeDef(def({ cwd: plain })), o);
      assert.equal(r.status, 'failed');
      assert.equal(calls.prompts, 0);
      assert.match(loop.loadState('prot-loop').lastError, /protected paths need a git cwd/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('definitions without protected behave as before', async () => {
    const loop = mod('../lib/loop');
    const d = def({ protected: undefined });
    const { opts: o, calls } = opts(() => {
      fs.writeFileSync(path.join(repo, 'scripts', 'eval', 'bot.js'), 'edited\n');
    });
    const r = await loop.runFromFile(writeDef(d), o);
    assert.equal(r.status, 'completed');
    assert.equal(calls.evals, 1);
  });

  it('validates protected in definitions and keeps it when saved', () => {
    const loop = mod('../lib/loop');
    const bad = loop.validateDefinition(def({ protected: { paths: [] } }), { cwdBase: repo });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /protected\.paths/.test(e)));
    const good = loop.validateDefinition(def(), { cwdBase: repo });
    assert.equal(good.ok, true, (good.errors || []).join('; '));
    assert.deepEqual(good.definition.protected.paths, ['scripts/eval/**', 'test/eval.test.js']);
    const plan = loop.planDryRun(good.definition, null, { env: process.env });
    assert.deepEqual(plan.phases[0].protected, ['scripts/eval/**', 'test/eval.test.js']);
  });

  it('notify payloads carry protectedViolation', () => {
    const loop = mod('../lib/loop');
    const state = { name: 'n', attempt: 0, phaseId: 'build', definition: { cwd: repo } };
    const p = loop.buildLoopNotifyPayload('loop.phase.failed', state, {
      protectedViolation: ['scripts/eval/bot.js'],
    });
    assert.deepEqual(p.protectedViolation, ['scripts/eval/bot.js']);
    assert.equal('protectedViolation' in loop.buildLoopNotifyPayload('loop.phase.failed', state, {}), false);
  });
});
