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
