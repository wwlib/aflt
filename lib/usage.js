'use strict';

/**
 * Token-usage normalization + session rollups.
 *
 * Engines report cache differently:
 *   - Cursor: inputTokens is UNCACHED; cacheRead/cacheWrite are separate.
 *   - Copilot: inputTokens is CACHE-INCLUSIVE; uncached = input − cacheRead − cacheWrite.
 *   - OpenCode: tokens.input is uncached; cache.read/write separate; tokens.total = input+output.
 *
 * Never invent USD cost from tokens — only pass through provider-reported cost.
 * Copilot premiumRequests stay in their own field (not cost).
 *
 * Copilot also reports AI credits per model call (copilotUsage.totalNanoAiu,
 * 1e9 nano-AIU = 1 credit). `credits` keeps that number; `usd` converts it at
 * the published credit price and `costBasis` says how (see COPILOT_PRICING).
 */

/** Copilot AI-credit pricing basis (GitHub: 1 AI credit = $0.01). */
const COPILOT_PRICING = Object.freeze({
  basis: 'copilot-nano-aiu',
  nanoAiuPerCredit: 1e9,
  usdPerCredit: 0.01,
  text: 'Copilot CLI per-call usage records (copilotUsage.totalNanoAiu; 1e9 nano-AIU = 1 AI credit; 1 credit = $0.01)',
});

/** Convert Copilot nano-AIU to { credits, usd }. */
function creditsFromNanoAiu(nano) {
  const n = asNonNegNumber(nano);
  if (n == null) return { credits: null, usd: null };
  const credits = n / COPILOT_PRICING.nanoAiuPerCredit;
  return { credits, usd: credits * COPILOT_PRICING.usdPerCredit };
}

const USAGE_VERSION = 1;

const ACCURACY = Object.freeze({
  reported: 'reported',
  estimated: 'estimated',
  partial: 'partial',
});

const SOURCES = Object.freeze([
  'cursor-result',
  'cursor-transcript',
  'cursor-hook',
  'copilot-usage-record',
  'copilot-usage-checkpoint',
  'copilot-shutdown',
  'copilot-result',
  'opencode-run-json',
  'opencode-db',
  'opencode-export',
  'estimated-chars',
  'unknown',
]);

const CLIS = Object.freeze(['cursor', 'copilot', 'opencode', 'unknown']);

function asNonNegInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function asNonNegNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function asFiniteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function asStringOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function promptToResponseRatio(totalInput, outputTokens) {
  const out = asNonNegInt(outputTokens);
  const inn = asNonNegInt(totalInput);
  if (out == null || out <= 0 || inn == null) return null;
  return Math.round((inn / out) * 100) / 100;
}

function emptyUsage(overrides = {}) {
  return {
    v: USAGE_VERSION,
    accuracy: overrides.accuracy || ACCURACY.reported,
    source: overrides.source || 'unknown',
    cli: overrides.cli || 'unknown',
    model: overrides.model != null ? asStringOrNull(overrides.model) : null,
    inputTokens: null,
    cacheRead: null,
    cacheWrite: null,
    totalInput: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    promptToResponse: null,
    cost: null,
    premiumRequests: null,
    credits: null,
    usd: null,
    costBasis: null,
    durationMs: null,
    requestId: null,
  };
}

/**
 * Finalize derived fields (totalInput / totalTokens / promptToResponse) when
 * callers set the component fields.
 */
function finalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const out = { ...usage, v: USAGE_VERSION };
  if (!SOURCES.includes(out.source)) out.source = 'unknown';
  if (!CLIS.includes(out.cli)) out.cli = 'unknown';
  if (!Object.values(ACCURACY).includes(out.accuracy)) out.accuracy = ACCURACY.reported;

  out.model = asStringOrNull(out.model);
  out.inputTokens = asNonNegInt(out.inputTokens);
  out.cacheRead = asNonNegInt(out.cacheRead);
  out.cacheWrite = asNonNegInt(out.cacheWrite);
  out.outputTokens = asNonNegInt(out.outputTokens);
  out.reasoningTokens = asNonNegInt(out.reasoningTokens);
  out.cost = asFiniteNumber(out.cost);
  out.premiumRequests = asNonNegNumber(out.premiumRequests);
  out.credits = asNonNegNumber(out.credits);
  out.usd = asNonNegNumber(out.usd);
  out.costBasis = out.credits != null || out.usd != null ? asStringOrNull(out.costBasis) : null;
  out.durationMs = asNonNegInt(out.durationMs);
  out.requestId = asStringOrNull(out.requestId);

  if (out.totalInput == null) {
    if (out.inputTokens != null || out.cacheRead != null || out.cacheWrite != null) {
      out.totalInput =
        (out.inputTokens || 0) + (out.cacheRead || 0) + (out.cacheWrite || 0);
    } else {
      out.totalInput = null;
    }
  } else {
    out.totalInput = asNonNegInt(out.totalInput);
  }

  if (out.totalTokens == null) {
    if (out.totalInput != null || out.outputTokens != null) {
      out.totalTokens = (out.totalInput || 0) + (out.outputTokens || 0);
    } else {
      out.totalTokens = null;
    }
  } else {
    out.totalTokens = asNonNegInt(out.totalTokens);
  }

  out.promptToResponse = promptToResponseRatio(out.totalInput, out.outputTokens);
  return out;
}

