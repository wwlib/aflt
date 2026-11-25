'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fleetDir, nowIso, escapeShellArg } = require('./util');

function runLogDir(sessionId) {
  return path.join(fleetDir(), 'runs', String(sessionId));
}

function newRunLogPath(sessionId, engine) {
  const dir = runLogDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const safeEngine = String(engine || 'cursor').replace(/[^a-z0-9_-]+/gi, '') || 'run';
  return path.join(dir, `${stamp}.${safeEngine}.txt`);
}

function encodePromptHeaderLine(value) {
  return String(value == null ? '' : value)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Header + stdout marker. Exit/signal/timedOut and stderr are appended later
 * so `af tail -f` can follow stdout while the engine is still running.
 *
 * Optional `kind` (`headless` | `interactive`) and `prompt` are written as
 * extra `#` lines before the stdout marker so older readers that only look
 * for `# argv:` / `# --- stdout ---` keep working.
 */
function writeRunLogHeader(file, { argv, cwd, kind = null, prompt = null }) {
  const parts = [];
  parts.push(`# cwd: ${cwd || ''}`);
  parts.push(`# argv: ${(argv || []).map(escapeShellArg).join(' ')}`);
  if (kind) parts.push(`# kind: ${String(kind)}`);
  if (prompt != null && prompt !== '') {
    parts.push(`# prompt: ${encodePromptHeaderLine(prompt)}`);
  }
  parts.push('# --- stdout ---');
  parts.push('');
  fs.writeFileSync(file, parts.join('\n'), { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * Record a launch/resume prompt for interactive sessions (Herdr / plain TUI).
 * Does not scrape running terminals or touch Herdr — argv/prompt only.
 * Same file layout as headless runs (empty stdout body).
 *
 * @returns {string|null} path written, or null when skipped
 */
function recordInteractiveLaunch(sessionId, opts = {}) {
  const prompt = opts.prompt;
  const argv = opts.argv;
  // Always record when a prompt is present; also record when argv is provided
  // so resume-without-prompt still leaves a launch breadcrumb.
  if ((!prompt || !String(prompt).trim()) && (!argv || !argv.length)) return null;
  const engine = opts.engine || 'cursor';
  const file = newRunLogPath(sessionId, engine);
  writeRunLogHeader(file, {
    argv: argv || [],
    cwd: opts.cwd || '',
    kind: opts.kind || 'interactive',
    prompt: prompt != null && String(prompt).trim() ? prompt : null,
  });
  writeRunLogFooter(file, {
    stderr: '',
    code: 'n/a',
    signal: null,
    timedOut: false,
  });
  return file;
}

function appendRunLog(file, chunk) {
  if (chunk == null || chunk === '') return;
  fs.appendFileSync(file, String(chunk), { encoding: 'utf8' });
}

/**
 * Append stderr (if any) and exit footer after the live stdout section.
 * Optional `usage` object is recorded as a single `# usage: <json>` line
 * (ignored by older readers that only look for exit/signal/timedOut).
 */
function writeRunLogFooter(file, { stderr, code, signal, timedOut, usage = null }) {
  const parts = [];
  if (stderr) {
    parts.push('# --- stderr ---');
    parts.push(stderr.endsWith('\n') ? stderr.slice(0, -1) : stderr);
  }
  parts.push(`# exit: ${code}`);
  parts.push(`# signal: ${signal || ''}`);
  parts.push(`# timedOut: ${timedOut ? 'yes' : 'no'}`);
  if (usage && typeof usage === 'object') {
    try {
      parts.push(`# usage: ${JSON.stringify(usage)}`);
    } catch (_) {
      /* ignore */
    }
  }
  parts.push('');
  fs.appendFileSync(file, parts.join('\n'), { encoding: 'utf8' });
  return file;
}

/**
 * Write a complete run log in one shot (same layout as streaming: header,
 * stdout, optional stderr, exit footer). Used by callers that already have
 * the full capture.
 */
function writeRunLog(file, { argv, cwd, stdout, stderr, code, signal, timedOut, kind = null, prompt = null, usage = null }) {
  writeRunLogHeader(file, { argv, cwd, kind, prompt });
  if (stdout) {
    const body = stdout.endsWith('\n') ? stdout : stdout + '\n';
    appendRunLog(file, body);
  }
  writeRunLogFooter(file, { stderr, code, signal, timedOut, usage });
  return file;
}

function signalExitCode(sig) {
  if (sig === 'SIGINT') return 130;
  if (sig === 'SIGTERM') return 143;
  if (sig === 'SIGHUP') return 129;
  return 1;
}

function killProcessGroup(pgid, signal) {
  if (pgid == null) return false;
  try {
    process.kill(-Number(pgid), signal);
    return true;
  } catch (_) {
    return false;
  }
}

/** Every descendant pid of `pid` (children first found via `ps`), deepest last. */
function descendantPids(pid) {
  if (pid == null || process.platform === 'win32') return [];
  let out = '';
  try {
    out = require('child_process').execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch (_) {
    return [];
  }
  const kids = new Map();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const ppid = Number(m[2]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(m[1]));
  }
  const found = [];
  const queue = [Number(pid)];
  while (queue.length) {
    const p = queue.shift();
    for (const c of kids.get(p) || []) {
      if (found.includes(c)) continue;
      found.push(c);
      queue.push(c);
    }
  }
  return found;
}

/** Signal a list of pids, ignoring ones already gone. */
function signalPids(pids, signal) {
  for (const p of pids || []) {
    try {
      process.kill(p, signal);
    } catch (_) {
      /* gone */
    }
  }
}

function isPidAlive(pid) {
  if (pid == null || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Spawn a CLI, capture stdout/stderr, optionally time out.
 * stdin is ignored so a headless run cannot hang waiting for a TTY prompt.
 * Optional `env` replaces process.env entirely when provided; use
 * `{ ...process.env, KEY: val }` for overlays.
 *
 * When `detached` is true the child is placed in its own process group
 * (still awaited; do not unref) so `af stop` can signal the whole group.
 * `onSpawn({ pid, pgid, child })` fires once the child has a pid.
 * Optional `logPath` streams stdout into the run log as data arrives
 * (header must already be written, or pass `logHeader: true`).
 *
 * When `forwardSignals` is true (default for detached), SIGINT/SIGTERM/SIGHUP
 * on this process are forwarded as SIGTERM to the child's process group so
 * interrupting af does not orphan the engine. Resolves with `interruptedBy`.
 *
 * `idleTimeoutMs` stops the engine (its whole process tree, including
 * children in other process groups) when there is no stdout/stderr and no
 * newer `activityProbe()` timestamp (ms) for that long; the result then has
 * `timedOut: true, idleTimedOut: true`. `onActivity(ms, source)` fires on
 * each sign of progress.
 */
function spawnCaptured(bin, argv, opts = {}) {
  const {
    cwd,
    timeoutMs,
    env,
    detached = false,
    onSpawn = null,
    logPath = null,
    logHeader = false,
    onStdout = null,
    onStderr = null,
    forwardSignals = Boolean(opts.detached),
    signalKillAfterMs = 2000,
    idleTimeoutMs = 0,
    idleCheckMs = 0,
    activityProbe = null,
    onActivity = null,
  } = opts;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, {
        cwd: cwd || process.cwd(),
        env: env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: Boolean(detached),
      });
    } catch (err) {
      reject(err);
      return;
    }

    const pid = child.pid != null ? child.pid : null;
    // Detached child is the process-group leader on Unix; pgid === pid.
    const pgid = detached && pid != null ? pid : null;
    if (typeof onSpawn === 'function') {
      try {
        onSpawn({ pid, pgid, child });
      } catch (_) {
        /* ignore callback errors */
      }
    }

    if (logPath && logHeader) {
      writeRunLogHeader(logPath, { argv: [bin, ...argv], cwd: cwd || process.cwd() });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let interruptedBy = null;
    let killTimer = null;
    const signalHandlers = {};

    function cleanupSignals() {
      for (const [sig, fn] of Object.entries(signalHandlers)) {
        try {
          process.removeListener(sig, fn);
        } catch (_) {
          /* ignore */
        }
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    }

    function terminateChild(sigName) {
      try {
        if (detached && pgid != null) {
          killProcessGroup(pgid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch (_) {
        try {
          child.kill('SIGTERM');
        } catch (__) {
          /* ignore */
        }
      }
      if (signalKillAfterMs > 0 && pid != null) {
        killTimer = setTimeout(() => {
          if (!isPidAlive(pid)) return;
          try {
            if (detached && pgid != null) killProcessGroup(pgid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch (_) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch (__) {
              /* ignore */
            }
          }
        }, signalKillAfterMs);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }
    }

    function onParentSignal(sig) {
      if (interruptedBy || settled) return;
      interruptedBy = sig;
      terminateChild(sig);
    }

    if (forwardSignals) {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const fn = () => onParentSignal(sig);
        signalHandlers[sig] = fn;
        try {
          process.on(sig, fn);
        } catch (_) {
          /* Windows may not support all signals */
        }
      }
    }

    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminateChild('SIGTERM');
          }, timeoutMs)
        : null;

    let lastActivity = Date.now();
    let idleTimedOut = false;
    const noteActivity = (source) => {
      lastActivity = Date.now();
      if (typeof onActivity === 'function') {
        try {
          onActivity(lastActivity, source);
        } catch (_) {
          /* ignore */
        }
      }
    };
    const idleTimer =
      idleTimeoutMs && idleTimeoutMs > 0
        ? setInterval(() => {
            if (settled) return;
            if (typeof activityProbe === 'function') {
              let t = null;
              try {
                t = activityProbe();
              } catch (_) {
                t = null;
              }
              if (t != null && Number(t) > lastActivity) noteActivity('files');
            }
            if (Date.now() - lastActivity < idleTimeoutMs) return;
            idleTimedOut = true;
            timedOut = true;
            clearInterval(idleTimer);
            // Children may sit in their own process group (shell tools), so
            // signal the whole tree, then the group.
            const tree = descendantPids(pid);
            signalPids(tree, 'SIGTERM');
            terminateChild('SIGTERM');
            if (signalKillAfterMs > 0 && tree.length) {
              const t = setTimeout(() => signalPids(tree.filter(isPidAlive), 'SIGKILL'), signalKillAfterMs);
              if (typeof t.unref === 'function') t.unref();
            }
          }, idleCheckMs || Math.max(250, Math.min(60000, Math.floor(idleTimeoutMs / 4))))
        : null;
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();

    child.stdout.on('data', (buf) => {
      if (idleTimer) noteActivity('output');
      const text = buf.toString('utf8');
      stdout += text;
      if (logPath) appendRunLog(logPath, text);
      if (typeof onStdout === 'function') {
        try {
          onStdout(text);
        } catch (_) {
          /* ignore */
        }
      }
    });
    child.stderr.on('data', (buf) => {
      if (idleTimer) noteActivity('output');
      const text = buf.toString('utf8');
      stderr += text;
      if (typeof onStderr === 'function') {
        try {
          onStderr(text);
        } catch (_) {
          /* ignore */
        }
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      cleanupSignals();
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      cleanupSignals();
      if (logPath) {
        writeRunLogFooter(logPath, {
          stderr,
          code: interruptedBy ? signalExitCode(interruptedBy) : code,
          signal: interruptedBy || signal,
          timedOut,
        });
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        idleTimedOut,
        ...(idleTimedOut ? { idleTimeoutMs } : {}),
        pid,
        pgid,
        interruptedBy,
      });
    });
  });
}

function commandString(bin, argv) {
  return [bin, ...argv].map(escapeShellArg).join(' ');
}

/**
 * Tail-capped excerpt of engine/run output for --json payloads.
 * Caps at max chars (default 2000), preferring the end of the text.
 */
function outputExcerpt(text, max = 2000) {
  const s = String(text == null ? '' : text);
  const n = Math.max(0, Number(max) || 2000);
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}

module.exports = {
  runLogDir,
  newRunLogPath,
  writeRunLogHeader,
  appendRunLog,
  writeRunLogFooter,
  writeRunLog,
  recordInteractiveLaunch,
  encodePromptHeaderLine,
  spawnCaptured,
  commandString,
  outputExcerpt,
  signalExitCode,
  killProcessGroup,
  isPidAlive,
  descendantPids,
};
