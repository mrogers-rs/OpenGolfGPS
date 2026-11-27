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

/** The hole's shape: tee to green along the line of play plus the green, with a margin. */
export function holeCorridor(h: Hole): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> {
  const line = turf.lineString([...h.line.slice(0, -1), h.center]);
  const parts: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[] = [turf.buffer(line, CORRIDOR_M, { units: 'meters', steps: 12 })!];
  if (h.green && h.green.length >= 4) parts.push(turf.buffer(turf.polygon([h.green]), GREEN_MARGIN_M, { units: 'meters', steps: 12 })!);
  const u = parts.length > 1 ? turf.union(turf.featureCollection(parts)) : parts[0];
  return u ?? parts[0];
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
