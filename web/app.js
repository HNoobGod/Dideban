'use strict';

// ============================================================ basics

const $ = (sel) => document.querySelector(sel);
const canvas = $('#map');
const ctx = canvas.getContext('2d');

const SIDE_COLOR = { WEST: '#2a6fdb', EAST: '#d03c3c', GUER: '#2f9e44', CIV: '#9b4dca' };
const SIDE_NAME = { WEST: 'BLUFOR', EAST: 'OPFOR', GUER: 'Independent', CIV: 'Civilian' };
const CHANNEL_NAME = ['Global', 'Side', 'Command', 'Group', 'Vehicle', 'Direct'];
const tOr = (key, fallback) => { const s = t(key); return s === key ? fallback : s; };
const COMMON_TYPES = [
  'mil_dot', 'mil_triangle', 'mil_box', 'mil_circle', 'mil_flag', 'mil_warning', 'mil_objective',
  'mil_destroy', 'mil_pickup', 'mil_join', 'mil_ambush', 'mil_start', 'mil_end', 'mil_arrow',
  'mil_arrow2', 'mil_marker', 'mil_unknown',
];
const FALLBACK_COLORS = [
  ['ColorBlack', 'Black', [0, 0, 0, 1]], ['ColorRed', 'Red', [0.9, 0, 0, 1]],
  ['ColorGreen', 'Green', [0, 0.8, 0, 1]], ['ColorBlue', 'Blue', [0, 0, 1, 1]],
  ['ColorYellow', 'Yellow', [0.85, 0.85, 0, 1]], ['ColorOrange', 'Orange', [0.85, 0.4, 0, 1]],
  ['ColorWhite', 'White', [1, 1, 1, 1]],
].map(([cls, name, rgba]) => ({ cls, name, rgba }));

// Every feature that can be switched off in Settings (stored per browser).
const DEFAULT_LAYERS = {
  grid: true, gridLabels: true, names: true, heights: true, contours: true, roads: true, buildings: true,
  markers: true, units: true, labels: true, aiNames: true, groups: true, civ: false, empty: true, health: true,
  facing: true, cones: true, smooth: true, compass: true, tools: true, cursor: true,
  models3d: true, models3dScale: true, buildings3d: true, hint: true,
  camera: false, // camera view, game view and helmet cams: hidden until switched on in Settings
};

