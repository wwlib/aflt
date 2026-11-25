'use strict';

/**
 * Live activity dashboard — history-first by default (tree + Gantt), optional
 * star graph view, optional completion-note capture.
 * Separate from `aflt memory dashboard` (memory-repo DASHBOARD.md).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { URL } = require('url');
const displayStateLib = require('./display-state');
const herdr = require('./herdr');
const herdrapp = require('./herdrapp');
const memory = require('./memory');
const orchestrate = require('./orchestrate');
const projectLib = require('./project');
const registry = require('./registry');
const taskCompletions = require('./task-completions');
const turns = require('./turns');
const agentDocs = require('./agent-docs');
const runHistory = require('./run-history');
const archiveLib = require('./archive');
const messagesLib = require('./messages');
const loopLib = require('./loop');
const { createLoopScheduler } = require('./loop-scheduler');
const { registryPath, nowIso, expandUserPath, fleetDir } = require('./util');

/**
 * Session usage summary plus Copilot credits from per-call records when the
 * stored summary has none (read-only; see making-of.withPerCallCredits).
 */
function withRecordedCredits(summary, sessionId) {
  try {
    return require('./making-of').withPerCallCredits(summary, sessionId);
  } catch (_) {
    return summary;
  }
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DASHBOARD_TZ = 'America/New_York';
const RECENT_MS = 5 * 60 * 1000;
const ACTIVE_PROJECT_MS = 24 * 60 * 60 * 1000;
const SSE_INTERVAL_MS = 3000;
const REGISTRY_POLL_MS = 2000;
const EVENTS_MAX = 40;
const MEMORY_DOCUMENT_BYTES = 32 * 1024;
const MEMORY_STATUS_NOTES = 10;
const ASSET_DIR = path.join(__dirname, '..', 'templates', 'dashboard');
const HISTORY_SORTS = new Set(['recent', 'created', 'name', 'project']);

/**
 * Fallback shape when no sessions are available. Live payloads use
 * messagesLib.collectDashboardMessages (issue #2).
 */
const MESSAGES_HOOK = Object.freeze({
  deferred: false,
  issue: 2,
  reason: null,
  items: Object.freeze([]),
});

const DISPLAY_STATES = new Set(['running', 'idle', 'done', 'failed']);
const execFileAsync = promisify(execFile);

function sessionNodeLabel(id) {
  const value = String(id);
  return value.length > 18 ? value.slice(0, 9) + '...' + value.slice(-6) : value;
}

async function focusHerdrSession(session, opts = {}) {
  const fetched = (opts.fetchHerdrTerminals || herdr.fetchHerdrTerminals)({ timeoutMs: 3000 });
  if (!fetched.ok) throw new Error(fetched.error || 'Unable to query Herdr terminals.');
  const terminal = herdr.classifySession(session, fetched.terminals);
  if (!['running', 'shell'].includes(terminal.runtime) || !terminal.address) {
    throw new Error('No unique live Herdr terminal is available for this session. Resume it in Herdr first.');
  }
  const app = herdrapp.resolveHerdrAppBin();
  const runApp = opts.runApp || ((args) => execFileAsync(app, args, { timeout: 5000, maxBuffer: 64 * 1024 }));
  try {
    const result = await runApp(['do', 'agent.focus', '--terminal', terminal.address]);
    const reply = JSON.parse(result.stdout);
    if (!reply || reply.ok !== true) throw new Error(String(reply?.error || 'Herdr did not confirm the focus action.'));
  } catch (err) {
    throw new Error(`Unable to focus the Herdr terminal. Check that the Herdr app is open. ${String(err.stderr || err.message).trim()}`);
  }
  const raiseApp = opts.raiseApp || (() => new Promise((resolve, reject) => {
    const child = spawn(app, [], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  }));
  try {
    await raiseApp();
  } catch (err) {
    throw new Error(`The terminal was selected, but the Herdr window could not be opened: ${err.message}`);
  }
  return { sessionId: session.id, address: terminal.address };
}

/**
 * Format a timestamp for the snapshot header in America/New_York (ET).
 * Host TZ independent. Returns "" if the input is not a valid date.
 * Example: 2026-11-16T00:52:17.000Z → "2026-11-15 19:52:17 ET"
 * @param {string|number|Date} input
 * @param {string} [timeZone]
 * @returns {string}
 */
function formatSnapshotStamp(input, timeZone = DASHBOARD_TZ) {
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type) => {
    const part = parts.find((p) => p.type === type);
    return part ? part.value : '';
  };
  const pad = (value) => String(value).padStart(2, '0');
  return `${get('year')}-${pad(get('month'))}-${pad(get('day'))} ${pad(get('hour'))}:${pad(get('minute'))}:${pad(get('second'))} ET`;
}

function parseTimeMs(iso) {
  if (iso == null || iso === '') return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

const deriveDisplayState = displayStateLib.deriveDisplayState;
const enrichmentForSession = displayStateLib.enrichmentForSession;

function sessionInputState(session, enrichment, previous = {}, now = Date.now()) {
  const checkpoint = {
    lastSendAt: session.lastSendAt || null,
    runStartedAt: session.runStartedAt || null,
  };
  const reset = { seenWorking: false, idleTicks: 0, working: false, completed: false };
  if (session.status === 'done' || session.status === 'paused') {
    return { ...checkpoint, ...reset, awaitingInput: false };
  }
  const runtime = enrichment && enrichment.runtime;
  if (runtime === 'running') {
    const sameRun = previous.lastSendAt === checkpoint.lastSendAt &&
      previous.runStartedAt === checkpoint.runStartedAt;
    const agentState = orchestrate.agentStateFromHerdr(enrichment);
    const transition = orchestrate.detectWaitingTransition({
      ...(sameRun ? previous : reset),
      agentState,
      lastSendAt: checkpoint.lastSendAt,
      sendGraceMs: orchestrate.resolveSendGraceMs(),
      now,
    });
    const completed = transition.hint === 'waiting' &&
      (agentState === 'done' || (agentState === 'idle' && sameRun && previous.completed === true));
    return {
      ...checkpoint, ...transition,
      working: agentState === 'working', completed,
      awaitingInput: !completed && transition.hint === 'waiting',
    };
  }
  return {
    ...checkpoint, ...reset,
    awaitingInput: !['shell', 'exited', 'missing'].includes(runtime) && session.workerStatus === 'waiting',
  };
}

/**
 * Preserve force-sim positions across SSE state updates.
 * Pure: merges mutable fields onto existing nodes; marks whether the node-id set changed
 * (caller should reheat / rebuild layout only when `nodeSetChanged` is true).
 *
 * @param {{ nodes?: object[], links?: object[], w?: number, h?: number, cx?: number, cy?: number, alpha?: number }|null} prevSim
 * @param {{ nodes: object[], links: object[], w: number, h: number, cx: number, cy: number }} nextBuilt
 * @param {{ reheatAlpha?: number, preserveAlpha?: boolean }} [opts]
 * @returns {{ nodes: object[], links: object[], w: number, h: number, cx: number, cy: number, alpha: number, nodeSetChanged: boolean }}
 */
function mergeSimPreserve(prevSim, nextBuilt, opts = {}) {
  const nextNodes = Array.isArray(nextBuilt && nextBuilt.nodes) ? nextBuilt.nodes : [];
  const nextLinks = Array.isArray(nextBuilt && nextBuilt.links) ? nextBuilt.links : [];
  const prevNodes = prevSim && Array.isArray(prevSim.nodes) ? prevSim.nodes : [];
  const prevById = new Map();
  for (const n of prevNodes) {
    if (n && n.id != null) prevById.set(n.id, n);
  }
  const prevIds = new Set(prevById.keys());
  const nextIds = new Set(nextNodes.map((n) => n && n.id).filter((id) => id != null));
  let nodeSetChanged = prevIds.size !== nextIds.size;
  if (!nodeSetChanged) {
    for (const id of nextIds) {
      if (!prevIds.has(id)) {
        nodeSetChanged = true;
        break;
      }
    }
  }

  const nodes = nextNodes.map((n) => {
    const prev = prevById.get(n.id);
    if (!prev) return n;
    return {
      ...n,
      x: prev.x,
      y: prev.y,
      vx: prev.vx != null ? prev.vx : 0,
      vy: prev.vy != null ? prev.vy : 0,
      fixed: prev.fixed != null ? prev.fixed : n.fixed,
    };
  });

  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);
  const links = nextLinks
    .map((l) => {
      const source = typeof l.source === 'object' && l.source ? l.source : byId.get(l.source);
      const target = typeof l.target === 'object' && l.target ? l.target : byId.get(l.target);
      // Prefer merged node objects when link already holds object refs from a rebuild
      const src = source && source.id != null && byId.has(source.id) ? byId.get(source.id) : source;
      const tgt = target && target.id != null && byId.has(target.id) ? byId.get(target.id) : target;
      if (!src || !tgt) return null;
      return {
        source: src,
        target: tgt,
        kind: l.kind,
        recent: l.recent,
      };
    })
    .filter(Boolean);

  let alpha;
  if (opts.preserveAlpha && prevSim && typeof prevSim.alpha === 'number' && !nodeSetChanged) {
    alpha = prevSim.alpha;
  } else if (nodeSetChanged || !prevSim) {
    alpha = opts.reheatAlpha != null ? opts.reheatAlpha : 1;
  } else {
    alpha = typeof prevSim.alpha === 'number' ? prevSim.alpha : 1;
  }

  return {
    nodes,
    links,
    w: nextBuilt.w,
    h: nextBuilt.h,
    cx: nextBuilt.cx,
    cy: nextBuilt.cy,
    alpha,
    nodeSetChanged,
  };
}

function sessionActivityMs(session) {
  const times = [
    parseTimeMs(session && session.lastUsed),
    parseTimeMs(session && session.lastRunAt),
    parseTimeMs(session && session.created),
  ].filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

function memoryRecordActivityMs(rec) {
  const times = [
    parseTimeMs(rec && rec.lastUsed),
    parseTimeMs(rec && rec.end),
    parseTimeMs(rec && rec.start),
  ].filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

function bucketIndex(ms, startMs, bucketMs, count) {
  if (ms == null || !Number.isFinite(ms)) return -1;
  const i = Math.floor((ms - startMs) / bucketMs);
  if (i < 0 || i >= count) return -1;
  return i;
}

function buildSparkline(timestamps, nowMs, windowMs, buckets) {
  const series = new Array(buckets).fill(0);
  const startMs = nowMs - windowMs;
  const bucketMs = windowMs / buckets;
  for (const ms of timestamps) {
    const i = bucketIndex(ms, startMs, bucketMs, buckets);
    if (i >= 0) series[i] += 1;
  }
  return series;
}

function pushEvent(events, ev) {
  if (!ev || !ev.at) return;
  events.push(ev);
}

/**
 * Pure aggregation. Does not read HOME / registry / Herdr.
 *
 * @param {{
 *   sessions?: object[],
 *   memoryRecords?: object[],
 *   memoryProjects?: object[],
 *   memoryErrors?: string[],
 *   memoryConfigured?: boolean,
 *   enrichmentById?: Record<string, object>,
 *   sessionActivityById?: Record<string, object>,
 *   completionsById?: Record<string, object>,
 *   completionErrors?: string[],
 *   captureCompletions?: boolean,
 *   now?: string|number|Date,
 *   isAlive?: (pid: number) => boolean,
 *   projectCache?: object,
 *   projectMetaById?: Record<string, object>,
 * }} input
 */
function aggregateDashboard(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const memoryRecords = Array.isArray(input.memoryRecords) ? input.memoryRecords : [];
  const memoryProjects = Array.isArray(input.memoryProjects) ? input.memoryProjects : [];
  const projectMetaById =
    input.projectMetaById && typeof input.projectMetaById === 'object'
      ? input.projectMetaById
      : {};
  const enrichmentById = input.enrichmentById && typeof input.enrichmentById === 'object'
    ? input.enrichmentById
    : {};
  const isAlive = input.isAlive;
  const cache = input.projectCache || projectLib.createLookupCache();
  const nowDate =
    input.now instanceof Date
      ? input.now
      : input.now != null
        ? new Date(input.now)
        : new Date();
  const nowMs = nowDate.getTime();
  const generatedAt =
    typeof input.now === 'string' && Number.isFinite(Date.parse(input.now))
      ? String(input.now)
      : nowDate.toISOString();

  const byId = new Map();
  const childrenByParent = new Map();
  for (const s of sessions) {
    if (!s || !s.id) continue;
    byId.set(s.id, s);
    if (s.parent) {
      if (!childrenByParent.has(s.parent)) childrenByParent.set(s.parent, []);
      childrenByParent.get(s.parent).push(s.id);
    }
  }

  const projectMap = new Map(); // name → { name, sessions: [], displayStates, lastActivity }
  const sessionViews = [];
  const links = [];
  const activityTimes = [];
  const events = [];

  function ensureProject(name) {
    const key = name || projectLib.ADHOC_NAME;
    if (!projectMap.has(key)) {
      const meta = projectMetaById[key] || null;
      projectMap.set(key, {
        name: key,
        sessionIds: [],
        displayStates: [],
        lastActivity: null,
        fromMemoryOnly: true,
        repositories: meta ? meta.repositories || [] : [],
        relationships: meta ? meta.relationships || [] : [],
        metaProblems: meta ? meta.problems || [] : [],
        displayName: meta && meta.name ? meta.name : null,
      });
    }
    return projectMap.get(key);
  }

  // Ensure mapped memory projects appear even with zero sessions.
  for (const id of Object.keys(projectMetaById)) {
    ensureProject(id);
  }

  for (const s of sessions) {
    if (!s || !s.id) continue;
    const project = projectLib.resolveProjectName(s, { cache }) || projectLib.ADHOC_NAME;
    const enrichment = enrichmentForSession(s, enrichmentById);
    let displayState = deriveDisplayState(s, enrichment, { isAlive });
    const activity = input.sessionActivityById?.[s.id] || sessionInputState(s, enrichment, {}, nowMs);
    let activityState = displayState;
    if (displayState === 'done') activityState = 'completed';
    else if (displayState !== 'failed' && s.status !== 'paused') {
      if (activity.working) activityState = 'working';
      else if (activity.completed) activityState = 'completed';
      else if (activity.awaitingInput) activityState = 'waiting';
      else if (displayStateLib.isPidAlive(s.runPid, isAlive)) {
        // Live engine pid (headless) → working even when OSC status is absent (Cursor).
        activityState = 'working';
      } else if (s.workerStatus === 'done' && displayState !== 'running') {
        activityState = 'completed';
      } else if (displayState === 'running') {
        activityState = 'working';
      } else {
        // Live Herdr pane (runtime running/shell) without working signal → idle,
        // matching Herdr's Agents panel — not the Running card.
        activityState = 'idle';
      }
    }
    // Loop worker sessions stay registry-active after their phase ends; use the
    // loop's recorded phase/loop outcome unless the session is live right now.
    const loopOutcome = input.loopSessionOutcomes ? input.loopSessionOutcomes[s.id] : null;
    if (
      loopOutcome &&
      !s.archived &&
      s.status !== 'paused' &&
      displayState === 'idle' &&
      activityState !== 'working' &&
      activityState !== 'waiting'
    ) {
      if (loopOutcome === 'failed') {
        displayState = 'failed';
        activityState = 'failed';
      } else {
        displayState = 'done';
        activityState = 'completed';
      }
    }
    const awaitingInput = activityState === 'waiting';
    const activityMs = sessionActivityMs(s);
    const recent = activityMs != null && nowMs - activityMs <= RECENT_MS;
    const children = childrenByParent.get(s.id) || [];
    const completion = input.completionsById?.[s.id] || null;

    if (activityMs != null && !s.archived) activityTimes.push(activityMs);

    const proj = ensureProject(project);
    // Archived sessions stay in sessionViews/history for the Show-archived toggle,
    // but do not inflate Active / running roll-ups.
    if (!s.archived) {
      proj.fromMemoryOnly = false;
      proj.sessionIds.push(s.id);
      proj.displayStates.push(displayState);
      if (completion && (!proj.completion || completion.at >= proj.completion.at)) {
        proj.completion = completion;
      }
      if (activityMs != null && (proj.lastActivity == null || activityMs > proj.lastActivity)) {
        proj.lastActivity = activityMs;
      }
    } else if (proj.sessionIds.length === 0 && !proj.fromMemoryOnly) {
      // Keep the project hub visible when only archived members remain.
      proj.fromMemoryOnly = false;
    }

    sessionViews.push({
      id: s.id,
      nodeLabel: sessionNodeLabel(s.id),
      title: memory.redactSensitive(s.title || s.id),
      project,
      engine: s.engine || 'cursor',
      status: s.status || 'done',
      archived: Boolean(s.archived),
      archivedAt: s.archivedAt || null,
      displayState,
      activityState,
      completion,
      awaitingInput,
      cwd: s.cwd ? memory.redactSensitive(s.cwd) : null,
      model: s.model || null,
      notes: s.notes ? memory.redactSensitive(s.notes) : null,
      role: s.role || null,
      parent: s.parent || null,
      workerStatus: s.workerStatus || null,
      created: s.created || null,
      lastUsed: s.lastUsed || null,
      lastRunAt: s.lastRunAt || null,
      lastExit: s.lastExit != null ? s.lastExit : null,
      lastError: s.lastError ? memory.redactSensitive(s.lastError) : null,
      runPid: s.runPid != null ? s.runPid : null,
      runStartedAt: s.runStartedAt || null,
      herdr: enrichment
        ? {
            runtime: herdr.displayRuntime(enrichment.runtime),
            address: enrichment.address || null,
            name: enrichment.name || null,
            exitCode: enrichment.exitCode != null ? enrichment.exitCode : null,
            status: enrichment.status != null ? enrichment.status : null,
            checkedAt: enrichment.checkedAt || null,
          }
        : s.herdr && typeof s.herdr === 'object'
          ? {
              runtime: herdr.displayRuntime(s.herdr.runtime),
              address: s.herdr.address || null,
              name: s.herdr.name || null,
              exitCode: s.herdr.exitCode != null ? s.herdr.exitCode : null,
              status: s.herdr.status != null ? s.herdr.status : null,
              checkedAt: s.herdr.checkedAt || null,
            }
          : null,
      children,
      recent,
    });

    if (completion) {
      pushEvent(events, {
        at: completion.at, type: 'task-complete', sessionId: s.id,
        title: s.title || s.id, project, text: `Task Complete · ${s.title || s.id}`,
      });
    }
    if (s.parent && s.parent !== s.id && byId.has(s.parent)) {
      links.push({ from: s.parent, to: s.id, kind: 'parent' });
    } else {
      links.push({ from: `project:${project}`, to: s.id, kind: 'project' });
    }

    if (s.created) {
      pushEvent(events, {
        at: s.created,
        type: 'created',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text: `created · ${s.title || s.id}`,
      });
    }
    if (s.lastRunAt) {
      pushEvent(events, {
        at: s.lastRunAt,
        type: 'run',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text: `run · ${s.title || s.id}`,
      });
    }
    if (s.lastUsed && s.lastUsed !== s.created && s.lastUsed !== s.lastRunAt) {
      pushEvent(events, {
        at: s.lastUsed,
        type: 'used',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text: `active · ${s.title || s.id}`,
      });
    }
    if (displayState === 'failed' && (s.lastError || s.lastExit != null)) {
      const when = s.lastUsed || s.lastRunAt || s.created || generatedAt;
      pushEvent(events, {
        at: when,
        type: 'failed',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text:
          'failed · ' +
          (s.title || s.id) +
          (s.lastExit != null ? ' (exit ' + s.lastExit + ')' : ''),
      });
    } else if (s.status === 'done' && (s.lastUsed || s.lastRunAt)) {
      pushEvent(events, {
        at: s.lastUsed || s.lastRunAt,
        type: 'done',
        sessionId: s.id,
        title: s.title || s.id,
        project,
        text: `done · ${s.title || s.id}`,
      });
    }
  }

  for (const rec of memoryRecords) {
    if (!rec) continue;
    const project =
      projectLib.canonicalProjectName(
        (rec.project && String(rec.project).trim()) || projectLib.ADHOC_NAME
      ) || projectLib.ADHOC_NAME;
    const proj = ensureProject(project);
    const ms = memoryRecordActivityMs(rec);
    if (ms != null) {
      activityTimes.push(ms);
      if (proj.lastActivity == null || ms > proj.lastActivity) {
        proj.lastActivity = ms;
      }
    }
    if (rec.id && !byId.has(rec.id) && rec.start) {
      pushEvent(events, {
        at: rec.start,
        type: 'memory',
        sessionId: rec.id,
        title: rec.title || rec.id,
        project,
        text: `history · ${rec.title || rec.id}`,
      });
    }
  }

  for (const context of memoryProjects) {
    const project = [...projectMap.values()].find(
      (p) => memory.sanitizeFolderName(p.name) === context.folder
    ) || ensureProject(context.project);
    project.memory = context;
  }

  const checkpointByProject = new Map();
  for (const cp of input.checkpoints || []) {
    if (cp && cp.project) checkpointByProject.set(cp.project, cp);
  }

  const sessionsByProject = new Map();
  for (const s of sessionViews) {
    if (!sessionsByProject.has(s.project)) sessionsByProject.set(s.project, []);
    sessionsByProject.get(s.project).push(s);
  }

  const projects = [...projectMap.values()]
    .map((p) => {
      // Project badge/ring/filter state rolls up from live (non-archived) sessions only
      // (waiting > running > failed > idle > done). Never from project "active"/open.
      const allMembers = sessionsByProject.get(p.name) || [];
      const members = allMembers.filter((s) => !s.archived);
      const filterStates = members.map(sessionFilterState);
      const displayState = rollupProjectFilterState(filterStates);
      const runningCount = filterStates.filter((d) => d === 'working').length;
      const sessionCount = members.length;
      const archivedCount = allMembers.filter((s) => s.archived).length;
      // Archived-only projects are still real projects (Show archived), not memory-only.
      const fromMemoryOnly =
        Boolean(p.fromMemoryOnly) || (sessionCount === 0 && archivedCount === 0);
      const recentlyActive =
        !fromMemoryOnly &&
        sessionCount > 0 &&
        (runningCount > 0 ||
          displayState === 'waiting' ||
          (p.lastActivity != null && nowMs - p.lastActivity <= ACTIVE_PROJECT_MS));
      return {
        id: `project:${p.name}`,
        name: p.name,
        displayName: p.displayName || null,
        displayState,
        filterState: displayState,
        sessionCount,
        archivedCount,
        runningCount,
        workingCount: runningCount,
        lastActivity: p.lastActivity != null ? new Date(p.lastActivity).toISOString() : null,
        // Memory-only / zero-session folders never count as Active projects.
        active: recentlyActive,
        fromMemoryOnly,
        memory: p.memory || null,
        completion: p.completion || null,
        checkpoint: checkpointByProject.get(p.name) || null,
        repositories: p.repositories || [],
        relationships: p.relationships || [],
        metaProblems: p.metaProblems || [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const engines = { cursor: 0, copilot: 0, opencode: 0 };
  let runningSessions = 0;
  let open = 0;
  let idle = 0;
  let done = 0;
  let failed = 0;
  let waiting = 0;
  for (const s of sessionViews) {
    if (s.archived) continue;
    const eng =
      s.engine === 'copilot' ? 'copilot' : s.engine === 'opencode' ? 'opencode' : 'cursor';
    engines[eng] += 1;
    // Counts follow the same live filter state as History/Graph (not bare displayState).
    const live = sessionFilterState(s);
    if (live === 'working') {
      runningSessions += 1;
      open += 1;
    } else if (live === 'waiting') {
      waiting += 1;
    } else if (live === 'idle') {
      idle += 1;
    } else if (live === 'failed') {
      failed += 1;
    } else if (live === 'completed') {
      done += 1;
    }
  }

  const activeProjects = projects.filter((p) => p.active && !isSessionlessProject(p)).length;

  events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const trimmedEvents = events.slice(0, EVENTS_MAX);

  const dashMessages = messagesLib.collectDashboardMessages(sessionViews);
  const historyTree = buildHistoryTree({
    projects,
    sessions: sessionViews,
    nowMs,
    sort: input.historySort || 'recent',
    messageMarkersById: dashMessages.bySessionId || {},
  });

  const loopsPayload =
    input.loops && typeof input.loops === 'object'
      ? input.loops
      : { ok: true, loops: [] };

  const spaceName =
    input.space !== undefined
      ? input.space
      : (() => {
          try {
            return require('./util').currentSpaceName() || null;
          } catch (_) {
            return null;
          }
        })();

  return {
    generatedAt,
    space: spaceName || null,
    defaultView: loopsPayload.loops && loopsPayload.loops.length ? 'loops' : 'history',
    views: ['history', 'graph', 'loops'],
    historySort: HISTORY_SORTS.has(input.historySort) ? input.historySort : 'recent',
    // Same 24h window as project `active` / History dormant collapse threshold.
    dormantAfterMs: ACTIVE_PROJECT_MS,
    historyTree,
    // Issue #2: cross-session / team messages for History markers + panel.
    messages: {
      deferred: false,
      issue: 2,
      reason: null,
      items: dashMessages.items || [],
    },
    stats: {
      activeProjects,
      runningSessions,
      workingSessions: runningSessions,
      engines,
      open,
      waiting,
      idle,
      done,
      completed: done,
      failed,
      sessions: sessionViews.length,
      projects: projects.length,
    },
    projects,
    sessions: sessionViews,
    links,
    sparkline24h: buildSparkline(activityTimes, nowMs, 24 * 60 * 60 * 1000, 24),
    sparkline7d: buildSparkline(activityTimes, nowMs, 7 * 24 * 60 * 60 * 1000, 7),
    events: trimmedEvents,
    completions: {
      captureEnabled: Boolean(input.captureCompletions),
      errors: input.completionErrors || [],
    },
    memory: {
      present: memoryRecords.length > 0 || memoryProjects.length > 0,
      recordCount: memoryRecords.length,
      configured: Boolean(input.memoryConfigured),
      errors: input.memoryErrors || [],
    },
    // Opt-in agentDocs checkpoints (issue #3). Age/overdue is status only — not progress.
    // Doc Bot notifications are batched after notes are written (messaging optional).
    checkpoints: {
      projects: input.checkpoints || [],
      missing: (input.checkpoints || []).filter((c) => c && c.missing).length,
      overdue: (input.checkpoints || []).filter((c) => c && c.overdue).length,
      retryDue: (input.checkpoints || []).filter((c) => c && c.retryDue).length,
      docBotQueue: input.docBotQueue || agentDocs.summarizeDocBotQueue(),
      docBotNotify: agentDocs.DOC_BOT_NOTIFY_DEFERRED,
    },
    // Milestone 3: loops summary for the Loops view (refreshed with SSE).
    loops: {
      ok: loopsPayload.ok !== false,
      loops: Array.isArray(loopsPayload.loops) ? loopsPayload.loops : [],
      definitionsDir: loopsPayload.definitionsDir || null,
      error: loopsPayload.error || null,
    },
  };
}

/** Canonical live-state keys shared by History, Graph, filters, and stats. */
const LIVE_STATES = Object.freeze(['waiting', 'working', 'failed', 'idle', 'completed']);
const STATE_LABELS = Object.freeze({
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  completed: 'Completed',
  failed: 'Failed',
});
/** Roll-up priority (highest first). */
const FILTER_PRIORITY = Object.freeze(['waiting', 'working', 'failed', 'idle', 'completed']);

/**
 * Per-session live filter/badge state (History rows, Graph leaves, Working counts).
 * "working" means actually working (activity working / displayState running from
 * OSC working or live runPid) — not merely herdr.runtime pane-alive.
 * @returns {'waiting'|'working'|'failed'|'idle'|'completed'}
 */
function sessionFilterState(s) {
  if (!s) return 'completed';
  if (s.awaitingInput || s.activityState === 'waiting') return 'waiting';
  // Completed turn: lifecycle done → completed; still-active/live pane → idle (not working).
  if (s.activityState === 'completed') {
    if (s.displayState === 'failed') return 'failed';
    if (s.displayState === 'running' || s.displayState === 'idle') return 'idle';
    return 'completed';
  }
  if (s.activityState === 'working' || s.displayState === 'running') return 'working';
  if (s.displayState === 'failed') return 'failed';
  if (s.displayState === 'idle') return 'idle';
  return 'completed';
}

/**
 * Project roll-up from session live states only: waiting > working > failed > idle > completed.
 * Empty project (no sessions) → idle. Never uses a project-level open/active flag.
 * @param {string[]} states
 * @returns {'waiting'|'working'|'failed'|'idle'|'completed'}
 */
function rollupProjectFilterState(states) {
  if (!states || states.length === 0) return 'idle';
  for (const key of FILTER_PRIORITY) {
    if (states.includes(key)) return key;
  }
  return 'idle';
}

function stateLabel(state) {
  if (state === 'running') return STATE_LABELS.working;
  if (state === 'done') return STATE_LABELS.completed;
  return STATE_LABELS[state] || STATE_LABELS.completed;
}

/** True when a project has no registry sessions (memory-folder-only clutter). */
function isSessionlessProject(p) {
  if (!p) return true;
  if (p.fromMemoryOnly) return true;
  const n = p.sessionCount != null ? Number(p.sessionCount) : null;
  if (n != null) return !(n > 0);
  return false;
}

/**
 * Dormant = roll-up idle/completed and last activity older than ACTIVE_PROJECT_MS
 * (same 24h window History uses for "active" projects). working/waiting/failed
 * are never dormant. Missing lastActivity is not treated as dormant (nothing to
 * compare against the threshold).
 *
 * @param {object|null|undefined} p
 * @param {number} [nowMs]
 * @param {number} [dormantAfterMs]
 * @returns {boolean}
 */
function isDormantProject(p, nowMs = Date.now(), dormantAfterMs = ACTIVE_PROJECT_MS) {
  if (!p) return false;
  const state = p.filterState || p.displayState || 'idle';
  if (state === 'working' || state === 'running' || state === 'waiting' || state === 'failed') {
    return false;
  }
  const last = parseTimeMs(p.lastActivity);
  if (last == null) return false;
  const windowMs = Number(dormantAfterMs);
  const threshold = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : ACTIVE_PROJECT_MS;
  return nowMs - last > threshold;
}

/**
 * Collapsible project → session → child tree with finished-turn Gantt markers.
 * Projects with any working/waiting session start expanded; fully dormant
 * projects start collapsed. Sessionless memory-only projects are grouped at
 * the bottom under "No sessions (N)" (collapsed by default). Manual collapse
 * is a client-side override.
 */
function buildHistoryTree({ projects, sessions, nowMs, sort = 'recent', messageMarkersById = {} } = {}) {
  const sessionById = new Map((sessions || []).map((s) => [s.id, s]));
  const childrenOf = new Map();
  for (const s of sessions || []) {
    if (!s || !s.parent || !sessionById.has(s.parent)) continue;
    const parent = sessionById.get(s.parent);
    // History tree is project-scoped: only nest same-project parent/child.
    // Cross-project workers still appear as roots under their own project.
    if (!parent || parent.project !== s.project) continue;
    if (!childrenOf.has(s.parent)) childrenOf.set(s.parent, []);
    childrenOf.get(s.parent).push(s);
  }

  let rangeStart = null;
  let rangeEnd = null;
  function noteRange(at) {
    const a = parseTimeMs(at);
    if (a == null) return;
    if (rangeStart == null || a < rangeStart) rangeStart = a;
    if (rangeEnd == null || a > rangeEnd) rangeEnd = a;
  }

  function sessionNode(s, depth) {
    const markers = runHistory.sessionActivityMarkers(s, { now: nowMs });
    for (const m of markers) noteRange(m.at);
    // Also bound the axis with session activity so empty-marker rows still fit.
    noteRange(s.lastUsed || s.lastRunAt || s.created);
    const msgMarkers = Array.isArray(messageMarkersById[s.id])
      ? messageMarkersById[s.id]
      : [];
    for (const m of msgMarkers) noteRange(m.at);
    const kids = (childrenOf.get(s.id) || [])
      .slice()
      .sort(sessionSortFn(sort))
      .map((c) => sessionNode(c, depth + 1));
    const filterState = sessionFilterState(s);
    const queuedCount = msgMarkers.filter((m) => m && m.status === 'queued' && m.direction === 'in').length;
    let sessionUsage = null;
    try {
      const turnsLib = require('./turns');
      const usageLib = require('./usage');
      const summary = withRecordedCredits(turnsLib.readUsageSummary(s.id), s.id);
      sessionUsage = usageLib.compactUsageSummary(summary);
    } catch (_) {
      sessionUsage = null;
    }
    return {
      id: s.id,
      kind: 'session',
      title: s.title,
      project: s.project,
      engine: s.engine,
      status: s.status,
      archived: Boolean(s.archived),
      archivedAt: s.archivedAt || null,
      displayState: s.displayState,
      activityState: s.activityState,
      awaitingInput: Boolean(s.awaitingInput),
      filterState,
      herdr: s.herdr || null,
      parent: s.parent || null,
      role: s.role || null,
      depth,
      created: s.created || null,
      lastActivity: s.lastUsed || s.lastRunAt || s.created || null,
      markers,
      // Legacy alias — empty (no span bars). Prefer markers.
      segments: [],
      children: kids,
      // Issue #2: per-row message markers (queued→waiting, read→idle, completed→completed).
      messageMarkers: msgMarkers,
      messageQueued: queuedCount,
      usage: sessionUsage,
    };
  }

  function sessionSortFn(mode) {
    return (a, b) => {
      if (mode === 'name') return String(a.title || '').localeCompare(String(b.title || ''));
      if (mode === 'created') {
        return String(b.created || '').localeCompare(String(a.created || ''));
      }
      if (mode === 'project') {
        const pc = String(a.project || '').localeCompare(String(b.project || ''));
        if (pc) return pc;
      }
      const am = parseTimeMs(a.lastUsed || a.lastRunAt || a.created) || 0;
      const bm = parseTimeMs(b.lastUsed || b.lastRunAt || b.created) || 0;
      return bm - am || String(a.title || '').localeCompare(String(b.title || ''));
    };
  }

  function isHistoryRoot(s) {
    if (!s.parent || !sessionById.has(s.parent)) return true;
    const parent = sessionById.get(s.parent);
    // Parent in another project → still a root under this project.
    return !parent || parent.project !== s.project;
  }

  const projectRows = (projects || []).map((p) => {
    const members = (sessions || []).filter((s) => s.project === p.name);
    const liveMembers = members.filter((s) => !s.archived);
    const filterStates = liveMembers.map(sessionFilterState);
    const rollup = rollupProjectFilterState(filterStates);
    const hasLiveAttention = rollup === 'waiting' || rollup === 'working';
    const sessionCount = p.sessionCount != null ? p.sessionCount : liveMembers.length;
    const archivedCount =
      p.archivedCount != null ? p.archivedCount : members.filter((s) => s.archived).length;
    const fromMemoryOnly =
      Boolean(p.fromMemoryOnly) || (sessionCount === 0 && archivedCount === 0);
    const roots = members.filter(isHistoryRoot);
    const childNodes = roots
      .slice()
      .sort(sessionSortFn(sort))
      .map((s) => sessionNode(s, 1));
    let projectUsage = null;
    try {
      const usageLib = require('./usage');
      const collect = (nodes, acc) => {
        for (const n of nodes || []) {
          if (n && n.usage) acc.push(n.usage);
          if (n && n.children) collect(n.children, acc);
        }
      };
      const summaries = [];
      collect(childNodes, summaries);
      projectUsage = usageLib.compactUsageSummary(
        usageLib.mergeUsageSummaries(summaries)
      );
    } catch (_) {
      projectUsage = null;
    }
    return {
      id: p.id,
      kind: 'project',
      name: p.name,
      // Same roll-up as projects[] (Graph hubs, detail badge, Working counts).
      displayState: rollup,
      filterState: rollup,
      active: !fromMemoryOnly && sessionCount > 0 && (Boolean(p.active) || hasLiveAttention),
      // Expand when any session is working or waiting; dormant projects start collapsed.
      collapsed: !hasLiveAttention,
      lastActivity: p.lastActivity,
      sessionCount,
      archivedCount,
      runningCount: p.runningCount,
      workingCount: p.runningCount,
      usage: projectUsage,
      fromMemoryOnly,
      depth: 0,
      children: childNodes,
      messageMarkers: [],
    };
  });

  const sortMode = HISTORY_SORTS.has(sort) ? sort : 'recent';
  function sortProjectRows(rows) {
    rows.sort((a, b) => {
      if (sortMode === 'name' || sortMode === 'project') {
        return String(a.name).localeCompare(String(b.name));
      }
      if (sortMode === 'created') {
        const am = parseTimeMs(a.lastActivity) || 0;
        const bm = parseTimeMs(b.lastActivity) || 0;
        return bm - am || String(a.name).localeCompare(String(b.name));
      }
      // recent (default): active first, then lastActivity desc
      if (a.active !== b.active) return a.active ? -1 : 1;
      const am = parseTimeMs(a.lastActivity) || 0;
      const bm = parseTimeMs(b.lastActivity) || 0;
      return bm - am || String(a.name).localeCompare(String(b.name));
    });
    return rows;
  }

  const withSessions = sortProjectRows(projectRows.filter((p) => !isSessionlessProject(p)));
  const noSessionRows = sortProjectRows(
    projectRows
      .filter((p) => isSessionlessProject(p))
      .map((p) => Object.assign({}, p, { depth: 1, collapsed: true }))
  );
  const noSessions =
    noSessionRows.length > 0
      ? {
          id: 'group:no-sessions',
          kind: 'no-sessions-group',
          label: `No sessions (${noSessionRows.length})`,
          collapsed: true,
          depth: 0,
          children: noSessionRows,
          messageMarkers: [],
        }
      : null;

  if (rangeStart == null) rangeStart = nowMs - 7 * 24 * 60 * 60 * 1000;
  if (rangeEnd == null || rangeEnd <= rangeStart) rangeEnd = rangeStart + 1;
  // Axis domain always reaches "now" so History presets can anchor the right edge
  // at wall clock even when the newest marker is older.
  rangeEnd = Math.max(rangeEnd, nowMs);

  return {
    sort: sortMode,
    range: {
      start: new Date(rangeStart).toISOString(),
      end: new Date(rangeEnd).toISOString(),
    },
    projects: withSessions,
    noSessions,
  };
}

/**
 * Detailed history panel payload for a project or session (lazy-loaded).
 * Always redacts sensitive values.
 */
function collectHistoryDetail(opts = {}) {
  const cache = opts.projectCache || projectLib.createLookupCache();
  const sessions =
    opts.sessions != null
      ? opts.sessions
      : registry.list({
          includeDone: true,
          includeArchived: opts.includeArchived === true,
        });
  const resolved =
    opts.memoryRepo != null
      ? { path: opts.memoryRepo }
      : memory.resolveMemoryRepo(opts.env || process.env);
  const memoryRepo = resolved && resolved.path;
  const context =
    opts.memoryProjects != null
      ? { projects: opts.memoryProjects, errors: [] }
      : loadMemoryProjects(memoryRepo);
  const completions =
    opts.completionsById != null
      ? { bySessionId: opts.completionsById, errors: [] }
      : taskCompletions.collectTaskCompletions(sessions, {
          memoryRepo,
          capture: false,
          env: opts.env || process.env,
          projectCache: cache,
        });
  const checkpoints =
    opts.checkpoints != null
      ? opts.checkpoints
      : agentDocs.collectCheckpointStatuses(sessions, {
          now: opts.now,
          env: opts.env || process.env,
          projectCache: cache,
        });

  const projectName = opts.project
    ? projectLib.canonicalProjectName(opts.project)
    : null;
  const sessionId = opts.sessionId || null;

  let focusSessions = sessions;
  if (sessionId) {
    focusSessions = sessions.filter((s) => s && s.id === sessionId);
  } else if (projectName) {
    focusSessions = sessions.filter((s) => {
      const name = projectLib.resolveProjectName(s, { cache }) || projectLib.ADHOC_NAME;
      return name === projectName;
    });
  }

  const projectMemory =
    (context.projects || []).find((p) => p.project === (projectName || (focusSessions[0] && projectLib.resolveProjectName(focusSessions[0], { cache })))) ||
    null;
  const checkpoint =
    (checkpoints || []).find((c) => c && c.project === (projectMemory && projectMemory.project)) ||
    null;

  const lists = [];
  const msgMarkerLists = [];
  for (const s of focusSessions) {
    if (!s || !s.id) continue;
    const proj =
      projectLib.resolveProjectName(s, { cache }) || projectLib.ADHOC_NAME;
    lists.push(
      runHistory.historyEventsFromRunLogs(s, { project: proj, redact: true })
    );
    lists.push(
      runHistory.historyEventsFromTurns(s, { project: proj, redact: true })
    );
    lists.push(
      runHistory.historyEventsFromCompletions(s, completions.bySessionId[s.id], {
        project: proj,
        redact: true,
      })
    );
    const msgEvents = messagesLib.historyEventsFromMessages(s, {
      project: proj,
      redact: true,
    });
    lists.push(msgEvents);
    msgMarkerLists.push(
      ...(messagesLib.collectDashboardMessages([s]).bySessionId[s.id] || [])
    );
  }
  if (projectMemory) {
    lists.push(runHistory.historyEventsFromStatusNotes(projectMemory, { project: projectMemory.project }));
  }

  const history = runHistory.mergeHistoryEvents(lists, { max: runHistory.HISTORY_EVENTS_MAX });
  const leftOff = runHistory.buildLeftOff({
    sessions: focusSessions,
    completionsById: completions.bySessionId,
    projectMemory,
    checkpoint,
  });

  const dashMessages = messagesLib.collectDashboardMessages(focusSessions);

  let usageSummary = null;
  try {
    const turnsLib = require('./turns');
    const usageLib = require('./usage');
    if (sessionId && focusSessions[0]) {
      usageSummary = usageLib.compactUsageSummary(
        withRecordedCredits(turnsLib.readUsageSummary(focusSessions[0].id), focusSessions[0].id)
      );
    } else {
      const summaries = focusSessions
        .filter((s) => s && s.id)
        .map((s) => withRecordedCredits(turnsLib.readUsageSummary(s.id), s.id))
        .filter(Boolean);
      usageSummary = usageLib.compactUsageSummary(
        usageLib.mergeUsageSummaries(summaries)
      );
    }
  } catch (_) {
    usageSummary = null;
  }

  return {
    generatedAt: nowIso(),
    scope: sessionId
      ? { type: 'session', id: sessionId }
      : { type: 'project', name: projectName || (projectMemory && projectMemory.project) || null },
    leftOff,
    history,
    usageSummary,
    messages: {
      deferred: false,
      issue: 2,
      reason: null,
      items: dashMessages.items || [],
      messageMarkers: msgMarkerLists,
    },
    memoryErrors: context.errors || [],
  };
}

/**
 * Read optional memory per-project `_aflt/sessions.jsonl` records. Never throws.
 */
function loadMemoryRecords(memoryRepo) {
  const out = [];
  if (!memoryRepo) return out;
  let folders;
  try {
    folders = memory.listRepoProjectFolders(memoryRepo);
  } catch (_) {
    return out;
  }
  for (const folder of folders) {
    const file = path.join(memoryRepo, folder, memory.GENERATED_DIR, 'sessions.jsonl');
    let raw;
    try {
      if (!fs.existsSync(file)) continue;
      raw = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    for (const line of raw.split(/\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === 'object') {
          if (!obj.project) obj.project = folder;
          out.push(obj);
        }
      } catch (_) {
        /* skip bad line */
      }
    }
  }
  return out;
}

/**
 * Read only known Markdown documents, bounded and contained within the memory repo.
 * Markdown is displayed as text, never interpreted as HTML or executable links.
 */
function loadMemoryProjects(memoryRepo) {
  const result = { projects: [], errors: [] };
  if (!memoryRepo) return result;
  let root;
  let folders;
  try {
    root = fs.realpathSync(memoryRepo);
    folders = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name).sort();
  } catch (err) {
    result.errors.push(`Cannot read memory repo (${err.code || err.message})`);
    return result;
  }

  function contained(relative) {
    const real = fs.realpathSync(path.join(root, relative));
    const fromRoot = path.relative(root, real);
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      throw new Error('path resolves outside memory repo');
    }
    return real;
  }

  function readDocument(relative, kind, errors, limit = MEMORY_DOCUMENT_BYTES) {
    let fd;
    try {
      const real = contained(relative);
      if (!fs.statSync(real).isFile()) throw new Error('not a regular file');
      fd = fs.openSync(real, 'r');
      const buffer = Buffer.alloc(limit + 1);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const content = memory.redactSensitive(buffer.subarray(0, Math.min(size, limit)).toString('utf8'));
      const heading = content.match(/^#\s+(.+?)\s*$/m);
      return {
        kind,
        path: relative.split(path.sep).join('/'),
        title: heading ? heading[1] : path.basename(relative),
        content,
        truncated: size > limit,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(`${relative}: ${err.code || err.message}`);
      return null;
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }

  const dashboard = readDocument(memory.DASHBOARD_REL, 'summary', result.errors, 128 * 1024);
  const summaries = new Map();
  if (dashboard) {
    if (dashboard.truncated) result.errors.push('Doc Bot summary source exceeds 128 KiB; some summaries may be unavailable');
    const block = memory.extractDocBotSummaryInner(dashboard.content) || '';
    for (const line of block.split('\n')) {
      if (!line.trim().startsWith('|')) continue;
      const cells = line.trim().slice(1).replace(/\|$/, '').split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|'));
      if (cells.length !== 3 || /^:?-+:?$/.test(cells[0])) continue;
      const name = cells[0].replace(/^\[([^\]]+)\]\([^)]+\)$/, '$1').replace(/^`|`$/g, '');
      summaries.set(projectLib.canonicalProjectName(name), { moved: cells[1], blocked: cells[2] });
    }
  }

  for (const folder of folders) {
    const project = projectLib.canonicalProjectName(folder);
    if (project !== folder && folders.includes(project)) continue;
    const errors = [];
    try {
      if (!fs.statSync(contained(folder)).isDirectory()) continue;
    } catch (err) {
      result.errors.push(`${folder}: ${err.code || err.message}`);
      continue;
    }
    const documents = [];
    for (const [file, kind] of [['README.md', 'readme'], ['dashboard.md', 'dashboard']]) {
      const document = readDocument(path.join(folder, file), kind, errors);
      if (document) documents.push(document);
    }
    let archivedStatusNotes = 0;
    try {
      const notes = contained(path.join(folder, 'status-notes'));
      // Live notes only — ignore status-notes/archive/ when finding pickup docs.
      // aflt never auto-moves or deletes; archived files may be labeled below.
      const names = fs.readdirSync(notes, { withFileTypes: true })
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) &&
          /^\d{4}-\d{2}-\d{2}.*\.md$/i.test(entry.name))
        .map((entry) => entry.name).sort().reverse();
      for (const name of names.slice(0, MEMORY_STATUS_NOTES)) {
        const document = readDocument(path.join(folder, 'status-notes', name), 'status', errors);
        if (document) {
          documents.push({ ...document, date: name.slice(0, 10), archived: false });
        }
      }
      try {
        const archivedDir = path.join(notes, 'archive');
        archivedStatusNotes = fs.readdirSync(archivedDir, { withFileTypes: true })
          .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.md$/i.test(entry.name))
          .length;
      } catch (archErr) {
        if (archErr.code !== 'ENOENT') {
          errors.push(`${folder}/status-notes/archive: ${archErr.code || archErr.message}`);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') errors.push(`${folder}/status-notes: ${err.code || err.message}`);
    }
    result.projects.push({
      project,
      folder: memory.sanitizeFolderName(project),
      summary: summaries.get(project) || null,
      documents,
      archivedStatusNotes,
      archivePolicy: 'never-auto-move-or-delete',
      errors,
    });
  }
  return result;
}

/**
 * Collect live dashboard state. Never mutates registry; note capture is opt-in.
 */
function collectState(opts = {}) {
  const cache = opts.projectCache || projectLib.createLookupCache();
  // Include archived so the Show-archived toggle can filter client-side; stats
  // and Active roll-ups ignore them (see aggregateDashboard).
  const sessions =
    opts.sessions != null
      ? opts.sessions
      : registry.list({
          includeDone: true,
          includeArchived: opts.includeArchived !== false,
        });

  const resolved =
    opts.memoryRepo != null
      ? { path: opts.memoryRepo }
      : memory.resolveMemoryRepo(opts.env || process.env);
  const memoryRepo = resolved && resolved.path;
  const completions = taskCompletions.collectTaskCompletions(sessions, {
    cache: opts.completionCache,
    memoryRepo,
    capture: Boolean(opts.captureCompletions),
    env: opts.env || process.env,
    projectCache: cache,
  });
  const memoryRecords = opts.memoryRecords != null
    ? opts.memoryRecords : loadMemoryRecords(memoryRepo);
  const context = opts.memoryProjects != null
    ? { projects: opts.memoryProjects, errors: [] } : loadMemoryProjects(memoryRepo);

  let projectMetaById = opts.projectMetaById;
  if (projectMetaById == null) {
    projectMetaById = {};
    try {
      const projectMeta = require('./project-meta');
      const report = projectMeta.buildProjectsReport({
        memoryRepo,
        env: opts.env || process.env,
      });
      for (const p of report.projects || []) {
        if (p && p.id) projectMetaById[p.id] = p;
      }
    } catch (_) {
      projectMetaById = {};
    }
  }

  let enrichmentById = opts.enrichmentById;
  if (enrichmentById == null) {
    enrichmentById = {};
    let fetchResult = opts.herdrFetch;
    if (fetchResult == null) {
      try {
        fetchResult = herdr.fetchHerdrTerminals(opts.herdrOpts || {});
      } catch (_) {
        fetchResult = { ok: false, error: 'herdr fetch failed', terminals: [], checkedAt: nowIso() };
      }
    }
    if (fetchResult && fetchResult.ok) {
      const enriched = herdr.enrichSessions(sessions, fetchResult);
      for (const e of enriched) {
        if (e && e.session && e.session.id) {
          enrichmentById[e.session.id] = e;
        }
      }
    }
  }

  const sessionActivityById = {};
  const previousActivityById = {};
  const nowMs = opts.now != null ? new Date(opts.now).getTime() : Date.now();
  for (const session of sessions) {
    if (!session || !session.id) continue;
    const prev = opts.waitingState?.get(session.id);
    if (prev) previousActivityById[session.id] = prev;
    const next = sessionInputState(session, enrichmentForSession(session, enrichmentById),
      prev, nowMs);
    sessionActivityById[session.id] = next;
    if (opts.waitingState) opts.waitingState.set(session.id, next);
  }
  if (opts.waitingState) {
    for (const id of opts.waitingState.keys()) {
      if (!Object.hasOwn(sessionActivityById, id)) opts.waitingState.delete(id);
    }
  }

  // Interactive turn capture → local runs/<id>/turns.jsonl (always; not gated by
  // --capture-completions). Memory status-notes remain opt-in above.
  let turnErrors = [];
  if (opts.captureTurns !== false) {
    try {
      const captured = turns.captureSessions(sessions, {
        env: opts.env || process.env,
        cache: opts.turnCache,
        sessionActivityById,
        previousActivityById,
        captureOsc: opts.captureOsc !== false,
      });
      turnErrors = captured.errors || [];
    } catch (err) {
      turnErrors = [memory.redactSensitive(String(err && err.message ? err.message : err))];
    }
  }

  const checkpoints = agentDocs.collectCheckpointStatuses(sessions, {
    now: opts.now,
    env: opts.env || process.env,
    projectCache: cache,
  });
  let docBotQueue = null;
  try {
    docBotQueue = agentDocs.summarizeDocBotQueue();
  } catch (_) {
    docBotQueue = null;
  }

  let loops = { ok: true, loops: [], definitionsDir: null };
  let loopSessionOutcomes = opts.loopSessionOutcomes || null;
  if (opts.loops != null) {
    loops = opts.loops;
  } else {
    if (!loopSessionOutcomes) {
      try {
        loopSessionOutcomes = loopLib.collectSessionOutcomes();
      } catch (_) {
        loopSessionOutcomes = null;
      }
    }
    try {
      const report = (opts.loopStatusReport || loopLib.statusReport)(null);
      loops = {
        ok: report.ok !== false,
        loops: report.loops || [],
        definitionsDir: loopLib.resolveDefinitionsDir(),
        error: report.error || null,
      };
    } catch (err) {
      loops = {
        ok: false,
        loops: [],
        definitionsDir: null,
        error: String(err && err.message ? err.message : err),
      };
    }
  }

  return aggregateDashboard({
    sessions,
    memoryRecords,
    memoryProjects: context.projects,
    memoryErrors: context.errors,
    memoryConfigured: Boolean(memoryRepo),
    projectMetaById,
    enrichmentById,
    sessionActivityById,
    completionsById: completions.bySessionId,
    completionErrors: [...(completions.errors || []), ...turnErrors].slice(0, 40),
    captureCompletions: opts.captureCompletions,
    checkpoints,
    docBotQueue,
    loops,
    loopSessionOutcomes,
    now: opts.now,
    isAlive: opts.isAlive,
    projectCache: cache,
  });
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stateColor(displayState) {
  // Canonical: Working green, Waiting orange, Idle gray, Completed blue, Failed red.
  switch (displayState) {
    case 'working':
    case 'running':
      return '#16a34a';
    case 'waiting':
      return '#f59e0b';
    case 'idle':
      return '#919191';
    case 'completed':
    case 'done':
      return '#0078d4';
    case 'failed':
      return '#dc2626';
    default:
      return '#919191';
  }
}

function layoutGraph(state, width, height, opts = {}) {
  const cx = width * 0.42;
  const cy = height * 0.5;
  const projects = state.projects || [];
  const sessions = state.sessions || [];
  const nodes = [];
  const edges = [];
  const hideDormant = opts.hideDormant !== false;
  const nowMs = parseTimeMs(state.generatedAt) != null ? parseTimeMs(state.generatedAt) : Date.now();
  const dormantAfterMs =
    state.dormantAfterMs != null ? Number(state.dormantAfterMs) : ACTIVE_PROJECT_MS;

  const hubR = Math.min(width, height) * 0.28;
  const projectPos = new Map();

  // Sessionless memory-only projects stay out of the Graph (History group only).
  // Dormant hubs (idle/done + stale lastActivity) are hidden by default.
  const graphProjects = projects.filter((p) => {
    if (isSessionlessProject(p)) return false;
    if (hideDormant && isDormantProject(p, nowMs, dormantAfterMs)) return false;
    return true;
  });
  const graphN = Math.max(graphProjects.length, 1);
  graphProjects.forEach((p, i) => {
    const angle = (i / graphN) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * hubR;
    const y = cy + Math.sin(angle) * hubR;
    projectPos.set(p.name, { x, y, angle });
    nodes.push({
      id: p.id,
      kind: 'project',
      label: p.name,
      displayState: p.displayState,
      x,
      y,
      r: 22,
    });
  });

  const visibleProjectNames = new Set(graphProjects.map((p) => p.name));
  const includeArchived = opts.includeArchived === true;
  const byProject = new Map();
  for (const s of sessions) {
    if (s.archived && !includeArchived) continue;
    const key = s.project || projectLib.ADHOC_NAME;
    if (!visibleProjectNames.has(key)) continue;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(s);
  }

  for (const [pname, list] of byProject) {
    const hub = projectPos.get(pname) || { x: cx, y: cy, angle: 0 };
    const m = list.length;
    const orbit = 58 + Math.min(m, 8) * 4;
    list.forEach((s, i) => {
      const base = hub.angle != null ? hub.angle : 0;
      const a = base + ((i - (m - 1) / 2) * (Math.PI / Math.max(m + 1, 4)));
      const x = hub.x + Math.cos(a) * orbit;
      const y = hub.y + Math.sin(a) * orbit;
      nodes.push({
        id: s.id,
        kind: 'session',
        label: s.nodeLabel || sessionNodeLabel(s.id),
        displayState: s.displayState,
        activityState: s.activityState,
        completion: s.completion,
        awaitingInput: s.awaitingInput,
        recent: Boolean(s.recent),
        x,
        y,
        r: 9,
      });
    });
  }

  const visibleIds = new Set(nodes.map((n) => n.id));
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  for (const link of state.links || []) {
    if (!visibleIds.has(link.from) || !visibleIds.has(link.to)) continue;
    edges.push({ ...link, recent: Boolean(sessionById.get(link.to)?.recent) });
  }

  return { nodes, edges, cx, cy };
}

function sparklinePath(series, x, y, w, h) {
  const vals = Array.isArray(series) ? series : [];
  if (vals.length === 0) return '';
  const max = Math.max(1, ...vals);
  const step = w / Math.max(vals.length - 1, 1);
  const pts = vals.map((v, i) => {
    const px = x + i * step;
    const py = y + h - (v / max) * h;
    return `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
  });
  return pts.join(' ');
}

/**
 * Standalone SVG snapshot of graph + stats + short timeline.
 */
function renderSvg(state, opts = {}) {
  const width = opts.width || 1200;
  const height = opts.height || 720;
  const panelW = 320;
  const graphW = width - panelW;
  const layout = layoutGraph(state, graphW, height);
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const stats = state.stats || {};
  const engines = stats.engines || {};

  const edgeEls = layout.edges
    .map((e) => {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) return '';
      const stroke = e.recent ? 'rgba(45,212,191,0.55)' : 'rgba(100,116,139,0.35)';
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${stroke}" stroke-width="1.4"/>`;
    })
    .join('\n');

  const sessionById = new Map((state.sessions || []).map((s) => [s.id, s]));
  const nodeEls = layout.nodes
    .map((n) => {
      const fill = stateColor(n.activityState || (n.awaitingInput ? 'waiting' : n.displayState));
      if (n.kind === 'project') {
        const context = (state.projects || []).find((p) => p.id === n.id);
        const info = context && context.memory;
        const description = 'Doc Bot summary\n' +
          (info?.summary ? info.summary.moved : 'No Doc Bot summary recorded for this project.');
        return `<g>
  <title>${escapeXml(description)}</title>
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="rgba(15,23,42,0.9)" stroke="${fill}" stroke-width="2"/>
  <text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 14).toFixed(1)}" text-anchor="middle" fill="#e2e8f0" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif" letter-spacing="0.04em">${escapeXml(n.label)}</text>
</g>`;
      }
      const session = sessionById.get(n.id);
      const liveKey = session
        ? sessionFilterState(session)
        : (n.awaitingInput ? 'waiting' : n.activityState || n.displayState || 'idle');
      const description = [
        `State: ${stateLabel(liveKey)}`,
        `Session ID: ${n.id}`,
        `Engine: ${session?.engine || 'unknown'}`,
        `Status: ${session?.status || 'unknown'}`,
        `Herdr status: ${session?.herdr?.runtime || 'unknown'}`,
      ].join('\n');
      const label = `<text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 14).toFixed(1)}" text-anchor="middle" fill="#94a3b8" font-size="10" font-family="Consolas, 'Courier New', Courier, monospace">${escapeXml(n.label)}</text>`;
      const title = `<title>${escapeXml(description)}</title>`;
      if (n.awaitingInput) {
        return `<g>${title}
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${fill}"/>
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r + 4}" fill="none" stroke="${fill}" stroke-dasharray="3 3"/>
  <text x="${(n.x + n.r + 6).toFixed(1)}" y="${(n.y - n.r + 2).toFixed(1)}" fill="${fill}" font-size="13" font-weight="bold">?</text>${label}</g>`;
      }
      if (n.activityState === 'working') {
        return `<g>${title}
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${fill}"/>
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r + 4}" fill="none" stroke="${fill}" stroke-width="2" pathLength="100" stroke-dasharray="25 75"/>${label}</g>`;
      }
      if (n.activityState === 'completed') {
        return `<g>${title}
  <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${fill}"/>${label}</g>`;
      }
      const circle = `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${fill}" opacity="0.9"/>`;
      return `<g>${title}${circle}${label}</g>`;
    })
    .join('\n');

  const spark24 = sparklinePath(state.sparkline24h, width - panelW + 24, 210, panelW - 48, 36);
  const spark7 = sparklinePath(state.sparkline7d, width - panelW + 24, 280, panelW - 48, 36);

  const eventLines = (state.events || [])
    .slice(0, 10)
    .map((ev, i) => {
      const yy = 360 + i * 22;
      return `<text x="${width - panelW + 24}" y="${yy}" fill="#94a3b8" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml((ev.text || '').slice(0, 42))}</text>`;
    })
    .join('\n');

  const stars = [];
  for (let i = 0; i < 60; i++) {
    const sx = (i * 97) % graphW;
    const sy = (i * 53) % height;
    const o = 0.15 + (i % 5) * 0.05;
    stars.push(`<circle cx="${sx}" cy="${sy}" r="1" fill="#94a3b8" opacity="${o}"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="bg" cx="40%" cy="45%" r="65%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </radialGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="rgba(148,163,184,0.06)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect width="${graphW}" height="${height}" fill="url(#grid)"/>
  ${stars.join('\n')}
  <g>${edgeEls}</g>
  <g>${nodeEls}</g>
  <rect x="${graphW}" y="0" width="${panelW}" height="${height}" fill="rgba(2,6,23,0.82)" stroke="rgba(45,212,191,0.15)"/>
  <text x="${graphW + 24}" y="42" fill="#f8fafc" font-size="22" font-family="ui-sans-serif, system-ui, sans-serif" font-weight="600" letter-spacing="0.12em">${escapeXml(state.space ? `aflt live · ${state.space}` : 'aflt live')}</text>
  <text x="${graphW + 24}" y="64" fill="#64748b" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(state.space ? `space ${state.space} · ` : '')}local · snapshot ${escapeXml(formatSnapshotStamp(state.generatedAt))}</text>
  <text x="${graphW + 24}" y="110" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">ACTIVE PROJECTS</text>
  <text x="${graphW + 24}" y="132" fill="#f8fafc" font-size="28" font-variant-numeric="tabular-nums" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${stats.activeProjects || 0}</text>
  <text x="${graphW + 140}" y="110" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">WORKING</text>
  <text x="${graphW + 140}" y="132" fill="#16a34a" font-size="28" font-variant-numeric="tabular-nums" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">${stats.workingSessions != null ? stats.workingSessions : (stats.runningSessions || 0)}</text>
  <text x="${graphW + 24}" y="168" fill="#94a3b8" font-size="10" font-family="ui-sans-serif, system-ui, sans-serif">cursor ${engines.cursor || 0} · copilot ${engines.copilot || 0} · opencode ${engines.opencode || 0} · Working ${stats.open || 0} · Waiting ${stats.waiting || 0} · Idle ${stats.idle || 0} · Completed ${stats.completed != null ? stats.completed : (stats.done || 0)} · Failed ${stats.failed || 0}</text>
  <text x="${graphW + 24}" y="200" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">LAST 24H</text>
  <path d="${spark24}" fill="none" stroke="#2dd4bf" stroke-width="1.5"/>
  <text x="${graphW + 24}" y="270" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">LAST 7D</text>
  <path d="${spark7}" fill="none" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="${graphW + 24}" y="340" fill="#94a3b8" font-size="10" letter-spacing="0.08em" font-family="ui-sans-serif, system-ui, sans-serif">RECENT</text>
  ${eventLines}
</svg>
`;
}

function renderHtmlDocument(state) {
  const css = readAsset('dashboard.css');
  const dataJson = JSON.stringify(state).replace(/</g, '\\u003c');
  const title = state && state.space ? `aflt live · ${state.space}` : 'aflt live';
  return readAsset('index.html')
    .replace('<title>aflt live</title>', `<title>${escapeXml(title)}</title>`)
    .replace('<div class="brand">aflt live</div>', `<div class="brand">${escapeXml(title)}</div>`)
    .replace('<link rel="stylesheet" href="/dashboard.css"/>', () => `<style>${css}</style>`)
    .replace('<script src="/marked.min.js"></script>', () =>
      `<script>${readAsset('marked.min.js')}</script>`)
    .replace('<script src="/dashboard.js"></script>', () =>
      `<script type="application/json" id="aflt-dashboard-data">${dataJson}</script>\n` +
      `<script>${readAsset('dashboard.js')}</script>`);
}

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#1f6feb"/>' +
  '<path d="M9 22l7-12 7 12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M12 18h8" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>';

function readAsset(name) {
  return fs.readFileSync(path.join(ASSET_DIR, name), 'utf8');
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function writeSnapshot(filePath, state) {
  const abs = path.resolve(expandUserPath(filePath));
  const ext = path.extname(abs).toLowerCase();
  let body;
  if (ext === '.svg') {
    body = renderSvg(state);
  } else if (ext === '.html' || ext === '.htm') {
    body = renderHtmlDocument(state);
  } else {
    const err = new Error(
      `unsupported snapshot extension "${ext || '(none)'}"; use .svg or .html`
    );
    err.code = 'DASHBOARD_SNAPSHOT_EXT';
    throw err;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return abs;
}

/**
 * Create the HTTP server (does not listen yet).
 * @returns {{ server: http.Server, close: () => Promise<void>, getState: () => object }}
 */
function createDashboardServer(opts = {}) {
  const herdrFocusToken = crypto.randomBytes(32).toString('hex');
  const actionToken = herdrFocusToken;
  let focusingHerdr = false;
  let mutating = false;
  const waitingState = new Map();
  const completionCache = new Map();
  const collect = typeof opts.collect === 'function' ? opts.collect : () => collectState({ ...opts, waitingState, completionCache });
  const sseClients = new Set();
  let lastPayload = null;
  let lastRegistryMtime = null;
  let closed = false;
  let watchHandle = null;
  let pollTimer = null;
  let sseTimer = null;
  const loopSchedulerEnabled = opts.loopScheduler !== false;
  const loopScheduler =
    opts.loopSchedulerHandle !== undefined
      ? opts.loopSchedulerHandle
      : loopSchedulerEnabled
        ? createLoopScheduler({
            pollMs: opts.loopSchedulerPollMs,
            resumeLoop: opts.resumeLoop,
            listCandidates: opts.listSchedulerCandidates,
            statusReport: opts.loopStatusReport,
            runOpts: opts.loopRunOpts,
            onError: opts.onLoopSchedulerError,
          })
        : null;

  function registryMtime() {
    try {
      return fs.statSync(registryPath()).mtimeMs;
    } catch (_) {
      return null;
    }
  }

  function refresh(reason) {
    if (closed) return lastPayload;
    try {
      lastPayload = {
        ...collect(),
        actions: { herdrFocusToken, actionToken },
      };
    } catch (err) {
      lastPayload = {
        generatedAt: nowIso(),
        error: String(err && err.message ? err.message : err),
        defaultView: 'history',
        views: ['history', 'graph'],
        historySort: 'recent',
        historyTree: { sort: 'recent', range: { start: nowIso(), end: nowIso() }, projects: [] },
        messages: { ...MESSAGES_HOOK },
        checkpoints: {
          projects: [],
          missing: 0,
          overdue: 0,
          retryDue: 0,
          docBotQueue: { pending: 0, batches: 0, batchesAcked: 0 },
          docBotNotify: agentDocs.DOC_BOT_NOTIFY_DEFERRED,
        },
        stats: {
          activeProjects: 0,
          runningSessions: 0,
          engines: { cursor: 0, copilot: 0 },
          open: 0,
          idle: 0,
          done: 0,
          failed: 0,
          sessions: 0,
          projects: 0,
        },
        projects: [],
        sessions: [],
        links: [],
        sparkline24h: new Array(24).fill(0),
        sparkline7d: new Array(7).fill(0),
        events: [],
        memory: { present: false, recordCount: 0 },
      };
    }
    const data = `data: ${JSON.stringify(lastPayload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch (_) {
        sseClients.delete(res);
      }
    }
    return lastPayload;
  }

  function checkRegistryChange() {
    const mt = registryMtime();
    if (mt != null && mt !== lastRegistryMtime) {
      lastRegistryMtime = mt;
      refresh('registry');
    }
  }

  function readJsonBody(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!chunks.length) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (err) {
          reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  function dashboardHostAllowed(req) {
    const raw = req.headers && req.headers.host;
    if (!raw || typeof raw !== 'string') return false;
    let hostname = '';
    try {
      hostname = new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch (_) {
      return false;
    }
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    const bind = String(opts.host != null ? opts.host : DEFAULT_HOST)
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    if (bind === '0.0.0.0' || bind === '::' || bind === '::0') return true;
    return hostname === bind;
  }

  function isLocalActionRequest(req, u) {
    const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    const token = req.headers['x-aflt-action-token'];
    return (
      loopback.has(req.socket.remoteAddress) &&
      ['localhost', '127.0.0.1', '::1'].includes(hostname) &&
      !(req.headers.origin && req.headers.origin !== u.origin) &&
      (token === herdrFocusToken || token === actionToken)
    );
  }

  function enrichmentForId(sessionId) {
    try {
      const state = lastPayload || collect();
      const row = (state.sessions || []).find((s) => s && s.id === sessionId);
      return row && row.herdr ? row.herdr : null;
    } catch (_) {
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = u.pathname;

    const jsonReply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    // Same Host allowlist as loopback actions, including read endpoints, so a
    // DNS-rebinding page cannot read the dashboard by pointing a hostile name
    // at this process.
    if (!dashboardHostAllowed(req)) {
      jsonReply(403, { error: 'Host is not allowed for this dashboard.' });
      return;
    }

    // Making-of viewer for loops in this space (read-only).
    if (pathname === '/making-of' || pathname.startsWith('/making-of/')) {
      (opts.handleMakingOf || require('./making-of').handleMakingOfRequest)(req, res, pathname, {
        back: '/',
        backLabel: '← dashboard',
      });
      return;
    }

    if (pathname.startsWith('/api/herdr/focus/')) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        jsonReply(405, { error: 'Use POST to focus a Herdr terminal.' });
        return;
      }
      if (!isLocalActionRequest(req, u)) {
        jsonReply(403, { error: 'Herdr focus requires a request from the local dashboard. Refresh the page and try again.' });
        return;
      }
      let session;
      try {
        const id = decodeURIComponent(pathname.slice('/api/herdr/focus/'.length));
        session = registry.findExact(id);
        if (session && session.id !== id) session = null;
      } catch (err) {
        jsonReply(400, { error: `Invalid session: ${err.message}` });
        return;
      }
      if (!session) {
        jsonReply(404, { error: 'This session is no longer registered.' });
        return;
      }
      if (focusingHerdr) {
        jsonReply(409, { error: 'Another Herdr terminal is being opened. Try again shortly.' });
        return;
      }
      focusingHerdr = true;
      try {
        const result = await (opts.focusHerdrSession || focusHerdrSession)(session);
        jsonReply(200, { ok: true, ...result });
      } catch (err) {
        jsonReply(502, { error: String(err.message || err) });
      } finally {
        focusingHerdr = false;
      }
      return;
    }

    // --- loop scheduler / UI API (milestone 2–3) ---
    if (pathname === '/api/loops') {
      if (req.method === 'GET') {
        try {
          const report = (opts.loopStatusReport || loopLib.statusReport)(null);
          const sched = loopScheduler ? loopScheduler.getStatus() : { runners: [], closed: true };
          jsonReply(200, {
            ok: true,
            loops: report.loops || [],
            definitionsDir: loopLib.resolveDefinitionsDir(),
            scheduler: {
              enabled: Boolean(loopScheduler),
              closed: Boolean(sched.closed),
              pollMs: sched.pollMs != null ? sched.pollMs : null,
              runners: sched.runners || [],
            },
          });
        } catch (err) {
          jsonReply(500, { error: String(err && err.message ? err.message : err) });
        }
        return;
      }
      if (req.method === 'POST') {
        // Save a new/updated loop definition (validated; allowed dirs only).
        if (!isLocalActionRequest(req, u)) {
          jsonReply(403, {
            error:
              'Saving a loop requires a request from the local dashboard. Refresh the page and try again.',
          });
          return;
        }
        let body = {};
        try {
          body = await readJsonBody(req, 256 * 1024);
        } catch (err) {
          jsonReply(err.statusCode || 400, { error: String(err.message || err) });
          return;
        }
        const raw = body.definition != null ? body.definition : body;
        try {
          const result = (opts.loopSave || loopLib.saveDefinition)(raw, {
            checkCwd: body.checkCwd !== false,
            checkPromptFiles: body.checkPromptFiles !== false,
            definitionsDir: body.definitionsDir,
          });
          if (!result.ok) {
            jsonReply(400, {
              ok: false,
              errors: result.errors || [result.error || 'validation failed'],
              warnings: result.warnings || [],
            });
            return;
          }
          jsonReply(200, {
            ok: true,
            path: result.path,
            name: result.definition && result.definition.name,
            warnings: result.warnings || [],
            definition: result.writable || null,
          });
        } catch (err) {
          jsonReply(500, { error: String(err && err.message ? err.message : err) });
        }
        return;
      }
      res.setHeader('Allow', 'GET, POST');
      jsonReply(405, { error: 'Use GET or POST for /api/loops.' });
      return;
    }

    if (pathname === '/api/loops/definitions') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        jsonReply(405, { error: 'Use GET for /api/loops/definitions.' });
        return;
      }
      try {
        const listed = (opts.loopListDefinitions || loopLib.listSavedDefinitions)();
        jsonReply(200, listed);
      } catch (err) {
        jsonReply(500, { error: String(err && err.message ? err.message : err) });
      }
      return;
    }

    if (pathname === '/api/loops/start') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        jsonReply(405, { error: 'Use POST for /api/loops/start.' });
        return;
      }
      if (!isLocalActionRequest(req, u)) {
        jsonReply(403, {
          error:
            'Starting a loop requires a request from the local dashboard. Refresh the page and try again.',
        });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (err) {
        jsonReply(err.statusCode || 400, { error: String(err.message || err) });
        return;
      }
      try {
        let result;
        if (body.path != null && String(body.path).trim()) {
          result = (opts.loopStart || loopLib.startFromPath)(String(body.path).trim(), {
            fresh: Boolean(body.fresh),
            requireAllowedPath: body.requireAllowedPath === false ? false : true,
          });
        } else if (body.name != null && String(body.name).trim()) {
          const loaded = (opts.loopLoadDefinition || loopLib.loadSavedDefinition)(
            String(body.name).trim()
          );
          if (!loaded.ok) {
            jsonReply(404, { error: loaded.error || 'definition not found' });
            return;
          }
          result = (opts.loopStart || loopLib.startFromPath)(loaded.path, {
            fresh: Boolean(body.fresh),
            requireAllowedPath: true,
          });
        } else {
          jsonReply(400, { error: 'Provide { path } or { name }.' });
          return;
        }
        if (!result.ok) {
          const status = result.code === 'LOOP_PATH' ? 403 : result.errors ? 400 : 409;
          jsonReply(status, {
            ok: false,
            error: result.error || 'loop start failed',
            errors: result.errors,
            warnings: result.warnings || [],
          });
          return;
        }
        if (loopScheduler) {
          Promise.resolve()
            .then(() => loopScheduler.tick())
            .catch(() => {});
        }
        jsonReply(200, {
          ok: true,
          name: result.state && result.state.name,
          status: result.status,
          active: result.state ? Boolean(result.state.active) : true,
          path: result.path,
          message: result.message,
          warnings: result.warnings || [],
        });
      } catch (err) {
        jsonReply(500, { error: String(err && err.message ? err.message : err) });
      }
      return;
    }

    const loopActionMatch = pathname.match(
      /^\/api\/loops\/([^/]+)(?:\/(pause|resume|stop|approve|definition))?$/
    );
    if (loopActionMatch) {
      let loopName;
      try {
        loopName = decodeURIComponent(loopActionMatch[1]);
      } catch (_) {
        jsonReply(400, { error: 'Invalid loop name.' });
        return;
      }
      if (loopLib.RESERVED_LOOP_ROUTE_NAMES.has(loopName)) {
        jsonReply(404, { error: `Unknown loop route: ${loopName}` });
        return;
      }
      const action = loopActionMatch[2] || null;

      if (!action) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          jsonReply(405, { error: 'Use GET for /api/loops/:name.' });
          return;
        }
        try {
          const report = (opts.loopStatusReport || loopLib.statusReport)(loopName);
          if (!report.ok) {
            jsonReply(404, { error: report.error || 'loop not found' });
            return;
          }
          jsonReply(200, {
            ...report,
            schedulerRunning: Boolean(loopScheduler && loopScheduler.isRunning(loopName)),
          });
        } catch (err) {
          jsonReply(500, { error: String(err && err.message ? err.message : err) });
        }
        return;
      }

      if (action === 'definition') {
        if (req.method === 'GET') {
          try {
            const loaded = (opts.loopLoadDefinition || loopLib.loadSavedDefinition)(loopName);
            if (!loaded.ok) {
              jsonReply(404, { error: loaded.error || 'definition not found' });
              return;
            }
            jsonReply(200, {
              ok: true,
              name: loopName,
              path: loaded.path,
              source: loaded.source,
              definition: loaded.definition,
            });
          } catch (err) {
            jsonReply(500, { error: String(err && err.message ? err.message : err) });
          }
          return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          if (!isLocalActionRequest(req, u)) {
            jsonReply(403, {
              error:
                'Saving a loop requires a request from the local dashboard. Refresh the page and try again.',
            });
            return;
          }
          let body = {};
          try {
            body = await readJsonBody(req, 256 * 1024);
          } catch (err) {
            jsonReply(err.statusCode || 400, { error: String(err.message || err) });
            return;
          }
          const raw = body.definition != null ? body.definition : body;
          if (!raw.name) raw.name = loopName;
          try {
            const result = (opts.loopSave || loopLib.saveDefinition)(raw, {
              checkCwd: body.checkCwd !== false,
              checkPromptFiles: body.checkPromptFiles !== false,
            });
            if (!result.ok) {
              jsonReply(400, {
                ok: false,
                errors: result.errors || [result.error || 'validation failed'],
                warnings: result.warnings || [],
              });
              return;
            }
            jsonReply(200, {
              ok: true,
              path: result.path,
              name: result.definition && result.definition.name,
              warnings: result.warnings || [],
              definition: result.writable || null,
            });
          } catch (err) {
            jsonReply(500, { error: String(err && err.message ? err.message : err) });
          }
          return;
        }
        res.setHeader('Allow', 'GET, POST, PUT');
        jsonReply(405, { error: 'Use GET or POST for /api/loops/:name/definition.' });
        return;
      }

      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        jsonReply(405, { error: `Use POST for /api/loops/:name/${action}.` });
        return;
      }
      if (!isLocalActionRequest(req, u)) {
        jsonReply(403, {
          error:
            'Loop control requires a request from the local dashboard. Refresh the page and try again.',
        });
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch (err) {
        jsonReply(err.statusCode || 400, { error: String(err.message || err) });
        return;
      }
      try {
        let result;
        if (action === 'pause') {
          result = (opts.loopPause || loopLib.requestPause)(loopName, body);
        } else if (action === 'resume') {
          result = (opts.loopResume || loopLib.requestResume)(loopName, {
            force: Boolean(body.force),
          });
          if (result && result.ok && loopScheduler) {
            Promise.resolve()
              .then(() => loopScheduler.tick())
              .catch(() => {});
          }
        } else if (action === 'stop') {
          result = (opts.loopStop || loopLib.requestStop)(loopName, body);
        } else if (action === 'approve') {
          result = (opts.loopApprove || loopLib.requestApprove)(loopName, {
            phaseId: body.phaseId,
            force: Boolean(body.force),
            env: opts.env,
          });
          if (result && result.notify && typeof result.notify.then === 'function') {
            result.notify.catch(() => {});
          }
          if (result && result.ok && loopScheduler) {
            Promise.resolve()
              .then(() => loopScheduler.tick())
              .catch(() => {});
          }
        }
        if (!result || !result.ok) {
          const conflict =
            result &&
            (result.status === 'failed' ||
              result.status === 'waiting' ||
              result.status === 'stopped');
          jsonReply(conflict ? 409 : 404, {
            error: (result && result.error) || `loop ${action} failed`,
            status: result && result.status,
          });
          return;
        }
        jsonReply(200, {
          ok: true,
          action,
          name: loopName,
          status: result.status,
          active: result.state ? Boolean(result.state.active) : undefined,
          pauseRequested: result.pauseRequested,
          stopRequested: result.stopRequested,
          phaseId: result.phaseId,
          gate: result.state && result.state.gate ? result.state.gate : undefined,
        });
      } catch (err) {
        jsonReply(500, { error: String(err && err.message ? err.message : err) });
      }
      return;
    }

    const mutationRoutes = new Set([
      '/api/session/archive',
      '/api/session/unarchive',
      '/api/session/delete',
      '/api/session/purge',
      '/api/project/archive-idle',
    ]);
    if (mutationRoutes.has(pathname)) {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        jsonReply(405, { error: 'Use POST for dashboard mutations.' });
        return;
      }
      if (!isLocalActionRequest(req, u)) {
        jsonReply(403, {
          error:
            'Archive/delete only works on the Mini — open this dashboard at 127.0.0.1 locally.',
        });
        return;
      }
      if (mutating) {
        jsonReply(409, { error: 'Another archive/delete is in progress. Try again shortly.' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        jsonReply(err.statusCode || 400, { error: String(err.message || err) });
        return;
      }
      mutating = true;
      try {
        if (pathname === '/api/project/archive-idle') {
          const project = body.project != null ? String(body.project).trim() : '';
          if (!project) {
            jsonReply(400, { error: 'Provide { project }.' });
            return;
          }
          const state = lastPayload || collect();
          const byId = new Map((state.sessions || []).map((s) => [s.id, s]));
          const result = archiveLib.archiveIdleDoneInProject(project, {
            force: Boolean(body.force),
            enrichmentById: Object.fromEntries(
              [...byId.entries()].map(([id, s]) => [id, s.herdr ? { status: s.herdr.status, runtime: s.herdr.runtime } : null])
            ),
            filterStateOf: (s) => {
              const view = byId.get(s.id);
              if (!view) return s.status || 'idle';
              return sessionFilterState(view);
            },
            isAlive: opts.isAlive || orchestrate.defaultIsAlive,
          });
          if (!result.ok) {
            jsonReply(409, { error: result.error || 'Unable to archive idle sessions.', skipped: result.skipped });
            return;
          }
          lastRegistryMtime = registryMtime();
          const next = refresh('archive-idle');
          jsonReply(200, {
            ok: true,
            archived: (result.sessions || []).map((s) => ({ id: s.id, title: s.title })),
            skipped: result.skipped || [],
            state: next,
          });
          return;
        }

        const id = body.id != null ? String(body.id).trim() : '';
        if (!id) {
          jsonReply(400, { error: 'Provide { id }.' });
          return;
        }
        const session = registry.findExact(id);
        if (!session || session.id !== id) {
          jsonReply(404, { error: 'This session is no longer registered.' });
          return;
        }
        const withChildren = Boolean(body.withChildren || body.with_children);
        const force = Boolean(body.force);
        const enrichment = enrichmentForId(id);

        if (pathname === '/api/session/archive') {
          const result = archiveLib.archiveSessions(session, {
            withChildren,
            force,
            enrichmentById: enrichment ? { [id]: enrichment } : {},
            isAlive: opts.isAlive || orchestrate.defaultIsAlive,
          });
          if (!result.ok) {
            jsonReply(409, { error: result.error || 'Unable to archive session.' });
            return;
          }
          lastRegistryMtime = registryMtime();
          jsonReply(200, {
            ok: true,
            archived: (result.sessions || []).map((s) => ({ id: s.id, title: s.title, archivedAt: s.archivedAt })),
            skipped: result.skipped || [],
            state: refresh('archive'),
          });
          return;
        }

        if (pathname === '/api/session/unarchive') {
          const result = archiveLib.unarchiveSessions(session, { withChildren });
          if (!result.ok) {
            jsonReply(409, { error: result.error || 'Unable to unarchive session.' });
            return;
          }
          lastRegistryMtime = registryMtime();
          jsonReply(200, {
            ok: true,
            unarchived: (result.sessions || []).map((s) => ({ id: s.id, title: s.title })),
            skipped: result.skipped || [],
            state: refresh('unarchive'),
          });
          return;
        }

        if (pathname === '/api/session/delete') {
          // Dashboard Delete: registry row only; never touch runs/<id>/ (or results/plans).
          const result = archiveLib.removeSession(session, {
            keepFiles: true,
            force,
            enrichment,
            isAlive: opts.isAlive || orchestrate.defaultIsAlive,
            home: fleetDir(),
          });
          if (!result.ok) {
            jsonReply(409, { error: result.error || 'Unable to delete session.' });
            return;
          }
          lastRegistryMtime = registryMtime();
          jsonReply(200, {
            ok: true,
            deleted: { id: result.session.id, title: result.session.title },
            state: refresh('delete'),
          });
          return;
        }

        if (pathname === '/api/session/purge') {
          // Full purge: registry + runs/ + engine chat. Requires typed confirmId === session.id.
          const confirmId = body.confirmId != null ? String(body.confirmId).trim() : '';
          if (!confirmId || confirmId !== session.id) {
            jsonReply(400, {
              error: 'Full purge requires confirmId matching the session id.',
            });
            return;
          }
          const purgeLib = require('./purge');
          const result = purgeLib.purgeSession(session, {
            apply: true,
            force,
            withChildren: withChildren,
            enrichment,
            isAlive: opts.isAlive || orchestrate.defaultIsAlive,
            home: fleetDir(),
            env: process.env,
          });
          if (!result.ok) {
            jsonReply(409, {
              error: result.error || 'Unable to purge session.',
              busy: result.busy || null,
            });
            return;
          }
          lastRegistryMtime = registryMtime();
          jsonReply(200, {
            ok: true,
            purged: (result.results || []).map((r) => r.session),
            state: refresh('purge'),
          });
          return;
        }
      } catch (err) {
        jsonReply(500, { error: String(err && err.message ? err.message : err) });
      } finally {
        mutating = false;
      }
      return;
    }

    if (pathname === '/api/state' || pathname === '/api/dashboard') {
      const state = lastPayload || refresh('api');
      const body = JSON.stringify(state);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (pathname === '/api/history') {
      const sessionId = u.searchParams.get('session') || u.searchParams.get('sessionId');
      const project = u.searchParams.get('project');
      const includeArchived =
        u.searchParams.get('includeArchived') === '1' ||
        u.searchParams.get('archived') === '1';
      if (!sessionId && !project) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Provide ?session=<id> or ?project=<name>' }));
        return;
      }
      try {
        if (sessionId && !includeArchived) {
          const row = registry.findExact(sessionId);
          if (row && row.archived) {
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Session is archived. Enable Show archived to view history.' }));
            return;
          }
        }
        const detail = (opts.collectHistory || collectHistoryDetail)({
          ...opts,
          sessionId: sessionId || null,
          project: project || null,
          includeArchived,
        });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(detail));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
      }
      return;
    }

    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const state = lastPayload || refresh('sse');
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      try {
        let html = readAsset('index.html');
        let spaceName = null;
        try {
          spaceName = require('./util').currentSpaceName();
        } catch (_) {
          spaceName = null;
        }
        if (spaceName) {
          const title = `aflt live · ${spaceName}`;
          html = html
            .replace('<title>aflt live</title>', `<title>${escapeXml(title)}</title>`)
            .replace('<div class="brand">aflt live</div>', `<div class="brand">${escapeXml(title)}</div>`);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(err.message || err));
      }
      return;
    }

    if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(FAVICON_SVG);
      return;
    }

    if (pathname === '/dashboard.css' || pathname === '/dashboard.js' || pathname === '/marked.min.js') {
      const file = path.join(ASSET_DIR, path.basename(pathname));
      try {
        const body = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': contentTypeFor(file),
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch (_) {
        res.writeHead(404).end('not found');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  });

  function startWatchers() {
    lastRegistryMtime = registryMtime();
    refresh('start');
    try {
      const rp = registryPath();
      const dir = path.dirname(rp);
      if (fs.existsSync(dir)) {
        watchHandle = fs.watch(dir, { persistent: true }, (_evt, filename) => {
          if (!filename || String(filename).includes('sessions')) {
            checkRegistryChange();
          }
        });
        if (typeof watchHandle.unref === 'function') watchHandle.unref();
      }
    } catch (_) {
      /* poll fallback only */
    }
    pollTimer = setInterval(checkRegistryChange, opts.registryPollMs || REGISTRY_POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    sseTimer = setInterval(() => refresh('tick'), opts.sseIntervalMs || SSE_INTERVAL_MS);
    if (typeof sseTimer.unref === 'function') sseTimer.unref();
    if (loopScheduler) {
      try {
        loopScheduler.start();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function close() {
    return new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      if (watchHandle) {
        try {
          watchHandle.close();
        } catch (_) {
          /* ignore */
        }
        watchHandle = null;
      }
      if (pollTimer) clearInterval(pollTimer);
      if (sseTimer) clearInterval(sseTimer);
      for (const res of sseClients) {
        try {
          res.end();
        } catch (_) {
          /* ignore */
        }
      }
      sseClients.clear();
      const finish = () => {
        server.close(() => resolve());
      };
      if (loopScheduler) {
        Promise.resolve()
          .then(() => loopScheduler.stop())
          .catch(() => {})
          .then(finish);
      } else {
        finish();
      }
    });
  }

  server.on('listening', startWatchers);

  return {
    server,
    close,
    getState: () => lastPayload || refresh('get'),
    refresh,
    loopScheduler,
  };
}

/**
 * Listen until SIGINT/SIGTERM. Resolves when closed.
 */
function serveDashboard(opts = {}) {
  const host = opts.host != null ? String(opts.host) : DEFAULT_HOST;
  const port = opts.port != null ? Number(opts.port) : DEFAULT_PORT;
  const asJson = Boolean(opts.json);
  const handle = createDashboardServer(opts);
  const { server, close } = handle;

  return new Promise((resolve, reject) => {
    const onSignal = () => {
      close().then(() => resolve({ ok: true, stopped: true }));
    };

    server.once('error', (err) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      reject(err);
    });

    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = addr && typeof addr === 'object' ? addr.port : port;
      const url = `http://${host}:${boundPort}/`;
      if (port !== 0 && opts.recordPort !== false) {
        // Lets space creation skip this port, even for spaces without config.json.
        try {
          require('./space').recordServedPort(fleetDir(), { port: boundPort, host, pid: process.pid });
        } catch (_) {
          /* best effort */
        }
      }
      if (asJson) {
        let spaceName = null;
        try {
          spaceName = require('./util').currentSpaceName();
        } catch (_) {
          spaceName = null;
        }
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              url,
              host,
              port: boundPort,
              space: spaceName || null,
              captureCompletions: Boolean(opts.captureCompletions),
            },
            null,
            2
          ) + '\n'
        );
      } else {
        process.stdout.write(`${url}\n`);
        try {
          const spaceName = require('./util').currentSpaceName();
          if (spaceName) process.stdout.write(`space: ${spaceName}\n`);
        } catch (_) {
          /* ignore */
        }
        if (opts.captureCompletions) process.stdout.write('Task Complete capture enabled (project status notes; no commits).\n');
      }
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    });
  });
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DASHBOARD_TZ,
  RECENT_MS,
  ACTIVE_PROJECT_MS,
  DISPLAY_STATES,
  LIVE_STATES,
  STATE_LABELS,
  FILTER_PRIORITY,
  ASSET_DIR,
  HISTORY_SORTS,
  MESSAGES_HOOK,
  formatSnapshotStamp,
  deriveDisplayState,
  enrichmentForSession,
  mergeSimPreserve,
  aggregateDashboard,
  sessionFilterState,
  rollupProjectFilterState,
  stateLabel,
  isSessionlessProject,
  isDormantProject,
  buildHistoryTree,
  collectHistoryDetail,
  loadMemoryRecords,
  loadMemoryProjects,
  collectState,
  createDashboardServer,
  serveDashboard,
  writeSnapshot,
  renderSvg,
  renderHtmlDocument,
  layoutGraph,
  stateColor,
  focusHerdrSession,
  sessionBusyForMutation: archiveLib.sessionBusyForMutation,
  createLoopScheduler,
};
