import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchCourses, coreWords, score } from '../src/search.ts';

// Shapes copied from real Nominatim answers (2026-11-28).
const course = (id: number, name: string, lon: number, lat: number) => ({
  osm_type: 'way', osm_id: id, type: 'golf_course', name, lon: String(lon), lat: String(lat),
  display_name: `${name}, 9860, North 99th Avenue, Sun City, Maricopa County, Arizona, 85373, United States`,
});
const UNION = course(119112753, 'Union Hills Country Club', -112.2737836, 33.6519428);
const SUNCITY = [
  UNION,
  course(3523398, 'Willowcreek Golf Course', -112.2898, 33.6437),
  course(3523225, 'Sun City Country Club', -112.2777, 33.5715),
  course(2342674, 'Westbrook Village Golf Club - Lakes Course', -112.2671, 33.6594),
];
const ROAD = { osm_type: 'way', osm_id: 436791540, type: 'tertiary', name: 'West Union Hills Drive', lon: '-112.2972627', lat: '33.6525556', display_name: 'West Union Hills Drive, Sun City' };
const MOUNTAIN = { osm_type: 'node', osm_id: 359253008, type: 'mountain_range', name: 'Union Hills', lon: '-112.0601507', lat: '33.7211498', display_name: 'Union Hills, Phoenix' };

/** A fake Nominatim: name search needs every word in the name or address, like the real one. */
function fake(log: string[]) {
  return async (url: string) => {
    const u = new URL(url);
    const q = u.searchParams.get('q')!;
    log.push(q + (u.searchParams.get('viewbox') ? ' [box]' : ''));
    if (u.searchParams.get('viewbox')) {
      const [w, n, e, s] = u.searchParams.get('viewbox')!.split(',').map(Number);
      return SUNCITY.filter((c) => +c.lon > w && +c.lon < e && +c.lat > s && +c.lat < n);
    }
    const all = [MOUNTAIN, ROAD, ...SUNCITY];
    const ws = q.toLowerCase().split(' ');
    // Like the real one, "Union Hills" alone ranks the hills and the road and leaves the course out.
    const wantsCourse = ws.some((w) => ['club', 'course'].includes(w));
    return all.filter((r) => (wantsCourse || r.type !== 'golf_course') && ws.every((w) => r.display_name.toLowerCase().includes(w)));
  };
}

test('filler words are dropped', () => {
  assert.deepEqual(coreWords('Union Hills golf course in Sun City'), ['union', 'hills', 'sun', 'city']);
  assert.deepEqual(coreWords('Golf Club'), ['golf', 'club']);
  assert.equal(score('Pebblebrook Golf Course', ['pebble']), 1);
  assert.equal(score('Union Hills Country Club', ['union', 'hills', 'sun']), 2);
});

test('"Union Hills golf course in Sun City" finds Union Hills Country Club', async () => {
  const log: string[] = [];
  const hits = await searchCourses('Union Hills golf course in Sun City', null, fake(log), 0);
  assert.equal(hits[0].name, 'Union Hills Country Club');
  assert.ok(!hits.some((h) => h.name.includes('Drive')));
});

test('plain "Union Hills" finds it with no location', async () => {
  const hits = await searchCourses('Union Hills', null, fake([]), 0);
  assert.equal(hits[0].name, 'Union Hills Country Club');
});

test('plain "Union Hills" finds it from nearby without asking around other places', async () => {
  const log: string[] = [];
  const hits = await searchCourses('union hills', [-112.267, 33.659], fake(log), 0);
  assert.equal(hits[0].name, 'Union Hills Country Club');
  assert.ok(!log.slice(2).some((q) => q.endsWith('[box]')));
  assert.equal(log[1], 'golf course [box]');
});

test('a town on its own lists its courses', async () => {
  const hits = await searchCourses('Peoria', null, async (url) => {
    if (new URL(url).searchParams.get('viewbox')) return SUNCITY;
    return url.includes('Peoria') || url.includes('peoria') ? [{ osm_type: 'relation', osm_id: 1, type: 'city', name: 'Peoria', lon: '-112.27', lat: '33.65', display_name: 'Peoria, AZ' }] : [];
  }, 0);
  assert.equal(hits.length, 4);
});