function storeGet(key, fallback) {
  try {
    const v = localStorage.getItem('a3map.' + key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function storeSet(key, value) {
  try { localStorage.setItem('a3map.' + key, JSON.stringify(value)); } catch { /* private mode */ }
}

const S = {
  sse: false,
  status: {},
  meta: { colors: [], types: [] },
  state: null,
  progress: {},
  terrain: null,
  terrainWorld: null,
  terrainLoading: false,
  maps: [],                              // maps the server has (terrain and/or satellite)
  mapChoice: storeGet('map', 'auto'),    // 'auto' = follow the game, or a map key
  style: storeGet('style', 'sat'),       // 'topo' | 'sat' | 'mix'
  sat: null,                             // { key, info, tiles: Map }
  dem: null,                             // { key, n, step, heights } from grad_meh, when there is no topo export
  dim: storeGet('dim', '2d'),            // '2d' | '3d'
  gridDigits: storeGet('grid', 6),       // 6 (100 m) or 8 (10 m) digit grid references
  bright: storeGet('bright', 1),         // map brightness multiplier
  iconScale: storeGet('iconScale', 1),   // size of unit, vehicle and marker icons
  // Ammo-count colouring on the detail page. Magazines: >= magHigh green, >= magLow yellow,
  // >0 red, 0 "empty" (dark). Throwables (smokes/flares/grenades): >= throwMin green, >0 red,
  // 0 hidden. All three are set in Settings and remembered per browser.
  magHigh: storeGet('magHigh', 4),
  magLow: storeGet('magLow', 2),
  throwMin: storeGet('throwMin', 2),
  compassScale: storeGet('compassScale', 1),
  compassPos: storeGet('compassPos', null), // [x, y] of the compass centre, or null = top-left corner
  followId: null,                        // unit/vehicle followed instead of the player
  camId: null,                           // unit/vehicle whose camera view is shown
  camLook: { yaw: 0, pitch: 0, fov: 60 }, // look-around offset in the camera view
  camSource: storeGet('camSource', 'map'), // camera view source: 'map' (3D from map data) | 'game' (real picture)
  view: { cx: 4096, cy: 4096, scale: 0.05, rot: 0, userMoved: false, centered: false, fitted: false },
  orient: storeGet('orient', 'north'),   // 'north' = map fixed, player icon turns; 'heading' = map turns, player fixed
  tool: 'select',                        // map tool: 'select' | 'marker' | 'line' | 'text'
  linePts: [],                           // points of the line being drawn
  W: 1, H: 1, dpr: 1,
  layers: Object.assign({}, DEFAULT_LAYERS, storeGet('layers', {})),
  follow: false,
  selected: null, // { kind: 'unit' | 'veh' | 'marker', id }
  dirty: false,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n, d) => String(Math.max(0, Math.floor(n))).padStart(d, '0');
// 6 digits = 100 m squares ("035 045"), 8 digits = 10 m squares ("0358 0452").
const gridRef = (x, y) => (S.gridDigits === 8
  ? `${pad(x / 10, 4)} ${pad(y / 10, 4)}`
  : `${pad(x / 100, 3)} ${pad(y / 100, 3)}`);
const rgba = (c, mul = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${(c[3] ?? 1) * mul})`;
const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

// ============================================================ view

const wkey = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
function gameKey() { return S.status.world ? wkey(S.status.world) : null; }
function viewKey() { return S.mapChoice === 'auto' ? gameKey() : S.mapChoice; }
function viewMap() { return S.maps.find((m) => m.key === viewKey()) || null; }
function onGameMap() { return !!gameKey() && viewKey() === gameKey(); }
function hasSat() { return !!(S.sat && S.sat.key === viewKey()); }
function effectiveStyle() {
  const sat = hasSat(), topo = !!S.terrain;
  if (S.style === 'mix') return sat && topo ? 'mix' : sat ? 'sat' : 'topo';
  if (S.style === 'sat') return sat ? 'sat' : 'topo';
  return topo || !sat ? 'topo' : 'sat';
}

function worldSize() {
  const m = viewMap();
  return (S.terrain && S.terrain.size) || (hasSat() && S.sat.info.worldSize) || (m && m.size) ||
    (onGameMap() && S.status.worldSize) || 8192;
}
const OFF = [-1e5, -1e5];
function is3d() { return (S.dim === '3d' || !!S.camId) && View3D.hasTerrain(); }

// ?cam=<unit id>: this window only shows the camera view of that unit.
const POPUP_CAM = new URLSearchParams(location.search).get('cam');

// 2D map rotation (radians): 0 = north up; in heading-up mode, the player's heading.
// While raster layers are drawn under a rotated canvas transform, w2s ignores the rotation.
let rotOff = false;
function mapRot() { return is3d() ? View3D.cam.yaw : S.view.rot; }
function rotVec(x, y, a) { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; }

// World -> screen. In 3D, z is the height in metres (default: on the ground).
// Horizontal anchor of the map centre. When the detail panel covers part of the map, the centre
// slides into the still-visible band so "center on me" / follow land in the middle of what you see.
let detailShiftPx = 0;
function vcx() { return S.W / 2 + detailShiftPx; }
function updateViewShift() {
  detailShiftPx = 0;
  const d = $('#detail');
  if (!d || d.hidden || d.classList.contains('full') || appEl.classList.contains('detail-window')) { redraw(); return; }
  const cr = canvas.getBoundingClientRect();
  const dr = d.getBoundingClientRect();
  if (dr.width > 0 && cr.width > 0) {
    const leftFree = dr.left - cr.left, rightFree = cr.right - dr.right;
    if (Math.max(leftFree, rightFree) >= 220) {
      detailShiftPx = (rightFree >= leftFree) ? (dr.right - cr.left) / 2 : (dr.left - cr.left) / 2 - S.W / 2;
    }
  }
  redraw();
}

function w2s(x, y, z) {
  if (is3d()) return View3D.project(x, y, z ?? Math.max(0, heightAt(x, y) ?? 0) + 1) || OFF;
  let dx = (x - S.view.cx) * S.view.scale, dy = (S.view.cy - y) * S.view.scale;
  if (S.view.rot && !rotOff) [dx, dy] = rotVec(dx, dy, -S.view.rot);
  return [dx + vcx(), dy + S.H / 2];
}
// Screen -> world; in 3D this picks the terrain and returns null when the ray misses.
function s2w(px, py) {
  if (is3d()) return View3D.pick(px, py);
  let dx = px - vcx(), dy = py - S.H / 2;
  if (S.view.rot) [dx, dy] = rotVec(dx, dy, S.view.rot);
  return [dx / S.view.scale + S.view.cx, S.view.cy - dy / S.view.scale];
}
// Screen angle (degrees, clockwise from screen-up) of a world heading at a point.
function screenDir(x, y, dir, z) {
  if (!is3d()) return dir - S.view.rot * 180 / Math.PI;
  const a = dir * Math.PI / 180, d = Math.max(5, View3D.cam.dist * 0.02);
  const p = w2s(x, y, z), q = w2s(x + Math.sin(a) * d, y + Math.cos(a) * d, z);
  return Math.atan2(q[0] - p[0], p[1] - q[1]) * 180 / Math.PI;
}
// Pans the 2D view by a screen-space delta.
function panBy(dx, dy) {
  if (S.view.rot) [dx, dy] = rotVec(dx, dy, S.view.rot);
  S.view.cx -= dx / S.view.scale;
  S.view.cy += dy / S.view.scale;
}
// Approximate pixels per metre (in 3D, at the camera target).
function viewScale() { return is3d() ? S.H / View3D.cam.dist : S.view.scale; }
function clampScale(s) {
  const min = Math.min(S.W, S.H) / worldSize() * 0.3;
  return Math.min(30, Math.max(min, s));
}
function fitWorld() {
  const ws = worldSize();
  S.view.cx = ws / 2; S.view.cy = ws / 2;
  S.view.scale = Math.min(S.W, S.H) / ws * 0.95;
  View3D.focus(ws / 2, ws / 2, ws * 0.85);
  redraw();
}
function centerOn(x, y, minScale) {
  S.view.cx = x; S.view.cy = y;
  if (minScale && S.view.scale < minScale) S.view.scale = clampScale(minScale);
  // 3D follows the same centre; distance roughly matching the 2D zoom.
  View3D.focus(x, y, minScale ? Math.min(View3D.cam.dist, S.H / S.view.scale * 0.9) : undefined);
  redraw();
}
function zoomAt(px, py, factor) {
  if (S.orient === 'heading') { px = vcx(); py = S.H / 2; } // player stays centred
  const [wx, wy] = s2w(px, py);
  S.view.scale = clampScale(S.view.scale * factor);
  let dx = px - vcx(), dy = py - S.H / 2;
  if (S.view.rot) [dx, dy] = rotVec(dx, dy, S.view.rot);
  S.view.cx = wx - dx / S.view.scale;
  S.view.cy = wy + dy / S.view.scale;
  redraw();
}
function redraw() {
  if (S.dirty) return;
  S.dirty = true;
  requestAnimationFrame(draw);
}
function resize() {
  const r = canvas.getBoundingClientRect();
  S.dpr = window.devicePixelRatio || 1;
  S.W = Math.max(1, r.width); S.H = Math.max(1, r.height);
  // Assigning canvas.width/height clears the canvas, so only do it when the pixel size
  // actually changed — a no-op resize must not blank the map for a frame.
  const cw = Math.round(S.W * S.dpr), ch = Math.round(S.H * S.dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  View3D.resize(S.W, S.H, S.dpr);
  if (!S.view.fitted) { S.view.fitted = true; fitWorld(); }
  updateViewShift();
  redraw();
}

// ============================================================ terrain

const ROAD_STYLE = {
  TRAIL: { fill: '#a3825a', casing: null, min: 0.8, dash: [2, 3] },
  TRACK: { fill: '#b08a57', casing: null, min: 1.1, dash: [5, 3] },
  ROAD: { fill: '#fbf3d0', casing: '#7d6d4a', min: 1.6 },
  'MAIN ROAD': { fill: '#f2b347', casing: '#6e4f1e', min: 2.2 },
};
const ROAD_ORDER = ['TRAIL', 'TRACK', 'ROAD', 'MAIN ROAD'];
const BUCKET = 500;

// Height grid for the selected map: our topo export, else grad_meh's elevation model.
function heightSource() {
  if (S.terrain) return S.terrain;
  if (S.dem && S.dem.key === viewKey()) return S.dem;
  return null;
}

function heightAt(x, y) {
  const t = heightSource();
  if (!t) return null;
  const N = t.n;
  const fx = Math.min(N - 1.001, Math.max(0, x / t.step - 0.5));
  const fy = Math.min(N - 1.001, Math.max(0, y / t.step - 0.5));
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const H = t.heights;
  const a = H[j * N + i], b = H[j * N + i + 1], c = H[(j + 1) * N + i], d = H[(j + 1) * N + i + 1];
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

// Marching squares over the height grid; pushes segments (grid coords) into out.
function contourCell(i, j, a, b, c, d, level, out) {
  const idx = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (c > level ? 4 : 0) | (d > level ? 8 : 0);
  if (idx === 0 || idx === 15) return;
  // corners: a=(i,j) b=(i+1,j) c=(i+1,j+1) d=(i,j+1)
  const e = [];
  const lerp = (p, q) => (level - p) / (q - p);
  if ((a > level) !== (b > level)) e[0] = [i + lerp(a, b), j];
  if ((b > level) !== (c > level)) e[1] = [i + 1, j + lerp(b, c)];
  if ((d > level) !== (c > level)) e[2] = [i + lerp(d, c), j + 1];
  if ((a > level) !== (d > level)) e[3] = [i, j + lerp(a, d)];
  const seg = (p, q) => out.push(e[p][0], e[p][1], e[q][0], e[q][1]);
  if (idx === 5) { seg(3, 0); seg(1, 2); return; }
  if (idx === 10) { seg(0, 1); seg(2, 3); return; }
  const k = [0, 1, 2, 3].filter((n) => e[n]);
  if (k.length === 2) seg(k[0], k[1]);
}

function buildPath(c, segs, k, R) {
  for (let q = 0; q < segs.length; q += 4) {
    c.moveTo((segs[q] + 0.5) * k, R - (segs[q + 1] + 0.5) * k);
    c.lineTo((segs[q + 2] + 0.5) * k, R - (segs[q + 3] + 0.5) * k);
  }
}

function strokeSegs(c, segs, k, R, color, width) {
  c.strokeStyle = color;
  c.lineWidth = width;
  const CH = 40000;
  for (let s = 0; s < segs.length; s += CH) {
    c.beginPath();
    buildPath(c, segs.slice(s, s + CH), k, R);
    c.stroke();
  }
}

function drawRoads(c, roads, idxs, toX, toY, pxPerM) {
  const byType = {};
  for (const i of idxs) {
    const r = roads[i];
    (byType[r[0]] || (byType[r[0]] = [])).push(r);
  }
  c.lineCap = 'round';
  for (const type of ROAD_ORDER) {
    const list = byType[type];
    if (!list) continue;
    const st = ROAD_STYLE[type];
    for (const pass of st.casing ? ['casing', 'fill'] : ['fill']) {
      // Group by pixel width so each group is a single path.
      const groups = new Map();
      for (const r of list) {
        let w = Math.max(st.min, (r[1] || 4) * pxPerM);
        if (pass === 'casing') w += 1.6;
        w = Math.round(w * 2) / 2;
        (groups.get(w) || groups.set(w, []).get(w)).push(r);
      }
      c.strokeStyle = pass === 'casing' ? st.casing : st.fill;
      c.setLineDash(pass === 'fill' && st.dash ? st.dash : []);
      for (const [w, rs] of groups) {
        c.lineWidth = w;
        c.beginPath();
        for (const r of rs) { c.moveTo(toX(r[2]), toY(r[3])); c.lineTo(toX(r[4]), toY(r[5])); }
        c.stroke();
      }
    }
  }
  c.setLineDash([]);
}

function drawBuildings(c, blds, idxs, toX, toY, pxPerM) {
  c.beginPath();
  for (const i of idxs) {
    const [bx, by, dir, w, l] = blds[i];
    const r = dir * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const hw = Math.max(w * pxPerM, 0.7) / 2 / pxPerM, hl = Math.max(l * pxPerM, 0.7) / 2 / pxPerM;
    const pts = [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]];
    for (let p = 0; p < 4; p++) {
      const [mx, my] = pts[p];
      const X = toX(bx + mx * cs + my * sn), Y = toY(by - mx * sn + my * cs);
      if (p === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
    }
    c.closePath();
  }
  c.fillStyle = '#6f6a62';
  c.fill();
}

function bucketize(items, getXY, size) {
  const nb = Math.ceil(size / BUCKET);
  const buckets = Array.from({ length: nb * nb }, () => []);
  items.forEach((it, i) => {
    const [x, y] = getXY(it);
    const bx = Math.min(nb - 1, Math.max(0, Math.floor(x / BUCKET)));
    const by = Math.min(nb - 1, Math.max(0, Math.floor(y / BUCKET)));
    buckets[by * nb + bx].push(i);
  });
  return { nb, buckets };
}

// Layers baked into the topo base image; changing one rebuilds it.
function bakedKey() { return ['contours', 'roads', 'buildings'].map((k) => (S.layers[k] ? 1 : 0)).join(''); }

function buildTerrain(t) {
  const N = t.n, size = t.size, step = t.step, H = t.heights, trees = t.trees;
  const maxTex = Math.min(screen.width, screen.height) < 800 ? 2048 : 4096;
  const k = Math.max(1, Math.floor(maxTex / N));
  const R = N * k;
  const mpp = size / R;

  // 1. Colour, forest and hillshade at one pixel per height sample.
  const small = document.createElement('canvas');
  small.width = small.height = N;
  const sc = small.getContext('2d');
  const img = sc.createImageData(N, N);
  const px = img.data;
  let maxH = 1;
  for (let q = 0; q < H.length; q++) if (H[q] > maxH) maxH = H[q];
  const treeRef = Math.max(1, step * step / 80);
  for (let j = 0; j < N; j++) {
    const rowOut = (N - 1 - j) * N;
    for (let i = 0; i < N; i++) {
      const h = H[j * N + i];
      const o = (rowOut + i) * 4;
      let r, g, b;
      if (h < 0) {
        const d = Math.min(1, -h / 60);
        r = 182 - 70 * d; g = 216 - 56 * d; b = 236 - 28 * d;
      } else {
        const e = Math.min(1, h / Math.max(150, maxH));
        r = 238 - 26 * e; g = 233 - 32 * e; b = 214 - 40 * e;
        const tr = trees[j * N + i];
        if (tr > 0) {
          const a = Math.min(1, tr / treeRef) * 0.62;
          r = r * (1 - a) + 126 * a; g = g * (1 - a) + 176 * a; b = b * (1 - a) + 100 * a;
        }
        const hl = H[j * N + Math.max(0, i - 1)], hr = H[j * N + Math.min(N - 1, i + 1)];
        const hd = H[Math.max(0, j - 1) * N + i], hu = H[Math.min(N - 1, j + 1) * N + i];
        // Light from the north-west.
        const shade = Math.min(1.12, Math.max(0.72, 1 + ((hr - hl) - (hu - hd)) / (2 * step) * 0.9));
        r *= shade; g *= shade; b *= shade;
      }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  sc.putImageData(img, 0, 0);

  const base = document.createElement('canvas');
  base.width = base.height = R;
  const bc = base.getContext('2d');
  bc.imageSmoothingEnabled = true;
  bc.imageSmoothingQuality = 'high';
  bc.drawImage(small, 0, 0, R, R);

  // 2. Contours and coastline.
  const interval = maxH > 500 ? 20 : 10;
  const majorEvery = interval * 5;
  const minor = [], major = [], coast = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = H[j * N + i], b = H[j * N + i + 1], c = H[(j + 1) * N + i + 1], d = H[(j + 1) * N + i];
      const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
      if (lo < 0 && hi >= 0) contourCell(i, j, a, b, c, d, -0.5, coast);
      if (hi <= 0) continue;
      for (let L = Math.ceil(Math.max(lo, 0.001) / interval) * interval; L < hi; L += interval) {
        contourCell(i, j, a, b, c, d, L, L % majorEvery === 0 ? major : minor);
      }
    }
  }
  // Line widths in base pixels: about 1 px, thinner on detailed small maps.
  const lw = Math.min(1.2, Math.max(0.8, 8 / mpp));
  if (S.layers.contours) {
    strokeSegs(bc, minor, k, R, 'rgba(150,108,58,0.38)', lw);
    strokeSegs(bc, major, k, R, 'rgba(135,92,42,0.65)', lw * 1.5);
  }
  strokeSegs(bc, coast, k, R, 'rgba(52,96,140,0.85)', lw * 2);

  // 3. Roads and buildings baked into the base image for zoomed-out views.
  const roads = (t.roads || []).filter((r) => r.length >= 6);
  const blds = (t.buildings || []).filter((b) => b.length >= 5);
  const toX = (x) => x / mpp, toY = (y) => R - y / mpp;
  if (S.layers.buildings) drawBuildings(bc, blds, blds.map((_, i) => i), toX, toY, 1 / mpp);
  if (S.layers.roads) drawRoads(bc, roads, roads.map((_, i) => i), toX, toY, 1 / mpp);

  // Roads alone on a transparent image, drawn over the satellite view when zoomed out.
  const RR = Math.min(R, 2048), rk = RR / R;
  const roadsCanvas = document.createElement('canvas');
  roadsCanvas.width = roadsCanvas.height = RR;
  drawRoads(roadsCanvas.getContext('2d'), roads, roads.map((_, i) => i), (x) => toX(x) * rk, (y) => toY(y) * rk, rk / mpp);

  const LOC_RANK = { NameCityCapital: 0, NameCity: 1, Airport: 2, NameVillage: 3, NameMarine: 4, NameLocal: 5, Hill: 6, Mount: 6 };
  const locations = (t.locations || [])
    .filter((l) => l.length >= 4 && (l[0] || l[1] === 'Mount'))
    .sort((a, b) => (LOC_RANK[a[1]] ?? 9) - (LOC_RANK[b[1]] ?? 9));

  return {
    // Kept so the base image can be rebuilt when a baked-in layer is toggled.
    raw: t, baked: bakedKey(),
    world: t.world, desc: t.desc, size, n: N, step, heights: H, R, mpp, base, roadsCanvas,
    roads, roadBk: bucketize(roads, (r) => [(r[2] + r[4]) / 2, (r[3] + r[5]) / 2], size),
    blds, bldBk: bucketize(blds, (b) => [b[0], b[1]], size),
    locations,
  };
}

async function loadTerrain(world, force) {
  if (!world || S.terrainLoading) return;
  if (!force && S.terrainWorld === world) return;
  S.terrainLoading = true;
  updateBanner();
  try {
    const res = await fetch('api/terrain/' + encodeURIComponent(world));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    await new Promise((r) => setTimeout(r, 30)); // let the banner paint before the heavy work
    if (world === viewKey()) {
      S.terrain = buildTerrain(data);
      S.terrainWorld = world;
      if (!S.view.userMoved && !S.view.centered) fitWorld();
    }
  } catch (e) {
    console.error(e);
    toast(t('toast.map_failed'));
  } finally {
    S.terrainLoading = false;
    if (world !== viewKey()) syncView(); // the user switched maps while loading
    sync3d();
    updateBanner();
    updateTerrainPanel();
    redraw();
  }
}

// ---- satellite tiles (from grad_meh, re-tiled by the server)

async function loadSat(key) {
  try {
    const res = await fetch(`api/sat/${encodeURIComponent(key)}/info`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const info = await res.json();
    if (key !== viewKey()) return;
    S.sat = { key, info, tiles: new Map() };
    if (!S.view.userMoved && !S.view.centered) fitWorld();
    if (info.dem && !(S.dem && S.dem.key === key)) loadDem(key);
    sync3d();
    updateStyleUI();
    redraw();
  } catch (e) {
    console.error(e);
  }
}

function satTile(level, x, y, create = true) {
  const tiles = S.sat.tiles;
  const k = `${level}/${x}_${y}`;
  let t = tiles.get(k);
  if (t) { tiles.delete(k); tiles.set(k, t); return t; } // keep recently used tiles at the end
  if (!create) return null;
  t = { img: new Image(), ok: false };
  t.img.onload = () => { t.ok = true; redraw(); };
  t.img.src = `api/sat/${encodeURIComponent(S.sat.key)}/${level}/${x}_${y}.jpg?v=${(S.sat.info && S.sat.info.ts) || 0}`;
  tiles.set(k, t);
  if (tiles.size > 700) {
    for (const old of tiles.keys()) { tiles.delete(old); if (tiles.size <= 500) break; }
  }
  return t;
}

function drawSat() {
  const info = S.sat.info, ws = worldSize();
  const need = S.view.scale * S.dpr; // device pixels per metre on screen
  let L = info.top;
  for (let l = 0; l <= info.top; l++) if (info.levels[l].w / ws >= need) { L = l; break; }
  const lv = info.levels[L];
  const tw = info.tile * ws / lv.w, th = info.tile * ws / lv.h; // tile size in metres
  const v = visibleWorld();
  const [wx, wy] = w2s(0, ws);
  const sz = ws * S.view.scale;
  ctx.save();
  ctx.beginPath(); ctx.rect(wx, wy, sz, sz); ctx.clip();
  ctx.fillStyle = '#3a4662'; ctx.fillRect(wx, wy, sz, sz);
  ctx.imageSmoothingEnabled = true;
  satTile(0, 0, 0); // coarse fallback for everything
  const x0 = Math.max(0, Math.floor(v.x0 / tw)), x1 = Math.min(lv.cols - 1, Math.floor(v.x1 / tw));
  const y0 = Math.max(0, Math.floor((ws - v.y1) / th)), y1 = Math.min(lv.rows - 1, Math.floor((ws - v.y0) / th));
  const dw = tw * S.view.scale + 0.6, dh = th * S.view.scale + 0.6;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const [sx, sy] = w2s(tx * tw, ws - ty * th);
      const t = satTile(L, tx, ty);
      if (t.ok) { ctx.drawImage(t.img, sx, sy, dw, dh); continue; }
      for (let d = 1; d <= L; d++) { // draw the part of the nearest loaded ancestor
        const p = satTile(L - d, tx >> d, ty >> d, d <= 2);
        if (p && p.ok) {
          const f = 2 ** d, s = info.tile / f;
          ctx.drawImage(p.img, (tx % f) * s, (ty % f) * s, s, s, sx, sy, dw, dh);
          break;
        }
      }
    }
  }
  ctx.restore();
}

// ============================================================ 3D view

async function loadDem(key) {
  try {
    const res = await fetch(`api/sat/${encodeURIComponent(key)}/dem`);
    if (!res.ok) return;
    const d = await res.json();
    if (key !== viewKey()) return;
    S.dem = { key, n: d.n, step: d.step, heights: d.heights };
    sync3d();
    redraw();
  } catch (e) { console.error(e); }
}

const s3 = { srcKey: null, texKey: null };

// Keeps the 3D mesh and texture in step with the selected map and style.
function sync3d() {
  if (!View3D.supported()) { updateDimUI(); return; }
  const hs = heightSource();
  const key = viewKey();
  const srcKey = hs ? `${key}:${hs === S.terrain ? 'topo' : 'dem'}` : null;
  if (srcKey !== s3.srcKey) {
    s3.srcKey = srcKey;
    s3.texKey = null;
    if (hs) View3D.setTerrain(hs, worldSize()); else View3D.clearTerrain();
  }
  if (hs) {
    const style = effectiveStyle();
    const texKey = `${key}:${style}:${hasSat() ? 1 : 0}:${S.terrain ? 1 : 0}`;
    if (texKey !== s3.texKey) { s3.texKey = texKey; build3dTexture(texKey, style); }
    // 3D buildings come from the topo export (footprints, and heights in newer exports).
    const blds = S.layers.buildings3d && S.terrain ? S.terrain.blds : null;
    const bldKey = `${srcKey}:${blds ? blds.length : 0}`;
    if (bldKey !== s3.bldKey) { s3.bldKey = bldKey; View3D.setBuildings(blds); }
  }
  updateDimUI();
}

async function build3dTexture(texKey, style) {
  const maxT = Math.min(Math.min(screen.width, screen.height) < 800 ? 2048 : 4096, View3D.maxTextureSize());
  let img = null;
  if (style !== 'topo' && hasSat()) {
    const info = S.sat.info, key = S.sat.key;
    let L = 0;
    for (let l = 0; l <= info.top; l++) if (info.levels[l].w <= maxT && info.levels[l].h <= maxT) L = l;
    const lv = info.levels[L];
    const c = document.createElement('canvas');
    c.width = lv.w; c.height = lv.h;
    const cc = c.getContext('2d');
    const jobs = [];
    for (let ty = 0; ty < lv.rows; ty++) for (let tx = 0; tx < lv.cols; tx++) {
      jobs.push(new Promise((done) => {
        const im = new Image();
        im.onload = () => { cc.drawImage(im, tx * info.tile, ty * info.tile); done(); };
        im.onerror = done;
        im.src = `api/sat/${encodeURIComponent(key)}/${L}/${tx}_${ty}.jpg?v=${(info && info.ts) || 0}`;
      }));
    }
    await Promise.all(jobs);
    if (style === 'mix' && S.terrain) { cc.globalAlpha = 0.45; cc.drawImage(S.terrain.base, 0, 0, lv.w, lv.h); }
    if (S.layers.roads && S.terrain) { cc.globalAlpha = 1; cc.drawImage(S.terrain.roadsCanvas, 0, 0, lv.w, lv.h); }
    img = c;
  } else if (S.terrain) {
    const b = S.terrain.base;
    if (b.width <= maxT) img = b;
    else {
      img = document.createElement('canvas');
      img.width = img.height = maxT;
      img.getContext('2d').drawImage(b, 0, 0, maxT, maxT);
    }
  }
  if (s3.texKey !== texKey) return; // the map or style changed meanwhile
  View3D.setTexture(img);
  redraw();
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// Vehicles as 3D models (positions interpolated like the 2D icons).
function vehicleModels() {
  const st = S.state;
  if (!st || !onGameMap() || !S.layers.units || !S.layers.models3d) return [];
  const side = new Map();
  for (const u of st.units) if (u.veh && !side.has(u.veh)) side.set(u.veh, groupSide(u));
  const out = [];
  for (const v of st.vehicles) {
    const sd = side.get(v.id) || 'CIV';
    if (!sideShown(sd)) continue;
    const P = animPos(v);
    out.push({ id: v.id, kind: v.kind, x: P.x, y: P.y, dir: P.dir, alt: v.alt > 3 ? v.alt : 0, color: hexRgb(SIDE_COLOR[sd] || '#777777') });
  }
  if (S.layers.empty) {
    for (const e of st.empty || []) {
      if (!sideShown(e.side)) continue;
      // Empty vehicles: side colour washed out towards grey.
      const c = hexRgb(SIDE_COLOR[e.side] || '#777777').map((v) => v * 0.45 + 0.35);
      out.push({ id: e.id, kind: e.kind, x: e.x, y: e.y, dir: e.dir, alt: 0, color: c });
    }
  }
  return out;
}

function draw3d() {
  if (S.orient === 'heading') applyHeadingUp();
  View3D.setBrightness(S.bright);
  View3D.setModelScaling(S.layers.models3dScale);
  View3D.setVehicles(vehicleModels());
  View3D.render();
  ctx.clearRect(0, 0, S.W, S.H);
  if (S.terrain && S.layers.names) drawLocations();
  if (S.state && onGameMap()) {
    if (S.layers.markers) drawMarkers();
    if (S.layers.units) drawUnits();
  }
  drawSelection();
  drawLinePreview();
  if (S.layers.compass) drawCompass();
}

// ---- unit camera view: first person from a unit or vehicle, built from the map data
// (terrain, satellite/topo texture, buildings, vehicle models), not the game's own picture.

function camObj() { return S.camId ? objById(S.camId) : null; }

function openCamera(id) {
  if (!View3D.supported()) return;
  S.camId = id;
  S.camLook = { yaw: 0, pitch: 0, fov: 60 };
  select(null);
  setTool('select');
  sync3d();
  if (window.innerWidth < 760) appEl.classList.add('panel-closed');
  updateCamHud();
  redraw();
}
function closeCamera() {
  if (POPUP_CAM) { window.close(); return; }
  S.camId = null;
  View3D.cam.fp = null;
  View3D.setModelScaling(S.layers.models3dScale);
  applyCamStream();
  updateCamHud();
  redraw();
}
function openCameraWindow(id) {
  const url = `${location.pathname}?cam=${encodeURIComponent(id)}`;
  window.open(url, 'dideban-cam-' + id.replace(/\W/g, '_'), 'width=960,height=600');
}

// ---- real picture from the game: your own screen, or another unit's helmet cam (picture-in-picture)
let helmetFor = null; // unit whose helmet cam this page asked the game to draw
function isMeCam() {
  const o = camObj();
  return !!o && o === myObj();
}
function applyCamStream() {
  const img = $('#cam-stream');
  const want = S.camId && S.camSource === 'game' ? (isMeCam() ? 'game' : 'helmet') : null;
  if (want === 'helmet' && helmetFor !== S.camId) {
    helmetFor = S.camId;
    command({ action: 'helmet_start', id: S.camId }).catch((e) => toast(t('toast.request_failed', { error: e.message })));
  } else if (want !== 'helmet' && helmetFor) {
    helmetFor = null;
    command({ action: 'helmet_stop' }).catch(() => {});
  }
  const src = want ? `api/stream/${want}.mjpg` : '';
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    if (src) img.src = src; else img.removeAttribute('src'); // removing the src closes the stream
    img.hidden = !src;
  }
  document.querySelectorAll('#cam-src button').forEach((b) => b.classList.toggle('active', b.dataset.src === S.camSource));
  $('#cam-note').textContent = t(S.camSource === 'game' ? (want === 'helmet' ? 'cam.note_helmet' : 'cam.note_game') : 'cam.note');
}
document.querySelectorAll('#cam-src button').forEach((b) => b.addEventListener('click', () => {
  S.camSource = b.dataset.src;
  storeSet('camSource', S.camSource);
  applyCamStream();
  redraw();
}));
// Stop a helmet cam when this page goes away (closing a camera window).
window.addEventListener('pagehide', () => {
  if (helmetFor) navigator.sendBeacon('api/command', new Blob([JSON.stringify({ action: 'helmet_stop' })], { type: 'application/json' }));
});
$('#btn-gameview').addEventListener('click', () => {
  const me = S.state && S.state.me;
  if (!me || !S.status.connected) { toast(t('toast.not_connected')); return; }
  S.camSource = 'game';
  openCamera(me.id);
});

function drawCamera() {
  const glc = $('#gl');
  const o = camObj();
  updateCamHud(o);
  applyCamStream();
  if (S.camSource === 'game') { // the <img> stream shows the picture
    glc.hidden = true;
    ctx.clearRect(0, 0, S.W, S.H);
    return;
  }
  if (!o || !View3D.hasTerrain()) {
    glc.hidden = true;
    ctx.fillStyle = '#101316';
    ctx.fillRect(0, 0, S.W, S.H);
    label(t(!o ? 'cam.notfound' : 'cam.noterrain'), S.W / 2, S.H / 2, { size: 14, align: 'center', color: '#e8e8e8', haloColor: 'rgba(0,0,0,.6)' });
    return;
  }
  glc.hidden = false;
  const P = animPos(o);
  const veh = !!o.kind;
  const eye = veh ? (o.alt > 3 ? o.alt + 1.5 : (o.kind === 'tank' || o.kind === 'apc' || o.kind === 'aa' ? 3 : 2.2)) : 1.7;
  View3D.cam.fp = {
    x: P.x, y: P.y, z: eye, fov: S.camLook.fov, skipId: veh ? o.id : null,
    yaw: (P.dir + S.camLook.yaw) * Math.PI / 180, pitch: S.camLook.pitch * Math.PI / 180,
  };
  View3D.setBrightness(S.bright);
  View3D.setModelScaling(false);
  View3D.setVehicles(vehicleModels());
  View3D.render();
  ctx.clearRect(0, 0, S.W, S.H);
  if (S.state) {
    if (S.layers.markers) drawMarkers();
    if (S.layers.units) drawUnits();
  }
  // Centre cross.
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1.5;
  line(ctx, S.W / 2 - 10, S.H / 2, S.W / 2 - 3, S.H / 2); line(ctx, S.W / 2 + 3, S.H / 2, S.W / 2 + 10, S.H / 2);
  line(ctx, S.W / 2, S.H / 2 - 10, S.W / 2, S.H / 2 - 3); line(ctx, S.W / 2, S.H / 2 + 3, S.W / 2, S.H / 2 + 10);
}

// Camera HUD: unit picker, heading and grid of the view.
let camOptionsKey = '';
function updateCamHud(o = camObj()) {
  const hud = $('#cam-hud');
  hud.hidden = !S.camId;
  appEl.classList.toggle('camera-on', !!S.camId);
  if (!S.camId) return;
  const st = S.state;
  const opts = [];
  if (st && onGameMap()) {
    const players = st.units.filter((u) => u.player), ai = st.units.filter((u) => !u.player && !u.veh);
    for (const u of [...players, ...ai]) if (sideShown(groupSide(u))) opts.push([u.id, u.name + (u.veh ? ' ▸' : '')]);
    for (const v of st.vehicles) opts.push([v.id, v.type]);
  }
  if (!opts.some(([id]) => id === S.camId)) opts.unshift([S.camId, '…']);
  const key = opts.map((x) => x.join('=')).join('|');
  const sel = $('#cam-select');
  if (key !== camOptionsKey) {
    camOptionsKey = key;
    sel.innerHTML = opts.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('');
  }
  sel.value = S.camId;
  if (o) {
    const P = animPos(o);
    const hdg = ((Math.round(P.dir + S.camLook.yaw) % 360) + 360) % 360;
    $('#cam-info').textContent = `${String(hdg).padStart(3, '0')}°  ·  GRID ${gridRef(P.x, P.y)}  ·  ${Math.round(S.camLook.fov)}°`;
  }
}
$('#cam-select').addEventListener('change', (e) => { S.camId = e.target.value; S.camLook = { yaw: 0, pitch: 0, fov: 60 }; redraw(); });
$('#cam-reset').addEventListener('click', () => { S.camLook = { yaw: 0, pitch: 0, fov: 60 }; redraw(); });
$('#cam-pop').addEventListener('click', () => { const id = S.camId; closeCamera(); openCameraWindow(id); });
$('#cam-close').addEventListener('click', closeCamera);

// The player's own unit, or the vehicle they are in.
function myObj() {
  const st = S.state;
  if (!st || !st.me || !onGameMap()) return null;
  const u = st.units.find((x) => x.id === st.me.id);
  return u && u.veh ? st.vehicles.find((v) => v.id === u.veh) || u : u || null;
}

// Any unit (the vehicle it sits in, if any), manned vehicle or empty vehicle by id.
function objById(id) {
  const st = S.state;
  if (!st || !onGameMap()) return null;
  const u = st.units.find((x) => x.id === id);
  if (u) return u.veh ? st.vehicles.find((v) => v.id === u.veh) || u : u;
  return st.vehicles.find((v) => v.id === id) || (st.empty || []).find((v) => v.id === id) || null;
}

// What follow mode, heading-up mode and the compass track: a chosen unit, or the player.
function trackObj() {
  if (S.followId) { const o = objById(S.followId); if (o) return o; }
  return myObj();
}

// Height of an aircraft above the ground (0 on the ground), so the 3D camera looks at it.
function altOf(o) { return o && o.kind && o.alt > 3 ? o.alt : 0; }

// Heading-up mode: the map turns so the tracked heading points up; the tracked unit stays centred.
function applyHeadingUp() {
  const o = trackObj();
  if (!o) return;
  const P = animPos(o);
  const a = P.dir * Math.PI / 180;
  if (is3d()) { View3D.cam.yaw = a; View3D.focus(P.x, P.y, undefined, altOf(o)); }
  else { S.view.rot = a; S.view.cx = P.x; S.view.cy = P.y; }
}

// Compass (top-left): the dial turns with the map, the yellow needle is the player's heading.
// Size from settings; position dragged by the user (kept inside the map).
// On phones the map view controls float over the top of the map; the compass's default spot
// moves below them so they never cover it (a position the user dragged it to is kept).
let compassPad = 0;
function updateCompassPad() {
  const vc = $('#view-ctrls');
  let pad = 0;
  if (vc && getComputedStyle(vc).position === 'fixed') {
    const cr = canvas.getBoundingClientRect(), r = vc.getBoundingClientRect();
    const reach = 2 * 38 * S.compassScale + 40; // the compass box at its default top-left spot
    if (r.width > 0 && r.bottom > cr.top && r.top < cr.top + reach && r.left < cr.left + reach) pad = Math.round(r.bottom - cr.top + 4);
  }
  if (pad !== compassPad) { compassPad = pad; redraw(); }
}
function compassGeom() {
  const r = 38 * S.compassScale;
  let [x, y] = S.compassPos || [r + 14, r + 18 + compassPad];
  x = Math.min(Math.max(x, r + 2), S.W - r - 2);
  y = Math.min(Math.max(y, r + 10), S.H - r - 50);
  return { x, y, r };
}
function drawCompass() {
  const { x, y, r } = compassGeom();
  const up = is3d() ? View3D.cam.yaw : S.view.rot; // bearing of screen-up, radians
  const o = trackObj();
  const heading = o ? ((animPos(o).dir % 360) + 360) % 360 : null;
  ctx.save();
  ctx.translate(x, y);
  circle(ctx, 0, 0, r);
  ctx.fillStyle = 'rgba(16,19,22,.78)'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.stroke();
  ctx.save();
  ctx.rotate(-up);
  for (let d = 0; d < 360; d += 10) {
    const long = d % 30 === 0;
    const a = d * Math.PI / 180, s = Math.sin(a), c = -Math.cos(a);
    ctx.strokeStyle = d === 0 ? '#ff5a5a' : 'rgba(255,255,255,.65)';
    ctx.lineWidth = long ? 1.6 : 1;
    line(ctx, s * (r - (long ? 8 : 4)), c * (r - (long ? 8 : 4)), s * (r - 1), c * (r - 1));
  }
  ctx.font = 'bold 10px Tahoma, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [['N', 0, '#ff5a5a'], ['E', 90, '#fff'], ['S', 180, '#fff'], ['W', 270, '#fff']].forEach(([l, d, col]) => {
    const a = d * Math.PI / 180;
    ctx.save();
    ctx.translate(Math.sin(a) * (r - 15), -Math.cos(a) * (r - 15));
    ctx.rotate(up); // keep letters upright
    ctx.fillStyle = col; ctx.fillText(l, 0, 0);
    ctx.restore();
  });
  if (heading !== null) {
    const a = heading * Math.PI / 180;
    ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2.5;
    line(ctx, 0, 0, Math.sin(a) * (r - 10), -Math.cos(a) * (r - 10));
    ctx.fillStyle = '#ffd400';
    circle(ctx, 0, 0, 3); ctx.fill();
  }
  ctx.restore();
  // Fixed index at the top of the dial.
  ctx.fillStyle = '#fff';
  poly(ctx, [[0, -r - 1], [-4, -r - 8], [4, -r - 8]]); ctx.fill();
  ctx.restore();

  // Readout: player heading (or the view bearing) in degrees, and the player's grid.
  const deg = heading !== null ? heading : ((up * 180 / Math.PI) % 360 + 360) % 360;
  const lines = [`${String(Math.round(deg) % 360).padStart(3, '0')}°`];
  if (o) lines.push(gridRef(animPos(o).x, animPos(o).y));
  ctx.font = 'bold 13px Consolas, ui-monospace, monospace';
  const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 12;
  const top = y + r + 6;
  ctx.fillStyle = 'rgba(16,19,22,.78)';
  ctx.fillRect(x - w / 2, top, w, 18 * lines.length + 4);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  lines.forEach((s, i) => {
    ctx.fillStyle = i === 0 ? '#ffd400' : '#e8e8e8';
    ctx.font = i === 0 ? 'bold 13px Consolas, ui-monospace, monospace' : '11px Consolas, ui-monospace, monospace';
    ctx.fillText(s, x, top + 3 + i * 18);
  });
}
function hitCompass(px, py) {
  if (!S.layers.compass || S.camId) return false;
  const g = compassGeom();
  return Math.hypot(px - g.x, py - g.y) <= g.r;
}

function updateDimUI() {
  const can = View3D.supported() && !!heightSource();
  document.querySelectorAll('#dim-seg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.dim === (is3d() ? '3d' : '2d'));
    if (b.dataset.dim === '3d') {
      b.disabled = !can;
      b.title = can ? '' : t('view.3d_unavailable');
    }
  });
  $('#hint').textContent = t(is3d() ? 'hint3d' : 'hint');
}

document.querySelectorAll('#dim-seg button').forEach((b) => b.addEventListener('click', () => {
  S.dim = b.dataset.dim;
  storeSet('dim', S.dim);
  if (S.dim === '3d') { View3D.focus(S.view.cx, S.view.cy, Math.min(worldSize() * 0.85, S.H / S.view.scale * 0.9)); sync3d(); }
  else if (View3D.hasTerrain()) { S.view.cx = View3D.cam.tx; S.view.cy = View3D.cam.ty; }
  updateDimUI();
  redraw();
}));

// ============================================================ icons

function circle(c, x, y, r) { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); }
function poly(c, pts, close = true) {
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  if (close) c.closePath();
}
function line(c, x1, y1, x2, y2) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
function glyph(c, text, s) {
  c.font = `bold ${Math.round(s * 1.2)}px Tahoma, sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 0, s * 0.06);
}

function drawNato(c, pre, kind, s) {
  const w = s * 1.15, h = s * 0.8;
  let X, Y;
  if (pre === 'o') { poly(c, [[0, -s], [s, 0], [0, s], [-s, 0]]); X = Y = s * 0.5; }
  else if (pre === 'n') { c.beginPath(); c.rect(-h, -h, 2 * h, 2 * h); X = Y = h; }
  else if (pre === 'u') { circle(c, 0, 0, s * 0.9); X = Y = s * 0.6; }
  else { c.beginPath(); c.rect(-w, -h, 2 * w, 2 * h); X = w; Y = h; }
  const a = c.globalAlpha;
  c.globalAlpha = a * 0.22; c.fill(); c.globalAlpha = a;
  c.stroke();
  c.save();
  c.clip();
  c.lineWidth = Math.max(1.4, s * 0.13);
  const inf = () => { line(c, -X, -Y, X, Y); line(c, -X, Y, X, -Y); };
  switch (kind) {
    case 'inf': inf(); break;
    case 'motor_inf': inf(); line(c, 0, -Y, 0, Y); break;
    case 'mech_inf': inf(); c.beginPath(); c.ellipse(0, 0, X * 0.6, Y * 0.45, 0, 0, Math.PI * 2); c.stroke(); break;
    case 'armor': c.beginPath(); c.ellipse(0, 0, X * 0.65, Y * 0.5, 0, 0, Math.PI * 2); c.stroke(); break;
    case 'recon': line(c, -X, Y, X, -Y); break;
    case 'air': case 'plane':
      c.beginPath(); c.ellipse(-X * 0.33, 0, X * 0.3, Y * 0.28, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(X * 0.33, 0, X * 0.3, Y * 0.28, 0, 0, Math.PI * 2); c.fill(); break;
    case 'uav': poly(c, [[-X * 0.6, -Y * 0.3], [0, Y * 0.35], [X * 0.6, -Y * 0.3]], false); c.stroke(); break;
    case 'naval': line(c, 0, -Y * 0.6, 0, Y * 0.6); c.beginPath(); c.arc(0, 0, Y * 0.55, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke(); break;
    case 'med': line(c, 0, -Y * 0.7, 0, Y * 0.7); line(c, -Y * 0.7, 0, Y * 0.7, 0); break;
    case 'art': circle(c, 0, 0, Math.min(X, Y) * 0.32); c.fill(); break;
    case 'mortar': circle(c, 0, Y * 0.3, Math.min(X, Y) * 0.22); c.fill(); line(c, 0, Y * 0.1, 0, -Y * 0.7); break;
    case 'support': line(c, -X, 0, X, 0); break;
    case 'maint': line(c, -X * 0.6, 0, X * 0.6, 0); circle(c, -X * 0.6, 0, Y * 0.2); c.stroke(); circle(c, X * 0.6, 0, Y * 0.2); c.stroke(); break;
    case 'antiair': c.beginPath(); c.arc(0, Y, X * 0.75, Math.PI, 2 * Math.PI); c.stroke(); break;
    case 'hq': glyph(c, 'HQ', s * 0.55); break;
    case 'service': glyph(c, 'S', s * 0.7); break;
    case 'installation': c.fillRect(-X * 0.4, -Y, X * 0.8, Y * 0.35); break;
    default: glyph(c, '?', s * 0.8);
  }
  c.restore();
}

// Draws a marker icon centred on (0,0) with half-size s.
function drawMarkerIcon(c, type, s, color) {
  const t = String(type || '').toLowerCase();
  c.fillStyle = color; c.strokeStyle = color;
  c.lineWidth = Math.max(1.6, s * 0.18);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const nato = /^(b|o|n|c|u)_(.+)$/.exec(t);
  if (nato) return drawNato(c, nato[1], nato[2], s);
  if (t.startsWith('flag_')) {
    line(c, -s * 0.5, s * 0.8, -s * 0.5, -s * 0.8);
    c.fillRect(-s * 0.5, -s * 0.8, s * 1.2, s * 0.8);
    return;
  }
  if (t.startsWith('respawn_')) { circle(c, 0, 0, s * 0.75); c.stroke(); glyph(c, 'R', s * 0.75); return; }
  const base = t.replace(/^(mil|hd)_/, '');
  switch (base) {
    case 'empty': case 'emptyicon': return;
    case 'dot': circle(c, 0, 0, s * 0.45); c.fill(); return;
    case 'box': c.fillRect(-s * 0.55, -s * 0.55, s * 1.1, s * 1.1); return;
    case 'triangle': poly(c, [[0, -s * 0.7], [s * 0.65, s * 0.5], [-s * 0.65, s * 0.5]]); c.fill(); return;
    case 'circle': circle(c, 0, 0, s * 0.6); c.stroke(); return;
    case 'flag':
      line(c, -s * 0.45, s * 0.85, -s * 0.45, -s * 0.85);
      poly(c, [[-s * 0.45, -s * 0.85], [s * 0.7, -s * 0.5], [-s * 0.45, -s * 0.1]]); c.fill(); return;
    case 'warning':
      poly(c, [[0, -s * 0.8], [s * 0.8, s * 0.6], [-s * 0.8, s * 0.6]]); c.stroke();
      line(c, 0, -s * 0.3, 0, s * 0.15); circle(c, 0, s * 0.38, s * 0.07); c.fill(); return;
    case 'objective':
      circle(c, 0, 0, s * 0.6); c.stroke(); circle(c, 0, 0, s * 0.18); c.fill();
      line(c, 0, -s * 0.95, 0, -s * 0.6); line(c, 0, s * 0.6, 0, s * 0.95);
      line(c, -s * 0.95, 0, -s * 0.6, 0); line(c, s * 0.6, 0, s * 0.95, 0); return;
    case 'destroy': line(c, -s * 0.6, -s * 0.6, s * 0.6, s * 0.6); line(c, -s * 0.6, s * 0.6, s * 0.6, -s * 0.6); return;
    case 'end': c.strokeRect(-s * 0.55, -s * 0.55, s * 1.1, s * 1.1); circle(c, 0, 0, s * 0.18); c.fill(); return;
    case 'pickup': circle(c, 0, 0, s * 0.62); c.stroke(); circle(c, 0, 0, s * 0.3); c.fill(); return;
    case 'join': line(c, -s * 0.6, -s * 0.6, 0, 0); line(c, s * 0.6, -s * 0.6, 0, 0); line(c, 0, 0, 0, s * 0.75); return;
    case 'ambush':
      c.beginPath(); c.arc(0, s * 0.5, s * 0.8, 1.15 * Math.PI, 1.85 * Math.PI); c.stroke();
      line(c, -s * 0.35, -s * 0.15, -s * 0.2, -s * 0.55); line(c, s * 0.35, -s * 0.15, s * 0.2, -s * 0.55); line(c, 0, -s * 0.25, 0, -s * 0.7); return;
    case 'start': poly(c, [[-s * 0.45, -s * 0.65], [s * 0.65, 0], [-s * 0.45, s * 0.65]]); c.fill(); return;
    case 'arrow': case 'arrow2':
      poly(c, [[0, -s * 0.95], [s * 0.6, -s * 0.1], [s * 0.2, -s * 0.1], [s * 0.2, s * 0.85], [-s * 0.2, s * 0.85], [-s * 0.2, -s * 0.1], [-s * 0.6, -s * 0.1]]);
      if (base === 'arrow') c.fill(); else c.stroke(); return;
    case 'marker':
      circle(c, 0, -s * 0.35, s * 0.4); c.fill();
      poly(c, [[-s * 0.33, -s * 0.15], [s * 0.33, -s * 0.15], [0, s * 0.8]]); c.fill(); return;
    case 'unknown': glyph(c, '?', s); return;
    default:
      if (t.startsWith('loc_')) { c.strokeRect(-s * 0.4, -s * 0.4, s * 0.8, s * 0.8); return; }
      poly(c, [[0, -s * 0.55], [s * 0.55, 0], [0, s * 0.55], [-s * 0.55, 0]]); c.fill();
  }
}

// Infantry: dot with a facing arrow and an optional field-of-view cone. dir is a screen angle (degrees).
function drawMan(x, y, dir, color, isMe, life, hp = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(S.iconScale, S.iconScale);
  drawManAt(0, 0, dir, color, isMe, life);
  if (S.layers.health) drawHealth(isMe ? 6.5 : 5, life, hp);
  ctx.restore();
}

const hpColor = (hp) => `hsl(${Math.round(Math.max(0, Math.min(1, hp)) * 120)}, 85%, 45%)`;

// Health under the icon (centred on 0,0): a bar when hurt; a red ring and medic cross when down.
function drawHealth(r, life, hp) {
  if (life === 'INCAPACITATED') {
    circle(ctx, 0, 0, r + 6);
    ctx.strokeStyle = '#ff2b2b'; ctx.lineWidth = 2.5; ctx.stroke();
    // Medic badge: white circle with a red cross, top-right.
    const bx = r + 6, by = -r - 6;
    circle(ctx, bx, by, 5.5); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillStyle = '#e02020';
    ctx.fillRect(bx - 1.2, by - 3.6, 2.4, 7.2); ctx.fillRect(bx - 3.6, by - 1.2, 7.2, 2.4);
    return;
  }
  if (hp >= 0.99) return;
  const w = 18, h = 3.5, y = r + 5;
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(-w / 2 - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = hpColor(hp);
  ctx.fillRect(-w / 2, y, w * Math.max(0.04, hp), h);
}
function drawManAt(x, y, dir, color, isMe, life) {
  const r = isMe ? 6.5 : 5;
  const a = dir * Math.PI / 180;
  if (S.layers.cones) {
    const len = isMe ? 34 : 26;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, len, a - Math.PI / 2 - 0.5, a - Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1;
  }
  if (S.layers.facing) {
    const tip = r + 10;
    ctx.fillStyle = '#fff';
    poly(ctx, [
      [x + Math.sin(a) * (tip + 1.5), y - Math.cos(a) * (tip + 1.5)],
      [x + Math.sin(a - 0.75) * (r + 1), y - Math.cos(a - 0.75) * (r + 1)],
      [x + Math.sin(a + 0.75) * (r + 1), y - Math.cos(a + 0.75) * (r + 1)],
    ]);
    ctx.fill();
    ctx.fillStyle = color;
    poly(ctx, [
      [x + Math.sin(a) * tip, y - Math.cos(a) * tip],
      [x + Math.sin(a - 0.6) * r, y - Math.cos(a - 0.6) * r],
      [x + Math.sin(a + 0.6) * r, y - Math.cos(a + 0.6) * r],
    ]);
    ctx.fill();
  }
  ctx.fillStyle = color;
  circle(ctx, x, y, r);
  ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  if (isMe) { circle(ctx, x, y, r + 3.5); ctx.lineWidth = 2.5; ctx.strokeStyle = '#ffd400'; ctx.stroke(); }
  if (life === 'INCAPACITATED') {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2;
    line(ctx, x - 3, y, x + 3, y); line(ctx, x, y - 3, x, y + 3);
    ctx.strokeStyle = '#e02020'; ctx.lineWidth = 1.2;
    line(ctx, x - 3, y, x + 3, y); line(ctx, x, y - 3, x, y + 3);
  }
}

// Top-down vehicle silhouettes, nose pointing up (-y), about 30 px long; rotated to the heading.
const VEH_SHAPES = {
  plane: { body: 'M0 -15 L2 -9 L2 -3 L14 4 L14 7 L2 3 L1.5 10 L6 13 L6 15 L0 13.5 L-6 15 L-6 13 L-1.5 10 L-2 3 L-14 7 L-14 4 L-2 -3 L-2 -9 Z' },
  heli: {
    body: 'M0 -10 C4 -10 5 -5 5 -1 C5 3 3 5 1.5 6 L1 14 L4.5 15 L4.5 17 L-4.5 17 L-4.5 15 L-1 14 L-1.5 6 C-3 5 -5 3 -5 -1 C-5 -5 -4 -10 0 -10 Z',
    rotor: true,
  },
  tank: {
    body: 'M-8 -11 H8 V12 H-8 Z',
    dark: 'M-8 -11 H-5 V12 H-8 Z M5 -11 H8 V12 H5 Z',
    top: 'M-1.3 -21 H1.3 V-3 H-1.3 Z M5.2 1 A5.2 5.2 0 1 1 -5.2 1 A5.2 5.2 0 1 1 5.2 1 Z',
  },
  apc: {
    body: 'M-5.5 -13 H5.5 L8 -8 V12 H-8 V-8 Z',
    dark: 'M8 -7 h2 v4 h-2 Z M8 -1 h2 v4 h-2 Z M8 5 h2 v4 h-2 Z M-10 -7 h2 v4 h-2 Z M-10 -1 h2 v4 h-2 Z M-10 5 h2 v4 h-2 Z',
    top: 'M-0.9 -12 H0.9 V-2 H-0.9 Z M3.4 0 A3.4 3.4 0 1 1 -3.4 0 A3.4 3.4 0 1 1 3.4 0 Z',
  },
  car: {
    body: 'M-5.5 -11 Q0 -13 5.5 -11 L6 9 Q0 11.5 -6 9 Z',
    dark: 'M-4.5 -6 Q0 -7.5 4.5 -6 L4 -3 Q0 -4 -4 -3 Z',
  },
  ship: { body: 'M0 -16 C5 -10 6 -4 6 4 L5 13 L-5 13 L-6 4 C-6 -4 -5 -10 0 -16 Z', dark: 'M-3 0 H3 V6 H-3 Z' },
  static: { body: 'M4 3 A4 4 0 1 1 -4 3 A4 4 0 1 1 4 3 Z', top: 'M-1.1 -13 H1.1 V1 H-1.1 Z' },
  // anti-air: tracked hull, turret with twin barrels either side and a radar dish behind
  aa: {
    body: 'M-8 -11 H8 V12 H-8 Z',
    dark: 'M-8 -11 H-5 V12 H-8 Z M5 -11 H8 V12 H5 Z',
    top: 'M-3.6 -17 H-1.6 V-2 H-3.6 Z M1.6 -17 H3.6 V-2 H1.6 Z M4.6 1 A4.6 4.6 0 1 1 -4.6 1 A4.6 4.6 0 1 1 4.6 1 Z M-3 7 H3 V10 H-3 Z',
  },
  // drone: long straight wings, slim body, no cockpit, inverted-V tail
  uav: { body: 'M0 -11 C1.3 -11 1.8 -9 1.8 -7 V-2 L16 -1 V1.5 L1.8 1.5 V9 L6 13 L5 14.5 L0 11.5 L-5 14.5 L-6 13 L-1.8 9 V1.5 L-16 1.5 V-1 L-1.8 -2 V-7 C-1.8 -9 -1.3 -11 0 -11 Z' },
  veh: { body: 'M-7 -10 H7 V10 H-7 Z' },
};
const vehPaths = {};
for (const [k, s] of Object.entries(VEH_SHAPES)) {
  vehPaths[k] = { body: new Path2D(s.body), dark: s.dark && new Path2D(s.dark), top: s.top && new Path2D(s.top), rotor: s.rotor };
}

function drawVehicle(x, y, v, color, isMe) {
  const p = vehPaths[v.kind] || vehPaths.veh;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(v.dir * Math.PI / 180);
  ctx.scale(1.25 * S.iconScale, 1.25 * S.iconScale);
  ctx.lineJoin = 'round';
  // Thick white outline under the fill keeps the silhouette readable on any background.
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.95)';
  ctx.stroke(p.body);
  if (p.top) ctx.stroke(p.top);
  ctx.fillStyle = color;
  ctx.fill(p.body);
  if (p.dark) { ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fill(p.dark); }
  if (p.top) {
    ctx.fillStyle = color; ctx.fill(p.top);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.stroke(p.top);
  }
  if (p.rotor) {
    circle(ctx, 0, -1, 14);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(20,20,20,.45)'; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(20,20,20,.8)';
    line(ctx, -10, -11, 10, 9); line(ctx, -10, 9, 10, -11);
  }
  ctx.restore();
  if (isMe) { circle(ctx, x, y, 24 * S.iconScale); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2.5; ctx.stroke(); }
}

function label(text, x, y, opt = {}) {
  ctx.font = `${opt.weight || ''} ${opt.size || 11}px Tahoma, "Segoe UI", sans-serif`;
  ctx.textAlign = opt.align || 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = opt.halo ?? 3;
  ctx.strokeStyle = opt.haloColor || 'rgba(255,255,255,.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = opt.color || '#1b1b1b';
  ctx.fillText(text, x, y);
}

// ============================================================ render

const patternCache = new Map();
function brushPattern(brush, color) {
  const key = brush + color;
  if (patternCache.has(key)) return patternCache.get(key);
  const p = document.createElement('canvas');
  p.width = p.height = 10;
  const c = p.getContext('2d');
  c.strokeStyle = color; c.lineWidth = 1.5;
  const L = (a, b, cc, d) => { c.beginPath(); c.moveTo(a, b); c.lineTo(cc, d); c.stroke(); };
  if (brush === 'Horizontal' || brush === 'Grid' || brush === 'Cross') L(0, 5, 10, 5);
  if (brush === 'Vertical' || brush === 'Grid' || brush === 'Cross') L(5, 0, 5, 10);
  if (brush === 'FDiagonal' || brush === 'DiagGrid') { L(0, 10, 10, 0); L(-5, 5, 5, -5); L(5, 15, 15, 5); }
  if (brush === 'BDiagonal' || brush === 'DiagGrid') { L(0, 0, 10, 10); L(-5, 5, 5, 15); L(5, -5, 15, 5); }
  const pat = ctx.createPattern(p, 'repeat');
  patternCache.set(key, pat);
  return pat;
}

function visibleWorld() {
  if (is3d()) { const ws = worldSize(); return { x0: 0, y0: 0, x1: ws, y1: ws }; }
  // Bounding box of the (possibly rotated) screen in world coordinates.
  const c = [s2w(0, 0), s2w(S.W, 0), s2w(0, S.H), s2w(S.W, S.H)];
  return {
    x0: Math.min(...c.map((p) => p[0])), x1: Math.max(...c.map((p) => p[0])),
    y0: Math.min(...c.map((p) => p[1])), y1: Math.max(...c.map((p) => p[1])),
  };
}

function visibleIndices(bk) {
  const v = visibleWorld();
  const { nb, buckets } = bk;
  const bx0 = Math.max(0, Math.floor(v.x0 / BUCKET) - 1), bx1 = Math.min(nb - 1, Math.floor(v.x1 / BUCKET) + 1);
  const by0 = Math.max(0, Math.floor(v.y0 / BUCKET) - 1), by1 = Math.min(nb - 1, Math.floor(v.y1 / BUCKET) + 1);
  const out = [];
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
    const b = buckets[by * nb + bx];
    for (let q = 0; q < b.length; q++) out.push(b[q]);
  }
  return out;
}

function draw() {
  S.dirty = false;
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  if (S.camId) return drawCamera();
  View3D.cam.fp = null;
  const gl = $('#gl');
  gl.hidden = !is3d();
  if (is3d()) return draw3d();
  ctx.fillStyle = '#3a4148';
  ctx.fillRect(0, 0, S.W, S.H);
  if (S.orient === 'heading') applyHeadingUp();
  else S.view.rot = 0;
  // Map images and the grid are drawn unrotated under a rotated canvas transform.
  const rotated = !!S.view.rot;
  if (rotated) {
    ctx.save();
    ctx.translate(vcx(), S.H / 2);
    ctx.rotate(-S.view.rot);
    ctx.translate(-vcx(), -S.H / 2);
    rotOff = true;
  }
  const ws = worldSize();
  const [x0, y0] = w2s(0, ws);
  const sz = ws * S.view.scale;
  const t = S.terrain;
  const style = effectiveStyle();

  // Brightness applies to the map image only, not to units, markers or labels.
  const useFilter = S.bright !== 1 && 'filter' in ctx;
  if (useFilter) ctx.filter = `brightness(${S.bright})`;
  if (style !== 'topo') drawSat();
  if (t && style !== 'sat') {
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = style === 'mix' ? 0.45 : 1;
    ctx.drawImage(t.base, x0, y0, sz, sz);
    ctx.globalAlpha = 1;
    // Zoomed past the base image resolution: redraw roads and buildings as vectors.
    if (S.view.scale * t.mpp > 1.5) {
      const toX = (x) => (x - S.view.cx) * S.view.scale + vcx();
      const toY = (y) => (S.view.cy - y) * S.view.scale + S.H / 2;
      if (style === 'topo' && S.layers.buildings) drawBuildings(ctx, t.blds, visibleIndices(t.bldBk), toX, toY, S.view.scale);
      if (style === 'topo' && S.layers.roads) drawRoads(ctx, t.roads, visibleIndices(t.roadBk), toX, toY, S.view.scale);
    }
  } else if (!t && style === 'topo') {
    ctx.fillStyle = '#e4e0cf';
    ctx.fillRect(x0, y0, sz, sz);
  }
  // Satellite / hybrid: roads on top (from the topo export).
  if (t && style !== 'topo' && S.layers.roads) {
    if (S.view.scale * t.mpp > 1.5) {
      const toX = (x) => (x - S.view.cx) * S.view.scale + vcx();
      const toY = (y) => (S.view.cy - y) * S.view.scale + S.H / 2;
      drawRoads(ctx, t.roads, visibleIndices(t.roadBk), toX, toY, S.view.scale);
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(t.roadsCanvas, x0, y0, sz, sz);
    }
  }
  if (useFilter) ctx.filter = 'none';
  else if (S.bright !== 1) {
    // Browsers without canvas filters: lighten or darken with an overlay.
    ctx.save();
    ctx.globalCompositeOperation = S.bright > 1 ? 'screen' : 'multiply';
    const a = S.bright > 1 ? Math.min(1, (S.bright - 1) * 0.6) : 1 - S.bright;
    ctx.fillStyle = S.bright > 1 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(x0, y0, sz, sz);
    ctx.restore();
  }

  if (S.layers.grid) drawGrid();
  if (rotated) { ctx.restore(); rotOff = false; }

  if (t && S.layers.names) drawLocations();
  if (S.state && onGameMap()) {
    if (S.layers.markers) drawMarkers();
    if (S.layers.units) drawUnits();
  }
  drawSelection();
  drawLinePreview();
  if (S.layers.compass) drawCompass();
}

function drawGrid() {
  const sc = S.view.scale, ws = worldSize();
  let g = 100;
  while (g * sc < 55 && g < 10000) g *= 10;
  const v = visibleWorld();
  const xa = Math.max(0, v.x0), xb = Math.min(ws, v.x1), ya = Math.max(0, v.y0), yb = Math.min(ws, v.y1);
  if (xa >= xb || ya >= yb) return;
  const [, syTop] = w2s(0, yb), [, syBot] = w2s(0, ya), [sxL] = w2s(xa, 0), [sxR] = w2s(xb, 0);

  const lines = (step, color, width) => {
    ctx.beginPath();
    for (let x = Math.ceil(xa / step) * step; x <= xb; x += step) {
      const sx = Math.round(w2s(x, 0)[0]) + 0.5;
      ctx.moveTo(sx, syTop); ctx.lineTo(sx, syBot);
    }
    for (let y = Math.ceil(ya / step) * step; y <= yb; y += step) {
      const sy = Math.round(w2s(0, y)[1]) + 0.5;
      ctx.moveTo(sxL, sy); ctx.lineTo(sxR, sy);
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  };
  if ((g / 10) * sc >= 12) lines(g / 10, 'rgba(0,0,0,0.07)', 1);
  lines(g, 'rgba(0,0,0,0.26)', 1);

  // Edge labels only make sense with north up.
  if (S.view.rot || !S.layers.gridLabels) return;
  const digits = g >= 1000 ? (ws >= 100000 ? 3 : 2) : 3;
  const div = g >= 1000 ? 1000 : 100;
  ctx.font = '11px Consolas, ui-monospace, monospace';
  ctx.textBaseline = 'top';
  const tag = (text, x, y, align) => {
    ctx.textAlign = align;
    const w = ctx.measureText(text).width + 6;
    const bx = align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = 'rgba(20,24,28,0.72)';
    ctx.fillRect(bx, y, w, 15);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText(text, align === 'center' ? x : x + 3, y + 2);
  };
  for (let x = Math.ceil(xa / g) * g; x < xb; x += g) {
    const sx = w2s(x + g / 2, 0)[0];
    if (sx > 20 && sx < S.W - 20) tag(pad(x / div, digits), sx, Math.max(2, syTop + 2), 'center');
  }
  for (let y = Math.ceil(ya / g) * g; y < yb; y += g) {
    const sy = w2s(0, y + g / 2)[1];
    if (sy > 20 && sy < S.H - 20) tag(pad(y / div, digits), Math.max(2, sxL + 2), sy - 7, 'left');
  }
}

const LOC_STYLE = {
  NameCityCapital: { size: 17, weight: 'bold', color: '#161616', min: 0 },
  NameCity: { size: 15, weight: 'bold', color: '#1d1d1d', min: 0 },
  Airport: { size: 12, weight: 'bold', color: '#333', min: 0.01 },
  NameVillage: { size: 13, weight: '', color: '#2a2a2a', min: 0.025 },
  NameMarine: { size: 12, weight: 'italic', color: '#2d5f8a', min: 0.02 },
  NameLocal: { size: 11, weight: 'italic', color: '#5a4a32', min: 0.08 },
  Hill: { size: 10, weight: '', color: '#6b5a3c', min: 0.4 },
  Mount: { size: 10, weight: '', color: '#6b5a3c', min: 0.4 },
};

function drawLocations() {
  const v = visibleWorld();
  for (const [name, type, x, y] of S.terrain.locations) {
    const st = LOC_STYLE[type];
    if (!st || viewScale() < st.min) continue;
    if (!S.layers.heights && (type === 'Mount' || type === 'Hill')) continue;
    if (is3d()) {
      // In 3D keep it readable: no hill heights, and minor names only near the camera target.
      if (type === 'Mount' || type === 'Hill') continue;
      const far = Math.hypot(x - View3D.cam.tx, y - View3D.cam.ty) > View3D.cam.dist * 2;
      if (far && type !== 'NameCityCapital' && type !== 'NameCity') continue;
    }
    if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) continue;
    const [sx, sy] = w2s(x, y);
    if (type === 'Mount' || type === 'Hill') {
      ctx.fillStyle = st.color;
      poly(ctx, [[sx, sy - 4], [sx + 4, sy + 3], [sx - 4, sy + 3]]); ctx.fill();
      const h = heightAt(x, y);
      label(name || (h !== null ? String(Math.round(h)) : ''), sx + 6, sy, st);
    } else {
      label(name, sx, sy, Object.assign({ align: 'center', halo: 3.5 }, st));
    }
  }
}

function markerTitle(m) { return m.text || (m.shape === 'ICON' ? m.type : tOr('shape.' + m.shape, m.shape)); }

const isTextOnly = (m) => m.shape === 'ICON' && (m.type === 'Empty' || m.type === 'EmptyIcon');
function markerVisible(m) { return m.alpha > 0 && !(isTextOnly(m) && !m.text); }

function drawMarkers() {
  const ms = S.state.markers;
  const sc = S.view.scale;
  for (const m of ms) {
    if (is3d() || !markerVisible(m) || (m.shape !== 'RECTANGLE' && m.shape !== 'ELLIPSE')) continue;
    const [sx, sy] = w2s(m.x, m.y);
    const ax = Math.abs(m.a) * sc, by = Math.abs(m.b) * sc;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(screenDir(m.x, m.y, m.dir) * Math.PI / 180);
    ctx.beginPath();
    if (m.shape === 'RECTANGLE') ctx.rect(-ax, -by, ax * 2, by * 2);
    else ctx.ellipse(0, 0, Math.max(ax, 0.5), Math.max(by, 0.5), 0, 0, Math.PI * 2);
    const col = rgba(m.rgba, m.alpha);
    const brush = m.brush || 'Solid';
    if (brush === 'Border') {
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    } else if (brush.startsWith('Solid')) {
      ctx.fillStyle = rgba(m.rgba, m.alpha * (brush === 'SolidFull' ? 1 : 0.5));
      ctx.fill();
      if (brush === 'SolidBorder') { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(); }
    } else {
      ctx.fillStyle = brushPattern(brush, col);
      ctx.fill();
    }
    ctx.restore();
  }
  for (const m of ms) {
    if (!markerVisible(m) || m.shape !== 'POLYLINE' || m.poly.length < 4) continue;
    ctx.beginPath();
    for (let q = 0; q < m.poly.length; q += 2) {
      const [px, py] = w2s(m.poly[q], m.poly[q + 1]);
      if (q === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(m.rgba, m.alpha); ctx.lineWidth = 2.5; ctx.stroke();
  }
  const v = visibleWorld();
  for (const m of ms) {
    if (!markerVisible(m) || m.shape !== 'ICON') continue;
    if (m.x < v.x0 - 500 || m.x > v.x1 + 500 || m.y < v.y0 - 500 || m.y > v.y1 + 500) continue;
    const [sx, sy] = w2s(m.x, m.y);
    const s = 11 * S.iconScale * Math.min(4, Math.max(0.3, Math.abs(m.a) || 1));
    const col = rgba(m.rgba, m.alpha);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(screenDir(m.x, m.y, m.dir) * Math.PI / 180);
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 2;
    drawMarkerIcon(ctx, m.type, s, col);
    ctx.restore();
    if (m.text) {
      const light = luma(m.rgba) > 0.6;
      const textOnly = isTextOnly(m);
      label(m.text, sx + (textOnly ? 0 : s + 4), sy, {
        size: textOnly ? 14 : 12, weight: 'bold', color: col, align: textOnly ? 'center' : 'left',
        haloColor: light ? 'rgba(0,0,0,.75)' : 'rgba(255,255,255,.9)',
      });
    }
  }
}

function groupSide(u) { const g = S.state && S.state.groups && S.state.groups[u.group]; return g ? g.side : 'CIV'; }
function sideShown(side) { return side !== 'CIV' || S.layers.civ; }

function drawUnits() {
  const st = S.state;
  const meId = st.me && st.me.id;
  const vehSide = new Map();
  const vehMe = new Set();
  for (const u of st.units) {
    if (!u.veh) continue;
    if (!vehSide.has(u.veh)) vehSide.set(u.veh, groupSide(u));
    if (u.id === meId) vehMe.add(u.veh);
  }
  const showAiNames = S.layers.aiNames && viewScale() > 0.6;

  // Unoccupied friendly vehicles: faded, drawn below everything else.
  if (S.layers.empty) {
    for (const e of st.empty || []) {
      if (!sideShown(e.side)) continue;
      const [sx, sy] = w2s(e.x, e.y);
      if (!(is3d() && S.layers.models3d)) {
        ctx.globalAlpha = 0.5;
        drawVehicle(sx, sy, { kind: e.kind, dir: screenDir(e.x, e.y, e.dir) }, SIDE_COLOR[e.side] || '#777', false);
        ctx.globalAlpha = 1;
      }
      if (S.layers.labels && showAiNames) label(`${e.type} (${t('info.empty')})`, sx + 20 * S.iconScale, sy, { size: 10, color: '#444' });
    }
  }

  for (const v of st.vehicles) {
    const side = vehSide.get(v.id) || 'CIV';
    if (!sideShown(side)) continue;
    if (S.camId && camObj() === v) continue; // sitting inside it
    const P = animPos(v);
    let sx, sy;
    if (is3d() && v.alt > 3) {
      // Aircraft: drawn at their altitude with a drop line to the ground.
      const g = Math.max(0, heightAt(P.x, P.y) ?? 0);
      const [gx, gy] = w2s(P.x, P.y, g);
      [sx, sy] = w2s(P.x, P.y, g + v.alt);
      ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      line(ctx, gx, gy, sx, sy); ctx.setLineDash([]);
    } else {
      [sx, sy] = w2s(P.x, P.y);
    }
    const model = is3d() && S.layers.models3d; // the 3D renderer draws the vehicle itself
    if (!model) {
      const z = is3d() && v.alt > 3 ? Math.max(0, heightAt(P.x, P.y) ?? 0) + v.alt : undefined;
      drawVehicle(sx, sy, { kind: v.kind, dir: screenDir(P.x, P.y, P.dir, z) }, SIDE_COLOR[side] || '#777', vehMe.has(v.id));
    } else if (vehMe.has(v.id)) {
      circle(ctx, sx, sy, 16); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    if (S.layers.labels && (showAiNames || st.units.some((u) => u.veh === v.id && u.player))) {
      label(v.type, sx + 22, sy, { size: 11, color: '#1b1b1b' });
    }
  }
  let me = null;
  for (const u of st.units) {
    if (u.veh) continue;
    const side = groupSide(u);
    if (!sideShown(side)) continue;
    if (u.id === S.camId) continue; // the camera is this unit's eyes
    if (u.id === meId) { me = u; continue; }
    const P = animPos(u);
    const [sx, sy] = w2s(P.x, P.y);
    drawMan(sx, sy, screenDir(P.x, P.y, P.dir), SIDE_COLOR[side] || '#777', false, u.life, u.hp);
    if (S.layers.labels && (u.player || showAiNames)) label(u.name, sx + 10, sy, { size: 11, weight: u.player ? 'bold' : '' });
  }
  if (S.layers.groups && viewScale() > 0.02) {
    st.groups.forEach((g) => {
      if (!sideShown(g.side)) return;
      const leader = st.units.find((u) => u.id === g.leader);
      if (!leader) return;
      const lv = leader.veh && st.vehicles.find((v) => v.id === leader.veh);
      const P = animPos(lv || leader);
      const [sx, sy] = w2s(P.x, P.y);
      label(g.name, sx, sy - 17, { size: 11, weight: 'bold', align: 'center', color: SIDE_COLOR[g.side] || '#333' });
    });
  }
  if (me) {
    const P = animPos(me);
    const [sx, sy] = w2s(P.x, P.y);
    drawMan(sx, sy, screenDir(P.x, P.y, P.dir), SIDE_COLOR[groupSide(me)] || '#777', true, me.life, me.hp);
    if (S.layers.labels) label(me.name, sx + 12, sy, { size: 12, weight: 'bold' });
  }
}

// ---- smooth movement: positions arrive many times per second and are interpolated in between.

const anim = new Map(); // id -> { fx, fy, fd, tx, ty, td, t0 }
let posDur = 100;       // measured time between position updates (ms)
let lastPosAt = 0;
let animRunning = false;

function lerpAngle(a, b, k) { return a + ((((b - a) % 360) + 540) % 360 - 180) * k; }

// Displayed position of a unit/vehicle/marker: interpolated if it is moving.
function animPos(o) {
  const a = S.layers.smooth && o.id !== undefined && anim.get(o.id);
  if (!a) return o;
  const k = Math.min(1, (performance.now() - a.t0) / posDur);
  return { x: a.fx + (a.tx - a.fx) * k, y: a.fy + (a.ty - a.fy) * k, dir: lerpAngle(a.fd, a.td, k) };
}

function setTarget(o, x, y, dir) {
  const cur = animPos(o);
  anim.set(o.id, { fx: cur.x, fy: cur.y, fd: cur.dir ?? dir, tx: x, ty: y, td: dir, t0: performance.now() });
  o.x = x; o.y = y; o.dir = dir;
}

function startAnim() {
  if (animRunning) return;
  animRunning = true;
  const step = () => {
    if (S.follow) followMe();
    S.dirty = false;
    draw();
    if (performance.now() - lastPosAt < posDur + 80) requestAnimationFrame(step);
    else animRunning = false;
  };
  requestAnimationFrame(step);
}

// A state snapshot with every list present, so a partial or older payload cannot break the views.
function normState(d) {
  for (const k of ['groups', 'units', 'vehicles', 'markers', 'empty', 'dead']) if (!Array.isArray(d[k])) d[k] = [];
  return d;
}

function onPos(p) {
  if (!Array.isArray(p.units)) p.units = [];
  if (!Array.isArray(p.vehicles)) p.vehicles = [];
  onLivePos(p); // detail-page gauges follow the position stream, even off the map view
  const st = S.state;
  if (!st || !onGameMap()) return;
  const now = performance.now();
  if (lastPosAt) posDur = Math.min(400, Math.max(30, posDur * 0.7 + (now - lastPosAt) * 0.3));
  lastPosAt = now;
  const units = new Map(st.units.map((u) => [u.id, u]));
  const vehs = new Map(st.vehicles.map((v) => [v.id, v]));
  for (const [id, x, y, dir] of p.units) { const u = units.get(id); if (u) setTarget(u, x, y, dir); }
  for (const [id, x, y, dir, alt, speed] of p.vehicles) {
    const v = vehs.get(id);
    if (!v) continue;
    setTarget(v, x, y, dir);
    v.alt = alt;
    if (Number.isFinite(speed)) v.speed = speed; // km/h, same source as the state's value
  }
  for (const u of st.units) { // crew rides with its vehicle
    const v = u.veh && vehs.get(u.veh);
    if (v) { u.x = v.x; u.y = v.y; }
  }
  if (st.me && p.me) { [st.me.x, st.me.y, st.me.dir] = p.me; }
  startAnim();
}

// Keeps the view on the player's displayed (interpolated) position.
function followMe() {
  const o = trackObj();
  if (!o) return;
  const P = animPos(o);
  S.view.cx = P.x; S.view.cy = P.y;
  View3D.focus(P.x, P.y, undefined, altOf(o));
}

// A full state update replaces the objects; keep newer positions from recent position updates.
function mergeAnimIntoState() {
  const st = S.state;
  const now = performance.now();
  const ids = new Set();
  for (const o of [...st.units, ...st.vehicles]) {
    ids.add(o.id);
    const a = anim.get(o.id);
    if (!a) continue;
    if (now - a.t0 > 1500) anim.delete(o.id); // position updates stopped: trust the state
    else { o.x = a.tx; o.y = a.ty; o.dir = a.td; }
  }
  for (const id of anim.keys()) if (!ids.has(id)) anim.delete(id);
}

function findSelected() {
  const sel = S.selected, st = S.state;
  if (!sel || !st) return null;
  if (sel.kind === 'unit') return st.units.find((u) => u.id === sel.id) || null;
  if (sel.kind === 'veh') return st.vehicles.find((v) => v.id === sel.id) || null;
  if (sel.kind === 'empty') return (st.empty || []).find((v) => v.id === sel.id) || null;
  if (sel.kind === 'marker') return st.markers.find((m) => m.name === sel.id) || null;
  return null;
}

function drawSelection() {
  const o = findSelected();
  if (!o) return;
  const P = animPos(o);
  const [sx, sy] = w2s(P.x, P.y);
  ctx.strokeStyle = '#ff3fa4'; ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  circle(ctx, sx, sy, 17); ctx.stroke();
  ctx.setLineDash([]);
}

// ============================================================ hit testing & info

function hitTest(px, py) {
  const st = S.state;
  if (!st || !onGameMap()) return null;
  // On a phone, air units are easy to hit by accident; only ground entities are tappable there.
  const groundOnly = window.matchMedia('(max-width: 760px)').matches;
  let best = null, bestD = 16 * 16;
  const consider = (kind, id, x, y) => {
    const [sx, sy] = w2s(x, y);
    const d = (sx - px) ** 2 + (sy - py) ** 2;
    if (d < bestD) { bestD = d; best = { kind, id }; }
  };
  if (S.layers.units) {
    const vehSide = new Map();
    for (const u of st.units) {
      if (u.veh) { if (!vehSide.has(u.veh)) vehSide.set(u.veh, groupSide(u)); continue; }
      if (sideShown(groupSide(u))) consider('unit', u.id, u.x, u.y);
    }
    for (const v of st.vehicles) {
      if (groundOnly && (v.kind === 'plane' || v.kind === 'heli' || v.kind === 'uav')) continue;
      if (sideShown(vehSide.get(v.id) || 'CIV')) consider('veh', v.id, v.x, v.y);
    }
    if (S.layers.empty) for (const e of st.empty || []) if (sideShown(e.side)) consider('empty', e.id, e.x, e.y);
  }
  if (S.layers.markers) {
    for (const m of st.markers) if (markerVisible(m) && m.shape === 'ICON') consider('marker', m.name, m.x, m.y);
    // Lines: distance from the click to each segment.
    for (const m of st.markers) {
      if (!markerVisible(m) || m.shape !== 'POLYLINE' || m.poly.length < 4) continue;
      for (let q = 0; q + 3 < m.poly.length; q += 2) {
        const [ax, ay] = w2s(m.poly[q], m.poly[q + 1]), [bx, by] = w2s(m.poly[q + 2], m.poly[q + 3]);
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
        const k = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2));
        const d = (ax + k * (bx - ax) - px) ** 2 + (ay + k * (by - ay) - py) ** 2;
        if (d < bestD) { bestD = d; best = { kind: 'marker', id: m.name }; }
      }
    }
  }
  return best;
}

function select(sel) {
  S.selected = sel;
  renderInfo();
  detailFollowSelection(sel);
  wsRenderAll(); // panels set to "selected" follow the map selection
  redraw();
}

function renderInfo() {
  const box = $('#info');
  // While the detail panel is open it replaces the info box, so keep the info box closed.
  if (S.detailId && !DETAIL_ID) { box.hidden = true; return; }
  const o = findSelected();
  if (!o) { box.hidden = true; return; }
  const kind = S.selected.kind;
  const st = S.state;
  const rows = [];
  let title = '', chip = '#777', actions = '';
  const grid = gridRef(o.x, o.y);
  if (kind === 'unit') {
    const g = st.groups[o.group];
    chip = SIDE_COLOR[g && g.side] || chip;
    title = o.name;
    rows.push([t('info.type'), o.type], [t('info.group'), g ? g.name : '-'], [t('info.rank'), o.rank],
      [t('info.status'), tOr('life.' + o.life, o.life)], [t('info.health'), `${Math.round((o.hp ?? 1) * 100)}%`]);
    if (o.veh) { const v = st.vehicles.find((x) => x.id === o.veh); if (v) rows.push([t('info.inside'), v.type]); }
    rows.push([t('info.player'), o.player ? t('info.yes') : t('info.ai')]);
  } else if (kind === 'veh') {
    const crew = st.units.filter((u) => u.veh === o.id);
    chip = SIDE_COLOR[crew.length ? groupSide(crew[0]) : 'CIV'] || chip;
    title = o.type;
    const num = (v, unit) => (Number.isFinite(v) ? `${Math.round(v)} ${unit}` : '—'); // never "undefined km/h"
    rows.push([t('info.type'), tOr('kind.' + o.kind, o.kind)], [t('info.speed'), num(o.speed, 'km/h')], [t('info.alt'), num(o.alt, 'm')],
      [t('info.crew'), crew.map((u) => u.name).join(LANG === 'fa' ? '، ' : ', ') || '-']);
  } else if (kind === 'empty') {
    chip = SIDE_COLOR[o.side] || chip;
    title = o.type;
    rows.push([t('info.type'), tOr('kind.' + o.kind, o.kind)], [t('info.status'), t('info.empty')]);
  } else {
    chip = rgba(o.rgba, 1);
    title = markerTitle(o);
    rows.push([t('info.type'), o.type], [t('info.channel'), o.channel === null ? t('channel.mission') : (CHANNEL_NAME[o.channel] || o.channel)]);
    if (o.user) actions = `<button class="btn danger" data-del="${esc(o.name)}">${esc(t('info.delete'))}</button>`;
  }
  if (kind !== 'marker') {
    const following = S.follow && S.followId === o.id;
    actions = `<button class="btn${following ? ' primary' : ''}" data-follow="${esc(o.id)}">${esc(t(following ? 'info.unfollow' : 'info.follow'))}</button>` +
      `<button class="btn" data-detail="${esc(o.id)}">${esc(t('info.detail'))}</button>` +
      (S.layers.camera && View3D.supported() ? `<button class="btn" data-cam="${esc(o.id)}">${esc(t('info.camera'))}</button>
        <button class="btn" data-camwin="${esc(o.id)}" title="${esc(t('info.camera_window'))}">↗</button>` : '');
  }
  const gridKey = t('info.grid');
  rows.push([gridKey, `<span dir="ltr">${grid}</span>`]);
  const h = heightAt(o.x, o.y);
  if (h !== null) rows.push([t('info.elev'), `${Math.round(h)} m`]);
  box.innerHTML = `
    <h4><span class="side-chip" style="background:${chip}"></span>${kind === 'veh' || kind === 'empty' ? kindIcon(o.kind, 16, 'info-kind') : ''}${esc(title)}
      <button class="close" data-close aria-label="${esc(t('info.close'))}">×</button></h4>
    <div class="kv">${rows.map(([k, v]) => `<span>${esc(k)}</span><span><bdi>${k === gridKey ? v : esc(v)}</bdi></span>`).join('')}</div>
    ${actions ? `<div class="acts">${actions}</div>` : ''}`;
  box.hidden = false;
}

$('#info').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) select(null);
  const f = e.target.closest('[data-follow]');
  if (f) {
    if (S.follow && S.followId === f.dataset.follow) setFollow(false);
    else { S.followId = f.dataset.follow; setFollow(true); }
    renderInfo();
  }
  const c = e.target.closest('[data-cam]');
  if (c) openCamera(c.dataset.cam);
  const w = e.target.closest('[data-camwin]');
  if (w) openCameraWindow(w.dataset.camwin);
  const dt = e.target.closest('[data-detail]');
  if (dt) openDetail(dt.dataset.detail);
  const del = e.target.closest('[data-del]');
  if (del) deleteMarker(del.dataset.del);
});

