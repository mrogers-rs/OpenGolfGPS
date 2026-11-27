// Decides when to move to the next hole automatically.
import * as turf from '@turf/turf';
import type { Hole, LngLat } from './types.ts';
import { yd } from './yardage.ts';

/** You're "on the next tee" when within this many yards of its tee. */
export const TEE_RADIUS_YD = 35;
/** Snap to a hole at start-up if you're this close to its tee. */
export const START_RADIUS_YD = 50;

/** Distance in yards from a point to the hole's green edge (0 if inside), or to its center if no green. */
export function ydToGreen(hole: Hole, p: LngLat) {
  if (!hole.green) return yd(p, hole.center);
  const poly = turf.polygon([hole.green]);
  if (turf.booleanPointInPolygon(p, poly)) return 0;
  return turf.pointToLineDistance(p, turf.lineString(hole.green), { units: 'meters' }) * 1.0936133;
}

/**
 * Returns the index to switch to, or null to stay.
 * Moves on one hole when you're within TEE_RADIUS_YD of the next hole's tee, unless you're still
 * on the current green (some greens sit right beside the next tee).
 * Manual override: whatever hole you pick by hand becomes `current`, and this keeps working from there.
 */
export function autoAdvance(holes: Hole[], current: number, p: LngLat): number | null {
  const next = holes[current + 1];
  if (!next) return null;
  const toNextTee = yd(p, next.line[0]);
  if (toNextTee > TEE_RADIUS_YD) return null;
  const toGreen = ydToGreen(holes[current], p);
  if (toGreen < 5 && toGreen < toNextTee) return null; // still putting out
  return current + 1;
}

/** At start-up: the hole whose tee you're standing near, if any. */
export function holeAtStart(holes: Hole[], p: LngLat): number | null {
  let best: number | null = null;
  let bestD = START_RADIUS_YD;
  holes.forEach((h, i) => {
    const d = yd(p, h.line[0]);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
