# Claude World, Milestone 1: the core loop on the Hyundai frame

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude (Opus 5.5) turns one traffic-camera frame into a metric plan of the place, the browser builds that plan in 3D with the photo projected onto it, Claude corrects the plan over up to 5 rounds from renders of the world, and we measure cost, time and look on the Hyundai frame for a go/no-go decision.

**Architecture:** `api/scene.js` gains `plan` and `refine` actions (raw `fetch`, structured outputs). Pure modules (`js/camera.js`, `js/plan.js`, `js/tiles.js`, `js/refine-loop.js`) hold the maths and are unit-tested with Node's built-in runner. `js/scenebuild.js` turns a plan into three.js meshes with a photo-projection shader; `js/world.js` uses it instead of its depth sheet when the scene answer has `surfaces`; `js/refine.js` renders the four views Claude checks; `js/main.js` runs the flow behind the `?plan=1` URL flag so the live site's behaviour is unchanged.

**Tech Stack:** Plain ES modules in the browser, three.js 0.186.1 from jsDelivr through the existing import map, Vercel Node functions (CommonJS), Anthropic Messages API over `fetch`, Node 26 `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-15-claude-world-design.md` (this plan covers its milestone 1).

## Global Constraints

- No build step, no `package.json`, no npm dependencies. Browser code imports `three` and `three/addons/...` through the import map in `index.html` (three@0.186.1).
- Code style matches the repo: 2-space indent, single quotes, semicolons, short plain comments that explain why.
- Units and frame: metres; the levelled world of `world.js` (camera at the origin, ground at `y = -h`, photo looking down -z after removing the pitch). Plan ground positions are `[right_m, fwd_m]`; world point = `[right_m, top - h, -fwd_m]`.
- Headings: 0 = the object's front faces the camera, 90 = its front points to the image's right; in three.js that is `rotation.y = heading in radians`.
- Claude calls: model `claude-opus-5-5` (env `CLAUDE_PLAN_MODEL`), `thinking: {type: 'adaptive'}`, `output_config: {effort: 'high' (env CLAUDE_PLAN_EFFORT), format: {type: 'json_schema', schema}}`, `fallbacks: 'default'` with header `anthropic-beta: server-side-fallback-2026-07-01`, raw `fetch` like today's request.
- Vercel limits: `maxDuration` 300 s for `api/scene.js`; request bodies under 4.5 MB.
- Image limits: frame up to 2576 px on the long edge; plan/refine frame base64 at most 2,600,000 characters; each render at most 700,000.
- The plan path runs only with `?plan=1` in the page URL and Smart scene on. Without the flag the site behaves exactly as today.
- Tests: `node --test tests/*.test.mjs` from the repo root. Never print, log or commit API keys; local keys live in `~/.config/pocket-world/<name>_key`.
- Work on branch `claude-world-m1`, never on `main`.

## Review Focus

1. **A wildly wrong camera from Claude** (pitch 0 for a camera pointing down, height 1000 m): the plan must still validate to sane numbers and the world must still build, so a refine round can fix it. Pinned in Task 3 (`clamps the camera`).
2. **Broken geometry from Claude** (two-point polygons, bow-tie polygons, slivers, duplicate ids, unknown kinds): the element is dropped, the rest builds. Pinned in Task 3 (`drops broken surfaces`, `dedupes ids`, `drops unknown object kinds`).
3. **A Claude call that outlives the function** (Opus taking more than 300 s): the server answers 504 with a clear error before Vercel kills it; the loop keeps the last good plan and stops. Pinned in Task 4 (`times out cleanly`) and Task 7 (`stops on a failed call`).
4. **A refine answer that would wipe the world** (removes every surface, or is not an object): the previous plan stays and the loop stops. Pinned in Task 3 (`refuses a patch that leaves no surfaces`) and Task 7 (`stops on a rejected patch`).
5. **Oversized payloads** (a huge frame or renders): the server refuses with 400 instead of a Vercel 413, and the browser shrinks the frame before sending. Pinned in Task 4 (`refuses an oversized frame`, `refine needs exactly four renders`).

---

## File structure

| File | Status | Responsibility |
| --- | --- | --- |
| `tools/dev-server.mjs` | new | Local server: static files with isolation headers + `api/*.js` handlers, keys from `~/.config/pocket-world` |
| `tools/fixtures/crossing-clean.jpg`, `crossing-raw.jpg` | new | The Hyundai frame (overlays removed by hand; and raw) |
| `tools/fixtures/crossing-plan-handmade.json` | new | A rough plan for the frame, to test building without API calls |
| `js/camera.js` | new | Photo camera maths (pure) |
| `js/plan.js` | new | Validate/clean a plan, merge a refine patch (pure) |
| `js/tiles.js` | new | Material tiles cut from the photo, rectified for ground materials (pure) |
| `js/refine-loop.js` | new | The refine loop with injected render/call/apply (pure) |
| `js/scenebuild.js` | new | Plan to three.js meshes, projection shader, depth pass |
| `js/refine.js` | new | The four views Claude checks |
| `api/scene.js` | modify | `plan` and `refine` actions, schemas, prompts |
| `js/world.js` | modify | Use the plan scene instead of the depth sheet when the scene has `surfaces` |
| `js/main.js` | modify | Hi-res copy, plan flow behind `?plan=1`, `window.__pw` hooks |
| `vercel.json` | modify | `api/scene.js` maxDuration 300 |
| `.gitignore` | modify | `.playwright-mcp/`, `.env*.local` |
| `tests/*.test.mjs` | new | Unit tests |
| `docs/superpowers/notes/2026-10-15-m1-results.md` | new (Task 9) | Measured cost, time, screenshots, go/no-go |

---

### Task 1: Branch, fixtures and the local dev server

**Files:**
- Create: `tools/dev-server.mjs`, `tests/dev-server.test.mjs`, `tools/fixtures/crossing-clean.jpg`, `tools/fixtures/crossing-raw.jpg`
- Modify: `.gitignore`
- Add to git: `docs/superpowers/specs/2026-10-15-claude-world-design.md`, `docs/superpowers/plans/2026-10-15-claude-world-m1.md`

**Interfaces:**
- Produces: `node tools/dev-server.mjs [port]` serving the repo on `http://localhost:<port>` (default 3000) with COOP/COEP headers; `POST|GET /api/<name>` runs `api/<name>.js`; keys loaded from env or `~/.config/pocket-world/{anthropic_key,wlt_key,fal_key}`; bodies over 4.5 MB get 413.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/zhan/personal/pocket-world
git checkout -b claude-world-m1
```

- [ ] **Step 2: Copy the fixtures**

```bash
S=/private/tmp/claude-501/-Users-zhan-personal-pocket-world/fa77bc53-59ee-48da-b9c1-e99256cda410/scratchpad/spike/in
mkdir -p tools/fixtures
cp "$S/cam_clean.jpg" tools/fixtures/crossing-clean.jpg
cp "$S/cam_raw.jpg" tools/fixtures/crossing-raw.jpg
sips -g pixelWidth -g pixelHeight tools/fixtures/crossing-clean.jpg
```
Expected: `pixelWidth: 1688`, `pixelHeight: 1070`.

- [ ] **Step 3: Update `.gitignore`**

Append these two lines to `.gitignore`:

```
.playwright-mcp/
.env*.local
```

- [ ] **Step 4: Write the failing test** `tests/dev-server.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withServer(fn) {
  const port = 4100 + Math.floor(Math.random() * 800);
  const home = mkdtempSync(path.join(tmpdir(), 'pw-home-'));
  const child = spawn(process.execPath, [path.join(root, 'tools/dev-server.mjs'), String(port)], {
    env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: '', WLT_API_KEY: '', FAL_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('dev server')) resolve(); });
    child.on('exit', () => reject(new Error('server exited')));
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });
  try { await fn(`http://localhost:${port}`); } finally { child.kill(); }
}

test('serves the site with isolation headers', () => withServer(async (base) => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-embedder-policy'), 'credentialless');
  assert.match(await r.text(), /Pocket World/);
}));

test('runs api handlers', () => withServer(async (base) => {
  const r = await fetch(`${base}/api/scene`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).enabled, false);
}));

test('never serves files outside the project', () => withServer(async (base) => {
  const r = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
  assert.ok(r.status === 403 || r.status === 404, `status ${r.status}`);
}));

test('rejects bodies over 4.5 MB like Vercel', () => withServer(async (base) => {
  const r = await fetch(`${base}/api/scene`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(4.6e6) });
  assert.equal(r.status, 413);
}));
```

- [ ] **Step 5: Run it to see it fail**

Run: `node --test tests/dev-server.test.mjs`
Expected: FAIL (`server exited`), because `tools/dev-server.mjs` doesn't exist.

- [ ] **Step 6: Write `tools/dev-server.mjs`**

```js
// Local dev server: serves the site like serve.py (same isolation headers) and
// runs the Vercel functions in api/ in-process, so Claude, Marble and fal work
// locally without `vercel dev`.
//
//   node tools/dev-server.mjs [port]
//
// Keys come from the environment, or from files in ~/.config/pocket-world:
//   ANTHROPIC_API_KEY <- anthropic_key, WLT_API_KEY <- wlt_key, FAL_KEY <- fal_key

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const port = Number(process.argv[2]) || 3000;
const MAX_BODY = 4.5e6;   // Vercel's request body limit (4.5 MB)

for (const [env, file] of [['ANTHROPIC_API_KEY', 'anthropic_key'], ['WLT_API_KEY', 'wlt_key'], ['FAL_KEY', 'fal_key']]) {
  if (process.env[env]) continue;
  try { process.env[env] = fs.readFileSync(path.join(os.homedir(), '.config/pocket-world', file), 'utf8').trim(); } catch {}
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.scan': 'application/octet-stream', '.spz': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

async function runApi(name, req, res) {
  const file = path.join(root, 'api', `${name}.js`);
  if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { res.statusCode = 413; return res.end(JSON.stringify({ error: 'FUNCTION_PAYLOAD_TOO_LARGE' })); }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  req.body = raw;
  if ((req.headers['content-type'] || '').includes('application/json')) { try { req.body = JSON.parse(raw); } catch {} }
  delete require.cache[file];   // pick up edits without a restart
  try { await require(file)(req, res); }
  catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: 'dev server: handler crashed' })); }
  }
}

http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cache-Control', 'no-cache');
  const url = new URL(req.url, 'http://localhost');
  const api = /^\/api\/([^/]+)$/.exec(url.pathname);
  if (api) return runApi(api[1], req, res);
  let rel;
  try { rel = path.normalize(decodeURIComponent(url.pathname)); } catch { res.statusCode = 400; return res.end(); }
  if (rel.endsWith(path.sep)) rel += 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
}).listen(port, () => console.log(`Pocket World dev server on http://localhost:${port}`));
```

- [ ] **Step 7: Run the test to see it pass**

Run: `node --test tests/dev-server.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```bash
git add .gitignore tools/dev-server.mjs tests/dev-server.test.mjs tools/fixtures/crossing-clean.jpg tools/fixtures/crossing-raw.jpg docs/superpowers/specs/2026-10-15-claude-world-design.md docs/superpowers/plans/2026-10-15-claude-world-m1.md
git commit -m "Claude World: local dev server, Hyundai fixtures, spec and M1 plan"
```

---

### Task 2: Camera maths (`js/camera.js`)

**Files:**
- Create: `js/camera.js`, `tests/camera.test.mjs`

**Interfaces:**
- Produces:
  - `photoCamera({W, H, hfovDeg, pitchDeg, heightM}) -> {W, H, f, cx, cy, pitch, h}` (pitch in radians; `f` exactly as `world.js` computes it)
  - `toCamera(cam, [x, y, z]) -> [x, y, z]` levelled world to camera frame
  - `project(cam, [x, y, z]) -> {u, v, depth} | null`
  - `groundPoint(cam, r, fwd, top = 0) -> [x, y, z]`
  - `pixelToGround(cam, u, v, top = 0) -> [right_m, fwd_m] | null`
  - `FOV_LONG_DEG = 65`

