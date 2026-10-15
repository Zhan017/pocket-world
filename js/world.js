// Turns a photo + its scan into a small 3D world.
//
//   Layer A  the photo as a depth-displaced sheet, torn apart at depth edges
//   Layer B  a "far side" sheet behind every edge, so tears show plausible
//            background instead of holes
//   Subjects each person or pet becomes a cutout standing at their depth,
//            turning to face you, with a soft contact shadow
//   Backdrop a sky/ground gradient sampled from the photo's own colors
//
// With a Claude scene description it also levels the camera, measures depth
// in metres from the ground, and builds simple surroundings beyond the frame.

import * as THREE from 'three';
import { pullPush, fillCloned, rankFilter, boxBlur, resample, percentile } from './fill.js';
import { buildSurroundings } from './surroundings.js';
import { samplePoints, fitObject } from './objects3d.js';
import { buildCar, canBuild, photoDepth, matchPaint, carMaterial, carShadow } from './carmodel.js';
import { buildPlanScene, surfaceTopAt } from './scenebuild.js';

const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle']);

const GRID_LONG = 384;          // mesh vertices along the photo's long side
const FOV_LONG_DEG = 65;        // assumed lens: a typical phone main camera
const TEAR = 0.03;              // disparity jump that splits the sheet

const worldVert = /* glsl */`
  varying vec2 vUv; varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const backdropFn = /* glsl */`
  uniform vec3 cTop; uniform vec3 cHorizon; uniform vec3 cBottom;
  vec3 backdrop(vec3 d) {
    float y = d.y;
    return y > 0.0 ? mix(cHorizon, cTop, smoothstep(0.0, 0.55, y))
                   : mix(cHorizon, cBottom, smoothstep(0.0, 0.45, -y));
  }`;

const worldFrag = /* glsl */`
  uniform sampler2D map; uniform float edge; uniform float shade; uniform float opacity; uniform float dither;
  varying vec2 vUv; varying vec3 vWorld;
  ${backdropFn}
  void main() {
    vec3 col = texture2D(map, vUv).rgb * shade;
    float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float f = smoothstep(0.0, edge, e);
    if (dither > 0.5) {
      // With surroundings, the photo's edge dissolves into them instead of into the sky.
      if (f < fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453)) discard;
      gl_FragColor = vec4(col, opacity);
      return;
    }
    vec3 d = normalize(vWorld - cameraPosition);
    gl_FragColor = vec4(mix(backdrop(d), col, f), opacity);
  }`;

const skyFrag = /* glsl */`
  varying vec3 vWorld;
  ${backdropFn}
  void main() { gl_FragColor = vec4(backdrop(normalize(vWorld - cameraPosition)), 1.0); }`;

const cutoutFrag = /* glsl */`
  uniform sampler2D map; uniform float opacity; varying vec2 vUv;
  void main() {
    vec4 c = texture2D(map, vUv);
    if (c.a < 0.02) discard;
    gl_FragColor = vec4(c.rgb, c.a * opacity);
  }`;

const shadowFrag = /* glsl */`
  uniform float strength; varying vec2 vUv;
  void main() {
    float r = length((vUv - 0.5) * 2.0);
    float a = strength * (1.0 - smoothstep(0.15, 1.0, r));
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
  }`;

function avgRows(px, W, H, y0, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4; r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
    }
  }
  return new THREE.Vector3(r / n / 255, g / n / 255, b / n / 255);
}

function canvasFrom(rgbaFloat, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const id = c.getContext('2d').createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    id.data[i * 4] = rgbaFloat[i * 3]; id.data[i * 4 + 1] = rgbaFloat[i * 3 + 1];
    id.data[i * 4 + 2] = rgbaFloat[i * 3 + 2]; id.data[i * 4 + 3] = 255;
  }
  c.getContext('2d').putImageData(id, 0, 0);
  return c;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const median = (arr) => { const s = Float64Array.from(arr).sort(); return s.length ? s[s.length >> 1] : 0; };
const srgbVec = (hexStr, fallback) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexStr || '');
  const n = parseInt(m ? m[1] : fallback, 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

function texFrom(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace; // shaders pass sRGB straight through
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/**
 * @param {object} scan   output of the AI step (see scan-format.js)
 * @param {HTMLCanvasElement} photo  the photo at scan.width x scan.height
 * @param {{strength?: number, scene?: object}} opts
 *   strength  depth strength, 0.5 (flat) to 2 (deep), used when depth isn't measured
 *   scene     Claude's description of the photo (api/scene.js), optional
 *   photoHi   the photo at up to 2576 px, used to paint Claude's plan of the place (optional)
 */
export function buildWorld(scan, photo, { strength = 1, scene = null, photoHi = null } = {}) {
  const W = scan.width, H = scan.height;
  const L = Math.max(W, H);
  // Claude's full plan of the place replaces the depth sheet (layers A and B).
  const planMode = Boolean(scene && Array.isArray(scene.surfaces) && scene.surfaces.length);
  const hfov = scene ? clamp(Number(scene.camera?.hfov_deg) || 0, 0, 120) : 0;
  const f = hfov >= 25 ? (W / 2) / Math.tan((hfov * Math.PI) / 360) : (L / 2) / Math.tan((FOV_LONG_DEG * Math.PI) / 360);
  const cx = W / 2, cy = H / 2;
  const near = 1, far = Math.pow(12, strength);
  let zOf = (dn) => 1 / (1 / far + dn * (1 / near - 1 / far));
  // Camera tilt: positive = the photo looks down at the ground.
  const pitch = scene ? (clamp(Number(scene.camera?.pitch_deg) || 0, -45, 85) * Math.PI) / 180 : 0;

  const px = photo.getContext('2d').getImageData(0, 0, W, H).data;

  // --- Normalized disparity (1 = nearest, 0 = farthest) -------------------
  const D = scan.depth;
  const lo = percentile(D.data, 0.01), hi = percentile(D.data, 0.995);
  const dnSrc = new Float32Array(D.data.length);
  for (let i = 0; i < dnSrc.length; i++) dnSrc[i] = Math.min(1, Math.max(0, (D.data[i] - lo) / (hi - lo || 1)));
  const dnAt = (x, y) => {
    const xi = Math.min(D.w - 1, Math.max(0, Math.round((x / W) * D.w - 0.5)));
    const yi = Math.min(D.h - 1, Math.max(0, Math.round((y / H) * D.h - 0.5)));
    return dnSrc[yi * D.w + xi];
  };

  // --- Subject mask at photo resolution ------------------------------------
  const mask = new Float32Array(W * H);
  for (const s of scan.subjects) {
    const [x0, y0, cw, ch] = s.crop;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      // The gap only needs filling where the cutout is mostly opaque; softer
      // edge pixels keep the original photo so the first view stays exact.
      const a = s.alpha[y * cw + x] > 127 ? 1 : 0, k = (y + y0) * W + (x + x0);
      if (a > mask[k]) mask[k] = a;
    }
  }
  const hasSubjects = scan.subjects.length > 0;
  const maskWide = hasSubjects ? rankFilter(mask, W, H, Math.max(2, Math.round(L * 0.002)), 'max') : mask;

  // --- Measure depth in metres from the ground (needs Claude's scene) -----
  // A ground pixel at image row v is hit by a ray that drops a known amount
  // per metre, given the camera height and tilt. Fitting the model's relative
  // disparity to those true values turns the whole depth map into metres.
  let calib = null;
  if (scene && Array.isArray(scene.ground_polygon) && scene.ground_polygon.length >= 3) {
    const h = clamp(Number(scene.camera?.height_m) || 1.5, 0.3, 400);
    const poly = scene.ground_polygon.map((p) => [clamp(Number(p.x) || 0, 0, 1) * W, clamp(Number(p.y) || 0, 0, 1) * H]);
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const xs = [], ys = [];
    for (let j = 0; j < 56; j++) for (let i = 0; i < 56; i++) {
      const u = ((i + 0.5) / 56) * W, v = ((j + 0.5) / 56) * H;
      if (!inside(u, v) || maskWide[Math.floor(v) * W + Math.floor(u)] > 0.5) continue;
      const yWorld = (-(v - cy) / f) * Math.cos(pitch) - Math.sin(pitch);
      if (yWorld > -0.02) continue;
      xs.push(dnAt(u, v)); ys.push(-yWorld / h);
    }
    if (xs.length >= 25) {
      // Theil-Sen: robust to the polygon spilling onto non-ground pixels.
      const step = Math.max(1, Math.floor(xs.length / 160));
      const sx = xs.filter((_, i) => i % step === 0), sy = ys.filter((_, i) => i % step === 0);
      const slopes = [];
      for (let i = 0; i < sx.length; i++) for (let j = i + 1; j < sx.length; j++) {
        const dx = sx[j] - sx[i];
        if (Math.abs(dx) > 0.02) slopes.push((sy[j] - sy[i]) / dx);
      }
      const a = median(slopes);
      const b = median(xs.map((x, i) => ys[i] - a * x));
      const err = median(xs.map((x, i) => Math.abs(a * x + b - ys[i]) / ys[i]));
      if (a > 0 && a + b > 0 && err < 0.3) {
        const zFarCap = clamp(60 * h, 150, 1500);
        zOf = (dn) => 1 / Math.max(a * dn + b, 1 / zFarCap);
        calib = { h, a, b, zFarCap, err };
      }
    }
  }

  // --- Grid ----------------------------------------------------------------
  const gs = GRID_LONG / L;
  const gw = Math.max(2, Math.round(W * gs)), gh = Math.max(2, Math.round(H * gs));
  const dnGrid = resample(dnSrc, D.w, D.h, gw, gh);
  // Typical (median) disparity of each subject = where its cutout will stand.
  const subjectDn = scan.subjects.map((s) => {
    const [x0, y0, cw, ch] = s.crop, ds = [];
    for (let y = 0; y < ch; y += 2) for (let x = 0; x < cw; x += 2) if (s.alpha[y * cw + x] > 180) ds.push(dnAt(x + x0, y + y0));
    ds.sort((p, q) => p - q);
    return ds.length ? ds[ds.length >> 1] : null;
  });
  let dnFill = dnGrid;
  if (hasSubjects) {
    const mg = rankFilter(resample(maskWide, W, H, gw, gh), gw, gh, 1, 'max');
    const wt = new Float32Array(gw * gh);
    for (let i = 0; i < wt.length; i++) wt[i] = mg[i] > 0.06 ? 0 : 1;
    dnFill = pullPush(dnGrid, gw, gh, 1, wt);
    // Whatever fills the gap must sit behind the person, never in front of them.
    const cap = new Float32Array(gw * gh).fill(1);
    scan.subjects.forEach((s, n) => {
      if (subjectDn[n] == null) return;
      const lim = Math.max(0, subjectDn[n] - 0.025);
      const [x0, y0, cw, ch] = s.crop;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        if (s.alpha[y * cw + x] <= 127) continue;
        const gx = Math.round(((x + x0) / W) * (gw - 1)), gy = Math.round(((y + y0) / H) * (gh - 1));
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx, yy = gy + dy;
          if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          const k = yy * gw + xx;
          if (lim < cap[k]) cap[k] = lim;
        }
      }
    });
    for (let i = 0; i < dnFill.length; i++) if (wt[i] === 0 && dnFill[i] > cap[i]) dnFill[i] = cap[i];
    // With measured depth, the gap a vehicle leaves is road: lay it on the
    // ground plane, so a 3D car stands on the road instead of in front of a ramp.
    if (calib) {
      const vm = new Uint8Array(gw * gh);
      for (const s of scan.subjects) {
        if (!VEHICLES.has(s.label)) continue;
        const [x0, y0, cw, ch] = s.crop;
        for (let y = 0; y < ch; y += 2) for (let x = 0; x < cw; x += 2) {
          if (s.alpha[y * cw + x] <= 127) continue;
          vm[Math.round(((y + y0) / H) * (gh - 1)) * gw + Math.round(((x + x0) / W) * (gw - 1))] = 1;
        }
      }
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (wt[k] !== 0 || !(vm[k] || (i > 0 && vm[k - 1]) || (i < gw - 1 && vm[k + 1]) || (j > 0 && vm[k - gw]) || (j < gh - 1 && vm[k + gw]))) continue;
        const yW = (-((j / (gh - 1)) * H - cy) / f) * cp - sp;
        if (yW > -0.01) continue;
        const dg = (yW * -1 / calib.h - calib.b) / calib.a;
        if (dg < dnFill[k]) dnFill[k] = dg;
      }
    }
  }

  // --- Texture A: the photo with people painted out -----------------------
  let texACanvas = photo;
  if (hasSubjects) {
    const rgb = new Float32Array(W * H * 3), wt = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2];
      wt[i] = maskWide[i] > 0.5 ? 0 : 1;
    }
    const filled = fillCloned(rgb, W, H, wt, scan.subjects);
    // Darken the gap a little so, when it shows, it reads as the person's soft shadow.
    const shade = boxBlur(Float32Array.from(wt, (v) => 1 - v), W, H, 1, Math.max(2, Math.round(L * 0.01)));
    for (let i = 0; i < W * H; i++) {
      if (wt[i] >= 0.5) continue;   // only inside the gap, never around the person
      const k = 1 - 0.14 * Math.min(1, shade[i] * 1.6);
      filled[i * 3] *= k; filled[i * 3 + 1] *= k; filled[i * 3 + 2] *= k;
    }
    texACanvas = canvasFrom(filled, W, H);
  }

  // --- Tears: triangles that span a depth edge ----------------------------
  const cw1 = gw - 1, ch1 = gh - 1;
  const torn = new Float32Array(cw1 * ch1);
  const span4 = (k) => {
    const a = dnFill[k], b = dnFill[k + 1], c = dnFill[k + gw], d = dnFill[k + gw + 1];
    return Math.max(a, b, c, d) - Math.min(a, b, c, d);
  };
  for (let j = 0; j < ch1; j++) for (let i = 0; i < cw1; i++) torn[j * cw1 + i] = span4(j * gw + i) >= TEAR ? 1 : 0;

  // --- Layer B: push every edge back to the far side ----------------------
  // Seen through a tear, B shows a softened copy of the photo at background
  // depth, which reads as "more of the scene" instead of a hole.
  const rB = Math.max(3, Math.round(Math.max(gw, gh) * 0.03));
  const dnB = boxBlur(rankFilter(dnFill, gw, gh, rB, 'min'), gw, gh, 1, 2);
  for (let i = 0; i < dnB.length; i++) dnB[i] = Math.min(dnB[i], dnFill[i]);
  const nearTear = rankFilter(torn, cw1, ch1, rB + 2, 'max');
  const bw = Math.max(2, Math.round(W / 2)), bh = Math.max(2, Math.round(H / 2));
  const texBCanvas = (() => {
    const half = document.createElement('canvas'); half.width = bw; half.height = bh;
    const hctx = half.getContext('2d', { willReadFrequently: true }); hctx.drawImage(texACanvas, 0, 0, bw, bh);
    const hp = hctx.getImageData(0, 0, bw, bh).data;
    const rgb = new Float32Array(bw * bh * 3);
    for (let i = 0; i < bw * bh; i++) { rgb[i * 3] = hp[i * 4]; rgb[i * 3 + 1] = hp[i * 4 + 1]; rgb[i * 3 + 2] = hp[i * 4 + 2]; }
    return canvasFrom(boxBlur(rgb, bw, bh, 3, 2), bw, bh);
  })();

  // --- Backdrop colors from the photo itself ------------------------------
  let cTop = avgRows(px, W, H, 0, H * 0.08);
  let cBottom = avgRows(px, W, H, H * 0.92, H).multiplyScalar(0.8);
  let cHorizon = avgRows(px, W, H, H * 0.35, H * 0.65).lerp(cTop, 0.35);
  if (scene?.sky) {
    // The photo may not show any sky (a camera pointing down), so use Claude's.
    cTop = srgbVec(scene.sky.top, '9fc0e8');
    cHorizon = srgbVec(scene.sky.horizon, 'd3dee8');
    cBottom = srgbVec(scene.ground_color, '7a7f6a').multiplyScalar(0.85);
  }
  const uniformsBase = () => ({
    cTop: { value: cTop }, cHorizon: { value: cHorizon }, cBottom: { value: cBottom },
  });

  // --- Geometry ------------------------------------------------------------
  // classify(cellIndex) -> 0 skip, 1 main mesh, 2 edge mesh
  const build = (dn, classify, push = 1) => {
    const pos = new Float32Array(gw * gh * 3), uv = new Float32Array(gw * gh * 2);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const u = (i / (gw - 1)) * W, v = (j / (gh - 1)) * H;
      const z = zOf(dn[k]) * push;
      pos[k * 3] = ((u - cx) / f) * z; pos[k * 3 + 1] = (-(v - cy) / f) * z; pos[k * 3 + 2] = -z;
      uv[k * 2] = u / W; uv[k * 2 + 1] = 1 - v / H;
    }
    const main = [], edge = [];
    for (let j = 0; j < ch1; j++) for (let i = 0; i < cw1; i++) {
      const kind = classify(j * cw1 + i);
      if (!kind) continue;
      const a = j * gw + i, b = a + 1, c = a + gw, d = c + 1;
      (kind === 2 ? edge : main).push(a, c, b, b, c, d);
    }
    const P = new THREE.BufferAttribute(pos, 3), U = new THREE.BufferAttribute(uv, 2);
    const geo = (idx) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', P); g.setAttribute('uv', U);
      g.setIndex(new THREE.Uint32BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      return g;
    };
    return { main: geo(main), edge: edge.length ? geo(edge) : null, tris: (main.length + edge.length) / 3 };
  };
  const A = build(dnFill, (c) => (torn[c] ? 2 : 1));
  const B = build(dnB, (c) => (nearTear[c] > 0 ? 1 : 0), 1.004);

  // `content` holds everything built in the photo's camera frame. Rotating it
  // by the camera tilt makes the ground level in the world.
  const group = new THREE.Group();
  const content = new THREE.Group();
  content.rotation.x = -pitch;
  group.add(content);
  const withSurroundings = Boolean(calib && scene?.layout);
  const textures = [];
  const worldMat = (canvas, shade, extra = {}) => {
    const t = texFrom(canvas); textures.push(t);
    return new THREE.ShaderMaterial({
      vertexShader: worldVert, fragmentShader: worldFrag, side: THREE.DoubleSide,
      uniforms: { map: { value: t }, edge: { value: withSurroundings ? 0.07 : 0.05 }, shade: { value: shade }, opacity: { value: 1 }, dither: { value: withSurroundings ? 1 : 0 }, ...uniformsBase() },
      ...extra,
    });
  };
  const matA = worldMat(texACanvas, 1);
  const meshA = new THREE.Mesh(A.main, matA);
  const meshB = new THREE.Mesh(B.main, worldMat(texBCanvas, 0.94));
  if (!planMode) content.add(meshB, meshA);
  // Torn triangles keep the photo pixel-perfect from where it was taken,
  // then dissolve as soon as you move, revealing layer B.
  let edgeMat = null;
  if (A.edge && !planMode) {
    edgeMat = new THREE.ShaderMaterial({
      vertexShader: worldVert, fragmentShader: worldFrag, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      uniforms: { ...matA.uniforms, opacity: { value: 1 } },
    });
    const meshE = new THREE.Mesh(A.edge, edgeMat);
    meshE.renderOrder = 1;
    content.add(meshE);
  }

  // --- Subjects ------------------------------------------------------------
  // People and pets become cutouts that turn to face you. Vehicles become a
  // relief (the photo pushed out by its own depth), which a generated 3D
  // model can replace later (attachModel).
  const subjects = [];
  const objects = [];
  for (const s of scan.subjects) {
    const [x0, y0, cw, ch] = s.crop;
    let a = new Float32Array(cw * ch);
    for (let i = 0; i < a.length; i++) a[i] = s.alpha[i] / 255;
    a = boxBlur(a, cw, ch, 1, 1);
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const id = c.getContext('2d').createImageData(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const k = y * cw + x, p = ((y + y0) * W + (x + x0)) * 4;
      id.data[k * 4] = px[p]; id.data[k * 4 + 1] = px[p + 1]; id.data[k * 4 + 2] = px[p + 2];
      const t = Math.min(1, Math.max(0, (a[k] - 0.3) / 0.4));
      id.data[k * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
    }
    c.getContext('2d').putImageData(id, 0, 0);
    const dnS = subjectDn[scan.subjects.indexOf(s)];
    if (dnS == null) continue;
    if (VEHICLES.has(s.label)) {
      const t = texFrom(c); textures.push(t);
      const step = Math.max(2, Math.round(Math.max(cw, ch) / 110));
      const nx = Math.floor((cw - 1) / step) + 1, ny = Math.floor((ch - 1) / step) + 1;
      const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
      const dnv = new Float32Array(nx * ny), al = new Uint8Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x = Math.min(cw - 1, i * step), y = Math.min(ch - 1, j * step), k = j * nx + i;
        // Edge pixels often carry the background's depth; keep them near the object.
        const d = Math.max(dnAt(x + x0, y + y0), dnS - 0.08);
        const z = zOf(d) * 0.995;
        pos[k * 3] = ((x + x0 - cx) / f) * z; pos[k * 3 + 1] = (-(y + y0 - cy) / f) * z; pos[k * 3 + 2] = -z;
        uv[k * 2] = x / (cw - 1); uv[k * 2 + 1] = 1 - y / (ch - 1);
        dnv[k] = d; al[k] = s.alpha[y * cw + x];
      }
      const idx = [];
      for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a0 = j * nx + i, b0 = a0 + 1, c0 = a0 + nx, d0 = c0 + 1;
        if (Math.max(al[a0], al[b0], al[c0], al[d0]) < 25) continue;
        const span = Math.max(dnv[a0], dnv[b0], dnv[c0], dnv[d0]) - Math.min(dnv[a0], dnv[b0], dnv[c0], dnv[d0]);
        if (span > 0.08) continue;
        idx.push(a0, c0, b0, b0, c0, d0);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const material = new THREE.ShaderMaterial({
        vertexShader: worldVert, fragmentShader: cutoutFrag, transparent: true, depthWrite: true,
        side: THREE.DoubleSide, uniforms: { map: { value: t }, opacity: { value: 1 } },
      });
      const relief = new THREE.Mesh(geo, material);
      relief.renderOrder = 2;
      content.add(relief);
      objects.push({ label: s.label, box: s.box, crop: s.crop, alpha: s.alpha, relief, material, model: null, vehicle: s.vehicle || null });
      continue;
    }
    const zS = zOf(dnS) * 0.985;
    const wW = (cw / f) * zS, hW = (ch / f) * zS;
    const X = ((x0 + cw / 2 - cx) / f) * zS;
    const Ybot = (-(y0 + ch - cy) / f) * zS;
    const pivot = new THREE.Group();
    pivot.position.set(X, Ybot, -zS);
    const geo = new THREE.PlaneGeometry(wW, hW); geo.translate(0, hW / 2, 0);
    const t = texFrom(c); textures.push(t);
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: worldVert, fragmentShader: cutoutFrag, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, uniforms: { map: { value: t }, opacity: { value: 1 } },
    }));
    mesh.renderOrder = 2;
    pivot.add(mesh);
    content.add(pivot);
    const [bx0, , bx1, by1] = s.box;
    const footY = (-(by1 - cy) / f) * zS;
    if (by1 < H - 3) {
      const sw = ((bx1 - bx0) / f) * zS * 1.25;
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(sw, sw * 0.42), new THREE.ShaderMaterial({
        vertexShader: worldVert, fragmentShader: shadowFrag, transparent: true, depthWrite: false,
        uniforms: { strength: { value: 0.32 } },
      }));
      // Lie flat on the real (levelled) ground.
      sh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, Math.cos(pitch), Math.sin(pitch)));
      sh.position.set(((bx0 + bx1) / 2 - cx) / f * zS, footY + 0.004 * zS, -zS + sw * 0.05);
      sh.renderOrder = 1;
      content.add(sh);
    }
    subjects.push({
      label: s.label, pivot, mesh, z: zS, height: ((by1 - s.box[1]) / f) * zS,
      base: Math.atan2(-X, zS), phase: Math.random() * Math.PI * 2,
    });
  }

  // Vehicles Claude described become full 3D models right away.
  let photoTex = null;
  const up = new THREE.Vector3(0, 1, 0);
  if (scene) objects.forEach((ob, i) => { if (canBuild(ob.vehicle)) attachCar(i); });

  // --- Backdrop sphere -----------------------------------------------------
  const skyRadius = calib ? 2500 : far * 6;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(skyRadius, 32, 16), new THREE.ShaderMaterial({
    vertexShader: worldVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false,
    uniforms: uniformsBase(),
  }));
  sky.renderOrder = -1;
  group.add(sky);

  // --- Claude's plan of the place ------------------------------------------
  // People and cars keep their own placement above; the plan's surfaces and
  // objects take the depth sheet's place.
  let planScene = null;
  if (planMode) {
    const nd = document.createElement('canvas'); nd.width = W; nd.height = H;
    const ndc = nd.getContext('2d');
    const ndi = ndc.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = maskWide[i] > 0.5 ? 255 : 0;
      ndi.data[i * 4] = ndi.data[i * 4 + 1] = ndi.data[i * 4 + 2] = v; ndi.data[i * 4 + 3] = 255;
    }
    ndc.putImageData(ndi, 0, 0);
    planScene = buildPlanScene(scene, { photo: photoHi || photo, noData: nd });
    group.add(planScene.group);
  }

  // --- Numbers the viewer needs -------------------------------------------
  const zs = [];
  for (let i = 0; i < dnFill.length; i += 7) zs.push(zOf(dnFill[i]));
  zs.sort((p, q) => p - q);
  const zMedian = zs[zs.length >> 1];
  // A single photo only supports a few steps before the illusion breaks.
  // Everything is scaled so the nearest content sits about 1 unit away.
  // A person very close to the lens leaves a big gap behind them when you
  // move sideways, so close-up portraits get a smaller walking area.
  // With measured depth, "1 unit" becomes the distance to the nearest content.
  const unit = calib ? clamp(zs[Math.floor(zs.length * 0.02)], 0.5, 60) : 1;
  const nearestZ = subjects.reduce((m, s) => Math.min(m, s.z / unit), Infinity);
  const room = Number.isFinite(nearestZ) ? Math.min(1, Math.max(0.4, nearestZ / 3)) : 1;
  const reach = room * unit * (withSurroundings ? 1.8 : 1);
  const bounds = planMode
    ? { minX: -0.6 * scene.extent_m, maxX: 0.6 * scene.extent_m, minZ: -0.6 * scene.extent_m, maxZ: 0.6 * scene.extent_m }
    : { minX: -0.45 * reach, maxX: 0.45 * reach, minZ: -0.9 * reach, maxZ: 0.35 * reach };

  // --- Surroundings beyond the frame --------------------------------------
  let surroundings = null;
  if (withSurroundings) {
    const toCam = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
    const inFrontOfPhoto = (pWorld) => {
      const p = pWorld.clone().applyQuaternion(toCam);
      if (p.z > -0.1) return false;
      const u = cx + (f * p.x) / -p.z, v = cy - (f * p.y) / -p.z;
      if (u < -0.08 * W || u > 1.08 * W || v < -0.08 * H || v > 1.08 * H) return false;
      const gi = Math.round(clamp(u / W, 0, 1) * (gw - 1)), gj = Math.round(clamp(v / H, 0, 1) * (gh - 1));
      return -p.z < zOf(dnFill[gj * gw + gi]) * 1.05;
    };
    surroundings = buildSurroundings(scene, { height: calib.h, inFrontOfPhoto, seed: W * 31 + H });
    group.add(surroundings.group);
  }

  // Where to stand for the diorama view, in the levelled world.
  group.updateMatrixWorld(true);
  const focus = content.localToWorld(new THREE.Vector3(0, 0, -zMedian));

  const sphere = A.main.boundingSphere.clone();
  const startQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, 0, 0, 'YXZ'));
  const camLocal = new THREE.Vector3();

  const vfovPhoto = 2 * Math.atan(H / 2 / f), hfovPhoto = 2 * Math.atan(W / 2 / f);
  // Show the whole photo when the screen allows it, but on tall phone screens
  // stop widening at 70 degrees and crop the sides instead (you can look around).
  const walkFov = (aspect) => {
    const need = 2 * Math.atan(Math.tan(hfovPhoto / 2) / aspect);
    const fov = Math.min(Math.max(vfovPhoto, need), Math.max(vfovPhoto, (70 * Math.PI) / 180));
    return (fov * 180) / Math.PI * 0.97;
  };

  function update(t, camera) {
    if (edgeMat) {
      const moved = camera.position.length() / unit;
      edgeMat.uniforms.opacity.value = 1 - THREE.MathUtils.smoothstep(moved, 0.004, 0.09);
      edgeMat.visible = edgeMat.uniforms.opacity.value > 0.003;
    }
    content.worldToLocal(camLocal.copy(camera.position));
    if (objects.length) {
      // The photo's own pixels show while you stand where it was taken; step
      // away and the generated 3D model takes over.
      const moved = camera.position.length() / unit;
      const fade = 1 - THREE.MathUtils.smoothstep(moved, 0.006, 0.08);
      for (const ob of objects) {
        if (!ob.model) continue;
        ob.material.uniforms.opacity.value = fade;
        ob.relief.visible = fade > 0.003;
        // Cross-fade: the model only appears once you step away from the photo.
        for (const m of ob.modelMats) {
          if (m.uniforms?.opacity) m.uniforms.opacity.value = 1 - fade; else m.opacity = 1 - fade;
          if (m.userData.overlay) continue;
          m.transparent = fade > 0.003; m.depthWrite = true;
        }
        ob.model.visible = fade < 0.997;
      }
    }
    for (const s of subjects) {
      const dx = camLocal.x - s.pivot.position.x, dz = camLocal.z - s.pivot.position.z;
      s.pivot.rotation.y = Math.atan2(dx, dz) - s.base;
      s.mesh.scale.y = 1 + Math.sin(t * 2.1 + s.phase) * 0.006;
    }
  }

  function dispose() {
    content.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    sky.geometry.dispose(); sky.material.dispose();
    textures.forEach(t => t.dispose());
    if (surroundings) surroundings.dispose();
    if (planScene) {
      planScene.dispose();
      // Built but never added to `content`, so the traverse above missed them.
      A.main.dispose(); if (A.edge) A.edge.dispose(); B.main.dispose(); matA.dispose(); meshB.material.dispose();
    }
  }

  // With measured depth, rest a model on the ground. Scaling about the camera
  // keeps it exactly on its outline in the photo.
  function restOnGround(matrix, points) {
    if (!calib) return matrix;
    const v = new THREE.Vector3(), ys = [];
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    for (let i = 0; i < points.n; i++) {
      v.set(points.pos[i * 3], points.pos[i * 3 + 1], points.pos[i * 3 + 2]).applyMatrix4(matrix);
      ys.push(v.y * cp + v.z * sp);
    }
    ys.sort((a, b) => a - b);
    const low = ys[Math.floor(ys.length * 0.004)];
    if (!(low < 0)) return matrix;
    const k = -calib.h / low;
    if (k < 0.6 || k > 1.6) return matrix;
    return new THREE.Matrix4().makeScale(k, k, k).multiply(matrix);
  }

  function setModel(ob, node, matrix, mats, kind) {
    if (ob.model) {
      content.remove(ob.model);
      ob.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const m of ob.modelMats) { (m.userData.textures || []).forEach((t) => t.dispose()); m.dispose(); }
    }
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(matrix);
    holder.add(node);
    content.add(holder);
    ob.model = holder; ob.modelMats = mats; ob.modelKind = kind;
    // The relief now sits on top as a fade-out layer.
    ob.material.depthTest = false;
    ob.material.depthWrite = false;
    ob.relief.renderOrder = 3;
  }

  /**
   * Build vehicle `i` from Claude's description (body style, size, colors,
   * heading), line it up with the photo and paint it with the photo.
   */
  function attachCar(i) {
    const ob = objects[i];
    const car = buildCar(ob.vehicle);
    if (!car) return null;
    const heading = ((Number(ob.vehicle.heading_deg) || 0) * Math.PI) / 180;
    let fit = fitObject({
      points: car.points, alpha: ob.alpha, crop: ob.crop, f, cx, cy, photo: px, W,
      depthAt: (u, v) => zOf(dnAt(u, v)), pitch, searchPitch: false,
      yawCenter: heading, yawSpan: (50 * Math.PI) / 180,
    });
    let matrix = null;
    if (fit && fit.iou >= 0.3 && (calib || !planMode)) {
      matrix = restOnGround(fit.matrix, car.points);
    } else if (planMode && Array.isArray(ob.vehicle.at)) {
      // The photo can't place it in metres: stand it where Claude's plan says,
      // on the plan's ground, turned to its heading (camera frame = levelled turned by the tilt).
      const [r, fw] = ob.vehicle.at;
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
      const pos = new THREE.Vector3(r, surfaceTopAt(scene, r, fw) - Number(scene.camera.height_m), -fw).applyQuaternion(tilt);
      const rot = tilt.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading));
      matrix = new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(1, 1, 1));
      fit = { ...(fit || { iou: 0, yaw: heading }), fromPlan: true };
    }
    ob.carFit = fit;
    if (!matrix) { car.geometry.dispose(); return fit; }
    const cam = { f, cx, cy, W, H };
    const depth = photoDepth(car.geometry, matrix, cam);
    // The cutout, pulled in a little so background pixels at its edge don't paint the car.
    const [x0, y0, cw, ch] = ob.crop;
    const a = Float32Array.from(ob.alpha, (v) => v / 255);
    const shrunk = rankFilter(a, cw, ch, Math.max(1, Math.round(Math.max(cw, ch) / 160)), 'min');
    const m8 = Uint8Array.from(shrunk, (v) => Math.round(v * 255));
    const maskTex = new THREE.DataTexture(m8, cw, ch, THREE.RedFormat);
    maskTex.unpackAlignment = 1; maskTex.minFilter = maskTex.magFilter = THREE.LinearFilter; maskTex.needsUpdate = true;
    textures.push(maskTex);
    const seen = (u, v) => {
      const x = Math.floor(u) - x0, y = Math.floor(v) - y0;
      if (x < 0 || y < 0 || x >= cw || y >= ch || m8[y * cw + x] < 200) return null;
      const p = (Math.floor(v) * W + Math.floor(u)) * 4;
      return [px[p], px[p + 1], px[p + 2]];
    };
    matchPaint(car, matrix, cam, depth, seen);
    if (!photoTex) {
      photoTex = new THREE.DataTexture(new Uint8Array(px), W, H, THREE.RGBAFormat);
      photoTex.colorSpace = THREE.NoColorSpace;
      photoTex.minFilter = photoTex.magFilter = THREE.LinearFilter;
      photoTex.needsUpdate = true;
      textures.push(photoTex);
    }
    const mat = carMaterial({ photoTex, depth, maskTex, matrix, cam, crop: ob.crop, up });
    const node = new THREE.Group();
    const shadow = carShadow(car.size);
    node.add(new THREE.Mesh(car.geometry, mat), shadow);
    setModel(ob, node, matrix, [mat, shadow.material], 'claude');
    return fit;
  }

  /**
   * Replace vehicle `i` with a generated 3D model (a loaded glTF scene from
   * SAM 3D). Returns the fit (with its silhouette match), or null if it didn't fit.
   */
  function attachModel(i, root) {
    const ob = objects[i];
    if (!ob || ob.modelKind === 'fal') return null;
    const points = samplePoints(root);
    const fit = fitObject({
      points, alpha: ob.alpha, crop: ob.crop, f, cx, cy, photo: px, W,
      depthAt: (u, v) => zOf(dnAt(u, v)), pitch, searchPitch: !scene,
    });
    if (!fit || fit.iou < 0.3) return fit;
    const modelMats = [];
    root.traverse((m) => {
      if (!m.isMesh) return;
      const old = m.material;
      const map = old.map || null;
      if (map) map.colorSpace = THREE.SRGBColorSpace;
      const C = m.geometry.attributes.color;
      if (C) {
        // The vertex colors are sRGB values; three.js expects linear ones.
        const c = new THREE.Color();
        for (let i = 0; i < C.count; i++) {
          c.setRGB(C.getX(i), C.getY(i), C.getZ(i), THREE.SRGBColorSpace);
          C.setXYZ(i, c.r, c.g, c.b);
        }
        C.needsUpdate = true;
      }
      // Unlit: the model's colors already carry the photo's lighting.
      const mat = new THREE.MeshBasicMaterial({ vertexColors: Boolean(C), map, side: THREE.DoubleSide, transparent: true, opacity: 0 });
      m.material = mat;
      modelMats.push(mat);
      old.dispose?.();
    });
    setModel(ob, root, restOnGround(fit.matrix, points), modelMats, 'fal');
    return fit;
  }

  return {
    group, update, dispose, attachModel,
    prepare: (renderer) => { if (planScene) planScene.prepare(renderer); },
    planScene,
    models: () => objects.filter((o) => o.model).map((o) => o.model),
    info: {
      width: W, height: H, near, far, zMedian, bounds, sphere, walkFov: planMode ? () => 70 : walkFov, startQuat, focus,
      speed: planMode ? 2 : 0.42 * room * unit,
      triangles: A.tris + B.tris,
      subjects: [...subjects.map(s => s.label), ...objects.map(o => o.label)],
      objects: objects.map((o) => ({ label: o.label, box: o.box, crop: o.crop, alpha: o.alpha, built: o.modelKind === 'claude', name: (o.vehicle && String(o.vehicle.make_model || '').slice(0, 40)) || '', fit: o.carFit ? { iou: o.carFit.iou, yaw: o.carFit.yaw, fromPlan: Boolean(o.carFit.fromPlan) } : null })),
      measured: Boolean(calib), calib, levelled: Boolean(scene), surroundings: withSurroundings,
      plan: planMode,
      caption: scene?.caption || '',
    },
    fog: planScene ? planScene.fog : surroundings ? surroundings.fog : null,
  };
}
