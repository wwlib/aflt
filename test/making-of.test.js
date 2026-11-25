'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync, execFileSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const FIX = path.join(__dirname, 'fixtures', 'making-of');
// Scrubbed from real runs (Copilot Claude Sonnet 5.5 hello-aflt m1; Cursor
// Composer probe; Cursor GPT-5.3-Codex m0 transcript). Text fields truncated,
// home paths replaced with /home/user, opaque ids replaced.
const COPILOT_CHAT = '6f068464-180d-4847-bb5f-9eae8cdd2bb8';
const COPILOT_M1_CREDITS = 20.23259;

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function clearMods() {
  for (const m of [
    '../lib/util',
    '../lib/usage',
    '../lib/copilot',
    '../lib/turns',
    '../lib/loop',
    '../lib/registry',
    '../lib/config',
    '../lib/making-of',
    '../lib/making-of-view',
    '../lib/dashboard',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('usage-summary double counting', () => {
  const usage = require('../lib/usage');

  it('counts a headless run once when Copilot events re-record the same work', () => {
    // Real m1 turns: one headless-run turn + one copilot-events turn, same usage.
    const turns = readLines(path.join(FIX, 'copilot-turns.jsonl'));
    assert.equal(turns.length, 2);
    const naive = usage.summarizeSessionUsage(turns, { dedupe: false });
    assert.equal(naive.premiumRequests, 14, 'old behavior double-counted');
    const s = usage.summarizeSessionUsage(turns);
    assert.equal(s.premiumRequests, 7);
    assert.equal(s.totalTokens, 271618);
    assert.equal(s.outputTokens, 11491);
    assert.equal(s.turnCount, 1);
    assert.equal(s.dedupedTurns, 1);
    assert.equal(s.accuracy, 'reported');
  });

  it('drops estimated Cursor transcript turns covered by a reported headless run', () => {
    const chatId = 'cccccccc-1111-2222-3333-444444444444';
    const turns = [
      { source: 'headless-run', chatId, at: '2026-11-23T23:15:26.057Z', usage: usage.normalizeCursorUsage({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000 }) },
      { source: 'cursor-transcript', chatId, at: '2026-11-23T23:15:31.889Z', usage: usage.estimateUsageFromText({ prompt: 'x'.repeat(400), reply: 'y'.repeat(80), cli: 'cursor' }) },
    ];
    const s = usage.summarizeSessionUsage(turns);
    assert.equal(s.turnCount, 1);
    assert.equal(s.dedupedTurns, 1);
    assert.equal(s.accuracy, 'reported');
    assert.equal(s.totalInput, 6000);
  });

  it('keeps interactive turns and later turns after a new headless run separate', () => {
    const chatId = 'dddddddd-1111-2222-3333-444444444444';
    const rec = (tok) => usage.normalizeCopilotUsage({ inputTokens: tok, outputTokens: 10, cost: 1 });
    const interactiveOnly = [
      { source: 'copilot-events', chatId, at: '2026-11-24T01:00:00Z', usage: rec(100) },
      { source: 'copilot-events', chatId, at: '2026-11-24T01:05:00Z', usage: rec(200) },
    ];
    assert.equal(usage.summarizeSessionUsage(interactiveOnly).turnCount, 2);
    // An events turn on another chat is not covered.
    const other = [
      { source: 'headless-run', chatId, at: '2026-11-24T01:00:00Z', usage: rec(100) },
      { source: 'copilot-events', chatId: 'eeeeeeee-1111-2222-3333-444444444444', at: '2026-11-24T01:01:00Z', usage: rec(50) },
    ];
    assert.equal(usage.summarizeSessionUsage(other).turnCount, 2);
    // An estimated headless run does not hide a reported events turn.
    const est = [
      { source: 'headless-run', chatId, at: '2026-11-24T01:00:00Z', usage: usage.estimateUsageFromText({ prompt: 'a', reply: 'b', cli: 'copilot' }) },
      { source: 'copilot-events', chatId, at: '2026-11-24T01:01:00Z', usage: rec(50) },
    ];
    assert.equal(usage.summarizeSessionUsage(est).turnCount, 2);
  });

  it('records Copilot AI credits and dollars with their pricing basis', () => {
    const copilot = require('../lib/copilot');
    const text = fs.readFileSync(path.join(FIX, 'copilot-events.jsonl'), 'utf8');
    const parsed = copilot.parseCopilotJsonOutput(text, {});
    assert.equal(parsed.usage.accuracy, 'reported');
    assert.ok(Math.abs(parsed.usage.credits - COPILOT_M1_CREDITS) < 1e-6, String(parsed.usage.credits));
    assert.ok(Math.abs(parsed.usage.usd - COPILOT_M1_CREDITS * 0.01) < 1e-9);
    assert.equal(parsed.usage.costBasis, 'copilot-nano-aiu');
    assert.equal(parsed.usage.cost, null, 'cost stays provider USD only');
    const s = usage.summarizeSessionUsage([{ usage: parsed.usage }, { usage: parsed.usage }], { dedupe: false });
    assert.ok(Math.abs(s.credits - 2 * COPILOT_M1_CREDITS) < 1e-6);
    assert.equal(s.costBasis, 'copilot-nano-aiu');
    const merged = usage.mergeUsageSummaries([s, usage.summarizeSessionUsage([])]);
    assert.ok(Math.abs(merged.credits - 2 * COPILOT_M1_CREDITS) < 1e-6);
    assert.deepEqual(usage.creditsFromNanoAiu(1e9), { credits: 1, usd: 0.01 });
    // Cursor usage carries no credits (never estimated).
    assert.equal(usage.normalizeCursorUsage({ inputTokens: 1, outputTokens: 1 }).credits, null);
  });
});

describe('making-of parsers', () => {
  const mo = require('../lib/making-of');

  it('parses Copilot events.jsonl into calls with recorded cost', () => {
    const r = mo.parseCopilotEvents(readLines(path.join(FIX, 'copilot-events.jsonl')), { phase: 'm1', chatId: COPILOT_CHAT });
    assert.equal(r.calls.length, 7);
    const credits = r.calls.reduce((a, c) => a + c.cost.credits, 0);
    assert.ok(Math.abs(credits - COPILOT_M1_CREDITS) < 1e-6);
    for (const c of r.calls) {
      for (const k of ['phase', 'timestamp', 'engine', 'model', 'input', 'output', 'toolCalls', 'tokens', 'cost', 'costBasis']) {
        assert.ok(Object.prototype.hasOwnProperty.call(c, k), k);
      }
      assert.equal(c.engine, 'copilot');
      assert.equal(c.model, 'claude-sonnet-5.5');
      assert.equal(c.cost.accuracy, 'reported');
      assert.match(c.costBasis, /totalNanoAiu/);
    }
    const first = r.calls[0];
    assert.ok(first.input.some((i) => i.type === 'system'));
    assert.ok(first.input.some((i) => i.type === 'user'));
    assert.equal(r.context.systemPrompts.length, 1, 'system prompt stored once');
    const tools = r.calls.flatMap((c) => c.toolCalls);
    assert.ok(tools.length > 0);
    assert.ok(tools.every((t) => t.result != null || t.success === false), 'tool results recorded');
    assert.ok(tools.some((t) => t.files.length), 'file edits recorded');
    assert.ok(r.calls[1].input.some((i) => i.type === 'toolResult'));
    assert.ok(r.context.toolDefinitions.tokens > 0);
    assert.ok(r.meta.shutdowns.length >= 1);
  });

  it('parses Cursor stream-json into calls with tool results and run usage', () => {
    const r = mo.parseCursorStream(readLines(path.join(FIX, 'cursor-stream.jsonl')), { phase: 'p' });
    assert.equal(r.calls.length, 2);
    const [a, b] = r.calls;
    assert.equal(a.model, 'Composer 2.5');
    assert.equal(a.input[0].type, 'user');
    assert.match(a.output.reasoning, /read a\.txt/);
    assert.equal(a.toolCalls.length, 1);
    assert.equal(a.toolCalls[0].name, 'read');
    assert.equal(a.toolCalls[0].result, 'hello probe\n');
    assert.equal(a.toolCalls[0].success, true);
    assert.ok(a.timestamp);
    assert.equal(b.input[0].type, 'toolResult');
    assert.equal(b.output.text, 'hello probe');
    assert.equal(b.tokens, null, 'Cursor has no per-call tokens');
    assert.equal(b.cost, null);
    assert.equal(r.meta.usage.inputTokens, 6506);
    assert.equal(r.meta.usage.outputTokens, 105);
  });

  it('parses a Cursor transcript and finds files from ApplyPatch bodies', () => {
    const r = mo.parseCursorTranscript(readLines(path.join(FIX, 'cursor-transcript.jsonl')), { phase: 'm0', chatId: 'c' });
    assert.equal(r.calls.length, 7);
    assert.ok(r.calls.every((c) => c.step === true && c.tokens === null));
    const files = r.calls.flatMap((c) => c.toolCalls.flatMap((t) => t.files.map((f) => path.basename(f.path))));
    assert.ok(files.includes('server.js'), files.join(','));
    assert.deepEqual(mo.filesFromPatch('*** Begin Patch\n*** Update File: a/b.js\n*** Delete File: c.txt\n'), [
      { path: 'a/b.js', kind: 'update' },
      { path: 'c.txt', kind: 'delete' },
    ]);
  });
});

describe('making-of recording, command and routes', () => {
  let home;
  let copilotHome;
  let repo;
  let defDir;
  const saved = {};
  const ENV_KEYS = ['HOME', 'AGENTFLEET_HOME', 'AGENTFLEET_COPILOT_HOME', 'AGENTFLEET_CURSOR_HOME', 'AFLT_SPACE', 'AGENTFLEET_CURSOR_BIN'];

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mo-home-'));
    copilotHome = path.join(home, '.copilot');
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mo-repo-'));
    defDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mo-def-'));
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    process.env.AGENTFLEET_CURSOR_HOME = path.join(home, '.cursor');
    delete process.env.AFLT_SPACE;
    clearMods();
  });

  afterEach(() => {
    clearMods();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of [home, repo, defDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  function seedCopilotPhase(sessionId) {
    const stateDir = path.join(copilotHome, 'session-state', COPILOT_CHAT);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'copilot-events.jsonl'), path.join(stateDir, 'events.jsonl'));
    const runDir = path.join(home, 'runs', sessionId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'copilot-turns.jsonl'), path.join(runDir, 'turns.jsonl'));
  }

  function seedLoop() {
    // Repo with an aflt phase commit touching files the fixture edits.
    git(repo, ['init', '-q']);
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'aflt loop demo phase m0 passed']);
    fs.writeFileSync(path.join(repo, 'src', 'rng.js'), 'export const rng = 1;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'aflt loop demo phase m1 passed']);
    fs.mkdirSync(path.join(repo, 'eval'));
    fs.writeFileSync(path.join(repo, 'eval', 'history.jsonl'), '{"overall":90}\n');
    // Seeds next to the definition.
    fs.writeFileSync(path.join(defDir, 'seed-m0.js'), 'console.log("seed")\n');
    fs.mkdirSync(path.join(defDir, 'm0-seed', 'src'), { recursive: true });
    fs.writeFileSync(path.join(defDir, 'm0-seed', 'package.json'), '{}\n');
    fs.writeFileSync(path.join(defDir, 'm0-seed', 'src', 'main.js'), '//\n');
    const sessionId = 'demo-m1-abc123';
    seedCopilotPhase(sessionId);
    const loopDir = path.join(home, 'loops', 'demo');
    fs.mkdirSync(loopDir, { recursive: true });
    fs.writeFileSync(
      path.join(loopDir, 'state.json'),
      JSON.stringify({
        version: 1,
        name: 'demo',
        status: 'completed',
        definitionPath: path.join(defDir, 'demo.json'),
        definition: {
          name: 'demo',
          cwd: repo,
          allow: { push: false },
          phases: [
            { id: 'm0', type: 'script', eval: { command: ['node', 'seed-m0.js'] } },
            { id: 'm1', type: 'run', session: 'demo-m1' },
          ],
        },
        phases: {
          m0: { id: 'm0', status: 'passed', lastEval: { at: '2026-11-24T03:13:00.000Z', code: 0, stdout: 'seed ok', stderr: '' } },
          m1: { id: 'm1', status: 'passed', sessionId, lastEval: { at: '2026-11-24T03:14:40.000Z', code: 0, stdout: 'tests 16 pass 16', stderr: '' } },
        },
        history: [],
      })
    );
    return sessionId;
  }

  it('recordPhase archives Copilot events and writes calls.jsonl + session-context.json', () => {
    const mo = require('../lib/making-of');
    const sessionId = 'demo-m1-abc123';
    seedCopilotPhase(sessionId);
    const out = mo.recordPhase({ sessionId, chatId: COPILOT_CHAT, engine: 'copilot', phase: 'm1' });
    assert.equal(out.ok, true, out.error);
    assert.equal(out.calls, 7);
    const archived = path.join(home, 'runs', sessionId, 'engine', `copilot-${COPILOT_CHAT}.events.jsonl`);
    assert.ok(fs.existsSync(archived));
    assert.equal(fs.statSync(archived).mode & 0o777, 0o600);
    const calls = readLines(path.join(home, 'runs', sessionId, 'calls.jsonl'));
    assert.equal(calls.length, 7);
    assert.deepEqual(calls.map((c) => c.index), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(calls.every((c) => c.phase === 'm1' && c.v === 1));
    const ctx = JSON.parse(fs.readFileSync(path.join(home, 'runs', sessionId, 'session-context.json'), 'utf8'));
    assert.equal(ctx.context.systemPrompts.length, 1);
    assert.equal(ctx.engine, 'copilot');
    // Archived copy wins after the live log is gone.
    fs.rmSync(path.join(copilotHome, 'session-state'), { recursive: true, force: true });
    assert.equal(mo.buildSessionRecord(sessionId).calls.length, 7);
  });

  it('recordPhase keeps every Cursor stream-json event', () => {
    const mo = require('../lib/making-of');
    const sessionId = 'cur-p-000001';
    fs.mkdirSync(path.join(home, 'runs', sessionId), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'runs', sessionId, 'turns.jsonl'),
      JSON.stringify({ sessionId, chatId: 'chat-1234', engine: 'cursor', source: 'headless-run', at: '2026-11-24T10:00:00Z' }) + '\n'
    );
    const stdout = fs.readFileSync(path.join(FIX, 'cursor-stream.jsonl'), 'utf8');
    const out = mo.recordPhase({ sessionId, chatId: 'chat-1234', engine: 'cursor', stdout, runStartedAt: '2026-11-24T10:00:00Z', phase: 'p' });
    assert.equal(out.ok, true, out.error);
    const streams = fs.readdirSync(path.join(home, 'runs', sessionId, 'engine')).filter((f) => f.endsWith('.stream.jsonl'));
    assert.equal(streams.length, 1);
    const saved = fs.readFileSync(path.join(home, 'runs', sessionId, 'engine', streams[0]), 'utf8');
    assert.equal(readLines(path.join(home, 'runs', sessionId, 'engine', streams[0])).length, stdout.trim().split('\n').length);
    assert.ok(saved.includes('"tool_call"'));
    assert.equal(out.calls, 2);
  });

  it('loop phases on Cursor request stream-json and record the making-of', async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mo-stub-'));
    const stub = path.join(stubDir, 'cursor-agent');
    fs.copyFileSync(path.join(FIX, 'cursor-stream.jsonl'), path.join(stubDir, 'stream.jsonl'));
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'process.stdout.write(require("crypto").randomUUID()+"\\n")'
  exit 0
fi
echo "$*" > "${stubDir}/argv.txt"
printf 'hello probe\\n' > "$PWD/a.txt"
cat "${stubDir}/stream.jsonl"
`,
      { mode: 0o755 }
    );
    process.env.AGENTFLEET_CURSOR_BIN = stub;
    git(repo, ['init', '-q']);
    const loop = require('../lib/loop');
    const def = {
      name: 'mo-cursor',
      cwd: repo,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 3, maxHours: 1 },
      phases: [
        {
          id: 'probe',
          session: 'mo-cursor-probe',
          prompt: 'Read a.txt',
          eval: { command: ['test', '-f', 'a.txt'], exitCode: 0 },
          maxFixAttempts: 0,
          force: true,
        },
      ],
    };
    const file = path.join(defDir, 'mo-cursor.json');
    fs.writeFileSync(file, JSON.stringify(def));
    try {
      const result = await loop.runFromFile(file, { env: { ...process.env } });
      assert.equal(result.ok, true, result.error);
      assert.match(fs.readFileSync(path.join(stubDir, 'argv.txt'), 'utf8'), /--output-format stream-json/);
      const sid = result.state.phases.probe.sessionId;
      const engineFiles = fs.readdirSync(path.join(home, 'runs', sid, 'engine'));
      assert.ok(engineFiles.some((f) => f.endsWith('.stream.jsonl')), engineFiles.join(','));
      const calls = readLines(path.join(home, 'runs', sid, 'calls.jsonl'));
      assert.equal(calls.length, 2);
      assert.equal(calls[0].phase, 'probe');
      assert.equal(calls[0].toolCalls[0].result, 'hello probe\n');
      // Run usage still parsed from the stream's result event.
      const turns = readLines(path.join(home, 'runs', sid, 'turns.jsonl'));
      assert.equal(turns[0].usage.inputTokens, 6506);
      assert.equal(turns[0].reply, 'hello probe');
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('aflt making-of writes a self-contained page with calls, commits and artifacts', () => {
    seedLoop();
    const out = path.join(home, 'out', 'demo.html');
    const dataOut = path.join(home, 'out', 'demo.json');
    const r = spawnSync(process.execPath, [afJs, 'making-of', 'demo', '--out', out, '--data', dataOut, '--build-url', 'http://127.0.0.1:9999/', '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.calls, 7);
    assert.ok(Math.abs(summary.credits - COPILOT_M1_CREDITS) < 1e-6);
    assert.equal(summary.costBasis, 'recorded by Copilot');
    assert.equal(summary.commits, 2);
    assert.equal(summary.seeds, 3);
    assert.equal(summary.prs, 0);
    const html = fs.readFileSync(out, 'utf8');
    assert.ok(!html.includes('/*__MAKING_OF_DATA__*/'));
    assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(html), 'no external styles');
    const data = JSON.parse(fs.readFileSync(dataOut, 'utf8'));
    assert.equal(data.phases.length, 2, 'script phase listed with no AI call');
    const m0 = data.phases.find((p) => p.phase === 'm0');
    assert.equal(m0.type, 'script');
    assert.equal(m0.totals.calls, 0);
    const c1 = data.commits.find((c) => /phase m1/.test(c.subject));
    assert.equal(c1.phase, 'm1');
    assert.equal(c1.attribution, 'aflt phase commit');
    assert.match(c1.diff, /src\/rng\.js/);
    assert.equal(data.commits[0].phase, 'm0');
    assert.equal(data.artifacts.build.url, 'http://127.0.0.1:9999/');
    assert.deepEqual(data.artifacts.seeds.map((a) => a.label).sort(), ['m0-seed/package.json', 'm0-seed/src/main.js', 'seed-m0.js']);
    assert.ok(data.artifacts.evalReports.some((a) => a.label === 'eval/history.jsonl'));
    assert.match(data.prsNote, /no remote/);
    // Usage summary recomputed without the double count.
    assert.equal(data.totals.aflt.premiumRequests, 7);
    // Default output path is inside the loop folder.
    const r2 = spawnSync(process.execPath, [afJs, 'making-of', 'demo', '--no-diffs'], { encoding: 'utf8', env: { ...process.env }, timeout: 30000 });
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(fs.existsSync(path.join(home, 'loops', 'demo', 'making-of.html')));
    assert.match(r2.stdout, /7 AI calls/);
    // Unknown loop fails clearly.
    const bad = spawnSync(process.execPath, [afJs, 'making-of', 'nope', '--json'], { encoding: 'utf8', env: { ...process.env }, timeout: 30000 });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout, /no loop state/);
  });

  it('--with-files exports every commit diff and artifact for static hosting', () => {
    seedLoop();
    const out = path.join(home, 'hub', 'demo.html');
    const dataOut = path.join(home, 'hub', 'demo.json');
    const r = spawnSync(process.execPath, [afJs, 'making-of', 'demo', '--out', out, '--data', dataOut, '--with-files', '--json'], {
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.files.diffs, 2);
    const data = JSON.parse(fs.readFileSync(dataOut, 'utf8'));
    const filesDir = path.join(home, 'hub', 'demo-files');
    for (const c of data.commits) {
      const href = data.links.diffMap[c.sha];
      assert.ok(href && href.startsWith('demo-files/commit/'), `diff link for ${c.short}`);
      assert.match(fs.readFileSync(path.join(home, 'hub', decodeURIComponent(href)), 'utf8'), new RegExp(c.sha));
    }
    for (const a of data.artifacts.seeds) assert.ok(data.links.fileMap[a.path], `seed ${a.label} linked`);
    for (const f of data.repo.finalTree) assert.ok(data.links.fileMap[path.join(data.repo.path, f)], `tracked ${f} linked`);
    assert.ok(fs.existsSync(path.join(filesDir, 'repo', 'src', 'rng.js.html')));
    assert.equal(data.links.diffBase, undefined);
    const html = fs.readFileSync(out, 'utf8');
    assert.match(html, /demo-files\/commit\//);
  });

  it('dashboard serves /making-of/<loop>, commit diffs and artifacts only', async () => {
    seedLoop();
    const dash = require('../lib/dashboard');
    const handle = dash.createDashboardServer({ collect: () => dash.aggregateDashboard({ sessions: [] }) });
    handle.server.listen(0, '127.0.0.1');
    await new Promise((resolve) => handle.server.once('listening', resolve));
    const port = handle.server.address().port;
    const get = (p) =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: p }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
          })
          .on('error', reject);
      });
    try {
      const idx = await get('/making-of');
      assert.equal(idx.status, 200);
      assert.match(idx.body, /\/making-of\/demo/);
      const page = await get('/making-of/demo');
      assert.equal(page.status, 200);
      assert.match(page.type, /text\/html/);
      assert.match(page.body, /making-of-data/);
      const json = JSON.parse((await get('/making-of/demo.json')).body);
      assert.equal(json.links.diffBase, '/making-of/demo/commit/');
      const sha = json.commits[1].sha;
      const diff = await get(`/making-of/demo/commit/${sha}`);
      assert.equal(diff.status, 200);
      assert.match(diff.body, /src\/rng\.js/);
      assert.equal((await get('/making-of/demo/commit/0123456789abcdef')).status, 404);
      const seed = json.artifacts.seeds.find((a) => a.label === 'seed-m0.js');
      const file = await get(`/making-of/demo/file?path=${encodeURIComponent(seed.path)}`);
      assert.equal(file.status, 200);
      assert.match(file.body, /seed/);
      assert.equal((await get(`/making-of/demo/file?path=${encodeURIComponent('/etc/hosts')}`)).status, 404);
      assert.equal((await get('/making-of/missing')).status, 404);
    } finally {
      await handle.close();
    }
  });
});
