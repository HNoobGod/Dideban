'use strict';
// Minimal WebGL2 terrain renderer for the 3D view (no external libraries, works offline).
// World coordinates: x east, y north, z up (metres). GL space: X = x, Y = z * exaggeration, Z = -y.

const View3D = (() => {
  let canvas = null, gl = null;
  let terrainProg = null, waterProg = null, modelProg = null;
  let mesh = null, water = null;
  const modelMeshes = {};   // vehicle kind -> mesh
  let buildingMesh = null;  // all buildings of the map in one mesh
  let vehicles = [];        // [{ kind, x, y, z, dir, color: [r,g,b] }] for the next frame
  let modelScaleOn = true;  // enlarge vehicles when zoomed out so they stay visible
  let tex = null, hasTex = false;
  let src = null;          // height source { n, step, heights }
  let size = 8192;
  const exag = 1.5; // fixed height exaggeration: Arma terrain looks flat at 1:1
  let bright = 1;
  let W = 1, H = 1, dpr = 1;
  // Orbit camera around (tx, ty, tz above ground). With fp set, a first-person camera instead:
  // fp = { x, y, z (metres above ground), yaw, pitch } (used by the unit camera view).
  const cam = { tx: 4096, ty: 4096, tz: 0, yaw: 0, pitch: 0.7, dist: 4000, fp: null };
  let mvp = new Float32Array(16), inv = new Float32Array(16), eye = [0, 0, 0];
  const SKY = [0.62, 0.70, 0.78];
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  // ---------------------------------------------------------------- matrices
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far), o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
    return o;
  }
  function lookAt(e, c, up) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const o = new Float32Array(16);
    o[0] = xx; o[1] = yx; o[2] = zx; o[4] = xy; o[5] = yy; o[6] = zy; o[8] = xz; o[9] = yz; o[10] = zz;
    o[12] = -(xx * e[0] + xy * e[1] + xz * e[2]);
    o[13] = -(yx * e[0] + yy * e[1] + yz * e[2]);
    o[14] = -(zx * e[0] + zy * e[1] + zz * e[2]);
    o[15] = 1;
    return o;
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function invert(m) {
    const o = new Float32Array(16);
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return o;
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  }
  function xform(m, x, y, z) {
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
  }

  // ---------------------------------------------------------------- shaders
  const TERRAIN_VS = `#version 300 es
    in vec3 aPos; in vec3 aNrm;
    uniform mat4 uMVP; uniform float uExag; uniform float uSize;
    out vec2 vUv; out vec3 vN; out float vH; out vec3 vPos;
    void main() {
      vec3 p = vec3(aPos.x, aPos.y * uExag, aPos.z);
      gl_Position = uMVP * vec4(p, 1.0);
      vUv = vec2(aPos.x / uSize, 1.0 + aPos.z / uSize);
      vN = vec3(aNrm.x * uExag, aNrm.y, aNrm.z * uExag);
      vH = aPos.y; vPos = p;
    }`;
  const TERRAIN_FS = `#version 300 es
    precision highp float;
    in vec2 vUv; in vec3 vN; in float vH; in vec3 vPos;
    uniform sampler2D uTex; uniform int uHasTex; uniform vec3 uLight; uniform vec3 uEye;
    uniform float uFog; uniform vec3 uSky; uniform float uBright;
    out vec4 o;
    void main() {
      vec3 n = normalize(vN);
      float d = max(dot(n, uLight), 0.0);
      vec3 base = uHasTex == 1 ? texture(uTex, vUv).rgb
        : (vH < 0.0 ? vec3(0.55, 0.62, 0.66) : mix(vec3(0.86, 0.83, 0.72), vec3(0.62, 0.57, 0.44), clamp(vH / 300.0, 0.0, 1.0)));
      vec3 c = min(base * (0.5 + 0.65 * d) * uBright, vec3(1.0));
      float f = clamp(distance(vPos, uEye) / uFog, 0.0, 1.0);
      o = vec4(mix(c, uSky, f * f * 0.85), 1.0);
    }`;
  const WATER_VS = `#version 300 es
    in vec3 aPos; uniform mat4 uMVP; out vec3 vPos;
    void main() { gl_Position = uMVP * vec4(aPos, 1.0); vPos = aPos; }`;
  const WATER_FS = `#version 300 es
    precision highp float;
    in vec3 vPos; uniform vec3 uEye; uniform float uFog; uniform vec3 uSky; uniform float uBright; out vec4 o;
    void main() {
      float f = clamp(distance(vPos, uEye) / uFog, 0.0, 1.0);
      o = vec4(mix(min(vec3(0.15, 0.34, 0.52) * uBright, vec3(1.0)), uSky, f * f * 0.85), 0.62);
    }`;

  // Vehicles and buildings: simple lit, single-colour boxes.
  const MODEL_VS = `#version 300 es
    in vec3 aPos; in vec3 aNrm; in float aShade;
    uniform mat4 uMVP; uniform mat4 uModel;
    out vec3 vN; out vec3 vPos; out float vShade;
    void main() {
      vec4 w = uModel * vec4(aPos, 1.0);
      gl_Position = uMVP * w;
      vN = mat3(uModel) * aNrm; vPos = w.xyz; vShade = aShade;
    }`;
  const MODEL_FS = `#version 300 es
    precision highp float;
    in vec3 vN; in vec3 vPos; in float vShade;
    uniform vec3 uColor; uniform vec3 uLight; uniform vec3 uEye; uniform float uFog; uniform vec3 uSky; uniform float uBright;
    out vec4 o;
    void main() {
      float d = max(dot(normalize(vN), uLight), 0.0);
      vec3 c = min(uColor * vShade * (0.45 + 0.7 * d) * uBright, vec3(1.0));
      float f = clamp(distance(vPos, uEye) / uFog, 0.0, 1.0);
      o = vec4(mix(c, uSky, f * f * 0.85), 1.0);
    }`;

  // Parts per vehicle kind: [right, up, forward] centre, [width, height, length], shade. Metres.
  const MODELS = {
    tank: [[0, 0.9, 0, 3.4, 1.0, 7.0, 1], [-1.55, 0.5, 0, 0.7, 1.0, 7.4, 0.5], [1.55, 0.5, 0, 0.7, 1.0, 7.4, 0.5],
      [0, 1.75, -0.3, 2.4, 0.8, 3.0, 0.85], [0, 1.85, 3.2, 0.25, 0.25, 4.2, 0.55]],
    apc: [[0, 1.3, 0, 2.9, 1.5, 7.2, 1], [0, 1.0, 3.9, 2.9, 0.9, 0.8, 0.9],
      ...[-2.4, -0.8, 0.8, 2.4].flatMap((f) => [[-1.55, 0.55, f, 0.5, 1.1, 1.1, 0.3], [1.55, 0.55, f, 0.5, 1.1, 1.1, 0.3]]),
      [0, 2.3, 0.3, 1.4, 0.6, 1.8, 0.85], [0, 2.35, 2.0, 0.18, 0.18, 2.4, 0.55]],
    car: [[0, 0.85, 0, 2.0, 0.8, 4.6, 1], [0, 1.55, -0.3, 1.8, 0.65, 2.4, 0.75],
      ...[-1.5, 1.5].flatMap((f) => [[-1.0, 0.4, f, 0.35, 0.8, 0.8, 0.3], [1.0, 0.4, f, 0.35, 0.8, 0.8, 0.3]])],
    heli: [[0, 1.6, 0.5, 1.8, 1.8, 4.5, 1], [0, 1.4, 3.1, 1.4, 1.2, 1.0, 0.85], [0, 2.0, -4.0, 0.45, 0.5, 5.0, 0.9],
      [0, 2.8, -6.3, 0.15, 1.6, 1.0, 0.85], [-0.9, 0.15, 0.5, 0.15, 0.15, 4.0, 0.4], [0.9, 0.15, 0.5, 0.15, 0.15, 4.0, 0.4],
      [0, 2.75, 0.5, 0.2, 0.5, 0.2, 0.5], [0, 3.05, 0.5, 11, 0.08, 0.35, 0.3], [0, 3.05, 0.5, 0.35, 0.08, 11, 0.3]],
    plane: [[0, 1.5, 0, 1.3, 1.3, 14, 1], [0, 1.4, 7.5, 0.8, 0.8, 1.5, 0.85], [0, 1.3, 0, 11, 0.25, 3.2, 0.95],
      [0, 1.6, -6.0, 4.6, 0.2, 1.4, 0.9], [0, 2.8, -6.0, 0.2, 2.4, 1.8, 0.85], [0, 2.3, 3.5, 0.8, 0.5, 2.0, 0.45]],
    ship: [[0, 0.6, 0, 3.0, 1.2, 9.0, 1], [0, 0.7, 5.0, 2.0, 1.0, 1.4, 0.9], [0, 1.7, -1.0, 2.0, 1.2, 3.0, 0.8]],
    static: [[0, 0.4, 0, 1.2, 0.8, 1.2, 0.7], [0, 1.0, 0.6, 0.2, 0.2, 2.0, 0.55], [0, 1.0, 0.2, 1.2, 0.8, 0.1, 0.9]],
    veh: [[0, 1.0, 0, 2.5, 2.0, 5.0, 1]],
  };

  // Appends a box (local axes) to vertex arrays: interleaved position(3), normal(3), shade(1).
  const FACES = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]], [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  ];
  function pushBox(out, idx, center, half, shade, xf, skipBottom) {
    for (const [n, corners] of FACES) {
      if (skipBottom && n[1] === -1) continue;
      const base = out.length / 7;
      const nn = xf ? xf(n[0], n[1], n[2], true) : n;
      for (const c of corners) {
        const p = [center[0] + c[0] * half[0], center[1] + c[1] * half[1], center[2] + c[2] * half[2]];
        const q = xf ? xf(p[0], p[1], p[2], false) : p;
        out.push(q[0], q[1], q[2], nn[0], nn[1], nn[2], shade);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  function upload(verts, idx) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    const st = 7 * 4;
    gl.enableVertexAttribArray(modelProg.aPos); gl.vertexAttribPointer(modelProg.aPos, 3, gl.FLOAT, false, st, 0);
    gl.enableVertexAttribArray(modelProg.aNrm); gl.vertexAttribPointer(modelProg.aNrm, 3, gl.FLOAT, false, st, 12);
    gl.enableVertexAttribArray(modelProg.aShade); gl.vertexAttribPointer(modelProg.aShade, 1, gl.FLOAT, false, st, 24);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, bufs: [vb, ib], count: idx.length };
  }
  function buildModels() {
    for (const [kind, parts] of Object.entries(MODELS)) {
      const v = [], i = [];
      // Model space: x right, y up, z = -forward (so the nose points to -Z, i.e. north at heading 0).
      for (const [r, u, f, w, h, l, shade] of parts) pushBox(v, i, [r, u, -f], [w / 2, h / 2, l / 2], shade);
      modelMeshes[kind] = upload(v, i);
    }
  }

  function compile(vs, fs) {
    const p = gl.createProgram();
    for (const [type, code] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u, aPos: gl.getAttribLocation(p, 'aPos'), aNrm: gl.getAttribLocation(p, 'aNrm'), aShade: gl.getAttribLocation(p, 'aShade') };
  }

  // ---------------------------------------------------------------- public
  function init(el) {
    canvas = el;
    gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) return false;
    try {
      terrainProg = compile(TERRAIN_VS, TERRAIN_FS);
      waterProg = compile(WATER_VS, WATER_FS);
      modelProg = compile(MODEL_VS, MODEL_FS);
      buildModels();
    } catch (e) {
      console.error(e);
      gl = null;
      return false;
    }
    return true;
  }

  function supported() { return !!gl; }

  function heightAt(x, y) {
    if (!src) return 0;
    const N = src.n, Hh = src.heights;
    const fx = Math.min(N - 1.001, Math.max(0, x / src.step - 0.5));
    const fy = Math.min(N - 1.001, Math.max(0, y / src.step - 0.5));
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
    return Hh[j * N + i] * (1 - u) * (1 - v) + Hh[j * N + i + 1] * u * (1 - v) +
      Hh[(j + 1) * N + i] * (1 - u) * v + Hh[(j + 1) * N + i + 1] * u * v;
  }

  function setTerrain(source, worldSize) {
    if (!gl) return;
    src = source;
    size = worldSize;
    const N = src.n, step = src.step, Hh = src.heights;
    const s = Math.max(1, Math.ceil(N / 512));
    const M = Math.floor((N - 1) / s) + 1;
    const pos = new Float32Array(M * M * 3), nrm = new Float32Array(M * M * 3);
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < M; i++) {
        const gi = Math.min(N - 1, i * s), gj = Math.min(N - 1, j * s);
        const k = (j * M + i) * 3;
        // Edge vertices are stretched to the map border so the mesh covers the whole world.
        const x = i === 0 ? 0 : i === M - 1 ? size : (gi + 0.5) * step;
        const y = j === 0 ? 0 : j === M - 1 ? size : (gj + 0.5) * step;
        pos[k] = x; pos[k + 1] = Hh[gj * N + gi]; pos[k + 2] = -y;
        const hl = Hh[gj * N + Math.max(0, gi - s)], hr = Hh[gj * N + Math.min(N - 1, gi + s)];
        const hd = Hh[Math.max(0, gj - s) * N + gi], hu = Hh[Math.min(N - 1, gj + s) * N + gi];
        const dzdx = (hr - hl) / (2 * s * step), dzdy = (hu - hd) / (2 * s * step);
        // GL normal of the height field (unnormalised; exaggeration is applied in the shader).
        nrm[k] = -dzdx; nrm[k + 1] = 1; nrm[k + 2] = dzdy;
      }
    }
    const idx = new Uint32Array((M - 1) * (M - 1) * 6);
    let q = 0;
    for (let j = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) {
      const a = j * M + i, b = a + 1, c = a + M, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    if (mesh) { gl.deleteVertexArray(mesh.vao); mesh.bufs.forEach((b) => gl.deleteBuffer(b)); }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bufs = [];
    const attr = (loc, data) => {
      const b = gl.createBuffer(); bufs.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    };
    attr(terrainProg.aPos, pos);
    attr(terrainProg.aNrm, nrm);
    const ib = gl.createBuffer(); bufs.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    mesh = { vao, bufs, count: idx.length };

    if (water) { gl.deleteVertexArray(water.vao); gl.deleteBuffer(water.buf); }
    const m = size * 2;
    const wpos = new Float32Array([-m, 0, m, m * 1.5, 0, m, -m, 0, -m * 1.5, m * 1.5, 0, -m * 1.5]);
    const wvao = gl.createVertexArray();
    gl.bindVertexArray(wvao);
    const wb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, wb);
    gl.bufferData(gl.ARRAY_BUFFER, wpos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(waterProg.aPos);
    gl.vertexAttribPointer(waterProg.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    water = { vao: wvao, buf: wb };
  }

  // Buildings [x, y, dir, width, length, height?] -> one static mesh standing on the terrain.
  function setBuildings(list) {
    if (!gl) return;
    if (buildingMesh) { gl.deleteVertexArray(buildingMesh.vao); buildingMesh.bufs.forEach((b) => gl.deleteBuffer(b)); buildingMesh = null; }
    if (!list || !list.length || !src) return;
    const v = [], i = [];
    for (const b of list) {
      const [x, y, dir, w, l] = b;
      // Older exports have no height: estimate from the footprint.
      const h = b[5] > 1 ? Math.min(b[5], 60) : Math.min(14, Math.max(3.5, 3 + Math.sqrt(w * l) * 0.35));
      const ground = Math.max(0, heightAt(x, y)) * exag - 0.5;
      const a = -dir * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      const xf = (px, py, pz, isNormal) => isNormal
        ? [px * c + pz * s, py, -px * s + pz * c]
        : [x + px * c + pz * s, ground + py, -y + (-px * s + pz * c)];
      pushBox(v, i, [0, h / 2, 0], [Math.max(0.5, w / 2), h / 2, Math.max(0.5, l / 2)], 1, xf, true);
    }
    buildingMesh = upload(v, i);
  }

  function setVehicles(list) { vehicles = list || []; }
  function setModelScaling(on) { modelScaleOn = on; }

  function clearTerrain() { src = null; }
  function hasTerrain() { return !!src && !!mesh; }

  function setTexture(image) {
    if (!gl) return;
    if (!image) { hasTex = false; return; }
    if (!tex) tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    hasTex = true;
  }

  function maxTextureSize() { return gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 2048; }

  function resize(w, h, ratio) {
    W = w; H = h; dpr = ratio;
    if (!canvas) return;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }

  function updateMatrices() {
    if (cam.fp) {
      // First person: eye at the unit, looking along its heading.
      const f = cam.fp;
      eye = [f.x, (Math.max(0, heightAt(f.x, f.y)) + f.z) * exag, -f.y];
      const cp = Math.cos(f.pitch);
      const target = [eye[0] + Math.sin(f.yaw) * cp * 100, eye[1] + Math.sin(f.pitch) * 100, eye[2] - Math.cos(f.yaw) * cp * 100];
      mvp = mul(perspective((f.fov || 60) * Math.PI / 180, W / H, 0.5, size * 2.5), lookAt(eye, target, [0, 1, 0]));
      inv = invert(mvp);
      return;
    }
    const th = (Math.max(0, heightAt(cam.tx, cam.ty)) + (cam.tz || 0)) * exag;
    const target = [cam.tx, th, -cam.ty];
    const cp = Math.cos(cam.pitch);
    eye = [target[0] - Math.sin(cam.yaw) * cp * cam.dist, target[1] + Math.sin(cam.pitch) * cam.dist,
      target[2] + Math.cos(cam.yaw) * cp * cam.dist];
    // Keep the camera above the ground.
    const ground = Math.max(0, heightAt(eye[0], -eye[2])) * exag + 20;
    if (eye[1] < ground) eye[1] = ground;
    const near = Math.max(1, cam.dist * 0.01);
    const far = cam.dist * 8 + size * 2;
    mvp = mul(perspective(50 * Math.PI / 180, W / H, near, far), lookAt(eye, target, [0, 1, 0]));
    inv = invert(mvp);
  }

  function render() {
    if (!gl || !mesh) return;
    updateMatrices();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(SKY[0], SKY[1], SKY[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const fog = cam.fp ? size * 0.5 : cam.dist * 6 + size * 0.6;
    const L = [-0.45, 0.75, -0.5];
    const ll = Math.hypot(...L);

    gl.useProgram(terrainProg.p);
    const u = terrainProg.u;
    gl.uniformMatrix4fv(u.uMVP, false, mvp);
    gl.uniform1f(u.uExag, exag);
    gl.uniform1f(u.uSize, size);
    gl.uniform3f(u.uLight, L[0] / ll, L[1] / ll, L[2] / ll);
    gl.uniform3f(u.uEye, eye[0], eye[1], eye[2]);
    gl.uniform1f(u.uFog, fog);
    gl.uniform3f(u.uSky, ...SKY);
    gl.uniform1i(u.uHasTex, hasTex ? 1 : 0);
    gl.uniform1f(u.uBright, bright);
    if (hasTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u.uTex, 0); }
    gl.bindVertexArray(mesh.vao);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);

    // Buildings and vehicles.
    if (buildingMesh || vehicles.length) {
      const m = modelProg.u;
      gl.useProgram(modelProg.p);
      gl.uniformMatrix4fv(m.uMVP, false, mvp);
      gl.uniform3f(m.uLight, L[0] / ll, L[1] / ll, L[2] / ll);
      gl.uniform3f(m.uEye, eye[0], eye[1], eye[2]);
      gl.uniform1f(m.uFog, fog);
      gl.uniform3f(m.uSky, ...SKY);
      gl.uniform1f(m.uBright, bright);
      if (buildingMesh) {
        gl.uniformMatrix4fv(m.uModel, false, IDENTITY);
        gl.uniform3f(m.uColor, 0.80, 0.76, 0.68);
        gl.bindVertexArray(buildingMesh.vao);
        gl.drawElements(gl.TRIANGLES, buildingMesh.count, gl.UNSIGNED_INT, 0);
      }
      // Real-size vehicles vanish when zoomed out, so they grow with camera distance.
      const k = cam.fp ? 1 : modelScaleOn ? Math.min(50, Math.max(1.5, cam.dist / 180)) : 1;
      for (const v of vehicles) {
        if (cam.fp && v.id === cam.fp.skipId) continue; // don't draw the vehicle the camera sits in
        const mm = modelMeshes[v.kind] || modelMeshes.veh;
        const a = -v.dir * Math.PI / 180, c = Math.cos(a) * k, s = Math.sin(a) * k;
        const ground = Math.max(0, heightAt(v.x, v.y)) * exag;
        const y = ground + (v.alt || 0) * exag; // same height scale as the overlay labels
        const model = new Float32Array([c, 0, -s, 0, 0, k, 0, 0, s, 0, c, 0, v.x, y, -v.y, 1]);
        gl.uniformMatrix4fv(m.uModel, false, model);
        gl.uniform3f(m.uColor, v.color[0], v.color[1], v.color[2]);
        gl.bindVertexArray(mm.vao);
        gl.drawElements(gl.TRIANGLES, mm.count, gl.UNSIGNED_INT, 0);
      }
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(waterProg.p);
    gl.uniformMatrix4fv(waterProg.u.uMVP, false, mvp);
    gl.uniform3f(waterProg.u.uEye, eye[0], eye[1], eye[2]);
    gl.uniform1f(waterProg.u.uFog, fog);
    gl.uniform3f(waterProg.u.uSky, ...SKY);
    gl.uniform1f(waterProg.u.uBright, bright);
    gl.bindVertexArray(water.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  // World (x, y, z metres) -> CSS pixels, or null when behind the camera.
  function project(x, y, z) {
    const p = xform(mvp, x, z * exag, -y);
    if (p[3] <= 0.01) return null;
    return [(p[0] / p[3] * 0.5 + 0.5) * W, (1 - (p[1] / p[3] * 0.5 + 0.5)) * H];
  }

  // CSS pixels -> world [x, y] on the terrain, or null when the ray misses.
  function pick(px, py) {
    const nx = px / W * 2 - 1, ny = 1 - py / H * 2;
    const a = xform(inv, nx, ny, -1, 1), b = xform(inv, nx, ny, 1, 1);
    const p0 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]], p1 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    const len = Math.min(Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), cam.dist * 8 + size * 2);
    const d = [(p1[0] - p0[0]), (p1[1] - p0[1]), (p1[2] - p0[2])];
    const dl = Math.hypot(...d); d[0] /= dl; d[1] /= dl; d[2] /= dl;
    const below = (t) => {
      const x = p0[0] + d[0] * t, y = p0[1] + d[1] * t, z = p0[2] + d[2] * t;
      return y <= Math.max(0, heightAt(x, -z)) * exag;
    };
    const steps = 600;
    let prev = 0;
    for (let k = 1; k <= steps; k++) {
      const tt = len * (k / steps) ** 2; // finer steps near the camera
      if (below(tt)) {
        let lo = prev, hi = tt;
        for (let r = 0; r < 20; r++) { const mid = (lo + hi) / 2; if (below(mid)) hi = mid; else lo = mid; }
        return [p0[0] + d[0] * hi, -(p0[2] + d[2] * hi)];
      }
      prev = tt;
    }
    return null;
  }

  // ---------------------------------------------------------------- camera
  function rotate(dx, dy) {
    cam.yaw += dx * 0.006;
    cam.pitch = Math.min(1.5, Math.max(0.12, cam.pitch + dy * 0.005));
  }
  function pan(dx, dy) {
    const k = cam.dist / H * 1.4;
    const fx = Math.sin(cam.yaw), fy = Math.cos(cam.yaw); // forward on the ground
    const rx = Math.cos(cam.yaw), ry = -Math.sin(cam.yaw); // right on the ground
    cam.tx = Math.min(size, Math.max(0, cam.tx - (rx * dx - fx * dy) * k));
    cam.ty = Math.min(size, Math.max(0, cam.ty - (ry * dx - fy * dy) * k));
  }
  function zoom(f) { cam.dist = Math.min(size * 1.6, Math.max(60, cam.dist * f)); }
  // alt: height of the target above the ground (e.g. a followed aircraft); 0 = on the ground.
  function focus(x, y, dist, alt) {
    cam.tx = x; cam.ty = y;
    cam.tz = alt || 0;
    if (dist) cam.dist = dist;
  }
  function setBrightness(b) { bright = b; }

  return {
    init, supported, setTerrain, clearTerrain, hasTerrain, setTexture, maxTextureSize, resize, render,
    project, pick, heightAt, rotate, pan, zoom, focus, setBrightness, cam,
    setBuildings, setVehicles, setModelScaling, modelScale: () => (modelScaleOn ? Math.min(50, Math.max(1.5, cam.dist / 180)) : 1),
  };
})();
