// Hole cutout (only the hole and a margin around it are shown) and what the hole view frames as you play.
import * as turf from '@turf/turf';
import type { Hole, LngLat } from './types.ts';
import { playLine } from './hazards.ts';
import { yd } from './yardage.ts';

/** Margin kept around the line of play, and around the green, in meters. (Guess: about 45 / 22 yd.) */
export const CORRIDOR_M = 42;
export const GREEN_MARGIN_M = 20;
/** Inside this many yards of the green, the view becomes a close-up of the green. */
export const APPROACH_YD = 100;
/** Extra room kept around the line of play when framing the hole (meters). */
export const VIEW_MARGIN_M = 18;

/** The plain pill around the line of play (used when nothing better can be built). */
function pill(h: Hole): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> {
  const line = turf.lineString([...h.line.slice(0, -1), h.center]);
  const parts: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = [turf.buffer(line, CORRIDOR_M, { units: 'meters', steps: 12 })!];
  if (h.green && h.green.length >= 4) parts.push(turf.buffer(turf.polygon([h.green]), GREEN_MARGIN_M, { units: 'meters', steps: 12 })!);
  const u = parts.length > 1 ? turf.union(turf.featureCollection(parts)) : parts[0];
  return u ?? parts[0];
}

type Poly = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
const M = { units: 'meters' as const };
const gauss = (x: number, c: number, s: number) => Math.exp(-((x - c) ** 2) / (2 * s * s));
const polys = (fs: GeoJSON.Feature[], kinds: string[]) =>
  fs.filter((f): f is GeoJSON.Feature<GeoJSON.Polygon> => kinds.includes(f.properties?.kind) && f.geometry?.type === 'Polygon');

/**
 * How wide the hole is (meters, each side of the line) at a distance along it: a tee box, a narrow carry,
 * a fairway that swells where drives land (twice on par 5s) and an approach that opens up to the green.
 * Each side wobbles a little (different on every hole) so the outline looks drawn, not machined.
 */
export function holeWidth(h: Hole, s: number, total: number, side: 1 | -1): number {
  const par = h.par ?? (total > 430 ? 5 : total > 210 ? 4 : 3);
  let w = s < 30 ? 17 - s * 0.1 : 14;
  if (par >= 4) {
    const land = Math.min(215, total - 110);
    if (land > 80) w += 20 * gauss(s, land, 65);
    if (par >= 5 && total - 130 > land + 120) w += 16 * gauss(s, total - 130, 55);
  }
  w += (par >= 4 ? 9 : 7) * Math.max(0, 1 - (total - s) / 110);
  const k = h.ref * 1.7 + (side > 0 ? 0 : 2.3);
  w += 2.6 * Math.sin(s / 41 + k) + 1.6 * Math.sin(s / 19 + k * 2.1);
  return Math.max(9, w);
}

/** Polygons (bunkers, water, fairways) that belong to this hole: nearer its line than any other hole's. */
function nearestHole(f: GeoJSON.Feature<GeoJSON.Polygon>, h: Hole, holes: Hole[], maxM: number): boolean {
  const ring = f.geometry.coordinates[0] as LngLat[];
  const step = Math.max(1, Math.floor(ring.length / 24));
  const pts = ring.filter((_, i) => i % step === 0);
  const dist = (x: Hole) => {
    const ls = turf.lineString([...x.line.slice(0, -1), x.center]);
    return Math.min(...pts.map((p) => turf.pointToLineDistance(p, ls, M)));
  };
  const mine = dist(h);
  if (mine > maxM) return false;
  return holes.every((o) => o === h || o.ref === h.ref || dist(o) >= mine - 3);
}

/** Shapes already built, per set of course features (a new set when the course or its edits change). */
const cache = new WeakMap<object, WeakMap<Hole, Poly>>();
const NONE: GeoJSON.Feature[] = [];

/**
 * The hole's shape for the cutout: an organic outline from the tee to the green that follows the line of
 * play, takes in the bunkers and water beside it, and follows mapped fairways where the hole has them.
 * `features` are the course's drawable features; `holes` all the course's holes (so neighbors' bunkers
 * and fairways stay out).
 */
