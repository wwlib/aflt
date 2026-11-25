'use strict';

/**
 * Loops view usage: Copilot credits / dollars from per-call records, and a
 * read-time recompute (no state rewrite) for loops recorded before the
 * double-count fix.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'making-of');
const CHAT = '6f068464-180d-4847-bb5f-9eae8cdd2bb8';
const CREDITS = 20.23259; // fixture: 7 calls of Copilot Claude Sonnet 5.5 m1

function clearMods() {
  for (const m of ['../lib/util', '../lib/usage', '../lib/copilot', '../lib/turns', '../lib/loop', '../lib/registry', '../lib/config', '../lib/making-of']) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-credits-home-'));
  const prev = { HOME: process.env.HOME, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME, AFLT_SPACE: process.env.AFLT_SPACE };
  process.env.HOME = home;
  process.env.AGENTFLEET_HOME = home;
  delete process.env.AFLT_SPACE;
  clearMods();
  try {
    return fn(home);
  } finally {
    clearMods();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const TURN_USAGE = {
  v: 1, accuracy: 'reported', source: 'copilot-usage-record', cli: 'copilot', model: 'claude-sonnet-5.5',
  inputTokens: 30, cacheRead: 600000, cacheWrite: 40000, totalInput: 640030, outputTokens: 20000,
  reasoningTokens: 2000, totalTokens: 660030, promptToResponse: 32, cost: null, premiumRequests: 7,
};

/** A Copilot phase session recorded before credits: events turn + headless-run turn (same work). */
function seedCopilotSession(home, id) {
  const dir = path.join(home, 'runs', id);
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true });
  const base = { v: 1, sessionId: id, chatId: CHAT, engine: 'copilot', prompt: 'p', reply: 'r', redacted: true };
  const turns = [
    { ...base, turnId: 'ev-1', at: '2026-11-24T03:17:01.000Z', source: 'copilot-events', engineEventId: 'ev-1', usage: TURN_USAGE },
    { ...base, turnId: `loop:${id}:1`, at: '2026-11-24T03:14:40.000Z', source: 'headless-run', engineEventId: `loop:${id}:1`, usage: TURN_USAGE },
  ];
  fs.writeFileSync(path.join(dir, 'turns.jsonl'), turns.map((t) => JSON.stringify(t)).join('\n') + '\n');
  fs.copyFileSync(path.join(FIX, 'copilot-events.jsonl'), path.join(dir, 'engine', `copilot-${CHAT}.events.jsonl`));
  return dir;
}

