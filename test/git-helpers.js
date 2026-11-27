'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Hermetic git author/committer for tests (no global git config required). */
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'aflt-test',
  GIT_AUTHOR_EMAIL: 'aflt-test@example.com',
  GIT_COMMITTER_NAME: 'aflt-test',
  GIT_COMMITTER_EMAIL: 'aflt-test@example.com',
};

const GIT_CONFIG = [
  '-c',
  'user.name=aflt-test',
  '-c',
  'user.email=aflt-test@example.com',
  '-c',
  'commit.gpgsign=false',
];

function gitEnv(extra = {}) {
  return { ...process.env, ...GIT_ENV, ...extra };
}

/**
 * Run git in `cwd` with hermetic identity (-c user.* and GIT_* env).
 * Returns spawnSync result (does not throw).
 */
function runGit(cwd, args, opts = {}) {
  const prefix = cwd ? ['-C', cwd] : [];
  return spawnSync('git', [...prefix, ...GIT_CONFIG, ...args], {
    encoding: 'utf8',
    env: gitEnv(opts.env),
    ...opts,
  });
}

/**
 * `git init -b main`, write one file, add, commit. Throws on failure with stderr.
 */
function initTestGitRepo(dir, { branch = 'main', message = 'init', file = 'README.md', content = 'x\n' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const init = runGit(dir, ['init', '-q', '-b', branch]);
  if (init.status !== 0) throw new Error(init.stderr || 'git init failed');
  if (file) fs.writeFileSync(path.join(dir, file), content);
  const add = runGit(dir, ['add', '-A']);
  if (add.status !== 0) throw new Error(add.stderr || 'git add failed');
  const commit = runGit(dir, ['commit', '-q', '-m', message]);
  if (commit.status !== 0) {
    throw new Error(
      commit.stderr || commit.stdout || 'git commit failed (set user.name/user.email or GIT_AUTHOR_*)'
    );
  }
  return dir;
}

function applyGitEnvToProcess() {
  for (const [key, value] of Object.entries(GIT_ENV)) {
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

module.exports = {
  GIT_ENV,
  GIT_CONFIG,
  gitEnv,
  runGit,
  initTestGitRepo,
  applyGitEnvToProcess,
};