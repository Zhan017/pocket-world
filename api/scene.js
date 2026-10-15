// Vercel serverless function: asks Claude to read the photo.
//
// GET  /api/scene  -> { enabled }  (is a key configured?)
// POST /api/scene  { image: <base64 JPEG>, width, height, subjects: [{ id, label, box: [x0,y0,x1,y1] (0..1) }] }
//                  -> { scene }  (see SCHEMA below)
// POST /api/scene  { action: 'plan', image, width, height, subjects }
//                  -> { plan, usage, model, ms }     Claude World: the whole place in metres (Opus)
// POST /api/scene  { action: 'refine', image, renders: [4 JPEGs], plan, round }
//                  -> { patch, usage, model, ms }    corrections after looking at renders of the world
//
// Set ANTHROPIC_API_KEY in the Vercel project settings. Optional: ANTHROPIC_MODEL.
// Claude only returns text (JSON here). It does not generate images.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MAX_IMAGE_BYTES = 700 * 1024;      // base64 length cap (about 500 KB of JPEG)
const RATE_LIMIT = 30;                   // requests per IP per hour, per server instance
const hits = new Map();

const color = { type: 'string', description: 'Hex color like #7a8b5c' };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['caption', 'scene_type', 'camera', 'ground_polygon', 'subjects', 'vehicles', 'sky', 'ground_color', 'layout'],
  properties: {
    caption: { type: 'string', description: 'A short plain description of the place, under 12 words.' },
    scene_type: { type: 'string', enum: ['street', 'road', 'path', 'park', 'forest', 'beach', 'waterfront', 'plaza', 'field', 'mountain', 'indoor', 'other'] },
    camera: {
      type: 'object',
      additionalProperties: false,
      required: ['height_m', 'pitch_deg', 'hfov_deg'],
      properties: {
        height_m: { type: 'number', description: 'Height of the lens above the ground below it, in metres. Handheld photo about 1.5, traffic or security camera 4 to 10, drone 20 or more.' },
        pitch_deg: { type: 'number', description: 'How far the view points below the horizon, in degrees. Positive = looking down, negative = looking up, 0 = level.' },
        hfov_deg: { type: 'number', description: 'Horizontal field of view in degrees. Phone main camera about 65 to 75, wide or CCTV 80 to 110, zoomed 20 to 45.' },
      },
    },
    ground_polygon: {
      type: 'array',
      description: 'Outline of the visible flat walkable ground (road, sidewalk, lawn, floor), as 4 to 10 points in normalized image coordinates (x right, y down, 0 to 1). Empty if no flat ground is visible.',
      items: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
    },
    subjects: {
      type: 'array',
      description: 'One verdict per detected subject id given in the request.',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'keep', 'reason'],
        properties: {
          id: { type: 'integer' },
          keep: { type: 'boolean', description: 'true for a real person, animal or vehicle physically in the scene. false for signs, pictograms, posters, statues, mannequins, screens, reflections, toy or pictured vehicles, and people fully inside vehicles.' },
          reason: { type: 'string' },
        },
      },
    },
    vehicles: {
      type: 'array',
      description: 'One entry per detected car, truck or bus you kept. The app builds a 3D model of it, so describe the whole vehicle, including the sides the photo does not show.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'body_style', 'make_model', 'body_color', 'roof_color', 'trim_color', 'wheel_color', 'length_m', 'width_m', 'height_m', 'heading_deg', 'taillight_style', 'profile', 'belt_h', 'axle_rear_t', 'axle_front_t', 'wheel_diameter_m', 'roundness'],
        properties: {
          id: { type: 'integer' },
          body_style: { type: 'string', enum: ['sedan', 'hatchback', 'wagon', 'suv', 'crossover', 'coupe', 'convertible', 'pickup', 'van', 'minivan', 'bus', 'truck', 'other'] },
          make_model: { type: 'string', description: 'Best guess of make and model, e.g. "Toyota Camry". Empty if unknown.' },
          body_color: { ...color, description: 'Main paint color as it looks in this light.' },
          roof_color: { ...color, description: 'Roof color (same as body unless two-tone).' },
          trim_color: { ...color, description: 'Bumper, sill and wheel-arch plastic color (often near black, or the body color).' },
          wheel_color: { ...color, description: 'Rim color.' },
          length_m: { type: 'number' }, width_m: { type: 'number', description: 'Without mirrors.' }, height_m: { type: 'number' },
          heading_deg: { type: 'number', description: 'Which way the front of the vehicle points, seen from the camera. 0 = front faces the camera, 180 = rear faces the camera, 90 = front points to the right of the image, -90 = to the left. Use in-between values for angled views.' },
          taillight_style: { type: 'string', enum: ['corner', 'wide', 'vertical', 'light_bar'], description: 'Shape of the rear lights for this model: corner (separate lights at each corner), wide (long horizontal lights reaching toward the middle), vertical (tall narrow lights), light_bar (a strip joining the two lights).' },
          profile: {
            type: 'array',
            description: 'Side silhouette of this model\'s top edge, from the rear bumper (t = 0) to the front bumper (t = 1). h is the height as a fraction of the full height (highest point of the roof = 1). 8 to 14 points with t increasing. part says what the stretch from this point to the next one is: body (boot, rear deck, bonnet), glass (rear window or windscreen), roof, or open (open cockpit or open load bed).',
            items: { type: 'object', additionalProperties: false, required: ['t', 'h', 'part'], properties: { t: { type: 'number' }, h: { type: 'number' }, part: { type: 'string', enum: ['body', 'glass', 'roof', 'open'] } } },
          },
          belt_h: { type: 'number', description: 'Height of the bottom edge of the side windows, as a fraction of the full height.' },
          axle_rear_t: { type: 'number', description: 'Rear wheel centre position along the length (0 = rear bumper, 1 = front bumper).' },
          axle_front_t: { type: 'number', description: 'Front wheel centre position along the length.' },
          wheel_diameter_m: { type: 'number', description: 'Outer tyre diameter.' },
          roundness: { type: 'number', description: '0 = boxy (vans, modern SUVs) to 1 = very rounded (Beetle, classic sports cars).' },
        },
      },
    },
    sky: {
      type: 'object', additionalProperties: false, required: ['top', 'horizon'],
      properties: { top: color, horizon: color },
    },
    ground_color: { ...color, description: 'Main ground color around the camera beyond the frame.' },
    layout: {
      type: 'object',
      additionalProperties: false,
      required: ['axis_yaw_deg', 'strips'],
      properties: {
        axis_yaw_deg: { type: 'number', description: 'Direction of the main road, path or corridor relative to where the camera points, in degrees. 0 = straight ahead, positive = turning right.' },
        strips: {
          type: 'array',
          description: 'Cross-section of the place as parallel bands running along the axis, ordered from left to right. Cover about 40 m to each side, including what is outside the frame.',
          items: {
            type: 'object', additionalProperties: false,
            required: ['kind', 'offset_m', 'width_m', 'height_m', 'color', 'repeat'],
            properties: {
              kind: { type: 'string', enum: ['road', 'sidewalk', 'grass', 'dirt', 'gravel', 'sand', 'water', 'parking', 'field', 'floor', 'hedge', 'trees', 'buildings', 'wall', 'fence'] },
              offset_m: { type: 'number', description: 'Lateral position of the band centre relative to the camera, metres. Negative = left.' },
              width_m: { type: 'number' },
              height_m: { type: 'number', description: '0 for flat surfaces. Typical: hedge 1, wall 2.5, trees 8, buildings 9 to 40.' },
              color: color,
              repeat: {
                type: 'object', additionalProperties: false, required: ['kind', 'spacing_m', 'height_m', 'color'],
                description: 'Objects lined up along this band. Use kind none if there are none.',
                properties: {
                  kind: { type: 'string', enum: ['none', 'tree', 'pine', 'bush', 'lamp_post', 'pole', 'bench'], description: 'For a band of kind trees, use tree or pine to pick the tree shape and spacing_m for how dense the trees are.' },
                  spacing_m: { type: 'number' },
                  height_m: { type: 'number' },
                  color: color,
                },
              },
            },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- plan (Claude World)
// The plan describes the whole place in metres so the browser can build it in
// 3D (js/scenebuild.js). Kind lists match js/plan.js.
const PLAN_MODEL = () => process.env.CLAUDE_PLAN_MODEL || 'claude-opus-5-5';
const PLAN_EFFORT = () => process.env.CLAUDE_PLAN_EFFORT || 'high';
const MAX_FRAME_B64 = 2_600_000;
const MAX_RENDER_B64 = 700_000;
const MAX_PLAN_CHARS = 200_000;
const PLAN_LIMIT = 6;       // plans per IP per hour, per server instance
const REFINE_LIMIT = 40;    // refine rounds per IP per hour, per server instance

const num = { type: 'number' };
const pt = { type: 'array', items: num, description: '[right_m, fwd_m]: metres right of and ahead of the point on the ground below the camera.' };
const pts = (description) => ({ type: 'array', items: pt, description });
const nbox = { type: 'array', items: num, description: '[x0, y0, x1, y1] in normalized image coordinates (x right, y down, 0 to 1).' };
const orNull = (s) => ({ anyOf: [s, { type: 'null' }] });
const idStr = { type: 'string', description: 'Short stable id, kept the same in later rounds.' };

const MATERIAL = {
  type: 'object', additionalProperties: false, required: ['id', 'kind', 'color', 'sample_box'],
  properties: {
    id: idStr,
    kind: { type: 'string', enum: ['asphalt', 'concrete', 'paving', 'curb', 'grass', 'soil', 'gravel', 'hedge', 'foliage', 'bark', 'facade', 'glass', 'metal', 'paint', 'water'] },
    color: { ...color, description: 'Average color of this material as it looks in this light.' },
    sample_box: orNull({ ...nbox, description: 'A clean patch of this material in the photo (no markings, shadows, vehicles or people, at least about 40 pixels wide), or null if not visible.' }),
  },
};
const SURFACE = {
  type: 'object', additionalProperties: false, required: ['id', 'kind', 'material', 'polygon', 'top_m'],
  properties: {
    id: idStr,
    kind: { type: 'string', enum: ['road', 'lane', 'sidewalk', 'median', 'island', 'grass', 'verge', 'parking', 'plaza', 'driveway'] },
    material: { type: 'string', description: 'Material id.' },
    polygon: pts('Outline on the ground, 3 to 40 points in order, not self-crossing.'),
    top_m: { type: 'number', description: 'Height of this surface above the road: 0 for the road, about 0.15 for a curbed sidewalk or median.' },
  },
};
const MARKING = {
  type: 'object', additionalProperties: false, required: ['id', 'kind', 'color', 'color2', 'points', 'width_m', 'dash_m', 'gap_m'],
  properties: {
    id: idStr,
    kind: { type: 'string', enum: ['lane_solid', 'lane_dashed', 'edge_line', 'stop_line', 'crosswalk'] },
    color, color2: { ...color, description: 'Second color for alternating crosswalk stripes; same as color otherwise.' },
    points: pts('The line. For a crosswalk: [one curb end, other curb end] of the walking line across the road.'),
    width_m: { type: 'number', description: 'Line width. For a crosswalk: how long each stripe is, measured along the traffic.' },
    dash_m: { type: 'number', description: 'Dash length for dashed lines, 0 for solid. For a crosswalk: stripe width.' },
    gap_m: { type: 'number', description: 'Gap between dashes or crosswalk stripes.' },
  },
};
const OBJECT = {
  type: 'object', additionalProperties: false,
  required: ['id', 'kind', 'at', 'path', 'height_m', 'width_m', 'depth_m', 'heading_deg', 'material', 'color', 'seen', 'sign'],
  properties: {
    id: idStr,
    kind: { type: 'string', enum: ['pole', 'lamp_post', 'sign', 'traffic_light', 'tree', 'bush', 'hedge', 'fence', 'wall', 'barrier', 'bollard', 'building', 'shelter', 'gantry'] },
    at: orNull({ ...pt, description: 'Ground position for single things.' }),
    path: orNull(pts('For hedges, fences, walls, barriers and gantries: the line they follow. For buildings: the footprint.')),
    height_m: num, width_m: { type: 'number', description: 'Width (crown diameter for trees and bushes, thickness for hedges and walls, plate width for signs).' },
    depth_m: num,
    heading_deg: { type: 'number', description: '0 = its front faces the camera, 90 = its front points to the image right.' },
    material: orNull({ type: 'string', description: 'Material id.' }),
    color, seen: { type: 'boolean', description: 'Whether the photo shows it.' },
    sign: orNull({
      type: 'object', additionalProperties: false, required: ['shape', 'face_color', 'symbol'],
      properties: {
        shape: { type: 'string', enum: ['square', 'rectangle', 'circle', 'triangle', 'diamond', 'octagon'] },
        face_color: color,
        symbol: { type: 'string', description: 'What it shows, e.g. pedestrian_crossing, speed_limit_40, no_entry.' },
      },
    }),
  },
};
const OVERLAY = {
  type: 'object', additionalProperties: false, required: ['kind', 'box'],
  properties: { kind: { type: 'string', enum: ['inset', 'box', 'text', 'logo', 'border'] }, box: nbox },
};
const VEHICLE = SCHEMA.properties.vehicles.items;
const PLAN_VEHICLE = {
  ...VEHICLE,
  required: [...VEHICLE.required, 'at'],
  properties: { ...VEHICLE.properties, at: { ...pt, description: 'Point on the ground under the centre of the vehicle.' } },
};
const PLAN_PROPS = {
  caption: SCHEMA.properties.caption, scene_type: SCHEMA.properties.scene_type, camera: SCHEMA.properties.camera,
  ground_polygon: SCHEMA.properties.ground_polygon, subjects: SCHEMA.properties.subjects,
  vehicles: { type: 'array', items: PLAN_VEHICLE },
  sky: SCHEMA.properties.sky, ground_color: SCHEMA.properties.ground_color,
  overlays: { type: 'array', items: OVERLAY, description: 'Anything drawn on top of the image: picture-in-picture insets, detection boxes, text, logos, borders.' },
  materials: { type: 'array', items: MATERIAL }, surfaces: { type: 'array', items: SURFACE },
  markings: { type: 'array', items: MARKING }, objects: { type: 'array', items: OBJECT },
  extent_m: { type: 'number', description: 'Radius around the camera the plan covers, normally 60.' },
  notes: { type: 'string', description: 'One short plain sentence for the viewer about the place.' },
};
const PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: Object.keys(PLAN_PROPS), properties: PLAN_PROPS };
const PATCH_PROPS = {
  notes: { type: 'string', description: 'One short plain sentence for the viewer about what you changed.' },
  done: { type: 'boolean', description: 'true when nearby visible things line up within about half a metre and nothing important is missing.' },
  camera: SCHEMA.properties.camera,
  materials: { type: 'array', items: MATERIAL }, surfaces: { type: 'array', items: SURFACE },
  markings: { type: 'array', items: MARKING }, objects: { type: 'array', items: OBJECT },
  vehicles: { type: 'array', items: PLAN_VEHICLE },
  remove: { type: 'array', items: { type: 'string' }, description: 'Ids to delete.' },
};
const PATCH_SCHEMA = { type: 'object', additionalProperties: false, required: Object.keys(PATCH_PROPS), properties: PATCH_PROPS };

const PLAN_SYSTEM = `You rebuild the place in a single photo as a 3D plan, so a web app can turn it into a small world people walk around in. The photo is usually a traffic or CCTV camera frame.

Coordinates
- Ground positions are [right_m, fwd_m] in metres. The origin is the point on the ground straight below the camera lens. fwd_m points the way the camera looks (flattened onto the ground), right_m to its right. Negative fwd_m is behind the camera.
- Heights are metres above the road surface. Angles are degrees. Headings: 0 = the object's front faces the camera, 90 = its front points to the image's right, 180 = it faces away.
- Image positions are normalized: x 0 to 1 left to right, y 0 to 1 top to bottom.

What to describe
- camera: the lens height above the road, how far it looks down (pitch, positive = down) and its horizontal field of view.
- surfaces: every ground area as a polygon (road, lanes paved differently, sidewalks, medians, islands, grass verges...). top_m is the height above the road: 0 for the road, about 0.15 for a curbed sidewalk or median.
- markings: painted lines and crossings. For a crosswalk, points = [one curb end, other curb end] of the walking line across the road; width_m = stripe length measured along the traffic; dash_m = stripe width; gap_m = space between stripes; color and color2 for alternating stripe colors (the same color twice if they don't alternate).
- objects: poles, signs, lamps, traffic lights, trees, bushes, hedges, fences, walls, barriers, bollards, buildings, shelters. Use at for single things and path for long ones (hedges, fences, walls, building footprints). seen says whether the photo shows it.
- materials: one per look (asphalt, grass, hedge...). sample_box is a clean patch of it in the photo, or null. Surfaces and objects refer to materials by id.
- vehicles: one per detected vehicle you keep, as described in the schema, plus at, the ground point under its centre.
- overlays: anything drawn on top of the image (picture-in-picture insets, detection boxes, text, logos, borders). Describe the scene underneath, not the overlays.

Beyond the frame
Cover about extent_m (normally 60) metres around the camera, including behind it. Continue what you see the way such roads are normally built: the road and its markings carry on, sidewalks and verges continue, vegetation continues. Keep unseen parts simple and plausible. Never add large overhead structures (bridges, gantries, roofs) you cannot see.

Accuracy
Visible things matter most: line their edges up with the photo. Use real sizes: lanes about 3.5 m, curbs 0.15 m, crosswalk stripes 0.4 to 0.6 m wide, sign plates 0.6 to 0.9 m, cars about 4.3 m long.
Use short stable ids (s1, m1, o1, mat-asphalt) and keep them when you revise. Vehicles keep the numeric id they were given.
At most 24 materials, 30 surfaces, 40 markings and 120 objects.`;

function planPrompt(W, H, subjects) {
  const list = subjects.length
    ? subjects.map((s) => `id ${s.id}: ${String(s.label).slice(0, 20)}, box x0=${(+s.box[0]).toFixed(3)} y0=${(+s.box[1]).toFixed(3)} x1=${(+s.box[2]).toFixed(3)} y1=${(+s.box[3]).toFixed(3)}`).join('\n')
    : 'none';
  return `The image above is the photo, ${W}x${H} pixels.
Detected subjects:
${list}
Describe the whole place as a plan and submit it by calling submit_plan once.`;
}

function refinePrompt(round, planJson) {
  return `Round ${round}. The first image is the photo. The next four are renders of the 3D world built from the current plan:
Image 2: the world from the photo's camera, with a 1 m ground grid (brighter every 5 m) and element ids (vehicles show as v<id>).
Image 3: the same view with the photo blended on top at 50%. Doubled edges mean something is misplaced.
Image 4: top-down map. Forward is up, the camera is the white triangle at the centre, grid lines every 5 m.
Image 5: looking back toward the camera from 15 m in front of it.
Current plan:
${planJson}
Return only what should change: corrected or new elements (complete, with their ids) in materials, surfaces, markings, objects and vehicles, ids to delete in remove, and the full camera even if unchanged. Fix the biggest problems first: a wrong camera height, tilt or field of view shifts everything, so correct the camera before moving many elements. Set done to true when nearby visible things line up within about half a metre and nothing important is missing. Submit your changes by calling submit_patch once.`;
}

const SYSTEM = `You read a single photo so a web app can turn it into a small 3D world the viewer can walk around in.
The app already has relative depth for every pixel and cut-outs of detected people. You supply what it cannot measure:
the camera height, tilt and field of view; where the flat ground is; which detected people, animals and vehicles are real; a
description of each vehicle good enough to model it in 3D from every side; and a simple layout of what most likely surrounds the
camera beyond the edges of the frame, including behind it.
Use metres and degrees. Base the layout on what is visible and on how such places are normally built.
Always give your best estimate, even when unsure.`;

function rateLimited(ip, kind = 'scene', limit = RATE_LIMIT) {
  const now = Date.now();
  const key = `${kind}:${ip}`;
  const list = (hits.get(key) || []).filter((t) => now - t < 3600e3);
  list.push(now);
  hits.set(key, list);
  return list.length > limit;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const cleanB64 = (v) => (typeof v === 'string' ? v.replace(/^data:image\/\w+;base64,/, '') : '');
const fail = (status, message) => Object.assign(new Error(message), { status });

// One call to the plan model; the answer comes back as the input of a tool call
// (the combined schemas are too big for structured outputs, so the tool is not
// strict and tool_choice stays auto). The whole answer has to arrive inside one
// function run, so it is cut off a little before Vercel's limit.
async function callClaude(key, { content, tool, schema, maxTokens }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.PLAN_TIMEOUT_MS) || 280000);
  let data;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify({
        model: PLAN_MODEL(),
        max_tokens: maxTokens,
        system: PLAN_SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: PLAN_EFFORT() },
        tools: [{ name: tool, description: 'Submit your answer.', input_schema: schema }],
        tool_choice: { type: 'auto' },
        fallbacks: 'default',
        messages: [{ role: 'user', content }],
      }),
    });
    data = await r.json().catch((e) => { if (e.name === 'AbortError') throw e; return null; });
    if (!r.ok || !data) throw fail(502, data?.error?.message || `Claude API error ${r.status}`);
  } catch (e) {
    if (e.status) throw e;
    throw e.name === 'AbortError' ? fail(504, 'Claude took too long.') : fail(502, 'Could not reach the Claude API.');
  } finally {
    clearTimeout(timer);
  }
  if (data.stop_reason === 'refusal') throw fail(502, 'Claude declined to describe this frame.');
  if (data.stop_reason === 'max_tokens') throw fail(502, 'Claude\'s answer was cut off.');
  const block = (data.content || []).find((c) => c.type === 'tool_use' && c.name === tool);
  if (!block) throw fail(502, 'Claude did not return an answer.');
  return { json: block.input, usage: data.usage, model: data.model, ms: Date.now() - t0 };
}