function seedLoopState(home, name, sessionId, storedUsage) {
  const dir = path.join(home, 'loops', name);
  fs.mkdirSync(dir, { recursive: true });
  const state = {
    version: 1, name, status: 'completed', active: false,
    definition: { name, cwd: home, engine: 'copilot', phases: [{ id: 'm1', engine: 'copilot', prompt: 'x', eval: { command: ['true'] } }] },
    phaseIndex: 1, phaseId: 'm1', attempt: 0, step: 'run', runsUsed: 1,
    startedAt: '2026-11-24T03:10:00.000Z', updatedAt: '2026-11-24T03:20:00.000Z', completedAt: '2026-11-24T03:20:00.000Z',
    phases: { m1: { id: 'm1', status: 'passed', attempts: 0, sessionId, engine: 'copilot' } },
    history: [], usage: storedUsage,
  };
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

describe('loop usage credits in the Loops view', () => {
  it('sessionCostTotals reads per-call credits read-only and caches them', () => {
    withHome((home) => {
      const dir = seedCopilotSession(home, 'demo-m1');
      const mo = require('../lib/making-of');
      const t = mo.sessionCostTotals('demo-m1');
      assert.equal(t.calls, 7);
      assert.equal(t.callsWithCost, 7);
      assert.ok(Math.abs(t.credits - CREDITS) < 1e-6, String(t.credits));
      assert.ok(Math.abs(t.usd - CREDITS * 0.01) < 1e-9);
      assert.equal(t.costBasis, 'copilot-nano-aiu');
      assert.equal(fs.existsSync(path.join(dir, 'calls.jsonl')), false, 'never writes calls.jsonl');
      assert.equal(mo.sessionCostTotals('demo-m1'), t, 'cached while sources are unchanged');
      assert.equal(mo.sessionCostTotals('../etc'), null);
      assert.equal(mo.sessionCostTotals('missing-session'), null);
    });
  });

  it('loop status recomputes double-counted totals and adds credits without rewriting state', () => {
    withHome((home) => {
      seedCopilotSession(home, 'demo-m1');
      const doubled = { ...TURN_USAGE, totalTokens: 2 * TURN_USAGE.totalTokens, turnCount: 2, premiumRequests: 14 };
      const stateFile = seedLoopState(home, 'demo', 'demo-m1', doubled);
      const before = fs.readFileSync(stateFile, 'utf8');
      const loop = require('../lib/loop');
      const r = loop.statusReport('demo');
      assert.equal(r.ok, true, r.error);
      assert.equal(r.usage.totalTokens, TURN_USAGE.totalTokens, 'de-duplicated at read time');
      assert.equal(r.usage.storedTotalTokens, 2 * TURN_USAGE.totalTokens);
      assert.equal(r.usage.recomputed, true);
      assert.ok(Math.abs(r.usage.credits - CREDITS) < 1e-6);
      assert.ok(Math.abs(r.usage.usd - CREDITS * 0.01) < 1e-9);
      assert.equal(r.usage.creditsSource, 'per-call');
      assert.equal(r.usage.calls, 7);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'state.json untouched');
      // List rows carry the same usage.
      const all = loop.statusReport(null);
      const row = all.loops.find((l) => l.name === 'demo');
      assert.ok(row && Math.abs(row.usage.credits - CREDITS) < 1e-6);
    });
  });

  it('Cursor loops keep cost unknown (no credits invented)', () => {
    withHome((home) => {
      const id = 'cur-m1';
      const dir = path.join(home, 'runs', id);
      fs.mkdirSync(dir, { recursive: true });
      const u = { v: 1, accuracy: 'reported', cli: 'cursor', model: 'composer-2.5', totalInput: 1000, outputTokens: 100, totalTokens: 1100 };
      fs.writeFileSync(path.join(dir, 'turns.jsonl'), JSON.stringify({ v: 1, turnId: 't', at: '2026-11-24T03:17:01.000Z', sessionId: id, engine: 'cursor', source: 'headless-run', usage: u }) + '\n');
      seedLoopState(home, 'cur', id, null);
      const loop = require('../lib/loop');
      const r = loop.statusReport('cur');
      assert.equal(r.usage.totalTokens, 1100);
      assert.equal(r.usage.credits == null, true);
      const ui = require('../templates/dashboard/dashboard.js');
      assert.match(ui.formatLoopUsage(r.usage), /cost unknown/);
    });
  });
});

describe('Loops UI usage formatting', () => {
  const ui = require('../templates/dashboard/dashboard.js');
  const usage = {
    totalTokens: 6123738, turnCount: 9, accuracy: 'reported', credits: 278.84226, usd: 2.7884226,
    costBasis: 'copilot-nano-aiu', creditsSource: 'per-call', calls: 104, callsWithCost: 104,
    storedTotalTokens: 10438305, recomputed: true,
  };

  it('formatLoopUsage shows credits and dollars instead of cost unknown', () => {
    const s = ui.formatLoopUsage(usage);
    assert.match(s, /6\.1m tok/);
    assert.match(s, /278\.8 credits · \$2\.79/);
    assert.doesNotMatch(s, /cost unknown/);
    assert.equal(ui.formatUsageCost({ credits: 3.456, usd: 0.03456 }), '3.46 credits · $0.03');
    assert.equal(ui.formatUsageCost({ cost: 0.5 }), '$0.5000');
    assert.equal(ui.formatUsageCost({ totalTokens: 5 }), '');
  });

  it('loop rows (tiles) show tokens and credits', () => {
    const html = ui.renderLoopsListHtml([{ name: 'hello-aflt', status: 'failed', usage, budget: { runsUsed: 9 } }]);
    assert.match(html, /6\.1m tok · 278\.8 credits · \$2\.79/);
    const cursorRow = ui.renderLoopsListHtml([{ name: 'c', status: 'completed', usage: { totalTokens: 9468307 } }]);
    assert.match(cursorRow, /9\.5m tok/);
    assert.doesNotMatch(cursorRow, /credits/);
  });

  it('detail shows a note when totals were recomputed from per-call records', () => {
    const html = ui.renderLoopDetailHtml({ name: 'hello-aflt', status: 'failed', usage, pipeline: [] });
    assert.match(html, /278\.8 credits · \$2\.79/);
    assert.match(html, /loops-usage-note/);
    assert.match(html, /stored rollup said 10,438,305 tok/);
    assert.match(html, /104 of 104 per-call usage records/);
    const plain = ui.renderLoopDetailHtml({ name: 'x', status: 'completed', usage: { totalTokens: 5 }, pipeline: [] });
    assert.doesNotMatch(plain, /loops-usage-note/);
  });
});
