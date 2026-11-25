'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { which, homeDir, shortId } = require('./util');

const WORKER_PREAMBLE = 'You are a worker agent for master "';
const EVENTS_LINE_LIMIT = 8000;

/**
 * GitHub Copilot CLI (`copilot`), verified on this machine 2026-11-11:
 *   /usr/local/bin/copilot  version 1.0.109
 * Headless: -p/--prompt, --output-format text|json, --silent,
 *   -C <dir>, --session-id=<uuid> (create or resume), --model,
 *   --allow-all-tools (required for non-interactive mode per --help; af only
 *   adds it with --force).
 * Interactive: `copilot` (no -p); -i/--interactive <prompt> starts interactive
 *   and auto-executes that prompt; --session-id=<uuid> create-or-resume
 *   (do not use --resume= for a freshly minted id — it fails);
 *   -C <dir>, --model, --allow-all-tools only when --force.
 * Cursor --trust/--workspace do not apply.
 * `gh copilot` is a preview wrapper around the same CLI; af calls `copilot` directly.
 * This is not `gh` repository tooling (issue/pr/repo) and not `gh agent-task`.
 */
function resolveCopilotBin() {
  if (process.env.AGENTFLEET_COPILOT_BIN) return process.env.AGENTFLEET_COPILOT_BIN;
  return which('copilot') || 'copilot';
}

/**
 * Extra workspace roots for handoff/plan files outside -C.
 * Dedupes --add-dir for result and plan parent dirs.
 */
function extraDirArgs(session, addDirs = []) {
  const dirs = [];
  const seen = new Set();
  for (const p of [session && session.result, session && session.plan]) {
    if (!p) continue;
    const dir = path.dirname(path.resolve(String(p)));
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push('--add-dir', dir);
  }
  // Whole directories (e.g. a loop state dir), used as given.
  for (const d of addDirs || []) {
    if (!d) continue;
    const dir = path.resolve(String(d));
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push('--add-dir', dir);
  }
  return dirs;
}

/**
 * Pre-approve writes to the handoff / plan files without --allow-all-tools.
 * Copilot: `--allow-tool=write(/abs/path)` scopes file create/modify only
 * (does not approve shell). Used for workers and masters with result/plan.
 */
function writeAllowArgs(session, allowWritePaths = []) {
  const args = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(String(p));
    if (seen.has(abs)) return;
    seen.add(abs);
    args.push(`--allow-tool=write(${abs})`);
  };
  add(session && session.result);
  add(session && session.plan);
  for (const p of allowWritePaths || []) add(p);
  return args;
}

/** @deprecated use extraDirArgs */
function resultDirArgs(session) {
  return extraDirArgs(session);
}

function newSessionId() {
  return crypto.randomUUID();
}

/**
 * addDirs / allowWritePaths grant access to files outside -C that a caller
 * must write (loop plan-next.json); see lib/loop.js loopPhaseWriteGrants.
 */
function buildPrintArgs(
  session,
  { prompt, force = false, outputFormat = 'text', silent = true, addDirs = [], allowWritePaths = [] } = {}
) {
  if (!prompt) throw new Error('prompt is required for a Copilot headless run');
  const fmt = outputFormat || 'text';
  if (fmt !== 'text' && fmt !== 'json') {
    throw new Error(`unsupported copilot --output-format: ${fmt} (want text or json)`);
  }
  const args = ['-p', String(prompt), '--output-format', fmt];
  if (silent) args.push('--silent');
  const cwd = session && session.cwd;
  if (cwd) args.push('-C', cwd);
  if (session && session.model) args.push('--model', session.model);
  // --session-id sets the UUID for a new session or resumes that id later
  // (copilot --help). Using --resume= on a freshly minted id fails with
  // "No session, task, or name matched".
  if (session && session.chatId) args.push(`--session-id=${session.chatId}`);
  args.push(...extraDirArgs(session, addDirs));
  args.push(...writeAllowArgs(session, allowWritePaths));
  args.push(...require('./mcp').copilotMcpLaunchArgs(session));
  if (force) args.push('--allow-all-tools');
  return args;
}

