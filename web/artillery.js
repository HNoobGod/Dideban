'use strict';
// ============================================================ artillery calculator (panel)
// The firing-solution panel: pick a gun (the one you are in, a friendly gun, or a manual
// position and type), a magazine and a target; it shows the solution for every charge on both
// arcs, with a simple view (a few very large numbers) and a full view (the whole table and the
// trajectory over the ground).
//
//   data      AR.db: the weapon database the server keeps per mod set (api/arty/db), read from the
//             game config by the mod. AR.q: the game's answer for the current gun and target
//             (exact heights, muzzle height, ACE settings, air density, wind).
//   state     AR.st = { settings, calc }: kept on the server and pushed to every page of this
//             server ("arty_state"), so a pop-out window or a phone shows the same thing. A change
//             is applied here at once and sent; the server's copy wins when it comes back.
//   maths     web/ballistics.js (Ballistics), the same code the unit tests run.
//   workspace the solution, the table and the profile are also workspace parts (wsComp) and one
//             workspace panel ('arty'), so they can go on custom dashboards.

const AR_FIELDS = ['az', 'el', 'charge', 'tof', 'range', 'dz', 'maxOrd', 'impact', 'drift', 'mv'];
const AR_SETTINGS = {
  angle: 'nato', angle2: '', dist: 'm', grid: 8, dec: 0, fields: ['az', 'el', 'charge', 'tof'],
  sound: true, vibrate: true, splash: 5, tol: 2,
};
const AR_CALC = {
  gunMode: 'mine', gunId: '', manual: null, veh: '', weapon: '', mag: '',
  target: null, arc: 'low', charge: -1, gunZ: null, targetZ: null,
};
const AR_PROFILE_N = 48;          // ground samples along the line of fire
const AR_REQUERY_MS = 15000;      // wind, temperature and the gun's position are asked again this often
const AR = {
  db: null, vehIdx: new Map(), dbStatus: { state: 'none' }, dbLoading: false,
  st: { settings: Object.assign({}, AR_SETTINGS), calc: Object.assign({}, AR_CALC), rev: -1 },
  open: false, view: 'simple',   // this browser's own choices (read in artyInit)
  pending: 0,                     // my changes the server has not echoed yet
  me: 'p' + Math.random().toString(36).slice(2, 9),
  q: null, qKey: '', qBusy: false, qErr: '', qAt: 0, qTimer: 0,
  gun: null, res: null, calcTimer: 0, sig: '', gridErr: { target: '', gun: '' },
};
const arS = () => AR.st.settings;
const arC = () => AR.st.calc;

// ---------------------------------------------------------------- formatting
const arDec = () => arS().dec;
// An angle in the chosen unit. Azimuths and elevations in mils are shown with 4 digits (0640).
function arAng(rad, unit, isAz) {
  if (rad == null || !Number.isFinite(rad)) return '—';
  const dec = arDec();
  let v = unit === 'deg' ? Ballistics.toDeg(rad) : Ballistics.toMils(rad, unit);
  if (isAz) { const full = unit === 'deg' ? 360 : Ballistics.MILS[unit]; v = ((v % full) + full) % full; }
  const s = v.toFixed(dec);
  if (unit === 'deg') return s + '°';
  const [i, f] = s.split('.');
  return (i.startsWith('-') ? '-' + i.slice(1).padStart(4, '0') : i.padStart(4, '0')) + (f ? '.' + f : '');
}
const arUnitName = (u) => t('ar.u.' + u);
function arDist(m, signed) {
  if (m == null || !Number.isFinite(m)) return '—';
  const sg = signed && m > 0 ? '+' : '';
  if (arS().dist === 'km' && Math.abs(m) >= 1000) return sg + (m / 1000).toFixed(Math.max(1, arDec() + 1)) + ' km';
  return sg + Math.round(m) + ' m';
}
const arSec = (s) => (s == null || !Number.isFinite(s) ? '—' : s.toFixed(1) + ' s');
const arPad = (n, d) => String(Math.max(0, Math.floor(n))).padStart(d, '0');
function arGrid(x, y, digits) {
  const d = digits || arS().grid;
  if (d === 10) return `${arPad(x, 5)} ${arPad(y, 5)}`;
  if (d === 8) return `${arPad(x / 10, 4)} ${arPad(y / 10, 4)}`;
  return `${arPad(x / 100, 3)} ${arPad(y / 100, 3)}`;
}
// "035 045", "03580452", "03581 04527" → centre of that square; null when it is not a grid.
function arParseGrid(text) {
  const s = String(text || '').replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[\s,.\-/]/g, '');
  if (!/^\d+$/.test(s) || ![6, 8, 10].includes(s.length)) return null;
  const n = s.length / 2, unit = 10 ** (5 - n);
  const x = Number(s.slice(0, n)) * unit + unit / 2, y = Number(s.slice(n)) * unit + unit / 2;
  const ws = worldSize();
  if (x > ws || y > ws) return null;
  return { x, y, digits: s.length };
}

