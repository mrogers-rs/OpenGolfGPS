// Front / center / back yardages and tap-to-measure. All distances in yards.
import * as turf from '@turf/turf';
import type { Hole, LngLat } from './types.ts';

const M_TO_YD = 1.0936133;
export const yd = (a: LngLat, b: LngLat) => turf.distance(a, b, { units: 'meters' }) * M_TO_YD;

/** Length along a polyline, in yards. */
export const pathYd = (pts: LngLat[]) => pts.slice(1).reduce((s, p, i) => s + yd(pts[i], p), 0);

export interface GreenNumbers {
  front: number;
  center: number;
  back: number;
  /** Where front/back were measured on the green edge (for drawing). */
  frontPt: LngLat;
  backPt: LngLat;
  /** 'gps' = from your position; 'tee' = from the tee along the hole's line of play. */
  from: 'gps' | 'tee';
}

/** Players farther than this from the green get "from tee" numbers instead (e.g. at home, or on another hole far away). */
export const MAX_GPS_YD = 700;

/**
 * Front/back are where the line of play crosses the green edge.
 * With GPS, the line of play is from you to the green center (your actual approach angle).
 * Without GPS, or once you're on the green, it's the hole's own mapped line (last dogleg point -> green).
 */
export function greenNumbers(hole: Hole, player: LngLat | null): GreenNumbers {
  const useGps = !!player && yd(player, hole.center) <= MAX_GPS_YD;
  const onGreen = useGps && hole.green && turf.booleanPointInPolygon(player!, turf.polygon([hole.green]));
  // Point the approach line comes from.
  const approach: LngLat = useGps && !onGreen ? player! : hole.line[Math.max(0, hole.line.length - 2)];
  const [frontPt, backPt] = greenEdges(hole, approach);

  if (useGps) {
    const p = player!;
    return { front: yd(p, frontPt), center: yd(p, hole.center), back: yd(p, backPt), frontPt, backPt, from: 'gps' };
  }
  // From the tee, measured along the line of play: tee -> doglegs -> approach point -> target.
  const toApproach = pathYd(hole.line.slice(0, Math.max(1, hole.line.length - 1)));
  return {
    front: toApproach + yd(approach, frontPt),
    center: toApproach + yd(approach, hole.center),
    back: toApproach + yd(approach, backPt),
    frontPt,
    backPt,
    from: 'tee',
  };
}

/** Near and far crossing of the line approach -> center (extended) with the green edge. */
export function greenEdges(hole: Hole, approach: LngLat): [LngLat, LngLat] {
  if (!hole.green) return [hole.center, hole.center];
  const bearing = turf.bearing(approach, hole.center);
  const far = turf.destination(hole.center, 150, bearing, { units: 'meters' }).geometry.coordinates as LngLat;
  const near = turf.destination(hole.center, 150, bearing + 180, { units: 'meters' }).geometry.coordinates as LngLat;
  const hits = turf.lineIntersect(turf.lineString([near, far]), turf.lineString(hole.green)).features.map(
    (f) => f.geometry.coordinates as LngLat,
  );
  if (hits.length < 2) return [hole.center, hole.center];
  // Order along the line from the approach side.
  hits.sort((a, b) => yd(near, a) - yd(near, b));
  return [hits[0], hits[hits.length - 1]];
}

export interface Measure {
  toTarget: number;
  targetToCenter: number;
  from: LngLat;
}

/** Tap-to-measure: from you (or the tee if GPS isn't usable) to the tapped point, then on to the green center. */
export function measure(hole: Hole, player: LngLat | null, target: LngLat): Measure {
  const from = player && yd(player, hole.center) <= MAX_GPS_YD ? player : hole.line[0];
  return { toTarget: yd(from, target), targetToCenter: yd(target, hole.center), from };
}
