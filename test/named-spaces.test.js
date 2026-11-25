'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const util = require('../lib/util');
const spaceLib = require('../lib/space');
const service = require('../lib/service');
const dashboard = require('../lib/dashboard');

describe('named spaces', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevSpace;
  let prevNotify;
  let prevProbe;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevSpace = process.env.AFLT_SPACE;
    prevNotify = process.env.AFLT_NOTIFY_URL;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-spaces-'));
    process.env.HOME = home;
    delete process.env.AGENTFLEET_HOME;
    delete process.env.AFLT_SPACE;
    delete process.env.AFLT_NOTIFY_URL;
    // Exact port numbers below: skip the live listening-port probe (covered in space-ports.test.js).
    prevProbe = process.env.AFLT_NO_PORT_PROBE;
    process.env.AFLT_NO_PORT_PROBE = '1';
    util.resetSpaceSelection();
  });

  afterEach(() => {
    util.resetSpaceSelection();
    if (prevProbe === undefined) delete process.env.AFLT_NO_PORT_PROBE;
    else process.env.AFLT_NO_PORT_PROBE = prevProbe;
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevSpace === undefined) delete process.env.AFLT_SPACE;
    else process.env.AFLT_SPACE = prevSpace;
    if (prevNotify === undefined) delete process.env.AFLT_NOTIFY_URL;
    else process.env.AFLT_NOTIFY_URL = prevNotify;
  });

  function af(args, extraEnv = {}) {
    const env = {
      ...process.env,
      HOME: home,
      // Hermetic: no real notify / identity bleed
      AFLT_NOTIFY_URL: '',
      AGENTFLEET_SESSION: '',
      AGENTFLEET_ID: '',
      ...extraEnv,
    };
    // Allow tests to unset AGENTFLEET_HOME by passing null
    if (Object.prototype.hasOwnProperty.call(extraEnv, 'AGENTFLEET_HOME') && extraEnv.AGENTFLEET_HOME == null) {
      delete env.AGENTFLEET_HOME;
    }
    if (Object.prototype.hasOwnProperty.call(extraEnv, 'AFLT_SPACE') && extraEnv.AFLT_SPACE == null) {
      delete env.AFLT_SPACE;
    }
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      cwd: home,
      env,
    });
  }

  it('no space equals today\'s fleetDir (default ~/.agentfleet)', () => {
    delete process.env.AGENTFLEET_HOME;
    delete process.env.AFLT_SPACE;
    util.resetSpaceSelection();
    assert.equal(util.fleetDir(), path.join(home, '.agentfleet'));
    const applied = util.applySpaceSelection({ env: process.env });
    assert.equal(applied.space, null);
    assert.equal(util.fleetDir(), path.join(home, '.agentfleet'));
  });

  it('--space and AFLT_SPACE resolve to ~/.agentfleet/spaces/NAME when AGENTFLEET_HOME unset', () => {
    delete process.env.AGENTFLEET_HOME;
    const viaFlag = util.applySpaceSelection({
      sawSpace: true,
      spaceFlag: 'lab',
      env: process.env,
    });
    assert.equal(viaFlag.space, 'lab');
    assert.equal(viaFlag.home, path.join(home, '.agentfleet', 'spaces', 'lab'));
    assert.equal(util.fleetDir(), path.join(home, '.agentfleet', 'spaces', 'lab'));
    assert.equal(util.currentSpaceName(), 'lab');

    util.resetSpaceSelection();
    delete process.env.AGENTFLEET_HOME;
    process.env.AFLT_SPACE = 'staging';
    const viaEnv = util.applySpaceSelection({ env: process.env });
    assert.equal(viaEnv.space, 'staging');
    assert.equal(util.fleetDir(), path.join(home, '.agentfleet', 'spaces', 'staging'));
  });

  it('flag wins over AFLT_SPACE', () => {
    delete process.env.AGENTFLEET_HOME;
    process.env.AFLT_SPACE = 'from-env';
    util.applySpaceSelection({
      sawSpace: true,
      spaceFlag: 'from-flag',
      env: process.env,
    });
    assert.equal(util.currentSpaceName(), 'from-flag');
    assert.equal(util.fleetDir(), path.join(home, '.agentfleet', 'spaces', 'from-flag'));
    assert.equal(process.env.AFLT_SPACE, 'from-flag');
  });

  it('explicit AGENTFLEET_HOME wins for the directory; space name still tracked', () => {
    const explicit = path.join(home, 'custom-fleet');
    process.env.AGENTFLEET_HOME = explicit;
    process.env.AFLT_SPACE = 'tracked';
    const applied = util.applySpaceSelection({ env: process.env });
    assert.equal(applied.space, 'tracked');
    assert.equal(applied.homeExplicit, true);
    assert.equal(util.fleetDir(), explicit);
    assert.equal(util.currentSpaceName(), 'tracked');
  });

  it('invalid space names fail clearly', () => {
    const bad = ['', '../x', 'a/b', 'a\\b', '..', '.hidden', '-bad', 'bad name', 'x..y'];
    for (const name of bad) {
      assert.throws(() => util.validateSpaceName(name), /invalid space name/i);
    }
    const r = af(['--space', '../evil', 'space', 'current'], { AGENTFLEET_HOME: null });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid space name/i);
  });

  it('stripSpaceFlag accepts any position and --space=VALUE', () => {
    const a = util.stripSpaceFlag(['ls', '--json', '--space', 'lab']);
    assert.deepEqual(a.argv, ['ls', '--json']);
    assert.equal(a.space, 'lab');
    assert.equal(a.sawSpace, true);

    const b = util.stripSpaceFlag(['--space=lab', 'doctor', '--json']);
    assert.deepEqual(b.argv, ['doctor', '--json']);
    assert.equal(b.space, 'lab');
  });

  it('create / list / current / remove', () => {
    const created = af(['space', 'create', 'lab', '--json'], { AGENTFLEET_HOME: null });
    assert.equal(created.status, 0, created.stderr + created.stdout);
    const j = JSON.parse(created.stdout);
    assert.equal(j.name, 'lab');
    assert.equal(j.path, path.join(home, '.agentfleet', 'spaces', 'lab'));
    assert.equal(j.notifyEnabled, false);
    assert.ok(j.port >= 8788, `expected port >= 8788, got ${j.port}`);
    assert.equal(j.serviceLabel, 'dev.aflt.dashboard.lab');
    assert.ok(fs.existsSync(path.join(j.path, 'config.json')));
    assert.ok(fs.existsSync(j.memoryRepo));
    assert.ok(j.memoryRepo.startsWith(j.path));

    const cfg = JSON.parse(fs.readFileSync(path.join(j.path, 'config.json'), 'utf8'));
    assert.equal(cfg.notify.enabled, false);
    assert.equal(cfg.dashboard.port, j.port);
    assert.equal(cfg.memoryRepo, j.memoryRepo);
    assert.equal(cfg.service.label, 'dev.aflt.dashboard.lab');

    const listed = af(['space', 'list', '--json'], { AGENTFLEET_HOME: null });
    assert.equal(listed.status, 0, listed.stderr);
    const lj = JSON.parse(listed.stdout);
    assert.equal(lj.default.current, true);
    assert.equal(lj.spaces.length, 1);
    assert.equal(lj.spaces[0].name, 'lab');

    // `space ls` is an alias of `space list` (the Herdr af sessions picker uses it).
    const ls = af(['space', 'ls', '--json'], { AGENTFLEET_HOME: null });
    assert.equal(ls.status, 0, ls.stderr);
    assert.deepEqual(JSON.parse(ls.stdout), lj);

    const curDefault = af(['space', 'current'], { AGENTFLEET_HOME: null });
    assert.equal(curDefault.status, 0);
    assert.match(curDefault.stdout, /\(default\)/);

    const curLab = af(['--space', 'lab', 'space', 'current'], { AGENTFLEET_HOME: null });
    assert.equal(curLab.status, 0, curLab.stderr);
    assert.equal(curLab.stdout.trim(), 'lab');

    // Non-empty without --force refuses
    const refuse = af(['space', 'remove', 'lab'], { AGENTFLEET_HOME: null });
    assert.notEqual(refuse.status, 0);
    assert.match(refuse.stderr, /not empty|--force/i);
    assert.ok(fs.existsSync(j.path));

    const removed = af(['space', 'remove', 'lab', '--force', '--json'], { AGENTFLEET_HOME: null });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(j.path), false);
  });

  it('remove never deletes the default home; rejects non-named targets', () => {
    const defaultHome = path.join(home, '.agentfleet');
    fs.mkdirSync(defaultHome, { recursive: true });
    fs.writeFileSync(path.join(defaultHome, 'config.json'), '{}\n');

    // "default" is not under spaces/ unless created as a named space
    const r = af(['space', 'remove', 'default', '--force'], { AGENTFLEET_HOME: null });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not found|not a named space/i);
    assert.ok(fs.existsSync(path.join(defaultHome, 'config.json')));
  });

  it('new spaces get unique ports and isolated memory; second space increments', () => {
    const a = spaceLib.createSpace('alpha');
    const b = spaceLib.createSpace('beta');
    assert.notEqual(a.port, b.port);
    assert.equal(a.port, 8788);
    assert.equal(b.port, 8789);
    assert.notEqual(a.memoryRepo, b.memoryRepo);
    assert.ok(a.memoryRepo.includes(`${path.sep}spaces${path.sep}alpha${path.sep}`));
    assert.ok(b.memoryRepo.includes(`${path.sep}spaces${path.sep}beta${path.sep}`));
  });

  it('service label/plist names differ by space; named space does not overwrite default plist', () => {
    spaceLib.createSpace('lab');
    util.applySpaceSelection({ sawSpace: true, spaceFlag: 'lab', env: process.env });

    const agentsDir = path.join(home, 'Library', 'LaunchAgents');
    const fake = {
      load() {
        return { status: 0, stdout: '', stderr: '' };
      },
      unload() {
        return { status: 0, stdout: '', stderr: '' };
      },
      list() {
        return { status: 0, stdout: '', stderr: '' };
      },
    };

    process.env.AFLT_NOTIFY_URL = 'https://example.invalid/hook';
    const named = service.install({
      platform: 'darwin',
      env: process.env,
      launchctl: fake,
      apply: true,
    });
    assert.equal(named.ok, true);
    assert.equal(named.label, 'dev.aflt.dashboard.lab');
    assert.equal(path.basename(named.path), 'dev.aflt.dashboard.lab.plist');
    assert.match(named.plist || fs.readFileSync(named.path, 'utf8'), /AFLT_SPACE/);
    assert.match(fs.readFileSync(named.path, 'utf8'), /dev\.aflt\.dashboard\.lab/);
    // notify off in space config → webhook env not copied
    assert.doesNotMatch(fs.readFileSync(named.path, 'utf8'), /AFLT_NOTIFY_URL/);
    assert.equal(fs.existsSync(path.join(agentsDir, 'dev.aflt.dashboard.plist')), false);

    util.resetSpaceSelection();
    delete process.env.AFLT_SPACE;
    delete process.env.AGENTFLEET_HOME;
    const def = service.install({
      platform: 'darwin',
      print: true,
      env: { ...process.env, AFLT_NOTIFY_URL: 'https://example.invalid/hook' },
      launchctl: fake,
    });
    assert.equal(def.label, 'dev.aflt.dashboard');
    assert.match(def.plist, /dev\.aflt\.dashboard<\/string>/);
    assert.doesNotMatch(def.plist, /dev\.aflt\.dashboard\./);
  });

  it('CLI and dashboard surface the non-default space name', () => {
    af(['space', 'create', 'lab'], { AGENTFLEET_HOME: null });
    const ls = af(['--space', 'lab', 'ls', '--json'], { AGENTFLEET_HOME: null });
    assert.equal(ls.status, 0, ls.stderr);
    const lj = JSON.parse(ls.stdout);
    assert.equal(lj.space, 'lab');
    assert.equal(lj.home, path.join(home, '.agentfleet', 'spaces', 'lab'));

    const doc = af(['--space', 'lab', 'doctor', '--json'], { AGENTFLEET_HOME: null });
    assert.equal(doc.status, 0, doc.stderr);
    const dj = JSON.parse(doc.stdout);
    const spaceCheck = (dj.checks || []).find((c) => c.name === 'space');
    assert.ok(spaceCheck);
    assert.equal(spaceCheck.detail, 'lab');

    // Dashboard state includes space
    util.applySpaceSelection({ sawSpace: true, spaceFlag: 'lab', env: process.env });
    const state = dashboard.aggregateDashboard({
      sessions: [],
      memoryRecords: [],
      memoryProjects: [],
      now: new Date().toISOString(),
    });
    assert.equal(state.space, 'lab');
    const svg = dashboard.renderSvg(state);
    assert.match(svg, /aflt live · lab/);
  });

  it('CLI --space mid-argv works for space current', () => {
    af(['space', 'create', 'mid'], { AGENTFLEET_HOME: null });
    const r = af(['space', 'current', '--space', 'mid', '--json'], { AGENTFLEET_HOME: null });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.space, 'mid');
  });

  it('dashboard port defaults from space config when --port omitted', () => {
    const created = spaceLib.createSpace('ports');
    util.applySpaceSelection({ sawSpace: true, spaceFlag: 'ports', env: process.env });
    assert.equal(spaceLib.resolveDashboardPort({}), created.port);
  });
});