async function planAction(res, key, ip, body) {
  const isPlan = body.action === 'plan';
  if (!process.env.CLAUDE_WORLD) return send(res, 404, { error: 'Claude World is not enabled on this site.' });
  if (rateLimited(ip, body.action, isPlan ? PLAN_LIMIT : REFINE_LIMIT)) {
    return send(res, 429, { error: isPlan ? 'Too many photos in the last hour. Try again later.' : 'Too many corrections in the last hour. Try again later.' });
  }
  const image = cleanB64(body.image);
  if (!image || image.length > MAX_FRAME_B64) return send(res, 400, { error: 'Send the frame as a base64 JPEG under about 1.9 MB in "image".' });
  const frame = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image }, cache_control: { type: 'ephemeral' } };
  let content, tool, schema, maxTokens;
  if (isPlan) {
    const subjects = Array.isArray(body.subjects) ? body.subjects.slice(0, 12) : [];
    content = [frame, { type: 'text', text: planPrompt(Number(body.width) || 0, Number(body.height) || 0, subjects) }];
    tool = 'submit_plan'; schema = PLAN_SCHEMA; maxTokens = 48000;
  } else {
    const renders = Array.isArray(body.renders) ? body.renders.map(cleanB64) : [];
    if (renders.length !== 4 || renders.some((r) => !r || r.length > MAX_RENDER_B64)) return send(res, 400, { error: 'Send exactly 4 renders as base64 JPEGs in "renders".' });
    const planJson = body.plan && typeof body.plan === 'object' && !Array.isArray(body.plan) ? JSON.stringify(body.plan) : '';
    if (!planJson || planJson.length > MAX_PLAN_CHARS) return send(res, 400, { error: 'Send the current plan as an object in "plan".' });
    const round = Math.max(1, Math.min(10, Math.round(Number(body.round) || 1)));
    content = [
      frame,
      ...renders.flatMap((data, i) => [{ type: 'text', text: `Image ${i + 2}:` }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }]),
      { type: 'text', text: refinePrompt(round, planJson) },
    ];
    tool = 'submit_patch'; schema = PATCH_SCHEMA; maxTokens = 24000;
  }
  let out;
  try { out = await callClaude(key, { content, tool, schema, maxTokens }); }
  catch (e) { return send(res, e.status || 502, { error: e.message }); }
  return send(res, 200, { [isPlan ? 'plan' : 'patch']: out.json, usage: out.usage, model: out.model, ms: out.ms });
}

