'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/** True when Cursor left an unresolved `${env:NAME}` literal (treat as unset). */
function isUnresolvedEnvInterpolation(value) {
  const s = String(value == null ? '' : value).trim();
  return /^\$\{env:[^}]*\}$/.test(s);
}

/**
 * Non-empty trimmed env value, or null.
 * Empty string / whitespace / unresolved `${env:…}` literals count as unset.
 */
function envNonEmpty(env, key) {
  if (!env || key == null) return null;
  const raw = env[key];
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || isUnresolvedEnvInterpolation(s)) return null;
  return s;
}

function homeDir() {
  return (
    envNonEmpty(process.env, 'HOME') ||
    envNonEmpty(process.env, 'USERPROFILE') ||
    os.homedir()
  );
}

/** Default (no-space) fleet home: `$HOME/.agentfleet`. */
function defaultFleetDir() {
  return path.join(homeDir(), '.agentfleet');
}

/** Root for named spaces: `$HOME/.agentfleet/spaces`. */
function spacesRootDir() {
  return path.join(defaultFleetDir(), 'spaces');
}

const DEFAULT_DASHBOARD_PORT = 8787;
const DEFAULT_SERVICE_LABEL = 'dev.aflt.dashboard';

/** Module state: selected space name after applySpaceSelection (null = default). */
let _selectedSpaceName = null;

/**
 * Validate a named-space identifier.
 * Must start with [A-Za-z0-9], then only [A-Za-z0-9._-]. Rejects empty, path
 * separators, and dot-dot.
 * @returns {string} trimmed validated name
 */
function validateSpaceName(name) {
  const s = name == null ? '' : String(name).trim();
  if (!s) {
    const err = new Error('invalid space name: empty (want [A-Za-z0-9][A-Za-z0-9._-]*)');
    err.code = 'SPACE_INVALID';
    throw err;
  }
  if (s.includes('/') || s.includes('\\') || s.includes('\0')) {
    const err = new Error(`invalid space name: path separators not allowed (${JSON.stringify(s)})`);
    err.code = 'SPACE_INVALID';
    throw err;
  }
  if (s === '.' || s === '..' || s.includes('..')) {
    const err = new Error(`invalid space name: dot-dot not allowed (${JSON.stringify(s)})`);
    err.code = 'SPACE_INVALID';
    throw err;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) {
    const err = new Error(
      `invalid space name: ${JSON.stringify(s)} (want [A-Za-z0-9][A-Za-z0-9._-]*)`
    );
    err.code = 'SPACE_INVALID';
    throw err;
  }
  return s;
}

function spaceHomeDir(name, opts = {}) {
  const validated = validateSpaceName(name);
  const root = opts.spacesRoot || spacesRootDir();
  return path.join(root, validated);
}

function serviceLabelForSpace(spaceName) {
  if (!spaceName) return DEFAULT_SERVICE_LABEL;
  return `${DEFAULT_SERVICE_LABEL}.${spaceName}`;
}

function plistBasenameForSpace(spaceName) {
  return `${serviceLabelForSpace(spaceName)}.plist`;
}

/**
 * Strip global `--space NAME` / `--space=NAME` from argv (any position).
 * @returns {{ argv: string[], space: string|null, sawSpace: boolean, missingValue: boolean }}
 */
function stripSpaceFlag(argv) {
  const out = [];
  let space = null;
  let sawSpace = false;
  let missingValue = false;
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--space') {
      sawSpace = true;
      const next = list[i + 1];
      if (next != null && next !== '' && !String(next).startsWith('-')) {
        space = String(next);
        i++;
      } else {
        space = '';
        missingValue = true;
      }
      continue;
    }
    if (typeof a === 'string' && a.startsWith('--space=')) {
      sawSpace = true;
      space = a.slice('--space='.length);
      if (space === '') missingValue = true;
      continue;
    }
    out.push(a);
  }
  return { argv: out, space, sawSpace, missingValue };
}

/**
 * Apply --space / AFLT_SPACE before fleetDir() or config load.
 * Flag wins over env. Explicit AGENTFLEET_HOME is never rewritten; space name
 * may still be tracked for display.
 *
 * @param {{ spaceFlag?: string|null, sawSpace?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ space: string|null, home: string, homeExplicit: boolean, warning?: string }}
 */
function applySpaceSelection(opts = {}) {
  const env = opts.env || process.env;
  const fromEnv = envNonEmpty(env, 'AFLT_SPACE');
  let name = null;

  if (opts.sawSpace) {
    // Flag present (even if empty → validate will fail).
    name = opts.spaceFlag == null ? '' : String(opts.spaceFlag);
    name = validateSpaceName(name);
  } else if (fromEnv) {
    name = validateSpaceName(fromEnv);
  } else {
    _selectedSpaceName = null;
    return {
      space: null,
      home: envNonEmpty(env, 'AGENTFLEET_HOME') || defaultFleetDir(),
      homeExplicit: Boolean(envNonEmpty(env, 'AGENTFLEET_HOME')),
    };
  }

  _selectedSpaceName = name;
  // Track for child processes / LaunchAgent / display.
  env.AFLT_SPACE = name;

  const homeExplicit = Boolean(envNonEmpty(env, 'AGENTFLEET_HOME'));
  let warning = null;
  if (!homeExplicit) {
    env.AGENTFLEET_HOME = spaceHomeDir(name);
  } else {
    const explicitHome = envNonEmpty(env, 'AGENTFLEET_HOME');
    const expectedHome = spaceHomeDir(name);
    if (explicitHome && path.resolve(explicitHome) !== path.resolve(expectedHome)) {
      warning =
        `AFLT_SPACE=${name} is set, but AGENTFLEET_HOME is explicitly set to ${explicitHome}; ` +
        `using AGENTFLEET_HOME and keeping AFLT_SPACE only as the tracked space name`;
    }
  }
  const out = {
    space: name,
    home: envNonEmpty(env, 'AGENTFLEET_HOME') || defaultFleetDir(),
    homeExplicit,
  };
  if (warning) out.warning = warning;
  return out;
}