/**
 * True when every numeric token field is 0/null — typical OpenCode error rows.
 */
function isAllZeroTokens(usage) {
  if (!usage) return true;
  const fields = [
    usage.inputTokens,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalInput,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.totalTokens,
  ];
  const present = fields.filter((v) => v != null);
  if (!present.length) return true;
  return present.every((v) => Number(v) === 0);
}

/**
 * Cursor CLI result.usage — inputTokens is UNCACHED.
 * Live sample (2026.11.19):
 *   { inputTokens:6187, outputTokens:40, cacheReadTokens:3968,
 *     cacheWriteTokens:0, reasoningTokens:39 }
 */
function normalizeCursorUsage(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const inputTokens = asNonNegInt(raw.inputTokens);
  const outputTokens = asNonNegInt(raw.outputTokens);
  const cacheRead = asNonNegInt(
    raw.cacheReadTokens != null ? raw.cacheReadTokens : raw.cacheRead
  );
  const cacheWrite = asNonNegInt(
    raw.cacheWriteTokens != null ? raw.cacheWriteTokens : raw.cacheWrite
  );
  const reasoningTokens = asNonNegInt(raw.reasoningTokens);
  if (
    inputTokens == null &&
    outputTokens == null &&
    cacheRead == null &&
    cacheWrite == null &&
    reasoningTokens == null
  ) {
    return null;
  }
  const totalInput =
    (inputTokens || 0) + (cacheRead || 0) + (cacheWrite || 0);
  return finalizeUsage({
    ...emptyUsage({
      accuracy: meta.accuracy || ACCURACY.reported,
      source: meta.source || 'cursor-result',
      cli: 'cursor',
      model: meta.model != null ? meta.model : null,
    }),
    inputTokens: inputTokens != null ? inputTokens : 0,
    cacheRead: cacheRead != null ? cacheRead : 0,
    cacheWrite: cacheWrite != null ? cacheWrite : 0,
    totalInput,
    outputTokens: outputTokens != null ? outputTokens : 0,
    reasoningTokens: reasoningTokens != null ? reasoningTokens : null,
    durationMs: asNonNegInt(meta.durationMs != null ? meta.durationMs : raw.duration_ms),
    requestId: asStringOrNull(meta.requestId != null ? meta.requestId : raw.request_id),
  });
}

/**
 * Copilot usage — inputTokens is CACHE-INCLUSIVE.
 * Live sample (session.usage_record data.usage):
 *   { model, inputTokens:16130, outputTokens:56, cacheReadTokens:0,
 *     cacheWriteTokens:16120, reasoningTokens:49, cost:0.33, duration:1008 }
 * cost here is premiumRequests, NOT USD.
 */
