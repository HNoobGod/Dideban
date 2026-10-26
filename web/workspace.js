'use strict';
// ============================================================ workspace (customisable dashboard)
// Every information panel of the detail page can also live in a workspace laid over the map:
// floating windows, docked columns at either edge, or (on a phone) a full-width stack. A layout
// is presentation only: which panels, where, how big, in what state, with which display
// options. Live data never goes into a layout; every panel draws from the same S.details /
// S.live stores as the detail page, through the same render functions.
//
//   registry   WS_REG: one definition per panel type (wsRegister); the library, the renderer
//              and the validator all read it, so a newly registered panel needs nothing else.
//   state      WS.work: the working copy of the current layout; WS.base: the saved copy (as a
//              canonical string) it is compared with for the "unsaved" mark.
//   storage    localStorage 'a3map.ws' (versioned, validated on every load) and a debounced
//              draft 'a3map.wsDraft' so a refresh keeps unsaved edits. Per browser, not synced.
//   renderer   one persistent element per panel instance; moving or resizing touches only its
//              style, data updates only its body (and only when the markup changed).

const WS_VER = 2;               // 2: parts of panels (components) and detached widgets
const WS_MOBILE_W = 640;          // below this workspace width the panels form a stack
const WS_HEAD = 34;               // title bar height (px)
const WS_SRC = ['sel', 'me', 'veh'];
const WS_CTX = ['man', 'air', 'armor', 'car', 'ship'];
const WS_CATS = ['overview', 'health', 'crew', 'weapons', 'inventory', 'nav', 'telemetry'];
const WS_GRIDS = [8, 12, 16, 24, 32];
const WS_GAPS = [0, 4, 8, 12, 16];
const WS_ID_RE = /^[\w-]{1,40}$/;

// ---------------------------------------------------------------- registry
const WS_REG = new Map();
// Common display options; a panel lists the ones it really supports.
const WS_PREF = {
  compact: { key: 'compact', type: 'bool', def: false, label: 'ws.pref.compact' },
  nums: { key: 'nums', type: 'bool', def: true, label: 'ws.pref.nums' },
  autohide: { key: 'autohide', type: 'bool', def: false, label: 'ws.pref.autohide' },
};
function wsRegister(def) {
  if (!def || !WS_ID_RE.test(def.id || '') || typeof def.render !== 'function') throw new Error('wsRegister: bad panel definition');
  const d = Object.assign({
    cat: 'overview', icon: 'misc', title: 'ws.p.' + def.id,
    size: { w: 360, h: 420 }, min: { w: 220, h: 140 }, max: null,
    multi: false, entity: true, prefs: [], applies: () => true, tab: null,
  }, def);
  if (!WS_CATS.includes(d.cat)) d.cat = 'overview';
  WS_REG.set(d.id, d);
  if (WS.ready) { wsLibRender(); wsRenderAll(); }
  return d;
}
const wsDef = (pid) => WS_REG.get(pid) || wsWidgetDef(pid);
const wsTitle = (def) => tOr(def.title, def.id);

// ---------------------------------------------------------------- helpers
const wsNum = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
function wsUid(p) { return p + Math.random().toString(36).slice(2, 8) + (Date.now() % 46656).toString(36); }
function wsClone(o) { return JSON.parse(JSON.stringify(o)); }
// Key-sorted JSON, so two equal layouts always give the same string (the "unsaved" test).
function wsStable(v) {
  if (Array.isArray(v)) return '[' + v.map(wsStable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined && k[0] !== '_')
      .map((k) => JSON.stringify(k) + ':' + wsStable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- schema
function wsBlank(name) {
  return {
    v: WS_VER, id: wsUid('L'), name: name || t('ws.untitled'), tpl: null, ctx: [],
    opt: { snap: true, grid: 16, gap: 8, guides: true, backdrop: 'map' },
    panels: [], dock: { start: [], end: [] }, mob: { order: [], h: {} },
  };
}
function wsCleanPrefs(def, raw) {
  const out = {};
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const p of def.prefs) {
    const v = src[p.key];
    if (p.type === 'bool') out[p.key] = typeof v === 'boolean' ? v : p.def;
    else if (p.type === 'select') out[p.key] = p.opts.includes(v) ? v : p.def;
    else if (p.type === 'multi') out[p.key] = Array.isArray(v) ? p.opts.filter((o) => v.includes(o)) : p.def.slice();
  }
  return out;
}
function wsNewInst(pid, src) {
  const def = wsDef(pid);
  const P = {
    iid: wsUid('p'), pid, src: def && def.entity ? (WS_SRC.includes(src) ? src : 'sel') : '',
    st: 'float', min: false, max: false, g: { x: 0.1, y: 0.08, w: 0.3, h: 0.5 }, z: 1, prefs: {},
  };
  if (def) P.prefs = wsCleanPrefs(def, null);
  if (def && def.comps) P.cl = wsDefaultCl(def);
  return P;
}
// Older layout versions are lifted one step at a time; add an entry here when the schema changes.
const WS_MIGRATIONS = {
  0: (L) => L, // unversioned drafts of v1 (same shape)
  // v1 → v2: panels got parts. The options that picked parts (instrument fields, telemetry
  // sections, the weapons panel's board and turret) become hidden parts.
  1: (L) => {
    const hideMap = {
      instruments: (p) => { const f = Array.isArray(p.fields) ? p.fields : null; const m = { spd: 'speed', alt: 'alt', att: 'attitude', cmp: 'heading', fuel: 'fuel', hp: 'hp' }; return f ? Object.keys(m).filter((k) => !f.includes(k)).map((k) => m[k]) : []; },
      telemetry: (p) => { const f = Array.isArray(p.fields) ? p.fields : null; return f ? ['link', 'run', 'rates', 'entity', 'events'].filter((k) => !f.includes(k)).map((k) => 'tel-' + k) : []; },
      weapons: (p) => [p.board === false ? 'loadout' : null, p.turret === false ? 'turret' : null].filter(Boolean),
    };
    for (const p of Array.isArray(L.panels) ? L.panels : []) {
      const def = p && typeof p.pid === 'string' && WS_REG.get(p.pid);
      if (!def || !def.comps || p.cl) continue;
      const hide = hideMap[p.pid] && p.prefs && typeof p.prefs === 'object' ? hideMap[p.pid](p.prefs) : [];
      p.cl = wsDefaultCl(def);
      for (const it of p.cl.items) if (hide.includes(it.cid)) it.hid = true;
    }
    return L;
  },
};
function wsMigrate(raw) {
  let v = Number.isInteger(raw.v) ? raw.v : 0;
  let L = raw;
  while (v < WS_VER) { const m = WS_MIGRATIONS[v]; if (m) L = m(L); v++; }
  return L;
}
// Builds a clean layout from anything (a stored copy, an imported file). Unknown fields are not
// copied, numbers are clamped, broken references are dropped; every fix is listed in issues.
// Panels whose type this version does not know are kept untouched (a newer version may have
// made them) and simply not drawn.
function wsValidateLayout(raw, issues) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a layout object');
  if (Number.isInteger(raw.v) && raw.v > WS_VER) issues.push(t('ws.issue.newer', { v: raw.v }));
  raw = wsMigrate(raw);
  const L = wsBlank(typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : t('ws.untitled'));
  if (typeof raw.id === 'string' && WS_ID_RE.test(raw.id)) L.id = raw.id;
  L.tpl = typeof raw.tpl === 'string' && WS_PRESETS.some((p) => p.key === raw.tpl) ? raw.tpl : null;
  L.ctx = Array.isArray(raw.ctx) ? WS_CTX.filter((c) => raw.ctx.includes(c)) : [];
  const o = raw.opt && typeof raw.opt === 'object' ? raw.opt : {};
  L.opt = {
    snap: o.snap !== false, grid: WS_GRIDS.includes(o.grid) ? o.grid : 16, gap: WS_GAPS.includes(o.gap) ? o.gap : 8,
    guides: o.guides !== false, backdrop: o.backdrop === 'solid' ? 'solid' : 'map',
  };
  const seen = new Set(), keys = new Set();
  let maxed = null;
  for (const p of Array.isArray(raw.panels) ? raw.panels.slice(0, 64) : []) {
    if (!p || typeof p !== 'object' || typeof p.pid !== 'string' || !WS_ID_RE.test(p.pid)) { issues.push(t('ws.issue.entry')); continue; }
    const def = wsDef(p.pid);
    const g = p.g && typeof p.g === 'object' ? p.g : {};
    const P = {
      iid: typeof p.iid === 'string' && WS_ID_RE.test(p.iid) && !seen.has(p.iid) ? p.iid : wsUid('p'),
      pid: p.pid,
      src: WS_SRC.includes(p.src) ? p.src : (def && !def.entity ? '' : 'sel'),
      st: ['float', 'dock', 'hidden'].includes(p.st) ? p.st : 'float',
      min: p.min === true, max: p.max === true,
      g: { x: 0, y: 0, w: wsNum(g.w, 0.04, 1, 0.3), h: wsNum(g.h, 0.04, 1, 0.5) },
      z: Math.round(wsNum(p.z, 0, 9999, 1)),
      prefs: {},
    };
    P.g.x = wsNum(g.x, 0, 1 - P.g.w, 0);
    P.g.y = wsNum(g.y, 0, 1 - P.g.h, 0);
    if (def && !def.entity) P.src = '';
    if (def) P.prefs = wsCleanPrefs(def, p.prefs);
    else if (p.prefs && typeof p.prefs === 'object') {
      // unknown panel type: keep plain option values only, for a version that knows it
      for (const [k, v] of Object.entries(p.prefs)) if (/^\w{1,24}$/.test(k) && ['boolean', 'number', 'string'].includes(typeof v)) P.prefs[k] = v;
    }
    if (def && def.comps) P.cl = wsValidateCl(def, p.cl, issues);
    else if (!def && p.cl) P.cl = wsValidateCl({ comps: [] }, p.cl, []); // kept for a version that knows the panel
    if (def && def.widget && p.from && typeof p.from === 'object' && typeof p.from.iid === 'string' && WS_ID_RE.test(p.from.iid)) P.from = { iid: p.from.iid, cid: def.cid };
    if (p.prev === 'float' || p.prev === 'dock') P.prev = p.prev;
    if (p.ret && typeof p.ret === 'object' && (p.ret.edge === 'start' || p.ret.edge === 'end')) {
      P.ret = { edge: p.ret.edge, col: Math.round(wsNum(p.ret.col, 0, 9, 0)), idx: Math.round(wsNum(p.ret.idx, 0, 32, 0)) };
    }
    // one instance per type, unless the type allows more with distinct data sources
    const key = def && def.multi ? p.pid + '|' + P.src + (P.from ? '|' + P.from.iid : '') : p.pid;
    if (keys.has(key)) { issues.push(t('ws.issue.dup', { n: def ? wsTitle(def) : p.pid })); continue; }
    keys.add(key);
    seen.add(P.iid);
    if (P.max) { if (maxed) maxed.max = false; maxed = P; }
    L.panels.push(P);
  }
  const byId = new Map(L.panels.map((P) => [P.iid, P]));
  const placed = new Set();
  for (const edge of ['start', 'end']) {
    const cols = raw.dock && Array.isArray(raw.dock[edge]) ? raw.dock[edge].slice(0, 6) : [];
    for (const c of cols) {
      if (!c || !Array.isArray(c.items)) continue;
      const items = [];
      for (const it of c.items.slice(0, 12)) {
        const P = it && byId.get(it.iid);
        if (!P || P.st !== 'dock' || placed.has(P.iid)) continue;
        placed.add(P.iid);
        items.push({ iid: P.iid, h: wsNum(it.h, 0.02, 1, 0.5) });
      }
      if (!items.length) continue;
      const sum = items.reduce((a, b) => a + b.h, 0);
      items.forEach((it) => { it.h = it.h / sum; });
      L.dock[edge].push({ w: wsNum(c.w, 0.05, 1, 0.25), items });
    }
  }
  const total = [...L.dock.start, ...L.dock.end].reduce((a, c) => a + c.w, 0);
  if (total > 1) [...L.dock.start, ...L.dock.end].forEach((c) => { c.w /= total; });
  for (const P of L.panels) if (P.st === 'dock' && !placed.has(P.iid)) { P.st = 'float'; issues.push(t('ws.issue.dock')); }
  wsFixDetached(L);
  const m = raw.mob && typeof raw.mob === 'object' ? raw.mob : {};
  L.mob.order = Array.isArray(m.order) ? [...new Set(m.order.filter((i) => byId.has(i)))] : [];
  if (m.h && typeof m.h === 'object') for (const [i, h] of Object.entries(m.h)) if (byId.has(i)) L.mob.h[i] = Math.round(wsNum(h, 120, 2000, 360));
  return L;
}
function wsFreshStore() {
  const layouts = WS_PRESETS.map((p) => wsFromPreset(p));
  return { v: WS_VER, layouts, current: layouts[0].id, def: layouts[0].id, autoCtx: false, show: true, mobShow: false };
}
function wsValidateStore(raw, issues) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.layouts)) throw new Error('not a layout store');
  const st = { v: WS_VER, layouts: [], current: null, def: null, autoCtx: raw.autoCtx === true, show: raw.show !== false, mobShow: raw.mobShow === true };
  const ids = new Set();
  for (const r of raw.layouts.slice(0, 50)) {
    try {
      const L = wsValidateLayout(r, issues);
      if (ids.has(L.id)) L.id = wsUid('L');
      ids.add(L.id);
      st.layouts.push(L);
    } catch (e) { issues.push(t('ws.issue.layout')); }
  }
  if (!st.layouts.length) return wsFreshStore();
  st.current = ids.has(raw.current) ? raw.current : st.layouts[0].id;
  st.def = ids.has(raw.def) ? raw.def : st.layouts[0].id;
  return st;
}

// ---------------------------------------------------------------- presets
// Starting points only: each becomes an ordinary, editable layout. Built as docked columns at
// the far edge, so the map (and its tools at the near edge) stays usable.
// col(edge, width, [[panel, source, height share], ...])
const wsCol = (edge, w, items) => ({ edge, w, items });
const WS_PRESETS = [
  { key: 'map', name: 'ws.preset.map', ctx: [], cols: [] },
  { key: 'pilot', name: 'ws.preset.pilot', ctx: ['air'], cols: [
    wsCol('end', 0.25, [['instruments', 'veh', 0.62], ['weapons', 'veh', 0.38]]),
    wsCol('end', 0.2, [['fuel', 'veh', 0.3], ['damage', 'veh', 0.7]]) ] },
  { key: 'gunner', name: 'ws.preset.gunner', ctx: ['armor'], cols: [
    wsCol('end', 0.26, [['turret', 'veh', 0.45], ['weapons', 'veh', 0.55]]),
    wsCol('end', 0.2, [['damage', 'veh', 1]]) ] },
  { key: 'commander', name: 'ws.preset.commander', ctx: [], cols: [
    wsCol('end', 0.26, [['crew', 'veh', 0.56], ['status', 'veh', 0.44]]),
    wsCol('end', 0.22, [['weapons', 'veh', 1]]) ] },
  { key: 'infantry', name: 'ws.preset.infantry', ctx: ['man'], cols: [
    wsCol('end', 0.25, [['health', 'me', 0.5], ['weapons', 'me', 0.5]]),
    wsCol('end', 0.24, [['inventory', 'me', 1]]) ] },
  { key: 'diag', name: 'ws.preset.diag', ctx: [], backdrop: 'solid', cols: [
    wsCol('start', 0.34, [['details', 'sel', 1]]),
    wsCol('start', 0.33, [['damage', 'sel', 0.55], ['telemetry', 'sel', 0.45]]),
    wsCol('start', 0.33, [['overview', 'sel', 1]]) ] },
  { key: 'minimal', name: 'ws.preset.minimal', ctx: [], floats: [['status', 'sel', { x: 0.73, y: 0.6, w: 0.25, h: 0.37 }]] },
];
function wsFromPreset(p, keep) {
  const L = wsBlank(t(p.name));
  if (keep) { L.id = keep.id; L.name = keep.name; L.ctx = keep.ctx.slice(); L.opt = Object.assign({}, keep.opt); }
  else L.ctx = p.ctx.slice();
  L.tpl = p.key;
  if (p.backdrop && !keep) L.opt.backdrop = p.backdrop;
  for (const c of p.cols || []) {
    const col = { w: c.w, items: [] };
    for (const [pid, src, h] of c.items) {
      const P = wsNewInst(pid, src);
      P.st = 'dock';
      L.panels.push(P);
      col.items.push({ iid: P.iid, h });
    }
    L.dock[c.edge].push(col);
  }
  let z = 1;
  for (const [pid, src, g] of p.floats || []) {
    const P = wsNewInst(pid, src);
    P.g = Object.assign({}, g); P.z = z++;
    L.panels.push(P);
  }
  return L;
}

// ---------------------------------------------------------------- state
const WS = {
  ready: false, off: false,
  store: null,         // { v, layouts, current, def, autoCtx, mobShow }
  work: null,          // working copy of the current layout (what is drawn)
  base: '',            // wsStable() of the saved copy
  undo: [],
  edit: false,
  sel: null,           // selected panel instance (iid)
  cust: null,          // iid whose settings sheet is open
  els: new Map(),      // iid -> element
  ids: new Map(),      // iid -> entity id it shows right now
  rects: new Map(),    // iid -> last laid-out rect (px, area coordinates)
  colRects: [],
  W: 0, H: 0, mobile: false,
  root: null, area: null,
  pfs: false,          // workspace "fullscreen" without the Fullscreen API (fills the window)
  op: null,            // drag in progress
  libQ: '', libCat: 'all', libOpen: true,
  libTab: 'panels',    // library: 'panels' | 'comps' (the parts of panels)
  libCCat: 'all',
  cedit: null,         // iid of the panel whose parts are being edited
  csel: null,          // selected part (component id) in that panel
  notice: [],          // problems found while loading (shown in the editor)
  ctxSeen: null,
  watchSig: '',
};
const wsP = (iid) => (WS.work ? WS.work.panels.find((P) => P.iid === iid) : null) || null;
const wsCurSaved = () => WS.store.layouts.find((l) => l.id === WS.work.id) || null;
const wsDirty = () => !!WS.work && wsStable(WS.work) !== WS.base;

