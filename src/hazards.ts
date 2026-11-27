// Hazard (bunker / water) reach and carry numbers, and layup markers along the line of play.
import * as turf from '@turf/turf';
import type { Course, Hole, LngLat } from './types.ts';
import { yd } from './yardage.ts';

const YD_TO_M = 0.9144;
/** A hazard counts as "in play" if any of it is within this many yards of the line of play. (Guess.) */
export const CORRIDOR_YD = 35;
/** Greenside hazards: anything within this many yards of the green edge. */
export const GREENSIDE_YD = 12;
/** Hide hazards you're already past or standing in. */
const BEHIND_YD = 5;
/** Ignore fairway hazards you'd carry with any shot (e.g. beside the tee box). */
const MIN_CARRY_YD = 40;

export type HazardKind = 'bunker' | 'water';

export interface HazardNumbers {
  kind: HazardKind;
  /** Yards to the near edge (reach) and far edge (carry), along your line. */
  reach: number;
  carry: number;
  side: 'L' | 'R' | 'C';
  /** Point to draw the label at (centroid of the in-play part). */
  at: LngLat;
  greenside: boolean;
}

/** Bunker and water polygons on the course (drawable features with kind bunker/water). */
export function hazardPolys(course: Course): { kind: HazardKind; poly: GeoJSON.Feature<GeoJSON.Polygon> }[] {
  const out: { kind: HazardKind; poly: GeoJSON.Feature<GeoJSON.Polygon> }[] = [];
  for (const f of course.features.features) {
    const k = f.properties?.kind;
    if ((k === 'bunker' || k === 'water') && f.geometry.type === 'Polygon') out.push({ kind: k, poly: f as GeoJSON.Feature<GeoJSON.Polygon> });
  }
  return out;
}

/**
 * The line of play from where you are: you -> rest of the hole -> green center.
 * Without a usable position, it's the whole hole from the tee.
 */
export function playLine(hole: Hole, from: LngLat | null): LngLat[] {
  const line = [...hole.line.slice(0, -1), hole.center];
  if (!from) return line;
  const ls = turf.lineString(line);
  const snap = turf.nearestPointOnLine(ls, from);
  const idx = snap.properties.index ?? 0;
  const rest = line.slice(idx + 1);
  // Snapped to the very end (e.g. standing behind the green): just you -> green center.
  return [from, ...(rest.length ? rest : [hole.center])];
}

/** Distance along a polyline (yards) to the point on it nearest p, and how far off the line p is. */
function along(line: LngLat[], p: LngLat) {
  const ls = turf.lineString(line);
  const snap = turf.nearestPointOnLine(ls, p, { units: 'meters' });
  return { at: (snap.properties.location ?? 0) / YD_TO_M, off: (snap.properties.dist ?? 0) / YD_TO_M, snap: snap.geometry.coordinates as LngLat, index: snap.properties.index ?? 0 };
}

/**
 * Reach/carry for every bunker or water hazard in play on this hole, nearest first.
 * `player` should be null when GPS isn't usable for this hole (numbers are then from the tee, along the line).
 */
export function hazardNumbers(course: Course, hole: Hole, player: LngLat | null): HazardNumbers[] {
  const line = playLine(hole, player);
  const lineYd = turf.length(turf.lineString(line), { units: 'meters' }) / YD_TO_M;
  const greenRing = hole.green ? turf.lineString(hole.green) : null;
  // Cheap pre-filter: only hazards whose box touches the line's box (padded by the corridor).
  const pad = (CORRIDOR_YD * YD_TO_M) / 111000;
  const [w, s, e, n] = turf.bbox(turf.lineString(line));
  const res: HazardNumbers[] = [];
  for (const { kind, poly } of hazardPolys(course)) {
    const [hw, hs, he, hn] = turf.bbox(poly);
    if (he < w - pad * 2 || hw > e + pad * 2 || hn < s - pad || hs > n + pad) continue;
    if (player && turf.booleanPointInPolygon(player, poly)) continue;
    const ring = densify(poly.geometry.coordinates[0] as LngLat[]);
    const greenside = !!greenRing && ring.some((p) => turf.pointToLineDistance(p, greenRing, { units: 'meters' }) / YD_TO_M <= GREENSIDE_YD);
    // The part of the hazard near the line of play (or all of it, for greenside hazards).
    const pos = ring.map((p) => ({ p, ...along(line, p) }));
    // Fairway hazards: near the line and between you and the green. Greenside: all of it.
    const inPlay = pos.filter((q) => greenside || (q.off <= CORRIDOR_YD && q.at >= 0 && q.at < lineYd));
    if (!inPlay.length) continue;
    const far = Math.max(...inPlay.map((q) => q.at));
    if (far < BEHIND_YD) continue; // already past it
    if (!greenside && far < MIN_CARRY_YD) continue; // right beside you (usually another hole's, by the tee)
    // GPS: straight-line yards from you. From the tee: yards along the line of play.
    const dists = inPlay.map((q) => (player ? yd(player, q.p) : q.at));
    const at = turf.centroid(turf.multiPoint(inPlay.map((q) => q.p))).geometry.coordinates as LngLat;
    res.push({ kind, reach: Math.min(...dists), carry: Math.max(...dists), side: sideOf(line, at), at, greenside });
  }
  return res.sort((a, b) => a.reach - b.reach);
}

/** Extra points every ~5 m along the ring so long thin hazards still hit the corridor. */
function densify(ring: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    const n = Math.max(1, Math.ceil(turf.distance(a, b, { units: 'meters' }) / 5));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Left/right of the line of play, looking toward the green. */
function sideOf(line: LngLat[], p: LngLat): 'L' | 'R' | 'C' {
  const { index, off } = along(line, p);
  if (off < 8) return 'C';
  const a = line[Math.min(index, line.length - 2)];
  const b = line[Math.min(index, line.length - 2) + 1];
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return cross > 0 ? 'L' : 'R';
}

export interface LayupMark {
  /** Yards to the green center from this spot (straight line). */
  toGreen: number;
  at: LngLat;
}

/** Standard layup distances from the green center. (Guess: 100/150/200/250.) */
export const LAYUPS = [100, 150, 200, 250];

/**
 * Spots on the line of play that are a round number of yards (straight line) from the green center.
 * Only spots ahead of `from` (you, or the tee) are returned.
 */
export function layupMarks(hole: Hole, from: LngLat | null, distances = LAYUPS): LayupMark[] {
  const line = playLine(hole, from);
  const ls = turf.lineString(line);
  const total = turf.length(ls, { units: 'meters' });
  const out: LayupMark[] = [];
  for (const d of distances) {
    // Walk back from the green until the straight-line distance to center reaches d.
    let found: LngLat | null = null;
    for (let m = total; m >= 0; m -= 2) {
      const p = turf.along(ls, m, { units: 'meters' }).geometry.coordinates as LngLat;
      if (yd(p, hole.center) >= d) { found = p; break; }
    }
    if (!found) continue;
    if (from && yd(from, found) < 15) continue; // right where you're standing
    out.push({ toGreen: d, at: found });
  }
  return out;
}
