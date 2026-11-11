/**
 * verify-client.mjs — loads client.js exactly as the browser loader would and
 * proves, WITHOUT a browser, the P1 wiring contract:
 *
 *   1. the module id EQUALS the package name (KICKOFF 避雷 #5);
 *   2. the factory returns apply with inject ['slots','locale'], and the
 *      factory really executes — a stray backtick inside the CSS template
 *      literal is a load-time SyntaxError that `node --check` cannot see
 *      (避雷 #3);
 *   3. apply() registers exactly one entry on conversation.input.left with our
 *      own id, and registers NOTHING on conversation.input.model (the seat
 *      that must never be shadowed) or on the dock/hero rows;
 *   4. the entry injects the session id verbatim;
 *   5. the closed state renders a .pf-btn trigger and no popover;
 *   6. the open card renders the three P1 states in order — reading, empty
 *      draft, draft loaded — and the result state renders the 原稿/改写 pair,
 *      the hard-fact counter, and the adopt/discard row;
 *   7. clicking 采纳 really writes the rewrite through inputActions.setDraft
 *      and persists it (the one behaviour that must not be a stub);
 *   8. CSS layout contracts survive: 28px trigger, min-height:0 on the scroll
 *      containers (避雷 #4), flex:none on the root, and no backtick in CSS.
 *
 * Usage: node verify-client.mjs
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

let loaded = null;
/* A real-enough localStorage: the settings layer keys its store by workspace,
 * so without one the bucket logic would be silently untested. */
const storage = new Map();
const localStorageStub = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};
new Function('window', src)({
  __ModuleLoader__: { load: (def) => { loaded = def; } },
  localStorage: localStorageStub,
});
if (!loaded) throw new Error('client.js never called __ModuleLoader__.load');
console.log('module id =', loaded.id, '| package name =', pkg.name);

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log('  ok   ' + label + (extra ? ' — ' + extra : '')); }
  else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
};

ok('module id equals the package name (避雷 #5)', loaded.id === pkg.name);
ok('client manifest injects the conversation UI module',
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'));

/* ── minimal React ─────────────────────────────────────────────────────── */
/* Two structures on purpose: `registry` keeps one persistent frame per
 * component (so seeded state survives a re-render), `stack` tracks which
 * component is currently executing (so hooks land in the right frame). A
 * single array cannot do both — a frame must be found by component AND be the
 * top of the stack, and popping must never evict a sibling's frame. */
const registry = [];
const stack = [];
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length > 1 ? children : children[0] },
  }),
  Fragment: Symbol('Fragment'),
  useState: (init) => {
    const frame = stack[stack.length - 1];
    const i = frame.cursor++;
    if (!(i in frame.slots)) frame.slots[i] = typeof init === 'function' ? init() : init;
    return [frame.slots[i], (next) => {
      frame.slots[i] = typeof next === 'function' ? next(frame.slots[i]) : next;
    }];
  },
  /* Effects are RECORDED, not run: most of them touch document/window, which do
   * not exist here, and running them implicitly would fire real network calls
   * mid-test. Keeping them also lets a test flush one specific frame's effects
   * on demand — which is how the reload path (mount -> resolve cwd -> re-read
   * the workspace bucket) gets covered without a browser.
   * NOTE: useEffect deliberately does NOT advance `cursor`. Slot indices are
   * part of this harness's contract (open(0), triggerRef(1), ...); advancing
   * them here would shift every frame below and silently un-test the rest. */
  useEffect: (fn, deps) => {
    const frame = stack[stack.length - 1];
    frame.effects = frame.effects || {};
    const i = frame.effectCursor || 0;
    frame.effectCursor = i + 1;
    frame.effects[i] = { fn, deps };
  },
  useCallback: (fn) => fn,
  useRef: (init) => {
    const frame = stack[stack.length - 1];
    const i = frame.cursor++;
    if (!(i in frame.slots)) frame.slots[i] = { current: init === undefined ? null : init };
    return frame.slots[i];
  },
};
/* react-dom is required only for createPortal. The stub records every portal so
 * the suite can prove WHERE the popover is mounted — which is the whole point of
 * using a portal at all: inside the composer's subtree, position:fixed resolves
 * against that subtree (backdrop-filter creates a containing block) and the
 * panel lands several centimetres off. */
/* The DOM globals this client half touches at RENDER time (as opposed to inside
 * effects, which this suite records rather than runs). Only document.body is
 * needed: the popover is portalled there so position:fixed resolves against the
 * viewport instead of the composer's backdrop-filtered containing block. */
const documentStub = { body: { __isBody: true } };
if (typeof globalThis.document === 'undefined') globalThis.document = documentStub;
const portals = [];
const ReactDOM = {
  createPortal(node, target, key) {
    portals.push({ node, target, key });
    return { __portal: true, node, target, key };
  },
};
const requireStub = (name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  throw new Error('unexpected require(' + name + ')');
};

function withFrame(component, fn) {
  let frame = registry.find(f => f.key === component);
  if (!frame) { frame = { key: component, cursor: 0, slots: {} }; registry.push(frame); }
  frame.cursor = 0;
  frame.effectCursor = 0;
  stack.push(frame);
  try { return fn(); } finally { stack.pop(); }
}

/* Run one recorded effect of one frame and let its promise settle. Used to drive
 * the settings effect (mount -> ask the Host for cwd -> re-read the workspace
 * bucket) deterministically, without a browser and without implicit network. */
async function flushEffect(frame, index) {
  const entry = frame.effects && frame.effects[index];
  if (!entry) throw new Error('no effect #' + index + ' recorded on this frame');
  await entry.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const mod = loaded.factory(requireStub);
console.log('inject =', JSON.stringify(mod.inject));
ok('factory injects slots + locale', Array.isArray(mod.inject) && mod.inject.join(',') === 'slots,locale');

/* ── ctx stub recording slot registrations ─────────────────────────────── */
const registrations = [];
const dicts = {};
const ctx = {
  effect: (fn) => { fn(); },
  get: () => undefined,
  slots: {
    inject: (key, cb) => { cb(); },
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
  locale: {
    register: (ns, d) => { dicts[ns] = d; return () => {}; },
    bind: (ns) => (key) => (dicts[ns] && dicts[ns].zh && dicts[ns].zh[key]) || key,
  },
};

mod.apply(ctx);

const left = registrations.filter(r => r.options.name === 'conversation.input.left');
const seat = registrations.filter(r => r.options.name === 'conversation.input.model');
const dock = registrations.filter(r => r.options.name === 'conversation.composer.dock');
const hero = registrations.filter(r => r.options.name === 'conversation.hero.options');
console.log('input.left =', left.length, '| input.model =', seat.length, '| composer.dock =', dock.length, '| hero.options =', hero.length);
ok('exactly one conversation.input.left registration', left.length === 1);
ok('registers our own fresh id', left[0] && left[0].options.id === 'dsh-prompt-forge');
ok('order is set (100)', left[0] && left[0].options.order === 100);
ok('NEVER registers on conversation.input.model (避雷: seat shadows shipped UI)', seat.length === 0);
ok('does not touch composer.dock / hero.options', dock.length === 0 && hero.length === 0);

const injected = left[0].options.inject('session-test');
ok('inject forwards sessionId verbatim', injected.sessionId === 'session-test');

/* ── P1 dictionaries ───────────────────────────────────────────────────── */
const zh = dicts['dsh-prompt-forge']?.zh ?? {};
const en = dicts['dsh-prompt-forge']?.en ?? {};
for (const key of ['replaced', 'unchanged', 'needDraft', 'labelOriginal', 'labelRewrite', 'adopt', 'discard', 'factKept', 'factFixed', 'factCapped', 'truncatedWarn', 'factInvented']) for (const key of ['costEstimate', 'costPeak', 'costOffPeak', 'costCalls', 'costUnknown']) {
  ok('zh dictionary has ' + key, typeof zh[key] === 'string' && zh[key].length > 0);
}
ok('zh and en carry the same keys',
  JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(dicts['dsh-prompt-forge']?.en ?? {}).sort()));

/* ── render helpers ────────────────────────────────────────────────────── */
const expand = (node, depth = 0) => {
  if (depth > 80) throw new Error('element tree too deep (render loop?)');
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(n => expand(n, depth + 1));
  /* A portal renders its node somewhere else in the document, but for the
   * assertions below the content is what matters; the mount point is checked
   * separately against the recorded portal targets. */
  if (node.__portal) return expand(node.node, depth + 1);
  if (typeof node.type === 'function') {
    return withFrame(node.type, () => expand(node.type(node.props || {}), depth + 1));
  }
  if (node.props) {
    return { ...node, props: { ...node.props, children: expand(node.props.children, depth + 1) } };
  }
  return node;
};
const classesOf = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => classesOf(n, out)); return out; }
  if (node.props && node.props.className) out.push(String(node.props.className));
  if (node.props) classesOf(node.props.children, out);
  return out;
};
const textOf = (node, out = []) => {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => textOf(n, out)); return out; }
  if (node.props) textOf(node.props.children, out);
  return out;
};
const findButton = (node, label) => {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = findButton(n, label); if (hit) return hit; }
    return null;
  }
  if (node.type === 'button' && textOf(node).join('').includes(label)) return node;
  return findButton(node.props?.children, label);
};

const t = ctx.locale.bind('dsh-prompt-forge');
const props = { sessionId: 'session-test', t, ...injected };

/* ── closed state ─────────────────────────────────────────────────────── */
const closedClasses = classesOf(expand(left[0].component(props)));
console.log('closed classes =', JSON.stringify(closedClasses));
ok('closed state renders the .pf-btn trigger (cannot self-collapse)', closedClasses.some(c => c.includes('pf-btn')));
ok('popover stays closed on first render', !closedClasses.some(c => c.includes('pf-pop')));

/* Force the panel open: ForgeButton hook order is open(0), busy(1),
 * triggerRef(2), popRef(3), runRef(4), cancelRef(5), closeTimer(6),
 * placement pos(7). The panel is a HOVER surface now, so `open` alone is the
 * whole story. */