// ============================================================ input

const pointers = new Map();
let gesture = null;
let longPress = null;

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function userMoved() {
  S.view.userMoved = true;
  if (S.follow) setFollow(false);
}

function openMarkerAt(px, py) {
  const w = s2w(px, py);
  if (w) openMarkerDialog(w[0], w[1]);
}

let suppressContextMenu = false;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = canvasPos(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 1) {
    // In 3D: left drag rotates; right drag or Shift+drag pans.
    gesture = { start: p, last: p, moved: false, button: e.button, pan3d: e.button === 2 || e.shiftKey };
    if (e.button === 0 && hitCompass(p[0], p[1])) {
      const g = compassGeom();
      gesture.compass = [p[0] - g.x, p[1] - g.y]; // grab offset: dragging moves the compass
    }
    if (e.pointerType !== 'mouse') {
      clearTimeout(longPress);
      longPress = setTimeout(() => {
        if (gesture && !gesture.moved) { gesture.moved = true; openMarkerAt(p[0], p[1]); }
      }, 550);
    }
  } else if (pointers.size === 2) {
    clearTimeout(longPress);
    const [a, b] = [...pointers.values()];
    gesture = { pinch: true, dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], moved: true };
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = canvasPos(e);
  if (e.pointerType === 'mouse' && !pointers.size) updateCursor(p);
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, p);
  if (!gesture) return;
  if (gesture.pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (S.camId) {
      if (dist > 0) S.camLook.fov = Math.min(90, Math.max(8, S.camLook.fov * gesture.dist / dist));
    } else if (is3d()) {
      View3D.pan(mid[0] - gesture.mid[0], mid[1] - gesture.mid[1]);
      if (dist > 0) View3D.zoom(gesture.dist / dist);
    } else {
      panBy(mid[0] - gesture.mid[0], mid[1] - gesture.mid[1]);
      if (gesture.dist > 0) zoomAt(mid[0], mid[1], dist / gesture.dist);
    }
    gesture.dist = dist; gesture.mid = mid;
    userMoved();
    redraw();
  } else if (!gesture.pinch && pointers.size === 1) {
    if (!gesture.moved && Math.hypot(p[0] - gesture.start[0], p[1] - gesture.start[1]) > 6) {
      gesture.moved = true;
      clearTimeout(longPress);
      canvas.classList.add('dragging');
    }
    if (gesture.moved && gesture.compass) {
      S.compassPos = [p[0] - gesture.compass[0], p[1] - gesture.compass[1]];
      redraw();
    } else if (gesture.moved && S.camId) {
      // Camera view: drag to look around (relative to the unit's heading).
      const L = S.camLook;
      L.yaw += (p[0] - gesture.last[0]) * 0.25 * (L.fov / 60);
      L.pitch = Math.min(80, Math.max(-80, L.pitch - (p[1] - gesture.last[1]) * 0.25 * (L.fov / 60)));
      redraw();
    } else if (gesture.moved) {
      const dx = p[0] - gesture.last[0], dy = p[1] - gesture.last[1];
      if (is3d()) {
        if (gesture.pan3d || e.shiftKey) View3D.pan(dx, dy); else View3D.rotate(dx, dy);
      } else {
        panBy(dx, dy);
      }
      userMoved();
      redraw();
    }
    gesture.last = p;
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const p = canvasPos(e);
  pointers.delete(e.pointerId);
  clearTimeout(longPress);
  canvas.classList.remove('dragging');
  if (gesture && gesture.moved && gesture.button === 2) suppressContextMenu = true; // that was a pan, not a click
  if (gesture && gesture.moved && gesture.compass) storeSet('compassPos', S.compassPos);
  if (gesture && !gesture.moved && !gesture.pinch && e.type === 'pointerup' && gesture.button === 0) {
    if (S.camId) { /* camera view: clicks only look around */ }
    else if (hitCompass(p[0], p[1])) toggleOrient();
    else if (S.tool === 'line') addLinePoint(p[0], p[1]);
    else if (S.tool === 'text') openDrawAt('text', p[0], p[1]);
    else if (S.tool === 'marker') openMarkerAt(p[0], p[1]);
    else select(hitTest(p[0], p[1]));
  }
  if (pointers.size === 0) gesture = null;
  else if (pointers.size === 1) {
    const q = [...pointers.values()][0];
    gesture = { start: q, last: q, moved: true };
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { $('#cursor-grid').textContent = ''; });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [px, py] = canvasPos(e);
  const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
  if (S.camId) { S.camLook.fov = Math.min(90, Math.max(8, S.camLook.fov / f)); redraw(); return; }
  if (is3d()) { View3D.zoom(1 / f); redraw(); } else zoomAt(px, py, f);
  userMoved();
}, { passive: false });

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (suppressContextMenu) { suppressContextMenu = false; return; }
  if (S.camId) return;
  const [px, py] = canvasPos(e);
  if (S.tool === 'line') { finishLine(); return; } // right-click ends the line
  openMarkerAt(px, py);
});
canvas.addEventListener('dblclick', (e) => {
  if (S.camId) { S.camLook = { yaw: 0, pitch: 0, fov: 60 }; redraw(); return; } // reset the look direction
  if (S.tool === 'line') { e.preventDefault(); finishLine(); }
});

// ---- map orientation
function toggleOrient() { setOrient(S.orient === 'north' ? 'heading' : 'north'); }
function setOrient(o) {
  S.orient = o;
  storeSet('orient', o);
  if (o === 'north') { S.view.rot = 0; }
  updateOrientUI();
  redraw();
}
function updateOrientUI() {
  document.querySelectorAll('#orient-seg button').forEach((b) => b.classList.toggle('active', b.dataset.orient === S.orient));
}
document.querySelectorAll('#orient-seg button').forEach((b) => b.addEventListener('click', () => setOrient(b.dataset.orient)));

// ---- drawing tools: marker, line, text
function setTool(tool) {
  S.tool = tool;
  if (tool !== 'line') S.linePts = [];
  document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  updateLineBar();
  canvas.classList.toggle('drawing', tool !== 'select');
  redraw();
}
document.querySelectorAll('#tools [data-tool]').forEach((b) => b.addEventListener('click', () => {
  const tool = b.dataset.tool;
  if (tool !== 'select' && !S.status.connected) { toast(t('toast.not_connected')); return; }
  if (tool !== 'select' && !onGameMap()) { toast(t('toast.not_game_map')); return; }
  setTool(S.tool === tool ? 'select' : tool);
}));

function addLinePoint(px, py) {
  const w = s2w(px, py);
  if (!w) return;
  S.linePts.push(w);
  updateLineBar();
  redraw();
}
function updateLineBar() {
  const bar = $('#line-bar');
  bar.hidden = S.tool !== 'line';
  $('#line-count').textContent = t('tools.points', { n: S.linePts.length });
  $('#line-done').disabled = S.linePts.length < 2;
}
function finishLine() {
  if (S.linePts.length < 2) return;
  openDrawDialog('line', S.linePts[0][0], S.linePts[0][1]);
}
$('#line-undo').addEventListener('click', () => { S.linePts.pop(); updateLineBar(); redraw(); });
$('#line-done').addEventListener('click', finishLine);
$('#line-cancel').addEventListener('click', () => setTool('select'));

function drawLinePreview() {
  if (S.tool !== 'line' || !S.linePts.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  S.linePts.forEach(([x, y], i) => { const [sx, sy] = w2s(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 5; ctx.stroke();
  ctx.strokeStyle = '#e02424'; ctx.lineWidth = 2.5; ctx.stroke();
  for (const [x, y] of S.linePts) {
    const [sx, sy] = w2s(x, y);
    circle(ctx, sx, sy, 4); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#e02424'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.restore();
}

function openDrawAt(mode, px, py) {
  const w = s2w(px, py);
  if (w) openDrawDialog(mode, w[0], w[1]);
}

function updateCursor(p) {
  if (!S.layers.cursor) { $('#cursor-grid').textContent = ''; return; }
  const w = s2w(p[0], p[1]);
  const ws = worldSize();
  if (!w || w[0] < 0 || w[1] < 0 || w[0] > ws || w[1] > ws) { $('#cursor-grid').textContent = ''; return; }
  const [x, y] = w;
  const h = heightAt(x, y);
  $('#cursor-grid').textContent = `GRID ${gridRef(x, y)}` + (h !== null ? `  ·  ${Math.round(h)} m` : '');
}

function setFollow(on) {
  S.follow = on;
  if (!on) S.followId = null; // turning follow off returns to following the player next time
  updateFollowUI();
  if (on) centerOnMe();
}
function updateFollowUI() {
  const b = $('#btn-follow'), c = $('#btn-me');
  const o = trackObj();
  const other = S.followId && objById(S.followId);
  const name = other ? (other.name || other.type) : '';
  // follow can be armed before the position is known (it starts tracking when it arrives);
  // centring needs a position now
  const st = !S.follow ? 'off' : (o ? 'on' : 'wait');
  b.setAttribute('aria-pressed', String(S.follow));
  b.dataset.state = st;
  const fl = st === 'off' ? t('follow') : (st === 'wait' ? t('follow.wait') : (name ? t('follow.unit', { name }) : t('follow.on')));
  b.title = fl + (st === 'off' ? '' : ' · ' + t('follow.stop'));
  b.setAttribute('aria-label', b.title);
  const who = $('#follow-who');
  who.hidden = !(S.follow && name);
  if (!who.hidden && who.textContent !== name) who.textContent = name;
  c.dataset.state = o ? 'ok' : 'na';
  c.setAttribute('aria-disabled', String(!o));
  c.title = o ? t('center_me') : t('center_me') + ' · ' + t('mapctl.no_pos');
  c.setAttribute('aria-label', c.title);
}
function centerOnMe() {
  const o = trackObj();
  if (!o) return;
  const P = animPos(o);
  centerOn(P.x, P.y, S.view.userMoved ? 0 : 0.15);
  View3D.cam.tz = altOf(o);
}
$('#btn-follow').addEventListener('click', () => setFollow(!S.follow));
$('#btn-me').addEventListener('click', () => {
  const b = $('#btn-me');
  if (!trackObj()) { toast(t('mapctl.no_pos')); return; }
  centerOnMe(); S.view.userMoved = true;
  // a one-off action: a short pulse, no lasting state
  b.classList.remove('ping'); void b.offsetWidth; b.classList.add('ping');
});

// The control cluster at the map's bottom-right corner (hint, cursor grid, follow, centre).
// It belongs to the map area, and moves aside from whatever is anchored over that corner:
// the detail page (right side in RTL), the selection card, the line bar, the drawing tools and
// docked workspace columns.
let mapCtlRaf = 0;
function mapCtlPlace() {
  if (mapCtlRaf) return;
  mapCtlRaf = requestAnimationFrame(() => { mapCtlRaf = 0; mapCtlPlaceNow(); });
}
function mapCtlPlaceNow() {
  updateCompassPad();
  const box = $('#map-ctl'), wrap = $('#map-wrap');
  if (!box || !wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const cw = box.offsetWidth, ch = box.offsetHeight;
  const m = window.innerWidth <= 760 ? 8 : 12;
  const wr = wrap.getBoundingClientRect();
  const obst = [];
  const add = (el) => {
    if (!el || el.hidden || el.offsetParent === null) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    obst.push({ l: r.left - wr.left, t: r.top - wr.top, r: r.right - wr.left, b: r.bottom - wr.top });
  };
  ['#detail', '#info', '#line-bar', '#tools'].forEach((q) => add($(q)));
  const ws = $('#ws');
  if (ws && !ws.hidden && !ws.classList.contains('ws-editing')) ws.querySelectorAll('.wsp-dock, .ws-tray:not([hidden]), .ws-dirty:not([hidden])').forEach(add);
  let right = m, bottom = m;
  for (let pass = 0; pass < 4; pass++) {
    const x0 = W - right - cw, y0 = H - bottom - ch;
    const hit = obst.find((o) => o.l < x0 + cw && o.r > x0 && o.t < y0 + ch && o.b > y0);
    if (!hit) break;
    const toLeft = W - hit.l + 8, toUp = H - hit.t + 8;
    // the smaller move that still keeps the cluster inside the map
    const okL = toLeft + cw <= W - m, okU = toUp + ch <= H - m;
    if (okL && (!okU || toLeft - right <= toUp - bottom)) right = toLeft; else if (okU) bottom = toUp; else break;
  }
  box.style.right = right + 'px';
  box.style.bottom = bottom + 'px';
}
{
  const ro = new ResizeObserver(mapCtlPlace);
  ro.observe($('#map-wrap'));
  ro.observe($('#map-ctl'));
  const mo = new MutationObserver(mapCtlPlace);
  for (const q of ['#detail', '#info', '#line-bar', '#tools']) {
    const el = $(q);
    if (el) { mo.observe(el, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] }); ro.observe(el); }
  }
  window.addEventListener('resize', mapCtlPlace);
  // the floating view controls (phones) collapse, wrap and move with the top bar
  const vc = $('#view-ctrls');
  if (vc) { ro.observe(vc); mo.observe(vc, { attributes: true, attributeFilter: ['class', 'style'] }); }
}

// ============================================================ panel

const appEl = $('#app');
if (window.innerWidth < 760) appEl.classList.add('panel-closed');
$('#btn-panel').addEventListener('click', () => {
  appEl.classList.toggle('panel-closed');
  renderLists();
});
// Phone bottom sheet: tap the handle to close.
$('#sheet-handle').addEventListener('click', () => appEl.classList.add('panel-closed'));

let activeTab = 'units';
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  activeTab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)); });
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + activeTab));
  if (activeTab === 'layers') loadSetup();
  renderLists();
}));

document.querySelectorAll('[data-layer]').forEach((cb) => {
  cb.checked = !!S.layers[cb.dataset.layer];
  cb.addEventListener('change', () => {
    S.layers[cb.dataset.layer] = cb.checked;
    // a layer can have a switch in more than one place: keep them all in step
    document.querySelectorAll(`[data-layer="${cb.dataset.layer}"]`).forEach((x) => { x.checked = cb.checked; });
    storeSet('layers', S.layers);
    if (S.terrain && S.terrain.baked !== bakedKey()) {
      S.terrain = buildTerrain(S.terrain.raw);
      s3.texKey = null;
    }
    applyUiToggles();
    sync3d();
    renderLists();
    renderInfo();
    redraw();
  });
});

// Show/hide interface pieces that are plain HTML.
function applyUiToggles() {
  $('#tools').hidden = !S.layers.tools;
  if (!S.layers.tools && S.tool !== 'select') setTool('select');
  $('#hint').hidden = !S.layers.hint;
  // Camera features: the buttons only exist while the setting is on.
  $('#btn-gameview').hidden = !S.layers.camera;
  if (!S.layers.camera && S.camId && !POPUP_CAM) closeCamera();
  renderInfo();
  if (!S.layers.cursor) $('#cursor-grid').textContent = '';
}

function renderLists() {
  const st = S.state;
  const units = st ? st.units.filter((u) => sideShown(groupSide(u))) : [];
  const dead = st && st.dead ? st.dead.filter((d) => sideShown(d.side)) : [];
  const markers = st ? st.markers.filter(markerVisible) : [];
  $('#count-units').textContent = st ? `(${units.length + dead.length})` : '';
  $('#count-markers').textContent = st ? `(${markers.length})` : '';
  if (appEl.classList.contains('panel-closed')) return;

  if (activeTab === 'units') {
    const el = $('#units-list');
    if (!st || (!units.length && !dead.length)) { el.innerHTML = `<div class="empty">${t(st ? 'empty.units' : 'empty.waiting')}</div>`; return; }
    const meId = st.me && st.me.id;
    const byGroup = new Map();
    for (const u of units) (byGroup.get(u.group) || byGroup.set(u.group, []).get(u.group)).push(u);
    const order = [...byGroup.keys()].sort((a, b) => {
      const ma = byGroup.get(a).some((u) => u.id === meId) ? 0 : 1, mb = byGroup.get(b).some((u) => u.id === meId) ? 0 : 1;
      const ga = st.groups[a] || { side: '', name: '' }, gb = st.groups[b] || { side: '', name: '' };
      return ma - mb || ga.side.localeCompare(gb.side) || String(ga.name).localeCompare(String(gb.name));
    });
    const vehName = new Map(st.vehicles.map((v) => [v.id, v.type]));
    const vehKind = new Map(st.vehicles.map((v) => [v.id, v.kind]));
    let html = order.map((gi) => {
      const g = st.groups[gi] || { name: '?', side: 'CIV', leader: '' }, list = byGroup.get(gi);
      const mine = list.some((u) => u.id === meId);
      return `<div class="grp-head${mine ? ' mine' : ''}" data-unit="${esc(g.leader)}">
          <span class="side-chip" style="background:${SIDE_COLOR[g.side] || '#777'}"></span>
          <span>${esc(g.name)}</span><span class="count">${list.length}</span></div>` +
        list.map((u) => `<div class="row-item${u.id === meId ? ' me' : ''}${u.life === 'INCAPACITATED' ? ' down' : ''}" data-unit="${esc(u.id)}">
          <span class="name">${u.leader ? '★ ' : ''}${esc(u.name)}</span>
          ${u.life === 'INCAPACITATED' ? `<span class="tag down">✚ ${t('tag.medic')}</span>`
            : (u.hp ?? 1) < 0.99 ? `<span class="tag" style="color:${hpColor(u.hp)}">${Math.round(u.hp * 100)}%</span>` : ''}
          ${u.player ? `<span class="tag">${t('tag.player')}</span>` : ''}
          <span class="sub">${u.veh ? kindIcon(vehKind.get(u.veh), 13, 'sub-ic') : ''}${esc(u.veh ? vehName.get(u.veh) || '' : u.type)}</span></div>`).join('');
    }).join('');
    if (dead.length) {
      // Fallen friendlies stay on the roster (in red) until they respawn.
      html += `<div class="grp-head kia"><span class="side-chip" style="background:var(--bad)"></span>
          <span>${esc(t('group.kia'))}</span><span class="count">${dead.length}</span></div>` +
        dead.map((d) => `<div class="row-item dead" data-deadx="${d.x}" data-deady="${d.y}">
          <span class="name">${esc(d.name)}</span><span class="tag down">${esc(t('tag.dead'))}</span>
          <span class="sub">${d.killer ? esc(t('killed.by', { name: d.killer })) : ''}</span></div>`).join('');
    }
    el.innerHTML = html;
  } else if (activeTab === 'markers') {
    const el = $('#markers-list');
    if (!markers.length) { el.innerHTML = `<div class="empty">${t(st ? 'empty.markers' : 'empty.waiting')}</div>`; return; }
    const sorted = [...markers].sort((a, b) => (b.user - a.user) || markerTitle(a).localeCompare(markerTitle(b)));
    el.innerHTML = sorted.map((m) => `<div class="row-item mk-item" data-marker="${esc(m.name)}">
        <span class="mk-swatch" style="background:${rgba(m.rgba, 1)}"></span>
        <span class="name">${esc(markerTitle(m))}</span>
        <span class="sub">${m.channel === null ? t('channel.mission') : esc(CHANNEL_NAME[m.channel] || '')}</span>
        ${m.user ? `<button class="mk-del" type="button" data-del="${esc(m.name)}" title="${esc(t('delete'))}" aria-label="${esc(t('delete'))}">×</button>` : ''}</div>`).join('');
  }
}

$('#units-list').addEventListener('click', (e) => {
  const deadRow = e.target.closest('[data-deadx]');
  if (deadRow) {
    centerOn(Number(deadRow.dataset.deadx), Number(deadRow.dataset.deady), 0.5);
    userMoved();
    if (window.innerWidth < 760) appEl.classList.add('panel-closed');
    return;
  }
  const row = e.target.closest('[data-unit]');
  if (!row || !S.state) return;
  const u = S.state.units.find((x) => x.id === row.dataset.unit);
  if (!u) return;
  const sel = u.veh ? { kind: 'veh', id: u.veh } : { kind: 'unit', id: u.id };
  centerOn(u.x, u.y, 0.5);
  userMoved();
  select(sel);
  if (window.innerWidth < 760) appEl.classList.add('panel-closed');
});
$('#markers-list').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { deleteMarker(del.dataset.del); return; }
  const row = e.target.closest('[data-marker]');
  if (!row || !S.state) return;
  const m = S.state.markers.find((x) => x.name === row.dataset.marker);
  if (!m) return;
  centerOn(m.x, m.y, 0.3);
  userMoved();
  select({ kind: 'marker', id: m.name });
  if (window.innerWidth < 760) appEl.classList.add('panel-closed');
});

// ============================================================ banner, status, toast

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

function progressHtml() {
  const p = S.progress;
  const pct = Math.round((p.value || 0) * 100);
  return `<div class="progress"><div class="bar" style="width:${pct}%"></div>
    <span class="label">${esc(tOr('stage.' + p.stage, p.stage || ''))} — ${pct}%</span></div>`;
}

function mapName(m) { return m ? (m.desc || m.world) : ''; }
function viewName() {
  const m = viewMap();
  if (m) return mapName(m);
  return onGameMap() ? (S.status.worldDesc || S.status.world) : (viewKey() || '');
}

function updateBanner() {
  const b = $('#banner');
  const st = S.status;
  const m = viewMap();
  const satState = m && m.sat ? m.sat.state : 'none';
  let html = '';
  const name = esc(viewName());
  if (!S.sse) html = `<p>${t('banner.server_down')}</p>`;
  else if (S.terrainLoading) html = `<p>${t('banner.loading')}</p>`;
  else if (S.progress.active) html = `<p>${t('banner.extracting', { name: esc(S.progress.world || st.world || '') })}</p>${progressHtml()}`;
  else if (satState === 'building' && !hasSat() && !S.terrain) {
    html = `<p>${t('banner.sat_building', { name, pct: Math.round(m.sat.progress * 100) })}</p>`;
  } else if (!viewKey()) html = `<p>${t('banner.waiting')}</p>`;
  else if (!S.terrain && !hasSat() && !(m && (m.terrain || satState === 'ready'))) {
    if (onGameMap() && st.connected) {
      html = `<p>${t('banner.no_image', { name })}</p>
        <div class="acts-row">
          <button class="btn primary" data-both>${t('banner.btn_both')}</button>
          <button class="btn" data-sat>${t('banner.btn_sat')}</button>
          <button class="btn" data-export>${t('banner.btn_topo')}</button>
        </div>`;
    } else {
      html = `<p>${t('banner.no_image_offline', { name })}</p>`;
    }
  }
  b.innerHTML = html;
  b.hidden = !html;
}
$('#banner').addEventListener('click', (e) => {
  if (e.target.closest('[data-both]')) { exportSat(); exportTerrain(); }
  else if (e.target.closest('[data-export]')) exportTerrain();
  else if (e.target.closest('[data-sat]')) exportSat();
});

function updateTerrainPanel() {
  const st = S.status;
  const m = viewMap();
  const name = viewName();
  let text;
  if (!viewKey()) text = t('topo.no_map');
  else if (S.terrain && S.terrainWorld === viewKey()) text = t('topo.ready', { name });
  else if (m && m.terrain) text = t('topo.saved', { name });
  else text = t('topo.missing', { name });
  $('#terrain-status').textContent = text;
  const pr = $('#progress');
  pr.hidden = !S.progress.active;
  if (S.progress.active) pr.outerHTML = `<div id="progress">${progressHtml()}</div>`;
  $('#btn-export').disabled = !st.connected || !onGameMap() || !!S.progress.active;

  const sat = m && m.sat ? m.sat : { state: 'none' };
  $('#sat-status').textContent = viewKey()
    ? t('sat.' + sat.state, { pct: Math.round((sat.progress || 0) * 100), error: sat.error || '' })
    : '';
  $('#btn-sat').disabled = !st.connected || !onGameMap() || sat.state === 'building';
}

function updateStyleUI() {
  const eff = effectiveStyle();
  document.querySelectorAll('#style-seg button').forEach((b) => {
    // highlight what the map really shows; the remembered choice comes back when it is available
    b.classList.toggle('active', b.dataset.style === eff);
    b.setAttribute('aria-pressed', String(b.dataset.style === eff));
    b.disabled = (b.dataset.style !== 'topo' && !hasSat()) || (b.dataset.style !== 'sat' && !S.terrain);
  });
  $('#style-note').textContent = eff !== S.style ? t('style.fallback', { style: t('style.' + eff) }) : '';
  loadBrightForStyle();
}
document.querySelectorAll('#style-seg button').forEach((b) => b.addEventListener('click', () => {
  S.style = b.dataset.style;
  storeSet('style', S.style);
  updateStyleUI();
  sync3d();
  redraw();
}));

function updateLangUI() {
  document.querySelectorAll('#lang-seg button').forEach((b) => b.classList.toggle('active', b.dataset.lang === LANG));
  if (typeof updateWakeUI === 'function' && WAKE) updateWakeUI();
}
document.querySelectorAll('#lang-seg button').forEach((b) => b.addEventListener('click', () => {
  LANG = b.dataset.lang;
  storeSet('lang', LANG);
  applyStaticI18n();
  updateLangUI();
  dialogMetaFilled = null;
  updateStatus();
  syncView();
  renderInfo();
  renderDetail();
  wsRenderAll(true); wsUpdateChrome();
  artyOnLang();
  updateFollowUI();
  if (activeTab === 'layers') loadSetup();
}));

// ---- icon and compass size
function bindSlider(id, key, onChange) {
  const input = $('#' + id), out = $('#' + id + '-val');
  const show = () => { out.textContent = `${Math.round(S[key] * 100)}%`; };
  input.value = String(S[key]);
  show();
  input.addEventListener('input', () => {
    S[key] = Number(input.value);
    storeSet(key, S[key]);
    show();
    if (onChange) onChange();
    redraw();
  });
}
bindSlider('icon-size', 'iconScale');
bindSlider('compass-size', 'compassScale');

// Ammo-warning thresholds: whole numbers kept per browser; changing one re-renders the detail page.
function bindNum(id, key) {
  const input = $('#' + id);
  input.value = String(S[key]);
  input.addEventListener('input', () => {
    const v = Math.max(1, Math.round(Number(input.value) || S[key]));
    S[key] = v; storeSet(key, v);
    renderDetail();
    wsRenderAll();
  });
}
bindNum('thr-mag-high', 'magHigh');
bindNum('thr-mag-low', 'magLow');
bindNum('thr-throw-min', 'throwMin');
$('#compass-reset').addEventListener('click', () => { S.compassPos = null; storeSet('compassPos', null); redraw(); });

const brightInput = $('#bright');
// Brightness is remembered per map style: the topo map opens near 0.85 and satellite near 2.0,
// and once the user drags the slider their value sticks for that style.
const DEFAULT_BRIGHT = { topo: 0.85, sat: 2, mix: 1.3 };
const brightDefault = (style) => DEFAULT_BRIGHT[style] ?? 1;
let brightStyle = null; // the style whose brightness is currently loaded
function loadBrightForStyle() {
  const k = effectiveStyle();
  if (k === brightStyle) return;
  brightStyle = k;
  const b = storeGet('bright_' + k, brightDefault(k));
  S.bright = b;
  brightInput.value = String(b);
  $('#bright-val').textContent = `${Math.round(b * 100)}%`;
  View3D.setBrightness(b);
  redraw();
}
function setBrightness(b) {
  S.bright = b;
  brightStyle = effectiveStyle();
  brightInput.value = String(b);
  $('#bright-val').textContent = `${Math.round(b * 100)}%`;
  storeSet('bright_' + brightStyle, b);
  View3D.setBrightness(b);
  redraw();
}
brightInput.addEventListener('input', () => setBrightness(Number(brightInput.value)));
$('#bright-reset').addEventListener('click', () => setBrightness(brightDefault(effectiveStyle())));
loadBrightForStyle();

