import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildWorld } from './world.js';
import { WalkControls } from './controls.js';
import { decodeScan } from './scan-format.js';
import { validatePlan } from './plan.js';
import { refineLoop } from './refine-loop.js';
import { renderViews } from './refine.js';

const $ = (s) => document.querySelector(s);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- renderer
const canvas = $('#scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (e) {
  $('#nogl').hidden = false;
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 4000);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.enablePan = false;
orbit.minAzimuthAngle = -1.0; orbit.maxAzimuthAngle = 1.0;
orbit.minPolarAngle = 0.45; orbit.maxPolarAngle = 1.72;
orbit.autoRotateSpeed = 0.3;
const walk = new WalkControls(camera, canvas, $('#stick'));

// ---------------------------------------------------------------- state
let world = null;
let current = null;           // { scan, photo, name }
let lastScan = null;
let collider = null;
// Claude World (docs/superpowers/specs/2026-10-15-claude-world-design.md):
// behind ?plan=1 while it is being built, so the live site is unchanged.
const PLAN_MODE = new URLSearchParams(location.search).has('plan');
// Walking collision (three-mesh-bvh from the CDN) is only loaded for Claude's world;
// if it fails to load you still walk, just without collision.
const { makeCollider = null } = PLAN_MODE ? await import('./collide.js').catch(() => ({})) : {};
const PLAN_ROUNDS = 5;
const planLog = [];
let planJob = 0;
let planState = 'idle';
let mode = 'diorama';         // 'diorama' | 'walk' | 'flying'
let strength = 1;
let lastInteract = performance.now();
let flight = null;
let hintTimer = 0;

['pointerdown', 'wheel', 'keydown'].forEach(ev => window.addEventListener(ev, () => { lastInteract = performance.now(); orbit.autoRotate = false; }, { passive: true }));

function dioramaPose(info) {
  // Stand a little behind and above where the photo was taken, so the world
  // reads as a small diorama floating in its own colors.
  const back = camera.aspect < 1 ? 1 + (1 - camera.aspect) * 1.1 : 1;   // tall screens step further back
  let target, position;
  if (info.levelled) {
    // Levelled worlds (Claude scene): look at the middle of the photo from above and behind.
    const d = info.focus.length();
    target = info.focus.clone();
    position = new THREE.Vector3(0.25 * d, 0.9 * d, 0.7 * d).sub(target).multiplyScalar(back).add(target);
  } else {
    const zm = Math.min(4, Math.max(1.6, info.zMedian));
    target = new THREE.Vector3(0, 0, -1.1 * zm);
    position = new THREE.Vector3(0.32 * zm, 0.36 * zm, 0.6 * zm).sub(target).multiplyScalar(back).add(target);
  }
  const m = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 1, 0));
  return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(m), fov: 50, target, dist: position.distanceTo(target) };
}

function walkPose(info) {
  if (info.plan && collider) {
    // Step down from the camera to the street, 3 m ahead of the point below it.
    const foot = collider.floorAt(0, -3, 0);
    if (foot != null) {
      return {
        position: new THREE.Vector3(0, foot + walk.eye, -3),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.08, 0, 0, 'YXZ')),
        fov: 70, foot,
      };
    }
  }
  return { position: new THREE.Vector3(0, 0, 0), quaternion: info.startQuat.clone(), fov: info.walkFov(camera.aspect) };
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function flyTo(pose, ms, done) {
  flight = {
    from: { p: camera.position.clone(), q: camera.quaternion.clone(), fov: camera.fov },
    to: pose, t0: performance.now(), ms: reduceMotion ? 1 : ms, done,
  };
}

function setMode(next) {
  if (!world || mode === 'flying' || next === mode) return;
  $('#mode-diorama').setAttribute('aria-pressed', String(next === 'diorama'));
  $('#mode-walk').setAttribute('aria-pressed', String(next === 'walk'));
  if (next === 'walk') {
    mode = 'flying'; orbit.enabled = false; orbit.autoRotate = false;
    const pose = walkPose(world.info);
    flyTo(pose, 1900, () => {
      mode = 'walk'; walk.enabled = true; walk.syncFromCamera();
      if (pose.foot != null) walk.foot = pose.foot;
      $('#stick').hidden = !coarse;
      showHint();
    });
  } else {
    mode = 'flying'; walk.enabled = false; $('#stick').hidden = true; hideHint();
    const pose = dioramaPose(world.info);
    flyTo(pose, 1500, () => {
      mode = 'diorama'; orbit.target.copy(pose.target); orbit.enabled = true; orbit.update();
      lastInteract = performance.now();
    });
  }
}