/** Currently selected named space, or null for the default (no-space) home. */
function currentSpaceName() {
  return _selectedSpaceName;
}

/** Test helper: clear selected space without touching env. */
function resetSpaceSelection() {
  _selectedSpaceName = null;
}

function fleetDir() {
  return envNonEmpty(process.env, 'AGENTFLEET_HOME') || defaultFleetDir();
}

function registryPath() {
  return envNonEmpty(process.env, 'AGENTFLEET_REGISTRY') || path.join(fleetDir(), 'sessions.json');
}

function nowIso() {
  return new Date().toISOString();
}

function shortId(id) {
  if (!id) return '';
  return String(id).slice(0, 8);
}

/**
 * Table display for af ids (`<slug>-<hex6>`). Prefer keeping the trailing
 * `-hex6` so siblings that share a slug prefix stay distinguishable within
 * `width` (default 16). Example: `hello-af-w1-250815` → `hello-af…-250815`.
 */
function displayId(id, width = 16) {
  const s = String(id || '');
  const w = Math.max(8, Number(width) || 16);
  if (!s) return '';
  if (s.length <= w) return s;
  const m = s.match(/-([0-9a-f]{6})$/i);
  if (m) {
    const suffix = `-${m[1]}`;
    const budget = w - suffix.length;
    if (budget <= 0) return s.slice(-w);
    const slug = s.slice(0, s.length - suffix.length);
    if (slug.length <= budget) return slug + suffix;
    if (budget === 1) return `…${suffix}`.slice(-w);
    return `${slug.slice(0, budget - 1)}…${suffix}`;
  }
  return s.slice(0, w - 1) + '…';
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

function makeId(title) {
  const slug = slugify(title);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${slug}-${suffix}`;
}

/** Expand a leading `~` / `~/…` to the user home directory. */
function expandUserPath(p) {
  const s = String(p == null ? '' : p);
  if (s === '~') return homeDir();
  if (s.startsWith('~/') || s.startsWith('~' + path.sep)) {
    return path.join(homeDir(), s.slice(2));
  }
  return s;
}

/**
 * Resolve a cwd for registration/filters: expand ~, realpath when the path
 * exists, otherwise path.resolve. Trailing separators stripped (except root).
 */
function resolveCwd(cwd) {
  const raw = expandUserPath(cwd || process.cwd());
  let resolved;
  try {
    if (fs.existsSync(raw)) {
      resolved = fs.realpathSync(raw);
    } else {
      resolved = path.resolve(raw);
    }
  } catch (_) {
    resolved = path.resolve(raw);
  }
  if (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    resolved = resolved.replace(/[/\\]+$/, '');
  }
  return resolved;
}

function gitBranch(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0) return (r.stdout || '').trim() || null;
  } catch (_) {
    /* ignore */
  }
  return null;
}

function which(cmd, env) {
  if (env && typeof env === 'object' && env.PATH != null) {
    const parts = String(env.PATH)
      .split(path.delimiter)
      .filter(Boolean);
    const ext = process.platform === 'win32' ? '.exe' : '';
    for (const dir of parts) {
      const cand = path.join(dir, `${cmd}${ext}`);
      try {
        fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      } catch (_) {
        /* try next */
      }
    }
    return null;
  }
  const opts = { encoding: 'utf8' };
  if (env && typeof env === 'object') opts.env = env;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], opts);
  if (r.status === 0) return (r.stdout || '').trim().split('\n')[0];
  return null;
}

function escapeShellArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function oscTitle(title) {
  // OSC 0 ; title BEL — widely supported (iTerm2, WezTerm, most terminals)
  return `\x1b]0;${String(title).replace(/[\x00-\x1f]/g, '')}\x07`;
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function pad(s, n) {
  s = String(s ?? '');
  if (s.length > n) return s.slice(0, n - 1) + '…';
  return s + ' '.repeat(n - s.length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  envNonEmpty,
  isUnresolvedEnvInterpolation,
  homeDir,
  defaultFleetDir,
  spacesRootDir,
  spaceHomeDir,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_SERVICE_LABEL,
  validateSpaceName,
  serviceLabelForSpace,
  plistBasenameForSpace,
  stripSpaceFlag,
  applySpaceSelection,
  currentSpaceName,
  resetSpaceSelection,
  fleetDir,
  registryPath,
  nowIso,
  shortId,
  displayId,
  slugify,
  makeId,
  expandUserPath,
  resolveCwd,
  gitBranch,
  which,
  escapeShellArg,
  oscTitle,
  parseArgs,
  pad,
  sleep,
};