function buildPrintCommand(session, opts = {}) {
  return [resolveCopilotBin(), ...buildPrintArgs(session, opts)];
}

/**
 * Model name from a Copilot "Model \"x\" is not available" error, else null.
 * Matches plain text and the escaped form inside --output-format json events.
 */
function unavailableModelFromOutput(text) {
  if (!text) return null;
  const m = String(text).match(/Model \\?"([^"\\]+)\\?" is not available/);
  return m ? m[1] : null;
}

/**
 * Model to retry with when no model is pinned and the account default is
 * unavailable. AGENTFLEET_COPILOT_FALLBACK_MODEL overrides; "" or "none"
 * disables the retry. Default: auto.
 */
function fallbackModel(env = process.env) {
  const raw = env && env.AGENTFLEET_COPILOT_FALLBACK_MODEL;
  if (raw == null) return 'auto';
  const v = String(raw).trim();
  if (!v || v.toLowerCase() === 'none') return null;
  return v;
}

/**
 * Interactive argv (without binary).
 * Does NOT fall back to session.prompt — pass opts.prompt only for first
 * launch (`af new --prompt`) or an explicit `--prompt` on that resume.
 */
function buildInteractiveArgs(session, { prompt, force = false } = {}) {
  if (!session || !session.chatId) {
    throw new Error('chatId (copilot session id) is required for interactive launch');
  }
  const args = [`--session-id=${session.chatId}`];
  const cwd = session.cwd;
  if (cwd) args.push('-C', cwd);
  if (session.model) args.push('--model', session.model);
  args.push(...extraDirArgs(session));
  args.push(...writeAllowArgs(session));
  args.push(...require('./mcp').copilotMcpLaunchArgs(session));
  if (typeof prompt === 'string' && prompt) args.push('-i', prompt);
  if (force) args.push('--allow-all-tools');
  return args;
}

function buildInteractiveCommand(session, opts = {}) {
  return [resolveCopilotBin(), ...buildInteractiveArgs(session, opts)];
}

function copilotAvailable() {
  return Boolean(which('copilot') || process.env.AGENTFLEET_COPILOT_BIN);
}

/**
 * Copilot on-disk home (`~/.copilot`).
 * Precedence: AGENTFLEET_COPILOT_HOME > COPILOT_HOME > HOME/.copilot
 */
function resolveCopilotHome(env = process.env) {
  if (env.AGENTFLEET_COPILOT_HOME) return path.resolve(String(env.AGENTFLEET_COPILOT_HOME));
  if (env.COPILOT_HOME) return path.resolve(String(env.COPILOT_HOME));
  return path.join(homeDir(), '.copilot');
}

function sessionStateRoot(env = process.env) {
  return path.join(resolveCopilotHome(env), 'session-state');
}

function unquoteYamlScalar(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    const q = s[0];
    let out = '';
    for (let i = 1; i < s.length - 1; i++) {
      const ch = s[i];
      if (ch === '\\' && q === '"' && i + 1 < s.length - 1) {
        out += s[i + 1];
        i++;
        continue;
      }
      if (ch === q && q === "'" && s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      out += ch;
    }
    return out;
  }
  return s;
}

function parseYamlBoolOrScalar(raw) {
  const s = String(raw ?? '').trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~' || s === '') return s === '' ? '' : null;
  return unquoteYamlScalar(s);
}

/**
 * Tiny tolerant YAML subset for Copilot workspace.yaml:
 * top-level `key: value`, quoted strings, and `key: |-` / `|` block scalars.
 */
