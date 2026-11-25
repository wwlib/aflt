'use strict';

/**
 * Verification stamps and commit gate for `aflt loop` onPass commit/merge.
 *
 * A loop definition may set
 *   commitGate: { mode: "off" | "observe" | "enforce", trailer?: "Verified-by", requireTiers?: [...] }
 * Phases record verification results (the phase eval plus any named tier) on
 * phaseState.verification[]; the gate turns them into git trailers and, in
 * enforce mode, refuses a commit when a required tier is not recorded ok.
 * Zero dependencies; git is invoked with argv data only.
 */

const { spawnSync } = require('child_process');

const COMMIT_GATE_MODES = new Set(['off', 'observe', 'enforce']);
const DEFAULT_TRAILER = 'Verified-by';
const LOOP_TRAILER = 'Aflt-Loop';
const EVAL_TIER = 'eval';

function normalizeCommitGate(raw, label = 'commitGate') {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label} must be an object like { "mode": "observe" }` };
  }
  const mode = raw.mode == null ? 'off' : String(raw.mode).trim().toLowerCase();
  if (!COMMIT_GATE_MODES.has(mode)) {
    return {
      ok: false,
      error: `${label}.mode must be one of: ${[...COMMIT_GATE_MODES].join(', ')} (got "${String(raw.mode)}")`,
    };
  }
  let trailer = DEFAULT_TRAILER;
  if (raw.trailer != null) {
    trailer = typeof raw.trailer === 'string' ? raw.trailer.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(trailer)) {
      return { ok: false, error: `${label}.trailer must be a git trailer token like "Verified-by"` };
    }
  }
  const requireTiers = [];
  if (raw.requireTiers != null) {
    if (!Array.isArray(raw.requireTiers)) {
      return { ok: false, error: `${label}.requireTiers must be an array of tier names` };
    }
    for (const t of raw.requireTiers) {
      const tier = typeof t === 'string' ? t.trim() : '';
      if (!tier || /[\r\n]/.test(tier)) {
        return { ok: false, error: `${label}.requireTiers entries must be non-empty single-line strings` };
      }
      if (!requireTiers.includes(tier)) requireTiers.push(tier);
    }
  }
  return { ok: true, value: { mode, trailer, requireTiers } };
}

/** The gate to apply for a definition, or null when absent / off. */
function activeGate(definition) {
  const g = definition && definition.commitGate;
  return g && g.mode && g.mode !== 'off' ? g : null;
}

function oneLine(text, max = 200) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * Parse node:test summary lines (`ℹ tests N`, `ℹ pass N`, ...). The last
 * occurrence wins because the run summary is printed at the end.
 */
function parseNodeTestCounts(text) {
  const found = {};
  const re = /^\s*ℹ\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/gm;
  let m;
  while ((m = re.exec(String(text || '')))) found[m[1]] = Number(m[2]);
  if (found.tests == null) return null;
  return {
    tests: found.tests,
    pass: found.pass != null ? found.pass : null,
    fail: found.fail != null ? found.fail : 0,
    skipped: found.skipped != null ? found.skipped : 0,
  };
}

function commandLabel(command) {
  return oneLine(Array.isArray(command) ? command.join(' ') : command, 80);
}

/** "681/681 (1 skipped)": tests that did not fail over total tests. */
function formatCounts(c) {
  let out = `${c.tests - c.fail}/${c.tests}`;
  const notes = [];
  if (c.fail > 0) notes.push(`${c.fail} failed`);
  if (c.skipped > 0) notes.push(`${c.skipped} skipped`);
  if (notes.length) out += ` (${notes.join(', ')})`;
  return out;
}

/**
 * Record (or replace, per tier) a verification result on a phase state.
 * Tier names are free-form; "eval" is reserved for the phase eval.
 */
function recordVerification(phaseState, { tier, ok, summary, ...extra } = {}) {
  const name = typeof tier === 'string' ? tier.trim() : '';
  if (!name) throw new Error('recordVerification: tier is required');
  if (!Array.isArray(phaseState.verification)) phaseState.verification = [];
  const entry = {
    tier: name,
    ok: Boolean(ok),
    summary: summary != null ? oneLine(summary) : '',
    ...extra,
    at: new Date().toISOString(),
  };
  const i = phaseState.verification.findIndex((v) => v.tier === name);
  if (i >= 0) phaseState.verification[i] = entry;
  else phaseState.verification.push(entry);
  return entry;
}

/** Record the phase eval: command, exit code, duration and node:test counts. */
function recordEvalVerification(phaseState, evalSpec, result, opts = {}) {
  const label = commandLabel(evalSpec && evalSpec.command);
  const counts = parseNodeTestCounts(`${result.stdout || ''}\n${result.stderr || ''}`);
  const ok = Boolean(opts.ok);
  let summary;
  if (counts) summary = `${label} ${formatCounts(counts)}`;
  else summary = ok ? `${label} ok` : `${label} exit ${result.code}`;
  const extra = {
    command: evalSpec ? evalSpec.command : null,
    code: result.code,
    durationMs: opts.durationMs != null ? opts.durationMs : result.durationMs != null ? result.durationMs : null,
  };
  if (counts) extra.tests = counts;
  return recordVerification(phaseState, { tier: EVAL_TIER, ok, summary, ...extra });
}

function missingTiers(gate, verification) {
  const done = new Set(
    (Array.isArray(verification) ? verification : []).filter((v) => v.ok).map((v) => v.tier)
  );
  return ((gate && gate.requireTiers) || []).filter((t) => !done.has(t));
}

function formatVerifiedBy(verification) {
  const parts = (Array.isArray(verification) ? verification : []).map((v) => {
    if (v.tier === EVAL_TIER) return v.summary || `${EVAL_TIER} ${v.ok ? 'ok' : 'failed'}`;
    if (!v.ok) return `${v.tier} FAILED${v.summary ? `: ${v.summary}` : ''}`;
    return `${v.tier} ${v.summary || 'ok'}`;
  });
  return parts.length ? parts.join('; ') : 'none';
}

function buildTrailers(gate, ctx) {
  const where = [`${ctx.loop} phase ${ctx.phaseId} attempt ${ctx.attempt}`];
  where.push(`engine ${ctx.engine || 'unknown'}`);
  if (ctx.model) where.push(`model ${ctx.model}`);
  return [
    `${gate.trailer}: ${oneLine(formatVerifiedBy(ctx.verification), 500)}`,
    `${LOOP_TRAILER}: ${oneLine(where.join(', '), 300)}`,
  ].join('\n');
}

function git(cwd, args, env, extra = {}) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: env || process.env,
    timeout: 60_000,
    ...extra,
  });
}

/** Paths still dirty per `git status --porcelain`, or null when git fails. */
function dirtyPaths(cwd, env) {
  const r = git(cwd, ['status', '--porcelain'], env);
  if (r.status !== 0) return null;
  return String(r.stdout || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter(Boolean)
    .map((l) => l.slice(3));
}

function describeDirty(paths) {
  const shown = paths.slice(0, 10).join(', ');
  return `working tree not clean after commit (${paths.length} path(s)): ${shown}${
    paths.length > 10 ? ', ...' : ''
  }`;
}

function headSha(cwd, env) {
  const r = git(cwd, ['rev-parse', 'HEAD'], env);
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}

function isMergeCommit(cwd, env) {
  const r = git(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD'], env);
  return r.status === 0 && String(r.stdout || '').trim().split(/\s+/).length > 2;
}

/** Append trailers to the message of the merge commit at HEAD. */
function amendTrailers(cwd, trailers, env) {
  const body = git(cwd, ['log', '-1', '--format=%B'], env);
  if (body.status !== 0) return { ok: false, error: (body.stderr || 'git log failed').trim() };
  const message = `${String(body.stdout || '').trimEnd()}\n\n${trailers}\n`;
  const r = git(cwd, ['commit', '--amend', '-F', '-'], env, { input: message });
  if (r.status !== 0) {
    return { ok: false, error: `${r.stderr || r.stdout || 'git commit --amend failed'}`.trim() };
  }
  return { ok: true };
}

module.exports = {
  COMMIT_GATE_MODES,
  DEFAULT_TRAILER,
  LOOP_TRAILER,
  EVAL_TIER,
  normalizeCommitGate,
  activeGate,
  parseNodeTestCounts,
  formatCounts,
  recordVerification,
  recordEvalVerification,
  missingTiers,
  formatVerifiedBy,
  buildTrailers,
  dirtyPaths,
  describeDirty,
  headSha,
  isMergeCommit,
  amendTrailers,
};
