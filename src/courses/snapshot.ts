// A course's OpenStreetMap data, saved into the app so opening it makes no OSM request.
// Files live in src/courses/osm/ and are made by scripts/snapshot-osm.ts (or the "OSM snapshot" GitHub workflow).
// Compact form: coordinates are flat [lon, lat, lon, lat, ...] arrays rounded to 6 decimals (~10 cm),
// and only the tags the app reads are kept. `toElements` turns it back into Overpass `out geom` elements.
import type { OverpassElement } from '../types.ts';

type Tags = Record<string, string>;
export type SnapEl =
  | { n: [number, number]; t: Tags }
  | { w: number[]; t: Tags }
  | { r: { role: string; g: number[] }[]; t: Tags };

export interface Bounds { minlat: number; minlon: number; maxlat: number; maxlon: number }

export interface CourseSnapshot {
  format: 1;
  courseId: string;
  name: string;
  /** When the data was taken from OpenStreetMap (ISO time). */
  snapshotAt: string;
  source: string;
  /** Course outline bounds (before padding), like Overpass `out bb`. */
  bounds: Bounds;
  elements: SnapEl[];
}

/** Tags the course parser looks at; everything else is dropped. */
const KEEP = ['golf', 'natural', 'building', 'landuse', 'waterway', 'highway', 'golf_cart', 'service', 'ref', 'par', 'handicap', 'name'];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const flat = (g: { lat: number; lon: number }[]) => g.flatMap((p) => [r6(p.lon), r6(p.lat)]);
const pts = (a: number[]) => {
  const out: { lat: number; lon: number }[] = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push({ lon: a[i], lat: a[i + 1] });
  return out;
};
function keepTags(t?: Tags): Tags {
  const o: Tags = {};
  for (const k of KEEP) if (t?.[k] != null) o[k] = t[k];
  return o;
}

export function makeSnapshot(courseId: string, name: string, bounds: Bounds, els: OverpassElement[], when = new Date()): CourseSnapshot {
  const elements: SnapEl[] = [];
  for (const e of els) {
    const t = keepTags(e.tags);
    if (e.type === 'node' && e.lat != null && e.lon != null) elements.push({ n: [r6(e.lon), r6(e.lat)], t });
    else if (e.type === 'way' && e.geometry) elements.push({ w: flat(e.geometry), t });
    else if (e.type === 'relation' && e.members) elements.push({ r: e.members.filter((m) => m.geometry).map((m) => ({ role: m.role, g: flat(m.geometry!) })), t });
  }
  return { format: 1, courseId, name, snapshotAt: when.toISOString(), source: '© OpenStreetMap contributors (ODbL), api.openstreetmap.org', bounds, elements };
}

/** Back to Overpass elements, for parseCourse. Ids are made up (the parser doesn't use them). */
export function toElements(s: CourseSnapshot): OverpassElement[] {
  return s.elements.map((e, i): OverpassElement => {
    if ('n' in e) return { type: 'node', id: i, lon: e.n[0], lat: e.n[1], tags: e.t };
    if ('w' in e) return { type: 'way', id: i, tags: e.t, geometry: pts(e.w) };
    return { type: 'relation', id: i, tags: e.t, members: e.r.map((m) => ({ type: 'way', role: m.role, geometry: pts(m.g) })) };
  });
}
