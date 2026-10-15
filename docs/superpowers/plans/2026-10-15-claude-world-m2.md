# Claude World, Milestone 2: walk the place

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** You can walk Claude's world like a real place: step down from the camera to the street, walk with collision (kerbs step up, hedges, poles, walls and cars stop you), cars stand where the plan says when the photo can't place them, and Claude's correction views show the 3D car and look less repetitive.

**Architecture:** A pure `js/walk.js` decides each walking step from two ray-cast callbacks (unit-tested in Node). `js/collide.js` provides those callbacks with three-mesh-bvh over the plan meshes and car models. `js/controls.js` uses them when a world has solid geometry; `js/main.js` builds a collider per world and flies you down to street level on "Walk in". `js/refine.js` drives the world's per-camera updates from each view camera. `js/scenebuild.js` gets smoother noise and less visible tiling, and exports `surfaceTopAt` for `js/world.js`, which places a car from the plan's `at` when the photo fit can't.

**Tech Stack:** as M1, plus three-mesh-bvh 0.9.15 from jsDelivr through the import map.

**Spec:** `docs/superpowers/specs/2026-10-15-claude-world-design.md` (milestone 2 of "Milestones"; components 5 and 8). M1 results: `docs/superpowers/notes/2026-10-15-m1-results.md`.

## Global Constraints

