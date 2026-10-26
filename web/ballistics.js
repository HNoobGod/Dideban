'use strict';
// ============================================================ artillery ballistics
// Pure maths for the artillery calculator: no DOM, no app state, so it runs the same in the
// browser (window.Ballistics) and under Node for the unit tests (module.exports).
//
//   frame      world x = east, y = north, z = up (Arma's ASL). A shot is simulated in its own
//              plane: d = downrange, c = cross range (+ right of the line of fire), z = height
//              relative to the gun's muzzle position.
//   models     vacuum: no drag at all (vanilla shells whose ammo has airFriction 0), solved in
//              closed form. drag: a numerical shot with a fixed time step, solved by bisection.
//              The drag terms copy the game exactly:
//                engine  the ammo's own airFriction, a = airFriction·|v|·v (no wind)
//                ACE     ace_artillerytables / ace_mk6mortar: a = airFriction·ρrel·|v−w|·(v−w),
//                        with the wind w, and the powder-temperature factor on the muzzle speed
//              (ace_artillerytables fnc_firedEH, ace_mk6mortar fnc_handleFired, and the ACE
//              extension's artillery/simulate.rs, which ACE's own range tables come from).
//   angles     radians inside; azimuth clockwise from north. Unit conversion is for the display.

(function (root) {
  const G = 9.80665;             // the engine's gravity (ACE uses the same value)
  const DT = 1 / 60;             // simulation step, s (ACE's own step)
  const ACE_DEFAULT_AF = -0.00006; // ace_artillerytables DEFAULT_AIR_FRICTION
  const MK6_AF = -0.0001;        // ace_mk6mortar MK6_82mm_AIR_FRICTION
  const MAX_TOF = 400;           // s; a shot still flying after this is treated as lost
  const EL_MIN = 0.0005;         // rad; lowest elevation the solver searches (0.03°)
  const EL_MAX = Math.PI / 2 - 0.0005;

  // ---------------------------------------------------------------- config rules
  // Muzzle speed of one fire mode: the weapon's initSpeed overrides the magazine's when positive,
  // multiplies it when negative, and is ignored when 0; then the mode's artilleryCharge.
  function muzzleVelocity(magInit, weaponInit, charge) {
    const w = Number(weaponInit) || 0;
    const base = w > 0 ? w : (w < 0 ? magInit * -w : magInit);
    return base * (Number.isFinite(charge) ? charge : 1);
  }

  // ACE's powder-temperature factor (the in-game handlers use 273.13 K, not 273.15).
  function powderFactor(tempC) {
    return ((tempC + 273.13) / 288.13 - 1) / 40 + 1;
  }

  // Which drag the game applies to this shot, from the weapon database and the mission's state.
  //   env:  { ace: { tables, mk6, adv, mk6Air }, tempC, density, wind: [wx, wy] }
  //   veh:  { scanner, aceApply (null = not set in config), mk6 }
  //   mag:  { aceAF (null = not set in config) }
  //   ammo: { airFriction }
  // → { kEng, kAce, windOn, mvScale, source }  (k > 0 means drag)
  function dragModel(env, veh, mag, ammo) {
    env = env || {};
    const ace = env.ace || {};
    const m = { kEng: 0, kAce: 0, windOn: false, mvScale: 1, source: 'vanilla' };
    const af = ammo && Number(ammo.airFriction) || 0;
    if (af < 0) m.kEng = -af;            // the engine's own drag (positive values are ignored)
    const rho = (Number(env.density) || 1.225) / 1.225;
    const tempC = Number.isFinite(env.tempC) ? env.tempC : 15;
    const apply = veh && veh.aceApply != null ? veh.aceApply : (veh ? veh.scanner : 0);
    if (ace.adv && apply === 1) {
      const aceAF = mag && mag.aceAF != null ? mag.aceAF : ACE_DEFAULT_AF;
      if (aceAF !== 0) {
        m.mvScale = powderFactor(tempC);
        m.source = 'ace';
        if (aceAF < 0) { m.kAce = -aceAF * rho; m.windOn = true; }
        else if (ammo && Number(ammo.airFriction) < 0) m.kEng = -ammo.airFriction; // ACE: "vanilla friction"
      }
    } else if (ace.mk6Air && veh && veh.mk6) {
      m.mvScale = powderFactor(tempC);
      m.kAce = -MK6_AF * rho;
      m.windOn = true;
      m.source = 'mk6';
    }
    return m;
  }
  const isVacuum = (m) => !m || (!(m.kEng > 0) && !(m.kAce > 0));

  // ---------------------------------------------------------------- one shot
  // p: { elev, mv, dz, kEng, kAce, wind: [cross, tail] (m/s, only with kAce), dt, path }
  // → { d, c, tof, maxOrd, impactAngle (rad below horizontal), vImpact, path? } or null when the
  //   round never comes down to dz (the target is above the top of its arc).
  function shot(p) {
    const dt = p.dt || DT, kE = p.kEng || 0, kA = p.kAce || 0;
    const wc = kA && p.wind ? p.wind[0] || 0 : 0, wt = kA && p.wind ? p.wind[1] || 0 : 0;
    const dz = p.dz || 0;
    let vc = 0, vd = p.mv * Math.cos(p.elev), vz = p.mv * Math.sin(p.elev);
    let c = 0, d = 0, z = 0, t = 0, top = 0;
    let lc = 0, ld = 0, lz = 0;
    const path = p.path ? [[0, 0]] : null;
    let pathT = 0;
    while (vz > 0 || z > dz) {
      if (t > MAX_TOF) return null;
      lc = c; ld = d; lz = z;
      let ac = 0, ad = 0, az = -G;
      if (kA) {
        const xc = wc - vc, xd = wt - vd, xz = -vz;
        const s = kA * Math.sqrt(xc * xc + xd * xd + xz * xz);
        ac += xc * s; ad += xd * s; az += xz * s;
      }
      if (kE) {
        const s = kE * Math.sqrt(vc * vc + vd * vd + vz * vz);
        ac -= vc * s; ad -= vd * s; az -= vz * s;
      }
      vc += ac * dt; vd += ad * dt; vz += az * dt;
      c += vc * dt; d += vd * dt; z += vz * dt;
      t += dt;
      if (z > top) top = z;
      if (path && t - pathT >= 0.25) { path.push([d, z]); pathT = t; }
    }
    if (top < dz || t <= 0) return null;
    // the crossing of dz lies between the last two steps
    const f = lz === z ? 1 : (lz - dz) / (lz - z);
    const out = {
      d: ld + (d - ld) * f, c: lc + (c - lc) * f, tof: t - dt + dt * f, maxOrd: top,
      impactAngle: Math.atan2(-vz, Math.hypot(vd, vc)), vImpact: Math.sqrt(vc * vc + vd * vd + vz * vz),
    };
    if (path) { path.push([out.d, dz]); out.path = path; }
    return out;
  }

  // Closed form without drag. Range reached at elevation e for a target dz above the gun.
  function vacRange(mv, e, dz) {
    const vs = mv * Math.sin(e), vh = mv * Math.cos(e);
    const rad = vs * vs - 2 * G * dz;
    if (rad < 0 || vh <= 0) return null;
    return vh * (vs + Math.sqrt(rad)) / G;
  }
  function vacShot(mv, e, dz, wantPath) {
    const vs = mv * Math.sin(e), vh = mv * Math.cos(e);
    const rad = vs * vs - 2 * G * dz;
    if (rad < 0 || vh <= 0) return null;
    const tof = (vs + Math.sqrt(rad)) / G;
    const vz = vs - G * tof;
    const out = { d: vh * tof, c: 0, tof, maxOrd: Math.max(0, vs * vs / (2 * G)), impactAngle: Math.atan2(-vz, vh), vImpact: Math.hypot(vh, vz) };
    if (wantPath) {
      out.path = [];
      for (let i = 0; i <= 40; i++) { const tt = tof * i / 40; out.path.push([vh * tt, vs * tt - G * tt * tt / 2]); }
    }
    return out;
  }

  // One shot in either model. wind is [cross, tail] for this line of fire.
  function fly(mv, e, dz, model, wind, wantPath, dt) {
    if (isVacuum(model)) return vacShot(mv, e, dz, wantPath);
    return shot({ elev: e, mv, dz, kEng: model.kEng, kAce: model.kAce, wind: model.windOn ? wind : null, path: wantPath, dt });
  }

  // Elevation of the longest shot (to height dz) and its range. Coarse scan, then golden section.
  const maxCache = new Map(); // the same charge is asked for both arcs and every wind pass
  function maxRange(mv, dz, model, wind) {
    const key = [mv, dz, model ? model.kEng : 0, model ? model.kAce : 0, wind ? wind[0] : 0, wind ? wind[1] : 0].map((v) => (+v || 0).toFixed(6)).join('|');
    if (maxCache.has(key)) return maxCache.get(key);
    if (maxCache.size > 256) maxCache.clear();
    const out = maxRangeRaw(mv, dz, model, wind);
    maxCache.set(key, out);
    return out;
  }
  function maxRangeRaw(mv, dz, model, wind) {
    const rng = (e) => { const s = fly(mv, e, dz, model, wind, false, isVacuum(model) ? 0 : 1 / 20); return s ? s.d : -1; };
    let best = -1, bestE = Math.PI / 4;
    for (let deg = 1; deg <= 89; deg += 2) {
      const e = deg * Math.PI / 180, r = rng(e);
      if (r > best) { best = r; bestE = e; }
    }
    if (best < 0) return null;
    const full = (e) => { const s = fly(mv, e, dz, model, wind, false); return s ? s.d : -1; };
    let a = Math.max(EL_MIN, bestE - 2.5 * Math.PI / 180), b = Math.min(EL_MAX, bestE + 2.5 * Math.PI / 180);
    const k = (Math.sqrt(5) - 1) / 2;
    let x1 = b - k * (b - a), x2 = a + k * (b - a), f1 = full(x1), f2 = full(x2);
    for (let i = 0; i < 40 && b - a > 1e-6; i++) {
      if (f1 < f2) { a = x1; x1 = x2; f1 = f2; x2 = a + k * (b - a); f2 = full(x2); }
      else { b = x2; x2 = x1; f2 = f1; x1 = b - k * (b - a); f1 = full(x1); }
    }
    const e = (a + b) / 2;
    return { elev: e, range: full(e) };
  }

  // Elevation that puts a round range metres downrange at height dz.
  //   high: the arc above the max-range elevation. Returns the shot plus elev, or a reason:
  //   'far' (beyond the longest shot) | 'near' (closer than this arc can drop) | 'height'.
  function solveElevation(mv, range, dz, model, high, wind) {
    if (isVacuum(model)) {
      const v2 = mv * mv, rad = v2 * v2 - G * (G * range * range + 2 * dz * v2);
      if (range <= 0) return { reason: 'near' };
      if (rad < 0) return { reason: 'far' };
      const e = Math.atan((v2 + (high ? 1 : -1) * Math.sqrt(rad)) / (G * range));
      if (e < EL_MIN || e > EL_MAX) return { reason: high ? 'near' : 'height' };
      const s = vacShot(mv, e, dz);
      return s ? Object.assign(s, { elev: e }) : { reason: 'height' };
    }
    const mx = maxRange(mv, dz, model, wind);
    if (!mx) return { reason: 'height' };
    if (range > mx.range) return { reason: 'far', maxRange: mx.range };
    const rngAt = (e) => { const s = fly(mv, e, dz, model, wind); return s ? s.d : -1; };
    // low arc: range rises with elevation up to the peak; high arc: it falls after it
    let lo = high ? mx.elev : EL_MIN, hi = high ? EL_MAX : mx.elev;
    const end = rngAt(high ? hi : lo);
    if (end >= 0 && end > range) return { reason: 'near', minRange: end };
    if (!high && end < 0) {
      // very low elevations cannot climb to dz: start where they first can
      let a = lo, b = hi;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (rngAt(m) < 0) a = m; else b = m; }
      lo = b;
      if (rngAt(lo) > range) return { reason: 'near', minRange: rngAt(lo) };
    }
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2, r = rngAt(m);
      const tooShort = r < range;
      if (tooShort !== high) lo = m; else hi = m;
      if (hi - lo < 1e-8) break;
    }
    const e = (lo + hi) / 2, s = fly(mv, e, dz, model, wind);
    return s ? Object.assign(s, { elev: e }) : { reason: 'height' };
  }

  // Wind as [cross (+ right), tail (+ toward the target)] for a line of fire at azimuth az.
  function windComps(w, az) {
    if (!w) return [0, 0];
    const sx = Math.sin(az), cy = Math.cos(az);
    return [w[0] * cy - w[1] * sx, w[0] * sx + w[1] * cy];
  }

  // Full firing solution from gun to target (world positions [x, y, zASL]).
  // → { ok, high, az, elev, tof, maxOrd, impactAngle, drift, range, dz } or { ok: false, reason }
  function solve(gun, target, mv, model, high, wind) {
    const dx = target[0] - gun[0], dy = target[1] - gun[1], dz = (target[2] || 0) - (gun[2] || 0);
    const range = Math.hypot(dx, dy);
    const az0 = Math.atan2(dx, dy);
    let az = az0, s = null, aim = range;
    const windy = !isVacuum(model) && model.windOn && wind && (wind[0] || wind[1]);
    for (let pass = 0; pass < (windy ? 4 : 1); pass++) {
      s = solveElevation(mv, aim, dz, model, high, windy ? windComps(wind, az) : null);
      if (s.reason) break;
      if (!windy) break;
      // drift: aim off to the other side, and fly the distance that lands on the target
      const off = Math.atan2(s.c, s.d);
      az = az0 - off;
      aim = Math.sqrt(Math.max(0, range * range - s.c * s.c));
    }
    if (!s || s.reason) return Object.assign({ ok: false, high, range, dz, az: norm(az0) }, s || { reason: 'height' });
    return {
      ok: true, high, range, dz, az: norm(az), azGeo: norm(az0), elev: s.elev, tof: s.tof,
      maxOrd: s.maxOrd, impactAngle: s.impactAngle, vImpact: s.vImpact, drift: s.c || 0,
    };
  }
  const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  // Reach of one charge on each arc, to height dz, inside the turret's elevation limits (rad).
  // → { low: { min, max } | null, high: { min, max } | null, peak }
  function chargeRanges(mv, dz, model, limits, wind) {
    const lim = limits || {};
    const eMin = Math.max(EL_MIN, Number.isFinite(lim.min) ? lim.min : EL_MIN);
    const eMax = Math.min(EL_MAX, Number.isFinite(lim.max) ? lim.max : EL_MAX);
    const mx = maxRange(mv, dz, model, wind);
    if (!mx || eMax <= eMin) return { low: null, high: null, peak: null };
    const at = (e) => { const s = fly(mv, e, dz, model, wind); return s ? s.d : null; };
    const span = (a, b) => {
      if (b - a < 1e-4) return null;   // under 0.006°: no arc left inside the limits
      const ra = at(a), rb = at(b);
      if (ra == null && rb == null) return null;
      const lo = Math.min(ra ?? Infinity, rb ?? Infinity), hi = Math.max(ra ?? -Infinity, rb ?? -Infinity);
      return { min: lo, max: hi };
    };
    return {
      low: span(eMin, Math.min(eMax, mx.elev)),
      high: span(Math.max(eMin, mx.elev), eMax),
      peak: mx,
    };
  }

  // Every charge × both arcs for one gun, magazine and target.
  //   charges: [{ name, mv }]   limits: { min, max } turret elevation, rad (null = none)
  // → { rows: [{ i, name, mv, low, high, reach }], best: { low, high } (row index or -1) }
  function table(gun, target, charges, model, limits, wind, opt) {
    const withReach = !opt || opt.reach !== false;
    const rows = charges.map((ch, i) => {
      const mvEff = ch.mv * (model ? model.mvScale || 1 : 1);
      const row = { i, name: ch.name, mv: mvEff };
      for (const high of [false, true]) {
        const s = solve(gun, target, mvEff, model, high, wind);
        if (s.ok && limits) {
          if (Number.isFinite(limits.min) && s.elev < limits.min - 1e-9) s.limit = 'low';
          if (Number.isFinite(limits.max) && s.elev > limits.max + 1e-9) s.limit = 'high';
        }
        row[high ? 'high' : 'low'] = s;
      }
      if (withReach) {
        const dz = (target[2] || 0) - (gun[2] || 0);
        row.reach = chargeRanges(mvEff, dz, model, limits, wind ? windComps(wind, Math.atan2(target[0] - gun[0], target[1] - gun[1])) : null);
      }
      return row;
    });
    return { rows, best: { low: bestCharge(rows, false), high: bestCharge(rows, true) } };
  }
  // Low arc: the shortest time of flight; high arc: the lowest charge. Only usable solutions.
  function bestCharge(rows, high) {
    let best = -1;
    rows.forEach((r, i) => {
      const s = high ? r.high : r.low;
      if (!s || !s.ok || s.limit) return;
      if (best < 0) { best = i; return; }
      if (!high && s.tof < rows[best].low.tof) best = i;
    });
    return best;
  }

  // ---------------------------------------------------------------- units
  const MILS = { nato: 6400, wp: 6000 };
  const toMils = (rad, sys) => rad * (MILS[sys] || 6400) / (2 * Math.PI);
  const fromMils = (m, sys) => m * 2 * Math.PI / (MILS[sys] || 6400);
  const toDeg = (rad) => rad * 180 / Math.PI;
  const fromDeg = (d) => d * Math.PI / 180;

  // ---------------------------------------------------------------- ACE extension, verbatim
  // Straight ports of ACE's artillery/simulate.rs and find_max_angle (including its end-of-flight
  // interpolation and whole-step time of flight). Used only by the tests, to show that the drag
  // model above is ACE's: they reproduce ACE's own unit-test numbers.
  const ace = {
    shot(elev, dz, mv, af, cross, tail, tempK, density) {
      const k = -density * af;
      const powder = af === 0 ? 1 : (tempK / 288.13 - 1) / 40 + 1;
      let t = 0, px = 0, py = 0, pz = 0, lx = 0, ly = 0, lz = 0;
      let vx = 0, vy = powder * mv * Math.cos(elev), vz = powder * mv * Math.sin(elev);
      while (vz > 0 || pz > dz) {
        lx = px; ly = py; lz = pz;
        const ax = cross - vx, ay = tail - vy, az = -vz;
        const m = Math.sqrt(ax * ax + ay * ay + az * az);
        vx += ax * (k * m) * DT; vy += ay * (k * m) * DT; vz += (-G + az * (k * m)) * DT;
        px += vx * DT; py += vy * DT; pz += vz * DT;
        t += DT;
      }
      const r = (dz - pz) / (lz - pz);
      return [lx + (px - lx) * r, ly + (py - ly) * r, t];
    },
    findMaxAngle(mv, af) {
      if (af === 0) return [Math.PI / 4, mv * mv / G];
      let bestA = Math.PI / 4, bestD = -1, a = Math.PI / 4;
      for (;;) {
        const d = ace.shot(a, 0, mv, af, 0, 0, 288.15, 1)[1];
        if (d > bestD) { bestA = a; bestD = d; }
        a -= Math.PI / 4 / 100;
        if (a <= 0) break;
      }
      return [bestA, bestD];
    },
    findSolution(range, dz, mv, af, high, minE, maxE, tempK, density) {
      let n = 50, dist = -1, time = -1, lo = minE, hi = maxE, err = 9999, e = -1;
      for (;;) {
        n--;
        e = (lo + hi) / 2;
        const s = ace.shot(e, dz, mv, af, 0, 0, tempK, density);
        dist = s[1]; time = s[2];
        if (!Number.isNaN(dist)) err = range - dist;
        if ((err > 0) !== !high) hi = e; else lo = e;
        if (n === 0 || hi - lo <= 0.000025) break;
      }
      if (Math.abs(err) > range * 0.001 * (high ? 1 : 2)) return [-1, -1, -1];
      return [dist, e, time];
    },
  };

  const B = {
    G, DT, ACE_DEFAULT_AF, MK6_AF,
    muzzleVelocity, powderFactor, dragModel, isVacuum,
    shot, fly, vacRange, maxRange, solveElevation, solve, windComps, chargeRanges, table, bestCharge,
    MILS, toMils, fromMils, toDeg, fromDeg, ace,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
  else root.Ballistics = B;
})(typeof window !== 'undefined' ? window : globalThis);
