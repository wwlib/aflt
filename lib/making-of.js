'use strict';

/**
 * "Making of" recording for aflt loops.
 *
 * Every loop phase is one aflt session (runs/<sessionId>/). After each phase
 * run aflt:
 *   1. archives the engine's native session record into runs/<id>/engine/
 *      (Copilot events.jsonl; Cursor stream-json stdout + agent transcript),
 *   2. writes runs/<id>/calls.jsonl — one normalized line per model call:
 *      { phase, index, timestamp, engine, model, input, output, toolCalls,
 *        tokens, cost, costBasis, ... }
 *   3. writes runs/<id>/session-context.json — system prompt, runtime
 *      instructions and what is known about tool definitions, once per session.
 *
 * `aflt making-of <loop>` collects those (or rebuilds them from the native
 * logs for runs recorded before this existed), adds the run repo's commits,
 * diffs and artifacts, and renders one self-contained HTML page
 * (lib/making-of-view.js).
 *
 * Cost rules: Copilot per-call credits come from its own usage records
 * (accuracy "reported"). Cursor reports tokens per run only and no cost, so
 * Cursor calls carry no per-call tokens or cost. Nothing is estimated here.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const usage = require('./usage');
const { fleetDir, nowIso, homeDir } = require('./util');

const CALLS_VERSION = 1;
const ENGINE_DIR = 'engine';
const CALLS_FILE = 'calls.jsonl';
const CONTEXT_FILE = 'session-context.json';
const MAX_DIFF_BYTES = 400 * 1024;
const MAX_ARTIFACT_BYTES = 200 * 1024;
const MAX_EVAL_TEXT = 20000;

// ---------- small helpers ----------

function runDir(sessionId) {
  return path.join(fleetDir(), 'runs', String(sessionId));
}

function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id) && !id.includes('..');
}

function safeName(s) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'x';
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  return parseJsonl(text);
}

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      out.push(JSON.parse(t));
    } catch (_) {
      /* skip partial lines */
    }
  }
  return out;
}

function readJson(file, dflt = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return dflt;
  }
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function copyPrivate(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch (_) {
    /* ignore */
  }
  return dest;
}

function msToIso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function copilotStateRoot(env) {
  return require('./copilot').sessionStateRoot(env || process.env);
}

function cursorHome(env = process.env) {
  if (env.AGENTFLEET_CURSOR_HOME) return path.resolve(String(env.AGENTFLEET_CURSOR_HOME));
  return path.join(homeDir(), '.cursor');
}

