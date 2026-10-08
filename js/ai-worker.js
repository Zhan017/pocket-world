// Runs the three AI models off the main thread so the page stays responsive.
//   1. Depth Anything V2 (small)  -> how far away every pixel is
//   2. D-FINE (small)             -> where the people (and pets) are
//   3. EdgeTAM                    -> a clean cutout of each one
// Everything runs on the visitor's device. The photo is never uploaded.

import { pipeline, env, RawImage, AutoModel, AutoProcessor, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';

env.allowLocalModels = false;

const MODELS = {
  depth: 'onnx-community/depth-anything-v2-small',
  detect: 'onnx-community/dfine_s_obj2coco-ONNX',
  segment: 'onnx-community/EdgeTAM-ONNX',
};
const SUBJECT_LABELS = new Set(['person', 'dog', 'cat', 'car', 'truck', 'bus', 'motorcycle', 'bicycle']);
const VEHICLES = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle']);
const MAX_SUBJECTS = 10;

let depthPipe = null, detPipe = null, samModel = null, samProc = null, loading = null;
let expected = 69e6;   // bytes to download on first use; updated once we know the device
const files = new Map();

function onProgress(p) {
  if (!p.file) return;
  if (p.status === 'progress' || p.status === 'done') {
    const prev = files.get(p.file) || { loaded: 0, total: 0 };
    const total = p.total || prev.total;
    const loaded = p.status === 'done' ? (total || prev.loaded) : (p.loaded || 0);
    files.set(p.file, { loaded, total });
    let L = 0, T = 0;
    for (const f of files.values()) { L += f.loaded; T += f.total; }
    postMessage({ type: 'download', loaded: L, total: T, expected });
  }
}

async function gpuWithF16() {
  try {
    if (!('gpu' in navigator)) return false;
    const a = await navigator.gpu.requestAdapter();
    return !!a && a.features.has('shader-f16');
  } catch { return false; }
}

async function loadModels() {
  const opts = (extra) => ({ progress_callback: onProgress, ...extra });
  // Depth is the heaviest model, so it gets the GPU when a good one is available.
  if (await gpuWithF16()) {
    expected = 91e6;
    try {
      depthPipe = await pipeline('depth-estimation', MODELS.depth, opts({ device: 'webgpu', dtype: 'fp16' }));
    } catch (e) { depthPipe = null; expected = 69e6; }
  }
  if (!depthPipe) depthPipe = await pipeline('depth-estimation', MODELS.depth, opts({ device: 'wasm', dtype: 'q8' }));
  detPipe = await pipeline('object-detection', MODELS.detect, opts({ device: 'wasm', dtype: 'fp16' }));
  samModel = await AutoModel.from_pretrained(MODELS.segment, opts({ device: 'wasm', dtype: 'fp16' }));
  samProc = await AutoProcessor.from_pretrained(MODELS.segment, opts({}));
}

function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]), y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

