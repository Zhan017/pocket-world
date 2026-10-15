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
