// Small image-processing helpers used to fill in what the photo can't see:
// the space behind people, and the far side of depth edges.

/**
 * Pull-push hole filling. Unknown pixels (weight 0) get a smooth blend of
 * the nearest known pixels at every scale.
 * @param {Float32Array} data  w*h*c values
 * @param {Float32Array} weight w*h weights in [0,1] (1 = known)
 */
export function pullPush(data, w, h, c, weight) {
  const levels = [{ w, h, v: data, wt: weight }];
  // Pull: build a pyramid of weighted averages.
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const p = levels[levels.length - 1];
    const w2 = Math.max(1, Math.ceil(p.w / 2)), h2 = Math.max(1, Math.ceil(p.h / 2));
    const v2 = new Float32Array(w2 * h2 * c), wt2 = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        let W = 0;
        const acc = [0, 0, 0, 0];
        for (let dy = 0; dy < 2; dy++) {
          const yy = y * 2 + dy; if (yy >= p.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = x * 2 + dx; if (xx >= p.w) continue;
            const i = yy * p.w + xx, ww = p.wt[i];
            if (ww <= 0) continue;
            W += ww;
            for (let k = 0; k < c; k++) acc[k] += p.v[i * c + k] * ww;
          }
        }
        const o = y * w2 + x;
        if (W > 0) for (let k = 0; k < c; k++) v2[o * c + k] = acc[k] / W;
        wt2[o] = Math.min(1, W);
      }
    }
    levels.push({ w: w2, h: h2, v: v2, wt: wt2 });
    if (w2 === 1 && h2 === 1) break;
  }
  // Push: fill each level's gaps from the (bilinearly upsampled) coarser level.
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l], g = levels[l + 1];
    const out = new Float32Array(f.w * f.h * c);
    for (let y = 0; y < f.h; y++) {
      const gy = Math.min(g.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(gy), y1 = Math.min(g.h - 1, y0 + 1), ty = gy - y0;
      for (let x = 0; x < f.w; x++) {
        const gx = Math.min(g.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(gx), x1 = Math.min(g.w - 1, x0 + 1), tx = gx - x0;
        const i = y * f.w + x, ww = Math.min(1, f.wt[i]);
        for (let k = 0; k < c; k++) {
          const a = g.v[(y0 * g.w + x0) * c + k], b = g.v[(y0 * g.w + x1) * c + k];
          const cc = g.v[(y1 * g.w + x0) * c + k], d = g.v[(y1 * g.w + x1) * c + k];
          const up = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
          out[i * c + k] = ww >= 1 ? f.v[i * c + k] : f.v[i * c + k] * ww + up * (1 - ww);
        }
      }
    }
    f.v = out;
    f.wt = new Float32Array(f.w * f.h).fill(1);
  }
  return levels[0].v;
}

/**
 * Fill the holes left by cut-out people so they keep some texture instead of
 * a flat smudge. Smooth color comes from pull-push; fine detail is cloned from
 * the area just beside each person (one consistent offset per person, so the
 * copied texture stays coherent).
 * @param {Array<{box:number[]}>} subjects  boxes in pixel coordinates
 */
export function fillCloned(rgb, w, h, weight, subjects) {
  const low = pullPush(rgb, w, h, 3, weight);
  const soft = boxBlur(low, w, h, 3, 3);
  const out = low.slice();
  const done = new Uint8Array(w * h);
  const known = (x, y) => x >= 0 && x < w && y >= 0 && y < h && weight[y * w + x] >= 0.5;
  for (const s of subjects) {
    const [bx0, by0, bx1, by1] = s.box;
    const bw = bx1 - bx0;
    const pad = Math.ceil(bw * 0.12) + 6;
    const x0 = Math.max(0, Math.floor(bx0 - pad)), x1 = Math.min(w, Math.ceil(bx1 + pad));
    const y0 = Math.max(0, Math.floor(by0 - pad)), y1 = Math.min(h, Math.ceil(by1 + pad));
    const shift = Math.round(bw * 1.15 + 8);
    // Use whichever side of the person has more visible background.
    let left = 0, right = 0;
    for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) {
      if (known(x - shift, y)) left++;
      if (known(x + shift, y)) right++;
    }
    const order = left >= right ? [-shift, shift] : [shift, -shift];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const k = y * w + x;
      if (weight[k] >= 0.5 || done[k]) continue;
      done[k] = 1;
      const dx = known(x + order[0], y) ? order[0] : known(x + order[1], y) ? order[1] : 0;
      if (!dx) continue;
      const i = k * 3, j = (k + dx) * 3;
      for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.max(0, low[i + c] + (rgb[j + c] - soft[j + c]) * 0.85));
    }
  }
  return out;
}

/** Separable sliding min or max filter over a single-channel image. */
export function rankFilter(src, w, h, r, mode = 'max') {
  const pick = mode === 'max' ? Math.max : Math.min;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = src[y * w + x];
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let xx = a; xx <= b; xx++) m = pick(m, src[y * w + xx]);
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = tmp[y * w + x];
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let yy = a; yy <= b; yy++) m = pick(m, tmp[yy * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Separable box blur (radius r) over a c-channel image. */
export function boxBlur(src, w, h, c, r) {
  if (r <= 0) return src.slice();
  const tmp = new Float32Array(w * h * c), out = new Float32Array(w * h * c);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let k = 0; k < c; k++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[(y * w + Math.min(w - 1, Math.max(0, i))) * c + k];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * c + k] = s / n;
        const add = Math.min(w - 1, x + r + 1), rem = Math.max(0, x - r);
        s += src[(y * w + add) * c + k] - src[(y * w + rem) * c + k];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let k = 0; k < c; k++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[(Math.min(h - 1, Math.max(0, i)) * w + x) * c + k];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * c + k] = s / n;
        const add = Math.min(h - 1, y + r + 1), rem = Math.max(0, y - r);
        s += tmp[(add * w + x) * c + k] - tmp[(rem * w + x) * c + k];
      }
    }
  }
  return out;
}

/** Bilinear resample of a single-channel float image. */
export function resample(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Value at percentile p (0..1) of a typed array, using a strided sample. */
export function percentile(arr, p) {
  const step = Math.max(1, Math.floor(arr.length / 20000));
  const s = [];
  for (let i = 0; i < arr.length; i += step) s.push(arr[i]);
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}