const buttonFrame = registry.find(f => f.slots[0] === false && f.slots[1] === false);
if (!buttonFrame) throw new Error('could not find the ForgeButton state frame');
ok('the trigger starts idle (not busy)', buttonFrame.slots[1] === false);
buttonFrame.slots[0] = true;
buttonFrame.slots[7] = { left: 40, top: 60, maxHeight: 360 };

const openTree = expand(left[0].component(props));
const openClasses = classesOf(openTree);
console.log('open classes =', JSON.stringify(openClasses));
ok('trigger survives while open', openClasses.some(c => c.includes('pf-btn')));
for (const required of ['pf-pop', 'pf-body']) {
  ok('open popover renders .' + required, openClasses.some(c => c.includes(required)));
}
const readingText = textOf(openTree).join(' ');
ok('before the draft resolves it shows the reading hint', readingText.includes(zh.loading ?? 'loading'));

/* ForgeCard hook order: draft view(0), settings(1), busy(2), error(3), result(4). */
const cardFrame = registry.find(f => f.slots[0] && typeof f.slots[0] === 'object' && 'ready' in f.slots[0]);
if (!cardFrame) throw new Error('could not find the ForgeCard state frame');

/* The trigger button is the action now, so there is no in-panel 改写 button to
 * find by label: locate it by its class instead. */
const findTrigger = (tree) => {
  let hit = null;
  const walk = (node) => {
    if (hit || node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'button' && /(^|\s)pf-btn(\s|$)/.test(String(node.props?.className || ''))) { hit = node; return; }
    walk(node.props?.children);
  };
  walk(tree);
  return hit;
};

/* Empty draft → the click must refuse, not call the model. */
cardFrame.slots[0] = { draft: '', actions: null, ready: true };
const emptyTree = expand(left[0].component(props));
ok('empty draft shows the needDraft hint', textOf(emptyTree).join(' ').includes(zh.needDraft));
ok('the panel carries no 改写 button of its own', findButton(emptyTree, zh.rewriteBtn ?? '改写') === null);
let emptyFetches = 0;
const realFetchEmpty = globalThis.fetch;
globalThis.fetch = () => { emptyFetches++; return Promise.reject(new Error('offline')); };
findTrigger(emptyTree).props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
globalThis.fetch = realFetchEmpty;
ok('clicking the trigger with an empty draft calls nobody', emptyFetches === 0, 'fetches=' + emptyFetches);

/* Draft loaded → the same click now runs the rewrite. */
let written = null;
let persisted = 0;
const actions = { setDraft: (text) => { written = text; }, persistDraft: () => { persisted++; } };
cardFrame.slots[0] = { draft: '把 index.js 的路由改成 exact', actions, ready: true };
const readyTree = expand(left[0].component(props));
ok('loaded draft shows the draftReady hint with a char count',
  textOf(readyTree).join(' ').includes(zh.draftReady));
ok('the trigger is enabled once a draft exists', findTrigger(readyTree)?.props?.disabled !== true);

/* Result state → 原稿 / 改写 pair + hard-fact counter + adopt/discard. */
const rewrite = '把 `index.js` 的 /prompt-forge/api 路由注册改成 kind: exact。';
cardFrame.slots[5] = {
  ok: true,
  rewrite,
  facts: { total: 3, kept: 3, missing: [], repaired: false, reinjected: false },
  model: { provider: 'p', model: 'm' },
};
const resultTree = expand(left[0].component(props));
const resultClasses = classesOf(resultTree);
for (const required of ['pf-preview', 'pf-pane', 'pf-pane-h', 'pf-pane-b', 'pf-fact', 'pf-actions']) {
  ok('result state renders .' + required, resultClasses.some(c => c.includes(required)));
}
const resultText = textOf(resultTree).join(' ');
ok('result shows the original label', resultText.includes(zh.labelOriginal));
ok('result shows the rewrite label', resultText.includes(zh.labelRewrite));
ok('result shows the hard-fact counter', resultText.includes(zh.factKept + ' 3/3'));
ok('no-literal draft says so instead of printing 0/0', !resultText.includes('0/0'));

/* A draft with no literal at all must not look like a failed check. */
cardFrame.slots[5] = {
  ok: true,
  rewrite: '把登录页加一个记住我。',
  facts: { total: 0, kept: 0, missing: [], repaired: false, reinjected: false },
  model: { provider: 'p', model: 'm' },
};
const noFactTree = expand(left[0].component(props));
const noFactText = textOf(noFactTree).join(' ');
ok('total=0 renders the factNone wording', noFactText.includes(zh.factNone));
ok('total=0 does not print a 0/0 counter', !noFactText.includes('0/0'));

/* A capped draft must say so. Without this the panel prints "40/40" for a draft
 * with sixty literals — the most reassuring line on screen, about the one state
 * that is not fully guarded. */
cardFrame.slots[5] = {
  ok: true,
  rewrite: '把 login.ts 里的 token 刷新改掉。',
  facts: { total: 40, kept: 40, missing: [], repaired: false, reinjected: false, invented: [], capped: true, inventedChecked: false },
  model: { provider: 'p', model: 'm' },
};
const cappedTree = expand(left[0].component(props));
const cappedText = textOf(cappedTree).join(' ');
ok('a capped fact scan says it was capped', cappedText.includes(zh.factCapped), cappedText.slice(0, 160));
ok('a capped fact scan still shows the counter', cappedText.includes(zh.factKept + ' 40/40'));
ok('an uncapped scan never claims the cap bit', !resultText.includes(zh.factCapped));
ok('total=0 is not flagged as a warning',
  !classesOf(noFactTree).some(c => c.includes('pf-fact') && c.includes('warn')));ok('result shows the rewrite body', resultText.includes(rewrite));
ok('result shows the original draft', resultText.includes('把 index.js 的路由改成 exact'));

/* The one behaviour that must not be a stub: adopt writes the draft back. */
const adoptBtn = findButton(resultTree, zh.adopt);
ok('adopt button exists', adoptBtn !== null);
adoptBtn.props.onClick();
ok('adopt writes the rewrite through inputActions.setDraft', written === rewrite, String(written).slice(0, 40));
/* One flush is not enough. The host publishes the composer to its per-session
 * store on its own schedule, so a single same-tick call can persist the OLD
 * draft — which is exactly the bug where a rewrite vanished after switching
 * sessions away and back. The fix flushes again on the microtask and on the
 * next frame; this asserts the immediate one, then the deferred ones below. */
ok('adopt flushes the draft immediately', persisted >= 1, 'persisted=' + persisted);
const afterAdopt = persisted;
await new Promise((resolve) => setTimeout(resolve, 0));
ok('adopt flushes the draft again after the editor commit', persisted > afterAdopt, 'persisted=' + persisted);

/* Missing facts must be surfaced, not swallowed. */
written = null;
cardFrame.slots[5] = {
  ok: true,
  rewrite: '没有事实的版本',
  facts: { total: 3, kept: 1, missing: ['index.js', 'v0.2.0'], repaired: true, reinjected: true },
};
const warnTree = expand(left[0].component(props));
const warnText = textOf(warnTree).join(' ');
ok('a fact gap is surfaced in the counter', warnText.includes(zh.factFixed + ' 2'), warnText.slice(0, 120));
ok('a fact gap adds the warn class', classesOf(warnTree).some(c => /pf-fact warn/.test(c)));


/* ── P3: the judgement row ─────────────────────────────────────────────── */
/* The verdict is the one line on this panel that is a model's opinion rather
 * than a deterministic count, so it gets its own class and its own three states.
 * The state that matters most is the third one: a judgement that did not run
 * must never render like a judgement that passed. */
cardFrame.slots[5] = {
  ok: true,
  rewrite,
  facts: { total: 3, kept: 3, missing: [], repaired: false, reinjected: false },
  judge: {
    enabled: true, judged: true, version: 1,
    signals: { fidelity: 'pass', depth: 'deepened', grounding: 'grounded', executability: 'executable' },
    conflicts: [], verdict: 'ok', reason: '', error: '',
  },
  model: { provider: 'p', model: 'm' },
};
const judgedOkTree = expand(left[0].component(props));
const judgedOkText = textOf(judgedOkTree).join(' ');
ok('a clean verdict renders the judge row', classesOf(judgedOkTree).some(c => /pf-judge/.test(c)));
ok('a clean verdict says it passed', judgedOkText.includes(zh.judgeOk), judgedOkText.slice(0, 200));
ok('a clean verdict is not flagged', !classesOf(judgedOkTree).some(c => /pf-judge warn/.test(c)));

/* A verdict with something to look at must be visibly different, and must name
 * WHICH signal fired — a bare "worth a look" tells the user nothing to act on. */
cardFrame.slots[5] = {
  ok: true,
  rewrite,
  facts: { total: 3, kept: 3, missing: [], repaired: false, reinjected: false },
  judge: {
    enabled: true, judged: true, version: 1,
    signals: { fidelity: 'pass', depth: 'rephrased-only', grounding: 'inferred', executability: 'needs-clarification' },
    conflicts: ['depthIsCosmetic'], verdict: 'check', reason: '只换了措辞', error: '',
  },
  model: { provider: 'p', model: 'm' },
};
const judgedCheckTree = expand(left[0].component(props));
const judgedCheckText = textOf(judgedCheckTree).join(' ');
ok('a check verdict renders the check wording', judgedCheckText.includes(zh.judgeCheck));
ok('a check verdict is flagged as a warning', classesOf(judgedCheckTree).some(c => /pf-judge warn/.test(c)));
ok('a check verdict names the shallow depth', judgedCheckText.includes(zh.judgeDepthShallow));
ok('a check verdict names the inferred grounding', judgedCheckText.includes(zh.judgeGroundingInferred));
ok('a check verdict names the clarification need', judgedCheckText.includes(zh.judgeExecClarify));

/* A judgement that did not run is MUTED, never a pass. This is the failure the
 * whole feature exists to prevent, so it is asserted directly. */