function showHint() {
  const h = $('#hint');
  h.textContent = coarse ? 'Drag to look around · use the stick to walk' : 'Drag to look · W A S D to walk · arrows to turn · Esc to step out';
  h.hidden = false; h.classList.remove('fade');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.add('fade'), 6000);
}
function hideHint() { $('#hint').hidden = true; clearTimeout(hintTimer); }

const nf = new Intl.NumberFormat('en');
function describe(info, name) {
  const counts = {};
  for (const l of info.subjects) counts[l] = (counts[l] || 0) + 1;
  const plural = { person: 'people', dog: 'dogs', cat: 'cats', car: 'cars', truck: 'trucks', bus: 'buses', motorcycle: 'motorcycles', bicycle: 'bicycles' };
  const who = Object.keys(counts).length
    ? Object.entries(counts).map(([l, n]) => `${n} ${n === 1 ? l : plural[l] || l + 's'}`).join(', ')
    : 'Nothing cut out';
  $('#readout-name').textContent = name;
  $('#readout-meta').textContent = `${who} · ${info.width}×${info.height} · ${nf.format(Math.round(info.triangles / 1000))}k triangles`;
  const cap = $('#readout-caption');
  cap.hidden = !info.caption;
  cap.textContent = info.caption ? `${info.caption}${info.measured ? ` · camera ${info.calib.h.toFixed(1)} m up` : ''}` : '';
  const depth = $('#depth');
  depth.disabled = info.measured;
  depth.title = info.measured ? 'Depth is measured from the ground in this world' : '';
}

function setWorld({ scan, photo, photoHi = null, name, sceneInfo = null }, { autoWalk = false, keepCamera = false } = {}) {
  const next = buildWorld(scan, photo, { strength, scene: sceneInfo, photoHi });
  next.prepare(renderer);   // the plan scene's depth pass, before it joins the scene
  if (world) { scene.remove(world.group); world.dispose(); }
  world = next;
  current = { scan, photo, photoHi, name, sceneInfo };
  scene.add(world.group);
  // Claude's world is solid: walking follows its ground and stops at its walls and cars.
  if (collider) { collider.dispose(); collider = null; }
  walk.collide = null;
  if (world.info.plan && makeCollider) {
    world.group.updateMatrixWorld(true);
    const meshes = world.planScene.meshes.filter((m) => !m.userData.paint);   // paint is flat, not a step
    for (const m of world.models()) m.traverse((o) => { if (o.isMesh) meshes.push(o); });
    collider = makeCollider(meshes);
    walk.collide = collider;
  }
  scene.fog = world.fog;
  walk.bounds = world.info.bounds;
  walk.speed = world.info.speed;
  describe(world.info, name);
  if (keepCamera) {
    if (mode === 'walk') camera.fov = world.info.walkFov(camera.aspect);
    camera.updateProjectionMatrix();
    return;
  }
  // Start outside, looking at the little world.
  const pose = dioramaPose(world.info);
  camera.position.copy(pose.position); camera.quaternion.copy(pose.quaternion);
  camera.fov = pose.fov; camera.updateProjectionMatrix();
  orbit.target.copy(pose.target);
  orbit.minDistance = pose.dist * 0.45; orbit.maxDistance = pose.dist * (world.info.surroundings ? 4 : 1.8);
  orbit.enabled = true; orbit.update();
  walk.enabled = false; $('#stick').hidden = true; hideHint();
  mode = 'diorama';
  $('#mode-diorama').setAttribute('aria-pressed', 'true');
  $('#mode-walk').setAttribute('aria-pressed', 'false');
  lastInteract = performance.now();
  if (autoWalk) setTimeout(() => setMode('walk'), reduceMotion ? 0 : 900);
}

