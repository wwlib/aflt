#!/usr/bin/env node
'use strict';

/**
 * Improve-round eval gate for the hello-aflt-scratch loop (portable Node).
 *
 * A copy of examples/loops/hello-aflt/improve-gate.js that lives inside the
 * project (.agentfleet/checks/), so improve rounds never run a script from
 * outside the project folder. Run from the game repo root:
 *   node .agentfleet/checks/improve-gate.cjs
 *
 * Runs AFTER the worker (workers are told not to commit). Compares:
 *   previous = overall from the committed HEAD gameplay tree
 *   after    = overall from the current (uncommitted) working tree
 *
 * NEVER uses the last line of eval/history.jsonl as "previous" — that bug
 * compared a post-write history line to itself. Also never measures "before
 * and after itself" on the dirty tree (that compared 92.4→92.4 and reverted
 * a real gain that was already in the working tree).
 *
 * Exit codes:
 *   0 — improved (keep changes, --write once) OR plateau/regression
 *       (gameplay restored to HEAD; plateau.json has both scores;
 *       latest-score is not left at the discarded working-tree score)
 *       so plan-next can stop.
 *   1 — test failure or locked scorer edits (scripts/eval/eval.js,
 *       scripts/eval/scorer.js) → fix attempt.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOCKED = ['scripts/eval/eval.js', 'scripts/eval/scorer.js'];
const RESTORE = [
  'src',
  'test',
  'public',
  'scripts/eval/bot.js',
  'README.md',
  'AGENTS.md',
  'package.json',
];

function die(msg, code = 1) {
  process.stderr.write(`improve-gate: ${msg}\n`);
  process.exit(code);
}

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    shell: false,
  });
}

function parseOverall(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.overall != null && Number.isFinite(Number(obj.overall))) {
      return Number(obj.overall);
    }
  } catch (_) {
    /* fall through */
  }
  const m = raw.match(/"overall"\s*:\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function measureOverall(write) {
  const args = write
    ? ['scripts/eval/eval.js', '--json', '--write']
    : ['scripts/eval/eval.js', '--json'];
  const r = run('node', args);
  if (r.status !== 0) {
    const err = new Error(
      `eval.js failed (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 800)}`
    );
    err.exitCode = 1;
    throw err;
  }
  let overall = parseOverall(r.stdout);
  if (overall == null && write && fs.existsSync('eval/latest-score.json')) {
    try {
      overall = parseOverall(fs.readFileSync('eval/latest-score.json', 'utf8'));
    } catch (_) {
      overall = null;
    }
  }
  if (overall == null) {
    const err = new Error('eval.js produced no overall score');
    err.exitCode = 1;
    throw err;
  }
  return { overall, stdout: r.stdout };
}

function listTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (st.isDirectory()) out.push(...listTestFiles(full));
    else if (name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  let st;
  try {
    st = fs.statSync(root);
  } catch (_) {
    return [];
  }
  if (st.isFile()) return [root];
  if (!st.isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    out.push(...walkFiles(path.join(root, name)));
  }
  return out;
}

function rmRf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

/** Snapshot current gameplay files (buffers) so HEAD measure cannot lose them. */
function snapshotGameplay() {
  const files = Object.create(null);
  for (const root of RESTORE) {
    for (const rel of walkFiles(root)) {
      files[rel] = fs.readFileSync(rel);
    }
  }
  return files;
}

function trackedRestoreRoots() {
  const existing = [];
  for (const rel of RESTORE) {
    const ls = run('git', ['ls-files', '--', rel]);
    if (String(ls.stdout || '').trim()) existing.push(rel);
  }
  return existing;
}

/**
 * Restore RESTORE paths to committed HEAD for previous measurement.
 * Removes working copies first so untracked worker files do not linger.
 */
function checkoutHeadGameplay() {
  for (const rel of RESTORE) {
    rmRf(rel);
  }
  const existing = trackedRestoreRoots();
  if (existing.length) {
    const r = run('git', ['checkout', 'HEAD', '--', ...existing]);
    if (r.status !== 0) {
      die(
        `git checkout HEAD failed: ${(r.stderr || r.stdout || '').slice(0, 800)}`,
        1
      );
    }
  }
}

/** Put worker gameplay files back (exact WT snapshot). */
function applyGameplaySnapshot(files) {
  for (const rel of RESTORE) {
    rmRf(rel);
  }
  for (const [rel, blob] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, blob);
  }
}

