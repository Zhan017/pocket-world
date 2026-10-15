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
    if (crosswalk && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) > 60) return;
    const dashed = m.kind === 'lane_dashed';
    // dashed lines are walked dash by dash later on, so tiny or zero values would hang: 0 or missing means the default
    const pos = (v, a, b, d) => (Number(v) > 0 && v !== null && v !== '' ? num(v, a, b, d) : d);
    markings.push({
      id: uid(m.id, 'm', i), kind: m.kind, color, color2: hex(m.color2, color), points: pts,
      width_m: num(m.width_m, 0.05, 8, crosswalk ? 3 : 0.15),
      dash_m: dashed ? pos(m.dash_m, 0.3, 20, 3) : crosswalk ? (num(m.dash_m, 0, 3, 0) >= 0.2 ? num(m.dash_m, 0, 3, 0.5) : 0.5) : num(m.dash_m, 0, 20, 0),
      gap_m: dashed ? pos(m.gap_m, 0.3, 20, 6) : crosswalk ? num(m.gap_m, 0, 3, 0) : num(m.gap_m, 0, 20, 0),
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
    .map((v) => ({ ...v, id: Number(v.id), at: point(v.at, R) }))
    .filter((v, i, all) => all.findIndex((w) => w.id === v.id) === i);

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
  // vehicles are labelled v<id> in the renders
  for (const r of [...remove]) { const m = /^v(\d+)$/.exec(r); if (m) remove.add(m[1]); }
  const merge = (category, items, upd) => {
    const out = items.filter((e) => !remove.has(String(e.id)));
    for (const u of Array.isArray(upd) ? upd : []) {
      if (!u || typeof u !== 'object' || u.id == null) continue;
      // a replacement that would not survive validation must not push out the good original
      if (validatePlan({ ...plan, [category]: [u] })?.[category].length !== 1) continue;
      const i = out.findIndex((e) => String(e.id) === String(u.id));
      if (i >= 0) out[i] = u; else out.push(u);
    }
    return out;
  };
  const next = validatePlan({
    ...plan,
    camera: patch.camera && typeof patch.camera === 'object' ? { ...plan.camera, ...patch.camera } : plan.camera,
    materials: merge('materials', plan.materials, patch.materials),
    surfaces: merge('surfaces', plan.surfaces, patch.surfaces),
    markings: merge('markings', plan.markings, patch.markings),
    objects: merge('objects', plan.objects, patch.objects),
    vehicles: merge('vehicles', plan.vehicles, patch.vehicles),
    notes: typeof patch.notes === 'string' ? patch.notes : plan.notes,
  });
  return next && next.surfaces.length ? next : plan;
}
