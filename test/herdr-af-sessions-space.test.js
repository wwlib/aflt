'use strict';

// af sessions Herdr panel: aflt space picker.
// The mod is an ES module for Herdr (imports "herdr" / "gpui-kit"), so these
// tests load it through data: URLs with small stand-ins for the host modules.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const modDir = path.join(__dirname, '..', 'herdr', 'mods', 'af-sessions');
const afspaceSrc = fs.readFileSync(path.join(modDir, 'afspace.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(modDir, 'main.js'), 'utf8');

function dataUrl(src) {
  return `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
}

let importSeq = 0;
function importAfspace() {
  return import(dataUrl(`${afspaceSrc}\n// ${importSeq++}`));
}

/** Rewrite main.js imports: host modules → globalThis.__afHost, ./afspace.js → data URL. */
function importMain() {
  let src = mainSrc;
  const hostImport = /import\s*\{([^}]*)\}\s*from\s*"(gpui-kit|gpui-base|herdr)";/g;
  assert.ok(/from "herdr";/.test(src), 'main.js imports from "herdr"');
  src = src.replace(hostImport, (_m, names) => `const {${names}} = globalThis.__afHost;`);
  assert.ok(src.includes('"./afspace.js"'), 'main.js imports ./afspace.js');
  src = src.replace('"./afspace.js"', JSON.stringify(dataUrl(afspaceSrc)));
  return import(dataUrl(`${src}\n// ${importSeq++}`));
}

/** Chainable stand-in for gpui-kit elements; records ids, text, and click handlers. */
function el() {
  const node = { id: null, kids: [], click: null };
  const proxy = new Proxy(node, {
    get(target, prop) {
      if (prop === '__node') return target;
      if (prop === 'id') return (v) => ((target.id = v), proxy);
      if (prop === 'child') return (c) => (target.kids.push(c), proxy);
      if (prop === 'children') return (arr) => (target.kids.push(...arr), proxy);
      if (prop === 'when') return (cond, fn) => (cond ? fn(proxy) : proxy);
      if (prop === 'on_click') return (fn) => ((target.click = fn), proxy);
      if (prop === 'then') return undefined;
      return () => proxy;
    },
  });
  return proxy;
}

function walk(n, fn) {
  if (n && n.__node) {
    fn(n.__node);
    for (const k of n.__node.kids) walk(k, fn);
  }
}
function findById(tree, id) {
  let hit = null;
  walk(tree, (n) => { if (n.id === id) hit = n; });
  return hit;
}
function textOf(tree) {
  const out = [];
  (function rec(n) {
    if (typeof n === 'string') out.push(n);
    else if (n && n.__node) for (const k of n.__node.kids) rec(k);
  })(tree);
  return out.join(' ');
}

function spaceListJson(names) {
  return JSON.stringify({
    current: null,
    default: { name: null, label: '(default)', path: '/h/.agentfleet', current: true },
    spaces: names.map((name) => ({ name, path: `/h/.agentfleet/spaces/${name}`, current: false })),
  });
}

function makeHost(state) {
  return {
    View: class {},
    div: el,
    v_flex: el,
    h_flex: el,
    home: () => '/h',
    spaces: () => [],
    focused: () => ({}),
    run: () => {},
    theme: () => ({}),
    notify: (n) => state.notes.push(n),
    exec: async (bin, args) => {
      state.calls.push(args);
      if (args.includes('space') && args.includes('ls')) {
        return { code: 0, stdout: spaceListJson(state.spaceNames), stderr: '' };
      }
      if (args.includes('ls')) {
        const i = args.indexOf('--space');
        const sp = i >= 0 ? args[i + 1] : null;
        const sessions = (state.sessionsBySpace[sp || ''] || []).map((title, n) => ({
          id: `${sp || 'def'}-${n}`,
          title,
          herdr: { runtime: 'exited' },
        }));
        return { code: 0, stdout: JSON.stringify({ sessions, queryOk: true }), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function makeCx(pending) {
  const cx = {
    notify() {},
    spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); },
    timer: { every() { return { cancel() {} }; } },
  };
  return cx;
}

async function settle(pending) {
  while (pending.length) await pending.shift();
}

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

describe('af sessions afspace helpers', () => {
  it('normalizes names: default → null, invalid → null', async () => {
    const a = await importAfspace();
    assert.equal(a.normalizeAfltSpace(null), null);
    assert.equal(a.normalizeAfltSpace(''), null);
    assert.equal(a.normalizeAfltSpace('default'), null);
    assert.equal(a.normalizeAfltSpace('(default)'), null);
    assert.equal(a.normalizeAfltSpace('../x'), null);
    assert.equal(a.normalizeAfltSpace('a/b'), null);
    assert.equal(a.normalizeAfltSpace(' scratch-composer '), 'scratch-composer');
    assert.equal(a.afltSpaceLabel(null), 'default');
    assert.equal(a.afltSpaceLabel('lab'), 'lab');
  });

  it('builds --space args only for named spaces', async () => {
    const a = await importAfspace();
    assert.deepEqual(a.afltSpaceArgs(null), []);
    assert.deepEqual(a.withAfltSpace(['ls', '--json', '--all'], null), ['ls', '--json', '--all']);
    assert.deepEqual(a.withAfltSpace(['resume', 't', '--no-open'], 'lab'), ['--space', 'lab', 'resume', 't', '--no-open']);
  });

  it('parses aflt space ls --json and lists default first', async () => {
    const a = await importAfspace();
    const p = a.parseAfltSpaceList(spaceListJson(['zeta', 'alpha', 'bad/name']));
    assert.equal(p.error, null);
    assert.deepEqual(p.names, ['alpha', 'zeta']);
    assert.deepEqual(a.afltSpaceOptions(p.names), [null, 'alpha', 'zeta']);
    assert.equal(a.parseAfltSpaceList('nope').error, 'parse failed');
    assert.equal(a.parseAfltSpaceList('{}').error, 'bad json');
  });

  it('resolves a vanished space to default with missing=true', async () => {
    const a = await importAfspace();
    assert.deepEqual(a.resolveAfltSpace('lab', ['lab']), { space: 'lab', missing: false });
    assert.deepEqual(a.resolveAfltSpace('gone', ['lab']), { space: null, missing: true });
    assert.deepEqual(a.resolveAfltSpace(null, []), { space: null, missing: false });
  });

  it('loads and saves through Web Storage, tolerating missing/broken storage', async () => {
    const a = await importAfspace();
    const st = memoryStorage();
    assert.equal(a.loadAfltSpace(st), null);
    assert.equal(a.saveAfltSpace(st, 'lab'), true);
    assert.equal(st.getItem(a.AFLT_SPACE_KEY), 'lab');
    assert.equal(a.loadAfltSpace(st), 'lab');
    a.saveAfltSpace(st, null);
    assert.equal(st.getItem(a.AFLT_SPACE_KEY), '');
    assert.equal(a.loadAfltSpace(st), null);
    assert.equal(a.loadAfltSpace(null), null);
    assert.equal(a.saveAfltSpace(undefined, 'lab'), false);
    const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
    assert.equal(a.loadAfltSpace(broken), null);
    assert.equal(a.saveAfltSpace(broken, 'lab'), false);
  });
});

describe('af sessions panel: aflt space picker', () => {
  let state;
  let prevStorage;

  beforeEach(() => {
    prevStorage = globalThis.localStorage;
    state = {
      calls: [],
      notes: [],
      spaceNames: ['lab', 'scratch-composer'],
      sessionsBySpace: { '': ['default-one'], lab: ['lab-one', 'lab-two'] },
    };
    globalThis.__afHost = makeHost(state);
  });

  afterEach(() => {
    delete globalThis.__afHost;
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  });

  async function start(storage) {
    globalThis.localStorage = storage;
    const { default: AfSessions } = await importMain();
    const pending = [];
    const cx = makeCx(pending);
    const view = new AfSessions();
    view.init({}, cx);
    await settle(pending);
    return { view, cx, pending };
  }

  it('every aflt call goes through the space-aware wrapper (static check)', () => {
    const direct = mainSrc.match(/execAf\(\s*\[[^\]]*\]/g) || [];
    // Only `aflt space ls` (space-independent) may call execAf directly.
    assert.deepEqual(direct, ['execAf(["space", "ls", "--json"]']);
    assert.match(mainSrc, /this\.af\(\["ls", "--json", "--all"\]/);
    assert.match(mainSrc, /this\.af\(\["adopt", title\][^)]*row\.afltSpace\)/);
    assert.match(mainSrc, /this\.af\(\["resume", row\.title, "--no-open"\][^)]*row\.afltSpace\)/);
  });

  it('default space: no --space flag, header shows "default"', async () => {
    const { view, cx } = await start(memoryStorage());
    assert.equal(view.afltSpace, null);
    const lsCall = state.calls.find((a) => a[0] === 'ls');
    assert.deepEqual(lsCall, ['ls', '--json', '--all']);
    assert.deepEqual(view.afltSpaceNames, ['lab', 'scratch-composer']);
    assert.deepEqual(view.sessions.map((s) => s.title), ['default-one']);
    const tree = view.render(cx);
    const chip = findById(tree, 'af-space-chip');
    assert.ok(chip, 'header has the space chip');
    assert.match(textOf({ __node: chip }), /default/);
  });

  it('picking a space persists it, passes --space to ls, and tags rows', async () => {
    const storage = memoryStorage();
    const { view, cx, pending } = await start(storage);
    // Open picker via the chip, then click the "lab" option.
    findById(view.render(cx), 'af-space-chip').click({}, cx);
    assert.equal(view.afltSpacePickerOpen, true);
    const tree = view.render(cx);
    assert.ok(findById(tree, 'af-space-opt-(default)'));
    assert.ok(findById(tree, 'af-space-opt-scratch-composer'));
    findById(tree, 'af-space-opt-lab').click({}, cx);
    await settle(pending);
    assert.equal(view.afltSpace, 'lab');
    assert.equal(view.afltSpacePickerOpen, false);
    assert.equal(storage.getItem('afltSpace'), 'lab');
    const lsCalls = state.calls.filter((a) => a.includes('--all'));
    assert.deepEqual(lsCalls.pop(), ['--space', 'lab', 'ls', '--json', '--all']);
    assert.deepEqual(view.sessions.map((s) => s.title).sort(), ['lab-one', 'lab-two']);
    assert.ok(view.sessions.every((s) => s.afltSpace === 'lab'));
    assert.match(textOf({ __node: findById(view.render(cx), 'af-space-chip') }), /lab/);
  });

  it('restores the saved space on start', async () => {
    const { view } = await start(memoryStorage({ afltSpace: 'lab' }));
    assert.equal(view.afltSpace, 'lab');
    assert.deepEqual(state.calls.find((a) => a.includes('--all')), ['--space', 'lab', 'ls', '--json', '--all']);
  });

  it('resume and adopt run in the row\'s space', async () => {
    const { view, cx, pending } = await start(memoryStorage({ afltSpace: 'lab' }));
    const row = view.sessions[0];
    view.onRowClick(row, cx);
    await settle(pending);
    assert.ok(state.calls.some((a) => a.join(' ') === `--space lab resume ${row.title} --no-open`), JSON.stringify(state.calls));
    await view.adoptAndFocus(row, cx);
    await settle(pending);
    assert.ok(state.calls.some((a) => a.join(' ') === `--space lab adopt ${row.title}`));
  });

  it('falls back to default with a toast when the saved space disappears', async () => {
    state.spaceNames = ['scratch-composer'];
    const storage = memoryStorage({ afltSpace: 'lab' });
    const { view } = await start(storage);
    assert.equal(view.afltSpace, null);
    assert.equal(storage.getItem('afltSpace'), '');
    assert.equal(state.notes.length, 1);
    assert.equal(state.notes[0].level, 'warning');
    assert.match(state.notes[0].body, /"lab" no longer exists/);
    assert.deepEqual(state.calls.find((a) => a.includes('--all')), ['ls', '--json', '--all']);
    assert.deepEqual(view.sessions.map((s) => s.title), ['default-one']);
  });

  it('works without localStorage (selection lives for the session only)', async () => {
    const { view, cx, pending } = await start(undefined);
    view.pickAfltSpace('lab', cx);
    await settle(pending);
    assert.equal(view.afltSpace, 'lab');
  });
});