cardFrame.slots[5] = {
  ok: true,
  rewrite,
  facts: { total: 3, kept: 3, missing: [], repaired: false, reinjected: false },
  judge: { enabled: true, judged: false, version: 1, signals: null, conflicts: [], verdict: 'unknown', reason: '', error: 'boom' },
  model: { provider: 'p', model: 'm' },
};
const judgedAbsentTree = expand(left[0].component(props));
const judgedAbsentText = textOf(judgedAbsentTree).join(' ');
ok('an unanswered verdict says so', judgedAbsentText.includes(zh.judgeAbsent));
ok('an unanswered verdict is muted, not a warning',
  classesOf(judgedAbsentTree).some(c => /pf-judge muted/.test(c)));
ok('an unanswered verdict never reads as a pass', !judgedAbsentText.includes(zh.judgeOk));

/* judge:false (the caller opted out) must render nothing at all — not an empty
 * row, not "not judged". Nothing was asked, so nothing is reported. */
cardFrame.slots[5] = {
  ok: true,
  rewrite,
  facts: { total: 3, kept: 3, missing: [], repaired: false, reinjected: false },
  judge: { enabled: false, judged: false, version: 1, signals: null, conflicts: [], verdict: 'unknown', reason: '', error: '' },
  model: { provider: 'p', model: 'm' },
};
const judgedOffTree = expand(left[0].component(props));
ok('judge:false renders no judge row', !classesOf(judgedOffTree).some(c => /pf-judge/.test(c)));
ok('judge:false does not claim anything about the rewrite',
  !textOf(judgedOffTree).join(' ').includes(zh.judgeAbsent));

/* The dict must carry every key the renderer can reach, or a user sees the raw
 * key. Checked against the zh dictionary rather than a literal list so a new
 * signal value cannot be added without its wording. */
for (const key of ['judgeOk', 'judgeCheck', 'judgeFix', 'judgeAbsent', 'judgeFidelityFail',
  'judgeDepthShallow', 'judgeDepthCompressed', 'judgeGroundingInvented', 'judgeGroundingInferred',
  'judgeExecBlocked', 'judgeExecClarify', 'conflict_depthIsFabricated',
  'conflict_depthBreaksExecutability', 'conflict_depthIsCosmetic', 'conflict_fidelityContradictsFactGate']) {
  ok('the zh dictionary has ' + key, typeof zh[key] === 'string' && zh[key] !== '');
  ok('the en dictionary has ' + key, typeof en[key] === 'string' && en[key] !== '');
}
cardFrame.slots[5] = null;

/* ── P2: mode row + settings ──────────────────────────────────────────── */
cardFrame.slots[5] = null;
cardFrame.slots[1] = { mode: 'polish', workspaceDocs: true };
const modeTree = expand(left[0].component(props));
const modeText = textOf(modeTree).join(' ');
ok('the mode row renders both modes', modeText.includes(zh.modePolish) && modeText.includes(zh.modeAcceptance));
ok('the docs toggle renders', modeText.includes(zh.docsToggle));
ok('the active mode is marked checked', classesOf(modeTree).some(c => /pf-mode on/.test(c)));

/* ---- The mode row is a RADIOGROUP and docs is a separate SWITCH (UI pass).
 * Before this, three identical blue pills sat side by side: two exclusive
 * modes and one independent toggle, visually indistinguishable, telling screen
 * readers that all three could be "on" at once. */
const byClass = (tree, re) => {
  let found = null;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type === 'function') { walk(expand(node)); return; }
    const p = node.props || {};
    if (typeof p.className === 'string' && re.test(p.className)) { found = node; return; }
    walk(p.children);
  })(tree);
  return found;
};
const allByClass = (tree, re) => {
  const out = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node.type === 'function') { walk(expand(node)); return; }
    const p = node.props || {};
    if (typeof p.className === 'string' && re.test(p.className)) out.push(node);
    walk(p.children);
  })(tree);
  return out;
};
const modeButtons = allByClass(modeTree, /(^|\s)pf-mode(\s|$)/);
const modeGroupNode = byClass(modeTree, /(^|\s)pf-seg(\s|$)/);
const docsBtn = allByClass(modeTree, /(^|\s)pf-docs(\s|$)/)[0] || null;
const hasClassDeep = (node, re) => {
  let hit = false;
  (function walk(n) {
    if (hit || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n.type === 'function') { walk(expand(n)); return; }
    const p = n.props || {};
    if (typeof p.className === 'string' && re.test(p.className)) { hit = true; return; }
    walk(p.children);
  })(node);
  return hit;
};
ok('the docs switch is NOT a mode pill',
  !!docsBtn && /(^|\s)pf-docs(\s|$)/.test(docsBtn.props.className || ''),
  docsBtn && docsBtn.props.className);
ok('the docs switch keeps aria-pressed, because it really is independent',
  !!docsBtn && docsBtn.props['aria-pressed'] === 'true');
/* A tick is the non-colour cue: the switch must not communicate its state by
 * fill colour alone. */
ok('the docs switch carries a visible tick, not colour alone',
  !!docsBtn && hasClassDeep(docsBtn, /(^|\s)tick(\s|$)/));
ok('the docs switch tells assistive tech what it reads',
  !!docsBtn && typeof docsBtn.props['aria-label'] === 'string'
  && docsBtn.props['aria-label'].includes(zh.docsToggle));
ok('the two modes expose role=radio', modeButtons.length === 2 && modeButtons.every(b => b.props.role === 'radio'),
  modeButtons.map(b => b.props.role).join(','));
ok('exactly one mode is aria-checked=true at a time',
  modeButtons.filter(b => b.props['aria-checked'] === 'true').length === 1);
ok('the unchecked mode says aria-checked=false',
  modeButtons.filter(b => b.props['aria-checked'] === 'false').length === 1);
ok('the modes no longer claim to be independent pressed buttons',
  modeButtons.every(b => !('aria-pressed' in (b.props || {}))));
ok('the mode group names itself for assistive tech',
  modeButtons.length === 2 && modeGroupNode !== null && modeGroupNode.props.role === 'radiogroup'
  && modeGroupNode.props['aria-label'] === zh.modeGroup, zh.modeGroup);
ok('the mode group is a single tab stop (roving tabindex)',
  modeButtons.filter(b => b.props.tabIndex === 0).length === 1
  && modeButtons.filter(b => b.props.tabIndex === -1).length === 1);

/* The CSS-level half of the UI contract lives further down, after `code` is
 * defined — see the "mode row CSS" block. */
const acceptBtn = findButton(modeTree, zh.modeAcceptance);
ok('the acceptance mode button exists', acceptBtn !== null);
acceptBtn.props.onClick();
ok('switching mode writes settings', cardFrame.slots[1]?.mode === 'acceptance', JSON.stringify(cardFrame.slots[1]));

/* ── settings persistence: per-workspace buckets, one POST, no legacy bleed ── */
const SETTINGS_KEY = 'dsh-prompt-forge:settings';
const readStore = () => JSON.parse(storage.get(SETTINGS_KEY) || '{}');
ok('the write is a cwd-keyed map, not a flat object', !('mode' in readStore()) && 'mode' in (readStore()[''] || {}));

/* A legacy flat object (<= 0.3.1) must be migrated, never treated as a bucket. */
storage.set(SETTINGS_KEY, JSON.stringify({ mode: 'acceptance', workspaceDocs: false }));
cardFrame.slots[2] = 'C:/wsA';
const docsBtnA = findButton(expand(left[0].component(props)), zh.docsToggle);
docsBtnA.props.onClick();
const afterA = readStore();
ok('a legacy flat value is migrated into the "" bucket only',
  'mode' in (afterA[''] || {}) && !('mode' in afterA));

/* Workspace A's choice must not leak into workspace B. */
const aSnapshot = JSON.stringify(afterA['C:/wsA']);
cardFrame.slots[2] = 'C:/wsB';
const docsBtnB = findButton(expand(left[0].component(props)), zh.docsToggle);
docsBtnB.props.onClick();
const afterB = readStore();
ok('each workspace gets its own bucket', Boolean(afterB['C:/wsA']) && Boolean(afterB['C:/wsB']));
ok('workspace B never overwrites workspace A', JSON.stringify(afterB['C:/wsA']) === aSnapshot);

/* One click must mean one host write — the side effect used to live inside the
 * state updater, which React may replay. */
let settingsPosts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const body = JSON.parse(init.body);
  if (body.command === 'settings-set') settingsPosts++;
  return Promise.reject(new Error('offline'));
};
cardFrame.slots[2] = 'C:/wsC';
findButton(expand(left[0].component(props)), zh.docsToggle).props.onClick();
globalThis.fetch = realFetch;
ok('one settings click sends exactly one host write', settingsPosts === 1, 'posts=' + settingsPosts);

/* Acceptance result → the acceptance status line, and a warn when missing. */
cardFrame.slots[5] = {
  ok: true, rewrite, mode: 'acceptance',
  facts: { total: 3, kept: 3, missing: [], repaired: false, reinjected: false },
  acceptance: { required: true, present: true },
  context: { turns: 0, workspaceDocs: [{ name: 'AGENTS.md', truncated: false }], cwd: 'C:/ws' },
};
const accTree = expand(left[0].component(props));
const accText = textOf(accTree).join(' ');
ok('a present acceptance section is reported', accText.includes(zh.acceptanceOk));
ok('the used docs are reported', accText.includes(zh.docsUsed) && accText.includes('AGENTS.md'));

cardFrame.slots[5] = {
  ok: true, rewrite, mode: 'acceptance',
  facts: { total: 0, kept: 0, missing: [], repaired: false, reinjected: false },
  acceptance: { required: true, present: false },
  context: { turns: 0, workspaceDocs: [], cwd: 'C:/ws' },
};
const missTree = expand(left[0].component(props));
ok('a missing acceptance section is surfaced', textOf(missTree).join(' ').includes(zh.acceptanceMissing));
ok('a missing acceptance section adds the warn class', classesOf(missTree).some(c => /pf-fact warn/.test(c)));

