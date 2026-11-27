'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { countUpdateChains } = require('../lib/eval-coverage');

describe('countUpdateChains', () => {
  it('counts explicit chain ids with 2+ update probes', () => {
    const probes = [
      { tier: 'updates', chain: 'trip', session: 1 },
      { tier: 'updates', chain: 'trip', session: 2 },
      { tier: 'updates', chain: 'other', session: 3 },
    ];
    assert.equal(countUpdateChains(probes), 1);
  });

  it('does not count distinct sessions without chain ids', () => {
    const probes = [
      { tier: 'updates', session: 1, after_turn: 1 },
      { tier: 'updates', session: 2, after_turn: 1 },
      { tier: 'updates', session: 3, after_turn: 1 },
    ];
    assert.equal(countUpdateChains(probes), 0);
  });

  it('counts ordered fact→correction in the same session', () => {
    const probes = [
      { tier: 'updates', session: 1, after_turn: 2, expect_any: ['March'] },
      { tier: 'updates', session: 1, after_turn: 8, forbid: ['March'], expect_any: ['October'] },
      { tier: 'updates', session: 1, after_turn: 12, forbid: ['October'], expect_any: ['spring'] },
    ];
    assert.equal(countUpdateChains(probes), 2);
  });
});