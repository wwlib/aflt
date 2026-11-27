'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const li = require('../lib/loop-init');

const PROMPTS = {
  'm0.md': 'Build tests and scripts/eval/eval.js mock scorer.',
  'eval.md': 'Build eval fixtures transcript.json with all tiers.',
  'm1.md': 'Build persona after human approves baseline.',
  'plan-next.md': 'Plan improve rounds.',
};

function evalProjectDraft() {
  return {
    name: 'chat-agent',
    project: 'chat-agent',
    cwd: '.',
    engine: 'cursor',
    model: 'composer-2.5',
    improveModel: 'composer-2.5',
    plannedPhaseGate: 'none',
    workdir: { mode: 'project' },
    protected: { paths: ['eval/fixtures/**', 'scripts/eval/**'], fromPhase: 'eval' },
    allow: { commit: true, merge: false, push: false },
    budget: { maxRuns: 30, maxHours: 4, maxPhases: 12 },
    phases: [
      {
        id: 'm0',
        prompt: 'Build the test harness and scripts/eval/eval.js eval scorer.',
        force: true,
        onPass: 'commit',
        eval: { command: 'npm test && node scripts/eval/eval.js --json' },
      },
      {
        id: 'eval',
        prompt: 'Build eval fixtures with eval.coverage tiers.',
        force: true,
        onPass: 'commit',
        eval: {
          command: 'npm test && node scripts/eval/eval.js --json',
          coverage: {
            tiers: ['facts', 'updates'],
            minCasesPerTier: 3,
            minUpdateChains: 2,
          },
        },
      },
      {
        id: 'm1',
        promptFile: 'prompts/m1.md',
        gate: 'approve',
        force: true,
        onPass: 'commit',
        eval: { command: 'npm test && node scripts/eval/eval.js --json' },
      },
      {
        id: 'live-eval',
        type: 'script',
        eval: {
          command: 'node scripts/eval/eval.js --json --live --write',
          minOverall: 0,
          noRegress: true,
          infraRetries: 1,
          timeoutSec: 1800,
        },
      },
      {
        id: 'plan-next',
        type: 'plan-next',
        model: 'gpt-5.3-codex',
        promptFile: 'prompts/plan-next.md',
        force: true,
        onPass: 'none',
      },
    ],
  };
}

function writePrompts(tmp) {
  const dir = path.join(tmp, '.agentfleet', 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(PROMPTS)) {
    fs.writeFileSync(path.join(dir, f), text);
  }
}

describe('loop init eval-milestone policy', () => {
  it('accepts a guide-shaped eval project draft', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-liep-'));
    try {
      writePrompts(tmp);
      const defDir = path.join(tmp, '.agentfleet');
      const r = li.checkLoopPolicy(evalProjectDraft(), { definitionDir: defDir });
      assert.deepEqual(r.errors, [], r.errors.join('; '));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('requires approve gate after eval milestone, not right after m0', () => {
    const d = evalProjectDraft();
    delete d.phases[2].gate;
    const r = li.checkLoopPolicy(d, { definitionDir: '/x' });
    assert.match(r.errors.join('\n'), /phase m1.*"gate": "approve"/);
    assert.doesNotMatch(r.errors.join('\n'), /after m0/i);
  });

  it('rejects gate on wrong phase when eval milestone exists', () => {
    const d = evalProjectDraft();
    d.phases[0].gate = 'approve';
    delete d.phases[2].gate;
    const r = li.checkLoopPolicy(d, { definitionDir: '/x' });
    assert.match(r.errors.join('\n'), /right after eval milestone/);
  });

  it('enforces protected.fromPhase and live-eval contract', () => {
    const d = evalProjectDraft();
    d.protected.fromPhase = 'm0';
    const live = d.phases.find((p) => p.id === 'live-eval');
    live.eval = {
      command: 'node scripts/eval/eval.js --json --live --write',
      passRegex: 'tiers',
      timeoutSec: 1800,
    };
    const r = li.checkLoopPolicy(d, { definitionDir: '/x' });
    assert.match(r.errors.join('\n'), /protected\.fromPhase must be "eval"/);
    assert.match(r.errors.join('\n'), /passRegex/);
    assert.match(r.errors.join('\n'), /infraRetries/);
  });

  it('loop guide section 11 example passes policy when prompts exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-liep-g-'));
    try {
      const guide = fs.readFileSync(path.join(__dirname, '..', 'templates', 'loop-guide.md'), 'utf8');
      const start = guide.indexOf('## 11. Shape');
      const block = guide.slice(start).match(/```json\n([\s\S]*?)\n```/);
      assert.ok(block, 'section 11 JSON block');
      const raw = JSON.parse(block[1].replace(/<[^>]+>/g, 'tierA'));
      const dir = path.join(tmp, '.agentfleet', 'prompts');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'm0.md'), 'Build the test harness and eval script with tests and eval.');
      fs.writeFileSync(path.join(dir, 'eval.md'), 'Build fixtures and eval scorer with coverage tiers.');
      fs.writeFileSync(path.join(dir, 'm1.md'), 'Feature milestone.');
      fs.writeFileSync(path.join(dir, 'plan-next.md'), 'Plan improve.');
      const r = li.checkLoopPolicy(raw, { definitionDir: path.join(tmp, '.agentfleet') });
      assert.deepEqual(r.errors, [], r.errors.join('; '));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});