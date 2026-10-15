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
