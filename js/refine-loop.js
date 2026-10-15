// The refine loop: show Claude the world built from the current plan, apply
// its corrections, rebuild, repeat. No three.js here so it can be tested in
// Node; the page passes in how to render, call the API and rebuild.

import { applyPatch } from './plan.js';

/**
 * @param {object} o
 * @param {object} o.plan  validated starting plan
 * @param {number} [o.rounds=5]
 * @param {(plan: object) => Promise<string[]>} o.render  four base64 JPEGs of the world built from `plan`
 * @param {(req: {round: number, renders: string[], plan: object}) => Promise<{patch: object, usage?: object}>} o.call
 * @param {(plan: object) => void} o.apply  rebuild the world from a corrected plan
 * @param {(info: object) => void} [o.onRound]
 * @param {number} [o.retries=1]  extra tries for a round whose call fails (not for 4xx answers)
 * @param {(info: {round: number, error: Error, ms: number}) => void} [o.onRetry]
 * @param {() => boolean} [o.cancelled]
 */
export async function refineLoop({ plan, rounds = 5, retries = 1, render, call, apply, onRound = () => {}, onRetry = () => {}, cancelled = () => false }) {
  let current = plan;
  for (let round = 1; round <= rounds; round++) {
    if (cancelled()) return { plan: current, rounds: round - 1, stopped: 'cancelled' };
    const t0 = Date.now();
    let res;
    try {
      const renders = await render(current);
      for (let attempt = 0; ; attempt++) {
        try { res = await call({ round, renders, plan: current }); break; } catch (error) {
          // A long answer runs past Claude's output cap now and then; the same request
          // usually works the second time. Refusals (4xx) and cancelled jobs are final.
          if (attempt >= retries || (error.status >= 400 && error.status < 500) || cancelled()) throw error;
          onRetry({ round, error, ms: Date.now() - t0 });
        }
      }
    } catch (error) {
      return { plan: current, rounds: round - 1, stopped: 'error', error };
    }
    if (cancelled()) return { plan: current, rounds: round - 1, stopped: 'cancelled' };
    const next = applyPatch(current, res && res.patch);
    const accepted = next !== current;   // applyPatch hands back the same plan when it refuses a patch
    if (accepted) {
      try { apply(next); } catch (error) { return { plan: current, rounds: round - 1, stopped: 'error', error }; }
      current = next;
    }
    const done = accepted && Boolean(res && res.patch && res.patch.done);
    onRound({ round, notes: String((res && res.patch && res.patch.notes) || ''), done, accepted, ms: Date.now() - t0, usage: (res && res.usage) || null });
    if (!accepted) return { plan: current, rounds: round, stopped: 'rejected' };
    if (done) return { plan: current, rounds: round, stopped: 'done' };
  }
  return { plan: current, rounds, stopped: 'rounds' };
}
