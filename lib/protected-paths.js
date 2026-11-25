'use strict';

/**
 * Immutable checks for `aflt loop`: protected path globs, a base-commit diff
 * guard, and a read-only base tree for eval harnesses. Zero dependencies.
 *
 * Globs are relative to the loop cwd and use `/` separators:
 *   `**`  any characters, including `/` (`a/**` = everything under a/)
 *   `**` + `/` zero or more directories (`**` + `/x.js` matches x.js and a/b/x.js)
 *   `*`   any characters except `/`; `?` one character except `/`
 * A pattern with no wildcards matches that exact path or anything below it,
 * and a trailing `/` means the directory and everything below it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROTECTED_SOURCES = new Set(['base']);

function normalizePattern(pattern) {
  let p = String(pattern).trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

function globToRegExp(pattern) {
  const p = normalizePattern(pattern);
  if (!p) throw new Error('empty glob');
  if (p.endsWith('/')) return globToRegExp(`${p}**`);
  const hasWildcard = /[*?]/.test(p);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(hasWildcard ? `^${re}$` : `^${re}(?:/.*)?$`);
}

function compileGlobs(patterns) {
  return (patterns || []).map((pattern) => ({ pattern, re: globToRegExp(pattern) }));
}

/** Returns the changed paths that match at least one protected glob. */
function matchProtected(changedPaths, patterns) {
  const compiled = compileGlobs(patterns);
  const hits = [];
  for (const file of changedPaths || []) {
    const rel = normalizePattern(file);
    if (compiled.some((g) => g.re.test(rel))) hits.push(file);
  }
  return hits;
}

/**
 * Validate a `protected` definition value: { paths: string[], source?: "base" }.
 * Returns { ok: true, value: null } when absent.
 */
function normalizeProtected(raw, label) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label}: protected must be an object like { "paths": ["scripts/eval/**"] }` };
  }
  if (!Array.isArray(raw.paths) || raw.paths.length === 0) {
    return { ok: false, error: `${label}: protected.paths must be a non-empty array of globs` };
  }
  const paths = [];
  for (const item of raw.paths) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: `${label}: protected.paths entries must be non-empty strings` };
    }
    const p = normalizePattern(item);
    if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
      return {
        ok: false,
        error: `${label}: protected path "${item}" must be relative to the loop cwd (no leading / and no ..)`,
      };
    }
    if (!paths.includes(p)) paths.push(p);
  }
  let source = 'base';
  if (raw.source != null) {
    const s = String(raw.source).trim().toLowerCase();
    if (!PROTECTED_SOURCES.has(s)) {
      return { ok: false, error: `${label}: protected.source must be "base"` };
    }
    source = s;
  }
  return { ok: true, value: { paths, source } };
}

/** Union of loop-level and phase-level protected globs. */
function effectivePatterns(definition, phase) {
  const out = [];
  for (const src of [definition && definition.protected, phase && phase.protected]) {
    for (const p of (src && src.paths) || []) if (!out.includes(p)) out.push(p);
  }
  return out;
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

function headSha(cwd) {
  const r = git(cwd, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout.trim() || null : null;
}

function splitNul(text) {
  return text.split('\0').filter(Boolean);
}

/**
 * Paths (relative to cwd) changed since baseSha: committed, staged, unstaged
 * and untracked-but-not-ignored. Renames are reported as delete + add.
 * Returns null when git cannot answer (callers must fail closed).
 */
function changedPathsSince(cwd, baseSha) {
  if (!baseSha) return null;
  const sets = [
    ['diff', '--name-only', '-z', '--no-renames', '--relative', baseSha],
    ['diff', '--name-only', '-z', '--no-renames', '--relative', '--cached', baseSha],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  const seen = new Set();
  for (const args of sets) {
    const r = git(cwd, args);
    if (!r.ok) return null;
    for (const f of splitNul(r.stdout)) seen.add(f);
  }
  return [...seen].sort();
}

/** Changed paths since baseSha that match the protected globs (null = git failed). */
function findViolations(cwd, baseSha, patterns) {
  if (!patterns || patterns.length === 0) return [];
  const changed = changedPathsSince(cwd, baseSha);
  if (changed == null) return null;
  return matchProtected(changed, patterns);
}

/**
 * Check out baseSha into a detached, throwaway git worktree so eval scripts and
 * harness files can be loaded from the base commit, never the mutable tree.
 * @returns {{ path: string, cleanup: () => void }}
 */
function materializeBaseTree(cwd, baseSha, dest) {
  if (!baseSha) throw new Error('materializeBaseTree: baseSha is required');
  let tmpRoot = null;
  let target = dest ? path.resolve(dest) : null;
  if (!target) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-base-'));
    target = path.join(tmpRoot, 'base');
  }
  const r = git(cwd, ['worktree', 'add', '--detach', target, baseSha]);
  if (!r.ok) {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw new Error(`git worktree add failed: ${r.stderr.trim() || 'unknown error'}`);
  }
  let cleaned = false;
  return {
    path: target,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      git(cwd, ['worktree', 'remove', '--force', target]);
      git(cwd, ['worktree', 'prune']);
      fs.rmSync(tmpRoot || target, { recursive: true, force: true });
    },
  };
}

module.exports = {
  globToRegExp,
  matchProtected,
  normalizeProtected,
  effectivePatterns,
  headSha,
  changedPathsSince,
  findViolations,
  materializeBaseTree,
};