// ---------------------------------------------------------------- loop
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  if (world && mode === 'walk') camera.fov = world.info.walkFov(camera.aspect);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const timer = new THREE.Timer();
renderer.setAnimationLoop((now) => {
  timer.update(now);
  const dt = Math.min(0.1, timer.getDelta());
  const t = timer.getElapsed();
  if (flight) {
    const k = Math.min(1, (performance.now() - flight.t0) / flight.ms), e = ease(k);
    camera.position.lerpVectors(flight.from.p, flight.to.position, e);
    camera.quaternion.slerpQuaternions(flight.from.q, flight.to.quaternion, e);
    camera.fov = flight.from.fov + (flight.to.fov - flight.from.fov) * e;
    camera.updateProjectionMatrix();
    if (k >= 1) { const d = flight.done; flight = null; d && d(); }
  } else if (mode === 'diorama') {
    if (!reduceMotion && performance.now() - lastInteract > 2500) {
      orbit.autoRotate = true;
      const az = orbit.getAzimuthalAngle();
      if (az > 0.45) orbit.autoRotateSpeed = 0.3;        // swing gently back and forth
      else if (az < -0.3) orbit.autoRotateSpeed = -0.3;
    }
    orbit.update();
  } else if (mode === 'walk') {
    walk.update(dt);
  }
  if (busy && !flight) return;   // the overlay covers the world; give the CPU to the AI
  if (world) world.update(reduceMotion ? 0 : t, camera);
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- UI wiring
$('#mode-diorama').addEventListener('click', () => setMode('diorama'));
$('#mode-walk').addEventListener('click', () => setMode('walk'));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mode === 'walk') setMode('diorama');
});

let depthTimer = 0;
$('#depth').addEventListener('input', (e) => {
  strength = parseFloat(e.target.value);
  clearTimeout(depthTimer);
  depthTimer = setTimeout(() => { if (current) setWorld(current, { keepCamera: true }); }, 120);
});

$('#save').addEventListener('click', () => {
  renderer.render(scene, camera);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pocket-world-${(current?.name || 'view').replace(/\.[^.]+$/, '')}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
});

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 6000);
}

// ---------------------------------------------------------------- photo -> world
let worker = null;
const pending = new Map();
let jobId = 0;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'download') return onDownload(m);
    if (m.type === 'step') return setStep(m.step, m);
    const job = pending.get('job'); if (!job) return;
    pending.delete('job');
    if (m.type === 'result') job.resolve(m.scan); else job.reject(new Error(m.message));
  };
  worker.onerror = (e) => {
    const job = pending.get('job'); pending.delete('job');
    job?.reject(new Error(e.message || 'The AI worker could not start.'));
  };
  return worker;
}

const STEPS = ['models', 'depth', 'detect', 'segment', 'claude', 'build'];
const timings = [];
function setStep(step, extra = {}) {
  timings.push([step, Math.round(performance.now())]);
  const idx = STEPS.indexOf(step);
  document.querySelectorAll('#steps li').forEach((li, i) => {
    li.dataset.state = i < idx ? 'done' : i === idx ? 'active' : 'todo';
  });
  if (step === 'segment') {
    const n = extra.count ?? 0;
    $('#step-segment').textContent = n ? `Cutting out ${n} ${n === 1 ? 'subject' : 'subjects'}` : 'Nothing to cut out';
  }
  if (step !== 'models') { $('#meter').hidden = true; }
}

