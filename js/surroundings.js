// Builds simple 3D surroundings from Claude's description of the place:
// a ground disc, parallel strips (road, grass, sidewalk...), raised strips
// (hedges, walls, buildings, tree belts) and objects lined up along them.
// Everything is in the levelled world: the camera is at the origin, the
// ground is the plane y = -height. Anything that would sit in front of the
// photo (as seen from where it was taken) is left out, so the real photo is
// never covered.

import * as THREE from 'three';

const FLAT = new Set(['road', 'sidewalk', 'grass', 'dirt', 'gravel', 'sand', 'water', 'parking', 'field', 'floor']);
const HALF_LENGTH = 320;   // strips run this far in both directions
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hex = (s, fallback) => (typeof s === 'string' && /^#?[0-9a-f]{6}$/i.test(s) ? new THREE.Color(s.startsWith('#') ? s : '#' + s) : new THREE.Color(fallback));

// Seeded random, so the same photo always gets the same world.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

const groundVert = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

// Flat surfaces: base color with soft noise, optional lane markings, fading
// into the horizon color with distance.
const groundFrag = /* glsl */`
  uniform vec3 color; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
  uniform float grain; uniform float lanes; uniform vec2 axisDir; uniform vec2 axisOrigin; uniform float halfWidth;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  void main() {
    vec2 p = vWorld.xz;
    float n = noise(p * 0.35) * 0.6 + noise(p * 2.1) * 0.3 + noise(p * 9.0) * 0.1;
    vec3 col = color * (1.0 + (n - 0.5) * grain);
    if (lanes > 0.5) {
      vec2 rel = p - axisOrigin;
      float along = dot(rel, axisDir);
      float across = dot(rel, vec2(-axisDir.y, axisDir.x));
      float centre = step(abs(across), 0.08) * step(0.5, fract(along / 9.0));
      float edges = step(abs(abs(across) - (halfWidth - 0.35)), 0.07);
      col = mix(col, vec3(0.93), max(centre, edges) * 0.85);
    }
    float d = length(vWorld - cameraPosition);
    col = mix(col, fogColor, smoothstep(fogNear, fogFar, d));
    gl_FragColor = vec4(col, 1.0);
  }`;

// Building facades: wall color with a grid of darker windows.
function facadeMaterial(color) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#' + color.getHexString(); g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(30,38,50,0.55)';
  for (let y = 10; y < 64; y += 32) for (let x = 8; x < 64; x += 32) g.fillRect(x, y, 16, 16);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: t });
}

/**
 * @param {object} scene  Claude's answer (see api/scene.js)
 * @param {{height:number, inFrontOfPhoto:(p:THREE.Vector3)=>boolean, seed:number}} opts
 */
