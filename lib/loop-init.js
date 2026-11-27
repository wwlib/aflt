'use strict';

/**
 * `aflt loop init`: draft a loop definition from a project's SPEC.md and
 * AGENTS.md. The engine writes `.agentfleet/loop.json` plus prompt files,
 * guided by templates/loop-guide.md. The draft is then checked with the loop
 * validator and the checks policy below; failures go back to the engine for
 * up to two repair attempts.
 */

const fs = require('fs');
const path = require('path');

const GUIDE_PATH = path.join(__dirname, '..', 'templates', 'loop-guide.md');
const DEFAULT_OUT = path.join('.agentfleet', 'loop.json');
const DEFAULT_MAX_REPAIRS = 2;
const AGENTS_POINTER_MARKER = '<!-- aflt-loop -->';
const DOC_CAP = 24000;

/**
 * Default models per engine: cheap for builds, stronger for plan-next.
 * Override with --build-model / --plan-model (or --model for both).
 */
const DEFAULT_MODELS = {
  cursor: { build: 'composer-2.5', plan: 'gpt-5.3-codex' },
  copilot: { build: 'auto', plan: 'claude-sonnet-5.5' },
  opencode: { build: null, plan: null },
};

function readGuide() {
  return fs.readFileSync(GUIDE_PATH, 'utf8');
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function capText(text, max = DOC_CAP) {
  if (text == null) return null;
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}\n\n[… truncated at ${max} characters]` : s;
}

/** Project `.agentfleet.json` (written by `aflt init`), or {}. */
function readProjectConfig(cwd) {
  const raw = readIfExists(path.join(cwd, '.agentfleet.json'));
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (_) {
    return {};
  }
}

function readGuidanceFiles(cwd) {
  const dir = path.join(cwd, 'docs', 'guidance');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    const text = readIfExists(path.join(dir, name));
    if (text != null) out.push({ name, text });
  }
  return out;
}

function readProjectDocs(cwd) {
  return {
    spec: readIfExists(path.join(cwd, 'SPEC.md')),
    agents: readIfExists(path.join(cwd, 'AGENTS.md')),
    guidance: readGuidanceFiles(cwd),
  };
}

function resolveModels(engine, opts = {}) {
  const defaults = DEFAULT_MODELS[engine] || { build: null, plan: null };
  const build = opts.buildModel || opts.model || defaults.build;
  const plan = opts.planModel || (opts.model && !opts.buildModel ? opts.model : null) || defaults.plan || build;
  return { build: build || null, plan: plan || null };
}

function slugName(s) {
  return (
    String(s || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

/** Paths for the draft: loop JSON and its prompts folder (beside it). */
function draftPaths(cwd, out) {
  const outAbs = path.resolve(cwd, out || DEFAULT_OUT);
  const promptsAbs = path.join(path.dirname(outAbs), 'prompts');
  return {
    outAbs,
    outRel: path.relative(cwd, outAbs) || path.basename(outAbs),
    promptsAbs,
    promptsRel: path.relative(cwd, promptsAbs) || 'prompts',
  };
}

function buildLoopInitPrompt(ctx) {
  const {
    projectName,
    engine,
    models,
    budget,
    paths,
    docs,
    guide,
  } = ctx;
  const budgetLines = [];
  if (budget && budget.credits != null) {
    budgetLines.push(
      `- AI credits: about ${budget.credits}. aflt cannot cap credits directly, so keep phases few and size budget.maxRuns conservatively.`
    );
  }
  if (budget && budget.hours != null) budgetLines.push(`- Active agent time: ${budget.hours} hours → budget.maxHours.`);
  if (!budgetLines.length) budgetLines.push('- Not given: use budget.maxRuns 30, maxHours 4.');
  return [
    'You are setting up an aflt loop for the project in the current folder.',
    'Read the loop-writing guide, then the project docs, then write these files and nothing else:',
    `1. ${paths.outRel} — the loop definition JSON.`,
    `2. One prompt file per agent phase under ${paths.promptsRel}/ (referenced from the JSON as "prompts/<file>", relative to the JSON file).`,
    '',
    'Do not write any project code, do not run the loop, do not commit, do not push, and do not switch to plan mode.',
    'Everything you need is in this prompt and in this project folder. Do not read files outside the project folder (no parent folders, other projects, or the aflt space), and reference prompt files by paths relative to the loop JSON.',
    'When you are done, reply with a short summary of the phases.',
    '',
    '## Settings',
    `- Loop name and project: ${projectName}`,
    `- Engine: ${engine} (top-level "engine")`,
    `- Cheap build model: ${models.build || '(engine default: leave "model" unset)'}`,
    `- Strong planning model (plan-next only): ${models.plan || '(engine default)'}`,
    '- Budget:',
    ...budgetLines,
    '',
    '## Loop-writing guide',
    guide,
    '',
    '## Project docs: SPEC.md',
    capText(docs.spec) || '(missing: infer what you can from AGENTS.md)',
    '',
    '## Project docs: AGENTS.md',
    capText(docs.agents) || '(missing)',
    '',
    '## Eval fixture coverage (required on the eval milestone phase)',
    'When human guidance names scoring tiers, the eval milestone eval.check must include eval.coverage with every tier, minCasesPerTier 3 (or guidance value), multi-step update chains for updates, and probes spanning sessions — so fixtures are complete before protected.fromPhase locks eval/fixtures and scripts/eval.',
    '',
    '## Human guidance (elaborate this brief into fixtures, scorer and phases; it overrides guide defaults)',
    docs.guidance && docs.guidance.length
      ? docs.guidance
          .map((g) => `### docs/guidance/${g.name}\n${capText(g.text) || '(empty)'}`)
          .join('\n\n')
      : '(no docs/guidance/*.md — follow the loop guide and SPEC.md)',
  ].join('\n');
}