function updateGridUI() {
  document.querySelectorAll('#grid-seg button').forEach((b) => b.classList.toggle('active', Number(b.dataset.digits) === S.gridDigits));
}
document.querySelectorAll('#grid-seg button').forEach((b) => b.addEventListener('click', () => {
  S.gridDigits = Number(b.dataset.digits);
  storeSet('grid', S.gridDigits);
  updateGridUI();
  renderInfo();
}));
updateGridUI();

// ---- all sides: only works for the server admin, Zeus or single player (the mod checks that in game)
function updateAllSidesUI() {
  const me = S.state && onGameMap() ? S.state.me : null;
  const allowed = !!(me && me.allSidesAllowed);
  const cb = $('#all-sides');
  cb.checked = !!S.settings.all_sides;
  cb.disabled = !allowed && !cb.checked; // always allow switching it off
  $('#all-sides-status').textContent = t(!me ? 'allsides.unknown' : allowed ? 'allsides.allowed' : 'allsides.denied');
  $('#allsides-badge').hidden = !(me && me.allSides);
}
$('#all-sides').addEventListener('change', async (e) => {
  const value = e.target.checked;
  try {
    await command({ action: 'all_sides', value });
    S.settings.all_sides = value;
  } catch (err) { toast(t('toast.request_failed', { error: err.message })); }
  updateAllSidesUI();
});

// The "Disable Camera" control is hidden behind a password. Type the keyword anywhere
// (not inside a text box), then enter the password to reveal it.
const CAM_GATE_WORD = 'cam';    // type this (outside any field) to be asked for the password
// The password is stored only as its SHA-256 hash, so the plain text is not in this file.
// To change it: compute sha256('your new password') and paste the hex below.
const CAM_GATE_HASH = 'a1b22f60cfdd66cb036e7fac0d81ea8380bc91d1ed854a37acd79eb66eecb0f5';
// Tiny self-contained SHA-256 (works on phones over plain http, where crypto.subtle is unavailable).
function camSha256(ascii) {
  const rr = (n, x) => (x >>> n) | (x << (32 - n));
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const bytes = [];
  for (let i = 0; i < ascii.length; i++) {
    const c = ascii.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  const l = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLen = l * 8;
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / Math.pow(2, 8 * i)) & 0xff);
  const w = new Array(64);
  for (let j = 0; j < bytes.length; j += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[j+i*4]<<24)|(bytes[j+i*4+1]<<16)|(bytes[j+i*4+2]<<8)|(bytes[j+i*4+3]);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(7,w[i-15])^rr(18,w[i-15])^(w[i-15]>>>3);
      const s1 = rr(17,w[i-2])^rr(19,w[i-2])^(w[i-2]>>>10);
      w[i] = (w[i-16]+s0+w[i-7]+s1)|0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;
    for (let i = 0; i < 64; i++) {
      const S1=rr(6,e)^rr(11,e)^rr(25,e), ch=(e&f)^((~e)&g), t1=(hh+S1+ch+K[i]+w[i])|0;
      const S0=rr(2,a)^rr(13,a)^rr(22,a), maj=(a&b)^(a&c)^(b&c), t2=(S0+maj)|0;
      hh=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+hh)|0;
  }
  const hx = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return hx(h0)+hx(h1)+hx(h2)+hx(h3)+hx(h4)+hx(h5)+hx(h6)+hx(h7);
}
function revealCamGate() { const g = $('#allsides-gate'); if (g) g.hidden = false; }
function promptCamGate() {
  const ans = window.prompt(LANG === 'fa' ? 'رمز را وارد کنید:' : 'Enter password:');
  if (ans === null) return;
  if (camSha256(ans) === CAM_GATE_HASH) {
    revealCamGate();
    try { localStorage.setItem('a3map.camGate', '1'); } catch { /* private mode */ }
  } else {
    toast(LANG === 'fa' ? 'رمز اشتباه است' : 'Wrong password');
  }
}
try { if (localStorage.getItem('a3map.camGate') === '1') revealCamGate(); } catch { /* private mode */ }
(function () {
  // Desktop: type the keyword anywhere outside a text field.
  let buf = '';
  document.addEventListener('keydown', (e) => {
    const el = document.activeElement, tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
    if (!e.key || e.key.length !== 1) return;
    buf = (buf + e.key).slice(-12).toLowerCase();
    if (buf.endsWith(CAM_GATE_WORD)) { buf = ''; promptCamGate(); }
  });
  // Phone / touch: tap the "Units" heading 5 times quickly.
  const h = [...document.querySelectorAll('h3')].find((x) => x.dataset.i18n === 'units.title');
  if (h) {
    h.style.cursor = 'default';
    let n = 0, last = 0;
    h.addEventListener('click', () => {
      const now = Date.now();
      n = (now - last < 800) ? n + 1 : 1;
      last = now;
      if (n >= 5) { n = 0; promptCamGate(); }
    });
  }
})();

// ---- position update rate (stored on the server, applies to every device)
S.settings = { pos_interval: 0.05 };
function updateRateUI() {
  document.querySelectorAll('#rate-seg button').forEach((b) =>
    b.classList.toggle('active', Math.abs(Number(b.dataset.rate) - S.settings.pos_interval) < 1e-6));
}
document.querySelectorAll('#rate-seg button').forEach((b) => b.addEventListener('click', async () => {
  const value = Number(b.dataset.rate);
  try {
    await command({ action: 'pos_interval', value });
    S.settings.pos_interval = value;
  } catch (e) { toast(t('toast.request_failed', { error: e.message })); }
  updateRateUI();
}));
updateRateUI();

// ---- fullscreen and hidden top bar
function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function toggleFullscreen() {
  const d = document, el = d.documentElement;
  if (isFullscreen()) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) { toast(t('full.ios')); return; }
  try {
    const r = req.call(el, { navigationUI: 'hide' });
    if (r && r.catch) r.catch(() => toast(t('full.ios')));
  } catch { toast(t('full.ios')); }
}
$('#btn-full').addEventListener('click', toggleFullscreen);
$('#btn-full2').addEventListener('click', toggleFullscreen);

function setBarHidden(hidden) {
  appEl.classList.toggle('bar-hidden', hidden);
  $('#float-bar').hidden = !hidden;
  storeSet('barHidden', hidden);
  mapCtlPlace();
}
$('#btn-hidebar').addEventListener('click', () => setBarHidden(true));
$('#btn-showbar').addEventListener('click', () => setBarHidden(false));
setBarHidden(storeGet('barHidden', false));

// ---- collapsible + movable floating menus (tools dock + top view controls)
(function () {
  const docks = [
    { el: $('#tools'), grip: $('#tools-grip'), arrow: $('#tools-arrow'),
      chk: $('#chk-tools-move'), moveKey: 'toolsMove', hideKey: 'toolsHidden', posKey: 'toolsPos' },
    { el: $('#view-ctrls'), grip: $('#view-grip'), arrow: $('#view-arrow'),
      chk: $('#chk-view-move'), moveKey: 'viewMove', hideKey: 'viewHidden', posKey: 'viewPos' },
  ];

  // Inline styles win over the CSS/media rules, so movable docks are placed with fixed px coords.
  function applyPos(el, pos) {
    if (pos) {
      el.style.position = 'fixed';
      el.style.left = pos[0] + 'px';
      el.style.top = pos[1] + 'px';
      el.style.right = el.style.bottom = 'auto';
      el.style.insetInlineStart = el.style.insetInlineEnd = 'auto';
      el.style.transform = 'none';
      el.style.margin = '0';
    } else {
      el.style.position = el.style.left = el.style.top = '';
      el.style.right = el.style.bottom = '';
      el.style.insetInlineStart = el.style.insetInlineEnd = '';
      el.style.transform = el.style.margin = '';
    }
  }
  function clampPos(el, x, y) {
    const maxX = Math.max(0, window.innerWidth - el.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - el.offsetHeight);
    return [Math.min(Math.max(0, x), maxX), Math.min(Math.max(0, y), maxY)];
  }
  function setMovable(d, on, persist) {
    d.el.classList.toggle('movable', on);
    if (persist !== false) storeSet(d.moveKey, on);
    if (on) {
      let pos = storeGet(d.posKey, null);
      const r = d.el.getBoundingClientRect();
      pos = pos ? clampPos(d.el, pos[0], pos[1]) : clampPos(d.el, r.left, r.top);
      applyPos(d.el, pos);
    } else {
      applyPos(d.el, null);
      storeSet(d.posKey, null);
    }
  }
  function setHidden(d, hidden) {
    d.el.classList.toggle('collapsed', hidden);
    storeSet(d.hideKey, hidden);
  }

  docks.forEach((d) => {
    if (!d.el) return;
    d.arrow.addEventListener('click', () => setHidden(d, !d.el.classList.contains('collapsed')));
    if (d.chk) d.chk.addEventListener('change', () => setMovable(d, d.chk.checked));

    let drag = null;
    d.grip.addEventListener('pointerdown', (e) => {
      if (!d.el.classList.contains('movable')) return;
      e.preventDefault();
      const r = d.el.getBoundingClientRect();
      applyPos(d.el, [r.left, r.top]);
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { d.grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      d.el.classList.add('dragging');
    });
    d.grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [x, y] = clampPos(d.el, e.clientX - drag.dx, e.clientY - drag.dy);
      d.el.style.left = x + 'px';
      d.el.style.top = y + 'px';
    });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      d.el.classList.remove('dragging');
      try { d.grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      const r = d.el.getBoundingClientRect();
      storeSet(d.posKey, [r.left, r.top]);
    };
    d.grip.addEventListener('pointerup', end);
    d.grip.addEventListener('pointercancel', end);

    // restore saved state
    const mv = storeGet(d.moveKey, false);
    if (d.chk) d.chk.checked = mv;
    if (mv) setMovable(d, true, false);
    if (storeGet(d.hideKey, false)) setHidden(d, true);
  });

  const resetBtn = $('#move-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    docks.forEach((d) => {
      storeSet(d.posKey, null);
      if (d.el.classList.contains('movable')) {
        applyPos(d.el, null);                 // snap back to the CSS default spot
        const r = d.el.getBoundingClientRect();
        applyPos(d.el, [r.left, r.top]);      // re-fix there so it stays movable
      }
    });
  });

  // keep movable docks on-screen after a resize / rotation
  window.addEventListener('resize', () => {
    docks.forEach((d) => {
      if (!d.el || !d.el.classList.contains('movable')) return;
      const r = d.el.getBoundingClientRect();
      applyPos(d.el, clampPos(d.el, r.left, r.top));
    });
  });
})();

// ---- game & mod setup (only works from the PC that runs the server)
async function setupCall(method, path, body) {
  const res = await fetch(path, method === 'GET' ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) { $('#setup-remote').hidden = false; $('#setup-form').hidden = true; return null; }
  $('#setup-remote').hidden = true; $('#setup-form').hidden = false;
  if (data.status) renderSetup(data.status);
  if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function renderSetup(s) {
  const arma = $('#setup-arma');
  if (document.activeElement !== arma) arma.value = s.arma_dir_setting || s.arma_dir || '';
  arma.placeholder = s.arma_dir || 'D:\\SteamLibrary\\steamapps\\common\\Arma 3';
  const rows = [
    [t('setup.st_arma'), s.arma_dir ? `<span class="path">${esc(s.arma_dir)}</span>` : `<span class="bad">${t('setup.missing')}</span>`],
    [t('setup.st_target'), s.target ? `<span class="path">${esc(s.target)}</span>` : '-'],
    [t('setup.st_installed'), s.installed ? t('setup.yes_at', { at: s.installed_at }) : t('setup.no')],
  ];
  $('#setup-status').innerHTML = rows.map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join('');
}

function setupBody() {
  return { arma_dir: $('#setup-arma').value };
}
$('#setup-save').addEventListener('click', async () => {
  try { if (await setupCall('POST', 'api/setup', setupBody())) toast(t('setup.saved')); }
  catch (e) { toast(t('toast.request_failed', { error: e.message })); }
});
function loadSetup() { setupCall('GET', 'api/setup').catch(() => {}); }

function renderMapSelect() {
  const sel = $('#map-select');
  const game = S.status.world ? t('map.auto_named', { name: S.status.worldDesc || S.status.world }) : t('map.auto');
  const opts = [`<option value="auto">${esc(game)}</option>`];
  for (const m of S.maps) {
    const tags = [m.sat && m.sat.state === 'ready' ? t('map.tag_sat') : '', m.terrain ? t('map.tag_topo') : '']
      .filter(Boolean).join(LANG === 'fa' ? '، ' : ', ');
    opts.push(`<option value="${esc(m.key)}">${esc(mapName(m))}${tags ? ` (${tags})` : ''}</option>`);
  }
  if (S.mapChoice !== 'auto' && !S.maps.some((m) => m.key === S.mapChoice)) {
    opts.push(`<option value="${esc(S.mapChoice)}">${esc(S.mapChoice)}</option>`);
  }
  const html = opts.join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = S.mapChoice;
}
$('#map-select').addEventListener('change', (e) => {
  S.mapChoice = e.target.value;
  storeSet('map', S.mapChoice);
  select(null);
  syncView();
});

// Loads whatever the selected map needs; called whenever status, map list or selection changes.
let lastViewKey = null;
function syncView() {
  const key = viewKey();
  if (key !== lastViewKey) {
    lastViewKey = key;
    S.view.centered = false;
    S.view.userMoved = false;
    if (S.terrainWorld !== key) { S.terrain = null; S.terrainWorld = null; }
    if (S.sat && S.sat.key !== key) S.sat = null;
    if (S.dem && S.dem.key !== key) S.dem = null;
    fitWorld();
  }
  const m = viewMap();
  if (key && m && m.terrain && S.terrainWorld !== key) loadTerrain(key);
  if (key && m && m.sat && m.sat.state === 'ready' && !hasSat()) loadSat(key);
  sync3d();
  renderMapSelect();
  updateStyleUI();
  updateBanner();
  updateTerrainPanel();
  renderLists();
  redraw();
}

function updateStatus() {
  const st = S.status;
  const dot = $('#conn-dot');
  dot.className = 'dot ' + (!S.sse ? '' : st.connected ? 'on' : 'wait');
  $('#conn-text').textContent = t(!S.sse ? 'conn.server_down' : st.connected ? 'conn.game_on' : 'conn.waiting');
  $('#world-name').textContent = st.world ? `${st.worldDesc || st.world}${st.mission ? ' · ' + st.mission : ''}` : '';
  // The game dropped out but its last units are still drawn: say they are frozen, not live.
  const stale = S.sse && !st.connected && !!S.state && onGameMap();
  const sb = $('#stale-badge');
  if (sb) { sb.hidden = !stale; if (stale) sb.textContent = t('stale.game'); }
  updateBanner();
  updateTerrainPanel();
}

// ============================================================ commands

async function command(body) {
  const res = await fetch('api/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status);
}

async function exportTerrain() {
  try { await command({ action: 'terrain_export' }); toast(t('toast.export_started')); }
  catch (e) { toast(t('toast.export_failed', { error: e.message })); }
}
$('#btn-export').addEventListener('click', exportTerrain);

async function exportSat() {
  try { await command({ action: 'sat_export' }); }
  catch (e) { toast(t('toast.request_failed', { error: e.message })); }
}
$('#btn-sat').addEventListener('click', exportSat);

async function deleteMarker(name) {
  try {
    await command({ action: 'marker_delete', name });
    toast(t('toast.marker_deleted'));
    if (S.selected && S.selected.id === name) select(null);
  } catch (e) { toast(t('toast.delete_failed', { error: e.message })); }
}

// ============================================================ entity detail (vehicle / unit page)
// A deep per-entity page (weapons, ammo, damage, crew, cargo, inventory) that follows the
// selection in the main window, and can be popped out — whole page or a single tab — into its
// own browser window with the menus hidden (good for a second monitor or a phone under one).
// set in a popped-out window; re-pointed (and the URL updated) when a mission restart gives the
// same entity a new id
let DETAIL_ID = new URLSearchParams(location.search).get('detail');
const DETAIL_TAB = new URLSearchParams(location.search).get('tab');   // a single-tab window
S.details = {};          // id -> latest detail payload from the game
S.detailId = null;       // entity the in-page panel is currently showing
S.detailTab = 'overview';
// the mission run this page's ids belong to (see "mission runs" below)
S.run = { session: null, at: 0, resets: 0, dropped: 0, pending: null, me: null, meVeh: null, oldState: false, log: [] };

const ICON_POP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_CUST = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
const ICON_DETACH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="9" y="3" width="12" height="12" rx="2"/><path d="M15 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2h4"/></svg>';
const ICON_FULL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_FULLX = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

function hpClass(f) { return f > 0.6 ? '' : (f > 0.3 ? 'warn' : 'bad'); }
function meter(frac, cls) {
  const p = Math.max(0, Math.min(1, frac || 0));
  return `<span class="meter ${cls ?? hpClass(p)}"><span style="width:${Math.round(p * 100)}%"></span></span>`;
}
function dKv(k, v) { return `<span>${esc(k)}</span><span><bdi>${v}</bdi></span>`; }
function partLabel(l) { return tOr('part.' + String(l).toLowerCase(), l); }
const isAir = (k) => k === 'plane' || k === 'heli' || k === 'uav';
const isArmor = (k) => k === 'tank' || k === 'apc' || k === 'aa';

// ---- shared icon registry: every glyph the detail pages (and the info box / unit list) draw.
// Kept as 0 0 24 24 path markup so one wrapper can size/colour any of them; drawn with
// currentColor so CSS sets the colour. Add an icon here once and reuse it by name everywhere.
const DICON = {
  // vehicle / unit kinds
  man: '<circle cx="12" cy="5.5" r="2.6"/><path d="M6.5 21c0-4 2.4-6.5 5.5-6.5S17.5 17 17.5 21"/>',
  car: '<path d="M3 13l2-5h14l2 5v4h-2a2 2 0 0 1-4 0H9a2 2 0 0 1-4 0H3z"/><path d="M6 13h12"/>',
  // APC: long boxy hull on eight wheels with a small one-man turret (not a tank: no long gun, no tracks)
  apc: '<path d="M2 15V11l2.5-3H17l3 3v4z"/><path d="M8 8V6h5v2M13 7h4"/><circle cx="5" cy="17.2" r="1.6"/><circle cx="9.3" cy="17.2" r="1.6"/><circle cx="13.6" cy="17.2" r="1.6"/><circle cx="18" cy="17.2" r="1.6"/>',
  tank: '<path d="M2 16h18v2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M4 16v-3h11v3"/><path d="M8 13v-2h8l5-1v1l-5 1"/><circle cx="6.5" cy="17.5" r="1"/><circle cx="12" cy="17.5" r="1"/><circle cx="17.5" cy="17.5" r="1"/>',
  // anti-air: tracked hull, turret with twin barrels raised high and a radar dish on top
  aa: '<path d="M2 17h18v1.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M4 17v-3h13v3"/><path d="M7 14v-2.5h6V14"/><path d="M12 11.5l6-6.5M10.5 11.5l6-6.5"/><path d="M5.5 11.5c0-2 1.5-3 3-3"/><path d="M7 8.5V7"/>',
  heli: '<path d="M3 7h18"/><path d="M12 7v3"/><path d="M7 10h8a3 3 0 0 1 3 3v2H9a4 4 0 0 1-4-4z"/><path d="M12 15v3h-3"/>',
  plane: '<path d="M12 2c1 0 2 1.5 2 4v4l7 4v2l-7-2v4l2 2v1l-4-1-4 1v-1l2-2v-4l-7 2v-2l7-4V6c0-2.5 1-4 2-4z"/>',
  // drone: no cockpit, long straight wings, pusher prop and inverted-V tail
  uav: '<path d="M12 4.5c.8 0 1.3.8 1.3 2V17h-2.6V6.5c0-1.2.5-2 1.3-2z"/><path d="M2 10.5h20v1.6H2z"/><path d="M10.7 16.5l-3.5 3M13.3 16.5l3.5 3"/><path d="M10 19.8h4"/>',
  ship: '<path d="M4 14h16l-2 5a2 2 0 0 1-2 1H8a2 2 0 0 1-2-1z"/><path d="M6 14V9h8l4 5"/><path d="M12 9V4"/>',
  static: '<circle cx="12" cy="13" r="3"/><path d="M12 10V5M12 16v3M9 13H4M20 13h-5"/>',
  veh: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M4 12h16"/>',
  // weapons (hand-held)
  rifle: '<path d="M2 9h13l3-1h4v2l-3 1h-2l-1 2h-2l-1 3h-2l-1-3H6l-1 2H2z"/>',
  pistol: '<path d="M4 8h13v3h-3l-1 1v2h-3v-3H7l-3 3z"/>',
  launcher: '<path d="M2 11h18l2 1-2 1H9l-2 2-2-1 1-1H2z"/><circle cx="19" cy="12" r="1"/>',
  mg: '<path d="M2 9h12l5-1h3v2l-3 1h-3l-1 2h-2l-1 2H8l-1-2H5l-1 2H2z"/><path d="M8 13v4"/>',
  // vehicle weapons
  cannon: '<path d="M2 13.5h6l2-3h4v6h-4l-2-3"/><path d="M14 12h7.5M14 15h7.5"/><path d="M21.5 11v5"/><circle cx="5" cy="17" r="1.2"/>',
  autocannon: '<path d="M3 10h7v6H3z"/><path d="M10 11.5h11M10 14.5h11"/><path d="M17 10.5v5M20.5 11v4"/>',
  coax: '<path d="M2 10h8v5H2z"/><path d="M10 11.2h9M10 13.8h12"/><path d="M5 15v3"/>',
  // minigun: rotary barrel cluster (three barrels seen side-on) with rear and front clamps,
  // the drive motor behind it and the feed chute below
  minigun: '<rect x="2" y="9.5" width="5" height="6" rx="1.2"/><path d="M7 11h2.5M7 14h2.5"/><rect x="9.5" y="9" width="1.8" height="7" rx=".5"/><rect x="18.2" y="9.6" width="1.6" height="5.8" rx=".5"/><path d="M11.3 10.3h6.9M11.3 12.5h6.9M11.3 14.7h6.9M19.8 10.3H22M19.8 12.5H22M19.8 14.7H22"/><path d="M4.5 15.5v3.5h4.5"/>',
  // helicopter chin turret: the nose from the side with a ball turret and its gun underneath
  heliturret: '<path d="M2 8.5h10.5a5.5 5.5 0 0 1 5.5 5.5H6.5A4.5 4.5 0 0 1 2 9.5z"/><path d="M5 8.5V6h9"/><circle cx="11.5" cy="16.6" r="2.4"/><path d="M13.6 17.5l7.4 2.3"/>',
  gl: '<path d="M2 10h9v5H2z"/><path d="M11 11h7a2 2 0 0 1 0 4h-7"/><circle cx="18" cy="13" r="1"/>',
  bomb: '<path d="M8 12a4 4 0 0 1 4-4h5l3 4-3 4h-5a4 4 0 0 1-4-4z"/><path d="M8 12H3M5 9l-2 3 2 3"/>',
  missile: '<path d="M3 12h13l4-2v4l-4-2"/><path d="M6 12l-3-3M6 12l-3 3"/><path d="M12 10.5v3"/>',
  pod: '<rect x="3" y="8" width="16" height="8" rx="3"/><circle cx="19" cy="10.5" r=".8"/><circle cx="19" cy="13.5" r=".8"/><path d="M7 8v8M11 8v8"/>',
  laser: '<rect x="2" y="9" width="8" height="6" rx="1.5"/><path d="M10 12h12"/><path d="M14 9.5l2 2.5-2 2.5"/><path d="M5 15v3"/>',
  horn: '<path d="M4 10h3l7-4v12l-7-4H4z"/><path d="M17 9a4 4 0 0 1 0 6M19.5 7a7 7 0 0 1 0 10"/>',
  // ammo / throwables
  mag: '<rect x="8.5" y="3" width="7" height="10" rx="1"/><path d="M8.5 13h7v6a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1z"/><path d="M10 6h4M10 8.5h4"/>',
  rocket: '<path d="M12 2c2.5 1.8 3.5 5 3.5 9l-3.5 3-3.5-3c0-4 1-7.2 3.5-9z"/><path d="M8.5 12l-2 5 3-2M15.5 12l2 5-3-2"/><circle cx="12" cy="9" r="1"/>',
  grenade: '<circle cx="12" cy="14.5" r="5.5"/><rect x="10" y="4" width="4" height="4" rx="1"/><path d="M14 5h3v2.5"/><path d="M9.5 12l1.5 1.5"/>',
  smoke: '<rect x="8.5" y="12" width="7" height="9" rx="2"/><path d="M9.5 12V9.5a2.5 2.5 0 0 1 5 0V12"/><path d="M12 7.5c0-2 2-2 2-4M9 7.5c0-1.6-1-2-1-3.5"/>',
  flare: '<circle cx="12" cy="12" r="2.4"/><path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M6.3 17.7l2.4-2.4M15.3 8.7l2.4-2.4"/>',
  mine: '<path d="M4 18h16"/><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 9V6M9 10L7 8M15 10l2-2"/>',
  // gear / items
  optic: '<circle cx="12" cy="12" r="7"/><path d="M12 5v3M12 16v3M5 12h3M16 12h3"/>',
  nvg: '<path d="M4 9h7a2 2 0 0 1 2 2 2 2 0 0 1 2-2h5v4a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3 3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/>',
  medical: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M12 9v6M9 12h6"/>',
  tool: '<path d="M14 6a3.5 3.5 0 0 0 4.5 4.5L21 13l-8 8-2.5-2.5A3.5 3.5 0 0 0 6 14L3.5 11.5 11.5 3.5z"/>',
  radio: '<rect x="6" y="8" width="9" height="13" rx="1.5"/><path d="M15 11l4-3M9 5v3M12 5v3"/><circle cx="8.5" cy="18" r="1"/>',
  gps: '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M12 14v3"/>',
  binocular: '<circle cx="7" cy="14" r="3.5"/><circle cx="17" cy="14" r="3.5"/><path d="M10.5 13h3M8 10.5l1-4h2M16 10.5l-1-4h-2"/>',
  uniform: '<path d="M8 3l4 2 4-2 3 3-2 3v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9L5 6z"/>',
  vest: '<path d="M8 3l4 3 4-3v16a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z"/><path d="M12 6v14M9 9h1M14 9h1"/>',
  backpack: '<rect x="6" y="6" width="12" height="15" rx="3"/><path d="M9 6V4a3 3 0 0 1 6 0v2M8 13h8M11 16h2"/>',
  helmet: '<path d="M4 14a8 8 0 0 1 16 0v1H4z"/><path d="M4 15h17v2H4z"/>',
  goggles: '<rect x="3" y="9" width="7" height="6" rx="3"/><rect x="14" y="9" width="7" height="6" rx="3"/><path d="M10 12h4"/>',
  misc: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2 2"/>',
  // cargo categories
  ammobox: '<rect x="3" y="9" width="18" height="11" rx="1.5"/><path d="M3 13h18"/><path d="M8 9V6.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1V9"/><path d="M7 16.5h2M15 16.5h2"/>',
  jerrycan: '<path d="M7 4h7l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M9 4V2.5h3V4"/><path d="M8.5 9.5l6 6M14.5 9.5l-6 6"/>',
  crate: '<path d="M3 8l9-4 9 4v9l-9 4-9-4z"/><path d="M3 8l9 4 9-4M12 12v9"/>',
  weaponcrate: '<rect x="2" y="8" width="20" height="10" rx="1.5"/><path d="M5 13h9l2-1h3"/><path d="M8 13v2"/>',
  personnel: '<circle cx="8" cy="7" r="2.3"/><circle cx="16" cy="7" r="2.3"/><path d="M3.5 19c0-3.5 2-5.5 4.5-5.5s4.5 2 4.5 5.5M11.5 19c0-3.5 2-5.5 4.5-5.5s4.5 2 4.5 5.5"/>',
  // vehicle systems
  engine: '<path d="M5 9h3V7h6v2h3l2 2h2v6h-2l-2 2H8l-3-3z"/><path d="M2 11v5M5 13.5H2"/>',
  glass: '<path d="M4 18L7 6h10l3 12z"/><path d="M9 9l-1.5 5M13 8l-3 9"/>',
  light: '<path d="M9 7h3a5 5 0 0 1 0 10H9z"/><path d="M9 7v10"/><path d="M5 8l-2-.8M5 12H2.5M5 16l-2 .8"/>',
  wiring: '<path d="M13 2L5 13h6l-1 9 8-11h-6z"/>',
  turret: '<circle cx="12" cy="13" r="5"/><path d="M12 8V2"/><path d="M4 20h16"/>',
  // crew roles (seat map and station panels)
  s_driver: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M3.8 10.6l6.1 1M20.2 10.6l-6.1 1M12 14.2v6.3"/>',
  s_gunner: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  // commander: head and shoulders under a beret worn tilted to one side
  s_cmdr: '<circle cx="12" cy="11" r="3.4"/><path d="M5.5 21.5c0-4 2.9-6.6 6.5-6.6s6.5 2.6 6.5 6.6"/><path d="M7.2 8.9c-.3-2.9 2.6-5.2 6.6-4.9 2.2.2 3.9 1 4.6 2l-1.3 1.6c-2.8-1.1-6.5-.9-9.9 1.3z"/><circle cx="17.6" cy="5.7" r=".9" fill="currentColor"/>',
  // passenger: a person seated, side view
  s_pass: '<circle cx="10" cy="4.6" r="2.2"/><path d="M10 7.6v6.4h5.5l1.8 6.5"/><path d="M10 10.5l3.6 1.4"/><path d="M6.2 9.5v8.8h8"/>',
  // pilot: flight helmet with the visor down
  s_pilot: '<path d="M5 13.5a7 7 0 0 1 14 0V17a2 2 0 0 1-2 2h-2.3l-1-2.8h-3.4l-1 2.8H7a2 2 0 0 1-2-2z"/><path d="M6.6 11.6h10.8v2.3a1 1 0 0 1-1 1H7.6a1 1 0 0 1-1-1z"/><path d="M12 6.5V4.5"/>',
  // crew health states: down (lying, incapacitated) and dead (a cross)
  h_down: '<circle cx="5.5" cy="13" r="2.4"/><path d="M8.5 14.5h9.5l3 2.5M10 14.5l2-3h4"/><path d="M3 19h18"/>',
  h_dead: '<path d="M12 3v18M7 8h10"/>',
  // stat glyphs
  heart: '<path d="M12 20s-7-4.5-7-9.5A3.5 3.5 0 0 1 12 7a3.5 3.5 0 0 1 7 3.5C19 15.5 12 20 12 20z"/>',
  fuel: '<path d="M5 20V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15"/><path d="M4 20h11"/><path d="M14 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-2-2"/><path d="M7 7h5"/>',
  gauge: '<path d="M4 17a8 8 0 0 1 16 0"/><path d="M12 17l4-5"/><circle cx="12" cy="17" r="1"/>',
  alt: '<path d="M12 3v18M12 3l-4 4M12 3l4 4M6 21h12"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9 4v16M15 4v16M4 9h16M4 15h16"/>',
  link: '<path d="M5 18a10 10 0 0 1 14 0"/><path d="M8 15a5.5 5.5 0 0 1 8 0"/><circle cx="12" cy="18.5" r="1.2"/><path d="M12 3v6M9 6h6"/>',
};
function dIcon(name, size = 18, cls = '') {
  const p = DICON[name] || DICON.misc;
  return `<svg class="di ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
// The icon for a vehicle kind, for any size (unknown kinds fall back to a generic vehicle).
function kindIcon(kind, size = 18, cls = '') { return dIcon(DICON[kind] ? kind : 'veh', size, cls); }

// ---- classify an inventory line (magazine / throwable / weapon / gear) by its name.
// Works off the English display name, which covers vanilla and most mods.
function classifyItem(name) {
  const s = String(name).toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));
  if (has('smoke')) return 'smoke';
  if (has('chemlight', 'chem light', 'ir grenade', 'ir strobe', 'flare')) return 'flare';
  if (has('grenade', 'rgo', 'rgn', 'm67', 'frag', 'explosive', 'satchel', 'demolition', 'mine', 'claymore')) return has('mine', 'claymore') ? 'mine' : 'grenade';
  if (has('rocket', 'missile', 'rpg', 'titan', 'nlaw', 'at4', 'pcml', ' at ', ' aa ', 'dagr', 'scalpel', 'macer', 'amraam', 'bim-', 'sidewinder')) return 'rocket';
  if (has('mag', 'rnd', 'round', 'belt', 'cmag', 'drum', 'clip', 'quiver')) return 'mag';
  if (has('scope', 'sight', 'optic', 'aco', 'rco', 'mrco', 'arco', 'holosight', 'nightstalker', 'dms', 'khs', 'ams')) return 'optic';
  if (has('nvg', 'night vision', 'nv goggles')) return 'nvg';
  if (has('first aid', 'medikit', 'medical', 'bandage', 'morphine', 'epinephrine', 'tourniquet', 'blood', 'medkit', 'personal aid')) return 'medical';
  if (has('toolkit', 'tool kit', 'repair')) return 'tool';
  if (has('radio', ' r-', 'rt-', 'manpack')) return 'radio';
  if (has('gps', 'uav terminal', 'microdagr', 'tablet')) return 'gps';
  if (has('binocular', 'rangefinder', 'laser designator')) return 'binocular';
  if (has('fuel', 'jerry')) return 'fuelcan';
  return 'misc';
}
const THROW_CATS = ['smoke', 'flare', 'grenade', 'mine'];

// A hand-held weapon's icon by its name (rifle / pistol / launcher / machine gun).
function weaponIcon(name) {
  const s = String(name).toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));
  if (has('launcher', 'rpg', 'titan', 'nlaw', 'pcml', 'at4', ' at ', ' aa ', 'maaws', 'vorona', 'rocket')) return 'launcher';
  if (has('minigun', 'machine gun', 'lmg', 'mmg', 'hmg', 'spmg', 'navid', 'zafir', 'mk200', 'm200', 'mg3', 'm249')) return 'mg';
  if (has('pistol', 'handgun', 'p07', 'acp', '.45', 'rook', '4-five', 'zubr', 'revolver', 'pdw')) return 'pistol';
  if (has('laser designator', 'laser marker', 'binocular', 'rangefinder')) return 'laser';
  return 'rifle';
}

// ---- ammo-count colour. Magazines use two thresholds; throwables use one.
function magClass(n) { return n <= 0 ? 'empty' : (n >= S.magHigh ? '' : (n >= S.magLow ? 'warn' : 'bad')); }
function throwClass(n) { return n <= 0 ? null : (n >= S.throwMin ? '' : 'bad'); }
function countChip(n, cls, suffix = '×') {
  return `<span class="cnt cnt-${cls === '' ? 'ok' : cls}">${suffix}${n}</span>`;
}

// The person's own name for a man (the detail payload carries the class name, not the soldier's).
function personName(id) {
  const st = S.state;
  if (!st) return '';
  const u = (st.units || []).find((x) => x.id === id);
  return u ? u.name : '';
}
function meId() { return S.state && S.state.me ? S.state.me.id : null; }

function detailTabsFor(d) {
  const T = [{ key: 'overview', label: t('d.tab.overview') }, { key: 'weapons', label: t('d.tab.weapons') }];
  if (d.kind === 'man') T.push({ key: 'inv', label: t('d.tab.inventory') }, { key: 'health', label: t('d.tab.health') });
  else T.push({ key: 'damage', label: t('d.tab.damage') }, { key: 'crew', label: t('d.tab.crew') }, { key: 'cargo', label: t('d.tab.cargo') });
  return T;
}

function aceBlock(a) {
  const rows = [
    dKv(t('ace.blood'), `${meter(a.blood)} ${Math.round(a.blood * 100)}%`),
    dKv(t('ace.pain'), `${meter(a.pain, a.pain > 0.3 ? 'bad' : 'warn')} ${Math.round(a.pain * 100)}%`),
    dKv(t('ace.hr'), t('ace.bpm', { n: a.hr })),
    dKv(t('ace.fractures'), a.fractured ? t('ace.yes') : t('ace.no')),
    dKv(t('ace.tourniquets'), a.tourniquets),
  ];
  return `<div class="d-sec">${t('ace.title')}</div><div class="d-kv">${rows.join('')}</div>`;
}

// ---- health (men): a front-view body whose regions colour by how hurt they are.
// Regions are anatomical: armL / legL are the soldier's own left, drawn on the viewer's right
// (the figure faces you). Sources, best first:
//   1. ACE medical's damage per body part (head, body, left/right arm, left/right leg)
//   2. the game's hit points. ACE adds one per limb; the game's own soldier has a single "legs"
//      and a single "arms" point, which then colours both sides (and says so).
const BODY_PARTS = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];
function hitRegions(label) {
  const l = String(label).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^(leftarm|lefthand|leftforearm|larm|lhand)$/.test(l)) return ['armL'];
  if (/^(rightarm|righthand|rightforearm|rarm|rhand)$/.test(l)) return ['armR'];
  if (/^(leftleg|leftfoot|leftlegs|lleg|lfoot)$/.test(l)) return ['legL'];
  if (/^(rightleg|rightfoot|rightlegs|rleg|rfoot)$/.test(l)) return ['legR'];
  if (/^(arms|arm|hands|hand)$/.test(l)) return ['armL', 'armR'];
  if (/^(legs|leg|feet|foot)$/.test(l)) return ['legL', 'legR'];
  if (/^(head|face|neck|brain)/.test(l)) return ['head'];
  if (/^(body|chest|abdomen|diaphragm|pelvis|spine\d*|torso|stomach)$/.test(l)) return ['torso'];
  return [];
}
// -> { z: {region: damage 0..1 | null}, shared: {arms, legs}, src: 'ace' | 'hit' | 'old' }
function bodyDamage(d) {
  const z = {}; BODY_PARTS.forEach((p) => { z[p] = null; });
  const parts = d.ace && Array.isArray(d.ace.parts) ? d.ace.parts : null;
  if (parts && parts.every((v) => Number.isFinite(v))) {
    // ACE damage per part grows with each wound; 1.0 (its default limb threshold) and above is severe
    BODY_PARTS.forEach((p, i) => { z[p] = parts[i] < 0 ? null : Math.min(1, parts[i]); });
    return { z, shared: { arms: false, legs: false }, src: 'ace' };
  }
  const full = Array.isArray(d.hitAll);
  const list = full ? d.hitAll : (d.hit || []);
  const sided = { arms: false, legs: false }, pair = { arms: false, legs: false };
  for (const p of list) {
    const regs = hitRegions(p.label);
    if (regs.length === 2) pair[regs[0].startsWith('arm') ? 'arms' : 'legs'] = true;
    else if (regs.length === 1 && /^(arm|leg)/.test(regs[0])) sided[regs[0].startsWith('arm') ? 'arms' : 'legs'] = true;
    for (const r of regs) z[r] = Math.max(z[r] ?? 0, p.dmg);
  }
  // older mods list only damaged parts: anything not listed is undamaged, not unknown
  if (!full) BODY_PARTS.forEach((p) => { if (z[p] == null) z[p] = 0; });
  return { z, shared: { arms: pair.arms && !sided.arms, legs: pair.legs && !sided.legs }, src: full ? 'hit' : 'old' };
}
// Two-step severity, as on the body: light (yellow) under 50% damage, severe (red) from 50%.
function woundSev(dmg) { return dmg == null ? 'na' : (dmg < 0.05 ? 'ok' : (dmg < 0.5 ? 'light' : 'severe')); }
const WOUND_FILL = { ok: '#c6ccd3', light: '#f0c419', severe: '#e0352b', na: 'url(#hatch)' };
// Vehicles keep their finer four-step scale.
function woundFill(dmg) {
  if (dmg == null) return 'url(#hatch)';
  if (dmg < 0.1) return '#c6ccd3';
  if (dmg < 0.35) return '#e8c24b';
  if (dmg < 0.7) return '#e0772f';
  if (dmg < 0.9) return '#d83a3a';
  return '#7c1f1f';
}
const HATCH_DEF = '<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#2a3139"/><path d="M0 0V6" stroke="#4a545e" stroke-width="2"/></pattern></defs>';
// Front view, 160 x 270. The right-hand limbs are the left-hand ones mirrored about x = 80.
const BODY_SHAPES = {
  head: '<ellipse cx="80" cy="27" rx="14.5" ry="17"/><path d="M73 41 h14 v9 h-14 z"/>',
  torso: '<path d="M58 51 Q80 46 102 51 L108 57 Q110 92 103 124 L100 140 H60 L57 124 Q50 92 52 57 Z"/>',
  arm: '<path d="M56 54 L44 58 Q38 61 37 69 L32 112 Q31 120 28 132 Q27 139 32 141 Q37 142 38 135 L41 120 L47 82 L53 73 Z"/>',
  leg: '<path d="M61 142 H79 L78 202 L77 240 Q77 250 69 252 H59 Q55 250 60 243 L62 202 Q58 172 61 142 Z"/>',
};
function bodyFigure(B) {
  const P = (zone) => {
    const sev = woundSev(B.z[zone]);
    return `class="bz bz-${sev}" data-zone="${zone}" fill="${WOUND_FILL[sev]}"`;
  };
  const mirror = (shape, zone) => `<g transform="translate(160 0) scale(-1 1)"><g ${P(zone)}>${shape}</g></g>`;
  return `<svg class="body" viewBox="0 0 160 270" width="150" height="253" role="img" aria-label="${esc(t('body.title'))}">${HATCH_DEF}`
    + `<g ${P('head')}>${BODY_SHAPES.head}</g>`
    + `<g ${P('torso')}>${BODY_SHAPES.torso}</g>`
    + `<g ${P('armR')}>${BODY_SHAPES.arm}</g>` + mirror(BODY_SHAPES.arm, 'armL')
    + `<g ${P('legR')}>${BODY_SHAPES.leg}</g>` + mirror(BODY_SHAPES.leg, 'legL')
    + `<text x="16" y="266" class="body-side">${esc(t('body.r'))}</text><text x="144" y="266" class="body-side">${esc(t('body.l'))}</text>`
    + `</svg>`;
}
function woundLegend(withNA) {
  return `<div class="wound-legend">`
    + `<span><i style="background:${WOUND_FILL.ok}"></i>${t('wound.ok')}</span>`
    + `<span><i style="background:${WOUND_FILL.light}"></i>${t('wound.light')}</span>`
    + `<span><i style="background:${WOUND_FILL.severe}"></i>${t('wound.severe')}</span>`
    + (withNA ? `<span><i class="lg-na"></i>${t('state.na')}</span>` : '') + `</div>`;
}
// The vehicle damage legend (four steps, with N/A).
function damageLegend() {
  return `<div class="wound-legend">`
    + `<span><i style="background:#c6ccd3"></i>${t('wound.ok')}</span>`
    + `<span><i style="background:#e8c24b"></i>${t('wound.light')}</span>`
    + `<span><i style="background:#e0772f"></i>${t('wound.heavy')}</span>`
    + `<span><i style="background:#7c1f1f"></i>${t('wound.critical')}</span>`
    + `<span><i class="lg-na"></i>${t('state.na')}</span></div>`;
}
function statusClass(life) { return life === 'INCAPACITATED' || life === 'DEAD' ? 'bad' : (life === 'INJURED' ? 'warn' : ''); }
function healthParts(d) {
  const B = bodyDamage(d);
  const a = d.ace;
  const lifeKey = (S.state && (S.state.units || []).find((u) => u.id === d.id) || {}).life;
  const statusTxt = lifeKey ? tOr('life.' + lifeKey, lifeKey) : null;
  let head = `<div class="body-wrap"><div class="body-fig">${bodyFigure(B)}</div><div class="body-side-col">`
    + stat('heart', t('d.health'), `${Math.round(d.hp * 100)}%`, hpClass(d.hp), d.hp);
  if (statusTxt) head += stat('man', t('d.status'), statusTxt, statusClass(lifeKey));
  if (a && a.fractured) head += stat('misc', t('ace.fractures'), t('ace.yes'), 'bad');
  if (a && a.tourniquets > 0) head += stat('medical', t('ace.tourniquets'), String(a.tourniquets), 'warn');
  head += `</div></div>` + woundLegend(B.src === 'hit' && BODY_PARTS.some((p) => B.z[p] == null));
  // the injured regions, with the remaining health of each (100% = unhurt)
  const hurt = BODY_PARTS.filter((p) => woundSev(B.z[p]) === 'light' || woundSev(B.z[p]) === 'severe');
  const label = (p) => {
    if (B.shared.legs && p.startsWith('leg')) return t('body.legs');
    if (B.shared.arms && p.startsWith('arm')) return t('body.arms');
    return t('body.' + p);
  };
  const seen = new Set();
  const rows = hurt.map((p) => {
    const lbl = label(p);
    if (seen.has(lbl)) return '';
    seen.add(lbl);
    const sev = woundSev(B.z[p]), ok = 1 - B.z[p];
    return `<div class="d-row wound-${sev}"><span class="wound-dot"></span><span class="d-n"><bdi>${esc(lbl)}</bdi></span>`
      + `<span class="wound-tag">${esc(t('wound.' + sev))}</span>${meter(ok, sev === 'severe' ? 'bad' : 'warn')}<span class="d-c">${Math.round(ok * 100)}%</span></div>`;
  }).join('');
  const parts = rows ? `<div class="d-sec">${t('body.injuries')}</div><div class="rows">${rows}</div>` : `<div class="d-empty d-empty-s">${t('body.none')}</div>`;
  const notes = (B.shared.legs || B.shared.arms ? `<div class="d-note-line">${esc(t('body.shared'))}</div>` : '')
    + (B.src === 'ace' ? `<div class="d-note-line">${esc(t('body.src_ace'))}</div>` : '');
  return { fig: head, wounds: parts + notes, ace: a ? aceBlock(a) : '' };
}
function renderHealth(d) {
  const p = healthParts(d);
  return p.fig + p.wounds + p.ace;
}

// A stat tile: icon, label, value, optional meter. cls '' | 'warn' | 'bad'.
function stat(icon, label, value, cls = '', frac) {
  return `<div class="tile ${cls ? 't-' + cls : ''}">`
    + `<span class="tile-ic">${dIcon(icon, 18)}</span>`
    + `<span class="tile-l">${esc(label)}</span>`
    + `<span class="tile-v"><bdi>${value}</bdi></span>`
    + (frac != null ? meter(frac, cls) : '') + `</div>`;
}
// A list row: category icon, name with its quantity right beside it, optional note at the end.
// Name and value stay together however wide the panel gets (the list itself has a max width).
function invRow(icon, name, chip = '', note = '') {
  return `<div class="d-row"><span class="d-ic">${dIcon(icon, 18)}</span>`
    + `<span class="d-n"><bdi>${esc(name)}</bdi></span>`
    + (chip || '')
    + (note ? `<span class="d-note"><bdi>${esc(note)}</bdi></span>` : '') + `</div>`;
}

// ============================================================ instruments
// Every round gauge uses a 200x200 viewBox centred on (100,100). Moving parts carry a needle
// key (data-nk) and are drawn by one animation loop (below), never by CSS transitions.
const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));
function gPt(r, a) { const rad = a * Math.PI / 180; return [100 + r * Math.sin(rad), 100 - r * Math.cos(rad)]; }
function gArc(r, a0, a1) {
  const [x0, y0] = gPt(r, a0), [x1, y1] = gPt(r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function gTick(r0, r1, a, w, col) {
  const [x0, y0] = gPt(r0, a), [x1, y1] = gPt(r1, a);
  return `<line x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`;
}
function gIcon(name, x, y, s) {
  return `<svg x="${x}" y="${y}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${DICON[name] || DICON.misc}</svg>`;
}
const G_BEZEL = '<circle cx="100" cy="100" r="97" class="g-bezel"/><circle cx="100" cy="100" r="90" class="g-face"/>';
const G_CAP = '<circle cx="100" cy="100" r="8" class="g-hub"/><circle cx="100" cy="100" r="3" class="g-hub-in"/>';
const rot = (a) => `transform="rotate(${a.toFixed(2)} 100 100)"`;
function needlePath(len, w) { return `M${100 - w} 100 L100 ${100 - len} L${100 + w} 100 L100 ${100 + len * 0.18} z`; }
const norm360 = (a) => ((a % 360) + 360) % 360;
const angDiff = (a, b) => ((((b - a) % 360) + 540) % 360) - 180; // shortest signed turn a → b

// ---- needle animation
// Each moving part has a key. Its target (the newest telemetry value) is kept apart from the
// value drawn now. A new target starts a straight move from the drawn value that lasts about one
// update interval: linear with clamped progress, so it never overshoots, never runs backwards
// and always ends exactly on the target. Angles turn the short way (359° → 1° is +2°).
// One requestAnimationFrame loop serves every needle and stops when all of them are still.
// The rendered HTML carries no needle positions; paintNeedles() sets them right after a render,
// so a re-render never makes a needle jump and an unchanged page is not rebuilt.
const NEEDLE = new Map(); // key -> { from, to, t0, dur, last, wrap }
const NEEDLE_MIN_MS = 30, NEEDLE_MAX_MS = 160;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
let needleRaf = 0;
function needleAt(n, now) {
  if (now >= n.t0 + n.dur) return n.to;
  return n.from + (n.to - n.from) * ((now - n.t0) / n.dur);
}
// Give a needle its newest target. Returns the value drawn now.
function needle(key, target, wrap = false) {
  if (!Number.isFinite(target)) return null;
  const now = performance.now();
  const n = NEEDLE.get(key);
  if (!n) { NEEDLE.set(key, { from: target, to: target, t0: now, dur: 0, last: now, wrap }); kickNeedles(); return target; }
  const cur = needleAt(n, now);
  const same = wrap ? Math.abs(angDiff(n.to, target)) < 1e-6 : Math.abs(target - n.to) < 1e-9;
  if (same) return cur;
  n.dur = REDUCED_MOTION.matches ? 0 : Math.max(NEEDLE_MIN_MS, Math.min(NEEDLE_MAX_MS, now - n.last));
  n.from = cur;
  n.to = wrap ? cur + angDiff(cur, target) : target;
  n.t0 = now; n.last = now;
  kickNeedles();
  return cur;
}
function needleVal(key) { const n = NEEDLE.get(key); return n ? needleAt(n, performance.now()) : null; }
function kickNeedles() { if (!needleRaf) needleRaf = requestAnimationFrame(needleFrame); }
function needleFrame() {
  needleRaf = 0;
  const now = performance.now();
  const box = $('#detail');
  if (box && !box.hidden) paintNeedles(box, now);
  wsPaintNeedles(now);
  for (const n of NEEDLE.values()) if (now < n.t0 + n.dur) { needleRaf = requestAnimationFrame(needleFrame); break; }
}
// Draw every keyed part inside root at its current value.
function paintNeedles(root, now = performance.now()) {
  for (const el of root.querySelectorAll('[data-nk]')) {
    const n = NEEDLE.get(el.dataset.nk);
    if (!n) continue;
    const v = needleAt(n, now);
    const f = NEEDLE_FMT[el.dataset.nf];
    if (f) f(el, v, now);
  }
}
// How a needle value becomes a drawing, by data-nf.
const NEEDLE_FMT = {
  deg: (el, v) => el.setAttribute('transform', `rotate(${v.toFixed(2)} 100 100)`),      // turret, hull
  card: (el, v) => el.setAttribute('transform', `rotate(${(-v).toFixed(2)} 100 100)`),   // compass rose
  spd: (el, v) => el.setAttribute('transform', `rotate(${speedAngle(v, +el.dataset.max).toFixed(2)} 100 100)`),
  spdarc: (el, v) => { el.style.strokeDashoffset = (100 - clamp01(v / +el.dataset.max) * 100).toFixed(2); },
  alt: (el, v) => el.setAttribute('transform', `rotate(${(-135 + 270 * altFrac(v)).toFixed(2)} 100 100)`),
  // artificial horizon: this key is the pitch; data-nb names the bank needle
  att: (el, v, now) => {
    const b = NEEDLE.get(el.dataset.nb);
    const bank = b ? needleAt(b, now) : 0;
    el.setAttribute('transform', `rotate(${(-bank).toFixed(2)} 100 100) translate(0 ${(Math.max(-90, Math.min(90, v)) * AI_PX).toFixed(2)})`);
  },
  bank: (el, v) => el.setAttribute('transform', `rotate(${(-v).toFixed(2)} 100 100)`),
};

// ---- speed
// Speed scale per vehicle kind: [full scale km/h, labelled step, minor step].
const SPEED_SCALE = {
  car: [200, 40, 10], apc: [120, 20, 5], tank: [100, 20, 5], aa: [100, 20, 5], ship: [80, 20, 5],
  heli: [400, 50, 10], uav: [400, 50, 10], plane: [1200, 200, 50], veh: [200, 40, 10],
};
function speedScale(v, kind) {
  let [max, major, minor] = SPEED_SCALE[kind] || SPEED_SCALE.veh;
  const sp = Math.max(0, v || 0);
  if (sp > max) max = Math.ceil(sp * 1.1 / major) * major; // out-ran the dial: the next render stretches it
  return { max, major, minor, sp };
}
const speedAngle = (v, max) => -135 + 270 * clamp01(Math.max(0, v) / max);
function speedGauge(key, kind, v) {
  const s = speedScale(v, kind);
  needle(key, s.sp);
  let ticks = '';
  for (let x = 0; x <= s.max + 1e-6; x += s.minor) {
    const a = -135 + 270 * x / s.max, isMaj = Math.abs(x / s.major - Math.round(x / s.major)) < 1e-6;
    ticks += gTick(isMaj ? 66 : 72, 78, a, isMaj ? 2.4 : 1.2, x / s.max > 0.85 ? 'var(--bad)' : (isMaj ? '#dfe4ea' : '#7d8893'));
    if (isMaj) { const [tx, ty] = gPt(52, a); ticks += `<text x="${tx.toFixed(1)}" y="${(ty + 4.5).toFixed(1)}" class="g-num">${x}</text>`; }
  }
  return `<svg class="gauge-svg" viewBox="0 0 200 200" data-g="spd" data-key="${esc(key)}" data-kind="${esc(kind)}" role="img" aria-label="${esc(t('d.speed'))}">` + G_BEZEL
    + `<path d="${gArc(84, -135, 135)}" class="g-track"/>`
    + `<path d="${gArc(84, -135, 135)}" pathLength="100" class="g-a g-val" stroke-dasharray="100 200" data-nk="${esc(key)}" data-nf="spdarc" data-max="${s.max}"/>`
    + ticks
    + `<text x="100" y="146" class="g-digit g-d">${Math.round(s.sp)}</text>`
    + `<text x="100" y="163" class="g-unit">km/h</text>`
    + `<g data-nk="${esc(key)}" data-nf="spd" data-max="${s.max}"><path d="${needlePath(80, 4)}" class="g-needle"/></g>` + G_CAP + '</svg>';
}
function patchSpeed(svg, v) {
  const sp = Math.max(0, v || 0);
  needle(svg.dataset.key, sp);
  svg.querySelector('.g-d').textContent = Math.round(sp);
}

// ---- altitude above the ground: a radar-altimeter style dial from 0 to 6000 m with an expanded
// low range (equal steps between 0, 100, 200, 500, 1000, 2000, 4000 and 6000 m), so a helicopter
// at 40 m and a jet at 5 km are both readable. Above 6000 m the needle rests on the stop and the
// dial says so; the readout always shows the real value.
const ALT_STOPS = [0, 100, 200, 500, 1000, 2000, 4000, 6000];
const ALT_MAX = 6000;
function altFrac(a) {
  const v = Math.max(0, Math.min(ALT_MAX, a || 0));
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (v <= ALT_STOPS[i]) return (i - 1 + (v - ALT_STOPS[i - 1]) / (ALT_STOPS[i] - ALT_STOPS[i - 1])) / (ALT_STOPS.length - 1);
  }
  return 1;
}
const altLabel = (m) => (m >= 1000 ? `${m / 1000}k` : String(m));
function altGauge(key, alt) {
  const a = Number.isFinite(alt) ? alt : null;
  if (a != null) needle(key, Math.max(0, a));
  let ticks = '';
  const seg = ALT_STOPS.length - 1;
  for (let i = 0; i < seg; i++) {
    const lo = ALT_STOPS[i], hi = ALT_STOPS[i + 1];
    const minor = (hi - lo) / ((hi - lo) % 4 === 0 && hi - lo <= 400 ? 4 : 5);
    for (let m = lo; m < hi - 1e-6; m += minor) {
      const maj = m === lo, ang = -135 + 270 * altFrac(m);
      ticks += gTick(maj ? 66 : 73, 79, ang, maj ? 2.4 : 1.1, maj ? '#dfe4ea' : '#7d8893');
    }
  }
  ALT_STOPS.forEach((m) => {
    const ang = -135 + 270 * altFrac(m);
    if (m === ALT_MAX) ticks += gTick(66, 79, ang, 2.4, 'var(--bad)');
    const [x, y] = gPt(52, ang);
    ticks += `<text x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" class="g-num">${altLabel(m)}</text>`;
  });
  const over = a != null && a > ALT_MAX;
  return `<svg class="gauge-svg${over ? ' g-over' : ''}" viewBox="0 0 200 200" data-g="alt" data-key="${esc(key)}" role="img" aria-label="${esc(t('d.alt'))}">` + G_BEZEL + ticks
    + `<text x="100" y="127" class="g-unit">${esc(t('d.alt_unit'))}</text>`
    + `<rect x="68" y="146" width="64" height="25" rx="5" class="g-window"/>`
    + `<text x="100" y="165" class="g-digit g-digit-s g-d">${a == null ? '—' : Math.round(a)}</text>`
    + `<text x="100" y="184" class="g-unit g-over-t">${over ? esc(t('d.alt_over', { n: ALT_MAX })) : ''}</text>`
    + (a == null ? '' : `<g data-nk="${esc(key)}" data-nf="alt"><path d="${needlePath(78, 4)}" class="g-needle"/></g>`)
    + G_CAP + '</svg>';
}
function patchAlt(svg, alt) {
  if (!Number.isFinite(alt)) return;
  needle(svg.dataset.key, Math.max(0, alt));
  svg.querySelector('.g-d').textContent = Math.round(alt);
  const over = alt > ALT_MAX;
  svg.classList.toggle('g-over', over);
  svg.querySelector('.g-over-t').textContent = over ? t('d.alt_over', { n: ALT_MAX }) : '';
}

// ---- attitude indicator (artificial horizon): sky above, ground below, a pitch ladder and a
// bank scale. The horizon disc turns by the bank and slides by the pitch; the aircraft symbol
// and the bank scale stay fixed. Pitch and bank come from the game (vector-based, in degrees).
const AI_PX = 2; // pixels per degree of pitch
function attitudeGauge(key, att) {
  const ok = att && Number.isFinite(att.pitch) && Number.isFinite(att.bank);
  if (ok) { needle(key + ':p', att.pitch); needle(key + ':b', att.bank, true); }
  let ladder = '';
  for (let p = -80; p <= 80; p += 5) {
    if (!p) continue;
    const y = 100 - p * AI_PX, w = p % 10 === 0 ? 24 : 11;
    ladder += `<line x1="${100 - w}" y1="${y}" x2="${100 + w}" y2="${y}" class="ai-lad"/>`;
    if (p % 10 === 0) ladder += `<text x="${100 - w - 3}" y="${y + 3.6}" class="ai-num" text-anchor="end">${Math.abs(p)}</text><text x="${100 + w + 3}" y="${y + 3.6}" class="ai-num" text-anchor="start">${Math.abs(p)}</text>`;
  }
  let scale = '';
  for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) scale += gTick(Math.abs(a) % 30 === 0 ? 76 : 80, 88, a, Math.abs(a) % 30 === 0 ? 2.4 : 1.6, '#f2f5f7');
  const disc = ok
    ? `<g data-nk="${esc(key)}:p" data-nb="${esc(key)}:b" data-nf="att">`
      + `<rect x="-300" y="-900" width="800" height="1000" class="ai-sky"/><rect x="-300" y="100" width="800" height="1000" class="ai-gnd"/>`
      + `<line x1="-300" y1="100" x2="500" y2="100" class="ai-hz"/>${ladder}</g>`
      + `<g data-nk="${esc(key)}:b" data-nf="bank"><path d="M100 18 l-6 10 h12 z" class="ai-ptr"/></g>`
    : `<rect x="0" y="0" width="200" height="200" fill="url(#ai-hatch)"/><text x="100" y="106" class="g-digit dd-natext">N/A</text>`;
  return `<svg class="gauge-svg" viewBox="0 0 200 200" data-g="att" data-key="${esc(key)}" role="img" aria-label="${esc(t('d.attitude'))}">`
    + `<defs><clipPath id="ai-clip-${esc(key).replace(/\W/g, '_')}"><circle cx="100" cy="100" r="88"/></clipPath>`
    + `<pattern id="ai-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#1a2027"/><path d="M0 0V6" stroke="#2c343d" stroke-width="2"/></pattern></defs>`
    + `<circle cx="100" cy="100" r="97" class="g-bezel"/>`
    + `<g clip-path="url(#ai-clip-${esc(key).replace(/\W/g, '_')})">${disc}</g>`
    + `<circle cx="100" cy="100" r="88" class="ai-rim"/>${scale}`
    + `<path d="M100 12 l-6 -9 h12 z" class="ai-idx"/>`
    + `<path d="M48 100 h32 l7 9 M152 100 h-32 l-7 9" class="ai-plane"/><circle cx="100" cy="100" r="3.4" class="ai-dot"/>`
    + '</svg>';
}
function attRead(att) {
  if (!att || !Number.isFinite(att.pitch)) return `<span class="ai-read" data-att>${esc(t('state.na'))}</span>`;
  const sg = (v) => (v > 0.05 ? '+' : (v < -0.05 ? '−' : '')) + Math.abs(v).toFixed(1) + '°';
  return `<span class="ai-read" data-att dir="ltr">${esc(t('d.pitch'))} <b>${sg(att.pitch)}</b> · ${esc(t('d.bank'))} <b>${sg(att.bank)}</b></span>`;
}
function patchAtt(svg, att) {
  if (!att || !Number.isFinite(att.pitch)) return;
  const k = svg.dataset.key;
  needle(k + ':p', att.pitch); needle(k + ':b', att.bank, true);
}

