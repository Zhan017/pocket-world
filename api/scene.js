// Vercel serverless function: asks Claude to read the photo.
//
// GET  /api/scene  -> { enabled }  (is a key configured?)
// POST /api/scene  { image: <base64 JPEG>, width, height, subjects: [{ id, label, box: [x0,y0,x1,y1] (0..1) }] }
//                  -> { scene }  (see SCHEMA below)
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
  required: ['caption', 'scene_type', 'camera', 'ground_polygon', 'subjects', 'sky', 'ground_color', 'layout'],
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

const SYSTEM = `You read a single photo so a web app can turn it into a small 3D world the viewer can walk around in.
The app already has relative depth for every pixel and cut-outs of detected people. You supply what it cannot measure:
the camera height, tilt and field of view; where the flat ground is; which detected people, animals and vehicles are real; and a simple
layout of what most likely surrounds the camera beyond the edges of the frame, including behind it.
Use metres and degrees. Base the layout on what is visible and on how such places are normally built.
Always give your best estimate, even when unsure.`;

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return send(res, 200, { enabled: Boolean(key), model: MODEL });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' });
  if (!key) return send(res, 503, { error: 'Smart scene is not set up on this site.' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many photos in the last hour. Try again later.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
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
        max_tokens: 2000,
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
