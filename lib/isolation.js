'use strict';

/**
 * Isolation checks for a from-scratch project (`aflt init`, `aflt loop init`).
 *
 * The engines (Cursor CLI, Copilot CLI) can pick up context from outside the
 * project folder: instruction files in a parent repo or parent folder, global
 * instruction files in the user's home, and the shared results/ folder of the
 * aflt space (passed with --add-dir). These checks list what could leak in so
 * a from-scratch run starts from the project docs only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Files in a folder that Cursor or Copilot may load as instructions. */
const INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  path.join('.cursor', 'rules'),
  path.join('.github', 'copilot-instructions.md'),
  path.join('.github', 'instructions'),
];

/** Entries `aflt init` accepts in an existing folder without --force/--existing. */
const SEED_ENTRIES = new Set([
  '.git',
  '.gitignore',
  '.agentfleet',
  '.agentfleet.json',
  '.DS_Store',
  'SPEC.md',
  'AGENTS.md',
  'README.md',
]);

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function realDir(dir) {
  try {
    return fs.realpathSync(dir);
  } catch (_) {
    return path.resolve(dir);
  }
}

/** Entries in dir that are not seed docs (sorted). Missing dir → []. */
function extraEntries(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return names.filter((n) => !SEED_ENTRIES.has(n)).sort();
}

/** Ancestor folders of dir, nearest first, up to the filesystem root. */
function ancestors(dir) {
  const out = [];
  let cur = path.dirname(dir);
  for (;;) {
    out.push(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

/**
 * Check what outside the project could reach the engine.
 * opts: space (name or null), spaceHome, env, home (user home; test seam),
 * memoryRepo (resolved path or null).
 * Returns { ok, dir, warnings: [{code, message, path?}] }.
 */
function checkIsolation(dirIn, opts = {}) {
  const dir = realDir(dirIn);
  const env = opts.env || process.env;
  const home = realDir(opts.home || env.HOME || os.homedir());
  const warnings = [];

  for (const anc of ancestors(dir)) {
    if (exists(path.join(anc, '.git'))) {
      warnings.push({
        code: 'parent-repo',
        path: anc,
        message: `the project is inside another git repo (${anc}); engines may read that repo's files and instructions. Use a folder outside any repo.`,
      });
    }
    for (const rel of INSTRUCTION_FILES) {
      const p = path.join(anc, rel);
      if (exists(p)) {
        warnings.push({
          code: 'parent-instructions',
          path: p,
          message: `a parent folder has ${rel} (${p}); Cursor/Copilot may load it as instructions for this project.`,
        });
      }
    }
  }

  const copilotHome = env.AGENTFLEET_COPILOT_HOME || env.COPILOT_HOME || path.join(home, '.copilot');
  const globals = [
    path.join(copilotHome, 'copilot-instructions.md'),
    path.join(copilotHome, 'instructions'),
    path.join(home, '.cursor', 'rules'),
    path.join(home, '.cursorrules'),
    path.join(home, '.claude', 'CLAUDE.md'),
  ];
  for (const p of globals) {
    if (exists(p)) {
      warnings.push({
        code: 'global-instructions',
        path: p,
        message: `global instructions at ${p} apply to every project the engine runs in.`,
      });
    }
  }

  const fleetHome = env.AGENTFLEET_HOME && String(env.AGENTFLEET_HOME).trim();
  if (fleetHome && (!opts.spaceHome || realDir(fleetHome) !== realDir(opts.spaceHome))) {
    warnings.push({
      code: 'fleet-home-override',
      path: fleetHome,
      message: opts.spaceHome
        ? `AGENTFLEET_HOME is set (${fleetHome}); it overrides the space, so sessions and loop state go there instead of ${opts.spaceHome}. Unset it (env -u AGENTFLEET_HOME) and use --space.`
        : `AGENTFLEET_HOME is set (${fleetHome}); sessions and loop state go there, not to a dedicated space. Unset it and use --space.`,
    });
  }

  if (env.AFLT_MEMORY_REPO && String(env.AFLT_MEMORY_REPO).trim()) {
    warnings.push({
      code: 'shared-memory',
      path: String(env.AFLT_MEMORY_REPO),
      message: `AFLT_MEMORY_REPO is set (${env.AFLT_MEMORY_REPO}); sessions get that shared memory repo instead of the space's own.`,
    });
  } else if (opts.memoryRepo && opts.spaceHome) {
    const mem = realDir(opts.memoryRepo);
    const sh = realDir(opts.spaceHome);
    if (mem !== sh && !mem.startsWith(sh + path.sep)) {
      warnings.push({
        code: 'shared-memory',
        path: mem,
        message: `the space's memory repo (${mem}) lives outside the space; other projects' notes may be visible.`,
      });
    }
  }

  if (!opts.space || opts.space === 'default') {
    warnings.push({
      code: 'shared-space',
      message:
        'no dedicated space: the default space shares results/ and plans/ (passed to the engine with --add-dir) with your other projects. Use `aflt init` or --space <new-name>.',
    });
  } else if (Array.isArray(opts.sessions)) {
    const others = opts.sessions.filter((s) => {
      if (!s || !s.cwd) return false;
      const c = realDir(s.cwd);
      return c !== dir && !c.startsWith(dir + path.sep);
    });
    if (others.length) {
      warnings.push({
        code: 'shared-space',
        message: `space "${opts.space}" also holds ${others.length} session(s) for other folders (e.g. ${others[0].cwd}); their results/ files are visible to this project's engine. Use a fresh space.`,
      });
    }
  }

  return { ok: warnings.length === 0, dir, warnings };
}

/** Read the sessions of a space home (never throws). */
function spaceSessions(spaceHome) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(spaceHome, 'sessions.json'), 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  INSTRUCTION_FILES,
  SEED_ENTRIES,
  extraEntries,
  ancestors,
  checkIsolation,
  spaceSessions,
};