// ---------------------------------------------------------------- smart scene (Claude)
// When the site has an Anthropic key configured (see api/scene.js), Claude reads
// a small copy of the photo: camera height and tilt, the ground, which "people"
// are real, and what surrounds the camera beyond the frame.
// When FAL_KEY is configured (see api/objects.js), cars and other vehicles are
// also rebuilt as full 3D models with SAM 3D Objects.
let smartAvailable = false, objectsAvailable = false;
const SMART_KEY = 'pw-smart-scene';
const toggleOn = () => $('#smart').checked;
const smartOn = () => smartAvailable && toggleOn();
const objectsOn = () => objectsAvailable && toggleOn();
function syncPrivacyText() {
  const to = [smartOn() && 'Anthropic (to understand the scene)', objectsOn() && 'fal.ai (only if it shows a car, to build the car in 3D)'].filter(Boolean);
  $('#privacy').textContent = to.length
    ? `A copy of your photo is sent to ${to.join(' and ')}. Everything else runs on your device.`
    : 'Runs on your device. Your photo is never uploaded.';
  $('#step-claude').hidden = !smartOn();
}
const available = (path) => fetch(path, { method: 'GET' }).then((r) => (r.ok ? r.json() : {})).then((j) => Boolean(j.enabled)).catch(() => false);
Promise.all([available('api/scene'), available('api/objects')]).then(([a, b]) => {
  smartAvailable = a; objectsAvailable = b;
  $('#smart-wrap').hidden = !(a || b);
  $('#smart-wrap').title = [a && 'Claude reads a small copy of your photo to level the camera, spot real people and describe each car so it can be built in 3D', b && 'fal.ai rebuilds cars, bikes and buses in full 3D'].filter(Boolean).join('. ') + '.';
  try { const v = localStorage.getItem(SMART_KEY); if (v !== null) $('#smart').checked = v === '1'; } catch {}
  syncPrivacyText();
});
$('#smart').addEventListener('change', () => {
  try { localStorage.setItem(SMART_KEY, $('#smart').checked ? '1' : '0'); } catch {}
  syncPrivacyText();
});

async function askClaude(photo, subjects) {
  // About 768 px on the long side is plenty for Claude and keeps the upload small.
  const s = Math.min(1, 768 / Math.max(photo.width, photo.height));
  const c = document.createElement('canvas');
  c.width = Math.round(photo.width * s); c.height = Math.round(photo.height * s);
  c.getContext('2d').drawImage(photo, 0, 0, c.width, c.height);
  const image = c.toDataURL('image/jpeg', 0.82).split(',')[1];
  const body = {
    image, width: photo.width, height: photo.height,
    subjects: subjects.map((sub, id) => ({ id, label: sub.label, box: [sub.box[0] / photo.width, sub.box[1] / photo.height, sub.box[2] / photo.width, sub.box[3] / photo.height] })),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('api/scene', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.scene) throw new Error(j.error || `status ${r.status}`);
    return j.scene;
  } finally { clearTimeout(timer); }
}

// The frame as base64 JPEG for Claude, shrunk until it fits the request limit.
function frameB64(canvas, maxChars = 1_600_000) {
  let c = canvas;
  for (;;) {
    const b = c.toDataURL('image/jpeg', 0.85).split(',')[1];
    if (b.length <= maxChars || Math.max(c.width, c.height) <= 1200) return b;
    const d = document.createElement('canvas');
    d.width = Math.round(c.width * 0.8); d.height = Math.round(c.height * 0.8);
    d.getContext('2d').drawImage(c, 0, 0, d.width, d.height);
    c = d;
  }
}

async function sceneApi(body) {
  const r = await fetch('api/scene', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `status ${r.status}`);
  return j;
}

