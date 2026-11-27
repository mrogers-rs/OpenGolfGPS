// Course edits made in the app: tees, greens, doglegs, par and hazards drawn on the satellite photo.
// They sit on top of the OpenStreetMap data (which is never changed) and can be exported as a JSON
// course file. Course files bundled in src/courses/ are used on every device.
import * as turf from '@turf/turf';
import type { Course, Hole, LngLat } from './types.ts';

/** Outlined shapes: hazards (bunker, water) and woods / groups of trees. */
export type HazardKind = 'bunker' | 'water' | 'wood';

export interface HoleEdit {
  par?: number;
  /** Where you tee off. */
  tee?: LngLat;
  /** Aiming points between tee and green (dogleg corners). An empty list means "straight at the green". */
  dogleg?: LngLat[];
  /** Green outline, closed ring. */
  green?: LngLat[];
}

export interface HazardEdit {
  id: string;
  kind: HazardKind;
  /** Outline, closed ring. */
  ring: LngLat[];
}

export interface TreeEdit {
  id: string;
  at: LngLat;
}

export interface CourseEdits {
  /** File format version. */
  format: 1;
  /** OSM id of the course these edits apply to, e.g. "relation/2342674". */
  courseId: string;
  name: string;
  updatedAt: number;
  holes: Record<string, HoleEdit>;
  hazards: HazardEdit[];
  /** Single trees (tapped). Woods are outlined shapes in `hazards` with kind "wood". */
  trees?: TreeEdit[];
}

export const emptyEdits = (courseId: string, name: string): CourseEdits => ({ format: 1, courseId, name, updatedAt: Date.now(), holes: {}, hazards: [] });

/** Closes a ring of tapped points (first point repeated at the end). */
export function closeRing(pts: LngLat[]): LngLat[] {
  if (pts.length < 3) return pts.slice();
  const [a, b] = [pts[0], pts[pts.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? pts.slice() : [...pts, a];
}

const r7 = (x: number) => Math.round(x * 1e7) / 1e7;
export const roundPt = (p: LngLat): LngLat => [r7(p[0]), r7(p[1])];

/** Hole numbers the editor offers: the mapped ones, the edited ones, and 1-18. */
export function editableRefs(base: Course, edits: CourseEdits | null, min = 18): number[] {
  const s = new Set<number>(base.holes.map((h) => h.ref));
  for (const k of Object.keys(edits?.holes ?? {})) s.add(Number(k));
  for (let i = 1; i <= min; i++) s.add(i);
  return [...s].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
}

/**
 * The course with edits applied. A hole needs a tee and a green (from either source) to be playable;
 * holes still missing one are left out until they're finished.
 */
export function applyEdits(base: Course, edits: CourseEdits | null): Course {
  if (!edits) return base;
  const byRef = new Map<number, Hole>(base.holes.map((h) => [h.ref, h]));
  const replacedGreens = new Set<string>();
  const ringKey = (r: LngLat[]) => r.map((p) => p.join(',')).join(';');
  const refs = new Set<number>([...byRef.keys(), ...Object.keys(edits.holes).map(Number)]);
  const holes: Hole[] = [];
  for (const ref of [...refs].sort((a, b) => a - b)) {
    const old = byRef.get(ref);
    const e = edits.holes[String(ref)];
    if (!e) { if (old) holes.push(old); continue; }
    const greenRing = e.green && e.green.length >= 4 ? e.green : old?.green;
    if (e.green && old?.green) replacedGreens.add(ringKey(old.green));
    const center: LngLat | undefined = e.green && e.green.length >= 4 ? (turf.centerOfMass(turf.polygon([e.green])).geometry.coordinates as LngLat) : old?.center;
    const tee = e.tee ?? old?.line[0];
    if (!tee || !center) continue; // not finished yet
    const mid = e.dogleg ?? old?.line.slice(1, -1) ?? [];
    const line: LngLat[] = [tee, ...mid, center];
    const pin = old?.pin && greenRing && turf.booleanPointInPolygon(old.pin, turf.polygon([greenRing])) ? old.pin : undefined;
    holes.push({ ref, par: e.par ?? old?.par, handicap: old?.handicap, line, green: greenRing, center, pin });
  }

  const editedRefs = new Set(Object.keys(edits.holes).map(Number));
  const features: GeoJSON.Feature[] = base.features.features.filter((f) => {
    const k = f.properties?.kind;
    if (k === 'hole' && editedRefs.has(Number(f.properties?.ref))) return false;
    if (k === 'green' && f.geometry.type === 'Polygon' && replacedGreens.has(ringKey((f.geometry as GeoJSON.Polygon).coordinates[0] as LngLat[]))) return false;
    return true;
  });
  for (const h of holes) {
    if (!editedRefs.has(h.ref)) continue;
    features.push(turf.lineString(h.line, { kind: 'hole', ref: h.ref }));
    const e = edits.holes[String(h.ref)];
    if (e.green && e.green.length >= 4) features.push(turf.polygon([e.green], { kind: 'green', edited: true }));
  }
  for (const z of edits.hazards) if (z.ring.length >= 4) features.push(turf.polygon([z.ring], { kind: z.kind, edited: true, hid: z.id }));
  for (const t of edits.trees ?? []) features.push(turf.point(t.at, { kind: 'tree', edited: true, hid: t.id }));

  const fc = turf.featureCollection(features);
  const bbox = holes.length ? (turf.bbox(turf.featureCollection(holes.map((h) => turf.lineString(h.line)))) as Course['bbox']) : base.bbox;
  return { ...base, holes, features: fc, bbox };
}

/** Checks a course file someone is importing; throws with a readable message if it isn't one. */
export function parseEditsFile(text: string): CourseEdits {
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error("That file isn't a course file (not JSON)."); }
  if (!j || j.format !== 1 || typeof j.courseId !== 'string' || typeof j.holes !== 'object' || !Array.isArray(j.hazards)) {
    throw new Error("That file isn't an OpenGolfGPS course file.");
  }
  const pt = (p: any) => Array.isArray(p) && p.length === 2 && p.every((x: any) => typeof x === 'number' && Number.isFinite(x));
  for (const [k, h] of Object.entries<any>(j.holes)) {
    if (!(Number(k) > 0)) throw new Error(`Bad hole number ${k}.`);
    if (h.tee && !pt(h.tee)) throw new Error(`Hole ${k}: bad tee.`);
    if (h.green && !(Array.isArray(h.green) && h.green.every(pt))) throw new Error(`Hole ${k}: bad green.`);
    if (h.dogleg && !(Array.isArray(h.dogleg) && h.dogleg.every(pt))) throw new Error(`Hole ${k}: bad dogleg.`);
  }
  for (const z of j.hazards) if (!(z && (z.kind === 'bunker' || z.kind === 'water' || z.kind === 'wood') && Array.isArray(z.ring) && z.ring.every(pt))) throw new Error('Bad shape in file.');
  if (j.trees != null && !(Array.isArray(j.trees) && j.trees.every((t: any) => t && typeof t.id === 'string' && pt(t.at)))) throw new Error('Bad tree in file.');
  return j as CourseEdits;
}

/** How far along the mapping is, for the editor and the course list. */
export function progressOf(course: Course, refs: number[]) {
  const done = refs.filter((r) => course.holes.some((h) => h.ref === r && h.green)).length;
  return { done, total: refs.length };
}
