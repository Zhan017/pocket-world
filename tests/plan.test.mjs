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