function parseWorkspaceYaml(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    if (/^(\||\|-|\|\+)$/.test(rest)) {
      const raw = [];
      while (i < lines.length) {
        const cont = lines[i];
        if (cont.length === 0) {
          raw.push(cont);
          i++;
          continue;
        }
        if (/^\s/.test(cont)) {
          raw.push(cont);
          i++;
          continue;
        }
        break;
      }
      let minIndent = Infinity;
      for (const r of raw) {
        if (!r.trim()) continue;
        const ind = r.match(/^(\s*)/)[1].length;
        if (ind < minIndent) minIndent = ind;
      }
      if (!Number.isFinite(minIndent)) minIndent = 0;
      out[key] = raw
        .map((r) => (r.length >= minIndent ? r.slice(minIndent) : r.replace(/^\s+/, '')))
        .join('\n')
        .replace(/\n+$/, '');
      continue;
    }
    out[key] = parseYamlBoolOrScalar(rest);
  }
  return out;
}

function realpathSafe(p) {
  if (p == null || p === '') return null;
  try {
    return fs.realpathSync(path.resolve(String(p)));
  } catch (_) {
    try {
      return path.resolve(String(p));
    } catch (_) {
      return String(p);
    }
  }
}

function pathEqualsOrInside(child, parent) {
  const c = realpathSafe(child);
  const p = realpathSafe(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

function firstLineOf(text) {
  const s = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!s) return '';
  return s.split(/\r?\n/).find((l) => l.trim()) || '';
}

/**
 * For af-spawned workers, title should be the task after the '---' separator.
 */
function promptForTitle(firstPrompt) {
  const s = String(firstPrompt || '');
  if (s.startsWith(WORKER_PREAMBLE)) {
    const idx = s.search(/\n---\s*\n/);
    if (idx !== -1) {
      const after = s.slice(idx).replace(/^\n---\s*\n/, '');
      const line = firstLineOf(after);
      if (line) return line;
    }
  }
  return firstLineOf(s) || s.trim();
}

function inferSessionTitle({ userNamed, name, summary, firstPrompt, id }) {
  if (userNamed && name) {
    return firstLineOf(name) || String(name).trim();
  }
  if (summary != null && String(summary).trim()) {
    return firstLineOf(summary);
  }
  const source = name || firstPrompt || '';
  const inferred = promptForTitle(source);
  if (inferred) return inferred;
  return `copilot-${shortId(id)}`;
}

function extractUserMessageText(data) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['content', 'text', 'message', 'prompt', 'body']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  // Rare: content as array of parts
  if (Array.isArray(data.content)) {
    const parts = data.content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p.text === 'string') return p.text;
        if (p && typeof p.content === 'string') return p.content;
        return '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  return null;
}

/**
 * Stream events.jsonl (capped). Returns { sessionId, copilotVersion, startTime,
 * cwd, firstPrompt, model }.
 */