/* A declared absence is the honest outcome — the model said, in the agreed
 * token, that the draft has nothing checkable. Painting it yellow would teach
 * the model to invent a section just to avoid the warning, which is the failure
 * the mode exists to prevent. */
cardFrame.slots[5] = {
  ok: true, rewrite, mode: 'acceptance',
  facts: { total: 0, kept: 0, missing: [], repaired: false, reinjected: false },
  acceptance: { required: true, present: false, declared: true },
  context: { turns: 0, workspaceDocs: [], cwd: 'C:/ws' },
};
const declaredTree = expand(left[0].component(props));
const declaredText = textOf(declaredTree).join(' ');
ok('a declared absence has its own wording', declaredText.includes(zh.acceptanceDeclared));
ok('a declared absence is not worded as a failure', !declaredText.includes(zh.acceptanceMissing));
ok('a declared absence does not raise the warn class',
  !classesOf(declaredTree).some(c => /pf-fact warn/.test(c)));

/* The rewrite request must carry the chosen mode and docs flag. */
ok('the trigger is present in the mode tree', findTrigger(modeTree) !== null);

/* Intercept fetch and actually fire the rewrite: the wire payload is the only
 * proof that the mode toggle reaches the Host instead of staying in React. */
let lastFetchBody = null;
globalThis.fetch = async (url, init) => {
  lastFetchBody = JSON.parse(init.body);
  return {
    json: async () => ({
      ok: true, rewrite: 'X', mode: lastFetchBody.mode,
      facts: { total: 0, kept: 0, missing: [], repaired: false, reinjected: false },
      acceptance: { required: true, present: true },
      context: { turns: 0, workspaceDocs: [], cwd: '' },
    }),
  };
};
await new Promise((resolve) => setTimeout(resolve, 0)); /* let the settings write settle */
cardFrame.slots[1] = { mode: 'acceptance', workspaceDocs: false };
cardFrame.slots[5] = null; /* no preview: we need the rewrite button, not adopt */
const runTree = expand(left[0].component(props));
const fireBtn = findTrigger(runTree);
lastFetchBody = null;
fireBtn.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
ok('the request carries the chosen mode', lastFetchBody?.mode === 'acceptance', JSON.stringify(lastFetchBody?.mode));
ok('the request carries the docs flag', lastFetchBody?.workspaceDocs === false, String(lastFetchBody?.workspaceDocs));

/* ── one-click replace: the rewrite lands WITHOUT a second click ──────────
 * The live build collapses the composer's own edits into one undo step, so a
 * clean rewrite is applied directly and Ctrl+Z is the way back. The preview
 * must therefore NOT be the happy path any more; it survives only as the
 * stop-and-look branch for a lossy result. */
ok('a clean rewrite is written into the composer without clicking 采纳',
  written === 'X', String(written).slice(0, 40));
ok('the request is not left in the preview state', cardFrame.slots[5] === null,
  JSON.stringify(cardFrame.slots[5] && 'result-present'));

/* The receipt must say what happened AND how to undo it: a silent swap plus a
 * Ctrl+Z the user does not know about is a worse deal than the old two-step. */
cardFrame.slots[0] = { draft: written, actions, ready: true }; /* composer now holds it */
const doneTree = expand(left[0].component(props));
const doneText = textOf(doneTree).join(' ');
ok('the replacement leaves a visible receipt', doneText.includes(zh.replaced), doneText.slice(0, 80));
/* No Ctrl+Z reminder: undoing an edit is common knowledge, and a hint that
 * states the obvious reads as the product doubting the user. */
ok('the receipt does NOT nag about Ctrl+Z',
  !/Ctrl\+Z/.test(doneText) && !('undoHint' in zh), doneText.slice(0, 120));
ok('the receipt keeps the fact counter so the swap can be judged', doneText.includes(zh.factNone));
/* Acceptance mode is reported HERE or nowhere: every click lands through the
 * one-shot path, so a receipt that counted facts only made the whole mode mute
 * in normal use. The screenshot that exposed it showed 验收补全 selected with no
 * acceptance line at all. */
ok('the one-click receipt reports the acceptance outcome', doneText.includes(zh.acceptanceOk),
  doneText.slice(0, 160));
ok('the receipt survives a re-render (state, not a toast timer)',
  cardFrame.slots[6] !== null && cardFrame.slots[6].rewrite === 'X',
  JSON.stringify(cardFrame.slots[6]));

/* The honest third state on the receipt too — and it must not be painted as a
 * failure there either, or the mode teaches the model to fake a section. */
cardFrame.slots[6] = Object.assign({}, cardFrame.slots[6], {
  acceptance: { required: true, present: false, declared: true },
});
const doneDeclaredTree = expand(left[0].component(props));
const doneDeclaredText = textOf(doneDeclaredTree).join(' ');
ok('the receipt uses the declared wording for its honest outcome',
  doneDeclaredText.includes(zh.acceptanceDeclared), doneDeclaredText.slice(0, 160));
ok('the receipt does not word a declared outcome as a missing section',
  !doneDeclaredText.includes(zh.acceptanceMissing));
ok('the receipt does not raise the warn class for a declared outcome',
  !classesOf(doneDeclaredTree).some(c => /pf-done-a warn/.test(c)));

/* And the genuinely missing case DOES warn, so the three states stay apart. */
cardFrame.slots[6] = Object.assign({}, cardFrame.slots[6], {
  acceptance: { required: true, present: false, declared: false },
});
const doneMissingTree = expand(left[0].component(props));
ok('the receipt words a truly missing section as missing',
  textOf(doneMissingTree).join(' ').includes(zh.acceptanceMissing));
ok('the receipt raises the warn class when the section is truly missing',
  classesOf(doneMissingTree).some(c => /pf-done-a warn/.test(c)));
cardFrame.slots[6] = Object.assign({}, cardFrame.slots[6], { acceptance: { required: true, present: true } });

/* The claim must expire by STATE, not by a timer: once the composer no longer
 * holds what we wrote (Ctrl+Z, or the user typing), "已替换" is a lie. */
cardFrame.slots[0] = { draft: '被撤销后的旧稿', actions, ready: true };
const revertedTree = expand(left[0].component(props));
const revertedText = textOf(revertedTree).join(' ');
ok('the receipt disappears once the draft no longer equals the rewrite',
  !revertedText.includes(zh.replaced), revertedText.slice(0, 80));

/* ── a lossy rewrite still lands, with no second gate ─────────────────────
 * The way back is Ctrl+Z, not a confirmation dialog, so even a rewrite that
 * dropped a literal goes straight into the composer; the receipt is what names
 * the damage. A preview here would be the very 采纳 button the user removed. */
let lossyWritten = null;
const lossyActions = { setDraft: (text) => { lossyWritten = text; }, persistDraft: () => {} };
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  return {
    json: async () => (body.command === 'rewrite'
      ? {
        ok: true,
        rewrite: '丢掉了 index.js 和 v0.2.0 的版本',
        facts: { total: 3, kept: 1, missing: ['index.js', 'v0.2.0'], repaired: true, reinjected: true },
      }
      : { ok: true }),
  };
};
cardFrame.slots[0] = { draft: '把 index.js 升到 v0.2.0，共三处事实', actions: lossyActions, ready: true };
cardFrame.slots[5] = null;
cardFrame.slots[6] = null;
const lossyTree = expand(left[0].component(props));
const lossyBtn = findTrigger(lossyTree);
lossyBtn.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
ok('a lossy rewrite still lands in the composer', lossyWritten === '丢掉了 index.js 和 v0.2.0 的版本',
  String(lossyWritten).slice(0, 30));
ok('a lossy rewrite leaves no preview behind', cardFrame.slots[5] === null,
  JSON.stringify(cardFrame.slots[5] && 'result-present'));
cardFrame.slots[0] = { draft: lossyWritten, actions: lossyActions, ready: true };
const lossyAfter = expand(left[0].component(props));
const lossyText = textOf(lossyAfter).join(' ');
ok('a lossy rewrite still shows the replacement receipt', lossyText.includes(zh.replaced));
ok('the receipt names how many literals had to be restored', lossyText.includes(zh.factFixed + ' 2'),
  lossyText.slice(0, 120));
ok('a lossy rewrite offers no 采纳/放弃 pair', findButton(lossyAfter, zh.adopt) === null);

/* ── a rewrite identical to the source is not an edit ─────────────────────
 * Reachable in normal use: "优化一下。" is a draft with nothing to change, so a
 * faithful model may hand it straight back. Writing it anyway pushes a no-op
 * onto the composer's undo stack and then says 已替换草稿 about text that did
 * not change — a receipt for an event that never happened. */
let sameWritten = null;
const sameActions = { setDraft: (text) => { sameWritten = text; }, persistDraft: () => {} };
globalThis.fetch = async () => ({
  json: async () => ({
    ok: true,
    rewrite: '优化一下。',
    facts: { total: 0, kept: 0, missing: [], repaired: false, reinjected: false },
    acceptance: { required: true, present: false, declared: true },
  }),
});
cardFrame.slots[0] = { draft: '优化一下。', actions: sameActions, ready: true };
cardFrame.slots[5] = null;
cardFrame.slots[6] = null;
const sameTree = expand(left[0].component(props));
findTrigger(sameTree).props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
ok('an identical rewrite never reaches the composer',
  sameWritten === null, String(sameWritten).slice(0, 40));
cardFrame.slots[0] = { draft: '优化一下。', actions: sameActions, ready: true };
const sameAfter = expand(left[0].component(props));
const sameText = textOf(sameAfter).join(' ');
ok('an identical rewrite still leaves a receipt', sameText.includes(zh.unchanged),
  sameText.slice(0, 120));
ok('an identical rewrite is not reported as a replacement',
  !sameText.includes(zh.replaced), sameText.slice(0, 120));
ok('the unchanged receipt still carries the acceptance outcome',
  sameText.includes(zh.acceptanceDeclared), sameText.slice(0, 160));
/* The guard is strict equality, not normalisation: a single punctuation mark
 * IS a change, and treating it as noise would silently drop real edits. */