// ---- compass: the card turns so the heading sits under the fixed lubber mark at the top.
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function cardinal(dir) { return CARDINALS[Math.round(norm360(dir) / 45) % 8]; }
const fmtDeg = (a) => String(Math.round(norm360(a)) % 360).padStart(3, '0') + '°';
function compassCard(r0) {
  let card = '';
  for (let a = 0; a < 360; a += 5) {
    const maj = a % 30 === 0, mid = a % 10 === 0;
    card += gTick(maj ? r0 - 14 : (mid ? r0 - 9 : r0 - 6), r0, a, maj ? 2.4 : 1.1, maj ? '#dfe4ea' : '#7d8893');
    if (maj) {
      const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[a] ?? String(a / 10);
      const cls = a === 0 ? 'g-card-n' : (a % 90 === 0 ? 'g-card-c' : 'g-card-d');
      card += `<text x="100" y="${100 - r0 + 33}" transform="rotate(${a} 100 100)" class="${cls}">${lbl}</text>`;
    }
  }
  return card;
}
function compassGauge(key, dir) {
  needle(key, norm360(dir), true);
  return `<svg class="gauge-svg" viewBox="0 0 200 200" data-g="cmp" data-key="${esc(key)}" role="img" aria-label="${esc(t('d.heading'))}">` + G_BEZEL
    + `<g data-nk="${esc(key)}" data-nf="card">${compassCard(86)}</g>`
    + `<path d="M100 4 L93 16 L107 16 z" class="g-lubber"/><line x1="100" y1="16" x2="100" y2="30" class="g-lubber-l"/>`
    + `<circle cx="100" cy="100" r="34" class="g-window"/>`
    + `<text x="100" y="104" class="g-digit g-digit-s g-d">${fmtDeg(dir)}</text>`
    + `<text x="100" y="121" class="g-unit g-unit-c g-c">${cardinal(dir)}</text></svg>`;
}
function patchCompass(svg, dir) {
  needle(svg.dataset.key, norm360(dir), true);
  svg.querySelector('.g-d').textContent = fmtDeg(dir);
  svg.querySelector('.g-c').textContent = cardinal(dir);
}

// A small 240° ring meter (fuel / health): icon and percentage in the middle.
function ringGauge(icon, frac, cls, ends, label) {
  const f = clamp01(frac);
  const tone = cls === 'bad' ? 'g-val-bad' : (cls === 'warn' ? 'g-val-warn' : 'g-val-ok');
  const [ex, ey] = gPt(76, -120), [fx, fy] = gPt(76, 120);
  return `<svg class="gauge-svg" viewBox="0 0 200 172" role="img" aria-label="${esc(label || '')} ${Math.round(f * 100)}%">`
    + `<path d="${gArc(76, -120, 120)}" class="g-track g-track-w"/>`
    + `<path d="${gArc(76, -120, 120)}" pathLength="100" class="${tone} g-ring" stroke-dasharray="100 200" style="stroke-dashoffset:${(100 - f * 100).toFixed(2)}"/>`
    + `<g class="g-ring-ic ${tone}-c">${gIcon(icon, 84, 52, 32)}</g>`
    + `<text x="100" y="124" class="g-digit">${Math.round(f * 100)}<tspan class="g-pct">%</tspan></text>`
    + (ends ? `<text x="${(ex + 8).toFixed(1)}" y="${(ey + 16).toFixed(1)}" class="g-end">${ends[0]}</text>`
      + `<text x="${(fx - 8).toFixed(1)}" y="${(fy + 16).toFixed(1)}" class="g-end">${ends[1]}</text>` : '')
    + '</svg>';
}

// Integrity dial for one component: 100% = intact, 0% = destroyed. The game reports damage
// (0 = intact … 1 = destroyed), so health = 1 − damage. Green / amber / red bands run from the
// healthy end down; the needle sits at the remaining health. dmg null = not reported → N/A.
function sevClass(dmg) { return dmg == null ? 'na' : (dmg >= 0.9 ? 'crit' : (dmg >= 0.7 ? 'bad' : (dmg >= 0.35 ? 'warn' : 'ok'))); }
const healthOf = (dmg) => (dmg == null || !Number.isFinite(dmg) ? null : 1 - clamp01(dmg));
function healthDial(label, dmg, icon) {
  const sev = sevClass(dmg);
  const h = healthOf(dmg);
  const band = (a, b, c) => `<path d="${gArc(70, -120 + 240 * a, -120 + 240 * b)}" class="dd-band" stroke="${c}"/>`;
  let ticks = '';
  for (let i = 0; i <= 10; i++) ticks += gTick(i % 5 ? 60 : 56, 64, -120 + 24 * i, i % 5 ? 1.2 : 2, '#9aa5b0');
  const body = h == null
    ? `<text x="100" y="118" class="g-digit dd-natext">N/A</text>`
    : `<g ${rot(-120 + 240 * h)}><path d="${needlePath(66, 3.5)}" class="g-needle"/></g>`
      + `<circle cx="100" cy="100" r="6" class="g-hub"/>`
      + `<text x="100" y="140" class="g-digit dd-v">${Math.round(h * 100)}<tspan class="g-pct">%</tspan></text>`;
  return `<div class="dd dd-${sev}" title="${esc(label)}"><svg class="gauge-svg" viewBox="0 0 200 160" role="img" aria-label="${esc(label)} ${h == null ? t('state.na') : Math.round(h * 100) + '%'}">`
    + `<circle cx="100" cy="100" r="92" class="g-face dd-face"/>`
    + band(0, 0.1, '#e05252') + band(0.1, 0.3, '#e0772f') + band(0.3, 0.65, '#e0a43a') + band(0.65, 1, '#3fb86b')
    + `<text x="38" y="150" class="g-end dd-end">0</text><text x="162" y="150" class="g-end dd-end">100</text>`
    + ticks + (icon ? `<g class="dd-ic">${gIcon(icon, 88, 62, 24)}</g>` : '') + body
    + `</svg><div class="dd-l"><bdi>${esc(label)}</bdi>${sev === 'crit' ? `<span class="dd-badge">${t('state.crit')}</span>` : ''}</div></div>`;
}

function gCard(svg, label, extra = '', cls = '') {
  return `<div class="g-card ${cls}">${svg}<div class="g-cap"><span>${esc(label)}</span>${extra}</div></div>`;
}

// ---- live telemetry from the position stream. The game sends it every frame it is due (default
// 20 Hz); vehicles with an open detail page also carry pitch, bank and gun directions there.
S.live = {};      // id -> { dir, alt, speed, pitch, bank, tur0, tur1, at }  newest position-stream values
S.detailAt = {};  // id -> performance.now() when its last detail arrived
S.rate = { pos: [], detail: [] }; // arrival times, for the measured update rates
const LIVE_MAX_AGE = 1500;
function noteRate(list, now) { list.push(now); while (list.length && now - list[0] > 3000) list.shift(); }
function rateOf(list) { return list.length < 2 ? 0 : (list.length - 1) * 1000 / (list[list.length - 1] - list[0]); }
function liveOf(d) {
  const L = S.live[d.id];
  const fresh = L && performance.now() - L.at < LIVE_MAX_AGE;
  const pick = (k, fb) => (fresh && L[k] != null ? L[k] : fb);
  const tu = (path) => {
    const e = (d.turrets || []).find((x) => JSON.stringify(x.path) === JSON.stringify(path));
    return e && e.ok ? e.az : null;
  };
  return {
    dir: pick('dir', d.dir),
    alt: pick('alt', d.alt),
    speed: pick('speed', d.speed),
    att: fresh && L.pitch != null ? { pitch: L.pitch, bank: L.bank } : (d.att || null),
    tur0: pick('tur0', d.turret && d.turret.ok ? d.turret.az : tu([0])),
    tur1: pick('tur1', tu([0, 0])),
  };
}
// Called from onPos for every position update: keep values for the entities a detail page
// shows and move their gauges in place (no full re-render).
function onLivePos(p) {
  const ids = detailWatchIds();
  if (!ids.length) return;
  const now = performance.now();
  let hit = false;
  for (const v of p.vehicles || []) {
    if (!ids.includes(v[0])) continue;
    hit = true;
    const L = { dir: v[3], alt: v[4], speed: v[5], at: now };
    if (v.length >= 10) { // extras for a watched vehicle (newer mod)
      L.pitch = v[6]; L.bank = v[7];
      L.tur0 = v[8] >= 0 ? v[8] : null; L.tur1 = v[9] >= 0 ? v[9] : null;
    }
    S.live[v[0]] = L;
  }
  for (const u of p.units || []) if (ids.includes(u[0])) { S.live[u[0]] = { dir: u[3], at: now }; hit = true; }
  if (hit) noteRate(S.rate.pos, now);
  patchLive();
  wsPatchLive();
}
function patchLive() {
  const box = $('#detail');
  if (!box || box.hidden) return;
  const id = DETAIL_ID || S.detailId;
  const d = id && S.details[id];
  if (!d || !d.found) return;
  patchLiveIn(box, d);
}
// Move the gauges inside box that belong to entity d (detail page or a workspace panel).
function patchLiveIn(box, d) {
  const L = liveOf(d);
  for (const svg of box.querySelectorAll('svg[data-g]')) {
    const g = svg.dataset.g;
    if (g === 'spd') patchSpeed(svg, L.speed);
    else if (g === 'alt') patchAlt(svg, L.alt);
    else if (g === 'cmp') patchCompass(svg, L.dir);
    else if (g === 'att') patchAtt(svg, L.att);
    else if (g === 'tur') patchTurret(svg, d, L);
  }
  if (L.att) for (const ar of box.querySelectorAll('[data-att]')) ar.outerHTML = attRead(L.att);
  for (const el of box.querySelectorAll('[data-turread]')) el.outerHTML = turretRead(d, L, el.dataset.turread);
  for (const el of box.querySelectorAll('[data-wslive]')) {
    const k = el.dataset.wslive;
    if (k === 'spd') el.textContent = `${Math.round(Math.max(0, L.speed || 0))} km/h`;
    else if (k === 'alt') el.textContent = Number.isFinite(L.alt) ? `${Math.round(L.alt)} m` : '—';
  }
}

// ---- data freshness: how old the newest detail is; stale data is dimmed, never shown as live.
function freshness(id) {
  if (!S.sse || (S.status && S.status.connected === false)) return { cls: 'off', txt: t('fresh.offline') };
  const at = S.detailAt[id];
  if (!at) return { cls: 'wait', txt: t('fresh.wait') };
  const age = (performance.now() - at) / 1000;
  if (age < 1.5) return { cls: 'live', txt: t('fresh.live') };
  if (age < 4) return { cls: 'late', txt: t('fresh.age', { n: age.toFixed(1) }) };
  return { cls: 'stale', txt: t('fresh.stale', { n: Math.round(age) }) };
}
function freshTitle() {
  const p = rateOf(S.rate.pos), dd = rateOf(S.rate.detail);
  return t('fresh.title') + (p || dd ? ' — ' + t('fresh.rates', { p: p.toFixed(0), d: dd.toFixed(0) }) : '');
}
function freshChip(id) {
  const f = freshness(id);
  return `<span class="fresh fresh-${f.cls}" data-fresh title="${esc(t('fresh.title'))}"><i></i>${esc(f.txt)}</span>`;
}
setInterval(() => {
  const box = $('#detail');
  if (!box || box.hidden) return;
  const id = DETAIL_ID || S.detailId;
  const el = box.querySelector('[data-fresh]');
  if (!id || !el) return;
  const f = freshness(id);
  el.className = `fresh fresh-${f.cls}`;
  el.lastChild.textContent = f.txt;
  el.title = freshTitle();
  box.classList.toggle('d-stale', f.cls === 'stale' || f.cls === 'off');
}, 250);

// ---- turret: a north-up dial with the hull and the gun drawn separately, both in world azimuth.
// The hull outline and the header icon follow the vehicle (a helicopter's chin gun is not a tank
// turret). The commander's sight, when the vehicle reports it, is a second, thinner pointer.
function turretInfo(d) {
  const tu = d.turret;
  if (tu == null) return { state: 'old' };          // this mod version does not report it
  if (tu.none) return { state: 'none' };            // no main turret on this vehicle
  if (!tu.ok) return { state: 'na', gunner: tu.gunner };
  return { state: 'ok', az: tu.az, rel: tu.rel, gunner: tu.gunner, gunnerName: tu.gunnerName };
}
const toMils = (deg) => Math.round(norm360(deg) * 6400 / 360);
function clockPos(rel) { const h = Math.round(norm360(rel) / 30) % 12; return h === 0 ? 12 : h; }
const turretIcon = (kind) => (isAir(kind) ? 'heliturret' : 'turret');
// Hull outline, nose up, centred on the dial.
function turretHull(kind) {
  if (kind === 'heli' || kind === 'uav' || kind === 'plane') {
    return `<circle cx="100" cy="96" r="40" class="tur-rotor"/>`
      + `<rect x="88" y="62" width="24" height="56" rx="11" class="tur-hullbox"/>`
      + `<rect x="97" y="116" width="6" height="34" rx="3" class="tur-hullbox"/>`
      + `<rect x="91" y="146" width="18" height="5" rx="2" class="tur-hullbox"/>`
      + `<ellipse cx="100" cy="72" rx="7" ry="8" class="tur-glass"/>`;
  }
  if (kind === 'apc') {
    return `<rect x="80" y="58" width="40" height="86" rx="6" class="tur-hullbox"/><path d="M100 50 l-7 9 h14 z" class="tur-hullnose"/>`
      + [70, 86, 102, 118].map((y) => `<rect x="75" y="${y}" width="5" height="11" rx="2" class="tur-hullnose"/><rect x="120" y="${y}" width="5" height="11" rx="2" class="tur-hullnose"/>`).join('');
  }
  if (kind === 'car') return `<rect x="84" y="66" width="32" height="70" rx="10" class="tur-hullbox"/><path d="M100 58 l-6 8 h12 z" class="tur-hullnose"/>`;
  return `<rect x="76" y="64" width="9" height="74" rx="3" class="tur-hullnose"/><rect x="115" y="64" width="9" height="74" rx="3" class="tur-hullnose"/>`
    + `<rect x="84" y="68" width="32" height="66" rx="5" class="tur-hullbox"/><path d="M100 60 l-6 8 h12 z" class="tur-hullnose"/>`;
}
function turretDial(d, L) {
  const ti = turretInfo(d);
  const key = d.id + ':tur';
  needle(key + ':hull', norm360(L.dir), true);
  const gunOk = ti.state === 'ok' && L.tur0 != null;
  if (gunOk) needle(key + ':gun', norm360(L.tur0), true);
  const cmdOk = L.tur1 != null;
  if (cmdOk) needle(key + ':cmd', norm360(L.tur1), true);
  const gun = gunOk
    ? `<g data-nk="${esc(key)}:gun" data-nf="deg"><path d="M98 100 V20 h4 V100 z" class="tur-barrel"/><circle cx="100" cy="100" r="13" class="tur-ring"/></g>`
    : `<g><circle cx="100" cy="100" r="13" class="tur-ring tur-ring-na"/></g>`;
  const cmd = cmdOk ? `<g data-nk="${esc(key)}:cmd" data-nf="deg"><path d="M100 100 V30" class="tur-cmd"/><circle cx="100" cy="30" r="4" class="tur-cmd-dot"/></g>` : '';
  return `<svg class="gauge-svg" viewBox="0 0 200 200" data-g="tur" data-key="${esc(key)}" role="img" aria-label="${esc(t('tur.title'))}">` + G_BEZEL
    + `<g>${compassCard(86)}</g>`
    + `<g data-nk="${esc(key)}:hull" data-nf="deg">${turretHull(d.kind)}</g>`
    + cmd + gun + '</svg>';
}
function patchTurret(svg, d, L) {
  const key = svg.dataset.key;
  needle(key + ':hull', norm360(L.dir), true);
  if (L.tur0 != null) needle(key + ':gun', norm360(L.tur0), true);
  if (L.tur1 != null) needle(key + ':cmd', norm360(L.tur1), true);
}
// The text beside the dial; re-rendered in place by the position stream.
function turretRead(d, L, which = 'main') {
  const ti = turretInfo(d);
  const hull = L.dir;
  const line = (lbl, v, small) => `<div><span>${esc(lbl)}</span><b dir="ltr">${v}</b>${small ? `<small dir="ltr">${small}</small>` : ''}</div>`;
  let h = `<div class="tur-read" data-turread="${which}">`;
  if (ti.state === 'ok' && L.tur0 != null) {
    const rel = norm360(L.tur0 - hull);
    h += line(t('tur.gun'), fmtDeg(L.tur0), `${toMils(L.tur0)} mil · ${cardinal(L.tur0)}`)
      + line(t('tur.hull'), fmtDeg(hull), cardinal(hull))
      + line(t('tur.rel'), fmtDeg(rel), t('tur.clock', { n: clockPos(rel) }));
  } else {
    h += `<div class="tur-na">${esc(t(ti.state === 'old' ? 'tur.old' : 'tur.na'))}</div>` + line(t('tur.hull'), fmtDeg(hull));
  }
  if (L.tur1 != null) h += line(t('tur.cmd'), fmtDeg(L.tur1), cardinal(L.tur1));
  return h + line(t('d.pos'), gridRef(d.x, d.y)) + '</div>';
}
function turretCard(d, L) {
  const ti = turretInfo(d);
  if (ti.state === 'none') return '';
  const mine = ti.gunner && ti.gunner === meId();
  return `<div class="tur ${mine ? 'tur-mine' : ''}"><div class="tur-head">${dIcon(turretIcon(d.kind), 16)}<span>${t(isAir(d.kind) ? 'tur.title_air' : 'tur.title')}</span>`
    + (mine ? `<span class="tur-you">${t('tur.you')}</span>` : '') + `</div>`
    + `<div class="tur-body"><div class="tur-dial">${turretDial(d, L)}</div>${turretRead(d, L)}</div></div>`;
}

