'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function snapshotTree(root) {
  const out = [];
  const walk = (dir, rel = '') => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? path.join(rel, name) : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full, r);
      else out.push(`${r}:${st.size}`);
    }
  };
  walk(root);
  return out;
}

describe('help flags are side-effect free', () => {
  it('every subcommand supports --help and -h with exit 0 and no engine spawn', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-help-home-'));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-help-stub-'));
    const marker = path.join(stubDir, 'spawned.log');
    const mkStub = (name) => {
      const file = path.join(stubDir, name);
      fs.writeFileSync(
        file,
        `#!/usr/bin/env bash
echo "${name}" >> "${marker}"
echo "engine must not run for help" >&2
exit 99
`,
        { mode: 0o755 }
      );
      return file;
    };
    const cursorStub = mkStub('cursor-agent');
    const copilotStub = mkStub('copilot');
    const opencodeStub = mkStub('opencode');

    const env = {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      AGENTFLEET_CURSOR_BIN: cursorStub,
      AGENTFLEET_COPILOT_BIN: copilotStub,
      AGENTFLEET_OPENCODE_BIN: opencodeStub,
      AGENTFLEET_SESSION: '',
      AGENTFLEET_ID: '',
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
    };
    fs.mkdirSync(env.AGENTFLEET_HOME, { recursive: true });
    const before = snapshotTree(home);

    const commands = [
      ['new'],
      ['init'],
      ['run'],
      ['log'],
      ['spawn'],
      ['master'],
      ['docs'],
      ['msg'],
      ['inbox'],
      ['thread'],
      ['mcp'],
      ['children'],
      ['result'],
      ['wait'],
      ['tail'],
      ['send'],
      ['stop'],
      ['herdr-templates'],
      ['herdr-app'],
      ['add'],
      ['import'],
      ['ls'],
      ['timeline'],
      ['projects'],
      ['dashboard'],
      ['making-of'],
      ['turns'],
      ['memory'],
      ['sync'],
      ['adopt'],
      ['resume'],
      ['cursor'],
      ['copilot'],
      ['opencode'],
      ['engine'],
      ['rename'],
      ['cwd'],
      ['done'],
      ['archive'],
      ['unarchive'],
      ['rm'],
      ['purge'],
      ['orphans'],
      ['note'],
      ['export'],
      ['import-file'],
      ['which-backend'],
      ['setup'],
      ['doctor'],
      ['notify'],
      ['loop'],
      ['space'],
      ['service'],
      ['eval'],
      ['notify', 'test'],
      ['loop', 'init'],
      ['loop', 'validate'],
      ['loop', 'run'],
      ['loop', 'start'],
      ['loop', 'pause'],
      ['loop', 'status'],
      ['loop', 'stop'],
      ['loop', 'resume'],
      ['loop', 'approve'],
      ['space', 'list'],
      ['space', 'create'],
      ['space', 'current'],
      ['space', 'remove'],
      ['service', 'install'],
      ['service', 'uninstall'],
      ['service', 'status'],
      ['eval', 'measure'],
      ['eval', 'score'],
      ['eval', 'report'],
      ['eval', 'gate'],
      ['eval', 'plateau'],
      ['eval', 'tile-dungeon'],
      ['turns', 'backfill'],
      ['memory', 'where'],
      ['memory', 'init'],
      ['memory', 'sync'],
      ['memory', 'dashboard'],
      ['memory', 'config'],
      ['memory', 'doc'],
      ['memory', 'status'],
      ['docs', 'checkpoint'],
      ['docs', 'notify'],
      ['mcp', 'install'],
      ['herdr-app', 'install'],
      ['herdr-app', 'status'],
    ];

    for (const cmd of commands) {
      for (const helpFlag of ['--help', '-h']) {
        const r = spawnSync(process.execPath, [afJs, ...cmd, helpFlag], {
          encoding: 'utf8',
          env,
          cwd: home,
        });
        assert.equal(r.status, 0, `${cmd.join(' ')} ${helpFlag}: ${r.stderr}\n${r.stdout}`);
        assert.ok(
          /usage:|aflt \(AgentFleet\)/i.test(`${r.stdout}\n${r.stderr}`),
          `${cmd.join(' ')} ${helpFlag} did not print help text`
        );
      }
    }

    const after = snapshotTree(home);
    assert.deepEqual(after, before, 'help commands must not mutate AGENTFLEET_HOME/HOME');
    assert.equal(fs.existsSync(marker), false, 'engine binary must never be spawned for help');

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });
});
