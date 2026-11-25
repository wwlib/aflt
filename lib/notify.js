'use strict';

/**
 * Opt-in webhook notifications for headless run completion/failure,
 * interactive turn capture, and `aflt loop` lifecycle events. Off unless a
 * URL is configured via `config.json` `notify` or `AFLT_NOTIFY_URL`
 * (+ optional key/header).
 *
 * POSTs use a short timeout; failures are logged to stderr and never break
 * the calling run/capture path. Secrets are never printed.
 *
 * Callers that are about to exit (headless `aflt run` / spawn / send, and
 * short-lived CLI paths that emit turn.captured) should `await settleNotify`
 * or `await flushPendingNotifies()` so the webhook can finish before the
 * process exits. Sockets are unref'd by default for long-lived hosts
 * (dashboard); pass `unref: false` when awaiting on an exit path.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('./config');
const memory = require('./memory');
const projectLib = require('./project');
const { envNonEmpty, nowIso } = require('./util');

const DEFAULT_HEADER = 'Authorization';
const DEFAULT_TIMEOUT_MS = 2500;
const SUMMARY_CAP = 480;
const EVENTS = Object.freeze({
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  TURN_CAPTURED: 'turn.captured',
  LOOP_STARTED: 'loop.started',
  LOOP_PHASE_STARTED: 'loop.phase.started',
  LOOP_PHASE_PASSED: 'loop.phase.passed',
  LOOP_PHASE_FAILED: 'loop.phase.failed',
  LOOP_COMPLETED: 'loop.completed',
  LOOP_FAILED: 'loop.failed',
  LOOP_STOPPED: 'loop.stopped',
  LOOP_HEARTBEAT: 'loop.heartbeat',
  LOOP_GATE_WAITING: 'loop.gate.waiting',
  LOOP_GATE_APPROVED: 'loop.gate.approved',
  LOOP_ENGINE_FAILOVER: 'loop.engine.failover',
  LOOP_NEEDS_HUMAN: 'loop.needs_human',
});

/** In-flight webhook promises (for flushPendingNotifies before process exit). */
const pendingNotifies = new Set();

/**
 * Resolve notify settings. Env overrides config for url / key / header.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   enabled: boolean,
 *   url: string|null,
 *   key: string|null,
 *   headerName: string,
 *   timeoutMs: number,
 *   source: { url: 'env'|'config'|null, key: 'env'|'config'|null, header: 'env'|'config'|'default' }
 * }}
 */
function resolveNotifyConfig(env = process.env) {
  const data = config.load();
  const raw =
    data && data.notify && typeof data.notify === 'object' && !Array.isArray(data.notify)
      ? data.notify
      : {};

  const urlEnv = envNonEmpty(env, 'AFLT_NOTIFY_URL');
  const urlCfg =
    typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : null;
  const url = urlEnv || urlCfg || null;

  const keyEnv = envNonEmpty(env, 'AFLT_NOTIFY_KEY');
  const keyCfg =
    typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : null;
  const key = keyEnv != null ? keyEnv : keyCfg;

  const headerEnv = envNonEmpty(env, 'AFLT_NOTIFY_HEADER');
  const headerCfg =
    typeof raw.header === 'string' && raw.header.trim()
      ? raw.header.trim()
      : typeof raw.headerName === 'string' && raw.headerName.trim()
        ? raw.headerName.trim()
        : null;
  const headerName = headerEnv || headerCfg || DEFAULT_HEADER;

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const timeoutEnv = envNonEmpty(env, 'AFLT_NOTIFY_TIMEOUT_MS');
  if (timeoutEnv && Number.isFinite(Number(timeoutEnv)) && Number(timeoutEnv) > 0) {
    timeoutMs = Math.min(30000, Math.floor(Number(timeoutEnv)));
  } else if (raw.timeoutMs != null && Number.isFinite(Number(raw.timeoutMs)) && Number(raw.timeoutMs) > 0) {
    timeoutMs = Math.min(30000, Math.floor(Number(raw.timeoutMs)));
  }

  return {
    enabled: Boolean(url),
    url,
    key: key || null,
    headerName,
    timeoutMs,
    source: {
      url: urlEnv ? 'env' : urlCfg ? 'config' : null,
      key: keyEnv != null ? 'env' : keyCfg ? 'config' : null,
      header: headerEnv ? 'env' : headerCfg ? 'config' : 'default',
    },
  };
}