// ---------------------------------------------------------------- storage
function wsReadStore() {
  let txt = null;
  try { txt = localStorage.getItem('a3map.ws'); } catch (e) { /* storage blocked: defaults, not saved */ }
  const issues = [];
  if (txt == null) return { st: wsFreshStore(), issues };
  try {
    return { st: wsValidateStore(JSON.parse(txt), issues), issues };
  } catch (e) {
    // unreadable: keep the broken text for recovery, start from the presets
    try { localStorage.setItem('a3map.wsBad', txt); } catch (e2) { /* nothing more to do */ }
    return { st: wsFreshStore(), issues: [t('ws.issue.store')] };
  }
}
function wsPersist() {
  try {
    localStorage.setItem('a3map.ws', JSON.stringify(WS.store));
    return true;
  } catch (e) {
    toast(t('ws.save_failed'));
    return false;
  }
}
let wsDraftT = 0;
function wsDraftSave() {
  clearTimeout(wsDraftT);
  wsDraftT = setTimeout(() => {
    if (!WS.work) return;
    if (wsDirty()) storeSet('wsDraft', { id: WS.work.id, L: WS.work });
    else wsDraftClear();
  }, 500);
}
function wsDraftClear() {
  clearTimeout(wsDraftT);
  try { localStorage.removeItem('a3map.wsDraft'); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- layout lifecycle
function wsOpen(id, draft) {
  const L = WS.store.layouts.find((l) => l.id === id) || WS.store.layouts[0];
  WS.store.current = L.id;
  wsPersist();
  WS.work = wsClone(L);
  WS.base = wsStable(L);
  if (draft) WS.work = draft;
  WS.undo = [];
  WS.sel = null; WS.cust = null; WS.cedit = null; WS.csel = null;
  WS.ctxSeen = wsMyCtx();
  wsApply();
}
// Re-draw everything from WS.work: elements, geometry, bodies, editor, subscriptions.
function wsApply() {
  const ce = WS.cedit && wsP(WS.cedit);
  if (WS.cedit && (!ce || ce.st === 'hidden' || !WS.edit)) { WS.cedit = null; WS.csel = null; }
  if (WS.csel && ce && !wsCVisible(ce, WS.csel)) WS.csel = null;
  wsSync();
  wsLayout();
  wsRenderAll(); // unchanged title bars and bodies are left alone (a click in progress keeps its target)
  wsUpdateChrome();
  pushWatch();
}
// Run a change as one undoable step.
function wsMut(fn) {
  const before = wsClone(WS.work);
  fn(WS.work);
  wsCommitFrom(before);
}
function wsCommitFrom(before) {
  if (wsStable(before) === wsStable(WS.work)) { wsLayout(); return; }
  WS.undo.push(before);
  if (WS.undo.length > 60) WS.undo.shift();
  wsApply();
  wsDraftSave();
}
function wsUndo() {
  if (!WS.undo.length) return;
  WS.work = WS.undo.pop();
  wsApply();
  wsDraftSave();
}
function wsSave() {
  const i = WS.store.layouts.findIndex((l) => l.id === WS.work.id);
  const copy = wsClone(WS.work);
  const prev = WS.store.layouts.slice();
  if (i >= 0) WS.store.layouts[i] = copy; else WS.store.layouts.push(copy);
  if (!wsPersist()) { WS.store.layouts = prev; return false; }
  WS.base = wsStable(copy);
  wsDraftClear();
  wsUpdateChrome();
  toast(t('ws.saved', { n: copy.name }));
  return true;
}
function wsSaveAs(name) {
  const L = wsClone(WS.work);
  L.id = wsUid('L'); L.name = name; L.tpl = WS.work.tpl;
  WS.store.layouts.push(L);
  WS.store.current = L.id;
  if (!wsPersist()) { WS.store.layouts.pop(); return; }
  wsDraftClear();
  WS.work = wsClone(L);
  WS.base = wsStable(L);
  WS.undo = [];
  wsUpdateChrome();
  toast(t('ws.saved', { n: name }));
}
function wsDiscard() {
  const L = wsCurSaved();
  wsDraftClear();
  if (L) { WS.work = wsClone(L); WS.base = wsStable(L); }
  WS.undo = [];
  wsApply();
}
// Switch layouts; unsaved changes are never dropped silently.
function wsSwitch(id) {
  if (!WS.work || id === WS.work.id) return;
  if (!wsDirty()) { wsDraftClear(); wsOpen(id); return; }
  wsAsk({
    title: t('ws.unsaved_title'), text: t('ws.unsaved_text', { n: WS.work.name }),
    buttons: [
      { label: t('ws.save'), primary: true, run: () => { if (wsSave()) wsOpen(id); } },
      { label: t('ws.discard'), run: () => { wsDraftClear(); wsOpen(id); } },
      { label: t('dlg.cancel') },
    ],
  });
}
function wsRestoreDefault() {
  const p = WS_PRESETS.find((x) => x.key === WS.work.tpl);
  wsMut((L) => {
    if (p) {
      const fresh = wsFromPreset(p, L);
      L.panels = fresh.panels; L.dock = fresh.dock; L.mob = { order: [], h: {} };
      if (p.backdrop) L.opt.backdrop = p.backdrop;
    } else {
      wsArrangeIn(L, 'grid');
      L.mob = { order: [], h: {} };
    }
  });
}

// ---------------------------------------------------------------- data sources
// sel = what the detail page or the map selection shows, else my vehicle, else me.
function wsResolve(src) {
  // right after a mission restart the old run's ids may belong to other things now
  if (S.run.oldState) return src === 'sel' && S.detailId && !S.run.pending ? S.detailId : null;
  const st = S.state;
  const me = st && st.me ? st.me.id : null;
  if (src === 'me') return me;
  const u = me && st.units ? st.units.find((x) => x.id === me) : null;
  const veh = u && u.veh ? u.veh : null;
  if (src === 'veh') return veh;
  const pick = S.detailId || (S.selected && (S.selected.kind === 'unit' || S.selected.kind === 'veh' || S.selected.kind === 'empty') ? S.selected.id : null);
  return pick || veh || me;
}
// Entities the workspace needs deep data for (joined with the detail page's in detailWatchIds).
function wsWatchIds() {
  if (WS.off || !WS.work) return [];
  const out = new Set();
  const pend = S.run.pending ? S.run.pending.id : null;
  for (const P of WS.work.panels) {
    if (P.st === 'hidden') continue;
    const def = wsDef(P.pid);
    if (!def || !def.entity) continue;
    const id = wsResolve(P.src);
    if (id && id !== pend) out.add(id);
  }
  return [...out];
}
// The role context of the player right now, for layouts that opt in to automatic switching.
function wsMyCtx() {
  const st = S.state;
  if (!st || !st.me) return null;
  const u = (st.units || []).find((x) => x.id === st.me.id);
  if (!u) return null;
  if (!u.veh) return 'man';
  const v = (st.vehicles || []).find((x) => x.id === u.veh);
  const k = v && v.kind;
  if (!k) return null;
  if (isAir(k)) return 'air';
  if (isArmor(k)) return 'armor';
  if (k === 'ship') return 'ship';
  return 'car';
}
function wsCheckCtx() {
  const c = wsMyCtx();
  if (c === WS.ctxSeen) return;
  WS.ctxSeen = c;
  if (!WS.store.autoCtx || !c || WS.edit || WS.work.ctx.includes(c)) return;
  const L = WS.store.layouts.find((l) => l.ctx.includes(c));
  if (!L) return;
  if (wsDirty()) { toast(t('ws.ctx_kept', { n: L.name })); return; }
  wsOpen(L.id);
  toast(t('ws.ctx_switched', { n: L.name }));
}

// ---------------------------------------------------------------- dock structure edits
function wsFindDock(L, iid) {
  for (const edge of ['start', 'end']) {
    const cols = L.dock[edge];
    for (let ci = 0; ci < cols.length; ci++) {
      const j = cols[ci].items.findIndex((it) => it.iid === iid);
      if (j >= 0) return { edge, ci, j };
    }
  }
  return null;
}
function wsUndockIn(L, P, rect) {
  const f = wsFindDock(L, P.iid);
  if (f) {
    const col = L.dock[f.edge][f.ci];
    col.items.splice(f.j, 1);
    if (!col.items.length) L.dock[f.edge].splice(f.ci, 1);
    else { const s = col.items.reduce((a, b) => a + b.h, 0); col.items.forEach((it) => { it.h /= s; }); }
    P.ret = { edge: f.edge, col: f.ci, idx: f.j };
  }
  P.st = 'float';
  if (rect) P.g = wsToFrac(rect);
  P.z = wsTopZ(L) + 1;
}
function wsNewColW(P) {
  const def = wsDef(P.pid);
  return Math.min(0.4, Math.max(0.14, (def ? def.size.w : 340) / Math.max(1, WS.W)));
}
// Keep the docked columns inside the workspace: when they would add up to more than all of it,
// the others give way (proportionally), never the column just placed.
function wsFitCols(L, keep) {
  const cols = [...L.dock.start, ...L.dock.end];
  const total = cols.reduce((a, c) => a + c.w, 0);
  if (total <= 1) return;
  const fixed = keep ? keep.w : 0;
  const rest = total - fixed;
  const room = Math.max(0.05, 1 - fixed);
  for (const c of cols) if (c !== keep) c.w = c.w * room / rest;
}
function wsDockIn(L, P, drop) {
  if (wsFindDock(L, P.iid)) wsUndockIn(L, P);
  P.st = 'dock'; P.max = false; P.min = false;
  const item = { iid: P.iid, h: 1 };
  if (drop.type === 'item') {
    const col = L.dock[drop.edge][drop.ci];
    if (col) {
      const tgt = col.items[drop.j];
      const h = tgt ? tgt.h / 2 : 1 / (col.items.length + 1);
      if (tgt) tgt.h = h;
      item.h = h;
      col.items.splice(drop.j + (drop.after ? 1 : 0), 0, item);
      const s = col.items.reduce((a, b) => a + b.h, 0); col.items.forEach((it) => { it.h /= s; });
      return;
    }
  }
  const col = { w: wsNewColW(P), items: [item] };
  const list = L.dock[drop.edge || 'end'];
  const at = drop.type === 'col' ? Math.max(0, Math.min(list.length, drop.at)) : (drop.type === 'edge' ? 0 : list.length);
  list.splice(at, 0, col);
  wsFitCols(L, col);
}
// Back to where it was docked last (or a new column at that edge, else at the end edge).
function wsRedockIn(L, P) {
  const r = P.ret;
  const col = r && L.dock[r.edge][r.col];
  if (!col) { wsDockIn(L, P, { type: 'col', edge: r ? r.edge : 'end', at: r ? Math.min(r.col, L.dock[r.edge].length) : L.dock.end.length }); return; }
  if (wsFindDock(L, P.iid)) wsUndockIn(L, P);
  P.st = 'dock'; P.max = false; P.min = false;
  col.items.splice(Math.min(r.idx, col.items.length), 0, { iid: P.iid, h: 1 / (col.items.length + 1) });
  const s = col.items.reduce((a, b) => a + b.h, 0); col.items.forEach((it) => { it.h /= s; });
}
function wsHideIn(L, P) {
  if (P.st === 'hidden') return;
  P.prev = P.st;
  if (P.st === 'dock') wsUndockIn(L, P);
  P.st = 'hidden'; P.max = false;
}
function wsShowIn(L, P) {
  if (P.st !== 'hidden') { P.min = false; return; }
  P.min = false;
  if (P.prev === 'dock' && !WS.mobile) wsRedockIn(L, P);
  else { P.st = 'float'; P.z = wsTopZ(L) + 1; }
}
function wsTopZ(L) { return L.panels.reduce((a, P) => (P.st === 'float' ? Math.max(a, P.z) : a), 0); }
function wsFrontIn(L, P) {
  if (P.st !== 'float') return;
  const floats = L.panels.filter((x) => x.st === 'float').sort((a, b) => a.z - b.z);
  if (floats[floats.length - 1] === P) return;
  floats.splice(floats.indexOf(P), 1); floats.push(P);
  floats.forEach((x, i) => { x.z = i + 1; });
}
function wsToFrac(r) {
  const W = Math.max(1, WS.W), H = Math.max(1, WS.H);
  const w = Math.min(1, r.w / W), h = Math.min(1, r.h / H);
  return { x: Math.max(0, Math.min(1 - w, r.x / W)), y: Math.max(0, Math.min(1 - h, r.y / H)), w, h };
}
// Add a panel (or bring back a hidden one) and place it where it does not hide another title bar.
function wsAddIn(L, pid, src) {
  const def = wsDef(pid);
  if (!def) return null;
  const same = L.panels.find((P) => P.pid === pid && !P.from && (!def.multi || P.src === (def.entity ? src : '')));
  if (same) { wsShowIn(L, same); wsFrontIn(L, same); return same; }
  if (!def.multi && L.panels.some((P) => P.pid === pid)) return null;
  const P = wsNewInst(pid, src);
  const W = Math.max(1, WS.W), H = Math.max(1, WS.H);
  P.g.w = Math.min(0.9, Math.max(def.min.w, def.size.w) / W);
  P.g.h = Math.min(0.9, Math.max(def.min.h, def.size.h) / H);
  P.g.x = Math.max(0, (1 - P.g.w) / 2); P.g.y = Math.max(0, (1 - P.g.h) / 3);
  P.z = wsTopZ(L) + 1;
  L.panels.push(P);
  wsNudgeIn(L, P);
  return P;
}
// A floating window dropped right over another's title bar is moved down and across a step.
function wsNudgeIn(L, P) {
  if (P.st !== 'float') return;
  const W = Math.max(1, WS.W), H = Math.max(1, WS.H), step = 28;
  for (let k = 0; k < 10; k++) {
    const clash = L.panels.some((o) => o !== P && o.st === 'float' && !o.min
      && Math.abs(o.g.x * W - P.g.x * W) < 16 && Math.abs(o.g.y * H - P.g.y * H) < 16);
    if (!clash) return;
    P.g.x = Math.min(1 - P.g.w, P.g.x + step / W);
    P.g.y = Math.min(1 - P.g.h, P.g.y + step / H);
  }
}
// Arrangements of every visible panel (docked columns filling the workspace).
function wsArrangeIn(L, how) {
  const vis = L.panels.filter((P) => P.st !== 'hidden' && wsDef(P.pid));
  L.dock = { start: [], end: [] };
  vis.forEach((P) => { P.st = 'dock'; P.max = false; P.min = false; });
  if (!vis.length) return;
  let ncol;
  if (how === 'side') ncol = vis.length;
  else if (how === 'stack') ncol = 1;
  else ncol = Math.ceil(Math.sqrt(vis.length));
  const per = Math.ceil(vis.length / ncol);
  for (let c = 0; c < ncol; c++) {
    const part = vis.slice(c * per, (c + 1) * per);
    if (!part.length) break;
    L.dock.start.push({ w: 0, items: part.map((P) => ({ iid: P.iid, h: 1 / part.length })) });
  }
  L.dock.start.forEach((c) => { c.w = 1 / L.dock.start.length; });
}
// Every docked panel becomes a floating window where it is now (free arrangement).
function wsFloatAllIn(L) {
  for (const P of L.panels) {
    if (P.st !== 'dock') continue;
    const r = WS.rects.get(P.iid);
    wsUndockIn(L, P, r || null);
  }
  L.dock = { start: [], end: [] };
}
// Align every floating window to the grid (position and size).
function wsAlignIn(L) {
  const g = L.opt.grid;
  const sn = (v) => Math.round(v / g) * g;
  for (const P of L.panels) {
    if (P.st !== 'float') continue;
    const r = wsFloatRect(P);
    P.g = wsToFrac({ x: sn(r.x), y: sn(r.y), w: Math.max(g, sn(r.w)), h: Math.max(g, sn(r.h)) });
  }
}

// ---------------------------------------------------------------- icons
const wsSvg = (d, extra = '') => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const WS_I = {
  cust: wsSvg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  dock: wsSvg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  float: wsSvg('<rect x="3" y="7" width="13" height="13" rx="2"/><path d="M8 7V4h13v12h-5"/>'),
  min: wsSvg('<path d="M5 18h14"/>'),
  unmin: wsSvg('<path d="M6 15l6-6 6 6"/>'),
  max: wsSvg('<rect x="4" y="4" width="16" height="16" rx="2"/>'),
  unmax: wsSvg('<rect x="7" y="3" width="14" height="14" rx="2"/><path d="M17 17v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h3"/>'),
  close: wsSvg('<path d="M6 6l12 12M18 6L6 18"/>'),
  up: wsSvg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  down: wsSvg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  grid: wsSvg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  undo: wsSvg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  lib: wsSvg('<path d="M4 4h6v16H4zM14 4l6 2-4 14-6-2z"/>'),
  full: wsSvg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  fullx: wsSvg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  more: wsSvg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  check: wsSvg('<path d="M5 12l5 5 9-10"/>'),
  eye: wsSvg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeoff: wsSvg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  parts: wsSvg('<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>'),
  grip: wsSvg('<circle cx="9" cy="6" r="1.2" fill="currentColor"/><circle cx="15" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="9" cy="18" r="1.2" fill="currentColor"/><circle cx="15" cy="18" r="1.2" fill="currentColor"/>'),
  compact: wsSvg('<path d="M4 9h16M4 15h16"/><path d="M9 4l3 3 3-3M9 20l3-3 3 3"/>'),
  ret: wsSvg('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>'),
};
const WS_RZ = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

// ---------------------------------------------------------------- elements
function wsMakeEl(P) {
  const el = document.createElement('section');
  el.className = 'wsp';
  el.dataset.iid = P.iid;
  el.tabIndex = -1;
  el.setAttribute('role', 'region');
  el.innerHTML = '<header class="wsp-head"></header><div class="wsc-strip" hidden></div><div class="wsp-body"></div><div class="wsp-cust" hidden></div>'
    + WS_RZ.map((d) => `<div class="wsp-rz wsp-rz-${d}" data-rz="${d}" aria-hidden="true"></div>`).join('');
  return el;
}
// One element per visible panel instance; an instance keeps its element (and its scroll
// position) across moves, docking and layout edits. Removed instances lose theirs.
function wsSync() {
  const want = new Set();
  for (const P of WS.work.panels) {
    if (P.st === 'hidden' || !wsDef(P.pid)) continue;
    want.add(P.iid);
    if (!WS.els.has(P.iid)) {
      const el = wsMakeEl(P);
      WS.els.set(P.iid, el);
      WS.area.appendChild(el);
    }
  }
  for (const [iid, el] of WS.els) if (!want.has(iid)) { el.remove(); WS.els.delete(iid); WS.ids.delete(iid); }
}

// ---------------------------------------------------------------- geometry
function wsFloatRect(P) {
  const def = wsDef(P.pid), W = WS.W, H = WS.H;
  let w = Math.min(W, Math.max(def.min.w, P.g.w * W));
  let h = Math.min(H, Math.max(def.min.h, P.g.h * H));
  if (def.max) { w = Math.min(w, Math.max(def.min.w, def.max.w)); h = Math.min(h, Math.max(def.min.h, def.max.h)); }
  const x = Math.min(Math.max(0, P.g.x * W), Math.max(0, W - w));
  const y = Math.min(Math.max(0, P.g.y * H), Math.max(0, H - h));
  return { x, y, w, h };
}
// Pixel rects for every drawn panel: docked columns from each edge, floating windows above
// them, a maximised panel over all. Minimised docked panels keep a title bar in their column;
// minimised floating windows go to the tray.
function wsRects() {
  const L = WS.work, W = WS.W, H = WS.H, gap = L.opt.gap, half = gap / 2;
  const out = new Map();
  WS.colRects = [];
  const inset = (x, y, w, h) => ({ x: x + half, y: y + half, w: Math.max(0, w - gap), h: Math.max(0, h - gap) });
  const placeCol = (col, x, w, edge, ci) => {
    const vis = col.items.map((it, j) => ({ it, j, P: wsP(it.iid) })).filter((o) => o.P && wsDef(o.P.pid));
    const mins = vis.filter((o) => o.P.min).length;
    const share = vis.filter((o) => !o.P.min).reduce((a, o) => a + o.it.h, 0) || 1;
    const free = Math.max(0, H - mins * (WS_HEAD + gap));
    let y = 0;
    const ys = [];
    for (const o of vis) {
      const h = o.P.min ? WS_HEAD + gap : free * o.it.h / share;
      out.set(o.P.iid, Object.assign(inset(x, y, w, h), { kind: 'dock', edge, ci, j: o.j }));
      y += h; ys.push(y);
    }
    WS.colRects.push({ edge, ci, x, w, ys, vis });
  };
  let x = 0;
  L.dock.start.forEach((c, i) => { const w = c.w * W; placeCol(c, x, w, 'start', i); x += w; });
  let xe = W;
  L.dock.end.forEach((c, i) => { const w = c.w * W; xe -= w; placeCol(c, xe, w, 'end', i); });
  for (const P of L.panels) {
    if (P.st !== 'float' || P.min || !wsDef(P.pid)) continue;
    out.set(P.iid, Object.assign(wsFloatRect(P), { kind: 'float' }));
  }
  const mx = L.panels.find((P) => P.max && P.st !== 'hidden' && wsDef(P.pid));
  if (mx) out.set(mx.iid, { x: 0, y: 0, w: W, h: H, kind: 'max' });
  return out;
}
// The phone/desktop choice follows the map area's width, so it is known while the workspace
// is hidden too; the panel area (smaller in the editor, by its bar) gives the geometry.
function wsMeasure() {
  const mw = $('#map-wrap').getBoundingClientRect();
  const r = WS.root.hidden ? mw : WS.area.getBoundingClientRect();
  WS.W = Math.max(1, Math.round(r.width));
  WS.H = Math.max(1, Math.round(r.height));
  WS.mobile = mw.width < WS_MOBILE_W;
}
// Apply geometry only (no body is re-rendered here).
function wsLayout() {
  if (!WS.work || WS.off) return;
  const wasMobile = WS.mobile;
  wsMeasure();
  WS.root.classList.toggle('ws-mob', WS.mobile);
  WS.root.classList.toggle('ws-solid', WS.work.opt.backdrop === 'solid' || WS.mobile);
  WS.root.style.setProperty('--ws-grid', WS.work.opt.grid + 'px');
  wsUpdateRoot();
  if (WS.mobile) wsLayoutMobile(); else wsLayoutDesk();
  if (wasMobile !== WS.mobile) wsRenderAll(true); // title bar buttons differ
  if (typeof mapCtlPlace === 'function') mapCtlPlace(); // the map's corner controls step aside from docked columns
}
function wsLayoutDesk() {
  const R = wsRects();
  WS.rects = R;
  const floats = WS.work.panels.filter((P) => P.st === 'float').sort((a, b) => a.z - b.z);
  const zr = new Map(floats.map((P, i) => [P.iid, 20 + i]));
  const hasMax = [...R.values()].some((r) => r.kind === 'max');
  WS.area.classList.toggle('ws-hasmax', hasMax);
  for (const P of WS.work.panels) {
    const el = WS.els.get(P.iid);
    if (!el) continue;
    const r = R.get(P.iid);
    el.classList.toggle('wsp-tray', !r);
    if (!r) continue;
    const z = r.kind === 'max' ? 400 : (r.kind === 'dock' ? 10 : zr.get(P.iid));
    el.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;z-index:${z}`;
    el.classList.toggle('wsp-float', r.kind === 'float');
    el.classList.toggle('wsp-dock', r.kind === 'dock');
    el.classList.toggle('wsp-max', r.kind === 'max');
    el.classList.toggle('wsp-min', P.min && r.kind !== 'max');
    el.classList.toggle('wsp-sel', WS.edit && WS.sel === P.iid);
    el.classList.toggle('wsp-under', hasMax && r.kind !== 'max');
  }
  wsSplitters();
  wsTray();
}
// Phone: one column in a stable order (the desktop geometry is left as it is).
function wsMobOrder() {
  const L = WS.work;
  const desk = [];
  for (const edge of ['start', 'end']) for (const c of L.dock[edge]) for (const it of c.items) desk.push(it.iid);
  L.panels.filter((P) => P.st === 'float').sort((a, b) => a.g.y - b.g.y || a.g.x - b.g.x).forEach((P) => desk.push(P.iid));
  const vis = new Set(L.panels.filter((P) => P.st !== 'hidden' && wsDef(P.pid)).map((P) => P.iid));
  const order = L.mob.order.filter((i) => vis.has(i));
  for (const i of desk) if (vis.has(i) && !order.includes(i)) order.push(i);
  return order;
}
function wsLayoutMobile() {
  const order = wsMobOrder();
  WS.rects = new Map();
  WS.colRects = [];
  const mx = WS.work.panels.find((P) => P.max && P.st !== 'hidden' && wsDef(P.pid));
  WS.area.classList.toggle('ws-hasmax', !!mx);
  order.forEach((iid, i) => {
    const el = WS.els.get(iid), P = wsP(iid);
    if (!el || !P) return;
    const def = wsDef(P.pid);
    const isMax = mx === P;
    const h = isMax ? WS.H : (P.min ? WS_HEAD : (WS.work.mob.h[iid] || Math.min(def.size.h, Math.round(WS.H * 0.8))));
    el.style.cssText = `order:${i};height:${h}px`;
    el.classList.remove('wsp-float', 'wsp-dock', 'wsp-tray');
    el.classList.toggle('wsp-max', isMax);
    el.classList.toggle('wsp-min', P.min && !isMax);
    el.classList.toggle('wsp-sel', WS.edit && WS.sel === iid);
    el.classList.toggle('wsp-under', !!mx && !isMax);
  });
  WS.area.querySelector('.ws-splits').innerHTML = '';
  wsTray();
}
// Drag handles between docked columns and between panels stacked in one column.
function wsSplitters() {
  const box = WS.area.querySelector('.ws-splits');
  let h = '';
  for (const c of WS.colRects) {
    const xEdge = c.edge === 'start' ? c.x + c.w : c.x;
    h += `<div class="ws-split ws-split-v" data-split="col" data-edge="${c.edge}" data-ci="${c.ci}" style="left:${xEdge - 4}px;top:0;height:${WS.H}px" title="${esc(t('ws.split'))}"></div>`;
    c.ys.slice(0, -1).forEach((y, k) => {
      h += `<div class="ws-split ws-split-h" data-split="item" data-edge="${c.edge}" data-ci="${c.ci}" data-j="${k}" style="left:${c.x}px;top:${y - 4}px;width:${c.w}px" title="${esc(t('ws.split'))}"></div>`;
    });
  }
  if (box._h !== h) { box.innerHTML = h; box._h = h; }
}
function wsTray() {
  const tray = WS.root.querySelector('.ws-tray');
  const mins = WS.mobile ? [] : WS.work.panels.filter((P) => P.st === 'float' && P.min && wsDef(P.pid));
  const h = mins.map((P) => {
    const def = wsDef(P.pid);
    return `<button class="ws-chip" data-tray="${P.iid}" title="${esc(t('ws.act.restore'))}">${dIcon(def.icon, 14)}<span>${esc(wsTitle(def))}</span>${wsSrcTag(P, def)}</button>`;
  }).join('');
  tray.hidden = !mins.length;
  if (tray._h !== h) { tray.innerHTML = h; tray._h = h; }
}

// ---------------------------------------------------------------- panel content
function wsEntityName(d) {
  if (!d || !d.found) return '';
  return d.kind === 'man' ? (personName(d.id) || d.name || d.cls) : (d.name || d.cls || '');
}
function wsSrcTag(P, def) { return def.entity ? `<span class="wsp-src">${esc(t('ws.src.' + P.src))}</span>` : ''; }
function wsHeadHtml(P, def, d) {
  const b = (act, icon, label, on) => `<button type="button" class="wsp-b${on ? ' on' : ''}" data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}">${icon}</button>`;
  const name = wsEntityName(d);
  const title = wsTitle(def);
  let h = `<span class="wsp-ic">${dIcon(def.icon, 16)}</span><span class="wsp-t"><b>${esc(title)}</b>`
    + (name ? `<span class="wsp-n"><bdi>${esc(name)}</bdi></span>` : '') + `</span>`
    + (WS.edit ? wsSrcTag(P, def) : '')
    + `<span class="wsp-fresh"></span>`;
  if (WS.mobile && WS.edit && !P.max) h += b('up', WS_I.up, t('ws.act.up')) + b('down', WS_I.down, t('ws.act.down'));
  if (WS.edit && def.comps) h += b('parts', WS_I.parts, t(WS.cedit === P.iid ? 'ws.c.done' : 'ws.c.edit'), WS.cedit === P.iid);
  if (WS.edit && def.widget) h += b('ret', WS_I.ret, t('ws.c.return'));
  h += b('cust', WS_I.cust, t('ws.act.cust'), WS.cust === P.iid);
  if (!WS.mobile && !P.max) h += b('dock', P.st === 'dock' ? WS_I.float : WS_I.dock, t(P.st === 'dock' ? 'ws.act.float' : 'ws.act.dock'));
  if (!P.max) h += b('min', P.min ? WS_I.unmin : WS_I.min, t(P.min ? 'ws.act.restore' : 'ws.act.min'));
  h += b('max', P.max ? WS_I.unmax : WS_I.max, t(P.max ? 'ws.act.unmax' : 'ws.act.max'));
  h += b('close', WS_I.close, t('ws.act.hide'));
  return h;
}
function wsNA(def, d) {
  return `<div class="d-empty ws-na">${dIcon(def.icon, 22)}<span>${esc(t('ws.na', { p: wsTitle(def), k: tOr('kind.' + d.kind, d.kind) }))}</span></div>`;
}
// The body markup of one panel, or null when it hides itself (not applicable + "auto-hide").
function wsBody(P, def, id, d) {
  if (!def.entity) return def.render(null, P, null);
  if (def.loose) return def.render(id ? S.details[id] || null : null, P, id);
  if (!id) return `<div class="d-empty">${esc(t('ws.nosrc.' + P.src))}</div>`;
  const pend = S.run.pending;
  if (pend && pend.id === id) {
    return `<div class="d-empty d-restart">${dIcon('misc', 28)}<b>${esc(t('run.restarted'))}</b>`
      + `<span>${esc(t(pend.failed ? 'run.lost' : 'run.finding', { n: pend.label || '' }))}</span></div>`;
  }
  if (!d) return `<div class="d-empty">${esc(t('d.loading'))}</div>`;
  if (!d.found) return `<div class="d-empty">${esc(t('d.gone'))}</div>`;
  if (!def.applies(d, P)) return P.prefs.autohide ? null : wsNA(def, d);
  return def.render(d, P);
}
// SVG ids (clip paths, hatch patterns) must be unique per document: the same gauge may be drawn
// in the detail page and in several panels at once.
function wsScopeIds(html, sfx) {
  return html.replace(/(\s)id="([^"]+)"/g, `$1id="$2--${sfx}"`).replace(/url\(#([^)]+)\)/g, `url(#$1--${sfx})`);
}
function wsRenderPanel(P, force) {
  const el = WS.els.get(P.iid);
  if (!el) return;
  const def = wsDef(P.pid);
  const id = def.entity ? wsResolve(P.src) : null;
  WS.ids.set(P.iid, id);
  const d = id ? S.details[id] : null;
  const hh = wsHeadHtml(P, def, d);
  if (force || el._hh !== hh) {
    el._hh = hh;
    el.querySelector('.wsp-head').innerHTML = hh;
    el.setAttribute('aria-label', wsTitle(def));
    el._fresh = null;
  }
  wsFreshOne(el, id, def);
  el.classList.toggle('wsp-compact', P.prefs.compact === true);
  el.classList.toggle('wsp-nonums', P.prefs.nums === false);
  el.classList.toggle('wsp-widget', !!def.widget);
  const cedit = WS.edit && WS.cedit === P.iid;
  el.classList.toggle('wsp-cedit', cedit);
  const strip = el.querySelector('.wsc-strip');
  strip.hidden = !cedit || (P.min && !P.max);
  if (cedit) { const sh = wsCStripHtml(P); if (strip._h !== sh) { strip._h = sh; strip.innerHTML = sh; } }
  if (P.min && !P.max) return; // collapsed: the body is not drawn (it is refreshed when restored)
  if (wsCompsLive(P, def, id, d)) {
    el.classList.remove('wsp-gone');
    wsRenderComps(el, P, def, id, d, force);
    return;
  }
  let body = wsBody(P, def, id, d);
  const gone = body === null;
  el.classList.toggle('wsp-gone', gone && !WS.edit);
  if (gone) body = wsNA(def, d);
  const html = wsScopeIds(body, P.iid);
  if (!force && el._sig === html) return;
  el._sig = html;
  const b = el.querySelector('.wsp-body');
  const sy = b.scrollTop;
  b.innerHTML = `<div class="d-wrap">${html}</div>`;
  b.scrollTop = sy;
  paintNeedles(b);
}
function wsRenderAll(force) {
  if (!WS.ready || WS.off || !WS.work) return;
  for (const P of WS.work.panels) if (WS.els.has(P.iid)) wsRenderPanel(P, force);
  const sig = wsWatchIds().join(',');
  if (sig !== WS.watchSig) { WS.watchSig = sig; pushWatch(); }
}
// A detail payload arrived: redraw the panels that show that entity.
function wsOnDetail(id) {
  if (!WS.ready || WS.off || !WS.work) return;
  for (const P of WS.work.panels) if (WS.ids.get(P.iid) === id) wsRenderPanel(P);
}
function wsOnState() {
  if (!WS.ready || WS.off || !WS.work) return;
  wsCheckCtx();
  wsRenderAll();
}
function wsFreshOne(el, id, def) {
  const box = el.querySelector('.wsp-fresh');
  if (!box) return;
  if (!def.entity || !id) { if (el._fresh !== '') { box.innerHTML = ''; el._fresh = ''; } el.classList.remove('d-stale'); return; }
  const f = freshness(id);
  const key = f.cls + '|' + f.txt;
  if (el._fresh !== key) {
    el._fresh = key;
    box.innerHTML = `<span class="fresh fresh-${f.cls}" title="${esc(freshTitle())}"><i></i>${esc(f.txt)}</span>`;
  }
  el.classList.toggle('d-stale', f.cls === 'stale' || f.cls === 'off');
}
// Live values from the position stream, moved in place (same as the detail page).
function wsPatchLive() {
  if (!WS.ready || WS.off || !WS.work || WS.root.hidden) return;
  for (const P of WS.work.panels) {
    if (P.min && !P.max) continue;
    const el = WS.els.get(P.iid);
    const id = WS.ids.get(P.iid);
    const d = id && S.details[id];
    if (!el || !d || !d.found) continue;
    patchLiveIn(el.querySelector('.wsp-body'), d);
  }
}
function wsPaintNeedles(now) {
  if (WS.ready && !WS.off && WS.root && !WS.root.hidden) paintNeedles(WS.area, now);
}

// ---------------------------------------------------------------- pointer: move, resize, split
// One set of handlers for every panel (delegated on the workspace). Pointer moves only set the
// dragged element's style, at most once per frame; the layout is written once, on release.
function wsSelect(iid) {
  if (WS.sel === iid) return;
  WS.sel = iid;
  for (const [i, el] of WS.els) el.classList.toggle('wsp-sel', WS.edit && i === iid);
  if (WS.edit) wsLibRender();
}
function wsDragLoop(op, frame, end) {
  const move = (ev) => {
    op.ev = ev;
    if (!op.raf) op.raf = requestAnimationFrame(() => { op.raf = 0; frame(op); });
  };
  const stop = (ev, cancel) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', can);
    if (op.raf) cancelAnimationFrame(op.raf);
    op.raf = 0;
    if (!cancel && ev) { op.ev = ev; frame(op); }
    WS.op = null;
    WS.root.classList.remove('ws-dragging');
    end(op, cancel);
  };
  const up = (ev) => stop(ev, false);
  const can = () => stop(null, true);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', can);
  WS.op = op;
  WS.root.classList.add('ws-dragging');
}
function wsElRect(el) { return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }; }

