'use strict';

/**
 * Hermetic test bootstrap (loaded via `node --import ./test/_setup.js`).
 * Ensures the suite never talks to a real Herdr core/app on the machine:
 * - AGENTFLEET_HC_BIN / AGENTFLEET_HERDR_APP_BIN → fail-closed stubs
 * - PATH: prepend stubs; strip ~/.local/bin and dirs that contain a real hc/herdr-app
 * - Short Herdr-app wait/poll budget
 *
 * Individual tests override *_BIN and/or prepend their own stub dir on PATH.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyGitEnvToProcess } = require('./git-helpers');

const hermeticDir = path.join(__dirname, 'fixtures', 'hermetic');
const stubHc = path.join(hermeticDir, 'hc');
const stubApp = path.join(hermeticDir, 'herdr-app');

function pathHasBin(dir, name) {
  if (!dir || dir === hermeticDir) return false;
  try {
    const p = path.join(dir, name);
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function sanitizePath(raw) {
  const delim = path.delimiter;
  const homeLocal = path.join(os.homedir(), '.local', 'bin');
  const parts = String(raw || '')
    .split(delim)
    .filter(Boolean)
    .filter((dir) => {
      const resolved = path.resolve(dir);
      if (resolved === path.resolve(homeLocal)) return false;
      if (resolved === path.resolve(hermeticDir)) return true;
      if (pathHasBin(resolved, 'hc') || pathHasBin(resolved, 'herdr-app')) return false;
      return true;
    });
  return [hermeticDir, ...parts].join(delim);
}

// A developer shell may export the fleet space, default engine, or model for
// live runs (docs/copilot-live-test.md). Those must not leak into the suite.
for (const key of [
  'AFLT_SPACE',
  'AGENTFLEET_ENGINE',
  'COPILOT_MODEL',
  'AGENTFLEET_COPILOT_FALLBACK_MODEL',
]) {
  delete process.env[key];
}

applyGitEnvToProcess();

process.env.AGENTFLEET_TEST_HERMETIC = '1';
process.env.AGENTFLEET_HC_BIN = stubHc;
process.env.AGENTFLEET_HERDR_APP_BIN = stubApp;
process.env.AGENTFLEET_HERDR_APP_WAIT_MS =
  process.env.AGENTFLEET_HERDR_APP_WAIT_MS || '50';
process.env.AF_HERDR_APP_ADOPT_WAIT_MS =
  process.env.AF_HERDR_APP_ADOPT_WAIT_MS || process.env.AGENTFLEET_HERDR_APP_WAIT_MS;
process.env.AF_HERDR_APP_RENAME_WAIT_MS =
  process.env.AF_HERDR_APP_RENAME_WAIT_MS || process.env.AGENTFLEET_HERDR_APP_WAIT_MS;
process.env.PATH = sanitizePath(process.env.PATH);
