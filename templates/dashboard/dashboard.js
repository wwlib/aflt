'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMarkdown(value, { documentLinks = true } = {}) {
  const engine = typeof module !== 'undefined' && module.exports && typeof document === 'undefined'
    ? require('./marked.min') : marked;
  const headings = new Set();
  const parser = new engine.Marked({
    gfm: true,
    renderer: {
      html: function (html) { return escapeHtml(html); },
      image: function (href, title, text) {
        return '<span class="markdown-image">[Image: ' + escapeHtml(text) + ']</span>';
      },
      link: function (href, title, text) {
        href = String(href || '').trim();
        if (!href || /[\u0000-\u001f\u007f]/.test(href)) return text;
        const label = title ? ' title="' + escapeHtml(title) + '"' : '';
        if (/^(https?:\/\/|mailto:)/i.test(href)) {
          return '<a href="' + escapeHtml(href) + '"' + label +
            ' target="_blank" rel="noopener noreferrer">' + text + '</a>';
        }
        if (/^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(href)) return text;
        if (!documentLinks) return text;
        return '<a href="#" data-document-link="' + escapeHtml(href) + '"' + label + '>' + text + '</a>';
      },
      heading: function (text, level, raw) {
        const slug = raw.toLowerCase().replace(/<[^>]*>/g, '')
          .replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
        const base = 'document-heading-' + slug;
        let id = base;
        let count = 0;
        while (headings.has(id)) id = base + '-' + (++count);
        headings.add(id);
        return '<h' + level + ' id="' + escapeHtml(id) + '">' + text + '</h' + level + '>\n';
      },
    },
  });
  return parser.parse(String(value == null ? '' : value));
}

function resolveDocumentLink(projects, fromPath, href) {
  let target;
  let file;
  let fragment;
  try {
    target = new URL(href, 'https://aflt.invalid/' + fromPath);
    file = decodeURIComponent(target.pathname).slice(1);
    fragment = decodeURIComponent(target.hash.slice(1));
  } catch (error) {
    if (error.name !== 'TypeError' && error.name !== 'URIError') throw error;
    return null;
  }
  if (target.origin !== 'https://aflt.invalid') return null;
  for (const project of projects || []) {
    const doc = project.memory && (project.memory.documents || []).find(function (d) {
      return d.path === file;
    });
    if (doc) return { project: project.id, path: doc.path, fragment: fragment };
  }
  return null;
}

function renderProjectMemory(project, memoryState) {
  const context = project && project.memory;
  const errors = [...((memoryState && memoryState.errors) || []), ...((context && context.errors) || [])];
  let html = errors.map(function (error) {
    return '<p class="memory-error">' + escapeHtml(error) + '</p>';
  }).join('');
  if (!project) return html + '<p class="empty">Select a project to review its status and docs.</p>';
  if (!context) {
    return html + '<p class="empty">' +
      (memoryState && memoryState.configured
        ? 'No memory documents found for this project.'
        : 'No memory repo configured. Use aflt memory init to opt in.') + '</p>';
  }
  if (context.summary) {
    html += '<div class="label">Doc Bot summary</div><p>' + escapeHtml(context.summary.moved) +
      '</p><div class="label">Blocked</div><p>' + escapeHtml(context.summary.blocked) + '</p>';
  } else {
    html += '<p class="empty">No Doc Bot summary recorded for this project.</p>';
  }
  const documents = context.documents || [];
  if (!documents.length) return html + '<p class="empty">No project documents recorded yet.</p>';
  html += '<ul class="memory-documents">';
  documents.forEach(function (doc) {
    html += '<li><button type="button" class="document-link" data-document-path="' +
      escapeHtml(doc.path) + '">' + escapeHtml(doc.title) + '</button><small>' +
      escapeHtml(doc.kind === 'status' ? 'Status note · ' + doc.date : doc.kind === 'readme' ? 'README' : 'Project dashboard') +
      (doc.truncated ? ' · preview limited to 32 KiB' : '') + '</small></li>';
  });
  return html + '</ul>';
}

/** Canonical labels — shared by Graph, History, filters, detail, stats. */
const STATE_LABELS = {
  working: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  completed: 'Completed',
  failed: 'Failed',
};

function stateLabel(state) {
  if (state === 'running') return STATE_LABELS.working;
  if (state === 'done') return STATE_LABELS.completed;
  return STATE_LABELS[state] || STATE_LABELS.completed;
}

function activityLabel(item) {
  if (!item) return stateLabel('completed');
  if (item.kind === 'project' || item.sessionCount != null) {
    return stateLabel(item.filterState || item.displayState || 'idle');
  }
  return stateLabel(rowFilterState(item));
}

/**
 * Per-session live filter/badge state (must match lib/dashboard.sessionFilterState).
 * "working" = actually working (OSC working / live runPid) — not bare herdr.runtime.
 */
function rowFilterState(item) {
  if (!item) return 'completed';
  if (item.awaitingInput || item.activityState === 'waiting') return 'waiting';
  if (item.activityState === 'completed') {
    if (item.displayState === 'failed') return 'failed';
    if (item.displayState === 'running' || item.displayState === 'idle') return 'idle';
    return 'completed';
  }
  if (item.activityState === 'working' || item.displayState === 'running') return 'working';
  if (item.displayState === 'failed') return 'failed';
  if (item.displayState === 'idle') return 'idle';
  // Map legacy filter keys if present on the payload.
  if (item.filterState === 'running') return 'working';
  if (item.filterState === 'done') return 'completed';
  if (item.filterState && STATE_LABELS[item.filterState]) return item.filterState;
  return 'completed';
}

/** Project roll-up priority: waiting > working > failed > idle > completed. */
const FILTER_PRIORITY = ['waiting', 'working', 'failed', 'idle', 'completed'];

const HIDE_DORMANT_STORAGE_KEY = 'aflt.dashboard.hideDormant';
const SHOW_ARCHIVED_STORAGE_KEY = 'aflt.dashboard.showArchived';
const GRAPH_SPREAD_STORAGE_KEY = 'aflt.dashboard.graphSpread';
const TIMELINE_PRESET_STORAGE_KEY = 'aflt.dashboard.timelinePreset';
const TIMELINE_VIEW_STORAGE_KEY = 'aflt.dashboard.timelineView';
const DEFAULT_DORMANT_AFTER_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRAPH_SPREAD = 0.3;
const GRAPH_ZOOM_MIN = 0.25;
const GRAPH_ZOOM_MAX = 4;
const DEFAULT_TIMELINE_PRESET = '7d';
const TIMELINE_MIN_SPAN_MS = 60 * 60 * 1000;
const TIMELINE_PRESET_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: null,
};

/**
 * Dormant = idle/completed roll-up and last activity older than dormantAfterMs
 * (must match lib/dashboard.isDormantProject). working/waiting/failed never dormant.
 * Missing lastActivity is not dormant (nothing older-than to compare).
 */
function isDormantProject(p, nowMs, dormantAfterMs) {
  if (!p) return false;
  const live = p.filterState || p.displayState || 'idle';
  if (live === 'working' || live === 'running' || live === 'waiting' || live === 'failed') {
    return false;
  }
  const last = p.lastActivity != null ? Date.parse(String(p.lastActivity)) : NaN;
  const windowMs = dormantAfterMs != null ? Number(dormantAfterMs) : DEFAULT_DORMANT_AFTER_MS;
  const threshold = Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : DEFAULT_DORMANT_AFTER_MS;
  if (!Number.isFinite(last)) return false;
  return nowMs - last > threshold;
}

function isHerdrFocusLocal(loc) {
  const source = loc || (typeof location !== 'undefined' ? location : null);
  // Missing hostname (tests / file://) → treat as local; only explicit remote hosts are blocked.
  if (!source || source.hostname == null || String(source.hostname).trim() === '') return true;
  const host = String(source.hostname).replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Format an ISO timestamp (or epoch ms) in the viewer's local time zone with a
 * short zone label: "2026-11-24 14:37:01 EST". Never shows raw UTC.
 * opts.timeZone (tests) overrides the browser zone; opts.seconds=false drops
 * seconds; opts.zone=false drops the label. Unparseable input is returned as-is.
 */
/** "3m ago" style age for an ISO time (empty when unknown). */
function formatAgo(value, nowMs) {
  const t = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round(((nowMs || Date.now()) - t) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}

/** Improve round label: "improve-r2 (round 2/3)" while running, else the last one run. */
function formatLoopRound(round) {
  if (!round || !round.total) return '';
  if (round.current) return round.current + ' (round ' + round.number + '/' + round.total + ')';
  if (round.last) return round.last + ' (' + round.number + '/' + round.total + ' rounds run)';
  return '0/' + round.total + ' rounds run';
}

function formatLocalDateTime(value, opts) {
  const o = opts || {};
  if (value == null || value === '') return '';
  const t = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(t)) return String(value);
  const d = new Date(t);
  const pad = function (n) { return String(n).padStart(2, '0'); };
  let y, mo, da, h, mi, s, zone = '';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: o.timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'short',
    });
    const parts = {};
    fmt.formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    y = parts.year; mo = parts.month; da = parts.day;
    h = parts.hour === '24' ? '00' : parts.hour; mi = parts.minute; s = parts.second;
    zone = parts.timeZoneName || '';
  } catch (_) {
    y = d.getFullYear(); mo = pad(d.getMonth() + 1); da = pad(d.getDate());
    h = pad(d.getHours()); mi = pad(d.getMinutes()); s = pad(d.getSeconds());
    const off = -d.getTimezoneOffset();
    zone = 'UTC' + (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
  }
  let out = y + '-' + mo + '-' + da + ' ' + h + ':' + mi + (o.seconds === false ? '' : ':' + s);
  if (o.zone !== false && zone) out += ' ' + zone;
  return out;
}

function renderTaskCompletion(completion) {
  if (!completion) return '';
  return '<section class="task-completion"><div class="label">Latest Task Complete</div>' +
    '<p class="completion-meta">' + escapeHtml(completion.sessionTitle) + ' · ' +
    escapeHtml(formatLocalDateTime(completion.at)) + '</p><div class="completion-body">' +
    renderMarkdown(completion.summary, { documentLinks: false }) + '</div>' +
    (completion.truncated ? '<p class="completion-meta">Preview truncated; the full message is saved in the project note when capture is enabled.</p>' : '') +
    (completion.saveError ? '<p class="memory-error">Could not save completion: ' + escapeHtml(completion.saveError) + '</p>' : '') +
    (completion.notePath ? '<p class="completion-meta">Captured in project docs: <code>' +
      escapeHtml(completion.notePath) + '</code></p>' : '') + '</section>';
}

function renderGraphHint(project, session) {
  if (session) {
    return '<p>State: <strong>' + escapeHtml(activityLabel(session)) + '</strong></p>' +
      '<p>Session ID: <code>' + escapeHtml(session.id) + '</code></p>' +
      '<p>Engine: <strong>' + escapeHtml(session.engine || 'unknown') + '</strong></p>' +
      '<p>Status: <strong>' + escapeHtml(session.status || 'unknown') + '</strong></p>' +
      '<p>Herdr status: <strong>' + escapeHtml(session.herdr && session.herdr.runtime || 'unknown') + '</strong></p>';
  }
  if (!project) return '';
  const summary = project.memory && project.memory.summary;
  return '<div class="label">Doc Bot summary</div><p>' +
    escapeHtml(summary ? summary.moved : 'No Doc Bot summary recorded for this project.') + '</p>';
}

/**
 * Preserve force-sim positions across SSE updates (shared algorithm with lib/dashboard.js).
 * Exported for hermetic Node tests when required without a DOM.
 */
function mergeSimPreserve(prevSim, nextBuilt, opts) {
  opts = opts || {};
  const nextNodes = nextBuilt && Array.isArray(nextBuilt.nodes) ? nextBuilt.nodes : [];
  const nextLinks = nextBuilt && Array.isArray(nextBuilt.links) ? nextBuilt.links : [];
  const prevNodes = prevSim && Array.isArray(prevSim.nodes) ? prevSim.nodes : [];
  const prevById = {};
  for (let i = 0; i < prevNodes.length; i++) {
    const n = prevNodes[i];
    if (n && n.id != null) prevById[n.id] = n;
  }
  const prevIds = Object.keys(prevById);
  const nextIds = {};
  for (let i = 0; i < nextNodes.length; i++) {
    if (nextNodes[i] && nextNodes[i].id != null) nextIds[nextNodes[i].id] = true;
  }
  let nodeSetChanged = prevIds.length !== Object.keys(nextIds).length;
  if (!nodeSetChanged) {
    for (let i = 0; i < prevIds.length; i++) {
      if (!nextIds[prevIds[i]]) {
        nodeSetChanged = true;
        break;
      }
    }
  }

  const nodes = nextNodes.map(function (n) {
    const prev = prevById[n.id];
    if (!prev) return n;
    return Object.assign({}, n, {
      x: prev.x,
      y: prev.y,
      vx: prev.vx != null ? prev.vx : 0,
      vy: prev.vy != null ? prev.vy : 0,
      fixed: prev.fixed != null ? prev.fixed : n.fixed,
    });
  });

  const byId = {};
  for (let i = 0; i < nodes.length; i++) byId[nodes[i].id] = nodes[i];
  const links = nextLinks
    .map(function (l) {
      var source = typeof l.source === 'object' && l.source ? l.source : byId[l.source];
      var target = typeof l.target === 'object' && l.target ? l.target : byId[l.target];
      var src =
        source && source.id != null && byId[source.id] ? byId[source.id] : source;
      var tgt =
        target && target.id != null && byId[target.id] ? byId[target.id] : target;
      if (!src || !tgt) return null;
      return {
        source: src,
        target: tgt,
        kind: l.kind,
        recent: l.recent,
      };
    })
    .filter(Boolean);

  var alpha;
  if (opts.preserveAlpha && prevSim && typeof prevSim.alpha === 'number' && !nodeSetChanged) {
    alpha = prevSim.alpha;
  } else if (nodeSetChanged || !prevSim) {
    alpha = opts.reheatAlpha != null ? opts.reheatAlpha : 1;
  } else {
    alpha = typeof prevSim.alpha === 'number' ? prevSim.alpha : 1;
  }

  return {
    nodes: nodes,
    links: links,
    w: nextBuilt.w,
    h: nextBuilt.h,
    cx: nextBuilt.cx,
    cy: nextBuilt.cy,
    alpha: alpha,
    nodeSetChanged: nodeSetChanged,
  };
}

/** Clamp graph spread slider (0 = tight clusters, 1 = loose). */
function clampGraphSpread(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_GRAPH_SPREAD;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Force-layout elasticity from a 0..1 spread control.
 * Lower values pull clusters tighter (shorter links, weaker repulsion).
 */
function graphForceParams(spread) {
  const s = clampGraphSpread(spread);
  return {
    spread: s,
    linkIdealParent: 48 + s * 72,
    linkIdealOther: 36 + s * 54,
    repulsion: 6 + s * 28,
    collideMult: 1.5 + s * 1.0,
    collideForce: 0.035 + s * 0.02,
    hubRadiusFactor: 0.14 + s * 0.2,
    sessionOrbit: 42 + s * 40,
    centerPull: 0.003 + (1 - s) * 0.004,
  };
}

function clampGraphZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  if (n < GRAPH_ZOOM_MIN) return GRAPH_ZOOM_MIN;
  if (n > GRAPH_ZOOM_MAX) return GRAPH_ZOOM_MAX;
  return n;
}

/**
 * Fit world-space nodes into a viewport via translate + scale.
 * Returns { scale, tx, ty } for: x' = x * scale + tx.
 */
function fitGraphView(nodes, viewportW, viewportH, opts) {
  opts = opts || {};
  const pad = opts.padding != null ? Number(opts.padding) : 48;
  const minScale = opts.minScale != null ? Number(opts.minScale) : GRAPH_ZOOM_MIN;
  const maxScale = opts.maxScale != null ? Number(opts.maxScale) : GRAPH_ZOOM_MAX;
  if (!nodes || !nodes.length || !(viewportW > 0) || !(viewportH > 0)) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n) continue;
    const r = n.r != null ? Number(n.r) : 8;
    const x = Number(n.x);
    const y = Number(n.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x - r);
    minY = Math.min(minY, y - r);
    maxX = Math.max(maxX, x + r);
    maxY = Math.max(maxY, y + r);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const availW = Math.max(viewportW - 2 * (Number.isFinite(pad) ? pad : 48), 1);
  const availH = Math.max(viewportH - 2 * (Number.isFinite(pad) ? pad : 48), 1);
  let scale = Math.min(availW / bw, availH / bh);
  const lo = Number.isFinite(minScale) ? minScale : GRAPH_ZOOM_MIN;
  const hi = Number.isFinite(maxScale) ? maxScale : GRAPH_ZOOM_MAX;
  scale = Math.max(lo, Math.min(hi, scale));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    scale: scale,
    tx: viewportW / 2 - cx * scale,
    ty: viewportH / 2 - cy * scale,
  };
}

/** Zoom around a pivot in the same coordinate space as tx/ty (viewBox units). */
function zoomGraphView(view, factor, pivotX, pivotY) {
  const oldScale = view && view.scale != null ? Number(view.scale) : 1;
  const tx = view && view.tx != null ? Number(view.tx) : 0;
  const ty = view && view.ty != null ? Number(view.ty) : 0;
  const f = Number(factor);
  const next = clampGraphZoom(oldScale * (Number.isFinite(f) && f > 0 ? f : 1));
  const ratio = next / (oldScale || 1);
  const px = Number.isFinite(pivotX) ? pivotX : 0;
  const py = Number.isFinite(pivotY) ? pivotY : 0;
  return {
    scale: next,
    tx: px * (1 - ratio) + tx * ratio,
    ty: py * (1 - ratio) + ty * ratio,
  };
}

function panGraphView(view, dx, dy) {
  return {
    scale: view && view.scale != null ? Number(view.scale) : 1,
    tx: (view && view.tx != null ? Number(view.tx) : 0) + (Number(dx) || 0),
    ty: (view && view.ty != null ? Number(view.ty) : 0) + (Number(dy) || 0),
  };
}

function graphViewTransform(view) {
  const scale = view && view.scale != null ? Number(view.scale) : 1;
  const tx = view && view.tx != null ? Number(view.tx) : 0;
  const ty = view && view.ty != null ? Number(view.ty) : 0;
  return 'translate(' + tx + ' ' + ty + ') scale(' + scale + ')';
}

function clampTimelineWindow(start, end, fullStart, fullEnd) {
  let s = Number(start);
  let e = Number(end);
  const fs = Number(fullStart);
  const fe = Number(fullEnd);
  if (!Number.isFinite(s) || !Number.isFinite(e)) {
    return {
      start: Number.isFinite(fs) ? fs : 0,
      end: Number.isFinite(fe) ? Math.max(fe, (Number.isFinite(fs) ? fs : 0) + 1) : 1,
    };
  }
  if (e < s) {
    const tmp = s;
    s = e;
    e = tmp;
  }
  const minSpan = TIMELINE_MIN_SPAN_MS;
  if (e - s < minSpan) {
    const mid = (s + e) / 2;
    s = mid - minSpan / 2;
    e = mid + minSpan / 2;
  }
  const fullLo = Number.isFinite(fs) ? fs : s;
  const fullHi = Number.isFinite(fe) ? Math.max(fe, fullLo + minSpan) : e;
  const maxSpan = Math.max(fullHi - fullLo, minSpan);
  if (e - s > maxSpan) {
    const mid = (s + e) / 2;
    s = mid - maxSpan / 2;
    e = mid + maxSpan / 2;
  }
  if (s < fullLo) {
    e += fullLo - s;
    s = fullLo;
  }
  if (e > fullHi) {
    s -= e - fullHi;
    e = fullHi;
  }
  if (s < fullLo) s = fullLo;
  if (e > fullHi) e = fullHi;
  if (e <= s) e = s + minSpan;
  return { start: s, end: e };
}

/**
 * Resolve the visible timeline window from a preset and optional override.
 * fullRange/override use epoch ms: { start, end }.
 *
 * Duration presets (24h/7d/30d) anchor the right edge at max(now, dataEnd) and
 * the left at end − duration (fixed span — not shrunk to the data range).
 * 'all' fits [dataStart, max(dataEnd, now)]. An override (manual pan/zoom)
 * wins until cleared; live callers pass null override to keep following now.
 */
function resolveTimelineWindow(fullRange, preset, override, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const fallbackSpan = TIMELINE_PRESET_MS['7d'];
  const dataStart = fullRange && Number.isFinite(fullRange.start)
    ? fullRange.start
    : now - fallbackSpan;
  const dataEnd = fullRange && Number.isFinite(fullRange.end)
    ? Math.max(fullRange.end, dataStart + 1)
    : now;
  // Visible domain always reaches "now" (or newer markers if clocks/data lead).
  const fullStart = dataStart;
  const fullEnd = Math.max(dataEnd, now);
  if (
    override &&
    Number.isFinite(override.start) &&
    Number.isFinite(override.end) &&
    override.end > override.start
  ) {
    // Pan/zoom domain: allow windows that extend a full 30d behind the right edge
    // so duration presets are not clamped back onto a short data span.
    const domainStart = Math.min(fullStart, fullEnd - TIMELINE_PRESET_MS['30d']);
    return clampTimelineWindow(override.start, override.end, domainStart, fullEnd);
  }
  const key = preset && Object.prototype.hasOwnProperty.call(TIMELINE_PRESET_MS, preset)
    ? preset
    : DEFAULT_TIMELINE_PRESET;
  const dur = TIMELINE_PRESET_MS[key];
  if (dur == null) {
    return { start: fullStart, end: fullEnd };
  }
  const end = fullEnd;
  const start = end - dur;
  return { start: start, end: end };
}

/**
 * Format a Gantt axis tick in local time (never UTC).
 * Short windows (< 2d) → HH:MM; longer → M/D.
 */
function formatTimelineAxisLabel(ms, spanMs) {
  const t = new Date(Number(ms));
  if (!Number.isFinite(t.getTime())) return '';
  const span = Number(spanMs);
  const short = Number.isFinite(span) && span < 2 * 24 * 60 * 60 * 1000;
  if (short) {
    return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
  }
  return (t.getMonth() + 1) + '/' + t.getDate();
}

