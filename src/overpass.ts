// Course search (Nominatim / Overpass) and loading (Overpass). Results are cached by storage.ts.
import * as turf from '@turf/turf';
import { parseCourse } from './course.ts';
import type { Course, LngLat, OverpassElement } from './types.ts';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export async function overpass(query: string): Promise<OverpassElement[]> {
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(`${url}: HTTP ${res.status}`);
      return JSON.parse(text).elements as OverpassElement[];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass unavailable');
}

export interface CourseHit {
  id: string; // "way/123"
  name: string;
  where?: string;
  center: LngLat;
}

/** Golf courses within `km` of a point. */
export async function coursesNear(p: LngLat, km = 25): Promise<CourseHit[]> {
  const els = await overpass(`[out:json][timeout:30];nwr["leisure"="golf_course"](around:${km * 1000},${p[1]},${p[0]});out tags center;`);
  return els
    .filter((e) => e.type !== 'node' && e.tags?.name)
    .map((e: any) => ({ id: `${e.type}/${e.id}`, name: e.tags.name, center: [e.center.lon, e.center.lat] as LngLat }))
    .sort((a, b) => turf.distance(p, a.center) - turf.distance(p, b.center));
}

/** Search by name using Nominatim (OSM's geocoder). */
export async function searchCourses(q: string): Promise<CourseHit[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&q=${encodeURIComponent(q + ' golf')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const rows: any[] = await res.json();
  return rows
    .filter((r) => r.type === 'golf_course' && (r.osm_type === 'way' || r.osm_type === 'relation'))
    .map((r) => ({ id: `${r.osm_type}/${r.osm_id}`, name: r.name || r.display_name.split(',')[0], where: r.display_name.split(',').slice(1, 4).join(',').trim(), center: [+r.lon, +r.lat] as LngLat }));
}

/** Fetch a course boundary, then every golf feature in (and slightly around) it. */
export async function loadCourse(id: string, fallbackName?: string): Promise<Course> {
  const [type, osmId] = id.split('/');
  const head = await overpass(`[out:json][timeout:30];${type}(${osmId});out geom tags bb;`);
  const c = head[0];
  if (!c) throw new Error('Course not found in OpenStreetMap');
  const boundary = boundaryOf(c);
  const b = c.bounds!;
  const pad = 0.0015; // ~150 m, catches tees/greens drawn just outside the boundary
  const bbox = `${b.minlat - pad},${b.minlon - pad},${b.maxlat + pad},${b.maxlon + pad}`;
  const els = await overpass(`[out:json][timeout:60];(nwr["golf"](${bbox});nwr["natural"="water"](${bbox}););out geom;`);
  const course = parseCourse(els, { id, name: c.tags?.name ?? fallbackName ?? 'Golf course', boundary });
  if (!course.holes.length) throw new Error('No holes are mapped for this course in OpenStreetMap yet');
  return course;
}

function boundaryOf(c: OverpassElement): LngLat[][][] | undefined {
  if (c.type === 'way' && c.geometry) return [[c.geometry.map((p) => [p.lon, p.lat] as LngLat)]];
  return undefined; // relation boundaries: fall back to bbox only
}
