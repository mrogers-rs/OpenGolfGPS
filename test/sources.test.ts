import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOverpass, wanted, golfCoursesIn } from '../src/osmapi.ts';
import { race } from '../src/overpass.ts';

test('OSM API answers convert to Overpass geometry, keeping only course features', () => {
  const els: any[] = [
    { type: 'node', id: 1, lat: 47, lon: -122 },
    { type: 'node', id: 2, lat: 47.001, lon: -122 },
    { type: 'node', id: 3, lat: 47.001, lon: -122.001 },
    { type: 'node', id: 4, lat: 47.0005, lon: -122.0005, tags: { natural: 'tree' } },
    { type: 'node', id: 5, lat: 47.0005, lon: -122.0005, tags: { amenity: 'bench' } },
    { type: 'way', id: 10, nodes: [1, 2, 3, 1], tags: { golf: 'green' } },
    { type: 'way', id: 11, nodes: [1, 2], tags: { highway: 'path' } },
    { type: 'way', id: 12, nodes: [1, 2], tags: { fence_type: 'chain' } },
    { type: 'way', id: 13, nodes: [1, 99], tags: { golf: 'bunker' } }, // missing node: dropped
    { type: 'relation', id: 20, tags: { natural: 'water' }, members: [{ type: 'way', ref: 10, role: 'outer' }] },
  ];
  const out = toOverpass(els);
  assert.deepEqual(out.map((e) => `${e.type}/${e.id}`), ['node/4', 'way/10', 'way/11', 'relation/20']);
  assert.equal(out[1].geometry!.length, 4);
  assert.deepEqual(out[1].geometry![1], { lat: 47.001, lon: -122 });
  assert.equal(out[3].members![0].geometry!.length, 4);
  assert.equal(wanted({ type: 'node', tags: { building: 'yes' } }), false);
  assert.equal(wanted({ type: 'way', tags: { waterway: 'stream' } }), true);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('falls back to the second source right away when the first fails', async () => {
  const t0 = Date.now();
  const v = await race('t1', [
    { name: 'a', run: async () => { await wait(10); throw new Error('busy'); } },
    { name: 'b', run: async () => 'from b' },
  ], 5000);
  assert.equal(v, 'from b');
  assert.ok(Date.now() - t0 < 1000);
});

test('asks the second source when the first is slow, and cancels the loser', async () => {
  let aborted = false;
  const v = await race('t2', [
    { name: 'a', run: (sig) => new Promise((_, rej) => sig.addEventListener('abort', () => { aborted = true; rej(new Error('cancelled')); })) },
    { name: 'b', run: async () => 'from b' },
  ], 30);
  assert.equal(v, 'from b');
  assert.equal(aborted, true);
});

test('one plain message when every source fails', async () => {
  await assert.rejects(race('t3', [
    { name: 'a', run: async () => { throw new Error('HTTP 504'); } },
    { name: 'b', run: async () => { throw new Error('HTTP 429'); } },
  ], 30), /busy right now/);
});

test('golf courses are found in an OSM API answer by tag, with a center, for ways and relations', () => {
  const els: any[] = [
    { type: 'node', id: 1, lat: 47.33, lon: -122.21 },
    { type: 'node', id: 2, lat: 47.34, lon: -122.21 },
    { type: 'node', id: 3, lat: 47.34, lon: -122.20 },
    { type: 'way', id: 10, nodes: [1, 2, 3, 1], tags: { leisure: 'golf_course', name: 'Auburn Golf Course' } },
    { type: 'way', id: 11, nodes: [1, 2, 3], tags: { golf: 'hole', ref: '1' } },
    { type: 'way', id: 12, nodes: [2, 3, 2] },
    { type: 'relation', id: 20, members: [{ type: 'way', ref: 12, role: 'outer' }], tags: { leisure: 'golf_course' } },
  ];
  const got = golfCoursesIn(els);
  assert.deepEqual(got.map((c) => c.id), ['way/10', 'relation/20']);
  assert.equal(got[0].name, 'Auburn Golf Course');
  assert.ok(Math.abs(got[0].center[1] - 47.335) < 1e-9);
  assert.equal(got[1].name, 'Golf course');
});
