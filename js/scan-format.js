// A "scan" is everything the AI step learns about a photo:
//   depth    relative inverse depth (bigger = closer), at model resolution
//   subjects people (and pets) with a box and a soft cutout mask
// It can be saved to a small binary file so a sample world loads with no AI at all.

const MAGIC = 'PWS1';

export function encodeScan(scan) {
  const { depth } = scan;
  let min = Infinity, max = -Infinity;
  for (const v of depth.data) { if (v < min) min = v; if (v > max) max = v; }
  const header = {
    width: scan.width, height: scan.height,
    depth: { w: depth.w, h: depth.h, min, max },
    subjects: scan.subjects.map(s => ({ label: s.label, score: s.score, box: s.box, crop: s.crop })),
  };
  const hjson = new TextEncoder().encode(JSON.stringify(header));
  const dBytes = depth.w * depth.h * 2;
  const aBytes = scan.subjects.reduce((n, s) => n + s.alpha.length, 0);
  const pad = (4 - ((8 + hjson.length) % 4)) % 4;
  const buf = new ArrayBuffer(8 + hjson.length + pad + dBytes + aBytes);
  const u8 = new Uint8Array(buf);
  u8.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(buf).setUint32(4, hjson.length, true);
  u8.set(hjson, 8);
  let o = 8 + hjson.length + pad;
  const q = new Uint16Array(buf, o, depth.w * depth.h);
  const span = max - min || 1;
  for (let i = 0; i < q.length; i++) q[i] = Math.round(((depth.data[i] - min) / span) * 65535);
  o += dBytes;
  for (const s of scan.subjects) { u8.set(s.alpha, o); o += s.alpha.length; }
  return buf;
}

export function decodeScan(buf) {
  const u8 = new Uint8Array(buf);
  if (new TextDecoder().decode(u8.subarray(0, 4)) !== MAGIC) throw new Error('Not a Pocket World scan file');
  const hlen = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  const pad = (4 - ((8 + hlen) % 4)) % 4;
  let o = 8 + hlen + pad;
  const { w, h, min, max } = header.depth;
  const q = new Uint16Array(buf, o, w * h);
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = min + (q[i] / 65535) * (max - min);
  o += w * h * 2;
  const subjects = header.subjects.map(s => {
    const n = s.crop[2] * s.crop[3];
    const alpha = u8.slice(o, o + n); o += n;
    return { ...s, alpha };
  });
  return { width: header.width, height: header.height, depth: { w, h, data }, subjects };
}