function readEventsMeta(eventsPath, { lineLimit = EVENTS_LINE_LIMIT } = {}) {
  const meta = {
    sessionId: null,
    copilotVersion: null,
    startTime: null,
    cwd: null,
    firstPrompt: null,
    model: null,
  };
  if (!eventsPath || !fs.existsSync(eventsPath)) return meta;
  let fh;
  try {
    fh = fs.openSync(eventsPath, 'r');
  } catch (_) {
    return meta;
  }
  try {
    const bufSize = 256 * 1024;
    const buf = Buffer.alloc(bufSize);
    let carry = '';
    let lines = 0;
    let done = false;
    while (!done) {
      const n = fs.readSync(fh, buf, 0, bufSize, null);
      if (n <= 0) break;
      carry += buf.slice(0, n).toString('utf8');
      let idx;
      while ((idx = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        lines++;
        if (line.trim()) {
          let obj;
          try {
            obj = JSON.parse(line);
          } catch (_) {
            obj = null;
          }
          if (obj) {
            const type = obj.type;
            const data = obj.data || {};
            if (type === 'session.start') {
              if (data.sessionId) meta.sessionId = data.sessionId;
              if (data.copilotVersion) meta.copilotVersion = data.copilotVersion;
              if (data.startTime) meta.startTime = data.startTime;
              if (data.context && data.context.cwd) meta.cwd = data.context.cwd;
            } else if (type === 'session.model_change') {
              if (typeof data.newModel === 'string' && data.newModel.trim()) {
                meta.model = data.newModel.trim();
              }
            } else if (type === 'user.message' && meta.firstPrompt == null) {
              const text = extractUserMessageText(data);
              if (text) meta.firstPrompt = text;
            }
          }
        }
        if (lines >= lineLimit) {
          done = true;
          break;
        }
      }
    }
  } finally {
    try {
      fs.closeSync(fh);
    } catch (_) {
      /* ignore */
    }
  }
  return meta;
}

function readSessionDir(dir, id) {
  const workspacePath = path.join(dir, 'workspace.yaml');
  const eventsPath = path.join(dir, 'events.jsonl');
  let st;
  try {
    st = fs.statSync(dir);
  } catch (_) {
    return null;
  }
  if (!st.isDirectory()) return null;

  const hasWorkspace = fs.existsSync(workspacePath);
  const hasEvents = fs.existsSync(eventsPath);
  if (!hasWorkspace && !hasEvents) return null;

  let ws = {};
  if (hasWorkspace) {
    try {
      ws = parseWorkspaceYaml(fs.readFileSync(workspacePath, 'utf8'));
    } catch (_) {
      ws = {};
    }
  }

  const events = hasEvents ? readEventsMeta(eventsPath) : {};
  const name = typeof ws.name === 'string' ? ws.name : null;
  const summary = ws.summary != null && String(ws.summary).trim() ? String(ws.summary) : null;
  const userNamed = ws.user_named === true;
  const firstPrompt = name || events.firstPrompt || null;
  const cwdRaw = ws.cwd || events.cwd || null;
  const gitRoot = ws.git_root || null;
  const updated =
    (typeof ws.updated_at === 'string' && ws.updated_at) ||
    (st.mtime && st.mtime.toISOString && st.mtime.toISOString()) ||
    null;
  const created =
    (typeof ws.created_at === 'string' && ws.created_at) ||
    events.startTime ||
    null;

  let model = null;
  if (typeof events.model === 'string' && events.model.trim()) {
    model = events.model.trim();
  }

  const sessionId = (typeof ws.id === 'string' && ws.id) || events.sessionId || id;

  return {
    id: sessionId,
    cwd: cwdRaw ? realpathSafe(cwdRaw) : null,
    gitRoot: gitRoot ? realpathSafe(gitRoot) : null,
    branch: typeof ws.branch === 'string' ? ws.branch : null,
    repository: typeof ws.repository === 'string' ? ws.repository : null,
    title: inferSessionTitle({
      userNamed,
      name,
      summary,
      firstPrompt,
      id: sessionId,
    }),
    firstPrompt,
    model,
    created,
    updated,
    userNamed,
    _mtimeMs: st.mtimeMs || 0,
  };
}

/**
 * List local Copilot CLI sessions under ~/.copilot/session-state.
 * @param {{ limit?: number, cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
function listLocalSessions({ limit = 50, cwd = null, env = process.env } = {}) {
  const root = sessionStateRoot(env);
  if (!fs.existsSync(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name || name.startsWith('.')) continue;
    const dir = path.join(root, name);
    let st;
    try {
      st = fs.statSync(dir);
    } catch (_) {
      continue;
    }
    if (!st.isDirectory()) continue;
    // UUID-ish dir names only (tolerate missing hyphenated form)
    if (!/^[0-9a-f-]{8,}$/i.test(name)) continue;
    const sess = readSessionDir(dir, name);
    if (!sess) continue;
    out.push(sess);
  }

  out.sort((a, b) => {
    const ta = Date.parse(a.updated) || a._mtimeMs || 0;
    const tb = Date.parse(b.updated) || b._mtimeMs || 0;
    return tb - ta;
  });

  let filtered = out;
  if (cwd) {
    filtered = out.filter(
      (s) =>
        (s.cwd && pathEqualsOrInside(s.cwd, cwd)) ||
        (s.gitRoot && pathEqualsOrInside(s.gitRoot, cwd))
    );
  }

  const lim = Math.max(0, Number(limit) || 0);
  return filtered.slice(0, lim).map((s) => publicSession(s));
}

/**
 * Resolve a session by full UUID or unique prefix (≥8 chars).
 * @returns {object|null}
 */
function getLocalSession(id, { env = process.env } = {}) {
  const q = String(id || '').trim();
  if (!q) return null;
  const root = sessionStateRoot(env);
  if (!fs.existsSync(root)) return null;

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
    const dir = path.join(root, q);
    if (!fs.existsSync(dir)) return null;
    return publicSession(readSessionDir(dir, q));
  }

  if (q.length < 8) {
    const err = new Error(`session id prefix too short (need ≥8 chars): ${q}`);
    err.code = 'PREFIX_TOO_SHORT';
    throw err;
  }

  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (_) {
    return null;
  }
  const ql = q.toLowerCase();
  const matches = entries.filter(
    (name) =>
      name &&
      !name.startsWith('.') &&
      name.toLowerCase().startsWith(ql) &&
      fs.existsSync(path.join(root, name))
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const err = new Error(
      `ambiguous session id prefix ${q}: ${matches.slice(0, 5).join(', ')}${
        matches.length > 5 ? '…' : ''
      }`
    );
    err.code = 'AMBIGUOUS_PREFIX';
    throw err;
  }
  const full = matches[0];
  return publicSession(readSessionDir(path.join(root, full), full));
}

