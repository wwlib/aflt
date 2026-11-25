'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const gateLib = require('../lib/commit-gate');

function git(dir, args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
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

const NODE_TEST_OUT = [
  'ℹ tests 681',
  'ℹ suites 90',
  'ℹ pass 680',
  'ℹ fail 0',
  'ℹ cancelled 0',
  'ℹ skipped 1',
  'ℹ todo 0',
].join('\n');

describe('commit-gate helpers', () => {
  it('normalizeCommitGate defaults and validates', () => {
    assert.deepEqual(gateLib.normalizeCommitGate(undefined), { ok: true, value: null });
    assert.deepEqual(gateLib.normalizeCommitGate({}).value, {
      mode: 'off',
      trailer: 'Verified-by',
      requireTiers: [],
    });
    const ok = gateLib.normalizeCommitGate({ mode: 'Enforce', trailer: 'Checked-by', requireTiers: ['tier1', 'tier1', ' tier2 '] });
    assert.deepEqual(ok.value, { mode: 'enforce', trailer: 'Checked-by', requireTiers: ['tier1', 'tier2'] });
    for (const bad of ['x', [], { mode: 'strict' }, { mode: 'observe', trailer: 'bad trailer' }, { requireTiers: 'tier1' }, { requireTiers: [''] }]) {
      assert.equal(gateLib.normalizeCommitGate(bad).ok, false, JSON.stringify(bad));
    }
  });

  it('parses node:test summary counts and records the eval verification', () => {
    assert.equal(gateLib.parseNodeTestCounts('nothing here'), null);
    assert.deepEqual(gateLib.parseNodeTestCounts(NODE_TEST_OUT), { tests: 681, pass: 680, fail: 0, skipped: 1 });
    const ps = {};
    const entry = gateLib.recordEvalVerification(
      ps,
      { command: 'npm test' },
      { code: 0, stdout: NODE_TEST_OUT, stderr: '', durationMs: 1234 },
      { ok: true }
    );
    assert.equal(entry.summary, 'npm test 681/681 (1 skipped)');
    assert.equal(entry.code, 0);
    assert.equal(entry.durationMs, 1234);
    assert.equal(entry.tests.pass, 680);
    assert.equal(ps.verification.length, 1);
  });

  it('recordVerification replaces per tier and formats Verified-by', () => {
    const ps = {};
    assert.equal(gateLib.formatVerifiedBy(ps.verification), 'none');
    gateLib.recordEvalVerification(ps, { command: ['npm', 'test'] }, { code: 0, stdout: NODE_TEST_OUT }, { ok: true });
    gateLib.recordVerification(ps, { tier: 'tier2', ok: false, summary: 'smoke' });
    gateLib.recordVerification(ps, { tier: 'tier2', ok: true, summary: 'smoke ok' });
    assert.equal(ps.verification.length, 2);
    assert.equal(gateLib.formatVerifiedBy(ps.verification), 'npm test 681/681 (1 skipped); tier2 smoke ok');
    gateLib.recordVerification(ps, { tier: 'tier3', ok: false });
    assert.match(gateLib.formatVerifiedBy(ps.verification), /; tier3 FAILED$/);
    assert.deepEqual(gateLib.missingTiers({ requireTiers: ['eval', 'tier2', 'tier3', 'tier4'] }, ps.verification), ['tier3', 'tier4']);
    assert.throws(() => gateLib.recordVerification(ps, { ok: true }));
  });
});

describe('aflt loop commit gate', () => {
  let home;
  let repo;
  let prevHome;
  let prevAfHome;
  let prevUrl;
  let prevMemory;
  let stubBin;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-cgate-home-')));
    stubBin = path.join(home, 'cursor-agent');
    fs.writeFileSync(stubBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-cgate-cwd-')));
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevUrl = process.env.AFLT_NOTIFY_URL;
    prevMemory = process.env.AFLT_MEMORY_REPO;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AFLT_NOTIFY_URL;
    delete process.env.AFLT_MEMORY_REPO;
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Gate Tester']);
    git(repo, ['config', 'user.email', 'gate@example.com']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
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

  function def(commitGate, phaseOver = {}) {
    return {
      name: 'gate-loop',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: true, merge: false, push: false },
      budget: { maxRuns: 20, maxHours: 2 },
      ...(commitGate ? { commitGate } : {}),
      phases: [
        {
          id: 'build',
          engine: 'cursor',
          model: 'test-model',
          prompt: 'make a change',
          eval: { command: 'npm test', exitCode: 0 },
          maxFixAttempts: 2,
          onPass: 'commit',
          ...phaseOver,
        },
      ],
    };
  }

  function opts() {
    const calls = { prompts: 0 };
    return {
      calls,
      opts: {
        env: { ...process.env, HOME: home, AGENTFLEET_HOME: home, AGENTFLEET_CURSOR_BIN: stubBin },
        allowExisting: true,
        ensureSession: async () => ({ id: 's1', title: 't', engine: 'cursor', cwd: repo, status: 'active' }),
        runPrompt: async () => {
          calls.prompts += 1;
          fs.writeFileSync(path.join(repo, 'app.js'), `v${calls.prompts}\n`);
          return { code: 0, timedOut: false, stdout: 'ok', stderr: '', outPath: null, runId: `r${calls.prompts}` };
        },
        runEval: async () => ({ code: 0, timedOut: false, stdout: NODE_TEST_OUT, stderr: '', cwd: repo }),
      },
    };
  }

  function writeDef(body) {
    const file = path.join(home, 'gate-loop.json');
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  }

  const lastMessage = () => git(repo, ['log', '-1', '--format=%B']);
  const events = (state) => state.history.map((h) => h.event);

  function silenceStderr() {
    const orig = process.stderr.write;
    const lines = [];
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    return { lines, restore: () => (process.stderr.write = orig) };
  }

  it('off (default): commit message is unchanged', async () => {
    const loop = mod('../lib/loop');
    for (const gate of [undefined, { mode: 'off', requireTiers: ['tier1'] }]) {
      const { opts: o } = opts();
      const r = await loop.runFromFile(writeDef(def(gate)), { ...o, fresh: true });
      assert.equal(r.status, 'completed', r.error);
      assert.equal(lastMessage(), 'aflt loop gate-loop phase build passed');
      assert.equal(loop.loadState('gate-loop').phases.build.onPass.gate, undefined);
      fs.rmSync(path.join(repo, 'app.js'), { force: true });
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '-m', 'reset']);
    }
  });

  it('observe: adds trailers and commits; missing required tier only warns', async () => {
    const loop = mod('../lib/loop');
    const { opts: o } = opts();
    const err = silenceStderr();
    let r;
    try {
      r = await loop.runFromFile(writeDef(def({ mode: 'observe', requireTiers: ['tier2'] })), o);
    } finally {
      err.restore();
    }
    assert.equal(r.status, 'completed', r.error);
    const msg = lastMessage();
    assert.match(msg, /^aflt loop gate-loop phase build passed\n\nVerified-by: npm test 681\/681 \(1 skipped\)\nAflt-Loop: gate-loop phase build attempt 0, engine cursor, model test-model\n?$/);
    assert.equal(git(repo, ['status', '--porcelain']), '');
    const state = loop.loadState('gate-loop');
    const warn = state.history.find((h) => h.event === 'loop.commit_gate.warning');
    assert.match(warn.summary, /required tier\(s\) not recorded ok: tier2/);
    assert.ok(!events(state).includes('loop.commit_gate.refused'));
    assert.ok(err.lines.some((l) => /tier2/.test(l)));
    assert.equal(state.phases.build.verification[0].tier, 'eval');
    assert.equal(state.phases.build.onPass.gate.mode, 'observe');
  });

  it('observe: a custom trailer name and a leftover dirty tree are warned, not blocked', async () => {
    const loop = mod('../lib/loop');
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho late > late.txt\n', { mode: 0o755 });
    const { opts: o } = opts();
    const err = silenceStderr();
    let r;
    try {
      r = await loop.runFromFile(writeDef(def({ mode: 'observe', trailer: 'Checked-by' })), o);
    } finally {
      err.restore();
    }
    assert.equal(r.status, 'completed', r.error);
    assert.match(lastMessage(), /\nChecked-by: npm test 681\/681/);
    const state = loop.loadState('gate-loop');
    assert.ok(state.history.some((h) => h.event === 'loop.commit_gate.warning' && /not clean after commit.*late\.txt/.test(h.summary)));
  });

  it('enforce: refuses without the required tier (no commit, no fix attempt)', async () => {
    const loop = mod('../lib/loop');
    const before = git(repo, ['rev-parse', 'HEAD']);
    const { opts: o, calls } = opts();
    const err = silenceStderr();
    let r;
    try {
      r = await loop.runFromFile(writeDef(def({ mode: 'enforce', requireTiers: ['tier1'] })), o);
    } finally {
      err.restore();
    }
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
    assert.equal(calls.prompts, 1, 'no fix attempt');
    assert.equal(git(repo, ['rev-parse', 'HEAD']), before, 'no commit made');
    const state = loop.loadState('gate-loop');
    assert.match(state.lastError, /required tier\(s\) not recorded ok: tier1/);
    assert.equal(state.phases.build.status, 'failed');
    const ev = events(state);
    assert.ok(ev.includes('loop.commit_gate.refused'));
    assert.ok(ev.includes('loop.phase.failed'));
    assert.ok(!ev.includes('loop.phase.eval_failed'));
  });

  it('enforce: accepts when every required tier is recorded ok and adds the trailer', async () => {
    const loop = mod('../lib/loop');
    const { opts: o } = opts();
    const r = await loop.runFromFile(writeDef(def({ mode: 'enforce', requireTiers: ['eval'] })), o);
    assert.equal(r.status, 'completed', r.error);
    assert.match(lastMessage(), /\nVerified-by: npm test 681\/681 \(1 skipped\)\nAflt-Loop: gate-loop phase build attempt 0, engine cursor, model test-model/);
    assert.ok(!events(loop.loadState('gate-loop')).includes('loop.commit_gate.refused'));
  });

  it('runOnPassAction enforce honors tiers recorded via recordVerification', () => {
    const loop = mod('../lib/loop');
    const definition = {
      name: 'gate-loop',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: true },
      commitGate: { mode: 'enforce', trailer: 'Verified-by', requireTiers: ['tier1', 'tier2'] },
    };
    const phase = { id: 'build', engine: 'cursor' };
    const phaseState = {};
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    loop.recordVerification(phaseState, { tier: 'tier1', ok: true, summary: 'unit green' });
    const refused = loop.runOnPassAction('commit', definition, phase, { phaseState, attempt: 1 });
    assert.equal(refused.ok, false);
    assert.equal(refused.gate.refused, true);
    assert.match(refused.error, /tier2/);
    assert.match(git(repo, ['status', '--porcelain']), /a\.txt/, 'nothing committed');

    loop.recordVerification(phaseState, { tier: 'tier2', ok: true, summary: 'smoke ok' });
    const ok = loop.runOnPassAction('commit', definition, phase, { phaseState, attempt: 1, engine: 'copilot' });
    assert.equal(ok.ok, true);
    assert.match(lastMessage(), /Verified-by: tier1 unit green; tier2 smoke ok\nAflt-Loop: gate-loop phase build attempt 1, engine copilot\n?$/);
  });

  it('enforce: refuses when the tree is still dirty after the commit', async () => {
    const loop = mod('../lib/loop');
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho late > late.txt\n', { mode: 0o755 });
    const { opts: o } = opts();
    const err = silenceStderr();
    let r;
    try {
      r = await loop.runFromFile(writeDef(def({ mode: 'enforce' })), o);
    } finally {
      err.restore();
    }
    assert.equal(r.status, 'failed');
    const state = loop.loadState('gate-loop');
    assert.match(state.lastError, /not clean after commit.*late\.txt/);
    assert.ok(events(state).includes('loop.commit_gate.refused'));
  });

  it('applies the trailer to a merge commit created by onPass merge', () => {
    const loop = mod('../lib/loop');
    git(repo, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'f\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'feature work']);
    git(repo, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'main work']);
    git(repo, ['checkout', '-q', 'feature']);
    git(repo, ['branch', '-q', '--set-upstream-to=main']);
    const definition = {
      name: 'gate-loop',
      cwd: repo,
      engine: 'cursor',
      allow: { merge: true },
      commitGate: { mode: 'observe', trailer: 'Verified-by', requireTiers: [] },
    };
    const phaseState = {};
    gateLib.recordVerification(phaseState, { tier: 'tier1', ok: true, summary: 'green' });
    const res = loop.runOnPassAction('merge', definition, { id: 'ship', engine: 'cursor' }, { phaseState, attempt: 0 });
    assert.equal(res.ok, true, res.error);
    assert.equal(git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').length, 3, 'merge commit');
    assert.match(lastMessage(), /Merge branch '.*main' into feature\n\nVerified-by: tier1 green\nAflt-Loop: gate-loop phase ship attempt 0, engine cursor\n?$/);
  });

  it('validates commitGate, warns when unused, and keeps it when saved', () => {
    const loop = mod('../lib/loop');
    const bad = loop.validateDefinition({ ...def({ mode: 'bogus' }) }, { checkCwd: false });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('\n'), /commitGate\.mode/);
    const none = def({ mode: 'observe' }, { onPass: 'none' });
    const v = loop.validateDefinition(none, { checkCwd: false });
    assert.equal(v.ok, true, (v.errors || []).join('; '));
    assert.ok(v.warnings.some((w) => /commitGate has no effect/.test(w)));
    const good = loop.validateDefinition(def({ mode: 'enforce', requireTiers: ['tier1'] }), { checkCwd: false });
    assert.deepEqual(good.definition.commitGate, { mode: 'enforce', trailer: 'Verified-by', requireTiers: ['tier1'] });
    assert.equal(loop.validateDefinition(def(undefined), { checkCwd: false }).definition.commitGate, undefined);
  });
});