function normalizeCopilotUsage(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const totalInput = asNonNegInt(raw.inputTokens);
  const outputTokens = asNonNegInt(raw.outputTokens);
  const cacheRead = asNonNegInt(
    raw.cacheReadTokens != null ? raw.cacheReadTokens : raw.cacheRead
  );
  const cacheWrite = asNonNegInt(
    raw.cacheWriteTokens != null ? raw.cacheWriteTokens : raw.cacheWrite
  );
  const reasoningTokens = asNonNegInt(raw.reasoningTokens);
  if (
    totalInput == null &&
    outputTokens == null &&
    cacheRead == null &&
    cacheWrite == null &&
    reasoningTokens == null
  ) {
    // result.usage often only has premiumRequests — still useful as partial.
    const premiumOnly = asNonNegNumber(
      meta.premiumRequests != null
        ? meta.premiumRequests
        : raw.cost != null
          ? raw.cost
          : raw.premiumRequests != null
            ? raw.premiumRequests
            : meta.totalPremiumRequests
    );
    if (premiumOnly == null && meta.durationMs == null && raw.totalApiDurationMs == null) {
      return null;
    }
    return finalizeUsage({
      ...emptyUsage({
        accuracy: meta.accuracy || ACCURACY.partial,
        source: meta.source || 'copilot-result',
        cli: 'copilot',
        model: meta.model != null ? meta.model : raw.model,
      }),
      premiumRequests: premiumOnly,
      durationMs: asNonNegInt(
        meta.durationMs != null
          ? meta.durationMs
          : raw.totalApiDurationMs != null
            ? raw.totalApiDurationMs
            : raw.duration
      ),
      cost: null,
    });
  }

  const cr = cacheRead != null ? cacheRead : 0;
  const cw = cacheWrite != null ? cacheWrite : 0;
  const ti = totalInput != null ? totalInput : 0;
  const inputTokens = Math.max(0, ti - cr - cw);
  const premiumRequests = asNonNegNumber(
    meta.premiumRequests != null
      ? meta.premiumRequests
      : raw.cost != null
        ? raw.cost
        : raw.premiumRequests != null
          ? raw.premiumRequests
          : meta.totalPremiumRequests
  );
  const credits = asNonNegNumber(meta.credits != null ? meta.credits : raw.credits);
  const priced = credits != null
    ? { credits, usd: credits * COPILOT_PRICING.usdPerCredit, costBasis: COPILOT_PRICING.basis }
    : {};

  return finalizeUsage({
    ...emptyUsage({
      accuracy: meta.accuracy || ACCURACY.reported,
      source: meta.source || 'copilot-usage-record',
      cli: 'copilot',
      model: meta.model != null ? meta.model : raw.model,
    }),
    inputTokens,
    cacheRead: cr,
    cacheWrite: cw,
    totalInput: ti,
    outputTokens: outputTokens != null ? outputTokens : 0,
    reasoningTokens: reasoningTokens != null ? reasoningTokens : null,
    cost: null,
    premiumRequests,
    durationMs: asNonNegInt(
      meta.durationMs != null
        ? meta.durationMs
        : raw.duration != null
          ? raw.duration
          : raw.totalApiDurationMs
    ),
    requestId: asStringOrNull(meta.requestId),
    ...priced,
  });
}

/**
 * Sum Copilot modelMetrics / providerModelMetrics maps into one usage blob.
 * Values look like { inputTokens, outputTokens, cacheReadTokens, … }.
 */
function sumCopilotModelMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let cost = 0;
  let duration = 0;
  let model = null;
  let any = false;
  for (const [key, val] of Object.entries(metrics)) {
    if (!val || typeof val !== 'object') continue;
    any = true;
    if (!model) model = key;
    inputTokens += asNonNegInt(val.inputTokens) || 0;
    outputTokens += asNonNegInt(val.outputTokens) || 0;
    cacheReadTokens +=
      asNonNegInt(val.cacheReadTokens != null ? val.cacheReadTokens : val.cacheRead) || 0;
    cacheWriteTokens +=
      asNonNegInt(val.cacheWriteTokens != null ? val.cacheWriteTokens : val.cacheWrite) || 0;
    reasoningTokens += asNonNegInt(val.reasoningTokens) || 0;
    if (val.cost != null) cost += asNonNegNumber(val.cost) || 0;
    if (val.duration != null) duration += asNonNegInt(val.duration) || 0;
  }
  if (!any) return null;
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    cost: cost || null,
    duration: duration || null,
  };
}

/**
 * Delta between two Copilot modelMetrics snapshots (checkpoint / shutdown).
 */
function deltaCopilotModelMetrics(after, before) {
  const a = sumCopilotModelMetrics(after);
  if (!a) return null;
  const b = sumCopilotModelMetrics(before) || {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    duration: 0,
  };
  return {
    model: a.model,
    inputTokens: Math.max(0, (a.inputTokens || 0) - (b.inputTokens || 0)),
    outputTokens: Math.max(0, (a.outputTokens || 0) - (b.outputTokens || 0)),
    cacheReadTokens: Math.max(0, (a.cacheReadTokens || 0) - (b.cacheReadTokens || 0)),
    cacheWriteTokens: Math.max(0, (a.cacheWriteTokens || 0) - (b.cacheWriteTokens || 0)),
    reasoningTokens: Math.max(0, (a.reasoningTokens || 0) - (b.reasoningTokens || 0)),
    cost:
      a.cost != null || b.cost != null
        ? Math.max(0, (a.cost || 0) - (b.cost || 0))
        : null,
    duration:
      a.duration != null || b.duration != null
        ? Math.max(0, (a.duration || 0) - (b.duration || 0))
        : null,
  };
}

