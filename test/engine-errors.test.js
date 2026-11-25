'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyEngineError } = require('../lib/engine-errors');

describe('classifyEngineError', () => {
  const positives = [
    ['usage_limit', 'cursor', "You've hit your usage limit for Other Models on the Pro plan."],
    ['usage_limit', 'cursor', 'b: You’ve hit your usage limit. Upgrade to Pro+.'],
    ['usage_limit', 'copilot', 'Error: Quota exceeded for premium requests'],
    ['usage_limit', 'copilot', 'You have exceeded your monthly premium request allowance limit'],
    ['usage_limit', 'opencode', 'You are out of premium requests'],
    ['rate_limit', 'opencode', 'Error: 429 Too Many Requests'],
    ['rate_limit', 'copilot', 'Rate limit exceeded, try again in 60s'],
    ['model_unavailable', 'copilot', 'Error: Model "gpt-9" is not available'],
    ['model_unavailable', 'cursor', 'Cannot use this model: composer-9. Available models: auto'],
    ['auth_required', 'cursor', 'Not logged in. Please log in with `cursor-agent login`.'],
    ['auth_required', 'copilot', 'Error: authentication required'],
    ['auth_required', 'opencode', 'HTTP 401 Unauthorized'],
    ['cli_missing', 'copilot', 'Error: spawn copilot ENOENT'],
    ['cli_missing', 'cursor', 'bash: cursor-agent: command not found'],
  ];
  for (const [kind, engine, text] of positives) {
    it(`${kind}: ${text.slice(0, 40)}`, () => {
      const r = classifyEngineError(`noise\n${text}\nmore noise`, { engine });
      assert.ok(r, text);
      assert.equal(r.kind, kind);
      assert.equal(r.retryable, false);
      assert.ok(r.line.includes(text.slice(2, 20)), r.line);
      assert.match(r.message, new RegExp(engine));
    });
  }

  it('finds errors inside escaped JSON event output and trims long lines', () => {
    const json = JSON.stringify({ type: 'error', message: `Model "x" is not available${' pad'.repeat(200)}` });
    const r = classifyEngineError(json, { engine: 'copilot' });
    assert.equal(r.kind, 'model_unavailable');
    assert.ok(r.line.length <= 310);
    assert.match(r.line, /Model "x" is not available/);
  });

  it('strips ANSI codes', () => {
    const r = classifyEngineError('\u001b[31mYou\'ve hit your usage limit\u001b[0m');
    assert.equal(r.kind, 'usage_limit');
    assert.doesNotMatch(r.line, /\u001b/);
  });

  const negatives = [
    '',
    null,
    '# tests 12\n# pass 10\n# fail 2\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
    'not ok 3 - parses config\n  error: expected 5 to equal 6',
    'Implemented a token-bucket rate limiter in lib/limiter.js',
    'agent exited 1',
    'Unauthorized access attempts are logged in audit.log',
    'Module not found: ./foo',
  ];
  for (const text of negatives) {
    it(`does not classify: ${String(text).slice(0, 40).replace(/\n/g, ' ')}`, () => {
      assert.equal(classifyEngineError(text, { engine: 'cursor' }), null);
    });
  }
});
