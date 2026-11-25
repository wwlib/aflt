'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const install = require('../lib/herdrappinstall');

function writeTree(root) {
  const mod = path.join(root, 'herdr', 'mods', 'af-sessions');
  const layouts = path.join(root, 'herdr', 'layouts');
  fs.mkdirSync(mod, { recursive: true });
  fs.mkdirSync(layouts, { recursive: true });
  fs.writeFileSync(path.join(mod, 'mod.json'), '{"place":"none","title":"af sessions"}\n');
  fs.writeFileSync(path.join(mod, 'main.js'), 'export default class X {}\n');
  fs.writeFileSync(path.join(layouts, 'af.json'), '{"id":"root"}\n');
  return {
    mod,
    layout: path.join(layouts, 'af.json'),
  };
}

describe('herdrappinstall', () => {
  let tmp;
  let srcRoot;
  let home;
  let sources;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-herdrapp-'));
    srcRoot = path.join(tmp, 'repo');
    home = path.join(tmp, 'herdr-home');
    sources = writeTree(srcRoot);
    fs.mkdirSync(path.join(home, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(home, 'layouts'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolveAppHome respects HERDR_APP_HOME', () => {
    assert.equal(
      install.resolveAppHome({ HERDR_APP_HOME: home }),
      path.resolve(home)
    );
  });

  it('status reports missing then linked after install', () => {
    let st = install.status({ home, sources, root: srcRoot });
    assert.equal(st.items[0].state, 'missing');
    assert.equal(st.items[1].state, 'missing');

    const r = install.install({ home, sources, root: srcRoot });
    assert.equal(r.ok, true);
    assert.ok(r.actions.some((a) => a.action === 'link'));

    st = install.status({ home, sources, root: srcRoot });
    assert.equal(st.items.find((i) => i.kind === 'mod').state, 'linked');
    assert.equal(st.items.find((i) => i.kind === 'layout').state, 'linked');
    assert.ok(install.isSymlinkTo(path.join(home, 'mods', 'af-sessions'), sources.mod));
  });

  it('install is idempotent when already linked', () => {
    install.install({ home, sources, root: srcRoot });
    const r = install.install({ home, sources, root: srcRoot });
    assert.equal(r.ok, true);
    assert.ok(r.actions.every((a) => a.action === 'ok'));
  });

  it('--copy installs files; status reports copied', () => {
    const r = install.install({ home, sources, root: srcRoot, copy: true });
    assert.equal(r.ok, true);
    const modDest = path.join(home, 'mods', 'af-sessions');
    assert.equal(fs.lstatSync(modDest).isSymbolicLink(), false);
    assert.equal(
      fs.readFileSync(path.join(modDest, 'main.js'), 'utf8'),
      fs.readFileSync(path.join(sources.mod, 'main.js'), 'utf8')
    );
    const st = install.status({ home, sources, root: srcRoot });
    assert.equal(st.items.find((i) => i.kind === 'mod').state, 'copied');
    assert.equal(st.items.find((i) => i.kind === 'layout').state, 'copied');
  });

  it('--copy status notices drift in helper modules (afspace.js), not just main.js', () => {
    fs.writeFileSync(path.join(sources.mod, 'afspace.js'), 'export const A = 1;\n');
    install.install({ home, sources, root: srcRoot, copy: true });
    const modDest = path.join(home, 'mods', 'af-sessions');
    assert.ok(fs.existsSync(path.join(modDest, 'afspace.js')));
    let st = install.status({ home, sources, root: srcRoot });
    assert.equal(st.items.find((i) => i.kind === 'mod').state, 'copied');
    fs.writeFileSync(path.join(sources.mod, 'afspace.js'), 'export const A = 2;\n');
    st = install.status({ home, sources, root: srcRoot });
    assert.equal(st.items.find((i) => i.kind === 'mod').state, 'other');
  });

  it('refuses overwrite of different content without --force', () => {
    const destMod = path.join(home, 'mods', 'af-sessions');
    fs.mkdirSync(destMod, { recursive: true });
    fs.writeFileSync(path.join(destMod, 'mod.json'), '{"place":"left"}\n');
    fs.writeFileSync(path.join(destMod, 'main.js'), 'other\n');
    fs.writeFileSync(path.join(home, 'layouts', 'af.json'), '{"id":"other"}\n');

    const r = install.install({ home, sources, root: srcRoot });
    assert.equal(r.ok, false);
    assert.ok(r.actions.some((a) => a.action === 'skip'));
    assert.equal(fs.readFileSync(path.join(destMod, 'main.js'), 'utf8'), 'other\n');
  });

  it('--force backs up then replaces', () => {
    const destLayout = path.join(home, 'layouts', 'af.json');
    fs.writeFileSync(destLayout, '{"id":"other"}\n');
    const r = install.install({ home, sources, root: srcRoot, force: true });
    assert.equal(r.ok, true);
    assert.ok(r.actions.some((a) => a.action === 'backup'));
    const baks = fs.readdirSync(path.join(home, 'layouts')).filter((f) => f.startsWith('af.json.bak-'));
    assert.equal(baks.length, 1);
    assert.equal(fs.readFileSync(path.join(home, 'layouts', baks[0]), 'utf8'), '{"id":"other"}\n');
    assert.ok(install.isSymlinkTo(destLayout, sources.layout));
  });

  it('--dry-run does not create files', () => {
    const r = install.install({ home, sources, root: srcRoot, dryRun: true });
    assert.equal(r.ok, true);
    assert.ok(r.actions.some((a) => a.action === 'would-link'));
    assert.equal(fs.existsSync(path.join(home, 'mods', 'af-sessions')), false);
    assert.equal(fs.existsSync(path.join(home, 'layouts', 'af.json')), false);
  });

  it('af herdr-app status / install --dry-run CLI', () => {
    const afJs = path.join(__dirname, '..', 'bin', 'af.js');
    const env = {
      ...process.env,
      HERDR_APP_HOME: home,
    };
    // Point sources at real repo paths via cwd; CLI uses repoRoot from lib location.
    // Dry-run against real sources but a temp HERDR_APP_HOME is enough.
    const status = spawnSync(process.execPath, [afJs, 'herdr-app', 'status'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /mod\s+missing/);
    assert.match(status.stdout, /layout\s+missing/);
    assert.match(status.stdout, new RegExp(`home: ${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const dry = spawnSync(process.execPath, [afJs, 'herdr-app', 'install', '--dry-run'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\[dry-run\] would-link/);
    assert.equal(fs.existsSync(path.join(home, 'mods', 'af-sessions')), false);
  });
});