/**
 * OpenCode tokens — input is uncached; cache separate; total usually = input+output.
 * Live sample (step_finish):
 *   { total:6788, input:6753, output:35, reasoning:0, cache:{write:0,read:0} }
 * cost:0 is real reported monetary cost (keep as 0, not null).
 */
function normalizeOpenCodeUsage(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;
  // Accept either { tokens, cost } or a bare tokens object.
  const tokens =
    raw.tokens && typeof raw.tokens === 'object'
      ? raw.tokens
      : raw.input != null || raw.output != null || raw.total != null
        ? raw
        : null;
  if (!tokens) {
    if (raw.cost == null && meta.cost == null) return null;
  }
  const cache = (tokens && tokens.cache) || raw.cache || {};
  const inputTokens = asNonNegInt(tokens && tokens.input);
  const outputTokens = asNonNegInt(tokens && tokens.output);
  const cacheRead = asNonNegInt(cache.read != null ? cache.read : cache.cache_read);
  const cacheWrite = asNonNegInt(cache.write != null ? cache.write : cache.cache_write);
  const reasoningTokens = asNonNegInt(tokens && tokens.reasoning);
  const reportedTotal = asNonNegInt(tokens && tokens.total);
  const cost = asFiniteNumber(meta.cost != null ? meta.cost : raw.cost);

  const usage = finalizeUsage({
    ...emptyUsage({
      accuracy: meta.accuracy || ACCURACY.reported,
      source: meta.source || 'opencode-run-json',
      cli: 'opencode',
      model: meta.model != null ? meta.model : raw.model,
    }),
    inputTokens: inputTokens != null ? inputTokens : 0,
    cacheRead: cacheRead != null ? cacheRead : 0,
    cacheWrite: cacheWrite != null ? cacheWrite : 0,
    totalInput:
      (inputTokens || 0) + (cacheRead || 0) + (cacheWrite || 0),
    outputTokens: outputTokens != null ? outputTokens : 0,
    reasoningTokens: reasoningTokens != null ? reasoningTokens : 0,
    totalTokens:
      reportedTotal != null
        ? reportedTotal
        : (inputTokens || 0) +
          (cacheRead || 0) +
          (cacheWrite || 0) +
          (outputTokens || 0),
    cost,
    durationMs: asNonNegInt(meta.durationMs),
    requestId: asStringOrNull(meta.requestId),
  });

  // Errored/failed OpenCode runs store all zeros — do not mark as reported.
  if (isAllZeroTokens(usage) && (cost == null || cost === 0)) {
    if (meta.allowZero) return usage;
    return null;
  }
  return usage;
}

/**
 * OpenCode session row columns: tokens_input / tokens_output / …
 */
function normalizeOpenCodeSessionColumns(row, meta = {}) {
  if (!row || typeof row !== 'object') return null;
  const tokens = {
    input: row.tokens_input != null ? row.tokens_input : row.tokensInput,
    output: row.tokens_output != null ? row.tokens_output : row.tokensOutput,
    reasoning: row.tokens_reasoning != null ? row.tokens_reasoning : row.tokensReasoning,
    total: null,
    cache: {
      read: row.tokens_cache_read != null ? row.tokens_cache_read : row.cache_read,
      write: row.tokens_cache_write != null ? row.tokens_cache_write : row.cache_write,
    },
  };
  if (tokens.input == null && tokens.output == null) return null;
  tokens.total =
    (asNonNegInt(tokens.input) || 0) + (asNonNegInt(tokens.output) || 0);
  return normalizeOpenCodeUsage(
    { tokens, cost: row.cost },
    { ...meta, source: meta.source || 'opencode-db' }
  );
}

/**
 * Fallback chars/4 estimation when engines do not report tokens.
 */
function estimateUsageFromText({ prompt, reply, cli, model, accuracy } = {}) {
  const promptStr = prompt != null ? String(prompt) : '';
  const replyStr = reply != null ? String(reply) : '';
  const inputTokens = promptStr.length ? Math.ceil(promptStr.length / 4) : null;
  const outputTokens = replyStr.length ? Math.ceil(replyStr.length / 4) : null;
  if (inputTokens == null && outputTokens == null) return null;
  return finalizeUsage({
    ...emptyUsage({
      accuracy: accuracy === ACCURACY.partial ? ACCURACY.partial : ACCURACY.estimated,
      source: 'estimated-chars',
      cli: CLIS.includes(cli) ? cli : 'unknown',
      model: model != null ? model : null,
    }),
    inputTokens: inputTokens != null ? inputTokens : 0,
    cacheRead: null,
    cacheWrite: null,
    totalInput: inputTokens != null ? inputTokens : 0,
    outputTokens: outputTokens != null ? outputTokens : 0,
    reasoningTokens: null,
  });
}

