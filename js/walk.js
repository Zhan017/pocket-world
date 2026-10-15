// One step of walking on Claude's world: the eyes stay `eye` metres above the
// surface under you, kerbs up to `step` are climbed, anything taller stops
// you `radius` short, and a blocked diagonal slides along the obstacle.
// The ray casts come from the caller (three.js in the page, fakes in tests).

const MAX_DROP = 3;   // metres you may step down in one go (kerbs, banks), not off a roof

/**
 * @param {{x: number, z: number, foot: number}} at   foot = height of the surface under you
 * @param {number} dx
 * @param {number} dz
 * @param {(x: number, z: number, fromY: number) => number | null} floorAt
 * @param {(x: number, y: number, z: number, ux: number, uz: number, far: number) => number | null} hitAhead
 * @returns {{x: number, z: number, foot: number}}
 */
export function walkStep(at, dx, dz, floorAt, hitAhead, { eye = 1.6, step = 0.35, radius = 0.3 } = {}) {
  const tryMove = (mx, mz) => {
    const len = Math.hypot(mx, mz);
    if (len < 1e-9) return null;
    const ux = mx / len, uz = mz / len;
    for (const y of [at.foot + step + 0.1, at.foot + Math.min(1.2, eye)]) {   // knee and chest
      const d = hitAhead(at.x, y, at.z, ux, uz, len + radius);
      if (d != null) return null;
    }
    const nx = at.x + mx, nz = at.z + mz;
    const floor = floorAt(nx, nz, at.foot + step + 0.05);
    if (floor == null || floor < at.foot - MAX_DROP) return null;
    return { x: nx, z: nz, foot: floor };
  };
  return tryMove(dx, dz) || tryMove(dx, 0) || tryMove(0, dz) || { x: at.x, z: at.z, foot: at.foot };
}
