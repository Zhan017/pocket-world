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
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  void main() {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    vec2 tuv = abs(n.y) > 0.6 ? vec2(vWorld.x, -vWorld.z) : vec2(vWorld.x - vWorld.z, vWorld.y);
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

/** Height of the plan's surface under [r, f] (the highest one containing it), or 0 on the road. */
export function surfaceTopAt(plan, r, f) {
  let top = 0;
  for (const s of plan.surfaces) if (s.top_m > top && inside(s.polygon, r, f)) top = s.top_m;
  return top;
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
  const topAt = (r, f) => surfaceTopAt(plan, r, f);

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
