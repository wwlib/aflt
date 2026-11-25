'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const iso = require('../lib/isolation');

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
/** Only warnings about paths inside root (the machine running the test may have its own). */
function within(res, root) {
  return res.warnings.filter((w) => !w.path || w.path.startsWith(root));
}

describe('isolation checks', () => {
  it('flags a parent repo and parent instruction files', () => {
    const root = tmp('aflt-iso-');
    try {
      const parent = path.join(root, 'parent');
      const proj = path.join(parent, 'sub', 'proj');
      fs.mkdirSync(proj, { recursive: true });
      spawnSync('git', ['init', '-q', parent]);
      fs.writeFileSync(path.join(parent, 'AGENTS.md'), '# other project\n');
      fs.mkdirSync(path.join(parent, 'sub', '.cursor', 'rules'), { recursive: true });
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const res = iso.checkIsolation(proj, { space: 'proj', sessions: [], env: {}, home });
      const codes = within(res, root).map((w) => `${w.code}:${path.relative(root, w.path)}`);
      assert.ok(codes.includes('parent-repo:parent'), codes.join(' '));
      assert.ok(codes.includes('parent-instructions:parent/AGENTS.md'), codes.join(' '));
      assert.ok(codes.includes(`parent-instructions:parent/sub/${path.join('.cursor', 'rules')}`), codes.join(' '));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags global instructions, a shared memory repo and a shared or default space', () => {
    const root = tmp('aflt-iso-');
    try {
      const proj = path.join(root, 'proj');
      fs.mkdirSync(proj);
      const home = path.join(root, 'home');
      fs.mkdirSync(path.join(home, '.copilot'), { recursive: true });
      fs.writeFileSync(path.join(home, '.copilot', 'copilot-instructions.md'), 'be terse\n');
      fs.mkdirSync(path.join(home, '.cursor', 'rules'), { recursive: true });

      let res = iso.checkIsolation(proj, { space: null, env: {}, home });
      let codes = res.warnings.map((w) => w.code);
      assert.ok(codes.includes('shared-space'));
      assert.equal(within(res, root).filter((w) => w.code === 'global-instructions').length, 2);

      res = iso.checkIsolation(proj, {
        space: 'proj',
        sessions: [{ cwd: proj }, { cwd: path.join(root, 'elsewhere') }],
        env: { AFLT_MEMORY_REPO: path.join(root, 'shared-memory') },
        home,
      });
      codes = res.warnings.map((w) => w.code);
      assert.ok(codes.includes('shared-space'));
      assert.ok(codes.includes('shared-memory'));

      const spaceHome = path.join(root, 'space');
      res = iso.checkIsolation(proj, {
        space: 'proj',
        spaceHome,
        memoryRepo: path.join(root, 'elsewhere-memory'),
        sessions: [{ cwd: proj }],
        env: {},
        home,
      });
      assert.ok(res.warnings.some((w) => w.code === 'shared-memory'));
      res = iso.checkIsolation(proj, {
        space: 'proj',
        spaceHome,
        memoryRepo: path.join(spaceHome, 'memory'),
        sessions: [{ cwd: proj }],
        env: {},
        home: path.join(root, 'empty-home'),
      });
      assert.deepEqual(within(res, root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('aflt init refuses a non-empty folder unless --existing/--force; seed docs are fine', () => {
    const root = tmp('aflt-iso-');
    try {
      const projectInit = require('../lib/project-init');
      const seeded = path.join(root, 'seeded');
      fs.mkdirSync(seeded);
      fs.writeFileSync(path.join(seeded, 'SPEC.md'), '# spec\n');
      fs.writeFileSync(path.join(seeded, 'AGENTS.md'), '# agents\n');
      const ok = projectInit.initProject({ name: 'seeded', dir: seeded, space: false, env: {}, home: root });
      assert.equal(ok.ok, true);
      assert.equal(fs.readFileSync(path.join(seeded, 'SPEC.md'), 'utf8'), '# spec\n');

      const busy = path.join(root, 'busy');
      fs.mkdirSync(busy);
      fs.writeFileSync(path.join(busy, 'server.js'), '// old code\n');
      fs.writeFileSync(path.join(busy, 'notes.txt'), 'old notes\n');
      assert.throws(
        () => projectInit.initProject({ name: 'busy', dir: busy, space: false, env: {}, home: root }),
        /not empty \(notes\.txt, server\.js\).*--existing/
      );
      assert.equal(fs.existsSync(path.join(busy, '.git')), false, 'nothing written on refusal');
      const res = projectInit.initProject({ name: 'busy', dir: busy, space: false, existing: true, env: {}, home: root });
      assert.deepEqual(res.existingEntries, ['notes.txt', 'server.js']);
      assert.ok(res.isolation.warnings.some((w) => w.code === 'shared-space'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('aflt init --isolated refuses when something could leak in', () => {
    const root = tmp('aflt-iso-');
    try {
      const projectInit = require('../lib/project-init');
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# parent rules\n');
      const dir = path.join(root, 'p');
      assert.throws(
        () => projectInit.initProject({ name: 'p', dir, space: false, isolated: true, env: {}, home: root }),
        /isolation check failed[\s\S]*AGENTS\.md/
      );
      assert.equal(fs.existsSync(dir), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('loop init reports isolation, refuses with --isolated, and tells the engine to stay in the folder', async () => {
    const root = tmp('aflt-iso-');
    try {
      const loopInit = require('../lib/loop-init');
      const proj = path.join(root, 'proj');
      fs.mkdirSync(proj);
      fs.writeFileSync(path.join(proj, 'SPEC.md'), '# spec\n');
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# parent\n');
      const common = { cwd: proj, engine: 'cursor', dryRun: true, space: 'proj', spaceHome: path.join(root, 'sp'), memoryRepo: null, env: {}, home: path.join(root, 'h') };
      const dry = await loopInit.initLoop(common);
      assert.equal(dry.ok, true);
      assert.match(dry.prompt, /Do not read files outside the project folder/);
      assert.ok(dry.isolation.warnings.some((w) => w.code === 'parent-instructions' && w.path === path.join(root, 'CLAUDE.md')));
      const refused = await loopInit.initLoop({ ...common, isolated: true });
      assert.equal(refused.ok, false);
      assert.match(refused.error, /isolation check failed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('loop init policy rejects checks that run files outside the project', () => {
    const loopInit = require('../lib/loop-init');
    const raw = {
      name: 'x',
      budget: { maxRuns: 9 },
      phases: [
        { id: 'm0', prompt: 'Write the tests and the eval script.', eval: { command: ['node', '../shared/check.js'] } },
        { id: 'm1', prompt: 'next', gate: 'approve', eval: { command: 'npm test' } },
      ],
    };
    const r = loopInit.checkLoopPolicy(raw, { projectDir: '/p/proj' });
    assert.ok(r.errors.some((e) => /phase m0: check uses \.\.\/shared\/check\.js outside the project folder/.test(e)), r.errors.join('; '));
    assert.ok(!r.errors.some((e) => /phase m1: check uses/.test(e)));
  });
});
