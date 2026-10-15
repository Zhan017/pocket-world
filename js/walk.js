// One step of walking on Claude's world: the eyes stay `eye` metres above the
// surface under you, kerbs up to `step` are climbed, your body (`radius` to
// each side) stops short of anything taller, and a blocked move slides along
// the face it hit. The ray casts come from the caller (three.js in the page,
// fakes in tests).

const MAX_DROP = 3;   // metres you may step down in one go (kerbs, banks), not off a roof

/**
 * @param {{x: number, z: number, foot: number}} at   foot = height of the surface under you
 * @param {number} dx
 * @param {number} dz
 * @param {(x: number, z: number, fromY: number) => number | null} floorAt
 *   the first surface below fromY at (x, z)
 * @param {(x: number, y: number, z: number, ux: number, uz: number, far: number) => ({distance: number, nx: number, nz: number} | null)} hitAhead
 *   the first obstacle along the horizontal unit direction (ux, uz) within far,
 *   with the horizontal normal of the face it hit (either side; only its direction matters)
 * @returns {{x: number, z: number, foot: number}}
 */
export function walkStep(at, dx, dz, floorAt, hitAhead, { eye = 1.6, step = 0.35, radius = 0.3 } = {}) {
  const knee = at.foot + step + 0.01;
  const heights = [knee, at.foot + 1.2, at.foot + eye - 0.1];   // knee, chest, head
  // The first face the body would touch moving (mx, mz): rays from its centre
  // and both sides, at each height.
  const obstacle = (mx, mz) => {
    const len = Math.hypot(mx, mz), ux = mx / len, uz = mz / len, px = -uz, pz = ux;
    for (const y of heights) for (const s of [0, -radius, radius]) {
      const hit = hitAhead(at.x + px * s, y, at.z + pz * s, ux, uz, len + radius);
      if (hit) return hit;
    }
    return null;
  };
  const stay = { x: at.x, z: at.z, foot: at.foot };
  let mx = dx, mz = dz;
  for (let i = 0; i < 3; i++) {   // the move, then up to two slides (into a corner)
    if (Math.hypot(mx, mz) < 1e-6) return stay;
    const hit = obstacle(mx, mz);
    if (!hit) {
      const x = at.x + mx, z = at.z + mz;
      const floor = floorAt(x, z, knee + 0.01);
      return floor == null || floor < at.foot - MAX_DROP ? stay : { x, z, foot: floor };
    }
    // Slide: drop the part of the move that goes into the face.
    const n = Math.hypot(hit.nx, hit.nz) || 1, nx = hit.nx / n, nz = hit.nz / n;
    const into = mx * nx + mz * nz;
    mx -= into * nx; mz -= into * nz;
  }
  return stay;
}