function publicSession(sess) {
  if (!sess) return null;
  const { _mtimeMs, userNamed, ...rest } = sess;
  return rest;
}

/**
 * Parse Copilot `--output-format json` stdout (JSONL events or a single result).
 * Prefer session.usage_record for tokens; result.usage is usually premium-only.
 *
 * @returns {{
 *   result: string,
 *   usage: object|null,
 *   model: string|null,
 *   events: object[],
 *   assistantText: string|null
 * }}
 */
function parseCopilotJsonOutput(stdout, opts = {}) {
  const usageLib = require('./usage');
  const text = String(stdout == null ? '' : stdout);
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t[0] === '{') {
      try {
        events.push(JSON.parse(t));
        continue;
      } catch (_) {
        /* fall through */
      }
    }
  }
  // Whole-buffer JSON array / object fallback.
  if (!events.length && text.trim()) {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) events.push(...parsed);
      else if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch (_) {
      /* leave events empty */
    }
  }

  let assistantText = null;
  let resultText = null;
  let resultUsage = null;
  let model = opts.model != null ? String(opts.model) : null;
  const usageRecords = [];
  let checkpointMetrics = null;
  let shutdownMetrics = null;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const type = ev.type;
    const data = ev.data || {};
    if (type === 'session.model_change' && typeof data.newModel === 'string') {
      model = data.newModel.trim() || model;
    }
    if (type === 'assistant.message') {
      const t = extractUserMessageText(data) || (typeof data.content === 'string' ? data.content : null);
      if (typeof t === 'string' && t.trim()) assistantText = t;
    }
    if (type === 'session.usage_record') {
      const raw = data.usage && typeof data.usage === 'object' ? data.usage : data;
      if (raw && (raw.inputTokens != null || raw.outputTokens != null)) {
        usageRecords.push(raw);
        if (raw.model) model = String(raw.model);
      }
    }
    if (type === 'session.usage_checkpoint') {
      checkpointMetrics =
        (data.accountingSnapshot && data.accountingSnapshot.modelMetrics) ||
        (data.accountingSnapshot && data.accountingSnapshot.providerModelMetrics) ||
        data.modelMetrics ||
        checkpointMetrics;
    }
    if (type === 'session.shutdown') {
      shutdownMetrics = data.modelMetrics || data.providerModelMetrics || shutdownMetrics;
    }
    if (type === 'result' || ev.result != null || data.usage) {
      if (typeof ev.result === 'string') resultText = ev.result;
      else if (typeof data.result === 'string') resultText = data.result;
      const u = (ev.usage || data.usage || null);
      if (u && typeof u === 'object') resultUsage = u;
    }
  }

  let usage = null;
  if (usageRecords.length) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens = 0;
    let cost = 0;
    let duration = 0;
    let nanoAiu = null;
    for (const raw of usageRecords) {
      const nano = raw.copilotUsage && raw.copilotUsage.totalNanoAiu;
      if (nano != null && Number.isFinite(Number(nano))) nanoAiu = (nanoAiu || 0) + Number(nano);
      inputTokens += Number(raw.inputTokens) || 0;
      outputTokens += Number(raw.outputTokens) || 0;
      cacheReadTokens += Number(raw.cacheReadTokens) || 0;
      cacheWriteTokens += Number(raw.cacheWriteTokens) || 0;
      reasoningTokens += Number(raw.reasoningTokens) || 0;
      if (raw.cost != null) cost += Number(raw.cost) || 0;
      if (raw.duration != null) duration += Number(raw.duration) || 0;
      if (raw.model) model = String(raw.model);
    }
    usage = usageLib.normalizeCopilotUsage(
      {
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        cost: cost || null,
        duration: duration || null,
      },
      {
        source: 'copilot-usage-record',
        credits: nanoAiu != null ? usageLib.creditsFromNanoAiu(nanoAiu).credits : null,
      }
    );
  } else if (checkpointMetrics || shutdownMetrics) {
    const delta = usageLib.sumCopilotModelMetrics(checkpointMetrics || shutdownMetrics);
    if (delta) {
      usage = usageLib.normalizeCopilotUsage(delta, {
        source: checkpointMetrics ? 'copilot-usage-checkpoint' : 'copilot-shutdown',
      });
    }
  } else if (resultUsage) {
    usage = usageLib.normalizeCopilotUsage(resultUsage, { source: 'copilot-result' });
  }

  const result =
    (resultText != null && String(resultText).trim()
      ? String(resultText)
      : null) ||
    (assistantText != null ? String(assistantText) : null) ||
    text;

  return {
    result,
    usage,
    model,
    events,
    assistantText,
  };
}