function buildRepairPrompt(ctx, problems) {
  return [
    `The loop draft at ${ctx.paths.outRel} has problems. Fix the JSON (and prompt files under ${ctx.paths.promptsRel}/ if needed) so all of these are resolved:`,
    '',
    ...problems.map((p) => `- ${p}`),
    '',
    'Keep everything else as it is. Follow the loop-writing guide you were given (tests and eval in m0, eval milestone with eval.coverage and protected.fromPhase when the project has an eval contract, gate "approve" on the phase right after the eval milestone—or after m0 when there is no eval milestone—budget caps).',
    'Write only those files. Do not write project code, run the loop, commit or push.',
  ].join('\n');
}

/** True when a check command cannot fail (true, exit 0, echo …, `|| true`). */
function isTrivialCheck(command) {
  if (command == null) return true;
  const s = Array.isArray(command) ? command.join(' ') : String(command);
  let t = s.trim();
  const shell = t.match(/^(?:sh|bash|zsh)\s+-c\s+(.+)$/s);
  if (shell) t = shell[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
  if (!t) return true;
  if (/^(true|:|exit(\s+0)?|pwd|date|ls|echo(\s.*)?|printf(\s.*)?)$/i.test(t)) return true;
  if (/(\|\||;)\s*(true|:|exit\s+0)\s*$/.test(t)) return true;
  return false;
}

function typeOfPhase(p) {
  return String((p && p.type) || 'run').toLowerCase();
}

/** First agent phase whose eval defines tier coverage (the eval milestone). */
function findEvalMilestonePhase(phases) {
  if (!Array.isArray(phases)) return null;
  for (const p of phases) {
    if (!p || typeOfPhase(p) !== 'run') continue;
    const cov = p.eval && p.eval.coverage;
    if (cov && (Array.isArray(cov.tiers) && cov.tiers.length || cov.command)) return p;
  }
  for (const p of phases) {
    if (!p || typeOfPhase(p) !== 'run') continue;
    if (String(p.id || '').toLowerCase() === 'eval') return p;
  }
  return null;
}

function evalCommandText(phase) {
  const cmd = phase && phase.eval && phase.eval.command;
  if (cmd == null) return '';
  return Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
}

function isLiveEvalScriptPhase(phase) {
  if (!phase || typeOfPhase(phase) !== 'script') return false;
  return /(?:^|\s)--live(?:\s|$)/.test(evalCommandText(phase));
}

function hasEvalContractFields(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.minOverall != null && ev.minOverall !== '') return true;
  if (ev.noRegress === true || String(ev.noRegress).toLowerCase() === 'true') return true;
  if (ev.minTiers && typeof ev.minTiers === 'object' && !Array.isArray(ev.minTiers) && Object.keys(ev.minTiers).length) {
    return true;
  }
  return false;
}