// Alignment guides: edges and centres of the other panels and of the workspace.
function wsGuideTargets(skip) {
  const xs = [0, WS.W / 2, WS.W], ys = [0, WS.H / 2, WS.H];
  for (const [iid, r] of WS.rects) {
    if (iid === skip || r.kind === 'max') continue;
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  return { xs, ys };
}
function wsNearest(vals, targets, tol) {
  let best = null;
  for (const [i, v] of vals.entries()) for (const tg of targets) {
    const dd = tg - v;
    if (Math.abs(dd) <= tol && (!best || Math.abs(dd) < Math.abs(best.d))) best = { d: dd, at: tg, i };
  }
  return best;
}
function wsShowGuides(gx, gy) {
  const a = WS.area.querySelector('.ws-guide-v'), b = WS.area.querySelector('.ws-guide-h');
  a.hidden = gx == null; b.hidden = gy == null;
  if (gx != null) a.style.left = gx + 'px';
  if (gy != null) b.style.top = gy + 'px';
}
// Snap a moving rect: guides first, else the grid. Free (Shift held) = neither.
function wsSnapRect(r, skip, free, edges) {
  const L = WS.work;
  let gx = null, gy = null;
  if (free) return { r, gx, gy };
  const T = L.opt.guides ? wsGuideTargets(skip) : null;
  const g = L.opt.grid;
  const out = Object.assign({}, r);
  const axis = (pos, size, targets, which) => {
    // which: 'move' shifts the rect; 'lo'/'hi' moves one edge
    const vals = which === 'move' ? [pos, pos + size / 2, pos + size] : (which === 'lo' ? [pos] : [pos + size]);
    const hit = targets ? wsNearest(vals, targets, 6) : null;
    if (hit) {
      if (which === 'move') pos += hit.d; else if (which === 'lo') { pos += hit.d; size -= hit.d; } else size += hit.d;
      return { pos, size, guide: hit.at };
    }
    if (L.opt.snap) {
      if (which === 'move') pos = Math.round(pos / g) * g;
      else if (which === 'lo') { const np = Math.round(pos / g) * g; size += pos - np; pos = np; }
      else size = Math.round((pos + size) / g) * g - pos;
    }
    return { pos, size, guide: null };
  };
  const ex = edges || 'move', ey = edges || 'move';
  if (ex === 'move' || /[ew]/.test(ex)) {
    const which = ex === 'move' ? 'move' : (ex.includes('w') ? 'lo' : 'hi');
    const a = axis(out.x, out.w, T && T.xs, which); out.x = a.pos; out.w = a.size; gx = a.guide;
  }
  if (ey === 'move' || /[ns]/.test(ey)) {
    const which = ey === 'move' ? 'move' : (ey.includes('n') ? 'lo' : 'hi');
    const a = axis(out.y, out.h, T && T.ys, which); out.y = a.pos; out.h = a.size; gy = a.guide;
  }
  return { r: out, gx, gy };
}

// Where a dragged window would dock: near a workspace side edge = a new outer column; over a
// docked panel = above / below it (top / bottom third) or a new column beside it (side quarter).
function wsDropTarget(px, py) {
  const W = WS.W, H = WS.H, E = 30;
  const colW = Math.min(W * 0.3, Math.max(W * 0.18, 300));
  if (px < E) return { type: 'edge', edge: 'start', rect: { x: 0, y: 0, w: colW, h: H } };
  if (px > W - E) return { type: 'edge', edge: 'end', rect: { x: W - colW, y: 0, w: colW, h: H } };
  for (const c of WS.colRects) {
    if (px < c.x || px > c.x + c.w) continue;
    let y0 = 0;
    for (let k = 0; k < c.vis.length; k++) {
      const y1 = c.ys[k];
      if (py >= y0 && py <= y1) {
        const fx = (px - c.x) / c.w, fy = (py - y0) / (y1 - y0), j = c.vis[k].j;
        const hgt = y1 - y0;
        if (fy < 0.3) return { type: 'item', edge: c.edge, ci: c.ci, j, after: false, rect: { x: c.x, y: y0, w: c.w, h: hgt / 2 } };
        if (fy > 0.7) return { type: 'item', edge: c.edge, ci: c.ci, j, after: true, rect: { x: c.x, y: y0 + hgt / 2, w: c.w, h: hgt / 2 } };
        const left = fx < 0.25, right = fx > 0.75;
        if (!left && !right) return null;
        // columns are numbered from their own edge outwards-in
        const at = c.edge === 'start' ? c.ci + (right ? 1 : 0) : c.ci + (left ? 1 : 0);
        return { type: 'col', edge: c.edge, at, rect: { x: left ? c.x : c.x + c.w * 0.6, y: 0, w: c.w * 0.4, h: H } };
      }
      y0 = y1;
    }
  }
  return null;
}
function wsShowDrop(drop) {
  const pv = WS.area.querySelector('.ws-preview');
  pv.hidden = !drop;
  if (drop) {
    const r = drop.rect;
    pv.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
    pv.querySelector('span').textContent = t('ws.drop');
  }
}

function wsStartMove(e, P, el) {
  if (WS.mobile || P.max) return;
  e.preventDefault();
  const op = { P, el, before: wsClone(WS.work), sx: e.clientX, sy: e.clientY, r0: wsElRect(el), moved: false, drop: null, rect: null };
  wsDragLoop(op, (o) => {
    const ev = o.ev, dx = ev.clientX - o.sx, dy = ev.clientY - o.sy;
    if (!o.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      o.moved = true;
      if (P.st === 'dock') { wsUndockIn(WS.work, P, o.r0); wsLayout(); wsRenderPanel(P); }
      o.el.classList.add('wsp-drag');
    }
    const def = wsDef(P.pid);
    let r = { x: o.r0.x + dx, y: o.r0.y + dy, w: Math.max(def.min.w, o.r0.w), h: Math.max(def.min.h, o.r0.h) };
    const s = wsSnapRect(r, P.iid, ev.shiftKey || ev.altKey);
    r = s.r;
    r.x = Math.max(0, Math.min(WS.W - r.w, r.x));
    r.y = Math.max(0, Math.min(WS.H - Math.min(r.h, WS_HEAD), r.y));
    r.y = Math.max(0, Math.min(Math.max(0, WS.H - r.h), r.y));
    o.rect = r;
    o.el.style.left = r.x + 'px';
    o.el.style.top = r.y + 'px';
    wsShowGuides(s.gx, s.gy);
    const ar = WS.area.getBoundingClientRect();
    // a widget over a panel that holds parts goes back in as a part (editor only)
    o.into = wsWidgetTarget(P, ev.clientX, ev.clientY);
    o.drop = !o.into && WS.edit && !ev.shiftKey ? wsDropTarget(ev.clientX - ar.left, ev.clientY - ar.top) : null;
    wsShowDrop(o.drop);
    wsCShowIns(o.into && !o.into.dup ? o.into.bar || null : null, o.into ? o.into.pe : null);
    o.el.classList.toggle('wsp-intopanel', !!(o.into && !o.into.dup));
  }, (o, cancel) => {
    o.el.classList.remove('wsp-drag', 'wsp-intopanel');
    wsShowGuides(null, null); wsShowDrop(null); wsCShowIns(null, null);
    if (cancel) { WS.work = o.before; wsApply(); return; }
    if (!o.moved) return;
    if (o.into && o.into.dup) { toast(t('ws.c.already', { n: wsTitle(wsDef(P.pid)), p: wsTitle(wsDef(o.into.P.pid)) })); }
    if (o.into && !o.into.dup) {
      const tgt = WS.work.panels.find((x) => x.iid === o.into.P.iid);
      if (wsAttachIn(WS.work, P, tgt, o.into.index, o.into.at || null)) {
        WS.sel = tgt.iid; WS.cedit = tgt.iid; WS.csel = wsDef(P.pid).cid;
        wsCommitFrom(o.before);
        return;
      }
    }
    if (o.drop) wsDockIn(WS.work, P, o.drop);
    else if (o.rect) { P.g = wsToFrac(o.rect); wsNudgeIn(WS.work, P); }
    wsCommitFrom(o.before);
  });
}
function wsStartResize(e, P, el, dir) {
  if (P.max) return;
  const def = wsDef(P.pid);
  e.preventDefault();
  e.stopPropagation();
  const op = { P, el, dir, before: wsClone(WS.work), sx: e.clientX, sy: e.clientY, r0: wsElRect(el), rect: null };
  if (WS.mobile) {
    // a phone stack: only the height changes
    wsDragLoop(op, (o) => {
      const h = Math.max(def.min.h, Math.min(2000, o.r0.h + (o.ev.clientY - o.sy)));
      o.rect = h; o.el.style.height = h + 'px';
    }, (o, cancel) => {
      if (cancel || o.rect == null) { wsLayout(); return; }
      WS.work.mob.h[P.iid] = Math.round(o.rect);
      wsCommitFrom(o.before);
    });
    return;
  }
  if (P.st !== 'float') return;
  wsDragLoop(op, (o) => {
    const ev = o.ev, dx = ev.clientX - o.sx, dy = ev.clientY - o.sy, r0 = o.r0;
    const mw = def.min.w, mh = def.min.h;
    const Mw = def.max ? def.max.w : WS.W, Mh = def.max ? def.max.h : WS.H;
    let { x, y, w, h } = r0;
    if (dir.includes('e')) w = r0.w + dx;
    if (dir.includes('s')) h = r0.h + dy;
    if (dir.includes('w')) { w = r0.w - dx; x = r0.x + dx; }
    if (dir.includes('n')) { h = r0.h - dy; y = r0.y + dy; }
    const s = wsSnapRect({ x, y, w, h }, P.iid, ev.shiftKey || ev.altKey, dir);
    ({ x, y, w, h } = s.r);
    // limits: minimum and maximum size, inside the workspace; the fixed edge never moves
    const right = r0.x + r0.w, bottom = r0.y + r0.h;
    if (dir.includes('w')) { x = Math.max(0, Math.min(x, right - mw)); w = Math.min(Mw, right - x); x = right - w; }
    else w = Math.max(mw, Math.min(Mw, w, WS.W - x));
    if (dir.includes('n')) { y = Math.max(0, Math.min(y, bottom - mh)); h = Math.min(Mh, bottom - y); y = bottom - h; }
    else h = Math.max(mh, Math.min(Mh, h, WS.H - y));
    o.rect = { x, y, w, h };
    o.el.style.cssText += `;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
    wsShowGuides(s.gx, s.gy);
  }, (o, cancel) => {
    wsShowGuides(null, null);
    if (cancel || !o.rect) { wsLayout(); return; }
    P.g = wsToFrac(o.rect);
    wsCommitFrom(o.before);
  });
}
function wsStartSplit(e, sp) {
  e.preventDefault();
  const edge = sp.dataset.edge, ci = Number(sp.dataset.ci), kind = sp.dataset.split;
  const L = WS.work, cols = L.dock[edge], col = cols[ci];
  if (!col) return;
  const op = { before: wsClone(L), sx: e.clientX, sy: e.clientY };
  const minW = (c) => Math.max(...c.items.map((it) => { const P = wsP(it.iid); return P && wsDef(P.pid) ? wsDef(P.pid).min.w : 160; }), 120) / WS.W;
  if (kind === 'col') {
    const next = cols[ci + 1];
    const w0 = col.w, n0 = next ? next.w : 0;
    const others = [...L.dock.start, ...L.dock.end].filter((c) => c !== col && c !== next).reduce((a, c) => a + c.w, 0);
    wsDragLoop(op, (o) => {
      let d = (o.ev.clientX - o.sx) / WS.W;
      if (edge === 'end') d = -d;
      let w = w0 + d;
      if (next) {
        w = Math.max(minW(col), Math.min(w0 + n0 - minW(next), w));
        col.w = w; next.w = w0 + n0 - w;
      } else {
        col.w = Math.max(minW(col), Math.min(1 - others, w));
      }
      wsLayout();
    }, (o, cancel) => { if (cancel) { WS.work = o.before; wsApply(); } else wsCommitFrom(o.before); });
  } else {
    const j = Number(sp.dataset.j);
    const a = col.items[j], b = col.items[j + 1];
    if (!a || !b) return;
    const a0 = a.h, b0 = b.h;
    const share = col.items.filter((it) => { const P = wsP(it.iid); return P && !P.min; }).reduce((s, it) => s + it.h, 0) || 1;
    const mins = col.items.filter((it) => { const P = wsP(it.iid); return P && P.min; }).length;
    const free = Math.max(1, WS.H - mins * (WS_HEAD + L.opt.gap));
    const minH = (it) => { const P = wsP(it.iid); return (P && wsDef(P.pid) ? wsDef(P.pid).min.h : 120) / free * share; };
    wsDragLoop(op, (o) => {
      const d = (o.ev.clientY - o.sy) / free * share;
      const na = Math.max(minH(a), Math.min(a0 + b0 - minH(b), a0 + d));
      a.h = na; b.h = a0 + b0 - na;
      wsLayout();
    }, (o, cancel) => { if (cancel) { WS.work = o.before; wsApply(); } else wsCommitFrom(o.before); });
  }
}

// ---------------------------------------------------------------- panel actions
function wsAct(P, act) {
  switch (act) {
    case 'cust': WS.cust = WS.cust === P.iid ? null : P.iid; if (!WS.edit) wsEdit(true); else wsUpdateChrome(); wsRenderAll(); break;
    case 'parts': wsCEdit(WS.cedit === P.iid ? null : P.iid); break;
    case 'ret': {
      let ok = false;
      wsMut((L) => { ok = wsReturnIn(L, L.panels.find((x) => x.iid === P.iid)); });
      if (!ok) toast(t('ws.c.noreturn'));
      break;
    }
    case 'min': wsMut((L) => { const Q = L.panels.find((x) => x.iid === P.iid); Q.min = !Q.min; Q.max = false; }); break;
    case 'max': wsMut((L) => { L.panels.forEach((x) => { if (x.iid !== P.iid) x.max = false; }); const Q = L.panels.find((x) => x.iid === P.iid); Q.max = !Q.max; if (Q.max) Q.min = false; }); break;
    case 'close': wsMut((L) => wsHideIn(L, L.panels.find((x) => x.iid === P.iid))); if (WS.cust === P.iid) WS.cust = null; toast(t('ws.hidden', { n: wsTitle(wsDef(P.pid)) })); break;
    case 'dock': wsMut((L) => { const Q = L.panels.find((x) => x.iid === P.iid); if (Q.st === 'dock') wsUndockIn(L, Q, WS.rects.get(Q.iid)); else wsRedockIn(L, Q); }); break;
    case 'up': case 'down': wsMut((L) => {
      const order = wsMobOrder(); const i = order.indexOf(P.iid); const j = i + (act === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]]; L.mob.order = order;
    }); break;
    default: break;
  }
}
function wsOnPointerDown(e) {
  if (e.button !== 0 || WS.op) return;
  const sp = e.target.closest('[data-split]');
  if (sp) { wsStartSplit(e, sp); return; }
  const el = e.target.closest('.wsp');
  if (!el) { if (WS.edit && e.target === WS.area) wsSelect(null); return; }
  const P = wsP(el.dataset.iid);
  if (!P) return;
  wsSelect(P.iid);
  if (P.st === 'float' && !WS.mobile) {
    const floats = WS.work.panels.filter((x) => x.st === 'float');
    if (floats.some((x) => x.z > P.z)) wsMut((L) => wsFrontIn(L, L.panels.find((x) => x.iid === P.iid)));
  }
  // a part of the panel whose parts are being edited: select it, then move or resize it
  const ce = WS.edit && WS.cedit === P.iid ? e.target.closest('.wsc') : null;
  if (ce && el.contains(ce) && !e.target.closest('[data-cact]')) {
    const cid = ce.dataset.cid;
    wsCSelect(cid);
    const crz = e.target.closest('[data-crz]');
    if (crz) wsStartCompResize(e, wsP(P.iid), cid, ce, WS.els.get(P.iid));
    else wsStartCompMove(e, wsP(P.iid), cid, ce, WS.els.get(P.iid));
    return;
  }
  if (WS.edit && WS.cedit === P.iid && WS.csel && e.target.closest('.wsp-body') && !e.target.closest('.wsc')) wsCSelect(null);
  const rz = e.target.closest('[data-rz]');
  if (rz) { wsStartResize(e, wsP(P.iid), WS.els.get(P.iid), rz.dataset.rz); return; }
  if (e.target.closest('button, a, input, select, textarea, label, [data-dtab]')) return;
  if (e.target.closest('.wsp-head')) wsStartMove(e, wsP(P.iid), WS.els.get(P.iid));
}
function wsOnClick(e) {
  const tray = e.target.closest('[data-tray]');
  if (tray) { wsMut((L) => { const Q = L.panels.find((x) => x.iid === tray.dataset.tray); if (Q) { Q.min = false; wsFrontIn(L, Q); } }); return; }
  const el = e.target.closest('.wsp');
  if (!el) return;
  const P = wsP(el.dataset.iid);
  if (!P) return;
  const btn = e.target.closest('[data-act]');
  if (btn && el.contains(btn) && btn.closest('.wsp-head')) { wsAct(P, btn.dataset.act); return; }
  const cb = e.target.closest('[data-cact]');
  if (cb && WS.cedit === P.iid) { const ce = cb.closest('.wsc'); if (ce) { wsCSelect(ce.dataset.cid); wsCAct(P, ce.dataset.cid, cb.dataset.cact); } return; }
  const sb = e.target.closest('[data-cstrip]');
  if (sb) { wsCStrip(P, sb.dataset.cstrip); return; }
  const tab = e.target.closest('[data-wstab]');
  if (tab) { wsMut((L) => { const Q = L.panels.find((x) => x.iid === P.iid); Q.prefs.tab = tab.dataset.wstab; }); return; }
}
function wsOnDblClick(e) {
  // double-click a part in the editor: edit that panel's parts with it selected
  const ce = WS.edit && e.target.closest('.wsc');
  if (ce && !e.target.closest('button')) {
    const pe = ce.closest('.wsp');
    if (pe && WS.cedit !== pe.dataset.iid) { wsCEdit(pe.dataset.iid); wsCSelect(ce.dataset.cid); }
    return;
  }
  const head = e.target.closest('.wsp-head');
  if (!head || e.target.closest('button')) return;
  const P = wsP(head.closest('.wsp').dataset.iid);
  if (P) wsAct(P, 'max');
}
// Keyboard: Esc restores a maximised panel or closes the open sheet; in the editor the arrows
// move the selected window by one grid step (Shift: resize), Delete hides it, Ctrl+Z undoes and
// Ctrl+S saves.
function wsOnKey(e) {
  if (WS.off || !WS.work) return;
  const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
  const modal = WS.root.querySelector('.ws-modal:not([hidden])');
  if (WS.edit && !typing && !modal && !WS.op && wsCKey(e)) return;
  if (e.key === 'Escape') {
    if (modal) { wsCloseModal(); e.preventDefault(); return; }
    if (WS.op) return;
    const mx = WS.work.panels.find((P) => P.max);
    if (mx) { wsAct(mx, 'max'); e.preventDefault(); return; }
    if (WS.cust) { WS.cust = null; wsUpdateChrome(); wsRenderAll(); return; }
    if (WS.pfs) { wsExitFull(); return; }
    return;
  }
  if (!WS.edit || typing || modal) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); wsUndo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); wsSave(); return; }
  const P = WS.sel && wsP(WS.sel);
  if (!P) return;
  if (e.key === 'Delete') { e.preventDefault(); wsAct(P, 'close'); return; }
  const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!k || P.st !== 'float' || WS.mobile) return;
  e.preventDefault();
  const step = e.altKey ? 1 : WS.work.opt.grid;
  wsMut((L) => {
    const Q = L.panels.find((x) => x.iid === P.iid);
    const def = wsDef(Q.pid);
    const r = wsFloatRect(Q);
    if (e.shiftKey) { r.w = Math.max(def.min.w, Math.min(WS.W - r.x, r.w + k[0] * step)); r.h = Math.max(def.min.h, Math.min(WS.H - r.y, r.h + k[1] * step)); }
    else { r.x = Math.max(0, Math.min(WS.W - r.w, r.x + k[0] * step)); r.y = Math.max(0, Math.min(WS.H - r.h, r.y + k[1] * step)); }
    Q.g = wsToFrac(r);
  });
}

// ---------------------------------------------------------------- editor chrome
function wsUpdateRoot() {
  if (!WS.root) return;
  const vis = WS.work && WS.work.panels.some((P) => P.st !== 'hidden' && wsDef(P.pid));
  const show = WS.edit || appEl.classList.contains('ws-window') || wsDirty()
    || (WS.mobile ? WS.store.mobShow : (WS.store.show !== false && vis));
  appEl.classList.toggle('ws-covers', show && (WS.mobile || WS.work.opt.backdrop === 'solid'));
  if (typeof mapCtlPlace === 'function') mapCtlPlace();
  if (WS.root.hidden === !show) return;
  WS.root.hidden = !show;
  if (show) requestAnimationFrame(() => { wsLayout(); wsRenderAll(true); });
}
function wsEdit(on) {
  if (WS.off) return;
  if (!on && WS.edit && wsDirty()) {
    wsAsk({
      title: t('ws.unsaved_title'), text: t('ws.unsaved_text', { n: WS.work.name }),
      buttons: [
        { label: t('ws.save'), primary: true, run: () => { if (wsSave()) wsEdit(false); } },
        { label: t('ws.discard'), run: () => { wsDiscard(); wsEditSet(false); } },
        { label: t('ws.keep'), run: () => wsEditSet(false) },
      ],
    });
    return;
  }
  wsEditSet(on);
}
function wsEditSet(on) {
  // on a phone the library is a full-screen sheet: start with the panels, open it on demand
  if (on && !WS.edit && WS.mobile) WS.libOpen = false;
  WS.edit = !!on;
  if (!on) { WS.cust = null; WS.cedit = null; WS.csel = null; }
  WS.root.classList.toggle('ws-editing', WS.edit);
  appEl.classList.toggle('ws-editing', WS.edit);
  wsUpdateRoot();
  wsUpdateChrome();
  requestAnimationFrame(() => { wsLayout(); wsRenderAll(true); });
}
function wsUpdateChrome() {
  if (!WS.root || !WS.work) return;
  const dirty = wsDirty();
  const bar = WS.root.querySelector('.wse-bar');
  bar.hidden = !WS.edit;
  if (WS.edit) bar.innerHTML = wsBarHtml(dirty);
  const lib = WS.root.querySelector('.wse-lib');
  lib.hidden = !WS.edit || !(WS.libOpen || WS.cust || (WS.cedit && !WS.mobile));
  if (!lib.hidden) wsLibRender();
  const chip = WS.root.querySelector('.ws-dirty');
  chip.hidden = WS.edit || !dirty;
  if (!chip.hidden) {
    chip.innerHTML = `<span class="ws-dot"></span><span>${esc(t('ws.changed', { n: WS.work.name }))}</span>`
      + `<button type="button" class="btn small-btn primary" data-wse="save">${esc(t('ws.save'))}</button>`
      + `<button type="button" class="btn small-btn" data-wse="discard">${esc(t('ws.discard'))}</button>`
      + `<button type="button" class="btn small-btn" data-wse="edit">${esc(t('ws.customize'))}</button>`;
  }
  const fab = WS.root.querySelector('.ws-fab');
  fab.hidden = !appEl.classList.contains('ws-window') || WS.edit;
  const b = $('#btn-ws');
  if (b) { b.classList.toggle('active', WS.edit); b.setAttribute('aria-expanded', String(!$('#ws-menu').hidden)); }
  wsUpdateRoot();
}
function wsBarHtml(dirty) {
  const L = WS.work;
  const opts = WS.store.layouts.map((l) => `<option value="${esc(l.id)}"${l.id === L.id ? ' selected' : ''}>${l.id === WS.store.def ? '★ ' : ''}${esc(l.id === L.id ? L.name : l.name)}</option>`).join('');
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement) || WS.pfs;
  const B = (act, icon, label, cls = '', dis = false) => `<button type="button" class="btn small-btn ${cls}" data-wse="${act}"${dis ? ' disabled' : ''} title="${esc(label)}">${icon || ''}<span>${esc(label)}</span></button>`;
  return `<div class="wse-row">`
    + `<span class="wse-title">${WS_I.grid}<b>${esc(t('ws.customize'))}</b></span>`
    + `<label class="wse-pick"><span class="sr">${esc(t('ws.layout'))}</span><select data-wse-pick aria-label="${esc(t('ws.layout'))}">${opts}</select></label>`
    + (dirty ? `<span class="wse-unsaved" title="${esc(t('ws.unsaved'))}"><span class="ws-dot"></span>${esc(t('ws.unsaved'))}</span>` : `<span class="wse-saved">${WS_I.check}${esc(t('ws.saved_s'))}</span>`)
    + `<span class="spacer"></span>`
    + B('save', '', t('ws.save'), 'primary', !dirty)
    + B('saveas', '', t('ws.saveas'))
    + B('undo', WS_I.undo, t('ws.undo'), '', !WS.undo.length)
    + B('cancel', '', t('ws.cancel'), '', !dirty)
    + `<span class="wse-menuwrap"><button type="button" class="btn small-btn" data-wse="m-layout" aria-haspopup="true">${esc(t('ws.m.layout'))} ▾</button></span>`
    + `<span class="wse-menuwrap"><button type="button" class="btn small-btn" data-wse="m-arrange" aria-haspopup="true">${esc(t('ws.m.arrange'))} ▾</button></span>`
    + B('lib', WS_I.lib, t('ws.library'), WS.libOpen ? 'on' : '')
    + B('full', isFs ? WS_I.fullx : WS_I.full, t(isFs ? 'ws.fs_exit' : 'ws.fs'))
    + B('done', WS_I.check, t('ws.done'), 'primary')
    + `</div>`;
}
function wsMenuHtml(which) {
  const L = WS.work;
  const it = (act, label, on, extra = '') => `<button type="button" class="wse-mi${on ? ' on' : ''}" data-wse="${act}"${extra}>${on != null ? `<span class="wse-ck">${on ? '✓' : ''}</span>` : ''}<span>${esc(label)}</span></button>`;
  const sel = (key, list, cur, fmt) => `<label class="wse-ms"><span>${esc(t('ws.opt.' + key))}</span><select data-wse-opt="${key}">${list.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(fmt(v))}</option>`).join('')}</select></label>`;
  if (which === 'arrange') {
    return `<div class="wse-mh">${esc(t('ws.m.arrange'))}</div>`
      + it('ar-side', t('ws.ar.side')) + it('ar-stack', t('ws.ar.stack')) + it('ar-grid', t('ws.ar.grid'))
      + it('ar-float', t('ws.ar.float')) + it('ar-align', t('ws.ar.align'))
      + `<div class="wse-sep"></div>`
      + it('o-snap', t('ws.opt.snap'), L.opt.snap) + it('o-guides', t('ws.opt.guides'), L.opt.guides)
      + sel('grid', WS_GRIDS, L.opt.grid, (v) => v + ' px') + sel('gap', WS_GAPS, L.opt.gap, (v) => v + ' px')
      + `<div class="wse-sep"></div>`
      + it('o-bd-map', t('ws.opt.bd_map'), L.opt.backdrop === 'map') + it('o-bd-solid', t('ws.opt.bd_solid'), L.opt.backdrop === 'solid')
      + `<div class="wse-sep"></div>` + it('reset', t(L.tpl ? 'ws.reset_tpl' : 'ws.reset'));
  }
  const presets = WS_PRESETS.map((p) => it('new-' + p.key, t(p.name))).join('');
  return `<div class="wse-mh">${esc(t('ws.m.layout'))}</div>`
    + it('new', t('ws.new')) + `<div class="wse-sub"><div class="wse-mh2">${esc(t('ws.new_from'))}</div>${presets}</div>`
    + it('dup', t('ws.dup')) + it('rename', t('ws.rename')) + it('del', t('ws.del'))
    + it('setdef', t('ws.setdef'), WS.store.def === L.id)
    + `<div class="wse-sep"></div>` + it('export', t('ws.export')) + it('import', t('ws.import'))
    + `<div class="wse-sep"></div><div class="wse-mh2">${esc(t('ws.ctx'))}</div>`
    + WS_CTX.map((c) => it('ctx-' + c, t('ws.ctx.' + c), L.ctx.includes(c))).join('')
    + it('autoctx', t('ws.autoctx'), WS.store.autoCtx === true);
}
function wsToggleMenu(which, btn) {
  const m = WS.root.querySelector('.wse-menu');
  if (!m.hidden && m.dataset.which === which) { m.hidden = true; return; }
  m.dataset.which = which;
  m.innerHTML = wsMenuHtml(which);
  m.hidden = false;
  const br = btn.getBoundingClientRect(), rr = WS.root.getBoundingClientRect();
  const w = Math.min(280, rr.width - 16);
  m.style.width = w + 'px';
  m.style.left = Math.max(8, Math.min(rr.width - w - 8, br.left - rr.left)) + 'px';
  m.style.top = (br.bottom - rr.top + 4) + 'px';
}
function wsCloseMenu() { const m = WS.root.querySelector('.wse-menu'); if (m) m.hidden = true; }

async function wsEditorCmd(act, el) {
  const L = WS.work;
  if (act !== 'm-layout' && act !== 'm-arrange' && !act.startsWith('o-') && !act.startsWith('ctx-') && act !== 'autoctx') wsCloseMenu();
  switch (act) {
    case 'save': wsSave(); return;
    case 'discard': wsDiscard(); return;
    case 'edit': wsEdit(true); return;
    case 'saveas': { const n = await wsPrompt(t('ws.saveas'), t('ws.copy_of', { n: L.name })); if (n) wsSaveAs(n); return; }
    case 'undo': wsUndo(); return;
    case 'cancel': wsDiscard(); return;
    case 'done': wsEdit(false); return;
    case 'lib': WS.libOpen = !WS.libOpen; if (!WS.libOpen) WS.cust = null; wsUpdateChrome(); return;
    case 'full': wsFullscreen(); return;
    case 'm-layout': wsToggleMenu('layout', el); return;
    case 'm-arrange': wsToggleMenu('arrange', el); return;
    case 'ar-side': wsMut((x) => wsArrangeIn(x, 'side')); return;
    case 'ar-stack': wsMut((x) => wsArrangeIn(x, 'stack')); return;
    case 'ar-grid': wsMut((x) => wsArrangeIn(x, 'grid')); return;
    case 'ar-float': wsMut((x) => wsFloatAllIn(x)); return;
    case 'ar-align': wsMut((x) => wsAlignIn(x)); return;
    case 'o-snap': wsMut((x) => { x.opt.snap = !x.opt.snap; }); break;
    case 'o-guides': wsMut((x) => { x.opt.guides = !x.opt.guides; }); break;
    case 'o-bd-map': wsMut((x) => { x.opt.backdrop = 'map'; }); break;
    case 'o-bd-solid': wsMut((x) => { x.opt.backdrop = 'solid'; }); break;
    case 'reset': wsRestoreDefault(); return;
    case 'new': { const n = await wsPrompt(t('ws.new'), t('ws.custom_n', { n: WS.store.layouts.length + 1 })); if (n) wsNewLayout(wsBlank(n)); return; }
    case 'dup': { const n = await wsPrompt(t('ws.dup'), t('ws.copy_of', { n: L.name })); if (n) { const c = wsClone(L); c.id = wsUid('L'); c.name = n; wsNewLayout(c); } return; }
    case 'rename': {
      const n = await wsPrompt(t('ws.rename'), L.name);
      if (!n) return;
      // a name change is saved at once (it is not a layout edit)
      L.name = n;
      const s = wsCurSaved();
      if (s) { s.name = n; WS.base = wsStable(Object.assign(JSON.parse(WS.base), { name: n })); }
      wsPersist(); wsUpdateChrome(); return;
    }
    case 'del': wsDeleteLayout(); return;
    case 'setdef': WS.store.def = L.id; wsPersist(); wsUpdateChrome(); toast(t('ws.def_set', { n: L.name })); return;
    case 'export': wsExport(); return;
    case 'import': wsImportPick(); return;
    case 'autoctx': WS.store.autoCtx = !WS.store.autoCtx; wsPersist(); break;
    default:
      if (act.startsWith('new-')) { const p = WS_PRESETS.find((x) => x.key === act.slice(4)); if (p) wsNewLayout(wsFromPreset(p)); return; }
      if (act.startsWith('ctx-')) { const c = act.slice(4); wsMut((x) => { x.ctx = x.ctx.includes(c) ? x.ctx.filter((y) => y !== c) : WS_CTX.filter((y) => y === c || x.ctx.includes(y)); }); break; }
      return;
  }
  // toggles keep their menu open, redrawn with the new state
  const m = WS.root.querySelector('.wse-menu');
  if (m && !m.hidden) m.innerHTML = wsMenuHtml(m.dataset.which);
}
function wsNewLayout(L) {
  const go = () => {
    WS.store.layouts.push(L);
    if (!wsPersist()) { WS.store.layouts.pop(); return; }
    wsDraftClear();
    wsOpen(L.id);
    toast(t('ws.created', { n: L.name }));
  };
  if (!wsDirty()) { go(); return; }
  wsAsk({
    title: t('ws.unsaved_title'), text: t('ws.unsaved_text', { n: WS.work.name }),
    buttons: [
      { label: t('ws.save'), primary: true, run: () => { if (wsSave()) go(); } },
      { label: t('ws.discard'), run: go },
      { label: t('dlg.cancel') },
    ],
  });
}
function wsDeleteLayout() {
  const L = WS.work;
  wsAsk({
    title: t('ws.del'), text: t('ws.del_q', { n: L.name }),
    buttons: [
      { label: t('ws.del'), danger: true, run: () => {
        WS.store.layouts = WS.store.layouts.filter((l) => l.id !== L.id);
        if (!WS.store.layouts.length) WS.store.layouts.push(wsFromPreset(WS_PRESETS[0]));
        if (WS.store.def === L.id) WS.store.def = WS.store.layouts[0].id;
        wsDraftClear();
        wsOpen(WS.store.def);
        toast(t('ws.deleted', { n: L.name }));
      } },
      { label: t('dlg.cancel'), primary: true },
    ],
  });
}

// ---------------------------------------------------------------- panel library
function wsLibItem(def) {
  const L = WS.work;
  const insts = L.panels.filter((P) => P.pid === def.id);
  const selD = def.entity ? S.details[wsResolve('sel')] : null;
  const na = selD && selD.found && !def.applies(selD, { prefs: {} });
  const st = (P) => (P.st === 'hidden' ? 'hidden' : (P.min ? 'min' : (P.max ? 'max' : P.st)));
  const btn = (act, label, cls = '') => `<button type="button" class="btn small-btn ${cls}" data-wlib="${act}" data-pid="${def.id}">${esc(label)}</button>`;
  const row = (P) => {
    const s = st(P);
    const acts = s === 'hidden' ? btn('show:' + P.iid, t('ws.lib.show'), 'primary')
      : (s === 'min' ? btn('show:' + P.iid, t('ws.act.restore')) : btn('focus:' + P.iid, t('ws.lib.focus'))) + btn('hide:' + P.iid, t('ws.lib.hide'));
    return `<div class="wl-inst wl-${s}${WS.sel === P.iid ? ' wl-sel' : ''}"><span class="wl-st">${esc(t('ws.st.' + s))}</span>`
      + (def.entity ? `<span class="wsp-src">${esc(t('ws.src.' + P.src))}</span>` : '') + `<span class="spacer"></span>`
      + btn('cust:' + P.iid, t('ws.act.cust')) + acts + `</div>`;
  };
  let adds = '';
  if (!insts.length) adds = btn('add:' + (def.entity ? 'sel' : ''), t('ws.lib.add'), 'primary');
  else if (def.multi) {
    const free = WS_SRC.filter((s) => !insts.some((P) => P.src === s));
    if (free.length) adds = `<span class="wl-addfor">${esc(t('ws.lib.add_for'))}</span>` + free.map((s) => btn('add:' + s, t('ws.src.' + s))).join('');
  }
  return `<div class="wl-item" data-cat="${def.cat}"><div class="wl-head"><span class="wl-ic">${dIcon(def.icon, 20)}</span>`
    + `<span class="wl-name"><b>${esc(wsTitle(def))}</b><small>${esc(tOr('ws.d.' + def.id, ''))}</small></span></div>`
    + (na ? `<div class="wl-note">${esc(t('ws.lib.na', { k: tOr('kind.' + selD.kind, selD.kind) }))}</div>` : '')
    + insts.map(row).join('') + (adds ? `<div class="wl-adds">${adds}</div>` : '') + `</div>`;
}
function wsCustHtml(P) {
  const def = wsDef(P.pid);
  if (!def) return '';
  let h = `<div class="wc"><div class="wc-head">${dIcon(def.icon, 18)}<b>${esc(wsTitle(def))}</b><span class="spacer"></span>`
    + `<button type="button" class="icon-btn" data-wlib="custclose" title="${esc(t('d.close'))}" aria-label="${esc(t('d.close'))}">${WS_I.close}</button></div>`;
  if (def.entity) {
    h += `<label class="wc-row"><span>${esc(t('ws.src'))}</span><select data-wpref="__src">`
      + WS_SRC.map((s) => {
        const taken = def.multi && WS.work.panels.some((x) => x !== P && x.pid === P.pid && x.src === s);
        return `<option value="${s}"${s === P.src ? ' selected' : ''}${taken ? ' disabled' : ''}>${esc(t('ws.src.' + s))}</option>`;
      }).join('') + `</select></label>`;
  }
  for (const p of def.prefs) {
    const v = P.prefs[p.key];
    if (p.type === 'bool') h += `<label class="wc-row wc-ck"><input type="checkbox" data-wpref="${p.key}"${v ? ' checked' : ''}><span>${esc(t(p.label))}</span></label>`;
    else if (p.type === 'select') {
      h += `<label class="wc-row"><span>${esc(t(p.label))}</span><select data-wpref="${p.key}">`
        + p.opts.map((o) => `<option value="${esc(String(o))}"${o === v ? ' selected' : ''}>${esc(p.fmt ? p.fmt(o) : tOr(p.optLabel + o, String(o)))}</option>`).join('') + `</select></label>`;
    } else if (p.type === 'multi') {
      h += `<fieldset class="wc-multi"><legend>${esc(t(p.label))}</legend>`
        + p.opts.map((o) => `<label class="wc-ck"><input type="checkbox" data-wpref="${p.key}" data-wopt="${o}"${v.includes(o) ? ' checked' : ''}><span>${esc(t(p.optLabel + o))}</span></label>`).join('') + `</fieldset>`;
    }
  }
  if (!def.prefs.length && !def.entity) h += `<div class="muted small">${esc(t('ws.no_prefs'))}</div>`;
  if (def.comps && P.cl && WS.cedit !== P.iid && P.st !== 'hidden') {
    const n = P.cl.items.filter((it) => !it.hid && !it.out && wsCDef(it.cid)).length;
    h += `<div class="wc-parts"><span>${esc(t('ws.c.count', { n }))}</span><button type="button" class="btn small-btn primary" data-wcomp="edit:${P.iid}">${WS_I.parts}<span>${esc(t('ws.c.edit'))}</span></button></div>`;
  }
  if (def.widget && P.from) {
    const P0 = wsP(P.from.iid);
    h += `<div class="wc-parts"><span>${esc(t('ws.c.from', { p: P0 && wsDef(P0.pid) ? wsTitle(wsDef(P0.pid)) : t('ws.c.gone') }))}</span><button type="button" class="btn small-btn" data-wlib="act:ret:${P.iid}">${WS_I.ret}<span>${esc(t('ws.c.return'))}</span></button></div>`;
  }
  const r = WS.rects.get(P.iid);
  const stKey = P.st === 'hidden' ? 'hidden' : (P.max ? 'max' : (P.min ? 'min' : P.st));
  h += `<div class="wc-geo">${esc(t('ws.st.' + stKey))}${r && !WS.mobile ? ` · <span dir="ltr">${Math.round(r.w)} × ${Math.round(r.h)} px</span>` : ''}</div>`;
  const a = (act, label) => `<button type="button" class="btn small-btn" data-wlib="act:${act}:${P.iid}">${esc(label)}</button>`;
  h += `<div class="wc-acts">`
    + (WS.mobile || P.st === 'hidden' ? '' : a('dock', t(P.st === 'dock' ? 'ws.act.float' : 'ws.act.dock')))
    + (P.st === 'hidden' ? '' : a('max', t(P.max ? 'ws.act.unmax' : 'ws.act.max')) + a('min', t(P.min ? 'ws.act.restore' : 'ws.act.min')))
    + (P.st === 'hidden' ? `<button type="button" class="btn small-btn primary" data-wlib="show:${P.iid}">${esc(t('ws.lib.show'))}</button>` : a('close', t('ws.act.hide')))
    + `<button type="button" class="btn small-btn danger" data-wlib="remove:${P.iid}">${esc(t('ws.remove'))}</button>`
    + `</div></div>`;
  return h;
}
function wsLibRender() {
  const lib = WS.root && WS.root.querySelector('.wse-lib');
  if (!lib || lib.hidden) return;
  const q = WS.libQ.trim().toLowerCase();
  const comps = WS.libTab === 'comps';
  const defs = [...WS_REG.values()].filter((d) => (WS.libCat === 'all' || d.cat === WS.libCat)
    && (!q || wsTitle(d).toLowerCase().includes(q) || tOr('ws.d.' + d.id, '').toLowerCase().includes(q) || d.id.includes(q)));
  const cust = WS.cust && wsP(WS.cust);
  const ced = WS.cedit && wsP(WS.cedit);
  const unknown = WS.work.panels.filter((P) => !wsDef(P.pid));
  const notices = WS.notice.length ? `<div class="wl-notice">${WS.notice.map((n) => `<div>${esc(n)}</div>`).join('')}<button type="button" class="btn small-btn" data-wlib="notice-ok">${esc(t('ws.ok'))}</button></div>` : '';
  const groups = WS_CATS.map((c) => {
    const list = defs.filter((d) => d.cat === c);
    return list.length ? `<div class="wl-cat">${esc(t('ws.cat.' + c))}</div>` + list.map(wsLibItem).join('') : '';
  }).join('');
  const html = `<div class="wl-top"><b>${esc(t('ws.library'))}</b><span class="spacer"></span>`
    + `<button type="button" class="icon-btn" data-wse="lib" title="${esc(t('d.close'))}" aria-label="${esc(t('d.close'))}">${WS_I.close}</button></div>`
    + (ced ? wsCListHtml(ced) : '')
    + (cust && cust !== ced ? wsCustHtml(cust) : '')
    + notices
    + `<div class="wl-tabs seg small" role="tablist">`
    + ['panels', 'comps'].map((k) => `<button type="button" role="tab" class="${WS.libTab === k ? 'on' : ''}" aria-selected="${WS.libTab === k}" data-wlib-tab="${k}">${esc(t('ws.lib.tab_' + k))}</button>`).join('') + `</div>`
    + `<input type="search" class="wl-q" data-wlib-q placeholder="${esc(t(comps ? 'ws.c.search' : 'ws.lib.search'))}" value="${esc(WS.libQ)}" aria-label="${esc(t(comps ? 'ws.c.search' : 'ws.lib.search'))}">`
    + (comps ? wsCLibHtml(q) : `<div class="wl-cats">${['all', ...WS_CATS].map((c) => `<button type="button" class="wl-catb${WS.libCat === c ? ' on' : ''}" data-wlib-cat="${c}">${esc(t(c === 'all' ? 'ws.cat.all' : 'ws.cat.' + c))}</button>`).join('')}</div>`
    + `<div class="wl-list">${groups || `<div class="d-empty">${esc(t('ws.lib.none'))}</div>`}`
    + (unknown.length ? `<div class="wl-cat">${esc(t('ws.lib.unknown'))}</div>` + unknown.map((P) => `<div class="wl-item"><div class="wl-head"><span class="wl-name"><b dir="ltr">${esc(P.pid)}</b><small>${esc(t('ws.lib.unknown_d'))}</small></span></div><div class="wl-adds"><button type="button" class="btn small-btn danger" data-wlib="remove:${P.iid}">${esc(t('ws.remove'))}</button></div></div>`).join('') : '')
    + `</div>`);
  if (lib._h === html) return;
  // keep the search box focused (and the caret where it was) while typing
  const qa = document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-wlib-q]');
  const caret = qa ? document.activeElement.selectionStart : null;
  const sc = lib.querySelector('.wl-list') ? lib.querySelector('.wl-list').scrollTop : 0;
  lib._h = html;
  lib.innerHTML = html;
  const list = lib.querySelector('.wl-list');
  if (list) list.scrollTop = sc;
  if (qa) { const i = lib.querySelector('[data-wlib-q]'); i.focus(); try { i.setSelectionRange(caret, caret); } catch (e) { /* ignore */ } }
}
function wsLibCmd(cmd, el) {
  const [act, a, b] = cmd.split(':');
  if (act === 'add') {
    const pid = el && el.dataset.pid;
    if (!pid) return;
    let added = null;
    wsMut((x) => { added = wsAddIn(x, pid, a || 'sel'); });
    if (added) wsSelect(added.iid);
    return;
  }
  if (act === 'custclose') { WS.cust = null; wsUpdateChrome(); wsRenderAll(); return; }
  if (act === 'notice-ok') { WS.notice = []; wsLibRender(); return; }
  const P = wsP(a);
  if (act === 'act' && b) { const Q = wsP(b); if (Q) wsAct(Q, a); return; }
  if (!P) return;
  if (act === 'show') { wsMut((x) => { const Q = x.panels.find((y) => y.iid === P.iid); wsShowIn(x, Q); wsFrontIn(x, Q); wsNudgeIn(x, Q); }); wsSelect(P.iid); return; }
  if (act === 'hide') { wsMut((x) => wsHideIn(x, x.panels.find((y) => y.iid === P.iid))); return; }
  if (act === 'focus') {
    wsSelect(P.iid);
    if (P.st === 'float') wsMut((x) => wsFrontIn(x, x.panels.find((y) => y.iid === P.iid)));
    const el = WS.els.get(P.iid);
    if (el) { el.focus({ preventScroll: WS.mobile ? false : true }); if (WS.mobile) el.scrollIntoView({ block: 'nearest' }); el.classList.add('wsp-flash'); setTimeout(() => el.classList.remove('wsp-flash'), 700); }
    return;
  }
  if (act === 'cust') { WS.cust = P.iid; wsSelect(P.iid); wsUpdateChrome(); wsRenderAll(); return; }
  if (act === 'remove') {
    wsMut((x) => {
      const f = wsFindDock(x, P.iid);
      if (f) wsUndockIn(x, x.panels.find((y) => y.iid === P.iid));
      x.panels = x.panels.filter((y) => y.iid !== P.iid);
      x.mob.order = x.mob.order.filter((i) => i !== P.iid);
      delete x.mob.h[P.iid];
      wsFixDetached(x); // a removed widget's part goes back into its panel (hidden)
    });
    if (WS.cust === P.iid) WS.cust = null;
    if (WS.sel === P.iid) WS.sel = null;
    wsUpdateChrome();
  }
}
function wsPrefChange(input) {
  const P = WS.cust && wsP(WS.cust);
  if (!P) return;
  const def = wsDef(P.pid);
  const key = input.dataset.wpref;
  wsMut((x) => {
    const Q = x.panels.find((y) => y.iid === P.iid);
    if (key === '__src') {
      if (WS_SRC.includes(input.value) && !(def.multi && x.panels.some((y) => y !== Q && y.pid === Q.pid && y.src === input.value))) Q.src = input.value;
      return;
    }
    const p = def.prefs.find((y) => y.key === key);
    if (!p) return;
    if (p.type === 'bool') Q.prefs[key] = input.checked;
    else if (p.type === 'select') { const v = p.opts.find((o) => String(o) === input.value); if (v !== undefined) Q.prefs[key] = v; }
    else if (p.type === 'multi') {
      const set = new Set(Q.prefs[key]);
      if (input.checked) set.add(input.dataset.wopt); else set.delete(input.dataset.wopt);
      Q.prefs[key] = p.opts.filter((o) => set.has(o));
    }
  });
}

// ---------------------------------------------------------------- modal (inside the workspace, so it works in fullscreen)
let wsModalDone = null;
function wsAsk({ title, text, buttons, input, body }) {
  const m = WS.root.querySelector('.ws-modal');
  return new Promise((resolve) => {
    wsModalDone = (v) => { m.hidden = true; m.innerHTML = ''; wsModalDone = null; resolve(v); };
    m.innerHTML = `<div class="ws-dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>`
      + (text ? `<p>${esc(text)}</p>` : '') + (body || '')
      + (input != null ? `<input type="text" class="ws-in" maxlength="60" value="${esc(input)}" dir="auto">` : '')
      + `<div class="ws-dlg-acts">${(buttons || []).map((b, i) => `<button type="button" class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}" data-wsdlg="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    m.hidden = false;
    m._buttons = buttons || [];
    const inp = m.querySelector('.ws-in');
    if (inp) { inp.focus(); inp.select(); } else { const p = m.querySelector('.btn.primary') || m.querySelector('.btn'); if (p) p.focus(); }
  });
}
function wsCloseModal() { if (wsModalDone) wsModalDone(null); }
async function wsPrompt(title, value) {
  let out = null;
  await wsAsk({
    title, input: value,
    buttons: [{ label: t('dlg.ok'), primary: true, run: (v) => { out = String(v || '').trim().slice(0, 60); } }, { label: t('dlg.cancel') }],
  });
  return out || null;
}

// ---------------------------------------------------------------- import / export
function wsExport() {
  const L = wsClone(WS.work);
  const file = { format: 'dideban-layout', v: WS_VER, exported: new Date().toISOString(), layout: L };
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dideban-layout-' + (L.name.replace(/[^\w؀-ۿ-]+/g, '_').slice(0, 40) || 'layout') + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function wsImportPick() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; if (f) wsImportFile(f); });
  inp.click();
}
// Imported files are data only: parsed as JSON, rebuilt through the validator (unknown fields
// dropped, values clamped), shown for confirmation, never executed.
function wsImportFile(f) {
  if (f.size > 256 * 1024) { toast(t('ws.imp.big')); return; }
  const r = new FileReader();
  r.onload = () => wsImportText(String(r.result || ''));
  r.onerror = () => toast(t('ws.imp.bad'));
  r.readAsText(f);
}
function wsImportText(txt) {
  let raw;
  try { raw = JSON.parse(txt); } catch (e) { toast(t('ws.imp.bad')); return null; }
  const src = raw && raw.format === 'dideban-layout' ? raw.layout : raw;
  const issues = [];
  let L;
  try { L = wsValidateLayout(src, issues); } catch (e) { toast(t('ws.imp.bad')); return null; }
  const known = L.panels.filter((P) => wsDef(P.pid));
  const list = known.map((P) => `<li>${dIcon(wsDef(P.pid).icon, 14)} ${esc(wsTitle(wsDef(P.pid)))}${wsDef(P.pid).entity ? ` <small>(${esc(t('ws.src.' + P.src))})</small>` : ''}</li>`).join('');
  const body = `<div class="ws-imp"><div><b>${esc(L.name)}</b> · ${esc(t('ws.imp.count', { n: known.length }))}</div><ul>${list}</ul>`
    + (L.panels.length > known.length ? `<div class="wl-note">${esc(t('ws.imp.unknown', { n: L.panels.length - known.length }))}</div>` : '')
    + (issues.length ? `<div class="wl-note">${issues.map(esc).join('<br>')}</div>` : '') + `</div>`;
  wsAsk({
    title: t('ws.import'), body,
    buttons: [
      { label: t('ws.imp.new'), primary: true, run: () => {
        L.id = wsUid('L');
        if (WS.store.layouts.some((l) => l.name === L.name)) L.name = t('ws.imp.name', { n: L.name });
        wsNewLayout(L);
      } },
      { label: t('ws.imp.replace'), run: () => wsMut((x) => {
        x.panels = L.panels; x.dock = L.dock; x.mob = L.mob; x.opt = L.opt; x.ctx = L.ctx;
      }) },
      { label: t('dlg.cancel') },
    ],
  });
  return L;
}

// ---------------------------------------------------------------- fullscreen
function wsFsTarget() { return $('#map-wrap'); }
async function wsFullscreen() {
  const target = wsFsTarget();
  const cur = document.fullscreenElement || document.webkitFullscreenElement;
  if (cur === target || WS.pfs) { wsExitFull(); return; }
  const req = target.requestFullscreen || target.webkitRequestFullscreen;
  if (req) {
    try {
      const p = req.call(target, { navigationUI: 'hide' });
      if (p && typeof p.then === 'function') await p;
      setTimeout(() => { if ((document.fullscreenElement || document.webkitFullscreenElement) !== target) wsPseudoFull(); }, 400);
      return;
    } catch (e) { /* refused (no gesture, iframe, iOS): fill the window instead */ }
  }
  wsPseudoFull();
}
function wsPseudoFull() {
  if ((document.fullscreenElement || document.webkitFullscreenElement) === wsFsTarget()) return;
  WS.pfs = true;
  appEl.classList.add('ws-pfs');
  toast(t('ws.fs_fallback'));
  wsUpdateChrome();
}
function wsExitFull() {
  if (WS.pfs) { WS.pfs = false; appEl.classList.remove('ws-pfs'); wsUpdateChrome(); return; }
  const ex = document.exitFullscreen || document.webkitExitFullscreen;
  if (ex) { try { const p = ex.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* already out */ } }
}

// ---------------------------------------------------------------- top bar menu
function wsMenuRender() {
  const m = $('#ws-menu');
  if (!m || WS.off) return;
  const it = (act, label, on, icon = '') => `<button type="button" class="wse-mi${on ? ' on' : ''}" data-wsm="${act}">${on != null ? `<span class="wse-ck">${on ? '✓' : ''}</span>` : ''}${icon}<span>${esc(label)}</span></button>`;
  const shown = WS.mobile ? WS.store.mobShow : WS.store.show !== false;
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement) || WS.pfs;
  m.innerHTML = `<div class="wse-mh">${esc(t('ws.title'))}</div>`
    + it('show', t(WS.mobile ? 'ws.show_mob' : 'ws.show'), shown)
    + `<div class="wse-sep"></div><div class="wse-mh2">${esc(t('ws.layouts'))}</div>`
    + WS.store.layouts.map((l) => it('open:' + l.id, (l.id === WS.store.def ? '★ ' : '') + (l.id === WS.work.id ? WS.work.name : l.name), l.id === WS.work.id)).join('')
    + `<div class="wse-sep"></div>`
    + it('edit', t('ws.customize'), null, WS_I.cust)
    + it('full', t(isFs ? 'ws.fs_exit' : 'ws.fs'), null, isFs ? WS_I.fullx : WS_I.full)
    + (appEl.classList.contains('ws-window') ? '' : it('window', t('ws.window'), null, WS_I.float));
}
function wsMenuToggle(anchor) {
  const m = $('#ws-menu');
  if (!m.hidden) { m.hidden = true; wsUpdateChrome(); return; }
  wsMenuRender();
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(280, window.innerWidth - 16);
  m.style.width = w + 'px';
  m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  wsUpdateChrome();
}
function wsMenuCmd(cmd) {
  const m = $('#ws-menu');
  m.hidden = true;
  if (cmd === 'show') {
    if (WS.mobile) WS.store.mobShow = !WS.store.mobShow; else WS.store.show = WS.store.show === false;
    wsPersist(); wsUpdateRoot(); wsUpdateChrome(); pushWatch(); return;
  }
  if (cmd.startsWith('open:')) {
    if (WS.mobile) WS.store.mobShow = true; else WS.store.show = true;
    wsSwitch(cmd.slice(5)); wsUpdateRoot(); return;
  }
  if (cmd === 'edit') { wsEdit(true); return; }
  if (cmd === 'full') { wsFullscreen(); return; }
  if (cmd === 'window') window.open(`${location.pathname}?ws=1`, 'dideban-workspace', 'width=1280,height=800');
}
// The detail page's tab → panel type, for its "customise" buttons.
const WS_TAB_PANEL = { overview: 'overview', weapons: 'weapons', inv: 'inventory', health: 'health', damage: 'damage', crew: 'crew', cargo: 'cargo' };
function wsCustomizeTab(tab) {
  if (WS.off) return;
  const pid = WS_TAB_PANEL[tab] || 'details';
  if (WS.mobile) WS.store.mobShow = true; else WS.store.show = true;
  wsEditSet(true);
  let P = null;
  wsMut((L) => { P = wsAddIn(L, pid, 'sel'); });
  if (P) { WS.sel = P.iid; WS.cust = P.iid; }
  wsUpdateChrome();
  wsRenderAll();
}

