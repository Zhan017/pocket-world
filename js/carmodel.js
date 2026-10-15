// A 3D vehicle built from Claude's description of it (body style, size,
// colors), then painted with the photo wherever the photo saw it.
//
// Cars are left-right symmetric, so the side the photo didn't see is painted
// with the mirrored pixels of the side it did see. What neither side shows
// (usually the back) keeps the modelled paint, glass, lights and plate.

import * as THREE from 'three';

const rgb = (s, d) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
  const n = parseInt(m ? m[1] : d, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

// Side profiles run from the rear bumper (t = 0) to the front bumper (t = 1).
// top: [t, height as a fraction of the full height, what the stretch that
// starts here is: b body, r roof, g glass, d open load bed].
// size: default length, width, height (m). belt: bottom of the side windows.
// clr: ground clearance. axles: wheel positions (t). r: wheel radius.
// inset: roof width relative to the body. side: where the side windows run (t),
// pillars: door pillars inside that stretch (t).
const STYLES = {
  sedan: { size: [4.7, 1.82, 1.45], belt: 0.64, clr: 0.1, axles: [0.2, 0.8], r: 0.22, inset: 0.78, side: [0.3, 0.77], pillars: [0.53],
    top: [[0, 0.55, 'b'], [0.03, 0.63, 'b'], [0.17, 0.67, 'g'], [0.33, 0.97, 'r'], [0.37, 1, 'r'], [0.58, 1, 'r'], [0.62, 0.97, 'g'], [0.78, 0.67, 'b'], [0.97, 0.6, 'b'], [1, 0.53, 'b']] },
  hatchback: { size: [4.1, 1.78, 1.47], belt: 0.62, clr: 0.1, axles: [0.19, 0.81], r: 0.22, inset: 0.78, side: [0.15, 0.78], pillars: [0.48],
    top: [[0, 0.56, 'b'], [0.02, 0.62, 'g'], [0.09, 0.96, 'r'], [0.13, 1, 'r'], [0.6, 1, 'r'], [0.64, 0.97, 'g'], [0.79, 0.65, 'b'], [0.97, 0.58, 'b'], [1, 0.5, 'b']] },
  wagon: { size: [4.8, 1.84, 1.5], belt: 0.62, clr: 0.1, axles: [0.2, 0.8], r: 0.22, inset: 0.8, side: [0.09, 0.78], pillars: [0.27, 0.5],
    top: [[0, 0.56, 'b'], [0.02, 0.62, 'g'], [0.05, 0.95, 'r'], [0.08, 1, 'r'], [0.6, 1, 'r'], [0.64, 0.97, 'g'], [0.79, 0.65, 'b'], [0.97, 0.58, 'b'], [1, 0.5, 'b']] },
  suv: { size: [4.5, 1.86, 1.68], belt: 0.6, clr: 0.13, axles: [0.19, 0.82], r: 0.21, inset: 0.82, cladding: true, side: [0.1, 0.81], pillars: [0.27, 0.52],
    top: [[0, 0.6, 'b'], [0.015, 0.63, 'g'], [0.06, 0.96, 'r'], [0.09, 1, 'r'], [0.65, 1, 'r'], [0.69, 0.97, 'g'], [0.82, 0.66, 'b'], [0.98, 0.61, 'b'], [1, 0.56, 'b']] },
  coupe: { size: [4.5, 1.84, 1.33], belt: 0.62, clr: 0.09, axles: [0.2, 0.79], r: 0.24, inset: 0.76, side: [0.3, 0.75],
    top: [[0, 0.56, 'b'], [0.03, 0.63, 'b'], [0.13, 0.66, 'g'], [0.37, 0.97, 'r'], [0.41, 1, 'r'], [0.55, 1, 'r'], [0.59, 0.97, 'g'], [0.76, 0.65, 'b'], [0.97, 0.57, 'b'], [1, 0.5, 'b']] },
  convertible: { size: [4.4, 1.8, 1.3], belt: 0.66, clr: 0.1, axles: [0.2, 0.79], r: 0.24, inset: 0.8, side: [0, 0],
    top: [[0, 0.58, 'b'], [0.04, 0.66, 'b'], [0.3, 0.7, 'd'], [0.595, 0.7, 'g'], [0.6, 1, 'g'], [0.66, 0.72, 'b'], [0.97, 0.62, 'b'], [1, 0.55, 'b']] },
  pickup: { size: [5.4, 1.95, 1.85], belt: 0.6, clr: 0.14, axles: [0.17, 0.82], r: 0.21, inset: 0.84, side: [0.42, 0.79], pillars: [0.6], cladding: true,
    top: [[0, 0.58, 'd'], [0.37, 0.58, 'b'], [0.385, 0.64, 'g'], [0.41, 0.97, 'r'], [0.43, 1, 'r'], [0.66, 1, 'r'], [0.69, 0.97, 'g'], [0.8, 0.66, 'b'], [0.98, 0.61, 'b'], [1, 0.56, 'b']] },
  van: { size: [5.1, 1.95, 1.95], belt: 0.52, clr: 0.09, axles: [0.17, 0.82], r: 0.17, inset: 0.95, win: 0.85, side: [0.05, 0.92], pillars: [0.36, 0.62, 0.8],
    top: [[0, 0.96, 'r'], [0.02, 1, 'r'], [0.8, 1, 'r'], [0.84, 0.96, 'g'], [0.93, 0.6, 'b'], [0.99, 0.52, 'b'], [1, 0.48, 'b']] },
  bus: { size: [12, 2.55, 3.1], belt: 0.4, clr: 0.1, axles: [0.25, 0.82], r: 0.16, inset: 0.98, win: 0.67, big: true, side: [0.02, 0.98], pillars: [0.12, 0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92],
    top: [[0, 0.97, 'r'], [0.01, 1, 'r'], [0.99, 1, 'r'], [1, 0.97, 'r']] },
  truck: { size: [7.5, 2.5, 3.3], belt: 0.5, clr: 0.12, axles: [0.18, 0.86], r: 0.16, inset: 0.97, side: [0.8, 0.97], win: 0.85, big: true,
    top: [[0, 1, 'r'], [0.74, 1, 'b'], [0.755, 0.83, 'r'], [0.95, 0.83, 'g'], [0.995, 0.52, 'b'], [1, 0.5, 'b']] },
};
const ALIAS = { crossover: 'suv', minivan: 'van', other: 'sedan', car: 'sedan' };
const PART = { body: 'b', glass: 'g', roof: 'r', open: 'd' };

// Claude's own side profile for the model, if it is usable: t from 0 to 1,
// heights scaled so the roof is 1.
function customProfile(p) {
  if (!Array.isArray(p) || p.length < 5 || p.length > 30) return null;
  const pts = p.map((q) => [Number(q?.t), Number(q?.h), PART[q?.part] || 'b'])
    .filter(([t, h]) => Number.isFinite(t) && Number.isFinite(h)).sort((a, b) => a[0] - b[0]);
  if (pts.length < 5) return null;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], hmax = Math.max(...pts.map((q) => q[1]));
  if (t0 > 0.1 || t1 < 0.9 || !(hmax > 0.2)) return null;
  const out = [];
  for (const [t, h, g] of pts) {
    let tt = clamp((t - t0) / (t1 - t0), 0, 1);
    if (out.length && tt <= out[out.length - 1][0]) tt = Math.min(1, out[out.length - 1][0] + 0.002);
    out.push([tt, clamp(h / hmax, 0.25, 1), g]);
  }
  // A real roof or windscreen has to reach the top somewhere in the middle.
  if (!out.some(([t, h]) => h > 0.95 && t > 0.15 && t < 0.9)) return null;
  return out;
}