// ---------------------------------------------------------------- server: state and database
async function arPost(body) {
  const r = await fetch('api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}
// Change settings and/or calculator inputs: here at once, then on the server for every page.
function arSet(part) {
  if (part.settings) Object.assign(AR.st.settings, part.settings);
  if (part.calc) Object.assign(AR.st.calc, part.calc);
  arSchedule();
  if (part.settings) arRenderSettings();
  AR.pending++;
  arPost(Object.assign({ action: 'arty_set', by: AR.me }, part))
    .catch((e) => { AR.pending = Math.max(0, AR.pending - 1); toast(t('toast.request_failed', { error: e.message })); });
}
function artyOnState(st) {
  if (!st || typeof st !== 'object') return; // SSE keeps order; a restarted server starts its rev again
  // my own change coming back while I have made more since: keep what is on screen
  if (st.by === AR.me && AR.pending > 0 && --AR.pending > 0) { AR.st.rev = st.rev ?? 0; return; }
  AR.st = { settings: Object.assign({}, AR_SETTINGS, st.settings), calc: Object.assign({}, AR_CALC, st.calc), rev: st.rev ?? 0 };
  arRenderSettings();
  arSchedule();
}
function artyOnDb(status) {
  AR.dbStatus = status || { state: 'none' };
  if (AR.dbStatus.state === 'ready' && (!AR.db || AR.db.key !== AR.dbStatus.key)) arLoadDb();
  else if (AR.dbStatus.key && AR.db && AR.db.key !== AR.dbStatus.key) { AR.db = null; AR.vehIdx.clear(); }
  arSchedule();
}
async function arLoadDb() {
  if (AR.dbLoading) return;
  AR.dbLoading = true;
  try {
    const r = await fetch('api/arty/db');
    const d = await r.json();
    if (d.status) AR.dbStatus = d.status;
    if (d.db) {
      AR.db = d.db;
      AR.vehIdx = new Map(d.db.vehicles.map((v) => [v.cls.toLowerCase(), v]));
    }
  } catch (e) { /* the server is restarting; the next status event retries */ }
  AR.dbLoading = false;
  arSchedule();
}
const arVeh = (cls) => (cls ? AR.vehIdx.get(String(cls).toLowerCase()) || null : null);

// ---------------------------------------------------------------- what to compute
// Friendly artillery the player can see on the map: crewed and empty, nearest first.
function arGunList() {
  const st = S.state;
  if (!st || !AR.db) return [];
  const me = st.me || { x: 0, y: 0 };
  // a crewed vehicle takes its crew's side; civilian ones only when civilians are shown
  const side = new Map();
  for (const u of st.units) if (u.veh && !side.has(u.veh)) side.set(u.veh, groupSide(u));
  const all = st.vehicles.filter((v) => sideShown(side.get(v.id) || 'CIV'))
    .concat((st.empty || []).filter((e) => sideShown(e.side))).filter((v) => arVeh(v.cls));
  return all.map((v) => ({ v, d: Math.hypot(v.x - me.x, v.y - me.y) })).sort((a, b) => a.d - b.d);
}
// The gun: position, its database entry, the weapon, magazine and charges to use.
function arGun() {
  const c = arC();
  if (!AR.db) return { reason: AR.dbStatus.state === 'scanning' ? 'scanning' : (S.status.connected ? 'nodb' : 'nogame') };
  let o = null, x, y, cls;
  if (c.gunMode === 'mine') {
    const st = S.state;
    if (!st || !st.me) return { reason: 'nogame' };
    const u = st.units.find((v) => v.id === st.me.id);
    o = u && u.veh ? st.vehicles.find((v) => v.id === u.veh) || null : null;
    if (!o) return { reason: 'notin' };
  } else if (c.gunMode === 'unit') {
    if (!c.gunId) return { reason: 'pick' };
    const st = S.state;
    o = st ? st.vehicles.find((v) => v.id === c.gunId) || (st.empty || []).find((v) => v.id === c.gunId) || null : null;
    if (!o) return { reason: 'gone' };
  } else {
    if (!c.manual) return { reason: 'nopos' };
    if (!c.veh) return { reason: 'notype' };
    x = c.manual.x; y = c.manual.y; cls = c.veh;
  }
  if (o) { x = o.x; y = o.y; cls = o.cls; }
  const veh = arVeh(cls);
  if (!veh) return { reason: 'notarty', cls };
  // every artillery weapon on the vehicle, with the turret that carries it
  const guns = [];
  for (const tu of veh.turrets) for (const w of tu.weapons) if (AR.db.weapons[w]) guns.push({ tu, w: AR.db.weapons[w] });
  if (!guns.length) return { reason: 'notarty', cls };
  const g = guns.find((x2) => x2.w.cls === c.weapon) || guns[0];
  const mags = [];
  for (const m of g.tu.mags.concat(g.w.mags)) if (AR.db.magazines[m] && !mags.includes(m)) mags.push(m);
  if (!mags.length) return { reason: 'nomag', cls };
  const mag = AR.db.magazines[mags.includes(c.mag) ? c.mag : mags[0]];
  const ammo = AR.db.ammo[mag.ammo] || { airFriction: 0 };
  let modes = g.w.modes.filter((m) => m.shown);
  if (!modes.length) modes = g.w.modes.slice();
  const seen = new Set();
  modes = modes.slice().sort((a, b) => a.charge - b.charge).filter((m) => (seen.has(m.charge) ? false : seen.add(m.charge)));
  const charges = modes.map((m, i) => ({
    name: m.name && m.name.length <= 14 ? m.name : t('ar.ch_n', { n: i + 1 }),
    mv: Ballistics.muzzleVelocity(mag.initSpeed, g.w.initSpeed, m.charge), charge: m.charge,
  }));
  return {
    x, y, id: o ? o.id : '', cls, veh, turret: g.tu, weapon: g.w, guns, mag, mags: mags.map((m) => AR.db.magazines[m]), ammo, charges,
    name: veh.name || cls, live: !!o,
  };
}
const arQKey = (g, tg) => [Math.round(g.x / 2), Math.round(g.y / 2), g.id || '', Math.round(tg.x), Math.round(tg.y)].join('|');

// Ask the game for exact heights along the line, the gun's muzzle height and the conditions.
async function arQuery(g, tg, force) {
  const key = arQKey(g, tg);
  if (!S.status.connected || AR.qBusy) return;
  if (!force && AR.q && AR.q.key === key && Date.now() - AR.qAt < AR_REQUERY_MS) return;
  const pts = [[g.x, g.y], [tg.x, tg.y]];
  for (let i = 1; i < AR_PROFILE_N; i++) { const f = i / AR_PROFILE_N; pts.push([g.x + (tg.x - g.x) * f, g.y + (tg.y - g.y) * f]); }
  AR.qBusy = true;
  try {
    const d = await arPost({ action: 'arty_query', points: pts, gun: g.live ? g.id : '' });
    AR.q = { key, data: d }; AR.qAt = Date.now(); AR.qErr = '';
  } catch (e) { AR.qErr = e.message; AR.qAt = Date.now(); }
  AR.qBusy = false;
  arSchedule();
}

// Recompute soon (several changes in one frame give one computation).
function arSchedule() {
  if (AR.calcTimer) return;
  AR.calcTimer = setTimeout(() => { AR.calcTimer = 0; arCompute(); }, 0);
}
function arWanted() {
  return AR.open || (typeof WS !== 'undefined' && WS.work && WS.work.panels.some((P) => P.pid === 'arty' || String(P.pid).startsWith('w-arty')));
}
function arCompute() {
  const c = arC();
  const g = arGun();
  AR.gun = g;
  if (arWanted() && AR.dbStatus.state === 'none' && S.status.connected && !AR.dbLoading) arLoadDb(); // asks the game to scan
  const tg = c.target;
  if (g.reason || !tg) { AR.res = null; arRender(); return; }
  const key = arQKey(g, tg);
  const q = AR.q && AR.q.key === key ? AR.q.data : null;
  if (arWanted()) arQuery(g, tg);
  const env = (q && q.env) || { ace: {}, tempC: 15, density: 1.225, wind: [0, 0] };
  // heights: a typed value, else the game's exact one, else the topo grid
  const topo = (x, y) => (typeof heightAt === 'function' ? heightAt(x, y) : null);
  const src = {};
  let gz;
  if (c.gunZ != null) { gz = c.gunZ; src.gun = 'manual'; }
  else if (q && q.gun) { gz = q.gun.muzzleZ; src.gun = 'game'; }
  else if (q) { gz = q.heights[0] + 1; src.gun = 'ground'; }
  else { const h = topo(g.x, g.y); gz = h == null ? 0 : h + 1; src.gun = h == null ? 'none' : 'topo'; }
  let tz;
  if (c.targetZ != null) { tz = c.targetZ; src.tgt = 'manual'; }
  else if (q) { tz = q.heights[1]; src.tgt = 'game'; }
  else { const h = topo(tg.x, tg.y); tz = h == null ? 0 : h; src.tgt = h == null ? 'none' : 'topo'; }
  const gx = q && q.gun ? q.gun.x : g.x, gy = q && q.gun ? q.gun.y : g.y;
  const model = Ballistics.dragModel(env, { scanner: g.veh.scanner, aceApply: g.veh.aceApply, mk6: g.veh.mk6 }, g.mag, g.ammo);
  const lim = { min: Ballistics.fromDeg(g.turret.minElev), max: Ballistics.fromDeg(g.turret.maxElev) };
  const wind = model.windOn ? env.wind : null;
  const sig = JSON.stringify([gx, gy, gz, tg.x, tg.y, tz, g.charges, model, lim, wind]);
  let T = AR.res && AR.res.sig === sig ? AR.res.T : null;
  if (!T) T = Ballistics.table([gx, gy, gz], [tg.x, tg.y, tz], g.charges, model, lim, wind);
  const arc = c.arc === 'high' ? 'high' : 'low';
  const auto = !(c.charge >= 0 && c.charge < T.rows.length);
  const i = auto ? T.best[arc] : c.charge;
  const row = i >= 0 ? T.rows[i] : null;
  const sol = row ? row[arc] : null;
  // ground under the line of fire: the game's samples, else the topo grid
  let prof = null;
  if (q && q.heights.length >= AR_PROFILE_N + 1) prof = [q.heights[0]].concat(q.heights.slice(2), [q.heights[1]]);
  else if (topo(g.x, g.y) != null) { prof = []; for (let k = 0; k <= AR_PROFILE_N; k++) { const f = k / AR_PROFILE_N; prof.push(topo(g.x + (tg.x - g.x) * f, g.y + (tg.y - g.y) * f)); } }
  AR.res = { sig, g, gun: [gx, gy, gz], tgt: [tg.x, tg.y, tz], T, arc, auto, i, row, sol, model, env, wind, lim, src, prof, q };
  arRender();
}

// ---------------------------------------------------------------- markup (shared by the panel and the workspace)
const AR_ICON = '<path d="M3 17h8l2-3"/><path d="M9 14l9-8"/><path d="M15.5 4.5l3 3"/><circle cx="6" cy="18.5" r="2"/><path d="M14 20h7"/>';
const AR_GEAR = '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>';
const arReasonText = (r) => tOr('ar.why.' + r, r);
function arSolText(s) {
  if (!s) return t('ar.no_sol');
  if (!s.ok) return t('ar.why.' + (s.reason || 'height'));
  if (s.limit) return t('ar.why.limit_' + s.limit);
  return '';
}
function arTile(key, r) {
  const s = arS(), sol = r && r.sol && r.sol.ok ? r.sol : null;
  let v = '—', sub = '', unit = '';
  const two = s.angle2 && s.angle2 !== s.angle;
  switch (key) {
    case 'az': v = arAng(sol && sol.az, s.angle, true); if (two && sol) sub = arAng(sol.az, s.angle2, true); unit = arUnitName(s.angle); break;
    case 'el': v = arAng(sol && sol.elev, s.angle); if (two && sol) sub = arAng(sol.elev, s.angle2); unit = arUnitName(s.angle); break;
    case 'charge': v = r && r.row ? esc(r.row.name) : '—'; sub = r && r.row ? `${Math.round(r.row.mv)} m/s` : ''; unit = r && r.auto ? t('ar.auto') : ''; break;
    case 'tof': v = arSec(sol && sol.tof); break;
    case 'range': v = arDist(r && Math.hypot(r.tgt[0] - r.gun[0], r.tgt[1] - r.gun[1])); break;
    case 'dz': v = arDist(r && r.tgt[2] - r.gun[2], true); break;
    case 'maxOrd': v = arDist(sol && sol.maxOrd); sub = sol ? `${Math.round(r.gun[2] + sol.maxOrd)} m ASL` : ''; break;
    case 'impact': v = arAng(sol && sol.impactAngle, s.angle === 'deg' ? 'deg' : s.angle); break;
    case 'drift': v = arDist(sol && sol.drift, true); break;
    case 'mv': v = r && r.row ? `${Math.round(r.row.mv)} m/s` : '—'; break;
  }
  return `<div class="ar-tile ar-t-${key}"><span class="ar-tl">${esc(t('ar.f.' + key))}${unit ? ` <i>${esc(unit)}</i>` : ''}</span>`
    + `<b class="ar-tv" dir="ltr">${v}</b>${sub ? `<span class="ar-ts" dir="ltr">${sub}</span>` : ''}</div>`;
}
function arControls(r) {
  const c = arC();
  const n = r ? r.T.rows.length : 0;
  return `<div class="ar-ctl">`
    + `<div class="seg ar-arc" role="group" aria-label="${esc(t('ar.arc'))}">`
    + `<button type="button" data-ar="arc-low" class="${c.arc !== 'high' ? 'active' : ''}">${esc(t('ar.low'))}</button>`
    + `<button type="button" data-ar="arc-high" class="${c.arc === 'high' ? 'active' : ''}">${esc(t('ar.high'))}</button></div>`
    + `<div class="ar-chs" role="group" aria-label="${esc(t('ar.f.charge'))}">`
    + `<button type="button" class="btn" data-ar="ch-prev" ${n ? '' : 'disabled'} aria-label="${esc(t('ar.ch_prev'))}">−</button>`
    + `<button type="button" class="btn${r && r.auto ? ' on' : ''}" data-ar="ch-auto" ${n ? '' : 'disabled'}>${esc(t('ar.auto'))}</button>`
    + `<button type="button" class="btn" data-ar="ch-next" ${n ? '' : 'disabled'} aria-label="${esc(t('ar.ch_next'))}">+</button></div></div>`;
}
function arStatusLine(r) {
  const g = AR.gun;
  if (!g || g.reason) return `<div class="ar-msg">${esc(arReasonText(g ? g.reason : 'nodb'))}${g && g.reason === 'scanning' ? ` <span dir="ltr">${Math.round((AR.dbStatus.progress || 0) * 100)}%</span>` : ''}</div>`;
  if (!arC().target) return `<div class="ar-msg">${esc(t('ar.why.notarget'))}</div>`;
  if (!r) return '';
  if (!r.row) {
    // automatic charge and nothing works on this arc: say why, and whether the other arc works
    const other = r.arc === 'high' ? 'low' : 'high';
    if (r.T.best[other] >= 0) return `<div class="ar-msg ar-bad">${esc(t('ar.why.other_' + other))}</div>`;
    const all = r.T.rows.flatMap((x) => [x.low, x.high]);
    const far = all.length && all.every((x) => !x.ok && x.reason === 'far');
    const reach = Math.max(0, ...r.T.rows.flatMap((x) => (x.reach ? [x.reach.low, x.reach.high] : [])).filter(Boolean).map((x) => x.max));
    return `<div class="ar-msg ar-bad">${esc(far ? t('ar.why.toofar', { max: arDist(reach) }) : t('ar.why.none'))}</div>`;
  }
  const why = arSolText(r.sol);
  return why ? `<div class="ar-msg ar-bad">${esc(why)}</div>` : '';
}
function arSimpleHtml(r, compact) {
  const fields = arS().fields.length ? arS().fields : ['az', 'el'];
  return arStatusLine(r)
    + `<div class="ar-tiles${compact ? ' ar-compact' : ''}">${fields.map((k) => arTile(k, r)).join('')}</div>`
    + arControls(r)
    + `<div class="ar-fm" data-ar-fm>${esc(t('ar.fm.none'))}</div>`;
}
function arTableHtml(r, noStatus) {
  if (!r) return noStatus ? '' : arStatusLine(r);
  const s = arS();
  const cell = (row, arc, i) => {
    const x = row[arc];
    const sel = r.i === i && r.arc === arc;
    const best = r.T.best[arc] === i;
    if (!x.ok) return `<td class="ar-na" colspan="2" title="${esc(arSolText(x))}">${esc(t('ar.why.short_' + (x.reason || 'height')))}</td>`;
    const cls = ['ar-pick', sel ? 'sel' : '', x.limit ? 'lim' : '', best ? 'best' : ''].join(' ');
    return `<td class="${cls}" data-ar="pick" data-i="${i}" data-arc="${arc}" dir="ltr" title="${esc(x.limit ? arSolText(x) : '')}">${arAng(x.elev, s.angle)}</td>`
      + `<td class="${cls}" data-ar="pick" data-i="${i}" data-arc="${arc}" dir="ltr">${arSec(x.tof)}</td>`;
  };
  // what this charge reaches inside the gun's elevation limits, both arcs together
  const reach = (rc) => {
    const sp = rc ? [rc.low, rc.high].filter(Boolean) : [];
    if (!sp.length) return '—';
    const km = (m) => (m / 1000).toFixed(1);
    return `${km(Math.min(...sp.map((x) => x.min)))}–${km(Math.max(...sp.map((x) => x.max)))} km`;
  };
  let h = (noStatus ? '' : arStatusLine(r)) + `<div class="ar-tablewrap"><table class="ar-table"><thead><tr><th rowspan="2">${esc(t('ar.f.charge'))}</th>`
    + `<th colspan="2">${esc(t('ar.low'))}</th><th colspan="2">${esc(t('ar.high'))}</th><th rowspan="2">${esc(t('ar.reach'))}</th></tr>`
    + `<tr><th>${esc(t('ar.col.el'))}</th><th>${esc(t('ar.col.tof'))}</th><th>${esc(t('ar.col.el'))}</th><th>${esc(t('ar.col.tof'))}</th></tr></thead><tbody>`;
  r.T.rows.forEach((row, i) => {
    h += `<tr><th scope="row"><bdi>${esc(row.name)}</bdi><span class="ar-mv" dir="ltr">${Math.round(row.mv)} m/s</span></th>`
      + cell(row, 'low', i) + cell(row, 'high', i)
      + `<td class="ar-rg" dir="ltr">${reach(row.reach)}</td></tr>`;
  });
  h += '</tbody></table></div>';
  // the selected solution in detail
  const x = r.sol && r.sol.ok ? r.sol : null;
  const kv = (k, v) => `<span>${esc(k)}</span><span dir="ltr">${v}</span>`;
  h += `<div class="d-kv ar-kv">`
    + kv(t('ar.f.az'), arAng(x && x.az, s.angle, true) + (x && Math.abs(x.az - x.azGeo) > 1e-6 ? ` <small>(${esc(t('ar.wind_aim'))} ${arAng(x.az - x.azGeo, s.angle)})</small>` : ''))
    + kv(t('ar.f.maxOrd'), x ? `${arDist(x.maxOrd)} · ${Math.round(r.gun[2] + x.maxOrd)} m ASL` : '—')
    + kv(t('ar.f.impact'), arAng(x && x.impactAngle, s.angle === 'deg' ? 'deg' : s.angle))
    + kv(t('ar.f.drift'), arDist(x && x.drift, true))
    + kv(t('ar.f.range'), arDist(Math.hypot(r.tgt[0] - r.gun[0], r.tgt[1] - r.gun[1])))
    + kv(t('ar.gun_h'), `${r.gun[2].toFixed(1)} m · ${esc(t('ar.src.' + r.src.gun))}`)
    + kv(t('ar.tgt_h'), `${r.tgt[2].toFixed(1)} m · ${esc(t('ar.src.' + r.src.tgt))}`)
    + kv(t('ar.model'), esc(arModelText(r)))
    + `</div>`;
  return h;
}
function arModelText(r) {
  const m = r.model;
  if (Ballistics.isVacuum(m)) return t('ar.model.vacuum');
  const parts = [t('ar.model.' + m.source)];
  if (m.kAce) parts.push(`k ${(m.kAce * 1e5).toFixed(2)}e-5`);
  if (m.kEng) parts.push(`${t('ar.model.engine')} ${(m.kEng * 1e5).toFixed(2)}e-5`);
  if (m.windOn && r.env.wind) parts.push(`${t('ar.wind')} ${Math.hypot(r.env.wind[0], r.env.wind[1]).toFixed(1)} m/s`);
  if (m.mvScale !== 1) parts.push(`${r.env.tempC.toFixed(1)} °C`);
  return parts.join(' · ');
}
// Side view: ground under the line of fire and the selected trajectory over it.
function arProfileHtml(r) {
  if (!r) return '';
  const x = r.sol && r.sol.ok ? r.sol : null;
  const range = Math.hypot(r.tgt[0] - r.gun[0], r.tgt[1] - r.gun[1]);
  if (!range) return '';
  let path = null, clips = false;
  if (x) {
    const sh = Ballistics.fly(r.row.mv, x.elev, r.tgt[2] - r.gun[2], r.model, r.wind ? Ballistics.windComps(r.wind, x.az) : null, true);
    path = sh && sh.path ? sh.path.map(([d, z]) => [d, r.gun[2] + z]) : null;
  }
  const ground = r.prof ? r.prof.map((h, k) => [range * k / (r.prof.length - 1), h]) : [[0, r.gun[2] - 1], [range, r.tgt[2]]];
  const gAt = (d) => {
    const f = Math.max(0, Math.min(1, d / range)) * (ground.length - 1), k = Math.min(ground.length - 2, Math.floor(f));
    return ground[k][1] + (ground[k + 1][1] - ground[k][1]) * (f - k);
  };
  if (path) clips = path.some(([d, z]) => d > range * 0.03 && d < range * 0.97 && z < gAt(d) - 1);
  const zs = ground.map((p) => p[1]).concat(path ? path.map((p) => p[1]) : []);
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  const W = 600, H = 200, P = 8;
  const sx = (d) => P + (d / range) * (W - 2 * P);
  const sy = (z) => H - P - ((z - zMin) / Math.max(1, zMax - zMin)) * (H - 2 * P - 14);
  const pts = (arr) => arr.map(([d, z]) => `${sx(d).toFixed(1)},${sy(z).toFixed(1)}`).join(' ');
  const gpoly = `${sx(0)},${H - P} ${pts(ground)} ${sx(range)},${H - P}`;
  let apex = '';
  if (path && x) {
    const top = path.reduce((a, p) => (p[1] > a[1] ? p : a), path[0]);
    apex = `<text x="${sx(top[0]).toFixed(1)}" y="${(sy(top[1]) - 4).toFixed(1)}" text-anchor="middle" class="ar-pt">${Math.round(top[1])} m</text>`;
  }
  return `<div class="ar-prof"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('ar.profile'))}" preserveAspectRatio="none">`
    + `<polygon points="${gpoly}" class="ar-ground"/>`
    + (path ? `<polyline points="${pts(path)}" class="ar-traj${clips ? ' clip' : ''}"/>` : '')
    + `<circle cx="${sx(0)}" cy="${sy(r.gun[2])}" r="5" class="ar-pg"/><circle cx="${sx(range)}" cy="${sy(r.tgt[2])}" r="5" class="ar-ptg"/>`
    + apex + `</svg>`
    + `<div class="ar-prof-l"><span>${esc(t('ar.profile'))}</span>${r.prof ? '' : `<span class="muted">${esc(t('ar.no_profile'))}</span>`}`
    + (clips ? `<span class="ar-bad">${esc(t('ar.clips'))}</span>` : '') + `</div></div>`;
}

// ---------------------------------------------------------------- the panel
function arPanelEl() { return $('#arty'); }
function arBuild() {
  const el = arPanelEl();
  if (!el || el._built) return;
  el._built = true;
  el.innerHTML = `<div class="ar-head">
      <span class="ar-ic">${dIcon('arty', 20)}</span><b class="ar-title"></b>
      <div class="seg small ar-view" role="tablist">
        <button type="button" data-ar="view-simple"></button><button type="button" data-ar="view-full"></button></div>
      <span class="spacer"></span>
      <button type="button" class="icon-btn" data-ar="settings">${dIcon('argear', 18)}</button>
      <button type="button" class="icon-btn" data-ar="close"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="ar-body">
      <div class="ar-inputs">
        <div class="ar-row"><span class="ar-lbl" data-l="gun"></span>
          <div class="seg small ar-gm"><button type="button" data-ar="gm-mine"></button><button type="button" data-ar="gm-unit"></button><button type="button" data-ar="gm-manual"></button></div></div>
        <div class="ar-row ar-gun-unit"><select class="ar-sel" data-in="gunId" dir="auto"></select></div>
        <div class="ar-row ar-gun-manual"><input class="ar-grid" data-in="gunGrid" inputmode="numeric" autocomplete="off" dir="ltr" maxlength="14">
          <select class="ar-sel" data-in="veh" dir="auto"></select></div>
        <div class="ar-row ar-gun-err ar-bad" data-out="gunErr" hidden></div>
        <div class="ar-row"><span class="ar-lbl" data-l="ammo"></span><select class="ar-sel" data-in="weapon" dir="auto"></select><select class="ar-sel" data-in="mag" dir="auto"></select></div>
        <div class="ar-row"><span class="ar-lbl" data-l="target"></span>
          <input class="ar-grid" data-in="tgtGrid" inputmode="numeric" autocomplete="off" dir="ltr" maxlength="14">
          <button type="button" class="btn primary ar-go" data-ar="calc"></button></div>
        <div class="ar-row ar-bad" data-out="tgtErr" hidden></div>
        <details class="ar-more"><summary data-l="heights"></summary>
          <div class="ar-row"><label class="ar-h"><span data-l="gun_h"></span><input type="number" step="0.1" data-in="gunZ" dir="ltr"></label>
          <label class="ar-h"><span data-l="tgt_h"></span><input type="number" step="0.1" data-in="targetZ" dir="ltr"></label></div>
          <p class="muted small" data-l="heights_help"></p></details>
      </div>
      <div class="ar-out"></div>
    </div>`;
  el.addEventListener('change', arOnInput);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.ar-grid')) { e.preventDefault(); arOnInput({ target: e.target }); arRefresh(); }
  });
}
// Fills the static texts and the inputs from the state (skips the field being typed in).
function arFillInputs() {
  const el = arPanelEl();
  if (!el || !el._built) return;
  const c = arC(), g = AR.gun;
  el.querySelector('.ar-title').textContent = t('ar.title');
  el.querySelectorAll('[data-l]').forEach((x) => { x.textContent = t('ar.' + x.dataset.l); });
  const vb = el.querySelectorAll('.ar-view button');
  vb[0].textContent = t('ar.view.simple'); vb[1].textContent = t('ar.view.full');
  vb[0].classList.toggle('active', AR.view !== 'full'); vb[1].classList.toggle('active', AR.view === 'full');
  const gm = el.querySelectorAll('.ar-gm button');
  ['mine', 'unit', 'manual'].forEach((m, i) => { gm[i].textContent = t('ar.gm.' + m); gm[i].classList.toggle('active', c.gunMode === m); });
  el.querySelector('[data-ar="settings"]').title = t('ar.settings');
  el.querySelector('[data-ar="close"]').title = t('ar.close');
  el.querySelector('.ar-go').textContent = t('ar.calc');
  el.querySelector('.ar-gun-unit').hidden = c.gunMode !== 'unit';
  el.querySelector('.ar-gun-manual').hidden = c.gunMode !== 'manual';
  const focus = document.activeElement;
  const setOpts = (sel, opts, val) => {
    const html = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    if (sel._h !== html) { sel._h = html; sel.innerHTML = html; }
    if (focus !== sel) sel.value = val;
  };
  // gun choices
  const list = arGunList();
  setOpts(el.querySelector('[data-in="gunId"]'), [['', t('ar.pick_gun')]].concat(list.map(({ v, d }) =>
    [v.id, `${arVeh(v.cls).name || v.cls} · ${arGrid(v.x, v.y, 6)} · ${(d / 1000).toFixed(1)} km`])), c.gunId);
  const vehs = AR.db ? AR.db.vehicles : [];
  setOpts(el.querySelector('[data-in="veh"]'), [['', t('ar.pick_type')]].concat(vehs.map((v) => [v.cls, v.name || v.cls])), c.veh);
  const gi = el.querySelector('[data-in="gunGrid"]');
  gi.placeholder = t('ar.grid_ph');
  if (focus !== gi && !AR.gridErr.gun) gi.value = c.manual ? arGrid(c.manual.x, c.manual.y) : '';
  const ok = g && !g.reason;
  setOpts(el.querySelector('[data-in="weapon"]'), ok ? g.guns.map((x) => [x.w.cls, x.w.name || x.w.cls]) : [['', '—']], ok ? g.weapon.cls : '');
  setOpts(el.querySelector('[data-in="mag"]'), ok ? g.mags.map((m) => [m.cls, m.name || m.cls]) : [['', '—']], ok ? g.mag.cls : '');
  const ti = el.querySelector('[data-in="tgtGrid"]');
  ti.placeholder = t('ar.grid_ph');
  if (focus !== ti && !AR.gridErr.target) ti.value = c.target ? arGrid(c.target.x, c.target.y) : '';
  for (const k of ['gunZ', 'targetZ']) {
    const inp = el.querySelector(`[data-in="${k}"]`);
    if (focus !== inp) inp.value = c[k] == null ? '' : c[k];
    inp.placeholder = t('ar.auto');
  }
  const ge = el.querySelector('[data-out="gunErr"]'), te = el.querySelector('[data-out="tgtErr"]');
  ge.hidden = !AR.gridErr.gun; ge.textContent = AR.gridErr.gun;
  te.hidden = !AR.gridErr.target; te.textContent = AR.gridErr.target;
}
function arOnInput(e) {
  const k = e.target.dataset.in;
  if (!k) return;
  const v = e.target.value;
  if (k === 'gunId') arSet({ calc: { gunId: v } });
  else if (k === 'veh') arSet({ calc: { veh: v, weapon: '', mag: '', charge: -1 } });
  else if (k === 'weapon') arSet({ calc: { weapon: v, mag: '', charge: -1 } });
  else if (k === 'mag') arSet({ calc: { mag: v } });
  else if (k === 'gunZ' || k === 'targetZ') {
    const n = v.trim() === '' ? null : Number(v);
    arSet({ calc: { [k]: n == null || !Number.isFinite(n) ? null : n } });
  } else if (k === 'tgtGrid' || k === 'gunGrid') {
    const which = k === 'tgtGrid' ? 'target' : 'gun';
    if (!v.trim()) { AR.gridErr[which] = ''; arSet({ calc: which === 'target' ? { target: null } : { manual: null } }); return; }
    const p = arParseGrid(v);
    AR.gridErr[which] = p ? '' : t('ar.grid_bad');
    if (p) arSet({ calc: which === 'target' ? { target: { x: p.x, y: p.y } } : { manual: { x: p.x, y: p.y } } });
    else arRender();
  }
}
function arRender() {
  arFillInputs();
  const el = arPanelEl();
  if (el && el._built && AR.open) {
    const r = AR.res;
    const html = AR.view === 'full' ? arTableHtml(r) + arProfileHtml(r) : arSimpleHtml(r);
    const out = el.querySelector('.ar-out');
    if (out._h !== html) { out._h = html; out.innerHTML = html; }
  }
  if (typeof wsRenderAll === 'function' && typeof WS !== 'undefined' && WS.ready) wsRenderAll();
}
// Recalculate now: ask the game again (fresh heights, wind, gun position).
function arRefresh() {
  const g = AR.gun, tg = arC().target;
  if (g && !g.reason && tg) arQuery(g, tg, true);
  arSchedule();
}
function artyOpen(on) {
  AR.open = on == null ? !AR.open : !!on;
  storeSet('arty.open', AR.open);
  arBuild();
  const el = arPanelEl();
  if (el) el.hidden = !AR.open;
  const b = $('#btn-arty');
  if (b) b.setAttribute('aria-pressed', AR.open ? 'true' : 'false');
  if (AR.open) { if (!AR.db) arLoadDb(); arSchedule(); }
}