/**
 * Header value for the optional secret. Default Authorization uses Bearer.
 * If the key already looks like a scheme-prefixed Authorization value, keep it.
 * Custom header names get the raw key.
 */
function headerValue(headerName, key) {
  if (key == null || key === '') return null;
  const name = String(headerName || DEFAULT_HEADER);
  if (name.toLowerCase() === 'authorization') {
    if (/^(Bearer|Basic|Digest)\s+/i.test(key)) return key;
    return `Bearer ${key}`;
  }
  return key;
}

/**
 * Short redacted summary for the webhook body. Never includes raw secrets.
 */
function summarize(text, max = SUMMARY_CAP) {
  let s = memory.redactSensitive(String(text == null ? '' : text)).trim();
  const n = Math.max(32, Number(max) || SUMMARY_CAP);
  if (s.length > n) {
    s = s.slice(0, n - 14).trimEnd() + '\n…[truncated]';
  }
  return s;
}

function resolveProject(session, meta = {}) {
  if (meta.project != null && String(meta.project).trim() !== '') {
    return String(meta.project).trim();
  }
  if (session && session.project != null && String(session.project).trim() !== '') {
    return String(session.project).trim();
  }
  if (!session) return null;
  try {
    return projectLib.resolveProjectName(session) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Build the JSON body posted to the webhook.
 */
function buildPayload(event, session, opts = {}) {
  const s = session && typeof session === 'object' ? session : {};
  const cwdRaw = s.cwd != null ? String(s.cwd) : null;
  return {
    event: String(event),
    sessionId: s.id != null ? String(s.id) : null,
    title: s.title != null ? String(s.title) : null,
    project: resolveProject(s, opts.meta || {}),
    engine: s.engine != null ? String(s.engine) : null,
    cwd: cwdRaw ? memory.redactSensitive(cwdRaw) : null,
    exitStatus: opts.exitStatus != null ? opts.exitStatus : null,
    timestamp: opts.timestamp || nowIso(),
    summary: summarize(opts.summary != null ? opts.summary : ''),
  };
}

/**
 * POST JSON to the webhook. Resolves with { ok, status, error }.
 * Never throws.
 */
function postWebhook(cfg, payload, opts = {}) {
  return new Promise((resolve) => {
    if (!cfg || !cfg.url) {
      resolve({ ok: false, status: null, error: 'notify not configured' });
      return;
    }
    let parsed;
    try {
      parsed = new URL(cfg.url);
    } catch (err) {
      resolve({ ok: false, status: null, error: `invalid notify url: ${err.message}` });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve({ ok: false, status: null, error: `unsupported notify url protocol: ${parsed.protocol}` });
      return;
    }

    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'aflt-notify',
    };
    const auth = headerValue(cfg.headerName, cfg.key);
    if (auth) {
      headers[cfg.headerName] = auth;
    }

    const timeoutMs =
      opts.timeoutMs != null && Number.isFinite(Number(opts.timeoutMs))
        ? Math.max(1, Math.floor(Number(opts.timeoutMs)))
        : cfg.timeoutMs || DEFAULT_TIMEOUT_MS;

    const transport = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let req;
    try {
      req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: `${parsed.pathname || '/'}${parsed.search || ''}`,
          method: 'POST',
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            const status = res.statusCode != null ? res.statusCode : null;
            const ok = status != null && status >= 200 && status < 300;
            finish({
              ok,
              status,
              error: ok ? null : `notify webhook HTTP ${status}`,
            });
          });
        }
      );
    } catch (err) {
      finish({ ok: false, status: null, error: err && err.message ? err.message : String(err) });
      return;
    }

    req.on('timeout', () => {
      try {
        req.destroy(new Error('notify timeout'));
      } catch (_) {
        /* ignore */
      }
    });
    req.on('error', (err) => {
      const msg = err && err.message ? err.message : String(err);
      finish({
        ok: false,
        status: null,
        error: /timeout/i.test(msg) ? 'notify timeout' : msg,
      });
    });
    if (opts.unref !== false) {
      req.on('socket', (socket) => {
        try {
          if (socket && typeof socket.unref === 'function') socket.unref();
        } catch (_) {
          /* ignore */
        }
      });
    }

    try {
      req.write(body);
      req.end();
    } catch (err) {
      finish({ ok: false, status: null, error: err && err.message ? err.message : String(err) });
    }
  });
}