- [ ] **Step 1: Write the failing test** `tests/camera.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoCamera, project, groundPoint, pixelToGround, toCamera } from '../js/camera.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('focal length matches world.js', () => {
  near(photoCamera({ W: 1000, H: 500, hfovDeg: 60 }).f, 500 / Math.tan(Math.PI / 6));
  // Below 25 degrees world.js falls back to a 65 degree lens on the long side.
  near(photoCamera({ W: 1000, H: 500, hfovDeg: 10 }).f, 500 / Math.tan((65 * Math.PI) / 360));
});

test('clamps like world.js', () => {
  const c = photoCamera({ W: 100, H: 100, hfovDeg: 60, pitchDeg: 200, heightM: 1000 });
  near(c.pitch, (85 * Math.PI) / 180);
  assert.equal(c.h, 400);
});

test('image centre hits the ground at h / tan(pitch)', () => {
  const cam = photoCamera({ W: 1600, H: 900, hfovDeg: 45, pitchDeg: 30, heightM: 4 });
  const g = pixelToGround(cam, 800, 450);
  near(g[0], 0);
  near(g[1], 4 / Math.tan(Math.PI / 6));
});

test('a level camera sees a pixel 100 px below centre at 1.5 f / 100 metres', () => {
  const cam = photoCamera({ W: 1000, H: 1000, hfovDeg: 60, pitchDeg: 0, heightM: 1.5 });
  const g = pixelToGround(cam, 500, 600);
  near(g[1], (1.5 * cam.f) / 100);
});

test('project and pixelToGround are inverses on the ground', () => {
  const cam = photoCamera({ W: 1688, H: 1070, hfovDeg: 43, pitchDeg: 13, heightM: 4.4 });
  for (const [r, f] of [[0, 20], [-5, 30], [6, 12], [2, 60]]) {
    const p = project(cam, groundPoint(cam, r, f));
    assert.ok(p, `ground point ${r},${f} should be in front`);
    const back = pixelToGround(cam, p.u, p.v);
    near(back[0], r, 1e-6);
    near(back[1], f, 1e-6);
  }
});

test('raised surfaces use their own plane', () => {
  const cam = photoCamera({ W: 1000, H: 1000, hfovDeg: 60, pitchDeg: 20, heightM: 5 });
  const p = project(cam, groundPoint(cam, 1, 15, 0.15));
  const back = pixelToGround(cam, p.u, p.v, 0.15);
  near(back[0], 1);
  near(back[1], 15);
});

test('behind the camera and above the horizon give null', () => {
  const cam = photoCamera({ W: 1000, H: 1000, hfovDeg: 60, pitchDeg: 10, heightM: 3 });
  assert.equal(project(cam, groundPoint(cam, 0, -10)), null);
  assert.equal(pixelToGround(cam, 500, 0), null);   // top edge is above the horizon at 10 degrees down
});

test('toCamera matches the rotation world.js uses (content.rotation.x = -pitch)', () => {
  const cam = photoCamera({ W: 100, H: 100, hfovDeg: 60, pitchDeg: 85, heightM: 2 });
  // Looking almost straight down, the point straight below the camera sits near its forward axis.
  const [x, y, z] = toCamera(cam, [0, -2, 0]);
  near(x, 0);
  assert.ok(z < 0 && Math.abs(y) < Math.abs(z));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/camera.test.mjs`
Expected: FAIL with `Cannot find module` for `js/camera.js`.

- [ ] **Step 3: Write `js/camera.js`**

```js
// The photo's camera as a pinhole, in the levelled world world.js uses when
// Claude has described the scene: camera at the origin, ground plane at
// y = -h, looking down -z and tilted down by `pitch`. Plan positions on the
// ground are [right_m, fwd_m]; fwd_m is -z.
//
// Plain maths with no three.js, so it runs in tests too.

export const FOV_LONG_DEG = 65;   // the fallback lens world.js assumes

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * @param {{W: number, H: number, hfovDeg?: number, pitchDeg?: number, heightM?: number}} o
 * @returns {{W: number, H: number, f: number, cx: number, cy: number, pitch: number, h: number}}
 */
export function photoCamera({ W, H, hfovDeg = 0, pitchDeg = 0, heightM = 1.5 }) {
  const hfov = clamp(Number(hfovDeg) || 0, 0, 120);
  const L = Math.max(W, H);
  const f = hfov >= 25 ? (W / 2) / Math.tan((hfov * Math.PI) / 360) : (L / 2) / Math.tan((FOV_LONG_DEG * Math.PI) / 360);
  const pitch = (clamp(Number(pitchDeg) || 0, -45, 85) * Math.PI) / 180;
  return { W, H, f, cx: W / 2, cy: H / 2, pitch, h: clamp(Number(heightM) || 1.5, 0.3, 400) };
}

/** Levelled world point -> the camera's own frame (x right, y up, looking down -z). */
export function toCamera(cam, [x, y, z]) {
  const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
  return [x, y * c - z * s, y * s + z * c];
}

/** Levelled world point -> photo pixel, or null when it is behind the camera. */
export function project(cam, p) {
  const [x, y, z] = toCamera(cam, p);
  if (z > -1e-6) return null;
  return { u: cam.cx + (cam.f * x) / -z, v: cam.cy - (cam.f * y) / -z, depth: -z };
}

/** Ground position [right_m, fwd_m], `top` metres above the road -> levelled world point. */
export function groundPoint(cam, r, fwd, top = 0) {
  return [r, top - cam.h, -fwd];
}

/** Photo pixel -> [right_m, fwd_m] where its ray meets the plane `top` metres above the road; null at or above the horizon. */
export function pixelToGround(cam, u, v, top = 0) {
  const dx = (u - cam.cx) / cam.f, dy = -(v - cam.cy) / cam.f, dz = -1;
  const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
  // Camera frame -> levelled world: rotate by -pitch about x.
  const wy = dy * c + dz * s, wz = -dy * s + dz * c;
  const planeY = top - cam.h;
  if (wy > -1e-6 || planeY >= 0) return null;
  const t = planeY / wy;
  return [dx * t, -wz * t];
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --test tests/camera.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add js/camera.js tests/camera.test.mjs
git commit -m "Claude World: photo camera maths"
```

---

### Task 3: Plan validation and patches (`js/plan.js`)

**Files:**
- Create: `js/plan.js`, `tests/plan.test.mjs`

**Interfaces:**
- Produces:
  - `validatePlan(raw) -> Plan | null`. `Plan` = `{caption, scene_type, camera: {height_m, pitch_deg, hfov_deg}, ground_polygon: [{x, y}], subjects, vehicles: [{...today's vehicle fields, id, at: [r, f] | null}], sky: {top, horizon}, ground_color, overlays: [{kind, box}], materials: [{id, kind, color, sample_box}], surfaces: [{id, kind, material, polygon, top_m}], markings: [{id, kind, color, color2, points, width_m, dash_m, gap_m}], objects: [{id, kind, at, path, height_m, width_m, depth_m, heading_deg, material, color, seen, sign}], extent_m, notes}`
  - `applyPatch(plan, patch) -> Plan` (returns the **same object** when the patch is rejected)
  - Constants `LIMITS`, `MATERIAL_KINDS`, `SURFACE_KINDS`, `MARKING_KINDS`, `OBJECT_KINDS`, `PATH_KINDS`, `OVERLAY_KINDS` (the server schema in Task 4 uses the same lists)

- [ ] **Step 1: Write the failing test** `tests/plan.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan, applyPatch } from '../js/plan.js';

const base = () => ({
  caption: 'Road crossing', scene_type: 'road',
  camera: { height_m: 4.4, pitch_deg: 13, hfov_deg: 43 },
  ground_polygon: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  subjects: [], vehicles: [], sky: { top: '#9fc0e8', horizon: '#d3dee8' }, ground_color: '#6f7a5a',
  overlays: [],
  materials: [{ id: 'mat-asphalt', kind: 'asphalt', color: '#666666', sample_box: [0.4, 0.3, 0.5, 0.4] }],
  surfaces: [{ id: 's1', kind: 'road', material: 'mat-asphalt', polygon: [[-7, -40], [7, -40], [7, 120], [-7, 120]], top_m: 0 }],
  markings: [{ id: 'm1', kind: 'crosswalk', color: '#f0f0f0', color2: '#e8c84a', points: [[-6, 20], [7, 20]], width_m: 3.5, dash_m: 0.5, gap_m: 0.5 }],
  objects: [{ id: 'o1', kind: 'sign', at: [-6.5, 21], path: null, height_m: 3, width_m: 0.7, depth_m: 0.05, heading_deg: 0, material: null, color: '#888888', seen: true, sign: { shape: 'square', face_color: '#2a6bd6', symbol: 'pedestrian_crossing' } }],
  extent_m: 60, notes: 'first plan',
});

test('returns null for nonsense', () => {
  assert.equal(validatePlan(null), null);
  assert.equal(validatePlan('plan'), null);
});

test('keeps a good plan', () => {
  const p = validatePlan(base());
  assert.equal(p.surfaces.length, 1);
  assert.equal(p.markings.length, 1);
  assert.equal(p.objects[0].sign.symbol, 'pedestrian_crossing');
  assert.deepEqual(p.camera, { height_m: 4.4, pitch_deg: 13, hfov_deg: 43 });
});

test('clamps the camera', () => {
  const raw = base();
  raw.camera = { height_m: 1000, pitch_deg: 200, hfov_deg: 5 };
  assert.deepEqual(validatePlan(raw).camera, { height_m: 120, pitch_deg: 85, hfov_deg: 25 });
  raw.camera = { height_m: 'tall', pitch_deg: null };
  assert.deepEqual(validatePlan(raw).camera, { height_m: 1.5, pitch_deg: 0, hfov_deg: 65 });
});

test('drops broken surfaces', () => {
  const raw = base();
  raw.surfaces.push(
    { id: 's2', kind: 'road', material: null, polygon: [[0, 0], [1, 1]], top_m: 0 },                          // two points
    { id: 's3', kind: 'grass', material: null, polygon: [[0, 0], [0.5, 0], [0.5, 0.5]], top_m: 0 },           // 0.125 m2 sliver
    { id: 's4', kind: 'grass', material: null, polygon: [[0, 0], [10, 10], [10, 0], [0, 10]], top_m: 0 },     // bow tie
    { id: 's5', kind: 'sidewalk', material: 'nope', polygon: [[8, 0], [12, 0], [12, 30], [8, 30]], top_m: 5 },
  );
  const p = validatePlan(raw);
  assert.deepEqual(p.surfaces.map((s) => s.id), ['s1', 's5']);
  assert.equal(p.surfaces[1].material, null);   // unknown material id
  assert.equal(p.surfaces[1].top_m, 1);         // clamped
});

test('dedupes ids', () => {
  const raw = base();
  raw.surfaces.push({ ...raw.surfaces[0] });
  const ids = validatePlan(raw).surfaces.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('drops unknown object kinds and path kinds without a path', () => {
  const raw = base();
  raw.objects.push(
    { ...raw.objects[0], id: 'o2', kind: 'spaceship' },
    { ...raw.objects[0], id: 'o3', kind: 'hedge', at: [3, 3], path: null, sign: null },
    { ...raw.objects[0], id: 'o4', kind: 'hedge', at: null, path: [[9, 10], [11, 60]], sign: null },
  );
  const p = validatePlan(raw);
  assert.deepEqual(p.objects.map((o) => o.id), ['o1', 'o4']);
  assert.equal(p.objects[1].sign, null);
});

test('crosswalk stripes get a sane width', () => {
  const raw = base();
  raw.markings[0].dash_m = 0;
  assert.equal(validatePlan(raw).markings[0].dash_m, 0.5);
});

test('overlay boxes are ordered and clamped; broken ones dropped', () => {
  const raw = base();
  raw.overlays = [{ kind: 'inset', box: [1.2, 0.4, 0.8, 0] }, { kind: 'box', box: [0.5] }, { kind: 'banner', box: [0, 0, 1, 1] }];
  assert.deepEqual(validatePlan(raw).overlays, [{ kind: 'inset', box: [0.8, 0, 1, 0.4] }]);
});

test('vehicles keep their fields and get a clamped at', () => {
  const raw = base();
  raw.vehicles = [{ id: 0, body_style: 'suv', at: [1, 9999] }, { id: 1, body_style: 'sedan', at: 'here' }];
  const p = validatePlan(raw);
  assert.equal(p.vehicles[0].body_style, 'suv');
  assert.deepEqual(p.vehicles[0].at, [1, 120]);   // extent 60 -> range +-120
  assert.equal(p.vehicles[1].at, null);
});

test('applyPatch upserts, removes and merges the camera', () => {
  const p = validatePlan(base());
  const next = applyPatch(p, {
    notes: 'moved the sign', done: false,
    camera: { height_m: 4.6, pitch_deg: 12, hfov_deg: 42 },
    materials: [], markings: [], vehicles: [],
    surfaces: [{ id: 's9', kind: 'median', material: null, polygon: [[-10, 0], [-8, 0], [-8, 50], [-10, 50]], top_m: 0.15 }],
    objects: [{ ...p.objects[0], at: [-7, 22] }],
    remove: ['m1'],
  });
  assert.notEqual(next, p);
  assert.deepEqual(next.surfaces.map((s) => s.id), ['s1', 's9']);
  assert.deepEqual(next.objects[0].at, [-7, 22]);
  assert.equal(next.markings.length, 0);
  assert.equal(next.camera.height_m, 4.6);
  assert.equal(next.notes, 'moved the sign');
});

test('refuses a patch that leaves no surfaces, or is not an object', () => {
  const p = validatePlan(base());
  assert.equal(applyPatch(p, { remove: ['s1'] }), p);
  assert.equal(applyPatch(p, null), p);
  assert.equal(applyPatch(p, 'oops'), p);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/plan.test.mjs`
Expected: FAIL with `Cannot find module` for `js/plan.js`.

- [ ] **Step 3: Write `js/plan.js`**