export const canBuild = (desc) => Boolean(desc && STYLES[ALIAS[desc.body_style] || desc.body_style]);

// Kinds (for repainting from the photo later): 0 body, 1 roof, 2 everything else.
const KIND_BODY = 0, KIND_ROOF = 1, KIND_OTHER = 2;

/**
 * Build the vehicle in its own frame: x to its right, y up, z toward its
 * front, wheels on y = 0. Returns null for styles it can't build.
 */
export function buildCar(desc = {}) {
  const key = ALIAS[desc.body_style] || desc.body_style;
  if (!STYLES[key]) return null;
  const S = { ...STYLES[key] };
  const custom = S.big ? null : customProfile(desc.profile);
  if (custom) S.top = custom;
  const num = (v) => (Number.isFinite(+v) ? +v : NaN);
  if (num(desc.belt_h) >= 0.4 && num(desc.belt_h) <= 0.8) S.belt = num(desc.belt_h);
  const ar = num(desc.axle_rear_t), af = num(desc.axle_front_t);
  if (ar >= 0.06 && ar <= 0.4 && af >= 0.6 && af <= 0.94) S.axles = [ar, af];
  const ro = clamp(Number.isFinite(num(desc.roundness)) ? num(desc.roundness) : 0.3, 0, 1);
  const pick = (v, d) => (Number.isFinite(+v) && +v > 0 ? clamp(+v, d * 0.65, d * 1.5) : d);
  const L = pick(desc.length_m, S.size[0]), Wd = pick(desc.width_m, S.size[1]), H = pick(desc.height_m, S.size[2]);
  const C = {
    body: rgb(desc.body_color, 'b4b8bc'),
    roof: rgb(desc.roof_color || desc.body_color, 'b4b8bc'),
    trim: rgb(desc.trim_color, '25282b'),
    rim: rgb(desc.wheel_color, '9ca2a8'),
    glass: [0.1, 0.12, 0.14], tire: [0.07, 0.07, 0.075], under: [0.06, 0.065, 0.07],
    plate: [0.9, 0.91, 0.89], head: [0.66, 0.71, 0.76], tail: [0.6, 0.05, 0.07], tailHi: [0.85, 0.12, 0.12],
    grille: [0.07, 0.075, 0.08], bed: [0.12, 0.12, 0.13],
  };
  const pos = [], nrm = [], col = [], gloss = [], kind = [];
  const push = (p, n, c, g, k) => { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); col.push(c[0], c[1], c[2]); gloss.push(g); kind.push(k); };
  const tri = (a, b, c, na, nb, nc, color, g, k) => { push(a, na, color, g, k); push(b, nb, color, g, k); push(c, nc, color, g, k); };
  const quad = (a, b, c, d, n, color, g, k) => { tri(a, b, c, n, n, n, color, g, k); tri(a, c, d, n, n, n, color, g, k); };

  // --- Profile helpers ----------------------------------------------------
  const tops = S.top;
  const lin = (t) => {
    for (let i = 0; i < tops.length - 1; i++) {
      const [t0, h0] = tops[i], [t1, h1] = tops[i + 1];
      if (t <= t1) return h0 + (h1 - h0) * clamp((t - t0) / Math.max(1e-6, t1 - t0), 0, 1);
    }
    return tops[tops.length - 1][1];
  };
  // Round the profile's corners, more for rounder cars.
  // Glass and open parts stay crisp (a windscreen is thin).
  const NP = 200, prof = Float32Array.from({ length: NP + 1 }, (_, i) => lin(i / NP));
  const tagAtLin = (t) => { let g = tops[0][2]; for (const k of tops) if (k[0] <= t) g = k[2]; return g; };
  const soft = Uint8Array.from({ length: NP + 1 }, (_, i) => (/[br]/.test(tagAtLin(i / NP)) && /[br]/.test(tagAtLin(Math.max(0, i - 1) / NP)) ? 1 : 0));
  for (let pass = 0, rr = Math.round(1 + 4 * ro); pass < 2; pass++) {
    const src = prof.slice();
    for (let i = 0; i <= NP; i++) {
      let sum = 0, n = 0, ok = true;
      for (let k = -rr; k <= rr; k++) { const j = i + k; if (j >= 0 && j <= NP) { sum += src[j]; n++; if (!soft[j]) ok = false; } }
      if (ok) prof[i] = sum / n;
    }
  }
  const topAt = (t) => { const x = clamp(t, 0, 1) * NP, i = Math.min(NP - 1, Math.floor(x)); return prof[i] + (prof[i + 1] - prof[i]) * (x - i); };
  const tagAt = (t) => { let g = tops[0][2]; for (const k of tops) if (k[0] <= t) g = k[2]; return g; };
  let sideRange = S.side || [0, 1], pillarList = S.pillars || [];
  if (custom) {
    // Side windows wherever the cabin is tall enough, less the pillars at each end.
    const ok = [];
    for (let t = 0; t <= 1; t += 0.005) if (topAt(t) - S.belt > 0.35 * (1 - S.belt) && tagAt(t) !== 'd') ok.push(t);
    const a = ok.length ? ok[0] + 0.03 : 1, b = ok.length ? ok[ok.length - 1] - 0.025 : 0, len = b - a;
    sideRange = len > 0.05 ? [a, b] : [0, 0];
    pillarList = len > 0.55 ? [a + len / 3, a + (2 * len) / 3] : len > 0.3 ? [a + len * 0.48] : [];
  }
  const pillarHalf = 0.05 / L;
  const isWindow = (t) => t >= sideRange[0] && t <= sideRange[1] && !pillarList.some((p) => Math.abs(t - p) < pillarHalf);
  const beltY = S.belt * H, win = S.win || 0.88;
  const endZone = 0.06 + 0.14 * ro, endW = 0.86 - 0.22 * ro;
  const hwAt = (t) => (Wd / 2) * (endW + (1 - endW) * Math.sqrt(clamp(Math.min(t, 1 - t) / endZone, 0, 1)));
  const botAt = (t) => S.clr * H * (1 + 0.8 * (1 - smooth(Math.min(t, 1 - t) / 0.06)));

  // Section at t: 5 points up the right side, then mirrored down the left.
  const section = (t) => {
    const hw = hwAt(t), topY = topAt(t) * H, bot = botAt(t);
    const p2y = Math.min(beltY, topY - 0.035 * H);
    const g = clamp((topY - beltY) / (H - beltY), 0, 1);
    const p4x = hw * Math.min(0.92 - 0.1 * ro, 0.97 - (0.97 - S.inset) * g);
    const p2 = [hw * 0.97, p2y], p4 = [p4x, topY];
    const p3 = [p2[0] + (p4[0] - p2[0]) * win, p2[1] + (p4[1] - p2[1]) * win];
    const p1 = [hw, bot + 0.45 * (p2y - bot)], p0 = [hw * (0.9 - 0.12 * ro), bot];
    const right = [p0, p1, p2, p3, p4];
    return [...right, ...right.slice().reverse().map(([x, y]) => [-x, y])];
  };
  const NS = 10;

  // --- Stations along the length ------------------------------------------
  const ts = new Set();
  for (let i = 0; i <= 90; i++) ts.add(+(i / 90).toFixed(5));
  for (const k of tops) ts.add(k[0]);
  for (const p of pillarList) { ts.add(+(p - pillarHalf).toFixed(5)); ts.add(+(p + pillarHalf).toFixed(5)); }
  for (const p of sideRange) ts.add(+p.toFixed(5));
  const T = [...ts].sort((a, b) => a - b);
  const G = T.map((t) => section(t).map(([x, y]) => [x, y, (t - 0.5) * L]));
  const N = G.map((row, i) => row.map((p, j) => {
    const a = G[Math.max(0, i - 1)][j], b = G[Math.min(G.length - 1, i + 1)][j];
    const c = row[(j + NS - 1) % NS], d = row[(j + 1) % NS];
    const st = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const sc = new THREE.Vector3(d[0] - c[0], d[1] - c[1], d[2] - c[2]);
    const n = new THREE.Vector3().crossVectors(sc, st).normalize();
    return [n.x, n.y, n.z];
  }));

  for (let i = 0; i < T.length - 1; i++) {
    const tm = (T[i] + T[i + 1]) / 2;
    const tag = tagAt(tm);
    const green = Math.min(topAt(T[i]), topAt(T[i + 1])) * H - beltY > 0.04 * H && isWindow(tm);
    for (let j = 0; j < NS; j++) {
      const e = j;                      // edge from point j to j+1
      let c = C.body, g = 0.55, k = KIND_BODY;
      if (e === 0 || e === 8) { if (S.cladding) { c = C.trim; g = 0.1; k = KIND_OTHER; } }
      else if (e === 2 || e === 6) { if (green) { c = C.glass; g = 1; k = KIND_OTHER; } }
      else if (e === 3 || e === 5) { if (green) { c = C.roof; k = KIND_ROOF; } }
      else if (e === 4) {
        if (tag === 'g') { c = C.glass; g = 1; k = KIND_OTHER; }
        else if (tag === 'r') { c = C.roof; k = KIND_ROOF; }
        else if (tag === 'd') { c = C.bed; g = 0.05; k = KIND_OTHER; }
      } else if (e === 9) { c = C.under; g = 0; k = KIND_OTHER; }
      const j2 = (j + 1) % NS;
      const A = G[i][j], B = G[i][j2], Cc = G[i + 1][j2], D = G[i + 1][j];
      tri(A, B, Cc, N[i][j], N[i][j2], N[i + 1][j2], c, g, k);
      tri(A, Cc, D, N[i][j], N[i + 1][j2], N[i + 1][j], c, g, k);
    }
  }
  // End caps.
  const cap = (row, dir) => {
    const cxy = row.reduce((s, p) => [s[0] + p[0] / NS, s[1] + p[1] / NS], [0, 0]);
    const mid = [cxy[0], cxy[1], row[0][2]], n = [0, 0, dir];
    for (let j = 0; j < NS; j++) {
      const a = row[j], b = row[(j + 1) % NS];
      if (dir > 0) tri(mid, b, a, n, n, n, C.body, 0.55, KIND_BODY); else tri(mid, a, b, n, n, n, C.body, 0.55, KIND_BODY);
    }
  };
  cap(G[0], -1);
  cap(G[G.length - 1], 1);

  // --- Lights, grille, plates ----------------------------------------------
  const rect = (zEnd, x0, x1, y0, y1, color, g) => {
    const z = zEnd > 0 ? L / 2 + 0.006 : -L / 2 - 0.006, n = [0, 0, Math.sign(zEnd)];
    const a = [x0, y0, z], b = [x1, y0, z], c = [x1, y1, z], d = [x0, y1, z];
    if (zEnd > 0) quad(a, b, c, d, n, color, g, KIND_OTHER); else quad(b, a, d, c, n, color, g, KIND_OTHER);
  };
  const pair = (zEnd, xa, xb, y0, y1, color, g) => { rect(zEnd, xa, xb, y0, y1, color, g); rect(zEnd, -xb, -xa, y0, y1, color, g); };
  for (const end of [1, -1]) {
    const t = end > 0 ? 1 : 0, capTop = topAt(t) * H, bot = botAt(t), half = hwAt(t) * 0.88;
    const h = (f) => bot + f * (capTop - bot);
    const plateW = Math.min(0.26, half * 0.32);
    if (S.big) {
      const yh = (f) => f * H;
      if (end > 0) {
        if (key === 'bus') rect(end, -half * 0.94, half * 0.94, beltY, yh(0.93), C.glass, 1);
        else rect(end, -half * 0.7, half * 0.7, yh(0.24), yh(0.4), C.grille, 0.2);
        pair(end, half * 0.6, half * 0.94, yh(0.17), yh(0.24), C.head, 1);
      } else {
        if (key === 'bus') rect(end, -half * 0.8, half * 0.8, yh(0.62), yh(0.92), C.glass, 1);
        else { rect(end, -0.012, 0.012, yh(0.2), yh(0.95), C.trim, 0.1); }
        pair(end, half * 0.72, half * 0.95, yh(0.22), yh(0.3), C.tail, 0.8);
      }
      rect(end, -plateW, plateW, yh(0.1), yh(0.15), C.plate, 0.3);
      continue;
    }
    if (end > 0) {
      pair(end, half * 0.55, half * 0.95, h(0.62), h(0.84), C.head, 1);
      rect(end, -half * 0.45, half * 0.45, h(0.36), h(0.6), C.grille, 0.2);
      rect(end, -plateW, plateW, h(0.2), h(0.33), C.plate, 0.3);
      rect(end, -half * 0.6, half * 0.6, h(0.04), h(0.15), C.trim, 0.1);
    } else {
      const style = desc.taillight_style || 'corner';
      if (key === 'van') {
        pair(end, half * 0.08, half * 0.84, h(0.62), h(0.9), C.glass, 1);
        pair(end, half * 0.86, half * 0.98, h(0.3), h(0.6), C.tail, 0.8);
      } else if (style === 'vertical') pair(end, half * 0.8, half * 0.97, h(0.42), h(0.9), C.tail, 0.8);
      else if (style === 'wide') pair(end, half * 0.35, half * 0.96, h(0.66), h(0.82), C.tail, 0.8);
      else {
        pair(end, half * 0.6, half * 0.96, h(0.62), h(0.84), C.tail, 0.8);
        if (style === 'light_bar') rect(end, -half * 0.6, half * 0.6, h(0.72), h(0.77), C.tailHi, 0.8);
      }
      rect(end, -plateW, plateW, h(0.38), h(0.52), C.plate, 0.3);
      rect(end, -half * 0.92, half * 0.92, h(0.02), h(0.16), C.trim, 0.1);
    }
  }

  // --- Wheels, arches, mirrors --------------------------------------------
  const wd = num(desc.wheel_diameter_m);
  const r = wd >= 0.45 && wd <= 1.4 ? clamp(wd / 2, 0.15 * H, 0.3 * H) : S.r * H;
  const tw = clamp(Wd * 0.12, 0.18, 0.32), SEG = 28;
  const disc = (x, yc, zc, r0, r1, dir, color, g) => {
    const n = [dir, 0, 0];
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2, a1 = ((s + 1) / SEG) * Math.PI * 2;
      const P = (rr, a) => [x, yc + rr * Math.cos(a), zc + rr * Math.sin(a)];
      if (r0 <= 0) { if (dir > 0) tri([x, yc, zc], P(r1, a0), P(r1, a1), n, n, n, color, g, KIND_OTHER); else tri([x, yc, zc], P(r1, a1), P(r1, a0), n, n, n, color, g, KIND_OTHER); }
      else if (dir > 0) quad(P(r0, a0), P(r1, a0), P(r1, a1), P(r0, a1), n, color, g, KIND_OTHER);
      else quad(P(r0, a1), P(r1, a1), P(r1, a0), P(r0, a0), n, color, g, KIND_OTHER);
    }
  };
  const arch = (x, yc, zc, ra, dir) => {
    const n = [dir, 0, 0];
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2, a1 = ((s + 1) / SEG) * Math.PI * 2;
      if (Math.cos(a0) < -0.15 && Math.cos(a1) < -0.15) continue;   // nothing below the axle
      const P = (a) => [x, yc + ra * Math.cos(a), zc + ra * Math.sin(a)];
      if (dir > 0) tri([x, yc, zc], P(a0), P(a1), n, n, n, C.under, 0, KIND_OTHER); else tri([x, yc, zc], P(a1), P(a0), n, n, n, C.under, 0, KIND_OTHER);
    }
  };
  for (const ta of S.axles) {
    const zc = (ta - 0.5) * L, hw = hwAt(ta);
    for (const side of [1, -1]) {
      const xo = side * (hw + 0.012), xi = side * (hw + 0.012 - tw);
      // Arch: a dark band on the body above the tire.
      arch(side * (hw * 0.985 + 0.004), r, zc, r * 1.14, side);
      for (let s = 0; s < SEG; s++) {
        const a0 = (s / SEG) * Math.PI * 2, a1 = ((s + 1) / SEG) * Math.PI * 2;
        const P = (x, a) => [x, r + r * Math.cos(a), zc + r * Math.sin(a)];
        const n0 = [0, Math.cos(a0), Math.sin(a0)], n1 = [0, Math.cos(a1), Math.sin(a1)];
        if (side > 0) { tri(P(xi, a0), P(xo, a0), P(xo, a1), n0, n0, n1, C.tire, 0, KIND_OTHER); tri(P(xi, a0), P(xo, a1), P(xi, a1), n0, n1, n1, C.tire, 0, KIND_OTHER); }
        else { tri(P(xo, a0), P(xi, a0), P(xi, a1), n0, n0, n1, C.tire, 0, KIND_OTHER); tri(P(xo, a0), P(xi, a1), P(xo, a1), n0, n1, n1, C.tire, 0, KIND_OTHER); }
      }
      disc(xo, r, zc, r * 0.68, r, side, C.tire, 0);
      disc(xo - side * 0.012, r, zc, 0, r * 0.68, side, C.rim, 0.7);
      disc(xo - side * 0.008, r, zc, 0, r * 0.2, side, C.trim, 0.3);
      disc(xi, r, zc, 0, r, -side, C.tire, 0);
    }
  }
  if (!S.big && key !== 'van') {
    // Door mirrors just ahead of the windscreen's base.
    let tA = 0.75;
    for (let i = tops.length - 2; i >= 0; i--) if (tops[i][2] === 'g') { tA = tops[i + 1][0]; break; }
    const zc = (tA - 0.5 - 0.02) * L, y0 = beltY + 0.01 * H, y1 = y0 + 0.13, hw = hwAt(tA);
    for (const side of [1, -1]) {
      const xa = side * hw * 0.96, xb = side * (hw + 0.17);
      const zf = zc + 0.06, zb = zc - 0.12;
      const box = [[xa, y0, zb], [xb, y0, zb], [xb, y1, zb], [xa, y1, zb], [xa, y0, zf], [xb, y0, zf], [xb, y1, zf], [xa, y1, zf]];
      // Winding doesn't matter (double-sided); the normals carry the lighting.
      const F = (a, b, c, d, n) => quad(box[a], box[b], box[c], box[d], n, C.body, 0.55, KIND_BODY);
      F(4, 5, 6, 7, [0, 0, 1]); F(1, 0, 3, 2, [0, 0, -1]); F(3, 7, 6, 2, [0, 1, 0]); F(0, 1, 5, 4, [0, -1, 0]); F(5, 1, 2, 6, [side, 0, 0]);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('gloss', new THREE.Float32BufferAttribute(gloss, 1));
  geo.computeBoundingSphere();
  return { geometry: geo, kind: Uint8Array.from(kind), colors: C, size: [L, Wd, H], points: surfacePoints(pos, 4000) };
}

/** Points spread evenly over the surface (for fitting the silhouette). */
function surfacePoints(pos, n) {
  const nt = pos.length / 9, area = new Float64Array(nt);
  let total = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < nt; i++) {
    a.fromArray(pos, i * 9); b.fromArray(pos, i * 9 + 3); c.fromArray(pos, i * 9 + 6);
    total += b.sub(a).cross(c.sub(a)).length() / 2;
    area[i] = total;
  }
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = new Float32Array(n * 3), col = new Float32Array(n * 3).fill(-1);
  for (let k = 0; k < n; k++) {
    const x = rnd() * total;
    let lo = 0, hi = nt - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (area[m] < x) lo = m + 1; else hi = m; }
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    for (let d = 0; d < 3; d++) {
      const p0 = pos[lo * 9 + d], p1 = pos[lo * 9 + 3 + d], p2 = pos[lo * 9 + 6 + d];
      out[k * 3 + d] = p0 + u * (p1 - p0) + v * (p2 - p0);
    }
  }
  return { pos: out, col, n };
}

