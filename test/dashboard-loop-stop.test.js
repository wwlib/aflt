'use strict';

/** Loops detail: Stop is red only while a loop can be stopped. */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../templates/dashboard/dashboard.js');

function stopButton(html) {
  const m = html.match(/<button[^>]*data-loop-action="stop"[^>]*>Stop<\/button>/);
  assert.ok(m, 'stop button rendered');
  return m[0];
}
function pauseButton(html) {
  const m = html.match(/<button[^>]*data-loop-action="pause"[^>]*>Pause<\/button>/);
  assert.ok(m, 'pause button rendered');
  return m[0];
}

describe('Loops detail Stop button state', () => {
  for (const status of ['completed', 'failed', 'stopped']) {
    it(`is neutral and disabled for a ${status} loop`, () => {
      const html = ui.renderLoopDetailHtml({ name: 'demo', status, pipeline: [] });
      const stop = stopButton(html);
      assert.doesNotMatch(stop, /\bdanger\b/);
      assert.match(stop, /class="loops-btn subtle"/);
      assert.match(stop, /\sdisabled\b/);
      assert.match(stop, new RegExp('title="Loop is ' + status + '; nothing to stop"'));
      assert.match(pauseButton(html), /\sdisabled\b/);
      // Resume / Edit / Making of stay usable.
      assert.doesNotMatch(html.match(/<button[^>]*data-loop-action="resume"[^>]*>/)[0], /disabled/);
    });
  }

  for (const status of ['running', 'pending', 'waiting', 'paused', 'needs_human']) {
    it(`stays the red, enabled action for a ${status} loop`, () => {
      const html = ui.renderLoopDetailHtml({ name: 'demo', status, pipeline: [] });
      const stop = stopButton(html);
      assert.match(stop, /class="loops-btn danger"/);
      assert.doesNotMatch(stop, /disabled/);
      assert.doesNotMatch(pauseButton(html), /disabled/);
    });
  }

  it('stays enabled while a runner is still live on a finished-looking state', () => {
    assert.equal(ui.loopIsFinished({ status: 'completed', runnerPid: 1234 }), false);
    assert.equal(ui.loopIsFinished({ status: 'stopped', schedulerRunning: true }), false);
    assert.equal(ui.loopIsFinished({ status: 'completed' }), true);
    assert.equal(ui.loopIsFinished(null), false);
  });

  it('a status change re-renders the detail pane (sync signature changes)', () => {
    const running = ui.loopSyncSignature({ name: 'demo', status: 'running', updatedAt: 'a' });
    const done = ui.loopSyncSignature({ name: 'demo', status: 'completed', updatedAt: 'a' });
    assert.notEqual(running, done);
  });
});
