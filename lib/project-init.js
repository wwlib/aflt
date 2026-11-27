'use strict';

/**
 * `aflt init <name>`: start a new looped project. Creates (or reuses) the
 * folder, runs `git init` when needed, creates an aflt space for it, and
 * writes starter SPEC.md / AGENTS.md / .agentfleet.json from a few plain
 * answers. Existing docs are kept unless `force` is set.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_ANSWERS = {
  goal: 'A small, working program described in this SPEC. Replace this line with what you are building.',
  stack: 'Node.js (no dependencies unless needed), node:test for tests.',
  checks: 'Automated tests pass and an eval script runs the program end-to-end and reports a score.',
  budgetCredits: null,
  budgetHours: 4,
};

const QUESTIONS = [
  { key: 'goal', q: 'What are you building? (one or two sentences)' },
  { key: 'stack', q: 'What stack? (language, framework, test runner)' },
  { key: 'checks', q: 'How will we know it works? (what the tests/eval should check)' },
  { key: 'budgetCredits', q: 'Budget in AI credits (Copilot; blank for none)', num: true },
  { key: 'budgetHours', q: 'Budget in hours of agent time', num: true },
];

function isGitRepo(dir) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 && String(r.stdout).trim() === 'true';
}

function gitInit(dir) {
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git init failed: ${(r.stderr || '').trim()}`);
}

function toNumberOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function specTemplate(name, a) {
  const budget = [];
  if (a.budgetCredits != null) budget.push(`up to ${a.budgetCredits} AI credits`);
  if (a.budgetHours != null) budget.push(`up to ${a.budgetHours} hours of agent time`);
  const guidanceBlock =
    a.guidanceRel && String(a.guidanceRel).trim()
      ? `\nHuman eval guidance (the loop drafter elaborates this brief into fixtures, scorer, and phases): \`${String(a.guidanceRel).trim()}\`.\n`
      : '';
  return `# ${name} — spec

## What we are building

${a.goal}

## Stack

${a.stack}

## How we know it works

${a.checks}
${guidanceBlock}
The first loop milestone (M0) turns this into automated tests and an eval
script. Every later milestone must keep them passing.

## Milestones

_Optional. List the steps you have in mind (M1, M2, …), or leave this for
\`aflt loop init\` to propose._

## Budget

${budget.length ? budget.join(', ') : 'Not set.'}
`;
}

function agentsTemplate(name, a) {
  return `# ${name} — agent instructions

Read SPEC.md first. It says what to build and how we know it works.

## Conventions

- Stack: ${a.stack}
- Keep changes small and focused on the current milestone.
- Add or update tests with every change; run the full test suite before you
  finish, and the eval script when it exists.
- Work only inside this repository. Do not read or copy files from other
  folders on disk (other projects, parent folders, the aflt install); everything
  you need is in SPEC.md, this file, and the task prompt. If something is
  missing, say so instead of searching for it.
- Do not push, open PRs, or change git remotes. Commit only when the prompt
  asks for it.
- Do not switch to plan mode; make the changes.
`;
}

/**
 * Ask the questions on a TTY. Values already given (flags) are skipped.
 * @returns {Promise<object>}
 */
async function askQuestions(answers, { input = process.stdin, output = process.stderr } = {}) {
  const readline = require('readline');
  const rl = readline.createInterface({ input, output });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
  try {
    for (const item of QUESTIONS) {
      if (answers[item.key] != null && answers[item.key] !== '') continue;
      const def = DEFAULT_ANSWERS[item.key];
      const hint = def != null ? ` [${def}]` : '';
      const reply = String(await ask(`${item.q}${hint}: `)).trim();
      if (reply) answers[item.key] = item.num ? toNumberOrNull(reply) : reply;
    }
  } finally {
    rl.close();
  }
  return answers;
}

function writeDoc(file, content, force) {
  const exists = fs.existsSync(file);
  if (exists && !force) return { path: file, action: 'kept' };
  fs.writeFileSync(file, content);
  return { path: file, action: exists ? 'overwritten' : 'written' };
}

/**
 * Copy a human guidance file into docs/guidance/ under the project root.
 * @returns {{ ok: true, relative: string, dest: string } | { ok: false, error: string }}
 */
function installGuidance(dir, guidancePath, force) {
  const src = path.resolve(String(guidancePath || '').trim());
  if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
    return { ok: false, error: `guidance file not found: ${src || guidancePath}` };
  }
  const base = path.basename(src);
  const destDir = path.join(dir, 'docs', 'guidance');
  const dest = path.join(destDir, base);
  if (fs.existsSync(dest) && !force) {
    return { ok: true, relative: path.join('docs', 'guidance', base).replace(/\\/g, '/'), dest, action: 'kept' };
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  return {
    ok: true,
    relative: path.join('docs', 'guidance', base).replace(/\\/g, '/'),
    dest,
    action: fs.existsSync(dest) ? 'copied' : 'copied',
  };
}

/** Merge aflt keys into .agentfleet.json without overwriting existing keys (unless force). */
function writeProjectConfig(dir, values, force) {
  const file = path.join(dir, '.agentfleet.json');
  let data = {};
  let existed = false;
  if (fs.existsSync(file)) {
    existed = true;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (err) {
      throw new Error(`.agentfleet.json is not valid JSON: ${err.message}`);
    }
  }
  const before = JSON.stringify(data);
  for (const [k, v] of Object.entries(values)) {
    if (v == null) continue;
    if (force || data[k] == null) data[k] = v;
  }
  const changed = JSON.stringify(data) !== before;
  if (changed) fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return { path: file, action: !existed ? 'written' : changed ? 'updated' : 'kept', config: data };
}

