// Turns Overpass "out geom" JSON into a Course: holes with greens matched, plus drawable features.
import * as turf from '@turf/turf';
import type { Course, FeatureKind, Hole, LngLat, OverpassElement } from './types.ts';

const ll = (g: { lat: number; lon: number }[]): LngLat[] => g.map((p) => [p.lon, p.lat]);
const closed = (r: LngLat[]) => r.length > 2 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];

/** Join multipolygon member ways into closed rings. */
export function joinRings(parts: LngLat[][]): LngLat[][] {
  const rings: LngLat[][] = [];
  const open = parts.filter((p) => p.length > 1).map((p) => p.slice());
  const same = (a: LngLat, b: LngLat) => a[0] === b[0] && a[1] === b[1];
  while (open.length) {
    let cur = open.shift()!;
    let grew = true;
    while (!closed(cur) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        const end = cur[cur.length - 1];
        if (same(end, p[0])) cur = cur.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else if (same(cur[0], p[p.length - 1])) cur = p.concat(cur.slice(1));
        else if (same(cur[0], p[0])) cur = p.slice().reverse().concat(cur.slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (closed(cur) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

function kindOf(tags: Record<string, string>): FeatureKind | null {
  const g = tags.golf;
  if (g === 'fairway' || g === 'green' || g === 'tee' || g === 'bunker' || g === 'rough' || g === 'hole' || g === 'driving_range' || g === 'cartpath') return g;
  if (g === 'water_hazard' || g === 'lateral_water_hazard' || tags.natural === 'water') return 'water';
  if (g === 'clubhouse') return 'clubhouse';
  return null;
}

function polygonsOf(el: OverpassElement): LngLat[][][] {
  if (el.type === 'way' && el.geometry) {
    const r = ll(el.geometry);
    return closed(r) && r.length >= 4 ? [[r]] : [];
  }
  if (el.type === 'relation' && el.members) {
    const outer = joinRings(el.members.filter((m) => m.geometry && m.role !== 'inner').map((m) => ll(m.geometry!)));
    const inner = joinRings(el.members.filter((m) => m.geometry && m.role === 'inner').map((m) => ll(m.geometry!)));
    return outer.map((o) => {
      const poly = turf.polygon([o]);
      return [o, ...inner.filter((i) => turf.booleanPointInPolygon(i[0], poly))];
    });
  }
  return [];
}

export interface ParseOptions {
  id: string;
  name: string;
  /** Optional course boundary; holes whose tee falls outside it are dropped (handles neighbouring courses in the bbox). */
  boundary?: LngLat[][][];
}

export function parseCourse(elements: OverpassElement[], opts: ParseOptions): Course {
  const features: GeoJSON.Feature[] = [];
  const greens: { ring: LngLat[]; poly: GeoJSON.Feature<GeoJSON.Polygon> }[] = [];
  const pins: LngLat[] = [];
  const holeEls: OverpassElement[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const kind = kindOf(tags);
    if (!kind) continue;
    if (kind === 'hole') { if (el.geometry) holeEls.push(el); continue; }
    if (el.type === 'node') continue;
    if (kind === 'cartpath') {
      if (el.geometry) features.push(turf.lineString(ll(el.geometry), { kind }));
      continue;
    }
    for (const rings of polygonsOf(el)) {
      const f = turf.polygon(rings, { kind });
      features.push(f);
      if (kind === 'green') greens.push({ ring: rings[0], poly: f });
    }
  }
  // golf=pin nodes aren't drawn, just used to place the flag
  for (const el of elements) if (el.type === 'node' && el.tags?.golf === 'pin' && el.lat != null) pins.push([el.lon!, el.lat]);

  const boundaryPolys = opts.boundary?.map((rings) => turf.polygon(rings));
  const inBoundary = (p: LngLat) => !boundaryPolys || boundaryPolys.some((b) => turf.booleanPointInPolygon(p, b) || turf.pointToLineDistance(p, turf.polygonToLine(b) as any, { units: 'meters' }) < 60);

  const byRef = new Map<number, Hole>();
  for (const el of holeEls) {
    const ref = parseInt(el.tags?.ref ?? '', 10);
    if (!Number.isFinite(ref)) continue;
    let line = ll(el.geometry!);
    if (line.length < 2) continue;
    if (!inBoundary(line[0])) continue;
    const green = matchGreen(line, greens);
    // Holes are normally mapped tee -> green; if the start is the end that touches a green, flip it.
    if (green && !matchGreen([line[line.length - 1]], greens) && matchGreen([line[0]], greens)) line = line.slice().reverse();
    const end = line[line.length - 1];
    const center: LngLat = green ? (turf.centerOfMass(green.poly).geometry.coordinates as LngLat) : end;
    const pin = green ? pins.find((p) => turf.booleanPointInPolygon(p, green.poly)) : undefined;
    const hole: Hole = {
      ref,
      par: num(el.tags?.par),
      handicap: num(el.tags?.handicap),
      line,
      green: green?.ring,
      center,
      pin,
    };
    features.push(turf.lineString(line, { kind: 'hole', ref }));
    if (!byRef.has(ref)) byRef.set(ref, hole);
  }
  const holes = [...byRef.values()].sort((a, b) => a.ref - b.ref);
  const fc = turf.featureCollection(features);
  const bboxSrc = holes.length ? turf.featureCollection(holes.map((h) => turf.lineString(h.line))) : fc;
  const bbox = turf.bbox(bboxSrc) as [number, number, number, number];
  return { id: opts.id, name: opts.name, bbox, holes, features: fc, fetchedAt: Date.now() };
}

function num(s?: string) {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) ? n : undefined;
}

/** The green containing the hole's last point, or the nearest green within 40 m of it. */
function matchGreen(line: LngLat[], greens: { ring: LngLat[]; poly: GeoJSON.Feature<GeoJSON.Polygon> }[]) {
  const end = line[line.length - 1];
  const inside = greens.find((g) => turf.booleanPointInPolygon(end, g.poly));
  if (inside) return inside;
  let best: (typeof greens)[number] | undefined;
  let bestD = 40;
  for (const g of greens) {
    const d = turf.pointToLineDistance(end, turf.lineString(g.ring), { units: 'meters' });
    if (d < bestD) { bestD = d; best = g; }
  }
  return best;
}