- No build step, no `package.json`, no npm dependencies. Browser libraries come from jsDelivr through the import map in `index.html`: `three@0.186.1`, `three/addons/`, and (new) `three-mesh-bvh@0.9.15` (`https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.9.15/src/index.js`).
- Code style matches the repo: 2-space indent, single quotes, semicolons, short plain comments that explain why.
- Frame and units: the levelled world (camera at the origin, road at `y = -h`, forward `-z`, metres). Plan ground positions `[right_m, fwd_m]` map to `[r, top - h, -f]`. Car models and people live in `content` (the photo camera's frame: levelled rotated by `+pitch` about x).
- Walking: eye 1.6 m above the surface under you; step up to 0.35 m; stop 0.3 m from anything taller; walking field of view 70° in plan mode; street-level start 3 m in front of the point below the camera.
- The live site stays unchanged: everything here only runs in plan mode (`?plan=1` + `CLAUDE_WORLD` on the server).
- Tests: `node --test tests/*.test.mjs` from the repo root (54 passing at the start). Browser checks use the dev server (`node tools/dev-server.mjs 3000`) and `window.__pw`.
- Work on branch `claude-world-m1` (continue it; it is pushed and tracks origin). Never print keys.

## Review Focus

1. **Walking off the edge of the world** (no surface under the next step) or over a big drop: you stay where you are. Pinned in Task 3 (`stays put at the edge of the world`, `refuses a big drop`).
2. **Moving diagonally into a hedge or wall**: you slide along it instead of stopping dead. Pinned in Task 3 (`slides along a wall`).
3. **A kerb vs a tall box**: 0.15 m steps up, 0.5 m blocks. Pinned in Task 3 (`steps up a kerb`, `a knee-high box blocks`).
4. **A correction round rebuilds the world while you are walking**: the collider is rebuilt and you keep your place and height. Checked in Task 4's browser step.
5. **The photo can't place the car** (no metric ground fit): the car stands at the plan's `at` on the plan's ground. Checked in Task 5's browser step.

---

## File structure

| File | Status | Responsibility |
| --- | --- | --- |
| `js/refine.js` | modify | Views call `world.update(0, viewCamera)` before each shot |
| `js/scenebuild.js` | modify | Smoother flat-colour noise, two-scale tiles with low-frequency tint; export `surfaceTopAt(plan, r, f)` |
| `js/walk.js` | new | One walking step from ray-cast callbacks (pure) |
| `tests/walk.test.mjs` | new | Walking rules |
| `js/collide.js` | new | BVH ray casts over meshes: `floorAt`, `hitAhead` |
| `js/controls.js` | modify | Use `walkStep` when `collide` is set; track `foot` |
| `js/main.js` | modify | Pass `world` to `renderViews`; collider per world; street-level walk pose; `willReadFrequently` on `photoHi` |
| `js/world.js` | modify | `walkFov` 70° in plan mode; car from the plan's `at` when the fit can't place it |
| `index.html` | modify | Import map entry for three-mesh-bvh |
| `docs/superpowers/notes/2026-10-15-m2-results.md` | new (Task 6) | Walk-through screenshots, numbers, go/no-go |

---

### Task 1: Views follow the view camera

**Files:**
- Modify: `js/refine.js`, `js/main.js`

**Interfaces:**
- Consumes: `world.update(t, camera)` (existing in `js/world.js`: turns people cutouts toward `camera`, cross-fades each car's photo relief and 3D model by `camera.position.length()`), `world.planScene.setFog(on)`.
- Produces: `renderViews(renderer, scene, plan, frame, world = null) -> {camera, blend, top, back}` (5th argument is now the world, not the plan scene).

- [ ] **Step 1: Change `renderViews` in `js/refine.js`**

Replace the JSDoc line `@param {{setFog?: (on: boolean) => void}} [planScene]  to switch fog off for the map` with:
```js
 * @param {{planScene?: object, update?: (t: number, camera: THREE.Camera) => void}} [world]
 *   the world built from `plan`: its fog is switched off for the map, and its people
 *   and cars are turned toward each view's camera (the 3D car shows away from the photo's pose)
```
Change the signature to `export function renderViews(renderer, scene, plan, frame, world = null) {` and add right after the `const ch = plan.camera.height_m;` line:
```js
  const planScene = world ? world.planScene : null;
  // People face, and cars cross-fade from photo to model, by the camera looking at them.
  const face = (cam) => { if (world && world.update) world.update(0, cam); };
```
Then call `face(pc);` on the line before `const base = shoot(renderer, scene, pc, w, h);`, `face(top);` as the first line inside the map shot's `try {`, and `face(back);` on the line before `const backC = shoot(renderer, scene, back, w, h);`. The existing `planScene?.setFog(...)` calls now use the local `planScene`.

- [ ] **Step 2: Pass the world from `js/main.js`**

In `buildWithClaude`, change the render callback to:
```js
    render: async (p) => { const v = renderViews(renderer, scene, p, photoHi, world); return [v.camera, v.blend, v.top, v.back]; },
```
In `window.__pw`, change `views()` to:
```js
  views() { return this.plan ? renderViews(renderer, scene, this.plan, current.photoHi || current.photo, world) : null; },
```

- [ ] **Step 3: Check**

Run: `node --check js/refine.js && node --check js/main.js && node --test tests/*.test.mjs`
Expected: clean; 54 pass.

Browser (dev server running): open `http://localhost:3000/`, then in the page:
```js
async () => {
  const blob = await (await fetch('tools/fixtures/crossing-clean.jpg')).blob();
  document.querySelector('#smart').checked = false;
  await window.__pw.processFile(new File([blob], 'crossing-clean.jpg', { type: 'image/jpeg' }));
  window.__pw.setPlan(await (await fetch('tools/fixtures/crossing-plan-claude.json')).json());
  window.__pw.setMode('walk');
  await new Promise((r) => setTimeout(r, 2500));   // the main camera now sits at the photo's pose
  const v = window.__pw.views();
  const img = new Image(); img.src = 'data:image/jpeg;base64,' + v.back; img.id = 'chk';
  img.style.cssText = 'position:fixed;z-index:99;left:0;top:0;width:1200px';
  document.body.appendChild(img);
  return Object.fromEntries(Object.entries(v).map(([k, b]) => [k, b.length]));
}
```
Take a screenshot. Expected: in the look-back view the Hyundai is the 3D model seen from behind (tail lights), not the flat photo cutout. Then, in the camera view, the car is still the photo (the camera sits at the photo's pose).

- [ ] **Step 4: Commit**

```bash
git add js/refine.js js/main.js
git commit -m "Views: people and cars face each view's camera, so Claude sees the 3D car"
```

---

### Task 2: Less repetitive ground, smoother colour

**Files:**
- Modify: `js/scenebuild.js`, `js/main.js`

**Interfaces:**
- Produces: `export function surfaceTopAt(plan, r, f) -> number` in `js/scenebuild.js` (the highest `top_m` of the plan's surfaces containing `[r, f]`, else 0); `buildPlanScene` uses it internally (behaviour unchanged).

- [ ] **Step 1: Smoother noise and two-scale tiles in the fragment shader**

In `js/scenebuild.js`, in the `frag` shader string, replace the line
```glsl
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
```
with
```glsl
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
```
and replace the two lines that compute `base`:
```glsl
    vec3 base = hasTile > 0.5 ? texture2D(tile, tuv / tileSize).rgb
                              : baseColor * (0.94 + 0.12 * hash(floor(vWorld.xz * 3.0)));
```
with
```glsl
    // Large soft patches so big areas don't read as one repeated tile.
    float tint = 0.94 + 0.12 * noise(tuv * 0.06);
    vec3 base;
    if (hasTile > 0.5) {
      vec3 a = texture2D(tile, tuv / tileSize).rgb;
      vec3 b = texture2D(tile, (tuv * 0.61 + vec2(0.37, 0.71)) / tileSize).rgb;   // a second scale hides the repeat
      base = mix(a, b, smoothstep(0.35, 0.65, noise(tuv * 0.15))) * tint;
    } else {
      base = baseColor * (0.93 + 0.14 * (noise(tuv * 1.3) * 0.6 + noise(tuv * 5.0) * 0.4)) * tint;
    }
```

- [ ] **Step 2: Export `surfaceTopAt`**

In `js/scenebuild.js`, add after the `inside` function:
```js
/** Height of the plan's surface under [r, f] (the highest one containing it), or 0 on the road. */
export function surfaceTopAt(plan, r, f) {
  let top = 0;
  for (const s of plan.surfaces) if (s.top_m > top && inside(s.polygon, r, f)) top = s.top_m;
  return top;
}
```
and in `buildPlanScene` replace the local `topAt` definition with `const topAt = (r, f) => surfaceTopAt(plan, r, f);`.

- [ ] **Step 3: `willReadFrequently` on the hi-res photo**

In `js/main.js` `processFile`, change `photoHi.getContext('2d').drawImage(bitmap, 0, 0, photoHi.width, photoHi.height);` to `photoHi.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, photoHi.width, photoHi.height);` (scenebuild reads it back on every rebuild; the first `getContext` call fixes the attribute).

- [ ] **Step 4: Check**

Run: `node --check js/scenebuild.js && node --check js/main.js && node --test tests/*.test.mjs`
Expected: clean; 54 pass.
Browser: load the frame and `tools/fixtures/crossing-plan-claude.json` as in Task 1, then put the camera at street level looking along the left verge (`__pw.walk.enabled = false; const c = __pw.camera; c.position.set(-6, -6 + 1.6, 10); c.rotation.set(-0.15, 0.6, 0, 'YXZ'); c.fov = 70; c.updateProjectionMatrix();`) and take a screenshot. Expected: no visible grid of identical tiles on the grass; flat-coloured paint has no 33 cm blocks; no console errors.

- [ ] **Step 5: Commit**

```bash
git add js/scenebuild.js js/main.js
git commit -m "Ground: soft patches and a second tile scale hide the repeat; smooth noise on flat colours"
```

---

### Task 3: Walking rules (`js/walk.js`)

**Files:**
- Create: `js/walk.js`, `tests/walk.test.mjs`

**Interfaces:**
- Produces: `walkStep(at, dx, dz, floorAt, hitAhead, {eye = 1.6, step = 0.35, radius = 0.3} = {}) -> {x, z, foot}` where `at = {x, z, foot}` (foot = height of the surface under you), `floorAt(x, z, fromY) -> number | null` (the first surface below `fromY` at `(x, z)`), `hitAhead(x, y, z, ux, uz, far) -> number | null` (distance to the first obstacle along the horizontal unit direction `(ux, uz)` within `far`).

- [ ] **Step 1: Write the failing test** `tests/walk.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkStep } from '../js/walk.js';

// A tiny world for the callbacks: flat ground at y = 0 for |x|, |z| < 50,
// plus optional boxes {x0, x1, z0, z1, top} standing on it.
function world(boxes = [], groundY = 0) {
  const boxAt = (x, z) => boxes.find((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);
  const floorAt = (x, z, fromY) => {
    if (Math.abs(x) > 50 || Math.abs(z) > 50) return null;
    const b = boxAt(x, z);
    if (b && b.top <= fromY) return b.top;
    return groundY <= fromY ? groundY : null;
  };
  const hitAhead = (x, y, z, ux, uz, far) => {
    for (let d = 0.01; d <= far; d += 0.01) {
      const b = boxAt(x + ux * d, z + uz * d);
      if (b && b.top > y) return d;
    }
    return null;
  };
  return { floorAt, hitAhead };
}

test('walks on flat ground', () => {
  const w = world();
  assert.deepEqual(walkStep({ x: 0, z: 0, foot: 0 }, 0.5, -0.5, w.floorAt, w.hitAhead), { x: 0.5, z: -0.5, foot: 0 });
});

test('steps up a kerb', () => {
  const w = world([{ x0: 1, x1: 5, z0: -5, z1: 5, top: 0.15 }]);
  const out = walkStep({ x: 0.9, z: 0, foot: 0 }, 0.2, 0, w.floorAt, w.hitAhead);
  assert.equal(out.x, 0.9 + 0.2);
  assert.equal(out.foot, 0.15);
});

test('a knee-high box blocks', () => {
  const w = world([{ x0: 1, x1: 5, z0: -5, z1: 5, top: 0.5 }]);
  assert.deepEqual(walkStep({ x: 0.5, z: 0, foot: 0 }, 0.3, 0, w.floorAt, w.hitAhead), { x: 0.5, z: 0, foot: 0 });
});

test('slides along a wall', () => {
  const w = world([{ x0: 1, x1: 1.2, z0: -10, z1: 10, top: 2 }]);
  const out = walkStep({ x: 0.6, z: 0, foot: 0 }, 0.3, -0.3, w.floorAt, w.hitAhead);
  assert.equal(out.x, 0.6);          // blocked across the wall
  assert.equal(out.z, -0.3);         // still moves along it
});

test('stays put at the edge of the world', () => {
  const w = world();
  assert.deepEqual(walkStep({ x: 49.9, z: 0, foot: 0 }, 0.3, 0, w.floorAt, w.hitAhead), { x: 49.9, z: 0, foot: 0 });
});

test('steps down a kerb but refuses a big drop', () => {
  const kerb = world([{ x0: -5, x1: 1, z0: -5, z1: 5, top: 0.15 }]);
  assert.equal(walkStep({ x: 0.9, z: 0, foot: 0.15 }, 0.2, 0, kerb.floorAt, kerb.hitAhead).foot, 0);
  const cliff = world([{ x0: -5, x1: 1, z0: -5, z1: 5, top: 4 }]);
  assert.deepEqual(walkStep({ x: 0.9, z: 0, foot: 4 }, 0.2, 0, cliff.floorAt, cliff.hitAhead), { x: 0.9, z: 0, foot: 4 });
});

test('no move means no change', () => {
  const w = world();
  assert.deepEqual(walkStep({ x: 1, z: 2, foot: 0 }, 0, 0, w.floorAt, w.hitAhead), { x: 1, z: 2, foot: 0 });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/walk.test.mjs`
Expected: FAIL with `Cannot find module` for `js/walk.js`.

- [ ] **Step 3: Write `js/walk.js`**

```js
// One step of walking on Claude's world: the eyes stay `eye` metres above the
// surface under you, kerbs up to `step` are climbed, anything taller stops
// you `radius` short, and a blocked diagonal slides along the obstacle.
// The ray casts come from the caller (three.js in the page, fakes in tests).

const MAX_DROP = 3;   // metres you may step down in one go (kerbs, banks), not off a roof

/**
 * @param {{x: number, z: number, foot: number}} at   foot = height of the surface under you
 * @param {number} dx
 * @param {number} dz
 * @param {(x: number, z: number, fromY: number) => number | null} floorAt
 * @param {(x: number, y: number, z: number, ux: number, uz: number, far: number) => number | null} hitAhead
 * @returns {{x: number, z: number, foot: number}}
 */
export function walkStep(at, dx, dz, floorAt, hitAhead, { eye = 1.6, step = 0.35, radius = 0.3 } = {}) {
  const tryMove = (mx, mz) => {
    const len = Math.hypot(mx, mz);
    if (len < 1e-9) return null;
    const ux = mx / len, uz = mz / len;
    for (const y of [at.foot + step + 0.1, at.foot + Math.min(1.2, eye)]) {   // knee and chest
      const d = hitAhead(at.x, y, at.z, ux, uz, len + radius);
      if (d != null) return null;
    }
    const nx = at.x + mx, nz = at.z + mz;
    const floor = floorAt(nx, nz, at.foot + step + 0.05);
    if (floor == null || floor < at.foot - MAX_DROP) return null;
    return { x: nx, z: nz, foot: floor };
  };
  return tryMove(dx, dz) || tryMove(dx, 0) || tryMove(0, dz) || { x: at.x, z: at.z, foot: at.foot };
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --test tests/walk.test.mjs` then `node --test tests/*.test.mjs`
Expected: walk 7/7; full suite 61/61.

- [ ] **Step 5: Commit**

```bash
git add js/walk.js tests/walk.test.mjs
git commit -m "Walking rules: kerbs step up, walls stop and slide, no walking off the world"
```

---

### Task 4: Collision walking and the step-down

**Files:**
- Create: `js/collide.js`
- Modify: `index.html`, `js/controls.js`, `js/main.js`, `js/world.js`

**Interfaces:**
- Consumes: `walkStep` (Task 3); `world.planScene.meshes`, `world.models()`, `world.info.plan`.
- Produces: `makeCollider(meshes) -> {floorAt(x, z, fromY), hitAhead(x, y, z, ux, uz, far), dispose()}` in `js/collide.js`; `WalkControls` gains `collide` (null or a collider), `foot` and `eye` (1.6); `world.info.walkFov` returns 70 in plan mode.

- [ ] **Step 1: Import map entry** in `index.html`

Add a line to the `imports` object (keep valid JSON, add the comma on the line before):
```json
        "three-mesh-bvh": "https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.9.15/src/index.js"
```

- [ ] **Step 2: Write `js/collide.js`**

```js
// Ray casts against the solid parts of Claude's world (plan meshes and car
// models), for walking. three-mesh-bvh makes each cast cost microseconds
// instead of milliseconds on a ~50k-triangle world.

import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

/** @param {THREE.Mesh[]} meshes  their matrixWorld must be up to date */
export function makeCollider(meshes) {
  for (const m of meshes) {
    if (!m.geometry.boundsTree) m.geometry.boundsTree = new MeshBVH(m.geometry);
    m.raycast = acceleratedRaycast;
  }
  const rc = new THREE.Raycaster();
  rc.firstHitOnly = true;
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  const first = () => rc.intersectObjects(meshes, false)[0] || null;
  return {
    floorAt(x, z, fromY) {
      rc.set(o.set(x, fromY, z), d.set(0, -1, 0)); rc.far = 60;
      const h = first();
      return h ? h.point.y : null;
    },
    hitAhead(x, y, z, ux, uz, far) {
      rc.set(o.set(x, y, z), d.set(ux, 0, uz)); rc.far = far;
      const h = first();
      return h ? h.distance : null;
    },
    dispose() { for (const m of meshes) m.geometry.boundsTree = null; },
  };
}
```

- [ ] **Step 3: Use it in `js/controls.js`**

1. Add at the top: `import { walkStep } from './walk.js';`
2. In the constructor, after `this.bounds = ...;` add:
```js
    this.collide = null;   // a collider (js/collide.js) when the world has solid ground and walls
    this.foot = 0;         // height of the surface under you (with a collider)
    this.eye = 1.6;
```
3. In `update(dt)`, replace the four lines
```js
    p.x = Math.min(b.maxX, Math.max(b.minX, p.x + dx));
    p.z = Math.min(b.maxZ, Math.max(b.minZ, p.z + dz));
    p.y = 0;
```
with
```js
    if (this.collide) {
      const next = walkStep({ x: p.x, z: p.z, foot: this.foot }, dx, dz, this.collide.floorAt, this.collide.hitAhead, { eye: this.eye });
      p.x = Math.min(b.maxX, Math.max(b.minX, next.x));
      p.z = Math.min(b.maxZ, Math.max(b.minZ, next.z));
      this.foot = next.foot;
      p.y = this.foot + this.eye;
    } else {
      p.x = Math.min(b.maxX, Math.max(b.minX, p.x + dx));
      p.z = Math.min(b.maxZ, Math.max(b.minZ, p.z + dz));
      p.y = 0;
    }
```

- [ ] **Step 4: Plan-mode walking field of view in `js/world.js`**

In the returned `info`, change `walkFov,` to `walkFov: planMode ? () => 70 : walkFov,`.

- [ ] **Step 5: Collider per world and the step-down in `js/main.js`**

1. Add the import: `import { makeCollider } from './collide.js';` and a module variable under `let lastScan = null;`: `let collider = null;`
2. In `setWorld`, right after `scene.add(world.group);` add:
```js
  // Claude's world is solid: walking follows its ground and stops at its walls and cars.
  if (collider) { collider.dispose(); collider = null; }
  walk.collide = null;
  if (world.info.plan) {
    world.group.updateMatrixWorld(true);
    const meshes = [...world.planScene.meshes];
    for (const m of world.models()) m.traverse((o) => { if (o.isMesh) meshes.push(o); });
    collider = makeCollider(meshes);
    walk.collide = collider;
  }
```
3. Replace `walkPose` with:
```js
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
```
4. In `setMode`, replace the walk branch's `flyTo(walkPose(world.info), 1900, () => {` and its first line so it reads:
```js
    const pose = walkPose(world.info);
    flyTo(pose, 1900, () => {
      mode = 'walk'; walk.enabled = true; walk.syncFromCamera();
      if (pose.foot != null) walk.foot = pose.foot;
```
(keep the rest of the callback as it is).

- [ ] **Step 6: Check**

Run: `node --check js/collide.js && node --check js/controls.js && node --check js/main.js && node --check js/world.js && node --test tests/*.test.mjs`
Expected: clean; 61 pass. Also check the import map is valid JSON: `python3 -c "import json,re;s=open('index.html').read();json.loads(re.search(r'<script type=\"importmap\">(.*?)</script>',s,re.S).group(1))" && echo ok`.

Browser (dev server running): load the frame and `tools/fixtures/crossing-plan-claude.json` as in Task 1 (without `setMode`), then:
```js
async () => {
  const pw = window.__pw;
  pw.setMode('walk');
  await new Promise((r) => setTimeout(r, 2500));
  const c = pw.camera, start = c.position.toArray().map((v) => +v.toFixed(2));
  // Walk forward 6 s with W held, then report where we are. Dispatch from the body:
  // the controls read e.target.closest(), which window doesn't have.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
  await new Promise((r) => setTimeout(r, 6000));
  document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
  return { start, after: c.position.toArray().map((v) => +v.toFixed(2)), foot: pw.walk.foot, collide: Boolean(pw.walk.collide) };
}
```
Expected: `start` is about `[0, -6 + 1.6, -3]` (the plan's camera is 6 m up); `collide: true`; after walking, `y - foot` is 1.6 and the position moved forward but stopped before passing through the car if it was in the way. Take a screenshot at the start (street level) and after the walk. Then hold `a` (strafe left) for 4 s toward the median kerb and confirm `foot` becomes about 0.15 to 0.2 (stepped up) or the position stops at the hedge. Finally trigger a rebuild while walking (`pw.setPlan(pw.plan)`) and confirm `pw.walk.collide` is set again and the camera position and `foot` are unchanged.

- [ ] **Step 7: Commit**

```bash
git add index.html js/collide.js js/controls.js js/main.js js/world.js
git commit -m "Walk Claude's world: step down to the street, follow kerbs, stop at walls and cars"
```

---

### Task 5: Cars from the plan when the photo can't place them

**Files:**
- Modify: `js/world.js`

**Interfaces:**
- Consumes: `surfaceTopAt` (Task 2), plan vehicles' `at` (M1), `scene.camera.height_m`, `pitch`.
- Produces: in plan mode, a vehicle whose photo fit fails (no fit, IoU < 0.3) or can't be trusted (no metric ground fit, `calib` null) is built at the plan's `at`, on the plan's ground, turned to its `heading_deg`. `info.objects[i].fit` gains `fromPlan: true` for those.

- [ ] **Step 1: Edit `attachCar` in `js/world.js`**

1. Add `surfaceTopAt` to the scenebuild import: `import { buildPlanScene, surfaceTopAt } from './scenebuild.js';`
2. In `attachCar`, replace these lines
```js
    ob.carFit = fit;
    if (!fit || fit.iou < 0.3) { car.geometry.dispose(); return fit; }
    const matrix = restOnGround(fit.matrix, car.points);
```
with
```js
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
```
3. Change `const fit = fitObject({` at the top of `attachCar` to `let fit = fitObject({`.
4. In the returned `info.objects` mapping, change `fit: o.carFit ? { iou: o.carFit.iou, yaw: o.carFit.yaw } : null` to `fit: o.carFit ? { iou: o.carFit.iou, yaw: o.carFit.yaw, fromPlan: Boolean(o.carFit.fromPlan) } : null`.

- [ ] **Step 2: Check**

Run: `node --check js/world.js && node --test tests/*.test.mjs`
Expected: clean; 61 pass.
Browser: load the frame, then a copy of the Claude plan with the ground outline removed so the metric fit can't run:
```js
async () => {
  const blob = await (await fetch('tools/fixtures/crossing-clean.jpg')).blob();
  document.querySelector('#smart').checked = false;
  await window.__pw.processFile(new File([blob], 'crossing-clean.jpg', { type: 'image/jpeg' }));
  const plan = await (await fetch('tools/fixtures/crossing-plan-claude.json')).json();
  plan.ground_polygon = [];
  window.__pw.setPlan(plan);
  const w = window.__pw.world, THREE = window.__THREE;
  const m = w.models()[0];
  const p = m ? new THREE.Vector3().setFromMatrixPosition(m.matrixWorld) : null;
  return { measured: w.info.measured, fit: w.info.objects[0]?.fit, at: plan.vehicles[0].at, h: plan.camera.height_m, modelAt: p && p.toArray().map((v) => +v.toFixed(2)) };
}
```
Expected: `measured: false`, `fit.fromPlan: true`, and `modelAt` is about `[at[0], -h, -at[1]]` (within 0.3 m; y is the road under it). Take a screenshot from street level next to it (as in Task 4) to confirm it stands on the road, upright, facing the camera's way within Claude's heading.

- [ ] **Step 3: Commit**

```bash
git add js/world.js
git commit -m "Cars stand where Claude's plan says when the photo can't place them"
```

---

### Task 6: Walk the Hyundai world for real, results and go/no-go

**Files:**
- Create: `docs/superpowers/notes/2026-10-15-m2-results.md`, `docs/superpowers/notes/m2/*.jpg`, `tools/fixtures/crossing-plan-claude-m2.json`

- [ ] **Step 1: Fresh Claude run with the new views**

With the dev server running (it has the key and `CLAUDE_WORLD=1`), open `http://localhost:3000/?plan=1`, make sure Smart scene is on, and run the frame as in M1 Task 9 (`processFile` with `tools/fixtures/crossing-clean.jpg`). Poll `__pw.planState` / `__pw.planLog` until `done` or `failed` (give up after 15 minutes). Record per call: time, input / cache write / cache read / output (thinking) tokens, cost (Opus 5.5: $4 in, $5 cache write, $0.20 cache read, $20 out per million), Claude's note.

- [ ] **Step 2: Walk it**

Press Walk in (step-down), then take screenshots: street level at the start; walking up to the crosswalk; at the car (standing beside it, it blocks you); stepping onto the median (kerb); looking back toward the camera's pole; one diagonal walk into the hedge (you slide along it). Save as JPEG (1200 px, quality 80) under `docs/superpowers/notes/m2/`. Save the final plan with `() => window.__pw.plan` to `tools/fixtures/crossing-plan-claude-m2.json`.

- [ ] **Step 3: Write `docs/superpowers/notes/2026-10-15-m2-results.md`**

Outline (fill every value from the run):
```markdown
# Claude World M2 results (walking the Hyundai frame)

## Numbers
(table as in the M1 note: plan and each round, time, tokens, cost, Claude's note; total)

## Walking
One paragraph per screenshot: what you can do there, what stops you, what looks wrong.

## Against the spec (milestone 2)
- Step down to the street: met / partly / not met, evidence
- Collision (kerbs, hedges, poles, walls, cars): ...
- Cars from the plan when the photo can't place them: ...
- Correction views show the 3D car: ...

## Problems found

## Recommendation
Go / no-go for milestone 3 (overlay cleaning), and what to change first.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-10-15-m2-results.md docs/superpowers/notes/m2 tools/fixtures/crossing-plan-claude-m2.json
git commit -m "Claude World: M2 walk-through of the Hyundai frame, results"
```

- [ ] **Step 5: Go/no-go with the user**

Show the screenshots and numbers, give the recommendation, and stop. Milestone 3 starts only on their go.
