import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as turf from '@turf/turf';
import { readFileSync } from 'node:fs';
import { parseCourse } from '../src/course.ts';
import { holeCorridor, holeMask, framing, insideCorridor, APPROACH_YD } from '../src/cutout.ts';
import { yd } from '../src/yardage.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/allenmore.json', import.meta.url), 'utf8'));
const course = parseCourse(fx.elements, { id: 'way/1', name: 'Allenmore' });

test('the cutout keeps the hole (tee, line, green) and hides far-away points', () => {
  for (const h of course.holes) {
    const c = holeCorridor(h);
    assert.ok(turf.booleanPointInPolygon(h.line[0], c), `tee of ${h.ref}`);
    assert.ok(turf.booleanPointInPolygon(h.center, c), `green of ${h.ref}`);
    const far = turf.destination(h.center, 300, turf.bearing(h.line[0], h.center) + 90, { units: 'meters' });
    assert.ok(!turf.booleanPointInPolygon(far, c));
    const mask = holeMask(c);
    assert.ok(turf.booleanPointInPolygon(far, mask) && !turf.booleanPointInPolygon(h.center, mask));
  }
  const h = course.holes[0];
  const trees = [turf.point(h.center), turf.point(turf.destination(h.center, 500, 0, { units: 'meters' }).geometry.coordinates)];
  assert.equal(insideCorridor(trees, holeCorridor(h)).length, 1);
});

test('the view frames less of the hole as you walk, then the green close up', () => {
  const h = course.holes.find((x) => x.par === 4)!;
  const span = (pts: [number, number][]) => turf.length(turf.lineString(turf.coordAll(turf.envelope(turf.multiPoint(pts))).slice(0, 3) as any), { units: 'meters' });
  const tee = framing(h, null);
  assert.equal(tee.mode, 'hole');
  const line = turf.lineString([...h.line.slice(0, -1), h.center]);
  const total = turf.length(line, { units: 'meters' });
  const mid = turf.along(line, total * 0.4, { units: 'meters' }).geometry.coordinates as [number, number];
  const ahead = framing(h, mid);
  assert.equal(ahead.mode, 'ahead');
  assert.ok(span(ahead.pts) < span(tee.pts));
  const near = turf.along(line, total - 60, { units: 'meters' }).geometry.coordinates as [number, number];
  assert.ok(yd(near, h.center) <= APPROACH_YD);
  const ap = framing(h, near);
  assert.equal(ap.mode, 'approach');
  assert.ok(span(ap.pts) < span(ahead.pts));
});

test('distance arcs on par 4s and 5s, short of the green, at the right range', async () => {
  const { distanceArcs } = await import('../src/arcs.ts');
  const p3 = course.holes.find((x) => x.par === 3)!;
  assert.equal(distanceArcs(p3, null).length, 0);
  const p5 = course.holes.find((x) => x.par === 5)!;
  const arcs = distanceArcs(p5, null);
  assert.ok(arcs.length >= 4, `got ${arcs.map((a) => a.yds)}`);
  for (const a of arcs) for (const p of [a.line[0], a.line[8], a.line[16]]) assert.ok(Math.abs(yd(p5.line[0], p) - a.yds) < 1.5);
  const p4 = course.holes.find((x) => x.par === 4 && yd(x.line[0], x.center) < 330)!;
  assert.ok(distanceArcs(p4, null).every((a) => a.yds < yd(p4.line[0], p4.center) - 15));
});

test('default drive crosshair: 240 yd out, in the fairway, only from the tee on par 4/5', async () => {
  const { driveTarget } = await import('../src/arcs.ts');
  const fairways = course.features.features.filter((f: any) => f.properties?.kind === 'fairway' && f.geometry.type === 'Polygon') as any;
  const p3 = course.holes.find((x) => x.par === 3)!;
  assert.equal(driveTarget(p3, fairways, null), null);
  let inFw = 0, n = 0;
  for (const h of course.holes.filter((x) => (x.par ?? 0) >= 4)) {
    const t = driveTarget(h, fairways, null, 240);
    if (!t) continue;
    n++;
    assert.ok(Math.abs(yd(h.line[0], t) - 240) < 25, `hole ${h.ref}: ${yd(h.line[0], t)}`);
    if (fairways.some((f: any) => turf.booleanPointInPolygon(t, f))) inFw++;
    // Walked off the tee: no default.
    const mid = turf.along(turf.lineString(h.line), 150, { units: 'meters' }).geometry.coordinates as [number, number];
    assert.equal(driveTarget(h, fairways, mid), null);
  }
  assert.ok(n >= 8, `targets on ${n} holes`);
});

test('default drive crosshair moves to the middle of an offset fairway', async () => {
  const { driveTarget } = await import('../src/arcs.ts');
  const h = course.holes.find((x) => x.par === 4 && yd(x.line[0], x.center) > 300)!;
  const b = turf.bearing(h.line[0], h.center);
  // A 30 m wide fairway whose middle is 18 m right of the line of play.
  const shifted = turf.lineString(h.line.map((p) => turf.destination(p, 18, b + 90, { units: 'meters' }).geometry.coordinates));
  const fw = turf.buffer(shifted, 15, { units: 'meters' }) as any;
  const t = driveTarget(h, [fw], null, 240)!;
  assert.ok(turf.booleanPointInPolygon(t, fw));
  const off = turf.pointToLineDistance(t, shifted, { units: 'meters' });
  assert.ok(off < 6, `off fairway middle by ${off.toFixed(1)} m`);
});