// ---------------------------------------------------------------- actions (panel, workspace parts, keys)
function arAction(a, el) {
  const c = arC();
  const n = AR.res ? AR.res.T.rows.length : 0;
  const cur = AR.res ? AR.res.i : -1;
  switch (a) {
    case 'arc-low': arSet({ calc: { arc: 'low' } }); break;
    case 'arc-high': arSet({ calc: { arc: 'high' } }); break;
    case 'arc': arSet({ calc: { arc: c.arc === 'high' ? 'low' : 'high' } }); break;
    case 'ch-auto': arSet({ calc: { charge: -1 } }); break;
    case 'ch-next': if (n) arSet({ calc: { charge: cur < 0 ? 0 : (cur + 1) % n } }); break;
    case 'ch-prev': if (n) arSet({ calc: { charge: cur <= 0 ? n - 1 : cur - 1 } }); break;
    case 'pick': arSet({ calc: { charge: Number(el.dataset.i), arc: el.dataset.arc === 'high' ? 'high' : 'low' } }); break;
    case 'view-simple': AR.view = 'simple'; storeSet('arty.view', AR.view); arRender(); break;
    case 'view-full': AR.view = 'full'; storeSet('arty.view', AR.view); arRender(); break;
    case 'gm-mine': case 'gm-unit': case 'gm-manual': arSet({ calc: { gunMode: a.slice(3), weapon: '', mag: '', charge: -1 } }); break;
    case 'calc': {
      const inp = arPanelEl().querySelector('[data-in="tgtGrid"]');
      if (inp && inp.value.trim()) arOnInput({ target: inp });
      arRefresh(); break;
    }
    case 'settings': arShowSettings(); break;
    case 'close': artyOpen(false); break;
    case 'open': artyOpen(true); break;
  }
}
function arShowSettings() {
  const tabBtn = document.querySelector('.tabs button[data-tab="layers"]');
  if (tabBtn) tabBtn.click();
  if ($('#app').classList.contains('panel-closed')) $('#btn-panel').click();
  const box = $('#arty-set');
  if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function arOnKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  const tg = e.target;
  if (tg && (tg.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(tg.tagName))) return;
  if (!arWanted() || (typeof WS !== 'undefined' && WS.edit)) return;
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { arRefresh(); e.preventDefault(); }
  else if (e.code === 'KeyH') { arAction('arc'); e.preventDefault(); }
  else if (e.code === 'KeyC') { arAction(e.shiftKey ? 'ch-prev' : 'ch-next'); e.preventDefault(); }
}