/**
 * Normalize a usage-ish object already close to the schema, or from mixed sources.
 */
function normalizeUsage(raw, meta = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v === USAGE_VERSION && raw.accuracy && raw.source && raw.cli) {
    return finalizeUsage(raw);
  }
  const cli = meta.cli || raw.cli || 'unknown';
  if (cli === 'cursor' || meta.source === 'cursor-result' || raw.cacheReadTokens != null) {
    // Heuristic: Cursor-shaped when cacheReadTokens present AND cli isn't copilot.
    if (cli === 'copilot') {
      return normalizeCopilotUsage(raw, meta);
    }
    if (cli === 'opencode') {
      return normalizeOpenCodeUsage(raw, meta);
    }
    if (cli === 'cursor' || meta.source === 'cursor-result' || meta.source === 'cursor-transcript') {
      return normalizeCursorUsage(raw, meta);
    }
  }
  if (cli === 'copilot' || String(meta.source || '').startsWith('copilot')) {
    return normalizeCopilotUsage(raw, meta);
  }
  if (cli === 'opencode' || String(meta.source || '').startsWith('opencode')) {
    return normalizeOpenCodeUsage(raw, meta);
  }
  // Generic pass-through for already-normalized-ish objects.
  return finalizeUsage({
    ...emptyUsage(meta),
    ...raw,
    accuracy: raw.accuracy || meta.accuracy || ACCURACY.reported,
    source: raw.source || meta.source || 'unknown',
    cli: raw.cli || meta.cli || 'unknown',
  });
}

/**
 * Accuracy rank for upgrade decisions: estimated < partial < reported.
 */
function accuracyRank(accuracy) {
  if (accuracy === ACCURACY.reported) return 3;
  if (accuracy === ACCURACY.partial) return 2;
  if (accuracy === ACCURACY.estimated) return 1;
  return 0;
}

/**
 * Whether `incoming` should replace `existing` usage on a turn.
 * Never overwrite reported with estimated; upgrade estimated → reported.
 * Same accuracy is normally a no-op, except a richer estimated (more tokens /
 * non-zero output) may replace a sparse estimated (e.g. prompt-only, 0 output
 * after a resource_exhausted exit) — still never invents `reported`.
 */
function shouldReplaceUsage(existing, incoming) {
  if (!incoming) return false;
  if (!existing) return true;
  const inRank = accuracyRank(incoming.accuracy);
  const exRank = accuracyRank(existing.accuracy);
  if (inRank > exRank) return true;
  if (inRank < exRank) return false;
  if (
    existing.accuracy === ACCURACY.estimated &&
    incoming.accuracy === ACCURACY.estimated
  ) {
    const exOut = existing.outputTokens || 0;
    const inOut = incoming.outputTokens || 0;
    const exTot = existing.totalTokens || 0;
    const inTot = incoming.totalTokens || 0;
    if (exOut === 0 && inOut > 0) return true;
    if (inTot > exTot) return true;
  }
  return false;
}

/**
 * Pick the more trustworthy usage blob before it is stored.
 * Higher accuracy wins. Same accuracy keeps the larger token total so a
 * Copilot events.jsonl record can replace a smaller stdout fragment.
 */
function preferRicherUsage(current, incoming) {
  if (!incoming) return current || null;
  if (!current) return incoming;
  const inRank = accuracyRank(incoming.accuracy);
  const exRank = accuracyRank(current.accuracy);
  if (inRank > exRank) return incoming;
  if (inRank < exRank) return current;
  if ((incoming.totalTokens || 0) > (current.totalTokens || 0)) return incoming;
  return current;
}