// ---------------------------------------------------------------- panels
// Each panel wraps an existing detail-page renderer; none of them keeps data of its own.
const wsFuelCls = (f) => (f > 0.3 ? '' : (f > 0.1 ? 'warn' : 'bad'));
const wsIsVeh = (d) => d.kind !== 'man' && d.kind !== 'static';
const WS_TABS = ['overview', 'weapons', 'inv', 'health', 'damage', 'crew', 'cargo'];
const wsTabLabel = (k) => t('d.tab.' + (k === 'inv' ? 'inventory' : k));

function wsDetailsPanel(d, P) {
  const tabs = detailTabsFor(d);
  let tab = P._tab || P.prefs.tab || 'overview';
  if (!tabs.find((x) => x.key === tab)) tab = 'overview';
  return `<div class="d-tabs ws-tabs">${tabs.map((tb) => `<button type="button" class="d-tab ${tb.key === tab ? 'active' : ''}" data-wstab="${tb.key}">${esc(tb.label)}</button>`).join('')}</div>`
    + `<div class="ws-tabbody">${detailBody(d, tab)}</div>`;
}
// The telemetry panel's sections (each is also a part of its own).
const wsTelKv = (k, v) => dKv(k, v);
const wsYes = (b) => esc(t(b ? 'ws.tel.yes' : 'ws.tel.no'));
function wsTelLink() {
  return `<div class="d-sec">${esc(t('ws.tel.link'))}</div><div class="d-kv">`
    + wsTelKv(t('ws.tel.server'), wsYes(S.sse)) + wsTelKv(t('ws.tel.game'), wsYes(S.status.connected))
    + wsTelKv(t('ws.tel.world'), esc(S.status.worldDesc || S.status.world || '—')) + wsTelKv(t('ws.tel.mission'), esc(S.status.mission || '—')) + `</div>`;
}
function wsTelRun() {
  const runs = S.run.log.filter((e) => e.ev === 'run').length;
  return `<div class="d-sec">${esc(t('ws.tel.run'))}</div><div class="d-kv">`
    + wsTelKv(t('ws.tel.session'), `<span dir="ltr">${esc(String(S.run.session || '—').slice(0, 18))}</span>`)
    + wsTelKv(t('ws.tel.since'), S.run.at ? `<span dir="ltr">${Math.round((performance.now() - S.run.at) / 1000)} s</span>` : '—')
    + wsTelKv(t('ws.tel.changes'), String(Math.max(0, runs - 1))) + wsTelKv(t('ws.tel.dropped'), String(S.run.dropped))
    + (S.run.pending ? wsTelKv(t('ws.tel.pending'), esc(S.run.pending.label || S.run.pending.id)) : '') + `</div>`;
}
function wsTelRates() {
  return `<div class="d-sec">${esc(t('ws.tel.rates'))}</div><div class="d-kv">`
    + wsTelKv(t('ws.tel.pos'), `<span dir="ltr">${rateOf(S.rate.pos).toFixed(1)} Hz</span>`)
    + wsTelKv(t('ws.tel.det'), `<span dir="ltr">${rateOf(S.rate.detail).toFixed(1)} Hz</span>`)
    + wsTelKv(t('ws.tel.watched'), String(detailWatchIds().length)) + `</div>`;
}
function wsTelEntity(d, id, P) {
  let h = `<div class="d-sec">${esc(t('ws.tel.entity'))}</div>`;
  if (!id) return h + `<div class="d-empty">${esc(t('ws.nosrc.' + ((P && P.src) || 'sel')))}</div>`;
  const fr = freshness(id);
  return h + `<div class="d-kv">` + wsTelKv('ID', `<span dir="ltr">${esc(id)}</span>`)
    + (d && d.found ? wsTelKv(t('ws.tel.class'), `<span dir="ltr">${esc(d.cls || '')}</span>`) + wsTelKv(t('ws.tel.kind'), esc(tOr('kind.' + d.kind, d.kind)))
      + wsTelKv(t('ws.tel.mtime'), `<span dir="ltr">${Number.isFinite(d.t) ? d.t.toFixed(1) + ' s' : '—'}</span>`) : '')
    + wsTelKv(t('ws.tel.fresh'), esc(fr.txt)) + `</div>`;
}
function wsTelEvents(P) {
  const n = (P && P.prefs && P.prefs.rows) || 5;
  const ev = S.run.log.slice(-n).reverse();
  return `<div class="d-sec">${esc(t('ws.tel.events'))}</div>`
    + (ev.length ? `<div class="ws-ev">${ev.map((e) => `<div><span dir="ltr">${esc(String(e.at).slice(11, 19))}</span> <b>${esc(e.ev)}</b> <small dir="ltr">${esc(Object.entries(e).filter(([k]) => k !== 'at' && k !== 'ev').map(([k, v]) => `${k}=${v}`).join(' ').slice(0, 80))}</small></div>`).join('')}</div>`
      : `<div class="d-empty">${esc(t('ws.tel.noev'))}</div>`);
}
// A panel that is made of parts still renders as one piece where something needs that.
function wsCompsRender(pid) {
  return (d, P, id) => (P && P.cl ? P.cl.items : wsDefaultCl(wsDef(pid)).items)
    .filter((it) => !it.hid && !it.out && wsCDef(it.cid))
    .map((it) => wsCDef(it.cid).render(d, { P, host: pid, item: it, id: id || (d && d.id) })).join('');
}