export function holeCorridor(h: Hole, features: GeoJSON.Feature[] = NONE, holes: Hole[] = []): Poly {
  let byHole = cache.get(features);
  if (!byHole) cache.set(features, (byHole = new WeakMap()));
  const hit = byHole.get(h);
  if (hit) return hit;
  let out: Poly;
  try { out = holeShape(h, features, holes.length ? holes : [h]); } catch { out = pill(h); }
  byHole.set(h, out);
  return out;
}

function holeShape(h: Hole, features: GeoJSON.Feature[], holes: Hole[]): Poly {
  const path: LngLat[] = [...h.line.slice(0, -1), h.center];
  const ls = turf.lineString(path);
  const total = turf.length(ls, M);
  if (total < 20) return pill(h);
  const [w0, s0, e0, n0] = turf.bbox(turf.buffer(ls, 90, M)!);
  const near = features.filter((f) => {
    const [w, s, e, n] = turf.bbox(f);
    return !(e < w0 || w > e0 || n < s0 || s > n0);
  });

  // Fairways this hole plays down (traced in the editor for this hole, or mapped in OSM).
  const fairways = polys(near, ['fairway']).filter((f) =>
    f.properties?.hole != null ? Number(f.properties.hole) === h.ref : f.properties?.hole == null && nearestHole(f, h, holes, 25),
  );
  const traced = fairways.length > 0;

  // Body: variable-width band along the line, built from short quads (plus round joints at doglegs).
  const parts: Poly[] = [];
  const step = 8;
  const n = Math.max(2, Math.ceil(total / step));
  const st: { p: LngLat; b: number; l: number; r: number }[] = [];
  const shrink = traced ? 0.55 : 1; // with real fairways, the band only needs to join tee, fairway and green
  for (let i = 0; i <= n; i++) {
    const s = (total * i) / n;
    const p = turf.along(ls, s, M).geometry.coordinates as LngLat;
    const q = turf.along(ls, Math.min(total, s + 2), M).geometry.coordinates as LngLat;
    const b = i === n ? st[i - 1].b : turf.bearing(p, q);
    st.push({ p, b, l: holeWidth(h, s, total, -1) * shrink, r: holeWidth(h, s, total, 1) * shrink });
  }
  const off = (p: LngLat, d: number, b: number) => turf.destination(p, d, b, M).geometry.coordinates as LngLat;
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], c = st[i + 1];
    const ring = [off(a.p, a.l, a.b - 90), off(c.p, c.l, a.b - 90), off(c.p, c.r, a.b + 90), off(a.p, a.r, a.b + 90)];
    parts.push(turf.polygon([[...ring, ring[0]]]));
  }
  for (const d of h.line.slice(1, -1)) {
    const s = turf.nearestPointOnLine(ls, d, M).properties.location ?? 0;
    parts.push(turf.circle(d, Math.max(holeWidth(h, s, total, 1), holeWidth(h, s, total, -1)) * shrink, { ...M, steps: 24 }));
  }
  // Tee box: a rounded pad a little behind the tee.
  parts.push(turf.circle(off(path[0], 6, st[0].b + 180), 15, { ...M, steps: 24 }));
  // Green and its collar.
  if (h.green && h.green.length >= 4) parts.push(turf.buffer(turf.polygon([h.green]), 11, { ...M, steps: 10 })!);
  else parts.push(turf.circle(h.center, 22, { ...M, steps: 24 }));
  // Fairways with a cut of rough around them.
  for (const f of fairways) parts.push(turf.buffer(f, 7, { ...M, steps: 8 })!);
  // Bunkers and water beside the hole, with a lip (only the part near the line, so a big lake doesn't open up).
  const reach = turf.buffer(ls, 55, { ...M, steps: 8 })!;
  for (const z of polys(near, ['bunker', 'water'])) {
    if (!nearestHole(z, h, holes, 45)) continue;
    const g = turf.buffer(z, 6, { ...M, steps: 8 });
    const cut = g && turf.intersect(turf.featureCollection([g, reach]));
    if (cut) parts.push(cut);
  }

  let shape: Poly = turf.union(turf.featureCollection(parts)) ?? parts[0];
  // Round off the joins (close, then open slightly) and smooth the outline.
  const grown = turf.buffer(shape, 10, { ...M, steps: 8 });
  const closed = grown && turf.buffer(grown, -10, { ...M, steps: 8 });
  if (closed) shape = closed;
  shape = outerRings(shape);
  // A bunker or pond standing apart from the hole gets joined to it by a short neck of rough.
  if (shape.geometry.type === 'MultiPolygon') {
    const [main, ...rest] = shape.geometry.coordinates;
    const necks: Poly[] = [turf.polygon(main)];
    for (const r of rest) {
      const part = turf.polygon(r);
      const at = turf.nearestPointOnLine(ls, turf.centroid(part), M).geometry.coordinates as LngLat;
      const pts = turf.featureCollection([...turf.explode(part).features, ...turf.explode(turf.circle(at, 10, { ...M, steps: 12 })).features]);
      necks.push((turf.convex(pts) as Poly | null) ?? part);
    }
    shape = outerRings(turf.union(turf.featureCollection(necks)) ?? shape);
  }
  const smooth = turf.polygonSmooth(shape as any, { iterations: 2 }).features[0] as Poly | undefined;
  return smooth ?? shape;
}

