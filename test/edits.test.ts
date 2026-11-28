import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as turf from '@turf/turf';
import { parseCourse } from '../src/course.ts';
import { applyEdits, closeRing, editableRefs, emptyEdits, parseEditsFile, type CourseEdits } from '../src/edits.ts';
import { greenNumbers } from '../src/yardage.ts';
import { hazardNumbers } from '../src/hazards.ts';
import type { LngLat } from '../src/types.ts';

const data = JSON.parse(readFileSync(new URL('./fixtures/westbrook-vistas.json', import.meta.url), 'utf8'));
const base = parseCourse(data.elements, { id: 'relation/2342699', name: 'Vistas' });

/** A rough circle of tapped points around c (radius m). */
const blob = (c: LngLat, r: number, n = 10): LngLat[] => Array.from({ length: n }, (_, i) => turf.destination(c, r, (360 * i) / n, { units: 'meters' }).geometry.coordinates as LngLat);

test('Vistas from OSM: 18 holes, no greens', () => {
  assert.equal(base.holes.length, 18);
  assert.ok(base.holes.every((h) => !h.green));
  const n = greenNumbers(base.holes[0], null);
  assert.equal(Math.round(n.front), Math.round(n.back)); // center only
});

test('a drawn green gives front / center / back', () => {
  const h1 = base.holes[0];
  const end = h1.line[h1.line.length - 1];
  const e = emptyEdits(base.id, base.name);
  e.holes['1'] = { green: closeRing(blob(end, 14)) };
  const c = applyEdits(base, e);
  const h = c.holes[0];
  assert.ok(h.green);
  const n = greenNumbers(h, null);
  assert.ok(n.back - n.front > 25 && n.back - n.front < 35, `depth ${n.back - n.front}`);
  assert.ok(Math.abs(n.center - (n.front + n.back) / 2) < 3);
  // Original hole line kept, green center as the target.
  assert.deepEqual(h.line[0], h1.line[0]);
  assert.equal(c.features.features.filter((f) => f.properties?.kind === 'green').length, 1);
});

test('new holes need a tee and a green; tee and dogleg replace the line', () => {
  const e = emptyEdits(base.id, base.name);
  const tee: LngLat = [-112.25, 33.66];
  e.holes['19'] = { tee, par: 4 };
  assert.equal(applyEdits(base, e).holes.length, 18); // not finished: left out
  const g = turf.destination(tee, 350, 0, { units: 'meters' }).geometry.coordinates as LngLat;
  e.holes['19'].green = closeRing(blob(g, 12));
  e.holes['19'].dogleg = [turf.destination(tee, 200, 20, { units: 'meters' }).geometry.coordinates as LngLat];
  const c = applyEdits(base, e);
  const h = c.holes.find((x) => x.ref === 19)!;
  assert.equal(h.par, 4);
  assert.equal(h.line.length, 3);
  assert.deepEqual(h.line[0], tee);
  assert.equal(c.holes.at(-1)!.ref, 19);
});

test('drawn hazards are used for hazard numbers', () => {
  const h1 = base.holes[0];
  const mid = turf.along(turf.lineString(h1.line), 220, { units: 'meters' }).geometry.coordinates as LngLat;
  const e: CourseEdits = { ...emptyEdits(base.id, base.name), hazards: [{ id: 'a', kind: 'bunker', ring: closeRing(blob(mid, 8)) }] };
  const hz = hazardNumbers(applyEdits(base, e), h1, null);
  assert.equal(hz.length, 1);
  assert.equal(hz[0].kind, 'bunker');
  assert.ok(hz[0].reach > 215 && hz[0].carry < 260, `${hz[0].reach}-${hz[0].carry}`);
});

test('par edit only keeps the mapped line', () => {
  const e = emptyEdits(base.id, base.name);
  e.holes['5'] = { par: 4 };
  const h = applyEdits(base, e).holes[4];
  assert.equal(h.par, 4);
  assert.deepEqual(h.line, base.holes[4].line);
});

test('course file round trip and validation', () => {
  const e = emptyEdits(base.id, base.name);
  e.holes['2'] = { tee: [-112.1, 33.6] };
  assert.deepEqual(parseEditsFile(JSON.stringify(e)), e);
  assert.throws(() => parseEditsFile('nope'));
  assert.throws(() => parseEditsFile(JSON.stringify({ format: 1, courseId: 'x', holes: { 1: { tee: ['a', 1] } }, hazards: [] })));
});

test('editor offers holes 1-18 even when OSM has one', () => {
  const one = { ...base, holes: base.holes.slice(0, 1) };
  assert.deepEqual(editableRefs(one, null), Array.from({ length: 18 }, (_, i) => i + 1));
});

test('marked trees and woods become scenery, not hazards', async () => {
  const h1 = base.holes[0];
  const mid = turf.along(turf.lineString(h1.line), 200, { units: 'meters' }).geometry.coordinates as LngLat;
  const e: CourseEdits = { ...emptyEdits(base.id, base.name), hazards: [{ id: 'w', kind: 'wood', ring: closeRing(blob(mid, 15)) }], trees: [{ id: 't', at: mid }] };
  const c = applyEdits(base, e);
  assert.equal(c.features.features.filter((f) => f.properties?.kind === 'tree').length, 1);
  assert.equal(c.features.features.filter((f) => f.properties?.kind === 'wood').length, 1);
  assert.equal(hazardNumbers(c, h1, null).length, 0);
  assert.deepEqual(parseEditsFile(JSON.stringify(e)), e);
});

test('export includes tees and par that come from OSM', async () => {
  const { completeEdits } = await import('../src/edits.ts');
  const e = emptyEdits(base.id, base.name);
  e.holes['1'] = { green: closeRing(blob(base.holes[0].line.at(-1)!, 12)) };
  const full = completeEdits(applyEdits(base, e), e);
  assert.deepEqual(full.holes['1'].tee, base.holes[0].line[0]);
  assert.equal(full.holes['1'].par, 4);
  assert.equal(Object.keys(full.holes).length, 18);
  assert.equal(e.holes['1'].tee, undefined); // original untouched
});