function writeLatestScore(overall) {
  fs.mkdirSync('eval', { recursive: true });
  const out = { overall, source: 'improve-gate-head' };
  fs.writeFileSync('eval/latest-score.json', JSON.stringify(out) + '\n');
}

function main() {
  if (!fs.existsSync('package.json')) {
    die('must run from the tile-dungeon (game) repo root');
  }
  if (!fs.existsSync('.git')) {
    die('need a git repo to compare committed HEAD vs working tree');
  }

  const dirtyLocked = run('git', ['diff', '--name-only', 'HEAD', '--', ...LOCKED]);
  const lockedNames = String(dirtyLocked.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lockedNames.length) {
    die(`locked scorer files were modified: ${lockedNames.join(', ')}`, 1);
  }

  const testFiles = listTestFiles('test');
  const testArgs = testFiles.length ? ['--test', ...testFiles] : ['--test', 'test'];
  const testRun = run('node', testArgs);
  if (testRun.status !== 0) {
    die(`tests failed (exit ${testRun.status})`, 1);
  }

  // Snapshot worker (uncommitted) gameplay, measure HEAD, then put worker files back.
  // Do not read eval/history.jsonl for "previous".
  const workerSnap = snapshotGameplay();
  let before;
  try {
    checkoutHeadGameplay();
    before = measureOverall(false);
  } catch (err) {
    applyGameplaySnapshot(workerSnap);
    die(err.message || String(err), err.exitCode || 1);
  }
  applyGameplaySnapshot(workerSnap);

  fs.mkdirSync('eval', { recursive: true });
  let after;
  try {
    after = measureOverall(false);
  } catch (err) {
    die(err.message || String(err), err.exitCode || 1);
  }

  const prev = before.overall;
  const next = after.overall;
  const payload = {
    previous: prev,
    after: next,
    measuredBy: 'improve-gate',
    beforeSource: 'committed-head',
    afterSource: 'working-tree',
  };

  if (next > prev) {
    // Keep worker changes; --write once on the kept tree.
    try {
      measureOverall(true);
    } catch (err) {
      die(err.message || String(err), err.exitCode || 1);
    }
    payload.result = 'improved';
    payload.keep_changes = true;
    payload.stop = false;
    payload.overall = next;
    fs.writeFileSync('eval/plateau.json', JSON.stringify(payload, null, 2) + '\n');
    process.stdout.write(
      JSON.stringify({ overall: next, previous: prev, after: next, result: 'improved' }) + '\n'
    );
    process.stdout.write(`improve-gate: improved ${prev} -> ${next}\n`);
    process.exit(0);
  }

  payload.result = next === prev ? 'plateau' : 'regressed';
  payload.keep_changes = false;
  payload.stop = true;
  // After revert, live score matches HEAD (previous) — do not advertise the discarded WT score as overall.
  payload.overall = prev;

  checkoutHeadGameplay();

  fs.writeFileSync('eval/plateau.json', JSON.stringify(payload, null, 2) + '\n');
  // Do not leave latest-score.json at the discarded working-tree score.
  writeLatestScore(prev);

  process.stdout.write(
    JSON.stringify({
      overall: prev,
      previous: prev,
      after: next,
      result: payload.result,
    }) + '\n'
  );
  process.stdout.write(
    `improve-gate: ${payload.result} ${prev} -> ${next}; gameplay changes reverted\n`
  );
  process.exit(0);
}

main();
