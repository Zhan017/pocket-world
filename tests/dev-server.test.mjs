import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withServer(fn) {
  const port = 4100 + Math.floor(Math.random() * 800);
  const home = mkdtempSync(path.join(tmpdir(), 'pw-home-'));
  const child = spawn(process.execPath, [path.join(root, 'tools/dev-server.mjs'), String(port)], {
    env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: '', WLT_API_KEY: '', FAL_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('dev server')) resolve(); });
    child.on('exit', () => reject(new Error('server exited')));
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });
  try { await fn(`http://localhost:${port}`); } finally { child.kill(); }
}

test('serves the site with isolation headers', () => withServer(async (base) => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-embedder-policy'), 'credentialless');
  assert.match(await r.text(), /Pocket World/);
}));

test('runs api handlers', () => withServer(async (base) => {
  const r = await fetch(`${base}/api/scene`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).enabled, false);
}));

test('never serves files outside the project', () => withServer(async (base) => {
  const r = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
  assert.ok(r.status === 403 || r.status === 404, `status ${r.status}`);
}));

test('rejects bodies over 4.5 MB like Vercel', () => withServer(async (base) => {
  const r = await fetch(`${base}/api/scene`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(4.6e6) });
  assert.equal(r.status, 413);
}));

test('survives a NUL byte in the path', () => withServer(async (base) => {
  const r = await fetch(`${base}/%00`);
  assert.equal(r.status, 400);
  const ok = await fetch(`${base}/`);
  assert.equal(ok.status, 200);
}));
