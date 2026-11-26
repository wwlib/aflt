#!/usr/bin/env node
'use strict';

/**
 * Portable M0 seed for hello-aflt.
 *
 * When the game cwd has no package.json, copies examples/loops/hello-aflt-seeded/m0-seed/
 * into the cwd. If the tree already looks seeded, leaves files alone.
 * Always runs the smoke test afterward.
 *
 * Resolved relative to this script (definition directory), not the game cwd.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SEED_DIR = path.join(__dirname, 'm0-seed');
const MARKER = 'package.json';

function die(msg, code = 1) {
  process.stderr.write(`seed-m0: ${msg}\n`);
  process.exit(code);
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === '.' || name === '..') continue;
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function main() {
  const cwd = process.cwd();
  if (!fs.existsSync(SEED_DIR)) {
    die(`seed directory missing: ${SEED_DIR}`);
  }

  const marker = path.join(cwd, MARKER);
  let seeded = false;
  if (!fs.existsSync(marker)) {
    for (const name of fs.readdirSync(SEED_DIR)) {
      copyRecursive(path.join(SEED_DIR, name), path.join(cwd, name));
    }
    seeded = true;
    process.stdout.write(`seed-m0: copied M0 scaffold into ${cwd}\n`);
  } else {
    process.stdout.write('seed-m0: package.json present; leaving tree unchanged\n');
  }

  if (!fs.existsSync(path.join(cwd, 'server.js'))) {
    die('server.js missing after seed');
  }
  if (!fs.existsSync(path.join(cwd, 'test', 'smoke.test.js'))) {
    die('test/smoke.test.js missing after seed');
  }

  const testRun = spawnSync(
    process.execPath,
    ['--test', 'test/smoke.test.js'],
    { cwd, encoding: 'utf8', env: process.env }
  );
  if (testRun.stdout) process.stdout.write(testRun.stdout);
  if (testRun.stderr) process.stderr.write(testRun.stderr);
  if (testRun.status !== 0) {
    die(`smoke test failed (exit ${testRun.status})`, testRun.status || 1);
  }

  process.stdout.write(
    seeded ? 'seed-m0: ok (seeded + smoke green)\n' : 'seed-m0: ok (smoke green)\n'
  );
  process.exit(0);
}

main();
