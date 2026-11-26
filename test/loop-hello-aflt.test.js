'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const exampleDir = path.join(repoRoot, 'examples', 'loops', 'hello-aflt');
const seedDir = path.join(exampleDir, 'seed');
const loopDirInSeed = path.join(seedDir, '.agentfleet');
const loopJson = path.join(loopDirInSeed, 'loop.json');
const checkScript = path.join(loopDirInSeed, 'checks', 'm0-check.cjs');
const gateScript = path.join(loopDirInSeed, 'checks', 'improve-gate.cjs');
const seededDir = path.join(repoRoot, 'examples', 'loops', 'hello-aflt-seeded');

/** Extensions that mean "code or markup", banned from the docs-only seed. */
const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.html', '.htm', '.css', '.svg', '.json', '.sh', '.py', '.wasm',
]);
/** The only .json allowed in the seed (config, not code). */
const CONFIG_JSON = new Set(['.agentfleet.json']);

function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-scratch-'));
}

/** A project folder seeded the documented way: cp -R seed/. <dir>, git init, commit. */
function seededProject() {
  const cwd = fs.realpathSync(tmpDir());
  fs.cpSync(seedDir, cwd, { recursive: true });
  spawnSync('git', ['init', '-q', cwd]);
  spawnSync('git', ['-C', cwd, 'add', '-A']);
  spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed']);
  return cwd;
}

