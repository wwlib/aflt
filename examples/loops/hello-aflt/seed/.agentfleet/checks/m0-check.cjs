#!/usr/bin/env node
'use strict';

/**
 * M0 check for hello-aflt (portable Node, zero deps).
 *
 * Lives inside the project (.agentfleet/checks/), next to the loop, so a run
 * never needs files outside the project folder. It never copies code: the M0
 * agent writes the scaffold from SPEC.md and this script checks it.
 *
 *   node .agentfleet/checks/m0-check.cjs --seed-docs
 *       verify the repo holds only the seed (AGENTS.md, SPEC.md,
 *       .agentfleet.json, .gitignore and .agentfleet/: loop, prompts, checks)
 *       and nothing else, so no pre-existing code leaks into a from-scratch run
 *   node .agentfleet/checks/m0-check.cjs
 *       verify the agent-built scaffold structurally, run its node:test suite,
 *       and boot server.js once
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

/** Seed: instructions, config and the loop's own check tooling. No game code, no HTML. */
const SEED_ALLOWED_NAMES = new Set(['.agentfleet.json', '.gitignore']);
const SEED_ALLOWED_EXTS = new Set(['.md', '.txt']);
const SEED_TOOLING = new Set([
  '.agentfleet/loop.json',
  '.agentfleet/checks/m0-check.cjs',
  '.agentfleet/checks/improve-gate.cjs',
]);
const SEED_REQUIRED = ['AGENTS.md', 'SPEC.md', '.agentfleet/loop.json'];

function isAllowedSeedFile(relPath) {
  const rel = String(relPath).split(path.sep).join('/');
  if (SEED_TOOLING.has(rel)) return true;
  if (/^\.agentfleet\/prompts\/[^/]+\.txt$/.test(rel)) return true;
  if (rel.startsWith('.agentfleet/')) return false;
  const base = path.basename(rel);
  if (SEED_ALLOWED_NAMES.has(base)) return true;
  return SEED_ALLOWED_EXTS.has(path.extname(base).toLowerCase());
}

function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!prefix && name === '.git') continue;
    if (name === '.DS_Store') continue;
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

/** Problems with the seed: missing docs, or files that are not part of it. */
function checkSeed(cwd) {
  const problems = [];
  for (const rel of SEED_REQUIRED) {
    if (!fs.existsSync(path.join(cwd, rel))) problems.push(`missing ${rel}`);
  }
  for (const rel of listFiles(cwd)) {
    if (!isAllowedSeedFile(rel)) problems.push(`not part of the seed: ${rel} (a from-scratch repo starts from the docs only)`);
  }
  return problems;
}