// ---- the instrument cluster at the top of the overview, chosen by what the entity is
function renderCluster(d) {
  const L = liveOf(d);
  const k = d.id + ':';
  const hpCard = gCard(ringGauge('heart', d.hp, hpClass(d.hp), null, t('d.health')), t('d.health'), '', 'g-mini');
  const fuelCard = d.fuel >= 0
    ? gCard(ringGauge('fuel', d.fuel, d.fuel > 0.3 ? '' : (d.fuel > 0.1 ? 'warn' : 'bad'), ['E', 'F'], t('d.fuel')), t('d.fuel'), '', 'g-mini')
    : '';
  const heading = gCard(compassGauge(k + 'cmp', L.dir), t('d.heading'));
  if (d.kind === 'man' || d.kind === 'static') {
    return `<div class="cluster">${heading}<div class="g-minis solo">${hpCard}</div></div>`;
  }
  const speed = gCard(speedGauge(k + 'spd', d.kind, L.speed), t('d.speed'));
  if (isAir(d.kind)) {
    const alt = gCard(altGauge(k + 'alt', L.alt), t('d.alt'));
    const att = gCard(attitudeGauge(k + 'att', L.att), t('d.attitude'), attRead(L.att));
    return `<div class="cluster cluster-air">${speed}${alt}${att}${heading}<div class="g-minis span2">${fuelCard}${hpCard}</div></div>`;
  }
  return `<div class="cluster">${speed}${heading}<div class="g-minis span2">${fuelCard}${hpCard}</div></div>`;
}

// The entity's name card (logo, person, type, side) at the top of the overview.
function detailHero(d) {
  const col = SIDE_COLOR[d.side] || '#777';
  const pname = d.kind === 'man' ? personName(d.id) : '';
  return `<div class="d-hero" style="--side:${col}">`
    + `<div class="d-logo">${kindIcon(d.kind, 44)}</div>`
    + `<div class="d-hero-txt">`
    + (pname ? `<div class="d-hero-name">${dIcon('man', 14)}<bdi>${esc(pname)}</bdi></div>` : '')
    + `<div class="d-hero-type"><bdi>${esc(d.name || d.cls)}</bdi></div>`
    + `<div class="d-hero-sub"><span class="side-chip" style="background:${col}"></span>`
    + `${esc(tOr('side.' + d.side, d.side))} · ${esc(tOr('kind.' + d.kind, d.kind))}</div>`
    + `</div></div>`;
}
function renderOverview(d) {
  const isMan = d.kind === 'man';
  const hero = detailHero(d);
  // speed, altitude, attitude, heading, fuel and health live on the gauges; only the grid stays a tile
  const tur = !isMan ? turretCard(d, liveOf(d)) : '';
  // the turret card carries the grid itself; otherwise it is a tile
  const tiles = tur ? '' : `<div class="d-tiles">${stat('grid', t('d.pos'), `<span dir="ltr">${gridRef(d.x, d.y)}</span>`)}</div>`;
  return hero + renderCluster(d) + tur + tiles;
}

// ============================================================ weapons
// One entry per weapon with a type tag. Newer mod versions tag weapons from CfgAmmo
// (weaponsFull); older ones only send names, so the tag is guessed from the name.
const UTILITY_TAGS = ['cm', 'laser', 'smoke', 'horn'];
function tagFromName(name, kind) {
  const s = String(name).toLowerCase();
  if (/flare|chaff|countermeasure|\bcm\b/.test(s)) return 'cm';
  if (/laser|designator|marker/.test(s)) return 'laser';
  if (/horn/.test(s)) return 'horn';
  if (/smoke/.test(s)) return 'smoke';
  if (/minigun|m134|gatling/.test(s)) return 'minigun';
  if (/bomb|gbu|mk-?82|cbu|kab|fab-/.test(s)) return 'bomb';
  if (/missile|scalpel|macer|asraam|amraam|sidewinder|bim-|zephyr|falchion|sahr|vikhr|ataka|titan|kh-|r-7|aa-|at-/.test(s)) return 'missile';
  if (/rocket|hydra|dagr|skyfire|s-8|zuni|shrieker|tratnyr/.test(s)) return 'rocket';
  if (/gmg|grenade launcher|40 ?mm|35 ?mm gl/.test(s)) return 'gl';
  if (/cannon|mm gun|120|125|105/.test(s) && /cannon|gun/.test(s) && !/auto|20 ?mm|30 ?mm|40 ?mm/.test(s)) return isArmor(kind) ? 'cannon' : 'autocannon';
  if (/autocannon|20 ?mm|30 ?mm|40 ?mm|35 ?mm/.test(s)) return 'autocannon';
  return 'mg';
}
const TAG_ICON = { cannon: 'cannon', autocannon: 'autocannon', mg: 'mg', minigun: 'minigun', gl: 'gl', missile: 'missile', rocket: 'pod', bomb: 'bomb', cm: 'flare', laser: 'laser', smoke: 'smoke', horn: 'horn', gun: 'mg' };
const GUN_TAGS = ['minigun', 'mg', 'autocannon', 'cannon', 'gun'];
// The icon for a vehicle weapon: by its type, then by where it sits (a helicopter's chin gun is a
// helicopter turret, not a tank one; a tank's coaxial MG has its own glyph).
function weaponGlyph(d, w, role) {
  if (w.tag === 'minigun') return 'minigun';
  if (isArmor(d.kind) && role === t('wrole.coax')) return 'coax';
  if (d.kind === 'heli' && GUN_TAGS.includes(w.tag) && w.turret && w.turret[0] === 0 && w.turret.length === 1) return 'heliturret';
  return TAG_ICON[w.tag] || 'mg';
}
function vehWeapons(d) {
  if (d.weaponsFull) return d.weaponsFull.map((w) => ({ ...w, known: true }));
  return (d.weapons || []).map((w) => ({ name: w.name, ammo: w.ammo, cap: 0, mags: 0, turret: null, tag: tagFromName(w.name, d.kind), known: false, laser: null }));
}
const samePath = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// One gun reachable from two stations (the game lists the class on both turrets, but only one of
// them holds its magazines) is one weapon: keep the entry with the ammunition and note the other
// station. Identical guns that each carry their own magazines stay separate.
function mergeShared(list) {
  const out = [];
  for (const w of list) {
    if (!w.cls) { out.push(w); continue; }
    const twin = out.find((o) => o.cls === w.cls && !samePath(o.turret, w.turret) && (o.mags === 0 || w.mags === 0));
    if (!twin) { out.push(w); continue; }
    const keep = twin.mags === 0 && w.mags > 0 ? w : twin, other = keep === w ? twin : w;
    const merged = { ...keep, also: [...(keep.also || []), other.turret] };
    out[out.indexOf(twin)] = merged;
  }
  return out;
}
// Who works the weapon, from its turret path: [-1] driver/pilot, [0] gunner, [0,0] commander.
function mountOf(d, w) {
  if (w.also && w.also.length) return [w, ...w.also.map((turret) => ({ turret }))].map((x) => mountOf(d, { turret: x.turret })).join(' / ');
  const tp = w.turret;
  if (!tp) return '';
  if (tp.length === 1 && tp[0] === -1) return t(isAir(d.kind) ? 'role.pilot' : 'role.driver');
  const seat = (d.seats || []).find((s) => samePath(s.turret, tp));
  if (seat && seat.gunnerName) return seat.gunnerName;
  if (tp.length === 1 && tp[0] === 0) return t('role.gunner');
  if (tp.length === 2 && tp[0] === 0 && tp[1] === 0) return t('role.commander');
  return t('role.turret');
}
// Role names for armour: the main gun, the coaxial MG beside it, and roof weapons above.
function armorRole(d, w) {
  if (!isArmor(d.kind) || !w.turret) return '';
  const main = w.turret.length === 1 && w.turret[0] === 0;
  if (main && w.tag === 'cannon') return t('wrole.main');
  if (main && (w.tag === 'mg' || w.tag === 'minigun')) return t('wrole.coax');
  if (main && w.tag === 'autocannon') return t('wrole.auto');
  if (main && w.tag === 'missile') return t('wrole.atgm');
  if (w.turret.length >= 2) return t('wrole.roof');
  return '';
}
// A weapon card. Rounds in total (every magazine for this weapon on its turret) against the real
// capacity; the rounds in the breech and each magazine type (AP / HE …) when the mod reports
// them. Older mods report only the loaded magazine, measured against the most rounds seen.
const AMMO_MAX = new Map();
function weaponCard(d, w) {
  const key = d.id + '|' + w.name + '|' + JSON.stringify(w.turret);
  let mx = w.cap > 0 ? w.cap : Math.max(AMMO_MAX.get(key) || 0, w.ammo);
  if (!(w.cap > 0)) AMMO_MAX.set(key, mx);
  const f = mx > 0 ? w.ammo / mx : 0;
  const empty = w.ammo <= 0;
  const cls = empty ? 'empty' : (f > 0.5 ? 'ok' : (f > 0.2 ? 'warn' : 'bad'));
  const role = armorRole(d, w);
  const icon = d.kind === 'man' ? weaponIcon(w.name) : weaponGlyph(d, w, role);
  const mount = mountOf(d, w);
  const multi = w.types && w.types.length > 1;
  const pyl = w.pylons > 0 ? t(w.pylons === 1 ? 'd.on_pylon' : 'd.on_pylons', { n: w.pylons }) : '';
  const sub = [role, mount, pyl, !multi && w.mag && w.mag !== w.name ? w.mag : ''].filter(Boolean).join(' · ');
  const status = empty ? `<span class="wst wst-empty">${t('ws.empty')}</span>` : '';
  const salvo = ['missile', 'bomb', 'rocket'].includes(w.tag);
  const loaded = w.loaded != null && w.mags > 1 && !salvo
    ? `<span class="wload">${dIcon('mag', 12)}${esc(t('ws.loaded', { n: w.loaded }))}${w.loadedMag && multi ? ` · <bdi>${esc(w.loadedMag)}</bdi>` : ''}</span>` : '';
  const types = multi
    ? `<span class="wtypes">${w.types.map((m) => `<span class="wtype ${m.ammo <= 0 ? 'wtype-0' : ''}"><bdi>${esc(m.name)}</bdi> <b dir="ltr">${m.ammo}/${m.cap}</b></span>`).join('')}</span>` : '';
  return `<div class="wcard w-${cls}">`
    + `<span class="wcard-ic">${dIcon(icon, 30)}</span>`
    + `<span class="wcard-t"><span class="wcard-n"><bdi>${esc(w.name)}</bdi></span>${sub ? `<span class="wcard-s"><bdi>${esc(sub)}</bdi></span>` : ''}</span>`
    + `<span class="wcard-v"><b>${w.ammo}</b>${w.cap > 0 ? `<small>/ ${w.cap}</small>` : `<small>${esc(t('d.rnd'))}</small>`}${w.mags > 1 && !salvo ? `<small class="wmags">${t('d.mags', { n: w.mags })}</small>` : ''}</span>`
    + status + (loaded || types ? `<span class="wextra">${loaded}${types}</span>` : '')
    + `<span class="wbelt ${w.cap > 0 ? '' : 'wbelt-est'}" title="${esc(w.cap > 0 ? '' : t('d.ammo_est'))}"><span style="width:${Math.round(f * 100)}%"></span></span></div>`;
}
// Laser designator state: on | off | unknown (not reported, or the data is stale) | none (not fitted).
function laserState(d, value) {
  const f = freshness(d.id).cls;
  if (value == null || f === 'stale' || f === 'off') return 'unknown';
  return value ? 'on' : 'off';
}
function laserRow(name, state) {
  return `<div class="d-row laser laser-${state}"><span class="d-ic">${dIcon('laser', 18)}</span>`
    + `<span class="d-n"><bdi>${esc(name)}</bdi></span>`
    + `<span class="las-chip"><i></i>${esc(t('las.' + state))}</span></div>`;
}
function utilRow(d, w) {
  if (w.tag === 'laser') return laserRow(w.name, laserState(d, w.laser == null || w.laser < 0 ? null : w.laser));
  const icon = TAG_ICON[w.tag] || 'misc';
  const chip = w.tag === 'horn' ? '' : countChip(w.ammo, w.ammo > 0 ? '' : 'empty');
  return invRow(icon, w.name, chip, t('wtag.' + w.tag));
}

// What hangs on a pylon, from its magazine's display name (aircraft board).
const STORE_COL = { missile: '#ff8a3d', bomb: '#e8c24b', pod: '#4dd0e1', tank: '#9fb7c9', gun: '#b39ddb', empty: 'none' };
function storeType(name) {
  const s = String(name || '').toLowerCase().trim();
  const has = (...w) => w.some((x) => s.includes(x));
  if (!s) return 'empty';
  if (has('fuel tank', 'drop tank', 'external fuel', 'fuel pod')) return 'tank';
  if (has('bomb', 'gbu', 'mk-82', 'mk82', 'mk-84', 'cbu', 'kab-', 'fab-', 'lgb', 'glide', 'jdam', 'paveway', 'sdb')) return 'bomb';
  if (has('minigun', 'gatling', 'gun pod', 'cannon pod')) return 'gun';
  if (has('rocket', 'hydra', 'dagr', 'skyfire', 's-8', 's-5', 's-13', 'zuni', 'shrieker', 'tratnyr', 'ffar', 'pod')) return 'pod';
  if (has('gun', 'cannon', 'gatling', 'twin')) return 'gun';
  return 'missile';
}
// One store, top view, nose up, centred on (x, y), drawn at scale k.
// state: ok (loaded) | spent (fired or dropped: an outline only) | empty (nothing fitted) | unknown
function storeGlyph(type, x, y, name, state, k = 1, s = {}) {
  const c = STORE_COL[type];
  const rnd = s.max > 1 ? ` — ${s.ammo} / ${s.max}` : '';
  const tip = `${name || t('store.empty')}${state === 'spent' ? ' — ' + t('ws.empty') : rnd}`;
  // a rack with several rounds says how many are left on it
  const badge = s.max > 1 && state !== 'empty' ? `<text x="0" y="25" class="hp-n">${s.ammo}</text>` : '';
  const g = (body) => `<g class="hp hp-${type} hp-st-${state}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k})"><title>${esc(tip)}</title>${body}${badge}</g>`;
  const fill = state === 'spent' ? 'none' : c;
  const stroke = `stroke="${c}" stroke-width="1.4"${state === 'spent' ? ' stroke-dasharray="3 2"' : ''}`;
  switch (type) {
    case 'bomb': return g(`<path d="M-3 9 L-7 14 H7 L3 9 z" fill="${fill}" ${stroke}/><ellipse cx="0" cy="-1" rx="5" ry="12" fill="${fill}" ${stroke}/>`);
    case 'pod': return g(`<rect x="-5" y="-11" width="10" height="22" rx="4" fill="${fill}" ${stroke}/><path d="M-5 -4 h10 M-5 2 h10" stroke="#0c0f12" stroke-width="1.2"/>`);
    case 'tank': return g(`<ellipse cx="0" cy="0" rx="5.5" ry="15" fill="${fill}" ${stroke}/>`);
    case 'gun': return s.mini
      // minigun pod: the rotary barrel cluster sticking out of the fairing
      ? g(`<rect x="-4.5" y="-6" width="9" height="18" rx="3" fill="${fill}" ${stroke}/><path d="M-2.2 -6 V-16 M0 -6 V-17 M2.2 -6 V-16" stroke="${c}" stroke-width="1.3"/><path d="M-3.2 -12 h6.4" stroke="${c}" stroke-width="1.4"/>`)
      : g(`<rect x="-4.5" y="-8" width="9" height="20" rx="3" fill="${fill}" ${stroke}/><rect x="-1.2" y="-15" width="2.4" height="8" fill="${c}"/>`);
    case 'empty': return g(`<rect x="-4" y="-9" width="8" height="18" rx="3" class="hp-hollow"/>`);
    default: return g(`<path d="M0 -16 L2.3 -11 V10 L6 15 H-6 L-2.3 10 V-11 z" fill="${fill}" ${stroke}/><path d="M-5 -6 h10" stroke="${c}" stroke-width="1.6"/>`);
  }
}
// A gun on the airframe, top view, barrels pointing along rot (0 = forward).
function gunGlyph(tag, x, y, rotDeg, name, ammo) {
  const empty = ammo != null && ammo <= 0;
  const c = empty ? '#7d8893' : STORE_COL.gun;
  const body = tag === 'minigun'
    ? `<rect x="-4" y="2" width="8" height="9" rx="2" fill="#0c0f12" stroke="${c}" stroke-width="1.4"/><path d="M-2.4 2 V-13 M0 2 V-14 M2.4 2 V-13" stroke="${c}" stroke-width="1.5"/><path d="M-3.6 -8 h7.2" stroke="${c}" stroke-width="1.6"/>`
    : `<rect x="-3.5" y="0" width="7" height="10" rx="2" fill="#0c0f12" stroke="${c}" stroke-width="1.4"/><path d="M0 0 V-${tag === 'cannon' || tag === 'autocannon' ? 15 : 11}" stroke="${c}" stroke-width="${tag === 'cannon' ? 3 : 2}"/>`;
  return `<g class="hp hp-gunmount" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rotDeg})"><title>${esc(name)}${empty ? ' — ' + esc(t('ws.empty')) : ''}</title>${body}</g>`;
}
// The vehicle weapon a pylon feeds: by the weapon class the mod reports for the pylon, else by the
// magazine names the weapon lists (older mods).
function pylonWeapon(d, p) {
  const ws = d.weaponsFull || [];
  if (p.weapon) return ws.find((w) => String(w.cls).toLowerCase() === p.weapon) || null;
  return ws.find((w) => (w.types || []).some((m) => m.name === p.name)) || null;
}
// A weapon fed from pylons is drawn on its pylons, never again as a fixed gun.
function isPylonFed(d, w) {
  if (w.pylons != null) return w.pylons > 0;
  return (d.pylonsFull || []).some((p) => p.mag && pylonWeapon(d, p) === w);
}
function pylonStores(d) {
  if (d.pylonsFull) {
    return d.pylonsFull.map((p) => {
      const w = p.mag ? pylonWeapon(d, p) : null;
      // what hangs there: the fed weapon's type from the game's ammunition config first (a
      // "minigun pod" is a gun, not a rocket pod), the store's name otherwise
      const byTag = w && { bomb: 'bomb', missile: 'missile', rocket: 'pod', minigun: 'gun', mg: 'gun', autocannon: 'gun', cannon: 'gun', gun: 'gun' }[w.tag];
      return {
        name: p.name, type: p.mag ? (storeType(p.name) === 'tank' ? 'tank' : (byTag || storeType(p.name))) : 'empty',
        // ok: full · part: some rounds left on a multi-round rack · spent: none left · empty: nothing fitted
        state: !p.mag ? 'empty' : (p.ammo <= 0 ? 'spent' : (p.max > 1 && p.ammo < p.max ? 'part' : 'ok')),
        ammo: p.ammo, max: p.max, ux: p.ux, uy: p.uy, index: p.index, mini: !!(w && w.tag === 'minigun'),
      };
    });
  }
  // older mod: grouped names only, no per-pylon rounds
  const out = [];
  for (const p of d.pylons || []) for (let i = 0; i < Math.max(1, p.count); i++) out.push({ name: p.name, type: storeType(p.name), state: p.name ? 'unknown' : 'empty', ux: -1, uy: -1 });
  return out;
}
// Hardpoint anchors per airframe, on the 320x240 board (nose up, centreline x = 160).
// Each side's stations are spread evenly from the wing root to the tip, inner to outer, so two
// stores never share a spot however many pylons the aircraft has. Stores on the centreline go
// down the fuselage.
const AIRFRAME_ST = {
  plane: { root: 26, tip: 134, y: (o) => 120 + 37 * ((o - 10) / 136), cy: 104, cdy: 34 },
  uav: { root: 22, tip: 140, y: () => 118, cy: 150, cdy: 30 },
  heli: { root: 32, tip: 88, y: () => 111, cy: 142, cdy: 22 },
};
function placeStores(stores, kind) {
  const A = AIRFRAME_ST[kind] || AIRFRAME_ST.plane;
  const xs = stores.map((s) => s.ux).filter((x) => x >= 0);
  const useUi = xs.length === stores.length && stores.length > 1 && Math.max(...xs) - Math.min(...xs) > 0.01;
  const L = [], R = [], C = [];
  if (useUi) {
    const lo = Math.min(...xs), hi = Math.max(...xs), mid = (lo + hi) / 2, half = (hi - lo) / 2;
    stores.forEach((s, i) => {
      const r = (s.ux - mid) / half; // -1 … 1, left of centre is the left wing
      (Math.abs(r) < 0.08 ? C : (r < 0 ? L : R)).push({ i, d: Math.abs(r) });
    });
  } else {
    // no layout info: the first half on the left wing, the rest mirrored on the right
    const n = stores.length, odd = n % 2, half = Math.floor(n / 2);
    stores.forEach((s, i) => {
      if (odd && i === n - 1) C.push({ i, d: 0 });
      else if (i < half) L.push({ i, d: half - i });
      else R.push({ i, d: i - half + 1 });
    });
  }
  const pos = [];
  const spread = (list, sign) => {
    list.sort((a, b) => a.d - b.d);
    const n = list.length;
    list.forEach((e, j) => {
      const o = n === 1 ? (A.root + A.tip) / 2 : A.root + (A.tip - A.root) * j / (n - 1);
      pos[e.i] = [160 + sign * o, A.y(o)];
    });
    return n;
  };
  const nMax = Math.max(spread(L, -1), spread(R, 1));
  C.forEach((e, j) => { pos[e.i] = [160, A.cy + j * A.cdy]; });
  // shrink the glyphs when stations sit close together
  const gap = nMax > 1 ? (A.tip - A.root) / (nMax - 1) : 99;
  return { pos, k: gap < 16 ? 0.7 : (gap < 22 ? 0.85 : 1) };
}
// Fixed guns drawn on the airframe: where each sits by who works it.
function airGuns(d) {
  // fixed guns only: a gun pod hangs on a pylon and is drawn there (once)
  const ws = mergeShared((d.weaponsFull || []).filter((w) => GUN_TAGS.includes(w.tag) && !isPylonFed(d, w)));
  const out = [];
  let door = 0, nose = 0;
  for (const w of ws) {
    const tp = w.turret || [];
    const seat = (d.seats || []).find((s) => samePath(s.turret, tp));
    const isDoor = d.kind === 'heli' && !(tp.length === 1 && (tp[0] === -1 || tp[0] === 0));
    if (isDoor || (seat && /door|crew chief|side/i.test(seat.gunnerName || ''))) {
      const left = door % 2 === 0;
      out.push({ w, x: left ? 130 : 190, y: 86 + Math.floor(door / 2) * 20, r: left ? -90 : 90 });
      door++;
    } else {
      const y = d.kind === 'heli' ? 27 : (d.kind === 'uav' ? 30 : 14);
      out.push({ w, x: 160 + (nose === 0 ? 0 : (nose % 2 ? -14 : 14) * Math.ceil(nose / 2)), y, r: 0 });
      nose++;
    }
  }
  return out;
}
function airframe(kind) {
  if (kind === 'heli') {
    return `<circle cx="160" cy="96" r="90" class="ac-rotor"/>`
      + `<rect x="66" y="105" width="188" height="12" rx="5" class="ac-wing"/>`
      + `<rect x="155" y="160" width="10" height="68" rx="4" class="ac-body"/>`
      + `<rect x="150" y="214" width="34" height="5" rx="2" class="ac-wing"/>`
      + `<rect x="138" y="36" width="44" height="132" rx="20" class="ac-body"/>`
      + `<ellipse cx="160" cy="58" rx="13" ry="16" class="ac-glass"/>`
      + `<path d="M160 96 L92 40 M160 96 L228 152 M160 96 L228 40 M160 96 L92 152" class="ac-blade"/>`
      + `<circle cx="160" cy="96" r="6" class="ac-hub"/>`;
  }
  if (kind === 'uav') {
    return `<path d="M152 104 L10 112 V124 L152 124 z" class="ac-wing"/><path d="M168 104 L310 112 V124 L168 124 z" class="ac-wing"/>`
      + `<path d="M154 196 L118 228 L124 232 L158 206 z" class="ac-wing"/><path d="M166 196 L202 228 L196 232 L162 206 z" class="ac-wing"/>`
      + `<path d="M160 22 C168 26 170 40 170 56 V206 a10 10 0 0 1-20 0 V56 C150 40 152 26 160 22 z" class="ac-body"/>`
      + `<path d="M150 220 h20" class="ac-blade"/>`;
  }
  return `<path d="M150 96 L14 150 V164 L150 144 z" class="ac-wing"/><path d="M170 96 L306 150 V164 L170 144 z" class="ac-wing"/>`
    + `<path d="M152 196 L106 222 V230 L152 218 z" class="ac-wing"/><path d="M168 196 L214 222 V230 L168 218 z" class="ac-wing"/>`
    + `<path d="M160 8 C170 22 172 40 172 58 V214 a12 12 0 0 1-24 0 V58 C148 40 150 22 160 8 z" class="ac-body"/>`
    + `<ellipse cx="160" cy="50" rx="6" ry="16" class="ac-glass"/>`;
}
function loadoutBoard(d) {
  const stores = pylonStores(d);
  const guns = airGuns(d);
  if (!stores.length && !guns.length) return '';
  const { pos, k } = placeStores(stores, d.kind);
  const hps = stores.map((s, i) => storeGlyph(s.type, pos[i][0], pos[i][1], s.name, s.state, k, s)).join('')
    + guns.map((g) => gunGlyph(g.w.tag, g.x, g.y, g.r, g.w.name, g.w.ammo)).join('');
  const svg = `<svg class="loadout-svg" viewBox="0 0 320 240" role="img" aria-label="${esc(t('d.stores'))}">${airframe(d.kind)}${hps}</svg>`;
  // legend: one row per store kind carried, and one per gun
  // Legend: one row per store carried. The number is rounds (bombs, missiles…) left against what
  // the racks hold, summed over that store's pylons; the pylon count is said apart, since one
  // rack can carry several. Older mods only name the stores, so their rows count pylons.
  const groups = new Map();
  for (const s of stores) {
    const key = s.name + '|' + s.type;
    const g = groups.get(key) || { name: s.name, type: s.type, pylons: 0, ammo: 0, max: 0, known: s.max != null };
    g.pylons++;
    if (s.max != null) { g.ammo += Math.max(0, s.ammo); g.max += s.max; }
    groups.set(key, g);
  }
  const legend = [...groups.values()].map((g) => {
    const sw = g.type === 'empty' ? '<i class="lg-sw lg-empty"></i>' : `<i class="lg-sw" style="background:${STORE_COL[g.type]}"></i>`;
    const val = g.type === 'empty' ? countChip(g.pylons, 'empty')
      : (g.known ? `<span class="cnt cnt-${g.ammo > 0 ? 'ok' : 'empty'}" dir="ltr">${g.ammo}<small>/${g.max}</small></span>` : countChip(g.pylons, 'n'));
    const pyl = g.type === 'empty' ? '' : `<span class="lg-p">${esc(t(g.pylons === 1 ? 'd.on_pylon' : 'd.on_pylons', { n: g.pylons }))}</span>`;
    return `<div class="lg-row">${sw}<span class="lg-n"><bdi>${esc(g.name || t('store.empty'))}</bdi></span>${val}${pyl}`
      + (g.type === 'empty' ? '' : `<span class="lg-t">${esc(t('store.' + g.type))}</span>`) + `</div>`;
  }).join('') + guns.map((g) => `<div class="lg-row"><span class="lg-ic">${dIcon(weaponGlyph(d, g.w, ''), 16)}</span><span class="lg-n"><bdi>${esc(g.w.name)}</bdi></span>`
    + `<span class="qty">${g.w.ammo}</span><span class="lg-t">${esc(mountOf(d, g.w))}</span></div>`).join('');
  const loaded = stores.filter((s) => s.state === 'ok' || s.state === 'part' || s.state === 'unknown').length;
  return `<div class="loadout"><div class="loadout-head"><span>${esc(t(stores.length ? 'd.stores' : 'd.mounts'))}</span>`
    + `<span class="loadout-n">${stores.length ? esc(t('d.hardpoints', { n: loaded })) : ''}</span></div>${svg}`
    + `<div class="lg">${legend}</div>`
    + (d.pylonsFull || !stores.length ? '' : `<div class="d-note-line">${esc(t('d.pylons_old'))}</div>`) + '</div>';
}

// opt.board / opt.turret: false leaves out the aircraft loadout diagram / the turret dial
// (a workspace panel may show those on their own).
function vehWeaponParts(d) {
  const all = vehWeapons(d);
  const main = mergeShared(all.filter((w) => !UTILITY_TAGS.includes(w.tag)));
  const util = all.filter((w) => UTILITY_TAGS.includes(w.tag) && w.tag !== 'horn');
  const out = { board: isAir(d.kind) ? loadoutBoard(d) : '', turret: turretCard(d, liveOf(d)), guns: '', util: '' };
  out.guns = `<div class="d-sec">${t('d.guns')}${main.length ? ` <span class="sec-n">${main.length}</span>` : ''}</div>`
    + (main.length ? `<div class="wcards">${main.map((w) => weaponCard(d, w)).join('')}</div>` : `<div class="d-empty">${t('d.none.weapons')}</div>`);
  // the laser marker is always listed for aircraft, so "not fitted" is said rather than implied
  const utilRows = util.map((w) => utilRow(d, w));
  if (!util.some((w) => w.tag === 'laser') && isAir(d.kind) && d.weaponsFull) utilRows.push(laserRow(t('las.name'), 'none'));
  if (utilRows.length) out.util = `<div class="d-sec">${t('d.utility')}</div><div class="rows">${utilRows.join('')}</div>`;
  if (!d.weaponsFull && all.length) out.util += `<div class="d-note-line">${esc(t('d.weapons_old'))}</div>`;
  return out;
}
function renderWeapons(d, opt = {}) {
  if (d.kind === 'man') return renderManWeapons(d);
  const p = vehWeaponParts(d);
  return (opt.board !== false ? p.board : '') + (opt.turret !== false ? p.turret : '') + p.guns + p.util;
}

// ============================================================ damage (vehicles)
// Component groups per kind. Each hit point is matched by its name (HitLAileron → wingL …);
// several hit points on one group show the worst. A group with no matching hit point is N/A.
// Everything here is shown as remaining integrity: 100% intact … 0% destroyed (1 − damage).
const DMG_GROUPS = {
  air: [
    ['fuselage', /hull|body|fuselage|structur/, 'plane'],
    ['wingL', /^l.*(wing|aileron|flap)|left.*(wing|aileron)|wingl/, null],
    ['wingR', /^r.*(wing|aileron|flap)|right.*(wing|aileron)|wingr/, null],
    ['rear', /rear|aft|fuselage2|hull2/, null],
    ['tail', /rudder|elevator|stabil|vtail|htail|^tail$|tailfin/, null],
    ['engine', /engine|motor|turbine/, 'engine'],
  ],
  heli: [
    ['fuselage', /hull|body|fuselage|structur/, 'heli'],
    ['rotorMain', /hrotor|mainrotor|^rotor/, null],
    ['rotorTail', /vrotor|tailrotor/, null],
    ['tailboom', /tailboom|^tail$/, null],
    ['engine', /engine|motor|turbine/, 'engine'],
    ['transmission', /transmission|gearbox/, null],
  ],
  armor: [
    ['hull', /hull|body|structur/, 'tank'],
    ['engine', /engine|motor/, 'engine'],
    ['turret', /turret/, 'turret'],
    ['gun', /gun|barrel|cannon/, 'cannon'],
    ['trackL', /^ltrack|lefttrack|trackl/, null],
    ['trackR', /^rtrack|righttrack|trackr/, null],
    ['wheels', /wheel/, null],
  ],
  car: [
    ['hull', /hull|body|structur/, 'car'],
    ['engine', /engine|motor/, 'engine'],
    ['wheels', /wheel/, null],
    ['turret', /turret/, 'turret'],
    ['gun', /gun|barrel/, 'mg'],
  ],
};
// Non-structural systems, shown as status icons apart from the silhouette.
const SYS_GROUPS = [
  ['fuel', /fuel/, 'fuel'],
  ['glass', /glass|window|canopy/, 'glass'],
  ['lights', /light|lamp/, 'light'],
  ['electric', /avionics|wiring|electr|battery|wire/, 'wiring'],
];
function dmgGroupSet(kind) {
  if (kind === 'plane' || kind === 'uav') return DMG_GROUPS.air;
  if (kind === 'heli') return DMG_GROUPS.heli;
  if (isArmor(kind)) return DMG_GROUPS.armor;
  return DMG_GROUPS.car;
}
// -> { vals: {group: damage|null}, known: bool (true when every hit point is reported), list }
function groupDamage(d, groups) {
  const known = Array.isArray(d.hitAll);
  const list = known ? d.hitAll : (d.hit || []);
  const vals = {};
  for (const [g, re] of groups) {
    let v = null;
    for (const p of list) {
      const l = String(p.label).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (re.test(l)) v = Math.max(v ?? 0, p.dmg);
    }
    vals[g] = v;
  }
  return { vals, known, list };
}
// Fixed-wing damage figure, top view, nose up, drawn for region-level colouring: five separate
// regions with gaps between them (fuselage with the nose and cockpit, the two wings, the tail
// group with both stabilisers and the fin, and the engine bay with its exhaust).
const PLANE_DMG = {
  fuselage: '<path d="M60 6 C66 12 69 22 69 34 V118 H51 V34 C51 22 54 12 60 6 Z"/>',
  wingL: '<path d="M49 66 L8 100 V110 L49 98 Z"/>',
  wingR: '<path d="M71 66 L112 100 V110 L71 98 Z"/>',
  engine: '<path d="M51 121 H69 V142 L65 147 H55 L51 142 Z"/>',
  tail: '<path d="M53 150 H67 V170 L62 176 H58 L53 170 Z M53 154 L24 166 V172 L53 166 Z M67 154 L96 166 V172 L67 166 Z"/>',
};
function vehicleFigure(kind, z) {
  const F = (zone) => `fill="${woundFill(z[zone])}" stroke="#0c0f12" stroke-width="1.4"`;
  const open = `<svg class="veh" viewBox="0 0 120 180" width="150" height="225" aria-hidden="true">${HATCH_DEF}`;
  if (isArmor(kind)) {
    return open
      + `<rect x="14" y="34" width="18" height="116" rx="5" ${F(z.trackL == null && z.wheels != null ? 'wheels' : 'trackL')}/>`
      + `<rect x="88" y="34" width="18" height="116" rx="5" ${F(z.trackR == null && z.wheels != null ? 'wheels' : 'trackR')}/>`
      + `<rect x="34" y="40" width="52" height="104" rx="6" ${F('hull')}/>`
      + `<rect x="40" y="112" width="40" height="30" rx="4" ${F('engine')}/>`
      + `<rect x="55" y="8" width="10" height="66" rx="3" ${F('gun')}/>`
      + `<circle cx="60" cy="80" r="24" ${F('turret')}/>`
      + `</svg>`;
  }
  if (kind === 'heli') {
    return open
      + `<circle cx="60" cy="66" r="50" fill="none" stroke="${woundFill(z.rotorMain) === 'url(#hatch)' ? '#4a545e' : woundFill(z.rotorMain)}" stroke-width="5" stroke-dasharray="6 5"/>`
      + `<rect x="56" y="112" width="8" height="48" rx="3" ${F('tailboom')}/>`
      + `<circle cx="60" cy="162" r="11" ${F('rotorTail')}/>`
      + `<rect x="44" y="34" width="32" height="84" rx="14" ${F('fuselage')}/>`
      + `<rect x="48" y="80" width="24" height="26" rx="5" ${F('engine')}/>`
      + `<circle cx="60" cy="66" r="8" ${F('rotorMain')}/>`
      + `</svg>`;
  }
  if (kind === 'plane' || kind === 'uav') {
    return open
      + ['wingL', 'wingR', 'tail', 'engine', 'fuselage'].map((zn) => `<g class="pz" data-zone="${zn}" ${F(zn)}>${PLANE_DMG[zn]}</g>`).join('')
      + `<path d="M60 16 c3 3 4 8 4 13 h-8 c0-5 1-10 4-13 z" class="pz-glass"/>`
      + `<text x="6" y="124" class="body-side">${esc(t('body.l'))}</text><text x="114" y="124" class="body-side">${esc(t('body.r'))}</text>`
      + `</svg>`;
  }
  return open
    + `<rect x="18" y="42" width="16" height="22" rx="4" ${F('wheels')}/>`
    + `<rect x="86" y="42" width="16" height="22" rx="4" ${F('wheels')}/>`
    + `<rect x="18" y="108" width="16" height="22" rx="4" ${F('wheels')}/>`
    + `<rect x="86" y="108" width="16" height="22" rx="4" ${F('wheels')}/>`
    + `<rect x="34" y="20" width="52" height="128" rx="12" ${F('hull')}/>`
    + `<rect x="42" y="20" width="36" height="26" rx="6" ${F('engine')}/>`
    + (z.turret != null ? `<circle cx="60" cy="88" r="14" ${F('turret')}/>` : '')
    + `</svg>`;
}
// The damage tab in parts, so the workspace can place each part on its own.
function vehDamageParts(d) {
  let groups = dmgGroupSet(d.kind);
  let G = groupDamage(d, groups);
  // tracks and wheels are alternatives: show the running gear this vehicle actually has
  if (G.vals.trackL != null || G.vals.trackR != null) groups = groups.filter(([g]) => g !== 'wheels');
  else if (G.vals.wheels != null) groups = groups.filter(([g]) => g !== 'trackL' && g !== 'trackR');
  if (groups.length !== dmgGroupSet(d.kind).length) G = groupDamage(d, groups);
  const fig = vehicleFigure(d.kind, { ...G.vals });
  // structural integrity dials, in the order of the group list; parts not reported are N/A
  const dials = groups.map(([g, , icon]) => healthDial(t('dmg.' + g), G.vals[g], icon)).join('');
  // systems: fuel / glass / lights / electrical, each its own status icon with its integrity
  const sys = SYS_GROUPS.map(([g, re, icon]) => {
    let v = null;
    for (const p of G.list) { const l = String(p.label).toLowerCase().replace(/[^a-z0-9]/g, ''); if (re.test(l)) v = Math.max(v ?? 0, p.dmg); }
    const sev = sevClass(v);
    const h = healthOf(v);
    const txt = v == null ? t('state.na') : (sev === 'ok' ? t('state.normal') : (sev === 'warn' ? t('state.damaged') : t('state.critical')));
    return `<div class="sys sys-${sev}" title="${esc(t('sys.' + g))}: ${esc(txt)}"><span class="sys-ic">${dIcon(icon, 22)}</span>`
      + `<span class="sys-l">${esc(t('sys.' + g))}</span><span class="sys-v">${h == null ? '—' : Math.round(h * 100) + '%'}</span>`
      + (h == null ? '' : `<span class="sys-bar"><span style="width:${Math.round(h * 100)}%"></span></span>`)
      + `<span class="sys-s">${esc(txt)}</span></div>`;
  }).join('');
  const fuel = d.fuel >= 0
    ? gCard(ringGauge('fuel', d.fuel, d.fuel > 0.3 ? '' : (d.fuel > 0.1 ? 'warn' : 'bad'), ['E', 'F'], t('d.fuel')), t('d.fuel_qty'), '', 'g-mini')
    : '';
  const hp = gCard(ringGauge('heart', d.hp, hpClass(d.hp), null, t('d.health')), t('d.integrity'), '', 'g-mini');
  return {
    fig, hp, fuel, legend: damageLegend(),
    struct: `<div class="d-sec">${t('dmg.structure')} <span class="sec-hint">${esc(t('dmg.scale'))}</span></div><div class="dd-grid">${dials}</div>`,
    sys: `<div class="d-sec">${t('dmg.systems')}</div><div class="sys-grid">${sys}</div>`,
    note: G.known ? '' : `<div class="d-note-line">${esc(t('dmg.old'))}</div>`,
  };
}
function renderVehicleDamage(d) {
  const p = vehDamageParts(d);
  return `<div class="dmg-top"><div class="body-fig">${p.fig}</div><div class="dmg-side">${p.hp}${p.fuel}</div></div>`
    + p.legend + p.struct + p.sys + p.note;
}