function findCursorTranscript(chatId, env = process.env) {
  if (!isSafeId(chatId)) return null;
  const root = path.join(cursorHome(env), 'projects');
  let slugs = [];
  try {
    slugs = fs.readdirSync(root);
  } catch (_) {
    return null;
  }
  for (const slug of slugs) {
    if (!slug || slug.startsWith('.')) continue;
    const f = path.join(root, slug, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    try {
      if (fs.lstatSync(f).isFile()) return f;
    } catch (_) {
      /* skip */
    }
  }
  return null;
}

// ---------- 1. archive native session records ----------

function engineDir(sessionId) {
  return path.join(runDir(sessionId), ENGINE_DIR);
}

/** Copy Copilot's session-state/<chatId>/events.jsonl into runs/<id>/engine/. */
function archiveCopilotSession(sessionId, chatId, opts = {}) {
  if (!sessionId || !isSafeId(chatId)) return null;
  const src = path.join(copilotStateRoot(opts.env), chatId, 'events.jsonl');
  if (!fs.existsSync(src)) return null;
  return copyPrivate(src, path.join(engineDir(sessionId), `copilot-${chatId}.events.jsonl`));
}

/** Persist one Cursor `--output-format stream-json` stdout (every event). */
function saveCursorStream(sessionId, chatId, stdout, opts = {}) {
  if (!sessionId || stdout == null || !String(stdout).trim()) return null;
  const stamp = String(opts.at || nowIso()).replace(/[:.]/g, '-');
  const file = path.join(
    engineDir(sessionId),
    `cursor-${safeName(chatId || 'chat')}-${safeName(stamp)}.stream.jsonl`
  );
  const text = String(stdout);
  return writePrivate(file, text.endsWith('\n') ? text : `${text}\n`);
}

/** Copy Cursor's agent transcript (assistant text + tool inputs) when present. */
function archiveCursorTranscript(sessionId, chatId, opts = {}) {
  if (!sessionId || !isSafeId(chatId)) return null;
  const src = findCursorTranscript(chatId, opts.env);
  if (!src) return null;
  return copyPrivate(src, path.join(engineDir(sessionId), `cursor-${chatId}.transcript.jsonl`));
}

/**
 * Archive whatever the engine recorded for this phase run. Best-effort; never throws.
 * @returns {string[]} archived file paths
 */
function archivePhaseRecord({ sessionId, chatId, engine, stdout, runStartedAt, env } = {}) {
  const out = [];
  const tryPush = (fn) => {
    try {
      const p = fn();
      if (p) out.push(p);
    } catch (_) {
      /* best-effort */
    }
  };
  if (engine === 'copilot') {
    tryPush(() => archiveCopilotSession(sessionId, chatId, { env }));
  } else if (engine === 'cursor') {
    tryPush(() => saveCursorStream(sessionId, chatId, stdout, { at: runStartedAt }));
    tryPush(() => archiveCursorTranscript(sessionId, chatId, { env }));
  }
  return out;
}

// ---------- 2. parsers ----------

function newCall(fields) {
  return {
    phase: null,
    index: null,
    timestamp: null,
    endTimestamp: null,
    engine: null,
    model: null,
    chatId: null,
    input: [],
    output: { text: '', reasoning: '', reasoningEncrypted: false, toolRequests: [] },
    toolCalls: [],
    tokens: null,
    cost: null,
    costBasis: null,
    costNote: null,
    latency: null,
    finishReason: null,
    ...fields,
  };
}

/**
 * Copilot CLI events.jsonl → calls (one per assistant.turn_start / usage record).
 * @returns {{ calls: object[], context: object, meta: object, gaps: string[] }}
 */
function parseCopilotEvents(events, ctx = {}) {
  const calls = [];
  const context = {
    systemPrompts: [],
    instructions: [],
    toolDefinitions: { recorded: false, tokens: null, note: 'Copilot CLI records only the token size of its tool definitions, not their text.' },
    copilotVersion: null,
    reasoningEffort: null,
    git: null,
  };
  const meta = { shutdowns: [], codeChanges: null, userPrompts: [], resumes: 0 };
  let cur = null;
  let pending = [];
  const toolById = new Map();
  for (const e of events || []) {
    if (!e || typeof e !== 'object') continue;
    const d = e.data || {};
    switch (e.type) {
      case 'session.start':
        context.copilotVersion = d.copilotVersion || context.copilotVersion;
        context.reasoningEffort = d.reasoningEffort || context.reasoningEffort;
        context.git = d.context || context.git;
        break;
      case 'session.resume':
        meta.resumes += 1;
        pending.push({ type: 'resume', at: e.timestamp || null, text: `Session resumed${d.selectedModel ? ` (${d.selectedModel})` : ''}` });
        break;
      case 'system.message': {
        const text = d.content || '';
        let ref = context.systemPrompts.indexOf(text);
        if (ref === -1) {
          context.systemPrompts.push(text);
          ref = context.systemPrompts.length - 1;
        }
        pending.push({ type: 'system', ref, chars: text.length });
        break;
      }
      case 'instruction.update':
        context.instructions.push({ name: d.name || null, text: d.content || '' });
        pending.push({ type: 'instruction', name: d.name || null, text: d.content || '' });
        break;
      case 'user.message':
        pending.push({ type: 'user', text: d.transformedContent || d.content || '', rawPrompt: d.content || '', at: e.timestamp || null });
        meta.userPrompts.push({ at: e.timestamp || null, text: d.content || '' });
        break;
      case 'assistant.turn_start':
        cur = newCall({
          ...ctx,
          engine: 'copilot',
          timestamp: e.timestamp || null,
          turnId: d.turnId != null ? String(d.turnId) : null,
          input: pending,
        });
        pending = [];
        calls.push(cur);
        break;
      case 'session.usage_record': {
        if (!cur) break;
        const u = d.usage || {};
        const det = {};
        for (const t of (u.copilotUsage && u.copilotUsage.tokenDetails) || []) det[t.tokenType] = t;
        const nano = u.copilotUsage ? u.copilotUsage.totalNanoAiu : null;
        cur.model = u.model || cur.model;
        cur.tokens = {
          in: u.inputTokens != null ? u.inputTokens : null,
          uncachedIn: det.input ? det.input.tokenCount : null,
          cacheRead: u.cacheReadTokens != null ? u.cacheReadTokens : null,
          cacheWrite: u.cacheWriteTokens != null ? u.cacheWriteTokens : null,
          out: u.outputTokens != null ? u.outputTokens : null,
          reasoning: u.reasoningTokens != null ? u.reasoningTokens : null,
          toolDefs: u.toolTokenCount != null ? u.toolTokenCount : null,
        };
        if (u.toolTokenCount != null) context.toolDefinitions.tokens = u.toolTokenCount;
        if (nano != null) {
          const { credits, usd } = usage.creditsFromNanoAiu(nano);
          const P = usage.COPILOT_PRICING;
          cur.cost = {
            credits,
            usd,
            accuracy: 'reported',
            premiumRequestUnits: u.cost != null ? u.cost : null,
            breakdown: Object.values(det).map((t) => ({
              type: t.tokenType,
              tokens: t.tokenCount,
              creditsPerMTok: t.batchSize ? (t.costPerBatch / P.nanoAiuPerCredit) * (1e6 / t.batchSize) : null,
              credits: t.batchSize ? (t.tokenCount * t.costPerBatch) / t.batchSize / P.nanoAiuPerCredit : null,
            })),
          };
          cur.costBasis = P.text;
        } else {
          cur.costNote = 'Copilot recorded tokens for this call but no AI-credit figure.';
        }
        cur.latency = { durationMs: u.duration != null ? u.duration : null, ttftMs: u.timeToFirstTokenMs != null ? u.timeToFirstTokenMs : null };
        cur.finishReason = u.finishReason || null;
        cur.apiCallId = u.apiCallId || null;
        break;
      }
      case 'assistant.message':
        if (!cur) break;
        cur.model = cur.model || d.model || null;
        if (d.content) cur.output.text += (cur.output.text ? '\n\n' : '') + d.content;
        if (d.reasoningText) cur.output.reasoning += (cur.output.reasoning ? '\n\n' : '') + d.reasoningText;
        if (d.reasoningOpaque || (d.reasoningBlocks && d.reasoningBlocks.blocks && d.reasoningBlocks.blocks.length)) {
          cur.output.reasoningEncrypted = true;
        }
        for (const t of d.toolRequests || []) {
          const tc = {
            id: t.toolCallId,
            name: t.name,
            intent: t.intentionSummary || null,
            args: t.arguments,
            result: null,
            detail: null,
            success: null,
            startedAt: null,
            endedAt: null,
            files: [],
          };
          cur.output.toolRequests.push({ id: t.toolCallId, name: t.name });
          cur.toolCalls.push(tc);
          toolById.set(t.toolCallId, tc);
        }
        break;
      case 'tool.execution_start': {
        const tc = toolById.get(d.toolCallId);
        if (tc) tc.startedAt = e.timestamp || null;
        break;
      }
      case 'tool.execution_complete': {
        const tc = toolById.get(d.toolCallId);
        if (tc) {
          tc.endedAt = e.timestamp || null;
          tc.success = d.success != null ? Boolean(d.success) : null;
          const r = d.result || {};
          tc.result = r.content != null ? r.content : d.error ? JSON.stringify(d.error) : null;
          tc.detail = r.detailedContent || null;
          for (const fe of d.fileEdits || []) if (fe && fe.path) tc.files.push({ path: fe.path, kind: fe.kind || 'edit' });
          if (!tc.files.length) tc.files.push(...filesFromToolArgs(tc.name, tc.args));
          if (d.shellExecution && d.shellExecution.exitCode != null) tc.exitCode = d.shellExecution.exitCode;
        }
        pending.push({ type: 'toolResult', toolCallId: d.toolCallId, name: tc ? tc.name : null });
        break;
      }
      case 'assistant.turn_end':
        if (cur) cur.endTimestamp = e.timestamp || null;
        break;
      case 'session.shutdown':
        meta.shutdowns.push({
          at: e.timestamp || null,
          premiumRequests: d.totalPremiumRequests != null ? d.totalPremiumRequests : null,
          nanoAiu: d.totalNanoAiu != null ? d.totalNanoAiu : null,
          shutdownType: d.shutdownType || null,
          systemTokens: d.systemTokens != null ? d.systemTokens : null,
          toolDefinitionsTokens: d.toolDefinitionsTokens != null ? d.toolDefinitionsTokens : null,
        });
        if (d.toolDefinitionsTokens != null) context.toolDefinitions.tokens = d.toolDefinitionsTokens;
        if (d.codeChanges) meta.codeChanges = d.codeChanges;
        break;
      default:
        break;
    }
  }
  const gaps = [
    'Copilot: exact request bodies are not stored. Each call\'s input lists what was new since the previous call (system prompt, user prompt, tool results); the full context is everything before it in the same chat.',
    'Copilot: tool definitions are recorded only as a token total, not their text.',
  ];
  if (calls.some((c) => c.output.reasoningEncrypted)) {
    gaps.push('Copilot: the model\'s private reasoning is encrypted (reasoningOpaque); only the reasoning summary is readable.');
  }
  return { calls, context, meta, gaps };
}

function cursorToolFromEvent(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return { name: 'tool', args: null, result: undefined };
  if (toolCall.function && typeof toolCall.function === 'object') {
    let args = toolCall.function.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch (_) {
        /* keep string */
      }
    }
    return { name: toolCall.function.name || 'function', args, result: toolCall.result };
  }
  const key = Object.keys(toolCall).find((k) => /ToolCall$/.test(k) && toolCall[k] && typeof toolCall[k] === 'object');
  if (!key) return { name: 'tool', args: null, result: undefined };
  const body = toolCall[key];
  return { name: key.replace(/ToolCall$/, ''), args: body.args != null ? body.args : null, result: body.result };
}

function cursorResultText(result) {
  if (result == null) return { text: null, success: null };
  if (typeof result === 'string') return { text: result, success: true };
  if (result.success != null) {
    const s = result.success;
    if (typeof s === 'string') return { text: s, success: true };
    if (s && typeof s.content === 'string') return { text: s.content, success: true };
    if (s && typeof s.stdout === 'string') {
      return { text: `${s.stdout}${s.stderr ? `\n[stderr]\n${s.stderr}` : ''}`, success: true, exitCode: s.exitCode };
    }
    return { text: JSON.stringify(s, null, 2), success: true };
  }
  for (const k of ['error', 'failure', 'rejected']) {
    if (result[k] != null) return { text: typeof result[k] === 'string' ? result[k] : JSON.stringify(result[k], null, 2), success: false };
  }
  return { text: JSON.stringify(result, null, 2), success: null };
}

const CURSOR_WRITE_TOOLS = /^(edit|write|create|delete|apply_?patch|search_?replace|str_?replace|multi_?edit)/i;

/** Paths named in an apply_patch body ("*** Add File: p", "*** Update File: p", ...). */
function filesFromPatch(text) {
  const out = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(String(text || '')))) out.push({ path: m[2].trim(), kind: m[1].toLowerCase() });
  return out;
}

