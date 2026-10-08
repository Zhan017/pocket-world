// Vercel serverless function: turns objects in the photo (cars, bikes...) into
// full 3D models with Meta's SAM 3D Objects, hosted on fal.ai.
//
// GET  /api/objects                        -> { enabled }
// POST /api/objects { action: 'submit', image: <base64 JPEG>, masks: [<base64 PNG>] }
//                                          -> { status_url, response_url }
// POST /api/objects { action: 'poll', status_url, response_url }
//                                          -> { status } or { status: 'COMPLETED', result }
//
// Set FAL_KEY in the Vercel project settings. Generation runs in fal's queue,
// so the browser polls instead of waiting on one long request.

const ENDPOINT = 'fal-ai/sam-3/3d-objects';
const QUEUE = 'https://queue.fal.run/';
const MAX_IMAGE = 900 * 1024;     // base64 characters
const MAX_MASKS = 4;
const RATE_LIMIT = 20;            // submits per IP per hour, per server instance
const hits = new Map();

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT;
}

async function falFetch(url, key, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

async function handler(req, res) {
  const key = process.env.FAL_KEY;
  if (req.method === 'GET') return send(res, 200, { enabled: Boolean(key) });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' });
  if (!key) return send(res, 503, { error: '3D objects are not set up on this site.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) return send(res, 400, { error: 'Send JSON.' });

  if (body.action === 'submit') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (rateLimited(ip)) return send(res, 429, { error: 'Too many 3D requests in the last hour. Try again later.' });
    const image = typeof body.image === 'string' ? body.image.replace(/^data:image\/\w+;base64,/, '') : '';
    const masks = Array.isArray(body.masks) ? body.masks.slice(0, MAX_MASKS).filter((m) => typeof m === 'string') : [];
    if (!image || image.length > MAX_IMAGE) return send(res, 400, { error: 'Send a JPEG under about 650 KB as base64 in "image".' });
    if (!masks.length) return send(res, 400, { error: 'Send at least one PNG mask in "masks".' });
    const input = {
      image_url: `data:image/jpeg;base64,${image}`,
      mask_urls: masks.map((m) => `data:image/png;base64,${m.replace(/^data:image\/\w+;base64,/, '')}`),
      seed: 7,
    };
    let r;
    try { r = await falFetch(QUEUE + ENDPOINT, key, { method: 'POST', body: JSON.stringify(input) }); }
    catch { return send(res, 502, { error: 'Could not reach fal.ai.' }); }
    if (!r.ok || !r.data?.status_url) return send(res, 502, { error: r.data?.detail || r.data?.error || `fal.ai error ${r.status}` });
    return send(res, 200, { status_url: r.data.status_url, response_url: r.data.response_url });
  }

  if (body.action === 'poll') {
    const { status_url: statusUrl, response_url: responseUrl } = body;
    // Only ever forward our key to fal's own queue.
    if (typeof statusUrl !== 'string' || typeof responseUrl !== 'string' || !statusUrl.startsWith(QUEUE) || !responseUrl.startsWith(QUEUE)) {
      return send(res, 400, { error: 'Bad request URLs.' });
    }
    let r;
    try { r = await falFetch(statusUrl, key); }
    catch { return send(res, 502, { error: 'Could not reach fal.ai.' }); }
    if (!r.ok) return send(res, 502, { error: `fal.ai status error ${r.status}` });
    const status = r.data?.status;
    if (status !== 'COMPLETED') return send(res, 200, { status: status || 'UNKNOWN', queue_position: r.data?.queue_position });
    try { r = await falFetch(responseUrl, key); }
    catch { return send(res, 502, { error: 'Could not reach fal.ai.' }); }
    if (!r.ok) return send(res, 502, { error: r.data?.detail?.[0]?.msg || r.data?.detail || `fal.ai result error ${r.status}` });
    const d = r.data || {};
    return send(res, 200, {
      status: 'COMPLETED',
      result: {
        model_glb: d.model_glb?.url || null,
        individual_glbs: Array.isArray(d.individual_glbs) ? d.individual_glbs.map((g) => g?.url || null) : null,
        metadata: d.metadata || [],
      },
    });
  }

  return send(res, 400, { error: 'Unknown action.' });
}

module.exports = handler;
