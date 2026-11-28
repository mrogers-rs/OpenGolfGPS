import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSnapshot, toElements } from '../src/courses/snapshot.ts';
import { parseCourse } from '../src/course.ts';
import { readFileSync, readdirSync } from 'node:fs';
import type { OverpassElement } from '../src/types.ts';

const g = (pts: [number, number][]) => pts.map(([lon, lat]) => ({ lon, lat }));

test('a snapshot parses to the same course as the OSM data it came from', () => {
  const ring = g([[-112.26, 33.66], [-112.2601, 33.66], [-112.2601, 33.6601], [-112.26, 33.66]]);
  const els: OverpassElement[] = [
    { type: 'way', id: 1, tags: { golf: 'hole', ref: '1', par: '4', note: 'dropped' }, geometry: g([[-112.27, 33.65], [-112.26005, 33.66003]]) },
    { type: 'way', id: 2, tags: { golf: 'green' }, geometry: ring },
    { type: 'node', id: 3, lat: 33.66, lon: -112.2700001234, tags: { natural: 'tree', species: 'palm' } },
    { type: 'way', id: 4, tags: { highway: 'service', golf_cart: 'designated' }, geometry: g([[-112.27, 33.65], [-112.268, 33.651]]) },
    { type: 'relation', id: 5, tags: { natural: 'water' }, members: [{ type: 'way', ref: 9, role: 'outer', geometry: ring }] },
  ];
  const b = { minlat: 33.65, minlon: -112.27, maxlat: 33.67, maxlon: -112.25 };
  const snap = JSON.parse(JSON.stringify(makeSnapshot('relation/1', 'Test', b, els)));
  assert.deepEqual(snap.elements[0].t, { golf: 'hole', ref: '1', par: '4' });
  assert.deepEqual(snap.elements[2].n, [-112.27, 33.66]);
  const a = parseCourse(els, { id: 'relation/1', name: 'Test' });
  const c = parseCourse(toElements(snap), { id: 'relation/1', name: 'Test' });
  assert.equal(c.holes.length, 1);
  assert.equal(c.holes[0].par, 4);
  assert.deepEqual(c.holes[0].green, a.holes[0].green);
  assert.deepEqual(c.features.features.map((f) => f.properties!.kind), a.features.features.map((f) => f.properties!.kind));
});

test('built-in snapshots are named by course id and have holes', () => {
  const dir = new URL('../src/courses/osm/', import.meta.url);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
  for (const f of files) {
    const s = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    assert.equal(f, s.courseId.replace('/', '-') + '.json');
    const c = parseCourse(toElements(s), { id: s.courseId, name: s.name });
    assert.ok(c.holes.length >= 1, f);
  }
});