```js
// Checks and cleans Claude's plan of a place (api/scene.js) so a bad answer
// can never break the 3D build: numbers are clamped to sane ranges, broken
// elements are dropped, ids are made unique. Also merges the changes Claude
// sends back in a refine round.
//
// Plain JS with no three.js, so it runs in tests too.

export const LIMITS = { materials: 24, surfaces: 30, markings: 40, objects: 120, vehicles: 12, overlays: 12, points: 40 };
export const MATERIAL_KINDS = ['asphalt', 'concrete', 'paving', 'curb', 'grass', 'soil', 'gravel', 'hedge', 'foliage', 'bark', 'facade', 'glass', 'metal', 'paint', 'water'];
export const SURFACE_KINDS = ['road', 'lane', 'sidewalk', 'median', 'island', 'grass', 'verge', 'parking', 'plaza', 'driveway'];
export const MARKING_KINDS = ['lane_solid', 'lane_dashed', 'edge_line', 'stop_line', 'crosswalk'];
export const OBJECT_KINDS = ['pole', 'lamp_post', 'sign', 'traffic_light', 'tree', 'bush', 'hedge', 'fence', 'wall', 'barrier', 'bollard', 'building', 'shelter', 'gantry'];
export const PATH_KINDS = new Set(['hedge', 'fence', 'wall', 'barrier', 'building', 'gantry']);
export const OVERLAY_KINDS = ['inset', 'box', 'text', 'logo', 'border'];
const SIGN_SHAPES = ['square', 'rectangle', 'circle', 'triangle', 'diamond', 'octagon'];

const num = (v, a, b, d) => { const x = Number(v); return v !== null && v !== '' && Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : d; };
const str = (v, max = 60) => (typeof v === 'string' ? v.slice(0, max) : '');
const hex = (v, d) => (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith('#') ? v : '#' + v).toLowerCase() : d);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function point(p, R) {
  if (!Array.isArray(p) || p.length < 2) return null;
  const r = Number(p[0]), f = Number(p[1]);
  if (!Number.isFinite(r) || !Number.isFinite(f)) return null;
  return [num(r, -R, R, 0), num(f, -R, R, 0)];
}

function points(a, R, min) {
  if (!Array.isArray(a)) return null;
  const out = [];
  for (const p of a.slice(0, LIMITS.points)) {
    const q = point(p, R);
    if (q && !(out.length && out[out.length - 1][0] === q[0] && out[out.length - 1][1] === q[1])) out.push(q);
  }
  return out.length >= min ? out : null;
}

function box(b) {
  if (!Array.isArray(b) || b.length < 4) return null;
  const v = b.slice(0, 4).map((x) => num(x, 0, 1, NaN));
  if (!v.every(Number.isFinite)) return null;
  const out = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  return out[2] - out[0] > 0.002 && out[3] - out[1] > 0.002 ? out : null;
}

function area(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(a) / 2;
}

const side = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
function selfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // neighbours share a corner
      const a = poly[i], b = poly[(i + 1) % n], c = poly[j], d = poly[(j + 1) % n];
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
    }
  }
  return false;
}

/** @returns {object|null} a clean plan, or null if `raw` isn't a plan at all */
export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const extent = num(raw.extent_m, 15, 150, 60);
  const R = extent * 2;
  const used = new Set();
  const uid = (v, prefix, i) => {
    let s = str(v, 32) || `${prefix}${i}`;
    while (used.has(s)) s += '_';
    used.add(s);
    return s;
  };

  const camera = {
    height_m: num(raw.camera?.height_m, 0.3, 120, 1.5),
    pitch_deg: num(raw.camera?.pitch_deg, -45, 85, 0),
    hfov_deg: num(raw.camera?.hfov_deg, 25, 120, 65),
  };

  const materials = list(raw.materials, LIMITS.materials).filter((m) => m && typeof m === 'object').map((m, i) => ({
    id: uid(m.id, 'mat', i),
    kind: MATERIAL_KINDS.includes(m.kind) ? m.kind : 'concrete',
    color: hex(m.color, '#808080'),
    sample_box: box(m.sample_box),
  }));
  const matIds = new Set(materials.map((m) => m.id));
  const mat = (v) => (typeof v === 'string' && matIds.has(v) ? v : null);

  const surfaces = [];
  list(raw.surfaces, LIMITS.surfaces).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const polygon = points(s.polygon, R, 3);
    if (!polygon || area(polygon) < 0.5 || selfIntersects(polygon)) return;
    surfaces.push({ id: uid(s.id, 's', i), kind: SURFACE_KINDS.includes(s.kind) ? s.kind : 'road', material: mat(s.material), polygon, top_m: num(s.top_m, 0, 1, 0) });
  });

  const markings = [];
  list(raw.markings, LIMITS.markings).forEach((m, i) => {
    if (!m || typeof m !== 'object' || !MARKING_KINDS.includes(m.kind)) return;
    const pts = points(m.points, R, 2);
    if (!pts) return;
    const color = hex(m.color, '#f2f2f2');
    const crosswalk = m.kind === 'crosswalk';
    markings.push({
      id: uid(m.id, 'm', i), kind: m.kind, color, color2: hex(m.color2, color), points: pts,
      width_m: num(m.width_m, 0.05, 8, crosswalk ? 3 : 0.15),
      dash_m: crosswalk ? (num(m.dash_m, 0, 3, 0) >= 0.2 ? num(m.dash_m, 0, 3, 0.5) : 0.5) : num(m.dash_m, 0, 20, 0),
      gap_m: num(m.gap_m, 0, 20, 0),
    });
  });

  const objects = [];
  list(raw.objects, LIMITS.objects).forEach((o, i) => {
    if (!o || typeof o !== 'object' || !OBJECT_KINDS.includes(o.kind)) return;
    const at = point(o.at, R);
    const path = points(o.path, R, o.kind === 'building' ? 3 : 2);
    if (PATH_KINDS.has(o.kind) ? !path : !(at || path)) return;
    const isSign = o.kind === 'sign';
    objects.push({
      id: uid(o.id, 'o', i), kind: o.kind, at: at || null, path: path || null,
      height_m: num(o.height_m, 0.1, 80, 2), width_m: num(o.width_m, 0.02, 80, 0.3), depth_m: num(o.depth_m, 0.02, 80, 0.3),
      heading_deg: num(o.heading_deg, -360, 360, 0), material: mat(o.material), color: hex(o.color, '#777777'),
      seen: Boolean(o.seen),
      sign: isSign ? {
        shape: SIGN_SHAPES.includes(o.sign?.shape) ? o.sign.shape : 'rectangle',
        face_color: hex(o.sign?.face_color, '#2a5bd7'),
        symbol: str(o.sign?.symbol, 40),
      } : null,
    });
  });

  const vehicles = list(raw.vehicles, LIMITS.vehicles)
    .filter((v) => v && typeof v === 'object' && Number.isInteger(Number(v.id)))
    .map((v) => ({ ...v, id: Number(v.id), at: point(v.at, R) }));

  const overlays = list(raw.overlays, LIMITS.overlays)
    .filter((o) => o && OVERLAY_KINDS.includes(o.kind))
    .map((o) => ({ kind: o.kind, box: box(o.box) }))
    .filter((o) => o.box);

  const ground_polygon = list(raw.ground_polygon, 12)
    .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
    .map((p) => ({ x: num(p.x, 0, 1, 0), y: num(p.y, 0, 1, 0) }));

  return {
    caption: str(raw.caption, 120), scene_type: str(raw.scene_type, 20) || 'road', camera, ground_polygon,
    subjects: Array.isArray(raw.subjects) ? raw.subjects.slice(0, 24) : [], vehicles,
    sky: { top: hex(raw.sky?.top, '#9fc0e8'), horizon: hex(raw.sky?.horizon, '#d3dee8') },
    ground_color: hex(raw.ground_color, '#7a7f6a'),
    overlays, materials, surfaces, markings, objects, extent_m: extent, notes: str(raw.notes, 200),
  };
}

/**
 * Merge a refine round's changes into a plan. Elements in the patch replace
 * the ones with the same id or are added; ids in `remove` are deleted.
 * Returns the same `plan` object when the patch is unusable or would leave
 * the world without any surface.
 */
export function applyPatch(plan, patch) {
  if (!plan || !patch || typeof patch !== 'object' || Array.isArray(patch)) return plan;
  const remove = new Set(Array.isArray(patch.remove) ? patch.remove.map(String) : []);
  const merge = (items, upd) => {
    const out = items.filter((e) => !remove.has(String(e.id)));
    for (const u of Array.isArray(upd) ? upd : []) {
      if (!u || typeof u !== 'object' || u.id == null) continue;
      const i = out.findIndex((e) => String(e.id) === String(u.id));
      if (i >= 0) out[i] = u; else out.push(u);
    }
    return out;
  };
  const next = validatePlan({
    ...plan,
    camera: patch.camera && typeof patch.camera === 'object' ? { ...plan.camera, ...patch.camera } : plan.camera,
    materials: merge(plan.materials, patch.materials),
    surfaces: merge(plan.surfaces, patch.surfaces),
    markings: merge(plan.markings, patch.markings),
    objects: merge(plan.objects, patch.objects),
    vehicles: merge(plan.vehicles, patch.vehicles),
    notes: typeof patch.notes === 'string' ? patch.notes : plan.notes,
  });
  return next && next.surfaces.length ? next : plan;
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --test tests/plan.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add js/plan.js tests/plan.test.mjs
git commit -m "Claude World: validate plans and merge refine patches"
```

---

### Task 4: `plan` and `refine` actions in `api/scene.js`

**Files:**
- Modify: `api/scene.js` (add schemas, prompts, `callClaude`, `planAction`; route in `handler`; extend `GET`; export new names), `vercel.json`
- Create: `tests/scene-api.test.mjs`

**Interfaces:**
- Consumes: kind lists from Task 3 (copied as literal arrays; the server is CommonJS and can't import the browser module).
- Produces:
  - `GET /api/scene -> {enabled, model, plan: boolean, planModel}`
  - `POST {action:'plan', image, width, height, subjects} -> {plan, usage, model, ms}`
  - `POST {action:'refine', image, renders:[4 base64 JPEGs], plan, round} -> {patch, usage, model, ms}`; `patch` = `{notes, done, camera, materials, surfaces, markings, objects, vehicles, remove}`
  - Errors as `{error}` with 400 (bad input), 429 (limits), 502 (Claude error, refusal, cut off), 504 (took too long)
  - `module.exports.PLAN_SCHEMA`, `module.exports.PATCH_SCHEMA` for tests

- [ ] **Step 1: Write the failing test** `tests/scene-api.test.mjs`

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.ANTHROPIC_API_KEY = 'test-key';
const handler = require('../api/scene.js');
const { PLAN_SCHEMA, PATCH_SCHEMA, SCHEMA } = handler;

let ipN = 0;
const req = (body, method = 'POST') => ({ method, headers: { 'x-forwarded-for': `10.0.0.${++ipN}` }, socket: {}, body });
function res() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
}
const json = (r) => JSON.parse(r.body);
const jpeg = (n = 1000) => 'A'.repeat(n);

let calls = [];
let reply = null;
beforeEach(() => {
  calls = [];
  delete process.env.PLAN_TIMEOUT_MS;
  reply = { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"hello":1}' }] };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => reply };
  };
});

test('GET reports the plan feature', async () => {
  const r = res();
  await handler(req(undefined, 'GET'), r);
  assert.equal(json(r).plan, true);
  assert.equal(json(r).planModel, 'claude-opus-5-5');
});

test('plan sends the frame to Opus with the plan schema', async () => {
  const r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 1688, height: 1070, subjects: [{ id: 0, label: 'car', box: [0.4, 0.4, 0.6, 0.7] }] }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(json(r).plan, { hello: 1 });
  const { body, init } = calls[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.output_config.effort, 'high');
  assert.deepEqual(body.output_config.format.schema, PLAN_SCHEMA);
  assert.equal(body.fallbacks, 'default');
  assert.match(init.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  const first = body.messages[0].content[0];
  assert.equal(first.type, 'image');
  assert.deepEqual(first.cache_control, { type: 'ephemeral' });
  assert.match(body.messages[0].content.at(-1).text, /id 0: car/);
});