function wsRegisterBuiltins() {
  const C = WS_PREF.compact, N = WS_PREF.nums, A = WS_PREF.autohide;
  wsRegisterComps();
  // comps: the parts a panel starts with, [component, size]
  wsRegister({ id: 'overview', cat: 'overview', icon: 'veh', size: { w: 380, h: 560 }, min: { w: 260, h: 220 }, multi: true, prefs: [C, N], render: wsCompsRender('overview'),
    comps: [['hero', 'L'], ['speed', 'M'], ['alt', 'M'], ['attitude', 'M'], ['heading', 'M'], ['fuel', 'M'], ['hp', 'M'], ['turret', 'L'], ['grid', 'M']] });
  wsRegister({ id: 'status', cat: 'overview', icon: 'gauge', size: { w: 340, h: 340 }, min: { w: 230, h: 160 }, multi: true, prefs: [C], render: wsCompsRender('status'),
    comps: [['hero', 'L'], ['t-hp', 'M'], ['t-fuel', 'M'], ['t-speed', 'M'], ['t-alt', 'M'], ['t-crew', 'M'], ['grid', 'M']] });
  wsRegister({ id: 'fuel', cat: 'overview', icon: 'fuel', size: { w: 240, h: 250 }, min: { w: 170, h: 170 }, multi: true, prefs: [A],
    applies: (d) => d.fuel >= 0,
    render: (d) => gCard(ringGauge('fuel', d.fuel, wsFuelCls(d.fuel), ['E', 'F'], t('d.fuel')), t('d.fuel_qty')) });
  wsRegister({ id: 'health', cat: 'health', icon: 'heart', size: { w: 360, h: 540 }, min: { w: 240, h: 220 }, multi: true, prefs: [C, A], applies: (d) => d.kind === 'man', render: wsCompsRender('health'),
    comps: [['body-fig', 'L'], ['wounds', 'L'], ['ace', 'L']] });
  wsRegister({ id: 'damage', cat: 'health', icon: 'engine', size: { w: 380, h: 600 }, min: { w: 260, h: 240 }, multi: true, prefs: [C, A], applies: wsIsVeh, render: wsCompsRender('damage'),
    comps: [['dmg-fig', 'L'], ['hp', 'M'], ['fuel', 'M'], ['dmg-legend', 'L'], ['dmg-struct', 'L'], ['dmg-sys', 'L']] });
  wsRegister({ id: 'crew', cat: 'crew', icon: 'personnel', size: { w: 380, h: 560 }, min: { w: 260, h: 220 }, multi: true, prefs: [C, A], applies: wsIsVeh, render: wsCompsRender('crew'),
    comps: [['crew-map', 'L'], ['crew-stations', 'L'], ['crew-list', 'L']] });
  wsRegister({ id: 'weapons', cat: 'weapons', icon: 'rifle', size: { w: 390, h: 580 }, min: { w: 260, h: 200 }, multi: true, prefs: [C], render: wsCompsRender('weapons'),
    comps: [['loadout', 'L'], ['turret', 'L'], ['guns', 'L'], ['utility', 'L'], ['man-weapons', 'L']] });
  wsRegister({ id: 'loadout', cat: 'weapons', icon: 'bomb', size: { w: 380, h: 470 }, min: { w: 260, h: 220 }, multi: true, prefs: [A],
    applies: (d) => isAir(d.kind),
    render: (d) => loadoutBoard(d) || `<div class="d-empty">${esc(t('ws.no_stores'))}</div>` });
  wsRegister({ id: 'inventory', cat: 'inventory', icon: 'backpack', size: { w: 400, h: 600 }, min: { w: 260, h: 220 }, multi: true, prefs: [C, A], applies: (d) => d.kind === 'man', render: wsCompsRender('inventory'),
    comps: [['inv-load', 'L'], ['inv-weapons', 'L'], ['inv-mags', 'L'], ['inv-throw', 'L'], ['inv-expl', 'L'], ['inv-medical', 'L'], ['inv-equip', 'L'], ['inv-attach', 'L'], ['inv-tools', 'L'], ['inv-worn', 'L']] });
  wsRegister({ id: 'cargo', cat: 'inventory', icon: 'crate', size: { w: 380, h: 480 }, min: { w: 240, h: 180 }, multi: true, prefs: [C, A], applies: wsIsVeh, render: (d) => renderInv(d) });
  wsRegister({ id: 'instruments', cat: 'nav', icon: 'gauge', size: { w: 400, h: 520 }, min: { w: 240, h: 200 }, multi: true, prefs: [N, C], render: wsCompsRender('instruments'),
    comps: [['speed', 'M'], ['alt', 'M'], ['attitude', 'M'], ['heading', 'M'], ['fuel', 'M'], ['hp', 'M']] });
  wsRegister({ id: 'attitude', cat: 'nav', icon: 'plane', size: { w: 280, h: 320 }, min: { w: 190, h: 220 }, multi: true, prefs: [N, A],
    applies: (d) => isAir(d.kind),
    render: (d) => { const L = liveOf(d); return gCard(attitudeGauge(d.id + ':att', L.att), t('d.attitude'), attRead(L.att)); } });
  wsRegister({ id: 'heading', cat: 'nav', icon: 'gps', size: { w: 270, h: 330 }, min: { w: 190, h: 220 }, multi: true, prefs: [N],
    render: (d) => gCard(compassGauge(d.id + ':cmp', liveOf(d).dir), t('d.heading'), `<span class="ws-grid" dir="ltr">${gridRef(d.x, d.y)}</span>`) });
  wsRegister({ id: 'turret', cat: 'nav', icon: 'turret', size: { w: 380, h: 330 }, min: { w: 260, h: 200 }, multi: true, prefs: [N, A],
    applies: (d) => wsIsVeh(d) && turretInfo(d).state !== 'none',
    render: (d) => turretCard(d, liveOf(d)) });
  wsRegister({ id: 'details', cat: 'telemetry', icon: 'misc', size: { w: 400, h: 620 }, min: { w: 260, h: 240 }, multi: true,
    prefs: [{ key: 'tab', type: 'select', opts: WS_TABS, def: 'overview', label: 'ws.pref.tab', fmt: wsTabLabel }, C],
    render: wsDetailsPanel });
  wsRegister({ id: 'telemetry', cat: 'telemetry', icon: 'link', size: { w: 340, h: 520 }, min: { w: 230, h: 180 }, multi: true, loose: true,
    prefs: [{ key: 'rows', type: 'select', opts: [5, 10, 20], def: 5, label: 'ws.pref.rows', fmt: String }],
    render: wsCompsRender('telemetry'), comps: [['tel-link', 'L'], ['tel-run', 'L'], ['tel-rates', 'L'], ['tel-entity', 'L'], ['tel-events', 'L']] });
  wsCompHomes();
}