function runCheck(cwd, args = []) {
  return spawnSync(process.execPath, [checkScript, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
}

describe('hello-aflt example (docs-only seed, everything inside the project)', () => {
  it('definition validates and dry-runs with seed-docs plus seeded milestones', () => {
    const loop = require('../lib/loop');
    const raw = JSON.parse(fs.readFileSync(loopJson, 'utf8'));
    const seeded = JSON.parse(fs.readFileSync(path.join(seededDir, 'hello-aflt.json'), 'utf8'));
    assert.equal(raw.name, 'hello-aflt');
    assert.ok(!Object.prototype.hasOwnProperty.call(raw, 'engine') || raw.engine == null);
    assert.ok(!JSON.stringify(raw).includes('/tmp/'));
    assert.ok(!JSON.stringify(raw).includes('m0-seed'));
    assert.ok(!JSON.stringify(raw).includes('seed-m0'));
    assert.deepEqual(
      raw.phases.map((p) => p.id),
      ['seed-docs', ...seeded.phases.map((p) => p.id)]
    );
    const seedPhase = raw.phases[0];
    assert.equal(seedPhase.type, 'script');
    assert.deepEqual(seedPhase.eval.command, ['node', '.agentfleet/checks/m0-check.cjs', '--seed-docs']);
    assert.equal(seedPhase.onPass, 'none');
    assert.deepEqual(raw.workdir, { mode: 'project' });
    assert.deepEqual(raw.protected, { paths: ['.agentfleet/**'] });
    const m0Raw = raw.phases.find((p) => p.id === 'm0');
    assert.ok(!m0Raw.type || m0Raw.type === 'run', 'm0 must be an AI build phase');
    for (const p of raw.phases.filter((x) => x.type !== 'script')) {
      assert.match(p.session, /^hello-aflt-/, p.id);
    }
    assert.equal(raw.allow.push, false);
    assert.equal(raw.allow.merge, false);

    // Seeded project: the loop, prompts and checks all resolve inside it.
    const cwd = seededProject();
    const file = path.join(cwd, '.agentfleet', 'loop.json');
    const result = loop.validateFile(file, { cwdBase: cwd });
    assert.equal(result.ok, true, (result.errors || []).join('; '));
    assert.deepEqual(result.warnings.filter((w) => /outside the project/.test(w)), []);
    for (const p of result.definition.phases.filter((x) => x.type !== 'script')) {
      assert.ok(p.promptFile && p.promptFile.startsWith(cwd + path.sep), p.promptFile);
      assert.ok(fs.existsSync(p.promptFile), p.promptFile);
    }
    const m0 = result.definition.phases.find((p) => p.id === 'm0');
    assert.deepEqual(m0.eval.command, ['node', '.agentfleet/checks/m0-check.cjs']);
    assert.ok(m0.maxFixAttempts >= 1);
    assert.deepEqual(require('../lib/loop-snapshot').outsidePaths(result.definition), []);

    const plan = loop.planDryRun(result.definition, file);
    assert.equal(plan.ok, true);
    assert.equal(plan.name, 'hello-aflt');
    assert.equal(raw.project, 'hello-aflt');
    assert.ok(plan.phases.length >= 7);
  });

  it('seed contains only instructions, config and the loop with its checks: no game code, no HTML', () => {
    const all = listFiles(seedDir);
    const tooling = all.filter((f) => f.startsWith('.agentfleet/'));
    assert.deepEqual(
      tooling.filter((f) => !/^\.agentfleet\/prompts\/[^/]+\.txt$/.test(f)),
      ['.agentfleet/checks/improve-gate.cjs', '.agentfleet/checks/m0-check.cjs', '.agentfleet/loop.json']
    );
    const files = all.filter((f) => !f.startsWith('.agentfleet/'));
    assert.deepEqual(files, ['.agentfleet.json', '.gitignore', 'AGENTS.md', 'SPEC.md']);
    for (const rel of files) {
      const base = path.basename(rel);
      const ext = path.extname(base).toLowerCase();
      if (CONFIG_JSON.has(base)) {
        // Config only: a flat object of strings, nothing executable.
        const cfg = JSON.parse(fs.readFileSync(path.join(seedDir, rel), 'utf8'));
        for (const v of Object.values(cfg)) assert.equal(typeof v, 'string', rel);
        continue;
      }
      assert.ok(!CODE_EXTS.has(ext), `code/markup file in seed: ${rel}`);
      assert.ok(base === '.gitignore' || ext === '.md' || ext === '.txt', `unexpected seed file: ${rel}`);
    }
    // Markdown must not smuggle a full scaffold in as fenced code.
    for (const rel of files.filter((f) => f.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(seedDir, rel), 'utf8');
      assert.ok(!/```(js|javascript|html|mjs|ts)\b/i.test(text), `${rel} embeds code`);
      assert.ok(!/<!DOCTYPE html>/i.test(text), `${rel} embeds HTML`);
    }
    const spec = fs.readFileSync(path.join(seedDir, 'SPEC.md'), 'utf8');
    assert.match(spec, /M0 — Scaffold/);
    assert.match(spec, /8792/);
    assert.match(spec, /createServer/);
  });

  it('m0-check guards the seed allowlist', () => {
    const { isAllowedSeedFile } = require(checkScript);
    for (const ok of ['AGENTS.md', 'SPEC.md', 'notes.txt', '.gitignore', '.agentfleet.json', '.agentfleet/loop.json', '.agentfleet/prompts/M0.txt', '.agentfleet/checks/m0-check.cjs', '.agentfleet/checks/improve-gate.cjs']) {
      assert.equal(isAllowedSeedFile(ok), true, ok);
    }
    for (const bad of ['server.js', 'src/main.js', 'public/index.html', 'package.json', 'a.ts', 'x.css', 'm.mjs', '.agentfleet/checks/game.js', '.agentfleet/other.json']) {
      assert.equal(isAllowedSeedFile(bad), false, bad);
    }
  });

  it('prompts make M0 a real build and never assume seed code', () => {
    const read = (n) => fs.readFileSync(path.join(loopDirInSeed, 'prompts', n), 'utf8');
    const m0 = read('M0.txt');
    assert.ok(!/do nothing heavy/i.test(m0));
    assert.ok(!/seed-m0/.test(m0));
    assert.ok(!/m0-seed/.test(m0));
    assert.match(m0, /FROM SCRATCH/);
    assert.match(m0, /package\.json/);
    assert.match(m0, /"type": "module"/);
    assert.match(m0, /8792/);
    assert.match(m0, /public\/index\.html/);
    assert.match(m0, /<canvas id="game"/);
    assert.match(m0, /src\/main\.js/);
    assert.match(m0, /test\/smoke\.test\.js/);
    assert.match(m0, /node:test/);
    assert.match(m0, /Work only inside this repo/);
    assert.match(m0, /Do not commit/);
    for (const n of ['M1.txt', 'M2.txt', 'M3.txt', 'M4.txt', 'M5a.txt']) {
      const text = read(n);
      assert.match(text, /no seed code/, n);
      assert.match(text, /SPEC\.md/, n);
      assert.ok(!/seed-m0/.test(text), n);
      assert.match(text, /Do not commit/, n);
    }
    const m5a = read('M5a.txt');
    assert.match(m5a, /crash_free/);
    assert.match(m5a, /AVG_DEPTH_TARGET\s*=\s*3\.5/);

    const planNext = read('plan-next.txt');
    assert.match(planNext, /hello-aflt-rN/);
    assert.match(planNext, /"command": \["node", "\.agentfleet\/checks\/improve-gate\.cjs"\]/);
    assert.ok(!/"\.\.\//.test(planNext), 'no ../ paths in the planner prompt');
    for (const n of ['M0.txt', 'M1.txt', 'M2.txt', 'M3.txt', 'M4.txt', 'M5a.txt', 'plan-next.txt']) {
      const text = read(n);
      assert.ok(!/~\/|\/Users\/|examples\/loops/.test(text), `${n} names a folder outside the project`);
    }
    // The planned check stays inside the project, so aflt accepts it.
    const esc = require('../lib/loop-snapshot').escapingTokens(['node', '.agentfleet/checks/improve-gate.cjs'], '/p/proj');
    assert.deepEqual(esc, []);
    // The in-project gate is the original gate plus a header.
    const body = (t) => t.slice(t.indexOf("const fs = require('fs');"));
    assert.equal(body(fs.readFileSync(gateScript, 'utf8')), body(fs.readFileSync(path.join(seededDir, 'improve-gate.js'), 'utf8')));
  });

  it('m0-check --seed-docs accepts the seed and refuses anything else in the repo', () => {
    const cwd = seededProject();
    const ok = runCheck(cwd, ['--seed-docs']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /seed ok/);
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'old-game.js'), '// left over\n');
    const bad = runCheck(cwd, ['--seed-docs']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not part of the seed: src\/old-game\.js/);
    const empty = runCheck(tmpDir(), ['--seed-docs']);
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /missing AGENTS\.md/);
  });

  it('every seed file is tracked by git (the repo ignores .agentfleet/ folders elsewhere)', () => {
    const { spawnSync } = require('child_process');
    const repo = path.join(__dirname, '..');
    for (const rel of ['loop.json', 'checks/m0-check.cjs', 'checks/improve-gate.cjs', 'prompts/plan-next.txt']) {
      const file = path.join(loopDirInSeed, rel);
      const r = spawnSync('git', ['check-ignore', '-q', file], { cwd: repo });
      assert.notEqual(r.status, 0, rel + ' is git-ignored');
    }
  });

  it('the in-project checks still run when the game sets "type": "module"', () => {
    const cwd = seededProject();
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'g', type: 'module' }) + '\n');
    const { spawnSync } = require('child_process');
    for (const script of ['.agentfleet/checks/m0-check.cjs', '.agentfleet/checks/improve-gate.cjs']) {
      const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 60000 });
      const out = String(r.stdout || '') + String(r.stderr || '');
      assert.doesNotMatch(out, /require is not defined|ERR_REQUIRE_ESM|ReferenceError/, script + ': ' + out);
    }
    const r = spawnSync(process.execPath, ['.agentfleet/checks/m0-check.cjs'], { cwd, encoding: 'utf8' });
    assert.match(String(r.stderr), /m0-check: /);
  });

  it('m0-check fails on a docs-only tree and copies no code in', () => {
    const cwd = tmpDir();
    const r = runCheck(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing package\.json/);
    assert.match(r.stderr, /missing server\.js/);
    assert.ok(!fs.existsSync(path.join(cwd, 'package.json')));
    assert.ok(!fs.existsSync(path.join(cwd, 'server.js')));
  });

  it('m0-check flags a scaffold that breaks the spec', () => {
    const cwd = tmpDir();
    fs.mkdirSync(path.join(cwd, 'test'));
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'jest' }, dependencies: { express: '1' } })
    );
    fs.writeFileSync(path.join(cwd, 'server.js'), "const http = require('http');\n");
    fs.writeFileSync(path.join(cwd, 'test', 'smoke.test.js'), '// empty\n');
    const r = runCheck(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"type" must be "module"/);
    assert.match(r.stderr, /must run node --test/);
    assert.match(r.stderr, /dependencies must be empty/);
    assert.match(r.stderr, /8792/);
    assert.match(r.stderr, /named export createServer/);
  });

  it('m0-check passes an agent-built scaffold (tests + server boot)', () => {
    // Stand-in for what an M0 agent writes: the hello-aflt-seeded scaffold.
    const cwd = seededProject();
    fs.cpSync(path.join(seededDir, 'm0-seed'), cwd, { recursive: true });
    const r = runCheck(cwd);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /m0-check: ok/);
  });

  it('install.sh and docs lead with from-scratch hello-aflt', () => {
    const quick = fs.readFileSync(path.join(repoRoot, 'docs', 'cli-quickstart-loops.md'), 'utf8');
    assert.match(quick, /hello-aflt\/seed/);
    assert.match(quick, /seed-docs/);
    assert.ok(!quick.includes('hello-aflt-scratch'));
    const readme = fs.readFileSync(path.join(exampleDir, 'README.md'), 'utf8');
    assert.match(readme, /git init/);
    assert.match(readme, /install\.sh/);
    assert.match(readme, /loop run \.agentfleet\/loop\.json/);
    assert.match(readme, /no code/i);
    const install = path.join(exampleDir, 'install.sh');
    assert.ok(fs.existsSync(install));
    assert.equal(fs.statSync(install).mode & 0o111, 0o111);
    const seededReadme = fs.readFileSync(path.join(seededDir, 'README.md'), 'utf8');
    assert.match(seededReadme, /Non-default|non-default/i);
  });
});
