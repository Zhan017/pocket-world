// The four views Claude looks at in each refine round (js/refine-loop.js):
// the world from the photo's camera with a metre grid and element ids, the
// same with the photo blended on top, a top-down map, and a look back toward
// the camera. Returns base64 JPEGs without the data: prefix.

import * as THREE from 'three';
import { photoCamera } from './camera.js';

const OUT_W = 1280;

function shoot(renderer, scene, camera, w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h);
  const prev = renderer.getRenderTarget();
  const buf = new Uint8Array(w * h * 4);
  try {
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  } finally {
    renderer.setRenderTarget(prev);
    rt.dispose();
  }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const id = g.createImageData(w, h);
  for (let y = 0; y < h; y++) id.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);   // GL rows go bottom-up
  g.putImageData(id, 0, 0);
  return c;
}

const copy = (c) => { const d = document.createElement('canvas'); d.width = c.width; d.height = c.height; d.getContext('2d').drawImage(c, 0, 0); return d; };
const b64 = (c) => {
  for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
    const b = c.toDataURL('image/jpeg', q).split(',')[1];
    if (b.length <= 600_000 || q === 0.45) return b;
  }
};

// Levelled-world point -> canvas pixel for a three.js camera, or null when it is behind it.
function toScreen(camera, p, w, h) {
  const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(camera.matrixWorldInverse);
  if (v.z > -camera.near) return null;
  v.applyMatrix4(camera.projectionMatrix);
  return [(v.x * 0.5 + 0.5) * w, (0.5 - v.y * 0.5) * h];
}

function polyline(g, camera, w, h, at, t0, t1, step) {
  g.beginPath();
  let pen = false;
  for (let t = t0; t <= t1 + 1e-6; t += step) {
    const s = toScreen(camera, at(t), w, h);
    if (!s || s[0] < -w || s[0] > 2 * w || s[1] < -h || s[1] > 2 * h) { pen = false; continue; }
    if (pen) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]);
    pen = true;
  }
  g.stroke();
}

// Ground grid at road level: every metre within 30 m, every 5 m beyond (brighter).
function drawGrid(g, camera, w, h, plan, fine) {
  const E = plan.extent_m, y = -plan.camera.height_m + 0.05;
  const step = fine ? 1 : 5;
  for (let k = Math.ceil(-E / step) * step; k <= E; k += step) {
    const strong = k % 5 === 0;
    if (fine && !strong && Math.abs(k) > 30) continue;
    g.strokeStyle = strong ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.32)';
    g.lineWidth = strong ? 1.5 : 1;
    polyline(g, camera, w, h, (t) => [k, y, -t], -E, E, 0.5);
    polyline(g, camera, w, h, (t) => [t, y, -k], -E, E, 0.5);
  }
}

function anchors(plan) {
  const h = plan.camera.height_m, out = [];
  const mid = (pts) => pts[Math.floor(pts.length / 2)];
  for (const s of plan.surfaces) {
    const c = s.polygon.reduce((a, p) => [a[0] + p[0] / s.polygon.length, a[1] + p[1] / s.polygon.length], [0, 0]);
    out.push({ id: s.id, p: [c[0], -h + s.top_m, -c[1]] });
  }
  for (const m of plan.markings) { const c = mid(m.points); out.push({ id: m.id, p: [c[0], -h + 0.05, -c[1]] }); }
  for (const o of plan.objects) { const c = o.at || (o.path && mid(o.path)); if (c) out.push({ id: o.id, p: [c[0], -h + o.height_m * 0.6, -c[1]] }); }
  for (const v of plan.vehicles) if (v.at) out.push({ id: `v${v.id}`, p: [v.at[0], -h + 1.2, -v.at[1]] });
  return out;
}