// ---------------------------------------------------------------- settings (Settings tab)
function arRenderSettings() {
  const box = $('#arty-set');
  if (!box) return;
  const s = arS();
  const seg = (key, opts, fmt) => `<div class="seg ar-seg" data-set="${key}">${opts.map((o) =>
    `<button type="button" data-v="${esc(String(o))}" class="${String(s[key]) === String(o) ? 'active' : ''}">${esc(fmt(o))}</button>`).join('')}</div>`;
  const fields = s.fields.concat(AR_FIELDS.filter((f) => !s.fields.includes(f)));
  const html = `<h3>${esc(t('ar.set.title'))}</h3>`
    + `<label class="field"><span>${esc(t('ar.set.angle'))}</span>${seg('angle', ['nato', 'wp', 'deg'], arUnitName)}</label>`
    + `<label class="field"><span>${esc(t('ar.set.angle2'))}</span>${seg('angle2', ['', 'nato', 'wp', 'deg'], (o) => (o ? arUnitName(o) : t('ar.set.none')))}</label>`
    + `<label class="field"><span>${esc(t('ar.set.dist'))}</span>${seg('dist', ['m', 'km'], (o) => t('ar.set.dist_' + o))}</label>`
    + `<label class="field"><span>${esc(t('ar.set.grid'))}</span>${seg('grid', [6, 8, 10], (o) => t('ar.set.grid_n', { n: o }))}</label>`
    + `<label class="field"><span>${esc(t('ar.set.dec'))}</span>${seg('dec', [0, 1, 2, 3], String)}</label>`
    + `<div class="field"><span>${esc(t('ar.set.fields'))}</span><ol class="ar-fields">${fields.map((f) => {
      const on = s.fields.includes(f), i = s.fields.indexOf(f);
      return `<li class="${on ? '' : 'off'}"><label class="check"><input type="checkbox" data-fld="${f}" ${on ? 'checked' : ''}> <span>${esc(t('ar.f.' + f))}</span></label>`
        + (on ? `<button type="button" class="icon-btn" data-fup="${f}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('ar.set.up'))}">▲</button>`
          + `<button type="button" class="icon-btn" data-fdown="${f}" ${i === s.fields.length - 1 ? 'disabled' : ''} aria-label="${esc(t('ar.set.down'))}">▼</button>` : '')
        + `</li>`;
    }).join('')}</ol></div>`
    + `<label class="check"><input type="checkbox" data-setb="sound" ${s.sound ? 'checked' : ''}> <span>${esc(t('ar.set.sound'))}</span></label>`
    + `<label class="check"><input type="checkbox" data-setb="vibrate" ${s.vibrate ? 'checked' : ''}> <span>${esc(t('ar.set.vibrate'))}</span></label>`
    + `<label class="field"><span>${esc(t('ar.set.splash'))}</span><input class="num" type="number" min="1" max="30" step="1" data-setn="splash" value="${s.splash}" dir="ltr"></label>`
    + `<label class="field"><span>${esc(t('ar.set.tol'))}</span><input class="num" type="number" min="0.5" max="50" step="0.5" data-setn="tol" value="${s.tol}" dir="ltr"></label>`
    + `<p class="muted small">${esc(t('ar.set.help'))}</p>`;
  if (box._h !== html && !box.contains(document.activeElement && document.activeElement.matches('input[type=number]') ? document.activeElement : null)) {
    box._h = html; box.innerHTML = html;
  }
}
function arSettingsEvents() {
  const box = $('#arty-set');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set] button');
    if (b) {
      const key = b.closest('[data-set]').dataset.set;
      const v = ['grid', 'dec'].includes(key) ? Number(b.dataset.v) : b.dataset.v;
      arSet({ settings: { [key]: v } });
      return;
    }
    const up = e.target.closest('[data-fup],[data-fdown]');
    if (up) {
      const f = up.dataset.fup || up.dataset.fdown, list = arS().fields.slice(), i = list.indexOf(f), j = i + (up.dataset.fup ? -1 : 1);
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      arSet({ settings: { fields: list } });
    }
  });
  box.addEventListener('change', (e) => {
    const f = e.target.dataset.fld;
    if (f) {
      const list = arS().fields.filter((x) => x !== f);
      if (e.target.checked) list.push(f);
      arSet({ settings: { fields: list } });
      return;
    }
    if (e.target.dataset.setb) { arSet({ settings: { [e.target.dataset.setb]: e.target.checked } }); return; }
    if (e.target.dataset.setn) {
      const n = Number(e.target.value);
      if (Number.isFinite(n)) arSet({ settings: { [e.target.dataset.setn]: n } });
    }
  });
}