function isSafeChatId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{8,200}$/.test(id) && !id.includes('..');
}

/**
 * Reported Copilot usage from session-state events.jsonl.
 * When `since` is set, only events at or after that time (2s skew) count,
 * so a later phase does not roll up an earlier one on a reused session.
 * @returns {object|null}
 */
function usageFromSessionEvents(session, opts = {}) {
  if (!session || !isSafeChatId(session.chatId)) return null;
  const env = opts.env || process.env;
  const file = path.join(sessionStateRoot(env), session.chatId, 'events.jsonl');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const skewMs = 2000;
  const kept = [];
  const untimed = [];
  let sawTimestamp = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    const ts =
      ev.timestamp ||
      (ev.data && ev.data.timestamp) ||
      ev.time ||
      null;
    const ms = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(ms)) {
      sawTimestamp = true;
      if (!Number.isFinite(sinceMs) || ms + skewMs >= sinceMs) kept.push(trimmed);
    } else {
      untimed.push(trimmed);
    }
  }
  const lines = kept.length ? kept : !sawTimestamp ? untimed : [];
  if (!lines.length) return null;
  const parsed = parseCopilotJsonOutput(lines.join('\n'), { model: opts.model || null });
  if (!parsed.usage || parsed.usage.accuracy !== 'reported') return null;
  return parsed.usage;
}

module.exports = {
  resolveCopilotBin,
  newSessionId,
  extraDirArgs,
  writeAllowArgs,
  resultDirArgs,
  buildPrintArgs,
  buildPrintCommand,
  unavailableModelFromOutput,
  fallbackModel,
  buildInteractiveArgs,
  buildInteractiveCommand,
  copilotAvailable,
  resolveCopilotHome,
  sessionStateRoot,
  parseWorkspaceYaml,
  listLocalSessions,
  getLocalSession,
  inferSessionTitle,
  promptForTitle,
  extractUserMessageText,
  pathEqualsOrInside,
  realpathSafe,
  parseCopilotJsonOutput,
  usageFromSessionEvents,
};