function logNotifyFailure(err) {
  const msg = err && err.message ? err.message : String(err || 'unknown error');
  try {
    process.stderr.write(`WARNING: notify failed: ${memory.redactSensitive(msg)}\n`);
  } catch (_) {
    /* ignore */
  }
}

/**
 * Queue a webhook POST. Never throws.
 * By default sockets are unref'd (long-lived hosts). Exit paths should pass
 * `unref: false` and await `settleNotify` / `flushPendingNotifies`.
 * @returns {{ skipped: true }|{ queued: true, promise: Promise }}
 */
function enqueue(cfg, payload, opts = {}) {
  if (!cfg || !cfg.enabled || !cfg.url) return { skipped: true };
  const promise = postWebhook(cfg, payload, opts).then((result) => {
    if (!result.ok) logNotifyFailure(new Error(result.error || 'notify failed'));
    return result;
  });
  // Swallow rejections so callers never see an unhandled rejection.
  const tracked = promise.catch((err) => {
    logNotifyFailure(err);
    return { ok: false, status: null, error: err && err.message ? err.message : String(err) };
  });
  pendingNotifies.add(tracked);
  tracked.finally(() => {
    pendingNotifies.delete(tracked);
  });
  return { queued: true, promise: tracked };
}

/**
 * Await a notifyRunFinished / notifyTurnCaptured result if one was queued.
 * Never throws; never changes caller exit semantics.
 * @param {{ skipped?: boolean, promise?: Promise }|null|undefined} result
 */
async function settleNotify(result) {
  if (!result || result.skipped || !result.promise) return result || { skipped: true };
  try {
    await result.promise;
  } catch (_) {
    /* already logged in enqueue */
  }
  return result;
}

/**
 * Await all in-flight notify POSTs (bounded by each request's timeout).
 * Safe to call on CLI exit; never throws.
 */
async function flushPendingNotifies() {
  const list = [...pendingNotifies];
  if (!list.length) return { flushed: 0 };
  await Promise.allSettled(list);
  return { flushed: list.length };
}

/**
 * Headless run finished or failed.
 * @returns {{ skipped: true }|{ queued: true, promise: Promise, event: string, payload: object }}
 */