// ---------------------------------------------------------------- start
function wsTick() {
  if (!WS.ready || WS.off || !WS.work || WS.root.hidden) return;
  WS.tickN = (WS.tickN || 0) + 1;
  for (const P of WS.work.panels) {
    const el = WS.els.get(P.iid);
    if (!el) continue;
    const def = wsDef(P.pid);
    wsFreshOne(el, WS.ids.get(P.iid), def);
    // parts that show clocks and rates (diagnostics) are redrawn once a second
    if (WS.tickN % 4 === 0 && def && (def.widget ? wsCDef(def.cid).tick : P.cl && P.cl.items.some((it) => !it.hid && !it.out && wsCDef(it.cid) && wsCDef(it.cid).tick))) wsRenderPanel(P);
  }
}
function wsInit() {
  WS.off = !!(DETAIL_ID || POPUP_CAM);
  const btn = $('#btn-ws');
  if (WS.off) { if (btn) btn.hidden = true; return; }
  if (new URLSearchParams(location.search).has('ws')) appEl.classList.add('ws-window', 'panel-closed');
  wsRegisterBuiltins();
  const root = document.createElement('div');
  root.id = 'ws'; root.className = 'ws'; root.hidden = true;
  root.innerHTML = '<div class="wse-bar" hidden></div>'
    + '<div class="ws-main"><div class="ws-area"><div class="ws-splits"></div>'
    + '<div class="ws-guide ws-guide-v" hidden></div><div class="ws-guide ws-guide-h" hidden></div>'
    + '<div class="ws-preview" hidden><span></span></div><div class="wsc-ins" hidden></div></div>'
    + '<div class="ws-tray" hidden></div><div class="ws-dirty" hidden></div><aside class="wse-lib" hidden></aside></div>'
    + '<div class="wse-menu" hidden></div>'
    + `<button type="button" class="ws-fab icon-btn" hidden data-wsfab title="${esc(t('ws.title'))}" aria-label="${esc(t('ws.title'))}">${WS_I.grid}</button>`
    + '<div class="ws-modal" hidden></div>';
  $('#map-wrap').appendChild(root);
  WS.root = root;
  WS.area = root.querySelector('.ws-area');
  const { st, issues } = wsReadStore();
  WS.store = st;
  if (typeof st.show !== 'boolean') st.show = true;
  WS.notice = issues;
  // unsaved edits from before a refresh come back as unsaved edits
  let startId = st.def, draft = null;
  const dr = storeGet('wsDraft', null);
  if (dr && typeof dr === 'object' && dr.L) {
    try {
      const L = wsValidateLayout(dr.L, []);
      if (st.layouts.some((l) => l.id === L.id)) { draft = L; startId = L.id; }
    } catch (e) { wsDraftClear(); }
  }
  WS.ready = true;
  wsMeasure();
  wsOpen(startId, draft);
  if (draft && wsDirty()) toast(t('ws.draft_back', { n: draft.name }));
  if (issues.length) toast(t('ws.issue.toast'));

  WS.area.addEventListener('pointerdown', wsOnPointerDown);
  root.addEventListener('dblclick', wsOnDblClick);
  root.addEventListener('click', (e) => {
    const m = root.querySelector('.wse-menu');
    const dl = e.target.closest('[data-wsdlg]');
    if (dl) {
      const mm = root.querySelector('.ws-modal');
      const b = (mm._buttons || [])[Number(dl.dataset.wsdlg)] || {};
      const inp = mm.querySelector('.ws-in');
      const val = inp ? inp.value : null;
      if (wsModalDone) wsModalDone(Number(dl.dataset.wsdlg));
      if (b.run) b.run(val);
      return;
    }
    if (e.target.classList.contains('ws-modal')) { wsCloseModal(); return; }
    if (e.target.closest('[data-wsfab]')) { wsMenuToggle(e.target.closest('[data-wsfab]')); return; }
    const w = e.target.closest('[data-wse]');
    if (w) { wsEditorCmd(w.dataset.wse, w); return; }
    if (!e.target.closest('.wse-menu')) m.hidden = true;
    const lb = e.target.closest('[data-wlib]');
    if (lb) { wsLibCmd(lb.dataset.wlib, lb); return; }
    const wc = e.target.closest('[data-wcomp]');
    if (wc) { wsCompCmd(wc.dataset.wcomp); return; }
    const lt = e.target.closest('[data-wlib-tab]');
    if (lt) { WS.libTab = lt.dataset.wlibTab; WS.libQ = ''; wsLibRender(); return; }
    const cc = e.target.closest('[data-wlib-ccat]');
    if (cc) { WS.libCCat = cc.dataset.wlibCcat; wsLibRender(); return; }
    const cat = e.target.closest('[data-wlib-cat]');
    if (cat) { WS.libCat = cat.dataset.wlibCat; wsLibRender(); return; }
    const tab = e.target.closest('[data-wstab]');
    if (tab) {
      const P = wsP(tab.closest('.wsp').dataset.iid);
      if (P) { P._tab = tab.dataset.wstab; wsRenderPanel(P); }
      return;
    }
    wsOnClick(e);
  });
  root.addEventListener('change', (e) => {
    const pick = e.target.closest('[data-wse-pick]');
    if (pick) { const id = pick.value; pick.value = WS.work.id; wsSwitch(id); return; }
    const opt = e.target.closest('[data-wse-opt]');
    if (opt) {
      const k = opt.dataset.wseOpt, v = Number(opt.value);
      wsMut((L) => { if (k === 'grid' && WS_GRIDS.includes(v)) L.opt.grid = v; if (k === 'gap' && WS_GAPS.includes(v)) L.opt.gap = v; });
      const m = root.querySelector('.wse-menu'); if (!m.hidden) m.innerHTML = wsMenuHtml(m.dataset.which);
      return;
    }
    const pr = e.target.closest('[data-wpref]');
    if (pr) { wsPrefChange(pr); return; }
    const sz = e.target.closest('[data-wcsz]');
    if (sz) { const [iid, cid] = sz.dataset.wcsz.split(':'); const P = wsP(iid); if (P) wsCAct(P, cid, 'sz:' + sz.value); return; }
    const cm = e.target.closest('[data-wccmp]');
    if (cm) { const [iid, cid] = cm.dataset.wccmp.split(':'); const P = wsP(iid); const it = wsItem(P, cid); if (it && !!it.cmp !== cm.checked) wsCAct(P, cid, 'cmp'); }
  });
  // right-click a part in the editor: that part, selected, with its settings in the side sheet
  root.addEventListener('contextmenu', (e) => {
    if (!WS.edit) return;
    const ce = e.target.closest('.wsc');
    const pe = ce && ce.closest('.wsp');
    if (!pe) return;
    e.preventDefault();
    if (WS.cedit !== pe.dataset.iid) wsCEdit(pe.dataset.iid);
    WS.libOpen = true;
    wsCSelect(ce.dataset.cid);
    wsUpdateChrome();
  });
  root.addEventListener('input', (e) => {
    if (e.target.matches('[data-wlib-q]')) { WS.libQ = e.target.value; wsLibRender(); }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.ws-in')) { const b = root.querySelector('.ws-modal .btn.primary'); if (b) { e.preventDefault(); b.click(); } }
  });
  document.addEventListener('keydown', (e) => { if (!WS.root.hidden) wsOnKey(e); });
  const fsChange = () => { wsUpdateChrome(); if (!$('#ws-menu').hidden) wsMenuRender(); };
  document.addEventListener('fullscreenchange', fsChange);
  document.addEventListener('webkitfullscreenchange', fsChange);
  if (btn) btn.addEventListener('click', () => wsMenuToggle(btn));
  $('#ws-menu').addEventListener('click', (e) => { const b = e.target.closest('[data-wsm]'); if (b) wsMenuCmd(b.dataset.wsm); });
  // Esc closes the top-bar menu (keyboard and screen-reader users have no "click outside")
  document.addEventListener('keydown', (e) => {
    const m = $('#ws-menu');
    if (e.key !== 'Escape' || m.hidden) return;
    m.hidden = true; wsUpdateChrome(); e.stopPropagation();
    if (btn) btn.focus();
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const m = $('#ws-menu');
    if (!m.hidden && !m.contains(e.target) && !e.target.closest('#btn-ws, [data-wsfab]')) { m.hidden = true; wsUpdateChrome(); }
    const em = root.querySelector('.wse-menu');
    if (!em.hidden && !em.contains(e.target) && !e.target.closest('[data-wse^="m-"]')) em.hidden = true;
  }, true);
  let raf = 0;
  const relayout = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; wsLayout(); }); };
  const ro = new ResizeObserver(relayout);
  ro.observe(WS.area);
  ro.observe($('#map-wrap'));
  setInterval(wsTick, 250);
}

// ---------------------------------------------------------------- components (parts of a panel)
// A component is one self-contained part of a panel: a gauge, a diagram, a list section. Each
// has a stable id and its own render function built from the detail page's renderers, and draws
// from the entity its host shows (the panel's data source); it never collects data of its own,
// so the same fuel gauge drawn in three places is three views of one S.details entry.
//
//   registry   WS_COMP (wsComp): id, category, icon, default size, which entities it applies to,
//              render(d, ctx). A panel lists its default components (def.comps).
//   in a panel P.cl = { mode: 'flow' | 'free', items: [{ cid, sz, hid, out, cmp, f, z }] }
//              flow: a 6-column grid in list order, sizes S/M/W/L (2/3/4/6 columns), reflowing
//              with the panel's width; free: positions and sizes as fractions of the panel's
//              width (so a wider panel scales the arrangement instead of breaking it).
//              hid = hidden; out = detached (it lives in a widget); cmp = compact display.
//   detached   a widget: an ordinary workspace instance of type 'w-<cid>' with from = { iid, cid }
//              pointing back at the panel it came from, so it can be returned there.
const WS_CCATS = ['nav', 'vstatus', 'damage', 'weapons', 'crew', 'inventory', 'diag'];
const WS_CCAT_PCAT = { nav: 'nav', vstatus: 'overview', damage: 'health', weapons: 'weapons', crew: 'crew', inventory: 'inventory', diag: 'telemetry' };
const WS_CSIZES = { S: 2, M: 3, W: 4, L: 6 };
const WS_CID_RE = /^[a-z0-9-]{1,32}$/;
const WS_COMP = new Map();
const WS_COMP_ALIAS = {}; // renamed components: old id -> new id (for layouts saved before)
const WS_WREG = new Map(); // widget panel definitions, made on demand from the components
function wsComp(def) {
  if (!def || !WS_CID_RE.test(def.id || '') || typeof def.render !== 'function') throw new Error('wsComp: bad component definition');
  const c = Object.assign({
    cat: 'vstatus', icon: 'misc', title: 'ws.c.' + def.id, size: 'M', entity: true, loose: false,
    wsize: { w: 260, h: 280 }, min: { w: 160, h: 120 }, applies: () => true, tick: false, home: null,
  }, def);
  WS_COMP.set(c.id, c);
  WS_WREG.delete('w-' + c.id);
  return c;
}
const wsCDef = (cid) => WS_COMP.get(WS_COMP_ALIAS[cid] || cid) || null;
const wsCTitle = (c) => tOr(c.title, c.id);
// The widget panel type for a component ('w-fuel' …): a small window holding just that part.
function wsWidgetDef(pid) {
  if (typeof pid !== 'string' || !pid.startsWith('w-')) return null;
  if (WS_WREG.has(pid)) return WS_WREG.get(pid);
  const c = wsCDef(pid.slice(2));
  if (!c) return null;
  const def = {
    id: pid, cid: c.id, widget: true, cat: WS_CCAT_PCAT[c.cat] || 'overview', icon: c.icon, title: c.title,
    size: c.wsize, min: c.min, max: null, multi: true, entity: c.entity, loose: c.loose,
    prefs: [WS_PREF.compact], applies: (d) => c.applies(d), tab: null,
    render: (d, P, id) => {
      const html = c.render(d, { P, host: 'widget', id: id || (d && d.id) || null, item: null });
      return html || wsCNA(c, d);
    },
  };
  WS_WREG.set(pid, def);
  return def;
}
function wsDefaultCl(def) {
  return { mode: 'flow', items: (def.comps || []).map(([cid, sz]) => ({ cid, sz: WS_CSIZES[sz] ? sz : 'M' })) };
}
// Rebuilds a panel's component layout from stored data: unknown fields dropped, sizes and
// positions clamped, duplicates removed. Unknown component ids are kept (a newer version may
// know them) but not drawn.
function wsValidateCl(def, raw, issues) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return wsDefaultCl(def);
  const out = { mode: raw.mode === 'free' ? 'free' : 'flow', items: [] };
  const seen = new Set();
  for (const r of raw.items.slice(0, 48)) {
    if (!r || typeof r.cid !== 'string' || !WS_CID_RE.test(r.cid)) { issues.push(t('ws.issue.comp')); continue; }
    const cid = WS_COMP_ALIAS[r.cid] || r.cid;
    if (seen.has(cid)) continue;
    seen.add(cid);
    const it = { cid, sz: WS_CSIZES[r.sz] ? r.sz : 'M' };
    if (r.hid === true) it.hid = true;
    if (r.out === true) it.out = true;
    if (r.cmp === true) it.cmp = true;
    if (r.f && typeof r.f === 'object') {
      const w = wsNum(r.f.w, 0.12, 1, 0.5), h = wsNum(r.f.h, 0.06, 4, 0.5);
      it.f = { x: wsNum(r.f.x, 0, 1 - w, 0), y: wsNum(r.f.y, 0, 8, 0), w, h };
    }
    if (Number.isFinite(r.z)) it.z = Math.round(wsNum(r.z, 0, 999, 0));
    out.items.push(it);
  }
  return out;
}
// Components whose detached widget no longer exists come back into their panel (hidden), so a
// part is never lost between a panel and a widget that was deleted.
function wsFixDetached(L) {
  const widgets = new Set(L.panels.filter((P) => P.from).map((P) => P.from.iid + '|' + P.from.cid));
  for (const P of L.panels) {
    if (!P.cl) continue;
    for (const it of P.cl.items) if (it.out && !widgets.has(P.iid + '|' + it.cid)) { it.out = false; it.hid = true; }
  }
}
const wsCVisible = (P, cid) => !!(P && P.cl && P.cl.items.some((it) => it.cid === cid && !it.hid && !it.out));
function wsCNA(c, d) {
  const k = d ? tOr('kind.' + d.kind, d.kind) : '';
  return `<div class="wsc-na">${dIcon(c.icon, 18)}<span>${esc(d ? t('ws.c.na', { k }) : t('ws.c.nodata'))}</span></div>`;
}

// ---------------------------------------------------------------- the components
function wsRegisterComps() {
  const L = (d) => liveOf(d);
  const tile = (html) => `<div class="d-tiles">${html}</div>`;
  const isMan = (d) => d.kind === 'man';
  const air = (d) => isAir(d.kind);
  // navigation
  wsComp({ id: 'heading', cat: 'nav', icon: 'gps', render: (d) => gCard(compassGauge(d.id + ':cmp', L(d).dir), t('d.heading')) });
  wsComp({ id: 'attitude', cat: 'nav', icon: 'plane', applies: air, render: (d) => (air(d) ? gCard(attitudeGauge(d.id + ':att', L(d).att), t('d.attitude'), attRead(L(d).att)) : '') });
  wsComp({ id: 'grid', cat: 'nav', icon: 'grid', wsize: { w: 240, h: 130 }, min: { w: 150, h: 90 },
    // the overview's turret card already carries the grid; the tile is for everything else
    render: (d, c) => (c.host === 'overview' && wsCVisible(c.P, 'turret') && turretCard(d, L(d)) ? ''
      : tile(stat('grid', t('d.pos'), `<span dir="ltr">${gridRef(d.x, d.y)}</span>`))) });
  // vehicle status
  wsComp({ id: 'hero', cat: 'vstatus', icon: 'veh', size: 'L', wsize: { w: 340, h: 150 }, min: { w: 200, h: 100 }, render: (d) => detailHero(d) });
  wsComp({ id: 'speed', cat: 'vstatus', icon: 'gauge', applies: wsIsVeh, render: (d) => (wsIsVeh(d) ? gCard(speedGauge(d.id + ':spd', d.kind, L(d).speed), t('d.speed')) : '') });
  wsComp({ id: 'alt', cat: 'vstatus', icon: 'alt', applies: air, render: (d) => (air(d) ? gCard(altGauge(d.id + ':alt', L(d).alt), t('d.alt')) : '') });
  wsComp({ id: 'fuel', cat: 'vstatus', icon: 'fuel', applies: (d) => d.fuel >= 0,
    render: (d, c) => (d.fuel >= 0 ? gCard(ringGauge('fuel', d.fuel, wsFuelCls(d.fuel), ['E', 'F'], t('d.fuel')), t(c.host === 'damage' || c.host === 'widget' ? 'd.fuel_qty' : 'd.fuel'), '', c.host === 'widget' ? '' : 'g-mini') : '') });
  wsComp({ id: 'hp', cat: 'vstatus', icon: 'heart',
    render: (d, c) => gCard(ringGauge('heart', d.hp, hpClass(d.hp), null, t('d.health')), t(c.host === 'damage' ? 'd.integrity' : 'd.health'), '', c.host === 'widget' ? '' : 'g-mini') });
  const small = { wsize: { w: 240, h: 130 }, min: { w: 150, h: 90 } };
  wsComp(Object.assign({ id: 't-hp', cat: 'vstatus', icon: 'heart', render: (d) => tile(stat('heart', t('d.health'), `${Math.round(d.hp * 100)}%`, hpClass(d.hp), d.hp)) }, small));
  wsComp(Object.assign({ id: 't-fuel', cat: 'vstatus', icon: 'fuel', applies: (d) => d.fuel >= 0, render: (d) => (d.fuel >= 0 ? tile(stat('fuel', t('d.fuel'), `${Math.round(d.fuel * 100)}%`, wsFuelCls(d.fuel), d.fuel)) : '') }, small));
  wsComp(Object.assign({ id: 't-speed', cat: 'vstatus', icon: 'gauge', applies: wsIsVeh,
    render: (d) => (wsIsVeh(d) ? tile(stat('gauge', t('d.speed'), `<span dir="ltr" data-wslive="spd">${Math.round(Math.max(0, L(d).speed || 0))} km/h</span>`)) : '') }, small));
  wsComp(Object.assign({ id: 't-alt', cat: 'vstatus', icon: 'alt', applies: air,
    render: (d) => (air(d) ? tile(stat('alt', t('d.alt'), `<span dir="ltr" data-wslive="alt">${Number.isFinite(L(d).alt) ? Math.round(L(d).alt) + ' m' : '—'}</span>`)) : '') }, small));
  wsComp(Object.assign({ id: 't-crew', cat: 'crew', icon: 'personnel', applies: wsIsVeh,
    render: (d) => {
      if (!wsIsVeh(d)) return '';
      const sl = seatList(d), occ = sl.seats.filter((s) => s.occupied).length;
      return tile(stat('personnel', t('ws.crew_n'), sl.full ? `${occ}/${sl.seats.length}` : String(occ)));
    } }, small));
  // damage
  const veh = wsIsVeh;
  const big = { size: 'L', wsize: { w: 360, h: 420 }, min: { w: 200, h: 140 } };
  wsComp(Object.assign({ id: 'dmg-fig', cat: 'damage', icon: 'engine', applies: veh, render: (d) => (veh(d) ? `<div class="body-fig">${vehDamageParts(d).fig}</div>` : '') }, big));
  wsComp(Object.assign({ id: 'dmg-legend', cat: 'damage', icon: 'misc', applies: veh, render: (d) => (veh(d) ? damageLegend() : '') }, big, { wsize: { w: 340, h: 120 } }));
  wsComp(Object.assign({ id: 'dmg-struct', cat: 'damage', icon: 'engine', applies: veh, render: (d) => (veh(d) ? vehDamageParts(d).struct : '') }, big));
  wsComp(Object.assign({ id: 'dmg-sys', cat: 'damage', icon: 'engine', applies: veh, render: (d) => { if (!veh(d)) return ''; const p = vehDamageParts(d); return p.sys + p.note; } }, big));
  wsComp(Object.assign({ id: 'body-fig', cat: 'damage', icon: 'heart', applies: isMan, render: (d) => (isMan(d) ? healthParts(d).fig : '') }, big));
  wsComp(Object.assign({ id: 'wounds', cat: 'damage', icon: 'medical', applies: isMan, render: (d) => (isMan(d) ? healthParts(d).wounds : '') }, big));
  wsComp(Object.assign({ id: 'ace', cat: 'damage', icon: 'medical', applies: (d) => isMan(d) && !!d.ace, render: (d) => (isMan(d) ? healthParts(d).ace : '') }, big));
  // weapons
  wsComp(Object.assign({ id: 'turret', cat: 'weapons', icon: 'turret', applies: (d) => veh(d) && turretInfo(d).state !== 'none', render: (d) => (veh(d) ? turretCard(d, L(d)) : '') }, big, { wsize: { w: 380, h: 330 } }));
  wsComp(Object.assign({ id: 'loadout', cat: 'weapons', icon: 'bomb', applies: air, render: (d) => (air(d) ? loadoutBoard(d) : '') }, big));
  wsComp(Object.assign({ id: 'guns', cat: 'weapons', icon: 'rifle', applies: veh, render: (d) => (veh(d) ? vehWeaponParts(d).guns : '') }, big));
  wsComp(Object.assign({ id: 'utility', cat: 'weapons', icon: 'flare', applies: veh, render: (d) => (veh(d) ? vehWeaponParts(d).util : '') }, big));
  wsComp(Object.assign({ id: 'man-weapons', cat: 'weapons', icon: 'rifle', applies: isMan, render: (d) => (isMan(d) ? renderManWeapons(d) : '') }, big));
  // crew
  wsComp(Object.assign({ id: 'crew-map', cat: 'crew', icon: 'personnel', applies: veh, render: (d) => (veh(d) ? crewParts(d).map : '') }, big));
  wsComp(Object.assign({ id: 'crew-stations', cat: 'crew', icon: 'turret', applies: veh, render: (d) => (veh(d) ? crewParts(d).stations : '') }, big));
  wsComp(Object.assign({ id: 'crew-list', cat: 'crew', icon: 'personnel', applies: veh, render: (d) => (veh(d) ? crewParts(d).list : '') }, big));
  // inventory: a soldier's kit by section; a vehicle's cargo as one part
  const INV = [['inv-load', 'load', 'backpack'], ['inv-weapons', 'weapons', 'rifle'], ['inv-mags', 'magazines', 'ammobox'], ['inv-throw', 'throwables', 'grenade'],
    ['inv-expl', 'explosives', 'bomb'], ['inv-medical', 'medical', 'medical'], ['inv-equip', 'equipment', 'tool'], ['inv-attach', 'attach', 'misc'], ['inv-tools', 'tools', 'tool'], ['inv-worn', 'worn', 'backpack']];
  for (const [id, key, icon] of INV) {
    wsComp(Object.assign({ id, cat: 'inventory', icon, applies: isMan,
      render: (d) => {
        if (!isMan(d)) return '';
        const p = manInvParts(d);
        return (p[key] || '') + (key === 'weapons' ? p.note : '');
      } }, big));
  }
  wsComp(Object.assign({ id: 'cargo', cat: 'inventory', icon: 'crate', applies: veh, render: (d) => (veh(d) ? renderCargo(d) : '') }, big));
  // diagnostics (the telemetry panel's sections, plus the entity's data freshness)
  const diag = { cat: 'diag', size: 'L', wsize: { w: 320, h: 220 }, min: { w: 200, h: 100 }, tick: true };
  wsComp(Object.assign({ id: 'tel-link', icon: 'link', entity: false, render: () => wsTelLink() }, diag));
  wsComp(Object.assign({ id: 'tel-run', icon: 'misc', entity: false, render: () => wsTelRun() }, diag));
  wsComp(Object.assign({ id: 'tel-rates', icon: 'gauge', entity: false, render: () => wsTelRates() }, diag));
  wsComp(Object.assign({ id: 'tel-events', icon: 'misc', entity: false, render: (d, c) => wsTelEvents(c.P) }, diag));
  wsComp(Object.assign({ id: 'tel-entity', icon: 'misc', loose: true, render: (d, c) => wsTelEntity(d, c.id, c.P) }, diag));
  wsComp(Object.assign({ id: 'fresh', icon: 'link', loose: true, wsize: { w: 240, h: 120 }, size: 'M',
    render: (d, c) => {
      if (!c.id) return `<div class="d-empty">${esc(t('ws.nosrc.' + (c.P && c.P.src || 'sel')))}</div>`;
      const f = freshness(c.id);
      return `<div class="wsc-fresh"><span class="fresh fresh-${f.cls}" title="${esc(freshTitle())}"><i></i>${esc(f.txt)}</span><small>${esc(t('ws.c.fresh_d'))}</small></div>`;
    } }, { cat: 'diag', min: { w: 160, h: 90 }, tick: true }));
}
// Which panel a component belongs to by default (the first one listing it): shown in the
// library, and where a detached part returns to when its own panel is gone.
function wsCompHomes() {
  for (const def of WS_REG.values()) for (const [cid] of def.comps || []) { const c = wsCDef(cid); if (c && !c.home) c.home = def.id; }
}

