'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const repoRoot = path.join(__dirname, '..');
const loop = require('../lib/loop');

function git(dir, args) {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

describe('loop workdir.mode worktree', () => {
  let tmp;
  let main;
  let wt;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-wt-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'linked');
    fs.mkdirSync(main);
    git(main, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(main, 'file.txt'), 'x\n');
    git(main, ['add', '-A']);
    git(main, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const WT = { mode: 'worktree', base: 'main' };

  it('passes a clean, non-empty linked worktree', () => {
    git(main, ['worktree', 'add', '-q', '-b', 'self', wt, 'main']);
    const r = loop._test.inspectLoopWorkdir(wt, { workdir: WT });
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.equal(r.mode, 'worktree');
    assert.equal(r.linkedWorktree, true);
    assert.equal(r.clean, true);
  });

  it('refuses a dirty worktree and suggests git worktree add', () => {
    git(main, ['worktree', 'add', '-q', '-b', 'self', wt, 'main']);
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x\n');
    const r = loop._test.inspectLoopWorkdir(wt, { workdir: WT });
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /not clean/);
    assert.match(r.problems.join('\n'), /git worktree add/);
  });

  it('refuses a non-git directory', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    const r = loop._test.inspectLoopWorkdir(plain, { workdir: WT });
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), /not a git repository/);
  });

  it('refuses the running package root and paths inside it', () => {
    const root = loop._test.inspectLoopWorkdir(repoRoot, { workdir: WT });
    assert.equal(root.ok, false);
    assert.match(root.problems.join('\n'), /running aflt checkout/);
    assert.match(root.problems.join('\n'), /git worktree add/);
    const inner = loop._test.inspectLoopWorkdir(path.join(repoRoot, 'lib'), { workdir: WT });
    assert.equal(inner.ok, false);
    assert.match(inner.problems.join('\n'), /running aflt checkout/);
  });

  it('keeps strict behavior for a non-empty repo without workdir', () => {
    const r = loop._test.inspectLoopWorkdir(main);
    assert.equal(r.ok, false);
    assert.equal(r.mode, 'fresh');
    assert.match(r.problems.join('\n'), /not an empty dedicated git repository/);
  });

  it('normalizes workdir and rejects unknown modes', () => {
    const n = loop._test.normalizeWorkdir;
    assert.deepEqual(n(undefined, tmp).value, { mode: 'fresh' });
    assert.deepEqual(n({ mode: 'worktree' }, tmp).value, {
      mode: 'worktree',
      base: 'origin/main',
      path: null,
      branch: null,
    });
    assert.equal(n({ mode: 'worktree', path: '~/x' }, tmp).value.path, path.join(os.homedir(), 'x'));
    const bad = n({ mode: 'shared' }, tmp);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /workdir\.mode must be "fresh", "worktree" or "project"/);
    assert.equal(n({ mode: 'worktree', base: '--evil' }, tmp).ok, false);
    assert.equal(n({ mode: 'fresh', path: '/x' }, tmp).ok, false);
    assert.equal(n('worktree', tmp).ok, false);
  });

  describe('through aflt loop', () => {
    let home;
    let defs;

    beforeEach(() => {
      home = path.join(tmp, 'home');
      defs = path.join(tmp, 'defs');
      fs.mkdirSync(home);
      fs.mkdirSync(defs);
    });

    function env() {
      const e = { ...process.env, HOME: home, AGENTFLEET_HOME: home };
      delete e.AGENTFLEET_TEST_HERMETIC;
      return e;
    }

    function writeDef(extra) {
      const file = path.join(defs, 'wt.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          name: 'wt-loop',
          engine: 'cursor',
          budget: { maxRuns: 2, maxHours: 1 },
          phases: [
            {
              id: 'p1',
              session: 'wt-p1',
              prompt: 'x',
              eval: { command: ['true'], exitCode: 0 },
              maxFixAttempts: 0,
              onPass: 'none',
            },
          ],
          ...extra,
        })
      );
      return file;
    }

    function run(file, args = []) {
      return spawnSync(process.execPath, [afJs, 'loop', 'run', file, '--dry-run', ...args], {
        encoding: 'utf8',
        env: env(),
        cwd: tmp,
      });
    }

    it('validate rejects an unknown workdir mode', () => {
      const file = writeDef({ cwd: main, workdir: { mode: 'bogus' } });
      const r = spawnSync(process.execPath, [afJs, 'loop', 'validate', file], {
        encoding: 'utf8',
        env: env(),
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /workdir\.mode must be "fresh", "worktree" or "project"/);
    });

    it('dry-run reports the worktree inspection and passes a clean linked worktree', () => {
      git(main, ['worktree', 'add', '-q', '-b', 'self', wt, 'main']);
      const file = writeDef({ cwd: wt, workdir: WT });
      const text = run(file);
      assert.equal(text.status, 0, text.stderr + text.stdout);
      assert.match(text.stdout, /workdir: mode=worktree base=main git=true clean=true linked=true ok/);
      const json = JSON.parse(run(file, ['--json']).stdout);
      assert.equal(json.workdir.mode, 'worktree');
      assert.equal(json.workdir.linkedWorktree, true);
    });

    it('dry-run refuses a dirty worktree and the aflt checkout', () => {
      git(main, ['worktree', 'add', '-q', '-b', 'self', wt, 'main']);
      fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x\n');
      const dirty = run(writeDef({ cwd: wt, workdir: WT }));
      assert.equal(dirty.status, 1);
      assert.match(dirty.stderr, /not clean/);
      const self = run(writeDef({ cwd: repoRoot, workdir: WT }));
      assert.equal(self.status, 1);
      assert.match(self.stderr, /running aflt checkout/);
    });

    it('does not change the strict guard when workdir is absent', () => {
      const r = run(writeDef({ cwd: main }));
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not an empty dedicated git repository/);
      assert.doesNotMatch(r.stdout, /workdir:/);
    });

    it('prints the create command for a missing workdir.path and creates only with --create-worktree', () => {
      const target = path.join(tmp, 'made');
      const repoDefs = path.join(main, 'examples');
      fs.mkdirSync(repoDefs);
      const file = path.join(repoDefs, 'wt.json');
      fs.writeFileSync(
        file,
        JSON.stringify({
          name: 'wt-loop',
          engine: 'cursor',
          workdir: { mode: 'worktree', base: 'main', path: target, branch: 'aflt-self-test' },
          budget: { maxRuns: 2, maxHours: 1 },
          phases: [
            {
              id: 'p1',
              session: 'wt-p1',
              prompt: 'x',
              eval: { command: ['true'], exitCode: 0 },
              maxFixAttempts: 0,
              onPass: 'none',
            },
          ],
        })
      );
      git(main, ['add', '-A']);
      git(main, ['commit', '-q', '-m', 'defs']);

      const missing = run(file);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /git worktree add -b aflt-self-test .*made main/);
      assert.equal(fs.existsSync(target), false);

      const planned = run(file, ['--create-worktree']);
      assert.equal(planned.status, 0, planned.stderr);
      assert.equal(fs.existsSync(target), false, 'dry-run must not create');

      const validated = loop.validateFile(file);
      assert.equal(validated.ok, true, (validated.errors || []).join('; '));
      assert.equal(validated.definition.cwd, target);
      const gate = loop._test.applyWorkdirGate(
        validated.definition,
        { createWorktree: true, checkWorkdir: true, definitionPath: file },
        null
      );
      assert.equal(gate.ok, true, gate.error);
      assert.equal(git(target, ['rev-parse', '--abbrev-ref', 'HEAD']), 'aflt-self-test');
      const after = loop._test.inspectLoopWorkdir(target, { workdir: validated.definition.workdir });
      assert.equal(after.ok, true, after.problems.join('; '));
      assert.equal(after.linkedWorktree, true);
    });
  });
});
