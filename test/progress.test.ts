import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOAD_STEPS, downloadFrac, stepProgress } from '../src/overpass.ts';

test('loading stages fill the bar in order without gaps', () => {
  const steps = Object.values(LOAD_STEPS);
  assert.equal(steps[0].from, 0);
  assert.equal(steps[steps.length - 1].to, 1);
  for (let i = 1; i < steps.length; i++) assert.equal(steps[i].from, steps[i - 1].to);
});

test('download progress rises with bytes and stays inside its stage', () => {
  let last = -1;
  for (const n of [0, 1e5, 5e5, 1e6, 3e6, 2e7]) {
    let f = -1;
    stepProgress((x) => (f = x), 'download', downloadFrac(n));
    assert.ok(f >= last, `progress went backwards at ${n}`);
    assert.ok(f >= LOAD_STEPS.download.from && f < LOAD_STEPS.download.to + 1e-9);
    last = f;
  }
});
