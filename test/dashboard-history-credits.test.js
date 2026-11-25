'use strict';

/**
 * History view usage: older Copilot sessions (usage-summary.json without
 * credits) show credits / $ from per-call records, read-only.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'making-of');
const CHAT = '6f068464-180d-4847-bb5f-9eae8cdd2bb8';
const CREDITS = 20.23259;

function clearMods() {
  for (const m of ['../lib/util', '../lib/usage', '../lib/copilot', '../lib/turns', '../lib/loop', '../lib/registry', '../lib/config', '../lib/making-of', '../lib/dashboard']) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hist-credits-'));
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

const SUMMARY = {
  v: 1, totalInput: 640030, inputTokens: 30, cacheRead: 600000, cacheWrite: 40000, outputTokens: 20000,
  reasoningTokens: 2000, totalTokens: 660030, promptToResponse: 32, cost: null, premiumRequests: 7,
  credits: null, usd: null, costBasis: null, turnCount: 1, reportedTurns: 1, estimatedTurns: 0, partialTurns: 0,
  accuracy: 'reported', cli: 'copilot', models: ['claude-sonnet-5.5'],
};

function seed(home, id, { engineLog = true } = {}) {
  const dir = path.join(home, 'runs', id);
  fs.mkdirSync(path.join(dir, 'engine'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'turns.jsonl'), JSON.stringify({ v: 1, turnId: 'ev', at: '2026-11-24T03:17:01.000Z', sessionId: id, chatId: CHAT, engine: 'copilot', source: 'copilot-events', usage: SUMMARY }) + '\n');
  fs.writeFileSync(path.join(dir, 'usage-summary.json'), JSON.stringify(SUMMARY, null, 2) + '\n');
  if (engineLog) fs.copyFileSync(path.join(FIX, 'copilot-events.jsonl'), path.join(dir, 'engine', `copilot-${CHAT}.events.jsonl`));
  return dir;
}

describe('History usage: Copilot credits from per-call records', () => {
  it('withPerCallCredits adds credits only when missing, read-only', () => {
    withHome((home) => {
      const dir = seed(home, 'h-m1');
      const before = fs.readFileSync(path.join(dir, 'usage-summary.json'), 'utf8');
      const mo = require('../lib/making-of');
      const out = mo.withPerCallCredits({ ...SUMMARY }, 'h-m1');
      assert.ok(Math.abs(out.credits - CREDITS) < 1e-6);
      assert.ok(Math.abs(out.usd - CREDITS * 0.01) < 1e-9);
      assert.equal(out.costBasis, 'copilot-nano-aiu');
      assert.equal(out.creditsSource, 'per-call');
      const recorded = { ...SUMMARY, credits: 5, usd: 0.05 };
      assert.equal(mo.withPerCallCredits(recorded, 'h-m1'), recorded, 'recorded credits win');
      assert.equal(mo.withPerCallCredits(null, 'h-m1'), null);
      assert.equal(fs.readFileSync(path.join(dir, 'usage-summary.json'), 'utf8'), before, 'usage-summary.json untouched');
      assert.equal(fs.existsSync(path.join(dir, 'calls.jsonl')), false);
    });
  });

  it('session nodes, project rollups and the History panel summary carry credits', () => {
    withHome((home) => {
      seed(home, 'h-m1');
      seed(home, 'h-m2');
      seed(home, 'h-none', { engineLog: false });
      const dash = require('../lib/dashboard');
      const sessions = ['h-m1', 'h-m2', 'h-none'].map((id) => ({
        id, title: id, engine: 'copilot', project: 'demo', cwd: home, status: 'done', created: '2026-11-24T03:00:00.000Z', lastUsed: '2026-11-24T03:20:00.000Z',
      }));
      const tree = dash.buildHistoryTree({ projects: [{ name: 'demo', lastActivity: '2026-11-24T03:20:00.000Z' }], sessions, nowMs: Date.parse('2026-11-24T04:00:00.000Z') });
      const flat = [];
      const walk = (nodes) => { for (const n of nodes || []) { flat.push(n); walk(n.children); } };
      walk(Array.isArray(tree) ? tree : tree.projects || tree.roots || tree.items || tree.rows);
      const node = flat.find((n) => n && n.id === 'h-m1');
      assert.ok(node && node.usage, 'session node has usage');
      assert.ok(Math.abs(node.usage.credits - CREDITS) < 1e-6);
      const none = flat.find((n) => n && n.id === 'h-none');
      assert.equal(none.usage.credits == null, true, 'no per-call source → no credits invented');
      const project = flat.find((n) => n && n.kind === 'project');
      assert.ok(project && Math.abs(project.usage.credits - 2 * CREDITS) < 1e-6, JSON.stringify(project && project.usage));

      const detail = dash.collectHistoryDetail({
        sessions, project: 'demo', memoryRepo: '', memoryProjects: [], completionsById: {}, checkpoints: [],
      });
      assert.ok(detail.usageSummary, 'History panel summary');
      assert.ok(Math.abs(detail.usageSummary.credits - 2 * CREDITS) < 1e-6, JSON.stringify(detail.usageSummary));
      const one = dash.collectHistoryDetail({
        sessions, sessionId: 'h-m2', memoryRepo: '', memoryProjects: [], completionsById: {}, checkpoints: [],
      });
      assert.ok(Math.abs(one.usageSummary.credits - CREDITS) < 1e-6);
    });
  });
});