function sumNullable(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

const HEADLESS_TURN_SOURCE = 'headless-run';

/**
 * Indexes of turn records whose usage is already inside a headless run's usage.
 *
 * A headless run (`aflt run` / a loop phase) records one `headless-run` turn
 * whose usage covers the whole engine invocation. Ingesting the engine's own
 * log afterwards (Copilot events.jsonl, Cursor transcripts) records the same
 * work again as per-message turns. Summing both double-counts. A non-headless
 * turn is "covered" when the latest headless-run turn on the same chat that
 * started at or before it carries non-estimated usage.
 *
 * @param {object[]} turns
 * @returns {Set<number>}
 */
function coveredTurnIndexes(turns) {
  const list = Array.isArray(turns) ? turns : [];
  const covered = new Set();
  const runsByChat = new Map();
  list.forEach((t, i) => {
    if (!t || t.source !== HEADLESS_TURN_SOURCE || !t.chatId) return;
    const ms = Date.parse(t.at);
    if (!Number.isFinite(ms)) return;
    if (!runsByChat.has(t.chatId)) runsByChat.set(t.chatId, []);
    runsByChat.get(t.chatId).push({ i, ms, usage: t.usage || null });
  });
  for (const runs of runsByChat.values()) runs.sort((a, b) => a.ms - b.ms);
  list.forEach((t, i) => {
    if (!t || !t.usage || t.source === HEADLESS_TURN_SOURCE || !t.chatId) return;
    const runs = runsByChat.get(t.chatId);
    if (!runs) return;
    const ms = Date.parse(t.at);
    if (!Number.isFinite(ms)) return;
    let owner = null;
    for (const r of runs) {
      if (r.ms <= ms) owner = r;
      else break;
    }
    if (!owner || !owner.usage) return;
    if (owner.usage.accuracy === ACCURACY.estimated) return;
    if (accuracyRank(t.usage.accuracy) > accuracyRank(owner.usage.accuracy)) return;
    covered.add(i);
  });
  return covered;
}

/**
 * Session rollup over turn records (each may have `.usage`).
 * Turns already covered by a headless run's usage are skipped (see
 * coveredTurnIndexes) and counted in `dedupedTurns`.
 */
function summarizeSessionUsage(turns, opts = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const covered = opts.dedupe === false ? new Set() : coveredTurnIndexes(list);
  let dedupedTurns = 0;
  let credits = null;
  let usd = null;
  const costBases = new Set();
  let totalInput = null;
  let inputTokens = null;
  let cacheRead = null;
  let cacheWrite = null;
  let outputTokens = null;
  let reasoningTokens = null;
  let totalTokens = null;
  let cost = null;
  let premiumRequests = null;
  let turnCount = 0;
  let reportedTurns = 0;
  let estimatedTurns = 0;
  let partialTurns = 0;
  const models = new Set();
  const clis = new Set();

  for (let idx = 0; idx < list.length; idx += 1) {
    const turn = list[idx];
    const u = turn && turn.usage ? turn.usage : turn;
    if (!u || typeof u !== 'object') continue;
    if (u.inputTokens == null && u.totalInput == null && u.outputTokens == null && u.cost == null && u.premiumRequests == null) {
      continue;
    }
    if (covered.has(idx)) {
      dedupedTurns += 1;
      continue;
    }
    if (u.credits != null) credits = sumNullable(credits, u.credits);
    if (u.usd != null) usd = sumNullable(usd, u.usd);
    if (u.costBasis) costBases.add(String(u.costBasis));
    turnCount += 1;
    if (u.accuracy === ACCURACY.estimated) estimatedTurns += 1;
    else if (u.accuracy === ACCURACY.partial) partialTurns += 1;
    else reportedTurns += 1;
    if (u.model) models.add(String(u.model));
    if (u.cli && u.cli !== 'unknown') clis.add(String(u.cli));

    totalInput = sumNullable(totalInput, u.totalInput);
    inputTokens = sumNullable(inputTokens, u.inputTokens);
    cacheRead = sumNullable(cacheRead, u.cacheRead);
    cacheWrite = sumNullable(cacheWrite, u.cacheWrite);
    outputTokens = sumNullable(outputTokens, u.outputTokens);
    reasoningTokens = sumNullable(reasoningTokens, u.reasoningTokens);
    totalTokens = sumNullable(totalTokens, u.totalTokens);
    if (u.cost != null) cost = sumNullable(cost, u.cost);
    if (u.premiumRequests != null) {
      premiumRequests = sumNullable(premiumRequests, u.premiumRequests);
    }
  }

  let accuracy = ACCURACY.reported;
  if (turnCount === 0) accuracy = ACCURACY.reported;
  else if (estimatedTurns === turnCount) accuracy = ACCURACY.estimated;
  else if (reportedTurns === turnCount) accuracy = ACCURACY.reported;
  else accuracy = ACCURACY.partial;

  let cli = 'unknown';
  if (clis.size === 1) cli = Array.from(clis)[0];
  else if (clis.size > 1) cli = 'unknown';

  return {
    v: USAGE_VERSION,
    totalInput,
    inputTokens,
    cacheRead,
    cacheWrite,
    outputTokens,
    reasoningTokens,
    totalTokens:
      totalTokens != null
        ? totalTokens
        : totalInput != null || outputTokens != null
          ? (totalInput || 0) + (outputTokens || 0)
          : null,
    promptToResponse: promptToResponseRatio(totalInput, outputTokens),
    cost,
    premiumRequests,
    credits,
    usd,
    costBasis: credits != null || usd != null ? Array.from(costBases).sort().join(',') || null : null,
    turnCount,
    reportedTurns,
    estimatedTurns,
    partialTurns,
    dedupedTurns,
    accuracy,
    cli,
    models: Array.from(models).sort(),
    updatedAt: opts.updatedAt || new Date().toISOString(),
  };
}

/**
 * Compact rollup suitable for memory / dashboard project nodes.
 */
function compactUsageSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  if (!summary.turnCount && summary.totalTokens == null && summary.totalInput == null) {
    return null;
  }
  const out = {
    v: USAGE_VERSION,
    totalTokens: summary.totalTokens != null ? summary.totalTokens : null,
    totalInput: summary.totalInput != null ? summary.totalInput : null,
    inputTokens: summary.inputTokens != null ? summary.inputTokens : null,
    cacheRead: summary.cacheRead != null ? summary.cacheRead : null,
    cacheWrite: summary.cacheWrite != null ? summary.cacheWrite : null,
    outputTokens: summary.outputTokens != null ? summary.outputTokens : null,
    reasoningTokens: summary.reasoningTokens != null ? summary.reasoningTokens : null,
    promptToResponse: summary.promptToResponse != null ? summary.promptToResponse : null,
    accuracy: summary.accuracy || ACCURACY.reported,
    cli: summary.cli || 'unknown',
    models: Array.isArray(summary.models) ? summary.models.slice() : [],
    turnCount: summary.turnCount || 0,
    reportedTurns: Number(summary.reportedTurns) || 0,
    estimatedTurns: Number(summary.estimatedTurns) || 0,
    partialTurns: Number(summary.partialTurns) || 0,
  };
  // If a compact payload omitted the breakdown, infer it from accuracy so
  // project rollups don't drop a fully-reported session to "partial".
  if (
    out.turnCount > 0 &&
    out.reportedTurns + out.estimatedTurns + out.partialTurns === 0
  ) {
    if (out.accuracy === ACCURACY.estimated) out.estimatedTurns = out.turnCount;
    else if (out.accuracy === ACCURACY.partial) out.partialTurns = out.turnCount;
    else out.reportedTurns = out.turnCount;
  }
  if (summary.cost != null) out.cost = summary.cost;
  if (summary.premiumRequests != null) out.premiumRequests = summary.premiumRequests;
  if (summary.credits != null) out.credits = summary.credits;
  if (summary.usd != null) out.usd = summary.usd;
  if (summary.costBasis) out.costBasis = summary.costBasis;
  return out;
}

