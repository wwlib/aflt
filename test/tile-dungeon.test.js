'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const td = require('../scripts/eval/tile-dungeon');

describe('tile-dungeon stats', () => {
  it('mean median stdDev', () => {
    assert.equal(td.mean([10, 20, 30]), 20);
    assert.equal(td.median([10, 20, 30]), 20);
    assert.equal(td.median([10, 30]), 20);
    const sd = td.stdDev([94, 96]);
    assert.ok(Math.abs(sd - Math.SQRT2) < 0.001);
    assert.equal(td.stdDev([42]), 0);
  });

  it('--dry-run prints plan without spawning', async () => {
    const r = await td.runTileDungeon({
      dryRun: true,
      trials: 3,
      candidate: process.cwd(),
      argv: ['--dry-run', '--trials', '3'],
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.plan.trials, 3);
    assert.ok(r.plan.loopDef.includes('hello-aflt.json'));
  });

  it('aggregates fake trial results', async () => {
    const r = await td.runTileDungeon({
      deps: {
        fakeTrials: (n) =>
          Array.from({ length: n }, (_, i) => ({
            ok: true,
            overall: 90 + i,
            dashboard: { ok: true, routes: [], snapshot: null },
          })),
      },
      trials: 2,
    });
    assert.equal(r.ok, true);
    assert.equal(r.trials.length, 2);
    assert.equal(r.mean, 90.5);
    assert.equal(r.median, 90.5);
    assert.ok(r.stdDev > 0);
  });
});