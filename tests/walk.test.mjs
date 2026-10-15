import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkStep } from '../js/walk.js';

// A tiny world for the callbacks: flat ground at y = 0 for |x|, |z| < 50,
// plus optional boxes {x0, x1, z0, z1, top} standing on it, and slanted walls
// {a, b, c, top}, solid where a*x + b*z >= c.
function world(boxes = [], groundY = 0, slants = []) {
  const boxAt = (x, z) => boxes.find((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1);
  const slantAt = (x, z) => slants.find((s) => s.a * x + s.b * z >= s.c);
  const floorAt = (x, z, fromY) => {
    if (Math.abs(x) > 50 || Math.abs(z) > 50) return null;
    const b = boxAt(x, z) || slantAt(x, z);
    if (b && b.top <= fromY) return b.top;
    return groundY <= fromY ? groundY : null;
  };
  const hitAhead = (x, y, z, ux, uz, far) => {
    for (let d = 0.01; d <= far; d += 0.01) {
      const px = x + ux * d, pz = z + uz * d;
      const b = boxAt(px, pz);
      if (b && b.top > y) {
        const bx = x + ux * (d - 0.01);
        const xFace = bx < b.x0 || bx > b.x1;
        return { distance: d, nx: xFace ? 1 : 0, nz: xFace ? 0 : 1 };
      }
      const s = slantAt(px, pz);
      if (s && s.top > y) return { distance: d, nx: s.a, nz: s.b };
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

test('slides along a slanted wall', () => {
  const w = world([], 0, [{ a: 1, b: 1, c: 1, top: 2 }]);
  const out = walkStep({ x: 0.25, z: 0.25, foot: 0 }, 0.3, 0.1, w.floorAt, w.hitAhead);
  assert.ok(out.x > 0.25 && out.z < 0.25, JSON.stringify(out));
  assert.ok(out.x + out.z < 0.7, JSON.stringify(out));
});

test('keeps the body clear of a wall passed at a glance', () => {
  const w = world([{ x0: 1, x1: 2, z0: -50, z1: 50, top: 2 }]);
  const out = walkStep({ x: 0.6, z: 0, foot: 0 }, 0.1, 0.3, w.floorAt, w.hitAhead);
  assert.equal(out.x, 0.6);
  assert.ok(Math.abs(out.z - 0.3) < 1e-9, JSON.stringify(out));
});

test('a body does not fit through a 0.36 m gap', () => {
  const w = world([
    { x0: -0.32, x1: -0.18, z0: -1.05, z1: -0.95, top: 2 },
    { x0: 0.18, x1: 0.32, z0: -1.05, z1: -0.95, top: 2 },
  ]);
  assert.deepEqual(walkStep({ x: 0, z: -0.5, foot: 0 }, 0, -0.3, w.floorAt, w.hitAhead), { x: 0, z: -0.5, foot: 0 });
});

test('no dead band between climbing and blocking', () => {
  const low = world([{ x0: 1, x1: 5, z0: -5, z1: 5, top: 0.355 }]);
  assert.equal(walkStep({ x: 0.9, z: 0, foot: 0 }, 0.2, 0, low.floorAt, low.hitAhead).foot, 0.355);
  const high = world([{ x0: 1, x1: 5, z0: -5, z1: 5, top: 0.37 }]);
  assert.deepEqual(walkStep({ x: 0.9, z: 0, foot: 0 }, 0.2, 0, high.floorAt, high.hitAhead), { x: 0.9, z: 0, foot: 0 });
});

test('a thin post never slips between the rays', () => {
  // A 0.2 m post (the narrowest solid the scene builds) anywhere across the body's width.
  for (let off = -0.3; off <= 0.3001; off += 0.05) {
    const post = { x0: off - 0.1, x1: off + 0.1, z0: -1.1, z1: -0.9, top: 2 };
    const w = world([post]);
    let at = { x: 0, z: 0, foot: 0 };
    for (let i = 0; i < 60; i++) {
      at = walkStep(at, 0, -0.03, w.floorAt, w.hitAhead);
      const inside = at.x > post.x0 - 0.15 && at.x < post.x1 + 0.15 && at.z > post.z0 - 0.15 && at.z < post.z1 + 0.15;
      assert.ok(!inside, `walked into a post at offset ${off.toFixed(2)}: ${JSON.stringify(at)}`);
    }
  }
});
