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

/** Default drive length for the tee-shot crosshair (yards). Adjustable in settings. */
export const DEFAULT_DRIVE_YD = 240;
/** Once you're this far from the tee, the default crosshair goes away (you've hit). */
const LEFT_TEE_YD = 40;

/**
 * Where a drive of `yds` lands on a par 4 or 5: on the line of play at that straight-line distance from the tee
 * (or from you, while you're on the tee), moved sideways to the middle of the fairway when there's one there.
 * Null on par 3s, when the green is within reach, or once you've left the tee.
 */
export function driveTarget(h: Hole, fairways: GeoJSON.Feature<GeoJSON.Polygon>[], me: LngLat | null, yds = DEFAULT_DRIVE_YD): LngLat | null {
  if (!h.par || h.par < 4) return null;
  const tee = h.line[0];
  if (me && yd(me, tee) > LEFT_TEE_YD) return null;
  const origin = me ?? tee;
  if (yd(origin, h.center) < yds + 20) return null;
  const line = turf.lineString([...h.line.slice(0, -1), h.center]);
  const total = turf.length(line, { units: 'meters' });
  let s = 0;
  let p: LngLat | null = null;
  for (; s <= total; s += 2) {
    const q = turf.along(line, s, { units: 'meters' }).geometry.coordinates as LngLat;
    if (yd(origin, q) >= yds) { p = q; break; }
  }
  if (!p) return null;
  // Across the hole at that spot: look 60 m each side for fairway and take the middle of the stretch nearest the line.
  const ahead = turf.along(line, Math.min(total, s + 5), { units: 'meters' }).geometry.coordinates as LngLat;
  const across = turf.bearing(origin, ahead) + 90;
  const near = fairways.filter((f) => { const [w, so, e, n] = turf.bbox(f); return p![0] > w - 0.001 && p![0] < e + 0.001 && p![1] > so - 0.001 && p![1] < n + 0.001; });
  if (!near.length) return p;
  const samples: { off: number; pt: LngLat; inFw: boolean }[] = [];
  for (let off = -60; off <= 60; off += 2) {
    const pt = turf.destination(p, Math.abs(off), off < 0 ? across + 180 : across, { units: 'meters' }).geometry.coordinates as LngLat;
    samples.push({ off, pt, inFw: near.some((f) => turf.booleanPointInPolygon(pt, f)) });
  }
  // Contiguous fairway runs; pick the one closest to the line (offset 0).
  const runs: { a: number; b: number }[] = [];
  samples.forEach((x, i) => { if (!x.inFw) return; const r = runs[runs.length - 1]; if (r && r.b === i - 1) r.b = i; else runs.push({ a: i, b: i }); });
  if (!runs.length) return p;
  const dist = (r: { a: number; b: number }) => (samples[r.a].off <= 0 && samples[r.b].off >= 0 ? 0 : Math.min(Math.abs(samples[r.a].off), Math.abs(samples[r.b].off)));
  const best = runs.sort((x, y) => dist(x) - dist(y))[0];
  if (dist(best) > 30) return p;
  const midOff = (samples[best.a].off + samples[best.b].off) / 2;
  return turf.destination(p, Math.abs(midOff), midOff < 0 ? across + 180 : across, { units: 'meters' }).geometry.coordinates as LngLat;
}
