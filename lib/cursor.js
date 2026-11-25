'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { homeDir, which, escapeShellArg } = require('./util');

/**
 * True when a bare `agent` binary is Cursor's CLI.
 * Official installs are often named `agent`; other vendors ship that name too.
 * Accept a path that contains "cursor", or --version / --help text that does.
 */
function agentBinaryIsCursor(bin) {
  if (!bin) return false;
  let real = String(bin);
  try {
    real = fs.realpathSync(bin);
  } catch (_) {
    /* keep the given path */
  }
  if (/cursor/i.test(real)) return true;
  for (const args of [['--version'], ['--help']]) {
    let out = '';
    try {
      const r = spawnSync(bin, args, {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      out = `${r.stdout || ''}\n${r.stderr || ''}`;
    } catch (_) {
      out = '';
    }
    if (/cursor/i.test(out)) return true;
  }
  return false;
}

/**
 * Resolve the Cursor CLI.
 * Prefer AGENTFLEET_CURSOR_BIN, then `cursor-agent`. A bare `agent` on PATH
 * is used only after an identity check — an unrelated vendor CLI is ignored.
 * @returns {{ bin: string|null, ignoredAgent: string|null, via: string }}
 */
function describeCursorBin(env = process.env) {
  if (env && env.AGENTFLEET_CURSOR_BIN) {
    return { bin: env.AGENTFLEET_CURSOR_BIN, ignoredAgent: null, via: 'env' };
  }
  const named = which('cursor-agent', env);
  if (named) return { bin: named, ignoredAgent: null, via: 'cursor-agent' };
  const agent = which('agent', env);
  if (agent) {
    if (agentBinaryIsCursor(agent)) return { bin: agent, ignoredAgent: null, via: 'agent' };
    return { bin: null, ignoredAgent: agent, via: 'rejected-agent' };
  }
  return { bin: null, ignoredAgent: null, via: 'missing' };
}

/**
 * Prefer `cursor-agent`. Fall back to `agent` only when it identifies as Cursor.
 * Override with AGENTFLEET_CURSOR_BIN.
 */
function resolveCursorBin() {
  const info = describeCursorBin();
  return info.bin || 'cursor-agent';
}

/**
 * Create an empty chat and return its UUID.
 * Verified: `cursor-agent create-chat` prints a UUID on stdout.
 * Note: on some installs the process may linger after printing the ID;
 * we take the first non-empty line and then kill the child.
 */
function createChat({ timeoutMs = 25000 } = {}) {
  const bin = resolveCursorBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['create-chat'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      const id = firstLine(stdout);
      if (id) {
        settled = true;
        resolve(id);
      } else {
        settled = true;
        reject(
          new Error(
            `create-chat timed out after ${timeoutMs}ms with no ID. stderr: ${stderr.trim()}`
          )
        );
      }
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
      const id = firstLine(stdout);
      if (id && !settled) {
        settled = true;
        clearTimeout(timer);
        try {
          child.kill('SIGTERM');
        } catch (_) {
          /* ignore */
        }
        resolve(id);
      }
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const id = firstLine(stdout);
      if (id) resolve(id);
      else
        reject(
          new Error(
            `create-chat exited ${code} without an ID. stderr: ${stderr.trim() || '(empty)'}`
          )
        );
    });
  });
}

function firstLine(s) {
  const line = String(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  // UUID or opaque chat id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line)) {
    return line;
  }
  // Accept other non-empty tokens that look like ids
  if (/^[A-Za-z0-9._:-]{8,}$/.test(line)) return line;
  return null;
}

/**
 * Build the argv for launching/resuming cursor-agent interactively.
 * Verified flags from cursor.com/docs/cli/reference/parameters:
 *   --resume [chatId], --model, --workspace, prompt args
 *
 * Does NOT fall back to session.prompt. Resume restores chat context via
 * --resume <chatId> only; appending the saved original task prompt would
 * inject a new user turn and can re-trigger the original work. Pass a
 * non-empty opts.prompt only for first launch (`af new --prompt`) or an
 * explicit `--prompt` on that resume invocation.
 */
/**
 * Extra --add-dir roots for result/plan files outside the workspace.
 */
function extraDirArgs(session) {
  const dirs = [];
  const seen = new Set();
  for (const p of [session && session.result, session && session.plan]) {
    if (!p) continue;
    const dir = path.dirname(path.resolve(String(p)));
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push('--add-dir', dir);
  }
  return dirs;
}

