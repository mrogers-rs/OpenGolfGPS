import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planShots, ballInAir, metres, MAX_SHOT_YD } from '../src/flight.ts';
import type { LngLat } from '../src/types.ts';

const tee: LngLat = [-112.25, 33.6];
const dog: LngLat = [-112.25, 33.6022]; // ~245 m north
const green: LngLat = [-112.2485, 33.6035];

test('one shot per leg of the line of play, ending at the pin', () => {
  const shots = planShots([tee, dog, green], green);
  assert.equal(shots.length, 2);
  assert.deepEqual(shots[0].from, tee);
  assert.ok(metres(shots[0].to, dog) < 0.5);
  assert.ok(metres(shots[1].to, green) < 0.5);
  assert.ok(shots[1].last && !shots[0].last);
  assert.ok(shots[0].carry < shots[0].yd);
});

test('a long straight leg is split into shots no longer than the max', () => {
  const far: LngLat = [-112.25, 33.6 + 520 / 111320]; // ~570 yd
  const shots = planShots([tee, far], far);
  assert.equal(shots.length, 2);
  for (const s of shots) assert.ok(s.yd <= MAX_SHOT_YD + 1);
});

test('the ball leaves the ground, peaks past halfway and lands on the landing spot', () => {
  const [s] = planShots([tee, dog, green], green);
  assert.equal(ballInAir(s, 0).alt, 0);
  assert.ok(metres(ballInAir(s, 1).at, s.land) < 0.5);
  assert.ok(Math.abs(ballInAir(s, 1).alt) < 0.01);
  let best = 0, bestS = 0;
  for (let u = 0; u <= 1; u += 0.01) { const p = ballInAir(s, u); if (p.alt > best) { best = p.alt; bestS = p.s; } }
  assert.ok(Math.abs(best - s.apex) < 0.5 && bestS > 0.5);
});
