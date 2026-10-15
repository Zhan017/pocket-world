// Places a generated 3D object (from SAM 3D Objects) exactly where the object
// sits in the photo.
//
// The model comes back upright (Y up) at unit size, in no particular spot. We
// search its heading (and the camera tilt, when we don't know it) for the pose
// whose silhouette and colors best match the object in the photo, then scale it
// so its front surface lands at the depth the photo says it is.

import * as THREE from 'three';

const DEG = Math.PI / 180;

/** Flatten a loaded glTF scene into sampled points (positions, sRGB colors). */
export function samplePoints(root, maxPoints = 3500) {
  root.updateMatrixWorld(true);
  const pos = [], col = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, P = g.attributes.position, C = g.attributes.color;
    const step = Math.max(1, Math.floor(P.count / maxPoints));
    const v = new THREE.Vector3();
    for (let i = 0; i < P.count; i += step) {
      v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld);
      pos.push(v.x, v.y, v.z);
      if (C) {
        // SAM 3D stores the photo's own (sRGB) colors in the vertices.
        for (let k = 0; k < 3; k++) col.push(Math.max(0, Math.min(1, C.getComponent(i, k))) * 255);
      } else col.push(-1, -1, -1);
    }
  });
  return { pos: Float32Array.from(pos), col: Float32Array.from(col), n: pos.length / 3 };
}

/**
 * @param {object} o
 * @param {{pos:Float32Array,col:Float32Array,n:number}} o.points  from samplePoints
 * @param {Uint8Array} o.alpha   object mask (0..255) over the crop
 * @param {number[]} o.crop      [x0, y0, cw, ch] in photo pixels
 * @param {number} o.f, o.cx, o.cy  camera intrinsics in photo pixels
 * @param {Uint8ClampedArray} o.photo  RGBA photo pixels (W*H*4)
 * @param {number} o.W
 * @param {(u:number,v:number)=>number} o.depthAt  photo depth (distance) at a pixel
 * @param {number} o.pitch       known camera tilt (radians, + = looking down)
 * @param {boolean} o.searchPitch  also search the tilt (when it isn't known)
 * @param {number} [o.yawCenter]  expected heading (radians), with
 * @param {number} [o.yawSpan]    how far to search either side of it
 * @returns {{matrix: THREE.Matrix4, iou:number, colorDiff:number, yaw:number, pitch:number} | null}
 */