async function scan({ rgba, width, height }) {
  const img = new RawImage(new Uint8ClampedArray(rgba), width, height, 4).rgb();

  // 1. Depth, at roughly the model's native 518 px.
  postMessage({ type: 'step', step: 'depth' });
  const s = 518 / Math.max(width, height);
  const dImg = s < 1 ? await img.resize(Math.round(width * s), Math.round(height * s)) : img;
  let d = await depthPipe(dImg);
  let pd = d.predicted_depth;
  const dh = pd.dims[pd.dims.length - 2], dw = pd.dims[pd.dims.length - 1];
  let ddata = Float32Array.from(pd.data);
  // Guard against a bad GPU result (all NaN or flat): fall back to CPU once.
  let lo = Infinity, hi = -Infinity;
  for (const v of ddata) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) {
    depthPipe = await pipeline('depth-estimation', MODELS.depth, { device: 'wasm', dtype: 'q8', progress_callback: onProgress });
    d = await depthPipe(dImg); pd = d.predicted_depth; ddata = Float32Array.from(pd.data);
  }
  const depthAt = (x, y) => {
    const xi = Math.min(dw - 1, Math.max(0, Math.round((x / width) * dw - 0.5)));
    const yi = Math.min(dh - 1, Math.max(0, Math.round((y / height) * dh - 0.5)));
    return ddata[yi * dw + xi];
  };

  // 2. Find people and pets.
  postMessage({ type: 'step', step: 'detect' });
  const dets = await detPipe(img, { threshold: 0.45, percentage: false });
  let cands = dets
    .filter(t => SUBJECT_LABELS.has(t.label) && t.score >= 0.5)
    .map(t => ({ label: t.label, score: t.score, box: [t.box.xmin, t.box.ymin, t.box.xmax, t.box.ymax] }))
    .filter(t => (t.box[3] - t.box[1]) >= height * 0.035 && (t.box[2] - t.box[0]) >= 4)
    .sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of cands) if (!kept.some(k => iou(k.box, c.box) > 0.6)) kept.push(c);
  // A "person" sitting inside a vehicle (a driver) belongs to the vehicle.
  const vehicles = kept.filter((k) => VEHICLES.has(k.label));
  const inside = (p, v) => {
    const ix = Math.max(0, Math.min(p.box[2], v.box[2]) - Math.max(p.box[0], v.box[0]));
    const iy = Math.max(0, Math.min(p.box[3], v.box[3]) - Math.max(p.box[1], v.box[1]));
    const area = (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]);
    return area > 0 && (ix * iy) / area > 0.8 && p.box[3] < v.box[3] - 0.15 * (v.box[3] - v.box[1]);
  };
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].label === 'person' && vehicles.some((v) => inside(kept[i], v))) kept.splice(i, 1);
  }
  cands = kept
    .sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))
    .slice(0, MAX_SUBJECTS);

  // 3. Cut each one out.
  postMessage({ type: 'step', step: 'segment', count: cands.length });
  const subjects = [];
  let emb = null, inputs = null;
  for (const c of cands) {
    if (!emb) {
      // Encode the image once; every box reuses the same embeddings.
      inputs = await samProc(img, { input_boxes: [[c.box]] });
      emb = await samModel.get_image_embeddings(inputs);
    }
    const [rh0, rw0] = inputs.reshaped_input_sizes[0];
    const sx = rw0 / width, sy = rh0 / height;
    const boxT = new Tensor('float32', Float32Array.from([c.box[0] * sx, c.box[1] * sy, c.box[2] * sx, c.box[3] * sy]), [1, 1, 4]);
    const out = await samModel({ ...emb, input_boxes: boxT });
    // Pick the best of the 3 candidate masks, then sample its low-res logits
    // straight into the crop (cheaper than upscaling all 3 to full size).
    const pm = out.pred_masks, sc = out.iou_scores.data;
    const nm = pm.dims[pm.dims.length - 3], mh = pm.dims[pm.dims.length - 2], mw = pm.dims[pm.dims.length - 1];
    let best = 0;
    for (let j = 1; j < nm; j++) if (sc[j] > sc[best]) best = j;
    if (sc[best] < 0.5) continue;
    const ip = samProc.image_processor ?? samProc;
    const pad = ip.pad_size ?? ip.size ?? { height: 1024, width: 1024 };
    const [rh, rw] = inputs.reshaped_input_sizes[0];
    const logits = pm.data, off = best * mh * mw;
    const sampleLogit = (x, y) => {
      const xr = ((x + 0.5) * rw) / width, yr = ((y + 0.5) * rh) / height;
      const u = Math.min(mw - 1, Math.max(0, (xr * mw) / pad.width - 0.5));
      const v = Math.min(mh - 1, Math.max(0, (yr * mh) / pad.height - 0.5));
      const u0 = Math.floor(u), v0 = Math.floor(v), u1 = Math.min(mw - 1, u0 + 1), v1 = Math.min(mh - 1, v0 + 1);
      const tu = u - u0, tv = v - v0;
      const q00 = logits[off + v0 * mw + u0], q01 = logits[off + v0 * mw + u1];
      const q10 = logits[off + v1 * mw + u0], q11 = logits[off + v1 * mw + u1];
      return (q00 * (1 - tu) + q01 * tu) * (1 - tv) + (q10 * (1 - tu) + q11 * tu) * tv;
    };
    const [bx0, by0, bx1, by1] = c.box;
    const bw = bx1 - bx0, bh = by1 - by0;
    const x0 = Math.max(0, Math.floor(bx0 - bw * 0.06)), y0 = Math.max(0, Math.floor(by0 - bh * 0.04));
    const x1 = Math.min(width, Math.ceil(bx1 + bw * 0.06)), y1 = Math.min(height, Math.ceil(by1 + bh * 0.04));
    const cw = x1 - x0, ch = y1 - y0;
    const alpha = new Uint8Array(cw * ch);
    let area = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const a = Math.min(1, Math.max(0, 0.5 + sampleLogit(x + x0, y + y0) * 0.75));
        alpha[y * cw + x] = Math.round(a * 255);
        if (a > 0.5) area++;
      }
    }
    if (area < 40) continue;
    // Typical depth of this subject, for sorting overlaps.
    const ds = [];
    for (let y = 0; y < ch; y += 2) for (let x = 0; x < cw; x += 2) if (alpha[y * cw + x] > 160) ds.push(depthAt(x + x0, y + y0));
    ds.sort((a, b) => a - b);
    subjects.push({ label: c.label, score: +c.score.toFixed(3), box: c.box.map(v => Math.round(v)), crop: [x0, y0, cw, ch], alpha, near: ds[ds.length >> 1] ?? 0 });
  }

  // Where two subjects overlap, the nearer one owns the pixels.
  subjects.sort((a, b) => b.near - a.near);
  for (let i = 1; i < subjects.length; i++) {
    const S = subjects[i];
    for (let j = 0; j < i; j++) {
      const N = subjects[j];
      const ox0 = Math.max(S.crop[0], N.crop[0]), oy0 = Math.max(S.crop[1], N.crop[1]);
      const ox1 = Math.min(S.crop[0] + S.crop[2], N.crop[0] + N.crop[2]), oy1 = Math.min(S.crop[1] + S.crop[3], N.crop[1] + N.crop[3]);
      for (let y = oy0; y < oy1; y++) for (let x = ox0; x < ox1; x++) {
        const na = N.alpha[(y - N.crop[1]) * N.crop[2] + (x - N.crop[0])] / 255;
        const si = (y - S.crop[1]) * S.crop[2] + (x - S.crop[0]);
        S.alpha[si] = Math.round(S.alpha[si] * (1 - na));
      }
    }
  }
  for (const s2 of subjects) delete s2.near;

  return { width, height, depth: { w: dw, h: dh, data: ddata }, subjects };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'scan') return;
  try {
    if (!depthPipe) {
      postMessage({ type: 'step', step: 'models' });
      loading ??= loadModels();
      await loading;
    }
    const result = await scan(msg);
    const transfer = [result.depth.data.buffer, ...result.subjects.map(s => s.alpha.buffer)];
    postMessage({ type: 'result', scan: result }, transfer);
  } catch (err) {
    loading = null; depthPipe = null;
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
