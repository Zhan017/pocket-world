// Local dev server: serves the site like serve.py (same isolation headers) and
// runs the Vercel functions in api/ in-process, so Claude, Marble and fal work
// locally without `vercel dev`.
//
//   node tools/dev-server.mjs [port]
//
// Keys come from the environment, or from files in ~/.config/pocket-world:
//   ANTHROPIC_API_KEY <- anthropic_key, WLT_API_KEY <- wlt_key, FAL_KEY <- fal_key

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const port = Number(process.argv[2]) || 3000;
const MAX_BODY = 4.5e6;   // Vercel's request body limit (4.5 MB)

for (const [env, file] of [['ANTHROPIC_API_KEY', 'anthropic_key'], ['WLT_API_KEY', 'wlt_key'], ['FAL_KEY', 'fal_key']]) {
  if (process.env[env]) continue;
  try { process.env[env] = fs.readFileSync(path.join(os.homedir(), '.config/pocket-world', file), 'utf8').trim(); } catch {}
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.scan': 'application/octet-stream', '.spz': 'application/octet-stream', '.glb': 'model/gltf-binary',
};

async function runApi(name, req, res) {
  const file = path.join(root, 'api', `${name}.js`);
  if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { res.statusCode = 413; return res.end(JSON.stringify({ error: 'FUNCTION_PAYLOAD_TOO_LARGE' })); }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  req.body = raw;
  if ((req.headers['content-type'] || '').includes('application/json')) { try { req.body = JSON.parse(raw); } catch {} }
  delete require.cache[file];   // pick up edits without a restart
  try { await require(file)(req, res); }
  catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: 'dev server: handler crashed' })); }
  }
}

http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cache-Control', 'no-cache');
  const url = new URL(req.url, 'http://localhost');
  const api = /^\/api\/([^/]+)$/.exec(url.pathname);
  if (api) return runApi(api[1], req, res);
  let rel;
  try { rel = path.normalize(decodeURIComponent(url.pathname)); } catch { res.statusCode = 400; return res.end(); }
  if (rel.endsWith(path.sep)) rel += 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(buf);
  });
}).listen(port, () => console.log(`Pocket World dev server on http://localhost:${port}`));
