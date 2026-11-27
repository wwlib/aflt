'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const loop = require('../lib/loop');

describe('budget.maxTokens', () => {
  it('normalizes optional maxTokens', () => {
    const b = loop._test.normalizeBudget({ maxRuns: 5, maxHours: 1, maxTokens: 1000 });
    assert.equal(b.maxTokens, 1000);
    assert.equal(loop._test.normalizeBudget({ maxTokens: 0 }).maxTokens, null);
  });

  it('fails loop when token usage meets cap', () => {
    const state = {
      definition: { budget: { maxTokens: 500 } },
      runsUsed: 0,
      startedAt: new Date().toISOString(),
      runSegmentStartedAt: new Date().toISOString(),
      usage: { totalTokens: 600, accuracy: 'reported' },
    };
    assert.match(loop._test.budgetExceeded(state), /maxTokens exceeded/);
  });

  it('skips maxTokens enforcement when usage unknown', () => {
    const state = {
      definition: { budget: { maxTokens: 500 } },
      runsUsed: 0,
      startedAt: new Date().toISOString(),
      runSegmentStartedAt: new Date().toISOString(),
      usage: null,
    };
    assert.equal(loop._test.budgetExceeded(state), null);
  });

  it('budgetSnapshot exposes maxTokens and tokensUsed', () => {
    const state = {
      definition: { budget: { maxTokens: 9000 } },
      runsUsed: 1,
      startedAt: new Date().toISOString(),
      usage: { totalTokens: 42 },
    };
    const snap = loop._test.budgetSnapshot(state);
    assert.equal(snap.maxTokens, 9000);
    assert.equal(snap.tokensUsed, 42);
  });
});