function buildResumeArgs(session, { prompt, trust = true } = {}) {
  const args = ['--resume', session.chatId];
  if (session.model) args.push('--model', session.model);
  if (session.cwd) args.push('--workspace', session.cwd);
  args.push(...extraDirArgs(session));
  args.push(...require('./mcp').cursorMcpLaunchArgs(session));
  // Default --trust so a registered workspace does not stall on the
  // "Workspace Trust Required" dialog (seen on Mini 2026-11-10 during
  // `af resume --via herdr`). Pass trust: false / --no-trust to keep the prompt.
  if (trust) args.push('--trust');
  // Only append when the caller explicitly provides a non-empty prompt.
  if (typeof prompt === 'string' && prompt) args.push(prompt);
  return args;
}

function buildResumeCommand(session, opts = {}) {
  const bin = resolveCursorBin();
  const args = buildResumeArgs(session, opts);
  return [bin, ...args];
}

function buildResumeCommandString(session, opts = {}) {
  return buildResumeCommand(session, opts).map(escapeShellArg).join(' ');
}

/**
 * Headless print-mode argv. Flags verified against cursor-agent --help
 * (2026.11.05-86047df on Mini, 2026-11-10):
 *   -p/--print, --output-format text|json|stream-json,
 *   --resume [chatId], --model, --workspace, --mode plan|ask, --force/--yolo, --trust.
 * Prompt is a trailing positional argument.
 * --trust is included unless trust === false, so a workspace trust prompt
 * cannot hang a non-interactive controller run.
 */
function buildPrintArgs(session, { prompt, mode, force = false, outputFormat = 'text', trust = true } = {}) {
  if (!prompt) throw new Error('prompt is required for a headless cursor run');
  const fmt = outputFormat || 'text';
  if (fmt !== 'text' && fmt !== 'json' && fmt !== 'stream-json') {
    throw new Error(`unsupported --output-format: ${fmt}`);
  }
  if (mode && mode !== 'ask' && mode !== 'plan') {
    throw new Error(`unsupported --mode: ${mode} (want ask or plan)`);
  }
  const args = ['-p', '--output-format', fmt];
  if (session && session.chatId) args.push('--resume', session.chatId);
  if (session && session.model) args.push('--model', session.model);
  if (session && session.cwd) args.push('--workspace', session.cwd);
  // Handoff / plan live outside the workspace ($AGENTFLEET_HOME/results|plans).
  args.push(...extraDirArgs(session));
  args.push(...require('./mcp').cursorMcpLaunchArgs(session));
  if (mode) args.push('--mode', mode);
  if (force) args.push('--force');
  if (trust) args.push('--trust');
  args.push(String(prompt));
  return args;
}

function buildPrintCommand(session, opts = {}) {
  return [resolveCursorBin(), ...buildPrintArgs(session, opts)];
}

function buildPrintCommandString(session, opts = {}) {
  return buildPrintCommand(session, opts).map(escapeShellArg).join(' ');
}

/**
 * Scan local CLI chat store.
 * Community/docs research: ~/.cursor/chats/<md5(workspacePath)>/<chatId>/{meta.json,store.db}
 * Marked: path layout observed by third parties; create-chat alone may not write
 * files until a prompt is sent. We still try to read what exists.
 */
