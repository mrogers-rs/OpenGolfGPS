import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCourse } from '../src/course.ts';
import { greenNumbers, measure, yd } from '../src/yardage.ts';
import { autoAdvance, holeAtStart } from '../src/advance.ts';
import type { LngLat } from '../src/types.ts';

const data = JSON.parse(readFileSync(new URL('./fixtures/allenmore.json', import.meta.url), 'utf8'));
const course = parseCourse(data.elements, { id: 'way/23143257', name: 'Allenmore Golf Course' });

test('parses 18 holes with greens and pars', () => {
  assert.equal(course.holes.length, 18);
  assert.deepEqual(course.holes.map((h) => h.ref), Array.from({ length: 18 }, (_, i) => i + 1));
  const pars = course.holes.map((h) => h.par);
  assert.equal(pars.reduce((a, b) => a! + b!, 0), 71); // sum of OSM par tags for Allenmore
  for (const h of course.holes) assert.ok(h.green, `hole ${h.ref} has a green`);
});

test('from-tee yardages are plausible and ordered front < center < back', () => {
  for (const h of course.holes) {
    const n = greenNumbers(h, null);
    assert.equal(n.from, 'tee');
    assert.ok(n.front < n.center && n.center < n.back, `hole ${h.ref}: ${n.front} ${n.center} ${n.back}`);
    const [lo, hi] = h.par === 3 ? [90, 260] : h.par === 4 ? [250, 480] : [430, 620];
    assert.ok(n.center > lo && n.center < hi, `hole ${h.ref} par ${h.par} center ${Math.round(n.center)}`);
    assert.ok(n.back - n.front > 10 && n.back - n.front < 60, `hole ${h.ref} green depth ${Math.round(n.back - n.front)}`);
  }
});

test('GPS yardages use your position', () => {
  const h = course.holes[0];
  const p = h.line[1]; // dogleg point on hole 1
  const n = greenNumbers(h, p);
  assert.equal(n.from, 'gps');
  assert.ok(Math.abs(n.center - yd(p, h.center)) < 0.01);
  assert.ok(n.front < n.center && n.center < n.back);
});

test('far-away GPS falls back to tee numbers', () => {
  const n = greenNumbers(course.holes[0], [-122.3, 47.6]);
  assert.equal(n.from, 'tee');
});

test('tap to measure', () => {
  const h = course.holes[0];
  const m = measure(h, h.line[0], h.line[1]);
  assert.ok(m.toTarget > 150 && m.toTarget < 300);
  assert.ok(Math.abs(m.toTarget + m.targetToCenter - greenNumbers(h, null).center) < 3);
});

test('auto-advance at next tee, not before', () => {
  const holes = course.holes;
  assert.equal(autoAdvance(holes, 0, holes[0].line[1]), null); // mid-fairway on 1
  assert.equal(autoAdvance(holes, 0, holes[1].line[0]), 1); // on 2nd tee
  assert.equal(autoAdvance(holes, 17, holes[0].line[0]), null); // no hole 19
  assert.equal(holeAtStart(holes, holes[9].line[0]), 9);
});

test('auto-advance waits while still on the green', () => {
  // On every hole, standing on the green center must not advance.
  course.holes.forEach((h, i) => assert.equal(autoAdvance(course.holes, i, h.center), null, `hole ${h.ref}`));
});