function notifyRunFinished(session, opts = {}) {
  try {
    const cfg = opts.config || resolveNotifyConfig(opts.env || process.env);
    if (!cfg.enabled) return { skipped: true };
    const exitStatus = opts.exitStatus != null ? opts.exitStatus : null;
    const timedOut = Boolean(opts.timedOut);
    const stopped = Boolean(opts.stopped);
    const event =
      !timedOut && !stopped && exitStatus === 0 ? EVENTS.RUN_COMPLETED : EVENTS.RUN_FAILED;
    const payload = buildPayload(event, session, {
      exitStatus,
      summary: opts.summary,
      timestamp: opts.timestamp,
      meta: opts.meta,
    });
    const queued = enqueue(cfg, payload, { timeoutMs: opts.timeoutMs, unref: opts.unref });
    return { ...queued, event, payload };
  } catch (err) {
    logNotifyFailure(err);
    return { skipped: true, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Interactive turn captured (turns.jsonl / emitTurnCaptured).
 */
function notifyTurnCaptured(session, turn, opts = {}) {
  try {
    const cfg = opts.config || resolveNotifyConfig(opts.env || process.env);
    if (!cfg.enabled) return { skipped: true };
    const s =
      session && typeof session === 'object'
        ? session
        : {
            id: turn && turn.sessionId != null ? turn.sessionId : null,
            title: null,
            project: opts.meta && opts.meta.project != null ? opts.meta.project : null,
            engine: null,
            cwd: null,
          };
    if (s.id == null && turn && turn.sessionId != null) s.id = turn.sessionId;
    const prompt = turn && turn.prompt != null ? String(turn.prompt) : '';
    const reply = turn && turn.reply != null ? String(turn.reply) : '';
    const summaryParts = [];
    if (prompt) summaryParts.push(`prompt: ${prompt}`);
    if (reply) summaryParts.push(`reply: ${reply}`);
    const payload = buildPayload(EVENTS.TURN_CAPTURED, s, {
      exitStatus: null,
      summary: summaryParts.join('\n') || 'turn captured',
      timestamp: (turn && turn.capturedAt) || opts.timestamp,
      meta: opts.meta || { project: s.project },
    });
    const queued = enqueue(cfg, payload, { timeoutMs: opts.timeoutMs, unref: opts.unref });
    return { ...queued, event: EVENTS.TURN_CAPTURED, payload };
  } catch (err) {
    logNotifyFailure(err);
    return { skipped: true, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Doctor-friendly status (never includes the key).
 */
function doctorStatus(env = process.env) {
  const cfg = resolveNotifyConfig(env);
  if (!cfg.enabled) {
    return {
      name: 'notify',
      ok: true,
      configured: false,
      detail: 'off (set config.json notify.url or AFLT_NOTIFY_URL)',
    };
  }
  let host = cfg.url;
  try {
    const u = new URL(cfg.url);
    host = `${u.protocol}//${u.host}${u.pathname || '/'}`;
  } catch (_) {
    host = '(invalid url)';
  }
  // Redact query/userinfo just in case
  host = memory.redactSensitive(host);
  const detail =
    `configured url=${host} key=${cfg.key ? 'set' : 'unset'} ` +
    `header=${cfg.headerName} (url from ${cfg.source.url || '?'}` +
    `${cfg.key ? `; key from ${cfg.source.key}` : ''})`;
  return {
    name: 'notify',
    ok: true,
    configured: true,
    detail,
  };
}

/**
 * Send a sample event (used by `aflt notify test`). Awaits the POST.
 */
async function sendTestEvent(opts = {}) {
  const env = opts.env || process.env;
  const cfg = opts.config || resolveNotifyConfig(env);
  if (!cfg.enabled) {
    return {
      ok: false,
      error: 'notify not configured (set config.json notify.url or AFLT_NOTIFY_URL)',
    };
  }
  const session = opts.session || {
    id: 'notify-test',
    title: 'notify-test',
    project: 'adhoc',
    engine: 'cursor',
    cwd: process.cwd(),
  };
  const payload = buildPayload(opts.event || EVENTS.RUN_COMPLETED, session, {
    exitStatus: opts.exitStatus != null ? opts.exitStatus : 0,
    summary: opts.summary != null ? opts.summary : 'aflt notify test sample event',
    timestamp: opts.timestamp,
  });
  const result = await postWebhook(cfg, payload, {
    timeoutMs: opts.timeoutMs,
    unref: false,
  });
  return { ...result, payload, config: { url: cfg.url, headerName: cfg.headerName, key: cfg.key ? 'set' : 'unset' } };
}

/**
 * Remove AFLT_NOTIFY_* from an env object in place (and return it), so nested
 * eval loops (verify tier2, tile-dungeon trials) never send the outer loop's
 * webhook events. Nested spaces are fresh, so config.json notify is unset too.
 */
function stripNotifyEnv(env) {
  if (!env) return env;
  for (const k of Object.keys(env)) {
    if (k.startsWith('AFLT_NOTIFY_')) delete env[k];
  }
  return env;
}

module.exports = {
  stripNotifyEnv,
  EVENTS,
  DEFAULT_HEADER,
  DEFAULT_TIMEOUT_MS,
  SUMMARY_CAP,
  resolveNotifyConfig,
  headerValue,
  summarize,
  buildPayload,
  postWebhook,
  enqueue,
  notifyRunFinished,
  notifyTurnCaptured,
  settleNotify,
  flushPendingNotifies,
  doctorStatus,
  sendTestEvent,
};
