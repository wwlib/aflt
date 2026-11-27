'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const loopInit = require('../lib/loop-init');
const util = require('../lib/util');

describe('loop commands apply project space', () => {
  let home;
  let project;
  const prev = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-lps-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'af-lps-proj-'));
    for (const k of ['HOME', 'AGENTFLEET_HOME', 'AFLT_SPACE']) prev[k] = process.env[k];
    process.env.HOME = home;
    delete process.env.AGENTFLEET_HOME;
    delete process.env.AFLT_SPACE;
    const space = 'my-proj-space';
    const spaceDir = path.join(home, '.agentfleet', 'spaces', space);
    fs.mkdirSync(spaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(spaceDir, 'config.json'),
      JSON.stringify({ dashboardPort: 8791 })
    );
    fs.writeFileSync(
      path.join(project, '.agentfleet.json'),
      JSON.stringify({ project: 'my-proj', space, loop: '.agentfleet/loop.json' })
    );
    fs.mkdirSync(path.join(project, '.agentfleet'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.agentfleet', 'loop.json'),
      JSON.stringify(
        {
          name: 'my-proj',
          cwd: '.',
          engine: 'cursor',
          budget: { maxRuns: 1, maxHours: 1, maxPhases: 1 },
          phases: [{ id: 'm0', prompt: 'x', eval: { command: 'true' } }],
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('applyProjectSpaceIfNeeded selects .agentfleet.json space', () => {
    const r = loopInit.applyProjectSpaceIfNeeded(project);
    assert.equal(r.applied, true);
    assert.equal(r.space, 'my-proj-space');
    assert.equal(util.currentSpaceName(), 'my-proj-space');
  });

  it('loop validate from project dir uses recorded space (hermetic)', () => {
    const res = spawnSync(process.execPath, [afJs, 'loop', 'validate', '.agentfleet/loop.json', '--json'], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr + res.stdout);
  });
});