// ---------------------------------------------------------------- layout edits
const wsItem = (P, cid) => (P && P.cl ? P.cl.items.find((it) => it.cid === cid) : null) || null;
function wsCNewItem(cid) { const c = wsCDef(cid); return { cid, sz: c ? c.size : 'M' }; }
// A free position for a part placed into a free-mode panel: below everything else.
function wsCFreeSlot(P, cid, at) {
  const c = wsCDef(cid);
  const w = (WS_CSIZES[(c && c.size) || 'M'] || 3) / 6;
  const bottom = P.cl.items.filter((it) => it.f && !it.hid && !it.out).reduce((a, it) => Math.max(a, it.f.y + it.f.h), 0);
  const h = w >= 1 ? 0.7 : w * 1.1;
  if (at) return { x: Math.max(0, Math.min(1 - w, at.x)), y: Math.max(0, at.y), w, h };
  return { x: 0, y: bottom ? bottom + 0.03 : 0, w, h };
}
function wsCTopZ(P) { return P.cl.items.reduce((a, it) => Math.max(a, it.z || 0), 0); }
// Detach a part from its panel into a widget at rect (workspace px). Returns the widget.
function wsDetachIn(L, iid, cid, rect) {
  const P = L.panels.find((x) => x.iid === iid);
  const it = wsItem(P, cid);
  const c = wsCDef(cid);
  if (!P || !it || !c) return null;
  it.out = true;
  const W = wsNewInst('w-' + cid, P.src || 'sel');
  W.from = { iid, cid };
  W.prefs.compact = it.cmp === true;
  const def = wsWidgetDef(W.pid);
  const r = Object.assign({}, rect);
  r.w = Math.max(def.min.w, Math.min(WS.W, r.w)); r.h = Math.max(def.min.h, Math.min(WS.H, r.h));
  r.x = Math.max(0, Math.min(WS.W - r.w, r.x)); r.y = Math.max(0, Math.min(WS.H - r.h, r.y));
  W.g = wsToFrac(r);
  W.z = wsTopZ(L) + 1;
  L.panels.push(W);
  return W;
}
function wsDropPanelIn(L, P) {
  if (wsFindDock(L, P.iid)) wsUndockIn(L, P);
  L.panels = L.panels.filter((x) => x !== P);
  L.mob.order = L.mob.order.filter((i) => i !== P.iid);
  delete L.mob.h[P.iid];
}
// Put a widget's part into a panel (its own panel = "return"; another = a move). index: position
// among the panel's items (null = the end); at: free-mode position (fractions). False when the
// panel already shows that part.
function wsAttachIn(L, W, P2, index, at) {
  const cid = W.pid.slice(2);
  if (!P2 || !P2.cl) return false;
  let it = wsItem(P2, cid);
  if (it && !it.hid && !it.out) return false;
  if (!it) { it = wsCNewItem(cid); P2.cl.items.push(it); }
  delete it.hid; delete it.out;
  it.cmp = W.prefs.compact === true || undefined;
  if (it.cmp === undefined) delete it.cmp;
  wsCPlace(P2, it, index, at);
  // the panel it came from no longer holds it (it moved), unless that is where it went
  if (W.from && W.from.iid !== P2.iid) {
    const P0 = L.panels.find((x) => x.iid === W.from.iid);
    if (P0 && P0.cl) P0.cl.items = P0.cl.items.filter((x) => !(x.cid === cid && x.out));
  }
  wsDropPanelIn(L, W);
  return true;
}
// Order an item within its panel (flow) or set its position (free).
function wsCPlace(P, it, index, at) {
  const items = P.cl.items;
  if (index != null) {
    items.splice(items.indexOf(it), 1);
    items.splice(Math.max(0, Math.min(items.length, index)), 0, it);
  }
  if (P.cl.mode === 'free' && (at || !it.f)) { it.f = wsCFreeSlot(P, it.cid, at); it.z = wsCTopZ(P) + 1; }
}
// Return a widget to the panel it was detached from; when that panel is gone (or never existed),
// to a panel of the component's default type showing the same data.
function wsReturnIn(L, W) {
  const cid = W.pid.slice(2);
  let P = W.from && L.panels.find((x) => x.iid === W.from.iid);
  if (P && P.st === 'hidden') wsShowIn(L, P);
  if (!P) {
    const c = wsCDef(cid);
    const home = c && c.home;
    if (!home) return false;
    P = wsAddIn(L, home, W.src || 'sel');
    if (!P) return false;
    if (!P.cl) P.cl = wsDefaultCl(wsDef(P.pid));
  }
  const it = wsItem(P, cid);
  const idx = it ? P.cl.items.indexOf(it) : null;
  return wsAttachIn(L, W, P, idx);
}
// Measure a panel's flow arrangement into free positions (what you see is what you get).
function wsCToFree(P) {
  const el = WS.els.get(P.iid);
  const host = el && el.querySelector('.wsc-host');
  const hw = host ? host.clientWidth : 0;
  const hr = host ? host.getBoundingClientRect() : null;
  P.cl.mode = 'free';
  let z = 1;
  for (const it of P.cl.items) {
    const ce = el && el._cels && el._cels.get(it.cid);
    if (ce && hw > 0 && !it.hid && !it.out) {
      const r = ce.getBoundingClientRect();
      it.f = { x: (r.left - hr.left) / hw, y: (r.top - hr.top) / hw, w: r.width / hw, h: Math.max(0.06, r.height / hw) };
      it.f.x = Math.max(0, Math.min(1 - it.f.w, it.f.x));
      it.z = z++;
    } else if (!it.f) it.f = wsCFreeSlot(P, it.cid);
  }
}
function wsCToFlow(P) {
  P.cl.mode = 'flow';
  const vis = P.cl.items.filter((it) => it.f && !it.hid && !it.out).sort((a, b) => a.f.y - b.f.y || a.f.x - b.f.x);
  const rest = P.cl.items.filter((it) => !vis.includes(it));
  // each part keeps the nearest grid size to the width it had
  for (const it of vis) {
    const cols = it.f.w * 6;
    it.sz = Object.keys(WS_CSIZES).reduce((a, k) => (Math.abs(WS_CSIZES[k] - cols) < Math.abs(WS_CSIZES[a] - cols) ? k : a), 'M');
  }
  P.cl.items = vis.concat(rest);
}

// ---------------------------------------------------------------- drawing a panel's parts
// Each part keeps its element; a data update rewrites only the parts whose markup changed, and a
// move or a size change touches only styles.
function wsCompsLive(P, def, id, d) {
  if (!def.comps || !P.cl) return false;
  if (!def.entity || def.loose) return true;
  if (!id || !d || !d.found) return false;
  if (S.run.pending && S.run.pending.id === id) return false;
  return def.applies(d, P);
}
function wsCToolsHtml(P, it, c) {
  const b = (act, icon, label, on) => `<button type="button" class="wsc-tb${on ? ' on' : ''}" data-cact="${act}" title="${esc(label)}" aria-label="${esc(label)}">${icon}</button>`;
  let h = `<div class="wsc-bar"><span class="wsc-grip" aria-hidden="true">${WS_I.grip}</span><span class="wsc-name">${esc(wsCTitle(c))}</span><span class="spacer"></span>`;
  if (P.cl.mode === 'flow') h += `<span class="wsc-sizes">${Object.keys(WS_CSIZES).map((k) => `<button type="button" class="wsc-sz${it.sz === k ? ' on' : ''}" data-cact="sz:${k}" title="${esc(t('ws.c.size_' + k))}" aria-label="${esc(t('ws.c.size_' + k))}">${k}</button>`).join('')}</span>`;
  h += b('cmp', WS_I.compact, t('ws.c.compact'), it.cmp === true)
    + b('detach', WS_I.float, t('ws.c.detach'))
    + b('hide', WS_I.eyeoff, t('ws.c.hide'));
  return h + `</div>`;
}
function wsRenderComps(el, P, def, id, d, force) {
  const b = el.querySelector('.wsp-body');
  let host = el._sig === '#comps' ? b.querySelector('.wsc-host') : null;
  if (!host) {
    b.innerHTML = '<div class="d-wrap"><div class="wsc-host"></div><div class="wsc-empty" hidden></div></div>';
    host = b.querySelector('.wsc-host');
    el._sig = '#comps';
    el._cels = new Map();
  }
  const editing = WS.edit && WS.cedit === P.iid;
  const free = P.cl.mode === 'free';
  host.className = 'wsc-host' + (free ? ' wsc-free' : ' wsc-flow') + (editing ? ' wsc-editing' : '');
  const seen = new Set();
  let order = 0, bottom = 0;
  for (const it of P.cl.items) {
    const c = wsCDef(it.cid);
    if (!c || it.hid || it.out) continue;
    let html = '';
    try { html = c.render(d, { P, host: P.pid, item: it, id }) || ''; } catch (e) { html = ''; console.warn('component', it.cid, e); }
    if (!html && !editing) continue; // nothing to show for this entity (an airspeed gauge on a soldier)
    const na = !html;
    if (na) html = wsCNA(c, d);
    seen.add(it.cid);
    let ce = el._cels.get(it.cid);
    if (!ce) {
      ce = document.createElement('div');
      ce.className = 'wsc';
      ce.dataset.cid = it.cid;
      el._cels.set(it.cid, ce);
      host.appendChild(ce);
    }
    const inner = (editing ? wsCToolsHtml(P, it, c) : '') + `<div class="wsc-b">${wsScopeIds(html, P.iid + '-' + it.cid)}</div>`
      + (editing ? (free ? '<div class="wsc-rz wsc-rz-se" data-crz="se" aria-hidden="true"></div>' : '<div class="wsc-rz wsc-rz-x" data-crz="x" aria-hidden="true"></div>') : '');
    if (force || ce._sig !== inner) { ce._sig = inner; ce.innerHTML = inner; paintNeedles(ce); }
    ce.className = `wsc wsc-${it.sz}${it.cmp ? ' wsc-cmp' : ''}${na ? ' wsc-isna' : ''}${editing && WS.csel === it.cid ? ' wsc-sel' : ''}`;
    if (free && it.f) {
      ce.style.cssText = `left:calc(${it.f.x} * 100cqw);top:calc(${it.f.y} * 100cqw);width:calc(${it.f.w} * 100cqw);height:calc(${it.f.h} * 100cqw);z-index:${(it.z || 0) + 1}`;
      bottom = Math.max(bottom, it.f.y + it.f.h);
    } else ce.style.cssText = `order:${order}`;
    order++;
  }
  for (const [cid, ce] of el._cels) if (!seen.has(cid)) { ce.remove(); el._cels.delete(cid); }
  host.style.height = free ? `calc(${bottom.toFixed(4)} * 100cqw + 8px)` : '';
  const empty = b.querySelector('.wsc-empty');
  empty.hidden = seen.size > 0;
  if (!empty.hidden) empty.innerHTML = `<div class="d-empty">${esc(t(editing ? 'ws.c.empty_edit' : 'ws.c.empty'))}</div>`;
}
// The strip under the title bar while a panel's parts are being edited.
function wsCStripHtml(P) {
  const hidden = P.cl.items.filter((it) => (it.hid || it.out) && wsCDef(it.cid)).length;
  const seg = (m) => `<button type="button" class="${P.cl.mode === m ? 'on' : ''}" data-cstrip="${m}" aria-pressed="${P.cl.mode === m}">${esc(t('ws.c.mode_' + m))}</button>`;
  return `<span class="wsc-strip-t">${WS_I.parts}<b>${esc(t('ws.c.editing'))}</b></span>`
    + `<span class="seg small wsc-mode" role="group" aria-label="${esc(t('ws.c.mode'))}">${seg('flow')}${seg('free')}</span>`
    + `<button type="button" class="btn small-btn" data-cstrip="list">${esc(t('ws.c.list'))}${hidden ? ` <span class="wsc-n">${hidden}</span>` : ''}</button>`
    + `<button type="button" class="btn small-btn" data-cstrip="add">+ ${esc(t('ws.c.add'))}</button>`
    + `<span class="spacer"></span><button type="button" class="btn small-btn primary" data-cstrip="done">${WS_I.check}<span>${esc(t('ws.done'))}</span></button>`;
}

// ---------------------------------------------------------------- component editing mode
function wsCEdit(iid) {
  const P = iid && wsP(iid);
  const on = !!(P && wsDef(P.pid) && wsDef(P.pid).comps);
  if (on && !WS.edit) wsEditSet(true);
  WS.cedit = on ? iid : null;
  WS.csel = null;
  if (on) { WS.sel = iid; WS.libTab = 'comps'; }
  wsUpdateChrome();
  wsLayout();
  wsRenderAll(true);
}
function wsCSelect(cid) {
  WS.csel = cid;
  const el = WS.cedit && WS.els.get(WS.cedit);
  if (el && el._cels) for (const [k, ce] of el._cels) ce.classList.toggle('wsc-sel', k === cid);
  wsLibRender();
}
function wsCAct(P, cid, act) {
  if (act.startsWith('sz:')) { const k = act.slice(3); if (WS_CSIZES[k]) wsMut((L) => { const it = wsItem(L.panels.find((x) => x.iid === P.iid), cid); if (it) it.sz = k; }); return; }
  if (act === 'cmp') { wsMut((L) => { const it = wsItem(L.panels.find((x) => x.iid === P.iid), cid); if (it) { if (it.cmp) delete it.cmp; else it.cmp = true; } }); return; }
  if (act === 'hide') {
    wsMut((L) => { const it = wsItem(L.panels.find((x) => x.iid === P.iid), cid); if (it) it.hid = true; });
    if (WS.csel === cid) WS.csel = null;
    toast(t('ws.c.hidden', { n: wsCTitle(wsCDef(cid)) }));
    return;
  }
  if (act === 'show') { wsMut((L) => { const Q = L.panels.find((x) => x.iid === P.iid); const it = wsItem(Q, cid); if (it) { delete it.hid; wsCPlace(Q, it, null, null); } }); return; }
  if (act === 'detach') {
    const el = WS.els.get(P.iid);
    const ce = el && el._cels && el._cels.get(cid);
    const ar = WS.area.getBoundingClientRect();
    const c = wsCDef(cid);
    let r = { x: 40, y: 40, w: c.wsize.w, h: c.wsize.h + WS_HEAD };
    if (ce) { const cr = ce.getBoundingClientRect(); r = { x: cr.left - ar.left + 24, y: cr.top - ar.top + 24, w: Math.max(c.min.w, cr.width), h: Math.max(c.min.h, cr.height + WS_HEAD) }; }
    let W = null;
    wsMut((L) => { W = wsDetachIn(L, P.iid, cid, r); });
    if (W) { WS.csel = null; WS.sel = W.iid; wsLibRender(); }
    return;
  }
  if (act === 'remove') { wsMut((L) => { const Q = L.panels.find((x) => x.iid === P.iid); Q.cl.items = Q.cl.items.filter((x) => x.cid !== cid); }); return; }
  if (act === 'up' || act === 'down') {
    wsMut((L) => {
      const Q = L.panels.find((x) => x.iid === P.iid);
      const vis = Q.cl.items.filter((x) => !x.hid && !x.out && wsCDef(x.cid));
      const i = vis.findIndex((x) => x.cid === cid), j = i + (act === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= vis.length) return;
      const a = Q.cl.items.indexOf(vis[i]), bb = Q.cl.items.indexOf(vis[j]);
      [Q.cl.items[a], Q.cl.items[bb]] = [Q.cl.items[bb], Q.cl.items[a]];
    });
  }
}
function wsCStrip(P, act) {
  if (act === 'done') { wsCEdit(null); return; }
  if (act === 'flow' || act === 'free') {
    if (P.cl.mode === act) return;
    wsMut((L) => { const Q = L.panels.find((x) => x.iid === P.iid); if (act === 'free') wsCToFree(Q); else wsCToFlow(Q); });
    return;
  }
  if (act === 'list' || act === 'add') {
    WS.libOpen = true; WS.libTab = 'comps';
    if (act === 'add') WS.libQ = '';
    wsUpdateChrome();
    const lib = WS.root.querySelector('.wse-lib');
    const tgt = lib && lib.querySelector(act === 'add' ? '.wl-q' : '.wcl');
    if (tgt) { tgt.scrollIntoView({ block: 'nearest' }); if (act === 'add') tgt.focus(); }
  }
}