/** Files a write-type tool call touched, from its arguments. */
function filesFromToolArgs(name, args) {
  if (!CURSOR_WRITE_TOOLS.test(String(name || ''))) return [];
  if (typeof args === 'string') return filesFromPatch(args);
  if (!args || typeof args !== 'object') return [];
  const patch = args.patch || args.input || args.diff || null;
  if (typeof patch === 'string' && /\*\*\* (Add|Update|Delete) File:/.test(patch)) return filesFromPatch(patch);
  const p = args.path || args.file_path || args.target_file || args.filePath || null;
  return p ? [{ path: String(p), kind: String(name) }] : [];
}

/**
 * Cursor `--output-format stream-json` events → calls.
 * A call groups the thinking, tool calls and assistant text of one model
 * request (tool calls share model_call_id; a new call starts after tool
 * results come back or after a user message).
 */
function parseCursorStream(events, ctx = {}) {
  const calls = [];
  const context = { systemPrompts: [], instructions: [], toolDefinitions: { recorded: false, tokens: null, note: 'Cursor CLI does not emit its system prompt or tool definitions.' }, model: null, cwd: null };
  const meta = { results: [], usage: null, sessionId: null, userPrompts: [] };
  let cur = null;
  let closed = true;
  let pending = [];
  const toolById = new Map();
  const open = (ts, modelCallId) => {
    cur = newCall({ ...ctx, engine: 'cursor', model: context.model, timestamp: ts, modelCallId: modelCallId || null, input: pending });
    cur.costNote = 'Cursor reports tokens per run (see phase totals), not per call, and records no cost.';
    pending = [];
    calls.push(cur);
    closed = false;
  };
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    const type = String(ev.type || '');
    const ts = msToIso(ev.timestamp_ms);
    if (type === 'system') {
      if (ev.model) context.model = String(ev.model);
      if (ev.cwd) context.cwd = String(ev.cwd);
      if (ev.session_id) meta.sessionId = String(ev.session_id);
      continue;
    }
    if (type === 'user') {
      const parts = (ev.message && ev.message.content) || [];
      const text = Array.isArray(parts) ? parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n\n') : String(parts || '');
      pending.push({ type: 'user', text, at: ts });
      meta.userPrompts.push({ at: ts, text });
      closed = true;
      continue;
    }
    if (type === 'thinking') {
      if (ev.subtype === 'delta' && ev.text) {
        if (!cur || closed) open(ts);
        cur.output.reasoning += ev.text;
      }
      continue;
    }
    if (type === 'tool_call') {
      const id = ev.call_id || (ev.tool_call && ev.tool_call.toolCallId) || `t${toolById.size}`;
      const parsed = cursorToolFromEvent(ev.tool_call);
      if (ev.subtype === 'started') {
        const mcid = ev.model_call_id || null;
        if (!cur || (closed && !(mcid && cur.modelCallId === mcid)) || (mcid && cur.modelCallId && cur.modelCallId !== mcid)) {
          open(ts, mcid);
        } else if (mcid && !cur.modelCallId) {
          cur.modelCallId = mcid;
        }
        const tc = { id, name: parsed.name, intent: null, args: parsed.args, result: null, detail: null, success: null, startedAt: ts, endedAt: null, files: filesFromToolArgs(parsed.name, parsed.args) };
        cur.toolCalls.push(tc);
        cur.output.toolRequests.push({ id, name: parsed.name });
        toolById.set(id, tc);
      } else if (ev.subtype === 'completed') {
        const tc = toolById.get(id);
        if (tc) {
          const r = cursorResultText(parsed.result);
          tc.result = r.text;
          tc.success = r.success;
          if (r.exitCode != null) tc.exitCode = r.exitCode;
          tc.endedAt = ts;
          if (cur) cur.endTimestamp = ts;
        }
        pending.push({ type: 'toolResult', toolCallId: id, name: tc ? tc.name : parsed.name });
        closed = true;
      }
      continue;
    }
    if (type === 'assistant') {
      const parts = (ev.message && ev.message.content) || [];
      const text = Array.isArray(parts)
        ? parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n\n')
        : typeof ev.message === 'string' ? ev.message : '';
      if (!text) continue;
      if (!cur || closed) open(ts);
      cur.output.text += (cur.output.text ? '\n\n' : '') + text;
      if (ts) cur.endTimestamp = ts;
      continue;
    }
    if (type === 'result') {
      meta.results.push({ durationMs: ev.duration_ms != null ? ev.duration_ms : null, requestId: ev.request_id || null, isError: Boolean(ev.is_error), usage: ev.usage || null });
      const u = usage.normalizeCursorUsage(ev.usage, { model: context.model, durationMs: ev.duration_ms });
      if (u) meta.usage = meta.usage ? usage.summarizeSessionUsage([meta.usage, u]) : u;
    }
  }
  for (const c of calls) c.model = c.model || context.model;
  const gaps = [
    'Cursor: stream-json records prompts, reasoning text, tool calls with results and replies, but not the system prompt or tool definitions. Tokens are reported per run, not per call, and Cursor records no cost.',
  ];
  return { calls, context, meta, gaps };
}

/** Cursor agent transcript (legacy runs): assistant text + tool inputs only. */
function parseCursorTranscript(lines, ctx = {}) {
  const calls = [];
  const meta = { userPrompts: [] };
  let pending = [];
  for (const line of lines || []) {
    const parts = (line && line.message && line.message.content) || [];
    const arr = Array.isArray(parts) ? parts : [];
    const text = arr.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n\n');
    if (line.role === 'user') {
      pending.push({ type: 'user', text });
      meta.userPrompts.push({ at: null, text });
      continue;
    }
    if (line.role !== 'assistant') continue;
    const tools = arr.filter((c) => c && c.type === 'tool_use').map((c, i) => {
      const args = c.input != null ? c.input : null;
      return {
        id: `${ctx.chatId || 'chat'}:${calls.length}:${i}`,
        name: c.name,
        intent: null,
        args,
        result: null,
        detail: null,
        success: null,
        files: filesFromToolArgs(c.name, args),
      };
    });
    const call = newCall({ ...ctx, engine: 'cursor', input: pending, step: true });
    call.output.text = text;
    call.output.toolRequests = tools.map((t) => ({ id: t.id, name: t.name }));
    call.toolCalls = tools;
    call.costNote = 'Cursor transcripts record no per-step tokens or cost.';
    calls.push(call);
    pending = tools.length ? [{ type: 'note', text: `(Cursor's transcript did not record the results of ${tools.length} tool call(s).)` }] : [];
  }
  const gaps = [
    'Cursor (transcript only): this run predates stream-json capture, so only assistant messages and tool inputs were recorded — no tool results, timestamps, system prompt or per-call tokens. One "step" is one assistant message.',
  ];
  return { calls, context: { systemPrompts: [], instructions: [], toolDefinitions: { recorded: false, tokens: null } }, meta, gaps };
}

// ---------- 3. per-session records (calls.jsonl) ----------

function listEngineFiles(sessionId) {
  try {
    return fs.readdirSync(engineDir(sessionId)).sort();
  } catch (_) {
    return [];
  }
}

/**
 * Build the normalized record for one aflt session (one loop phase).
 * Prefers archived engine files; falls back to the engine's live logs.
 */