let tweakedWritten = null;
const tweakActions = { setDraft: (text) => { tweakedWritten = text; }, persistDraft: () => {} };
globalThis.fetch = async () => ({
  json: async () => ({
    ok: true,
    rewrite: '优化一下',
    facts: { total: 0, kept: 0, missing: [], repaired: false, reinjected: false },
    acceptance: { required: true, present: false, declared: true },
  }),
});
cardFrame.slots[0] = { draft: '优化一下。', actions: tweakActions, ready: true };
cardFrame.slots[5] = null;
cardFrame.slots[6] = null;
findTrigger(expand(left[0].component(props))).props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
ok('a rewrite that only drops a period still counts as a change',
  tweakedWritten === '优化一下', String(tweakedWritten).slice(0, 40));

/* ── the two first-class outcomes the receipt used to drop ────────────────
 * `truncated` and `facts.invented` were returned by the Host and thrown away
 * here, so the card said nothing when the rewrite stopped mid-sentence or when
 * it invented a path the draft never had. Both are silent-truth failures: the
 * text looks fine, and only the receipt can say it is not. */
const doneRowClasses = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => doneRowClasses(n, out)); return out; }
  const cn = node.props && node.props.className;
  if (typeof cn === 'string' && /^pf-done-[hba]/.test(cn)) out.push(cn);
  if (node.props) doneRowClasses(node.props.children, out);
  return out;
};
/* The invented literals belong in the tooltip, not the line: a row of paths
 * would wrap the panel to three lines and push the rewrite out of view. */
const titlesOf = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => titlesOf(n, out)); return out; }
  if (node.props && typeof node.props.title === 'string') out.push(node.props.title);
  if (node.props) titlesOf(node.props.children, out);
  return out;
};
const alertRun = async (payload, draftText) => {
  let landed = null;
  const acts = { setDraft: (text) => { landed = text; }, persistDraft: () => {} };
  globalThis.fetch = async () => ({ json: async () => Object.assign({
    ok: true,
    facts: { total: 0, kept: 0, missing: [], repaired: false, reinjected: false },
  }, payload) });
  cardFrame.slots[0] = { draft: draftText, actions: acts, ready: true };
  cardFrame.slots[5] = null;
  cardFrame.slots[6] = null;
  findTrigger(expand(left[0].component(props))).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  cardFrame.slots[0] = { draft: landed === null ? cardFrame.slots[0].draft : landed, actions: acts, ready: true };
  return { text: textOf(expand(left[0].component(props))).join(' '), tree: expand(left[0].component(props)) };
};

const truncRun = await alertRun({
  rewrite: '把 X 改清楚，然后',
  truncated: true,
}, '把 X 改清楚');
ok('a truncated rewrite says so on the receipt',
  truncRun.text.includes(zh.truncatedWarn), truncRun.text.slice(0, 160));
ok('a truncated rewrite still lands, it is only labelled',
  truncRun.text.includes(zh.replaced), truncRun.text.slice(0, 160));
ok('the truncation line is painted as a warning',
  classesOf(truncRun.tree).some(c => /pf-done-a warn/.test(c)));

const inventedRun = await alertRun({
  rewrite: '把 src/app.ts 改成 src/index.ts',
  facts: {
    total: 0, kept: 0, missing: [], repaired: false, reinjected: false,
    invented: ['src/index.ts'], capped: false, inventedChecked: true,
  },
}, '把 src/app.ts 改个名字');
ok('a fabricated literal is reported with its count',
  inventedRun.text.includes(zh.factInvented + ' 1'), inventedRun.text.slice(0, 200));
ok('the fabricated literals themselves ride in the tooltip, not the line',
  !inventedRun.text.includes('src/index.ts')
  && titlesOf(inventedRun.tree).some(title => title.includes('src/index.ts')),
  JSON.stringify(titlesOf(inventedRun.tree)));
ok('the invented line is painted as a warning',
  classesOf(inventedRun.tree).some(c => /pf-done-a warn/.test(c)));

const quietRun = await alertRun({
  rewrite: '把 X 改清楚',
  truncated: false,
  acceptance: { required: true, present: true, declared: false },
  facts: {
    total: 1, kept: 1, missing: [], repaired: false, reinjected: false,
    invented: [], capped: false, inventedChecked: true,
  },
}, '把 X 改清楚一下');
ok('neither outcome fired: no extra line is added',
  !quietRun.text.includes(zh.truncatedWarn) && !quietRun.text.includes(zh.factInvented),
  quietRun.text.slice(0, 160));
/* The receipt is three lines when nothing alarming happened. Counting the rows
 * is the only way to keep "no extra line" from decaying into "no extra text":
 * an empty but rendered row would sail through a text-only check. */
ok('the quiet receipt keeps exactly three rows',
  doneRowClasses(quietRun.tree).length === 3, JSON.stringify(doneRowClasses(quietRun.tree)));

/* ── 开放项 1: an unknown mode id must fall back, not kill the rewrite ────
 * Symptom being pinned: a stale/typo'd id (e.g. "accept" instead of
 * "acceptance") lit up NEITHER mode button, so the card looked merely empty,
 * and the very same value was POSTed to the Host, which answered
 * 400 "mode not available" — the whole feature silently dead. */

/* A real remount: the card's state is only seeded from localStorage while the
 * frame is being created, so reusing an old frame would assert on a value the
 * test itself wrote and prove nothing. */
const mountCard = () => {
  const at = registry.indexOf(cardFrame);
  if (at >= 0) registry.splice(at, 1);
  const tree = expand(left[0].component(props));
  const card = registry[registry.length - 1];
  return { tree, card };
};
/* The pressed mode button, identified by its LABEL: the docs toggle reuses the
 * .pf-mode class and is "on" by default, so class counting cannot tell them
 * apart (this assertion is exactly what caught that).
 *
 * Since the UI pass the class is no longer the whole truth: the modes are a
 * radiogroup, so a mode is checked only if BOTH the visual class and
 * aria-checked agree. Keeping the class check alone would let a regression
 * that drops the ARIA state (screen readers hear nothing) pass silently. */
const pressedModeLabels = (tree, labels) => labels.filter(l => {
  const btn = findButton(tree, l);
  if (!btn) return false;
  const cls = btn.props.className || '';
  return /(^|\s)pf-mode on(\s|$)/.test(cls) && btn.props['aria-checked'] === 'true';
});

/* (a) Mount path. The initial state is read from localStorage before any Host
 * round-trip, so a dirty value is live from the very first frame. */
storage.set(SETTINGS_KEY, JSON.stringify({ '': { mode: 'accept', workspaceDocs: true } }));
const dirtyMount = mountCard();
ok('an unknown mode id falls back to the default on mount',
  dirtyMount.card.slots[1]?.mode === 'polish', JSON.stringify(dirtyMount.card.slots[1]));
ok('the fallback lights the default mode button instead of none',
  JSON.stringify(pressedModeLabels(dirtyMount.tree, [zh.modePolish, zh.modeAcceptance])) === JSON.stringify([zh.modePolish]),
  JSON.stringify(pressedModeLabels(dirtyMount.tree, [zh.modePolish, zh.modeAcceptance])));

/* A stored value of the wrong TYPE is the same class of bug. */
storage.set(SETTINGS_KEY, JSON.stringify({ '': { mode: 42, workspaceDocs: 'yes' } }));
const retypeMount = mountCard();
ok('a non-string mode and non-boolean docs fall back to defaults',
  retypeMount.card.slots[1]?.mode === 'polish' && retypeMount.card.slots[1]?.workspaceDocs === true,
  JSON.stringify(retypeMount.card.slots[1]));
/* ...and the default must be what the UI shows, not just what state holds. */
ok('the type fallback is visible in the row too',
  JSON.stringify(pressedModeLabels(retypeMount.tree, [zh.modePolish, zh.modeAcceptance])) === JSON.stringify([zh.modePolish]),
  JSON.stringify(pressedModeLabels(retypeMount.tree, [zh.modePolish, zh.modeAcceptance])));

/* (b) Reload path — the one that actually bites in the GUI. On mount `cwd` is
 * still '', so the workspace's OWN bucket is only merged once the Host answers
 * settings-get. That second merge is where a dirty bucket used to win. */
storage.set(SETTINGS_KEY, JSON.stringify({ 'C:/wsDirty': { mode: 'accept', workspaceDocs: true } }));
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.command === 'settings-get') {
    return { json: async () => ({ ok: true, cwd: 'C:/wsDirty', settings: { mode: 'accept', workspaceDocs: true } }) };
  }
  return { json: async () => ({ ok: true }) };
};
const reloadMount = mountCard();
reloadMount.card.slots[1] = { mode: 'accept', workspaceDocs: true }; /* worst case: dirty already in state */
await flushEffect(reloadMount.card, 1);
ok('the workspace bucket is sanitized when it is merged after cwd resolves',
  reloadMount.card.slots[1]?.mode === 'polish', JSON.stringify(reloadMount.card.slots[1]));

/* (c) Workspace-file path: no local bucket for this workspace, so the value from
 * the workspace settings FILE is merged — it must be validated too. */
storage.delete(SETTINGS_KEY);
const fileMount = mountCard();
await flushEffect(fileMount.card, 1);
ok('the workspace settings file is sanitized when it is merged',
  fileMount.card.slots[1]?.mode === 'polish', JSON.stringify(fileMount.card.slots[1]));

/* (d) Write path: nothing outside the whitelist may be persisted or POSTed. */
let dirtyPostMode = null;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.command === 'settings-set') dirtyPostMode = body.settings && body.settings.mode;
  return { json: async () => ({ ok: true }) };
};
storage.set(SETTINGS_KEY, JSON.stringify({ '': { mode: 'polish', workspaceDocs: true } }));
const writeMount = mountCard();
writeMount.card.slots[1] = { mode: 'polish', workspaceDocs: true };
writeMount.card.slots[2] = 'C:/wsE';
const writeTree = expand(left[0].component(props));
const polishBtn = findButton(writeTree, zh.modePolish);
polishBtn.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 0));
const storedMode = (readStore()['C:/wsE'] || {}).mode;
ok('a mode click persists a whitelisted id', storedMode === 'polish', String(storedMode));
ok('a mode click POSTs a whitelisted id', dirtyPostMode === 'polish', String(dirtyPostMode));

