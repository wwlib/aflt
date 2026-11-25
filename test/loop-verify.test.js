'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const loopVerify = require('../lib/loop-verify');
const commitGate = require('../lib/commit-gate');

describe('loop-verify helpers', () => {
  it('isPortBlocked respects reserved ports', () => {
    assert.equal(loopVerify.isPortBlocked(8787), true);
    assert.equal(loopVerify.isPortBlocked(8792), true);
    assert.equal(loopVerify.isPortBlocked(8810), true);
    assert.equal(loopVerify.isPortBlocked(8790), false);
  });

  it('normalizeVerify accepts tier shapes', () => {
    const ok = loopVerify.normalizeVerify({
      tier1: ['npm', 'test'],
      tier2: { loop: 'examples/loops/hello-eval.json', timeoutSec: 60 },
      tier3: { tileDungeon: true, trials: 2 },
      dashboard: { routes: ['/api/state'] },
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value.tier1.command, ['npm', 'test']);
    assert.equal(ok.value.tier2.loop, 'examples/loops/hello-eval.json');
    assert.equal(ok.value.tier3.trials, 2);
  });

  it('tier ordering stops at first failure', async () => {
    const calls = [];
    const phaseState = { verification: [] };
    const r = await loopVerify.runAfterEvalVerify({
      state: { verifyCheckpoints: {} },
      definition: {
        name: 'x',
        cwd: process.cwd(),
        verify: { tier1: ['false'], tier2: { loop: 'a.json', timeoutSec: 1 } },
      },
      phase: {},
      phaseState,
      recordVerification: (e) => commitGate.recordVerification(phaseState, e),
      saveState: () => {},
      env: process.env,
      runCommand: async () => ({ code: 1, stdout: '', stderr: 'fail' }),
      tierRunners: {
        tier1: async (spec, ctx) => {
          calls.push('tier1');
          return { ok: false, summary: 'tier1 red' };
        },
        tier2: async () => {
          calls.push('tier2');
          return { ok: true, summary: 'tier2 ok' };
        },
        tier3: async () => ({ ok: true, summary: 'tier3 ok' }),
      },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, ['tier1']);
    assert.equal(phaseState.verification.filter((v) => v.tier === 'tier2').length, 0);
  });

  it('mergeVerify honors explicit null to skip inherited tiers', () => {
    const merged = loopVerify.mergeVerify(
      {
        tier1: { command: ['npm', 'test'] },
        tier2: { loop: 'x.json' },
        tier3: { tileDungeon: true, trials: 2 },
      },
      { tier3: null }
    );
    assert.ok(merged.tier1);
    assert.ok(merged.tier2);
    assert.equal(merged.tier3, null);
    const onlyT3 = loopVerify.mergeVerify(
      {
        tier1: { command: ['npm', 'test'] },
        tier2: { loop: 'x.json' },
        tier3: { tileDungeon: true, trials: 2 },
      },
      { tier1: null, tier2: null, tier3: { tileDungeon: true, trials: 1 } }
    );
    assert.equal(onlyT3.tier1, null);
    assert.equal(onlyT3.tier2, null);
    assert.equal(onlyT3.tier3.trials, 1);
  });

  it('checkpoint skip on resume for same SHA', async () => {
    const sha = 'abc123def456789012345678901234567890';
    const state = {
      verifyCheckpoints: {
        [sha]: { tiers: { tier1: { ok: true, summary: 'cached green' } } },
      },
    };
    const phaseState = { verification: [] };
    let ran = false;
    const r = await loopVerify.runAfterEvalVerify({
      state,
      definition: {
        name: 'x',
        cwd: '/tmp',
        verify: { tier1: ['npm', 'test'] },
      },
      phase: {},
      phaseState,
      recordVerification: (e) => commitGate.recordVerification(phaseState, e),
      saveState: () => {},
      env: process.env,
      headSha: () => sha,
      runCommand: async () => {
        ran = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(ran, false);
    assert.match(
      phaseState.verification.find((v) => v.tier === 'tier1').summary,
      /checkpoint/
    );
  });
});

describe('dashboard checker', () => {
  let tiny;
  let port;

  before(() => {
    tiny = http.createServer((req, res) => {
      if (req.url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: [], projects: [], loops: { ok: true, loops: [] } }));
        return;
      }
      if (req.url === '/api/loops') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, loops: [] }));
        return;
      }
      if (req.url === '/api/loops/definitions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ definitions: [] }));
        return;
      }
      if (req.url === '/api/loops/demo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: 'demo', status: 'running', phases: [{ id: 'a' }] }));
        return;
      }
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>ok</body></html>');
        return;
      }
      res.writeHead(404);
      res.end('missing');
    });
  });

  after(() => {
    if (tiny) tiny.close();
  });

  it('passes on healthy tiny server', async () => {
    await new Promise((resolve) => tiny.listen(0, '127.0.0.1', resolve));
    port = tiny.address().port;
    const r = await loopVerify.runDashboardUiCheck({ port, loopName: 'demo' });
    assert.equal(r.ok, true);
  });

  it('fails when loop detail missing', async () => {
    const r = await loopVerify.runDashboardUiCheck({
      port,
      loopName: 'missing',
      dashboard: { routes: [{ method: 'GET', path: '/api/loops/:name', shape: 'loopDetail' }] },
    });
    assert.equal(r.ok, false);
  });
});
describe('verify checkpoint key covers uncommitted work', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');

  function tempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-verify-key-'));
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const sha = String(git('rev-parse', 'HEAD')).trim();
    return { dir, sha };
  }

  it('clean tree keys by HEAD; edits and untracked files change the key', () => {
    const { dir, sha } = tempRepo();
    try {
      assert.equal(loopVerify.verifyCheckpointKey(dir, process.env), sha);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
      const k1 = loopVerify.verifyCheckpointKey(dir, process.env);
      assert.match(k1, new RegExp(`^${sha}\\+dirty-[0-9a-f]{16}$`));
      fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
      const k2 = loopVerify.verifyCheckpointKey(dir, process.env);
      assert.notEqual(k2, k1);
      fs.writeFileSync(path.join(dir, 'new.txt'), 'y\n');
      assert.notEqual(loopVerify.verifyCheckpointKey(dir, process.env), k2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not reuse a green HEAD checkpoint after uncommitted edits', async () => {
    const { dir, sha } = tempRepo();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'worker edit\n');
      const state = {
        verifyCheckpoints: { [sha]: { tiers: { tier1: { ok: true, summary: 'cached green' } } } },
      };
      const phaseState = { verification: [] };
      let ran = false;
      const r = await loopVerify.runAfterEvalVerify({
        state,
        definition: { name: 'x', cwd: dir, verify: { tier1: { command: ['npm', 'test'] } } },
        phase: {},
        phaseState,
        recordVerification: (e) => commitGate.recordVerification(phaseState, e),
        saveState: () => {},
        env: process.env,
        runCommand: async () => {
          ran = true;
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      assert.equal(r.ok, true);
      assert.equal(ran, true);
      assert.match(r.sha, /\+dirty-/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dashboard serve (real child, no fakes)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dashboardApi = require('../scripts/eval/dashboard-api');

  it('dashboard-api exports every helper loop-verify calls', () => {
    for (const name of ['httpRequest', 'checkDashboardRoutes', 'waitForServeJson', 'stopChild']) {
      assert.equal(typeof dashboardApi[name], 'function', `dashboard-api.${name}`);
    }
  });

  it('withDashboardServe starts aflt dashboard --serve on a free port and stops it', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-verify-serve-'));
    let child = null;
    try {
      const out = await loopVerify.withDashboardServe(
        {
          packageRoot: path.resolve(__dirname, '..'),
          space: 'verify-serve-test',
          env: { ...process.env, HOME: home },
        },
        async (h) => {
          child = h.child;
          assert.equal(loopVerify.isPortBlocked(h.port), false);
          const state = await dashboardApi.httpRequest(h.port, '/api/state');
          const loops = await dashboardApi.httpRequest(h.port, '/api/loops');
          const root = await dashboardApi.httpRequest(h.port, '/');
          return { state: state.status, loops: loops.status, root: root.status };
        }
      );
      assert.deepEqual(out, { state: 200, loops: 200, root: 200 });
      assert.ok(child);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'dashboard child stopped');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('loop detail shape + failed route summary', () => {
  it('accepts phases keyed by id (the real /api/loops/:name shape)', () => {
    const body = JSON.stringify({ ok: true, name: 'x', status: 'completed', phases: { a: {}, b: {} } });
    const r = loopVerify.checkLoopDetailShape(200, body, true);
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    const empty = loopVerify.checkLoopDetailShape(
      200,
      JSON.stringify({ ok: true, name: 'x', status: 'completed', phases: {} }),
      true
    );
    assert.equal(empty.ok, false);
  });

  it('failedRouteSummary names the failing route and check', () => {
    const s = loopVerify.failedRouteSummary({
      ok: false,
      routes: [
        { path: '/api/state', ok: true },
        { path: '/api/loops/x', ok: false, checks: [{ ok: true, detail: 'ok:true' }, { ok: false, detail: 'status=failed' }] },
      ],
    });
    assert.equal(s, '; failed: /api/loops/x (status=failed)');
    assert.equal(loopVerify.failedRouteSummary({ ok: true, routes: [] }), '');
  });
});

describe('candidate aflt + nested loop path resolution', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const repoRoot = path.resolve(__dirname, '..');

  it('afltRootFor smokes the candidate checkout when the loop cwd is aflt', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-not-aflt-'));
    try {
      const ctx = { cwd: repoRoot, packageRoot: '/opt/stable-aflt' };
      assert.equal(loopVerify.afltRootFor({}, ctx), repoRoot);
      assert.equal(loopVerify.afltRootFor({ aflt: 'runner' }, ctx), '/opt/stable-aflt');
      assert.equal(loopVerify.afltRootFor({}, { cwd: other, packageRoot: '/opt/stable-aflt' }), '/opt/stable-aflt');
      assert.equal(loopVerify.afltRootFor({ aflt: 'candidate' }, { cwd: other, packageRoot: '/x' }), other);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('resolveNestedLoopPath tries the loop cwd before the definition dir', () => {
    const defDir = path.join(repoRoot, 'examples', 'loops');
    const rel = 'examples/loops/hello-eval.json';
    assert.equal(
      loopVerify.resolveNestedLoopPath(rel, { cwd: repoRoot, definitionDir: defDir }),
      path.join(repoRoot, rel)
    );
    assert.equal(
      loopVerify.resolveNestedLoopPath('hello-eval.json', { cwd: '/nonexistent-cwd', definitionDir: defDir }),
      path.join(defDir, 'hello-eval.json')
    );
    assert.equal(loopVerify.resolveNestedLoopPath('/abs/x.json', { cwd: repoRoot }), '/abs/x.json');
  });
});