async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return send(res, 200, { enabled: Boolean(key), model: MODEL, plan: Boolean(key && process.env.CLAUDE_WORLD), planModel: PLAN_MODEL() });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' });
  if (!key) return send(res, 503, { error: 'Smart scene is not set up on this site.' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (body && (body.action === 'plan' || body.action === 'refine')) return planAction(res, key, ip, body);
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many photos in the last hour. Try again later.' });

  const image = body && typeof body.image === 'string' ? body.image.replace(/^data:image\/\w+;base64,/, '') : '';
  if (!image || image.length > MAX_IMAGE_BYTES) return send(res, 400, { error: 'Send a JPEG under 500 KB as base64 in "image".' });
  const subjects = Array.isArray(body.subjects) ? body.subjects.slice(0, 12) : [];
  const W = Number(body.width) || 0, H = Number(body.height) || 0;

  const list = subjects.length
    ? subjects.map((s) => `id ${s.id}: ${String(s.label).slice(0, 20)}, box x0=${(+s.box[0]).toFixed(3)} y0=${(+s.box[1]).toFixed(3)} x1=${(+s.box[2]).toFixed(3)} y1=${(+s.box[3]).toFixed(3)}`).join('\n')
    : 'none';
  const prompt = `Original photo size: ${W}x${H} pixels. Coordinates are normalized 0 to 1 (x right, y down).
Detected subjects:
${list}
Fill in every field of the schema for this photo.`;

  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        system: SYSTEM,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: prompt },
        ] }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      }),
    });
  } catch {
    return send(res, 502, { error: 'Could not reach the Claude API.' });
  }
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) return send(res, 502, { error: data?.error?.message || `Claude API error ${r.status}` });
  if (data.stop_reason === 'refusal' || data.stop_reason === 'max_tokens') return send(res, 502, { error: 'Claude could not describe this photo.' });
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  let scene;
  try { scene = JSON.parse(text); } catch { return send(res, 502, { error: 'Claude returned an unreadable answer.' }); }
  return send(res, 200, { scene, model: data.model, usage: data.usage });
}

module.exports = handler;
module.exports.SCHEMA = SCHEMA;
module.exports.PLAN_SCHEMA = PLAN_SCHEMA;
module.exports.PATCH_SCHEMA = PATCH_SCHEMA;