function buildSessionRecord(sessionId, opts = {}) {
  const env = opts.env || process.env;
  const dir = runDir(sessionId);
  const turns = readJsonl(path.join(dir, 'turns.jsonl'));
  const engine = opts.engine || (turns[0] && turns[0].engine) || null;
  const chatIds = [...new Set([...(opts.chatIds || []), ...turns.map((t) => t.chatId)].filter(Boolean))];
  const files = listEngineFiles(sessionId);
  const ctx = { phase: opts.phase || null, sessionId };
  const rec = {
    sessionId,
    engine,
    chatIds,
    calls: [],
    context: { systemPrompts: [], instructions: [], toolDefinitions: { recorded: false, tokens: null } },
    meta: {},
    sources: [],
    gaps: [],
    turns,
    recording: null,
  };
  const absorb = (parsed, source) => {
    rec.calls.push(...parsed.calls);
    for (const s of parsed.context.systemPrompts || []) {
      if (!rec.context.systemPrompts.includes(s)) rec.context.systemPrompts.push(s);
    }
    // Re-point system refs at the merged list.
    for (const c of parsed.calls) {
      for (const i of c.input) {
        if (i.type === 'system' && typeof i.ref === 'number') {
          i.ref = rec.context.systemPrompts.indexOf(parsed.context.systemPrompts[i.ref]);
        }
      }
    }
    rec.context.instructions.push(...(parsed.context.instructions || []));
    if (parsed.context.toolDefinitions) rec.context.toolDefinitions = { ...rec.context.toolDefinitions, ...parsed.context.toolDefinitions };
    for (const k of ['copilotVersion', 'reasoningEffort', 'git', 'model', 'cwd']) {
      if (parsed.context[k] != null) rec.context[k] = parsed.context[k];
    }
    const m = parsed.meta || {};
    rec.meta.userPrompts = (rec.meta.userPrompts || []).concat(m.userPrompts || []);
    if (m.shutdowns) rec.meta.shutdowns = (rec.meta.shutdowns || []).concat(m.shutdowns);
    if (m.codeChanges) rec.meta.codeChanges = m.codeChanges;
    if (m.usage) rec.meta.engineUsage = rec.meta.engineUsage ? usage.summarizeSessionUsage([rec.meta.engineUsage, m.usage]) : m.usage;
    for (const g of parsed.gaps || []) if (!rec.gaps.includes(g)) rec.gaps.push(g);
    rec.sources.push(source);
  };

  if (engine === 'copilot') {
    rec.recording = 'copilot-events';
    for (const chatId of chatIds) {
      const archived = path.join(engineDir(sessionId), `copilot-${chatId}.events.jsonl`);
      const live = isSafeId(chatId) ? path.join(copilotStateRoot(env), chatId, 'events.jsonl') : null;
      const src = fs.existsSync(archived) ? archived : live && fs.existsSync(live) ? live : null;
      if (!src) {
        rec.gaps.push(`Copilot chat ${chatId} has no events.jsonl (neither archived nor in Copilot's session-state).`);
        continue;
      }
      absorb(parseCopilotEvents(readJsonl(src), { ...ctx, chatId }), src);
    }
  } else if (engine === 'cursor') {
    const streams = files.filter((f) => /^cursor-.*\.stream\.jsonl$/.test(f));
    if (streams.length) {
      rec.recording = 'cursor-stream-json';
      for (const f of streams) {
        const src = path.join(engineDir(sessionId), f);
        const events = readJsonl(src);
        const init = events.find((e) => e && e.type === 'system' && e.session_id);
        absorb(parseCursorStream(events, { ...ctx, chatId: init ? init.session_id : chatIds[0] || null }), src);
      }
    } else {
      rec.recording = 'cursor-transcript';
      for (const chatId of chatIds) {
        const archived = path.join(engineDir(sessionId), `cursor-${chatId}.transcript.jsonl`);
        const src = fs.existsSync(archived) ? archived : findCursorTranscript(chatId, env);
        if (!src) {
          rec.gaps.push(`Cursor chat ${chatId} has no agent transcript.`);
          continue;
        }
        absorb(parseCursorTranscript(readJsonl(src), { ...ctx, chatId }), src);
      }
    }
  } else if (engine) {
    rec.gaps.push(`Engine ${engine}: making-of recording is not implemented yet (only Copilot and Cursor).`);
  }

  // Fall back to a previously written calls.jsonl when native sources are gone.
  if (!rec.calls.length) {
    const prior = readJsonl(path.join(dir, CALLS_FILE)).filter((c) => c && c.v === CALLS_VERSION);
    if (prior.length) {
      rec.calls = prior;
      rec.recording = rec.recording || 'calls.jsonl';
      rec.sources.push(path.join(dir, CALLS_FILE));
      const priorCtx = readJson(path.join(dir, CONTEXT_FILE));
      if (priorCtx && priorCtx.context) rec.context = priorCtx.context;
    }
  }
  rec.calls.forEach((c, i) => {
    c.v = CALLS_VERSION;
    c.phase = opts.phase || c.phase || null;
    c.sessionId = sessionId;
    c.index = i + 1;
  });
  rec.usageSummary = usage.summarizeSessionUsage(turns);
  return rec;
}

/**
 * Write runs/<id>/calls.jsonl and runs/<id>/session-context.json.
 * @returns {{ callsPath: string, contextPath: string, calls: number }|null}
 */
function writeSessionCalls(sessionId, opts = {}) {
  if (!sessionId) return null;
  const rec = buildSessionRecord(sessionId, opts);
  const dir = runDir(sessionId);
  const callsPath = writePrivate(
    path.join(dir, CALLS_FILE),
    rec.calls.map((c) => JSON.stringify(c)).join('\n') + (rec.calls.length ? '\n' : '')
  );
  const contextPath = writePrivate(
    path.join(dir, CONTEXT_FILE),
    JSON.stringify(
      {
        v: CALLS_VERSION,
        sessionId,
        phase: opts.phase || null,
        engine: rec.engine,
        chatIds: rec.chatIds,
        recording: rec.recording,
        context: rec.context,
        meta: { shutdowns: rec.meta.shutdowns || [], codeChanges: rec.meta.codeChanges || null, engineUsage: rec.meta.engineUsage || null },
        sources: rec.sources,
        gaps: rec.gaps,
        writtenAt: nowIso(),
      },
      null,
      2
    ) + '\n'
  );
  return { callsPath, contextPath, calls: rec.calls.length };
}

/**
 * Post-phase hook used by the loop runner: archive, then write calls.jsonl.
 * Never throws (a making-of problem must not fail a phase).
 */
function recordPhase({ sessionId, chatId, engine, stdout, runStartedAt, phase, env } = {}) {
  try {
    const archived = archivePhaseRecord({ sessionId, chatId, engine, stdout, runStartedAt, env });
    const written = writeSessionCalls(sessionId, { phase, env, engine, chatIds: chatId ? [chatId] : [] });
    return { ok: true, archived, ...written };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------- 4. loop collection: phases, commits, artifacts ----------

function sum(arr, f) {
  return arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
}

function totalsFor(calls) {
  const withCost = calls.filter((c) => c.cost && c.cost.credits != null);
  const t = calls.map((c) => c.timestamp).filter(Boolean).sort();
  const e = calls.map((c) => c.endTimestamp || c.timestamp).filter(Boolean).sort();
  return {
    calls: calls.length,
    toolCalls: sum(calls, (c) => c.toolCalls.length),
    tokensIn: sum(calls, (c) => c.tokens && c.tokens.in),
    uncachedIn: sum(calls, (c) => c.tokens && c.tokens.uncachedIn),
    cacheRead: sum(calls, (c) => c.tokens && c.tokens.cacheRead),
    cacheWrite: sum(calls, (c) => c.tokens && c.tokens.cacheWrite),
    tokensOut: sum(calls, (c) => c.tokens && c.tokens.out),
    reasoning: sum(calls, (c) => c.tokens && c.tokens.reasoning),
    credits: withCost.length ? sum(withCost, (c) => c.cost.credits) : null,
    usd: withCost.length ? sum(withCost, (c) => c.cost.usd) : null,
    premiumRequestUnits: sum(calls, (c) => c.cost && c.cost.premiumRequestUnits),
    callsWithCost: withCost.length,
    durationMs: t.length ? Date.parse(e[e.length - 1]) - Date.parse(t[0]) : null,
  };
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function isGitRepo(cwd) {
  try {
    return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch (_) {
    return false;
  }
}

function githubBase(remoteUrl) {
  const m = String(remoteUrl || '').trim().match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** Full `git show` for one commit (patch + stat), size-capped. */
function commitDiff(repo, sha, maxBytes = MAX_DIFF_BYTES) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ''))) throw new Error('invalid commit sha');
  const text = git(repo, ['show', '--format=fuller', '--stat', '--patch', '--no-color', String(sha)]);
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false, bytes: Buffer.byteLength(text) };
  return { text: text.slice(0, maxBytes), truncated: true, bytes: Buffer.byteLength(text) };
}

