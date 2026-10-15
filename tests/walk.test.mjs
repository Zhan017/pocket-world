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