export function fitObject(o) {
  const { points, alpha, crop, f, cx, cy, photo, W } = o;
  const [x0, y0, cw, ch] = crop;
  const Hpx = Math.floor(photo.length / 4 / W);

  // Tight box of the mask, then a scoring grid around it.
  let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity, maskCount = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (alpha[y * cw + x] > 127) {
      maskCount++;
      if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y;
    }
  }
  if (maskCount < 50) return null;
  mx0 += x0; mx1 += x0 + 1; my0 += y0; my1 += y0 + 1;
  const mw = mx1 - mx0, mh = my1 - my0, ucM = (mx0 + mx1) / 2, vcM = (my0 + my1) / 2;
  const pad = 0.3;
  const gx0 = mx0 - mw * pad, gy0 = my0 - mh * pad, gw = mw * (1 + 2 * pad), gh = mh * (1 + 2 * pad);
  const GN = 56;
  const cell = Math.max(gw, gh) / GN;
  const GW = Math.ceil(gw / cell), GH = Math.ceil(gh / cell);
  const maskGrid = new Uint8Array(GW * GH);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const u = Math.floor(gx0 + (i + 0.5) * cell) - x0, v = Math.floor(gy0 + (j + 0.5) * cell) - y0;
    if (u >= 0 && v >= 0 && u < cw && v < ch && alpha[v * cw + u] > 127) maskGrid[j * GW + i] = 1;
  }
  let maskCells = 0;
  for (const m of maskGrid) maskCells += m;

  const n = points.n, P = points.pos, C = points.col;
  const R = new Float32Array(n * 3);
  const occ = new Uint8Array(GW * GH), zbuf = new Float32Array(GW * GH), zidx = new Int32Array(GW * GH);

  const rotate = (q) => {
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyQuaternion(q);
      R[i * 3] = v.x; R[i * 3 + 1] = v.y; R[i * 3 + 2] = v.z;
    }
  };
  // Project rotated points with scale s and translation t; returns bbox.
  const project = (s, t, cb) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = 0; i < n; i++) {
      const X = s * R[i * 3] + t.x, Y = s * R[i * 3 + 1] + t.y, Z = s * R[i * 3 + 2] + t.z;
      if (Z > -1e-4) continue;
      const u = cx + (f * X) / -Z, v = cy - (f * Y) / -Z;
      if (u < a) a = u; if (u > c) c = u; if (v < b) b = v; if (v > d) d = v;
      if (cb) cb(i, u, v, -Z);
    }
    return [a, b, c, d];
  };
  // Scale and shift so the projected box matches the mask box. The object is
  // placed about one unit away; scaling everything about the camera later
  // leaves the picture unchanged.
  const place = () => {
    const t = new THREE.Vector3((ucM - cx) / f, -(vcM - cy) / f, -1);
    let s = 0.3;
    for (let it = 0; it < 4; it++) {
      const [a, b, c, d] = project(s, t);
      const pw = c - a, ph = d - b;
      if (!(pw > 0 && ph > 0)) return null;
      s *= Math.sqrt((mw * mh) / (pw * ph));
      const du = ucM - (a + c) / 2, dv = vcM - (b + d) / 2;
      t.x += (du * -t.z) / f; t.y -= (dv * -t.z) / f;
    }
    return { s, t };
  };
  const score = (s, t) => {
    occ.fill(0); zbuf.fill(Infinity);
    project(s, t, (i, u, v, z) => {
      const gi = Math.floor((u - gx0) / cell), gj = Math.floor((v - gy0) / cell);
      if (gi < 0 || gj < 0 || gi >= GW || gj >= GH) return;
      const k = gj * GW + gi;
      occ[k] = 1;
      if (z < zbuf[k]) { zbuf[k] = z; zidx[k] = i; }
    });
    let inter = 0, uni = 0, cdiff = 0, cn = 0;
    for (let k = 0; k < occ.length; k++) {
      // Fill single-cell gaps between sampled points.
      const o1 = occ[k] || (k % GW > 0 && occ[k - 1] && k % GW < GW - 1 && occ[k + 1]) ? 1 : 0;
      if (o1 && maskGrid[k]) inter++;
      if (o1 || maskGrid[k]) uni++;
      if (occ[k] && maskGrid[k] && C[zidx[k] * 3] >= 0) {
        const gi = k % GW, gj = Math.floor(k / GW);
        const u = Math.min(W - 1, Math.max(0, Math.floor(gx0 + (gi + 0.5) * cell)));
        const v = Math.min(Hpx - 1, Math.max(0, Math.floor(gy0 + (gj + 0.5) * cell)));
        const p = (v * W + u) * 4, ci = zidx[k] * 3;
        cdiff += (Math.abs(photo[p] - C[ci]) + Math.abs(photo[p + 1] - C[ci + 1]) + Math.abs(photo[p + 2] - C[ci + 2])) / 765;
        cn++;
      }
    }
    const iou = uni ? inter / uni : 0;
    const colorDiff = cn ? cdiff / cn : 0.5;
    return { iou, colorDiff, value: iou - 0.6 * colorDiff };
  };

  const q = new THREE.Quaternion(), qy = new THREE.Quaternion(), qx = new THREE.Quaternion();
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
  const tryPose = (yaw, pitch) => {
    qx.setFromAxisAngle(X, pitch); qy.setFromAxisAngle(Y, yaw);
    q.copy(qx).multiply(qy);               // upright in the world, seen by a tilted camera
    rotate(q);
    const pl = place();
    if (!pl) return null;
    return { yaw, pitch, ...pl, ...score(pl.s, pl.t), q: q.clone() };
  };

  const pitches = o.searchPitch ? [0, 10, 20, 30, 40, 50, 60].map((d) => d * DEG) : [o.pitch];
  // Either every heading, or (when we know roughly which way it faces, which
  // a silhouette alone can't tell front from back) a window around that.
  const yaws = [];
  if (o.yawSpan != null) for (let d = -o.yawSpan; d <= o.yawSpan + 1e-6; d += 5 * DEG) yaws.push(o.yawCenter + d);
  else for (let yd = 0; yd < 360; yd += 15) yaws.push(yd * DEG);
  let best = null;
  for (const p of pitches) for (const yaw of yaws) {
    const r = tryPose(yaw, p);
    if (r && (!best || r.value > best.value)) best = r;
  }
  if (!best) return null;
  // Refine around the best guess.
  for (const step of o.yawSpan != null ? [2, 1] : [5, 2]) {
    const base = best;
    for (let dy = -2; dy <= 2; dy++) for (let dp = o.searchPitch ? -1 : 0; dp <= (o.searchPitch ? 1 : 0); dp++) {
      if (!dy && !dp) continue;
      const r = tryPose(base.yaw + dy * step * DEG, base.pitch + dp * step * DEG);
      if (r && r.value > best.value) best = r;
    }
  }

  // Depth: match the model's visible front to the photo's depth there.
  rotate(best.q);
  const front = [];
  score(best.s, best.t);
  for (let k = 0; k < zbuf.length; k++) if (maskGrid[k] && zbuf[k] < Infinity) front.push(zbuf[k]);
  const photoD = [];
  for (let j = 0; j < GH; j += 2) for (let i = 0; i < GW; i += 2) {
    if (!maskGrid[j * GW + i]) continue;
    photoD.push(o.depthAt(gx0 + (i + 0.5) * cell, gy0 + (j + 0.5) * cell));
  }
  if (!front.length || !photoD.length) return null;
  front.sort((a, b) => a - b); photoD.sort((a, b) => a - b);
  const k = photoD[photoD.length >> 1] / front[front.length >> 1];

  const matrix = new THREE.Matrix4().compose(best.t.clone().multiplyScalar(k), best.q, new THREE.Vector3(1, 1, 1).multiplyScalar(best.s * k));
  return { matrix, iou: best.iou, colorDiff: best.colorDiff, yaw: best.yaw, pitch: best.pitch, size: best.s * k };
}
