import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.CLAUDE_WORLD = '1';
const handler = require('../api/scene.js');
const { PLAN_SCHEMA, PATCH_SCHEMA, SCHEMA } = handler;

let ipN = 0;
const req = (body, method = 'POST') => ({ method, headers: { 'x-forwarded-for': `10.0.0.${++ipN}` }, socket: {}, body });
function res() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
}
const json = (r) => JSON.parse(r.body);
const jpeg = (n = 1000) => 'A'.repeat(n);

let calls = [];
let reply = null;
beforeEach(() => {
  calls = [];
  delete process.env.PLAN_TIMEOUT_MS;
  reply = { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"hello":1}' }] };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => reply };
  };
});

test('GET reports the plan feature', async () => {
  const r = res();
  await handler(req(undefined, 'GET'), r);
  assert.equal(json(r).plan, true);
  assert.equal(json(r).planModel, 'claude-opus-5-5');
});

test('plan sends the frame to Opus with the plan schema', async () => {
  const r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 1688, height: 1070, subjects: [{ id: 0, label: 'car', box: [0.4, 0.4, 0.6, 0.7] }] }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(json(r).plan, { hello: 1 });
  const { body, init } = calls[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.output_config.effort, 'high');
  assert.deepEqual(body.output_config.format.schema, PLAN_SCHEMA);
  assert.equal(body.fallbacks, 'default');
  assert.match(init.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  const first = body.messages[0].content[0];
  assert.equal(first.type, 'image');
  assert.deepEqual(first.cache_control, { type: 'ephemeral' });
  assert.match(body.messages[0].content.at(-1).text, /id 0: car/);
});

test('refine sends the frame, four renders and the plan, and returns a patch', async () => {
  const r = res();
  await handler(req({ action: 'refine', image: jpeg(), renders: [jpeg(), jpeg(), jpeg(), jpeg()], plan: { surfaces: [] }, round: 2 }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(json(r).patch, { hello: 1 });
  const content = calls[0].body.messages[0].content;
  assert.equal(content.filter((c) => c.type === 'image').length, 5);
  assert.deepEqual(calls[0].body.output_config.format.schema, PATCH_SCHEMA);
  assert.match(content.at(-1).text, /Round 2/);
});

test('refine needs exactly four renders and a plan', async () => {
  let r = res();
  await handler(req({ action: 'refine', image: jpeg(), renders: [jpeg(), jpeg(), jpeg()], plan: {} }), r);
  assert.equal(r.statusCode, 400);
  r = res();
  await handler(req({ action: 'refine', image: jpeg(), renders: [jpeg(), jpeg(), jpeg(), jpeg()] }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('refuses an oversized frame', async () => {
  const r = res();
  await handler(req({ action: 'plan', image: jpeg(2_700_000), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('a refusal or a cut-off answer is a 502', async () => {
  reply = { ...reply, stop_reason: 'refusal' };
  let r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 502);
  reply = { ...reply, stop_reason: 'max_tokens' };
  r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 502);
});

test('times out cleanly', async () => {
  process.env.PLAN_TIMEOUT_MS = '30';
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 504);
  assert.match(json(r).error, /too long/);
});

test('times out while reading the answer', async () => {
  process.env.PLAN_TIMEOUT_MS = '30';
  globalThis.fetch = async (url, init) => ({
    ok: true, status: 200,
    json: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  const r = res();
  await handler(req({ action: 'plan', image: jpeg(), width: 10, height: 10 }), r);
  assert.equal(r.statusCode, 504);
});

test('plan and refine are off without CLAUDE_WORLD', async () => {
  delete process.env.CLAUDE_WORLD;
  try {
    const r = res();
    await handler(req({ action: 'plan', image: jpeg(), width: 10, height: 10 }), r);
    assert.equal(r.statusCode, 404);
    assert.equal(calls.length, 0);
    const g = res();
    await handler(req(undefined, 'GET'), g);
    assert.equal(json(g).plan, false);
  } finally { process.env.CLAUDE_WORLD = '1'; }
});

test('limits plans per visitor', async () => {
  const ip = '10.9.9.9';
  let last;
  for (let i = 0; i < 7; i++) {
    last = res();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': ip }, socket: {}, body: { action: 'plan', image: jpeg(), width: 10, height: 10 } }, last);
  }
  assert.equal(last.statusCode, 429);
});

test('the old request is unchanged', async () => {
  const r = res();
  await handler(req({ image: jpeg(), width: 10, height: 10, subjects: [] }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
  assert.deepEqual(calls[0].body.output_config.format.schema, SCHEMA);
  assert.equal(calls[0].body.thinking, undefined);
});

test('schemas only use what structured outputs support', () => {
  const banned = ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'multipleOf'];
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    for (const k of banned) assert.ok(!(k in node), `${where} uses ${k}`);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${where} needs additionalProperties: false`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${where} must require every property`);
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${where}.${k}`);
    }
    if (node.items) walk(node.items, `${where}[]`);
    if (node.anyOf) node.anyOf.forEach((v, i) => walk(v, `${where}|${i}`));
  };
  walk(PLAN_SCHEMA, 'plan');
  walk(PATCH_SCHEMA, 'patch');
});