// ---------------------------------------------------------------- dragging parts
// Where a dragged part would go: a place in a panel that holds parts (its own or another), or
// out into the workspace as a widget (docked when dropped on a docking target).
function wsCTargetAt(cx, cy, skipIid) {
  for (const el of document.elementsFromPoint(cx, cy)) {
    if (el.closest('.wsc-ghost')) continue;
    const pe = el.closest('.wsp');
    if (!pe || !WS.area.contains(pe)) continue;
    if (pe.dataset.iid === skipIid) continue; // the widget being dragged is under the pointer
    const P = wsP(pe.dataset.iid);
    const def = P && wsDef(P.pid);
    if (!P || !def || !def.comps || !P.cl || P.min) return null;
    const host = pe.querySelector('.wsc-host');
    const body = pe.querySelector('.wsp-body');
    if (!host || !body) return null;
    const br = body.getBoundingClientRect();
    if (cx < br.left || cx > br.right || cy < br.top || cy > br.bottom) return null;
    return { P, pe, host };
  }
  return null;
}
// Insertion point among a flow host's visible parts: before the first part whose centre comes
// after the pointer in reading order.
function wsCFlowIndex(P, pe, host, cx, cy, skipCid) {
  const rtl = getComputedStyle(host).direction === 'rtl';
  const vis = P.cl.items.filter((it) => !it.hid && !it.out && it.cid !== skipCid && pe._cels && pe._cels.get(it.cid) && pe._cels.get(it.cid).isConnected);
  let bar = null;
  for (const it of vis) {
    const r = pe._cels.get(it.cid).getBoundingClientRect();
    const midX = r.left + r.width / 2;
    const before = cy < r.top || (cy <= r.bottom && (rtl ? cx > midX : cx < midX));
    if (before) {
      bar = { x: rtl ? r.right : r.left, y: r.top, h: r.height, v: true };
      return { index: P.cl.items.indexOf(it), bar };
    }
  }
  const last = vis[vis.length - 1];
  if (last) { const r = pe._cels.get(last.cid).getBoundingClientRect(); bar = { x: rtl ? r.left : r.right, y: r.top, h: r.height, v: true }; }
  else { const r = host.getBoundingClientRect(); bar = { x: r.left, y: r.top, w: r.width, v: false }; }
  return { index: null, bar };
}
function wsCShowIns(bar, tgtEl) {
  const ins = WS.area.querySelector('.wsc-ins');
  ins.hidden = !bar;
  for (const el of WS.area.querySelectorAll('.wsp-droptgt')) if (el !== tgtEl) el.classList.remove('wsp-droptgt');
  if (tgtEl) tgtEl.classList.add('wsp-droptgt');
  if (!bar) return;
  const ar = WS.area.getBoundingClientRect();
  ins.style.cssText = bar.v ? `left:${bar.x - ar.left - 2}px;top:${bar.y - ar.top}px;width:4px;height:${bar.h}px`
    : `left:${bar.x - ar.left}px;top:${bar.y - ar.top - 2}px;width:${bar.w}px;height:4px`;
}
// Snap a part's free rect (host px) to the grid, or to the edges and centres of the other parts.
function wsCSnap(P, pe, r, skipCid, free, edges) {
  if (free) return { r, gx: null, gy: null };
  const g = WS.work.opt.grid;
  const xs = [], ys = [];
  if (WS.work.opt.guides && pe._cels) {
    const hr = pe.querySelector('.wsc-host').getBoundingClientRect();
    xs.push(0, hr.width / 2, hr.width);
    for (const it of P.cl.items) {
      const ce = it.cid !== skipCid && pe._cels.get(it.cid);
      if (!ce || !ce.isConnected) continue;
      const q = ce.getBoundingClientRect();
      const x = q.left - hr.left, y = q.top - hr.top;
      xs.push(x, x + q.width / 2, x + q.width); ys.push(y, y + q.height / 2, y + q.height);
    }
  }
  const out = Object.assign({}, r);
  let gx = null, gy = null;
  const fit = (pos, size, T, which) => {
    const vals = which === 'move' ? [pos, pos + size / 2, pos + size] : [pos + size];
    const hit = wsNearest(vals, T, 6);
    if (hit) return which === 'move' ? { pos: pos + hit.d, size, at: hit.at } : { pos, size: size + hit.d, at: hit.at };
    if (!WS.work.opt.snap) return { pos, size, at: null };
    return which === 'move' ? { pos: Math.round(pos / g) * g, size, at: null } : { pos, size: Math.round((pos + size) / g) * g - pos, at: null };
  };
  const which = edges ? 'hi' : 'move';
  const a = fit(out.x, out.w, xs, which); out.x = a.pos; out.w = a.size; gx = a.at;
  const bq = fit(out.y, out.h, ys, which); out.y = bq.pos; out.h = bq.size; gy = bq.at;
  return { r: out, gx, gy };
}
function wsCHostToArea(pe, x, y) {
  const hr = pe.querySelector('.wsc-host').getBoundingClientRect(), ar = WS.area.getBoundingClientRect();
  return { x: x == null ? null : x + hr.left - ar.left, y: y == null ? null : y + hr.top - ar.top };
}
function wsStartCompMove(e, P, cid, ce, pe) {
  e.preventDefault();
  const r0 = ce.getBoundingClientRect();
  const op = { before: wsClone(WS.work), sx: e.clientX, sy: e.clientY, r0, moved: false, tgt: null, ghost: null, as: 0 };
  // near the top or bottom edge of a panel body, the body scrolls (to reach parts out of view)
  const autoScroll = () => {
    const ev = op.ev;
    if (!ev || !op.moved) return;
    const pe2 = document.elementsFromPoint(ev.clientX, ev.clientY).map((x) => x.closest('.wsp')).find((x) => x && WS.area.contains(x));
    const body = pe2 && pe2.querySelector('.wsp-body');
    if (!body || body.scrollHeight <= body.clientHeight) return;
    const br = body.getBoundingClientRect(), edge = 36;
    const v = ev.clientY < br.top + edge ? -1 : (ev.clientY > br.bottom - edge ? 1 : 0);
    if (!v || ev.clientX < br.left || ev.clientX > br.right) return;
    const top0 = body.scrollTop;
    body.scrollTop += v * 14;
    if (body.scrollTop !== top0) frame(op);
  };
  const frame = (o) => {
    if (!o.as) o.as = setInterval(autoScroll, 40);
    const ev = o.ev, dx = ev.clientX - o.sx, dy = ev.clientY - o.sy;
    if (!o.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      o.moved = true;
      o.ghost = ce.cloneNode(true);
      o.ghost.classList.add('wsc-ghost');
      o.ghost.style.cssText = `width:${r0.width}px;height:${r0.height}px`;
      document.body.appendChild(o.ghost);
      ce.classList.add('wsc-src');
    }
    let gl = r0.left + dx, gt = r0.top + dy;
    const hit = wsCTargetAt(ev.clientX, ev.clientY, null);
    o.tgt = null;
    wsShowGuides(null, null); wsShowDrop(null);
    if (hit && hit.P.iid === P.iid && P.cl.mode === 'free') {
      // moving within its own free-mode panel: snapped to the grid and the other parts
      const hr = hit.host.getBoundingClientRect();
      const s = wsCSnap(P, pe, { x: gl - hr.left, y: gt - hr.top, w: r0.width, h: r0.height }, cid, ev.shiftKey || ev.altKey);
      const x = Math.max(0, Math.min(hr.width - s.r.w, s.r.x)), y = Math.max(0, s.r.y);
      gl = hr.left + x; gt = hr.top + y;
      o.tgt = { type: 'free', x: x / hr.width, y: y / hr.width };
      const g = wsCHostToArea(pe, s.gx, s.gy);
      wsShowGuides(g.x, g.y);
      wsCShowIns(null, null);
    } else if (hit) {
      const hr = hit.host.getBoundingClientRect();
      if (hit.P.cl.mode === 'free') {
        o.tgt = { type: 'into', P: hit.P, index: null, at: { x: (ev.clientX - hr.left) / hr.width - 0.1, y: (ev.clientY - hr.top) / hr.width - 0.05 } };
        wsCShowIns(null, hit.pe);
      } else {
        const fi = wsCFlowIndex(hit.P, hit.pe, hit.host, ev.clientX, ev.clientY, hit.P.iid === P.iid ? cid : null);
        o.tgt = { type: 'into', P: hit.P, index: fi.index };
        wsCShowIns(fi.bar, hit.pe);
      }
    } else {
      wsCShowIns(null, null);
      const ar = WS.area.getBoundingClientRect();
      const inside = ev.clientX >= ar.left && ev.clientX <= ar.right && ev.clientY >= ar.top && ev.clientY <= ar.bottom;
      if (inside) {
        const drop = !WS.mobile && !ev.shiftKey ? wsDropTarget(ev.clientX - ar.left, ev.clientY - ar.top) : null;
        o.tgt = { type: 'detach', rect: { x: gl - ar.left, y: gt - ar.top - WS_HEAD, w: r0.width, h: r0.height + WS_HEAD }, drop };
        wsShowDrop(drop);
      }
    }
    o.ghost.style.left = gl + 'px';
    o.ghost.style.top = gt + 'px';
    o.ghost.classList.toggle('wsc-ghost-out', !!(o.tgt && o.tgt.type === 'detach'));
  };
  wsDragLoop(op, frame, (o, cancel) => {
    clearInterval(o.as);
    if (o.ghost) o.ghost.remove();
    ce.classList.remove('wsc-src');
    wsShowGuides(null, null); wsShowDrop(null); wsCShowIns(null, null);
    if (cancel || !o.moved || !o.tgt) { if (cancel) { WS.work = o.before; wsApply(); } return; }
    const T = o.tgt;
    let sel = cid, selPanel = P.iid, msg = null;
    const L = WS.work;
    const Q = L.panels.find((x) => x.iid === P.iid);
    const it = wsItem(Q, cid);
    if (!it) return;
    if (T.type === 'free') {
      it.f = Object.assign({}, it.f || wsCFreeSlot(Q, cid), { x: Math.max(0, Math.min(1 - (it.f ? it.f.w : 0.5), T.x)), y: Math.max(0, T.y) });
      it.z = wsCTopZ(Q) + 1;
    } else if (T.type === 'into' && T.P.iid === P.iid) {
      wsCPlace(Q, it, T.index == null ? null : (T.index > Q.cl.items.indexOf(it) ? T.index - 1 : T.index), null);
      if (T.index == null) { Q.cl.items.splice(Q.cl.items.indexOf(it), 1); Q.cl.items.push(it); }
    } else if (T.type === 'into') {
      const Q2 = L.panels.find((x) => x.iid === T.P.iid);
      const ex = wsItem(Q2, cid);
      if (ex && !ex.hid && !ex.out) msg = t('ws.c.already', { n: wsCTitle(wsCDef(cid)), p: wsTitle(wsDef(Q2.pid)) });
      else {
        Q.cl.items = Q.cl.items.filter((x) => x !== it);
        let n = ex;
        if (!n) { n = { cid, sz: it.sz }; if (it.cmp) n.cmp = true; Q2.cl.items.push(n); }
        delete n.hid; delete n.out;
        wsCPlace(Q2, n, T.index, T.at || null);
        selPanel = Q2.iid;
      }
    } else if (T.type === 'detach') {
      const W = wsDetachIn(L, P.iid, cid, T.rect);
      if (W && T.drop) wsDockIn(L, W, T.drop);
      if (W) { sel = null; WS.sel = W.iid; }
    }
    if (msg) { toast(msg); return; }
    if (selPanel !== WS.cedit && sel) { WS.cedit = selPanel; WS.sel = selPanel; }
    WS.csel = sel;
    wsCommitFrom(o.before);
  });
}
function wsStartCompResize(e, P, cid, ce, pe) {
  e.preventDefault(); e.stopPropagation();
  const host = pe.querySelector('.wsc-host');
  const hw = host.clientWidth || 1;
  const r0 = ce.getBoundingClientRect(), hr = host.getBoundingClientRect();
  const rtl = getComputedStyle(host).direction === 'rtl';
  const op = { before: wsClone(WS.work), sx: e.clientX, sy: e.clientY, val: null };
  const it0 = wsItem(P, cid);
  wsDragLoop(op, (o) => {
    const dx = o.ev.clientX - o.sx, dy = o.ev.clientY - o.sy;
    if (P.cl.mode === 'free') {
      const s = wsCSnap(P, pe, { x: r0.left - hr.left, y: r0.top - hr.top, w: r0.width + dx, h: r0.height + dy }, cid, o.ev.shiftKey || o.ev.altKey, 'se');
      const x = r0.left - hr.left, y = r0.top - hr.top;
      const w = Math.max(hw * 0.15, Math.min(hw - x, s.r.w)), h = Math.max(48, s.r.h);
      o.val = { w: w / hw, h: h / hw };
      ce.style.width = w + 'px'; ce.style.height = h + 'px';
      const g = wsCHostToArea(pe, s.gx, s.gy);
      wsShowGuides(g.x, g.y);
    } else {
      // the grid sizes: whichever is nearest to the dragged width
      const w = r0.width + (rtl ? -dx : dx);
      const cols = (w / hw) * 6;
      const k = Object.keys(WS_CSIZES).reduce((a, q) => (Math.abs(WS_CSIZES[q] - cols) < Math.abs(WS_CSIZES[a] - cols) ? q : a), it0.sz);
      o.val = k;
      for (const q of Object.keys(WS_CSIZES)) ce.classList.toggle('wsc-' + q, q === k);
    }
  }, (o, cancel) => {
    wsShowGuides(null, null);
    if (cancel || o.val == null) { wsRenderAll(true); return; }
    const it = wsItem(P, cid);
    if (P.cl.mode === 'free') it.f = Object.assign({}, it.f, o.val); else it.sz = o.val;
    WS.csel = cid;
    wsCommitFrom(o.before);
  });
}
// A widget dragged over a panel that holds parts (editor only): where it would go in.
function wsWidgetTarget(P, cx, cy) {
  if (!WS.edit) return null;
  const def = wsDef(P.pid);
  if (!def || !def.widget) return null;
  const hit = wsCTargetAt(cx, cy, P.iid);
  if (!hit) return null;
  const ex = wsItem(hit.P, def.cid);
  if (ex && !ex.hid && !ex.out) return { P: hit.P, pe: hit.pe, dup: true };
  if (hit.P.cl.mode === 'free') {
    const hr = hit.host.getBoundingClientRect();
    return { P: hit.P, pe: hit.pe, index: null, at: { x: (cx - hr.left) / hr.width - 0.1, y: (cy - hr.top) / hr.width - 0.05 } };
  }
  const fi = wsCFlowIndex(hit.P, hit.pe, hit.host, cx, cy, null);
  return { P: hit.P, pe: hit.pe, index: fi.index, bar: fi.bar };
}

// ---------------------------------------------------------------- keyboard (parts)
function wsCKey(e) {
  const P = WS.cedit && wsP(WS.cedit);
  if (!P) return false;
  if (e.key === 'Escape') { if (WS.csel) wsCSelect(null); else wsCEdit(null); e.preventDefault(); return true; }
  const cid = WS.csel;
  if (!cid) return false;
  if (e.key === 'Delete') { e.preventDefault(); wsCAct(P, cid, 'hide'); return true; }
  const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!k) return false;
  e.preventDefault();
  if (P.cl.mode === 'flow') {
    if (e.shiftKey) {
      const ks = Object.keys(WS_CSIZES), it = wsItem(P, cid);
      const rtl = document.documentElement.dir === 'rtl';
      const step = k[0] * (rtl ? -1 : 1) || -k[1];
      const j = Math.max(0, Math.min(ks.length - 1, ks.indexOf(it.sz) + step));
      wsCAct(P, cid, 'sz:' + ks[j]);
    } else {
      const rtl = document.documentElement.dir === 'rtl';
      const back = k[1] < 0 || (rtl ? k[0] > 0 : k[0] < 0);
      wsCAct(P, cid, back ? 'up' : 'down');
    }
    return true;
  }
  const el = WS.els.get(P.iid);
  const hw = (el && el.querySelector('.wsc-host') && el.querySelector('.wsc-host').clientWidth) || 300;
  const st = (e.altKey ? 1 : WS.work.opt.grid) / hw;
  wsMut((L) => {
    const it = wsItem(L.panels.find((x) => x.iid === P.iid), cid);
    if (!it || !it.f) return;
    if (e.shiftKey) { it.f.w = Math.max(0.15, Math.min(1 - it.f.x, it.f.w + k[0] * st)); it.f.h = Math.max(0.06, it.f.h + k[1] * st); }
    else { it.f.x = Math.max(0, Math.min(1 - it.f.w, it.f.x + k[0] * st)); it.f.y = Math.max(0, it.f.y + k[1] * st); }
  });
  return true;
}

// ---------------------------------------------------------------- library and settings (parts)
function wsCListHtml(P) {
  const def = wsDef(P.pid);
  const row = (it) => {
    const c = wsCDef(it.cid);
    if (!c) return `<div class="wcl-row wcl-unknown"><span class="wcl-n" dir="ltr">${esc(it.cid)}</span><small>${esc(t('ws.lib.unknown_d'))}</small><span class="spacer"></span><button type="button" class="btn small-btn danger" data-wcomp="remove:${P.iid}:${it.cid}">${esc(t('ws.remove'))}</button></div>`;
    const st = it.out ? 'out' : (it.hid ? 'hid' : 'vis');
    const btn = (act, label, cls = '') => `<button type="button" class="btn small-btn ${cls}" data-wcomp="${act}:${P.iid}:${it.cid}">${esc(label)}</button>`;
    let acts = '';
    if (st === 'vis') acts = btn('select', t('ws.c.select')) + btn('hide', t('ws.c.hide'));
    else if (st === 'hid') acts = btn('show', t('ws.lib.show'), 'primary') + btn('remove', t('ws.remove'));
    else acts = btn('return', t('ws.c.return'), 'primary');
    return `<div class="wcl-row wcl-${st}${WS.csel === it.cid && WS.cedit === P.iid ? ' wcl-sel' : ''}"><span class="wl-ic">${dIcon(c.icon, 16)}</span><span class="wcl-n">${esc(wsCTitle(c))}</span>`
      + `<small class="wcl-st">${esc(t('ws.c.st_' + st))}</small><span class="spacer"></span>${acts}</div>`;
  };
  const sel = WS.cedit === P.iid && WS.csel ? wsItem(P, WS.csel) : null;
  const sc = sel && wsCDef(sel.cid);
  let h = `<div class="wcl"><div class="wcl-head">${WS_I.parts}<b>${esc(t('ws.c.of', { p: wsTitle(def) }))}</b><span class="spacer"></span>`
    + (WS.cedit === P.iid ? `<button type="button" class="btn small-btn primary" data-wcomp="done:${P.iid}">${esc(t('ws.done'))}</button>`
      : `<button type="button" class="btn small-btn primary" data-wcomp="edit:${P.iid}">${esc(t('ws.c.edit'))}</button>`) + `</div>`;
  if (sc) {
    const it = sel;
    h += `<div class="wcl-selbox"><div class="wcl-selhead">${dIcon(sc.icon, 16)}<b>${esc(wsCTitle(sc))}</b><small>${esc(t('ws.c.selected'))}</small></div>`;
    if (P.cl.mode === 'flow') {
      h += `<label class="wc-row"><span>${esc(t('ws.c.size'))}</span><select data-wcsz="${P.iid}:${it.cid}">`
        + Object.keys(WS_CSIZES).map((k) => `<option value="${k}"${it.sz === k ? ' selected' : ''}>${esc(t('ws.c.size_' + k))}</option>`).join('') + `</select></label>`;
    } else if (it.f) {
      h += `<div class="wc-geo" dir="ltr">${Math.round(it.f.x * 100)}%, ${Math.round(it.f.y * 100)}% · ${Math.round(it.f.w * 100)}% × ${Math.round(it.f.h * 100)}%</div>`;
    }
    h += `<label class="wc-row wc-ck"><input type="checkbox" data-wccmp="${P.iid}:${it.cid}"${it.cmp ? ' checked' : ''}><span>${esc(t('ws.c.compact'))}</span></label>`
      + `<div class="wc-acts"><button type="button" class="btn small-btn" data-wcomp="detach:${P.iid}:${it.cid}">${esc(t('ws.c.detach'))}</button>`
      + `<button type="button" class="btn small-btn" data-wcomp="hide:${P.iid}:${it.cid}">${esc(t('ws.c.hide'))}</button></div>`
      + `<div class="muted small">${esc(t('ws.c.keys'))}</div></div>`;
  }
  h += `<div class="wcl-mode"><span>${esc(t('ws.c.mode'))}</span><span class="seg small">`
    + ['flow', 'free'].map((m) => `<button type="button" class="${P.cl.mode === m ? 'on' : ''}" data-wcomp="mode-${m}:${P.iid}">${esc(t('ws.c.mode_' + m))}</button>`).join('')
    + `</span></div><div class="wcl-list">${P.cl.items.map(row).join('') || `<div class="d-empty">${esc(t('ws.c.empty'))}</div>`}</div></div>`;
  return h;
}
// The part library: every component, by category, with "add to this panel" (the panel whose
// parts are being edited, else the selected panel that holds parts) and "add as a widget".
function wsCLibItem(c, tgt) {
  const it = tgt ? wsItem(tgt, c.id) : null;
  const inTgt = it && !it.hid && !it.out;
  const src = tgt && tgt.src ? tgt.src : 'sel';
  const wpid = 'w-' + c.id;
  const wl = WS.work.panels.find((P) => P.pid === wpid && !P.from && P.src === (c.entity ? src : ''));
  const home = c.home && wsDef(c.home);
  const btn = (act, label, cls = '', dis = false) => `<button type="button" class="btn small-btn ${cls}" data-wcomp="${act}"${dis ? ' disabled' : ''}>${esc(label)}</button>`;
  let acts = '';
  if (tgt) {
    const tname = wsTitle(wsDef(tgt.pid));
    acts += inTgt ? `<span class="wl-addfor">${esc(t('ws.c.in_panel', { p: tname }))}</span>`
      : btn(`addto:${tgt.iid}:${c.id}`, t(it && it.out ? 'ws.c.return_to' : 'ws.c.add_to', { p: tname }), 'primary');
  }
  acts += wl ? (wl.st === 'hidden' ? btn(`wshow:${wl.iid}:${c.id}`, t('ws.c.widget_show')) : `<span class="wl-addfor">${esc(t('ws.c.widget_on'))}</span>`)
    : btn(`widget:${src}:${c.id}`, t('ws.c.widget'));
  return `<div class="wl-item wl-comp" data-ccat="${c.cat}"><div class="wl-head"><span class="wl-ic">${dIcon(c.icon, 18)}</span>`
    + `<span class="wl-name"><b>${esc(wsCTitle(c))}</b><small>${esc(tOr('ws.cd.' + c.id, ''))}${home ? ` · ${esc(t('ws.c.home', { p: wsTitle(home) }))}` : ''}</small></span></div>`
    + `<div class="wl-adds">${acts}</div></div>`;
}
function wsCLibHtml(q) {
  const P = (WS.cedit && wsP(WS.cedit)) || (WS.sel && wsP(WS.sel));
  const tgt = P && P.cl && wsDef(P.pid) && wsDef(P.pid).comps && P.st !== 'hidden' ? P : null;
  const list = [...WS_COMP.values()].filter((c) => (WS.libCCat === 'all' || c.cat === WS.libCCat)
    && (!q || wsCTitle(c).toLowerCase().includes(q) || tOr('ws.cd.' + c.id, '').toLowerCase().includes(q) || c.id.includes(q)));
  const groups = WS_CCATS.map((cat) => {
    const l = list.filter((c) => c.cat === cat);
    return l.length ? `<div class="wl-cat">${esc(t('ws.ccat.' + cat))}</div>` + l.map((c) => wsCLibItem(c, tgt)).join('') : '';
  }).join('');
  return `<div class="wl-cats">${['all', ...WS_CCATS].map((c) => `<button type="button" class="wl-catb${WS.libCCat === c ? ' on' : ''}" data-wlib-ccat="${c}">${esc(t(c === 'all' ? 'ws.cat.all' : 'ws.ccat.' + c))}</button>`).join('')}</div>`
    + (tgt ? '' : `<div class="wl-note">${esc(t('ws.c.pick_panel'))}</div>`)
    + `<div class="wl-list">${groups || `<div class="d-empty">${esc(t('ws.lib.none'))}</div>`}</div>`;
}
function wsCompCmd(cmd) {
  const [act, a, cid] = cmd.split(':');
  if (act === 'widget') {
    let W = null;
    wsMut((L) => { W = wsAddIn(L, 'w-' + cid, a || 'sel'); });
    if (W) wsSelect(W.iid);
    return;
  }
  const P = wsP(a);
  if (!P) return;
  if (act === 'wshow') { wsMut((L) => { const Q = L.panels.find((x) => x.iid === P.iid); wsShowIn(L, Q); wsFrontIn(L, Q); }); wsSelect(P.iid); return; }
  if (act === 'edit') { wsCEdit(P.iid); return; }
  if (act === 'done') { wsCEdit(null); return; }
  if (act === 'mode-flow' || act === 'mode-free') { wsCStrip(P, act.slice(5)); return; }
  if (act === 'select') { if (WS.cedit !== P.iid) wsCEdit(P.iid); wsCSelect(cid); return; }
  if (act === 'return') {
    const W = WS.work.panels.find((x) => x.from && x.from.iid === P.iid && x.from.cid === cid);
    if (W) wsMut((L) => wsReturnIn(L, L.panels.find((x) => x.iid === W.iid)));
    return;
  }
  if (act === 'addto') {
    const it = wsItem(P, cid);
    if (it && it.out) { const W = WS.work.panels.find((x) => x.from && x.from.iid === P.iid && x.from.cid === cid); if (W) { wsMut((L) => wsReturnIn(L, L.panels.find((x) => x.iid === W.iid))); return; } }
    wsMut((L) => {
      const Q = L.panels.find((x) => x.iid === P.iid);
      let n = wsItem(Q, cid);
      if (!n) { n = wsCNewItem(cid); Q.cl.items.push(n); }
      delete n.hid; delete n.out;
      wsCPlace(Q, n, null, null);
    });
    if (WS.cedit !== P.iid) wsCEdit(P.iid);
    wsCSelect(cid);
    const el = WS.els.get(P.iid), ce = el && el._cels && el._cels.get(cid);
    if (ce) { ce.scrollIntoView({ block: 'nearest' }); ce.classList.add('wsc-flash'); setTimeout(() => ce.classList.remove('wsc-flash'), 700); }
    return;
  }
  wsCAct(P, cid, act);
}
