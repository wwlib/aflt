'use strict';

/**
 * Loop hoursUsed / elapsed = active run time (run segments), not wall time
 * since startedAt. A completed loop resumed hours later must not count the
 * idle gap (the scratch-composer hello-aflt-scratch run showed 3.108 h for
 * ~21 min of work).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function clearMods() {
  for (const m of ['../lib/util', '../lib/config', '../lib/loop', '../lib/registry', '../lib/turns', '../lib/usage', '../lib/making-of']) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-24T16:44:36.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** Two run segments 3 h apart: 2 min (m0–m1), then 19 min (m2…plan-next). */
function resumedHistoryState() {
  return {
    status: 'completed',
    startedAt: iso(T0),
    completedAt: iso(T0 + 3 * 60 * MIN + 21 * MIN),
    definition: { budget: { maxHours: 1 }, phases: [{ id: 'm0' }, { id: 'm1' }] },
    runsUsed: 5,
    history: [
      { at: iso(T0), event: 'loop.started' },
      { at: iso(T0 + 1 * MIN), event: 'loop.phase.passed', phaseId: 'm0' },
      { at: iso(T0 + 2 * MIN), event: 'loop.completed' },
      { at: iso(T0 + 3 * 60 * MIN + 2 * MIN), event: 'loop.started' },
      { at: iso(T0 + 3 * 60 * MIN + 10 * MIN), event: 'loop.phase.passed', phaseId: 'm2' },
      { at: iso(T0 + 3 * 60 * MIN + 21 * MIN), event: 'loop.completed' },
    ],
  };
}

describe('loop active time (hoursUsed without idle gaps)', () => {
  it('legacy state: reconstructs run segments from history at read time', () => {
    clearMods();
    const loop = require('../lib/loop');
    const s = resumedHistoryState();
    const later = T0 + 24 * 60 * MIN;
    assert.equal(loop._test.activeElapsedMs(s, later), 21 * MIN);
    assert.equal(loop._test.elapsedMsOf(s, later), 21 * MIN);
    assert.equal(loop._test.wallElapsedMsOf(s, later), 3 * 60 * MIN + 21 * MIN);
    const snap = loop._test.budgetSnapshot(s, later);
    assert.equal(snap.hoursUsed, Math.round((21 / 60) * 1000) / 1000);
    // Read-only: no fields were written onto the legacy state.
    assert.equal(s.activeMs, undefined);
    assert.equal(s.runSegmentStartedAt, undefined);
  });

  it('budget maxHours is enforced on active time, not wall time', () => {
    clearMods();
    const loop = require('../lib/loop');
    const s = resumedHistoryState();
    s.status = 'running';
    s.completedAt = null;
    s.history.pop(); // the second segment is still open
    // Wall: 3h+ since startedAt; active: 2 min + (now - second start).
    const realNow = Date.now;
    try {
      Date.now = () => T0 + 3 * 60 * MIN + 32 * MIN; // 30 min into segment 2
      assert.equal(loop._test.budgetExceeded(s), null, 'maxHours 1: 32 active minutes is within budget');
      Date.now = () => T0 + 3 * 60 * MIN + 62 * MIN; // 60 min into segment 2
      assert.match(String(loop._test.budgetExceeded(s)), /maxHours exceeded \(1\.0\d\/1\)/);
    } finally {
      Date.now = realNow;
    }
  });

  it('new state accumulates activeMs per segment; idle gaps and gate waits do not count', () => {
    clearMods();
    const loop = require('../lib/loop');
    const t = loop._test;
    const s = { status: 'pending', startedAt: null, activeMs: 0, runSegmentStartedAt: null, history: [], definition: { budget: {} } };
    s.status = 'running';
    s.startedAt = iso(T0);
    t.openRunSegment(s, iso(T0));
    assert.equal(t.activeElapsedMs(s, T0 + 5 * MIN), 5 * MIN, 'open segment counts up to now');
    s.status = 'completed';
    s.completedAt = iso(T0 + 10 * MIN);
    t.closeRunSegment(s, s.completedAt);
    assert.equal(s.activeMs, 10 * MIN);
    assert.equal(s.runSegmentStartedAt, null);
    assert.equal(t.activeElapsedMs(s, T0 + 5 * 60 * MIN), 10 * MIN, 'frozen after completion');
    // Resumed 5 h later for 7 min, then waits at a gate for an hour.
    s.status = 'running';
    t.openRunSegment(s, iso(T0 + 5 * 60 * MIN));
    s.status = 'waiting';
    t.closeRunSegment(s, iso(T0 + 5 * 60 * MIN + 7 * MIN));
    assert.equal(t.activeElapsedMs(s, T0 + 6 * 60 * MIN + 7 * MIN), 17 * MIN);
    assert.equal(t.budgetSnapshot(s, T0 + 6 * 60 * MIN).hoursUsed, Math.round((17 / 60) * 1000) / 1000);
  });

  it('a segment left open by a crashed runner closes at its last update on resume', () => {
    clearMods();
    const loop = require('../lib/loop');
    const t = loop._test;
    const s = { status: 'running', startedAt: iso(T0), activeMs: 0, runSegmentStartedAt: iso(T0), updatedAt: iso(T0 + 4 * MIN), history: [], definition: {} };
    t.openRunSegment(s, iso(T0 + 2 * 60 * MIN));
    assert.equal(s.activeMs, 4 * MIN);
    assert.equal(s.runSegmentStartedAt, iso(T0 + 2 * 60 * MIN));
  });

  it('legacy state resumed: activeMs is seeded from history closed segments', () => {
    clearMods();
    const loop = require('../lib/loop');
    const t = loop._test;
    const s = resumedHistoryState();
    s.status = 'running';
    t.openRunSegment(s, iso(T0 + 30 * 60 * MIN));
    assert.equal(s.activeMs, 21 * MIN);
    assert.equal(t.activeElapsedMs(s, T0 + 30 * 60 * MIN + 3 * MIN), 24 * MIN);
  });

  it('no history and no activeMs: falls back to wall time', () => {
    clearMods();
    const loop = require('../lib/loop');
    const s = { status: 'completed', startedAt: iso(T0), completedAt: iso(T0 + 9 * MIN), definition: {} };
    assert.equal(loop._test.activeElapsedMs(s, T0 + 60 * MIN), 9 * MIN);
  });

  it('runLoop records activeMs and closes the segment on completion', async () => {
    clearMods();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-active-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-active-cwd-'));
    const prev = { HOME: process.env.HOME, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME };
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    try {
      execFileSync('git', ['init', '-q'], { cwd });
      const loop = require('../lib/loop');
      const def = {
        name: 'active-demo',
        cwd,
        engine: 'cursor',
        allow: { commit: false, merge: false, push: false },
        budget: { maxRuns: 2, maxHours: 1 },
        phases: [{ id: 'seed', type: 'script', eval: { command: ['true'], exitCode: 0 } }],
      };
      const file = path.join(cwd, 'active-demo.json');
      fs.writeFileSync(file, JSON.stringify(def));
      const result = await loop.runFromFile(file, { env: { ...process.env } });
      assert.equal(result.ok, true, result.error);
      const state = loop.loadState('active-demo');
      assert.equal(state.status, 'completed');
      assert.equal(typeof state.activeMs, 'number');
      assert.ok(state.activeMs >= 0 && state.activeMs < 60 * 1000);
      assert.equal(state.runSegmentStartedAt, null);
      const report = loop.statusReport('active-demo');
      assert.ok(report.budget.hoursUsed < 0.02);
      assert.ok(report.wallElapsedMs >= report.elapsedMs);
    } finally {
      clearMods();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
