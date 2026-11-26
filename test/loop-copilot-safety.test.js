'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const repoRoot = path.join(__dirname, '..');

function clearMods() {
  for (const name of ['../lib/loop', '../lib/config', '../lib/registry', '../lib/copilot', '../lib/usage', '../lib/turns']) {
    try {
      delete require.cache[require.resolve(name)];
    } catch (_) {
      /* ignore */
    }
  }
}

function gitInit(dir) {
  const r = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

describe('loop copilot safety', () => {
  let home;
  let cwd;
  let stubDir;
  let prev;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-safe-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-safe-cwd-'));
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-safe-stub-'));
    prev = {
      HOME: process.env.HOME,
      AGENTFLEET_HOME: process.env.AGENTFLEET_HOME,
      AGENTFLEET_CURSOR_BIN: process.env.AGENTFLEET_CURSOR_BIN,
      AGENTFLEET_COPILOT_BIN: process.env.AGENTFLEET_COPILOT_BIN,
      AGENTFLEET_COPILOT_HOME: process.env.AGENTFLEET_COPILOT_HOME,
      COPILOT_MODEL: process.env.COPILOT_MODEL,
      AFLT_MEMORY_REPO: process.env.AFLT_MEMORY_REPO,
    };
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.COPILOT_MODEL;
    delete process.env.AFLT_MEMORY_REPO;
    delete process.env.AGENTFLEET_CURSOR_BIN;
    delete process.env.AGENTFLEET_COPILOT_BIN;
    delete process.env.AGENTFLEET_COPILOT_HOME;
  });

  afterEach(() => {
    clearMods();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function enforcedEnv(extra = {}) {
    const env = {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: home,
      ...extra,
    };
    delete env.AGENTFLEET_TEST_HERMETIC;
    return env;
  }

  function writeDef(body) {
    const file = path.join(stubDir, `${body.name}.json`);
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
  }

  function phase(overrides = {}) {
    return {
      id: 'p1',
      session: 'loop-p1',
      prompt: 'do the work',
      eval: { command: ['true'], exitCode: 0 },
      maxFixAttempts: 0,
      onPass: 'none',
      ...overrides,
    };
  }

  it('does not pass a phase when the worker exits 1 and the eval is green', async () => {
    gitInit(cwd);
    const stub = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'process.stdout.write(require("crypto").randomUUID()+"\\n")'
  exit 0
fi
echo "agent blew up" >&2
exit 1
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(cwd, 'ALREADY.txt'), 'green\n');
    process.env.AGENTFLEET_CURSOR_BIN = stub;
    // The eval would pass if it ran; the tree is dirty so allow the folder.
    const file = writeDef({
      name: 'agent-fail',
      cwd,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 5, maxHours: 1 },
      phases: [
        phase({
          eval: { command: ['grep', '-x', 'green', 'ALREADY.txt'], exitCode: 0 },
          force: true,
        }),
      ],
    });
    const loop = require('../lib/loop');
    const result = await loop.runFromFile(file, {
      env: enforcedEnv({ AGENTFLEET_CURSOR_BIN: stub }),
      checkWorkdir: true,
      allowExisting: true,
    });
    assert.equal(result.ok, false, result.error);
    assert.equal(result.status, 'failed');
    const state = loop.loadState('agent-fail');
    assert.equal(state.phases.p1.status, 'failed');
    assert.notEqual(state.phases.p1.status, 'passed');
    assert.match(state.lastError || '', /agent exited 1/);
    assert.equal(state.runsUsed, 1);
  });

  it('creates results/ before Copilot --add-dir from an empty home', async () => {
    gitInit(cwd);
    const log = path.join(stubDir, 'args.log');
    const copilotHome = path.join(home, 'copilot-home');
    const stub = path.join(stubDir, 'copilot');
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${log}"
echo '---' >> "${log}"
args=("$@")
i=0
while [[ $i -lt \${#args[@]} ]]; do
  if [[ \${args[$i]} == --add-dir ]]; then
    dir=\${args[$((i+1))]}
    if [[ ! -d $dir ]]; then
      echo "error: option '--add-dir $dir' is invalid. Directory does not exist" >&2
      exit 1
    fi
  fi
  i=$((i+1))
done
echo stub-ok
exit 0
`,
      { mode: 0o755 }
    );
    process.env.AGENTFLEET_COPILOT_BIN = stub;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    assert.equal(fs.existsSync(path.join(home, 'results')), false);
    const file = writeDef({
      name: 'empty-home',
      cwd,
      engine: 'copilot',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 4, maxHours: 1 },
      phases: [phase({ force: true })],
    });
    const loop = require('../lib/loop');
    const result = await loop.runFromFile(file, {
      env: enforcedEnv({
        AGENTFLEET_COPILOT_BIN: stub,
        AGENTFLEET_COPILOT_HOME: copilotHome,
      }),
      checkWorkdir: true,
    });
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    assert.equal(result.status, 'completed');
    assert.equal(fs.existsSync(path.join(home, 'results')), true);
    const logged = fs.readFileSync(log, 'utf8');
    assert.match(logged, /--add-dir/);
  });

  it('resolves model from the definition, COPILOT_MODEL, then config', async () => {
    const loop = require('../lib/loop');
    const bad = loop.validateDefinition({
      name: 'bad-model',
      cwd,
      engine: 'copilot',
      phases: [phase({ model: 'not a model' })],
    }, { checkCwd: false });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('\n'), /model/);

    const def = {
      name: 'with-model',
      cwd,
      engine: 'copilot',
      model: 'from-definition',
      phases: [phase()],
    };
    const validated = loop.validateDefinition(def, { checkCwd: false, env: enforcedEnv() });
    assert.equal(validated.ok, true, (validated.errors || []).join('; '));
    assert.equal(
      loop.resolvePhaseModel(validated.definition.phases[0], validated.definition, enforcedEnv({
        COPILOT_MODEL: 'from-env',
      })),
      'from-definition'
    );

    const bare = loop.validateDefinition(
      { ...def, model: undefined, name: 'bare-model' },
      { checkCwd: false }
    );
    assert.equal(
      loop.resolvePhaseModel(bare.definition.phases[0], bare.definition, enforcedEnv({
        COPILOT_MODEL: 'from-env',
      })),
      'from-env'
    );

    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ defaultModel: 'from-config' }) + '\n'
    );
    clearMods();
    const loop2 = require('../lib/loop');
    const fromConfig = loop2.validateDefinition(
      { name: 'cfg-model', cwd, engine: 'copilot', phases: [phase()] },
      { checkCwd: false }
    );
    assert.equal(
      loop2.resolvePhaseModel(fromConfig.definition.phases[0], fromConfig.definition, enforcedEnv()),
      'from-config'
    );
    assert.equal(
      loop2.resolvePhaseModel(fromConfig.definition.phases[0], fromConfig.definition, enforcedEnv({
        COPILOT_MODEL: 'from-env',
      })),
      'from-env'
    );
  });

  it('passes --model and records reported Copilot usage instead of a char estimate', async () => {
    gitInit(cwd);
    const log = path.join(stubDir, 'model.log');
    const copilotHome = path.join(home, 'copilot-home');
    const stub = path.join(stubDir, 'copilot');
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${log}"
echo '---' >> "${log}"
sid=""
for a in "$@"; do
  case "$a" in
    --session-id=*) sid="\${a#--session-id=}" ;;
  esac
done
if [[ -n "$sid" && -n "\${AGENTFLEET_COPILOT_HOME:-}" ]]; then
  dir="$AGENTFLEET_COPILOT_HOME/session-state/$sid"
  mkdir -p "$dir"
  now=$(node -e 'process.stdout.write(new Date().toISOString())')
  printf '%s\\n' "{\\"type\\":\\"session.usage_record\\",\\"timestamp\\":\\"$now\\",\\"data\\":{\\"usage\\":{\\"model\\":\\"auto\\",\\"inputTokens\\":20000,\\"outputTokens\\":800,\\"cacheReadTokens\\":100,\\"cacheWriteTokens\\":50}}}" > "$dir/events.jsonl"
fi
echo '{"type":"assistant.message","data":{"content":"done"}}'
exit 0
`,
      { mode: 0o755 }
    );
    process.env.AGENTFLEET_COPILOT_BIN = stub;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    const file = writeDef({
      name: 'usage-model',
      cwd,
      engine: 'copilot',
      model: 'auto',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 4, maxHours: 1 },
      phases: [phase({ force: false })],
    });
    const loop = require('../lib/loop');
    const result = await loop.runFromFile(file, {
      env: enforcedEnv({
        AGENTFLEET_COPILOT_BIN: stub,
        AGENTFLEET_COPILOT_HOME: copilotHome,
      }),
      checkWorkdir: true,
    });
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    const logged = fs.readFileSync(log, 'utf8');
    assert.match(logged, /--model\nauto\n/);
    assert.doesNotMatch(logged, /--allow-all-tools/);
    const turns = require('../lib/turns');
    const state = loop.loadState('usage-model');
    const rows = turns.readTurns(state.phases.p1.sessionId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usage.accuracy, 'reported');
    assert.ok(rows[0].usage.totalTokens >= 20000, JSON.stringify(rows[0].usage));
    assert.notEqual(rows[0].usage.source, 'estimated-chars');
  });

  function unavailableDefaultStub(log) {
    const stub = path.join(stubDir, 'copilot');
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${log}"
echo '---' >> "${log}"
for a in "$@"; do
  if [[ "$a" == "--model" ]]; then
    echo '{"type":"assistant.message","data":{"content":"done"}}'
    exit 0
  fi
done
echo '{"type":"session.error","data":{"errorType":"query","message":"Execution failed: Model \\"claude-opus-4.6\\" is not available."}}'
exit 1
`,
      { mode: 0o755 }
    );
    return stub;
  }

  it('retries on --model auto when the Copilot account default is unavailable', async () => {
    gitInit(cwd);
    const log = path.join(stubDir, 'fallback.log');
    const copilotHome = path.join(home, 'copilot-home');
    const stub = unavailableDefaultStub(log);
    process.env.AGENTFLEET_COPILOT_BIN = stub;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    const file = writeDef({
      name: 'model-fallback',
      cwd,
      engine: 'copilot',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 6, maxHours: 1 },
      phases: [phase({ force: false }), phase({ id: 'p2', session: 'loop-p2', force: false })],
    });
    const loop = require('../lib/loop');
    const result = await loop.runFromFile(file, {
      env: enforcedEnv({ AGENTFLEET_COPILOT_BIN: stub, AGENTFLEET_COPILOT_HOME: copilotHome }),
      checkWorkdir: true,
    });
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    const runs = fs.readFileSync(log, 'utf8').split('---\n').filter(Boolean);
    // p1: default fails, retry with auto. p2: starts on auto directly.
    assert.equal(runs.length, 3, runs.join('|'));
    assert.doesNotMatch(runs[0], /--model/);
    assert.match(runs[1], /--model\nauto\n/);
    assert.match(runs[2], /--model\nauto\n/);
    const state = loop.loadState('model-fallback');
    assert.equal(state.phases.p1.status, 'passed');
    assert.equal(state.phases.p2.status, 'passed');
    // Both worker sessions record the model they actually ran on.
    const registry = require('../lib/registry');
    for (const id of ['p1', 'p2']) {
      const row = registry.list().find((r) => r.id === state.phases[id].sessionId);
      assert.equal(row && row.model, 'auto', `${id}: ${JSON.stringify(row)}`);
    }
  });

  it('does not retry when AGENTFLEET_COPILOT_FALLBACK_MODEL=none', async () => {
    gitInit(cwd);
    const log = path.join(stubDir, 'nofallback.log');
    const copilotHome = path.join(home, 'copilot-home');
    const stub = unavailableDefaultStub(log);
    process.env.AGENTFLEET_COPILOT_BIN = stub;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    const file = writeDef({
      name: 'model-nofallback',
      cwd,
      engine: 'copilot',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 3, maxHours: 1 },
      phases: [phase({ force: false })],
    });
    const loop = require('../lib/loop');
    const result = await loop.runFromFile(file, {
      env: enforcedEnv({
        AGENTFLEET_COPILOT_BIN: stub,
        AGENTFLEET_COPILOT_HOME: copilotHome,
        AGENTFLEET_COPILOT_FALLBACK_MODEL: 'none',
      }),
      checkWorkdir: true,
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /--model/);
    assert.match(
      loop.loadState('model-nofallback').lastError || '',
      /model_unavailable.*is not available/
    );
  });

  it('refuses a live run with a clear message when the engine CLI is missing', async () => {
    gitInit(cwd);
    const prevPath = process.env.PATH;
    // Only git + node in PATH. Do not put the node binary's directory on PATH —
    // hosts often ship an unrelated `agent` next to node (e.g. Grok), and
    // agentBinaryIsCursor can false-accept it. Symlink node into the stub bin.
    const binDir = path.join(stubDir, 'bin');
    fs.mkdirSync(binDir);
    const gitBin = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(gitBin, path.join(binDir, 'git'));
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    const isolatedPath = binDir;
    process.env.PATH = isolatedPath;
    try {
      const file = writeDef({
        name: 'no-cursor',
        cwd,
        engine: 'cursor',
        allow: { commit: false, merge: false, push: false },
        budget: { maxRuns: 2, maxHours: 1 },
        phases: [phase({ force: true })],
      });
      const loop = require('../lib/loop');
      const env = enforcedEnv({ PATH: isolatedPath });
      // Host may export AGENTFLEET_*_BIN; clear so resolve cannot bypass PATH.
      delete env.AGENTFLEET_CURSOR_BIN;
      delete env.AGENTFLEET_COPILOT_BIN;
      delete env.AGENTFLEET_OPENCODE_BIN;
      const dry = await loop.runFromFile(file, { env, checkWorkdir: true, dryRun: true });
      assert.equal(dry.ok, true, JSON.stringify(dry));
      assert.match((dry.warnings || []).join('\n'), /cursor-agent not on PATH/);
      const result = await loop.runFromFile(file, { env, checkWorkdir: true });
      assert.equal(result.ok, false);
      assert.equal(result.status, 'refused');
      assert.match(result.error || '', /engine cursor: cursor-agent not on PATH.*aflt doctor/);
      assert.doesNotMatch(result.error || '', /ENOENT/);
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('dry-run shows cwd and permissions and refuses an unsafe folder', () => {
    const file = writeDef({
      name: 'guard',
      cwd,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 2, maxHours: 1 },
      phases: [phase()],
    });
    const env = enforcedEnv();
    const denied = spawnSync(process.execPath, [afJs, 'loop', 'run', file, '--dry-run', '--json'], {
      encoding: 'utf8',
      env,
      cwd,
    });
    assert.equal(denied.status, 1, denied.stdout + denied.stderr);
    const deniedJson = JSON.parse(denied.stdout);
    assert.equal(deniedJson.ok, false);
    assert.equal(deniedJson.dryRun, true);
    assert.equal(fs.realpathSync(deniedJson.cwd), fs.realpathSync(cwd));
    assert.equal(deniedJson.permissions, 'restricted');
    assert.match(denied.stdout, new RegExp(`"permissions": "restricted"`));
    assert.match(denied.stderr, /not a git repository/);

    gitInit(cwd);
    const text = spawnSync(process.execPath, [afJs, 'loop', 'run', file, '--dry-run'], {
      encoding: 'utf8',
      env,
      cwd: stubDir,
    });
    // Definition lives in stubDir, which is inside cwd? No, stubDir is a sibling.
    // cwd is the game repo and does not contain the definition. But the definition's
    // cwd field is the game dir. Dry-run from stubDir still resolves definition cwd.
    assert.equal(text.status, 0, text.stderr + text.stdout);
    assert.match(text.stdout, /cwd: /);
    assert.match(text.stdout, /permissions: restricted/);
    assert.match(text.stdout, /force=false/);

    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'x\n');
    const dirty = spawnSync(process.execPath, [afJs, 'loop', 'run', file, '--dry-run', '--json'], {
      encoding: 'utf8',
      env,
      cwd: stubDir,
    });
    assert.equal(dirty.status, 1, dirty.stdout);
    assert.match(dirty.stderr, /not clean|not an empty/);

    const allowed = spawnSync(
      process.execPath,
      [afJs, 'loop', 'run', file, '--dry-run', '--json', '--allow-existing', '--force'],
      { encoding: 'utf8', env, cwd: stubDir }
    );
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    const allowedJson = JSON.parse(allowed.stdout);
    assert.equal(allowedJson.ok, true);
    assert.equal(allowedJson.permissions, 'force');
    assert.match(allowed.stderr, /allow-existing/);

    const inside = writeDef({
      name: 'inside-aflt',
      cwd: repoRoot,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 2, maxHours: 1 },
      phases: [phase()],
    });
    const repoRun = spawnSync(process.execPath, [afJs, 'loop', 'run', inside, '--dry-run', '--json'], {
      encoding: 'utf8',
      env,
      cwd: repoRoot,
    });
    assert.equal(repoRun.status, 1, repoRun.stdout);
    assert.match(repoRun.stderr, /aflt checkout|loop definition/);
  });

  it('tells the user how to fix a fresh non-git directory but stays strict', () => {
    const loop = require('../lib/loop');
    const inspection = loop._test.inspectLoopWorkdir(cwd);
    assert.equal(inspection.ok, false);
    const msg = inspection.problems.join('\n');
    assert.match(msg, /is not a git repository/);
    assert.match(msg, /git init/);
    assert.match(msg, /--allow-existing/);

    gitInit(cwd);
    assert.equal(loop._test.inspectLoopWorkdir(cwd).ok, true);
  });

  it('grants Copilot plan-next the loop state dir and plan-next.json write rule', () => {
    const loop = require('../lib/loop');
    const copilot = require('../lib/copilot');
    const def = { name: 'grant-loop' };
    const dir = loop.loopDir('grant-loop');
    const planFile = loop.planNextOutputPath('grant-loop');

    const grants = loop.loopPhaseWriteGrants({ id: 'plan', type: 'plan-next' }, def);
    assert.deepEqual(grants, { addDirs: [dir], allowWritePaths: [planFile] });
    const none = loop.loopPhaseWriteGrants({ id: 'dev', type: 'run' }, def);
    assert.deepEqual(none, { addDirs: [], allowWritePaths: [] });

    const session = { cwd, chatId: 'abc', engine: 'copilot', result: path.join(home, 'results', 'x.md') };
    const args = copilot.buildPrintArgs(session, { prompt: 'p', force: true, ...grants });
    const addIdx = args.indexOf(dir);
    assert.ok(addIdx > 0 && args[addIdx - 1] === '--add-dir', args.join(' '));
    assert.ok(args.includes(`--allow-tool=write(${planFile})`), args.join(' '));
    assert.ok(args.includes('--allow-all-tools'));
    assert.ok(!args.includes('--allow-all-paths'));

    const plain = copilot.buildPrintArgs(session, { prompt: 'p', ...none });
    assert.ok(!plain.includes(dir));
    assert.ok(!plain.some((a) => a.includes('plan-next.json')));

    const scoped = copilot.buildPrintArgs(session, {
      prompt: 'p',
      force: false,
      ...grants,
    });
    assert.ok(scoped.includes(`--allow-tool=write(${planFile})`), scoped.join(' '));
    assert.ok(!scoped.includes('--allow-all-tools'));
    assert.ok(!scoped.includes('--allow-all-paths'));
  });

  it('runSessionPrompt passes loop grants to the Copilot argv for plan-next only', async () => {
    const stub = path.join(stubDir, 'copilot-stub.js');
    const argvLog = path.join(stubDir, 'argv.jsonl');
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('{}\\n');
`,
      { mode: 0o755 }
    );
    process.env.AGENTFLEET_COPILOT_BIN = stub;
    const loop = require('../lib/loop');
    const registry = require('../lib/registry');
    const def = { name: 'argv-loop', cwd };
    const session = registry.add({
      title: 'argv-s',
      chatId: '11111111-1111-4111-8111-111111111111',
      cwd,
      engine: 'copilot',
      status: 'active',
      role: 'worker',
    });
    await loop.runSessionPrompt(session, 'plan it', { id: 'plan', type: 'plan-next', force: true, engine: 'copilot' }, { definition: def, env: process.env });
    await loop.runSessionPrompt(session, 'do it', { id: 'dev', type: 'run', engine: 'copilot' }, { definition: def, env: process.env });
    const runs = fs
      .readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(runs.length, 2);
    const dir = loop.loopDir('argv-loop');
    const planFile = loop.planNextOutputPath('argv-loop');
    const addDirs = runs[0].flatMap((a, i) => (runs[0][i - 1] === '--add-dir' ? [a] : []));
    assert.ok(addDirs.includes(dir), runs[0].join(' '));
    assert.ok(runs[0].includes(`--allow-tool=write(${planFile})`));
    assert.ok(!runs[1].includes(`--allow-tool=write(${planFile})`));
    assert.ok(!runs[1].includes(dir));
  });

  it('documents engines, the seed bind address, and loop run flags', () => {
    const pkg = require('../package.json');
    assert.match(pkg.engines.node, />=20\.10/);
    const server = fs.readFileSync(
      path.join(repoRoot, 'examples/loops/hello-aflt-seeded/m0-seed/server.js'),
      'utf8'
    );
    assert.match(server, /HOST \|\| '127\.0\.0\.1'/);
    assert.doesNotMatch(server, /0\.0\.0\.0/);
    const help = spawnSync(process.execPath, [afJs, 'help'], { encoding: 'utf8' });
    assert.match(help.stdout, /--allow-existing/);
    assert.match(help.stdout, /--force/);
    assert.match(help.stdout, /COPILOT_MODEL/);
    assert.ok(fs.existsSync(path.join(repoRoot, '.github/workflows/test.yml')));
  });
});