/**
 * Create the project. opts: name, dir, space (string|null), createSpace
 * (bool), engine, goal, stack, checks, budgetCredits, budgetHours, force,
 * spaceLib (test seam).
 */
function initProject(opts = {}) {
  const name = String(opts.name || '').trim();
  if (!name) throw new Error('project name is required');
  const slug = require('./loop-init').slugName(name);
  const dir = path.resolve(opts.dir || path.join(process.cwd(), slug));
  const createdDir = !fs.existsSync(dir);
  const isolation = require('./isolation');
  // From-scratch means from the docs only: refuse a folder with other files in it.
  const extra = createdDir ? [] : isolation.extraEntries(dir);
  if (extra.length && !opts.force && !opts.existing) {
    const shown = extra.slice(0, 8).join(', ') + (extra.length > 8 ? `, … (${extra.length} entries)` : '');
    throw new Error(
      `${dir} is not empty (${shown}). aflt init starts a project from SPEC.md/AGENTS.md only; use a new empty folder, or pass --existing to set up a loop in this project anyway (--force also overwrites the docs).`
    );
  }
  const spaceName0 = opts.space === false ? null : opts.space || slug;
  const util0 = require('./util');
  const spaceHome0 = spaceName0 ? util0.spaceHomeDir(spaceName0) : null;
  const iso = isolation.checkIsolation(dir, {
    space: opts.space === false ? opts.currentSpace || null : spaceName0,
    spaceHome: spaceHome0,
    sessions: spaceHome0 ? isolation.spaceSessions(spaceHome0) : [],
    env: opts.env,
    home: opts.home,
  });
  if (opts.isolated && !iso.ok) {
    throw new Error(
      'isolation check failed (--isolated):\n' + iso.warnings.map((w) => `  - ${w.message}`).join('\n')
    );
  }
  fs.mkdirSync(dir, { recursive: true });

  let git = 'existing';
  if (!isGitRepo(dir)) {
    gitInit(dir);
    git = 'initialized';
  }

  const answers = {};
  for (const k of Object.keys(DEFAULT_ANSWERS)) {
    answers[k] = opts[k] != null && opts[k] !== '' ? opts[k] : DEFAULT_ANSWERS[k];
  }
  answers.budgetCredits = toNumberOrNull(answers.budgetCredits);
  answers.budgetHours = toNumberOrNull(answers.budgetHours);

  let guidanceRel = null;
  let guidanceFile = null;
  if (opts.guidance) {
    const g = installGuidance(dir, opts.guidance, opts.force);
    if (!g.ok) throw new Error(g.error);
    guidanceRel = g.relative;
    guidanceFile = g.dest;
    answers.guidanceRel = guidanceRel;
  }

  let space = null;
  if (opts.space !== false) {
    const spaceLib = opts.spaceLib || require('./space');
    const util = require('./util');
    const spaceName = opts.space || slug;
    const home = util.spaceHomeDir(spaceName);
    let created = false;
    if (!fs.existsSync(path.join(home, 'config.json'))) {
      if (fs.existsSync(home)) {
        space = { name: spaceName, path: home, created: false };
      } else {
        const res = spaceLib.createSpace(spaceName);
        created = true;
        space = { name: res.name, path: res.path, port: res.port, created };
      }
    }
    if (!space) space = { name: spaceName, path: home, created };
  }

  const files = [];
  files.push(writeDoc(path.join(dir, 'SPEC.md'), specTemplate(name, answers), opts.force));
  files.push(writeDoc(path.join(dir, 'AGENTS.md'), agentsTemplate(name, answers), opts.force));
  const budget = {};
  if (answers.budgetCredits != null) budget.credits = answers.budgetCredits;
  if (answers.budgetHours != null) budget.hours = answers.budgetHours;
  const cfg = writeProjectConfig(
    dir,
    {
      project: slug,
      space: space ? space.name : null,
      engine: opts.engine || null,
      budget: Object.keys(budget).length ? budget : null,
      loop: '.agentfleet/loop.json',
    },
    opts.force
  );
  files.push({ path: cfg.path, action: cfg.action });

  const spaceFlag = space ? ` --space ${space.name}` : '';
  return {
    ok: true,
    name,
    project: slug,
    dir,
    createdDir,
    git,
    isolation: { ok: iso.ok, warnings: iso.warnings },
    ...(extra.length ? { existingEntries: extra } : {}),
    space,
    engine: opts.engine || null,
    answers,
    ...(guidanceRel ? { guidance: guidanceRel, guidanceFile } : {}),
    files,
    next: [
      `cd ${dir}`,
      'edit SPEC.md and AGENTS.md (what to build, how we know it works)',
      'git add -A && git commit -m "Seed project docs"   # loop init/run need a clean repo',
      `aflt${spaceFlag} loop init${opts.engine ? ` --engine ${opts.engine}` : ''}     # drafts .agentfleet/loop.json`,
      `aflt${spaceFlag} loop start .agentfleet/loop.json`,
    ],
  };
}

module.exports = {
  DEFAULT_ANSWERS,
  QUESTIONS,
  specTemplate,
  agentsTemplate,
  askQuestions,
  writeDoc,
  installGuidance,
  writeProjectConfig,
  initProject,
  isGitRepo,
};
