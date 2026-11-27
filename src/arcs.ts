// Distance arcs on par 4s and 5s: how far 200-300 yd reaches from the tee (or from you, once you're on the hole).
import * as turf from '@turf/turf';
import type { Hole, LngLat } from './types.ts';
import { playLine } from './hazards.ts';
import { yd } from './yardage.ts';

const YD_TO_M = 0.9144;
export const ARC_YDS = [200, 225, 250, 270, 300];
/** Blue, green, yellow, orange, red: shorter to longer. */
export const ARC_COLORS: Record<number, string> = { 200: '#4dabf7', 225: '#51cf66', 250: '#ffd43b', 270: '#ff922b', 300: '#ff6b6b' };
/** Each arc spans this far either side of the line of play (meters), about the cutout's width. */
const HALF_WIDTH_M = 40;
/** Leave out arcs that land within this many yards of the green center or past it. */
const SHORT_OF_GREEN_YD = 15;

export interface Arc { yds: number; color: string; line: LngLat[]; label: LngLat; side: 'L' | 'R' }

/** Arcs from `from` (null = the tee), centered on where the line of play is that far out. */
export function distanceArcs(h: Hole, from: LngLat | null, yds = ARC_YDS): Arc[] {
  if (!h.par || h.par < 4) return [];
  const origin = from ?? h.line[0];
  const toGreen = yd(origin, h.center);
  const line = turf.lineString(playLine(h, from));
  const total = turf.length(line, { units: 'meters' });
  const out: Arc[] = [];
  for (const d of yds) {
    if (d > toGreen - SHORT_OF_GREEN_YD) continue;
    const m = d * YD_TO_M;
    // Walk the line until the straight-line distance from the origin reaches d (follows doglegs).
    let mid: LngLat | null = null;
    for (let s = 0; s <= total; s += 2) {
      const p = turf.along(line, s, { units: 'meters' }).geometry.coordinates as LngLat;
      if (yd(origin, p) >= d) { mid = p; break; }
    }
    if (!mid) continue;
    const b = turf.bearing(origin, mid);
    const span = (Math.atan2(HALF_WIDTH_M, m) * 180) / Math.PI;
    const pts: LngLat[] = [];
    for (let k = 0; k <= 16; k++) pts.push(turf.destination(origin, m, b - span + (2 * span * k) / 16, { units: 'meters' }).geometry.coordinates as LngLat);
    // Labels on the right end, clear of the line-of-play labels.
    const side = 'R' as const;
    out.push({ yds: d, color: ARC_COLORS[d] ?? '#fff', line: pts, label: side === 'R' ? pts[pts.length - 1] : pts[0], side });
  }
  return out;
}