/**
 * Commits in the run repo, oldest first, with files and phase attribution.
 * aflt's own commits say "aflt loop <name> phase <id> passed"; others are
 * attributed to the phase that was running at commit time.
 */
function collectCommits(repo, phases, opts = {}) {
  if (!repo || !isGitRepo(repo)) return { commits: [], remote: null, github: null, head: null, error: repo ? 'not a git repository' : 'no repo' };
  let remote = null;
  try {
    remote = git(repo, ['remote', 'get-url', 'origin']).trim() || null;
  } catch (_) {
    remote = null;
  }
  const github = githubBase(remote);
  let head = null;
  try {
    head = git(repo, ['rev-parse', 'HEAD']).trim();
  } catch (_) {
    return { commits: [], remote, github, head: null };
  }
  const raw = git(repo, ['log', '--reverse', '--no-color', '--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b', '--name-status']);
  const commits = [];
  for (const chunk of raw.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [sha, short, author, at, subject, rest = ''] = chunk.split('\x1f');
    const lines = rest.split('\n');
    const files = [];
    const body = [];
    let inFiles = false;
    for (const line of lines) {
      const m = line.match(/^([AMDRCTU])\d*\t(.+?)(?:\t(.+))?$/);
      if (m) {
        inFiles = true;
        files.push({ status: m[1], path: m[3] || m[2], from: m[3] ? m[2] : null });
      } else if (!inFiles) body.push(line);
    }
    const numstat = {};
    try {
      for (const l of git(repo, ['show', '--numstat', '--format=', sha]).split('\n')) {
        const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (m) numstat[m[3]] = { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) };
      }
    } catch (_) {
      /* ignore */
    }
    for (const f of files) Object.assign(f, numstat[f.path] || {});
    commits.push({
      sha,
      short,
      author,
      at,
      subject,
      body: body.join('\n').trim(),
      files,
      phase: null,
      attribution: null,
      calls: [],
      url: github ? `${github}/commit/${sha}` : null,
    });
  }
  const loopName = opts.loopName || null;
  const starts = phases.filter((p) => p.start).map((p) => ({ phase: p.phase, ms: Date.parse(p.start) })).sort((a, b) => a.ms - b.ms);
  for (const c of commits) {
    const m = c.subject.match(/^aflt loop (\S+) phase (\S+) passed/);
    if (m && (!loopName || m[1] === loopName) && phases.some((p) => p.phase === m[2])) {
      c.phase = m[2];
      c.attribution = 'aflt phase commit';
      continue;
    }
    const ms = Date.parse(c.at);
    let owner = null;
    for (const s of starts) if (s.ms <= ms) owner = s;
    c.phase = owner ? owner.phase : null;
    c.attribution = owner ? 'commit time inside phase' : 'before the loop started';
  }
  if (opts.withDiffs !== false) {
    for (const c of commits) {
      try {
        const d = commitDiff(repo, c.sha, opts.maxDiffBytes || MAX_DIFF_BYTES);
        c.diff = d.text;
        c.diffTruncated = d.truncated;
        c.diffBytes = d.bytes;
      } catch (_) {
        c.diff = null;
      }
    }
  }
  return { commits, remote, github, head };
}

function readArtifact(file, label, kind, maxBytes = MAX_ARTIFACT_BYTES) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return null;
  }
  if (!st.isFile()) return null;
  const a = { label, kind, path: file, bytes: st.size, content: null, truncated: false };
  try {
    const buf = fs.readFileSync(file);
    const isBinary = buf.subarray(0, 8000).includes(0);
    if (!isBinary) {
      a.content = buf.subarray(0, maxBytes).toString('utf8');
      a.truncated = buf.length > maxBytes;
    }
  } catch (_) {
    /* unreadable */
  }
  return a;
}

function walkFiles(root, max = 500) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const d = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const ent of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) out.push(p);
    }
  }
  return out.sort();
}

/**
 * Seed inputs: explicit --seed paths, else files in the loop definition folder
 * whose names start with "seed" or end with "-seed" (e.g. seed-m0.js, m0-seed/).
 */
function collectSeedArtifacts(defDir, explicit = []) {
  const roots = [];
  if (explicit && explicit.length) roots.push(...explicit.map((p) => path.resolve(p)));
  else if (defDir) {
    let ents = [];
    try {
      ents = fs.readdirSync(defDir);
    } catch (_) {
      ents = [];
    }
    for (const n of ents.sort()) if (/^seed/i.test(n) || /-seed$/i.test(n)) roots.push(path.join(defDir, n));
  }
  const out = [];
  for (const r of roots) {
    let st;
    try {
      st = fs.statSync(r);
    } catch (_) {
      continue;
    }
    const files = st.isDirectory() ? walkFiles(r) : [r];
    const base = st.isDirectory() ? path.dirname(r) : path.dirname(r);
    for (const f of files) {
      const a = readArtifact(f, path.relative(base, f), 'seed');
      if (a) out.push(a);
    }
  }
  return out;
}

function phaseNameFor(sessionId, loopName, statePhases) {
  for (const [id, ps] of Object.entries(statePhases || {})) if (ps && ps.sessionId === sessionId) return id;
  const m = String(sessionId).match(new RegExp(`^${loopName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(.+)-[0-9a-f]{6}$`));
  return m ? m[1] : sessionId;
}

