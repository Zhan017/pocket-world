import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildWorld } from './world.js';
import { WalkControls } from './controls.js';
import { decodeScan } from './scan-format.js';

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
let mode = 'diorama';         // 'diorama' | 'walk' | 'flying'
let strength = 1;
let lastInteract = performance.now();
let flight = null;
let hintTimer = 0;

['pointerdown', 'wheel', 'keydown'].forEach(ev => window.addEventListener(ev, () => { lastInteract = performance.now(); orbit.autoRotate = false; }, { passive: true }));

function dioramaPose(info) {
  // Stand a little behind and above where the photo was taken, so the world
  // reads as a small diorama floating in its own colors.
  const zm = Math.min(4, Math.max(1.6, info.zMedian));
  const target = new THREE.Vector3(0, 0, -1.1 * zm);
  const back = camera.aspect < 1 ? 1 + (1 - camera.aspect) * 1.1 : 1;   // tall screens step further back
  const position = new THREE.Vector3(0.32 * zm, 0.36 * zm, 0.6 * zm).sub(target).multiplyScalar(back).add(target);
  const m = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 1, 0));
  return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(m), fov: 50, target, dist: position.distanceTo(target) };
}

function walkPose(info) {
  return { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion(), fov: info.walkFov(camera.aspect) };
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
    flyTo(walkPose(world.info), 1900, () => {
      mode = 'walk'; walk.enabled = true; walk.syncFromCamera();
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
  const plural = { person: 'people', dog: 'dogs', cat: 'cats' };
  const who = Object.keys(counts).length
    ? Object.entries(counts).map(([l, n]) => `${n} ${n === 1 ? l : plural[l] || l + 's'}`).join(', ')
    : 'No people found';
  $('#readout-name').textContent = name;
  $('#readout-meta').textContent = `${who} · ${info.width}×${info.height} · ${nf.format(Math.round(info.triangles / 1000))}k triangles`;
}

function setWorld({ scan, photo, name }, { autoWalk = false, keepCamera = false } = {}) {
  const next = buildWorld(scan, photo, { strength });
  if (world) { scene.remove(world.group); world.dispose(); }
  world = next;
  current = { scan, photo, name };
  scene.add(world.group);
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
  orbit.minDistance = pose.dist * 0.45; orbit.maxDistance = pose.dist * 1.8;
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

const STEPS = ['models', 'depth', 'detect', 'segment', 'build'];
const timings = [];
function setStep(step, extra = {}) {
  timings.push([step, Math.round(performance.now())]);
  const idx = STEPS.indexOf(step);
  document.querySelectorAll('#steps li').forEach((li, i) => {
    li.dataset.state = i < idx ? 'done' : i === idx ? 'active' : 'todo';
  });
  if (step === 'segment') {
    const n = extra.count ?? 0;
    $('#step-segment').textContent = n ? `Cutting out ${n} ${n === 1 ? 'subject' : 'subjects'}` : 'No people found, skipping cutouts';
  }
  if (step !== 'models') { $('#meter').hidden = true; }
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
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { throw new Error('Your browser cannot open this photo format. Save it as JPG or PNG and try again.'); }
    const s = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const W = Math.max(8, Math.round(bitmap.width * s)), H = Math.max(8, Math.round(bitmap.height * s));
    const photo = document.createElement('canvas'); photo.width = W; photo.height = H;
    const ctx = photo.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, W, H);
    bitmap.close?.();
    const rgba = ctx.getImageData(0, 0, W, H).data;
    setStep('models');
    const w = getWorker();
    const scan = await new Promise((resolve, reject) => {
      pending.set('job', { resolve, reject, id: ++jobId });
      w.postMessage({ type: 'scan', rgba: rgba.buffer, width: W, height: H }, [rgba.buffer]);
    });
    setStep('build'); await frame(); await frame();
    setWorld({ scan, photo, name: file.name || 'your photo' }, { autoWalk: true });
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
  const [img, buf] = await Promise.all([
    new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'sample/forest-path.jpg'; }),
    fetch('sample/forest-path.scan').then(r => { if (!r.ok) throw new Error('missing sample'); return r.arrayBuffer(); }),
  ]);
  const scan = decodeScan(buf);
  const photo = document.createElement('canvas'); photo.width = scan.width; photo.height = scan.height;
  photo.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, scan.width, scan.height);
  setWorld({ scan, photo, name: 'forest-path.jpg' });
}
loadSample().catch(() => toast('The sample world did not load. You can still use your own photo.'));

// For automated checks.
window.__pw = { timings, get mode() { return mode; }, get world() { return world; }, setMode, processFile, camera, walk, orbit, renderer, scene };