function drawLabels(g, camera, w, h, plan) {
  g.font = '600 13px system-ui, sans-serif';
  for (const a of anchors(plan)) {
    const s = toScreen(camera, a.p, w, h);
    if (!s || s[0] < 0 || s[0] > w || s[1] < 0 || s[1] > h) continue;
    g.fillStyle = '#ffeb3b';
    g.beginPath(); g.arc(s[0], s[1], 2.5, 0, Math.PI * 2); g.fill();
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(a.id, s[0] + 4, s[1] - 4);
    g.fillText(a.id, s[0] + 4, s[1] - 4);
  }
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene  the page's scene with the world built from `plan`
 * @param {object} plan  the plan that world was built from
 * @param {HTMLCanvasElement} frame  the photo
 * @param {{planScene?: object, update?: (t: number, camera: THREE.Camera) => void}} [world]
 *   the world built from `plan`: its fog is switched off for the map, and its people
 *   and cars are turned toward each view's camera (the 3D car shows away from the photo's pose)
 */
export function renderViews(renderer, scene, plan, frame, world = null) {
  const sc = OUT_W / Math.max(frame.width, frame.height);
  const w = Math.round(frame.width * sc), h = Math.round(frame.height * sc);
  const ch = plan.camera.height_m;
  const planScene = world ? world.planScene : null;
  // People face, and cars cross-fade from photo to model, by the camera looking at them.
  const face = (cam) => { if (world && world.update) world.update(0, cam); };

  // 1 and 2: the photo's camera.
  const cam = photoCamera({ W: w, H: h, hfovDeg: plan.camera.hfov_deg, pitchDeg: plan.camera.pitch_deg, heightM: ch });
  const pc = new THREE.PerspectiveCamera((2 * Math.atan(h / 2 / cam.f) * 180) / Math.PI, w / h, 0.3, 4000);
  pc.rotation.x = -cam.pitch;
  pc.updateProjectionMatrix(); pc.updateMatrixWorld(true);
  face(pc);
  const base = shoot(renderer, scene, pc, w, h);
  const camView = copy(base);
  const g1 = camView.getContext('2d');
  drawGrid(g1, pc, w, h, plan, true);
  drawLabels(g1, pc, w, h, plan);
  const blend = copy(base);
  const g2 = blend.getContext('2d');
  g2.globalAlpha = 0.5; g2.drawImage(frame, 0, 0, w, h); g2.globalAlpha = 1;
  drawLabels(g2, pc, w, h, plan);

  // 3: top-down map, forward up, no fog.
  const E = plan.extent_m, s = 1024;
  const top = new THREE.OrthographicCamera(-E, E, E, -E, 1, 2000);
  top.position.set(0, 500, 0); top.up.set(0, 0, -1); top.lookAt(0, 0, 0);
  top.updateProjectionMatrix(); top.updateMatrixWorld(true);
  const sceneFog = scene.fog;
  let map;
  try {
    face(top);
    scene.fog = null; if (planScene?.setFog) planScene.setFog(false);
    map = shoot(renderer, scene, top, s, s);
  } finally {
    scene.fog = sceneFog; if (planScene?.setFog) planScene.setFog(true);
  }
  const g3 = map.getContext('2d');
  drawGrid(g3, top, s, s, plan, false);
  drawLabels(g3, top, s, s, plan);
  const o = toScreen(top, [0, 0, 0], s, s);
  g3.fillStyle = '#ffffff'; g3.strokeStyle = '#000000'; g3.lineWidth = 2;
  g3.beginPath(); g3.moveTo(o[0], o[1] - 12); g3.lineTo(o[0] - 8, o[1] + 8); g3.lineTo(o[0] + 8, o[1] + 8); g3.closePath(); g3.fill(); g3.stroke();
  g3.font = '600 14px system-ui, sans-serif'; g3.fillStyle = '#ffffff';
  g3.fillText(`forward is up · grid 5 m · ${2 * E} m across`, 12, s - 14);

  // 4: looking back toward the camera from 15 m in front of it.
  const back = new THREE.PerspectiveCamera(70, w / h, 0.3, 4000);
  back.position.set(0, -ch + 1.7, -15); back.lookAt(0, -ch + 1.7, 0);
  back.updateProjectionMatrix(); back.updateMatrixWorld(true);
  face(back);
  const backC = shoot(renderer, scene, back, w, h);
  drawLabels(backC.getContext('2d'), back, w, h, plan);

  return { camera: b64(camView), blend: b64(blend), top: b64(map), back: b64(backC) };
}