// ============================================================ crew (top-down seat map)
// Seats come from the mod (every seat, empty ones too) or, for older versions, only the
// occupied positions. Each seat is classified, then laid out by vehicle kind.
function seatList(d) {
  if (Array.isArray(d.seats)) return { seats: d.seats.map((s) => ({ ...s, occupied: !!s.id })), full: true };
  return { seats: (d.crew || []).map((c) => ({ role: c.role, id: c.id, name: c.name, player: c.player, hp: c.hp, turret: null, ffv: false, pos: '', gunnerName: '', occupied: true, personal: null })), full: false };
}
function seatClass(d, s) {
  const pos = (s.pos || '').toLowerCase(), gn = (s.gunnerName || '').toLowerCase();
  if (s.role === 'driver') return isAir(d.kind) ? 'pilot' : 'driver';
  if (/co-?pilot/.test(pos) || /co-?pilot/.test(gn)) return 'copilot';
  if (s.role === 'commander' || /commander/.test(gn)) return 'commander';
  if (s.role === 'gunner') return 'gunner';
  if (s.role === 'turret' && !s.ffv) return /door|crew chief|side/.test(gn) ? 'door' : 'gunner';
  return 'cargo';
}
// Role glyphs on the seat map and in the station panels (shared icons, no letters).
const SEAT_ICON = { pilot: 's_pilot', copilot: 's_pilot', driver: 's_driver', gunner: 's_gunner', door: 's_gunner', commander: 's_cmdr', cargo: 's_pass' };
// Lay seats out as slots {x, y, s} on a 200-wide canvas; returns { slots, h }.
// Every vehicle class has its own arrangement; nothing is shared between them.
function seatLayout(d, seats) {
  const by = (c) => seats.filter((s) => s.cls === c);
  const P = by('pilot').concat(by('driver')), CP = by('copilot'), GU = by('gunner'), CO = by('commander'), DO = by('door'), CA = by('cargo');
  const slots = [];
  const put = (s, x, y) => s && slots.push({ x, y, s });
  const cargoGrid = (list, y0, cols, x0 = 100, dx = 34, dy = 34) => {
    list.forEach((s, i) => {
      const r = Math.floor(i / cols), c = i % cols, n = Math.min(cols, list.length - r * cols);
      put(s, x0 + (c - (n - 1) / 2) * dx, y0 + r * dy);
    });
    return y0 + Math.ceil(list.length / cols) * dy;
  };
  let h = 200;
  const k = d.kind;
  if (k === 'heli') {
    const tandem = !CA.length && !DO.length && P.length + CP.length + GU.length <= 2;
    if (tandem) { put(CP[0] || GU[0], 100, 52); put(P[0], 100, 92); h = 230; }
    else {
      put(P[0], 118, 50); put(CP[0], 82, 50);
      // door gunners at the cabin doors, then the passenger rows behind them
      const rest = GU.concat(DO);
      rest.forEach((s, i) => put(s, i % 2 ? 146 : 54, 94 + Math.floor(i / 2) * 36));
      h = cargoGrid(CA, 94 + Math.ceil(rest.length / 2) * 36, 3, 100, 38, 38) + 70;
    }
  } else if (k === 'plane' || k === 'uav') {
    put(P[0], 100, 40); put(CP[0] || GU[0], 100, 76);
    const rest = (CP.length ? GU : GU.slice(1)).concat(DO);
    rest.forEach((s, i) => put(s, i % 2 ? 150 : 50, 112 + Math.floor(i / 2) * 32));
    h = cargoGrid(CA, 112 + Math.ceil(rest.length / 2) * 32, 4, 100, 34, 34) + 50;
  } else if (k === 'apc') {
    // APC: driver centred at the front, the two-man turret behind, the troop compartment at the
    // rear with two benches facing each other along the sides
    put(P[0], 100, 40);
    put(GU[0], 78, 90); put(CO[0], 122, 90);
    const extra = GU.slice(1).concat(CO.slice(1), DO);
    extra.forEach((s, i) => put(s, 100 + (i % 2 ? 30 : -30), 128 + Math.floor(i / 2) * 32));
    const y0 = Math.max(140, 128 + Math.ceil(extra.length / 2) * 32);
    CA.forEach((s, i) => put(s, i % 2 ? 132 : 68, y0 + Math.floor(i / 2) * 34));
    h = y0 + Math.ceil(CA.length / 2) * 34 + 26;
  } else if (isArmor(k)) {
    // tank / AA: driver centred in the front hull, gunner and commander in the turret
    put(P[0], 100, 40);
    put(GU[0], 78, 92); put(CO[0], 122, 92);
    GU.slice(1).concat(CO.slice(1), DO).forEach((s, i) => put(s, 100 + (i % 2 ? 26 : -26), 128 + Math.floor(i / 2) * 32));
    const extra = GU.length - 1 + CO.length - 1 + DO.length;
    const y0 = Math.max(144, 128 + Math.ceil(Math.max(0, extra) / 2) * 32); // behind the turret
    CA.forEach((s, i) => put(s, i % 2 ? 128 : 72, y0 + Math.floor(i / 2) * 34));
    h = y0 + Math.ceil(CA.length / 2) * 34 + 30;
  } else if (k === 'ship') {
    GU.concat(CO, DO).forEach((s, i) => put(s, 100 + (i % 2 ? 26 : -26) * (i ? 1 : 0), 46 + Math.floor((i + 1) / 2) * 32));
    const y0 = 46 + Math.ceil((GU.length + CO.length + DO.length) / 2) * 32 + 10;
    const yE = cargoGrid(CA, y0, 2, 100, 40, 34);
    put(P[0], 100, yE + 8);
    h = yE + 50;
  } else if (k === 'static') {
    put(GU[0] || P[0] || CO[0], 100, 100); h = 200;
  } else { // car / unknown wheeled
    put(P[0], 78, 56);
    const front = CA.shift();
    put(front, 122, 56);
    GU.concat(CO, DO).forEach((s, i) => put(s, 100 + (i ? (i % 2 ? 30 : -30) : 0), 100 + Math.floor((i + 1) / 2) * 30));
    const y0 = 100 + Math.ceil((GU.length + CO.length + DO.length) / 2) * 32 + (GU.length + CO.length + DO.length ? 4 : 0);
    h = cargoGrid(CA, Math.max(100, y0), 3, 100, 36, 36) + 36;
  }
  return { slots, h: Math.max(h, 180) };
}
// Outline of the vehicle, nose up, stretched to the seat map's height.
function crewHull(kind, h) {
  const b = h - 14;
  if (kind === 'heli') {
    const cab = Math.max(140, b - 60);
    return `<circle cx="100" cy="${cab / 2 + 10}" r="${Math.min(96, cab / 2 + 30)}" class="cr-rotor"/>`
      + `<rect x="54" y="14" width="92" height="${cab}" rx="36" class="cr-hull"/>`
      + `<rect x="94" y="${cab + 10}" width="12" height="${b - cab - 6}" rx="5" class="cr-hull"/>`;
  }
  if (kind === 'plane' || kind === 'uav') {
    return `<path d="M100 8 C116 20 120 34 120 48 V${b - 20} a20 20 0 0 1-40 0 V48 C80 34 84 20 100 8 z" class="cr-hull"/>`
      + `<path d="M80 ${Math.min(130, b * 0.45)} L6 ${Math.min(160, b * 0.55)} V${Math.min(172, b * 0.6)} L80 ${Math.min(156, b * 0.55)} z M120 ${Math.min(130, b * 0.45)} L194 ${Math.min(160, b * 0.55)} V${Math.min(172, b * 0.6)} L120 ${Math.min(156, b * 0.55)} z" class="cr-wing"/>`;
  }
  if (kind === 'apc') {
    const wheels = [0.18, 0.4, 0.62, 0.84].map((f) => `<rect x="34" y="${(14 + f * (b - 30)).toFixed(0)}" width="12" height="22" rx="4" class="cr-wing"/><rect x="154" y="${(14 + f * (b - 30)).toFixed(0)}" width="12" height="22" rx="4" class="cr-wing"/>`).join('');
    return wheels + `<path d="M46 30 L60 12 H140 L154 30 V${b} H46 Z" class="cr-hull"/>`
      + `<circle cx="100" cy="90" r="30" class="cr-turret"/><rect x="96" y="40" width="8" height="26" rx="3" class="cr-turret"/>`
      + `<path d="M58 ${b - 4} h84" class="cr-ramp"/>`;
  }
  if (isArmor(kind)) {
    return `<rect x="30" y="14" width="18" height="${b - 8}" rx="6" class="cr-wing"/><rect x="152" y="14" width="18" height="${b - 8}" rx="6" class="cr-wing"/>`
      + `<rect x="48" y="18" width="104" height="${b - 16}" rx="8" class="cr-hull"/>`
      + `<circle cx="100" cy="92" r="34" class="cr-turret"/><rect x="96" y="4" width="8" height="56" rx="3" class="cr-turret"/>`;
  }
  if (kind === 'ship') return `<path d="M100 8 C134 34 142 70 142 110 V${b} H58 V110 C58 70 66 34 100 8 z" class="cr-hull"/>`;
  if (kind === 'static') return `<circle cx="100" cy="100" r="44" class="cr-hull"/><rect x="96" y="20" width="8" height="70" rx="3" class="cr-turret"/>`;
  return `<rect x="52" y="20" width="96" height="${b - 10}" rx="26" class="cr-hull"/><path d="M60 40 Q100 30 140 40 L136 70 Q100 62 64 70 z" class="cr-glass"/>`;
}
// A crew member's health as the seat map and the crew cards show it: the game's life state first
// (dead and incapacitated are said in words, whatever the number), then the health figure on the
// map's scale (0..1: 1 - damage, or the ACE blood volume when lower). No figure = unknown, never 0.
function crewHealth(s) {
  if (!s.occupied) return null;
  const life = String(s.life || '').toUpperCase();
  const pct = s.hp != null && s.hp >= 0 ? Math.round(s.hp * 100) : null;
  if (life.startsWith('DEAD')) return { tone: 'dead', key: 'dead', icon: 'h_dead', pct };
  if (life === 'INCAPACITATED') return { tone: 'bad', key: 'down', icon: 'h_down', pct };
  if (pct == null) return { tone: 'unk', key: 'unknown', icon: 'misc', pct };
  if (s.hp > 0.6) return { tone: 'ok', key: 'ok', icon: 'heart', pct };
  if (s.hp > 0.3) return { tone: 'warn', key: 'injured', icon: 'heart', pct };
  return { tone: 'bad', key: 'critical', icon: 'heart', pct };
}
const seatTone = (s) => (!s.occupied ? 'vac' : crewHealth(s).tone);
// The crew member card: a large role icon, the name, the role, and the health right beside them
// (status word, percentage and bar, so it never rests on colour alone).
function crewRole(s) { return s.gunnerName && s.cls !== 'pilot' && s.cls !== 'driver' ? s.gunnerName : t('crew.' + s.cls); }
function crewMember(d, s, me) {
  const H = crewHealth(s);
  const mine = s.id && s.id === me;
  return `<div class="cm cm-${H.tone}${mine ? ' cm-me' : ''}">`
    + `<span class="cm-ic">${dIcon(SEAT_ICON[s.cls] || 'man', 30)}</span>`
    + `<span class="cm-t"><span class="cm-n"><bdi>${esc(s.name || '?')}</bdi>${s.player ? `<span class="cm-pl" title="${esc(t('crew.player'))}">●</span>` : ''}${mine ? `<span class="cm-you">${esc(t('crew.you'))}</span>` : ''}</span>`
    + `<span class="cm-r">${esc(crewRole(s))}</span></span>`
    + `<span class="cm-h"><span class="cm-hs">${dIcon(H.icon, 14)}${esc(t('hs.' + H.key))}</span><b dir="ltr">${H.pct == null ? '—' : H.pct + '%'}</b></span>`
    + `<span class="cm-bar"><span style="width:${H.pct == null ? 0 : H.pct}%"></span></span></div>`;
}
// One seat: a box in the health colour with the role glyph inside; vacant seats are a dashed outline.
function seatGlyph(x, y, s, me) {
  const occ = s.occupied, mine = occ && s.id === me;
  const name = occ ? (s.name || '?') : t('crew.vacant');
  // names under the crew seats only: passenger rows sit too close, and the list below names them
  const short = occ && s.cls !== 'cargo' ? (s.name || '?').split(/\s+/).pop().slice(0, 7) : '';
  const ic = DICON[SEAT_ICON[s.cls]] || DICON.man;
  const H = crewHealth(s);
  return `<g class="seat seat-${seatTone(s)}${mine ? ' seat-me' : ''}${s.ffv ? ' seat-ffv' : ''}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">`
    + `<title>${esc(t('crew.' + s.cls))}: ${esc(name)}${s.player ? ' (' + t('crew.player') + ')' : ''}${H ? ' — ' + t('hs.' + H.key) + (H.pct != null ? ' ' + H.pct + '%' : '') : ''}</title>`
    + `<rect x="-15" y="-14" width="30" height="29" rx="7" class="seat-box"/>`
    + `<svg x="-11" y="-12.5" width="22" height="22" viewBox="0 0 24 24" class="seat-ic" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ic}</svg>`
    // health bar along the bottom of the box: the length is the occupant's health
    + (occ ? `<rect x="-11" y="10" width="22" height="2.6" rx="1.3" class="seat-hpbg"/>${H && H.pct != null ? `<rect x="-11" y="10" width="${(22 * H.pct / 100).toFixed(1)}" height="2.6" rx="1.3" class="seat-hp"/>` : ''}` : '')
    + (s.ffv ? `<circle cx="13" cy="-12" r="3.4" class="seat-ffv-dot"/>` : '')
    + (short ? `<text x="0" y="26" class="seat-name">${esc(short)}</text>` : '')
    + `</g>`;
}
// ---- crew station panels (gunner, commander, door gunner): who sits there, their health, the
// vehicle weapons that station works, and — kept apart — the person's own weapons.
function personalRows(s) {
  if (!s.occupied) return '';
  if (s.personal == null) return `<div class="st-note">${esc(t('st.pw_old'))}</div>`;
  if (!s.personal.length) return `<div class="st-note">${esc(t('st.pw_none'))}</div>`;
  const use = s.ffvMode == null ? '' : (s.ffvMode === 1 ? 'yes' : (s.ffvMode === 2 ? (s.turnedOut ? 'yes' : 'out') : 'no'));
  return s.personal.map((p) => `<div class="st-row st-pw"><span class="d-ic">${dIcon(p.kind === 'pistol' ? 'pistol' : (p.kind === 'launcher' ? 'launcher' : weaponIcon(p.name)), 18)}</span>`
    + `<span class="d-n"><bdi>${esc(p.name)}</bdi></span><span class="st-amm" dir="ltr"><b>${p.ammo}</b><small>${esc(t('d.rnd'))}</small>${p.mags ? ` <small>+${t('d.mags', { n: p.mags })}</small>` : ''}</span></div>`).join('')
    + (use ? `<div class="st-use st-use-${use}">${esc(t('st.use_' + use))}</div>` : '');
}
function stationPanel(d, s, L) {
  const ws = (d.weaponsFull || []).filter((w) => samePath(w.turret, s.turret) && !['horn'].includes(w.tag));
  const head = s.occupied ? crewMember(d, s, meId())
    : `<div class="st-head"><span class="st-ic st-vac">${dIcon(SEAT_ICON[s.cls], 20)}</span><span class="st-role">${esc(s.gunnerName || t('crew.' + s.cls))}</span><span class="st-who">${esc(t('crew.vacant'))}</span></div>`;
  // where this station's gun or sight points
  let dir = '';
  const isMain = samePath(s.turret, [0]), isCmd = samePath(s.turret, [0, 0]);
  const az = isMain ? L.tur0 : (isCmd ? L.tur1 : (() => { const e = (d.turrets || []).find((x) => samePath(x.path, s.turret)); return e && e.ok ? e.az : null; })());
  if (s.turret && (isMain || isCmd || (d.turrets || []).some((x) => samePath(x.path, s.turret)))) {
    dir = `<div class="st-row"><span class="d-ic">${dIcon(turretIcon(d.kind), 18)}</span><span class="d-n">${esc(t(isCmd ? 'tur.cmd' : 'tur.gun'))}</span>`
      + (az == null ? `<span class="st-na">${esc(t('tur.na_short'))}</span>` : `<span class="st-amm" dir="ltr"><b>${fmtDeg(az)}</b> <small>${cardinal(az)} · ${esc(t('tur.rel'))} ${fmtDeg(az - L.dir)}</small></span>`) + `</div>`;
  }
  const mounted = ws.length
    ? ws.map((w) => `<div class="st-row"><span class="d-ic">${dIcon(weaponGlyph(d, w, armorRole(d, w)), 18)}</span><span class="d-n"><bdi>${esc(w.name)}</bdi></span>`
      + (w.tag === 'laser' ? `<span class="las-chip las-${laserState(d, w.laser < 0 ? null : w.laser)}"><i></i>${esc(t('las.' + laserState(d, w.laser < 0 ? null : w.laser)))}</span>`
        : `<span class="st-amm" dir="ltr"><b>${w.ammo}</b>${w.cap > 0 ? `<small>/ ${w.cap}</small>` : ''}</span>`) + `</div>`).join('')
    : `<div class="st-note">${esc(t('st.no_mounted'))}</div>`;
  return `<div class="st st-${s.cls}">${head}${dir}`
    + `<div class="st-sub">${esc(t('st.mounted'))}</div>${mounted}`
    + `<div class="st-sub">${esc(t('st.personal'))}</div>${personalRows(s)}</div>`;
}
function crewParts(d) {
  const { seats, full } = seatList(d);
  if (d.kind === 'uav') {
    const ops = seats.filter((s) => s.occupied);
    return { map: `<div class="crew-uav">${dIcon('uav', 64)}<div><b>${t('crew.uav')}</b><div class="d-note-line">${t('crew.uav_note')}</div></div></div>`
      + (ops.length ? `<div class="rows">${ops.map((s) => invRow('link', s.name || '—', '', t('crew.' + seatClass(d, s)))).join('')}</div>` : ''), stations: '', list: '' };
  }
  if (!seats.length) return { map: `<div class="d-empty">${t('d.none.crew')}</div>`, stations: '', list: '' };
  const cls = seats.map((s) => ({ ...s, cls: seatClass(d, s) }));
  const { slots, h } = seatLayout(d, cls);
  const me = meId();
  const seatSvg = slots.map(({ x, y, s }) => seatGlyph(x, y, s, me)).join('');
  const svg = `<svg class="crew-svg" viewBox="0 0 200 ${h}" role="img" aria-label="${esc(t('d.tab.crew'))}">${crewHull(d.kind, h)}${seatSvg}</svg>`;
  const occ = cls.filter((s) => s.occupied).length;
  const present = [...new Set(cls.map((s) => s.cls))];
  const legend = `<div class="wound-legend crew-legend">`
    + present.map((c) => `<span class="cl-role">${dIcon(SEAT_ICON[c], 14)}${esc(t('crew.' + c))}</span>`).join('')
    + `<span><i class="cl-ok"></i>${t('hs.ok')}</span><span><i class="cl-warn"></i>${t('hs.injured')}</span><span><i class="cl-bad"></i>${t('hs.critical')}</span>`
    + `<span><i class="cl-vac"></i>${t('crew.vacant')}</span><span><i class="cl-me"></i>${t('crew.you')}</span>`
    + (cls.some((s) => s.ffv) ? `<span><i class="cl-ffv"></i>${t('crew.ffv')}</span>` : '')
    + (full ? '' : `<span><i class="cl-unk"></i>${t('crew.unknown')}</span>`) + `</div>`;
  // station panels for the weapon positions, then everyone else as a list
  const L = liveOf(d);
  const stations = full && d.weaponsFull ? cls.filter((s) => ['gunner', 'commander', 'door'].includes(s.cls)) : [];
  stations.sort((a, b) => ['gunner', 'commander', 'door'].indexOf(a.cls) - ['gunner', 'commander', 'door'].indexOf(b.cls));
  const stHtml = stations.length ? `<div class="d-sec">${t('st.title')}</div><div class="st-grid">${stations.map((s) => stationPanel(d, s, L)).join('')}</div>` : '';
  const others = cls.filter((s) => s.occupied && !stations.includes(s));
  const ord = ['pilot', 'copilot', 'driver', 'commander', 'gunner', 'door', 'cargo'];
  others.sort((a, b) => ord.indexOf(a.cls) - ord.indexOf(b.cls));
  const rows = others.map((s) => crewMember(d, s, me)).join('');
  const aceSrc = cls.some((s) => s.hpSrc === 'ace');
  return {
    map: `<div class="crew-head"><span>${t('crew.occ', { n: occ, m: full ? cls.length : '?' })}</span></div>`
      + `<div class="crew-wrap">${svg}</div>` + legend,
    stations: stHtml,
    list: (rows ? `<div class="d-sec">${t(stations.length ? 'crew.others' : 'crew.members')}</div><div class="cm-grid">${rows}</div>` : '')
      + (aceSrc ? `<div class="d-note-line">${esc(t('hs.src_ace'))}</div>` : '')
      + (full ? '' : `<div class="d-note-line">${esc(t('crew.old'))}</div>`),
  };
}
function renderCrew(d) {
  const p = crewParts(d);
  return p.map + p.stations + p.list;
}

// ============================================================ infantry kit cards
// Large, icon-first cards shared by a soldier's Weapons and Inventory tabs. One card component
// (itemCard) and one icon set (KIT_ART); the two tabs only choose which cards to show.
// Icons: 48x48 (items) or 96x48 (long guns), drawn in currentColor; ".f" parts are a tinted fill.
const KIT_ART = {
  rifle: [96, '<path class="f" d="M6 18h16v10L8 32a3 3 0 0 1-3-3z"/><path class="f" d="M22 16h40v12H22z"/><path class="f" d="M62 18h18v8H62z"/><path d="M80 22h13"/><path class="f" d="M45 28q1 8-2 14h7q3-6 2-14z"/><path class="f" d="M33 28l-3 10h6l3-10"/><path d="M36 12h16v4H36z"/><path d="M27 22h9"/>'],
  mg: [96, '<path class="f" d="M4 17h16v11L7 31a3 3 0 0 1-3-3z"/><path class="f" d="M20 15h44v13H20z"/><path d="M64 21h29" stroke-width="3"/><path d="M44 11h11v4"/><path class="f" d="M38 28h14v11H38z"/><path class="f" d="M28 28l-3 9h6l3-9"/><path d="M72 22l-6 17M74 22l6 17"/><path d="M86 18v3"/>'],
  launcher: [96, '<rect class="f" x="8" y="18" width="68" height="11" rx="3"/><path class="f" d="M76 15l13 3.5v10L76 32z"/><path class="f" d="M40 29l-2 9h6l2-9"/><path d="M28 13h9v5M52 29l-1 6h5"/><path d="M12 18v11M70 18v11"/>'],
  pistol: [48, '<path class="f" d="M5 13h35v8H5z"/><path class="f" d="M9 21h19l-2 4h-4l-3 15h-9l3-15z"/><path d="M22 25q0 6-5 6"/><path d="M40 16h3"/>'],
  binocular: [48, '<rect class="f" x="5" y="16" width="15" height="22" rx="5"/><rect class="f" x="28" y="16" width="15" height="22" rx="5"/><path d="M20 22h8M20 30h8"/><path d="M9 16v-5h7v5M32 16v-5h7v5"/>'],
  designator: [48, '<rect class="f" x="4" y="14" width="26" height="20" rx="3"/><circle cx="30" cy="24" r="6" class="f"/><path d="M36 24h9" stroke-dasharray="2 2"/><path d="M8 34v6h8v-6"/><path d="M10 20h10"/>'],
  mag: [48, '<path class="f" d="M17 8h14l1 12q1 12-3 22H17q3-10 1-22z"/><path d="M20 8q4-5 8 0"/><path d="M19 16h12M19.5 23h12M19 30h11"/><path d="M15 42h16"/>'],
  pmag: [48, '<path class="f" d="M19 9h10v31a2 2 0 0 1-2 2h-6a2 2 0 0 1-2-2z"/><path d="M21 9q3-4 6 0"/><path d="M22 16v18"/><path d="M17 42h14"/>'],
  belt: [48, '<path class="f" d="M5 20h28v20H5z"/><path d="M5 20l4-6h20l4 6"/><path d="M15 14v-3h8v3"/><path d="M33 26c6 0 9 3 9 9"/><path d="M35 23l3-3M38 26l3-3M41 30l3-3"/><path d="M10 28h18"/>'],
  glround: [48, '<path class="f" d="M16 22h16v20H16z"/><path class="f" d="M16 22q8-16 16 0"/><path d="M16 30h16M14 42h20"/>'],
  rocket: [48, '<path class="f" d="M24 4q9 8 9 21v11H15V25q0-13 9-21z"/><path d="M15 36l-5 8h8M33 36l5 8h-8"/><path d="M15 24h18"/>'],
  grenade: [48, '<circle class="f" cx="24" cy="30" r="12"/><path d="M19 15h10v4H19z"/><path d="M29 16q8 2 6 14"/><circle cx="14" cy="13" r="4"/><path d="M13 30h22M24 18v24M16 23l16 14M32 23L16 37" stroke-width="1.2"/>'],
  smoke: [48, '<rect class="f" x="15" y="17" width="18" height="25" rx="3"/><path d="M17 17v-4h14v4"/><path d="M31 14q5 1 4 12"/><path d="M15 27h18"/><path d="M10 11a4 4 0 0 1 7-3 4 4 0 0 1 7 0"/>'],
  chemlight: [48, '<rect class="f" x="20" y="9" width="8" height="31" rx="4"/><path d="M20 35h8"/><circle cx="24" cy="6" r="2"/><path d="M11 13l4 3M37 13l-4 3M9 25h6M33 25h6M11 37l4-3M37 37l-4-3"/>'],
  explosive: [48, '<rect class="f" x="5" y="20" width="38" height="17" rx="2"/><rect x="17" y="13" width="12" height="7"/><path d="M29 16q8-9 13-1"/><path d="M10 27h14M10 31h9"/>'],
  mine: [48, '<ellipse class="f" cx="24" cy="32" rx="19" ry="7"/><path d="M9 32v-4a15 5 0 0 1 30 0v4"/><ellipse cx="24" cy="25" rx="6" ry="2"/><path d="M24 23v-6"/>'],
  firstaid: [48, '<rect class="f" x="7" y="12" width="34" height="27" rx="5"/><path d="M7 20h34"/><path d="M24 23v12M18 29h12" stroke-width="3"/>'],
  medikit: [48, '<rect class="f" x="5" y="15" width="38" height="26" rx="3"/><path d="M18 15v-4h12v4"/><path d="M24 21v14M17 28h14" stroke-width="3"/>'],
  bandage: [48, '<circle class="f" cx="19" cy="24" r="12"/><circle cx="19" cy="24" r="4"/><path d="M31 24h12v8H27"/>'],
  syringe: [48, '<path class="f" d="M13 33l17-17 5 5-17 17z"/><path d="M13 33l-6 6M30 16l6-6M33 7l8 8M18 28l3 3M22 24l3 3"/>'],
  ivbag: [48, '<path class="f" d="M13 5h22v25q0 7-11 7T13 30z"/><path d="M24 37v8M17 13h14"/><path d="M19 5V2h10v3"/>'],
  tourniquet: [48, '<rect class="f" x="5" y="19" width="38" height="10" rx="5"/><path d="M24 10v28" stroke-width="3"/><path d="M14 24h4M30 24h4"/>'],
  toolkit: [48, '<rect class="f" x="5" y="20" width="38" height="20" rx="2"/><path d="M5 27h38"/><path d="M16 20v-5h16v5"/><path d="M21 31v4M27 31v4"/>'],
  radio: [48, '<rect class="f" x="14" y="15" width="19" height="28" rx="3"/><path d="M29 15V3"/><path d="M18 21h11M18 25h11M18 29h11"/><circle cx="23.5" cy="37" r="2"/><path d="M18 15v-3"/>'],
  gps: [48, '<rect class="f" x="12" y="5" width="24" height="38" rx="4"/><rect x="16" y="10" width="16" height="15"/><path d="M24 13v9M19.5 17.5h9"/><circle cx="19" cy="32" r="1.5"/><circle cx="29" cy="32" r="1.5"/><path d="M20 38h8"/>'],
  terminal: [48, '<rect class="f" x="5" y="12" width="34" height="26" rx="3"/><rect x="9" y="16" width="26" height="18"/><path d="M39 18l5-12"/><path d="M14 29l6-6 4 4 7-8"/>'],
  map: [48, '<path class="f" d="M5 12l13-4 12 4 13-4v28l-13 4-12-4-13 4z"/><path d="M18 8v28M30 12v28"/><path d="M9 30q6-10 12-4t14-10" stroke-dasharray="2 2"/>'],
  compass: [48, '<circle class="f" cx="24" cy="24" r="17"/><path d="M24 11l4 13h-8z" fill="currentColor"/><path d="M24 37l4-13h-8z"/><path d="M24 4v3M24 41v3M4 24h3M41 24h3"/>'],
  watch: [48, '<rect x="17" y="3" width="14" height="9" rx="2"/><rect x="17" y="36" width="14" height="9" rx="2"/><circle class="f" cx="24" cy="24" r="12"/><path d="M24 17v7l5 3"/>'],
  nvg: [48, '<path d="M18 7h12v8H18z"/><rect class="f" x="6" y="15" width="15" height="20" rx="5"/><rect class="f" x="27" y="15" width="15" height="20" rx="5"/><circle cx="13.5" cy="35" r="4"/><circle cx="34.5" cy="35" r="4"/><path d="M21 22h6"/>'],
  optic: [48, '<path class="f" d="M4 20h6l4-4h20l4 4h6v8h-6l-4 4H14l-4-4H4z"/><path d="M20 16v-4h8v4"/><path d="M10 34h28" stroke-width="1.2"/>'],
  muzzle: [48, '<rect class="f" x="4" y="18" width="36" height="12" rx="6"/><path d="M40 24h5"/><path d="M14 18v12M22 18v12M30 18v12" stroke-width="1.2"/>'],
  pointer: [48, '<rect class="f" x="8" y="17" width="24" height="12" rx="2"/><path d="M32 23h12" stroke-dasharray="2 2"/><path d="M12 29v4h16v-4"/><circle cx="28" cy="23" r="2"/>'],
  bipod: [48, '<rect class="f" x="10" y="8" width="28" height="7" rx="2"/><path d="M20 15l-9 28M28 15l9 28" stroke-width="3"/>'],
  uniform: [48, '<path class="f" d="M16 5l8 5 8-5 10 7-5 9-3-2v24H14V19l-3 2-5-9z"/><path d="M24 10v33"/><path d="M17 22h4M27 22h4"/>'],
  vest: [48, '<path class="f" d="M15 4l9 6 9-6 5 7v31H10V11z"/><path d="M10 27h28"/><rect x="13" y="29" width="7" height="8"/><rect x="28" y="29" width="7" height="8"/><path d="M24 10v15"/>'],
  backpack: [48, '<rect class="f" x="10" y="11" width="28" height="33" rx="7"/><path d="M17 11V8a7 7 0 0 1 14 0v3"/><rect x="15" y="27" width="18" height="11" rx="2"/><path d="M15 20h18"/>'],
  headgear: [48, '<path class="f" d="M7 30a17 17 0 0 1 34 0v3H7z"/><path d="M4 33h41v4H4z"/><path d="M24 13v6"/>'],
  goggles: [48, '<rect class="f" x="5" y="17" width="16" height="14" rx="6"/><rect class="f" x="27" y="17" width="16" height="14" rx="6"/><path d="M21 24h6M5 24H2M43 24h3"/>'],
  misc: [48, '<path class="f" d="M7 15l17-8 17 8v18l-17 8-17-8z"/><path d="M7 15l17 8 17-8M24 23v18"/>'],
};
function kitArt(name, cls = '') {
  const a = KIT_ART[name] || KIT_ART.misc;
  const w = a[0] === 96;
  return `<svg class="ic-svg ${w ? 'ic-svg-w' : ''} ${cls}" viewBox="0 0 ${a[0]} 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${a[1]}</svg>`;
}
// The shared card. q: the big number (null = none), unit: what it counts, sub: secondary line,
// state: '' | ok | low | bad | empty | equipped | current, badge: a short status word,
// meter: 0..1 shown as a bar (container load), wide: a long gun spans two columns.
function itemCard(o) {
  const st = o.state || '';
  return `<div class="ic ${st ? 'ic-' + st : ''}${o.wide ? ' ic-wide' : ''}"${o.title ? ` title="${esc(o.title)}"` : ''}>`
    + `<div class="ic-art">${kitArt(o.art)}</div>`
    + (o.badge ? `<span class="ic-badge">${esc(o.badge)}</span>` : '')
    + (o.q != null ? `<div class="ic-q" dir="ltr"><b>${o.q}</b>${o.of != null ? `<small>/ ${o.of}</small>` : ''}${o.unit ? `<small>${esc(o.unit)}</small>` : ''}</div>` : '')
    + `<div class="ic-n"><bdi>${esc(o.name)}</bdi></div>`
    + (o.sub ? `<div class="ic-s"><bdi>${o.subHtml ? o.sub : esc(o.sub)}</bdi></div>` : '')
    + (o.meter != null ? `<div class="ic-m"><span style="width:${Math.round(clamp01(o.meter) * 100)}%"></span></div>` : '')
    + `</div>`;
}
const cardGrid = (cards) => `<div class="icards">${cards.join('')}</div>`;
function kitSec(key, n, cards) {
  if (!cards.length) return '';
  return `<div class="d-sec">${t(key)}${n != null ? ` <span class="sec-n">${n}</span>` : ''}</div>` + cardGrid(cards);
}

// ---- what an inventory entry is, for its icon and its section. The mod's hint (from the game's
// own config: which "weapon" takes a magazine, an item's slot) decides first; the display name
// refines it (a thrown magazine can be a frag, a smoke or a chemlight).
function kitKind(name, hint) {
  const s = String(name).toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));
  if (hint === 'throw') return has('smoke') ? 'smoke' : (has('chemlight', 'chem light', 'ir grenade', 'ir strobe', 'strobe', 'light stick') ? 'chemlight' : 'grenade');
  if (hint === 'put') return has('mine', 'claymore', 'apers', 'slam', 'tripwire', 'bounding', 'm6 ', 'at mine', 'pressure') ? 'mine' : 'explosive';
  if (hint === 'launcher') return 'rocket';
  if (['map', 'gps', 'radio', 'compass', 'watch', 'nvg', 'optic', 'muzzle', 'pointer', 'bipod', 'headgear', 'goggles'].includes(hint)) return hint;
  if (hint === 'mag') {
    if (has('40 mm', '40mm', '3gl', 'ugl', '1rnd he', 'grenade round', 'flare round', 'smoke round', 'he grenade', 'shell')) return 'glround';
    if (has('belt', 'box', 'drum', '100rnd', '100 rnd', '150rnd', '150 rnd', '200rnd', '200 rnd')) return 'belt';
    if (has('9 mm', '9mm', '.45', '45 acp', 'pistol', '.50 ae', '5.7')) return 'pmag';
    return 'mag';
  }
  // items without a hint (older mods, or a slot the mod does not tag): by name
  if (has('bandage', 'dressing', 'gauze', 'packing')) return 'bandage';
  if (has('morphine', 'epinephrine', 'adenosine', 'atropine', 'syringe', 'autoinjector', 'injector', 'naloxone')) return 'syringe';
  if (has('blood', 'plasma', 'saline', 'iv bag')) return 'ivbag';
  if (has('tourniquet')) return 'tourniquet';
  if (has('medikit', 'medkit', 'medical kit', 'surgical', 'personal aid')) return 'medikit';
  if (has('first aid', 'firstaid', 'ifak', 'splint')) return 'firstaid';
  if (has('toolkit', 'tool kit', 'repair kit', 'defusal', 'wire cutter', 'entrenching')) return 'toolkit';
  if (has('uav terminal', 'terminal', 'tablet')) return 'terminal';
  const c = classifyItem(name);
  if (c === 'mag') return has('belt', 'box') ? 'belt' : 'mag';
  if (c === 'grenade') return 'grenade';
  if (c === 'mine') return has('mine', 'claymore') ? 'mine' : 'explosive';
  return { smoke: 'smoke', flare: 'chemlight', rocket: 'rocket', optic: 'optic', nvg: 'nvg', medical: 'firstaid', tool: 'toolkit', radio: 'radio', gps: 'gps', binocular: 'binocular', fuelcan: 'misc' }[c] || 'misc';
}
const KIT_SECTION = {
  mag: 'ammo', pmag: 'ammo', belt: 'ammo', glround: 'ammo', rocket: 'ammo',
  grenade: 'throw', smoke: 'throw', chemlight: 'throw',
  explosive: 'explosives', mine: 'explosives',
  firstaid: 'medical', medikit: 'medical', bandage: 'medical', syringe: 'medical', ivbag: 'medical', tourniquet: 'medical',
  map: 'equipment', gps: 'equipment', radio: 'equipment', compass: 'equipment', watch: 'equipment', nvg: 'equipment', terminal: 'equipment', binocular: 'equipment',
  optic: 'attach', muzzle: 'attach', pointer: 'attach', bipod: 'attach',
  headgear: 'worn', goggles: 'worn',
  toolkit: 'tools', misc: 'tools',
};
const SLOT_ART = { primary: null, handgun: 'pistol', secondary: 'launcher', binocular: 'binocular' };