/** factor > 1 zooms in (shorter span). anchorMs keeps that instant fixed. */
function zoomTimelineWindow(window, factor, anchorMs, fullStart, fullEnd) {
  const start = window && Number(window.start);
  const end = window && Number(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return clampTimelineWindow(fullStart, fullEnd, fullStart, fullEnd);
  }
  const f = Number(factor);
  const zoom = Number.isFinite(f) && f > 0 ? f : 1;
  const span = end - start;
  const nextSpan = span / zoom;
  const anchor = Number.isFinite(anchorMs) ? anchorMs : (start + end) / 2;
  const ratio = (anchor - start) / span;
  const nextStart = anchor - nextSpan * ratio;
  return clampTimelineWindow(nextStart, nextStart + nextSpan, fullStart, fullEnd);
}

function panTimelineWindow(window, deltaMs, fullStart, fullEnd) {
  const start = window && Number(window.start);
  const end = window && Number(window.end);
  const delta = Number(deltaMs) || 0;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return clampTimelineWindow(fullStart, fullEnd, fullStart, fullEnd);
  }
  return clampTimelineWindow(start + delta, end + delta, fullStart, fullEnd);
}

/**
 * Place finished-turn markers so overlaps remain selectable.
 * Nearby markers stack on lanes; denser clusters become a count badge
 * (expand via expandedGroupIds).
 *
 * @returns {Array<{kind:'marker'|'group', leftPct, lane, laneCount, ...}>}
 */
function layoutTimelineMarkers(markers, rangeStart, rangeEnd, trackWidthPx, opts) {
  opts = opts || {};
  const minSepPx = opts.minSepPx != null ? Number(opts.minSepPx) : 12;
  const maxStack = opts.maxStack != null ? Number(opts.maxStack) : 3;
  const expanded = opts.expandedGroupIds || null;
  const span = Number(rangeEnd) - Number(rangeStart);
  if (!(span > 0) || !(trackWidthPx > 0)) return [];
  const minSepPct = Math.max(0.15, (minSepPx / trackWidthPx) * 100);

  const items = [];
  (markers || []).forEach(function (m, idx) {
    if (!m || (m.state !== 'completed' && m.state !== 'failed')) return;
    const t = Date.parse(m.at);
    if (!Number.isFinite(t)) return;
    const left = ((t - rangeStart) / span) * 100;
    if (left < -2 || left > 102) return;
    items.push({ marker: m, idx: idx, t: t, left: left });
  });
  items.sort(function (a, b) {
    return a.t - b.t || a.idx - b.idx;
  });

  const clusters = [];
  let current = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!current) {
      current = { members: [it] };
      continue;
    }
    const prev = current.members[current.members.length - 1];
    if (it.left - prev.left <= minSepPct) {
      current.members.push(it);
    } else {
      clusters.push(current);
      current = { members: [it] };
    }
  }
  if (current) clusters.push(current);

  const out = [];
  for (let ci = 0; ci < clusters.length; ci++) {
    const members = clusters[ci].members;
    let center = 0;
    for (let i = 0; i < members.length; i++) center += members[i].left;
    center /= members.length;
    const groupId = 'g' + ci;
    const expand = expanded && (
      (typeof expanded.has === 'function' && expanded.has(groupId)) ||
      (Array.isArray(expanded) && expanded.indexOf(groupId) !== -1)
    );
    if (members.length === 1) {
      out.push({
        kind: 'marker',
        id: groupId + '-0',
        groupId: groupId,
        leftPct: members[0].left,
        lane: 0,
        laneCount: 1,
        marker: members[0].marker,
        sourceIndex: members[0].idx,
      });
      continue;
    }
    if (members.length <= maxStack || expand) {
      const laneCount = members.length;
      for (let li = 0; li < members.length; li++) {
        out.push({
          kind: 'marker',
          id: groupId + '-' + li,
          groupId: groupId,
          leftPct: center,
          lane: li,
          laneCount: laneCount,
          marker: members[li].marker,
          sourceIndex: members[li].idx,
        });
      }
      continue;
    }
    out.push({
      kind: 'group',
      id: groupId,
      groupId: groupId,
      leftPct: center,
      lane: 0,
      laneCount: 1,
      count: members.length,
      markers: members.map(function (m) { return m.marker; }),
      sourceIndexes: members.map(function (m) { return m.idx; }),
    });
  }
  return out;
}

function maxTimelineLaneCount(laid) {
  let max = 1;
  (laid || []).forEach(function (item) {
    if (item && item.laneCount > max) max = item.laneCount;
  });
  return max;
}

/** Format elapsed milliseconds for the Loops view. */
function formatLoopElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const sec = Math.floor(n / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ' + (sec % 60) + 's';
  const hr = Math.floor(min / 60);
  return hr + 'h ' + (min % 60) + 'm';
}

/** Budget used summary: "3/20 runs · 0.4/2 h". */
function formatLoopBudget(budget) {
  if (!budget || typeof budget !== 'object') return '—';
  const parts = [];
  if (budget.maxRuns != null) {
    parts.push((budget.runsUsed != null ? budget.runsUsed : 0) + '/' + budget.maxRuns + ' runs');
  } else if (budget.runsUsed != null) {
    parts.push(budget.runsUsed + ' runs');
  }
  if (budget.maxHours != null) {
    const used = budget.hoursUsed != null ? Number(budget.hoursUsed) : 0;
    parts.push((Number.isFinite(used) ? used.toFixed(1) : '0') + '/' + budget.maxHours + ' h');
  } else if (budget.hoursUsed != null) {
    parts.push(Number(budget.hoursUsed).toFixed(1) + ' h');
  }
  return parts.length ? parts.join(' · ') : '—';
}

function loopStatusClass(status) {
  const s = String(status || 'unknown').toLowerCase();
  if (s === 'running' || s === 'pending') return 'running';
  if (s === 'waiting') return 'waiting';
  if (s === 'needs_human') return 'waiting';
  if (s === 'paused') return 'paused';
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'stopped') return s;
  return 'paused';
}

/**
 * Render step pipeline chips: plan → develop → evaluate → revise → (approve) → next.
 * @param {Array<{id:string,label:string,active?:boolean,done?:boolean}>} steps
 */
function renderLoopStepPipeline(steps) {
  const list = Array.isArray(steps) && steps.length
    ? steps
    : [
        { id: 'plan', label: 'plan' },
        { id: 'develop', label: 'develop' },
        { id: 'evaluate', label: 'evaluate' },
        { id: 'revise', label: 'revise' },
        { id: 'next', label: 'next' },
      ];
  let html = '<div class="loops-pipeline" role="list" aria-label="Phase step pipeline">';
  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const cls = ['loops-pipe-stage'];
    if (s.active) cls.push('active');
    if (s.done) cls.push('done');
    if (s.id === 'approve' && s.active) cls.push('waiting');
    if (i) html += '<span class="loops-pipe-arrow" aria-hidden="true">→</span>';
    html +=
      '<span class="' +
      cls.join(' ') +
      '" role="listitem"' +
      (s.active ? ' aria-current="step"' : '') +
      '>' +
      escapeHtml(s.label || s.id || '') +
      '</span>';
  }
  html += '</div>';
  return html;
}

/**
 * Compact list markup for loop rows (pure; used by live view + tests).
 */
function renderLoopsListHtml(loops, selectedName) {
  const rows = Array.isArray(loops) ? loops : [];
  if (!rows.length) {
    return '<div class="empty">No loops yet. Save a definition or start from a file.</div>';
  }
  let html = '';
  for (let i = 0; i < rows.length; i++) {
    const loop = rows[i] || {};
    const name = String(loop.name || '');
    const selected = selectedName && name === selectedName;
    const status = String(loop.status || 'unknown');
    const meta = [
      loop.active ? 'live' : null,
      loop.engine ? loop.engine + (loop.model ? '/' + loop.model : '') : null,
      loop.round && loop.round.current
        ? 'round ' + formatLoopRound(loop.round)
        : loop.phaseId
          ? 'phase ' + loop.phaseId
          : null,
      loop.attempt != null ? 'attempt ' + loop.attempt : null,
      loop.lastActivityAt ? 'last activity ' + formatAgo(loop.lastActivityAt) : null,
      formatLoopElapsed(loop.elapsedMs),
      formatLoopBudget(loop.budget),
      formatLoopRowUsage(loop.usage) || null,
    ]
      .filter(Boolean)
      .join(' · ');
    html +=
      '<button type="button" class="loops-row' +
      (selected ? ' active' : '') +
      '" role="listitem" data-loop-name="' +
      escapeHtml(name) +
      '" aria-pressed="' +
      String(!!selected) +
      '">' +
      '<span class="loops-row-name">' +
      escapeHtml(name) +
      '</span>' +
      '<span class="loops-status ' +
      loopStatusClass(status) +
      '">' +
      escapeHtml(status) +
      '</span>' +
      '<span class="loops-row-meta">' +
      escapeHtml(meta) +
      '</span>' +
      '</button>';
  }
  return html;
}

/** Strip plan-mode / pkill safety preamble from prompt teasers (display only). */
function stripPromptPreamble(text) {
  const raw = String(text == null ? '' : text);
  if (!raw) return '';
  const prefixes = [
    /^do not switch to plan mode\.\s*/i,
    /^never use pkill\/killall or pattern-matched kills; only stop pids you started\.\s*/i,
  ];
  function stripLine(line) {
    let s = String(line || '').trim();
    for (let n = 0; n < 4 && s; n++) {
      let hit = false;
      for (let i = 0; i < prefixes.length; i++) {
        if (prefixes[i].test(s)) {
          s = s.replace(prefixes[i], '').trim();
          hit = true;
          break;
        }
      }
      if (hit) continue;
      if (/^do not switch to plan mode\.?$/i.test(s)) return '';
      if (/^never use pkill\/killall\b[^.]*\.?$/i.test(s)) return '';
      break;
    }
    return s;
  }
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !String(lines[i]).trim()) i += 1;
  let stripped = 0;
  while (i < lines.length && stripped < 4) {
    const trimmed = String(lines[i]).trim();
    if (!trimmed) break;
    const rest = stripLine(trimmed);
    if (rest === trimmed) break;
    stripped += 1;
    if (rest) {
      lines[i] = rest;
      break;
    }
    i += 1;
  }
  while (i < lines.length && !String(lines[i]).trim()) i += 1;
  return lines.slice(i).join('\n');
}