export function buildSurroundings(scene, { height, inFrontOfPhoto, seed = 7 }) {
  const group = new THREE.Group();
  const disposables = [];
  const rand = rng(seed);
  const y0 = -height;
  const skyHorizon = hex(scene.sky?.horizon, '#c9d6e3');
  const fogNear = 60, fogFar = 420;
  const groundColor = hex(scene.ground_color, '#7a7f6a');

  // Colors from Claude are sRGB hex; the flat shader writes them straight out,
  // so read them back as raw sRGB numbers.
  const raw = (c) => { const k = new THREE.Color(); k.setRGB(c.r, c.g, c.b, THREE.LinearSRGBColorSpace); return k.convertLinearToSRGB(); };
  const flatMat = (color, grain, extra = {}) => {
    const fog = raw(skyHorizon);
    const m = new THREE.ShaderMaterial({
      vertexShader: groundVert, fragmentShader: groundFrag, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        color: { value: new THREE.Vector3(color.r, color.g, color.b) },
        fogColor: { value: new THREE.Vector3(fog.r, fog.g, fog.b) },
        fogNear: { value: fogNear }, fogFar: { value: fogFar }, grain: { value: grain },
        lanes: { value: 0 }, axisDir: { value: new THREE.Vector2(0, -1) }, axisOrigin: { value: new THREE.Vector2() }, halfWidth: { value: 3 },
        ...extra,
      },
    });
    disposables.push(m);
    return m;
  };

  // Ground disc under everything.
  const disc = new THREE.Mesh(new THREE.CircleGeometry(900, 64), flatMat(raw(groundColor), 0.25));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = y0 - 0.06;
  disc.renderOrder = -0.6;
  group.add(disc);
  disposables.push(disc.geometry);

  // Lights for the solid shapes.
  group.add(new THREE.HemisphereLight(hex(scene.sky?.top, '#9fc0e8'), groundColor, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.4, 1, 0.3);
  group.add(sun);

  const layout = scene.layout || { axis_yaw_deg: 0, strips: [] };
  const yaw = (clamp(Number(layout.axis_yaw_deg) || 0, -90, 90) * Math.PI) / 180;
  const dir = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const along = (offset, s, y = y0) => right.clone().multiplyScalar(offset).addScaledVector(dir, s).setY(y);

  const strips = (layout.strips || []).slice(0, 16);
  let flatIndex = 0;

  // Instanced props collected across strips.
  const props = { trunk: [], canopy: [], pine: [], bush: [], post: [], lamp: [], bench: [] };
  // Probe the whole crown, not just the trunk, so no branch pokes into the photo.
  const crownHidden = (c, r, h0, h1) => {
    const pts = [c.clone().setY(h0), c.clone().setY(h1)];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) pts.push(new THREE.Vector3(c.x + dx * r, (h0 + h1) / 2, c.z + dz * r));
    return pts.some(inFrontOfPhoto);
  };
  const soften = (c) => c.clone().lerp(skyHorizon, 0.12).offsetHSL(0, -0.08, 0);
  const addTree = (p, h, color, shape = 'tree') => {
    const r = h * (shape === 'pine' ? 0.22 : 0.3);
    if (inFrontOfPhoto(p) || crownHidden(p, r, p.y + h * 0.25, p.y + h)) return;
    const shade = soften(color).offsetHSL(0, 0, (rand() - 0.5) * 0.08);
    if (shape === 'pine') {
      props.trunk.push({ p, s: new THREE.Vector3(h * 0.025, h * 0.35, h * 0.025), c: new THREE.Color('#5a4535') });
      props.pine.push({ p: p.clone().setY(p.y + h * 0.2), s: new THREE.Vector3(r, h * 0.8, r), c: shade });
      return;
    }
    props.trunk.push({ p, s: new THREE.Vector3(h * 0.04, h * 0.45, h * 0.04), c: new THREE.Color('#5b4636') });
    const k = 0.8 + rand() * 0.4;
    props.canopy.push({ p: p.clone().setY(p.y + h * 0.62), s: new THREE.Vector3(r * k, h * 0.36 * k, r * k), c: shade });
  };
  const addProp = (kind, p, h, color) => {
    if (kind === 'tree' || kind === 'pine') return addTree(p, h, color, kind);
    const top = p.clone().setY(p.y + h);
    if (inFrontOfPhoto(p) || inFrontOfPhoto(top)) return;
    if (kind === 'bush') {
      if (crownHidden(p, h * 0.7, p.y, p.y + h)) return;
      props.bush.push({ p: p.clone().setY(p.y + h * 0.4), s: new THREE.Vector3(h * 0.7, h * 0.5, h * 0.7), c: soften(color).offsetHSL(0, 0, (rand() - 0.5) * 0.06) });
    }
    else if (kind === 'lamp_post') { props.post.push({ p, s: new THREE.Vector3(0.09, h, 0.09), c: color }); props.lamp.push({ p: top, s: new THREE.Vector3(0.5, 0.15, 0.25), c: new THREE.Color('#e9e4d0') }); }
    else if (kind === 'pole') props.post.push({ p, s: new THREE.Vector3(0.07, h, 0.07), c: color });
    else if (kind === 'bench') props.bench.push({ p: p.clone().setY(p.y + 0.25), s: new THREE.Vector3(1.6, 0.5, 0.5), c: color });
  };

  for (const s of strips) {
    const kind = s.kind;
    const offset = clamp(Number(s.offset_m) || 0, -150, 150);
    const width = clamp(Number(s.width_m) || 2, 0.3, 120);
    const color = hex(s.color, '#808080');
    if (FLAT.has(kind)) {
      const grain = kind === 'grass' || kind === 'field' ? 0.45 : kind === 'water' ? 0.15 : 0.22;
      const m = flatMat(raw(color), grain, kind === 'road' && width > 4.5 ? {
        lanes: { value: 1 }, axisDir: { value: new THREE.Vector2(dir.x, dir.z) },
        axisOrigin: { value: new THREE.Vector2(right.x * offset, right.z * offset) }, halfWidth: { value: width / 2 },
      } : {});
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, HALF_LENGTH * 2), m);
      plane.rotation.order = 'YXZ';
      plane.rotation.set(-Math.PI / 2, -yaw, 0);
      plane.position.copy(along(offset, 0, y0 - 0.04 + flatIndex++ * 0.003));
      plane.renderOrder = -0.5;
      disposables.push(plane.geometry);
      group.add(plane);
    } else {
      const sh = clamp(Number(s.height_m) || (kind === 'hedge' ? 1.1 : kind === 'wall' ? 2.5 : kind === 'fence' ? 1.4 : 9), 0.3, 120);
      if (kind === 'trees') {
        // A belt of trees; repeat.kind picks the shape (pine or broadleaf), repeat.spacing_m the density.
        const spacing = clamp(Number(s.repeat?.spacing_m) || 7, 3, 40);
        const shape = s.repeat?.kind === 'pine' ? 'pine' : 'tree';
        const count = Math.min(260, Math.round(((HALF_LENGTH * 2) / spacing) * Math.max(1, width / spacing)));
        for (let i = 0; i < count; i++) {
          const a = (rand() * 2 - 1) * HALF_LENGTH, o = offset + (rand() - 0.5) * width;
          addTree(along(o, a), sh * (0.75 + rand() * 0.5), color, shape);
        }
      } else {
        // Hedges, walls, fences and buildings come in segments so the ones
        // in view of the photo can be skipped.
        const mat = kind === 'buildings' ? facadeMaterial(soften(color)) : new THREE.MeshLambertMaterial({ color: soften(color) });
        disposables.push(mat);
        let a = -HALF_LENGTH;
        while (a < HALF_LENGTH) {
          const len = kind === 'buildings' ? 12 + rand() * 16 : 10;
          const segH = kind === 'buildings' ? sh * (0.7 + rand() * 0.6) : sh;
          const depth = kind === 'fence' ? 0.12 : kind === 'wall' ? Math.min(width, 0.4) : width;
          const mid = along(offset, a + len / 2);
          const corners = [-1, 1].flatMap((i) => [-1, 1].map((j) => mid.clone().addScaledVector(dir, (i * len) / 2).addScaledVector(right, (j * depth) / 2)));
          const probe = [...corners, ...corners.map((c) => c.clone().setY(c.y + segH))];
          if (!probe.some(inFrontOfPhoto)) {
            const geo = new THREE.BoxGeometry(depth, segH, kind === 'buildings' ? len : len + 0.02);
            if (kind === 'buildings') {
              // Repeat the window texture once per ~3 m.
              const uv = geo.attributes.uv;
              for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(depth, len) / 3, uv.getY(i) * segH / 3);
            }
            const box = new THREE.Mesh(geo, mat);
            box.position.copy(mid).setY(y0 + segH / 2);
            box.rotation.y = -yaw;
            disposables.push(geo);
            group.add(box);
          }
          a += len + (kind === 'buildings' ? 2 + rand() * 4 : 0);
        }
      }
    }
    // Objects lined up along the strip.
    const r = s.repeat;
    if (r && r.kind && r.kind !== 'none' && kind !== 'trees') {
      const spacing = clamp(Number(r.spacing_m) || 10, 1.5, 80);
      const h = clamp(Number(r.height_m) || 3, 0.3, 40);
      const c = hex(r.color, r.kind === 'tree' || r.kind === 'bush' ? '#4f7a35' : '#5e6266');
      for (let a = -HALF_LENGTH; a <= HALF_LENGTH; a += spacing) addProp(r.kind, along(offset, a + (rand() - 0.5) * spacing * 0.2), h, c);
    }
  }

  // Build the instanced meshes.
  const inst = (list, geo, mat) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    list.forEach((it, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
      m.compose(it.p, q, it.s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, it.c);
    });
    disposables.push(geo, mat);
    group.add(mesh);
  };
  const lambert = () => new THREE.MeshLambertMaterial({ flatShading: true });
  inst(props.trunk, new THREE.CylinderGeometry(0.6, 1, 2, 6).translate(0, 1, 0).scale(1, 0.5, 1).translate(0, 0, 0), lambert());
  inst(props.canopy, new THREE.IcosahedronGeometry(1, 1), lambert());
  inst(props.pine, new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0), lambert());
  inst(props.bush, new THREE.IcosahedronGeometry(1, 1), lambert());
  inst(props.post, new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0), lambert());
  inst(props.lamp, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  inst(props.bench, new THREE.BoxGeometry(1, 1, 1), lambert());

  return {
    group,
    fog: new THREE.Fog(skyHorizon, fogNear, fogFar),
    dispose() { disposables.forEach((d) => d.dispose && d.dispose()); },
  };
}