// One model for both tabs, from the itemised kit (newer mods) or, for older mods, from the
// grouped lists they send: { weapons, mags, items, worn, load, full }
function kitModel(d) {
  const k = d.kit;
  if (k) {
    const worn = (d.inv || []).find((s) => s.section === 'wear');
    return {
      full: true,
      weapons: k.weapons.map((w) => ({ ...w, art: w.slot === 'primary' ? (weaponIcon(w.name) === 'mg' ? 'mg' : 'rifle') : (w.slot === 'binocular' && /designator|laser/i.test(w.name) ? 'designator' : SLOT_ART[w.slot]) })),
      mags: k.mags.map((m) => ({ ...m, kind: kitKind(m.name, m.hint) })),
      items: k.items.map((i) => ({ ...i, kind: kitKind(i.name, i.hint) })),
      worn: worn ? worn.items : [],
      load: k.load,
    };
  }
  // older mod: weapons with the loaded rounds; magazines grouped with a "N rnd" note; items by name
  const sec = (key) => ((d.inv || []).find((s) => s.section === key) || {}).items || [];
  const weapons = (d.weapons || []).map((w) => {
    const ic = weaponIcon(w.name);
    const slot = ic === 'pistol' ? 'handgun' : (ic === 'launcher' ? 'secondary' : (ic === 'laser' ? 'binocular' : 'primary'));
    return { slot, name: w.name, loaded: w.ammo, cap: 0, spare: null, spareRounds: null, current: false, loadedMag: '',
      art: slot === 'primary' ? (ic === 'mg' ? 'mg' : 'rifle') : (slot === 'binocular' ? (/designator/i.test(w.name) ? 'designator' : 'binocular') : SLOT_ART[slot]) };
  });
  const mags = sec('mags').map((m) => {
    const c = classifyItem(m.name);
    const hint = ['grenade', 'smoke', 'flare'].includes(c) ? 'throw' : (c === 'mine' ? 'put' : (c === 'rocket' ? 'launcher' : 'mag'));
    const r = /(\d+)\s*rnd/i.exec(m.note || '');
    return { name: m.name, spare: m.count, spareRounds: r ? +r[1] : null, cap: 0, hint, loaded: 0, kind: kitKind(m.name, hint), total: true };
  });
  const items = sec('items').map((i) => ({ name: i.name, count: i.count, hint: '', equipped: null, kind: kitKind(i.name, '') }));
  return { full: false, weapons, mags, items, worn: sec('wear'), load: null };
}

// ---- cards
function weaponKitCard(d, w) {
  if (w.slot === 'binocular') {
    // a designator reports whether it is lasing; binoculars are just equipment
    if (w.art === 'designator') {
      const ls = laserState(d, d.laser == null ? null : d.laser);
      return itemCard({ art: 'designator', name: w.name, state: ls === 'on' ? 'current' : '', badge: t('las.' + ls), sub: t('las.name') });
    }
    return itemCard({ art: 'binocular', name: w.name, state: w.current ? 'current' : '', badge: w.current ? t('kit.in_hand') : '' });
  }
  const has = w.loaded != null && w.loaded >= 0;
  const f = has && w.cap > 0 ? w.loaded / w.cap : null;
  const state = has && w.loaded === 0 && !(w.spare > 0) ? 'empty' : (w.current ? 'current' : '');
  const spare = w.spare == null ? '' : (w.spare > 0 ? t('kit.spare', { n: w.spare, r: w.spareRounds }) : t('kit.no_spare'));
  const sub = [w.loadedMag, spare].filter(Boolean).join(' · ');
  return itemCard({
    art: w.art, name: w.name, wide: w.art === 'rifle' || w.art === 'mg' || w.art === 'launcher',
    q: has ? w.loaded : '—', of: has && w.cap > 0 ? w.cap : null, unit: t('kit.rnd_loaded'),
    sub, state, badge: state === 'empty' ? t('ws.empty') : (w.current ? t('kit.in_hand') : ''),
    meter: f,
  });
}
function magKitCard(m) {
  // throwables count every one carried (the one "in hand" is still in the kit); magazines count
  // the spares, with any of that type sitting in a weapon said apart
  const thrown = m.hint === 'throw' || m.hint === 'put';
  const n = thrown ? m.spare + (m.loaded || 0) : m.spare;
  const cls = thrown ? (throwClass(n) === null ? 'empty' : (throwClass(n) === 'bad' ? 'low' : 'ok')) : ({ empty: 'empty', bad: 'low', warn: 'low', '': 'ok' }[magClass(n)]);
  const parts = [];
  if (!thrown && m.spareRounds != null && n > 0) parts.push(t('kit.rounds_total', { n: m.spareRounds }));
  if (!thrown && m.loaded > 0) parts.push(t('kit.in_weapon', { n: m.loaded }));
  return itemCard({ art: m.kind, name: m.name, q: n, unit: thrown ? '' : t('kit.mags_unit'), sub: parts.join(' · '), state: n > 0 ? cls : 'empty',
    badge: n > 0 ? '' : (m.loaded > 0 ? t('kit.only_loaded') : t('ws.empty')), title: m.cap > 0 ? t('kit.cap', { n: m.cap }) : '' });
}
function itemKitCard(i) {
  return itemCard({ art: i.kind, name: i.name, q: i.count > 1 ? i.count : null, unit: '', state: i.equipped ? 'equipped' : '',
    badge: i.equipped ? t('kit.equipped') : '' });
}
const WORN_ART = { uniform: 'uniform', vest: 'vest', backpack: 'backpack' };
function wornCards(K) {
  return K.worn.map((it) => {
    const key = it.note || 'uniform';
    const ld = K.load ? K.load[key] : null;
    return itemCard({ art: WORN_ART[key] || 'misc', name: it.name, sub: tOr('wear.' + key, key) + (ld != null && ld >= 0 ? ' · ' + t('kit.load', { n: Math.round(ld * 100) }) : ''),
      meter: ld != null && ld >= 0 ? ld : null, state: 'equipped', badge: t('kit.worn') });
  });
}
function bySection(list, sec) { return list.filter((x) => KIT_SECTION[x.kind] === sec); }

// Weapons tab: the guns (rounds loaded, spare magazines), their ammunition, throwables, explosives.
function renderManWeapons(d) {
  const K = kitModel(d);
  const guns = K.weapons.filter((w) => w.slot !== 'binocular');
  const opt = K.weapons.filter((w) => w.slot === 'binocular');
  let h = guns.length ? kitSec('d.guns', null, guns.map((w) => weaponKitCard(d, w))) : `<div class="d-empty">${t('d.none.weapons')}</div>`;
  if (opt.length) h += kitSec('d.utility', null, opt.map((w) => weaponKitCard(d, w)));
  const ammo = bySection(K.mags, 'ammo'), thr = bySection(K.mags, 'throw'), exp = bySection(K.mags, 'explosives');
  h += kitSec('d.magazines', ammo.reduce((a, m) => a + m.spare, 0), ammo.map(magKitCard));
  h += kitSec('d.throwables', thr.reduce((a, m) => a + m.spare + (m.loaded || 0), 0), thr.map(magKitCard));
  h += kitSec('inv.explosives', exp.reduce((a, m) => a + m.spare + (m.loaded || 0), 0), exp.map(magKitCard));
  if (!K.full) h += `<div class="d-note-line">${esc(t('kit.old'))}</div>`;
  return h;
}
// Inventory tab: everything carried and worn, by purpose, with the containers' load.
// A soldier's inventory by section (keys: load, weapons, magazines, throwables, explosives,
// medical, equipment, attach, tools, worn, note); empty sections are ''.
function manInvParts(d) {
  const K = kitModel(d);
  const p = { empty: !K.weapons.length && !K.mags.length && !K.items.length && !K.worn.length, load: '' };
  if (K.load && K.load.total >= 0) {
    p.load = `<div class="kit-load">${dIcon('backpack', 16)}<span>${esc(t('kit.load_total'))}</span>${meter(Math.min(1, K.load.total), K.load.total > 0.9 ? 'bad' : (K.load.total > 0.7 ? 'warn' : ''))}<b dir="ltr">${Math.round(K.load.total * 100)}%</b></div>`;
  }
  const ammo = bySection(K.mags, 'ammo'), thr = bySection(K.mags, 'throw'), exp = bySection(K.mags, 'explosives');
  const sum = (l) => l.reduce((a, i) => a + (i.count || 1), 0);
  p.weapons = kitSec('inv.weapons', K.weapons.length, K.weapons.map((w) => itemCard({ art: w.art, name: w.name, wide: false, state: w.current ? 'current' : 'equipped', badge: w.current ? t('kit.in_hand') : t('kit.equipped') })));
  p.magazines = kitSec('inv.magazines', ammo.reduce((a, m) => a + m.spare, 0), ammo.map(magKitCard));
  p.throwables = kitSec('inv.throwables', thr.reduce((a, m) => a + m.spare + (m.loaded || 0), 0), thr.map(magKitCard));
  p.explosives = kitSec('inv.explosives', exp.reduce((a, m) => a + m.spare + (m.loaded || 0), 0), exp.map(magKitCard));
  for (const sec of ['medical', 'equipment', 'attach', 'tools']) {
    const l = bySection(K.items, sec);
    p[sec] = kitSec('inv.' + sec, sum(l), l.map(itemKitCard));
  }
  const worn = wornCards(K).concat(bySection(K.items, 'worn').map(itemKitCard));
  p.worn = kitSec('inv.worn', null, worn);
  p.note = K.full ? '' : `<div class="d-note-line">${esc(t('kit.old'))}</div>`;
  return p;
}
const MAN_INV_KEYS = ['load', 'weapons', 'magazines', 'throwables', 'explosives', 'medical', 'equipment', 'attach', 'tools', 'worn', 'note'];
function renderManInv(d) {
  const p = manInvParts(d);
  if (p.empty) return `<div class="d-empty">${t('d.none.inv')}</div>`;
  return MAN_INV_KEYS.map((k) => p[k]).join('') || `<div class="d-empty">${t('d.none.inv')}</div>`;
}

// ============================================================ inventory / cargo
// Vehicle cargo regrouped into categories with their own icons; only categories present are shown.
const CARGO_CATS = [
  ['ammo', 'ammobox', (it, sec) => sec === 'cargo_mags' || ['mag', 'rocket', 'grenade', 'smoke', 'flare', 'mine'].includes(classifyItem(it.name))],
  ['weapons', 'weaponcrate', (it, sec) => sec === 'cargo_weapons'],
  ['medical', 'medical', (it) => classifyItem(it.name) === 'medical'],
  ['fuel', 'jerrycan', (it) => classifyItem(it.name) === 'fuelcan'],
  ['equipment', 'tool', (it) => ['optic', 'nvg', 'binocular', 'gps', 'radio', 'tool'].includes(classifyItem(it.name))],
  ['backpacks', 'backpack', (it, sec) => sec === 'cargo_backpacks'],
  ['supplies', 'crate', () => true],
];
function qty(n) { return `<span class="qty">×${n}</span>`; }
function renderCargo(d) {
  let h = '';
  // personnel from the seat list (passengers only; the crew has its own tab)
  const { seats, full } = seatList(d);
  if (full && seats.length) {
    const cargoSeats = seats.filter((s) => seatClass(d, s) === 'cargo');
    if (cargoSeats.length) {
      const n = cargoSeats.filter((s) => s.occupied).length;
      h += `<div class="d-sec">${t('cargo.personnel')}</div><div class="rows">`
        + invRow('personnel', t('cargo.passengers'), `<span class="qty">${n} / ${cargoSeats.length}</span>`) + '</div>';
    }
  }
  const buckets = new Map();
  for (const sec of d.inv || []) {
    for (const it of sec.items) {
      const cat = CARGO_CATS.find(([, , fn]) => fn(it, sec.section));
      (buckets.get(cat[0]) || buckets.set(cat[0], []).get(cat[0])).push(it);
    }
  }
  for (const [key, icon] of CARGO_CATS) {
    const list = buckets.get(key);
    if (!list || !list.length) continue;
    const total = list.reduce((a, it) => a + (it.count || 1), 0);
    h += `<div class="d-sec cargo-sec">${dIcon(icon, 14)}<span>${t('cargo.' + key)}</span><span class="sec-n">${total}</span></div><div class="rows">`
      + list.map((it) => invRow(key === 'ammo' ? classifyItem(it.name) : (key === 'weapons' ? weaponIcon(it.name) : icon), it.name, qty(it.count || 1))).join('') + '</div>';
  }
  return h || `<div class="d-empty">${t('d.none.inv')}</div>`;
}
function renderInv(d) {
  if (d.kind !== 'man') return renderCargo(d);
  return renderManInv(d);
}

function detailBody(d, tab) {
  const pend = S.run.pending;
  if (pend && pend.id === (DETAIL_ID || S.detailId)) {
    return `<div class="d-empty d-restart">${dIcon('misc', 28)}<b>${esc(t('run.restarted'))}</b>`
      + `<span>${esc(t(pend.failed ? (DETAIL_ID ? 'run.lost_win' : 'run.lost') : 'run.finding', { n: pend.label || '' }))}</span></div>`;
  }
  if (!d) return `<div class="d-empty">${t('d.loading')}</div>`;
  if (!d.found) return `<div class="d-empty">${t('d.gone')}</div>`;
  switch (tab) {
    case 'weapons': return renderWeapons(d);
    case 'damage': return renderVehicleDamage(d);
    case 'crew': return renderCrew(d);
    case 'cargo': case 'inv': return renderInv(d);
    case 'health': return renderHealth(d);
    default: return renderOverview(d);
  }
}

function renderDetailInto(box, id, mode, onlyTab) {
  const d = S.details[id];
  const tabs = d ? detailTabsFor(d) : [];
  let active = onlyTab || S.detailTab;
  if (d && !tabs.find((x) => x.key === active)) active = 'overview';
  // a man is titled by the soldier's name (the payload's name is his class, e.g. "Rifleman")
  const title = d ? ((d.kind === 'man' && personName(id)) || d.name || d.cls || id) : id;
  const sub = d ? esc(tOr('kind.' + d.kind, d.kind)) : '';
  const fullBtn = `<button class="icon-btn" data-dfull title="${esc(t('full.toggle'))}" aria-label="${esc(t('full.toggle'))}">${box.classList.contains('full') ? ICON_FULLX : ICON_FULL}</button>`;
  const headBtns = mode === 'panel'
    ? fullBtn + `<button class="icon-btn" data-dpop title="${esc(t('d.popout'))}" aria-label="${esc(t('d.popout'))}">${ICON_POP}</button>
       <button class="icon-btn" data-dclose title="${esc(t('d.close'))}" aria-label="${esc(t('d.close'))}">${ICON_X}</button>`
    : `<button class="icon-btn" data-dwinclose title="${esc(t('d.close'))}" aria-label="${esc(t('d.close'))}">${ICON_X}</button>`;
  const tabBar = (!onlyTab && tabs.length)
    ? `<div class="d-tabs">${tabs.map((tb) => `<button class="d-tab ${tb.key === active ? 'active' : ''}" data-dtab="${tb.key}">${esc(tb.label)}<span class="d-detach" data-ddetach="${tb.key}" title="${esc(t('d.detach'))}" aria-label="${esc(t('d.detach'))}">${ICON_DETACH}</span>${DETAIL_ID ? '' : `<span class="d-detach d-cust" data-dcust="${tb.key}" title="${esc(t('ws.act.cust_tab'))}" aria-label="${esc(t('ws.act.cust_tab'))}">${ICON_CUST}</span>`}</button>`).join('')}</div>`
    : '';
  const body = `<div class="d-wrap">${detailBody(d, onlyTab || active)}</div>`;
  const head = `<div class="d-head"><span class="side-chip" style="background:${d ? (SIDE_COLOR[d.side] || '#777') : '#777'}"></span>`
    + (d ? `<span class="d-kind">${kindIcon(d.kind, 18)}</span>` : '')
    + `<span class="d-title">${esc(title)}</span>${sub ? `<span class="d-sub">${sub}</span>` : ''}<span class="spacer"></span>${freshChip(id)}${headBtns}</div>`;
  // Nothing changed since the last render (same data, same tab): leave the DOM alone.
  const sig = head + tabBar + body;
  if (box._sig === sig && !box.hidden) return;
  box._sig = sig;
  // Keep the scroll positions across re-renders so neither the body (vertical) nor the
  // tab strip (horizontal) jumps back when the data updates.
  const prevBody = box.querySelector('.d-body');
  const prevTabs = box.querySelector('.d-tabs');
  const scrollY = prevBody ? prevBody.scrollTop : 0;
  const scrollX = prevTabs ? prevTabs.scrollLeft : 0;
  box.innerHTML = head + tabBar + `<div class="d-body">${body}</div>`
    + (mode === 'panel' ? '<div class="panel-resize" id="detail-resize" aria-hidden="true"></div>' : '');
  paintNeedles(box); // needles start where they are drawn now, never at a stale angle
  const nb = box.querySelector('.d-body');
  if (nb) nb.scrollTop = scrollY;
  const nt = box.querySelector('.d-tabs');
  if (nt) nt.scrollLeft = scrollX;
  box.hidden = false;
  const f = freshness(id);
  box.classList.toggle('d-stale', f.cls === 'stale' || f.cls === 'off');
}

function renderDetail() {
  if (DETAIL_ID) { renderDetailInto($('#detail'), DETAIL_ID, 'window', DETAIL_TAB); return; }
  const box = $('#detail');
  if (!S.detailId) { box.hidden = true; box._sig = null; return; }
  renderDetailInto(box, S.detailId, 'panel', null);
}

function openDetail(id) {
  if (!id) return;
  if (S.run.pending && id !== S.run.pending.id) S.run.pending = null; // picked again by hand
  if (id !== S.detailId) S.detailTab = 'overview';
  S.detailId = id;
  $('#info').hidden = true;
  if (window.matchMedia('(max-width: 760px)').matches) appEl.classList.add('panel-closed');
  renderDetail();
  updateViewShift();
  pushWatch();
  wsRenderAll();
}
function closeDetail() {
  S.detailId = null;
  const box = $('#detail');
  box.hidden = true;
  box._sig = null;
  box.classList.remove('full');
  renderInfo();
  updateViewShift();
  pushWatch();
  wsRenderAll();
}
// A detail payload arrived. Older than the one shown (out of order) → ignored.
function acceptDetail(d) {
  // a payload from another mission run (in flight across a restart) is never shown
  if (d.session && S.run.session && d.session !== S.run.session) { S.run.dropped++; return; }
  const prev = S.details[d.id];
  // mission time restarts at 0 with every run, so only payloads of one run are ordered by it
  if (prev && prev.found && (prev.session || '') === (d.session || '') && d.t < prev.t) return;
  S.details[d.id] = d;
  S.detailAt[d.id] = performance.now();
  noteRate(S.rate.detail, S.detailAt[d.id]);
  onDetail(d.id);
}
function onDetail(id) {
  if (DETAIL_ID) { if (id === DETAIL_ID) renderDetail(); return; }
  if (id === S.detailId) renderDetail();
  wsOnDetail(id);
}
function detailFollowSelection(sel) {
  if (DETAIL_ID || !S.detailId || !sel) return;
  if (sel.kind === 'unit' || sel.kind === 'veh' || sel.kind === 'empty') openDetail(sel.id);
}
function openDetailWindow(id, tab) {
  if (!id) return;
  const url = `${location.pathname}?detail=${encodeURIComponent(id)}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`;
  window.open(url, 'dideban-detail-' + String(id).replace(/\W/g, '_') + (tab ? '-' + tab : ''), 'width=430,height=640');
}

// ---- keep the screen awake (Screen Wake Lock API). Asked for only after the user ticks the box;
// the browser drops the lock whenever the page is hidden, so it is taken again when the page is
// visible and the option is still on. Where the API is missing (no https, old browser) the page
// says so instead of claiming the screen stays on.
var WAKE = { want: storeGet('wakeLock', false), lock: null, state: 'off', err: '' };
function wakeSupported() { return 'wakeLock' in navigator && typeof navigator.wakeLock.request === 'function'; }
async function wakeAcquire() {
  if (!WAKE.want || WAKE.lock || document.visibilityState !== 'visible') return;
  if (!window.isSecureContext) { WAKE.state = 'insecure'; return updateWakeUI(); }
  if (!wakeSupported()) { WAKE.state = 'unsupported'; return updateWakeUI(); }
  if (WAKE.pending) return;
  WAKE.pending = true; WAKE.state = 'pending'; updateWakeUI();
  try {
    const lock = await navigator.wakeLock.request('screen');
    WAKE.pending = false;
    if (!WAKE.want) { lock.release().catch(() => {}); WAKE.state = 'off'; return updateWakeUI(); }
    WAKE.lock = lock; WAKE.state = 'on';
    lock.addEventListener('release', () => {
      if (WAKE.lock === lock) WAKE.lock = null;
      WAKE.state = WAKE.want ? 'lost' : 'off';
      updateWakeUI();
    });
  } catch (e) {
    WAKE.pending = false; WAKE.state = 'denied'; WAKE.err = (e && (e.message || e.name)) || '';
  }
  updateWakeUI();
}
function wakeRelease() {
  const l = WAKE.lock; WAKE.lock = null;
  if (l) l.release().catch(() => {});
  WAKE.state = 'off'; updateWakeUI();
}
function updateWakeUI() {
  const chk = $('#chk-wake'), st = $('#wake-status');
  if (chk) chk.checked = WAKE.want;
  if (!st) return;
  const key = !WAKE.want ? 'off' : WAKE.state;
  st.textContent = key === 'denied' ? t('wake.denied', { e: WAKE.err }) : t('wake.' + (key === 'off' && WAKE.want ? 'pending' : key));
  st.classList.toggle('wake-on', key === 'on');
  st.classList.toggle('wake-warn', ['insecure', 'unsupported', 'denied', 'lost'].includes(key));
}
{
  const chk = $('#chk-wake');
  if (chk) chk.addEventListener('change', () => {
    WAKE.want = chk.checked; storeSet('wakeLock', WAKE.want);
    if (WAKE.want) wakeAcquire(); else wakeRelease();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakeAcquire(); });
  // a remembered "on" is retried on the first tap, since some browsers want a user gesture
  window.addEventListener('pointerdown', () => { if (WAKE.want && !WAKE.lock) wakeAcquire(); }, { passive: true });
  updateWakeUI();
  wakeAcquire();
}

// Tell the server which entities to collect deep info for (a heartbeat; the server drops ids
// whose window went away). Every open detail page keeps its own entity alive.
function detailWatchIds() {
  // a pending id is from the previous mission run: nothing to ask for it yet
  const own = S.run.pending ? [] : (DETAIL_ID ? [DETAIL_ID] : (S.detailId ? [S.detailId] : []));
  const ws = wsWatchIds(); // workspace panels (each entity once, however many panels show it)
  return ws.length ? [...new Set(own.concat(ws))] : own;
}
function pushWatch() { command({ action: 'detail_watch', ids: detailWatchIds(), session: S.run.session || undefined }).catch(() => {}); }
setInterval(pushWatch, 2000);

$('#detail').addEventListener('click', (e) => {
  if (e.target.closest('[data-dclose]')) return closeDetail();
  if (e.target.closest('[data-dwinclose]')) return window.close();
  if (e.target.closest('[data-dfull]')) { $('#detail').classList.toggle('full'); renderDetail(); updateViewShift(); return; }
  const cu = e.target.closest('[data-dcust]');
  if (cu) { e.stopPropagation(); wsCustomizeTab(cu.dataset.dcust); return; }
  const det = e.target.closest('[data-ddetach]');
  if (det) { e.stopPropagation(); openDetailWindow(DETAIL_ID || S.detailId, det.dataset.ddetach); return; }
  if (e.target.closest('[data-dpop]')) return openDetailWindow(S.detailId, null);
  const tb = e.target.closest('[data-dtab]');
  if (tb) { S.detailTab = tb.dataset.dtab; renderDetail(); }
});

// ---- resize the side panels by dragging their inline-end edge (desktop only).
// Widths are CSS variables so the phone layout (which overrides width) is unaffected.
function beginPanelDrag(el, varName, key, e, minW, maxW, isDetail) {
  if (!window.matchMedia('(min-width: 761px)').matches) return;
  e.preventDefault();
  const rtl = document.documentElement.dir === 'rtl';
  const startX = e.clientX, startW = el.getBoundingClientRect().width;
  document.body.style.cursor = 'ew-resize';
  const move = (ev) => {
    let w = startW + (rtl ? -1 : 1) * (ev.clientX - startX);
    w = Math.max(minW, Math.min(maxW, w));
    document.documentElement.style.setProperty(varName, w + 'px');
    if (isDetail) updateViewShift(); else resize();
  };
  const up = () => {
    document.body.style.cursor = '';
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    storeSet(key, Math.round(el.getBoundingClientRect().width));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
$('#panel-resize').addEventListener('pointerdown', (e) => beginPanelDrag($('#panel'), '--panel-w', 'panelW', e, 220, 560, false));
$('#detail').addEventListener('pointerdown', (e) => {
  if (e.target.closest('#detail-resize')) beginPanelDrag($('#detail'), '--detail-w', 'detailW', e, 280, 680, true);
});
(function () { // restore saved panel widths
  const pw = storeGet('panelW', null);
  if (pw) document.documentElement.style.setProperty('--panel-w', pw + 'px');
  const dw = storeGet('detailW', null);
  if (dw) document.documentElement.style.setProperty('--detail-w', dw + 'px');
})();

// ============================================================ marker dialog

const dlg = $('#dlg-marker');
let pendingPos = null;
let dialogMetaFilled = null;

function colorList() { return S.meta.colors.length ? S.meta.colors : FALLBACK_COLORS; }

function fillMarkerSelects() {
  if (dialogMetaFilled === S.meta) return;
  dialogMetaFilled = S.meta;
  const types = S.meta.types.length ? S.meta.types : COMMON_TYPES.map((cls) => ({ cls, name: cls, group: '' }));
  const byCls = new Map(types.map((t) => [t.cls, t]));
  const common = COMMON_TYPES.filter((c) => byCls.has(c));
  const groups = new Map();
  for (const t of types) {
    if (common.includes(t.cls)) continue;
    const g = t.group || 'Other';
    (groups.get(g) || groups.set(g, []).get(g)).push(t);
  }
  const opt = (t) => `<option value="${esc(t.cls)}">${esc(t.name || t.cls)}</option>`;
  $('#mk-type').innerHTML =
    `<optgroup label="${esc(t('dlg.common'))}">${common.map((c) => opt(byCls.get(c))).join('')}</optgroup>` +
    [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(opt).join('')}</optgroup>`).join('');
  $('#mk-color').innerHTML = colorList().map((c) => `<option value="${esc(c.cls)}">${esc(c.name || c.cls)}</option>`).join('');
  const last = storeGet('lastMarker', {});
  if (last.type && byCls.has(last.type)) $('#mk-type').value = last.type;
  if (last.color && colorList().some((c) => c.cls === last.color)) $('#mk-color').value = last.color;
  else if (colorList().some((c) => c.cls === 'ColorRed')) $('#mk-color').value = 'ColorRed';
  if (last.channel !== undefined) $('#mk-channel').value = String(last.channel);
}

function drawPreview() {
  const c = $('#mk-preview').getContext('2d');
  c.clearRect(0, 0, 56, 56);
  const col = colorList().find((x) => x.cls === $('#mk-color').value);
  c.save();
  c.translate(28, 28);
  drawMarkerIcon(c, $('#mk-type').value, 16, col ? rgba(col.rgba, 1) : '#000');
  c.restore();
}
$('#mk-type').addEventListener('change', drawPreview);
$('#mk-color').addEventListener('change', drawPreview);

// One dialog for all three: 'marker' (icon + text), 'text' (text only), 'line' (colour only).
let dialogMode = 'marker';
function openDrawDialog(mode, x, y) {
  const ws = worldSize();
  if (x < 0 || y < 0 || x > ws || y > ws) return;
  if (!S.status.connected) { toast(t('toast.not_connected')); return; }
  if (!onGameMap()) { toast(t('toast.not_game_map')); return; }
  dialogMode = mode;
  pendingPos = [x, y];
  fillMarkerSelects();
  $('#dlg-title').textContent = t(mode === 'line' ? 'dlg.title_line' : mode === 'text' ? 'dlg.title_text' : 'dlg.title');
  $('#mk-type-row').hidden = mode !== 'marker';
  $('#mk-text-field').hidden = mode === 'line';
  $('#mk-text').required = mode === 'text';
  $('#mk-grid').textContent = mode === 'line'
    ? t('tools.points', { n: S.linePts.length })
    : `GRID ${gridRef(x, y)}`;
  $('#mk-text').value = '';
  drawPreview();
  dlg.returnValue = '';
  dlg.showModal();
  if (mode !== 'line' && window.matchMedia('(pointer: fine)').matches) $('#mk-text').focus();
}
function openMarkerDialog(x, y) { openDrawDialog('marker', x, y); }

dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'ok' || !pendingPos) return;
  const color = $('#mk-color').value, channel = Number($('#mk-channel').value);
  let body;
  if (dialogMode === 'line') {
    body = { action: 'marker_line', points: S.linePts, color, channel };
  } else if (dialogMode === 'text') {
    body = { action: 'marker_text', x: pendingPos[0], y: pendingPos[1], text: $('#mk-text').value, color, channel };
  } else {
    body = { action: 'marker_create', x: pendingPos[0], y: pendingPos[1], type: $('#mk-type').value, text: $('#mk-text').value, color, channel };
  }
  const last = storeGet('lastMarker', {});
  storeSet('lastMarker', { type: body.type || last.type, color, channel });
  pendingPos = null;
  try {
    await command(body);
    toast(t('toast.marker_placed'));
    if (dialogMode === 'line') { S.linePts = []; updateLineBar(); redraw(); }
  } catch (e) { toast(t('toast.marker_failed', { error: e.message })); }
});

// ---- mission runs. Every netId and every mission time belongs to one run of the mission; a
// restart (the extension may stay connected through it) starts a new run. The server tags each
// run, and on a new one this page forgets every cached payload and live value, stops asking for
// the old ids, and finds the entity it was showing again in the new run (the player, the
// player's vehicle, or the one unit / vehicle that matches it). Nothing from the old run is shown
// as current. The lifecycle is logged (window.didebanLifecycle()) to check this in the field.
function runLog(ev, info = {}) {
  S.run.log.push({ at: new Date().toISOString(), ev, ...info });
  if (S.run.log.length > 60) S.run.log.shift();
}
window.didebanLifecycle = () => ({ session: S.run.session, dropped: S.run.dropped, pending: S.run.pending, log: S.run.log.slice() });
// session: the run the server reports now; force: treat as new even without a session change
function noteRun(session, src, force = false) {
  if (!session) return;
  if (S.run.session === session && !force) return;
  const first = S.run.session === null;
  const old = S.run.session;
  S.run.session = session;
  S.run.at = performance.now();
  runLog('run', { src, from: old, to: session });
  if (!first || force) missionReset(src);
}
function missionReset(src) {
  const id = DETAIL_ID || S.detailId;
  const d = id && S.details[id];
  if (id && !(S.run.pending && S.run.pending.id === id)) {
    // remember what the page showed, to find it again in the new run
    S.run.pending = {
      id, tries: 0, failed: false,
      me: id === S.run.me, meVeh: !!S.run.meVeh && id === S.run.meVeh,
      kind: d ? d.kind : '', cls: d ? d.cls : '', side: d ? d.side : '',
      person: d && d.kind === 'man' ? personName(id) : '',
      label: d ? (d.kind === 'man' ? personName(id) || d.name : d.name) || d.cls : '',
    };
  }
  for (const k of Object.keys(S.details)) delete S.details[k];
  for (const k of Object.keys(S.detailAt)) delete S.detailAt[k];
  for (const k of Object.keys(S.live)) delete S.live[k];
  S.rate.pos.length = 0; S.rate.detail.length = 0;
  AMMO_MAX.clear();
  NEEDLE.clear();
  // the map state still describes the old run until the new run's first state arrives
  S.run.oldState = true;
  runLog('reset', { src, showing: id || null, pending: !!S.run.pending });
  const box = $('#detail');
  if (box) box._sig = null;
  renderDetail();
  wsRenderAll(true);
  pushWatch();
}
// A state update after a reset: look for the entity the page showed.
function rebindTarget(P, st) {
  const units = st.units || [], vehs = (st.vehicles || []).concat(st.empty || []);
  if (P.me && st.me && st.me.id) return st.me.id;
  if (P.meVeh && st.me) {
    const u = units.find((x) => x.id === st.me.id);
    const v = u && u.veh && vehs.find((x) => x.id === u.veh);
    if (v && (!P.cls || v.cls === P.cls)) return v.id;
  }
  if (P.kind === 'man' && P.person) {
    const m = units.filter((u) => u.name === P.person && groupSide(u) === P.side);
    if (m.length === 1) return m[0].id;
  } else if (P.cls) {
    const m = vehs.filter((v) => v.cls === P.cls);
    if (m.length === 1) return m[0].id;
  }
  return null;
}
function runSawState(st) {
  S.run.oldState = false;
  if (st.me) {
    S.run.me = st.me.id;
    const u = (st.units || []).find((x) => x.id === st.me.id);
    S.run.meVeh = u && u.veh ? u.veh : null;
  }
  const P = S.run.pending;
  if (!P || P.failed) return;
  const nid = rebindTarget(P, st);
  if (nid) {
    S.run.pending = null;
    runLog('rebind', { from: P.id, to: nid });
    if (DETAIL_ID) {
      DETAIL_ID = nid;
      try {
        const u = new URL(location.href); u.searchParams.set('detail', nid);
        history.replaceState(null, '', u.toString());
      } catch (e) { /* the window keeps working on the new id either way */ }
    } else if (S.detailId === P.id) S.detailId = nid;
    pushWatch();
    renderDetail();
    wsRenderAll();
    return;
  }
  // three state updates (about three seconds) without a match: say so, keep nothing stale
  if (++P.tries >= 3) { P.failed = true; runLog('rebind_failed', { from: P.id }); renderDetail(); wsRenderAll(); }
}

// ============================================================ server events

let lastGameWorld = null;
function onStatus() {
  artyOnGameState();
  noteRun(S.status.session, 'status');
  if (S.status.world !== lastGameWorld) {
    // Units and markers from the previous mission/world are no longer valid.
    if (lastGameWorld !== null) { S.state = null; select(null); }
    lastGameWorld = S.status.world;
  }
  updateStatus();
  syncView();
}

function onState() {
  const st = S.state;
  runSawState(st); // re-finds a detail page's entity after a mission restart
  wsOnState();      // workspace panels follow me / my vehicle / the selection
  artyOnGameState(); // the gun I am in, friendly guns (artillery.js)
  mergeAnimIntoState();
  if (!onGameMap()) { renderLists(); return; }
  const ws = worldSize();
  const meOnMap = st.me && st.me.x >= 0 && st.me.y >= 0 && st.me.x <= ws && st.me.y <= ws;
  if (meOnMap && !S.view.centered && !S.view.userMoved) {
    S.view.centered = true;
    centerOn(st.me.x, st.me.y, 0.15);
  } else if (S.follow && st.me) {
    followMe();
    redraw();
  }
  if (S.selected && !findSelected()) S.selected = null;
  updateFollowUI();
  updateAllSidesUI();
  if (S.camId) updateCamHud();
  renderInfo();
  renderLists();
  redraw();
}

// One server event's JSON body; a malformed one is skipped (logged) instead of breaking the stream handler.
function evData(e) {
  try { return JSON.parse(e.data); } catch (err) { console.warn('dideban: ignored a malformed "' + e.type + '" event'); return null; }
}
// Listener for a server event that carries an object; malformed or empty payloads never reach fn.
const onEv = (fn) => (e) => { const d = evData(e); if (d && typeof d === 'object') fn(d); };
let sseRetry = 0;
function connect() {
  clearTimeout(sseRetry);
  const es = new EventSource('events');
  es.onopen = () => { S.sse = true; updateStatus(); };
  es.onerror = () => {
    S.sse = false; updateStatus();
    // The browser retries a dropped stream by itself, but gives up for good after an HTTP error
    // (e.g. a proxy or a server answering 5xx while it restarts): reconnect from here then.
    if (es.readyState === EventSource.CLOSED) { es.close(); sseRetry = setTimeout(connect, 3000); }
  };
  es.addEventListener('status', onEv((d) => { S.sse = true; S.status = d; onStatus(); }));
  es.addEventListener('meta', onEv((d) => { S.meta = { colors: d.colors || [], types: d.types || [] }; }));
  es.addEventListener('state', onEv((d) => { S.state = normState(d); onState(); }));
  es.addEventListener('detail', onEv((d) => acceptDetail(d)));
  es.addEventListener('progress', onEv((d) => { S.progress = d; updateBanner(); updateTerrainPanel(); }));
  es.addEventListener('maps', onEv((d) => { S.maps = Array.isArray(d) ? d : []; syncView(); }));
  es.addEventListener('meh_result', onEv((d) => {
    const code = d.code;
    toast(tOr('meh.' + code, t('meh.other', { code })));
  }));
  es.addEventListener('pos', onEv((d) => onPos(d)));
  es.addEventListener('settings', onEv((d) => { S.settings = d; updateRateUI(); updateAllSidesUI(); }));
  es.addEventListener('state_reset', (e) => {
    let r = {};
    try { r = JSON.parse(e.data) || {}; } catch (err) { /* older server: empty body */ }
    // older servers say nothing about the run: a reset is then taken as a new run
    if (r.session) noteRun(r.session, 'state_reset');
    else noteRun('reset-' + (++S.run.resets), 'state_reset', true);
    S.state = null; select(null); renderLists(); redraw();
  });
  es.addEventListener('arty_db', (e) => artyOnDb(JSON.parse(e.data)));
  es.addEventListener('arty_state', (e) => artyOnState(JSON.parse(e.data)));
  es.addEventListener('terrain', onEv((d) => {
    const key = wkey(d.world);
    if (key === viewKey()) loadTerrain(key, true);
  }));
}

applyStaticI18n();
updateLangUI();
View3D.init($('#gl'));
resize();
new ResizeObserver(resize).observe(canvas);
updateStatus();
updateDimUI();
updateOrientUI();
applyUiToggles();
updateLineBar();
updateFollowUI();
if (POPUP_CAM) {
  // Camera-only window opened from the map.
  appEl.classList.add('cam-window', 'panel-closed');
  S.mapChoice = 'auto';
  S.camId = POPUP_CAM;
  document.title = `${t('app.name')} · ${t('info.camera')}`;
  updateCamHud();
}
if (DETAIL_ID) {
  // A detail-only window opened from the map (whole page or a single tab).
  appEl.classList.add('detail-window', 'panel-closed');
  document.title = `${t('app.name')} · ${DETAIL_TAB ? t('d.tab.' + DETAIL_TAB) : t('info.detail')}`;
  renderDetail();
  pushWatch();
}
artyInit(); // the artillery calculator (artillery.js); registers its workspace panel first
wsInit(); // the customisable workspace (workspace.js)
requestAnimationFrame(() => requestAnimationFrame(() => appEl.classList.add('ready')));
connect();
