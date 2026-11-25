'use strict';

const fs = require('fs');
const path = require('path');
const { homeDir } = require('./util');

const MOD_NAME = 'af-sessions';
const LAYOUT_NAME = 'af.json';

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function defaultSources(root = repoRoot()) {
  return {
    mod: path.join(root, 'herdr', 'mods', MOD_NAME),
    layout: path.join(root, 'herdr', 'layouts', LAYOUT_NAME),
  };
}

function resolveAppHome(env = process.env) {
  if (env && env.HERDR_APP_HOME && String(env.HERDR_APP_HOME).trim()) {
    return path.resolve(String(env.HERDR_APP_HOME));
  }
  return path.join(homeDir(), '.config', 'herdr-app');
}

function destinations(home) {
  return {
    mod: path.join(home, 'mods', MOD_NAME),
    layout: path.join(home, 'layouts', LAYOUT_NAME),
  };
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function readLink(p) {
  try {
    return fs.readlinkSync(p);
  } catch (_) {
    return null;
  }
}

function resolveSymlinkTarget(dest) {
  const raw = readLink(dest);
  if (raw == null) return null;
  return path.resolve(path.dirname(dest), raw);
}

function sameResolved(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch (_) {
    return path.resolve(a) === path.resolve(b);
  }
}

function isSymlinkTo(dest, src) {
  if (!exists(dest)) return false;
  try {
    if (!fs.lstatSync(dest).isSymbolicLink()) return false;
    const target = resolveSymlinkTarget(dest);
    return target != null && sameResolved(target, src);
  } catch (_) {
    return false;
  }
}

function isCopiedMatch(dest, src) {
  if (!exists(dest) || !exists(src)) return false;
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink()) return false;
    if (st.isDirectory()) {
      // mod.json, main.js, plus every other top-level .js module (afspace.js, …).
      const files = ['mod.json', 'main.js'];
      for (const name of fs.readdirSync(src)) {
        if (name.endsWith('.js') && !files.includes(name)) files.push(name);
      }
      return files.every((f) => {
        const a = path.join(src, f);
        const b = path.join(dest, f);
        if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
        return fs.readFileSync(a).equals(fs.readFileSync(b));
      });
    }
    return fs.readFileSync(src).equals(fs.readFileSync(dest));
  } catch (_) {
    return false;
  }
}

function classifyItem(kind, src, dest) {
  if (!exists(dest)) {
    return { kind, state: 'missing', dest, src, detail: null };
  }
  if (isSymlinkTo(dest, src)) {
    return { kind, state: 'linked', dest, src, detail: readLink(dest) };
  }
  if (isCopiedMatch(dest, src)) {
    return { kind, state: 'copied', dest, src, detail: null };
  }
  let detail = 'exists (different)';
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink()) detail = `symlink → ${readLink(dest)}`;
    else if (st.isDirectory()) detail = 'directory (different)';
    else detail = 'file (different)';
  } catch (_) {
    /* ignore */
  }
  return { kind, state: 'other', dest, src, detail };
}

function bakPath(dest) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let candidate = `${dest}.bak-${stamp}`;
  let n = 2;
  while (exists(candidate)) {
    candidate = `${dest}.bak-${stamp}-${n}`;
    n++;
  }
  return candidate;
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function removePath(dest) {
  const st = fs.lstatSync(dest);
  if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(dest);
  else fs.rmSync(dest, { recursive: true, force: true });
}

/**
 * Report linked/copied/missing for the af-sessions mod and af layout.
 */
function status(opts = {}) {
  const home = opts.home || resolveAppHome(opts.env || process.env);
  const sources = opts.sources || defaultSources(opts.root || repoRoot());
  const dests = destinations(home);
  const items = [
    classifyItem('mod', sources.mod, dests.mod),
    classifyItem('layout', sources.layout, dests.layout),
  ];
  return { home, items, sources, destinations: dests };
}

/**
 * Install the repo's herdr/mods/af-sessions and herdr/layouts/af.json into
 * the Herdr app home. Default: symlink. --copy copies. Never overwrite a
 * different existing path unless --force (then move aside to .bak-<ts>).
 * Idempotent when already correctly linked/copied for the chosen mode.
 */
function install(opts = {}) {
  const copy = Boolean(opts.copy);
  const force = Boolean(opts.force);
  const dryRun = Boolean(opts.dryRun || opts['dry-run']);
  const home = opts.home || resolveAppHome(opts.env || process.env);
  const sources = opts.sources || defaultSources(opts.root || repoRoot());
  const dests = destinations(home);
  const actions = [];

  if (!exists(sources.mod)) {
    return { ok: false, dryRun, home, actions, error: `source mod missing: ${sources.mod}` };
  }
  if (!exists(sources.layout)) {
    return { ok: false, dryRun, home, actions, error: `source layout missing: ${sources.layout}` };
  }

  const installOne = (kind, src, dest) => {
    const wantLinked = !copy;
    if (wantLinked && isSymlinkTo(dest, src)) {
      actions.push({ kind, action: 'ok', dest, detail: 'already linked' });
      return true;
    }
    if (copy && isCopiedMatch(dest, src)) {
      actions.push({ kind, action: 'ok', dest, detail: 'already copied' });
      return true;
    }

    if (exists(dest)) {
      const ours =
        isSymlinkTo(dest, src) ||
        isCopiedMatch(dest, src);
      if (!ours) {
        if (!force) {
          const cur = classifyItem(kind, src, dest);
          actions.push({
            kind,
            action: 'skip',
            dest,
            detail: `${cur.detail || 'exists'}; pass --force to replace`,
          });
          return false;
        }
        const bak = bakPath(dest);
        actions.push({ kind, action: 'backup', dest, detail: bak });
        if (!dryRun) fs.renameSync(dest, bak);
      } else if (!dryRun) {
        // Switching modes (link ↔ copy) on our own install.
        removePath(dest);
      } else {
        actions.push({
          kind,
          action: copy ? 'would-replace-with-copy' : 'would-replace-with-link',
          dest,
          detail: src,
        });
        return true;
      }
    }

    if (copy) {
      actions.push({ kind, action: dryRun ? 'would-copy' : 'copy', dest, detail: src });
      if (!dryRun) copyRecursive(src, dest);
    } else {
      actions.push({ kind, action: dryRun ? 'would-link' : 'link', dest, detail: src });
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.symlinkSync(src, dest);
      }
    }
    return true;
  };

  const modOk = installOne('mod', sources.mod, dests.mod);
  const layoutOk = installOne('layout', sources.layout, dests.layout);
  const ok = modOk && layoutOk;
  return {
    ok,
    dryRun,
    home,
    actions,
    error: ok ? null : 'refusing to overwrite without --force',
  };
}

module.exports = {
  MOD_NAME,
  LAYOUT_NAME,
  repoRoot,
  defaultSources,
  resolveAppHome,
  destinations,
  status,
  install,
  isSymlinkTo,
  isCopiedMatch,
  bakPath,
};