/**
 * When AGENTFLEET_HOME is unset and no --space was chosen, use the space recorded
 * in the project's `.agentfleet.json` (same as `aflt loop init`).
 */
function applyProjectSpaceIfNeeded(cwd, opts = {}) {
  const util = require('./util');
  if (util.currentSpaceName() || util.envNonEmpty(process.env, 'AGENTFLEET_HOME')) {
    return { applied: false };
  }
  const root = path.resolve(cwd || process.cwd());
  const pc = readProjectConfig(root);
  if (!pc.space) return { applied: false };
  try {
    util.applySpaceSelection({
      sawSpace: true,
      spaceFlag: String(pc.space).trim(),
      env: opts.env || process.env,
    });
    return { applied: true, space: String(pc.space).trim() };
  } catch (err) {
    if (opts.throwOnError) throw err;
    return { applied: false, error: err.message || String(err) };
  }
}

function phasePromptText(rawPhase, definitionDir) {
  if (!rawPhase) return '';
  if (rawPhase.prompt) return String(rawPhase.prompt);
  if (rawPhase.promptFile) {
    const p = path.isAbsolute(rawPhase.promptFile)
      ? rawPhase.promptFile
      : path.resolve(definitionDir || '.', rawPhase.promptFile);
    return readIfExists(p) || '';
  }
  return '';
}

/**
 * aflt's checks policy for drafted loops (on top of the loop validator):
 * every agent/script phase has a check that can fail, the first agent phase
 * builds tests + eval, the phase after it has gate "approve", and budget caps
 * are set. Returns { errors, warnings }.
 */