/** Drops holes inside the shape (the cutout is one solid piece per part). */
function outerRings(f: Poly): Poly {
  if (f.geometry.type === 'Polygon') return turf.polygon([f.geometry.coordinates[0]]);
  const big = f.geometry.coordinates.map((p) => p[0]).sort((a, b) => turf.area(turf.polygon([b])) - turf.area(turf.polygon([a])));
  return big.length === 1 ? turf.polygon([big[0]]) : turf.multiPolygon(big.map((r) => [r]));
}

/** Everything outside the corridor (a world polygon with the hole cut out), for darkening the rest. */
export function holeMask(corridor: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>): GeoJSON.Feature<GeoJSON.Polygon> {
  return turf.mask(corridor as any) as GeoJSON.Feature<GeoJSON.Polygon>;
}

/** Keeps features that are at least partly inside the corridor (for raised trees and buildings). */
export function insideCorridor<T extends GeoJSON.Feature>(features: T[], corridor: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>): T[] {
  const [w, s, e, n] = turf.bbox(corridor);
  return features.filter((f) => {
    const p = turf.coordAll(f)[0] as LngLat | undefined;
    if (!p || p[0] < w || p[0] > e || p[1] < s || p[1] > n) return false;
    return turf.booleanPointInPolygon(p, corridor);
  });
}

export type Framing =
  /** The whole hole (no usable position): tee to green. */
  | { mode: 'hole'; pts: LngLat[]; from: LngLat }
  /** What's left: you to the green. Shrinks as you walk. */
  | { mode: 'ahead'; pts: LngLat[]; from: LngLat }
  /** Close to the green: a close-up of it, faced from where you are. */
  | { mode: 'approach'; pts: LngLat[]; from: LngLat };

/** What the hole view should fit on screen, given your position (null when GPS isn't usable for this hole). */
export function framing(h: Hole, me: LngLat | null): Framing {
  const green = h.green ?? [];
  // A little of the fairway either side is kept in view too, so the hole doesn't touch the screen edges.
  const roomy = (pts: LngLat[]) => turf.coordAll(turf.buffer(turf.multiPoint(pts), VIEW_MARGIN_M, { units: 'meters', steps: 4 })!) as LngLat[];
  if (!me) return { mode: 'hole', pts: roomy([...h.line, ...green]), from: h.line[0] };
  if (yd(me, h.center) <= APPROACH_YD) {
    const ring = green.length ? green : [h.center];
    const pts = turf.coordAll(turf.buffer(turf.multiPoint(ring), 10, { units: 'meters', steps: 8 })!) as LngLat[];
    return { mode: 'approach', pts, from: me };
  }
  return { mode: 'ahead', pts: roomy([...playLine(h, me), ...green]), from: me };
}
