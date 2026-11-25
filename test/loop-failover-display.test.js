'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('nested eval env + failover display', () => {
  it('stripNotifyEnv removes every AFLT_NOTIFY_* key and keeps the rest', () => {
    const notify = require('../lib/notify');
    const env = {
      AFLT_NOTIFY_URL: 'http://x/hook',
      AFLT_NOTIFY_KEY: 'k',
      AFLT_NOTIFY_HEADER: 'X-Key',
      AFLT_SPACE: 'self-eval-abc-t2',
      PATH: '/bin',
    };
    assert.equal(notify.stripNotifyEnv(env), env);
    assert.deepEqual(env, { AFLT_SPACE: 'self-eval-abc-t2', PATH: '/bin' });
    assert.equal(notify.stripNotifyEnv(null), null);
  });

  it('loop summary engine follows the current phase after an engines failover', () => {
    const loop = require('../lib/loop');
    const state = {
      phaseId: 'build',
      definition: {
        name: 'x',
        engine: null,
        engines: ['copilot', 'cursor'],
        phases: [{ id: 'build', engine: 'copilot', model: null }],
      },
      phases: { build: { engine: 'cursor' } },
    };
    assert.equal(loop.resolveLoopEngineModel(state, {}).engine, 'cursor');
    state.phases.build = {};
    assert.equal(loop.resolveLoopEngineModel(state, {}).engine, 'copilot');
  });
});