/** Compact token rollup for Loops detail (never invents USD). */
function formatLoopUsage(usage) {
  if (!usage || typeof usage !== 'object') return '—';
  const total =
    usage.totalTokens != null
      ? usage.totalTokens
      : usage.totalInput != null || usage.outputTokens != null
        ? (usage.totalInput || 0) + (usage.outputTokens || 0)
        : null;
  if (total == null && !usage.turnCount) return '—';
  const approx =
    usage.accuracy === 'estimated' || usage.accuracy === 'partial' ? '~' : '';
  function fmtTok(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    const v = Number(n);
    if (Math.abs(v) < 1000) return String(Math.round(v));
    if (Math.abs(v) < 1000000) {
      const k = v / 1000;
      const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
      return String(rounded).replace(/\.0$/, '') + 'k';
    }
    return String(Math.round((v / 1000000) * 10) / 10).replace(/\.0$/, '') + 'm';
  }
  const parts = [];
  if (total != null) parts.push(approx + fmtTok(total) + ' tok');
  if (usage.turnCount) parts.push(usage.turnCount + ' turn' + (usage.turnCount === 1 ? '' : 's'));
  if (usage.accuracy) parts.push(String(usage.accuracy));
  const estN = Number(usage.estimatedTurns) || 0;
  if (estN > 0 && usage.accuracy !== 'estimated') {
    parts.push(estN + ' estimated');
  }
  const cost = formatUsageCost(usage);
  if (cost) parts.push(cost);
  else if (total != null) parts.push('cost unknown');
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * Recorded cost of a usage rollup: Copilot AI credits and dollars
 * ("278.8 credits · $2.79"), else a reported USD cost. '' when the engine
 * recorded no cost (Cursor). Never derived from tokens.
 */
function formatUsageCost(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const credits = usage.credits != null ? Number(usage.credits) : NaN;
  if (Number.isFinite(credits)) {
    const c = credits < 10 ? credits.toFixed(2) : credits.toFixed(1);
    const usd = usage.usd != null ? Number(usage.usd) : NaN;
    return c + ' credits' + (Number.isFinite(usd) ? ' · $' + usd.toFixed(2) : '');
  }
  if (usage.usd != null && Number.isFinite(Number(usage.usd))) return '$' + Number(usage.usd).toFixed(2);
  if (usage.cost != null && Number.isFinite(Number(usage.cost))) return '$' + Number(usage.cost).toFixed(4);
  return '';
}

/** Short token + cost bit for a loop row ("6.1m tok · 278.8 credits · $2.79"). */
function formatLoopRowUsage(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const total = usage.totalTokens != null ? Number(usage.totalTokens) : NaN;
  const bits = [];
  if (Number.isFinite(total)) {
    bits.push(
      (total >= 1e6 ? (Math.round(total / 1e5) / 10) + 'm' : total >= 1e3 ? Math.round(total / 1e3) + 'k' : String(total)) +
        ' tok'
    );
  }
  const cost = formatUsageCost(usage);
  if (cost) bits.push(cost);
  return bits.join(' · ');
}

/** Note when the read-time recompute disagrees with the stored rollup. */
function formatLoopUsageNote(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const notes = [];
  if (usage.storedTotalTokens != null && usage.recomputed) {
    notes.push(
      'Recomputed from per-session turns (de-duplicated); the stored rollup said ' +
        Number(usage.storedTotalTokens).toLocaleString('en-US') +
        ' tok, recorded before the double-count fix.'
    );
  }
  if (usage.creditsSource === 'per-call' && usage.calls) {
    notes.push(
      'Credits from ' + usage.callsWithCost + ' of ' + usage.calls + ' per-call usage records (as the engine recorded them).'
    );
  }
  return notes.join(' ');
}

/**
 * Historical loop phase tree with eval scores (from stored phase results).
 */
function renderLoopPhaseTree(detail) {
  const pipeline = detail && Array.isArray(detail.pipeline) ? detail.pipeline : [];
  if (!pipeline.length) return '';
  const rootId = detail.loopRootSessionId || null;
  const rootTitle = detail.loopRootSessionTitle || (detail.name ? 'loop-' + detail.name : 'loop');
  let html = '<div class="loops-phase-tree" role="tree" aria-label="Loop phase tree">';
  html += '<div class="loops-phase-tree-root" role="treeitem" aria-expanded="true">';
  if (rootId) {
    html +=
      '<button type="button" class="loops-session-link" data-session-id="' +
      escapeHtml(rootId) +
      '">' +
      escapeHtml(rootTitle) +
      '</button>';
  } else {
    html += '<span>' + escapeHtml(rootTitle) + '</span>';
  }
  html += ' <span class="loops-row-meta">master</span>';
  html += '</div>';
  html += '<ul class="loops-phase-tree-list" role="group">';
  for (let i = 0; i < pipeline.length; i++) {
    const p = pipeline[i] || {};
    html +=
      '<li class="loops-phase-tree-item' +
      (p.current ? ' current' : '') +
      '" role="treeitem">';
    html += '<span class="loops-phase-tree-id">' + escapeHtml(p.id || 'phase') + '</span>';
    html +=
      ' <span class="loops-status ' +
      loopStatusClass(p.status) +
      '">' +
      escapeHtml(p.status || 'pending') +
      '</span>';
    if (p.roundRunning) {
      html += ' <span class="loops-row-meta">' + escapeHtml(p.roundRunning) + ' running</span>';
    }
    if (p.evalScore != null && Number.isFinite(Number(p.evalScore))) {
      html +=
        ' <span class="loops-phase-score" title="Eval overall score">' +
        escapeHtml(String(p.evalScore)) +
        '</span>';
    }
    if (p.sessionId) {
      html +=
        ' <button type="button" class="loops-session-link" data-session-id="' +
        escapeHtml(p.sessionId) +
        '">' +
        escapeHtml(p.sessionTitle || p.sessionId) +
        '</button>';
    }
    html += '</li>';
  }
  html += '</ul></div>';
  return html;
}

function renderLoopPhaseCards(pipeline) {
  const phases = Array.isArray(pipeline) ? pipeline : [];
  if (!phases.length) return '<div class="empty">No phases</div>';
  let html = '<div class="loops-phases-live">';
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i] || {};
    const cls = 'loops-phase-card' + (p.current ? ' current' : '');
    html += '<div class="' + cls + '">';
    html += '<div class="loops-phase-head">';
    html += '<strong>' + escapeHtml(p.id || 'phase') + '</strong>';
    html +=
      '<span class="loops-status ' +
      loopStatusClass(p.status) +
      '">' +
      escapeHtml(p.status || 'pending') +
      '</span>';
    if (p.evalScore != null && Number.isFinite(Number(p.evalScore))) {
      html +=
        '<span class="loops-phase-score" title="Eval overall score">' +
        escapeHtml(String(p.evalScore)) +
        '</span>';
    }
    html += '</div>';
    const bits = [];
    if (p.gate) bits.push('gate=' + p.gate + (p.gateApproved ? ' (approved)' : ''));
    if (p.sessionId) {
      bits.push(
        'session <button type="button" class="loops-session-link" data-session-id="' +
          escapeHtml(p.sessionId) +
          '">' +
          escapeHtml(p.sessionTitle || p.sessionId) +
          '</button>'
      );
    } else if (p.sessionTitle) {
      bits.push('session ' + escapeHtml(p.sessionTitle));
    }
    if (p.attempts) bits.push('attempts ' + p.attempts);
    if (bits.length) html += '<div class="loops-row-meta">' + bits.join(' · ') + '</div>';
    if (p.lastEval && p.lastEval.text) {
      html +=
        '<pre class="loops-eval-tail" aria-label="Eval output">' +
        escapeHtml(p.lastEval.text) +
        '</pre>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

/**
 * True when a loop has finished (completed / failed / stopped) and no runner
 * is live, so Stop and Pause have nothing to act on.
 */
function loopIsFinished(loop) {
  if (!loop || typeof loop !== 'object') return false;
  const s = String(loop.status || '').toLowerCase();
  if (s !== 'completed' && s !== 'failed' && s !== 'stopped') return false;
  return !loop.runnerPid && !loop.schedulerRunning;
}

/**
 * Merge a phase edited in the loop form over the phase it was opened from, so
 * fields the form has no input for (type, promptFile, timeouts, improveModel,
 * protected, verify) survive a save. A phase opened with a promptFile keeps it
 * while the prompt box stays empty; script / plan-next phases never gain a
 * prompt or a placeholder eval.
 */
function mergeEditedLoopPhase(orig, edited) {
  if (!orig || typeof orig !== 'object') return edited;
  const out = Object.assign({}, orig, edited);
  const promptEmpty = !edited.prompt || !String(edited.prompt).trim();
  if (promptEmpty) delete out.prompt;
  if (promptEmpty && orig.promptFile) out.promptFile = orig.promptFile;
  if (!promptEmpty) delete out.promptFile;
  if (!edited.model) delete out.model;
  if (!edited.gate) delete out.gate;
  if (!edited.mode) delete out.mode;
  if (!edited.session && orig.session) out.session = orig.session;
  if (orig.type === 'script') {
    delete out.prompt;
    delete out.promptFile;
  }
  if (orig.type === 'plan-next' && !orig.eval) {
    const cmd = edited.eval && edited.eval.command;
    if (cmd == null || String(cmd).trim() === 'true') delete out.eval;
  }
  if (orig.eval && edited.eval) {
    const origCmd = Array.isArray(orig.eval.command) ? orig.eval.command.join(' ') : String(orig.eval.command);
    if (String(edited.eval.command) === origCmd) out.eval = Object.assign({}, orig.eval, { exitCode: orig.eval.exitCode != null ? orig.eval.exitCode : 0 });
    else out.eval = Object.assign({}, orig.eval, edited.eval);
  }
  return out;
}

/**
 * Banner for a loop paused at an approval gate: which phase is next and the
 * cost so far (credits / $ when the engine records them, else "cost unknown").
 */
function renderLoopGateBanner(detail) {
  const gate = (detail && detail.gate) || {};
  const cost = gate.costSoFar || null;
  let text = 'Waiting for approval before phase ' + (gate.phaseId || detail.phaseId || '?') + '.';
  if (cost && cost.text) text += ' Cost so far: ' + cost.text + '.';
  text += ' Approve to continue, or Stop.';
  return '<p class="loops-gate-banner" role="status">' + escapeHtml(text) + '</p>';
}

/**
 * Detail panel HTML for a loop status payload from GET /api/loops/:name.
 */
function renderLoopDetailHtml(detail) {
  if (!detail || !detail.name) {
    return '<div class="empty">Select a loop or create one</div>';
  }
  const status = String(detail.status || 'unknown');
  const waitingGate = Boolean(detail.gate && detail.gate.waiting) || status === 'waiting';
  let html = '<div class="loops-detail-header">';
  html += '<div class="loops-detail-title">' + escapeHtml(detail.name) + '</div>';
  html += '<div class="loops-controls">';
  if (waitingGate) {
    html +=
      '<button type="button" class="loops-btn" data-loop-action="approve" data-loop-name="' +
      escapeHtml(detail.name) +
      '">Approve</button>';
  }
  const finished = loopIsFinished(detail);
  const finishedTitle = finished
    ? ' disabled aria-disabled="true" title="Loop is ' + escapeHtml(status) + '; nothing to '
    : '';
  html +=
    '<button type="button" class="loops-btn subtle" data-loop-action="pause" data-loop-name="' +
    escapeHtml(detail.name) +
    '"' +
    (finished ? finishedTitle + 'pause"' : '') +
    '>Pause</button>';
  html +=
    '<button type="button" class="loops-btn subtle" data-loop-action="resume" data-loop-name="' +
    escapeHtml(detail.name) +
    '">Resume</button>';
  // Stop is the destructive (red) action only while there is something to
  // stop; a completed / failed / stopped loop gets a neutral disabled button.
  html +=
    '<button type="button" class="loops-btn ' +
    (finished ? 'subtle' : 'danger') +
    '" data-loop-action="stop" data-loop-name="' +
    escapeHtml(detail.name) +
    '"' +
    (finished ? finishedTitle + 'stop"' : '') +
    '>Stop</button>';
  html +=
    '<button type="button" class="loops-btn subtle" data-loop-action="edit" data-loop-name="' +
    escapeHtml(detail.name) +
    '">Edit</button>';
  html +=
    '<a class="loops-btn subtle loops-making-of" href="/making-of/' +
    encodeURIComponent(detail.name) +
    '" target="_blank" rel="noopener" title="Every AI call, commit and artifact of this loop">Making of</a>';
  html += '</div></div>';

  if (waitingGate) html += renderLoopGateBanner(detail);

  html += '<div class="loops-stats">';
  const stats = [
    { k: 'Status', v: status },
    { k: 'Engine', v: detail.engine || '—' },
    { k: 'Model', v: detail.model || '—' },
    {
      k: 'Phase',
      v: (detail.round && detail.round.current) || detail.phaseId || '—',
    },
    { k: 'Round', v: formatLoopRound(detail.round) || '—' },
    { k: 'Attempt', v: detail.attempt != null ? String(detail.attempt) : '—' },
    { k: 'Step', v: detail.step || '—' },
    { k: 'Started', v: detail.startedAt ? formatLocalDateTime(detail.startedAt) : '—' },
    { k: 'Updated', v: detail.updatedAt ? formatLocalDateTime(detail.updatedAt) : '—' },
    {
      k: 'Last activity',
      v: detail.lastActivityAt
        ? formatLocalDateTime(detail.lastActivityAt) + ' (' + formatAgo(detail.lastActivityAt) + ')'
        : '—',
    },
    { k: 'Elapsed', v: formatLoopElapsed(detail.elapsedMs) },
    { k: 'Budget', v: formatLoopBudget(detail.budget) },
    { k: 'Tokens', v: formatLoopUsage(detail.usage) },
  ];
  for (let i = 0; i < stats.length; i++) {
    html +=
      '<div class="loops-stat"><span class="k">' +
      escapeHtml(stats[i].k) +
      '</span><span class="v">' +
      escapeHtml(stats[i].v) +
      '</span></div>';
  }
  html += '</div>';
  const usageNote = formatLoopUsageNote(detail.usage);
  if (usageNote) html += '<p class="loops-row-meta loops-usage-note">' + escapeHtml(usageNote) + '</p>';

  html += '<div class="label">Step pipeline</div>';
  html += renderLoopStepPipeline(detail.steps);
  html += '<div class="label">Phase tree</div>';
  html += renderLoopPhaseTree(detail);
  html += '<div class="label">Phases</div>';
  html += renderLoopPhaseCards(detail.pipeline);
  if (detail.currentEval && detail.currentEval.text) {
    html += '<div class="label">Current eval output</div>';
    html +=
      '<pre class="loops-eval-tail">' + escapeHtml(detail.currentEval.text) + '</pre>';
  }
  if (detail.lastError) {
    html +=
      '<p class="loops-form-status error">' + escapeHtml(detail.lastError) + '</p>';
  }
  return html;
}

/** Fields of a loop summary/detail that make a rendered detail pane stale. */
function loopSyncSignature(loop) {
  if (!loop || typeof loop !== 'object') return '';
  const budget = loop.budget || {};
  const elapsed = Number(loop.elapsedMs);
  return JSON.stringify([
    loop.name,
    loop.status,
    loop.phaseId,
    loop.phaseIndex,
    loop.attempt,
    loop.step,
    loop.runsUsed != null ? loop.runsUsed : budget.runsUsed,
    loop.active ? 1 : 0,
    loop.updatedAt,
    Number.isFinite(elapsed) ? Math.floor(elapsed / 1000) : null,
  ]);
}

/**
 * Whether the selected loop's detail pane must be re-fetched/re-rendered after
 * the list poll delivered `summary` (the loop's row from /api/loops).
 * `synced` is { name, signature } of the summary the pane last synced to.
 */
function loopDetailNeedsSync(summary, synced, selectedName) {
  if (!selectedName || !summary || summary.name !== selectedName) return false;
  if (!synced || synced.name !== selectedName) return true;
  return loopSyncSignature(summary) !== synced.signature;
}

/** Build a default empty phase editor model. */
function emptyLoopPhaseForm(index) {
  return {
    id: 'phase-' + (index + 1),
    engine: 'cursor',
    session: '',
    prompt: '',
    evalCommand: 'true',
    maxFixAttempts: 3,
    onPass: 'none',
    gate: '',
    mode: '',
    force: false,
  };
}

if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
  module.exports = {
    mergeSimPreserve, renderProjectMemory, renderGraphHint, renderMarkdown, resolveDocumentLink,
    renderTaskCompletion, formatLocalDateTime, activityLabel, rowFilterState, stateLabel, isHerdrFocusLocal, isDormantProject,
    STATE_LABELS, FILTER_PRIORITY,
    HIDE_DORMANT_STORAGE_KEY, SHOW_ARCHIVED_STORAGE_KEY, DEFAULT_DORMANT_AFTER_MS,
    GRAPH_SPREAD_STORAGE_KEY, TIMELINE_PRESET_STORAGE_KEY, TIMELINE_VIEW_STORAGE_KEY,
    DEFAULT_GRAPH_SPREAD, DEFAULT_TIMELINE_PRESET, TIMELINE_PRESET_MS, TIMELINE_MIN_SPAN_MS,
    GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX,
    clampGraphSpread, graphForceParams, clampGraphZoom, fitGraphView, zoomGraphView, panGraphView,
    graphViewTransform, clampTimelineWindow, resolveTimelineWindow, formatTimelineAxisLabel,
    zoomTimelineWindow, panTimelineWindow, layoutTimelineMarkers, maxTimelineLaneCount,
    formatLoopElapsed, formatLoopBudget, formatLoopUsage, loopStatusClass, renderLoopStepPipeline,
    formatUsageCost, formatLoopRowUsage, formatLoopUsageNote,
    loopIsFinished,
    loopSyncSignature, loopDetailNeedsSync,
    renderLoopsListHtml, renderLoopPhaseTree, renderLoopPhaseCards, renderLoopDetailHtml, renderLoopGateBanner, mergeEditedLoopPhase,
    emptyLoopPhaseForm, escapeHtml,
  };
} else {
  (function () {
    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    const svg = document.getElementById('graph');
    const stage = document.getElementById('stage');
    const metaEl = document.getElementById('meta');
    const statsEl = document.getElementById('stats');
    const detailEl = document.getElementById('detail');
    const eventsEl = document.getElementById('events');
    const spark24 = document.getElementById('spark24');
    const spark7 = document.getElementById('spark7');
    const hintEl = document.getElementById('hint');
    const actionStatus = document.getElementById('action-status');
    const graphTooltip = document.getElementById('graph-tooltip');
    const projectSelect = document.getElementById('project-select');
    const memoryEl = document.getElementById('project-memory');
    const documentDialog = document.getElementById('document-dialog');
    const documentTitle = document.getElementById('document-title');
    const documentPath = document.getElementById('document-path');
    const documentContent = document.getElementById('document-content');
    const documentNotice = document.getElementById('document-notice');
    const documentToggle = document.getElementById('document-toggle');
    const snapshotData = document.getElementById('aflt-dashboard-data');
    const historyViewEl = document.getElementById('history-view');
    const historyTreeEl = document.getElementById('history-tree');
    const ganttAxisEl = document.getElementById('gantt-axis');
    const graphViewEl = document.getElementById('graph-view');
    const loopsViewEl = document.getElementById('loops-view');
    const viewHistoryBtn = document.getElementById('view-history');
    const viewGraphBtn = document.getElementById('view-graph');
    const viewLoopsBtn = document.getElementById('view-loops');
    const loopsListEl = document.getElementById('loops-list');
    const loopsDefinitionsEl = document.getElementById('loops-definitions');
    const loopsDetailEl = document.getElementById('loops-detail');
    const loopsFormWrap = document.getElementById('loops-form-wrap');
    const loopsForm = document.getElementById('loops-form');
    const loopsPhasesEl = document.getElementById('loops-phases');
    const loopsFormStatus = document.getElementById('loops-form-status');
    const loopsNewBtn = document.getElementById('loops-new');
    const loopsRefreshBtn = document.getElementById('loops-refresh');
    const loopsStartInput = document.getElementById('loops-start-input');
    const loopsStartBtn = document.getElementById('loops-start-btn');
    const loopsAddPhaseBtn = document.getElementById('loops-add-phase');
    const loopsFormCancelBtn = document.getElementById('loops-form-cancel');
    const sortSelect = document.getElementById('history-sort');
    const hideDormantEl = document.getElementById('hide-dormant');
    const dormantHiddenCountEl = document.getElementById('dormant-hidden-count');
    const showArchivedEl = document.getElementById('show-archived');
    const confirmDialog = document.getElementById('confirm-dialog');
    const confirmTitle = document.getElementById('confirm-title');
    const confirmBody = document.getElementById('confirm-body');
    const confirmOk = document.getElementById('confirm-ok');
    const confirmCancel = document.getElementById('confirm-cancel');
    const confirmClose = document.getElementById('confirm-close');
    const leftoffPanel = document.getElementById('leftoff-panel');
    const leftoffEl = document.getElementById('leftoff');
    const historyPanel = document.getElementById('history-panel');
    const historyFeed = document.getElementById('history-feed');
    const historyFilterEl = document.getElementById('history-filter');
    const historyTooltip = document.getElementById('history-tooltip');
    const historyHintEl = document.getElementById('history-hint');
    const herdrRemoteNote = document.getElementById('herdr-remote-note');
    const timelinePresetsEl = document.getElementById('timeline-presets');
    const timelineZoomInBtn = document.getElementById('timeline-zoom-in');
    const timelineZoomOutBtn = document.getElementById('timeline-zoom-out');
    const graphZoomInBtn = document.getElementById('graph-zoom-in');
    const graphZoomOutBtn = document.getElementById('graph-zoom-out');
    const graphFitBtn = document.getElementById('graph-fit');
    const graphSpreadEl = document.getElementById('graph-spread');
    const ganttAxisWrapEl = ganttAxisEl && ganttAxisEl.parentElement;

    let hideDormant = true;
    let showArchived = false;
    let graphSpread = DEFAULT_GRAPH_SPREAD;
    let timelinePreset = DEFAULT_TIMELINE_PRESET;
    let timelineOverride = null;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        const stored = localStorage.getItem(HIDE_DORMANT_STORAGE_KEY);
        if (stored === '0' || stored === 'false') hideDormant = false;
        else if (stored === '1' || stored === 'true') hideDormant = true;
        const archivedStored = localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY);
        if (archivedStored === '1' || archivedStored === 'true') showArchived = true;
        else if (archivedStored === '0' || archivedStored === 'false') showArchived = false;
        const spreadStored = localStorage.getItem(GRAPH_SPREAD_STORAGE_KEY);
        if (spreadStored != null && spreadStored !== '') {
          graphSpread = clampGraphSpread(Number(spreadStored));
        }
        const presetStored = localStorage.getItem(TIMELINE_PRESET_STORAGE_KEY);
        if (presetStored && Object.prototype.hasOwnProperty.call(TIMELINE_PRESET_MS, presetStored)) {
          timelinePreset = presetStored;
        }
        const viewStored = localStorage.getItem(TIMELINE_VIEW_STORAGE_KEY);
        if (viewStored) {
          try {
            const parsed = JSON.parse(viewStored);
            if (parsed && Number.isFinite(parsed.start) && Number.isFinite(parsed.end) && parsed.end > parsed.start) {
              timelineOverride = { start: parsed.start, end: parsed.end };
            }
          } catch (_) {
            /* ignore bad JSON */
          }
        }
      }
    } catch (_) {
      /* ignore quota / private mode */
    }
    if (hideDormantEl) hideDormantEl.checked = hideDormant;
    if (showArchivedEl) showArchivedEl.checked = showArchived;
    if (graphSpreadEl) graphSpreadEl.value = String(Math.round(graphSpread * 100));

    // Prefer updating a trailing text node so the legend element stays intact.
    // Fall back to textContent when the host DOM is a minimal test double.
    const hintTextNode = (function () {
      if (!hintEl) return null;
      const nodes = hintEl.childNodes;
      if (nodes && nodes.length) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (nodes[i] && nodes[i].nodeType === 3) return nodes[i];
        }
      }
      if (typeof document.createTextNode === 'function' && typeof hintEl.appendChild === 'function') {
        try {
          const t = document.createTextNode('');
          hintEl.appendChild(t);
          return t;
        } catch (_) {
          /* fall through */
        }
      }
      return null;
    })();
    function setHintText(text) {
      if (hintTextNode) hintTextNode.nodeValue = '\n          ' + text + '\n        ';
      else if (hintEl) hintEl.textContent = text;
    }

    let currentView = 'history';
    let simStale = true;
    let sortMode = 'recent';
    let sortTouched = false;
    let stateFilter = '';
    const collapseOverride = new Map();
    let historyReq = 0;
    let historyLoaded = null;
    const expandedReplies = new Set();

    let state = null;
    let selectedId = null;
    let hoverId = null;
    let focusId = null;
    let tooltipId = null;
    let tooltipHovered = false;
    let tooltipHideTimer = null;
    let historyHoverId = null;
    let historyFocusId = null;
    let historyTooltipId = null;
    let historyTooltipHovered = false;
    let historyTooltipHideTimer = null;
    let sim = null;
    let graphLayers = null;
    let graphWorld = null;
    let graphView = { scale: 1, tx: 0, ty: 0 };
    let graphViewInitialized = false;
    let graphNeedsFit = true;
    let graphPanning = null;
    let graphPanMoved = false;
    const graphNodes = new Map();
    const expandedTimelineGroups = new Set();
    let timelineWindow = null;
    let timelinePanning = null;
    let timelineTrackWidth = 280;
    let lastUpdatedAt = Date.now();
    let raf = 0;
    let selectedDocument = null;
    let documentSource = false;
    let openingHerdr = false;

    function persistLocal(key, value) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage) {
          localStorage.setItem(key, value);
        }
      } catch (_) {
        /* ignore */
      }
    }

    function forceParams() {
      return graphForceParams(graphSpread);
    }

    function applyGraphWorldTransform() {
      if (!graphWorld) return;
      graphWorld.setAttribute('transform', graphViewTransform(graphView));
    }

    function clientToViewBox(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      const w = sim && sim.w ? sim.w : Math.max(rect.width || 800, 320);
      const h = sim && sim.h ? sim.h : Math.max(rect.height || 600, 320);
      const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * w;
      const y = ((clientY - rect.top) / Math.max(rect.height, 1)) * h;
      return { x: x, y: y, w: w, h: h, rect: rect };
    }

    function fitGraphToView(opts) {
      if (!sim || !sim.nodes || !sim.nodes.length) return;
      const rect = svg.getBoundingClientRect();
      const w = sim.w || Math.max(rect.width || 800, 320);
      const h = sim.h || Math.max(rect.height || 600, 320);
      graphView = fitGraphView(sim.nodes, w, h, opts);
      graphViewInitialized = true;
      graphNeedsFit = false;
      applyGraphWorldTransform();
      positionGraphTooltip();
    }

    function setGraphZoom(factor, clientX, clientY) {
      const pivot = clientToViewBox(
        clientX != null ? clientX : (svg.getBoundingClientRect().left + svg.getBoundingClientRect().width / 2),
        clientY != null ? clientY : (svg.getBoundingClientRect().top + svg.getBoundingClientRect().height / 2)
      );
      graphView = zoomGraphView(graphView, factor, pivot.x, pivot.y);
      graphViewInitialized = true;
      graphNeedsFit = false;
      applyGraphWorldTransform();
      positionGraphTooltip();
    }

    function fullTimelineRange() {
      const tree = state && state.historyTree;
      const range = tree && tree.range;
      const start = range ? Date.parse(range.start) : NaN;
      const end = range ? Date.parse(range.end) : NaN;
      const now = stateNowMs(state);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        // Always extend the right edge to now so presets/pan can follow wall clock
        // even when the newest marker is hours earlier.
        return { start: start, end: Math.max(end, now) };
      }
      return { start: now - TIMELINE_PRESET_MS['7d'], end: now };
    }

    /** Clamp domain for pan/zoom: data ∪ room for the largest duration preset. */
    function timelineClampDomain(full) {
      const end = full && Number.isFinite(full.end) ? full.end : stateNowMs(state);
      const start = full && Number.isFinite(full.start) ? full.start : end - TIMELINE_PRESET_MS['7d'];
      return {
        start: Math.min(start, end - TIMELINE_PRESET_MS['30d']),
        end: end,
      };
    }

    function activeTimelineWindow() {
      const full = fullTimelineRange();
      timelineWindow = resolveTimelineWindow(full, timelinePreset, timelineOverride, stateNowMs(state));
      return timelineWindow;
    }

    function persistTimelineView() {
      persistLocal(TIMELINE_PRESET_STORAGE_KEY, timelinePreset);
      if (timelineOverride) {
        persistLocal(TIMELINE_VIEW_STORAGE_KEY, JSON.stringify(timelineOverride));
      } else {
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.removeItem(TIMELINE_VIEW_STORAGE_KEY);
          }
        } catch (_) {
          /* ignore */
        }
      }
    }

    function syncTimelinePresetChips() {
      if (!timelinePresetsEl || typeof timelinePresetsEl.querySelectorAll !== 'function') return;
      const chips = timelinePresetsEl.querySelectorAll('.timeline-preset');
      for (let i = 0; i < chips.length; i++) {
        const on = (chips[i].getAttribute('data-preset') || '') === timelinePreset;
        toggleBtnClass(chips[i], 'active', on);
        chips[i].setAttribute('aria-pressed', String(on));
      }
    }

    function setTimelinePreset(preset) {
      if (!Object.prototype.hasOwnProperty.call(TIMELINE_PRESET_MS, preset)) return;
      timelinePreset = preset;
      timelineOverride = null;
      expandedTimelineGroups.clear();
      persistTimelineView();
      syncTimelinePresetChips();
      renderHistoryTree();
    }

    function adjustTimelineZoom(factor, anchorMs) {
      const domain = timelineClampDomain(fullTimelineRange());
      const win = activeTimelineWindow();
      timelineOverride = zoomTimelineWindow(win, factor, anchorMs, domain.start, domain.end);
      persistTimelineView();
      renderHistoryTree();
    }

    function adjustTimelinePan(deltaMs) {
      const domain = timelineClampDomain(fullTimelineRange());
      const win = activeTimelineWindow();
      timelineOverride = panTimelineWindow(win, deltaMs, domain.start, domain.end);
      persistTimelineView();
      renderHistoryTree();
    }

    function measureTimelineTrackWidth() {
      if (!historyTreeEl || typeof historyTreeEl.querySelector !== 'function') {
        return timelineTrackWidth;
      }
      const track = historyTreeEl.querySelector('.gantt-track');
      if (track && typeof track.getBoundingClientRect === 'function') {
        const w = track.getBoundingClientRect().width;
        if (w > 40) timelineTrackWidth = w;
      } else if (ganttAxisEl && typeof ganttAxisEl.getBoundingClientRect === 'function') {
        const w = ganttAxisEl.getBoundingClientRect().width;
        if (w > 40) timelineTrackWidth = w;
      }
      return timelineTrackWidth;
    }

    function updateHerdrRemoteNote() {
      if (!herdrRemoteNote) return;
      const remote = !snapshotData && !isHerdrFocusLocal();
      herdrRemoteNote.hidden = !remote;
      if (remote) {
        herdrRemoteNote.textContent =
          'Opening Herdr and archive/delete only work on the Mini — open this dashboard at 127.0.0.1 locally.';
      }
    }

    function actionToken() {
      if (!state || !state.actions) return null;
      return state.actions.actionToken || state.actions.herdrFocusToken || null;
    }

    function actionsAllowed() {
      return !snapshotData && Boolean(actionToken()) && isHerdrFocusLocal();
    }

    function setActionMessage(text, isError) {
      if (!actionStatus) return;
      actionStatus.hidden = false;
      actionStatus.setAttribute('class', isError ? 'action-status error' : 'action-status');
      actionStatus.textContent = text;
    }

    function confirmAction(opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        if (!confirmDialog || typeof confirmDialog.showModal !== 'function') {
          const ok =
            typeof window !== 'undefined' && typeof window.confirm === 'function'
              ? window.confirm(String(opts.body || opts.title || 'Confirm?'))
              : false;
          resolve(ok);
          return;
        }
        if (confirmTitle) confirmTitle.textContent = opts.title || 'Confirm';
        if (confirmBody) confirmBody.textContent = opts.body || '';
        if (confirmOk) confirmOk.textContent = opts.okLabel || 'OK';
        let settled = false;
        function finish(ok) {
          if (settled) return;
          settled = true;
          confirmOk && confirmOk.removeEventListener('click', onOk);
          confirmCancel && confirmCancel.removeEventListener('click', onCancel);
          confirmClose && confirmClose.removeEventListener('click', onCancel);
          confirmDialog.removeEventListener('cancel', onCancel);
          try {
            if (confirmDialog.open) confirmDialog.close();
          } catch (_) {
            /* ignore */
          }
          resolve(ok);
        }
        function onOk(ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          finish(true);
        }
        function onCancel(ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          finish(false);
        }
        confirmOk && confirmOk.addEventListener('click', onOk);
        confirmCancel && confirmCancel.addEventListener('click', onCancel);
        confirmClose && confirmClose.addEventListener('click', onCancel);
        confirmDialog.addEventListener('cancel', onCancel);
        confirmDialog.showModal();
      });
    }

    async function postDashboardAction(pathname, body) {
      if (!actionsAllowed()) {
        setActionMessage(
          'Archive/delete only work on the Mini — open this dashboard at 127.0.0.1 locally.',
          true
        );
        updateHerdrRemoteNote();
        throw new Error('actions require local dashboard');
      }
      const response = await fetch(pathname, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aflt-Action-Token': actionToken(),
        },
        body: JSON.stringify(body || {}),
      });
      const result = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(result.error || 'Request failed');
      if (result.state) applyState(result.state, { forceRebuild: true });
      return result;
    }

    async function openInHerdr(id) {
      if (openingHerdr) return;
      const session = (state.sessions || []).find(function (s) { return s.id === id; });
      if (!session) return;
      setActionMessage('Opening ' + session.title + ' in Herdr...', false);
      if (snapshotData || !actionToken()) {
        setActionMessage('Open the live local dashboard to select this agent in Herdr.', false);
        return;
      }
      if (!isHerdrFocusLocal()) {
        setActionMessage(
          'Opening Herdr only works on the Mini — open this dashboard at 127.0.0.1 locally.',
          true
        );
        updateHerdrRemoteNote();
        return;
      }
      openingHerdr = true;
      try {
        const response = await fetch('/api/herdr/focus/' + encodeURIComponent(id), {
          method: 'POST',
          headers: { 'X-Aflt-Action-Token': actionToken() },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Unable to open the agent in Herdr.');
        setActionMessage('Selected ' + session.title + ' in Herdr.', false);
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      } finally {
        openingHerdr = false;
      }
    }

    async function archiveSession(id, withChildren) {
      setActionMessage(withChildren ? 'Archiving with sub-agents…' : 'Archiving…', false);
      try {
        const result = await postDashboardAction('/api/session/archive', {
          id: id,
          withChildren: !!withChildren,
        });
        setActionMessage(
          'Archived ' + ((result.archived && result.archived[0] && result.archived[0].title) || id) + '.',
          false
        );
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    async function unarchiveSession(id, withChildren) {
      setActionMessage('Unarchiving…', false);
      try {
        await postDashboardAction('/api/session/unarchive', {
          id: id,
          withChildren: !!withChildren,
        });
        setActionMessage('Unarchived ' + id + '.', false);
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    async function deleteSession(id, title) {
      const label = title || id;
      const ok = await confirmAction({
        title: 'Remove from registry?',
        body:
          'Remove "' +
          label +
          '" from the registry? Run logs under ~/.agentfleet/runs/ are kept. This cannot be undone from the dashboard.',
        okLabel: 'Remove',
      });
      if (!ok) return;
      setActionMessage('Removing…', false);
      try {
        await postDashboardAction('/api/session/delete', { id: id });
        if (selectedId === id) selectedId = null;
        setActionMessage('Removed ' + label + ' (logs kept).', false);
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    async function purgeSession(id, title) {
      const label = title || id;
      const ok = await confirmAction({
        title: 'Delete everything?',
        body:
          'Permanently purge "' +
          label +
          '" — registry row, runs/<id>/ logs, results/plans, and the engine Copilot/Cursor chat when mapped. Never touches Herdr. Type the session id in the next prompt.',
        okLabel: 'Continue',
      });
      if (!ok) return;
      let typed = '';
      if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
        typed = String(
          window.prompt('Type the session id to confirm full purge:\n' + id, '') || ''
        ).trim();
      }
      if (typed !== id) {
        setActionMessage('Purge cancelled — session id did not match.', true);
        return;
      }
      setActionMessage('Purging…', false);
      try {
        await postDashboardAction('/api/session/purge', { id: id, confirmId: typed });
        if (selectedId === id) selectedId = null;
        setActionMessage('Purged ' + label + '.', false);
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    async function archiveIdleInProject(projectName) {
      const ok = await confirmAction({
        title: 'Archive idle/done sessions?',
        body:
          'Archive all idle and done sessions in project "' +
          projectName +
          '"? Running, waiting, and failed sessions stay visible. You can unarchive later.',
        okLabel: 'Archive idle/done',
      });
      if (!ok) return;
      setActionMessage('Archiving idle/done sessions…', false);
      try {
        const result = await postDashboardAction('/api/project/archive-idle', {
          project: projectName,
        });
        const n = (result.archived || []).length;
        setActionMessage(
          n === 0 ? 'No idle/done sessions to archive.' : 'Archived ' + n + ' session' + (n === 1 ? '' : 's') + '.',
          false
        );
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      }
    }

    function sessionActionButtonsHtml(session) {
      if (!session || snapshotData) return '';
      const local = actionsAllowed();
      const disabled = local ? '' : ' disabled title="Only on the Mini (127.0.0.1)"';
      if (session.archived) {
        return (
          '<div class="session-actions">' +
          '<button type="button" data-action="unarchive" data-id="' +
          esc(session.id) +
          '"' +
          disabled +
          '>Unarchive</button>' +
          '<button type="button" class="danger" data-action="delete" data-id="' +
          esc(session.id) +
          '" data-title="' +
          esc(session.title || session.id) +
          '"' +
          disabled +
          '>Remove</button>' +
          '<button type="button" class="danger" data-action="purge" data-id="' +
          esc(session.id) +
          '" data-title="' +
          esc(session.title || session.id) +
          '"' +
          disabled +
          '>Delete everything</button></div>'
        );
      }
      const kids = (session.children || []).length;
      return (
        '<div class="session-actions">' +
        '<button type="button" data-action="archive" data-id="' +
        esc(session.id) +
        '"' +
        disabled +
        '>Archive</button>' +
        (kids
          ? '<button type="button" data-action="archive-children" data-id="' +
            esc(session.id) +
            '"' +
            disabled +
            '>Archive with sub-agents</button>'
          : '') +
        '<button type="button" class="danger" data-action="delete" data-id="' +
        esc(session.id) +
        '" data-title="' +
        esc(session.title || session.id) +
        '"' +
        disabled +
        '>Remove</button>' +
        '<button type="button" class="danger" data-action="purge" data-id="' +
        esc(session.id) +
        '" data-title="' +
        esc(session.title || session.id) +
        '"' +
        disabled +
        '>Delete everything</button></div>'
      );
    }

    function projectActionButtonsHtml(project) {
      if (!project || snapshotData || !(project.sessionCount > 0 || project.archivedCount > 0)) return '';
      const local = actionsAllowed();
      const disabled = local ? '' : ' disabled title="Only on the Mini (127.0.0.1)"';
      return (
        '<div class="project-actions">' +
        '<button type="button" data-action="archive-idle" data-project="' +
        esc(project.name) +
        '"' +
        disabled +
        '>Archive all idle/done sub-agents</button></div>'
      );
    }

    function rowActionsHtml(enriched, isProject) {
      if (snapshotData) return '';
      const local = actionsAllowed();
      const disabled = local ? '' : ' disabled title="Only on the Mini (127.0.0.1)"';
      if (isProject) {
        if (!(enriched.sessionCount > 0 || enriched.archivedCount > 0)) return '';
        return (
          '<span class="row-actions">' +
          '<button type="button" data-action="archive-idle" data-project="' +
          esc(enriched.name) +
          '"' +
          disabled +
          '>Archive idle/done</button></span>'
        );
      }
      if (enriched.archived) {
        return (
          '<span class="row-actions">' +
          '<button type="button" data-action="unarchive" data-id="' +
          esc(enriched.id) +
          '"' +
          disabled +
          '>Unarchive</button>' +
          '<button type="button" class="danger" data-action="delete" data-id="' +
          esc(enriched.id) +
          '" data-title="' +
          esc(enriched.title || enriched.id) +
          '"' +
          disabled +
          '>Remove</button>' +
          '<button type="button" class="danger" data-action="purge" data-id="' +
          esc(enriched.id) +
          '" data-title="' +
          esc(enriched.title || enriched.id) +
          '"' +
          disabled +
          '>Purge</button></span>'
        );
      }
      const kids = (enriched.children || []).length;
      return (
        '<span class="row-actions">' +
        '<button type="button" data-action="archive" data-id="' +
        esc(enriched.id) +
        '"' +
        disabled +
        '>Archive</button>' +
        (kids
          ? '<button type="button" data-action="archive-children" data-id="' +
            esc(enriched.id) +
            '"' +
            disabled +
            '>Archive+</button>'
          : '') +
        '<button type="button" class="danger" data-action="delete" data-id="' +
        esc(enriched.id) +
        '" data-title="' +
        esc(enriched.title || enriched.id) +
        '"' +
        disabled +
        '>Remove</button>' +
        '<button type="button" class="danger" data-action="purge" data-id="' +
        esc(enriched.id) +
        '" data-title="' +
        esc(enriched.title || enriched.id) +
        '"' +
        disabled +
        '>Purge</button></span>'
      );
    }

    const COLORS = {
      working: 'var(--state-working)',
      waiting: 'var(--state-waiting)',
      idle: 'var(--state-idle)',
      completed: 'var(--state-completed)',
      failed: 'var(--state-failed)',
      // Legacy aliases
      running: 'var(--state-working)',
      done: 'var(--state-completed)',
    };
    const markerPayload = new Map();

    function ago(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      return Math.floor(m / 60) + 'h ago';
    }

    function spacePrefix() {
      return state && state.space ? 'space ' + state.space + ' · ' : '';
    }

    function applySpaceBrand() {
      // Tests run dashboard.js in a minimal vm document without querySelector.
      if (typeof document.querySelector !== 'function') return;
      const brandEl = document.querySelector('.brand');
      if (!brandEl) return;
      if (state && state.space) {
        brandEl.textContent = 'aflt live · ' + state.space;
        if (typeof document.title === 'string' || 'title' in document) {
          document.title = 'aflt live · ' + state.space;
        }
      } else {
        brandEl.textContent = 'aflt live';
        if (!snapshotData && (typeof document.title === 'string' || 'title' in document)) {
          document.title = 'aflt live';
        }
      }
    }

    function tickMeta() {
      if (!state) {
        metaEl.textContent = 'local · connecting…';
        return;
      }
      applySpaceBrand();
      if (snapshotData) {
        metaEl.textContent = spacePrefix() + 'snapshot · ' + formatLocalDateTime(state.generatedAt);
        return;
      }
      if (state.error) {
        metaEl.textContent = spacePrefix() + 'dashboard error · ' + state.error;
        return;
      }
      if (state.completions && state.completions.errors.length) {
        metaEl.textContent = spacePrefix() + 'completion error · ' + state.completions.errors.join('; ');
        return;
      }
      metaEl.textContent = spacePrefix() + 'local · updated ' + ago(Date.now() - lastUpdatedAt) +
        (state.completions && state.completions.captureEnabled ? ' · completion capture on' : '');
    }
    setInterval(tickMeta, 1000);

    function sparkPath(series, w, h) {
      const vals = series || [];
      if (!vals.length) return '';
      const max = Math.max(1, ...vals);
      const step = w / Math.max(vals.length - 1, 1);
      return vals
        .map(function (v, i) {
          const x = i * step;
          const y = h - (v / max) * (h - 4) - 2;
          return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
        })
        .join(' ');
    }

    function drawSpark(el, series, color) {
      const w = 280;
      const h = 40;
      const d = sparkPath(series, w, h);
      el.innerHTML =
        '<path d="' +
        d +
        '" fill="none" stroke="' +
        color +
        '" stroke-width="1.6" stroke-linejoin="round"/>';
    }

    function renderStats(s) {
      const st = s.stats || {};
      const eng = st.engines || {};
      statsEl.innerHTML =
        '<div class="stat"><div class="k">active projects</div><div class="v">' +
        (st.activeProjects || 0) +
        '</div></div>' +
        '<div class="stat"><div class="k">Working</div><div class="v working">' +
        (st.workingSessions != null ? st.workingSessions : st.runningSessions || 0) +
        '</div></div>' +
        '<div class="engines">cursor ' +
        (eng.cursor || 0) +
        ' · copilot ' +
        (eng.copilot || 0) +
        ' · Working ' +
        (st.open || 0) +
        ' · Waiting ' +
        (st.waiting || 0) +
        ' · Idle ' +
        (st.idle || 0) +
        ' · Completed ' +
        (st.completed != null ? st.completed : st.done || 0) +
        ' · Failed ' +
        (st.failed || 0) +
        '</div>';
    }

    function renderEvents(s) {
      const events = s.events || [];
      eventsEl.innerHTML = events
        .map(function (ev) {
          const when = formatLocalDateTime(ev.at);
          return (
            '<li><span class="when">' +
            esc(when) +
            '</span>' +
            esc(ev.text || '') +
            '</li>'
          );
        })
        .join('');
    }

    function esc(s) {
      return escapeHtml(s);
    }

    function currentProject() {
      const item = findSelection();
      if (!item) return null;
      return item.name && item.sessionCount != null ? item : (state.projects || []).find(function (p) {
        return p.name === item.project;
      });
    }

    function renderMemory() {
      const project = currentProject();
      const options = '<option value="">Select a project</option>' + (state.projects || []).map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
      }).join('');
      if (projectSelect.innerHTML !== options) projectSelect.innerHTML = options;
      projectSelect.value = project ? project.id : '';
      const html = renderProjectMemory(project, state.memory);
      if (memoryEl.innerHTML !== html) memoryEl.innerHTML = html;
      if (documentDialog.open && selectedDocument) showDocument(selectedDocument);
    }

    function showDocument(selection) {
      const project = (state.projects || []).find(function (p) { return p.id === selection.project; });
      const doc = project && project.memory && project.memory.documents.find(function (d) {
        return d.path === selection.path;
      });
      documentTitle.textContent = doc ? doc.title : 'Document unavailable';
      documentPath.textContent = selection.path;
      const content = doc ? doc.content : 'This document is no longer available. Close this reader and select another document.';
      const html = documentSource
        ? '<pre class="markdown-source">' + escapeHtml(content) + '</pre>'
        : renderMarkdown(content);
      if (documentContent.innerHTML !== html) documentContent.innerHTML = html;
      documentToggle.textContent = documentSource ? 'Render Markdown' : 'View source';
      documentNotice.textContent = 'Read-only ' + (documentSource ? 'Markdown source' : 'Markdown preview') +
        ' · sensitive values redacted' +
        (doc && doc.truncated ? ' · truncated to 32 KiB. Open the source file for the full document.' : '') +
        (documentSource ? '' : ' · images shown as text');
    }

    documentToggle.addEventListener('click', function () {
      documentSource = !documentSource;
      if (selectedDocument) showDocument(selectedDocument);
    });
    documentContent.addEventListener('click', function (event) {
      const link = event.target.closest('a[data-document-link]');
      if (!link || !selectedDocument) return;
      event.preventDefault();
      const target = resolveDocumentLink(state.projects, selectedDocument.path, link.dataset.documentLink);
      if (!target) {
        documentNotice.textContent = 'This linked document is not included in the read-only preview. Open it from the source repository.';
        return;
      }
      selectedDocument = { project: target.project, path: target.path };
      showDocument(selectedDocument);
      if (target.fragment) {
        const heading = document.getElementById('document-heading-' + target.fragment);
        if (heading) heading.scrollIntoView({ block: 'start' });
        else documentNotice.textContent = 'The linked heading was not found in this preview.';
      }
    });

    projectSelect.addEventListener('change', function () {
      selectedId = projectSelect.value || null;
      renderDetail();
    });
    memoryEl.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-document-path]');
      const project = currentProject();
      if (!button || !project) return;
      selectedDocument = { project: project.id, path: button.dataset.documentPath };
      showDocument(selectedDocument);
      documentDialog.showModal();
    });
    document.getElementById('document-close').addEventListener('click', function () {
      documentDialog.close();
    });

    function findSelection() {
      if (!selectedId || !state) return null;
      if (String(selectedId).startsWith('project:')) {
        const name = String(selectedId).slice('project:'.length);
        return (state.projects || []).find(function (p) {
          return p.name === name || p.id === selectedId;
        });
      }
      return (state.sessions || []).find(function (s) {
        return s.id === selectedId;
      });
    }

    function renderDetail() {
      renderMemory();
      syncHistoryPanel();
      markSelectedRows();
      const item = findSelection();
      if (!item) {
        detailEl.innerHTML = '<div class="empty">select a project or session</div>';
        return;
      }
      if (item.sessionCount != null && item.name) {
        const projectState = item.filterState || item.displayState || 'idle';
        detailEl.innerHTML =
          '<div class="label">project</div><h2>' +
          esc(item.name) +
          '</h2><span class="badge ' +
          esc(projectState) +
          '">' +
          esc(stateLabel(projectState)) +
          '</span><dl>' +
          row('sessions', item.sessionCount) +
          row('archived', item.archivedCount || 0) +
          row('Working', item.workingCount != null ? item.workingCount : item.runningCount) +
          row('last activity', item.lastActivity ? formatLocalDateTime(item.lastActivity) : '—') +
          '</dl>' +
          projectActionButtonsHtml(item) +
          renderTaskCompletion(item.completion);
        return;
      }
      const kids = (item.children || []).length;
      const liveState = rowFilterState(item);
      detailEl.innerHTML =
        '<div class="label">session</div><h2>' +
        esc(item.title) +
        '</h2><span class="badge ' +
        esc(liveState) +
        '">' +
        esc(activityLabel(item)) +
        '</span><dl>' +
        row('id', item.id) +
        row('project', item.project) +
        row('engine', item.engine) +
        row('status', item.status) +
        row('archived', item.archived ? 'yes' : 'no') +
        row('worker', item.workerStatus || '—') +
        row('cwd', item.cwd || '—') +
        row('model', item.model || '—') +
        row('last used', item.lastUsed ? formatLocalDateTime(item.lastUsed) : '—') +
        row('last exit', item.lastExit == null ? '—' : item.lastExit) +
        row('error', item.lastError || '—') +
        row(
          'herdr',
          item.herdr && item.herdr.runtime
            ? item.herdr.runtime + (item.herdr.name ? ' · ' + item.herdr.name : '')
            : '—'
        ) +
        row('children', kids) +
        '</dl>' +
        sessionActionButtonsHtml(item) +
        renderTaskCompletion(item.completion);
    }

    function row(k, v) {
      return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>';
    }

    function stateNowMs(s) {
      const t = s && s.generatedAt != null ? Date.parse(String(s.generatedAt)) : NaN;
      return Number.isFinite(t) ? t : Date.now();
    }

    function dormantWindowMs(s) {
      const n = s && s.dormantAfterMs != null ? Number(s.dormantAfterMs) : DEFAULT_DORMANT_AFTER_MS;
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DORMANT_AFTER_MS;
    }

    function countDormantProjects(list, s) {
      const nowMs = stateNowMs(s);
      const windowMs = dormantWindowMs(s);
      let n = 0;
      (list || []).forEach(function (p) {
        if (isDormantProject(p, nowMs, windowMs)) n += 1;
      });
      return n;
    }

    function filterGraphProjects(list, s) {
      const nowMs = stateNowMs(s);
      const windowMs = dormantWindowMs(s);
      return (list || []).filter(function (p) {
        if (!p) return false;
        if (p.fromMemoryOnly || !(p.sessionCount > 0)) return false;
        if (hideDormant && isDormantProject(p, nowMs, windowMs)) return false;
        return true;
      });
    }

    function updateDormantHiddenCount() {
      if (!dormantHiddenCountEl) return;
      if (!hideDormant || !state) {
        dormantHiddenCountEl.hidden = true;
        dormantHiddenCountEl.textContent = '';
        return;
      }
      // Count session-bearing dormant hubs removed from Graph/History (not the No-sessions group).
      const n = countDormantProjects(
        (state.projects || []).filter(function (p) {
          return p && !p.fromMemoryOnly && p.sessionCount > 0;
        }),
        state
      );
      if (n <= 0) {
        dormantHiddenCountEl.hidden = true;
        dormantHiddenCountEl.textContent = '';
        return;
      }
      dormantHiddenCountEl.hidden = false;
      dormantHiddenCountEl.textContent = n === 1 ? '1 dormant hidden' : n + ' dormant hidden';
    }

    function buildSim(s) {
      const rect = svg.getBoundingClientRect();
      const w = Math.max(rect.width || 800, 320);
      const h = Math.max(rect.height || 600, 320);
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      const params = forceParams();
      const nodes = [];
      const links = [];
      // Sessionless memory-only projects stay out; optionally hide dormant hubs.
      const projects = filterGraphProjects(s.projects || [], s);
      const visibleNames = {};
      projects.forEach(function (p) { visibleNames[p.name] = true; });
      const sessions = (s.sessions || []).filter(function (sess) {
        if (!sess || !visibleNames[sess.project]) return false;
        if (sess.archived && !showArchived) return false;
        return true;
      });
      const n = Math.max(projects.length, 1);
      const hubR = Math.min(w, h) * params.hubRadiusFactor;
      const cx = w * 0.5;
      const cy = h * 0.5;

      projects.forEach(function (p, i) {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const projectState = p.filterState || p.displayState || 'idle';
        nodes.push({
          id: p.id,
          kind: 'project',
          label: p.name,
          displayState: projectState,
          filterState: projectState,
          x: cx + Math.cos(angle) * hubR,
          y: cy + Math.sin(angle) * hubR,
          vx: 0,
          vy: 0,
          r: 20,
          fixed: reduced,
        });
      });

      const hub = {};
      nodes.forEach(function (n) {
        if (n.kind === 'project') hub[n.label] = n;
      });

      sessions.forEach(function (sess, idx) {
        const parent = hub[sess.project] || { x: cx, y: cy };
        const a = ((idx % 12) / 12) * Math.PI * 2;
        nodes.push({
          id: sess.id,
          kind: 'session',
          label: sess.nodeLabel || sess.id,
          displayState: sess.displayState,
          activityState: sess.activityState,
          awaitingInput: !!sess.awaitingInput,
          recent: !!sess.recent,
          x: parent.x + Math.cos(a) * params.sessionOrbit,
          y: parent.y + Math.sin(a) * params.sessionOrbit,
          vx: 0,
          vy: 0,
          r: 8,
          project: sess.project,
        });
      });

      const sessionById = new Map(sessions.map(function (sess) { return [sess.id, sess]; }));
      (s.links || []).forEach(function (l) {
        links.push({
          source: l.from, target: l.to, kind: l.kind,
          recent: !!(sessionById.get(l.to) || {}).recent,
        });
      });

      const byId = {};
      nodes.forEach(function (n) {
        byId[n.id] = n;
      });
      const resolved = links
        .map(function (l) {
          return {
            source: byId[l.source],
            target: byId[l.target],
            kind: l.kind,
            recent: l.recent,
          };
        })
        .filter(function (l) {
          return l.source && l.target;
        });

      return { nodes: nodes, links: resolved, w: w, h: h, cx: cx, cy: cy, alpha: 1 };
    }

    function stepSim(model) {
      if (reduced) return;
      if (model.alpha == null) model.alpha = 1;
      if (model.alpha < 0.002) {
        for (let i = 0; i < model.nodes.length; i++) {
          model.nodes[i].vx = 0;
          model.nodes[i].vy = 0;
        }
        return;
      }
      const alpha = model.alpha;
      const nodes = model.nodes;
      const links = model.links;
      const params = forceParams();
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy || 1;
          const dist = Math.sqrt(d2);
          const min = (a.r + b.r) * params.collideMult;
          if (dist < min) {
            const f = ((min - dist) / dist) * params.collideForce * alpha;
            dx *= f;
            dy *= f;
            if (!a.fixed) {
              a.vx -= dx;
              a.vy -= dy;
            }
            if (!b.fixed) {
              b.vx += dx;
              b.vy += dy;
            }
          } else {
            const f = (params.repulsion / d2) * alpha;
            dx *= f;
            dy *= f;
            if (!a.fixed) {
              a.vx -= dx;
              a.vy -= dy;
            }
            if (!b.fixed) {
              b.vx += dx;
              b.vy += dy;
            }
          }
        }
      }
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        const a = l.source;
        const b = l.target;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const ideal = l.kind === 'parent' ? params.linkIdealParent : params.linkIdealOther;
        const f = ((dist - ideal) / dist) * 0.02 * alpha;
        dx *= f;
        dy *= f;
        if (!a.fixed) {
          a.vx += dx;
          a.vy += dy;
        }
        if (!b.fixed) {
          b.vx -= dx;
          b.vy -= dy;
        }
      }
      let ke = 0;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.kind === 'project') {
          const dx = model.cx - n.x;
          const dy = model.cy - n.y;
          n.vx += dx * params.centerPull * alpha;
          n.vy += dy * params.centerPull * alpha;
        }
        if (n.fixed) {
          n.vx = 0;
          n.vy = 0;
          continue;
        }
        n.vx *= 0.86;
        n.vy *= 0.86;
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.max(n.r + 8, Math.min(model.w - n.r - 8, n.x));
        n.y = Math.max(n.r + 8, Math.min(model.h - n.r - 8, n.y));
        ke += n.vx * n.vx + n.vy * n.vy;
      }
      if (ke < 0.00005) {
        model.alpha = 0;
      } else {
        model.alpha *= 0.988;
      }
    }

    function positionGraphTooltip() {
      if (!tooltipId || !sim || tooltipHovered) return;
      const node = sim.nodes.find(function (n) { return n.id === tooltipId; });
      if (!node) return;
      const graphRect = svg.getBoundingClientRect();
      const tipRect = graphTooltip.getBoundingClientRect();
      const sx = graphRect.width / sim.w;
      const sy = graphRect.height / sim.h;
      const scale = graphView.scale || 1;
      const screenX = (node.x * scale + (graphView.tx || 0)) * sx;
      const screenY = (node.y * scale + (graphView.ty || 0)) * sy;
      const nodeR = node.r * scale * sx;
      let left = screenX + nodeR + 12;
      if (left + tipRect.width > graphRect.width - 12) {
        left = screenX - nodeR - tipRect.width - 12;
      }
      graphTooltip.style.left = Math.max(12, Math.min(left, graphRect.width - tipRect.width - 12)) + 'px';
      graphTooltip.style.top = Math.max(12, Math.min(screenY - tipRect.height / 2,
        graphRect.height - tipRect.height - 12)) + 'px';
    }

    function cancelTooltipHide() {
      if (tooltipHideTimer !== null) clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }

    function dismissGraphTooltip() {
      cancelTooltipHide();
      hoverId = null;
      focusId = null;
      tooltipId = null;
      tooltipHovered = false;
      renderGraphTooltip();
    }

    function scheduleTooltipHide() {
      cancelTooltipHide();
      if (hoverId || focusId || tooltipHovered) return;
      tooltipHideTimer = setTimeout(function () {
        tooltipHideTimer = null;
        if (!hoverId && !focusId && !tooltipHovered) dismissGraphTooltip();
      }, 450);
    }

    function renderGraphTooltip() {
      const id = hoverId || focusId || tooltipId;
      const session = state && (state.sessions || []).find(function (s) { return s.id === id; });
      const project = state && (state.projects || []).find(function (p) {
        return p.id === id || (session && p.name === session.project);
      });
      const nextId = session || project ? id : null;
      if (tooltipHovered && nextId && tooltipId === nextId) return;
      tooltipId = nextId;
      if (!tooltipId) {
        tooltipHovered = false;
        cancelTooltipHide();
      }
      graphTooltip.hidden = !tooltipId;
      const html = renderGraphHint(project, session);
      if (graphTooltip.innerHTML !== html) graphTooltip.innerHTML = html;
      setHintText(tooltipId
        ? 'click for details · double-click an agent for Herdr · Esc to dismiss hint'
        : 'hover a node · click for details · double-click an agent for Herdr');
      positionGraphTooltip();
    }

    function drawGraph() {
      if (!sim) return;
      const ns = 'http://www.w3.org/2000/svg';
      if (!graphWorld) {
        graphWorld = document.createElementNS(ns, 'g');
        graphWorld.setAttribute('class', 'graph-world');
        svg.appendChild(graphWorld);
      }
      if (!graphLayers) {
        graphLayers = ['stars', 'edges', 'nodes'].map(function () {
          const group = document.createElementNS(ns, 'g');
          graphWorld.appendChild(group);
          return group;
        });
      }
      applyGraphWorldTransform();
      if (graphNeedsFit && sim.nodes && sim.nodes.length) {
        fitGraphToView();
      }
      const stars = graphLayers[0];
      const edgeG = graphLayers[1];
      const nodeG = graphLayers[2];
      while (stars.firstChild) stars.removeChild(stars.firstChild);
      while (edgeG.firstChild) edgeG.removeChild(edgeG.firstChild);

      for (let i = 0; i < 50; i++) {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', String((i * 97) % sim.w));
        c.setAttribute('cy', String((i * 53) % sim.h));
        c.setAttribute('r', '1');
        c.setAttribute('fill', 'var(--cp-text-muted)');
        c.setAttribute('opacity', String(0.12 + (i % 5) * 0.04));
        stars.appendChild(c);
      }
      sim.links.forEach(function (l) {
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', l.source.x);
        line.setAttribute('y1', l.source.y);
        line.setAttribute('x2', l.target.x);
        line.setAttribute('y2', l.target.y);
        line.setAttribute(
          'class',
          'edge ' + l.kind + (l.recent ? ' recent' : '')
        );
        edgeG.appendChild(line);

        if (!reduced && l.recent) {
          const t = (Date.now() / 1000) % 1;
          const tx = l.source.x + (l.target.x - l.source.x) * t;
          const ty = l.source.y + (l.target.y - l.source.y) * t;
          const dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', tx);
          dot.setAttribute('cy', ty);
          dot.setAttribute('r', '2.2');
          dot.setAttribute('class', 'traveler');
          edgeG.appendChild(dot);
        }
      });
      const visibleIds = new Set(sim.nodes.map(function (n) { return n.id; }));
      graphNodes.forEach(function (entry, id) {
        if (!visibleIds.has(id)) {
          nodeG.removeChild(entry.group);
          graphNodes.delete(id);
        }
      });
      sim.nodes.forEach(function (n) {
        let entry = graphNodes.get(n.id);
        if (!entry) {
          const g = document.createElementNS(ns, 'g');
          const circle = document.createElementNS(ns, 'circle');
          const label = document.createElementNS(ns, 'text');
          g.setAttribute('data-id', n.id);
          g.setAttribute('role', 'button');
          g.setAttribute('tabindex', '0');
          g.setAttribute('aria-describedby', 'graph-tooltip');
          g.appendChild(circle);
          g.appendChild(label);
          let waiting = null;
          let working = null;
          if (n.kind === 'session') {
            const indicator = document.createElementNS(ns, 'g');
            const ring = document.createElementNS(ns, 'circle');
            const badge = document.createElementNS(ns, 'circle');
            const mark = document.createElementNS(ns, 'text');
            indicator.setAttribute('class', 'waiting-indicator');
            indicator.setAttribute('aria-hidden', 'true');
            ring.setAttribute('class', 'waiting-ring');
            badge.setAttribute('class', 'waiting-badge');
            badge.setAttribute('r', '7');
            mark.setAttribute('class', 'waiting-mark');
            mark.textContent = '?';
            indicator.appendChild(ring);
            indicator.appendChild(badge);
            indicator.appendChild(mark);
            g.appendChild(indicator);
            waiting = { group: indicator, ring: ring, badge: badge, mark: mark };
            working = document.createElementNS(ns, 'circle');
            working.setAttribute('class', 'working-indicator');
            working.setAttribute('aria-hidden', 'true');
            working.setAttribute('pathLength', '100');
            g.appendChild(working);
          }
          g.addEventListener('mouseenter', function () {
            cancelTooltipHide();
            focusId = null;
            hoverId = n.id;
            renderGraphTooltip();
          });
          g.addEventListener('mouseleave', function () {
            if (hoverId === n.id) hoverId = null;
            scheduleTooltipHide();
          });
          g.addEventListener('focus', function () {
            cancelTooltipHide();
            if (hoverId !== n.id) focusId = n.id;
            renderGraphTooltip();
          });
          g.addEventListener('blur', function () {
            if (focusId === n.id) focusId = null;
            scheduleTooltipHide();
          });
          function selectNode(ev) {
            ev.stopPropagation();
            selectedId = n.id;
            renderDetail();
          }
          g.addEventListener('click', selectNode);
          if (n.kind === 'session') {
            g.addEventListener('dblclick', function (ev) {
              ev.stopPropagation();
              openInHerdr(n.id);
            });
          }
          g.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
              dismissGraphTooltip();
            }
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              selectNode(ev);
            }
          });
          nodeG.appendChild(g);
          entry = { group: g, circle: circle, label: label, waiting: waiting, working: working };
          graphNodes.set(n.id, entry);
        }
        const g = entry.group;
        const c = entry.circle;
        const label = entry.label;
        g.setAttribute('class', 'node-hit' + (selectedId === n.id ? ' selected' : ''));
        g.setAttribute('aria-label', n.kind === 'session' ? n.id + ' — ' + activityLabel(n) : n.label);
        g.setAttribute('aria-pressed', String(selectedId === n.id));
        c.setAttribute('cx', n.x);
        c.setAttribute('cy', n.y);
        c.setAttribute('r', n.r);
        const live =
          n.kind === 'project'
            ? n.filterState || n.displayState || 'idle'
            : rowFilterState(n);
        c.setAttribute('style', '--cp-node-color: ' + (COLORS[live] || COLORS.idle));
        label.setAttribute('x', n.x);
        label.setAttribute('text-anchor', 'middle');
        label.textContent = n.label;

        if (n.kind === 'project') {
          c.setAttribute('class', 'hub');
          c.setAttribute('stroke', COLORS[live] || COLORS.idle);
          label.setAttribute('y', n.y + n.r + 14);
          label.setAttribute('class', 'hub-label');
          label.setAttribute('visibility', 'visible');
        } else {
          c.setAttribute(
            'class',
            'leaf ' +
              live +
              (live === 'waiting' ? ' awaiting-input' : '') +
              (live === 'working' && !reduced ? ' pulse' : '')
          );
          label.setAttribute('y', n.y + n.r + 14);
          label.setAttribute('class', 'session-label');
          label.setAttribute('visibility', 'visible');
          const waiting = entry.waiting;
          waiting.group.setAttribute('visibility', live === 'waiting' ? 'visible' : 'hidden');
          waiting.ring.setAttribute('cx', n.x);
          waiting.ring.setAttribute('cy', n.y);
          waiting.ring.setAttribute('r', n.r + 4);
          waiting.badge.setAttribute('cx', n.x + n.r + 6);
          waiting.badge.setAttribute('cy', n.y - n.r - 2);
          waiting.mark.setAttribute('x', n.x + n.r + 6);
          waiting.mark.setAttribute('y', n.y - n.r + 2);
          entry.working.setAttribute('visibility', live === 'working' ? 'visible' : 'hidden');
          entry.working.setAttribute('cx', n.x);
          entry.working.setAttribute('cy', n.y);
          entry.working.setAttribute('r', n.r + 4);
        }
      });
      positionGraphTooltip();
    }

    /* ---------- history view ---------- */

    function setShown(el, shown) {
      if (!el) return;
      el.hidden = !shown;
      if (el.style) el.style.display = shown ? '' : 'none';
    }

    function timeMs(value) {
      const t = Date.parse(value || '');
      return isNaN(t) ? 0 : t;
    }

    function agoLabel(value) {
      const t = Date.parse(value || '');
      if (isNaN(t)) return '';
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      const h = Math.floor(m / 60);
      if (h < 48) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    }

    function sessionSortFn(mode) {
      return function (a, b) {
        if (mode === 'name') return String(a.title || '').localeCompare(String(b.title || ''));
        if (mode === 'created') {
          return timeMs(b.created) - timeMs(a.created) ||
            String(a.title || '').localeCompare(String(b.title || ''));
        }
        return timeMs(b.lastActivity) - timeMs(a.lastActivity) ||
          String(a.title || '').localeCompare(String(b.title || ''));
      };
    }

    function sortSessionNodes(list, mode) {
      return (list || []).slice().sort(sessionSortFn(mode)).map(function (node) {
        return Object.assign({}, node, { children: sortSessionNodes(node.children, mode) });
      });
    }

    function newestCreated(node) {
      let best = node.kind === 'session' ? timeMs(node.created) : 0;
      (node.children || []).forEach(function (c) {
        best = Math.max(best, newestCreated(c));
      });
      return best;
    }

    function sortProjectNodes(projects, mode) {
      const sorted = (projects || []).slice().sort(function (a, b) {
        const byName = String(a.name || '').localeCompare(String(b.name || ''));
        if (mode === 'name' || mode === 'project') return byName;
        if (mode === 'created') {
          return newestCreated(b) - newestCreated(a) ||
            timeMs(b.lastActivity) - timeMs(a.lastActivity) || byName;
        }
        if (!!a.active !== !!b.active) return a.active ? -1 : 1;
        return timeMs(b.lastActivity) - timeMs(a.lastActivity) || byName;
      });
      return sorted.map(function (p) {
        return Object.assign({}, p, { children: sortSessionNodes(p.children, mode) });
      });
    }

    function rollupFilterState(states) {
      if (!states || !states.length) return 'idle';
      for (let i = 0; i < FILTER_PRIORITY.length; i++) {
        if (states.indexOf(FILTER_PRIORITY[i]) !== -1) return FILTER_PRIORITY[i];
      }
      return 'idle';
    }

    function collectSessionFilterStates(node) {
      const enriched = enrichHistoryNode(node);
      const out = [];
      if (enriched.kind === 'session') out.push(rowFilterState(enriched));
      (enriched.children || []).forEach(function (c) {
        Array.prototype.push.apply(out, collectSessionFilterStates(c));
      });
      return out;
    }

    function projectFilterRollup(node) {
      // Live child roll-up so SSE session enrichments win over a stale project badge.
      return rollupFilterState(collectSessionFilterStates(node));
    }

    function isCollapsed(node) {
      if (collapseOverride.has(node.id)) return collapseOverride.get(node.id);
      if (node && node.kind === 'no-sessions-group') {
        // Sessionless memory projects: collapsed by default; override survives SSE.
        return node.collapsed !== false;
      }
      if (node && node.kind === 'project') {
        const rollup = projectFilterRollup(node);
        // Expand when any session is working or waiting; dormant projects start collapsed.
        return !(rollup === 'waiting' || rollup === 'working' || rollup === 'running');
      }
      return !!node.collapsed;
    }

    function historyRoots() {
      const tree = state && state.historyTree;
      const list = (tree && tree.projects) || [];
      if (tree && tree.noSessions) return list.concat([tree.noSessions]);
      return list;
    }

    function rangeBounds(range) {
      if (!range) return { start: NaN, end: NaN };
      const start = typeof range.start === 'number' ? range.start : Date.parse(range.start);
      const end = typeof range.end === 'number' ? range.end : Date.parse(range.end);
      return { start: start, end: end };
    }

    function ganttHtml(markers, range, rowId) {
      const bounds = rangeBounds(range);
      const start = bounds.start;
      const end = bounds.end;
      const span = end - start;
      const trackW = measureTimelineTrackWidth();
      let html = '<div class="gantt-track">';
      if (span > 0) {
        const laid = layoutTimelineMarkers(markers, start, end, trackW, {
          expandedGroupIds: expandedTimelineGroups,
        });
        const lanes = maxTimelineLaneCount(laid);
        html = '<div class="gantt-track" style="--gantt-lanes:' + lanes + '">';
        laid.forEach(function (item) {
          if (!item) return;
          if (item.kind === 'group') {
            const gid = 'grp-' + String(rowId || 'row') + '-' + item.groupId;
            let failed = 0;
            let completed = 0;
            (item.markers || []).forEach(function (m) {
              if (m && m.state === 'failed') failed += 1;
              else completed += 1;
            });
            markerPayload.set(gid, {
              kind: 'group',
              groupId: item.groupId,
              count: item.count,
              markers: item.markers || [],
              state: failed && completed ? 'mixed' : failed ? 'failed' : 'completed',
            });
            const groupClass = failed && completed ? 'mixed' : failed ? 'failed' : 'completed';
            html +=
              '<button type="button" class="gantt-marker group ' +
              esc(groupClass) +
              '" style="left:' +
              item.leftPct.toFixed(2) +
              '%;--lane:0" data-marker-id="' +
              esc(gid) +
              '" data-group-id="' +
              esc(item.groupId) +
              '" aria-label="' +
              esc(item.count + ' turns — click to expand') +
              '">' +
              esc(String(item.count)) +
              '</button>';
            return;
          }
          const m = item.marker;
          if (!m) return;
          const mid =
            'm-' +
            String(rowId || 'row') +
            '-' +
            item.id +
            '-' +
            String(m.at);
          markerPayload.set(mid, {
            state: m.state,
            at: m.at,
            prompt: stripPromptPreamble(m.prompt || ''),
            reply: m.reply || '',
            sessionId: m.sessionId || null,
            groupId: item.groupId || null,
            usage: m.usage || null,
          });
          html +=
            '<button type="button" class="gantt-marker ' +
            esc(m.state) +
            '" style="left:' +
            item.leftPct.toFixed(2) +
            '%;--lane:' +
            (item.lane || 0) +
            '" data-marker-id="' +
            esc(mid) +
            '" aria-label="' +
            esc(stateLabel(m.state) + ' · ' + formatLocalDateTime(m.at)) +
            '"></button>';
        });
      }
      return html + '</div>';
    }

    function renderGanttAxis(range) {
      if (!ganttAxisEl) return;
      const bounds = rangeBounds(range);
      const start = bounds.start;
      const end = bounds.end;
      const span = end - start;
      if (!(span > 0)) {
        ganttAxisEl.innerHTML = '';
        return;
      }
      let html = '';
      for (let i = 0; i <= 4; i++) {
        const label = formatTimelineAxisLabel(start + (span * i) / 4, span);
        html += '<span style="left:' + (i * 25) + '%">' + esc(label) + '</span>';
      }
      if (ganttAxisEl.innerHTML !== html) ganttAxisEl.innerHTML = html;
    }

    function enrichHistoryNode(node) {
      if (!node || node.kind !== 'session' || !state) return node;
      const sess = (state.sessions || []).find(function (s) { return s.id === node.id; });
      if (!sess) return node;
      return Object.assign({}, node, {
        awaitingInput: !!sess.awaitingInput,
        activityState: sess.activityState || node.activityState,
        displayState: sess.displayState || node.displayState,
        status: sess.status || node.status,
        engine: sess.engine || node.engine,
        herdr: sess.herdr || node.herdr || null,
        title: sess.title || node.title,
      });
    }

    function nodeMatchesFilter(node) {
      if (!stateFilter) return true;
      if (node.kind === 'project') {
        return (node.children || []).some(function (c) {
          return nodeMatchesFilter(enrichHistoryNode(c));
        });
      }
      return rowFilterState(enrichHistoryNode(node)) === stateFilter;
    }

    function filterTree(nodes) {
      return (nodes || []).map(function (n) {
        if (n.kind === 'no-sessions-group') {
          const kids = filterTree(n.children || []);
          if (stateFilter && !kids.length) return null;
          return Object.assign({}, n, { children: kids });
        }
        if (n.kind === 'project') {
          const kids = filterTree(n.children || []);
          if (!showArchived && !(n.sessionCount > 0) && !(n.fromMemoryOnly)) {
            // Archived-only project: hide unless Show archived is on.
            if (!(n.archivedCount > 0)) return null;
            return null;
          }
          if (stateFilter) {
            const sessionless = n.fromMemoryOnly || !(n.sessionCount > 0);
            if (sessionless) {
              const fs = n.filterState || n.displayState || 'idle';
              if (fs !== stateFilter) return null;
              return Object.assign({}, n, { children: kids });
            }
            if (!kids.length) return null;
          } else if (!showArchived && !kids.length && !(n.fromMemoryOnly)) {
            return null;
          }
          return Object.assign({}, n, { children: kids });
        }
        const enriched = enrichHistoryNode(n);
        if (enriched.archived && !showArchived) return null;
        const kids = filterTree(enriched.children || []);
        // Keep ancestors when a matching child is nested underneath.
        if (stateFilter && !nodeMatchesFilter(enriched) && !kids.length) return null;
        return Object.assign({}, enriched, { children: kids });
      }).filter(Boolean);
    }

    function historyRowHtml(node, range) {
      const enriched = enrichHistoryNode(node);
      const isGroup = enriched.kind === 'no-sessions-group';
      const isProject = enriched.kind === 'project';
      const kids = enriched.children || [];
      const collapsed = isCollapsed(enriched);
      const depth = Math.max(0, enriched.depth || 0);
      const label = isGroup
        ? (enriched.label || 'No sessions')
        : isProject
          ? enriched.name
          : enriched.title || enriched.id;
      const filterKey = isGroup
        ? 'idle'
        : isProject
          ? projectFilterRollup(enriched)
          : rowFilterState(enriched);
      const bits = [];
      if (isGroup) {
        bits.push((kids.length || 0) + ' projects');
      } else if (isProject) {
        bits.push((enriched.sessionCount != null ? enriched.sessionCount : kids.length) + ' sessions');
        const wc = enriched.workingCount != null ? enriched.workingCount : enriched.runningCount;
        if (wc) bits.push(wc + ' Working');
      } else {
        bits.push(enriched.engine || '');
      }
      if (enriched.usage) {
        const uBit = formatUsageMetaBit(enriched.usage);
        if (uBit) bits.push(uBit);
      }
      const when = agoLabel(enriched.lastActivity);
      if (when) bits.push(when);
      // Markers stay on the session that produced them — never roll up onto
      // project / no-sessions group rows (including when those rows are collapsed).
      const markers = isGroup || isProject ? [] : enriched.markers || [];
      const waiting = !isProject && !isGroup && filterKey === 'waiting';
      const working = !isProject && !isGroup && filterKey === 'working';
      const stateClass = (isGroup ? 'muted' : filterKey) +
        (waiting ? ' waiting awaiting-input' : '') +
        (working ? ' working' : '');
      const ariaState = isGroup ? 'no sessions' : activityLabel(enriched);
      const archivedClass = !isProject && !isGroup && enriched.archived ? ' archived' : '';
      let html = '<div class="history-row ' +
        (isGroup ? 'group no-sessions' : isProject ? 'project' : 'session') +
        ' ' + stateClass + archivedClass +
        (selectedId === enriched.id ? ' selected' : '') +
        '" role="treeitem" tabindex="0" data-id="' + esc(enriched.id) +
        '" data-kind="' + esc(enriched.kind) +
        '" data-filter-state="' + esc(filterKey) +
        '" data-archived="' + (enriched.archived ? '1' : '0') +
        '" aria-level="' + (depth + 1) +
        '" aria-selected="' + String(selectedId === enriched.id) + '"' +
        ' aria-label="' + esc((isProject || isGroup ? label : enriched.id) + ' — ' + ariaState) + '"' +
        (kids.length ? ' aria-expanded="' + String(!collapsed) + '"' : '') +
        ' style="padding-left:' + (1 + depth * 1.25).toFixed(2) + 'rem">' +
        '<div class="history-label"><button type="button" class="twist" data-twist="' + esc(enriched.id) +
        '" tabindex="-1" aria-label="' + (collapsed ? 'Expand ' : 'Collapse ') + esc(label) + '"' +
        (kids.length ? '' : ' disabled') + '>' +
        (kids.length ? (collapsed ? '&#9656;' : '&#9662;') : '&middot;') + '</button>' +
        '<span class="row-markers" aria-hidden="true">' +
        '<span class="row-waiting-mark">?</span><span class="row-working-mark"></span></span>' +
        '<span class="title" title="' + esc(label) + '">' + esc(label) + '</span>' +
        (isGroup
          ? ''
          : '<span class="history-state ' + esc(filterKey) + '">' + esc(ariaState) + '</span>') +
        '<span class="meta-bits">' + esc(bits.filter(Boolean).join(' · ')) + '</span>' +
        rowActionsHtml(enriched, isProject) +
        '</div>' +
        ganttHtml(markers, range, enriched.id) +
        messageMarkersHtml(enriched) +
        '</div>';
      if (!collapsed) {
        kids.forEach(function (child) {
          html += historyRowHtml(child, range);
        });
      }
      return html;
    }

    function syncFilterChips() {
      if (!historyFilterEl || typeof historyFilterEl.querySelectorAll !== 'function') return;
      const chips = historyFilterEl.querySelectorAll('.filter-chip');
      for (let i = 0; i < chips.length; i++) {
        const on = (chips[i].getAttribute('data-state') || '') === stateFilter;
        toggleBtnClass(chips[i], 'active', on);
        chips[i].setAttribute('aria-pressed', String(on));
      }
    }

    function renderHistoryTree() {
      if (!state || !historyTreeEl) return;
      markerPayload.clear();
      const tree = state.historyTree;
      if (!sortTouched) {
        sortMode = (tree && tree.sort) || state.historySort || 'recent';
        if (sortSelect && sortSelect.value !== sortMode) sortSelect.value = sortMode;
      }
      syncFilterChips();
      syncTimelinePresetChips();
      updateHerdrRemoteNote();
      const hasSessionProjects = tree && (tree.projects || []).length > 0;
      const hasNoSessions = tree && tree.noSessions && (tree.noSessions.children || []).length > 0;
      if (!tree || (!hasSessionProjects && !hasNoSessions)) {
        renderGanttAxis(null);
        const empty = '<p class="empty">No projects or sessions yet.</p>';
        if (historyTreeEl.innerHTML !== empty) historyTreeEl.innerHTML = empty;
        return;
      }
      const viewRange = activeTimelineWindow();
      renderGanttAxis(viewRange);
      const nowMs = stateNowMs(state);
      const windowMs = dormantWindowMs(state);
      let projectNodes = sortProjectNodes(tree.projects || [], sortMode);
      if (hideDormant) {
        projectNodes = projectNodes.filter(function (p) {
          return !isDormantProject(p, nowMs, windowMs);
        });
      }
      const projects = filterTree(projectNodes);
      let html = projects.map(function (p) { return historyRowHtml(p, viewRange); }).join('');
      // Sessionless folders keep their own bottom group (still reachable for notes).
      if (tree.noSessions) {
        const groupFiltered = filterTree([tree.noSessions])[0];
        if (groupFiltered) html += historyRowHtml(groupFiltered, viewRange);
      }
      if (!html) {
        html = hideDormant && !stateFilter
          ? '<p class="empty">No active projects — turn off Hide dormant to see older ones.</p>'
          : '<p class="empty">No sessions match this state filter.</p>';
      }
      updateDormantHiddenCount();
      if (historyTreeEl.innerHTML === html) return;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      const keepFocus = active && typeof historyTreeEl.contains === 'function' && historyTreeEl.contains(active)
        ? active.getAttribute('data-id')
        : null;
      historyTreeEl.innerHTML = html;
      if (keepFocus && typeof historyTreeEl.querySelectorAll === 'function') {
        const rows = historyTreeEl.querySelectorAll('.history-row');
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute('data-id') === keepFocus && typeof rows[i].focus === 'function') {
            rows[i].focus();
            break;
          }
        }
      }
    }

    function markSelectedRows() {
      if (!historyTreeEl || typeof historyTreeEl.querySelectorAll !== 'function') return;
      const rows = historyTreeEl.querySelectorAll('.history-row');
      for (let i = 0; i < rows.length; i++) {
        const on = rows[i].getAttribute('data-id') === selectedId;
        toggleBtnClass(rows[i], 'selected', on);
        rows[i].setAttribute('aria-selected', String(on));
      }
    }

    function toggleCollapse(id) {
      let found = null;
      (function walk(list) {
        (list || []).forEach(function (n) {
          if (n.id === id) found = n;
          walk(n.children);
        });
      })(historyRoots());
      if (!found) return;
      collapseOverride.set(id, !isCollapsed(found));
      renderHistoryTree();
    }

    function selectRow(id) {
      selectedId = id;
      renderDetail();
    }

    function cancelHistoryTooltipHide() {
      if (historyTooltipHideTimer !== null) clearTimeout(historyTooltipHideTimer);
      historyTooltipHideTimer = null;
    }

    function dismissHistoryTooltip() {
      cancelHistoryTooltipHide();
      historyHoverId = null;
      historyFocusId = null;
      historyTooltipId = null;
      historyTooltipHovered = false;
      renderHistoryTooltip();
    }

    function scheduleHistoryTooltipHide() {
      cancelHistoryTooltipHide();
      if (historyHoverId || historyFocusId || historyTooltipHovered) return;
      historyTooltipHideTimer = setTimeout(function () {
        historyTooltipHideTimer = null;
        if (!historyHoverId && !historyFocusId && !historyTooltipHovered) dismissHistoryTooltip();
      }, 450);
    }

    function positionMarkerTooltip(anchor) {
      if (!historyTooltip || !historyViewEl || !anchor || historyTooltipHovered) return;
      const viewRect = historyViewEl.getBoundingClientRect
        ? historyViewEl.getBoundingClientRect()
        : { width: 800, height: 600, left: 0, top: 0 };
      const aRect = anchor.getBoundingClientRect
        ? anchor.getBoundingClientRect()
        : { left: 12, top: 12, width: 8, height: 8, right: 20, bottom: 20 };
      const tipRect = historyTooltip.getBoundingClientRect
        ? historyTooltip.getBoundingClientRect()
        : { width: 320, height: 160 };
      let left = aRect.left - viewRect.left + 12;
      let top = aRect.bottom - viewRect.top + 6;
      if (left + tipRect.width > viewRect.width - 12) {
        left = Math.max(12, viewRect.width - tipRect.width - 12);
      }
      if (top + tipRect.height > viewRect.height - 12) {
        top = Math.max(12, aRect.top - viewRect.top - tipRect.height - 6);
      }
      historyTooltip.style.left = left + 'px';
      historyTooltip.style.top = top + 'px';
    }

    function renderMarkerTooltipHtml(payload) {
      if (!payload) return '';
      if (payload.kind === 'group') {
        const lines = (payload.markers || []).slice(0, 8).map(function (m, i) {
          return (
            '<p class="group-turn"><strong>' +
            esc(stateLabel(m.state)) +
            '</strong> · ' +
            esc(formatLocalDateTime(m.at)) +
            '<br/><span class="prompt">' +
            esc((m.prompt || '(no prompt)').slice(0, 120)) +
            '</span></p>'
          );
        }).join('');
        return (
          '<p><strong>' +
          esc(String(payload.count || 0)) +
          ' turns</strong> · click badge to expand</p>' +
          lines +
          ((payload.markers || []).length > 8
            ? '<p class="completion-meta">+' + ((payload.markers || []).length - 8) + ' more</p>'
            : '')
        );
      }
      const usageLine = payload.usage ? formatUsageTooltipLine(payload.usage) : '';
      return (
        '<p><strong>' +
        esc(stateLabel(payload.state)) +
        '</strong> · ' +
        esc(formatLocalDateTime(payload.at)) +
        '</p>' +
        (usageLine ? '<p class="usage-line">' + esc(usageLine) + '</p>' : '') +
        '<div class="label">Prompt</div><p>' +
        esc(payload.prompt || '(no prompt)') +
        '</p>' +
        '<div class="label">Reply</div><p>' +
        esc(payload.reply || '(no reply)') +
        '</p>'
      );
    }

    function showMarkerTooltip(markerId, anchor) {
      if (!historyTooltip) return;
      const payload = markerPayload.get(markerId);
      if (!payload) {
        dismissHistoryTooltip();
        return;
      }
      cancelHistoryTooltipHide();
      historyTooltipId = markerId;
      historyHoverId = markerId;
      historyTooltip.hidden = false;
      const html = renderMarkerTooltipHtml(payload);
      if (historyTooltip.innerHTML !== html) historyTooltip.innerHTML = html;
      if (anchor) positionMarkerTooltip(anchor);
    }

    function renderHistoryTooltip() {
      // History row hover popups are disabled; only timeline marker popups use this element.
      if (!historyTooltipId || !markerPayload.has(historyTooltipId)) {
        if (historyTooltip) historyTooltip.hidden = true;
      }
    }

    if (historyTreeEl) {
      historyTreeEl.addEventListener('click', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const actionBtn = closest('[data-action]');
        if (actionBtn && actionBtn.getAttribute && actionBtn.getAttribute('data-action')) {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          handleDashboardAction(actionBtn);
          return;
        }
        const markerBtn = closest('.gantt-marker');
        if (markerBtn) {
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          const groupId = markerBtn.getAttribute('data-group-id');
          const classAttr = markerBtn.getAttribute && markerBtn.getAttribute('class') || '';
          if (groupId && /\bgroup\b/.test(String(classAttr))) {
            if (expandedTimelineGroups.has(groupId)) expandedTimelineGroups.delete(groupId);
            else expandedTimelineGroups.add(groupId);
            dismissHistoryTooltip();
            renderHistoryTree();
            return;
          }
          const mid = markerBtn.getAttribute('data-marker-id');
          if (mid) showMarkerTooltip(mid, markerBtn);
          return;
        }
        if (closest('.gantt-track') && expandedTimelineGroups.size) {
          expandedTimelineGroups.clear();
          dismissHistoryTooltip();
          renderHistoryTree();
          return;
        }
        const twist = closest('button[data-twist]');
        if (twist) {
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          if (!twist.disabled) toggleCollapse(twist.getAttribute('data-twist'));
          return;
        }
        const row = closest('.history-row');
        if (row) {
          if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
          const kind = row.getAttribute('data-kind');
          if (kind === 'no-sessions-group') {
            toggleCollapse(row.getAttribute('data-id'));
            return;
          }
          // Project rows (including sessionless memory folders) stay clickable for notes/docs.
          selectRow(row.getAttribute('data-id'));
        }
      });
      historyTreeEl.addEventListener('dblclick', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const row = closest('.history-row');
        if (!row || row.getAttribute('data-kind') !== 'session') return;
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        openInHerdr(row.getAttribute('data-id'));
      });
      historyTreeEl.addEventListener('mouseover', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const marker = closest('.gantt-marker');
        if (!marker) return;
        const mid = marker.getAttribute('data-marker-id');
        if (!mid) return;
        showMarkerTooltip(mid, marker);
      });
      historyTreeEl.addEventListener('mouseout', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const marker = closest('.gantt-marker');
        if (!marker) return;
        const related = ev.relatedTarget;
        if (related && typeof marker.contains === 'function' && marker.contains(related)) return;
        if (related && historyTooltip && typeof historyTooltip.contains === 'function' && historyTooltip.contains(related)) {
          return;
        }
        if (historyHoverId === marker.getAttribute('data-marker-id')) historyHoverId = null;
        scheduleHistoryTooltipHide();
      });
      historyTreeEl.addEventListener('focusin', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const marker = closest('.gantt-marker');
        if (!marker) return;
        const mid = marker.getAttribute('data-marker-id');
        if (mid) showMarkerTooltip(mid, marker);
      });
      historyTreeEl.addEventListener('focusout', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const marker = closest('.gantt-marker');
        if (!marker) return;
        if (historyHoverId === marker.getAttribute('data-marker-id')) historyHoverId = null;
        scheduleHistoryTooltipHide();
      });
      historyTreeEl.addEventListener('keydown', function (ev) {
        const row = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('.history-row')
          : null;
        if (!row || ev.target !== row) return;
        const id = row.getAttribute('data-id');
        const expanded = row.getAttribute('aria-expanded');
        if (ev.key === 'Escape') {
          dismissHistoryTooltip();
        } else if (ev.key === 'Enter' || ev.key === ' ') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          selectRow(id);
        } else if (ev.key === 'ArrowRight' && expanded === 'false') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          toggleCollapse(id);
        } else if (ev.key === 'ArrowLeft' && expanded === 'true') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          toggleCollapse(id);
        } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
          if (typeof ev.preventDefault === 'function') ev.preventDefault();
          if (typeof historyTreeEl.querySelectorAll !== 'function') return;
          const rows = Array.prototype.slice.call(historyTreeEl.querySelectorAll('.history-row'));
          const next = rows[rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)];
          if (next && typeof next.focus === 'function') next.focus();
        }
      });
    }

    if (historyTooltip) {
      historyTooltip.addEventListener('mouseenter', function () {
        cancelHistoryTooltipHide();
        historyHoverId = null;
        historyFocusId = null;
        historyTooltipHovered = true;
      });
      historyTooltip.addEventListener('mouseleave', function () {
        historyTooltipHovered = false;
        scheduleHistoryTooltipHide();
      });
      historyTooltip.addEventListener('click', function (ev) {
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
      });
    }

    if (historyFilterEl) {
      historyFilterEl.addEventListener('click', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (!closest) return;
        const chip = closest('.filter-chip');
        if (!chip) return;
        stateFilter = chip.getAttribute('data-state') || '';
        renderHistoryTree();
      });
    }

    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        sortTouched = true;
        sortMode = sortSelect.value || 'recent';
        renderHistoryTree();
      });
    }

    /* ---------- history panel (left off + prompt history) ---------- */

    function safeMarkdown(text) {
      try {
        return renderMarkdown(text, { documentLinks: false });
      } catch (_) {
        return '<pre class="markdown-source">' + esc(text) + '</pre>';
      }
    }

    function previewLines(text, n) {
      return String(text == null ? '' : text).split('\n').slice(0, n).join('\n');
    }

    function snapshotLeftOff(item, isProject) {
      const project = isProject ? item : (state.projects || []).find(function (p) {
        return p.name === item.project;
      });
      const note = project && project.memory && (project.memory.documents || []).find(function (d) {
        return d.kind === 'status';
      });
      const cps = (state.checkpoints && state.checkpoints.projects) || [];
      const cp = cps.find(function (c) {
        return c && project && (c.project === project.name || c.name === project.name);
      });
      const open = cp && ((cp.state === 'requested' && !cp.completedAt) || cp.missing || cp.overdue);
      return {
        completion: item.completion || null,
        statusNote: note
          ? { path: note.path, title: note.title, date: note.date || null, preview: previewLines(note.content, 8) }
          : null,
        checkpoint: open ? cp : null,
      };
    }

    function renderLeftOff(leftOff) {
      if (!leftOff || (!leftOff.completion && !leftOff.statusNote && !leftOff.checkpoint)) {
        return '<p class="empty">Nothing recorded yet for this selection.</p>';
      }
      let html = renderTaskCompletion(leftOff.completion);
      const note = leftOff.statusNote;
      if (note) {
        html += '<section class="status-note-preview"><div class="label">Latest status note</div>' +
          '<p class="completion-meta">' + esc(note.title || note.path || '') +
          (note.date ? ' · ' + esc(note.date) : '') + '</p><div class="completion-body">' +
          safeMarkdown(note.preview || '') + '</div></section>';
      }
      const cp = leftOff.checkpoint;
      if (cp) {
        const flags = [];
        if (cp.state) flags.push(cp.state);
        if (cp.missing) flags.push('missing');
        if (cp.overdue) flags.push('overdue');
        html += '<section class="checkpoint-preview"><div class="label">Doc checkpoint</div>' +
          '<p class="completion-meta">' + esc(flags.join(' · ') || 'open') +
          (cp.requestedAt ? ' · requested ' + esc(cp.requestedAt) : '') + '</p>' +
          (cp.reason ? '<p>' + esc(cp.reason) + '</p>' : '') + '</section>';
      }
      return html;
    }

    function historyItemKey(ev, idx) {
      return [ev.type, ev.at, ev.sessionId || '', ev.path || '', idx].join('|');
    }

    function formatUsageMetaBit(summary) {
      if (!summary) return '';
      const total = summary.totalTokens != null
        ? summary.totalTokens
        : (summary.totalInput != null || summary.outputTokens != null)
          ? (summary.totalInput || 0) + (summary.outputTokens || 0)
          : null;
      if (total == null) return '';
      const approx = summary.accuracy === 'estimated' || summary.accuracy === 'partial' ? '~' : '';
      function fmtTok(n) {
        if (n == null || !isFinite(Number(n))) return '';
        const v = Number(n);
        if (Math.abs(v) < 1000) return String(Math.round(v));
        if (Math.abs(v) < 1000000) {
          const k = v / 1000;
          const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
          return String(rounded).replace(/\.0$/, '') + 'k';
        }
        return String(Math.round((v / 1000000) * 10) / 10).replace(/\.0$/, '') + 'm';
      }
      let bit = approx + fmtTok(total) + ' tok';
      if (summary.promptToResponse != null && Number(summary.promptToResponse) > 0) {
        const ratio = Number(summary.promptToResponse);
        bit += ' · ' + (ratio >= 10 ? String(Math.round(ratio)) : String(ratio)) + ':1';
      }
      return bit;
    }

    function formatUsageTooltipLine(u) {
      // Note: incomplete/estimated gaps stay visible (never invent reported USD).
      if (!u) return '';
      const inn = u.totalInput != null ? u.totalInput : u.inputTokens;
      const out = u.outputTokens;
      if (inn == null && out == null) return '';
      function loc(n) {
        if (n == null) return '?';
        try { return Number(n).toLocaleString('en-US'); } catch (_) { return String(n); }
      }
      let line = loc(inn) + ' in → ' + loc(out) + ' out';
      if (u.promptToResponse != null) {
        const ratio = Number(u.promptToResponse);
        line += ' (' + (ratio >= 10 ? String(Math.round(ratio)) : String(ratio)) + ':1)';
      }
      if (u.accuracy) line += ' · ' + u.accuracy;
      if (u.accuracy === 'estimated' && !(u.outputTokens > 0)) {
        line += ' · incomplete';
      }
      const costBit = formatUsageCost(u);
      line += ' · ' + (costBit || 'cost unknown');
      return line;
    }

    function renderUsageSummaryBlock(summary) {
      if (!summary || (summary.totalTokens == null && summary.totalInput == null && !summary.turnCount)) {
        return '';
      }
      const bits = [];
      if (summary.totalTokens != null) bits.push(Number(summary.totalTokens).toLocaleString('en-US') + ' tok');
      if (summary.inputTokens != null || summary.cacheRead != null) {
        const uncached = summary.inputTokens != null ? Number(summary.inputTokens).toLocaleString('en-US') : '?';
        const cached = (summary.cacheRead || 0) + (summary.cacheWrite || 0);
        bits.push(uncached + ' uncached' + (cached ? ' + ' + Number(cached).toLocaleString('en-US') + ' cached' : ''));
      }
      if (summary.outputTokens != null) {
        let out = Number(summary.outputTokens).toLocaleString('en-US') + ' out';
        if (summary.reasoningTokens) out += ' (+' + Number(summary.reasoningTokens).toLocaleString('en-US') + ' reasoning)';
        bits.push(out);
      }
      if (summary.promptToResponse != null) {
        const ratio = Number(summary.promptToResponse);
        bits.push((ratio >= 10 ? String(Math.round(ratio)) : String(ratio)) + ':1');
      }
      const costBit = formatUsageCost(summary);
      bits.push(costBit || 'cost unknown');
      if ((Number(summary.estimatedTurns) || 0) > 0) {
        bits.push(Number(summary.estimatedTurns) + ' estimated turn' +
          (Number(summary.estimatedTurns) === 1 ? '' : 's'));
      }
      if (summary.premiumRequests != null) bits.push(summary.premiumRequests + ' premium');
      return (
        '<div class="usage-summary">' +
        '<span class="usage-badge ' + esc(summary.accuracy || 'reported') + '">' +
        esc(summary.accuracy || 'reported') + '</span> ' +
        esc(bits.join(' · ')) +
        '</div>'
      );
    }

    function renderUsageBarChart(items) {
      const turns = (items || []).filter(function (ev) {
        return ev && ev.usage && (ev.usage.totalInput != null || ev.usage.outputTokens != null);
      }).slice(0, 24);
      if (!turns.length) return '';
      let maxIn = 1;
      let maxOut = 1;
      turns.forEach(function (ev) {
        const inn = Number(ev.usage.totalInput || ev.usage.inputTokens || 0);
        const out = Number(ev.usage.outputTokens || 0);
        if (inn > maxIn) maxIn = inn;
        if (out > maxOut) maxOut = out;
      });
      const w = 240;
      const h = 48;
      const gap = 2;
      const barW = Math.max(2, Math.floor((w - gap * turns.length) / turns.length));
      let rects = '';
      turns.slice().reverse().forEach(function (ev, i) {
        const inn = Number(ev.usage.totalInput || ev.usage.inputTokens || 0);
        const out = Number(ev.usage.outputTokens || 0);
        const inH = Math.max(1, Math.round((inn / maxIn) * (h / 2 - 2)));
        const outH = Math.max(1, Math.round((out / maxOut) * (h / 2 - 2)));
        const x = i * (barW + gap);
        const est = ev.usage.accuracy === 'estimated' || ev.usage.accuracy === 'partial';
        const cls = est ? 'usage-bar estimated' : 'usage-bar';
        rects +=
          '<rect class="' + cls + ' in" x="' + x + '" y="' + (h / 2 - inH) +
          '" width="' + barW + '" height="' + inH + '" />' +
          '<rect class="' + cls + ' out" x="' + x + '" y="' + (h / 2 + 1) +
          '" width="' + barW + '" height="' + outH + '" />';
      });
      return (
        '<div class="usage-chart" title="Input (top) vs output (bottom) tokens per turn">' +
        '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h +
        '" role="img" aria-label="Token usage per turn">' + rects + '</svg></div>'
      );
    }

    function renderHistoryItems(items) {
      if (!items || !items.length) return '<p class="empty">No prompt history recorded.</p>';
      return items.map(function (ev, idx) {
        const key = historyItemKey(ev, idx);
        const more = !!ev.replyTruncated || (ev.reply != null && ev.replyPreview != null &&
          String(ev.reply) !== String(ev.replyPreview));
        const expanded = expandedReplies.has(key);
        const body = expanded ? ev.reply : (ev.replyPreview != null ? ev.replyPreview : ev.reply);
        const when = formatLocalDateTime(ev.at);
        const isMsg = ev.type === 'message';
        const statusState = isMsg
          ? (ev.status === 'completed' ? 'completed' : ev.status === 'read' ? 'idle' : 'waiting')
          : '';
        let html = '<article class="history-feed-item' + (isMsg ? ' history-message' : '') +
          '" data-key="' + esc(key) + '">' +
          '<div class="when">' + esc(when) + (ev.sessionTitle ? ' · ' + esc(ev.sessionTitle) : '') +
          '<span class="kind-tag">' + esc(ev.kind || ev.type || '') + '</span>' +
          (isMsg && ev.status
            ? '<span class="msg-status ' + esc(statusState) + '">' + esc(ev.status) + '</span>'
            : '') +
          '</div>';
        if (ev.title) html += '<div class="label">' + esc(ev.title) + '</div>';
        if (ev.usage) {
          const uLine = formatUsageTooltipLine(ev.usage);
          if (uLine) html += '<p class="usage-line">' + esc(uLine) + '</p>';
        }
        if (isMsg) {
          html += '<div class="prompt">' + esc((ev.direction === 'out' ? '→ ' : '← ') +
            (ev.from || '') + ' → ' + (ev.to || '')) + '</div>';
        } else if (ev.prompt) {
          html += '<div class="prompt">' + esc(ev.prompt) + '</div>';
        }
        if (body) {
          html += '<div class="reply' + (more && !expanded ? ' collapsed' : '') + '">' +
            safeMarkdown(body) + '</div>';
          if (more) {
            html += '<button type="button" class="expand-reply" data-key="' + esc(key) +
              '" aria-expanded="' + String(expanded) + '">' + (expanded ? 'Collapse' : 'Expand') + '</button>';
          }
          if (expanded && ev.replyTruncated) {
            html += '<p class="completion-meta">Reply truncated in the stored log.</p>';
          }
        }
        return html + '</article>';
      }).join('');
    }

    function messageMarkersHtml(enriched) {
      const marks = enriched && enriched.messageMarkers;
      if (!marks || !marks.length) return '<div class="message-markers" hidden></div>';
      const queued = typeof enriched.messageQueued === 'number'
        ? enriched.messageQueued
        : marks.filter(function (m) { return m && m.status === 'queued' && m.direction === 'in'; }).length;
      const latest = marks[0];
      const state = latest && latest.state ? latest.state : 'waiting';
      let html = '<div class="message-markers" title="' +
        esc((queued ? queued + ' queued · ' : '') + (latest && latest.text ? latest.text : 'messages')) +
        '">';
      if (queued > 0) {
        html += '<span class="msg-dot waiting" aria-label="' + queued + ' queued messages">' +
          (queued > 9 ? '9+' : String(queued)) + '</span>';
      } else if (latest) {
        html += '<span class="msg-dot ' + esc(state) + '" aria-hidden="true"></span>';
      }
      html += '</div>';
      return html;
    }

    function renderHistoryPanel() {
      const loaded = historyLoaded;
      if (!loaded) return;
      const data = loaded.data;
      const leftHtml = data ? renderLeftOff(data.leftOff) : '<p class="empty">Loading…</p>';
      if (leftoffEl && leftoffEl.innerHTML !== leftHtml) leftoffEl.innerHTML = leftHtml;
      let feedHtml = '';
      if (loaded.offline) {
        feedHtml += '<p class="empty">Full prompt history requires the live dashboard server ' +
          '(aflt dashboard --serve). This snapshot only includes the latest completion and status note.</p>';
      } else if (loaded.error) {
        feedHtml += '<p class="memory-error">' + esc(loaded.error) + '</p>';
      } else if (loaded.loading && !data) {
        feedHtml += '<p class="empty">Loading history…</p>';
      }
      if (data && !loaded.offline) {
        if (data.usageSummary) feedHtml += renderUsageSummaryBlock(data.usageSummary);
        if (data.history) feedHtml += renderUsageBarChart(data.history);
        feedHtml += renderHistoryItems(data.history);
      }
      if (historyFeed && historyFeed.innerHTML !== feedHtml) historyFeed.innerHTML = feedHtml;
    }

    function syncHistoryPanel() {
      const item = findSelection();
      if (!item) {
        historyReq++;
        historyLoaded = null;
        setShown(leftoffPanel, false);
        setShown(historyPanel, false);
        return;
      }
      setShown(leftoffPanel, true);
      setShown(historyPanel, true);
      const isProject = item.sessionCount != null && !!item.name;
      const sig = [item.id, item.lastUsed || item.lastActivity || '',
        item.completion && item.completion.at || ''].join('|');
      if (historyLoaded && historyLoaded.key === item.id && historyLoaded.sig === sig) return;
      const prev = historyLoaded && historyLoaded.key === item.id ? historyLoaded.data : null;
      if (snapshotData) {
        historyLoaded = {
          key: item.id, sig: sig, offline: true,
          data: { leftOff: snapshotLeftOff(item, isProject), history: [], messages: null },
        };
        renderHistoryPanel();
        return;
      }
      const token = ++historyReq;
      historyLoaded = { key: item.id, sig: sig, loading: true, data: prev };
      renderHistoryPanel();
      let url = '/api/history?' + (isProject
        ? 'project=' + encodeURIComponent(item.name)
        : 'session=' + encodeURIComponent(item.id));
      if (showArchived || item.archived) url += '&includeArchived=1';
      fetch(url)
        .then(function (r) {
          return r.json().then(function (body) {
            if (!r.ok) throw new Error((body && body.error) || 'Unable to load history.');
            return body;
          });
        })
        .then(function (data) {
          if (token !== historyReq) return;
          historyLoaded = { key: item.id, sig: sig, data: data };
          renderHistoryPanel();
        })
        .catch(function (err) {
          if (token !== historyReq) return;
          historyLoaded = { key: item.id, sig: sig, data: prev, error: String(err.message || err) };
          renderHistoryPanel();
        });
    }

    if (historyFeed) {
      historyFeed.addEventListener('click', function (ev) {
        const button = ev.target && typeof ev.target.closest === 'function'
          ? ev.target.closest('button.expand-reply')
          : null;
        if (!button) return;
        const key = button.getAttribute('data-key');
        if (expandedReplies.has(key)) expandedReplies.delete(key);
        else expandedReplies.add(key);
        renderHistoryPanel();
      });
    }

    /* ---------- view switching + graph loop ---------- */

    function loop() {
      if (currentView !== 'graph') {
        raf = 0;
        return;
      }
      if (sim && !reduced) stepSim(sim);
      drawGraph();
      raf = requestAnimationFrame(loop);
    }

    function startLoop() {
      if (currentView !== 'graph') return;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    }

    function updateSim(opts) {
      opts = opts || {};
      if (!state) return;
      const built = buildSim(state);
      if (!sim || opts.forceRebuild || simStale) {
        sim = Object.assign({}, built, { alpha: 1, nodeSetChanged: true });
        if (!graphViewInitialized || opts.fit) graphNeedsFit = true;
      } else {
        sim = mergeSimPreserve(sim, built, { preserveAlpha: true, reheatAlpha: 0.85 });
        if (sim.nodeSetChanged && !graphViewInitialized) graphNeedsFit = true;
      }
      simStale = false;
      renderGraphTooltip();
    }

    function toggleBtnClass(btn, name, on) {
      if (!btn) return;
      if (btn.classList && typeof btn.classList.toggle === 'function') {
        btn.classList.toggle(name, on);
        return;
      }
      const cur = String(btn.className || '').split(/\s+/).filter(Boolean);
      const has = cur.indexOf(name) !== -1;
      if (on && !has) cur.push(name);
      if (!on && has) cur.splice(cur.indexOf(name), 1);
      btn.className = cur.join(' ');
    }

    let selectedLoopName = null;
    let loopDetailCache = null;
    let loopDetailSynced = null;
    let loopDetailSyncing = false;
    let loopDetailHtml = '';
    let loopDefinitionsCache = [];
    let loopFormPhases = [emptyLoopPhaseForm(0)];
    /** Definition the form was opened from; fields the form has no input for are kept on save. */
    let loopFormOrig = null;
    let loopsLoading = false;

    function setView(name) {
      currentView = name === 'graph' ? 'graph' : name === 'loops' ? 'loops' : 'history';
      const graph = currentView === 'graph';
      const loops = currentView === 'loops';
      setShown(historyViewEl, !graph && !loops);
      setShown(graphViewEl, graph);
      setShown(loopsViewEl, loops);
      toggleBtnClass(viewHistoryBtn, 'active', currentView === 'history');
      toggleBtnClass(viewGraphBtn, 'active', graph);
      toggleBtnClass(viewLoopsBtn, 'active', loops);
      if (viewHistoryBtn) viewHistoryBtn.setAttribute('aria-pressed', String(currentView === 'history'));
      if (viewGraphBtn) viewGraphBtn.setAttribute('aria-pressed', String(graph));
      if (viewLoopsBtn) viewLoopsBtn.setAttribute('aria-pressed', String(loops));
      if (stage) {
        stage.setAttribute(
          'aria-label',
          graph ? 'activity graph' : loops ? 'loops' : 'session history'
        );
      }
      updateHerdrRemoteNote();
      if (graph) {
        updateSim({ forceRebuild: true, fit: !graphViewInitialized });
        startLoop();
      } else {
        stopLoop();
        dismissGraphTooltip();
        if (loops) renderLoopsView();
        else renderHistoryTree();
      }
    }

    function setLoopsFormStatus(msg, isError) {
      if (!loopsFormStatus) return;
      if (!msg) {
        setShown(loopsFormStatus, false);
        loopsFormStatus.textContent = '';
        return;
      }
      loopsFormStatus.textContent = msg;
      loopsFormStatus.className = 'loops-form-status' + (isError ? ' error' : '');
      setShown(loopsFormStatus, true);
    }

    function renderLoopPhaseEditors() {
      if (!loopsPhasesEl) return;
      let html = '';
      for (let i = 0; i < loopFormPhases.length; i++) {
        const p = loopFormPhases[i] || emptyLoopPhaseForm(i);
        html += '<div class="loops-phase-editor" data-phase-index="' + i + '">';
        html += '<div class="loops-phase-editor-grid">';
        html +=
          '<label>id <input data-field="id" value="' +
          escapeHtml(p.id) +
          '" required/></label>';
        html +=
          '<label>engine <select data-field="engine">' +
          ['cursor', 'copilot', 'opencode']
            .map(function (e) {
              return (
                '<option value="' +
                e +
                '"' +
                (p.engine === e ? ' selected' : '') +
                '>' +
                e +
                '</option>'
              );
            })
            .join('') +
          '</select></label>';
        html +=
          '<label>session <input data-field="session" value="' +
          escapeHtml(p.session || '') +
          '" placeholder="auto"/></label>';
        html +=
          '<label>maxFixAttempts <input data-field="maxFixAttempts" type="number" min="0" value="' +
          escapeHtml(p.maxFixAttempts != null ? p.maxFixAttempts : 3) +
          '"/></label>';
        html +=
          '<label>onPass <select data-field="onPass">' +
          ['none', 'commit', 'merge', 'push']
            .map(function (o) {
              return (
                '<option value="' +
                o +
                '"' +
                ((p.onPass || 'none') === o ? ' selected' : '') +
                '>' +
                o +
                '</option>'
              );
            })
            .join('') +
          '</select></label>';
        html +=
          '<label>gate <select data-field="gate">' +
          '<option value=""' +
          (!p.gate ? ' selected' : '') +
          '>none</option>' +
          '<option value="approve"' +
          (p.gate === 'approve' ? ' selected' : '') +
          '>approve</option>' +
          '</select></label>';
        html +=
          '<label>mode <select data-field="mode">' +
          '<option value=""' +
          (!p.mode ? ' selected' : '') +
          '>(default)</option>' +
          '<option value="ask"' +
          (p.mode === 'ask' ? ' selected' : '') +
          '>ask</option>' +
          '<option value="plan"' +
          (p.mode === 'plan' ? ' selected' : '') +
          '>plan</option>' +
          '</select></label>';
        html +=
          '<label>force <input data-field="force" type="checkbox"' +
          (p.force === true ? ' checked' : '') +
          '/></label>';
        html +=
          '<label>model <input data-field="model" value="' +
          escapeHtml(p.model || '') +
          '" placeholder="loop default"/></label>';
        const kindBits = [];
        if (p.type && p.type !== 'run') kindBits.push('type: ' + p.type);
        if (p.promptFile) kindBits.push('promptFile: ' + p.promptFile);
        if (p.improveModel) kindBits.push('improveModel: ' + p.improveModel);
        if (kindBits.length) {
          html += '<p class="loops-row-meta loops-phase-kind">' + escapeHtml(kindBits.join(' · ')) + '</p>';
        }
        html +=
          '<label>eval command <input data-field="evalCommand" value="' +
          escapeHtml(p.evalCommand || 'true') +
          '"/></label>';
        html +=
          '<label>prompt <textarea data-field="prompt">' +
          escapeHtml(p.prompt || '') +
          '</textarea></label>';
        html += '</div>';
        html +=
          '<button type="button" class="loops-btn subtle" data-remove-phase="' +
          i +
          '">Remove phase</button>';
        html += '</div>';
      }
      loopsPhasesEl.innerHTML = html;
    }

    function readLoopFormPhasesFromDom() {
      if (!loopsPhasesEl) return loopFormPhases;
      const editors = loopsPhasesEl.querySelectorAll('.loops-phase-editor');
      const next = [];
      for (let i = 0; i < editors.length; i++) {
        const ed = editors[i];
        const get = function (field) {
          const el = ed.querySelector('[data-field="' + field + '"]');
          return el ? el.value : '';
        };
        const idxAttr = Number(ed.getAttribute('data-phase-index'));
        const prev = Number.isFinite(idxAttr) ? loopFormPhases[idxAttr] : null;
        next.push({
          _orig: prev && prev._orig ? prev._orig : null,
          type: prev && prev.type ? prev.type : '',
          promptFile: prev && prev.promptFile ? prev.promptFile : '',
          improveModel: prev && prev.improveModel ? prev.improveModel : '',
          model: get('model') || '',
          id: get('id'),
          engine: get('engine') || 'cursor',
          session: get('session'),
          prompt: get('prompt'),
          evalCommand: get('evalCommand') || 'true',
          maxFixAttempts: Number(get('maxFixAttempts') || 3),
          onPass: get('onPass') || 'none',
          gate: get('gate') || '',
          mode: get('mode') || '',
          force: Boolean(ed.querySelector('[data-field="force"]') && ed.querySelector('[data-field="force"]').checked),
        });
      }
      loopFormPhases = next.length ? next : [emptyLoopPhaseForm(0)];
      return loopFormPhases;
    }

    function showLoopForm(prefill) {
      if (!loopsFormWrap || !loopsForm) return;
      setShown(loopsFormWrap, true);
      setLoopsFormStatus('', false);
      const def = prefill || {};
      loopFormOrig = def;
      loopsForm.name.value = def.name || '';
      loopsForm.project.value = def.project || '';
      loopsForm.engine.value = def.engine || 'cursor';
      loopsForm.cwd.value = def.cwd || '.';
      loopsForm.maxRuns.value =
        def.budget && def.budget.maxRuns != null ? def.budget.maxRuns : '';
      loopsForm.maxHours.value =
        def.budget && def.budget.maxHours != null ? def.budget.maxHours : '';
      if (Array.isArray(def.phases) && def.phases.length) {
        loopFormPhases = def.phases.map(function (p, i) {
          const base = emptyLoopPhaseForm(i);
          return {
            id: p.id || base.id,
            engine: p.engine || base.engine,
            session: p.session || '',
            prompt: p.prompt || '',
            evalCommand: p.eval && p.eval.command != null
              ? Array.isArray(p.eval.command)
                ? p.eval.command.join(' ')
                : String(p.eval.command)
              : base.evalCommand,
            maxFixAttempts: p.maxFixAttempts != null ? p.maxFixAttempts : 3,
            onPass: p.onPass || 'none',
            gate: p.gate || '',
            mode: p.mode || '',
            force: p.force === true,
            model: p.model || '',
            type: p.type || '',
            promptFile: p.promptFile || '',
            improveModel: p.improveModel || '',
            _orig: p,
          };
        });
      } else {
        loopFormPhases = [emptyLoopPhaseForm(0)];
      }
      renderLoopPhaseEditors();
    }

    function hideLoopForm() {
      if (loopsFormWrap) setShown(loopsFormWrap, false);
      setLoopsFormStatus('', false);
    }

    function buildDefinitionFromForm() {
      readLoopFormPhasesFromDom();
      const phases = loopFormPhases.map(function (p) {
        const phase = {
          id: String(p.id || '').trim(),
          engine: p.engine || 'cursor',
          prompt: String(p.prompt || ''),
          eval: { command: String(p.evalCommand || 'true'), exitCode: 0 },
          maxFixAttempts: Number.isFinite(Number(p.maxFixAttempts))
            ? Math.floor(Number(p.maxFixAttempts))
            : 3,
          onPass: p.onPass || 'none',
          force: p.force === true,
        };
        if (p.session) phase.session = String(p.session).trim();
        if (p.gate) phase.gate = p.gate;
        if (p.mode) phase.mode = p.mode;
        if (p.model) phase.model = String(p.model).trim();
        return mergeEditedLoopPhase(p._orig, phase);
      });
      const orig = loopFormOrig && typeof loopFormOrig === 'object' ? loopFormOrig : {};
      const def = Object.assign({}, orig, {
        name: String(loopsForm.name.value || '').trim(),
        engine: loopsForm.engine.value || 'cursor',
        cwd: String(loopsForm.cwd.value || '.').trim() || '.',
        allow: orig.allow || { commit: false, merge: false, push: false },
        budget: Object.assign({}, orig.budget || {}),
        phases: phases,
      });
      delete def.budget.maxRuns;
      delete def.budget.maxHours;
      const project = String(loopsForm.project.value || '').trim();
      if (project) def.project = project;
      const maxRuns = Number(loopsForm.maxRuns.value);
      const maxHours = Number(loopsForm.maxHours.value);
      if (Number.isFinite(maxRuns) && maxRuns > 0) def.budget.maxRuns = Math.floor(maxRuns);
      if (Number.isFinite(maxHours) && maxHours > 0) def.budget.maxHours = maxHours;
      return def;
    }

    async function fetchLoopDetail(name) {
      const response = await fetch('/api/loops/' + encodeURIComponent(name));
      const result = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(result.error || 'Failed to load loop');
      return result;
    }

    async function fetchLoopDefinitions() {
      const response = await fetch('/api/loops/definitions');
      const result = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(result.error || 'Failed to load definitions');
      return result;
    }

    function renderLoopsListFromState() {
      if (!loopsListEl) return;
      const loops = (state && state.loops && state.loops.loops) || [];
      loopsListEl.innerHTML = renderLoopsListHtml(loops, selectedLoopName);
    }

    function renderLoopDefinitionsList() {
      if (!loopsDefinitionsEl) return;
      const defs = loopDefinitionsCache || [];
      if (!defs.length) {
        loopsDefinitionsEl.innerHTML = '<div class="empty">No saved definitions</div>';
        return;
      }
      let html = '';
      for (let i = 0; i < defs.length; i++) {
        const d = defs[i] || {};
        html +=
          '<button type="button" class="loops-row" data-definition-name="' +
          escapeHtml(d.name || '') +
          '" data-definition-path="' +
          escapeHtml(d.path || '') +
          '">' +
          '<span class="loops-row-name">' +
          escapeHtml(d.name || '') +
          '</span>' +
          '<span class="loops-row-meta">' +
          escapeHtml(
            (d.phaseCount != null ? d.phaseCount + ' phase(s)' : '') +
              (d.engine ? ' · ' + d.engine : '') +
              (d.project ? ' · ' + d.project : '')
          ) +
          '</span>' +
          '</button>';
      }
      loopsDefinitionsEl.innerHTML = html;
    }

    function loopSummaryFromState(name) {
      const rows = (state && state.loops && state.loops.loops) || [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i] && rows[i].name === name) return rows[i];
      }
      return null;
    }

    /** Swap the detail markup, keeping the panel and eval-tail scroll offsets. */
    function setLoopDetailHtml(html) {
      if (!loopsDetailEl || html === loopDetailHtml) return;
      const panel = loopsDetailEl.parentNode || null;
      const panelTop = panel ? panel.scrollTop : 0;
      const tails = loopsDetailEl.querySelectorAll
        ? Array.prototype.map.call(loopsDetailEl.querySelectorAll('.loops-eval-tail'), function (el) {
            return el.scrollTop;
          })
        : [];
      loopDetailHtml = html;
      loopsDetailEl.innerHTML = html;
      if (panel) panel.scrollTop = panelTop;
      if (loopsDetailEl.querySelectorAll) {
        Array.prototype.forEach.call(loopsDetailEl.querySelectorAll('.loops-eval-tail'), function (el, i) {
          if (tails[i] != null) el.scrollTop = tails[i];
        });
      }
    }

    async function selectLoop(name) {
      const changed = name !== selectedLoopName;
      selectedLoopName = name;
      renderLoopsListFromState();
      if (!name) {
        loopDetailCache = null;
        loopDetailSynced = null;
        setLoopDetailHtml('<div class="empty">Select a loop or create one</div>');
        return;
      }
      const summary = loopSummaryFromState(name);
      try {
        const detail = await fetchLoopDetail(name);
        if (selectedLoopName !== name) return;
        loopDetailCache = detail;
        loopDetailSynced = { name: name, signature: loopSyncSignature(summary || detail) };
        if (changed && loopsDetailEl && loopsDetailEl.parentNode) loopsDetailEl.parentNode.scrollTop = 0;
        setLoopDetailHtml(renderLoopDetailHtml(loopDetailCache));
      } catch (err) {
        setLoopDetailHtml(
          '<div class="empty">' + escapeHtml(String(err.message || err)) + '</div>'
        );
      }
    }

    /** Re-sync the selected loop's detail pane when the polled loop row changed. */
    async function syncSelectedLoopDetail() {
      if (!selectedLoopName || loopDetailSyncing) return;
      const summary = loopSummaryFromState(selectedLoopName);
      if (!loopDetailNeedsSync(summary, loopDetailSynced, selectedLoopName)) return;
      loopDetailSyncing = true;
      try {
        await selectLoop(selectedLoopName);
      } finally {
        loopDetailSyncing = false;
      }
    }

    async function refreshLoopsData() {
      if (loopsLoading) return;
      loopsLoading = true;
      try {
        const listed = await fetch('/api/loops').then(function (r) { return r.json(); });
        if (state) {
          state.loops = {
            ok: listed.ok !== false,
            loops: listed.loops || [],
            definitionsDir: listed.definitionsDir || null,
          };
        }
        renderLoopsListFromState();
        try {
          const defs = await fetchLoopDefinitions();
          loopDefinitionsCache = defs.definitions || [];
          renderLoopDefinitionsList();
        } catch (_) {
          /* ignore */
        }
        if (selectedLoopName) await selectLoop(selectedLoopName);
      } catch (err) {
        setActionMessage(String(err.message || err), true);
      } finally {
        loopsLoading = false;
      }
    }

    function renderLoopsView() {
      renderLoopsListFromState();
      renderLoopDefinitionsList();
      if (loopDetailCache && selectedLoopName) {
        setLoopDetailHtml(renderLoopDetailHtml(loopDetailCache));
      }
      refreshLoopsData();
    }

    async function postLoopAction(pathname, body) {
      if (!actionsAllowed()) {
        setActionMessage(
          'Loop controls only work on the Mini — open this dashboard at 127.0.0.1 locally.',
          true
        );
        throw new Error('actions require local dashboard');
      }
      const response = await fetch(pathname, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aflt-Action-Token': actionToken(),
        },
        body: JSON.stringify(body || {}),
      });
      const result = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(result.error || 'Request failed');
      return result;
    }

    if (viewHistoryBtn) viewHistoryBtn.addEventListener('click', function () { setView('history'); });
    if (viewGraphBtn) viewGraphBtn.addEventListener('click', function () { setView('graph'); });
    if (viewLoopsBtn) viewLoopsBtn.addEventListener('click', function () { setView('loops'); });

    if (loopsNewBtn) {
      loopsNewBtn.addEventListener('click', function () {
        showLoopForm({ name: '', phases: [emptyLoopPhaseForm(0)] });
      });
    }
    if (loopsRefreshBtn) {
      loopsRefreshBtn.addEventListener('click', function () { refreshLoopsData(); });
    }
    if (loopsFormCancelBtn) {
      loopsFormCancelBtn.addEventListener('click', function () { hideLoopForm(); });
    }
    if (loopsAddPhaseBtn) {
      loopsAddPhaseBtn.addEventListener('click', function () {
        readLoopFormPhasesFromDom();
        loopFormPhases.push(emptyLoopPhaseForm(loopFormPhases.length));
        renderLoopPhaseEditors();
      });
    }
    if (loopsPhasesEl) {
      loopsPhasesEl.addEventListener('click', function (ev) {
        const t = ev.target;
        const btn = t && t.closest ? t.closest('[data-remove-phase]') : null;
        if (!btn) return;
        const idx = Number(btn.getAttribute('data-remove-phase'));
        readLoopFormPhasesFromDom();
        if (loopFormPhases.length <= 1) return;
        loopFormPhases.splice(idx, 1);
        renderLoopPhaseEditors();
      });
    }
    if (loopsForm) {
      loopsForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        const def = buildDefinitionFromForm();
        setLoopsFormStatus('Saving…', false);
        postLoopAction('/api/loops', { definition: def })
          .then(function (result) {
            setLoopsFormStatus('Saved ' + (result.path || def.name), false);
            setActionMessage('Saved loop definition ' + def.name, false);
            return refreshLoopsData();
          })
          .catch(function (err) {
            setLoopsFormStatus(String(err.message || err), true);
          });
      });
    }
    if (loopsStartBtn) {
      loopsStartBtn.addEventListener('click', function () {
        const pathVal = loopsStartInput ? String(loopsStartInput.value || '').trim() : '';
        if (!pathVal) {
          setActionMessage('Enter a loop definition path to start.', true);
          return;
        }
        postLoopAction('/api/loops/start', { path: pathVal })
          .then(function (result) {
            setActionMessage('Started loop ' + (result.name || pathVal), false);
            if (result.name) selectedLoopName = result.name;
            return refreshLoopsData();
          })
          .catch(function (err) {
            setActionMessage(String(err.message || err), true);
          });
      });
    }
    if (loopsListEl) {
      loopsListEl.addEventListener('click', function (ev) {
        const t = ev.target;
        const row = t && t.closest ? t.closest('[data-loop-name]') : null;
        if (!row) return;
        selectLoop(row.getAttribute('data-loop-name'));
      });
    }
    if (loopsDefinitionsEl) {
      loopsDefinitionsEl.addEventListener('click', function (ev) {
        const t = ev.target;
        const row = t && t.closest ? t.closest('[data-definition-name]') : null;
        if (!row) return;
        const name = row.getAttribute('data-definition-name');
        const pathVal = row.getAttribute('data-definition-path');
        if (loopsStartInput && pathVal) loopsStartInput.value = pathVal;
        fetch('/api/loops/' + encodeURIComponent(name) + '/definition')
          .then(function (r) { return r.json(); })
          .then(function (result) {
            if (result && result.definition) showLoopForm(result.definition);
            else setActionMessage(result.error || 'Definition not found', true);
          })
          .catch(function (err) {
            setActionMessage(String(err.message || err), true);
          });
      });
    }
    if (loopsDetailEl) {
      loopsDetailEl.addEventListener('click', function (ev) {
        const t = ev.target;
        const sessionBtn = t && t.closest ? t.closest('[data-session-id]') : null;
        if (sessionBtn) {
          const sid = sessionBtn.getAttribute('data-session-id');
          if (sid) {
            selectedId = sid;
            setView('history');
            renderDetail();
            setActionMessage('Selected session ' + sid + ' in History.', false);
          }
          return;
        }
        const btn = t && t.closest ? t.closest('[data-loop-action]') : null;
        if (!btn) return;
        const action = btn.getAttribute('data-loop-action');
        const name = btn.getAttribute('data-loop-name');
        if (!action || !name) return;
        if (action === 'edit') {
          fetch('/api/loops/' + encodeURIComponent(name) + '/definition')
            .then(function (r) { return r.json(); })
            .then(function (result) {
              if (result && result.definition) showLoopForm(result.definition);
              else if (loopDetailCache && loopDetailCache.definition) {
                showLoopForm({
                  name: loopDetailCache.name,
                  project: loopDetailCache.project,
                  cwd: loopDetailCache.cwd,
                  engine: loopDetailCache.definition.engine,
                  budget: loopDetailCache.definition.budget,
                  phases: (loopDetailCache.definition.phases || []).map(function (p) {
                    return {
                      id: p.id,
                      engine: p.engine,
                      session: p.session,
                      prompt: '',
                      eval: p.eval,
                      maxFixAttempts: p.maxFixAttempts,
                      onPass: p.onPass,
                      gate: p.gate,
                      mode: p.mode,
                      force: p.force,
                    };
                  }),
                });
              } else {
                setActionMessage(result.error || 'No editable definition found', true);
              }
            })
            .catch(function (err) {
              setActionMessage(String(err.message || err), true);
            });
          return;
        }
        postLoopAction('/api/loops/' + encodeURIComponent(name) + '/' + action, {})
          .then(function () {
            setActionMessage(action + ' · ' + name, false);
            return refreshLoopsData();
          })
          .catch(function (err) {
            setActionMessage(String(err.message || err), true);
          });
      });
    }
    if (hideDormantEl) {
      hideDormantEl.addEventListener('change', function () {
        hideDormant = !!hideDormantEl.checked;
        persistLocal(HIDE_DORMANT_STORAGE_KEY, hideDormant ? '1' : '0');
        renderHistoryTree();
        updateDormantHiddenCount();
        simStale = true;
        updateSim({ forceRebuild: true, fit: true });
        drawGraph();
        if (currentView === 'graph') startLoop();
      });
    }
    if (showArchivedEl) {
      showArchivedEl.addEventListener('change', function () {
        showArchived = !!showArchivedEl.checked;
        persistLocal(SHOW_ARCHIVED_STORAGE_KEY, showArchived ? '1' : '0');
        renderHistoryTree();
        renderDetail();
        simStale = true;
        updateSim({ forceRebuild: true, fit: true });
        drawGraph();
        if (currentView === 'graph') startLoop();
      });
    }

    if (timelinePresetsEl) {
      timelinePresetsEl.addEventListener('click', function (ev) {
        const target = ev.target;
        const btn = target && typeof target.closest === 'function'
          ? target.closest('.timeline-preset')
          : null;
        if (!btn) return;
        const preset = btn.getAttribute('data-preset');
        if (preset) setTimelinePreset(preset);
      });
    }
    if (timelineZoomInBtn) {
      timelineZoomInBtn.addEventListener('click', function () { adjustTimelineZoom(1.35); });
    }
    if (timelineZoomOutBtn) {
      timelineZoomOutBtn.addEventListener('click', function () { adjustTimelineZoom(1 / 1.35); });
    }

    function timelineAnchorFromEvent(ev) {
      const win = activeTimelineWindow();
      const span = win.end - win.start;
      const el = ganttAxisEl || historyTreeEl;
      if (!el || typeof el.getBoundingClientRect !== 'function') return (win.start + win.end) / 2;
      const rect = el.getBoundingClientRect();
      const ratio = rect.width > 0 ? (ev.clientX - rect.left) / rect.width : 0.5;
      return win.start + span * Math.max(0, Math.min(1, ratio));
    }

    function onTimelineWheel(ev) {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      const dy = ev.deltaY || 0;
      const factor = dy > 0 ? 1 / 1.15 : 1.15;
      adjustTimelineZoom(factor, timelineAnchorFromEvent(ev));
    }

    if (historyViewEl) {
      historyViewEl.addEventListener('wheel', onTimelineWheel, { passive: false });
    }

    function beginTimelinePan(ev) {
      if (ev.button != null && ev.button !== 0) return;
      const target = ev.target;
      const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
      if (closest && closest('.gantt-marker, button, a, select, input, .filter-chip, .timeline-preset')) return;
      if (!(closest && (closest('.gantt-axis') || closest('.gantt-track') || closest('.gantt-axis-wrap')))) {
        return;
      }
      const win = activeTimelineWindow();
      timelinePanning = {
        x: ev.clientX,
        start: win.start,
        end: win.end,
        width: measureTimelineTrackWidth(),
      };
      if (ganttAxisWrapEl) toggleBtnClass(ganttAxisWrapEl, 'panning', true);
      if (historyTreeEl) toggleBtnClass(historyTreeEl, 'timeline-panning', true);
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
    }

    function moveTimelinePan(ev) {
      if (!timelinePanning) return;
      const width = timelinePanning.width || measureTimelineTrackWidth();
      const span = timelinePanning.end - timelinePanning.start;
      const dx = ev.clientX - timelinePanning.x;
      const deltaMs = width > 0 ? (-dx / width) * span : 0;
      const domain = timelineClampDomain(fullTimelineRange());
      timelineOverride = panTimelineWindow(
        { start: timelinePanning.start, end: timelinePanning.end },
        deltaMs,
        domain.start,
        domain.end
      );
      // Live-update axis/markers without clearing override mid-drag.
      renderHistoryTree();
    }

    function endTimelinePan() {
      if (!timelinePanning) return;
      timelinePanning = null;
      if (ganttAxisWrapEl) toggleBtnClass(ganttAxisWrapEl, 'panning', false);
      if (historyTreeEl) toggleBtnClass(historyTreeEl, 'timeline-panning', false);
      persistTimelineView();
    }

    if (ganttAxisWrapEl) {
      ganttAxisWrapEl.addEventListener('mousedown', beginTimelinePan);
    }
    if (historyTreeEl) {
      historyTreeEl.addEventListener('mousedown', beginTimelinePan);
    }
    window.addEventListener('mousemove', moveTimelinePan);
    window.addEventListener('mouseup', endTimelinePan);

    if (graphZoomInBtn) {
      graphZoomInBtn.addEventListener('click', function (ev) {
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
        setGraphZoom(1.25);
      });
    }
    if (graphZoomOutBtn) {
      graphZoomOutBtn.addEventListener('click', function (ev) {
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
        setGraphZoom(1 / 1.25);
      });
    }
    if (graphFitBtn) {
      graphFitBtn.addEventListener('click', function (ev) {
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
        fitGraphToView();
        drawGraph();
      });
    }
    if (graphSpreadEl) {
      graphSpreadEl.addEventListener('input', function () {
        graphSpread = clampGraphSpread(Number(graphSpreadEl.value) / 100);
        persistLocal(GRAPH_SPREAD_STORAGE_KEY, String(graphSpread));
        if (sim) sim.alpha = 1;
        updateSim({ forceRebuild: true, fit: true });
        drawGraph();
        if (currentView === 'graph') startLoop();
      });
      graphSpreadEl.addEventListener('click', function (ev) {
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
      });
    }

    if (graphViewEl) {
      graphViewEl.addEventListener('wheel', function (ev) {
        if (currentView !== 'graph') return;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        const dy = ev.deltaY || 0;
        const factor = dy > 0 ? 1 / 1.12 : 1.12;
        setGraphZoom(factor, ev.clientX, ev.clientY);
      }, { passive: false });
    }

    function graphPanTarget(ev) {
      const target = ev.target;
      if (!target) return true;
      if (typeof target.closest === 'function') {
        if (target.closest('.graph-controls, .graph-tooltip, .node-hit, button, input, label')) {
          return false;
        }
      }
      return true;
    }

    function beginGraphPan(ev) {
      if (currentView !== 'graph') return;
      if (ev.button != null && ev.button !== 0) return;
      if (!graphPanTarget(ev)) return;
      const pivot = clientToViewBox(ev.clientX, ev.clientY);
      graphPanning = {
        x: ev.clientX,
        y: ev.clientY,
        tx: graphView.tx || 0,
        ty: graphView.ty || 0,
        sx: pivot.w / Math.max(pivot.rect.width, 1),
        sy: pivot.h / Math.max(pivot.rect.height, 1),
      };
      graphPanMoved = false;
      if (graphViewEl) toggleBtnClass(graphViewEl, 'panning', true);
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
    }

    function moveGraphPan(ev) {
      if (!graphPanning) return;
      const dx = (ev.clientX - graphPanning.x) * graphPanning.sx;
      const dy = (ev.clientY - graphPanning.y) * graphPanning.sy;
      if (Math.abs(ev.clientX - graphPanning.x) > 3 || Math.abs(ev.clientY - graphPanning.y) > 3) {
        graphPanMoved = true;
      }
      graphView = {
        scale: graphView.scale || 1,
        tx: graphPanning.tx + dx,
        ty: graphPanning.ty + dy,
      };
      graphViewInitialized = true;
      graphNeedsFit = false;
      applyGraphWorldTransform();
      positionGraphTooltip();
    }

    function endGraphPan() {
      if (!graphPanning) return;
      graphPanning = null;
      if (graphViewEl) toggleBtnClass(graphViewEl, 'panning', false);
    }

    if (svg) {
      svg.addEventListener('mousedown', beginGraphPan);
    }
    window.addEventListener('mousemove', moveGraphPan);
    window.addEventListener('mouseup', endGraphPan);

    async function handleDashboardAction(el) {
      if (!el || !el.getAttribute) return false;
      const action = el.getAttribute('data-action');
      if (!action) return false;
      const id = el.getAttribute('data-id');
      const project = el.getAttribute('data-project');
      const title = el.getAttribute('data-title');
      if (action === 'archive' && id) await archiveSession(id, false);
      else if (action === 'archive-children' && id) await archiveSession(id, true);
      else if (action === 'unarchive' && id) await unarchiveSession(id, false);
      else if (action === 'delete' && id) await deleteSession(id, title);
      else if (action === 'purge' && id) await purgeSession(id, title);
      else if (action === 'archive-idle' && project) await archiveIdleInProject(project);
      else return false;
      return true;
    }

    if (detailEl) {
      detailEl.addEventListener('click', function (ev) {
        const t = ev.target;
        const btn =
          t && t.getAttribute && t.getAttribute('data-action')
            ? t
            : t && t.closest
              ? t.closest('[data-action]')
              : null;
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        handleDashboardAction(btn);
      });
    }
    setShown(graphViewEl, false);
    setShown(loopsViewEl, false);

    function applyState(next, opts) {
      opts = opts || {};
      state = next;
      if (!selectedId) {
        const first = (state.projects || []).find(function (p) {
          return p.memory && (p.memory.summary || (p.memory.documents || []).length);
        });
        if (first) selectedId = first.id;
      }
      lastUpdatedAt = Date.now();
      tickMeta();
      renderStats(state);
      drawSpark(spark24, state.sparkline24h, 'var(--cp-accent)');
      drawSpark(spark7, state.sparkline7d, 'var(--cp-link)');
      renderEvents(state);
      renderHistoryTree();
      renderDetail();
      updateHerdrRemoteNote();
      if (historyTooltipId) renderHistoryTooltip();
      if (currentView === 'loops') {
        renderLoopsListFromState();
        // The SSE tick carries fresh loop rows; refetch the detail when they moved.
        syncSelectedLoopDetail();
      }
      // Always rebuild/draw the graph model so a later switch (or tests) have nodes.
      updateSim(opts);
      drawGraph();
      if (currentView === 'graph') startLoop();
      else {
        // Keep a single queued frame so consumers that drain RAF still see an update
        // while history is the default view; do not spin the force loop.
        if (!raf) {
          raf = requestAnimationFrame(function () {
            raf = 0;
            if (currentView === 'graph') startLoop();
            else drawGraph();
          });
        }
      }
    }

    graphTooltip.addEventListener('mouseenter', function () {
      cancelTooltipHide();
      hoverId = null;
      focusId = null;
      tooltipHovered = true;
    });
    graphTooltip.addEventListener('mouseleave', function () {
      tooltipHovered = false;
      scheduleTooltipHide();
    });
    graphTooltip.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    // Empty graph background dismisses the popup (node clicks stopPropagation).
    // Listen on svg, graph-view, and stage so clicks on the SVG/backdrop clear the
    // selection in both the real DOM and the dashboard test harness.
    function clearGraphSelection() {
      if (currentView !== 'graph') return;
      if (graphPanMoved) {
        graphPanMoved = false;
        return;
      }
      selectedId = null;
      dismissGraphTooltip();
      renderDetail();
    }
    if (svg) svg.addEventListener('click', clearGraphSelection);
    if (graphViewEl) graphViewEl.addEventListener('click', clearGraphSelection);
    if (stage) stage.addEventListener('click', clearGraphSelection);
    if (historyViewEl) {
      historyViewEl.addEventListener('click', function (ev) {
        const target = ev.target;
        const closest = target && typeof target.closest === 'function' ? target.closest.bind(target) : null;
        if (closest && closest('.history-row, .graph-tooltip, .filter-chip, .timeline-preset, .twist, button, a, select, input')) return;
        selectedId = null;
        dismissHistoryTooltip();
        renderDetail();
      });
    }
    window.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        dismissGraphTooltip();
        dismissHistoryTooltip();
        if (expandedTimelineGroups.size) {
          expandedTimelineGroups.clear();
          renderHistoryTree();
        }
      }
    });

    window.addEventListener('resize', function () {
      if (state && currentView === 'graph') {
        applyState(state, { forceRebuild: true, fit: true });
      } else if (state) {
        measureTimelineTrackWidth();
        renderHistoryTree();
      }
    });

    function connectSse() {
      const es = new EventSource('/events');
      es.onmessage = function (msg) {
        try {
          applyState(JSON.parse(msg.data));
        } catch (_) {
          /* ignore */
        }
      };
      es.onerror = function () {
        metaEl.textContent = 'local · reconnecting…';
      };
    }

    function firstState(data) {
      applyState(data, { forceRebuild: true });
      if (data && data.defaultView === 'graph') setView('graph');
      else if (data && data.defaultView === 'loops') {
        setView('loops');
        const rows = (data.loops && data.loops.loops) || [];
        const pick = rows.find(function (l) { return l && l.active; }) || rows[0];
        if (pick && pick.name) selectLoop(pick.name);
      }
    }

    if (snapshotData) {
      firstState(JSON.parse(snapshotData.textContent));
      return;
    }

    fetch('/api/state')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        firstState(data);
        connectSse();
      })
      .catch(function () {
        metaEl.textContent = 'local · failed to load';
        connectSse();
      });
  })();
}
