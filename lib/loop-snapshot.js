'use strict';

/**
 * Snapshot the files a loop depends on into its state dir so a saved loop
 * never depends on files outside the project or the space.
 *
 * - promptFile: copied to <loopDir>/prompts/<phase>-<basename>; the phase gets
 *   `promptSnapshot` (the copy, used by resolvePhasePrompt) and
 *   `promptFileSource` (the original path, for display).
 * - eval.command: absolute file tokens outside the project folder (companion
 *   check scripts next to a loop JSON, e.g. examples/loops/x/m0-check.js) are
 *   copied with their folder (scripts often read siblings via __dirname) to
 *   <loopDir>/files/<folder>-<hash>/ and the token is rewritten to the copy;
 *   `eval.commandSource` keeps the original command.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_DIR_BYTES = 5 * 1024 * 1024;
const MAX_DIR_FILES = 400;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function isInside(p, root) {
  if (!p || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function safePart(s) {
  return String(s || 'x').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'x';
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/** Size/count of a folder (stops early past the caps). */
function measureDir(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (bytes > MAX_DIR_BYTES || files > MAX_DIR_FILES) return;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(path.join(d, ent.name));
      } else if (ent.isFile()) {
        files += 1;
        bytes += fs.statSync(path.join(d, ent.name)).size;
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) copyDir(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/** Absolute path tokens in an eval command that point at a file outside root. */
function outsideFileTokens(command, root) {
  const tokens = Array.isArray(command)
    ? command.map(String)
    : typeof command === 'string'
      ? command.split(/\s+/).filter(Boolean)
      : [];
  return tokens.filter((t) => path.isAbsolute(t) && isFile(t) && !isInside(t, root));
}

/**
 * Path tokens in an eval command that leave the project folder: relative
 * tokens that climb out ("../x") and absolute paths outside root that do not
 * exist. Returns [{token, resolved}].
 */
function escapingTokens(command, root) {
  if (!root) return [];
  const tokens = Array.isArray(command)
    ? command.map(String)
    : typeof command === 'string'
      ? command.split(/\s+/).filter(Boolean)
      : [];
  const out = [];
  for (const raw of tokens) {
    const t = raw.replace(/^['"]|['"]$/g, '');
    if (!t || t.startsWith('-')) continue;
    if (path.isAbsolute(t)) {
      if (!isInside(t, root) && !fs.existsSync(t) && /[\\/]/.test(t.slice(1))) out.push({ token: t, resolved: t });
      continue;
    }
    if (t === '..' || t.startsWith('../') || t.startsWith('..\\') || /(^|[\\/])\.\.([\\/]|$)/.test(t)) {
      const resolved = path.resolve(root, t);
      if (!isInside(resolved, root)) out.push({ token: t, resolved });
    }
  }
  return out;
}

/**
 * Snapshot one definition's files into loopDirAbs. Mutates the phases.
 * opts.refresh: re-copy prompts that were already snapshotted (fresh start).
 * Returns { prompts, scripts, warnings }.
 */
function snapshotLoopFiles(definition, loopDirAbs, opts = {}) {
  const res = { prompts: 0, scripts: 0, warnings: [] };
  if (!definition || !Array.isArray(definition.phases) || !loopDirAbs) return res;
  const root = definition.cwd || null;
  const copiedDirs = new Map();
  for (const phase of definition.phases) {
    if (!phase || !phase.id) continue;
    if (phase.promptFile && (opts.refresh || !phase.promptSnapshot || !isFile(phase.promptSnapshot))) {
      const src = phase.promptFileSource && isFile(phase.promptFileSource) ? phase.promptFileSource : phase.promptFile;
      if (isFile(src)) {
        const dst = path.join(loopDirAbs, 'prompts', `${safePart(phase.id)}-${safePart(path.basename(src))}`);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        phase.promptFileSource = phase.promptFileSource || phase.promptFile;
        phase.promptSnapshot = dst;
        res.prompts += 1;
      } else if (!phase.promptSnapshot) {
        res.warnings.push(`phase ${phase.id}: promptFile ${src} is missing and there is no snapshot`);
      }
    }
    const ev = phase.eval;
    if (ev && ev.command != null && root) {
      const tokens = outsideFileTokens(ev.command, root).filter((t) => !isInside(t, loopDirAbs));
      if (!tokens.length) continue;
      const map = new Map();
      for (const t of tokens) {
        const srcDir = path.dirname(t);
        let dstDir = copiedDirs.get(srcDir);
        if (!dstDir) {
          const m = measureDir(srcDir);
          if (m.bytes > MAX_DIR_BYTES || m.files > MAX_DIR_FILES) {
            res.warnings.push(
              `phase ${phase.id}: check script ${t} is outside the project and its folder is too big to snapshot; keep it in the project`
            );
            continue;
          }
          const hash = crypto.createHash('sha1').update(srcDir).digest('hex').slice(0, 8);
          dstDir = path.join(loopDirAbs, 'files', `${safePart(path.basename(srcDir))}-${hash}`);
          copyDir(srcDir, dstDir);
          copiedDirs.set(srcDir, dstDir);
          res.scripts += 1;
        }
        map.set(t, path.join(dstDir, path.basename(t)));
      }
      if (!map.size) continue;
      if (ev.commandSource == null) ev.commandSource = Array.isArray(ev.command) ? ev.command.slice() : ev.command;
      if (Array.isArray(ev.command)) ev.command = ev.command.map((t) => (map.has(String(t)) ? map.get(String(t)) : t));
      else ev.command = String(ev.command).split(/(\s+)/).map((t) => (map.has(t) ? map.get(t) : t)).join('');
    }
  }
  return res;
}

/**
 * Paths a definition reads from outside its project folder (for validate warnings).
 * Returns [{phaseId, kind: 'promptFile'|'command', path}].
 */
function outsidePaths(definition) {
  const out = [];
  const root = definition && definition.cwd;
  if (!root) return out;
  for (const p of definition.phases || []) {
    if (p.promptFile && path.isAbsolute(p.promptFile) && !isInside(p.promptFile, root)) {
      out.push({ phaseId: p.id, kind: 'promptFile', path: p.promptFile });
    }
    if (p.eval && p.eval.command != null) {
      for (const t of outsideFileTokens(p.eval.command, root)) out.push({ phaseId: p.id, kind: 'command', path: t });
      for (const e of escapingTokens(p.eval.command, root)) out.push({ phaseId: p.id, kind: 'command', path: e.resolved });
    }
  }
  return out;
}

module.exports = { snapshotLoopFiles, outsidePaths, isInside, outsideFileTokens, escapingTokens };
