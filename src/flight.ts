// Golf-sim flyover: the shots a ball plays down a hole's line of play, and where the ball is mid-flight.
// Pure math (no map), so it can be tested.
import type { LngLat } from './types.ts';

const M_PER_DEG = 111_320;
/** Metres between two nearby points (equirectangular; fine at hole scale). */
export function metres(a: LngLat, b: LngLat) {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG;
}
export function lerpLL(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
/** Compass bearing a -> b in degrees. */
export function bearingOf(a: LngLat, b: LngLat) {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI;
}
/** Moves `m` metres from `p` at compass bearing `deg`. */
export function offset(p: LngLat, m: number, deg: number): LngLat {
  const r = (deg * Math.PI) / 180;
  const k = Math.cos((p[1] * Math.PI) / 180);
  return [p[0] + (Math.sin(r) * m) / (M_PER_DEG * k), p[1] + (Math.cos(r) * m) / M_PER_DEG];
}

export interface Shot {
  from: LngLat;
  /** Where the ball comes down. */
  land: LngLat;
  /** Where it stops after rolling. */
  to: LngLat;
  /** Total length (yards), from -> to. */
  yd: number;
  /** Carry (yards), from -> land. */
  carry: number;
  /** Peak height, metres. */
  apex: number;
  /** Sideways bend at mid-flight, metres (negative: left, a draw). */
  bend: number;
  /** Seconds in the air, and rolling. */
  air: number;
  roll: number;
  last: boolean;
}

/** Longest shot the flyover plays; a longer leg (a straight par 5) is split into equal shots. */
export const MAX_SHOT_YD = 290;
const YD = 0.9144;

/**
 * One shot per leg of the line of play (tee -> each dogleg mark -> the pin or green center), with long legs split.
 * Each ball lands a little short and rolls out to the mark.
 */
export function planShots(line: LngLat[], pin: LngLat): Shot[] {
  const pts = [...line.slice(0, -1), pin];
  // Drop marks practically on top of each other (and a dogleg sitting on the green).
  const stops: LngLat[] = [pts[0]];
  for (const p of pts.slice(1)) if (metres(stops[stops.length - 1], p) > 12) stops.push(p);
  if (stops.length === 1) stops.push(pin);
  else stops[stops.length - 1] = pin;
  const legs: [LngLat, LngLat][] = [];
  for (let i = 1; i < stops.length; i++) {
    const n = Math.max(1, Math.ceil(metres(stops[i - 1], stops[i]) / YD / MAX_SHOT_YD));
    for (let j = 0; j < n; j++) legs.push([lerpLL(stops[i - 1], stops[i], j / n), lerpLL(stops[i - 1], stops[i], (j + 1) / n)]);
  }
  return legs.map(([from, to], i) => {
    const last = i === legs.length - 1;
    const d = metres(from, to);
    // Rolls out a bit on the fairway, checks up on the green.
    const rollM = last ? Math.min(5, d * 0.04) : Math.min(16, d * 0.07);
    const land = lerpLL(from, to, (d - rollM) / Math.max(d, 1));
    const carryM = d - rollM;
    return {
      from, land, to, last,
      yd: d / YD,
      carry: carryM / YD,
      apex: Math.max(14, Math.min(34, 16 + 0.07 * carryM)),
      // A gentle draw off the tee, a little fade after, straight wedges.
      bend: carryM < 70 ? 0 : (i === 0 ? -1 : 1) * Math.min(9, carryM * 0.035),
      air: 1.9 + carryM / 115,
      roll: last ? 0.9 : 0.8,
    };
  });
}

/** Horizontal progress (0-1) of the ball after fraction `u` of its hang time: fast off the club, slowing down. */
export const flightProgress = (u: number) => 1 - Math.pow(1 - clamp01(u), 1.45);
/** Height (fraction of apex) at horizontal progress `s`: peaks past halfway, comes down steeper than it went up. */
export const flightHeight = (s: number) => Math.sin(Math.PI * Math.pow(clamp01(s), 1.3));

/** Ball position (ground point and height in metres) `u` of the way through the shot's hang time. */
export function ballInAir(shot: Shot, u: number): { at: LngLat; alt: number; s: number } {
  const s = flightProgress(u);
  const side = bearingOf(shot.from, shot.land) + 90;
  const at = offset(lerpLL(shot.from, shot.land, s), shot.bend * Math.sin(Math.PI * s), side);
  return { at, alt: shot.apex * flightHeight(s), s };
}

/** Ball position `u` of the way through its roll (slowing to a stop). */
export function ballRolling(shot: Shot, u: number): LngLat {
  const k = 1 - Math.pow(1 - clamp01(u), 2.2);
  return lerpLL(shot.land, shot.to, k);
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const smooth = (t: number) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
/** Shortest turn from bearing a to b, `t` of the way. */
export function turnTo(a: number, b: number, t: number) {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}
