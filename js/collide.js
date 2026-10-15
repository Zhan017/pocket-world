// Ray casts against the solid parts of Claude's world (plan meshes and car
// models), for walking. three-mesh-bvh makes each cast cost microseconds
// instead of milliseconds on a ~50k-triangle world.

import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

/** @param {THREE.Mesh[]} meshes  their matrixWorld must be up to date */
export function makeCollider(meshes) {
  for (const m of meshes) {
    if (!m.geometry.boundsTree) m.geometry.boundsTree = new MeshBVH(m.geometry);
    m.raycast = acceleratedRaycast;
  }
  const rc = new THREE.Raycaster();
  rc.firstHitOnly = true;
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  const first = () => rc.intersectObjects(meshes, false)[0] || null;
  return {
    floorAt(x, z, fromY) {
      rc.set(o.set(x, fromY, z), d.set(0, -1, 0)); rc.far = 60;
      const h = first();
      return h ? h.point.y : null;
    },
    hitAhead(x, y, z, ux, uz, far) {
      rc.set(o.set(x, y, z), d.set(ux, 0, uz)); rc.far = far;
      const h = first();
      if (!h) return null;
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : d.clone().negate();
      return { distance: h.distance, nx: n.x, nz: n.z };
    },
    dispose() { for (const m of meshes) m.geometry.boundsTree = null; },
  };
}
