'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('aflt init (new looped project)', () => {
  let home;
  let work;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pi-home-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pi-work-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  function af(args, extra = {}) {
    const env = { ...process.env, HOME: home, ...extra };
    delete env.AGENTFLEET_HOME;
    delete env.AFLT_SPACE;
    return spawnSync(process.execPath, [afJs, ...args], { cwd: work, env, encoding: 'utf8', timeout: 30000 });
  }

  it('creates folder, git repo, space and starter docs non-interactively', () => {
    const res = af([
      'init', 'My App', '--yes', '--json', '--engine', 'cursor',
      '--goal', 'A dice roller CLI', '--stack', 'Node + node:test', '--checks', 'rolls are in range',
      '--budget-credits', '200', '--budget-hours', '3',
    ]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.project, 'my-app');
    const dir = path.join(work, 'my-app');
    assert.equal(fs.realpathSync(out.dir), fs.realpathSync(dir));
    assert.equal(out.git, 'initialized');
    assert.ok(fs.existsSync(path.join(dir, '.git')));
    assert.equal(out.space.name, 'my-app');
    assert.equal(out.space.created, true);
    assert.ok(fs.existsSync(path.join(home, '.agentfleet', 'spaces', 'my-app', 'config.json')));
    const spec = fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8');
    assert.match(spec, /A dice roller CLI/);
    assert.match(spec, /rolls are in range/);
    assert.match(spec, /up to 200 AI credits, up to 3 hours/);
    assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /Node \+ node:test/);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.agentfleet.json'), 'utf8'));
    assert.deepEqual(cfg, {
      project: 'my-app',
      space: 'my-app',
      engine: 'cursor',
      budget: { credits: 200, hours: 3 },
      loop: '.agentfleet/loop.json',
    });
    assert.ok(out.next.some((n) => /aflt --space my-app loop init --engine cursor/.test(n)));
  });

  it('keeps existing docs (and .agentfleet.json keys) unless --force', () => {
    const dir = path.join(work, 'seeded');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SPEC.md'), '# my own spec\n');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# my own agents\n');
    fs.writeFileSync(path.join(dir, '.agentfleet.json'), JSON.stringify({ project: 'keep-me', docs: true }));
    const res = af(['init', 'seeded', '--dir', dir, '--yes', '--json', '--space', 'seeded-space']);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.files.map((f) => f.action), ['kept', 'kept', 'updated']);
    assert.equal(fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8'), '# my own spec\n');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.agentfleet.json'), 'utf8'));
    assert.equal(cfg.project, 'keep-me');
    assert.equal(cfg.docs, true);
    assert.equal(cfg.space, 'seeded-space');
    assert.equal(out.space.name, 'seeded-space');

    const forced = af(['init', 'seeded', '--dir', dir, '--yes', '--json', '--force', '--no-space']);
    assert.equal(forced.status, 0, forced.stderr);
    const fo = JSON.parse(forced.stdout);
    assert.equal(fo.space, null);
    assert.deepEqual(fo.files.map((f) => f.action).slice(0, 2), ['overwritten', 'overwritten']);
    assert.match(fs.readFileSync(path.join(dir, 'SPEC.md'), 'utf8'), /## How we know it works/);
  });

  it('reuses an existing git repo and space; prints a readable summary', () => {
    const dir = path.join(work, 'again');
    assert.equal(af(['init', 'again', '--dir', dir, '--yes']).status, 0);
    const res = af(['init', 'again', '--dir', dir, '--yes']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /git: existing repo/);
    assert.match(res.stdout, /space: again \(existing\)/);
    assert.match(res.stdout, /kept\s+SPEC\.md/);
    assert.match(res.stdout, /aflt --space again loop init/);
  });

  it('loop init picks up the space recorded by aflt init (dry run)', () => {
    const dir = path.join(work, 'spacey');
    assert.equal(af(['init', 'spacey', '--dir', dir, '--yes', '--engine', 'copilot']).status, 0);
    const env = { ...process.env, HOME: home };
    delete env.AGENTFLEET_HOME;
    delete env.AFLT_SPACE;
    const res = spawnSync(process.execPath, [afJs, 'loop', 'init', '--dry-run', '--json'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.space, 'spacey');
    assert.equal(out.engine, 'copilot');
    assert.match(out.prompt, /Engine: copilot/);
  });

  it('usage error without a name', () => {
    const res = af(['init']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /usage: aflt init <name>/);
  });
});
