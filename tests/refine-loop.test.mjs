import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../js/plan.js';
import { refineLoop } from '../js/refine-loop.js';

const plan = validatePlan({
  camera: { height_m: 4, pitch_deg: 10, hfov_deg: 45 },
  surfaces: [{ id: 's1', kind: 'road', material: null, polygon: [[-5, 0], [5, 0], [5, 50], [-5, 50]], top_m: 0 }],
  extent_m: 60,
});
const patch = (extra = {}) => ({ notes: 'ok', done: false, camera: plan.camera, materials: [], surfaces: [], markings: [], objects: [], vehicles: [], remove: [], ...extra });
const harness = (answers) => {
  const applied = [], rounds = [];
  let i = 0;
  return {
    applied, rounds,
    opts: {
      plan,
      render: async () => ['a', 'b', 'c', 'd'],
      call: async () => { const a = answers[i++]; if (a instanceof Error) throw a; return { patch: a, usage: { output_tokens: 1 } }; },
      apply: (p) => applied.push(p),
      onRound: (r) => rounds.push(r),
    },
  };
};

test('stops when Claude is done', async () => {
  const h = harness([patch(), patch({ done: true, notes: 'aligned' })]);
  const out = await refineLoop(h.opts);
  assert.equal(out.stopped, 'done');
  assert.equal(out.rounds, 2);
  assert.equal(h.applied.length, 2);
  assert.equal(h.rounds[1].notes, 'aligned');
});

test('stops after the round limit', async () => {
  const h = harness([patch(), patch(), patch()]);
  const out = await refineLoop({ ...h.opts, rounds: 3 });
  assert.equal(out.stopped, 'rounds');
  assert.equal(h.applied.length, 3);
});

test('stops on a failed call and keeps the plan', async () => {
  const h = harness([new Error('Claude took too long.')]);
  const out = await refineLoop(h.opts);
  assert.equal(out.stopped, 'error');
  assert.equal(out.plan, plan);
  assert.equal(h.applied.length, 0);
  assert.match(out.error.message, /too long/);
});

test('stops on a rejected patch', async () => {
  const h = harness([patch({ remove: ['s1'] })]);
  const out = await refineLoop(h.opts);
  assert.equal(out.stopped, 'rejected');
  assert.equal(out.plan, plan);
  assert.equal(h.applied.length, 0);
  assert.equal(h.rounds[0].accepted, false);
});

test('stops when cancelled', async () => {
  const h = harness([patch(), patch()]);
  let calls = 0;
  const out = await refineLoop({ ...h.opts, cancelled: () => ++calls > 1 });
  assert.equal(out.stopped, 'cancelled');
  assert.equal(h.applied.length, 0);
});

test('stops when the rebuild throws and keeps the last good plan', async () => {
  const h = harness([patch()]);
  const out = await refineLoop({ ...h.opts, apply: () => { throw new Error('webgl lost'); } });
  assert.equal(out.stopped, 'error');
  assert.equal(out.plan, plan);
  assert.match(out.error.message, /webgl lost/);
});

test('a rejected patch is never reported as done', async () => {
  const h = harness([patch({ remove: ['s1'], done: true })]);
  const out = await refineLoop(h.opts);
  assert.equal(out.stopped, 'rejected');
  assert.equal(h.rounds[0].done, false);
});
