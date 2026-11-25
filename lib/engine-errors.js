'use strict';

/**
 * Classify headless engine output (cursor-agent / copilot / opencode) as a
 * non-retryable infrastructure error: usage/quota caps, rate limits, an
 * unavailable model, missing auth, or a missing CLI. Retrying the same prompt
 * (e.g. loop fix attempts) cannot succeed for these.
 */

const MAX_LINE = 300;
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const LABELS = {
  usage_limit: 'usage limit reached',
  rate_limit: 'rate limited',
  model_unavailable: 'model unavailable',
  auth_required: 'authentication required',
  cli_missing: 'CLI not found',
};

// Checked in priority order; each rule matches a single line.
const RULES = [
  {
    kind: 'usage_limit',
    tests: [
      /you(?:'|’)?ve (?:hit|reached|exceeded) (?:your|the|a) [^\n]*\blimit/i,
      /\busage[- ]limit\b/i,
      /\bquota (?:exceeded|exhausted|reached)\b|\bexceeded (?:your|the|current) [^\n]{0,60}\b(?:quota|limit)\b/i,
      /\bout of (?:premium )?requests\b|\bno (?:premium )?requests (?:remaining|left)\b/i,
      /\bpremium requests?\b[^\n]*\b(?:exhausted|exceeded|used up|limit reached)\b/i,
      /\binsufficient (?:credits|quota)\b|\bcredit balance is too low\b/i,
    ],
  },
  {
    kind: 'rate_limit',
    tests: [
      (line) =>
        /\brate[- ]?limit(?:ed|s)?\b/i.test(line) &&
        /\b(?:error|exceed(?:ed)?|reached|hit|429|too many|try again|retry|limited)\b/i.test(line),
      /\btoo many requests\b/i,
      (line) => /\b429\b/.test(line) && /\b(?:status|http|error|code)\b/i.test(line),
    ],
  },
  {
    kind: 'model_unavailable',
    tests: [
      /\bmodel\s+\\?["'`]?[\w.:/-]+\\?["'`]?\s+(?:is\s+)?not\s+(?:available|found|supported)\b/i,
      /\bmodel\b[^\n]{0,80}\bnot (?:available|supported) (?:for|to|on) (?:your|this) (?:account|plan|subscription)\b/i,
      /\bcannot use this model\b/i,
      /\b(?:unknown|invalid|unsupported) model\b/i,
    ],
  },
  {
    kind: 'auth_required',
    tests: [
      /\bnot (?:logged|signed)[- ]in\b/i,
      /\bplease (?:log ?in|sign ?in|authenticate)\b/i,
      /\b(?:authentication|login|sign[- ]?in) (?:is )?required\b|\bauthentication failed\b/i,
      /\b401\b[^\n]*\bunauthori[sz]ed\b|\bunauthori[sz]ed\b[^\n]*\b401\b/i,
      /\binvalid (?:api[- ]?key|credentials|token)\b|\bno authentication information found\b/i,
      /\b(?:cursor-agent|agent|copilot|opencode|gh) (?:auth )?login\b/i,
    ],
  },
  {
    kind: 'cli_missing',
    tests: [
      /\bspawn [^\n]*\bENOENT\b/i,
      /: command not found\b|\bexecutable file not found\b/i,
    ],
  },
];

function normalize(text) {
  return String(text == null ? '' : text)
    .replace(ANSI_RE, '')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n');
}

function trimLine(line, index) {
  const s = line.trim();
  if (s.length <= MAX_LINE) return s;
  const start = Math.max(0, Math.min(index - 100, s.length - MAX_LINE));
  const slice = s.slice(start, start + MAX_LINE).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + MAX_LINE < s.length ? '…' : ''}`;
}

/**
 * @param {string} text combined stdout/stderr of a failed engine run
 * @param {{engine?: string}} [opts]
 * @returns {null|{kind: string, retryable: false, line: string, message: string}}
 */
function classifyEngineError(text, opts = {}) {
  const lines = normalize(text).split('\n');
  for (const rule of RULES) {
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const test of rule.tests) {
        let index = -1;
        if (typeof test === 'function') {
          if (!test(line)) continue;
          index = 0;
        } else {
          const m = test.exec(line);
          if (!m) continue;
          index = m.index;
        }
        const shown = trimLine(line, index);
        const engine = opts.engine ? `${opts.engine} ` : '';
        return {
          kind: rule.kind,
          retryable: false,
          line: shown,
          message: `${engine}${LABELS[rule.kind]} (not retryable): ${shown}`,
        };
      }
    }
  }
  return null;
}

module.exports = { classifyEngineError, KINDS: Object.keys(LABELS) };