// Plan the place with Claude, build it, then let Claude correct it over a few rounds.
async function buildWithClaude(job, { scan, photo, photoHi, name }) {
  const image = frameB64(photoHi);
  planState = 'planning';
  status3d('Claude is planning the place…');
  const t0 = performance.now();
  const res = await sceneApi({
    action: 'plan', image, width: photoHi.width, height: photoHi.height,
    subjects: scan.subjects.map((sub, id) => ({ id, label: sub.label, box: [sub.box[0] / photo.width, sub.box[1] / photo.height, sub.box[2] / photo.width, sub.box[3] / photo.height] })),
  });
  if (job !== planJob) return;
  const plan = validatePlan(res.plan);
  planLog.push({ step: 'plan', ms: Math.round(performance.now() - t0), serverMs: res.ms, usage: res.usage, model: res.model, notes: plan?.notes || '' });
  if (!plan || !plan.surfaces.length) throw new Error('Claude could not plan this place');
  setWorld({ scan: keepRealSubjects(scan, plan), photo, photoHi, name, sceneInfo: plan });
  planState = 'refining';
  status3d(`Claude built the place · checking it (round 1 of ${PLAN_ROUNDS})`);
  const out = await refineLoop({
    plan, rounds: PLAN_ROUNDS,
    render: async (p) => { const v = renderViews(renderer, scene, p, photoHi, world); return [v.camera, v.blend, v.top, v.back]; },
    call: ({ round, renders, plan: p }) => sceneApi({ action: 'refine', image, renders, plan: p, round }),
    apply: (p) => { if (job === planJob) setWorld({ scan: keepRealSubjects(scan, p), photo, photoHi, name, sceneInfo: p }, { keepCamera: true }); },
    onRound: (info) => {
      planLog.push({ step: 'refine', ...info });
      if (job === planJob) status3d(`Round ${info.round} of ${PLAN_ROUNDS}: ${info.notes || 'checked'}`);
    },
    cancelled: () => job !== planJob,
  });
  if (job !== planJob) return;
  if (out.stopped === 'error') {
    // a half-built world must not stay on screen: go back to the last good plan
    try { setWorld({ scan: keepRealSubjects(scan, out.plan), photo, photoHi, name, sceneInfo: out.plan }, { keepCamera: true }); } catch {}
  }
  planState = out.stopped === 'error' ? 'failed' : 'done';
  status3d(out.stopped === 'done' ? `Claude is happy with the place after ${out.rounds} ${out.rounds === 1 ? 'round' : 'rounds'}` : `Claude checked the place ${out.rounds} ${out.rounds === 1 ? 'time' : 'times'}`);
  if (out.error) toast(`Claude stopped correcting the place (${out.error.message}).`);
}