function relToRepo(repo, p) {
  if (!p) return null;
  const s = String(p);
  if (repo && path.isAbsolute(s)) {
    const rel = path.relative(repo, s);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
    // macOS /private/var vs /var style aliases: compare realpaths.
    try {
      const rel2 = path.relative(fs.realpathSync(repo), fs.realpathSync(s));
      if (!rel2.startsWith('..')) return rel2;
    } catch (_) {
      /* file may be gone */
    }
    return null;
  }
  return s.replace(/^\.\//, '');
}

/**
 * Everything the viewer needs for one loop in the current space.
 */
function collectLoop(loopName, opts = {}) {
  const loopLib = opts.loopLib || require('./loop');
  const state = opts.state || loopLib.loadState(loopName);
  if (!state) throw new Error(`no loop state for "${loopName}" in this space (${fleetDir()}). Set AFLT_SPACE or --space.`);
  const def = state.definition || {};
  const statePhases = state.phases || {};

  // Sessions: phase state first (definition order), then registry phase sessions.
  const sessionIds = [];
  for (const p of def.phases || []) {
    const ps = statePhases[p.id];
    if (ps && ps.sessionId && !sessionIds.includes(ps.sessionId)) sessionIds.push(ps.sessionId);
  }
  for (const ps of Object.values(statePhases)) {
    if (ps && ps.sessionId && !sessionIds.includes(ps.sessionId)) sessionIds.push(ps.sessionId);
  }
  try {
    const reg = readJson(path.join(fleetDir(), 'sessions.json'), { sessions: [] });
    for (const s of reg.sessions || []) {
      const tags = s.tags || [];
      if (tags.includes(loopName) && tags.includes('loop-phase') && !sessionIds.includes(s.id)) sessionIds.push(s.id);
    }
  } catch (_) {
    /* ignore */
  }

  const phases = [];
  const calls = [];
  const gaps = [];
  const contexts = {};
  for (const sid of sessionIds) {
    if (!fs.existsSync(runDir(sid))) continue;
    const phaseName = phaseNameFor(sid, loopName, statePhases);
    const rec = buildSessionRecord(sid, { phase: phaseName, env: opts.env });
    const ps = statePhases[phaseName] || {};
    const start =
      rec.turns.map((t) => t.at).filter(Boolean).sort()[0] ||
      rec.calls.map((c) => c.timestamp).filter(Boolean).sort()[0] ||
      null;
    const onDisk = readJson(path.join(runDir(sid), 'usage-summary.json'));
    phases.push({
      phase: phaseName,
      sessionId: sid,
      runDir: sid,
      engine: rec.engine,
      chatIds: rec.chatIds,
      recording: rec.recording,
      start,
      status: ps.status || null,
      attempts: ps.attempts || null,
      type: ((def.phases || []).find((p) => p.id === phaseName) || {}).type || null,
      sources: [path.join(runDir(sid), 'turns.jsonl'), ...rec.sources],
      userPrompts: rec.meta.userPrompts || [],
      shutdowns: rec.meta.shutdowns || [],
      codeChanges: rec.meta.codeChanges || null,
      engineUsage: rec.meta.engineUsage || null,
      usageSummary: rec.usageSummary,
      usageSummaryOnDisk: onDisk,
      lastEval: ps.lastEval
        ? {
            at: ps.lastEval.at || null,
            code: ps.lastEval.code,
            timedOut: Boolean(ps.lastEval.timedOut),
            stdout: String(ps.lastEval.stdout || '').slice(-MAX_EVAL_TEXT),
            stderr: String(ps.lastEval.stderr || '').slice(-MAX_EVAL_TEXT),
            cwd: ps.lastEval.cwd || null,
          }
        : null,
      runLog: ps.lastRun && ps.lastRun.outPath ? ps.lastRun.outPath : null,
    });
    contexts[sid] = rec.context;
    calls.push(...rec.calls);
    for (const g of rec.gaps) if (!gaps.includes(g)) gaps.push(g);
  }
  // A script phase (non-AI step) has no session; still list it.
  for (const p of def.phases || []) {
    if (p.type === 'script' && !phases.some((x) => x.phase === p.id)) {
      const ps = statePhases[p.id] || {};
      phases.push({
        phase: p.id,
        sessionId: null,
        runDir: `script:${p.id}`,
        engine: null,
        type: 'script',
        chatIds: [],
        recording: 'no AI call (script step)',
        start: (ps.lastEval && ps.lastEval.at) || null,
        status: ps.status || null,
        sources: [],
        userPrompts: [],
        shutdowns: [],
        usageSummary: null,
        lastEval: ps.lastEval ? { ...ps.lastEval, stdout: String(ps.lastEval.stdout || '').slice(-MAX_EVAL_TEXT), stderr: String(ps.lastEval.stderr || '').slice(-MAX_EVAL_TEXT) } : null,
      });
    }
  }
  phases.sort((a, b) => String(a.start || '9').localeCompare(String(b.start || '9')));
  const order = new Map(phases.map((p, i) => [p.runDir, i]));
  calls.sort((a, b) => (order.get(a.sessionId) - order.get(b.sessionId)) || a.index - b.index);
  calls.forEach((c, i) => {
    c.phaseIndex = c.index;
    c.index = i + 1;
    c.runDir = c.sessionId;
    c.systemPrompt = undefined;
  });
  for (const p of phases) {
    p.totals = totalsFor(calls.filter((c) => c.sessionId === p.sessionId));
    p.totals.billedPrompts = p.shutdowns && p.shutdowns.length ? sum(p.shutdowns, (s) => s.premiumRequests) : null;
    p.context = p.sessionId ? contexts[p.sessionId] || null : null;
  }

  // Repo: commits, per-phase files, call → commit links.
  const repo = opts.repo || def.cwd || null;
  const repoInfo = collectCommits(repo, phases, { loopName, withDiffs: opts.withDiffs });
  const commits = repoInfo.commits;
  for (const c of calls) {
    c.produced = [];
    for (const t of c.toolCalls || []) {
      for (const f of t.files || []) {
        const rel = relToRepo(repo, f.path);
        if (rel && !c.produced.some((x) => x.path === rel)) c.produced.push({ path: rel, kind: f.kind || null, commit: null });
      }
    }
    if (!c.produced.length) continue;
    const callMs = Date.parse(c.timestamp || '') || 0;
    for (const pr of c.produced) {
      const touches = (cm) => cm.files.some((f) => f.path === pr.path || f.from === pr.path);
      // Same-phase commit first (aflt commits once per passed phase); else the
      // first later commit touching the file when the call has a timestamp.
      const hit =
        commits.find((cm) => cm.phase === c.phase && touches(cm)) ||
        (callMs ? commits.find((cm) => Date.parse(cm.at) + 2000 >= callMs && touches(cm)) : null);
      if (hit) {
        pr.commit = hit.short;
        if (!hit.calls.includes(c.index)) hit.calls.push(c.index);
      }
    }
  }
  for (const p of phases) {
    const files = new Map();
    for (const cm of commits.filter((x) => x.phase === p.phase)) {
      for (const f of cm.files) {
        const cur = files.get(f.path) || { path: f.path, status: f.status, added: 0, removed: 0, commits: [], calls: [] };
        cur.status = cur.commits.length ? (cur.status === 'A' && f.status !== 'D' ? 'A' : f.status) : f.status;
        cur.added += f.added || 0;
        cur.removed += f.removed || 0;
        cur.commits.push(cm.short);
        files.set(f.path, cur);
      }
    }
    for (const c of calls.filter((x) => x.sessionId === p.sessionId)) {
      for (const pr of c.produced || []) {
        const cur = files.get(pr.path) || { path: pr.path, status: '?', added: null, removed: null, commits: [], calls: [], uncommitted: true };
        if (!cur.calls.includes(c.index)) cur.calls.push(c.index);
        files.set(pr.path, cur);
      }
    }
    for (const fp of (p.codeChanges && p.codeChanges.filesModified) || []) {
      const rel = relToRepo(repo, fp);
      if (rel && !files.has(rel)) files.set(rel, { path: rel, status: 'M', added: null, removed: null, commits: [], calls: [], uncommitted: true });
    }
    p.files = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    p.commits = commits.filter((x) => x.phase === p.phase).map((x) => x.short);
  }

  // Artifacts.
  const defDir = state.definitionPath ? path.dirname(state.definitionPath) : null;
  const seeds = collectSeedArtifacts(defDir, opts.seeds);
  const evalReports = [];
  if (repo) {
    const evalDir = path.join(repo, 'eval');
    for (const f of fs.existsSync(evalDir) ? walkFiles(evalDir, 50) : []) {
      const a = readArtifact(f, path.relative(repo, f), 'eval-report');
      if (a) evalReports.push(a);
    }
  }
  let finalTree = [];
  if (repo && repoInfo.head) {
    try {
      finalTree = git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
    } catch (_) {
      finalTree = [];
    }
  }

  const engines = [...new Set(phases.map((p) => p.engine).filter(Boolean))];
  const models = [...new Set(calls.map((c) => c.model).filter(Boolean))];
  const totals = totalsFor(calls);
  totals.billedPrompts = phases.some((p) => p.totals.billedPrompts != null) ? sum(phases, (p) => p.totals.billedPrompts) : null;
  const afltUsage = usage.mergeUsageSummaries(phases.map((p) => p.usageSummary).filter(Boolean));
  const onDiskUsage = usage.mergeUsageSummaries(phases.map((p) => p.usageSummaryOnDisk).filter(Boolean));
  const hasCopilot = engines.includes('copilot');
  if (engines.includes('cursor')) {
    gaps.push('Cursor: per-phase token totals come from aflt\'s usage summary (Cursor\'s own result usage when reported). Cursor records no cost, so no dollar figure is shown and none is estimated.');
  }
  const prs = [];
  return {
    v: CALLS_VERSION,
    kind: 'aflt-making-of',
    generatedAt: nowIso(),
    generator: 'aflt making-of',
    space: process.env.AFLT_SPACE || null,
    fleetDir: fleetDir(),
    run: {
      loop: loopName,
      displayName: def.displayName || loopName,
      engine: engines.join(' + ') || null,
      model: models.join(', ') || def.model || null,
      status: state.status || null,
      cwd: def.cwd || null,
      goal: def.goal || null,
      startedAt: state.startedAt || null,
      completedAt: state.completedAt || state.failedAt || state.stoppedAt || null,
      lastError: state.lastError || null,
      definitionPath: state.definitionPath || null,
    },
    pricing: hasCopilot
      ? { basis: 'recorded', text: `Costs are ${usage.COPILOT_PRICING.text}. Every figure is reported by Copilot itself; nothing is estimated.`, usdPerCredit: usage.COPILOT_PRICING.usdPerCredit }
      : { basis: 'none', text: 'Cursor reports tokens per run and no cost, so this page shows tokens only. No dollar figure is estimated.' },
    totals: {
      ...totals,
      aflt: afltUsage,
      afltOnDisk: onDiskUsage,
      afltNote: 'aflt usage summary, recomputed with headless-run de-duplication. "On disk" is the usage-summary.json written at run time; older runs double-counted turns there.',
    },
    phases,
    calls,
    repo: {
      path: repo,
      remote: repoInfo.remote,
      github: repoInfo.github,
      head: repoInfo.head,
      error: repoInfo.error || null,
      finalTree,
    },
    commits,
    prs,
    prsNote: repoInfo.remote
      ? `aflt opened no pull requests for this loop (allow.push is ${def.allow && def.allow.push ? 'true' : 'false'}). Remote: ${repoInfo.remote}`
      : 'No pull requests: this repo has no remote, so nothing could be pushed or opened as a PR.',
    artifacts: {
      seeds,
      evalReports,
      build: opts.buildUrl ? { url: opts.buildUrl, label: opts.buildLabel || 'Playable build' } : null,
    },
    links: opts.links || {},
    gaps,
  };
}

// ---------- 5. HTTP routes (aflt dashboard and aflt making-of --serve) ----------

function listLoopNames() {
  try {
    return fs
      .readdirSync(path.join(fleetDir(), 'loops'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(fleetDir(), 'loops', d.name, 'state.json')))
      .map((d) => d.name)
      .sort();
  } catch (_) {
    return [];
  }
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function isInside(child, parent) {
  try {
    const c = fs.realpathSync(child);
    const p = fs.realpathSync(parent);
    return c === p || c.startsWith(p + path.sep);
  } catch (_) {
    return false;
  }
}

/**
 * Serve /making-of routes. Returns true when the request was handled.
 *   /making-of                      index of loops in this space
 *   /making-of/<loop>               self-contained viewer page
 *   /making-of/<loop>.json          raw payload
 *   /making-of/<loop>/commit/<sha>  full `git show` of one run-repo commit
 *   /making-of/<loop>/file?path=P   a seed/eval artifact or a file in the run repo
 */
function handleMakingOfRequest(req, res, pathname, opts = {}) {
  if (pathname !== '/making-of' && !pathname.startsWith('/making-of/')) return false;
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    send(405, 'text/plain; charset=utf-8', 'Use GET.');
    return true;
  }
  const rest = pathname.replace(/^\/making-of\/?/, '');
  const back = opts.back || '/';
  if (!rest) {
    const loops = listLoopNames();
    const items = loops.map((n) => `<li><a href="/making-of/${encodeURIComponent(n)}">${escHtml(n)}</a></li>`).join('');
    send(200, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><title>Making of · aflt</title><body style="font:14px -apple-system,sans-serif;background:#0f1115;color:#e6e8ee;padding:24px"><h1>🎬 Making of</h1><p><a style="color:#7cc4ff" href="${escHtml(back)}">← dashboard</a></p><ul>${items || '<li>No loops in this space.</li>'}</ul></body>`);
    return true;
  }
  let parts;
  try {
    parts = rest.split('/').map((p) => decodeURIComponent(p));
  } catch (_) {
    send(400, 'text/plain; charset=utf-8', 'Bad path.');
    return true;
  }
  let loopName = parts[0];
  const asJson = parts.length === 1 && loopName.endsWith('.json');
  if (asJson) loopName = loopName.slice(0, -5);
  if (!/^[A-Za-z0-9._-]+$/.test(loopName) || !listLoopNames().includes(loopName)) {
    send(404, 'text/plain; charset=utf-8', `Unknown loop: ${loopName}`);
    return true;
  }
  const base = `/making-of/${encodeURIComponent(loopName)}`;
  const collect = (withDiffs) =>
    (opts.collect || collectLoop)(loopName, {
      ...(opts.collectOpts || {}),
      withDiffs,
      links: { back, backLabel: opts.backLabel || '← dashboard', diffBase: `${base}/commit/`, fileBase: `${base}/file?path=` },
    });
  try {
    if (parts.length === 1) {
      const data = collect(true);
      if (asJson) send(200, 'application/json; charset=utf-8', JSON.stringify(data));
      else send(200, 'text/html; charset=utf-8', require('./making-of-view').renderHtml(data));
      return true;
    }
    if (parts[1] === 'commit' && parts[2]) {
      const data = collect(false);
      const sha = parts[2];
      if (!data.repo.path || !data.commits.some((c) => c.sha === sha || c.short === sha)) {
        send(404, 'text/plain; charset=utf-8', 'Unknown commit for this loop.');
        return true;
      }
      send(200, 'text/plain; charset=utf-8', commitDiff(data.repo.path, sha, 16 * 1024 * 1024).text);
      return true;
    }
    if (parts[1] === 'file') {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const want = u.searchParams.get('path') || '';
      const data = collect(false);
      const known = [...data.artifacts.seeds, ...data.artifacts.evalReports].some((a) => a.path === want);
      const inRepo = data.repo.path && path.isAbsolute(want) && isInside(want, data.repo.path) && !want.split(path.sep).includes('.git');
      if (!want || !(known || inRepo) || !fs.existsSync(want) || !fs.statSync(want).isFile()) {
        send(404, 'text/plain; charset=utf-8', 'Not an artifact of this loop.');
        return true;
      }
      send(200, 'text/plain; charset=utf-8', fs.readFileSync(want));
      return true;
    }
    send(404, 'text/plain; charset=utf-8', 'Not found.');
  } catch (err) {
    send(500, 'text/plain; charset=utf-8', String((err && err.message) || err));
  }
  return true;
}

/**
 * Static export next to a written page: every commit's full diff and every
 * artifact (seed files, eval reports, files tracked at HEAD) as escaped HTML
 * files in `<page>-files/`, with data.links.diffMap / fileMap pointing at
 * them (relative URLs), so a static host can link everything without aflt.
 * Mutates and returns data.links; returns counts.
 */
function textPage(title, text, isDiff) {
  const body = String(text)
    .split('\n')
    .map((l) => {
      const e = escHtml(l);
      if (!isDiff) return e;
      if (/^(\+\+\+|---)/.test(l)) return `<b>${e}</b>`;
      if (l.startsWith('+')) return `<span class="a">${e}</span>`;
      if (l.startsWith('-')) return `<span class="d">${e}</span>`;
      if (l.startsWith('@@')) return `<span class="h">${e}</span>`;
      return e;
    })
    .join('\n');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escHtml(title)}</title>` +
    '<style>body{margin:0;background:#0f1115;color:#e6e8ee;font:13px ui-monospace,Menlo,monospace}h1{font:600 14px -apple-system,sans-serif;padding:10px 14px;margin:0;border-bottom:1px solid #262a33}' +
    'pre{margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word}.a{color:#7ee787}.d{color:#ff7b72}.h{color:#79c0ff}</style></head>' +
    `<body><h1>${escHtml(title)}</h1><pre>${body}</pre></body></html>\n`
  );
}

function exportFiles(data, outHtml, opts = {}) {
  const maxFileBytes = opts.maxFileBytes || 2 * 1024 * 1024;
  const dirName = `${path.basename(outHtml).replace(/\.html?$/i, '')}-files`;
  const dir = path.join(path.dirname(outHtml), dirName);
  const rel = (...p) => [dirName, ...p].map((s) => s.split('/').map(encodeURIComponent).join('/')).join('/');
  const safe = (p) =>
    p
      .split(/[\\/]+/)
      .filter((s) => s && s !== '.' && s !== '..')
      .join('/');
  const diffMap = {};
  const fileMap = {};
  let diffs = 0;
  let files = 0;
  const repo = data.repo && data.repo.path;
  if (repo) {
    for (const c of data.commits || []) {
      let d;
      try {
        d = commitDiff(repo, c.sha, 16 * 1024 * 1024);
      } catch (_) {
        continue;
      }
      const f = path.join(dir, 'commit', `${c.sha}.diff.html`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, textPage(`${c.short} ${c.subject}`, d.text, true));
      diffMap[c.sha] = rel('commit', `${c.sha}.diff.html`);
      diffMap[c.short] = diffMap[c.sha];
      diffs += 1;
    }
  }
  const put = (abs, key) => {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > maxFileBytes) return;
      const k = `${safe(key)}.html`;
      const f = path.join(dir, ...k.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const buf = fs.readFileSync(abs);
      const text = buf.includes(0) ? `(binary file, ${buf.length} bytes; not shown)` : buf.toString('utf8');
      fs.writeFileSync(f, textPage(abs, text, false));
      fileMap[abs] = rel(...k.split('/'));
      files += 1;
    } catch (_) {
      /* skip unreadable */
    }
  };
  const A = data.artifacts || {};
  for (const a of A.seeds || []) put(a.path, `seed/${a.label || path.basename(a.path)}`);
  for (const a of A.evalReports || []) put(a.path, `eval/${a.label || path.basename(a.path)}`);
  if (repo) {
    for (const f of (data.repo && data.repo.finalTree) || []) put(path.join(repo, f), `repo/${f}`);
  }
  data.links = { ...(data.links || {}), diffMap, fileMap, filesDir: dir };
  delete data.links.diffBase;
  delete data.links.fileBase;
  return { dir, diffs, files };
}

// ---------- read-only cost totals for dashboards ----------

const _costCache = new Map();

function statSig(file) {
  try {
    const st = fs.statSync(file);
    return st.size + ':' + st.mtimeMs;
  } catch (_) {
    return '-';
  }
}

/**
 * Per-call token and credit totals for one session, from the same records the
 * making-of page uses (archived engine logs, Copilot's live events.jsonl, or
 * calls.jsonl). Read-only (never writes calls.jsonl) and cached on the
 * source files' size + mtime, so dashboard polling stays cheap.
 * Returns null for sessions with no per-call cost source (Cursor/OpenCode
 * report no cost) or nothing recorded.
 * @returns {{ calls:number, callsWithCost:number, credits:number|null, usd:number|null,
 *   tokensIn:number, tokensOut:number, totalTokens:number, costBasis:string|null }|null}
 */
function sessionCostTotals(sessionId, opts = {}) {
  if (!isSafeId(sessionId)) return null;
  const env = opts.env || process.env;
  const dir = runDir(sessionId);
  const turnsFile = path.join(dir, 'turns.jsonl');
  const callsFile = path.join(dir, CALLS_FILE);
  const key = dir;
  const cached = _costCache.get(key);
  const turnsSig = statSig(turnsFile);
  let chatIds;
  let engine;
  if (cached && cached.turnsSig === turnsSig) {
    chatIds = cached.chatIds;
    engine = cached.engine;
  } else {
    const turns = readJsonl(turnsFile);
    engine = (turns.find((t) => t && t.engine) || {}).engine || null;
    chatIds = [...new Set(turns.map((t) => t && t.chatId).filter(Boolean))];
  }
  const hasCalls = fs.existsSync(callsFile);
  if (engine !== 'copilot' && !hasCalls) {
    _costCache.set(key, { turnsSig, chatIds, engine, sig: null, value: null });
    return null;
  }
  const sigParts = [turnsSig, statSig(callsFile)];
  for (const f of listEngineFiles(sessionId)) sigParts.push(f + '=' + statSig(path.join(engineDir(sessionId), f)));
  if (engine === 'copilot') {
    for (const c of chatIds) {
      if (isSafeId(c)) sigParts.push(c + '=' + statSig(path.join(copilotStateRoot(env), c, 'events.jsonl')));
    }
  }
  const sig = sigParts.join('|');
  if (cached && cached.sig === sig) return cached.value;
  let value = null;
  try {
    const rec = buildSessionRecord(sessionId, { env, engine: engine || undefined });
    if (rec.calls.length) {
      const t = totalsFor(rec.calls);
      value = {
        calls: t.calls,
        callsWithCost: t.callsWithCost,
        credits: t.credits,
        usd: t.usd,
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
        totalTokens: t.tokensIn + t.tokensOut,
        costBasis: t.credits != null ? usage.COPILOT_PRICING.basis : null,
      };
    }
  } catch (_) {
    value = null;
  }
  _costCache.set(key, { turnsSig, chatIds, engine, sig, value });
  return value;
}

/**
 * Read-only credits fallback for a session usage summary: when the summary
 * (usage-summary.json / turns) has no credits but the session's per-call
 * usage records do (Copilot runs synced before credits were recorded), return
 * a copy with credits / usd / costBasis from those records. Never writes.
 */
function withPerCallCredits(summary, sessionId, opts = {}) {
  if (!summary || typeof summary !== 'object' || summary.credits != null || !sessionId) return summary;
  let t = null;
  try {
    t = sessionCostTotals(sessionId, opts);
  } catch (_) {
    t = null;
  }
  if (!t || t.credits == null) return summary;
  return { ...summary, credits: t.credits, usd: t.usd, costBasis: t.costBasis, creditsSource: 'per-call' };
}

/** Sum sessionCostTotals over several sessions (a loop's phases). */
function costTotalsForSessions(sessionIds, opts = {}) {
  let out = null;
  for (const id of [...new Set((sessionIds || []).filter(Boolean))]) {
    const t = sessionCostTotals(id, opts);
    if (!t) continue;
    if (!out) out = { calls: 0, callsWithCost: 0, credits: null, usd: null, tokensIn: 0, tokensOut: 0, totalTokens: 0, costBasis: null, sessions: 0 };
    out.sessions += 1;
    out.calls += t.calls;
    out.callsWithCost += t.callsWithCost;
    out.tokensIn += t.tokensIn;
    out.tokensOut += t.tokensOut;
    out.totalTokens += t.totalTokens;
    if (t.credits != null) out.credits = (out.credits || 0) + t.credits;
    if (t.usd != null) out.usd = (out.usd || 0) + t.usd;
    if (t.costBasis) out.costBasis = t.costBasis;
  }
  return out;
}

module.exports = {
  CALLS_VERSION,
  sessionCostTotals,
  costTotalsForSessions,
  withPerCallCredits,
  exportFiles,
  CALLS_FILE,
  CONTEXT_FILE,
  ENGINE_DIR,
  runDir,
  engineDir,
  parseJsonl,
  archiveCopilotSession,
  saveCursorStream,
  archiveCursorTranscript,
  archivePhaseRecord,
  parseCopilotEvents,
  parseCursorStream,
  parseCursorTranscript,
  filesFromPatch,
  filesFromToolArgs,
  buildSessionRecord,
  writeSessionCalls,
  recordPhase,
  totalsFor,
  collectCommits,
  commitDiff,
  collectSeedArtifacts,
  collectLoop,
  githubBase,
  isGitRepo,
  listLoopNames,
  handleMakingOfRequest,
};
