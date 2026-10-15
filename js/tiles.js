// Material tiles cut from the photo, for the parts of the world the photo
// never saw. A ground material (asphalt, grass...) is rectified: we sample a
// square of real ground around the material's sample patch as if seen from
// straight above, so it repeats at its true size. Other materials (hedge
// sides, facades) use the patch as it appears.
//
// Plain JS with no three.js, so it runs in tests too.

import { project, pixelToGround, groundPoint } from './camera.js';

// Bilinear sample of an RGBA image at pixel (x, y); null outside it.
function sample(img, x, y) {
  const { data, width: W, height: H } = img;
  if (!(x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1)) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * W + x0) * 4 + c], b = data[(y0 * W + x1) * 4 + c];
    const d = data[(y1 * W + x0) * 4 + c], e = data[(y1 * W + x1) * 4 + c];
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
  return out;
}

/**
 * @param {{data: Uint8ClampedArray, width: number, height: number}} img  the photo (RGBA)
 * @param {object} cam  photoCamera() for this image size
 * @param {number[]} box  [x0, y0, x1, y1] normalized
 * @returns {{data: Uint8ClampedArray, width: number, height: number, metres: number} | null}
 */
export function groundTile(img, cam, box, { size = 256, top = 0 } = {}) {
  const [x0, y0, x1, y1] = box;
  const W = img.width, H = img.height;
  const bl = pixelToGround(cam, x0 * W, y1 * H, top), br = pixelToGround(cam, x1 * W, y1 * H, top);
  const c = pixelToGround(cam, ((x0 + x1) / 2) * W, ((y0 + y1) / 2) * H, top);
  if (!bl || !br || !c) return null;
  const metres = Math.min(6, Math.max(0.5, Math.hypot(br[0] - bl[0], br[1] - bl[1])));
  const out = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const r = c[0] + ((i + 0.5) / size - 0.5) * metres;
      const f = c[1] + ((j + 0.5) / size - 0.5) * metres;   // row 0 = nearest edge
      const p = project(cam, groundPoint(cam, r, f, top));
      const px = p && sample(img, p.u - 0.5, p.v - 0.5);
      if (!px) return null;   // the square leaves the photo
      const k = (j * size + i) * 4;
      out[k] = px[0]; out[k + 1] = px[1]; out[k + 2] = px[2]; out[k + 3] = 255;
    }
  }
  return { data: out, width: size, height: size, metres };
}

/** The box as it appears in the photo, resampled to size x size. */
export function patchTile(img, box, size = 256) {
  const [x0, y0, x1, y1] = box;
  const out = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (x0 + ((i + 0.5) / size) * (x1 - x0)) * img.width - 0.5;
      const y = (y0 + ((j + 0.5) / size) * (y1 - y0)) * img.height - 0.5;
      const px = sample(img, Math.min(img.width - 1, Math.max(0, x)), Math.min(img.height - 1, Math.max(0, y)));
      const k = (j * size + i) * 4;
      out[k] = px[0]; out[k + 1] = px[1]; out[k + 2] = px[2]; out[k + 3] = 255;
    }
  }
  return { data: out, width: size, height: size };
}
