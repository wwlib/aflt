'use strict';

/**
 * Fixture tier coverage checks for loop eval phases (before protected paths lock).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_FIXTURE = 'eval/fixtures/transcript.json';
const DEFAULT_MIN_PER_TIER = 3;
const DEFAULT_MIN_UPDATE_CHAINS = 2;

function asNonEmptyString(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

/**
 * @param {object} raw
 * @param {string} label
 */
function normalizeCoverage(raw, label) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label}: eval.coverage must be an object` };
  }

  let command = null;
  if (raw.command != null) {
    if (typeof raw.command === 'string') {
      command = raw.command.trim();
      if (!command) return { ok: false, error: `${label}: eval.coverage.command is empty` };
    } else if (Array.isArray(raw.command)) {
      if (!raw.command.length || raw.command.some((c) => typeof c !== 'string' || !String(c).trim())) {
        return { ok: false, error: `${label}: eval.coverage.command array must be non-empty strings` };
      }
      command = raw.command.map((c) => String(c));
    } else {
      return { ok: false, error: `${label}: eval.coverage.command must be a string or string array` };
    }
  }

  let tiers = null;
  if (raw.tiers != null) {
    if (!Array.isArray(raw.tiers) || !raw.tiers.length) {
      return { ok: false, error: `${label}: eval.coverage.tiers must be a non-empty array` };
    }
    tiers = raw.tiers.map((t) => String(t).trim()).filter(Boolean);
    if (!tiers.length) {
      return { ok: false, error: `${label}: eval.coverage.tiers has no valid names` };
    }
  }

  let minCasesPerTier = DEFAULT_MIN_PER_TIER;
  if (raw.minCasesPerTier != null && raw.minCasesPerTier !== '') {
    const n = Number(raw.minCasesPerTier);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return { ok: false, error: `${label}: eval.coverage.minCasesPerTier must be an integer >= 1` };
    }
    minCasesPerTier = n;
  }

  let minUpdateChains = null;
  if (raw.minUpdateChains != null && raw.minUpdateChains !== '') {
    const n = Number(raw.minUpdateChains);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return { ok: false, error: `${label}: eval.coverage.minUpdateChains must be an integer >= 1` };
    }
    minUpdateChains = n;
  }

  const fixture = raw.fixture != null ? asNonEmptyString(raw.fixture) || DEFAULT_FIXTURE : DEFAULT_FIXTURE;

  const timeoutSec =
    raw.timeoutSec != null && Number.isFinite(Number(raw.timeoutSec)) && Number(raw.timeoutSec) > 0
      ? Math.floor(Number(raw.timeoutSec))
      : 120;

  if (!command && !tiers) {
    return {
      ok: false,
      error: `${label}: eval.coverage needs coverage.command or a tiers list`,
    };
  }

  if (tiers && tiers.includes('updates') && minUpdateChains == null) {
    minUpdateChains = DEFAULT_MIN_UPDATE_CHAINS;
  }

  return {
    ok: true,
    value: {
      command,
      tiers,
      minCasesPerTier,
      minUpdateChains,
      fixture,
      timeoutSec,
    },
  };
}

function coverageActive(cov) {
  return Boolean(cov && (cov.command || (Array.isArray(cov.tiers) && cov.tiers.length)));
}

function expandUserPath(p) {
  const s = String(p || '');
  if (s.startsWith('~/')) return path.join(process.env.HOME || '', s.slice(2));
  return s;
}

function loadProbeList(fixturePath) {
  let raw;
  try {
    raw = fs.readFileSync(fixturePath, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read fixture ${fixturePath}: ${err.message}` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON in ${fixturePath}: ${err.message}` };
  }
  let probes = null;
  if (Array.isArray(data)) probes = data;
  else if (data && Array.isArray(data.probes)) probes = data.probes;
  if (!probes) {
    return { ok: false, error: `fixture ${fixturePath} has no "probes" array` };
  }
  return { ok: true, probes };
}

function countProbesByTier(probes) {
  const counts = {};
  for (const p of probes) {
    if (!p || typeof p !== 'object') continue;
    const tier = p.tier != null ? String(p.tier).trim() : '';
    if (!tier) continue;
    counts[tier] = (counts[tier] || 0) + 1;
  }
  return counts;
}

/**
 * Distinct update chains: explicit probe.chain ids, else distinct sessions among update probes.
 */
function countUpdateChains(probes) {
  const updates = probes.filter((p) => p && String(p.tier) === 'updates');
  if (!updates.length) return 0;
  const chainIds = new Set();
  for (const p of updates) {
    if (p.chain != null && String(p.chain).trim()) chainIds.add(String(p.chain).trim());
    if (p.update_chain != null && String(p.update_chain).trim()) {
      chainIds.add(String(p.update_chain).trim());
    }
  }
  if (chainIds.size) return chainIds.size;
  const sessions = new Set();
  for (const p of updates) {
    if (p.session != null) sessions.add(String(p.session));
  }
  return sessions.size;
}

function partialUpdateProbeCount(probes) {
  let n = 0;
  for (const p of probes) {
    if (!p || String(p.tier) !== 'updates') continue;
    const forbid = Array.isArray(p.forbid) ? p.forbid.filter(Boolean) : [];
    if (forbid.length >= 1) n += 1;
  }
  return n;
}

/**
 * Built-in fixture tier coverage (probe counts per tier).
 */
function checkFixtureCoverage(cov, cwd) {
  if (!cov || !Array.isArray(cov.tiers) || !cov.tiers.length) {
    return { ok: true, skipped: true };
  }
  const root = cwd || process.cwd();
  const fixturePath = path.resolve(root, expandUserPath(cov.fixture || DEFAULT_FIXTURE));
  const loaded = loadProbeList(fixturePath);
  if (!loaded.ok) return loaded;
  const counts = countProbesByTier(loaded.probes);
  const min = cov.minCasesPerTier != null ? cov.minCasesPerTier : DEFAULT_MIN_PER_TIER;
  const shortfalls = [];
  for (const tier of cov.tiers) {
    const have = counts[tier] || 0;
    if (have < min) shortfalls.push(`${tier}: ${have}/${min}`);
  }
  const extras = [];
  if (cov.tiers.includes('updates') && cov.minUpdateChains != null) {
    const chains = countUpdateChains(loaded.probes);
    if (chains < cov.minUpdateChains) {
      extras.push(`updates chains: ${chains}/${cov.minUpdateChains} (multi-step update chains)`);
    }
    const partials = partialUpdateProbeCount(loaded.probes);
    const needPartials = Math.min(2, min);
    if (partials < needPartials) {
      extras.push(`updates with forbid (partial corrections): ${partials}/${needPartials}`);
    }
  }
  if (!shortfalls.length && !extras.length) {
    return { ok: true, counts, fixture: fixturePath };
  }
  const parts = [];
  if (shortfalls.length) parts.push(`probe count below minimum: ${shortfalls.join(', ')}`);
  if (extras.length) parts.push(extras.join('; '));
  return {
    ok: false,
    counts,
    fixture: fixturePath,
    message: `fixture tier coverage failed (${fixturePath}): ${parts.join('; ')}. Add probes for every required tier before protected paths lock.`,
  };
}

function runCoverageCommand(cov, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = (cov.timeoutSec || 120) * 1000;
  const env = opts.env || process.env;
  let result;
  if (typeof cov.command === 'string') {
    result = spawnSync('sh', ['-c', cov.command], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  } else {
    result = spawnSync(cov.command[0], cov.command.slice(1), {
      cwd,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
  }
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  const code = timedOut ? 124 : result.status == null ? 1 : result.status;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (code !== 0) {
    return {
      ok: false,
      code,
      timedOut,
      message: `coverage command failed (exit ${code}): ${stderr || stdout || '(no output)'}`.trim(),
    };
  }
  return { ok: true, code: 0, stdout, stderr };
}

/**
 * @returns {{ ok: boolean, message?: string, counts?: object, skipped?: boolean }}
 */
function checkEvalCoverage(cov, opts = {}) {
  if (!coverageActive(cov)) return { ok: true, skipped: true };
  const cwd = opts.cwd || process.cwd();
  if (typeof opts.runCommand === 'function' && cov.command) {
    const custom = opts.runCommand(cov, { cwd, env: opts.env });
    if (custom && custom.ok === false) {
      return { ok: false, message: custom.message || 'coverage command failed' };
    }
  } else if (cov.command) {
    const cmd = runCoverageCommand(cov, { cwd, env: opts.env });
    if (!cmd.ok) return cmd;
  }
  if (Array.isArray(cov.tiers) && cov.tiers.length) {
    return checkFixtureCoverage(cov, cwd);
  }
  return { ok: true };
}

function protectedFixturesLockSummary(definition) {
  if (!definition || !definition.protected) return '';
  const paths = Array.isArray(definition.protected.paths)
    ? definition.protected.paths.filter(Boolean)
    : [];
  if (!paths.length) return '';
  const from = definition.protected.fromPhase
    ? String(definition.protected.fromPhase)
    : 'the eval milestone';
  return (
    `Eval fixtures and scorer paths are locked after phase "${from}" ` +
    `(${paths.join(', ')}). Fixes must be in non-protected application code only — do not edit fixtures or scripts/eval.`
  );
}

module.exports = {
  DEFAULT_FIXTURE,
  DEFAULT_MIN_PER_TIER,
  DEFAULT_MIN_UPDATE_CHAINS,
  normalizeCoverage,
  coverageActive,
  checkEvalCoverage,
  checkFixtureCoverage,
  countProbesByTier,
  countUpdateChains,
  loadProbeList,
  protectedFixturesLockSummary,
};