// ---------------------------------------------------------------- 3D objects (SAM 3D)
let objectsJob = 0;
const gltfLoader = new GLTFLoader();
const plural3d = { car: 'cars', truck: 'trucks', bus: 'buses', motorcycle: 'motorcycles', bicycle: 'bicycles' };
// "3D car built" when Claude's description became a model, else nothing.
function builtStatus(w) {
  const built = w.info.objects.filter((o) => o.built);
  if (!built.length) return '';
  const noun = built.length === 1 ? (built[0].name || `The ${built[0].label}`) : `${built.length} ${new Set(built.map((o) => o.label)).size === 1 ? plural3d[built[0].label] || 'vehicles' : 'vehicles'}`;
  return `${noun} built in 3D · step sideways to see ${built.length === 1 ? 'it' : 'them'}`;
}
function status3d(text) {
  const el = $('#readout-3d');
  el.hidden = !text; el.textContent = text || '';
}
function maskPng(W, H, obj) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const [x0, y0, cw, ch] = obj.crop;
  const id = g.getImageData(x0, y0, cw, ch);
  for (let i = 0; i < cw * ch; i++) if (obj.alpha[i] > 127) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; }
  g.putImageData(id, x0, y0);
  return c.toDataURL('image/png').split(',')[1];
}
async function objectsApi(body) {
  const r = await fetch('api/objects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `status ${r.status}`);
  return j;
}
// Runs in the background after the world is shown: send the photo and one mask
// per vehicle, wait for the models, then swap them in.
async function build3dObjects(photo, forWorld) {
  const job = ++objectsJob;
  const list = forWorld.info.objects
    .map((o, i) => ({ ...o, i, area: (o.box[2] - o.box[0]) * (o.box[3] - o.box[1]) }))
    .sort((a, b) => b.area - a.area).slice(0, 4);
  if (!list.length) return;
  const noun = list.length === 1 ? list[0].label : (plural3d[list[0].label] || 'vehicles');
  status3d(`Building 3D ${list.length === 1 ? noun : list.length + ' ' + noun}…`);
  try {
    const image = photo.toDataURL('image/jpeg', 0.9).split(',')[1];
    const masks = list.map((o) => maskPng(photo.width, photo.height, o));
    const sub = await objectsApi({ action: 'submit', image, masks });
    const t0 = performance.now();
    let result = null;
    while (!result) {
      await new Promise((r) => setTimeout(r, 3000));
      if (job !== objectsJob || world !== forWorld) return;
      if (performance.now() - t0 > 6 * 60e3) throw new Error('it took too long');
      const st = await objectsApi({ action: 'poll', status_url: sub.status_url, response_url: sub.response_url });
      if (st.status === 'COMPLETED') result = st.result;
      else status3d(`Building 3D ${noun}… ${st.status === 'IN_QUEUE' ? 'waiting in line' : 'modelling'}`);
    }
    const urls = list.length > 1 && result.individual_glbs?.length ? result.individual_glbs : [result.model_glb];
    let placed = 0;
    for (let k = 0; k < list.length; k++) {
      const meta = (result.metadata || []).find((m) => m.object_index === k);
      const url = urls[k] ?? urls[meta?.object_index ?? -1];
      if (!url) continue;
      const gltf = await gltfLoader.loadAsync(url);
      if (job !== objectsJob || world !== forWorld) return;
      const fit = forWorld.attachModel(list[k].i, gltf.scene);
      if (fit && fit.iou >= 0.3) placed++;
      console.info('[3d] fit', list[k].label, fit && { iou: +fit.iou.toFixed(2), color: +fit.colorDiff.toFixed(2), size: +fit.size.toFixed(2) });
    }
    status3d(placed ? `3D ${placed === 1 ? list[0].label : noun} ready · step sideways to see ${placed === 1 ? 'it' : 'them'}` : builtStatus(forWorld));
    if (!placed && !builtStatus(forWorld)) toast('The 3D model did not line up with the photo, so the flat version stays.');
  } catch (e) {
    if (job === objectsJob) { status3d(builtStatus(forWorld)); toast(`3D objects failed (${e.message}).`); }
  }
}

// Drop detections Claude says aren't real (signs, posters, drivers inside cars...),
// and hand each vehicle Claude's description of it so it can be built in 3D.
function keepRealSubjects(scan, sceneInfo) {
  if (!sceneInfo) return scan;
  const verdicts = Array.isArray(sceneInfo.subjects) ? sceneInfo.subjects : [];
  const drop = new Set(verdicts.filter((v) => v && v.keep === false).map((v) => v.id));
  const vehicles = Array.isArray(sceneInfo.vehicles) ? sceneInfo.vehicles : [];
  return {
    ...scan,
    subjects: scan.subjects
      .map((s, i) => ({ ...s, vehicle: vehicles.find((v) => v && v.id === i) || null }))
      .filter((_, i) => !drop.has(i)),
  };
}
function onDownload({ loaded, total, expected }) {
  $('#meter').hidden = false;
  total = Math.max(total, expected || 0);
  const pct = total ? Math.min(100, (loaded / total) * 100) : 0;
  $('#meter-fill').style.width = `${pct}%`;
  $('#meter-text').textContent = total ? `${(loaded / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB` : 'Starting download';
}

function resetSteps() {
  document.querySelectorAll('#steps li').forEach(li => { li.dataset.state = 'todo'; });
  $('#step-segment').textContent = 'Cutting out people';
  $('#meter').hidden = true;
  $('#meter-fill').style.width = '0%';
}

const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
let busy = false;

async function processFile(file) {
  if (busy) return;
  if (!file || !file.type.startsWith('image/')) { toast('That file is not an image. Try a JPG or PNG photo.'); return; }
  busy = true;
  timings.length = 0; timings.push(['start', Math.round(performance.now())]);
  resetSteps();
  $('#busy').hidden = false;
  try {
    planJob++;
    planState = 'idle'; planLog.length = 0; status3d('');
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { throw new Error('Your browser cannot open this photo format. Save it as JPG or PNG and try again.'); }
    const s = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const W = Math.max(8, Math.round(bitmap.width * s)), H = Math.max(8, Math.round(bitmap.height * s));
    const photo = document.createElement('canvas'); photo.width = W; photo.height = H;
    const ctx = photo.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, W, H);
    // Claude and the plan's projected texture get up to 2576 px (Opus's high-resolution limit);
    // only the plan flow needs it.
    let photoHi = null;
    if (PLAN_MODE && smartOn()) {
      const sHi = Math.min(1, 2576 / Math.max(bitmap.width, bitmap.height));
      photoHi = document.createElement('canvas');
      photoHi.width = Math.max(8, Math.round(bitmap.width * sHi)); photoHi.height = Math.max(8, Math.round(bitmap.height * sHi));
      photoHi.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, photoHi.width, photoHi.height);
    }
    bitmap.close?.();
    const rgba = ctx.getImageData(0, 0, W, H).data;
    setStep('models');
    const w = getWorker();
    const scan = await new Promise((resolve, reject) => {
      pending.set('job', { resolve, reject, id: ++jobId });
      w.postMessage({ type: 'scan', rgba: rgba.buffer, width: W, height: H }, [rgba.buffer]);
    });
    lastScan = scan;
    let sceneInfo = null, sceneError = '';
    if (smartOn() && PLAN_MODE) {
      // Show the photo's own 2.5D world right away; Claude's plan replaces it when ready.
      setStep('build'); await frame(); await frame();
      const base = { scan, photo, photoHi, name: file.name || 'your photo' };
      setWorld(base);
      $('#busy').hidden = true;
      const job = planJob;
      buildWithClaude(job, base).catch((e) => {
        if (job !== planJob) return;
        planState = 'failed';
        status3d('');
        toast(`Claude could not build the place (${e.message}).`);
      });
      timings.push(['ready', Math.round(performance.now())]);
      return;
    }
    if (smartOn()) {
      setStep('claude');
      try { sceneInfo = await askClaude(photo, scan.subjects); }
      catch (e) { sceneError = e.name === 'AbortError' ? 'Claude took too long' : e.message; }
    }
    setStep('build'); await frame(); await frame();
    setWorld({ scan: keepRealSubjects(scan, sceneInfo), photo, photoHi, name: file.name || 'your photo', sceneInfo }, { autoWalk: true });
    status3d(builtStatus(world));
    if (objectsOn() && world.info.objects.length) build3dObjects(photo, world);
    if (sceneError) toast(`Built the world without Claude (${sceneError}).`);
    timings.push(['ready', Math.round(performance.now())]);
    $('#busy').hidden = true;
  } catch (err) {
    $('#busy').hidden = true;
    toast(err.message.includes('fetch') || err.message.includes('network')
      ? 'Could not download the AI models. Check your connection and try again.'
      : err.message);
  } finally {
    busy = false;
  }
}