function checkLoopPolicy(raw, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.phases)) {
    return { errors: ['loop JSON must be an object with a phases array'], warnings };
  }
  const definitionDir = opts.definitionDir || null;
  const phases = raw.phases.filter((p) => p && typeof p === 'object');
  const typeOf = typeOfPhase;

  for (const p of phases) {
    const t = typeOf(p);
    if (t === 'plan-next') continue;
    const cmd = p.eval && p.eval.command;
    if (cmd == null || (Array.isArray(cmd) && !cmd.length) || !String(cmd).trim()) {
      errors.push(`phase ${p.id || '?'}: needs a real check (eval.command)`);
    } else if (isTrivialCheck(cmd)) {
      errors.push(
        `phase ${p.id || '?'}: check ${JSON.stringify(Array.isArray(cmd) ? cmd.join(' ') : cmd)} always passes; use the tests, the eval script, a build or a specific file check`
      );
    } else if (opts.projectDir) {
      const esc = require('./loop-snapshot').escapingTokens(cmd, opts.projectDir);
      if (esc.length) {
        errors.push(
          `phase ${p.id || '?'}: check uses ${esc.map((e) => e.token).join(', ')} outside the project folder; checks must run files inside the project`
        );
      }
    }
  }

  const runIdx = phases.findIndex((p) => typeOf(p) === 'run');
  if (runIdx < 0) {
    errors.push('loop has no agent (run) phase');
  } else {
    const first = phases[runIdx];
    const text = phasePromptText(first, definitionDir);
    const cmd = first.eval && first.eval.command;
    const cmdText = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '');
    if (!/\btests?\b|test harness|unit test/i.test(text)) {
      errors.push(`first milestone ${first.id}: its prompt must build the test harness (no mention of tests)`);
    }
    if (!/\beval/i.test(text)) {
      errors.push(`first milestone ${first.id}: its prompt must build an eval script (no mention of an eval)`);
    }
    if (cmdText && !/test|eval|check|spec|verify/i.test(cmdText)) {
      warnings.push(`first milestone ${first.id}: check "${cmdText}" does not look like it runs the tests or the eval`);
    }
    if (opts.gate !== false) {
      const evalMs = findEvalMilestonePhase(phases);
      const gateAnchor = evalMs || first;
      const anchorIdx = phases.indexOf(gateAnchor);
      const next = phases.slice(anchorIdx + 1).find((p) => typeOf(p) !== 'script');
      if (!next) {
        errors.push(
          evalMs
            ? `add at least one milestone after eval milestone ${evalMs.id}`
            : `add at least one milestone after ${first.id}`
        );
      } else if (String(next.gate || '').toLowerCase() !== 'approve') {
        errors.push(
          evalMs
            ? `phase ${next.id}: set "gate": "approve" on the phase right after eval milestone ${evalMs.id} (section 9 of the loop guide)`
            : `phase ${next.id}: set "gate": "approve" so the loop pauses after the first milestone and reports the cost so far`
        );
      }
    }
  }

  const evalMs = findEvalMilestonePhase(phases);
  if (evalMs) {
    const ev = evalMs.eval || {};
    const cov = ev.coverage;
    if (!cov || (!cov.command && !(Array.isArray(cov.tiers) && cov.tiers.length))) {
      errors.push(
        `phase ${evalMs.id}: eval milestone needs eval.coverage with tiers (and minCasesPerTier) before protected paths lock fixtures`
      );
    }
    const prot = raw.protected && typeof raw.protected === 'object' ? raw.protected : null;
    const fromPhase = prot && prot.fromPhase != null ? String(prot.fromPhase).trim() : '';
    if (!fromPhase) {
      errors.push(`set loop "protected.fromPhase" to "${evalMs.id}" (eval milestone) so only that phase can write fixtures/scorer`);
    } else if (fromPhase !== evalMs.id) {
      errors.push(`protected.fromPhase must be "${evalMs.id}" (the eval milestone id), not "${fromPhase}"`);
    }
    for (const p of phases) {
      if (!isLiveEvalScriptPhase(p)) continue;
      const pev = p.eval || {};
      if (pev.passRegex != null && String(pev.passRegex).trim() && !hasEvalContractFields(pev)) {
        errors.push(
          `phase ${p.id}: live-eval script should use eval.minOverall, eval.minTiers, and/or eval.noRegress instead of passRegex alone`
        );
      }
      if (!hasEvalContractFields(pev)) {
        warnings.push(
          `phase ${p.id}: live-eval script has no eval.minOverall, eval.minTiers, or eval.noRegress (contract fields recommended)`
        );
      }
      const retries = pev.infraRetries != null ? Number(pev.infraRetries) : 0;
      if (!Number.isFinite(retries) || retries < 1) {
        errors.push(`phase ${p.id}: set eval.infraRetries >= 1 on the live-eval script (backend timeouts should retry once)`);
      }
    }
  }

  const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {};
  if (budget.maxRuns == null && budget.maxHours == null) {
    errors.push('set budget.maxRuns and budget.maxHours (budget caps)');
  }
  const planNext = phases.find((p) => typeOf(p) === 'plan-next');
  if (planNext) {
    if (budget.maxPhases == null) {
      errors.push('plan-next needs budget.maxPhases to cap improve rounds');
    } else if (Number(budget.maxPhases) > phases.length + 6) {
      warnings.push(
        `budget.maxPhases ${budget.maxPhases} leaves room for more than 3 improve rounds (${phases.length} phases defined)`
      );
    }
    if (planNext.force !== true) {
      errors.push('phase plan-next: set "force": true so the planner can write its plan file (and any improve prompt files)');
    }
    if (!planNext.model) warnings.push('plan-next has no "model"; it will use the loop model');
    if (!raw.improveModel && !planNext.improveModel && planNext.model) {
      warnings.push('no "improveModel": improve rounds will use the loop model (not the planner model)');
    }
  }
  // Model switches between consecutive agent phases lose the prompt cache.
  let switches = 0;
  let last;
  for (const p of phases) {
    if (typeOf(p) !== 'run') continue;
    const m = p.model || raw.model || null;
    if (last !== undefined && m !== last) switches++;
    last = m;
  }
  if (switches > 1) warnings.push(`build phases switch model ${switches} times; group phases by model to keep the cache`);
  return { errors, warnings };
}