/**
 * Depth of the model as the photo's camera sees it: for each pixel of a
 * small map, the distance (-z) of the nearest surface. Used to tell which
 * parts of the model the photo actually saw.
 */
export function photoDepth(geometry, matrix, { f, cx, cy, W, H }, mapW = 320) {
  const s = mapW / W, mapH = Math.max(2, Math.round(H * s));
  const depth = new Float32Array(mapW * mapH).fill(1e9);
  const P = geometry.attributes.position, v = new THREE.Vector3();
  const sx = new Float32Array(3), sy = new Float32Array(3), iz = new Float32Array(3);
  for (let t = 0; t < P.count; t += 3) {
    let ok = true;
    for (let k = 0; k < 3; k++) {
      v.fromBufferAttribute(P, t + k).applyMatrix4(matrix);
      if (v.z > -1e-3) { ok = false; break; }
      sx[k] = (cx + (f * v.x) / -v.z) * s; sy[k] = (cy - (f * v.y) / -v.z) * s; iz[k] = 1 / -v.z;
    }
    if (!ok) continue;
    const x0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2]))), x1 = Math.min(mapW - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
    const y0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2]))), y1 = Math.min(mapH - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
    const den = (sy[1] - sy[2]) * (sx[0] - sx[2]) + (sx[2] - sx[1]) * (sy[0] - sy[2]);
    if (Math.abs(den) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((sy[1] - sy[2]) * (px - sx[2]) + (sx[2] - sx[1]) * (py - sy[2])) / den;
      const w1 = ((sy[2] - sy[0]) * (px - sx[2]) + (sx[0] - sx[2]) * (py - sy[2])) / den;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const d = 1 / (w0 * iz[0] + w1 * iz[1] + w2 * iz[2]);
      const k = y * mapW + x;
      if (d < depth[k]) depth[k] = d;
    }
  }
  // Grow one pixel so silhouette edges don't read as "unseen".
  const grown = depth.slice();
  for (let y = 0; y < mapH; y++) for (let x = 0; x < mapW; x++) {
    let m = depth[y * mapW + x];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < mapW && yy < mapH) m = Math.min(m, depth[yy * mapW + xx]);
    }
    grown[y * mapW + x] = m;
  }
  return { data: grown, w: mapW, h: mapH };
}

