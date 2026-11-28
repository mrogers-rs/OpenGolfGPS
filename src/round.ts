// A round: scorecard, today's pin positions and pace of play. Pure logic, no DOM.
import type { Course, LngLat } from './types.ts';

export type Fairway = 'hit' | 'left' | 'right';

export interface HoleScore {
  strokes?: number;
  putts?: number;
  /** Tee shot result on par 4s and 5s. */
  fairway?: Fairway;
  penalties?: number;
  sand?: number;
  /** Green in regulation as you marked it. Unset = worked out from strokes and putts. */
  gir?: boolean;
  /** Today's pin, placed in green view. */
  pin?: LngLat;
  /** When you got to this hole (first time it was shown during the round). */
  arrived?: number;
}

export interface Round {
  id: string;
  courseId: string;
  courseName: string;
  startedAt: number;
  finishedAt?: number;
  /** Index of the hole the round started on (for shotgun / back-nine starts). */
  startHole: number;
  /** Target round length in minutes (pace of play). */
  paceTarget: number;
  /** Keyed by hole ref. */
  holes: Record<number, HoleScore>;
  pars: Record<number, number>;
}

/** Default target for 18 holes. (Guess: 4h15.) */
export const DEFAULT_PACE_MIN = 255;

export function newRound(course: Course, startHole = 0, paceTarget = DEFAULT_PACE_MIN, now = Date.now()): Round {
  const pars: Record<number, number> = {};
  for (const h of course.holes) if (h.par) pars[h.ref] = h.par;
  return { id: 'r' + now.toString(36), courseId: course.id, courseName: course.name, startedAt: now, startHole, paceTarget, holes: {}, pars };
}

// ---------- Score ----------

export interface Totals {
  holes: number;
  strokes: number;
  par: number;
  toPar: number;
  putts: number;
  puttsHoles: number;
  fairways: number;
  fairwayChances: number;
  gir: number;
  girChances: number;
  penalties: number;
  /** Up-and-down saves: missed green in regulation but made par or better. */
  scrambles: number;
  scrambleChances: number;
  sandSaves: number;
  sandChances: number;
  /** Counts of eagles-or-better, birdies, pars, bogeys, doubles-or-worse. */
  dist: { eagle: number; birdie: number; par: number; bogey: number; double: number };
  /** Scoring average by par. */
  byPar: Record<number, { n: number; strokes: number }>;
}

/** Green in regulation: on the green with par-2 strokes or fewer (needs putts). */
export function isGir(score: HoleScore, par: number): boolean | undefined {
  if (score.gir != null) return score.gir;
  if (score.strokes == null || score.putts == null) return undefined;
  return score.strokes - score.putts <= par - 2;
}

export function totals(r: Round, refs?: number[]): Totals {
  const t: Totals = {
    holes: 0, strokes: 0, par: 0, toPar: 0, putts: 0, puttsHoles: 0, fairways: 0, fairwayChances: 0, gir: 0, girChances: 0,
    penalties: 0, scrambles: 0, scrambleChances: 0, sandSaves: 0, sandChances: 0,
    dist: { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0 }, byPar: {},
  };
  const keys = refs ?? Object.keys(r.holes).map(Number);
  for (const ref of keys) {
    const s = r.holes[ref];
    const par = r.pars[ref];
    if (!s || s.strokes == null || !par) continue;
    t.holes++;
    t.strokes += s.strokes;
    t.par += par;
    const diff = s.strokes - par;
    if (diff <= -2) t.dist.eagle++; else if (diff === -1) t.dist.birdie++; else if (diff === 0) t.dist.par++; else if (diff === 1) t.dist.bogey++; else t.dist.double++;
    (t.byPar[par] ??= { n: 0, strokes: 0 });
    t.byPar[par].n++;
    t.byPar[par].strokes += s.strokes;
    if (s.putts != null) { t.putts += s.putts; t.puttsHoles++; }
    if (par >= 4 && s.fairway) { t.fairwayChances++; if (s.fairway === 'hit') t.fairways++; }
    t.penalties += s.penalties ?? 0;
    const gir = isGir(s, par);
    if (gir != null) {
      t.girChances++;
      if (gir) t.gir++;
      else { t.scrambleChances++; if (diff <= 0) t.scrambles++; }
    }
    if (s.sand) { t.sandChances++; if (diff <= 0) t.sandSaves++; }
  }
  t.toPar = t.strokes - t.par;
  return t;
}

/** Name for a score relative to par (Ace for a hole in one). */
export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return 'Ace';
  const d = strokes - par;
  return d <= -3 ? 'Albatross' : d === -2 ? 'Eagle' : d === -1 ? 'Birdie' : d === 0 ? 'Par' : d === 1 ? 'Bogey' : d === 2 ? 'Double' : d === 3 ? 'Triple' : '+' + d;
}

/** CSS class for a score relative to par. */
export const scoreClass = (d: number) => (d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'double');

export const fmtToPar = (n: number) => (n === 0 ? 'E' : n > 0 ? '+' + n : String(n));
export const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) + '%' : '–');

// ---------- Pace of play ----------

/** Minutes allotted per hole by par, scaled so the course adds up to the round target. */
export function holeAllotments(course: Course, target: number): number[] {
  const base = course.holes.map((h) => (h.par === 3 ? 11 : h.par === 5 ? 17 : 14)); // relative weights (guess)
  const sum = base.reduce((a, b) => a + b, 0);
  // Target is for 18 holes; a 9-hole course gets half.
  const scaledTarget = (target * course.holes.length) / 18;
  return base.map((b) => (b * scaledTarget) / sum);
}

export interface Pace {
  /** Minutes since the round started. */
  elapsed: number;
  /** Minutes behind (+) or ahead (-) of pace; 0 = on pace. */
  delta: number;
  /** Minutes you've been on the current hole. */
  onHole: number;
}

/**
 * You're on pace while the clock is inside the current hole's window
 * (expected start of this hole .. expected end of this hole).
 */
export function pace(r: Round, course: Course, holeIndex: number, now = Date.now()): Pace {
  const allot = holeAllotments(course, r.paceTarget);
  const n = course.holes.length;
  // Holes played before this one, counting from the starting hole (wraps for back-nine starts).
  const played = (holeIndex - r.startHole + n) % n;
  let expStart = 0;
  for (let k = 0; k < played; k++) expStart += allot[(r.startHole + k) % n];
  const expEnd = expStart + allot[holeIndex];
  const elapsed = (now - r.startedAt) / 60000;
  const delta = elapsed > expEnd ? elapsed - expEnd : elapsed < expStart ? elapsed - expStart : 0;
  const arrived = r.holes[course.holes[holeIndex].ref]?.arrived;
  return { elapsed, delta, onHole: arrived ? (now - arrived) / 60000 : 0 };
}

export const fmtClock = (min: number) => `${Math.floor(min / 60)}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
