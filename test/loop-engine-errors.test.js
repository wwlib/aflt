'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/usage',
    '../lib/turns',
    '../lib/registry',
    '../lib/config',
    '../lib/memory',
    '../lib/notify',
    '../lib/engine-errors',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function startCapture() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        /* ignore */
      }
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        hits,
        url: `http://127.0.0.1:${server.address().port}/hook`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    );
  });
}

describe('loop non-retryable engine errors', () => {
  let home;
  let cwd;
  let prev;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-eerr-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-eerr-cwd-'));
    prev = {
      HOME: process.env.HOME,
      AGENTFLEET_HOME: process.env.AGENTFLEET_HOME,
      AGENTFLEET_CURSOR_BIN: process.env.AGENTFLEET_CURSOR_BIN,
      AGENTFLEET_COPILOT_BIN: process.env.AGENTFLEET_COPILOT_BIN,
      AGENTFLEET_COPILOT_HOME: process.env.AGENTFLEET_COPILOT_HOME,
      COPILOT_MODEL: process.env.COPILOT_MODEL,
    };
    delete process.env.COPILOT_MODEL;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    fs.mkdirSync(process.env.AGENTFLEET_HOME, { recursive: true });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    clearMods();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function def(name) {
    return {
      name,
      cwd,
      project: 'demo',
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 10, maxHours: 1 },
      phases: [
        {
          id: 'p1',
          session: `${name}-p1`,
          prompt: 'do it',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 3,
          onPass: 'none',
        },
      ],
    };
  }

  function harness(runPrompt) {
    return {
      env: process.env,
      fresh: true,
      ensureSession: async () => ({
        id: 'sess-eerr',
        title: 'eerr-p1',
        engine: 'cursor',
        cwd,
        status: 'active',
      }),
      runPrompt,
      runEval: async () => ({ code: 0, timedOut: false, stdout: '', stderr: '', cwd }),
    };
  }

  it('fails immediately on a usage limit without spending fix attempts', async () => {
    const loop = require('../lib/loop');
    const capture = await startCapture();
    process.env.AFLT_NOTIFY_URL = capture.url;
    let calls = 0;
    const limit = "b: You've hit your usage limit for Other Models on the Pro plan.";
    try {
      const result = await loop.runLoop(
        def('eerr-usage'),
        harness(async () => {
          calls += 1;
          return {
            code: 1,
            timedOut: false,
            stdout: '',
            stderr: `starting\n${limit}\n`,
            engineErrorText: `starting\n${limit}\n`,
          };
        })
      );
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.equal(calls, 1);
      const state = loop.loadState('eerr-usage');
      assert.equal(state.runsUsed, 1);
      assert.equal(state.phases.p1.status, 'failed');
      assert.equal(state.phases.p1.errorKind, 'usage_limit');
      assert.match(state.lastError, /usage_limit/);
      assert.match(state.lastError, /You've hit your usage limit/);
      assert.doesNotMatch(state.lastError, /agent exited/);
      const failed = state.history.find((h) => h.event === 'loop.phase.failed');
      assert.equal(failed.errorKind, 'usage_limit');
      assert.equal(failed.nonRetryable, true);
      assert.match(failed.summary, /usage limit/);
      assert.ok(!state.history.some((h) => h.event === 'loop.phase.eval_failed'));
      await new Promise((r) => setTimeout(r, 100));
      const phaseFailed = capture.hits.find((h) => h.event === 'loop.phase.failed');
      const loopFailed = capture.hits.find((h) => h.event === 'loop.failed');
      for (const hit of [phaseFailed, loopFailed]) {
        assert.ok(hit, JSON.stringify(capture.hits.map((h) => h.event)));
        assert.equal(hit.errorKind, 'usage_limit');
        assert.equal(hit.nonRetryable, true);
        assert.match(hit.summary, /usage limit/);
      }
    } finally {
      delete process.env.AFLT_NOTIFY_URL;
      await capture.close();
    }
  });

  it('still retries (fix attempts) for ordinary agent failures', async () => {
    const loop = require('../lib/loop');
    let calls = 0;
    const result = await loop.runLoop(
      def('eerr-normal'),
      harness(async () => {
        calls += 1;
        return {
          code: 1,
          timedOut: false,
          stdout: '# fail 2\nAssertionError: expected 5 to equal 6',
          stderr: 'agent blew up',
        };
      })
    );
    assert.equal(result.ok, false);
    assert.equal(calls, 4);
    const state = loop.loadState('eerr-normal');
    assert.match(state.lastError, /failed after 3 fix attempt/);
    assert.equal(state.phases.p1.errorKind, undefined);
  });
  function stubLoop(engine, script, name) {
    spawnSync('git', ['init'], { cwd, encoding: 'utf8' });
    fs.writeFileSync(path.join(cwd, 'KEEP.txt'), 'x\n');
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-eerr-stub-'));
    const stub = path.join(stubDir, engine === 'cursor' ? 'cursor-agent' : 'copilot');
    fs.writeFileSync(stub, script, { mode: 0o755 });
    const d = def(name);
    d.engine = engine;
    const file = path.join(stubDir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(d));
    const key = engine === 'cursor' ? 'AGENTFLEET_CURSOR_BIN' : 'AGENTFLEET_COPILOT_BIN';
    const env = { ...process.env, [key]: stub, AGENTFLEET_COPILOT_HOME: path.join(home, 'ch') };
    delete env.COPILOT_MODEL;
    process.env[key] = stub;
    process.env.AGENTFLEET_COPILOT_HOME = env.AGENTFLEET_COPILOT_HOME;
    return { file, env, stubDir, key };
  }

  it('real cursor run: usage limit on stderr stops after one run', async () => {
    const stubSrc = `#!/usr/bin/env bash
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'process.stdout.write(require("crypto").randomUUID()+"\\n")'
  exit 0
fi
echo "b: You've hit your usage limit for Other Models on the Pro plan." >&2
exit 1
`;
    const { file, env, stubDir } = stubLoop('cursor', stubSrc, 'eerr-real-cursor');
    try {
      const loop = require('../lib/loop');
      const result = await loop.runFromFile(file, { env, checkWorkdir: true, allowExisting: true });
      assert.equal(result.status, 'failed');
      const state = loop.loadState('eerr-real-cursor');
      assert.equal(state.runsUsed, 1);
      assert.equal(state.phases.p1.errorKind, 'usage_limit');
      assert.match(state.lastError, /You've hit your usage limit/);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('copilot unavailable default model: auto fallback retry happens first, then fails fast', async () => {
    const log = path.join(home, 'calls.log');
    const stubSrc = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
echo 'Error: Model "gpt-9" is not available' >&2
exit 1
`;
    const { file, env, stubDir } = stubLoop('copilot', stubSrc, 'eerr-real-copilot');
    try {
      const loop = require('../lib/loop');
      const result = await loop.runFromFile(file, { env, checkWorkdir: true, allowExisting: true });
      assert.equal(result.status, 'failed');
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
      assert.equal(calls.length, 2, calls.join('\n'));
      assert.doesNotMatch(calls[0], /--model/);
      assert.match(calls[1], /--model auto/);
      const state = loop.loadState('eerr-real-copilot');
      assert.equal(state.phases.p1.errorKind, 'model_unavailable');
      assert.match(state.lastError, /Model "gpt-9" is not available/);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('missing engine CLI fails fast as cli_missing', async () => {
    const stubSrc = '#!/usr/bin/env bash\nexit 0\n';
    const { file, env, stubDir } = stubLoop('copilot', stubSrc, 'eerr-missing-cli');
    try {
      env.AGENTFLEET_COPILOT_BIN = path.join(stubDir, 'does-not-exist');
      process.env.AGENTFLEET_COPILOT_BIN = env.AGENTFLEET_COPILOT_BIN;
      const loop = require('../lib/loop');
      const result = await loop.runFromFile(file, { env, checkWorkdir: true, allowExisting: true });
      assert.equal(result.status, 'failed');
      const state = loop.loadState('eerr-missing-cli');
      assert.equal(state.runsUsed, 1);
      assert.equal(state.phases.p1.errorKind, 'cli_missing');
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