/* The Host rejects anything else, so the two whitelists must agree. */
const hostSrc = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const hostModes = (hostSrc.match(/AVAILABLE_MODES\s*=\s*new Set\(\[([^\]]*)\]\)/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
const clientModes = (src.match(/MODE_IDS\s*=\s*\[([^\]]*)\]/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
ok('the client whitelist matches the Host whitelist',
  hostModes.length > 0 && JSON.stringify(clientModes.slice().sort()) === JSON.stringify(hostModes.slice().sort()),
  'client=' + clientModes.join('|') + ' host=' + hostModes.join('|'));

/* ── CSS / layout contracts ───────────────────────────────────────────── */
const flat = src.replace(/\n/g, ' ');
ok('.pf-btn matches the 28px tool-row baseline', /\.pf-btn\{[^}]*height:28px/.test(flat));
ok('.pf-body carries min-height:0 so it can scroll (避雷 #4)', /\.pf-body\{[^}]*min-height:0/.test(flat));
ok('.pf-pane-b carries min-height:0 (nested scroll)', /\.pf-pane-b\{[^}]*min-height:0/.test(flat));
ok('trigger carries flex:none so a full row cannot squeeze it to zero', /\.pf-root\{[^}]*flex:none/.test(flat));
const cssOpen = 'const CSS = `';
const cssStart = src.indexOf(cssOpen);
const cssEnd = src.indexOf('`;', cssStart);
const cssBody = cssStart >= 0 && cssEnd > cssStart ? src.slice(cssStart + cssOpen.length, cssEnd) : '';
ok('the CSS template literal is found', cssBody.length > 500, 'len=' + cssBody.length);
ok('the CSS template literal holds no backtick (避雷 #3)', cssBody.length > 0 && !cssBody.includes('`'));

/* ── source-level contracts ───────────────────────────────────────────── */
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/\n/g, ' ');
ok('the open-gated effect has its if (!open) return guard', /if\s*\(!open\)\s*return\b/.test(code));
ok('placement anchors upward by bottom', /bottom:\s*window\.innerHeight - rect\.top \+ POPOVER_GAP/.test(code));
ok('placement anchors downward by top', /top:\s*rect\.bottom \+ POPOVER_GAP/.test(code));
ok('placement flips on available room', /openUp\s*=\s*above\s*>=\s*POPOVER_MIN\s*\|\|\s*above\s*>=\s*below/.test(code));
ok('placement centres the panel on the trigger, not on an edge',
  /left\s*=\s*rect\.left \+ rect\.width \/ 2 - width \/ 2/.test(code),
  'edge-anchoring parks the panel beside the button instead of over it');
ok('popover receives either anchor', /style:\s*\{\s*left:\s*pos\.left,\s*top:\s*pos\.top,\s*bottom:\s*pos\.bottom/.test(code));
ok('trigger ResizeObserver present', /anchorWatcher/.test(src));
ok('the draft is read through uiSession.bindingSource', /bindingSource\(\{\s*sessionId,\s*binding:\s*owner\s*\}\)/.test(code));
/* The write path moved into replaceDraft(body, from) when 采纳 stopped being
 * the only way a rewrite lands: pin the call, not the old adopt-only shape. */
ok('the draft is written through inputActions.setDraft', /actions\.setDraft\(\s*body\.rewrite\s*\)/.test(code));
/* react-dom is allowed for exactly one reason: createPortal. Anything else
 * would mean the client half started reaching for a dependency the host does
 * not guarantee. */
const required = [...src.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(m => m[1]);
ok('requires only react and react-dom',
  required.every(name => name === 'react' || name === 'react-dom'),
  JSON.stringify([...new Set(required)]));
ok('react-dom is required for createPortal',
  required.includes('react-dom') && /ReactDOM\.createPortal\(/.test(src));
/* THE REGRESSION THIS FILE EXISTS FOR: the popover must NOT render inside the
 * composer. Backdrop-filter on the composer panel makes it a containing block,
 * so a fixed-position child measures against the panel instead of the viewport
 * and lands on top of the draft. The mount target is the assertion; the panel's
 * own CSS is irrelevant. */
ok('the popover is portalled to document.body',
  /ReactDOM\.createPortal\([\s\S]{0,4000}?document\.body\s*,?\s*\)/.test(src));

/* ── the mode row's CSS and semantics (UI pass) ─────────────────────────
 * The DOM half lives up in the mode-row block; these pin the stylesheet and
 * source facts that make the row READ correctly: a segmented track for the
 * exclusive modes, an outlined tick pill for the independent switch, no brand
 * blue on the row (blue is reserved for the commit action), and one width
 * constant that agrees with the CSS box. */
ok('the docs switch is 28px tall so it lines up with the composer row',
  /\.pf-docs\{[^}]*height:28px/.test(code));
ok('the mode segments and the switch are the same height internally',
  /\.pf-mode\{[^}]*height:24px/.test(code));
ok('the active mode segment is NOT filled with the brand blue (blue is for commit)',
  /\.pf-mode\.on\{[^}]*background:var\(--dsw-alias-bg-layer-2\)/.test(code)
  && !/\.pf-mode\.on\{[^}]*background:var\(--dsw-alias-state-business-primary/.test(code),
  'blue on two pills at once was the original confusion');
ok('the mode group sits on a shared track, so it reads as one control',
  /\.pf-seg\{[^}]*border-radius:999px/.test(code)
  && /\.pf-seg\{[^}]*background:var\(--dsw-alias-interactive-bg-hover/.test(code));
ok('the docs switch sits apart from the segmented group',
  /\.pf-docs\{[^}]*margin-left:auto/.test(code));
ok('the docs tick only fades, so toggling does not reflow the pill',
  /\.pf-docs \.tick\{[^}]*opacity:0/.test(code) && /\.pf-docs\.on \.tick\{[^}]*opacity:1/.test(code));
ok('the panel width constant matches the CSS box width',
  /const POPOVER_WIDTH = 268/.test(code) && /\.pf-pop\{[^}]*width:268px/.test(code),
  'a drift here makes the panel jump sideways on first paint');
ok('the panel is border-box so the constant really is the rendered width',
  /\.pf-pop\{[^}]*box-sizing:border-box/.test(code));
ok('the panel has a gap, so its rows are not glued together',
  /\.pf-pop\{[^}]*gap:8px/.test(code));
ok('the dead header/title/badge CSS is gone',
  !/\.pf-head\{/.test(code) && !/\.pf-title\{/.test(code) && !/\.pf-badge\{/.test(code));
ok('the trigger declares a popup for assistive tech',
  /'aria-haspopup': 'true'/.test(code));
ok('the trigger opens on focus, so the panel is reachable by keyboard',
  /onFocus:/.test(code));
ok('the trigger has no native tooltip fighting the panel',
  !/title:\s*busy\s*\?/.test(code));

/* ── the busy contract: no second rewrite while one is in flight ─────────
 * A guard inside onClick alone is NOT this contract — the button still looked
 * clickable and nothing said "working". These assertions pin the three things
 * that make the in-progress state real to a human and to the DOM.
 *
 * NOTE: `cardFrame` from above may already have been evicted by mountCard()
 * (which splices the old frame out and re-expands, creating a NEW object), so
 * re-resolve the live frame by component identity rather than reusing a stale
 * handle — writing to an evicted frame silently tests nothing. */
const liveCard = () => {
  const frame = registry.find(f => f.key === cardFrame.key);
  if (!frame) throw new Error('lost the ForgeCard frame');
  return frame;
};
let busyCard = liveCard();
busyCard.slots[5] = null;
busyCard.slots[6] = null;
busyCard.slots[1] = { mode: 'polish', workspaceDocs: true };
busyCard.slots[0] = { draft: '把 index.js 的路由改成 exact', actions, ready: true };
/* ForgeCard order: view(0) settings(1) cwd(2) busy(3) error(4) result(5)
 * notice(6). The panel body is driven by the CARD's busy, not the trigger's —
 * that is the point of the split: the card owns the truth, the button only
 * reports it. */
busyCard.slots[3] = true;
buttonFrame.slots[0] = true;
buttonFrame.slots[7] = { left: 40, top: 60, maxHeight: 360 };
buttonFrame.slots[1] = true;
const busyTree = expand(left[0].component(props));
const busyTrigger = findTrigger(busyTree);
console.log('busy trigger props =', JSON.stringify({
  ariaDisabled: busyTrigger?.props?.['aria-disabled'],
  disabled: busyTrigger?.props?.disabled,
  ariaBusy: busyTrigger?.props?.['aria-busy'],
  dataBusy: busyTrigger?.props?.['data-busy'],
}));
/* aria-disabled, NOT the real `disabled` attribute: the second click has to
 * reach the handler so it can CANCEL. A real disabled attribute would swallow
 * that click and strand the user — the exact defect this change fixes. */
ok('a busy trigger announces aria-disabled', busyTrigger?.props?.['aria-disabled'] === 'true');
ok('a busy trigger is NOT really disabled (the cancel click must land)',
  busyTrigger?.props?.disabled !== true);
ok('a busy trigger reports aria-busy', busyTrigger?.props?.['aria-busy'] === 'true');
ok('a busy trigger carries a data-busy hook for styling',
  busyTrigger?.props?.['data-busy'] === 'true');
ok('the panel says it is rewriting while busy',
  textOf(busyTree).join(' ').includes(zh.running), 'running=' + zh.running);
ok('the busy line carries a spinner, not just text',
  classesOf(busyTree).some(c => /(^|\s)pf-line pf-busy(\s|$)/.test(c))
  && classesOf(busyTree).some(c => /(^|\s)pf-spin(\s|$)/.test(c)));
/* The spinner must be the RING and not an empty box: a bare <span> with no icon
 * inside renders as nothing at 11px, leaving the busy line visually identical to
 * a plain sentence. One circle only — the reference capture has no dim track
 * underneath, so a second full ring would be invented chrome. */
ok('the busy spinner actually contains the ring artwork',
  classesOf(busyTree).some(c => /(^|\s)pf-spin-arc(\s|$)/.test(c))
  && !classesOf(busyTree).some(c => /(^|\s)pf-spin-track(\s|$)/.test(c)));
ok('the busy state survives the receipt: no replacement notice while busy',
  !classesOf(busyTree).some(c => /(^|\s)pf-done(\s|$)/.test(c)));

/* The animation is the ONLY busy signal on the trigger itself, so the
 * prefers-reduced-motion block must slow it down rather than delete it. A
 * previous version set animation:none there and the trigger looked idle for the
 * whole request on any machine reporting reduce — a silent, environment-
 * dependent regression that no assertion covered. */
ok('reduced motion slows the trigger spin instead of removing it',
  /@media \(prefers-reduced-motion:reduce\)\{[\s\S]{0,900}?\.pf-btn\[data-busy="true"\] \.pf-glyph-busy \.ico\{animation-duration:/.test(code)
  && !/prefers-reduced-motion:reduce\)\{[\s\S]{0,900}?\.pf-btn\[data-busy="true"\] \.pf-glyph-busy \.ico\{animation:none/.test(code));
ok('reduced motion slows the panel spinner instead of removing it',
  /prefers-reduced-motion:reduce\)\{[\s\S]{0,900}?\.pf-spin\{animation-duration:/.test(code)
  && !/prefers-reduced-motion:reduce\)\{[\s\S]{0,900}?\.pf-spin\{animation:none/.test(code));
ok('the trigger spin still has a keyframe to run',
  /@keyframes pf-spin\{to\{transform:rotate\(360deg\)\}\}/.test(code)
  && /\.pf-btn\[data-busy="true"\] \.pf-glyph-busy \.ico\{opacity:1;animation:pf-spin /.test(code));

/* Idle and busy are two marks in one slot, crossfaded over 120ms. The previous
 * shape — `busy ? h(SpinIcon, ...) : h(SparkIcon)` — unmounted one SVG and
 * mounted the other inside a single frame, so the button blinked instead of
 * changing phase, and the ring restarted from 0deg on every click. The fix is
 * structural: both marks are always mounted and only opacity moves. */
ok('both marks are mounted at once, so the switch is a crossfade not a blink',
  /h\('span', \{ className: 'pf-glyph' \},[\s\S]{0,200}?pf-glyph-idle[\s\S]{0,120}?pf-glyph-busy/.test(code)
  && !/busy \? h\(SpinIcon/.test(code));
ok('the idle mark really stays in the tree while busy',
  (() => {
    const btn = findTrigger(busyTree);
    if (!btn) return false;
    let idle = false;
    let busyRing = false;
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const cls = String(node.props?.className || '');
      if (/(^|\s)pf-glyph-idle(\s|$)/.test(cls)) idle = true;
      if (/(^|\s)pf-glyph-busy(\s|$)/.test(cls)) {
        busyRing = /(^|\s)pf-spin-arc(\s|$)/.test(
          String(node.props?.children?.props?.children?.props?.className || ''));
      }
      walk(node.props?.children);
    };
    walk(btn);
    return idle && busyRing;
  })());
ok('the crossfade is 120ms and carries the opacity, not just a wrapper',
  /\.pf-glyph \.ico\{[^}]*transition:opacity 120ms linear\}/.test(code)
  && /\.pf-btn\[data-busy="true"\] \.pf-glyph-idle \.ico\{opacity:0\}/.test(code)
  && /\.pf-btn\[data-busy="true"\] \.pf-glyph-busy \.ico\{opacity:1;/.test(code));
/* Decorative motion may be deleted under reduce; the spin may only be slowed.
 * Deleting the crossfade removes a flourish, deleting the spin removes the only
 * signal that a request is running. */
ok('reduced motion drops the crossfade entirely, unlike the spin',
  /prefers-reduced-motion:reduce\)\{[\s\S]{0,900}?\.pf-glyph \.ico\{transition:none\}/.test(code));

/* The two-tone border ring was replaced on purpose, and so was the short
 * breathing dash that followed it. Measured off the reference capture: the ring
 * draws 294 of 360 degrees (a constant 66 degree notch), turns once per .95s,
 * and sits on NO track — the notch reads as pure background. The earlier draft
 * drew an 86 degree dash over a fading full ring, which at 15px collapsed into
 * "a thin line orbiting" instead of "a ring with a notch". */
ok('the spinner is the measured .95s notched ring, not the old .7s border ring',
  /\.pf-btn\[data-busy="true"\] \.pf-glyph-busy \.ico\{opacity:1;animation:pf-spin \.95s linear infinite\}/.test(code)
  && /\.pf-spin-arc\{stroke-dasharray:41 60\}/.test(code)
  && !/border-top-color:transparent/.test(code)
  && !/pf-spin \.8s linear/.test(code)
  && !/pf-spin-dash/.test(code));
/* The spin must live on the box, never on the <circle>. A CSS animation on an
 * SVG shape resolves transform-origin against the view-box origin, so the ring
 * orbited the top-left corner of the 20x20 view-box and spent most of every turn
 * clipped outside the 15px icon box: the spinner was simply invisible, on and
 * off, and nothing in the source looked wrong. Guard the arrangement, not just
 * the duration. */
ok('the ring only spins through its box, never around the view-box corner',
  /@keyframes pf-spin\{to\{transform:rotate\(360deg\)\}\}/.test(code)
  && !/pf-spin-rotate/.test(code)
  && !/\.pf-spin-arc\{[^}]*animation:/.test(code));
/* A dash sum smaller than the circumference is what guarantees the gap: if the
 * dash plus gap equalled the path length the pattern would tile exactly once and
 * leave a hairline seam where it restarts. 41 + 60 = 101 > 50.27 (2*pi*8). */
ok('the ring gap is wider than the circle, so the dash never tiles a seam',
  (() => {
    const m = code.match(/\.pf-spin-arc\{stroke-dasharray:([\d.]+) ([\d.]+)\}/);
    if (!m) return false;
    const circumference = 2 * Math.PI * 8;
    return Number(m[1]) + Number(m[2]) > circumference;
  })());
/* 294 of 360 degrees drawn means the dash is about 81.7% of the circumference;
 * assert it lands there rather than trusting the hand-typed number. */
ok('the drawn arc covers the measured 294 degrees',
  (() => {
    const m = code.match(/\.pf-spin-arc\{stroke-dasharray:([\d.]+) /);
    if (!m) return false;
    const circumference = 2 * Math.PI * 8;
    const drawn = Number(m[1]);
    return Math.abs(drawn / circumference * 360 - 294) < 6;
  })());
/* Both surfaces show the same thing, so both must mount the same component; and
 * the trigger must still show the spark when it is NOT busy, or the plugin loses
 * its identity mark. */
ok('the trigger swaps the spark for the ring only while busy',
  /h\('span', \{ className: 'pf-glyph-idle' \}, h\(SparkIcon\)\)/.test(code)
  && /h\('span', \{ className: 'pf-glyph-busy' \}, h\(SpinIcon, \{ className: 'ico' \}\)\)/.test(code)
  && /h\('span', \{ className: 'pf-spin', 'aria-hidden': 'true' \}, h\(SpinIcon\)\)/.test(code));
/* The same state drawn twice must not use two pen weights: an earlier pass
 * thickened only the trigger and left the panel ring on the 2-unit attribute,
 * so the two rings sitting in one toolbar read as different things. Both are
 * expressed against the same r=8 view-box radius, so equal numbers are the
 * correct comparison even though the rendered sizes differ (15px vs 11px). */
ok('both carriers draw the ring with one pen weight',
  (() => {
    const btn = code.match(/\.pf-btn \.ico \.pf-spin-arc\{stroke-width:([\d.]+)\}/);
    const panel = code.match(/\.pf-spin \.pf-spin-arc\{stroke-width:([\d.]+)\}/);
    if (!btn || !panel) return false;
    return Number(btn[1]) === Number(panel[1]) && Number(btn[1]) > 2;
  })());
/* A class name handed to a component as a bare string is not a props object:
 * h(SpinIcon, 'ico') passes "ico" as props, React reads props.className off it
 * (undefined), and the trigger renders an SVG with NO class — so the rule keyed
 * on .ico never matches and the ring sits perfectly still. Nothing throws, the
 * markup looks plausible, and the panel spinner beside it keeps turning, so the
 * bug reads as "only the button is broken". Guard the call shape. */
ok('the icon component is handed props, never a bare class string',
  !/h\(SpinIcon, '[^']*'\)/.test(code)
  && /function SpinIcon\(props\)[\s\S]{0,200}?className: props && props\.className/.test(code));
/* The source shape above is necessary but not sufficient: the failure was in the
 * RENDERED tree, not in the text. Render the busy button and read the SVG that
 * actually comes out. Without the class, no .ico rule can match and the ring is
 * motionless while the panel spinner beside it turns — the exact asymmetry the
 * user reported. */
ok('the rendered busy trigger really carries the ico class on its svg',
  (() => {
    const btn = findTrigger(busyTree);
    if (!btn) return false;
    let found = null;
    const walk = (node) => {
      if (found || node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type === 'svg' && /(^|\s)pf-spin-arc(\s|$)/.test(
        String((node.props?.children?.props?.className) || ''))) {
        found = String(node.props?.className || '');
        return;
      }
      walk(node.props?.children);
    };
    walk(btn);
    return found !== null && /(^|\s)ico(\s|$)/.test(found);
  })());

/* The hover surface must NOT be hung on the button: mouseenter is unreliable on
 * a control that changes activation semantics mid-flight, and the panel has to
 * stay reachable for the whole round trip. */
ok('hover lives on the wrapper, so the busy trigger still opens the panel',
  /className:\s*'pf-root'[\s\S]{0,240}?onMouseEnter:\s*openNow/.test(code)
  && !/onMouseEnter:\s*openNow[\s\S]{0,120}?onClick:\s*fire/.test(code));

/* Leaving busy restores the click: the pair is what makes "during" meaningful. */
buttonFrame.slots[1] = false;
const idleTree = expand(left[0].component(props));
ok('an idle trigger is clickable again', findTrigger(idleTree)?.props?.disabled !== true);

/* ── the hover contract (m00923) ─────────────────────────────────────────
 * The pointer is the way IN and the way OUT: hovering opens the three settings,
 * leaving closes them, and a CLICK is the rewrite itself. Each of those three
 * is a separate promise, so each gets its own assertion — a single "it opens"
 * test would pass even with the click still just toggling the panel. */
ok('hovering the trigger opens the panel', /onMouseEnter:\s*openNow/.test(code));
ok('leaving the trigger schedules a close', /onMouseLeave:\s*scheduleClose/.test(code));
ok('the panel itself keeps the hover open',
  /className:\s*'pf-pop'[\s\S]{0,300}?onMouseEnter[\s\S]{0,80}?onMouseLeave/.test(code));
ok('leaving does not close instantly (the pointer must cross the gap)',
  /setTimeout\(\s*\(\)\s*=>\s*\{[^}]*setOpen\(false\)/.test(code) && /\b180\b/.test(code));
ok('a click runs the rewrite instead of toggling the panel',
  /onClick:\s*fire/.test(code) && !/onClick:\s*\(\)\s*=>\s*setOpen\(o\s*=>\s*!o\)/.test(code));
ok('the click callback delegates to the card run via runRef',
  /runRef\.current\s*=\s*run/.test(code) && /runRef\.current/.test(code));
ok('a click while busy does not stack a second rewrite',
  /if\s*\(busy\s*\|\|\s*draft\s*===\s*''\)\s*return/.test(code));
ok('the in-flight request survives a mouseleave (card owns the shell)',
  /if\s*\(!open\s*\|\|\s*!pos\)\s*return null/.test(code));

/* ── the cancel contract (m01819) ────────────────────────────────────────
 * A rewrite used to be unstoppable: no timeout, no abort, so a wedged provider
 * left the trigger disabled until the page was reloaded. Now the SECOND click
 * on a busy trigger cancels, and a 90s backstop covers the case where nobody
 * clicks at all. Each half is asserted separately, because either one alone
 * still leaves a user stranded. */
ok('a busy click cancels instead of returning early',
  /if\s*\(busy\)\s*\{[\s\S]{0,200}?cancel\(\)/.test(code)
  && !/const fire[\s\S]{0,160}?if\s*\(busy\)\s*return;/.test(code));
ok('the card publishes its cancel handle to the trigger',
  /cancelRef\.current\s*=\s*cancel/.test(code));
ok('the request is issued with an abort signal',
  /api\('rewrite'[\s\S]{0,200}?controller\.signal/.test(code));
ok('api forwards the signal to fetch',
  /async function api\([^)]*signal[^)]*\)[\s\S]{0,400}?signal/.test(code));
ok('there is a timeout backstop on the rewrite', /REWRITE_TIMEOUT_MS/.test(code)
  && /setTimeout\([\s\S]{0,220}?controller\.abort\(/.test(code));
ok('the timeout is generous enough for the three-call worst case',
  /REWRITE_TIMEOUT_MS\s*=\s*90000/.test(code));
ok('an abort is not rendered as a red error',
  /setQuiet\(/.test(code) && /reason\s*===\s*'timeout'/.test(code));
ok('a cancelled run still clears busy', /finally\s*\{[\s\S]{0,400}?setBusy\(false\)/.test(code));

/* ── the session-switch contract ────────────────────────────────────────
 * Switching sessions disposes the session's input shell, which unmounts this
 * card. Unmount used to abort the in-flight request, so a rewrite started a
 * moment before a switch was killed mid-flight and the composer went back to
 * the original text — the one bug that made the feature look broken rather
 * than slow. The request now outlives the unmount: only the late paints are
 * gated on mountedRef, never the composer write. */
ok('unmounting does not abort the in-flight rewrite',
  /React\.useEffect\(\(\) => \(\) => \{[\s\S]{0,120}?mountedRef\.current = false;[\s\S]{0,40}?\}, \[\]\)/.test(code)
  && !/React\.useEffect\(\(\) => \(\) => \{[\s\S]{0,200}?controller\.abort\(/.test(code));
ok('the composer write is not gated on the card still being mounted',
  /if\s*\(!actions \|\| typeof actions\.setDraft !== 'function'\) return false;/.test(code)
  && /actions\.setDraft\(body\.rewrite\)/.test(code));
ok('a rewrite landing after unmount is parked, not written into a dead shell',
  /if \(!mountedRef\.current\) \{[\s\S]{0,140}?pendingWrites\.set\(sessionId, \{ body, from \}\);[\s\S]{0,40}?return;/.test(code));
ok('the parked rewrite is delivered when the session comes back',
  /pendingWrites\.get\(sessionId\)[\s\S]{0,400}?replaceDraft\(parked\.body, parked\.from\)[\s\S]{0,60}?pendingWrites\.delete\(sessionId\)/.test(code));
ok('the parked entry is only cleared once the write really happened',
  /if \(replaceDraft\(parked\.body, parked\.from\)\) pendingWrites\.delete\(sessionId\)/.test(code));
ok('the late error and quiet lines are still gated on mountedRef',
  /if \(mountedRef\.current\) setError\(/.test(code)
  && /if \(mountedRef\.current\) setQuiet\(/.test(code));

/* ── the cost row ───────────────────────────────────────────────────────
 * Three behaviours, each with a way to be quietly wrong: a number without
 * its caveats reads as a bill, an unreported usage must not render as a
 * confident zero, and the receipt must not smuggle the price of the attempt
 * into a claim about what was written.
 *
 * The frames are re-acquired first: the mount tests above replace the card
 * frame, so writing into the captured `cardFrame` would set state on a
 * detached frame and the render would quietly use a fresh one — the
 * assertions would then pass or fail on defaults rather than on the values
 * the test set. */
/* The frame is re-acquired through `liveCard` (declared above) rather than via
 * the captured `cardFrame`: mountCard() splices the old frame out and creates a
 * new one, so writing into the stale handle would set state on a detached
 * frame and the render would silently use defaults instead — the assertions
 * would then be testing nothing. */
const renderCard = (slots) => {
  buttonFrame.slots[0] = true;
  buttonFrame.slots[1] = false;
  buttonFrame.slots[7] = { left: 40, top: 60, maxHeight: 360 };
  const card = liveCard();
  card.slots[0] = { draft: '把 index.js 的路由改成 exact', actions, ready: true };
  card.slots[1] = { mode: 'polish', workspaceDocs: true };
  card.slots[2] = false;
  card.slots[3] = '';
  card.slots[4] = '';
  card.slots[5] = slots.result ?? null;
  card.slots[6] = slots.notice ?? null;
  return expand(left[0].component(props));
};
const COST_BASE = {
  ok: true,
  rewrite,
  facts: { total: 1, kept: 1, missing: [], repaired: false, reinjected: false },
  usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 },
  usageTotal: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, calls: 2 },
  cost: { amount: 0.002804, currency: 'CNY', period: 'off-peak', multiplier: 1, estimated: true, calls: 2 },
};

let costTree = renderCard({ result: COST_BASE });
let costText = textOf(costTree).join(' ');
ok('cost row renders .pf-cost', classesOf(costTree).some(c => /(^|\s)pf-cost(\s|$)/.test(c)), JSON.stringify(classesOf(costTree).filter(c => c.includes('pf-cost'))));
ok('cost row states that the number is an estimate', costText.includes(zh.costEstimate), costText.slice(0, 120));
ok('cost row prints the amount with its currency', costText.includes('¥0.0028'), costText.slice(0, 120));
ok('cost row names the billing period next to the amount', costText.includes(zh.costOffPeak), costText.slice(0, 120));
ok('cost row counts the model calls behind the number', costText.includes('2 ' + zh.costCalls), costText.slice(0, 120));

/* Peak gets its own label, so a doubled number is never unexplained. */
costTree = renderCard({ result: Object.assign({}, COST_BASE, {
  cost: { amount: 0.005608, currency: 'CNY', period: 'peak', multiplier: 2, estimated: true, calls: 2 },
}) });
costText = textOf(costTree).join(' ');
ok('a peak cost is labelled peak', costText.includes(zh.costPeak), costText.slice(0, 120));
ok('a peak cost shows its multiplier', costText.includes('×2'), costText.slice(0, 120));

/* Spent but unreported: unknown, in words — never ¥0.00. */
costTree = renderCard({ result: Object.assign({}, COST_BASE, {
  cost: null,
  usageTotal: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 2 },
}) });
costText = textOf(costTree).join(' ');
ok('an unreported cost says unknown', costText.includes(zh.costUnknown), costText.slice(0, 120));
ok('an unreported cost never renders as a zero amount', !/¥\s?0\.0{2,4}/.test(costText), costText.slice(0, 120));

/* Nothing spent at all: the row stays absent rather than announcing zero. */
costTree = renderCard({ result: Object.assign({}, COST_BASE, { cost: null, usageTotal: null }) });
ok('no usage at all renders no cost row',
  !classesOf(costTree).some(c => /(^|\s)pf-cost(\s|$)/.test(c)));

/* The receipt is a claim about the write, not a bill for the attempt. */
const receiptTree = renderCard({ notice: {
  rewrite: '把 index.js 的路由改成 exact',
  before: 3, after: 3, same: false,
  facts: { total: 1, kept: 1, missing: [] },
  cost: { amount: 0.002804, currency: 'CNY', period: 'peak', multiplier: 2, estimated: true, calls: 2 },
} });
ok('the one-click receipt carries no cost row',
  !classesOf(receiptTree).some(c => /(^|\s)pf-cost(\s|$)/.test(c)));
console.log('\n' + (failures === 0
  ? 'OK — client half parses (factory executed), registers only on conversation.input.left, renders all P1 states, and one click on the trigger replaces the draft outright — lossy or not, with no 采纳 step.'
  : failures + ' FAILURE(S)'));
if (failures > 0) process.exit(1);