function readText(cwd, rel) {
  try {
    return fs.readFileSync(path.join(cwd, rel), 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Structural checks against SPEC.md § M0. Returns a list of problems.
 */
function checkScaffold(cwd) {
  const problems = [];
  const need = (rel) => {
    const text = readText(cwd, rel);
    if (text == null) problems.push(`missing ${rel}`);
    return text;
  };

  const pkgText = need('package.json');
  if (pkgText != null) {
    let pkg = null;
    try {
      pkg = JSON.parse(pkgText);
    } catch (err) {
      problems.push(`package.json is not valid JSON: ${err.message}`);
    }
    if (pkg) {
      if (pkg.type !== 'module') problems.push('package.json "type" must be "module"');
      const scripts = pkg.scripts || {};
      if (!/node\s+--test/.test(String(scripts.test || ''))) {
        problems.push('package.json scripts.test must run node --test');
      }
      if (!/node\s+server\.js/.test(String(scripts.start || ''))) {
        problems.push('package.json scripts.start must run node server.js');
      }
      for (const key of ['dependencies', 'devDependencies']) {
        if (pkg[key] && Object.keys(pkg[key]).length) {
          problems.push(`package.json ${key} must be empty (zero-dependency)`);
        }
      }
    }
  }

  const server = need('server.js');
  if (server != null) {
    if (!/8792/.test(server)) problems.push('server.js must default PORT to 8792');
    if (!/127\.0\.0\.1/.test(server)) problems.push('server.js must bind 127.0.0.1 by default');
    if (!/export\s+(function|const|async function)\s+createServer|export\s*\{[^}]*createServer/.test(server)) {
      problems.push('server.js must have a named export createServer() (not export default)');
    }
    if (/require\(/.test(server)) problems.push('server.js must be ESM (no require())');
  }

  const html = need('public/index.html');
  if (html != null) {
    if (!/<canvas[^>]*id=["']game["']/i.test(html)) problems.push('public/index.html needs <canvas id="game">');
    if (!/<script[^>]*type=["']module["'][^>]*src=["']\/src\/main\.js["']/i.test(html)) {
      problems.push('public/index.html must load /src/main.js as a module');
    }
  }

  need('src/main.js');

  const smoke = need('test/smoke.test.js');
  if (smoke != null) {
    if (!/node:test/.test(smoke)) problems.push('test/smoke.test.js must use node:test');
    if (!/createServer/.test(smoke)) problems.push('test/smoke.test.js must exercise createServer');
  }

  const readme = need('README.md');
  if (readme != null && !/8792/.test(readme)) problems.push('README.md must document port 8792');
  need('AGENTS.md');
  need('SPEC.md');
  return problems;
}

function testFiles(cwd) {
  const dir = path.join(cwd, 'test');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.test.js'))
    .sort()
    .map((n) => path.join('test', n));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function get(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, body: '', error: err.message }));
  });
}

/** Start `node server.js` on a free port, hit /health and /, stop that PID. */
async function bootCheck(cwd) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (c) => {
    output += c;
  });
  child.stderr.on('data', (c) => {
    output += c;
  });
  const problems = [];
  try {
    let health = null;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode != null) break;
      health = await get(port, '/health');
      if (health.status) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!health || health.status !== 200) {
      problems.push(`node server.js: /health not 200 on port ${port} (${output.trim().slice(-300)})`);
    } else {
      let ok = false;
      try {
        ok = JSON.parse(health.body).ok === true;
      } catch (_) {
        ok = false;
      }
      if (!ok) problems.push('/health must return {"ok":true}');
      const index = await get(port, '/');
      if (index.status !== 200 || !/<canvas[^>]*id=["']game["']/i.test(index.body)) {
        problems.push('GET / must serve index.html with <canvas id="game">');
      }
      const main = await get(port, '/src/main.js');
      if (main.status !== 200) problems.push('GET /src/main.js must return 200');
    }
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
  }
  return problems;
}

async function main(argv = process.argv.slice(2)) {
  const cwd = process.cwd();
  const log = (msg) => process.stdout.write(`${msg}\n`);
  const fail = (msg, code = 1) => {
    process.stderr.write(`m0-check: ${msg}\n`);
    process.exit(code);
  };

  if (argv.includes('--seed-docs')) {
    const seedProblems = checkSeed(cwd);
    if (seedProblems.length) fail(`seed check failed:\n  - ${seedProblems.join('\n  - ')}`);
    log('m0-check: seed ok (docs, loop and checks only; no code)');
    process.exit(0);
  }

  const problems = checkScaffold(cwd);
  if (problems.length) {
    fail(`scaffold incomplete (see SPEC.md § M0):\n  - ${problems.join('\n  - ')}`);
  }

  const files = testFiles(cwd);
  if (!files.includes(path.join('test', 'smoke.test.js'))) fail('test/smoke.test.js missing');
  const testRun = spawnSync(process.execPath, ['--test', ...files], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: 120000,
  });
  if (testRun.stdout) process.stdout.write(testRun.stdout);
  if (testRun.stderr) process.stderr.write(testRun.stderr);
  if (testRun.status !== 0) fail(`node --test failed (exit ${testRun.status})`, testRun.status || 1);

  const bootProblems = await bootCheck(cwd);
  if (bootProblems.length) fail(`server boot check failed:\n  - ${bootProblems.join('\n  - ')}`);

  log(`m0-check: ok (agent-built scaffold, ${files.length} test file(s) green, server boots)`);
  process.exit(0);
}

module.exports = {
  isAllowedSeedFile,
  checkSeed,
  checkScaffold,
  listFiles,
};

if (require.main === module) {
  main();
}