function listLocalChats({ limit = 50 } = {}) {
  const root = path.join(homeDir(), '.cursor', 'chats');
  if (!fs.existsSync(root)) return [];
  const out = [];
  let hashes;
  try {
    hashes = fs.readdirSync(root);
  } catch (_) {
    return [];
  }
  for (const hash of hashes) {
    const hashDir = path.join(root, hash);
    let chatIds;
    try {
      if (!fs.statSync(hashDir).isDirectory()) continue;
      chatIds = fs.readdirSync(hashDir);
    } catch (_) {
      continue;
    }
    for (const chatId of chatIds) {
      const chatDir = path.join(hashDir, chatId);
      const metaPath = path.join(chatDir, 'meta.json');
      let meta = {};
      let mtime = 0;
      try {
        const st = fs.statSync(chatDir);
        mtime = st.mtimeMs;
        if (fs.existsSync(metaPath)) {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
      } catch (_) {
        continue;
      }
      out.push({
        chatId,
        cwd: meta.cwd || meta.workspacePath || null,
        workspaceHash: hash,
        meta,
        mtime,
        path: chatDir,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

/**
 * md5 of workspace path — used by Cursor CLI for ~/.cursor/chats/<hash>/.
 * UNVERIFIED on this box (no chats/ written after create-chat alone);
 * matches community reports.
 */
function workspaceHash(cwd) {
  return crypto.createHash('md5').update(path.resolve(cwd)).digest('hex');
}

/**
 * `cursor-agent ls` is interactive and ignores --print/--output-format json
 * (confirmed: forum.cursor.com + local --help shows no flags). So we cannot
 * reliably scrape it; import uses the local store instead.
 */
function lsIsInteractiveOnly() {
  return true;
}

function spawnCursorInteractive(argv, { cwd } = {}) {
  const bin = resolveCursorBin();
  const child = spawn(bin, argv, {
    cwd: cwd || process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function cursorAvailable() {
  return Boolean(describeCursorBin().bin);
}

/**
 * Parse Cursor print-mode stdout (`json` or `stream-json`) into result text + usage.
 * For `text` format, returns the raw stdout as result with no usage.
 *
 * @param {string} stdout
 * @param {{ format?: string, model?: string|null }} [opts]
 * @returns {{
 *   result: string,
 *   usage: object|null,
 *   model: string|null,
 *   sessionId: string|null,
 *   requestId: string|null,
 *   durationMs: number|null,
 *   raw: object|null,
 *   format: string
 * }}
 */
function parseCursorPrintOutput(stdout, opts = {}) {
  const usageLib = require('./usage');
  const format = String(opts.format || 'text').toLowerCase();
  const text = String(stdout == null ? '' : stdout);
  const out = {
    result: text,
    usage: null,
    model: opts.model != null ? String(opts.model) : null,
    sessionId: null,
    requestId: null,
    durationMs: null,
    raw: null,
    format,
  };
  if (format !== 'json' && format !== 'stream-json') {
    return out;
  }

  const events = [];
  const trimmed = text.trim();
  if (!trimmed) return out;

  // Single JSON object (json format) or JSONL (stream-json).
  if (format === 'json' || (trimmed.startsWith('{') && !trimmed.includes('\n{'))) {
    try {
      events.push(JSON.parse(trimmed));
    } catch (_) {
      // Fall through to line-wise parse.
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t[0] !== '{') continue;
        try {
          events.push(JSON.parse(t));
        } catch (__) {
          /* skip */
        }
      }
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      try {
        events.push(JSON.parse(t));
      } catch (_) {
        /* skip */
      }
    }
  }

  let resultText = null;
  let resultObj = null;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type || '').toLowerCase();
    if (type === 'system' && (ev.subtype === 'init' || ev.subtype === 'initialized')) {
      if (ev.model) out.model = String(ev.model);
      if (ev.session_id) out.sessionId = String(ev.session_id);
    }
    if (type === 'result' || ev.subtype === 'success' || ev.result != null) {
      // Prefer the final result event.
      if (type === 'result' || resultObj == null) {
        resultObj = ev;
        if (typeof ev.result === 'string') resultText = ev.result;
        else if (ev.result != null) resultText = String(ev.result);
        else if (typeof ev.message === 'string') resultText = ev.message;
      }
    }
    // stream-json assistant text deltas (best-effort).
    if (type === 'assistant' && typeof ev.message === 'string' && !resultText) {
      resultText = ev.message;
    }
    if (type === 'assistant' && ev.message && typeof ev.message.content === 'string' && !resultText) {
      resultText = ev.message.content;
    }
  }

  if (resultObj) {
    out.raw = resultObj;
    if (resultObj.session_id) out.sessionId = String(resultObj.session_id);
    if (resultObj.request_id) out.requestId = String(resultObj.request_id);
    if (resultObj.duration_ms != null) out.durationMs = Number(resultObj.duration_ms);
    if (resultObj.model) out.model = String(resultObj.model);
    // Recover model from nested fields when present (Cursor often omits it).
    if (!out.model && resultObj.usage && resultObj.usage.model) {
      out.model = String(resultObj.usage.model);
    }
    if (!out.model && resultObj.message && resultObj.message.model) {
      out.model = String(resultObj.message.model);
    }
    if (resultObj.usage && typeof resultObj.usage === 'object') {
      out.usage = usageLib.normalizeCursorUsage(resultObj.usage, {
        source: 'cursor-result',
        model: out.model,
        durationMs: out.durationMs,
        requestId: out.requestId,
      });
    }
  }

  if (resultText != null) out.result = resultText;
  else if (events.length && format !== 'text') {
    // Could not extract result text — leave raw stdout so callers still see output.
    out.result = text;
  }
  return out;
}

module.exports = {
  resolveCursorBin,
  describeCursorBin,
  agentBinaryIsCursor,
  createChat,
  extraDirArgs,
  buildResumeArgs,
  buildResumeCommand,
  buildResumeCommandString,
  buildPrintArgs,
  buildPrintCommand,
  buildPrintCommandString,
  listLocalChats,
  workspaceHash,
  lsIsInteractiveOnly,
  spawnCursorInteractive,
  cursorAvailable,
  firstLine,
  parseCursorPrintOutput,
};