$('#file').addEventListener('change', (e) => { processFile(e.target.files[0]); e.target.value = ''; });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').hidden = true;
  const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/'));
  if (f) processFile(f);
});
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
  if (f) processFile(f);
});

// ---------------------------------------------------------------- sample world
async function loadSample() {
  const [img, buf, sceneInfo] = await Promise.all([
    new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'sample/forest-path.jpg'; }),
    fetch('sample/forest-path.scan').then(r => { if (!r.ok) throw new Error('missing sample'); return r.arrayBuffer(); }),
    // A saved scene description, so the sample shows the surroundings without an API call.
    fetch('sample/forest-path.scene.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const scan = decodeScan(buf);
  lastScan = scan;
  const photo = document.createElement('canvas'); photo.width = scan.width; photo.height = scan.height;
  photo.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, scan.width, scan.height);
  setWorld({ scan: keepRealSubjects(scan, sceneInfo), photo, name: 'forest-path.jpg', sceneInfo });
}
loadSample().catch(() => toast('The sample world did not load. You can still use your own photo.'));

// For automated checks.
window.__pw = {
  timings, get mode() { return mode; }, get world() { return world; }, setMode, processFile, camera, walk, orbit, renderer, scene,
  get plan() { return current?.sceneInfo?.surfaces ? current.sceneInfo : null; },
  get lastScan() { return lastScan; },
  planLog,
  get planState() { return planState; },
  views() { return this.plan ? renderViews(renderer, scene, this.plan, current.photoHi || current.photo, world) : null; },
  // Build the current photo from a plan without calling Claude (tests and debugging).
  setPlan(raw) {
    const p = validatePlan(raw);
    if (!p || !p.surfaces.length || !current || !lastScan) return null;
    setWorld({ ...current, scan: keepRealSubjects(lastScan, p), sceneInfo: p });
    return p;
  },
};
window.__THREE = THREE;