test('refine sends the frame, four renders and the plan, and returns a patch', async () => {
  const r = res();
  await handler(req({ action: 'refine', image: jpeg(), renders: [jpeg(), jpeg(), jpeg(), jpeg()], plan: { surfaces: [] }, round: 2 }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(json(r).patch, { hello: 1 });
  const content = calls[0].body.messages[0].content;
  assert.equal(content.filter((c) => c.type === 'image').length, 5);
  assert.deepEqual(calls[0].body.output_config.format.schema, PATCH_SCHEMA);
  assert.match(content.at(-1).text, /Round 2/);
});

test('refine needs exactly four renders and a plan', async () => {
  let r = res();
  await handler(req({ action: 'refine', image: jpeg(), renders: [jpeg(), jpeg(), jpeg()], plan: {} }), r);
  assert.equal(r.statusCode, 400);
  r = res();
  await handler(req({ action: 'refine', image: jpeg(), renders: [jpeg(), jpeg(), jpeg(), jpeg()] }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('refuses an oversized frame', async () => {
  const r = res();
  await handler(req({ action: 'plan', image: jpeg(2_700_000), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('a refusal or a cut-off answer is a 502', async () => {
  reply = { ...reply, stop_reason: 'refusal' };
  let r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 502);
  reply = { ...reply, stop_reason: 'max_tokens' };
  r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 502);
});

test('times out cleanly', async () => {
  process.env.PLAN_TIMEOUT_MS = '30';
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 504);
  assert.match(json(r).error, /too long/);
});

test('limits plans per visitor', async () => {
  const ip = '10.9.9.9';
  let last;
  for (let i = 0; i < 7; i++) {
    last = res();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': ip }, socket: {}, body: { action: 'plan', image: jpeg(), width: 10, height: 10 } }, last);
  }
  assert.equal(last.statusCode, 429);
});

test('the old request is unchanged', async () => {
  const r = res();
  await handler(req({ image: jpeg(), width: 10, height: 10, subjects: [] }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
  assert.deepEqual(calls[0].body.output_config.format.schema, SCHEMA);
  assert.equal(calls[0].body.thinking, undefined);
});

test('schemas only use what structured outputs support', () => {
  const banned = ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'multipleOf'];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    for (const k of banned) assert.ok(!(k in node), `${where} uses ${k}`);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${where} needs additionalProperties: false`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${where} must require every property`);
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${where}.${k}`);
    }
    if (node.items) walk(node.items, `${where}[]`);
    if (node.anyOf) node.anyOf.forEach((v, i) => walk(v, `${where}|${i}`));
  };
  walk(PLAN_SCHEMA, 'plan');
  walk(PATCH_SCHEMA, 'patch');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/scene-api.test.mjs`
Expected: FAIL. `PLAN_SCHEMA` is undefined and the plan test gets the old path's answer.

- [ ] **Step 3: Add the schemas after `const SCHEMA = {...};` in `api/scene.js`**

```js
// ---------------------------------------------------------------- plan (Claude World)
// The plan describes the whole place in metres so the browser can build it in
// 3D (js/scenebuild.js). Kind lists match js/plan.js.
const PLAN_MODEL = () => process.env.CLAUDE_PLAN_MODEL || 'claude-opus-5-5';
const PLAN_EFFORT = () => process.env.CLAUDE_PLAN_EFFORT || 'high';
const MAX_FRAME_B64 = 2_600_000;
const MAX_RENDER_B64 = 700_000;
const MAX_PLAN_CHARS = 200_000;
const PLAN_LIMIT = 6;       // plans per IP per hour, per server instance
const REFINE_LIMIT = 40;    // refine rounds per IP per hour, per server instance

const num = { type: 'number' };
const pt = { type: 'array', items: num, description: '[right_m, fwd_m]: metres right of and ahead of the point on the ground below the camera.' };
const pts = (description) => ({ type: 'array', items: pt, description });
const nbox = { type: 'array', items: num, description: '[x0, y0, x1, y1] in normalized image coordinates (x right, y down, 0 to 1).' };
const orNull = (s) => ({ anyOf: [s, { type: 'null' }] });
const idStr = { type: 'string', description: 'Short stable id, kept the same in later rounds.' };

const MATERIAL = {
  type: 'object', additionalProperties: false, required: ['id', 'kind', 'color', 'sample_box'],
  properties: {
    id: idStr,
    kind: { type: 'string', enum: ['asphalt', 'concrete', 'paving', 'curb', 'grass', 'soil', 'gravel', 'hedge', 'foliage', 'bark', 'facade', 'glass', 'metal', 'paint', 'water'] },
    color: { ...color, description: 'Average color of this material as it looks in this light.' },
    sample_box: orNull({ ...nbox, description: 'A clean patch of this material in the photo (no markings, shadows, vehicles or people, at least about 40 pixels wide), or null if not visible.' }),
  },
};
const SURFACE = {
  type: 'object', additionalProperties: false, required: ['id', 'kind', 'material', 'polygon', 'top_m'],
  properties: {
    id: idStr,
    kind: { type: 'string', enum: ['road', 'lane', 'sidewalk', 'median', 'island', 'grass', 'verge', 'parking', 'plaza', 'driveway'] },
    material: { type: 'string', description: 'Material id.' },
    polygon: pts('Outline on the ground, 3 to 40 points in order, not self-crossing.'),
    top_m: { type: 'number', description: 'Height of this surface above the road: 0 for the road, about 0.15 for a curbed sidewalk or median.' },
  },
};
const MARKING = {
  type: 'object', additionalProperties: false, required: ['id', 'kind', 'color', 'color2', 'points', 'width_m', 'dash_m', 'gap_m'],
  properties: {
    id: idStr,
    kind: { type: 'string', enum: ['lane_solid', 'lane_dashed', 'edge_line', 'stop_line', 'crosswalk'] },
    color, color2: { ...color, description: 'Second color for alternating crosswalk stripes; same as color otherwise.' },
    points: pts('The line. For a crosswalk: [one curb end, other curb end] of the walking line across the road.'),
    width_m: { type: 'number', description: 'Line width. For a crosswalk: how long each stripe is, measured along the traffic.' },
    dash_m: { type: 'number', description: 'Dash length for dashed lines, 0 for solid. For a crosswalk: stripe width.' },
    gap_m: { type: 'number', description: 'Gap between dashes or crosswalk stripes.' },
  },
};
const OBJECT = {
  type: 'object', additionalProperties: false,
  required: ['id', 'kind', 'at', 'path', 'height_m', 'width_m', 'depth_m', 'heading_deg', 'material', 'color', 'seen', 'sign'],
  properties: {
    id: idStr,
    kind: { type: 'string', enum: ['pole', 'lamp_post', 'sign', 'traffic_light', 'tree', 'bush', 'hedge', 'fence', 'wall', 'barrier', 'bollard', 'building', 'shelter', 'gantry'] },
    at: orNull({ ...pt, description: 'Ground position for single things.' }),
    path: orNull(pts('For hedges, fences, walls, barriers and gantries: the line they follow. For buildings: the footprint.')),
    height_m: num, width_m: { type: 'number', description: 'Width (crown diameter for trees and bushes, thickness for hedges and walls, plate width for signs).' },
    depth_m: num,
    heading_deg: { type: 'number', description: '0 = its front faces the camera, 90 = its front points to the image right.' },
    material: orNull({ type: 'string', description: 'Material id.' }),
    color, seen: { type: 'boolean', description: 'Whether the photo shows it.' },
    sign: orNull({
      type: 'object', additionalProperties: false, required: ['shape', 'face_color', 'symbol'],
      properties: {
        shape: { type: 'string', enum: ['square', 'rectangle', 'circle', 'triangle', 'diamond', 'octagon'] },
        face_color: color,
        symbol: { type: 'string', description: 'What it shows, e.g. pedestrian_crossing, speed_limit_40, no_entry.' },
      },
    }),
  },
};
const OVERLAY = {
  type: 'object', additionalProperties: false, required: ['kind', 'box'],
  properties: { kind: { type: 'string', enum: ['inset', 'box', 'text', 'logo', 'border'] }, box: nbox },
};
const VEHICLE = SCHEMA.properties.vehicles.items;
const PLAN_VEHICLE = {
  ...VEHICLE,
  required: [...VEHICLE.required, 'at'],
  properties: { ...VEHICLE.properties, at: { ...pt, description: 'Point on the ground under the centre of the vehicle.' } },
};
const PLAN_PROPS = {
  caption: SCHEMA.properties.caption, scene_type: SCHEMA.properties.scene_type, camera: SCHEMA.properties.camera,
  ground_polygon: SCHEMA.properties.ground_polygon, subjects: SCHEMA.properties.subjects,
  vehicles: { type: 'array', items: PLAN_VEHICLE },
  sky: SCHEMA.properties.sky, ground_color: SCHEMA.properties.ground_color,
  overlays: { type: 'array', items: OVERLAY, description: 'Anything drawn on top of the image: picture-in-picture insets, detection boxes, text, logos, borders.' },
  materials: { type: 'array', items: MATERIAL }, surfaces: { type: 'array', items: SURFACE },
  markings: { type: 'array', items: MARKING }, objects: { type: 'array', items: OBJECT },
  extent_m: { type: 'number', description: 'Radius around the camera the plan covers, normally 60.' },
  notes: { type: 'string', description: 'One short plain sentence for the viewer about the place.' },
};
const PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: Object.keys(PLAN_PROPS), properties: PLAN_PROPS };
const PATCH_PROPS = {
  notes: { type: 'string', description: 'One short plain sentence for the viewer about what you changed.' },
  done: { type: 'boolean', description: 'true when nearby visible things line up within about half a metre and nothing important is missing.' },
  camera: SCHEMA.properties.camera,
  materials: { type: 'array', items: MATERIAL }, surfaces: { type: 'array', items: SURFACE },
  markings: { type: 'array', items: MARKING }, objects: { type: 'array', items: OBJECT },
  vehicles: { type: 'array', items: PLAN_VEHICLE },
  remove: { type: 'array', items: { type: 'string' }, description: 'Ids to delete.' },
};
const PATCH_SCHEMA = { type: 'object', additionalProperties: false, required: Object.keys(PATCH_PROPS), properties: PATCH_PROPS };

const PLAN_SYSTEM = `You rebuild the place in a single photo as a 3D plan, so a web app can turn it into a small world people walk around in. The photo is usually a traffic or CCTV camera frame.

Coordinates
- Ground positions are [right_m, fwd_m] in metres. The origin is the point on the ground straight below the camera lens. fwd_m points the way the camera looks (flattened onto the ground), right_m to its right. Negative fwd_m is behind the camera.
- Heights are metres above the road surface. Angles are degrees. Headings: 0 = the object's front faces the camera, 90 = its front points to the image's right, 180 = it faces away.
- Image positions are normalized: x 0 to 1 left to right, y 0 to 1 top to bottom.

What to describe
- camera: the lens height above the road, how far it looks down (pitch, positive = down) and its horizontal field of view.
- surfaces: every ground area as a polygon (road, lanes paved differently, sidewalks, medians, islands, grass verges...). top_m is the height above the road: 0 for the road, about 0.15 for a curbed sidewalk or median.
- markings: painted lines and crossings. For a crosswalk, points = [one curb end, other curb end] of the walking line across the road; width_m = stripe length measured along the traffic; dash_m = stripe width; gap_m = space between stripes; color and color2 for alternating stripe colors (the same color twice if they don't alternate).
- objects: poles, signs, lamps, traffic lights, trees, bushes, hedges, fences, walls, barriers, bollards, buildings, shelters. Use at for single things and path for long ones (hedges, fences, walls, building footprints). seen says whether the photo shows it.
- materials: one per look (asphalt, grass, hedge...). sample_box is a clean patch of it in the photo, or null. Surfaces and objects refer to materials by id.
- vehicles: one per detected vehicle you keep, as described in the schema, plus at, the ground point under its centre.
- overlays: anything drawn on top of the image (picture-in-picture insets, detection boxes, text, logos, borders). Describe the scene underneath, not the overlays.

Beyond the frame
Cover about extent_m (normally 60) metres around the camera, including behind it. Continue what you see the way such roads are normally built: the road and its markings carry on, sidewalks and verges continue, vegetation continues. Keep unseen parts simple and plausible. Never add large overhead structures (bridges, gantries, roofs) you cannot see.

Accuracy
Visible things matter most: line their edges up with the photo. Use real sizes: lanes about 3.5 m, curbs 0.15 m, crosswalk stripes 0.4 to 0.6 m wide, sign plates 0.6 to 0.9 m, cars about 4.3 m long.
Use short stable ids (s1, m1, o1, mat-asphalt) and keep them when you revise. Vehicles keep the numeric id they were given.
At most 30 surfaces, 40 markings and 120 objects.`;

function planPrompt(W, H, subjects) {
  const list = subjects.length
    ? subjects.map((s) => `id ${s.id}: ${String(s.label).slice(0, 20)}, box x0=${(+s.box[0]).toFixed(3)} y0=${(+s.box[1]).toFixed(3)} x1=${(+s.box[2]).toFixed(3)} y1=${(+s.box[3]).toFixed(3)}`).join('\n')
    : 'none';
  return `The image above is the photo, ${W}x${H} pixels.
Detected subjects:
${list}
Describe the whole place as a plan.`;
}

function refinePrompt(round, planJson) {
  return `Round ${round}. The first image is the photo. The next four are renders of the 3D world built from the current plan:
Image 2: the world from the photo's camera, with a 1 m ground grid (brighter every 5 m) and element ids (vehicles show as v<id>).
Image 3: the same view with the photo blended on top at 50%. Doubled edges mean something is misplaced.
Image 4: top-down map. Forward is up, the camera is the white triangle at the centre, grid lines every 5 m.
Image 5: looking back toward the camera from 15 m in front of it.
Current plan:
${planJson}
Return only what should change: corrected or new elements (complete, with their ids) in materials, surfaces, markings, objects and vehicles, ids to delete in remove, and the full camera even if unchanged. Fix the biggest problems first: a wrong camera height, tilt or field of view shifts everything, so correct the camera before moving many elements. Set done to true when nearby visible things line up within about half a metre and nothing important is missing.`;
}
```

- [ ] **Step 4: Add `callClaude` and `planAction` after `send()` in `api/scene.js`, and make `rateLimited` take a kind and a limit**

Replace the existing `rateLimited` function with:

```js
function rateLimited(ip, kind = 'scene', limit = RATE_LIMIT) {
  const now = Date.now();
  const key = `${kind}:${ip}`;
  const list = (hits.get(key) || []).filter((t) => now - t < 3600e3);
  list.push(now);
  hits.set(key, list);
  return list.length > limit;
}
```

Then add after `send()`:

```js
const cleanB64 = (v) => (typeof v === 'string' ? v.replace(/^data:image\/\w+;base64,/, '') : '');
const fail = (status, message) => Object.assign(new Error(message), { status });

// One structured-output call to the plan model. The whole answer has to arrive
// inside one function run, so it is cut off a little before Vercel's limit.
async function callClaude(key, { content, schema, maxTokens }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.PLAN_TIMEOUT_MS) || 280000);
  let data;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify({
        model: PLAN_MODEL(),
        max_tokens: maxTokens,
        system: PLAN_SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: PLAN_EFFORT(), format: { type: 'json_schema', schema } },
        fallbacks: 'default',
        messages: [{ role: 'user', content }],
      }),
    });
    data = await r.json().catch(() => null);
    if (!r.ok || !data) throw fail(502, data?.error?.message || `Claude API error ${r.status}`);
  } catch (e) {
    if (e.status) throw e;
    throw e.name === 'AbortError' ? fail(504, 'Claude took too long.') : fail(502, 'Could not reach the Claude API.');
  } finally {
    clearTimeout(timer);
  }
  if (data.stop_reason === 'refusal') throw fail(502, 'Claude declined to describe this frame.');
  if (data.stop_reason === 'max_tokens') throw fail(502, 'Claude\'s answer was cut off.');
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  try { return { json: JSON.parse(text), usage: data.usage, model: data.model, ms: Date.now() - t0 }; }
  catch { throw fail(502, 'Claude returned an unreadable answer.'); }
}

async function planAction(res, key, ip, body) {
  const isPlan = body.action === 'plan';
  if (rateLimited(ip, body.action, isPlan ? PLAN_LIMIT : REFINE_LIMIT)) {
    return send(res, 429, { error: isPlan ? 'Too many photos in the last hour. Try again later.' : 'Too many corrections in the last hour. Try again later.' });
  }
  const image = cleanB64(body.image);
  if (!image || image.length > MAX_FRAME_B64) return send(res, 400, { error: 'Send the frame as a base64 JPEG under about 1.9 MB in "image".' });
  const frame = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image }, cache_control: { type: 'ephemeral' } };
  let content, schema, maxTokens;
  if (isPlan) {
    const subjects = Array.isArray(body.subjects) ? body.subjects.slice(0, 12) : [];
    content = [frame, { type: 'text', text: planPrompt(Number(body.width) || 0, Number(body.height) || 0, subjects) }];
    schema = PLAN_SCHEMA; maxTokens = 32000;
  } else {
    const renders = Array.isArray(body.renders) ? body.renders.map(cleanB64) : [];
    if (renders.length !== 4 || renders.some((r) => !r || r.length > MAX_RENDER_B64)) return send(res, 400, { error: 'Send exactly 4 renders as base64 JPEGs in "renders".' });
    const planJson = body.plan && typeof body.plan === 'object' && !Array.isArray(body.plan) ? JSON.stringify(body.plan) : '';
    if (!planJson || planJson.length > MAX_PLAN_CHARS) return send(res, 400, { error: 'Send the current plan as an object in "plan".' });
    const round = Math.max(1, Math.min(10, Math.round(Number(body.round) || 1)));
    content = [
      frame,
      ...renders.flatMap((data, i) => [{ type: 'text', text: `Image ${i + 2}:` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }]),
      { type: 'text', text: refinePrompt(round, planJson) },
    ];
    schema = PATCH_SCHEMA; maxTokens = 16000;
  }
  let out;
  try { out = await callClaude(key, { content, schema, maxTokens }); }
  catch (e) { return send(res, e.status || 502, { error: e.message }); }
  return send(res, 200, { [isPlan ? 'plan' : 'patch']: out.json, usage: out.usage, model: out.model, ms: out.ms });
}
```

- [ ] **Step 5: Route in `handler`**

In `handler`, change the GET line and move body parsing ahead of the old rate limit. The top of `handler` becomes:

```js
async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return send(res, 200, { enabled: Boolean(key), model: MODEL, plan: Boolean(key), planModel: PLAN_MODEL() });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' });
  if (!key) return send(res, 503, { error: 'Smart scene is not set up on this site.' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (body && (body.action === 'plan' || body.action === 'refine')) return planAction(res, key, ip, body);
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many photos in the last hour. Try again later.' });

  const image = body && typeof body.image === 'string' ? body.image.replace(/^data:image\/\w+;base64,/, '') : '';
```

Keep everything after that line exactly as it is today. At the bottom, export the new schemas:

```js
module.exports = handler;
module.exports.SCHEMA = SCHEMA;
module.exports.PLAN_SCHEMA = PLAN_SCHEMA;
module.exports.PATCH_SCHEMA = PATCH_SCHEMA;
```

Also update the comment block at the top of `api/scene.js` to list the two new actions:

```js
// POST /api/scene  { action: 'plan', image, width, height, subjects }
//                  -> { plan, usage, model, ms }     Claude World: the whole place in metres (Opus)
// POST /api/scene  { action: 'refine', image, renders: [4 JPEGs], plan, round }
//                  -> { patch, usage, model, ms }    corrections after looking at renders of the world
```

- [ ] **Step 6: Raise the duration in `vercel.json`**

Change `"api/scene.js": { "maxDuration": 30 }` to `"api/scene.js": { "maxDuration": 300 }`.

- [ ] **Step 7: Run the tests to see them pass**

Run: `node --test tests/scene-api.test.mjs`
Expected: PASS, 10 tests.
Run: `node --test tests/*.test.mjs`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add api/scene.js vercel.json tests/scene-api.test.mjs
git commit -m "Claude World: plan and refine actions on the scene endpoint"
```

---

### Task 5: Material tiles from the photo (`js/tiles.js`)

**Files:**
- Create: `js/tiles.js`, `tests/tiles.test.mjs`

**Interfaces:**
- Consumes: `photoCamera`, `project`, `pixelToGround`, `groundPoint` from Task 2.
- Produces:
  - `groundTile(img, cam, box, {size = 256, top = 0}) -> {data, width, height, metres} | null`: a square of real ground around the box centre seen from straight above; `metres` = its side; row 0 = nearest edge (smallest fwd_m), column 0 = leftmost (smallest right_m); null when the square leaves the photo or crosses the horizon.
  - `patchTile(img, box, size = 256) -> {data, width, height}`: the box as it appears, resampled.
  - `img` is `{data: Uint8ClampedArray RGBA, width, height}` (an `ImageData`), `cam` is `photoCamera` for that image size.

- [ ] **Step 1: Write the failing test** `tests/tiles.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoCamera, pixelToGround } from '../js/camera.js';
import { groundTile, patchTile } from '../js/tiles.js';

// A synthetic photo where each ground pixel's red = 128 + 10 * right_m and
// green = 4 * fwd_m, so tiles can be checked against real ground positions.
function groundPhoto(cam) {
  const { W, H } = cam;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const g = pixelToGround(cam, u + 0.5, v + 0.5);
    const k = (v * W + u) * 4;
    if (g) { data[k] = 128 + 10 * g[0]; data[k + 1] = 4 * g[1]; }
    data[k + 3] = 255;
  }
  return { data, width: W, height: H };
}

test('ground tile samples real ground positions', () => {
  const cam = photoCamera({ W: 400, H: 300, hfovDeg: 50, pitchDeg: 25, heightM: 5 });
  const img = groundPhoto(cam);
  const t = groundTile(img, cam, [0.4, 0.6, 0.6, 0.75], { size: 32 });
  assert.ok(t, 'tile should exist');
  assert.equal(t.width, 32);
  const c = pixelToGround(cam, 0.5 * 400, 0.675 * 300);
  const at = (i, j) => [t.data[(j * 32 + i) * 4], t.data[(j * 32 + i) * 4 + 1]];
  // Column 0 is metres/2 to the left of the centre; row 0 is metres/2 nearer.
  const left = c[0] - t.metres / 2 + (0.5 / 32) * t.metres;
  const nearF = c[1] - t.metres / 2 + (0.5 / 32) * t.metres;
  assert.ok(Math.abs(at(0, 16)[0] - (128 + 10 * left)) <= 3, `red ${at(0, 16)[0]} vs ${128 + 10 * left}`);
  assert.ok(Math.abs(at(16, 0)[1] - 4 * nearF) <= 3, `green ${at(16, 0)[1]} vs ${4 * nearF}`);
  assert.ok(at(31, 16)[0] > at(0, 16)[0], 'red grows to the right');
  assert.ok(at(16, 31)[1] > at(16, 0)[1], 'green grows forward');
});

test('ground tile is null above the horizon', () => {
  const cam = photoCamera({ W: 400, H: 300, hfovDeg: 50, pitchDeg: 5, heightM: 5 });
  assert.equal(groundTile(groundPhoto(cam), cam, [0.4, 0.0, 0.6, 0.1]), null);
});

test('patch tile resamples the box', () => {
  const data = new Uint8ClampedArray(10 * 10 * 4);
  for (let i = 0; i < 100; i++) { data[i * 4] = i % 10 < 5 ? 0 : 200; data[i * 4 + 3] = 255; }
  const t = patchTile({ data, width: 10, height: 10 }, [0.6, 0, 1, 1], 8);   // stays clear of the 0/200 boundary
  assert.equal(t.width, 8);
  for (let i = 0; i < 64; i++) assert.equal(t.data[i * 4], 200);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/tiles.test.mjs`
Expected: FAIL with `Cannot find module` for `js/tiles.js`.

- [ ] **Step 3: Write `js/tiles.js`**

```js
// Material tiles cut from the photo, for the parts of the world the photo
// never saw. A ground material (asphalt, grass...) is rectified: we sample a
// square of real ground around the material's sample patch as if seen from
// straight above, so it repeats at its true size. Other materials (hedge
// sides, facades) use the patch as it appears.
//
// Plain JS with no three.js, so it runs in tests too.

import { project, pixelToGround, groundPoint } from './camera.js';

// Bilinear sample of an RGBA image at pixel (x, y); null outside it.
function sample(img, x, y) {
  const { data, width: W, height: H } = img;
  if (!(x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1)) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * W + x0) * 4 + c], b = data[(y0 * W + x1) * 4 + c];
    const d = data[(y1 * W + x0) * 4 + c], e = data[(y1 * W + x1) * 4 + c];
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
  return out;
}

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img  the photo (RGBA)
 * @param {object} cam  photoCamera() for this image size
 * @param {number[]} box  [x0, y0, x1, y1] normalized
 * @returns {{data: Uint8ClampedArray, width: number, height: number, metres: number} | null}
 */
export function groundTile(img, cam, box, { size = 256, top = 0 } = {}) {
  const [x0, y0, x1, y1] = box;
  const W = img.width, H = img.height;
  const bl = pixelToGround(cam, x0 * W, y1 * H, top), br = pixelToGround(cam, x1 * W, y1 * H, top);
  const c = pixelToGround(cam, ((x0 + x1) / 2) * W, ((y0 + y1) / 2) * H, top);
  if (!bl || !br || !c) return null;
  const metres = Math.min(6, Math.max(0.5, Math.hypot(br[0] - bl[0], br[1] - bl[1])));
  const out = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const r = c[0] + ((i + 0.5) / size - 0.5) * metres;
      const f = c[1] + ((j + 0.5) / size - 0.5) * metres;   // row 0 = nearest edge
      const p = project(cam, groundPoint(cam, r, f, top));
      const px = p && sample(img, p.u - 0.5, p.v - 0.5);
      if (!px) return null;   // the square leaves the photo
      const k = (j * size + i) * 4;
      out[k] = px[0]; out[k + 1] = px[1]; out[k + 2] = px[2]; out[k + 3] = 255;
    }
  }
  return { data: out, width: size, height: size, metres };
}

/** The box as it appears in the photo, resampled to size x size. */
export function patchTile(img, box, size = 256) {
  const [x0, y0, x1, y1] = box;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (x0 + ((i + 0.5) / size) * (x1 - x0)) * img.width - 0.5;
      const y = (y0 + ((j + 0.5) / size) * (y1 - y0)) * img.height - 0.5;
      const px = sample(img, Math.min(img.width - 1, Math.max(0, x)), Math.min(img.height - 1, Math.max(0, y)));
      const k = (j * size + i) * 4;
      out[k] = px[0]; out[k + 1] = px[1]; out[k + 2] = px[2]; out[k + 3] = 255;
    }
  }
  return { data: out, width: size, height: size };
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --test tests/tiles.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add js/tiles.js tests/tiles.test.mjs
git commit -m "Claude World: material tiles cut from the photo"
```

---

### Task 6: Build the plan in 3D and show it in the app

**Files:**
- Create: `js/scenebuild.js`, `tools/fixtures/crossing-plan-handmade.json`
- Modify: `js/world.js`, `js/main.js`

**Interfaces:**
- Consumes: `photoCamera` (Task 2), `validatePlan` (Task 3), `groundTile`, `patchTile` (Task 5).
- Produces:
  - `buildPlanScene(plan, {photo, noData}) -> {group, meshes, photoCam, prepare(renderer), setFog(on), fog, dispose()}` in `js/scenebuild.js`
  - `buildWorld(scan, photo, {strength, scene, photoHi})`: when `scene.surfaces` is non-empty, the returned world has `planScene`, `prepare(renderer)`, `info.plan === true`
  - In `js/main.js`: `setWorld({scan, photo, photoHi, name, sceneInfo}, opts)` calls `world.prepare(renderer)`; `window.__pw.setPlan(rawPlan) -> plan | null`, `window.__pw.plan` (current plan), `window.__pw.lastScan`

- [ ] **Step 1: Write the handmade fixture** `tools/fixtures/crossing-plan-handmade.json`

A rough plan for `crossing-clean.jpg`. It doesn't need to be accurate, only to exercise every builder.

```json
{
  "caption": "Two-lane road with a crosswalk",
  "scene_type": "road",
  "camera": { "height_m": 4.4, "pitch_deg": 13, "hfov_deg": 43 },
  "ground_polygon": [{ "x": 0.05, "y": 0.35 }, { "x": 0.95, "y": 0.35 }, { "x": 0.95, "y": 1 }, { "x": 0.05, "y": 1 }],
  "subjects": [],
  "vehicles": [],
  "sky": { "top": "#9fc0e8", "horizon": "#d3dee8" },
  "ground_color": "#6f7a5a",
  "overlays": [],
  "materials": [
    { "id": "mat-asphalt", "kind": "asphalt", "color": "#6b6d70", "sample_box": [0.36, 0.2, 0.46, 0.3] },
    { "id": "mat-grass", "kind": "grass", "color": "#5f8a3e", "sample_box": [0.02, 0.5, 0.1, 0.6] },
    { "id": "mat-hedge", "kind": "hedge", "color": "#4d6b34", "sample_box": [0.75, 0.25, 0.85, 0.35] }
  ],
  "surfaces": [
    { "id": "s-road", "kind": "road", "material": "mat-asphalt", "polygon": [[-7, -40], [8, -40], [8, 120], [-7, 120]], "top_m": 0 },
    { "id": "s-median", "kind": "median", "material": "mat-grass", "polygon": [[-12, 12], [-8, 12], [-8, 120], [-12, 120]], "top_m": 0.15 },
    { "id": "s-verge", "kind": "verge", "material": "mat-grass", "polygon": [[8, -40], [14, -40], [14, 120], [8, 120]], "top_m": 0.15 }
  ],
  "markings": [
    { "id": "m-cross", "kind": "crosswalk", "color": "#f0f0f0", "color2": "#e8c84a", "points": [[-6.5, 20], [7.5, 20]], "width_m": 3.5, "dash_m": 0.5, "gap_m": 0.5 },
    { "id": "m-centre", "kind": "lane_dashed", "color": "#f2f2f2", "color2": "#f2f2f2", "points": [[0.5, 24], [0.5, 110]], "width_m": 0.15, "dash_m": 3, "gap_m": 6 }
  ],
  "objects": [
    { "id": "o-sign", "kind": "sign", "at": [-8.5, 19], "path": null, "height_m": 3, "width_m": 0.7, "depth_m": 0.05, "heading_deg": 0, "material": null, "color": "#8a8f96", "seen": true, "sign": { "shape": "square", "face_color": "#2a6bd6", "symbol": "pedestrian_crossing" } },
    { "id": "o-hedge", "kind": "hedge", "at": null, "path": [[10, 8], [10.5, 60]], "height_m": 1.1, "width_m": 1.5, "depth_m": 1.5, "heading_deg": 0, "material": "mat-hedge", "color": "#4d6b34", "seen": true, "sign": null },
    { "id": "o-tree", "kind": "tree", "at": [12, 45], "path": null, "height_m": 7, "width_m": 4, "depth_m": 4, "heading_deg": 0, "material": "mat-hedge", "color": "#4d6b34", "seen": false, "sign": null },
    { "id": "o-lamp", "kind": "lamp_post", "at": [-9, 35], "path": null, "height_m": 8, "width_m": 0.2, "depth_m": 0.2, "heading_deg": 90, "material": null, "color": "#8a8f96", "seen": false, "sign": null }
  ],
  "extent_m": 60,
  "notes": "Handmade test plan"
}
```

- [ ] **Step 2: Write `js/scenebuild.js`**

```js
// Builds Claude's plan of a place (js/plan.js) as 3D meshes in the levelled
// world world.js uses: camera at the origin, ground at y = -h, metres.
// Every surface shows the photo where the photo saw it (projected from the
// photo's camera, with a depth pass so pixels never land on something that
// was hidden), and a tile of its material everywhere else.

import * as THREE from 'three';
import { photoCamera } from './camera.js';
import { groundTile, patchTile } from './tiles.js';

const GROUND_MATERIALS = new Set(['asphalt', 'concrete', 'paving', 'curb', 'grass', 'soil', 'gravel', 'paint', 'water']);
const SURFACE_COLORS = { road: '#5f6266', lane: '#5f6266', sidewalk: '#a8a39a', median: '#8f8a80', island: '#8f8a80', grass: '#5f8a3e', verge: '#5f8a3e', parking: '#66686b', plaza: '#a8a39a', driveway: '#77787a' };
const GREY = '#8a8f96';

const vert = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

// Photo where the photo saw this point (inside the frame, not hidden behind
// something nearer, not at a grazing angle, not a person or vehicle), the
// material tile elsewhere. Colors stay sRGB end to end, like world.js.
const frag = /* glsl */`
  #include <packing>
  uniform sampler2D photo; uniform sampler2D noData; uniform sampler2D photoDepth;
  uniform mat4 photoViewProj; uniform float photoNear; uniform float photoFar;
  uniform sampler2D tile; uniform float tileSize; uniform float hasTile; uniform vec3 baseColor;
  uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    vec2 tuv = abs(n.y) > 0.6 ? vec2(vWorld.x, -vWorld.z) : vec2(vWorld.x - vWorld.z, vWorld.y);
    vec3 base = hasTile > 0.5 ? texture2D(tile, tuv / tileSize).rgb
                              : baseColor * (0.94 + 0.12 * hash(floor(vWorld.xz * 3.0)));
    vec3 col = base;
    vec4 clip = photoViewProj * vec4(vWorld, 1.0);
    if (clip.w > 0.0) {
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        float d = clip.w;   // distance along the photo camera's axis
        float stored = -perspectiveDepthToViewZ(texture2D(photoDepth, uv).x, photoNear, photoFar);
        float vis = 1.0 - smoothstep(0.01 * d + 0.03, 0.03 * d + 0.12, d - stored);
        float edge = smoothstep(0.0, 0.015, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        float graze = smoothstep(0.04, 0.2, abs(dot(n, normalize(vWorld))));
        float w = vis * edge * graze * (1.0 - texture2D(noData, uv).r);
        col = mix(base, texture2D(photo, uv).rgb, w);
      }
    }
    float dist = length(vWorld - cameraPosition);
    col = mix(col, fogColor, smoothstep(fogNear, fogFar, dist));
    gl_FragColor = vec4(col, 1.0);
  }`;

const rgb = (h) => {
  const n = parseInt(String(h).replace('#', ''), 16) || 0x808080;
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;   // shaders pass sRGB straight through
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  return t;
}

function dataTexture({ data, width, height }) {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function inside(poly, r, f) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > f) !== (yj > f) && r < ((xj - xi) * (f - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function surfaceGeometry(s, h, layer) {
  const shape = new THREE.Shape(s.polygon.map(([r, f]) => new THREE.Vector2(r, f)));
  let g;
  if (s.top_m >= 0.03) g = new THREE.ExtrudeGeometry(shape, { depth: s.top_m, bevelEnabled: false });
  else { g = new THREE.ShapeGeometry(shape); g.translate(0, 0, 0.003 + layer * 0.001); }
  g.rotateX(-Math.PI / 2);   // shape (r, f) -> world (r, 0, -f); extrusion goes up
  g.translate(0, -h, 0);
  return g;
}

function positions(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

// A flat strip along a polyline, `width` wide at height y; dashed when dash and gap are both > 0.
function ribbonGeometry(points, width, y, dash = 0, gap = 0) {
  const pos = [];
  const quad = (a, b) => {
    const dr = b[0] - a[0], df = b[1] - a[1], len = Math.hypot(dr, df) || 1;
    const nr = (-df / len) * (width / 2), nf = (dr / len) * (width / 2);
    const P = (r, f) => [r, y, -f];
    const p0 = P(a[0] + nr, a[1] + nf), p1 = P(a[0] - nr, a[1] - nf), p2 = P(b[0] + nr, b[1] + nf), p3 = P(b[0] - nr, b[1] - nf);
    pos.push(...p0, ...p1, ...p2, ...p2, ...p1, ...p3);
  };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(dash > 0 && gap > 0)) { quad(a, b); continue; }
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let s = 0; s < len; s += dash + gap) quad(at(s / len), at(Math.min(len, s + dash) / len));
  }
  return positions(pos);
}

// Crosswalk stripes along the walking line, alternating color and color2.
function crosswalkGeometries(m, y) {
  const a = m.points[0], b = m.points[m.points.length - 1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 0.5) return [null, null];
  const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], perp = [-dir[1], dir[0]];
  const stripe = m.dash_m, gap = m.gap_m, half = m.width_m / 2;
  const lists = [[], []];
  let k = 0;
  for (let s = 0; s + stripe <= len + 1e-6; s += stripe + gap, k++) {
    const c0 = [a[0] + dir[0] * s, a[1] + dir[1] * s], c1 = [a[0] + dir[0] * (s + stripe), a[1] + dir[1] * (s + stripe)];
    const q = (p, sgn) => [p[0] + perp[0] * half * sgn, y, -(p[1] + perp[1] * half * sgn)];
    const p0 = q(c0, 1), p1 = q(c0, -1), p2 = q(c1, 1), p3 = q(c1, -1);
    lists[k % 2].push(...p0, ...p1, ...p2, ...p2, ...p1, ...p3);
  }
  return lists.map((pos) => (pos.length ? positions(pos) : null));
}

// Meshes for one object: a list of [geometry, material id or null, color].
function objectParts(o, h, topAt) {
  const parts = [];
  const at = o.at || (o.path ? o.path[Math.floor(o.path.length / 2)] : null);
  const H = o.height_m;
  const yAt = (p) => -h + topAt(p[0], p[1]);
  const put = (geo, p, heading = o.heading_deg) => geo.applyMatrix4(new THREE.Matrix4().makeRotationY((heading * Math.PI) / 180).setPosition(p[0], yAt(p), -p[1]));
  const cyl = (rad, len) => new THREE.CylinderGeometry(rad, rad, len, 8).translate(0, len / 2, 0);
  const along = (a, b, geo) => {
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return geo.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(b[1] - a[1], b[0] - a[0])).setPosition(mid[0], yAt(mid), -mid[1]));
  };
  switch (o.kind) {
    case 'pole': case 'bollard':
      if (at) parts.push([put(cyl(Math.max(o.kind === 'pole' ? 0.04 : 0.08, o.width_m / 2), H), at), o.material, o.color]);
      break;
    case 'lamp_post':
      if (!at) break;
      parts.push([put(cyl(0.08, H), at), o.material, o.color]);
      parts.push([put(new THREE.BoxGeometry(1.6, 0.08, 0.08).translate(0.8, H, 0), at), o.material, o.color]);
      parts.push([put(new THREE.BoxGeometry(0.5, 0.12, 0.25).translate(1.5, H - 0.08, 0), at), null, '#d8d8d0']);
      break;
    case 'sign': {
      if (!at) break;
      const w = Math.max(0.3, o.width_m), ph = o.sign && o.sign.shape === 'rectangle' ? w * 0.6 : w;
      const post = Math.max(0.5, H - ph);
      parts.push([put(cyl(0.04, post), at), null, GREY]);
      parts.push([put(new THREE.BoxGeometry(w, ph, 0.04).translate(0, post + ph / 2, 0), at), null, o.sign ? o.sign.face_color : o.color]);
      break;
    }
    case 'traffic_light':
      if (!at) break;
      parts.push([put(cyl(0.08, H), at), null, GREY]);
      parts.push([put(new THREE.BoxGeometry(0.35, 0.95, 0.3).translate(0, H - 0.5, 0.2), at), null, '#2b2d30']);
      break;
    case 'tree': {
      if (!at) break;
      const rad = Math.min(8, Math.max(0.8, o.width_m / 2));
      parts.push([put(cyl(0.15, H * 0.5), at), null, '#5b4636']);
      const crown = new THREE.IcosahedronGeometry(rad, 1);
      crown.scale(1, 1.15, 1);
      crown.translate(0, Math.max(rad, H - rad * 1.1), 0);
      parts.push([put(crown, at), o.material, o.color]);
      break;
    }
    case 'bush': {
      if (!at) break;
      const rad = Math.max(0.2, o.width_m / 2);
      const g = new THREE.IcosahedronGeometry(rad, 1);
      g.scale(1, Math.max(0.3, H / (2 * rad)), 1);
      g.translate(0, H / 2, 0);
      parts.push([put(g, at), o.material, o.color]);
      break;
    }
    case 'shelter':
      if (at) parts.push([put(new THREE.BoxGeometry(o.width_m, H, o.depth_m).translate(0, H / 2, 0), at), o.material, o.color]);
      break;
    case 'hedge': case 'fence': case 'wall': case 'barrier': {
      if (!o.path) break;
      const thick = o.kind === 'fence' ? 0.06 : Math.max(0.1, o.width_m);
      for (let i = 0; i < o.path.length - 1; i++) {
        const a = o.path[i], b = o.path[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len >= 0.05) parts.push([along(a, b, new THREE.BoxGeometry(len, H, thick).translate(0, H / 2, 0)), o.material, o.color]);
      }
      break;
    }
    case 'building': {
      if (!o.path || o.path.length < 3) break;
      const g = new THREE.ExtrudeGeometry(new THREE.Shape(o.path.map(([r, f]) => new THREE.Vector2(r, f))), { depth: H, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.translate(0, -h, 0);
      parts.push([g, o.material, o.color]);
      break;
    }
    case 'gantry': {
      if (!o.path) break;
      const a = o.path[0], b = o.path[o.path.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1) break;
      const beam = Math.max(0.4, o.depth_m);
      parts.push([along(a, b, new THREE.BoxGeometry(len, beam, 0.6).translate(0, H + beam / 2, 0)), o.material, o.color]);
      for (const p of [a, b]) parts.push([put(cyl(0.25, H + beam), p, 0), null, GREY]);
      break;
    }
    default:
      break;
  }
  return parts;
}

/**
 * @param {object} plan  a plan from validatePlan() with at least one surface
 * @param {{photo: HTMLCanvasElement, noData?: HTMLCanvasElement|null}} opts
 *   photo   the frame at full resolution, projected onto the world
 *   noData  same aspect; white where the photo must not be used (people, vehicles)
 */
export function buildPlanScene(plan, { photo, noData = null }) {
  const W = photo.width, H = photo.height, h = plan.camera.height_m, E = plan.extent_m;
  const cam = photoCamera({ W, H, hfovDeg: plan.camera.hfov_deg, pitchDeg: plan.camera.pitch_deg, heightM: h });
  const group = new THREE.Group();
  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };

  // The photo's own camera: projection and the depth pass both use it.
  const photoCam = new THREE.PerspectiveCamera((2 * Math.atan(H / 2 / cam.f) * 180) / Math.PI, W / H, 0.3, 3000);
  photoCam.rotation.x = -cam.pitch;
  photoCam.updateProjectionMatrix();
  photoCam.updateMatrixWorld(true);
  const viewProj = new THREE.Matrix4().multiplyMatrices(photoCam.projectionMatrix, photoCam.matrixWorldInverse);
  const dw = 1024, dh = Math.max(2, Math.round((1024 * H) / W));
  const depthTex = keep(new THREE.DepthTexture(dw, dh, THREE.FloatType));
  const rt = keep(new THREE.WebGLRenderTarget(dw, dh, { depthTexture: depthTex, depthBuffer: true }));

  let noDataTex;
  if (noData) noDataTex = keep(canvasTexture(noData));
  else { noDataTex = keep(new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat)); noDataTex.needsUpdate = true; }
  const shared = {
    photo: { value: keep(canvasTexture(photo)) }, noData: { value: noDataTex }, photoDepth: { value: depthTex },
    photoViewProj: { value: viewProj }, photoNear: { value: photoCam.near }, photoFar: { value: photoCam.far },
    fogColor: { value: rgb(plan.sky.horizon) }, fogNear: { value: E * 1.2 }, fogFar: { value: E * 6 },
  };
  const makeMaterial = ({ tile = null, tileSize = 1, color = '#808080' }) => keep(new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide,
    uniforms: { ...shared, tile: { value: tile }, tileSize: { value: tileSize }, hasTile: { value: tile ? 1 : 0 }, baseColor: { value: rgb(color) } },
  }));

  // Materials: a tile cut from the photo when Claude pointed at a clean patch.
  const img = photo.getContext('2d').getImageData(0, 0, W, H);
  const byId = new Map();
  for (const m of plan.materials) {
    let tile = null, size = 1;
    if (m.sample_box) {
      const g = GROUND_MATERIALS.has(m.kind) ? groundTile(img, cam, m.sample_box) : null;
      const p = g || patchTile(img, m.sample_box);
      tile = keep(dataTexture(p));
      size = g ? g.metres : 1.5;
    }
    byId.set(m.id, makeMaterial({ tile, tileSize: size, color: m.color }));
  }
  const flat = new Map();
  const flatMat = (hex) => { if (!flat.has(hex)) flat.set(hex, makeMaterial({ color: hex })); return flat.get(hex); };
  const materialFor = (id, hex) => byId.get(id) || flatMat(hex);

  const meshes = [];
  const add = (geo, mat) => { const mesh = new THREE.Mesh(keep(geo), mat); group.add(mesh); meshes.push(mesh); return mesh; };
  const topAt = (r, f) => {
    let top = 0;
    for (const s of plan.surfaces) if (s.top_m > top && inside(s.polygon, r, f)) top = s.top_m;
    return top;
  };

  plan.surfaces.forEach((s, i) => add(surfaceGeometry(s, h, i), materialFor(s.material, SURFACE_COLORS[s.kind] || '#808080')));
  for (const m of plan.markings) {
    const y = -h + topAt(m.points[0][0], m.points[0][1]) + 0.045;
    if (m.kind === 'crosswalk') {
      const [g0, g1] = crosswalkGeometries(m, y);
      if (g0) add(g0, flatMat(m.color));
      if (g1) add(g1, flatMat(m.color2));
    } else {
      const dashed = m.kind === 'lane_dashed';
      add(ribbonGeometry(m.points, m.width_m, y, dashed ? (m.dash_m || 3) : 0, dashed ? (m.gap_m || 6) : 0), flatMat(m.color));
    }
  }
  for (const o of plan.objects) for (const [geo, matId, hex] of objectParts(o, h, topAt)) add(geo, materialFor(matId, hex));
  // Ground to the horizon, so the photo's far road still has something to land on.
  const disc = new THREE.CircleGeometry(2400, 64);
  disc.rotateX(-Math.PI / 2);
  disc.translate(0, -h - 0.02, 0);
  add(disc, flatMat(plan.ground_color));

  // Depth of everything as the photo's camera sees it, so the shader knows
  // which surface each photo pixel really belongs to. Runs once per build.
  const depthOnly = keep(new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  function prepare(renderer) {
    const prev = renderer.getRenderTarget();
    const parent = group.parent;
    const tmp = new THREE.Scene();
    tmp.overrideMaterial = depthOnly;   // never sample photoDepth while writing it
    tmp.add(group);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(tmp, photoCam);
    renderer.setRenderTarget(prev);
    tmp.remove(group);
    if (parent) parent.add(group);
  }

  return {
    group, meshes, photoCam, prepare,
    fog: new THREE.Fog(plan.sky.horizon, E * 1.2, E * 6),
    setFog(on) { shared.fogNear.value = on ? E * 1.2 : 1e8; shared.fogFar.value = on ? E * 6 : 1e9; },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
```

- [ ] **Step 3: Use it in `js/world.js`**

Make these edits:

1. Add the import under the existing imports:
```js
import { buildPlanScene } from './scenebuild.js';
```
2. In the JSDoc of `buildWorld`, add a line after the `scene` line:
```js
 *   photoHi   the photo at up to 2576 px, used to paint Claude's plan of the place (optional)
```
3. Change the signature to:
```js
export function buildWorld(scan, photo, { strength = 1, scene = null, photoHi = null } = {}) {
```
4. Right after `const L = Math.max(W, H);` add:
```js
  // Claude's full plan of the place replaces the depth sheet (layers A and B).
  const planMode = Boolean(scene && Array.isArray(scene.surfaces) && scene.surfaces.length);
```
5. Change `content.add(meshB, meshA);` to:
```js
  if (!planMode) content.add(meshB, meshA);
```
6. Change `if (A.edge) {` (the torn-triangle block) to:
```js
  if (A.edge && !planMode) {
```
7. Right after `group.add(sky);` add:
```js
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
```
8. Replace the `const bounds = ...;` line with:
```js
  const bounds = planMode
    ? { minX: -0.6 * scene.extent_m, maxX: 0.6 * scene.extent_m, minZ: -0.6 * scene.extent_m, maxZ: 0.6 * scene.extent_m }
    : { minX: -0.45 * reach, maxX: 0.45 * reach, minZ: -0.9 * reach, maxZ: 0.35 * reach };
```
9. In `dispose()`, add at the end:
```js
    if (planScene) {
      planScene.dispose();
      // Built but never added to `content`, so the traverse above missed them.
      A.main.dispose(); if (A.edge) A.edge.dispose(); B.main.dispose(); matA.dispose(); meshB.material.dispose();
    }
```
10. In the returned object: add `prepare: (renderer) => { if (planScene) planScene.prepare(renderer); },` and `planScene,` next to `attachModel`; in `info` change `speed: 0.42 * room * unit,` to `speed: planMode ? 2 : 0.42 * room * unit,` and add `plan: planMode,` after `surroundings: withSurroundings,`; change the `fog:` line to:
```js
    fog: planScene ? planScene.fog : surroundings ? surroundings.fog : null,
```

- [ ] **Step 4: Keep a hi-res copy and prepare the plan scene in `js/main.js`**

1. Add the import at the top with the others:
```js
import { validatePlan } from './plan.js';
```
2. Add `let lastScan = null;` under `let current = null;`.
3. Replace the first three lines of `setWorld` with:
```js
function setWorld({ scan, photo, photoHi = null, name, sceneInfo = null }, { autoWalk = false, keepCamera = false } = {}) {
  const next = buildWorld(scan, photo, { strength, scene: sceneInfo, photoHi });
  next.prepare(renderer);   // the plan scene's depth pass, before it joins the scene
  if (world) { scene.remove(world.group); world.dispose(); }
  world = next;
  current = { scan, photo, photoHi, name, sceneInfo };
```
4. In `processFile`, right after `ctx.drawImage(bitmap, 0, 0, W, H);` and before `bitmap.close?.();`, add:
```js
    // Claude and the plan's projected texture get up to 2576 px (Opus's high-resolution limit).
    const sHi = Math.min(1, 2576 / Math.max(bitmap.width, bitmap.height));
    const photoHi = document.createElement('canvas');
    photoHi.width = Math.max(8, Math.round(bitmap.width * sHi)); photoHi.height = Math.max(8, Math.round(bitmap.height * sHi));
    photoHi.getContext('2d').drawImage(bitmap, 0, 0, photoHi.width, photoHi.height);
```
   After the scan resolves (`const scan = await new Promise(...)`), add `lastScan = scan;`. Change the existing `setWorld({ scan: keepRealSubjects(scan, sceneInfo), photo, name: ..., sceneInfo }, { autoWalk: true });` call to pass `photoHi` too:
```js
    setWorld({ scan: keepRealSubjects(scan, sceneInfo), photo, photoHi, name: file.name || 'your photo', sceneInfo }, { autoWalk: true });
```
5. In `loadSample`, after `const scan = decodeScan(buf);` add `lastScan = scan;`.
6. Extend the `window.__pw` object:
```js
window.__pw = {
  timings, get mode() { return mode; }, get world() { return world; }, setMode, processFile, camera, walk, orbit, renderer, scene,
  get plan() { return current?.sceneInfo?.surfaces ? current.sceneInfo : null; },
  get lastScan() { return lastScan; },
  // Build the current photo from a plan without calling Claude (tests and debugging).
  setPlan(raw) {
    const p = validatePlan(raw);
    if (!p || !p.surfaces.length || !current || !lastScan) return null;
    setWorld({ ...current, scan: keepRealSubjects(lastScan, p), sceneInfo: p });
    return p;
  },
};
```

- [ ] **Step 5: Run the unit tests**

Run: `node --test tests/*.test.mjs`
Expected: all PASS (nothing in Node imports the browser modules changed here).

- [ ] **Step 6: Check it in a real browser**

Start the server: `node tools/dev-server.mjs 3000` (background). With Playwright, open `http://localhost:3000/` and run in the page:

```js
async () => {
  const blob = await (await fetch('tools/fixtures/crossing-clean.jpg')).blob();
  document.querySelector('#smart').checked = false;   // no Claude for this check
  await window.__pw.processFile(new File([blob], 'crossing-clean.jpg', { type: 'image/jpeg' }));
  const plan = await (await fetch('tools/fixtures/crossing-plan-handmade.json')).json();
  const p = window.__pw.setPlan(plan);
  return { surfaces: p?.surfaces.length, plan: window.__pw.world.info.plan, meshes: window.__pw.world.planScene?.meshes.length };
}
```
Expected: `{surfaces: 3, plan: true, meshes: >= 14}` and no console errors. Then put the camera at the photo's pose (`__pw.setMode('walk')`, wait 2.5 s) and take a screenshot; then move it to street level near the crosswalk (`__pw.camera.position.set(0, -4.4 + 1.6, -12)`, look forward) and take another. Expected: the start view looks like the photo (road, crosswalk, sign, bushes in the right places); at street level the road and crosswalk are solid geometry and the parts the photo didn't see show asphalt and grass textures, not grey or holes. Save both screenshots under the scratchpad and look at them before committing. Remove the `.playwright-mcp/` folder contents afterwards (it's ignored by git).

- [ ] **Step 7: Commit**

```bash
git add js/scenebuild.js js/world.js js/main.js tools/fixtures/crossing-plan-handmade.json
git commit -m "Claude World: build the plan in 3D with the photo projected onto it"
```

---

### Task 7: The refine loop (`js/refine-loop.js`)

**Files:**
- Create: `js/refine-loop.js`, `tests/refine-loop.test.mjs`

**Interfaces:**
- Consumes: `applyPatch` (Task 3).
- Produces: `refineLoop({plan, rounds = 5, render, call, apply, onRound, cancelled}) -> Promise<{plan, rounds, stopped, error?}>` where `render(plan) -> Promise<string[4]>`, `call({round, renders, plan}) -> Promise<{patch, usage?, ms?}>`, `apply(plan)` rebuilds the world, `onRound({round, notes, done, accepted, ms, usage})`, `stopped` is one of `'done' | 'rounds' | 'error' | 'rejected' | 'cancelled'`.

- [ ] **Step 1: Write the failing test** `tests/refine-loop.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../js/plan.js';
import { refineLoop } from '../js/refine-loop.js';

const plan = validatePlan({
  camera: { height_m: 4, pitch_deg: 10, hfov_deg: 45 },
  surfaces: [{ id: 's1', kind: 'road', material: null, polygon: [[-5, 0], [5, 0], [5, 50], [-5, 50]], top_m: 0 }],
  extent_m: 60,
});
const patch = (extra = {}) => ({ notes: 'ok', done: false, camera: plan.camera, materials: [], surfaces: [], markings: [], objects: [], vehicles: [], remove: [], ...extra });
const harness = (answers) => {
  const applied = [], rounds = [];
  let i = 0;
  return {
    applied, rounds,
    opts: {
      plan,
      render: async () => ['a', 'b', 'c', 'd'],
      call: async () => { const a = answers[i++]; if (a instanceof Error) throw a; return { patch: a, usage: { output_tokens: 1 } }; },
      apply: (p) => applied.push(p),
      onRound: (r) => rounds.push(r),
    },
  };
};

test('stops when Claude is done', async () => {
  const h = harness([patch(), patch({ done: true, notes: 'aligned' })]);
  const out = await refineLoop(h.opts);
  assert.equal(out.stopped, 'done');
  assert.equal(out.rounds, 2);
  assert.equal(h.applied.length, 2);
  assert.equal(h.rounds[1].notes, 'aligned');
});

test('stops after the round limit', async () => {
  const h = harness([patch(), patch(), patch()]);
  const out = await refineLoop({ ...h.opts, rounds: 3 });
  assert.equal(out.stopped, 'rounds');
  assert.equal(h.applied.length, 3);
});

test('stops on a failed call and keeps the plan', async () => {
  const h = harness([new Error('Claude took too long.')]);
  const out = await refineLoop(h.opts);
  assert.equal(out.stopped, 'error');
  assert.equal(out.plan, plan);
  assert.equal(h.applied.length, 0);
  assert.match(out.error.message, /too long/);
});

test('stops on a rejected patch', async () => {
  const h = harness([patch({ remove: ['s1'] })]);
  const out = await refineLoop(h.opts);
  assert.equal(out.stopped, 'rejected');
  assert.equal(out.plan, plan);
  assert.equal(h.applied.length, 0);
  assert.equal(h.rounds[0].accepted, false);
});

test('stops when cancelled', async () => {
  const h = harness([patch(), patch()]);
  let calls = 0;
  const out = await refineLoop({ ...h.opts, cancelled: () => ++calls > 1 });
  assert.equal(out.stopped, 'cancelled');
  assert.equal(h.applied.length, 0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/refine-loop.test.mjs`
Expected: FAIL with `Cannot find module` for `js/refine-loop.js`.

- [ ] **Step 3: Write `js/refine-loop.js`**

```js
// The refine loop: show Claude the world built from the current plan, apply
// its corrections, rebuild, repeat. No three.js here so it can be tested in
// Node; the page passes in how to render, call the API and rebuild.

import { applyPatch } from './plan.js';

/**
 * @param {object} o
 * @param {object} o.plan  validated starting plan
 * @param {number} [o.rounds=5]
 * @param {(plan: object) => Promise<string[]>} o.render  four base64 JPEGs of the world built from `plan`
 * @param {(req: {round: number, renders: string[], plan: object}) => Promise<{patch: object, usage?: object}>} o.call
 * @param {(plan: object) => void} o.apply  rebuild the world from a corrected plan
 * @param {(info: object) => void} [o.onRound]
 * @param {() => boolean} [o.cancelled]
 */
export async function refineLoop({ plan, rounds = 5, render, call, apply, onRound = () => {}, cancelled = () => false }) {
  let current = plan;
  for (let round = 1; round <= rounds; round++) {
    if (cancelled()) return { plan: current, rounds: round - 1, stopped: 'cancelled' };
    const t0 = Date.now();
    let res;
    try {
      res = await call({ round, renders: await render(current), plan: current });
    } catch (error) {
      return { plan: current, rounds: round - 1, stopped: 'error', error };
    }
    if (cancelled()) return { plan: current, rounds: round - 1, stopped: 'cancelled' };
    const next = applyPatch(current, res && res.patch);
    const accepted = next !== current;   // applyPatch hands back the same plan when it refuses a patch
    if (accepted) { current = next; apply(current); }
    const done = Boolean(res && res.patch && res.patch.done);
    onRound({ round, notes: String((res && res.patch && res.patch.notes) || ''), done, accepted, ms: Date.now() - t0, usage: (res && res.usage) || null });
    if (!accepted) return { plan: current, rounds: round, stopped: 'rejected' };
    if (done) return { plan: current, rounds: round, stopped: 'done' };
  }
  return { plan: current, rounds, stopped: 'rounds' };
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `node --test tests/refine-loop.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add js/refine-loop.js tests/refine-loop.test.mjs
git commit -m "Claude World: refine loop"
```

---

### Task 8: The views Claude checks, and the plan flow in the app

**Files:**
- Create: `js/refine.js`
- Modify: `js/main.js`

**Interfaces:**
- Consumes: `photoCamera` (Task 2), `validatePlan` (Task 3), `refineLoop` (Task 7), `world.planScene.setFog` (Task 6), `POST api/scene` plan/refine (Task 4).
- Produces:
  - `renderViews(renderer, scene, plan, frame) -> {camera, blend, top, back}` (base64 JPEG strings, no `data:` prefix) in `js/refine.js`
  - In `js/main.js`: the `?plan=1` flow; `window.__pw.planLog` (array of `{step, round?, ms, usage, model?, notes, done?, accepted?}`), `window.__pw.views()` (calls `renderViews` for the current plan), `window.__pw.planState` (`'idle' | 'planning' | 'refining' | 'done' | 'failed'`)

- [ ] **Step 1: Write `js/refine.js`**

```js
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
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(prev);
  const buf = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  rt.dispose();
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const id = g.createImageData(w, h);
  for (let y = 0; y < h; y++) id.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);   // GL rows go bottom-up
  g.putImageData(id, 0, 0);
  return c;
}

const copy = (c) => { const d = document.createElement('canvas'); d.width = c.width; d.height = c.height; d.getContext('2d').drawImage(c, 0, 0); return d; };
const b64 = (c) => c.toDataURL('image/jpeg', 0.85).split(',')[1];

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
  for (let k = -E; k <= E; k += fine ? 1 : 5) {
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
 * @param {{setFog?: (on: boolean) => void}} [planScene]  to switch fog off for the map
 */
export function renderViews(renderer, scene, plan, frame, planScene = null) {
  const w = OUT_W, h = Math.round((OUT_W * frame.height) / frame.width);
  const ch = plan.camera.height_m;

  // 1 and 2: the photo's camera.
  const cam = photoCamera({ W: w, H: h, hfovDeg: plan.camera.hfov_deg, pitchDeg: plan.camera.pitch_deg, heightM: ch });
  const pc = new THREE.PerspectiveCamera((2 * Math.atan(h / 2 / cam.f) * 180) / Math.PI, w / h, 0.3, 4000);
  pc.rotation.x = -cam.pitch;
  pc.updateProjectionMatrix(); pc.updateMatrixWorld(true);
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
  scene.fog = null; if (planScene?.setFog) planScene.setFog(false);
  const map = shoot(renderer, scene, top, s, s);
  scene.fog = sceneFog; if (planScene?.setFog) planScene.setFog(true);
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
  const backC = shoot(renderer, scene, back, w, h);
  drawLabels(backC.getContext('2d'), back, w, h, plan);

  return { camera: b64(camView), blend: b64(blend), top: b64(map), back: b64(backC) };
}
```

- [ ] **Step 2: Add the plan flow to `js/main.js`**

1. Imports at the top:
```js
import { refineLoop } from './refine-loop.js';
import { renderViews } from './refine.js';
```
2. Under `let lastScan = null;` add:
```js
// Claude World (docs/superpowers/specs/2026-10-15-claude-world-design.md):
// behind ?plan=1 while it is being built, so the live site is unchanged.
const PLAN_MODE = new URLSearchParams(location.search).has('plan');
const PLAN_ROUNDS = 5;
const planLog = [];
let planJob = 0;
let planState = 'idle';
```
3. Add these functions after `askClaude`:
```js
// The frame as base64 JPEG for Claude, shrunk until it fits the request limit.
function frameB64(canvas, maxChars = 2_400_000) {
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
    render: async (p) => { const v = renderViews(renderer, scene, p, photoHi, world.planScene); return [v.camera, v.blend, v.top, v.back]; },
    call: ({ round, renders, plan: p }) => sceneApi({ action: 'refine', image, renders, plan: p, round }),
    apply: (p) => { if (job === planJob) setWorld({ scan: keepRealSubjects(scan, p), photo, photoHi, name, sceneInfo: p }, { keepCamera: true }); },
    onRound: (info) => {
      planLog.push({ step: 'refine', ...info });
      if (job === planJob) status3d(`Round ${info.round} of ${PLAN_ROUNDS}: ${info.notes || 'checked'}`);
    },
    cancelled: () => job !== planJob,
  });
  if (job !== planJob) return;
  planState = out.stopped === 'error' ? 'failed' : 'done';
  status3d(out.stopped === 'done' ? `Claude is happy with the place after ${out.rounds} ${out.rounds === 1 ? 'round' : 'rounds'}` : `Claude checked the place ${out.rounds} ${out.rounds === 1 ? 'time' : 'times'}`);
  if (out.error) toast(`Claude stopped correcting the place (${out.error.message}).`);
}
```
4. In `processFile`, add `planJob++;` as the first line inside `try {` (a new photo cancels a running plan). Then replace the block from `let sceneInfo = null, sceneError = '';` through `if (smartOn()) { ... }` with:
```js
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
```
   (`return` inside `try` still runs `finally`, which clears `busy`, so the preview renders while Claude works.)
5. Add to `window.__pw`:
```js
  planLog,
  get planState() { return planState; },
  views() { return this.plan ? renderViews(renderer, scene, this.plan, current.photoHi || current.photo, world.planScene) : null; },
```

- [ ] **Step 3: Run the unit tests**

Run: `node --test tests/*.test.mjs`
Expected: all PASS.

- [ ] **Step 4: Check the views in a real browser (no API calls)**

With `node tools/dev-server.mjs 3000` running, open `http://localhost:3000/` in Playwright, load the frame and the handmade plan exactly as in Task 6 Step 6, then run:

```js
() => {
  const v = window.__pw.views();
  for (const [k, b] of Object.entries(v)) {
    const img = new Image(); img.src = 'data:image/jpeg;base64,' + b; img.id = 'view-' + k;
    img.style.cssText = 'position:fixed;z-index:99;left:0;top:0;width:640px;display:none';
    document.body.appendChild(img);
  }
  return Object.fromEntries(Object.entries(v).map(([k, b]) => [k, b.length]));
}
```
Expected: four lengths, each between 20,000 and 700,000. Show each image in turn (`display:block`), take a screenshot, and check that: the camera view has the metre grid lying on the road and yellow ids on the surfaces, sign, hedge, tree and lamp; the blend view shows the photo over the render; the map shows the road as a vertical strip with the camera triangle at the centre and the crosswalk 20 m above it; the look-back view shows road continuing behind the camera. Fix anything that's upside down or mirrored before committing.

- [ ] **Step 5: Commit**

```bash
git add js/refine.js js/main.js
git commit -m "Claude World: views for Claude and the plan flow behind ?plan=1"
```

---

### Task 9: Real run on the Hyundai frame, measurements and the go/no-go

**Files:**
- Create: `docs/superpowers/notes/2026-10-15-m1-results.md`, `tools/fixtures/crossing-plan-claude.json`

**Prerequisite (the user):** save an Anthropic API key to `~/.config/pocket-world/anthropic_key` (for example `! pbpaste > ~/.config/pocket-world/anthropic_key && chmod 600 ~/.config/pocket-world/anthropic_key` after copying the key). Never print it.

- [ ] **Step 1: Start the server and check the key is picked up**

```bash
node tools/dev-server.mjs 3000   # run in the background
curl -s localhost:3000/api/scene
```
Expected: `{"enabled":true,"model":"claude-haiku-5-5","plan":true,"planModel":"claude-opus-5-5"}`.

- [ ] **Step 2: Run the full flow in Playwright**

Open `http://localhost:3000/?plan=1`, make sure Smart scene is on, then:

```js
async () => {
  const blob = await (await fetch('tools/fixtures/crossing-clean.jpg')).blob();
  document.querySelector('#smart').checked = true;
  window.__pw.processFile(new File([blob], 'crossing-clean.jpg', { type: 'image/jpeg' }));
  return 'started';
}
```
Poll every 60 s with `() => ({ state: window.__pw.planState, log: window.__pw.planLog })` until `state` is `done` or `failed` (give up after 25 minutes). Take a screenshot after the plan arrives and after every round.

- [ ] **Step 3: Capture the result**

When it finishes:
1. Save the final plan: `() => JSON.stringify(window.__pw.plan, null, 2)` into `tools/fixtures/crossing-plan-claude.json`.
2. Screenshots: the start pose (`__pw.setMode('walk')`), the four `__pw.views()` images, street level at the crosswalk (`__pw.camera.position.set(0, -h + 1.6, -15)` with `h` = the plan's camera height, looking forward and then back toward the camera).
3. Compute cost per call from `planLog[i].usage` with Opus 5.5 prices: input $4/MTok, cache writes $5/MTok, cache reads $0.20/MTok, output $20/MTok:
   `cost = (input_tokens * 4 + cache_creation_input_tokens * 5 + cache_read_input_tokens * 0.2 + output_tokens * 20) / 1e6`.

- [ ] **Step 4: Write `docs/superpowers/notes/2026-10-15-m1-results.md`**

Use this outline and fill every value from the run:

```markdown
# Claude World M1 results (Hyundai frame)

## Numbers
| Step | Server time | Input | Cache write | Cache read | Output | Cost | Notes from Claude |
| --- | --- | --- | --- | --- | --- | --- | --- |
| plan | ... | ... | ... | ... | ... | ... | ... |
| round 1 | ... |
| ... |
| **Total** | ... | | | | | ... | stopped: done / rounds / error |

## Look
Screenshots (start pose, camera view with grid, blend, map, look-back, street level) and one paragraph per view:
what lines up, what doesn't, what the unseen parts look like.

## Against the spec's success criteria
1 to 4 from the spec, each: met / partly / not met, with the evidence.

## Problems found
Each with the cause if known.

## Recommendation
Go / no-go for milestone 2, and what to change first.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-10-15-m1-results.md tools/fixtures/crossing-plan-claude.json
git commit -m "Claude World: M1 run on the Hyundai frame, results"
```

- [ ] **Step 6: Go/no-go with the user**

Show the user the screenshots and the numbers table, give the recommendation, and stop. Milestone 2 starts only on their go.
