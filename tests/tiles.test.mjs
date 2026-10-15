import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoCamera, pixelToGround } from '../js/camera.js';
import { groundTile, patchTile } from '../js/tiles.js';

// A synthetic photo where each ground pixel's red = 128 + 40 * right_m and
// green = 20 * fwd_m, so tiles can be checked against real ground positions.
function groundPhoto(cam) {
  const { W, H } = cam;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const g = pixelToGround(cam, u + 0.5, v + 0.5);
    const k = (v * W + u) * 4;
    if (g) { data[k] = 128 + 40 * g[0]; data[k + 1] = 20 * g[1]; }
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
  const right = c[0] + t.metres / 2 - (0.5 / 32) * t.metres;
  const farF = c[1] + t.metres / 2 - (0.5 / 32) * t.metres;
  assert.ok(Math.abs(at(0, 16)[0] - (128 + 40 * left)) <= 1.5, `red left ${at(0, 16)[0]} vs ${128 + 40 * left}`);
  assert.ok(Math.abs(at(31, 16)[0] - (128 + 40 * right)) <= 1.5, `red right ${at(31, 16)[0]} vs ${128 + 40 * right}`);
  assert.ok(Math.abs(at(16, 0)[1] - 20 * nearF) <= 1.5, `green near ${at(16, 0)[1]} vs ${20 * nearF}`);
  assert.ok(Math.abs(at(16, 31)[1] - 20 * farF) <= 1.5, `green far ${at(16, 31)[1]} vs ${20 * farF}`);
  assert.ok(at(31, 16)[0] > at(0, 16)[0], 'red grows to the right');
  assert.ok(at(16, 31)[1] > at(16, 0)[1], 'green grows forward');
});

test('ground tile is null above the horizon', () => {
  const cam = photoCamera({ W: 400, H: 300, hfovDeg: 50, pitchDeg: 5, heightM: 5 });
  assert.equal(groundTile(groundPhoto(cam), cam, [0.4, 0.0, 0.6, 0.1]), null);
});

test('patch tile resamples the box', () => {
  const data = new Uint8ClampedArray(10 * 10 * 4);
  for (let i = 0; i < 100; i++) {
    data[i * 4] = i % 10 < 5 ? 0 : 200;
    data[i * 4 + 1] = Math.floor(i / 10) < 5 ? 50 : 150;
    data[i * 4 + 3] = 255;
  }
  const img = { data, width: 10, height: 10 };
  const t = patchTile(img, [0.6, 0, 1, 1], 8);   // stays clear of the 0/200 boundary
  assert.equal(t.width, 8);
  for (let i = 0; i < 64; i++) assert.equal(t.data[i * 4], 200);
  const top = patchTile(img, [0.6, 0, 1, 0.4], 8);
  for (let i = 0; i < 64; i++) { assert.equal(top.data[i * 4], 200); assert.equal(top.data[i * 4 + 1], 50); }
  const both = patchTile(img, [0.6, 0, 1, 1], 8);   // spans both green bands, top to bottom
  for (let i = 0; i < 8; i++) {
    assert.equal(both.data[i * 4], 200); assert.equal(both.data[i * 4 + 1], 50);                  // row 0
    assert.equal(both.data[(56 + i) * 4], 200); assert.equal(both.data[(56 + i) * 4 + 1], 150);   // row 7
  }
  const bottom = patchTile(img, [0.6, 0.6, 1, 1], 8);
  for (let i = 0; i < 64; i++) { assert.equal(bottom.data[i * 4], 200); assert.equal(bottom.data[i * 4 + 1], 150); }
});
