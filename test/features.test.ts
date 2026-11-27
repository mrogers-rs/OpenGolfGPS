import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCourse } from '../src/course.ts';
import { hazardNumbers, layupMarks } from '../src/hazards.ts';
import { yd } from '../src/yardage.ts';
import { newRound, markShot, shotDistances, totals, isGir, pace, holeAllotments, fmtToPar } from '../src/round.ts';

const data = JSON.parse(readFileSync(new URL('./fixtures/allenmore.json', import.meta.url), 'utf8'));
const course = parseCourse(data.elements, { id: 'way/23143257', name: 'Allenmore Golf Course' });
const H = (ref: number) => course.holes[ref - 1];

test('hazards from the tee: reach < carry, nearest first, nothing beside the tee', () => {
  for (const h of course.holes) {
    const hz = hazardNumbers(course, h, null);
    for (const z of hz) assert.ok(z.reach <= z.carry, `hole ${h.ref}`);
    for (let i = 1; i < hz.length; i++) assert.ok(hz[i - 1].reach <= hz[i].reach);
    for (const z of hz) assert.ok(z.greenside || z.carry >= 40, `hole ${h.ref} hazard at ${z.carry}`);
  }
});

test('hole 12 (par 3) has water to carry in front of the green', () => {
  const water = hazardNumbers(course, H(12), null).filter((z) => z.kind === 'water');
  assert.ok(water.length >= 1);
  assert.ok(water[0].carry > 70 && water[0].carry < 110, `carry ${water[0].carry}`);
});

test('hole 3 fairway bunkers on the left, greenside bunkers flagged', () => {
  const hz = hazardNumbers(course, H(3), null);
  const fairway = hz.filter((z) => !z.greenside);
  assert.ok(fairway.length >= 2 && fairway.every((z) => z.side === 'L'));
  assert.ok(hz.some((z) => z.greenside));
});

test('hazards you have passed disappear; GPS numbers are from you', () => {
  const h = H(3);
  const fromTee = hazardNumbers(course, h, null).filter((z) => !z.greenside);
  // Stand 300 yd along hole 3, past its fairway bunkers.
  const me = h.line[h.line.length - 2];
  const hz = hazardNumbers(course, h, me);
  assert.ok(hz.filter((z) => !z.greenside).length < fromTee.length);
  for (const z of hz) assert.ok(z.reach < 150);
});

test('layup marks sit the right distance from the green', () => {
  const h = H(5);
  const marks = layupMarks(h, null);
  assert.deepEqual(marks.map((m) => m.toGreen), [100, 150, 200, 250]);
  for (const m of marks) assert.ok(Math.abs(yd(m.at, h.center) - m.toGreen) < 3);
  // Standing 120 yd out, only the 100 mark is ahead of you.
  const near = layupMarks(h, marks[0].at).map((m) => m.toGreen);
  assert.ok(!near.includes(200) && !near.includes(250));
});

test('scorecard totals and stats', () => {
  const r = newRound(course, 0, 255, 0);
  r.holes[1] = { strokes: 4, putts: 2, fairway: 'hit' }; // par 4, GIR
  r.holes[2] = { strokes: 4, putts: 1 }; // par 3 bogey, missed green... strokes-putts=3 > 1
  r.holes[3] = { strokes: 3, putts: 1, fairway: 'left' }; // birdie
  const t = totals(r);
  const pars = [1, 2, 3].map((i) => H(i).par!);
  assert.equal(t.par, pars.reduce((a, b) => a + b));
  assert.equal(t.strokes, 11);
  assert.equal(t.putts, 4);
  assert.equal(t.fairways, 1);
  assert.equal(t.fairwayChances, 2);
  assert.equal(isGir(r.holes[1], 4), true);
  assert.equal(isGir(r.holes[2], 3), false);
  assert.equal(fmtToPar(0), 'E');
  assert.equal(fmtToPar(2), '+2');
});

test('shot tracker distances', () => {
  const r = newRound(course);
  const h = H(1);
  assert.equal(markShot(r, 1, h.line[0]), null);
  const d = markShot(r, 1, h.line[1])!;
  assert.ok(d > 150 && d < 300);
  assert.equal(shotDistances(r.holes[1]).length, 1);
});

test('pace of play', () => {
  const allot = holeAllotments(course, 255);
  assert.ok(Math.abs(allot.reduce((a, b) => a + b, 0) - 255) < 0.01);
  const r = newRound(course, 0, 255, 0);
  const min = 60000;
  assert.equal(pace(r, course, 0, 5 * min).delta, 0); // on the 1st, 5 min in
  assert.ok(pace(r, course, 0, 40 * min).delta > 20); // still on the 1st after 40 min
  const exp9 = allot.slice(0, 9).reduce((a, b) => a + b, 0);
  assert.ok(pace(r, course, 9, (exp9 - 10) * min).delta < -9); // on the 10th tee 10 min early
  // Back-nine start wraps round.
  const r10 = newRound(course, 9, 255, 0);
  assert.equal(pace(r10, course, 9, 2 * min).delta, 0);
});

test('scenery is parsed for the map view', () => {
  const sq = (x: number, y: number, d = 0.0003) => [[y, x], [y, x + d], [y + d, x + d], [y + d, x], [y, x]].map(([lat, lon]) => ({ lat, lon }));
  const extra = [
    { type: 'node', id: 1, lat: 47.24, lon: -122.47, tags: { natural: 'tree' } },
    { type: 'way', id: 2, tags: { natural: 'wood' }, geometry: sq(-122.475, 47.236) },
    { type: 'way', id: 3, tags: { building: 'yes' }, geometry: sq(-122.471, 47.243, 0.0001) },
    { type: 'way', id: 4, tags: { highway: 'footway' }, geometry: [{ lat: 47.24, lon: -122.47 }, { lat: 47.241, lon: -122.471 }] },
    { type: 'way', id: 5, tags: { waterway: 'stream' }, geometry: [{ lat: 47.238, lon: -122.47 }, { lat: 47.239, lon: -122.471 }] },
    { type: 'way', id: 6, tags: { highway: 'service', golf_cart: 'designated' }, geometry: [{ lat: 47.238, lon: -122.47 }, { lat: 47.239, lon: -122.471 }] },
  ];
  const c = parseCourse([...data.elements, ...extra], { id: 'x', name: 'x' });
  const kinds = (k: string) => c.features.features.filter((f) => f.properties?.kind === k);
  assert.equal(kinds('tree')[0].geometry.type, 'Point');
  assert.equal(kinds('wood')[0].geometry.type, 'Polygon');
  assert.equal(kinds('building').length, 1);
  assert.equal(kinds('path')[0].geometry.type, 'LineString');
  assert.equal(kinds('stream').length, 1);
  assert.equal(kinds('cartpath').length, 1);
  assert.equal(c.holes.length, 18);
  assert.ok((c.v ?? 0) >= 2);
});

test('hazards and layups work from anywhere, including behind the green or on another hole', () => {
  for (const h of course.holes) {
    for (const p of [h.center, course.holes[(h.ref + 6) % 18].line[0], [h.center[0] + 0.0004, h.center[1] + 0.0004] as [number, number]]) {
      hazardNumbers(course, h, p);
      layupMarks(h, p);
    }
  }
});