/**
 * Merge multiple session summaries (project rollup).
 */
function mergeUsageSummaries(summaries, opts = {}) {
  const list = (Array.isArray(summaries) ? summaries : []).filter(Boolean);
  if (!list.length) return null;
  let credits = null;
  let usd = null;
  const costBases = new Set();
  for (const s of list) {
    if (s.credits != null) credits = sumNullable(credits, s.credits);
    if (s.usd != null) usd = sumNullable(usd, s.usd);
    if (s.costBasis) for (const b of String(s.costBasis).split(',')) costBases.add(b);
  }
  let totalInput = null;
  let inputTokens = null;
  let cacheRead = null;
  let cacheWrite = null;
  let outputTokens = null;
  let reasoningTokens = null;
  let totalTokens = null;
  let cost = null;
  let premiumRequests = null;
  let turnCount = 0;
  let reportedTurns = 0;
  let estimatedTurns = 0;
  let partialTurns = 0;
  const models = new Set();
  const clis = new Set();
  for (const s of list) {
    totalInput = sumNullable(totalInput, s.totalInput);
    inputTokens = sumNullable(inputTokens, s.inputTokens);
    cacheRead = sumNullable(cacheRead, s.cacheRead);
    cacheWrite = sumNullable(cacheWrite, s.cacheWrite);
    outputTokens = sumNullable(outputTokens, s.outputTokens);
    reasoningTokens = sumNullable(reasoningTokens, s.reasoningTokens);
    totalTokens = sumNullable(totalTokens, s.totalTokens);
    if (s.cost != null) cost = sumNullable(cost, s.cost);
    if (s.premiumRequests != null) {
      premiumRequests = sumNullable(premiumRequests, s.premiumRequests);
    }
    const n = Number(s.turnCount) || 0;
    turnCount += n;
    let r = Number(s.reportedTurns) || 0;
    let e = Number(s.estimatedTurns) || 0;
    let p = Number(s.partialTurns) || 0;
    // Compact session nodes may omit the breakdown; infer from accuracy so a
    // project whose sessions are all "reported" stays "reported".
    if (n > 0 && r + e + p === 0) {
      if (s.accuracy === ACCURACY.estimated) e = n;
      else if (s.accuracy === ACCURACY.partial) p = n;
      else r = n;
    }
    reportedTurns += r;
    estimatedTurns += e;
    partialTurns += p;
    for (const m of s.models || []) models.add(String(m));
    if (s.cli && s.cli !== 'unknown') clis.add(String(s.cli));
  }
  let accuracy = ACCURACY.reported;
  if (turnCount === 0) accuracy = ACCURACY.reported;
  else if (estimatedTurns === turnCount) accuracy = ACCURACY.estimated;
  else if (reportedTurns === turnCount) accuracy = ACCURACY.reported;
  else accuracy = ACCURACY.partial;
  return {
    v: USAGE_VERSION,
    totalInput,
    inputTokens,
    cacheRead,
    cacheWrite,
    outputTokens,
    reasoningTokens,
    totalTokens:
      totalTokens != null
        ? totalTokens
        : totalInput != null || outputTokens != null
          ? (totalInput || 0) + (outputTokens || 0)
          : null,
    promptToResponse: promptToResponseRatio(totalInput, outputTokens),
    cost,
    premiumRequests,
    credits,
    usd,
    costBasis: credits != null || usd != null ? Array.from(costBases).sort().join(',') || null : null,
    turnCount,
    reportedTurns,
    estimatedTurns,
    partialTurns,
    accuracy,
    cli: clis.size === 1 ? Array.from(clis)[0] : 'unknown',
    models: Array.from(models).sort(),
    updatedAt: opts.updatedAt || new Date().toISOString(),
  };
}