/** Validate a drafted loop file: loop validator + checks policy. */
function checkDraft(outAbs, cwd, loopLib, opts = {}) {
  if (!fs.existsSync(outAbs)) {
    return { ok: false, errors: [`the loop file was not written: ${outAbs}`], warnings: [] };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(outAbs, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`${path.basename(outAbs)} is not valid JSON: ${err.message}`], warnings: [] };
  }
  let validated;
  try {
    validated = loopLib.validateFile(outAbs, { cwdBase: cwd });
  } catch (err) {
    return { ok: false, errors: [err.message], warnings: [], raw };
  }
  const projectDir = (validated && validated.ok && validated.definition && validated.definition.cwd) || cwd;
  const policy = checkLoopPolicy(raw, { definitionDir: path.dirname(outAbs), gate: opts.gate, projectDir });
  const errors = [].concat(validated.ok ? [] : validated.errors || [], policy.errors);
  const warnings = [].concat(validated.warnings || [], policy.warnings);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    raw,
    definition: validated.ok ? validated.definition : null,
  };
}

/** If the engine replied with the JSON instead of writing it, save the reply's JSON block. */
function salvageJsonFromReply(stdout, outAbs) {
  if (!stdout || fs.existsSync(outAbs)) return false;
  const m = String(stdout).match(/```json\s*([\s\S]*?)```/);
  if (!m) return false;
  try {
    const data = JSON.parse(m[1]);
    if (!data || !Array.isArray(data.phases)) return false;
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

/** Readable phase lines for the terminal. */
function summarizeDraft(raw) {
  if (!raw || !Array.isArray(raw.phases)) return [];
  const lines = [];
  const b = raw.budget || {};
  lines.push(
    `loop "${raw.name}" — engine ${raw.engine || '(default)'}, model ${raw.model || '(engine default)'}` +
      (raw.improveModel ? `, improve rounds on ${raw.improveModel}` : '')
  );
  lines.push(
    `budget: maxRuns=${b.maxRuns != null ? b.maxRuns : '-'} maxHours=${b.maxHours != null ? b.maxHours : '-'} maxPhases=${b.maxPhases != null ? b.maxPhases : '-'} maxTokens=${b.maxTokens != null ? b.maxTokens : '-'}`
  );
  raw.phases.forEach((p, i) => {
    const type = String(p.type || 'run');
    const cmd = p.eval && p.eval.command != null ? (Array.isArray(p.eval.command) ? p.eval.command.join(' ') : String(p.eval.command)) : null;
    const bits = [];
    if (type !== 'run') bits.push(type);
    if (p.gate === 'approve') bits.push('⏸ approve first');
    if (p.model) bits.push(`model ${p.model}`);
    if (p.improveModel) bits.push(`improve rounds on ${p.improveModel}`);
    lines.push(
      `  ${String(i + 1).padStart(2)}. ${p.id}${bits.length ? ` [${bits.join(', ')}]` : ''}` +
        (type === 'plan-next' ? ' — plans improve rounds from the eval' : cmd ? ` — check: ${cmd}` : '')
    );
  });
  return lines;
}

function agentsPointerSection(outRel) {
  const promptsRel = path.join(path.dirname(outRel), 'prompts');
  return [
    '',
    AGENTS_POINTER_MARKER,
    '## aflt loop',
    '',
    `This project uses an aflt loop; see \`${outRel}\` (phase prompts in \`${promptsRel}/\`).`,
    `Run it from the project root: \`aflt loop start ${outRel}\` (dashboard scheduler) or \`aflt loop run ${outRel}\` (terminal).`,
    'The first milestone builds the test harness and eval; when the loop has a dedicated eval milestone, it pauses for approval on the phase after that milestone (otherwise after M0) and reports the cost so far.',
    'Keep the tests and the eval green: every phase is checked by them.',
    '',
  ].join('\n');
}

/** Append the pointer section to AGENTS.md (creates it when missing). Never rewrites existing text. */
function ensureAgentsPointer(cwd, outRel) {
  const file = path.join(cwd, 'AGENTS.md');
  const existing = readIfExists(file);
  if (existing != null && (existing.includes(AGENTS_POINTER_MARKER) || existing.includes(outRel))) {
    return { path: file, action: 'kept' };
  }
  const section = agentsPointerSection(outRel);
  if (existing == null) {
    fs.writeFileSync(file, `# Agent instructions\n${section}`);
    return { path: file, action: 'created' };
  }
  fs.writeFileSync(file, existing.replace(/\s*$/, '\n') + section);
  return { path: file, action: 'appended' };
}

/**
 * Copy the draft into the space's loops/definitions dir so the dashboard
 * editor lists it. The copy uses absolute cwd / promptFile paths so it works
 * from any folder.
 */
function saveDashboardCopy(raw, outAbs, cwd, loopLib) {
  const defDir = path.dirname(outAbs);
  const copy = JSON.parse(JSON.stringify(raw));
  copy.cwd = path.resolve(cwd, raw.cwd || '.');
  for (const p of copy.phases || []) {
    if (p && p.promptFile && !path.isAbsolute(p.promptFile)) {
      // Project-relative (resolved against the loop cwd), never an absolute path.
      p.promptFile = path.relative(copy.cwd, path.resolve(defDir, p.promptFile));
    }
    if (p && p.eval && p.eval.command != null) {
      p.eval.command = loopLib.resolveEvalCommandPaths(p.eval.command, { definitionDir: defDir });
    }
  }
  const saved = loopLib.saveDefinition(copy, { checkCwd: true, checkPromptFiles: true });
  return saved;
}

function relOrAbs(cwd, p) {
  const r = path.relative(cwd, p);
  return r && !r.startsWith('..') ? r : p;
}

/**
 * Default engine runner: one registry session (reused for repairs) driven
 * through the loop's headless plumbing.
 */
function makeDefaultRunAgent(loopLib) {
  let session = null;
  return async function runAgent({ prompt, cwd, engine, model, projectName, timeoutSec }) {
    const definition = {
      name: `loop-init-${slugName(projectName)}`,
      engine,
      cwd,
      model: model || null,
      project: projectName || null,
      phases: [],
    };
    const phase = {
      id: 'loop-init',
      type: 'run',
      engine,
      session: `loop-init-${slugName(projectName)}`,
      force: true,
      mode: null,
      model: model || null,
      timeoutSec: timeoutSec || 900,
    };
    if (!session) session = await loopLib.ensureSession(phase, definition, {});
    const result = await loopLib.runSessionPrompt(session, prompt, phase, {
      definition,
      recordMakingOf: false,
    });
    return { ...result, sessionId: session.id };
  };
}

function usageForSession(sessionId) {
  if (!sessionId) return null;
  try {
    const usage = require('./turns').readUsageSummary(sessionId);
    if (!usage) return null;
    const out = {};
    for (const k of ['totalTokens', 'inputTokens', 'outputTokens', 'credits', 'usd', 'turnCount']) {
      if (usage[k] != null) out[k] = usage[k];
    }
    return out;
  } catch (_) {
    return null;
  }
}

/**
 * Isolation check for the project folder in the current space (see lib/isolation.js).
 * opts.space / opts.spaceHome / opts.memoryRepo / opts.env / opts.home override.
 */
function checkProjectIsolation(cwd, opts = {}) {
  const iso = require('./isolation');
  const util = require('./util');
  const env = opts.env || process.env;
  const space = opts.space !== undefined ? opts.space : util.currentSpaceName() || null;
  const spaceHome = opts.spaceHome || (space ? util.spaceHomeDir(space) : util.fleetDir());
  let memoryRepo = opts.memoryRepo;
  if (memoryRepo === undefined) {
    try {
      const m = require('./memory').resolveMemoryRepo(env);
      memoryRepo = m ? m.path : null;
    } catch (_) {
      memoryRepo = null;
    }
  }
  const r = iso.checkIsolation(cwd, {
    space,
    spaceHome,
    memoryRepo,
    sessions: iso.spaceSessions(spaceHome),
    env,
    home: opts.home,
  });
  return { ok: r.ok, warnings: r.warnings };
}

/**
 * Draft a loop. opts: cwd, engine, model, buildModel, planModel, out, dryRun,
 * maxRepairs, runAgent (test seam), dashboard (save a copy; default true),
 * agentsPointer (default true), timeoutSec, log(fn).
 */
async function initLoop(opts = {}) {
  const loopLib = opts.loopLib || require('./loop');
  const cwd = path.resolve(opts.cwd || process.cwd());
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const projectCfg = readProjectConfig(cwd);
  const engineLib = require('./engine');
  let engine = opts.engine || projectCfg.engine || null;
  if (!engine) engine = engineLib.resolveEngine({}).engine;
  engine = require('./config').validateEngine(engine);
  const projectName = projectCfg.project || projectCfg.name || path.basename(cwd);
  const models = resolveModels(engine, opts);
  const out = opts.out || projectCfg.loop || DEFAULT_OUT;
  const paths = draftPaths(cwd, out);
  const docs = readProjectDocs(cwd);
  const isolation = checkProjectIsolation(cwd, opts);
  if (opts.isolated && !isolation.ok) {
    return {
      ok: false,
      cwd,
      isolation,
      error: 'isolation check failed (--isolated): ' + isolation.warnings.map((w) => w.message).join(' | '),
    };
  }
  if (!docs.spec && !docs.agents) {
    return {
      ok: false,
      error: `no SPEC.md or AGENTS.md in ${cwd}; write them first (aflt init creates starters)`,
    };
  }
  const budget = {
    credits: opts.budgetCredits != null ? opts.budgetCredits : projectCfg.budget && projectCfg.budget.credits != null ? projectCfg.budget.credits : null,
    hours: opts.budgetHours != null ? opts.budgetHours : projectCfg.budget && projectCfg.budget.hours != null ? projectCfg.budget.hours : null,
  };
  const ctx = { projectName, engine, models, budget, paths, docs, guide: readGuide() };
  const prompt = buildLoopInitPrompt(ctx);
  const base = {
    cwd,
    engine,
    models,
    out: paths.outAbs,
    outRel: paths.outRel,
    promptsDir: paths.promptsAbs,
    projectName,
    isolation,
  };
  if (opts.dryRun) {
    return { ok: true, dryRun: true, ...base, prompt, promptChars: prompt.length };
  }
  if (fs.existsSync(paths.outAbs) && !opts.force) {
    return {
      ok: false,
      ...base,
      error: `${paths.outRel} already exists; pass --force to draft a new one (the old file is kept as ${paths.outRel}.bak)`,
    };
  }
  let replaced = null;
  if (opts.force && fs.existsSync(paths.outAbs)) {
    // Keep the old draft beside the new one instead of deleting it.
    replaced = `${paths.outAbs}.bak`;
    fs.renameSync(paths.outAbs, replaced);
  }
  fs.mkdirSync(paths.promptsAbs, { recursive: true });

  const runAgent = typeof opts.runAgent === 'function' ? opts.runAgent : makeDefaultRunAgent(loopLib);
  const maxRepairs = opts.maxRepairs != null ? opts.maxRepairs : DEFAULT_MAX_REPAIRS;
  const attempts = [];
  let check = null;
  let sessionId = null;
  for (let i = 0; i <= maxRepairs; i++) {
    const p = i === 0 ? prompt : buildRepairPrompt(ctx, check.errors);
    log(i === 0 ? `drafting the loop with ${engine}${models.build ? ` (${models.build})` : ''}…` : `repair attempt ${i}: ${check.errors.length} problem(s)…`);
    const run = await runAgent({
      prompt: p,
      cwd,
      engine,
      model: models.build,
      projectName,
      attempt: i,
      timeoutSec: opts.timeoutSec,
    });
    if (run && run.sessionId) sessionId = run.sessionId;
    salvageJsonFromReply(run && run.stdout, paths.outAbs);
    check = checkDraft(paths.outAbs, cwd, loopLib, { gate: opts.gate });
    attempts.push({
      attempt: i,
      kind: i === 0 ? 'draft' : 'repair',
      exit: run ? run.code : null,
      timedOut: Boolean(run && run.timedOut),
      ok: check.ok,
      errors: check.errors,
    });
    if (check.ok) break;
    if (run && run.code != null && run.code !== 0 && !fs.existsSync(paths.outAbs)) {
      // The engine itself failed and wrote nothing: repairing will not help.
      break;
    }
  }
  // The loop runs in the project's own (non-empty) repo, next to its definition.
  if (check && check.ok && check.raw && check.raw.workdir == null) {
    check.raw.workdir = { mode: 'project' };
    fs.writeFileSync(paths.outAbs, JSON.stringify(check.raw, null, 2) + '\n');
  }
  const usage = usageForSession(sessionId);
  const result = {
    ok: Boolean(check && check.ok),
    ...base,
    attempts,
    errors: check ? check.errors : [],
    warnings: check ? check.warnings : [],
    summary: check && check.raw ? summarizeDraft(check.raw) : [],
    sessionId,
    usage,
    definition: check && check.raw ? check.raw : null,
    ...(replaced ? { replaced } : {}),
  };
  if (!result.ok) return result;

  if (opts.agentsPointer !== false) {
    try {
      result.agentsPointer = ensureAgentsPointer(cwd, paths.outRel);
    } catch (err) {
      result.warnings.push(`could not update AGENTS.md: ${err.message}`);
    }
  }
  if (opts.dashboard !== false) {
    try {
      const saved = saveDashboardCopy(check.raw, paths.outAbs, cwd, loopLib);
      if (saved.ok) result.dashboardCopy = saved.path;
      else result.warnings.push(`dashboard copy not saved: ${(saved.errors || []).join('; ')}`);
    } catch (err) {
      result.warnings.push(`dashboard copy not saved: ${err.message}`);
    }
  }
  result.next = [
    'git add -A && git commit -m "Add aflt loop"   # the loop needs a clean repo',
    `aflt loop validate ${relOrAbs(cwd, paths.outAbs)}`,
    `aflt loop run ${relOrAbs(cwd, paths.outAbs)}            # run in this terminal`,
    `aflt loop start ${relOrAbs(cwd, paths.outAbs)}          # or hand it to the dashboard scheduler`,
    'aflt dashboard --serve                       # review/edit under Loops → Saved definitions',
  ];
  return result;
}

module.exports = {
  GUIDE_PATH,
  DEFAULT_OUT,
  DEFAULT_MODELS,
  DEFAULT_MAX_REPAIRS,
  AGENTS_POINTER_MARKER,
  readGuide,
  readGuidanceFiles,
  readProjectConfig,
  readProjectDocs,
  resolveModels,
  draftPaths,
  buildLoopInitPrompt,
  buildRepairPrompt,
  checkProjectIsolation,
  applyProjectSpaceIfNeeded,
  findEvalMilestonePhase,
  isTrivialCheck,
  checkLoopPolicy,
  checkDraft,
  salvageJsonFromReply,
  summarizeDraft,
  agentsPointerSection,
  ensureAgentsPointer,
  saveDashboardCopy,
  initLoop,
  slugName,
};