/**
 * Repaint the modelled body and roof with the color the photo shows on the
 * visible body panels, so the hidden side matches the lit, real paint.
 */
export function matchPaint(car, matrix, cam, depth, seen) {
  const geo = car.geometry, P = geo.attributes.position, Nn = geo.attributes.normal, Col = geo.attributes.color;
  const samples = [[], [], []];
  const a = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(matrix);
  const s = depth.w / cam.W;
  for (let t = 0; t < P.count; t += 3) {
    if (car.kind[t] !== KIND_BODY) continue;
    a.set(0, 0, 0);
    for (let k = 0; k < 3; k++) a.add(new THREE.Vector3().fromBufferAttribute(P, t + k));
    a.multiplyScalar(1 / 3).applyMatrix4(matrix);
    n.fromBufferAttribute(Nn, t).applyMatrix3(nm).normalize();
    if (a.z > -1e-3 || n.dot(a.clone().negate().normalize()) < 0.45) continue;
    const u = cam.cx + (cam.f * a.x) / -a.z, v = cam.cy - (cam.f * a.y) / -a.z;
    const dx = Math.floor(u * s), dy = Math.floor(v * s);
    if (dx < 0 || dy < 0 || dx >= depth.w || dy >= depth.h) continue;
    if (-a.z > depth.data[dy * depth.w + dx] * 1.02) continue;
    const c = seen(u, v);
    if (!c) continue;
    samples[0].push(c[0]); samples[1].push(c[1]); samples[2].push(c[2]);
  }
  if (samples[0].length < 12) return null;
  // Panels also catch grille, wheels and reflections. Keep the samples closest
  // to the paint Claude named, and let the photo decide the exact shade.
  const ref = car.colors.body.map((v) => v * 255);
  const idx = samples[0].map((_, i) => i);
  const dist = idx.map((i) => Math.abs(samples[0][i] - ref[0]) + Math.abs(samples[1][i] - ref[1]) + Math.abs(samples[2][i] - ref[2]));
  idx.sort((p, q) => dist[p] - dist[q]);
  const keep = idx.slice(0, Math.max(8, Math.round(idx.length * 0.4)));
  const med = [0, 1, 2].map((c) => { const arr = keep.map((i) => samples[c][i]).sort((p, q) => p - q); return arr[arr.length >> 1] / 255; });
  // The shader lights hidden panels at about 0.85 on average.
  const paint = med.map((v) => clamp(v / 0.85, 0, 1));
  const roofSame = car.colors.roof.every((v, i) => Math.abs(v - car.colors.body[i]) < 0.02);
  for (let i = 0; i < Col.count; i++) {
    if (car.kind[i] === KIND_BODY || (roofSame && car.kind[i] === KIND_ROOF)) Col.setXYZ(i, paint[0], paint[1], paint[2]);
  }
  Col.needsUpdate = true;
  return med;
}

