// Turns a photo + its scan into a small 3D world.
//
//   Layer A  the photo as a depth-displaced sheet, torn apart at depth edges
//   Layer B  a "far side" sheet behind every edge, so tears show plausible
//            background instead of holes
//   Subjects each person or pet becomes a cutout standing at their depth,
//            turning to face you, with a soft contact shadow
//   Backdrop a sky/ground gradient sampled from the photo's own colors

import * as THREE from 'three';
import { pullPush, fillCloned, rankFilter, boxBlur, resample, percentile } from './fill.js';

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
  uniform sampler2D map; uniform float edge; uniform float shade; uniform float opacity;
  varying vec2 vUv; varying vec3 vWorld;
  ${backdropFn}
  void main() {
    vec3 col = texture2D(map, vUv).rgb * shade;
    float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float f = smoothstep(0.0, edge, e);
    vec3 d = normalize(vWorld - cameraPosition);
    gl_FragColor = vec4(mix(backdrop(d), col, f), opacity);
  }`;

const skyFrag = /* glsl */`
  varying vec3 vWorld;
  ${backdropFn}
  void main() { gl_FragColor = vec4(backdrop(normalize(vWorld - cameraPosition)), 1.0); }`;

const cutoutFrag = /* glsl */`
  uniform sampler2D map; varying vec2 vUv;
  void main() {
    vec4 c = texture2D(map, vUv);
    if (c.a < 0.02) discard;
    gl_FragColor = c;
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
 * @param {{strength?: number}} opts  depth strength, 0.5 (flat) to 2 (deep)
 */
export function buildWorld(scan, photo, { strength = 1 } = {}) {
  const W = scan.width, H = scan.height;
  const L = Math.max(W, H);
  const f = (L / 2) / Math.tan((FOV_LONG_DEG * Math.PI) / 360);
  const cx = W / 2, cy = H / 2;
  const near = 1, far = Math.pow(12, strength);
  const zOf = (dn) => 1 / (1 / far + dn * (1 / near - 1 / far));

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
  const cTop = avgRows(px, W, H, 0, H * 0.08);
  const cBottom = avgRows(px, W, H, H * 0.92, H).multiplyScalar(0.8);
  const cHorizon = avgRows(px, W, H, H * 0.35, H * 0.65).lerp(cTop, 0.35);
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

  const group = new THREE.Group();
  const textures = [];
  const worldMat = (canvas, shade, extra = {}) => {
    const t = texFrom(canvas); textures.push(t);
    return new THREE.ShaderMaterial({
      vertexShader: worldVert, fragmentShader: worldFrag, side: THREE.DoubleSide,
      uniforms: { map: { value: t }, edge: { value: 0.05 }, shade: { value: shade }, opacity: { value: 1 }, ...uniformsBase() },
      ...extra,
    });
  };
  const matA = worldMat(texACanvas, 1);
  const meshA = new THREE.Mesh(A.main, matA);
  const meshB = new THREE.Mesh(B.main, worldMat(texBCanvas, 0.94));
  group.add(meshB, meshA);
  // Torn triangles keep the photo pixel-perfect from where it was taken,
  // then dissolve as soon as you move, revealing layer B.
  let edgeMat = null;
  if (A.edge) {
    edgeMat = new THREE.ShaderMaterial({
      vertexShader: worldVert, fragmentShader: worldFrag, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      uniforms: { ...matA.uniforms, opacity: { value: 1 } },
    });
    const meshE = new THREE.Mesh(A.edge, edgeMat);
    meshE.renderOrder = 1;
    group.add(meshE);
  }

  // --- Subjects ------------------------------------------------------------
  const subjects = [];
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
      side: THREE.DoubleSide, uniforms: { map: { value: t } },
    }));
    mesh.renderOrder = 2;
    pivot.add(mesh);
    group.add(pivot);
    const [bx0, , bx1, by1] = s.box;
    const footY = (-(by1 - cy) / f) * zS;
    if (by1 < H - 3) {
      const sw = ((bx1 - bx0) / f) * zS * 1.25;
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(sw, sw * 0.42), new THREE.ShaderMaterial({
        vertexShader: worldVert, fragmentShader: shadowFrag, transparent: true, depthWrite: false,
        uniforms: { strength: { value: 0.32 } },
      }));
      sh.rotation.x = -Math.PI / 2;
      sh.position.set(((bx0 + bx1) / 2 - cx) / f * zS, footY + 0.004 * zS, -zS + sw * 0.05);
      sh.renderOrder = 1;
      group.add(sh);
    }
    subjects.push({
      label: s.label, pivot, mesh, z: zS, height: ((by1 - s.box[1]) / f) * zS,
      base: Math.atan2(-X, zS), phase: Math.random() * Math.PI * 2,
    });
  }

  // --- Backdrop sphere -----------------------------------------------------
  const sky = new THREE.Mesh(new THREE.SphereGeometry(far * 6, 32, 16), new THREE.ShaderMaterial({
    vertexShader: worldVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false,
    uniforms: uniformsBase(),
  }));
  sky.renderOrder = -1;
  group.add(sky);

  // --- Numbers the viewer needs -------------------------------------------
  const zs = [];
  for (let i = 0; i < dnFill.length; i += 7) zs.push(zOf(dnFill[i]));
  zs.sort((p, q) => p - q);
  const zMedian = zs[zs.length >> 1];
  // A single photo only supports a few steps before the illusion breaks.
  // Everything is scaled so the nearest content sits about 1 unit away.
  // A person very close to the lens leaves a big gap behind them when you
  // move sideways, so close-up portraits get a smaller walking area.
  const nearestZ = subjects.reduce((m, s) => Math.min(m, s.z), Infinity);
  const room = Number.isFinite(nearestZ) ? Math.min(1, Math.max(0.4, nearestZ / 3)) : 1;
  const bounds = { minX: -0.45 * room, maxX: 0.45 * room, minZ: -0.9 * room, maxZ: 0.35 * room };

  const sphere = A.main.boundingSphere.clone();

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
      const moved = camera.position.length();
      edgeMat.uniforms.opacity.value = 1 - THREE.MathUtils.smoothstep(moved, 0.004, 0.09);
      edgeMat.visible = edgeMat.uniforms.opacity.value > 0.003;
    }
    for (const s of subjects) {
      const dx = camera.position.x - s.pivot.position.x, dz = camera.position.z - s.pivot.position.z;
      s.pivot.rotation.y = Math.atan2(dx, dz) - s.base;
      s.mesh.scale.y = 1 + Math.sin(t * 2.1 + s.phase) * 0.006;
    }
  }

  function dispose() {
    group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    textures.forEach(t => t.dispose());
  }

  return {
    group, update, dispose,
    info: {
      width: W, height: H, near, far, zMedian, bounds, sphere, walkFov,
      speed: 0.42 * room,
      triangles: A.tris + B.tris,
      subjects: subjects.map(s => s.label),
    },
  };
}
