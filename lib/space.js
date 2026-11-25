'use strict';

/**
 * Named spaces — isolated aflt homes under `$HOME/.agentfleet/spaces/<name>`.
 *
 * Resolution (flag / AFLT_SPACE / AGENTFLEET_HOME) lives in lib/util.js.
 * This module owns `aflt space` create/list/current/remove and helpers for
 * per-space dashboard ports, service labels, and isolated memory/notify.
 */

const fs = require('fs');
const path = require('path');
const {
  homeDir,
  defaultFleetDir,
  spacesRootDir,
  spaceHomeDir,
  validateSpaceName,
  currentSpaceName,
  serviceLabelForSpace,
  plistBasenameForSpace,
  DEFAULT_DASHBOARD_PORT,
} = require('./util');

const DEFAULT_SERVICE_LABEL = serviceLabelForSpace(null);

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * Extract a recorded dashboard port from a space (or default) config object.
 * @returns {number|null}
 */
function portFromConfig(data) {
  if (!data || typeof data !== 'object') return null;
  const dash = data.dashboard;
  if (dash && typeof dash === 'object' && !Array.isArray(dash) && dash.port != null) {
    const n = Number(dash.port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  if (data.port != null) {
    const n = Number(data.port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  return null;
}

const DASHBOARD_SERVE_FILE = 'dashboard-serve.json';

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * Port of a dashboard currently served for a fleet home (written by
 * `dashboard --serve`), or null when none is recorded or its process is gone.
 * Covers spaces with no config.json, whose port is not recorded anywhere else.
 */
function servedPortFromHome(home, opts = {}) {
  const data = readJsonSafe(path.join(home, DASHBOARD_SERVE_FILE));
  if (!data || typeof data !== 'object') return null;
  const n = Number(data.port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  const alive = opts.pidAlive || pidAlive;
  if (data.pid != null && !alive(data.pid)) return null;
  return n;
}

/**
 * Record the port a dashboard is serving on for this fleet home (best effort).
 */
function recordServedPort(home, info = {}) {
  try {
    const port = Number(info.port);
    if (!home || !Number.isInteger(port) || port < 1) return false;
    fs.mkdirSync(home, { recursive: true });
    const data = {
      port,
      host: info.host || null,
      pid: info.pid || process.pid,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(home, DASHBOARD_SERVE_FILE), JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

const PROBE_SCRIPT = [
  "const net=require('net');",
  'const ports=JSON.parse(process.argv[1]);',
  'function busy(p){return new Promise((r)=>{let done=false;const fin=(v)=>{if(!done){done=true;r(v);}};',
  "const s=net.connect({port:p,host:'127.0.0.1'});s.setTimeout(250);",
  "s.once('connect',()=>{s.destroy();fin(true);});",
  "const tryListen=()=>{const srv=net.createServer();srv.once('error',()=>fin(true));srv.listen(p,'127.0.0.1',()=>srv.close(()=>fin(false)));};",
  "s.once('timeout',()=>{s.destroy();tryListen();});s.once('error',()=>tryListen());});}",
  '(async()=>{const out=[];for(const p of ports){if(await busy(p))out.push(p);}process.stdout.write(JSON.stringify(out));})();',
].join('');

/**
 * Synchronously probe which ports are in use on this machine (something accepts
 * connections, or the port cannot be bound on 127.0.0.1). Runs a short node
 * child so space creation stays synchronous. Returns a Set of busy ports.
 */
function probeBusyPorts(ports, opts = {}) {
  const list = (ports || []).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
  if (!list.length) return new Set();
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync(process.execPath, ['-e', PROBE_SCRIPT, JSON.stringify(list)], {
      encoding: 'utf8',
      timeout: opts.timeoutMs || 10000,
    });
    const arr = JSON.parse(String(res.stdout || '[]'));
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch (_) {
    return new Set();
  }
}

/**
 * Ports already claimed: default 8787 plus any recorded in default or named-space
 * configs, plus ports of dashboards currently served for any space (including
 * spaces without a config.json).
 */
function collectRecordedPorts(opts = {}) {
  const used = new Set([DEFAULT_DASHBOARD_PORT]);
  const root = opts.spacesRoot || spacesRootDir();
  const defaultHome = opts.defaultHome || defaultFleetDir();

  const defaultCfg = readJsonSafe(path.join(defaultHome, 'config.json'));
  const defaultPort = portFromConfig(defaultCfg);
  if (defaultPort != null) used.add(defaultPort);
  const defaultServed = servedPortFromHome(defaultHome, opts);
  if (defaultServed != null) used.add(defaultServed);

  if (fs.existsSync(root)) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch (_) {
      names = [];
    }
    for (const name of names) {
      const full = path.join(root, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (_) {
        continue;
      }
      if (!st.isDirectory()) continue;
      const cfg = readJsonSafe(path.join(full, 'config.json'));
      const p = portFromConfig(cfg);
      if (p != null) used.add(p);
      const served = servedPortFromHome(full, opts);
      if (served != null) used.add(served);
    }
  }
  return used;
}

/**
 * Next free port starting at 8787 (default reserved), then 8788, 8789, …
 * Skips ports recorded for any space and ports something is listening on now
 * (pass `probe: false` to skip the live check, or `isPortBusy(port)` to inject
 * one; AFLT_NO_PORT_PROBE=1 disables it).
 */
function allocateDashboardPort(opts = {}) {
  const used = opts.used || collectRecordedPorts(opts);
  const probeOn = opts.probe !== false && process.env.AFLT_NO_PORT_PROBE !== '1';
  const probeBusy = opts.isPortBusy
    ? (ports) => new Set(ports.filter((p) => opts.isPortBusy(p)))
    : probeBusyPorts;
  let port = DEFAULT_DASHBOARD_PORT;
  while (port <= 65535) {
    const batch = [];
    while (port <= 65535 && batch.length < 16) {
      if (!used.has(port)) batch.push(port);
      port += 1;
    }
    if (!batch.length) break;
    const busy = probeOn ? probeBusy(batch) : new Set();
    const free = batch.find((p) => !busy.has(p));
    if (free != null) return free;
  }
  const err = new Error('no free dashboard port available (scanned recorded and listening ports)');
  err.code = 'SPACE_PORT_EXHAUSTED';
  throw err;
}

/**
 * Resolve dashboard port for the current fleet home: flag > config > default 8787.
 */
function resolveDashboardPort(opts = {}) {
  if (opts.port != null && opts.port !== true && opts.port !== '') {
    const n = Number(opts.port);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      const err = new Error('--port must be an integer 0–65535');
      err.code = 'SPACE_BAD_PORT';
      throw err;
    }
    return n;
  }
  const data = opts.config != null ? opts.config : readJsonSafe(path.join(opts.home || require('./util').fleetDir(), 'config.json'));
  const fromCfg = portFromConfig(data);
  if (fromCfg != null) return fromCfg;
  return DEFAULT_DASHBOARD_PORT;
}

/**
 * Whether a space's own config has notify enabled (has a url, and not explicitly disabled).
 */
function spaceNotifyEnabled(configData) {
  const data = configData && typeof configData === 'object' ? configData : {};
  const raw = data.notify && typeof data.notify === 'object' && !Array.isArray(data.notify) ? data.notify : {};
  if (raw.enabled === false) return false;
  const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : null;
  return Boolean(url);
}

function listNamedSpaceDirs(opts = {}) {
  const root = opts.spacesRoot || spacesRootDir();
  if (!fs.existsSync(root)) return [];
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      validateSpaceName(name);
    } catch (_) {
      continue;
    }
    const full = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (_) {
      continue;
    }
    if (!st.isDirectory()) continue;
    out.push({ name, path: full });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function hasAnyFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur);
    } catch (_) {
      continue;
    }
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      const full = path.join(cur, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (_) {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else return true;
    }
  }
  return false;
}

function listSpaces(opts = {}) {
  const current = opts.current !== undefined ? opts.current : currentSpaceName();
  const defaultHome = opts.defaultHome || defaultFleetDir();
  const named = listNamedSpaceDirs(opts).map((s) => {
    const cfg = readJsonSafe(path.join(s.path, 'config.json'));
    return {
      name: s.name,
      path: s.path,
      current: current === s.name,
      port: portFromConfig(cfg),
      serviceLabel: (cfg && cfg.service && cfg.service.label) || serviceLabelForSpace(s.name),
      memoryRepo: cfg && typeof cfg.memoryRepo === 'string' ? cfg.memoryRepo : null,
      notifyEnabled: spaceNotifyEnabled(cfg),
    };
  });
  return {
    current: current || null,
    default: {
      name: null,
      label: '(default)',
      path: defaultHome,
      current: !current,
      port: DEFAULT_DASHBOARD_PORT,
      serviceLabel: DEFAULT_SERVICE_LABEL,
    },
    spaces: named,
  };
}

function createSpace(name, opts = {}) {
  const validated = validateSpaceName(name);
  const home = spaceHomeDir(validated, opts);
  if (fs.existsSync(home)) {
    const err = new Error(`space already exists: ${validated} (${home})`);
    err.code = 'SPACE_EXISTS';
    throw err;
  }

  const port = opts.port != null ? Number(opts.port) : allocateDashboardPort(opts);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error(`invalid dashboard port: ${port}`);
    err.code = 'SPACE_BAD_PORT';
    throw err;
  }

  const memoryRepo = opts.memoryRepo || path.join(home, 'memory');
  const label = serviceLabelForSpace(validated);
  const configData = {
    space: { name: validated },
    dashboard: { port },
    notify: { enabled: false },
    memoryRepo,
    service: {
      label,
      plist: plistBasenameForSpace(validated),
    },
  };

  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(memoryRepo, { recursive: true, mode: 0o700 });
  writeJsonAtomic(path.join(home, 'config.json'), configData);

  return {
    ok: true,
    name: validated,
    path: home,
    port,
    memoryRepo,
    serviceLabel: label,
    plist: plistBasenameForSpace(validated),
    notifyEnabled: false,
    config: configData,
  };
}

function currentSpaceInfo(opts = {}) {
  const name = opts.current !== undefined ? opts.current : currentSpaceName();
  const homeExplicit = Boolean(
    opts.homeExplicit != null
      ? opts.homeExplicit
      : require('./util').envNonEmpty(process.env, 'AGENTFLEET_HOME')
  );
  return {
    space: name || null,
    default: !name,
    home: opts.home || require('./util').fleetDir(),
    homeExplicit,
    label: name || '(default)',
  };
}

function removeSpace(name, opts = {}) {
  const force = Boolean(opts.force);
  let validated;
  try {
    validated = validateSpaceName(name);
  } catch (err) {
    throw err;
  }

  // Never remove the default (unsanded) home — only names under spaces/.
  const root = path.resolve(opts.spacesRoot || spacesRootDir());
  const home = path.resolve(spaceHomeDir(validated, opts));
  const rel = path.relative(root, home);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error(
      `refusing to remove: "${validated}" is not a named space under ${root}`
    );
    err.code = 'SPACE_NOT_NAMED';
    throw err;
  }

  if (!fs.existsSync(home)) {
    const err = new Error(`space not found: ${validated}`);
    err.code = 'SPACE_NOT_FOUND';
    throw err;
  }

  const nonEmpty = hasAnyFiles(home);
  if (nonEmpty && !force) {
    const err = new Error(
      `space "${validated}" is not empty (has config or other files); pass --force to remove`
    );
    err.code = 'SPACE_NOT_EMPTY';
    throw err;
  }

  fs.rmSync(home, { recursive: true, force: true });
  return { ok: true, name: validated, path: home, forced: force && nonEmpty };
}

module.exports = {
  DEFAULT_SERVICE_LABEL,
  DEFAULT_DASHBOARD_PORT,
  readJsonSafe,
  writeJsonAtomic,
  portFromConfig,
  collectRecordedPorts,
  allocateDashboardPort,
  probeBusyPorts,
  servedPortFromHome,
  recordServedPort,
  DASHBOARD_SERVE_FILE,
  resolveDashboardPort,
  spaceNotifyEnabled,
  listNamedSpaceDirs,
  listSpaces,
  createSpace,
  currentSpaceInfo,
  removeSpace,
  hasAnyFiles,
  serviceLabelForSpace,
  plistBasenameForSpace,
  validateSpaceName,
  spacesRootDir,
  spaceHomeDir,
  defaultFleetDir,
  homeDir,
};