const carVert = /* glsl */`
  attribute vec3 color; attribute float gloss;
  uniform mat4 toCam;
  varying vec3 vCam, vCamM, vN, vNM, vCol, vWN, vWP; varying float vGloss;
  void main() {
    vCam = (toCam * vec4(position, 1.0)).xyz;
    vCamM = (toCam * vec4(-position.x, position.y, position.z, 1.0)).xyz;
    mat3 R = mat3(toCam);
    vN = normalize(R * normal);
    vNM = normalize(R * vec3(-normal.x, normal.y, normal.z));
    vCol = color; vGloss = gloss;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWP = wp.xyz; vWN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const carFrag = /* glsl */`
  uniform sampler2D photo; uniform sampler2D depthMap; uniform sampler2D mask;
  uniform vec4 cam;       // f, cx, cy, unused
  uniform vec2 size;      // photo W, H
  uniform vec4 crop;      // mask x0, y0, w, h in photo pixels
  uniform float opacity; uniform vec3 up;
  varying vec3 vCam, vCamM, vN, vNM, vCol, vWN, vWP; varying float vGloss;

  // How much the photo saw this point, and what color it saw there.
  float seen(vec3 p, vec3 n, out vec3 c) {
    c = vec3(0.0);
    if (p.z > -1e-3) return 0.0;
    vec2 px = vec2(cam.y + cam.x * p.x / -p.z, cam.z - cam.x * p.y / -p.z);
    vec2 uv = px / size;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
    float w = smoothstep(0.22, 0.5, dot(n, normalize(-p)));
    float d = texture2D(depthMap, uv).r;
    w *= 1.0 - smoothstep(0.01, 0.03, (-p.z - d) / d);
    vec2 m = (px - crop.xy) / crop.zw;
    float inside = step(0.0, m.x) * step(0.0, m.y) * step(m.x, 1.0) * step(m.y, 1.0);
    w *= inside * smoothstep(0.45, 0.85, texture2D(mask, m).r);
    c = texture2D(photo, uv).rgb;
    return w;
  }

  void main() {
    // Modelled paint, lit simply, with a hint of sky in glossy parts.
    vec3 n = normalize(vWN);
    float lam = max(dot(n, normalize(up * 1.0 + vec3(0.25, 0.0, 0.2))), 0.0);
    vec3 col = vCol * (0.58 + 0.42 * lam);
    vec3 V = normalize(cameraPosition - vWP);
    vec3 R = reflect(-V, n);
    float sky = smoothstep(-0.2, 0.7, dot(R, up));
    col = mix(col, mix(vec3(0.16), vec3(0.72, 0.77, 0.82), sky), vGloss * 0.22);
    // The photo, mirrored onto the hidden side, then the photo itself.
    vec3 cm, cd;
    float wm = seen(vCamM, vNM, cm);
    float wd = seen(vCam, normalize(vN), cd);
    col = mix(col, cm, wm * (1.0 - wd));
    col = mix(col, cd, wd);
    gl_FragColor = vec4(col, opacity);
  }`;

export function carMaterial({ photoTex, depth, maskTex, matrix, cam, crop, up }) {
  const depthTex = new THREE.DataTexture(depth.data, depth.w, depth.h, THREE.RedFormat, THREE.FloatType);
  depthTex.minFilter = depthTex.magFilter = THREE.NearestFilter;
  depthTex.needsUpdate = true;
  const mat = new THREE.ShaderMaterial({
    vertexShader: carVert, fragmentShader: carFrag, side: THREE.DoubleSide, transparent: true,
    uniforms: {
      photo: { value: photoTex }, depthMap: { value: depthTex }, mask: { value: maskTex },
      cam: { value: new THREE.Vector4(cam.f, cam.cx, cam.cy, 0) },
      size: { value: new THREE.Vector2(cam.W, cam.H) },
      crop: { value: new THREE.Vector4(...crop) },
      toCam: { value: matrix.clone() },
      up: { value: up.clone() },
      opacity: { value: 0 },
    },
  });
  mat.userData.textures = [depthTex];
  return mat;
}

/** A soft shadow under the vehicle, in its own frame (fades with the model). */
export function carShadow(size) {
  const [L, Wd] = size;
  const geo = new THREE.PlaneGeometry(Wd * 1.3, L * 1.12);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.03, 0);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { opacity: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float opacity; varying vec2 vUv;
      void main() {
        vec2 q = abs(vUv - 0.5) * 2.0;
        float d = length(max(q - vec2(0.62, 0.78), 0.0) / vec2(0.38, 0.22));
        float a = 0.42 * (1.0 - smoothstep(0.0, 1.0, d)) * (0.75 + 0.25 * (1.0 - max(q.x, q.y)));
        gl_FragColor = vec4(0.0, 0.0, 0.0, a * opacity);
      }`,
  });
  mat.userData.overlay = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return mesh;
}