/**
 * Format compact token count for UI (e.g. 10155 → "10.2k").
 */
function formatTokenCount(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
  if (Math.abs(v) < 1000) return String(Math.round(v));
  if (Math.abs(v) < 1000000) {
    const k = v / 1000;
    const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
    return `${rounded}k`.replace(/\.0k$/, 'k');
  }
  const m = v / 1000000;
  const rounded = Math.round(m * 10) / 10;
  return `${rounded}m`.replace(/\.0m$/, 'm');
}

/**
 * Compact meta bit for History tree rows: "10.2k tok · 254:1" (prefix ~ if estimated).
 */
function formatUsageMetaBit(summary) {
  if (!summary) return '';
  const total =
    summary.totalTokens != null
      ? summary.totalTokens
      : summary.totalInput != null || summary.outputTokens != null
        ? (summary.totalInput || 0) + (summary.outputTokens || 0)
        : null;
  if (total == null) return '';
  const approx =
    summary.accuracy === ACCURACY.estimated || summary.accuracy === ACCURACY.partial
      ? '~'
      : '';
  let bit = `${approx}${formatTokenCount(total)} tok`;
  if (summary.promptToResponse != null && Number(summary.promptToResponse) > 0) {
    const ratio = Number(summary.promptToResponse);
    const shown = ratio >= 10 ? String(Math.round(ratio)) : String(ratio);
    bit += ` · ${shown}:1`;
  }
  return bit;
}

/**
 * Per-turn tooltip line: "10,155 in → 40 out (254:1) · reported"
 */
function formatUsageTooltipLine(usage) {
  if (!usage) return '';
  const inn = usage.totalInput != null ? usage.totalInput : usage.inputTokens;
  const out = usage.outputTokens;
  if (inn == null && out == null) return '';
  const fmt = (n) =>
    n == null ? '?' : Number(n).toLocaleString('en-US');
  let line = `${fmt(inn)} in → ${fmt(out)} out`;
  if (usage.promptToResponse != null) {
    const ratio = Number(usage.promptToResponse);
    const shown = ratio >= 10 ? String(Math.round(ratio)) : String(ratio);
    line += ` (${shown}:1)`;
  }
  if (usage.accuracy) line += ` · ${usage.accuracy}`;
  return line;
}

module.exports = {
  USAGE_VERSION,
  ACCURACY,
  SOURCES,
  CLIS,
  COPILOT_PRICING,
  creditsFromNanoAiu,
  coveredTurnIndexes,
  emptyUsage,
  finalizeUsage,
  isAllZeroTokens,
  normalizeCursorUsage,
  normalizeCopilotUsage,
  normalizeOpenCodeUsage,
  normalizeOpenCodeSessionColumns,
  normalizeUsage,
  sumCopilotModelMetrics,
  deltaCopilotModelMetrics,
  estimateUsageFromText,
  preferRicherUsage,
  accuracyRank,
  shouldReplaceUsage,
  summarizeSessionUsage,
  compactUsageSummary,
  mergeUsageSummaries,
  formatTokenCount,
  formatUsageMetaBit,
  formatUsageTooltipLine,
  promptToResponseRatio,
};