// ---------------------------------------------------------------- workspace parts
function arRegisterWorkspace() {
  if (typeof wsComp !== 'function') return;
  const C = WS_PREF.compact;
  const base = { cat: 'weapons', icon: 'arty', entity: false };
  wsComp(Object.assign({ id: 'arty-sol', size: 'L', wsize: { w: 340, h: 300 }, min: { w: 200, h: 150 },
    render: (d, ctx) => `<div class="ar-ws">${arSimpleHtml(AR.res, ctx && ctx.P && ctx.P.prefs && ctx.P.prefs.compact)}</div>` }, base));
  wsComp(Object.assign({ id: 'arty-table', size: 'L', wsize: { w: 460, h: 420 }, min: { w: 280, h: 180 },
    // inside the calculator panel next to the solution part, the status line is shown once
    render: (d, ctx) => `<div class="ar-ws">${arTableHtml(AR.res, ctx && ctx.host === 'arty' && wsCVisible(ctx.P, 'arty-sol'))}</div>` }, base));
  wsComp(Object.assign({ id: 'arty-prof', size: 'L', wsize: { w: 460, h: 240 }, min: { w: 240, h: 140 },
    render: (d, ctx) => `<div class="ar-ws">${AR.res ? arProfileHtml(AR.res) : (ctx && ctx.host === 'arty' ? '' : arStatusLine(null))}</div>` }, base));
  wsRegister({ id: 'arty', cat: 'weapons', icon: 'arty', entity: false, size: { w: 420, h: 620 }, min: { w: 260, h: 220 }, prefs: [C],
    render: wsCompsRender('arty'), comps: [['arty-sol', 'L'], ['arty-table', 'L'], ['arty-prof', 'L']] });
}

// ---------------------------------------------------------------- start
function artyInit() {
  AR.open = storeGet('arty.open', false);
  AR.view = storeGet('arty.view', 'simple') === 'full' ? 'full' : 'simple';
  if (typeof DICON === 'object') { DICON.arty = AR_ICON; DICON.argear = AR_GEAR; }
  arRegisterWorkspace();
  arSettingsEvents();
  arRenderSettings();
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ar]');
    if (b && !b.disabled) arAction(b.dataset.ar, b);
  });
  document.addEventListener('keydown', arOnKey);
  const btn = $('#btn-arty');
  if (btn) btn.addEventListener('click', () => artyOpen());
  if (new URLSearchParams(location.search).has('arty')) AR.open = true;
  artyOpen(AR.open);
  setInterval(() => { if (arWanted() && AR.gun && !AR.gun.reason && arC().target) arCompute(); }, AR_REQUERY_MS);
}
// The game's state changed (positions of friendly guns, the vehicle I am in).
function artyOnGameState() {
  if (arWanted()) arSchedule();
}
function artyOnLang() {
  arRenderSettings();
  const el = arPanelEl();
  if (el) { const out = el.querySelector('.ar-out'); if (out) out._h = ''; }
  arRender();
}
