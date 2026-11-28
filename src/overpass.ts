// Course search (Nominatim / Overpass) and loading (Overpass). Results are cached by storage.ts.
import * as turf from '@turf/turf';
import { parseCourse } from './course.ts';
import type { Course, LngLat, OverpassElement } from './types.ts';
import { apiCourseHead, apiCourseFeatures } from './osmapi.ts';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** If an endpoint hasn't answered after this long, also ask the next one (first good answer wins). */
const HEDGE_MS = 8000;
const TOTAL_MS = 90000;
/** If the preferred source (Overpass or the main OSM API) hasn't answered by then, also ask the other. */
const HEDGE_SOURCE_MS = 12000;

/** The public Overpass servers are often slow, rate-limited or down, so ask them in a staggered race. */
/** `onBytes` hears how much of the answer has arrived so far (the fastest server's). */
export async function overpass(query: string, onBytes?: (n: number) => void, signal?: AbortSignal): Promise<OverpassElement[]> {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), TOTAL_MS);
  // Start with whichever server answered last time.
  let order = ENDPOINTS;
  try {
    const last = localStorage.getItem('overpass:last');
    if (last && ENDPOINTS.includes(last)) order = [last, ...ENDPOINTS.filter((e) => e !== last)];
  } catch { /* storage unavailable */ }

  const ask = async (url: string) => {
    const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal,
      // overpass-api.de refuses some hosting origins by Referer (e.g. *.pages.dev); it doesn't need one.
      referrerPolicy: 'no-referrer' });
    const text = await readText(res, onBytes);
    if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}`);
    const els = JSON.parse(text).elements as OverpassElement[];
    try { localStorage.setItem('overpass:last', url); } catch { /* ignore */ }
    return els;
  };

  try {
    return await new Promise<OverpassElement[]>((resolve, reject) => {
      let failed = 0;
      let started = 0;
      let round = 1;
      let hedge: ReturnType<typeof setTimeout> | undefined;
      const next = () => {
        if (started >= order.length) return;
        const url = order[started++];
        clearTimeout(hedge);
        hedge = setTimeout(next, HEDGE_MS);
        const myRound = round;
        ask(url).then(resolve, () => {
          if (myRound !== round) return; // a slow failure from an earlier round
          if (++failed < order.length) return next(); // failed fast: move on right away
          if (round++ >= 3) return reject(new Error("Couldn't reach OpenStreetMap (all Overpass servers busy). Try again in a minute."));
          // Every server failed: they're usually just busy, so go round again after a pause.
          failed = 0;
          started = 0;
          clearTimeout(hedge);
          hedge = setTimeout(next, 3000);
        });
      };
      ctrl.signal.addEventListener('abort', () => reject(new Error(signal?.aborted ? 'cancelled' : 'OpenStreetMap is taking too long. Try again in a minute.')));
      next();
    });
  } finally {
    clearTimeout(timer);
    ctrl.abort(); // cancel the losers
  }
}

/** Reads a response body, reporting bytes as they arrive. */
async function readText(res: Response, onBytes?: (n: number) => void): Promise<string> {
  if (!onBytes || !res.ok || !res.body) return res.text();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let n = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    out += dec.decode(value, { stream: true });
    onBytes(n);
  }
  return out + dec.decode();
}

/** Loading stages, in order, with the share of the progress bar each one gets. */
export const LOAD_STEPS = {
  find: { from: 0, to: 0.12, label: 'Finding the course' },
  download: { from: 0.12, to: 0.72, label: 'Downloading holes, hazards and trees' },
  build: { from: 0.72, to: 0.86, label: 'Building holes' },
  save: { from: 0.86, to: 1, label: 'Saving for offline' },
} as const;
export type LoadStep = keyof typeof LOAD_STEPS;
/** Progress callback: overall fraction 0..1 and the stage's text. */
export type LoadProgress = (frac: number, label: string) => void;

/** Typical course download is 0.3-3 MB and Overpass sends no length, so ease toward the end of the stage. */
export function downloadFrac(bytes: number): number {
  return 1 - Math.exp(-bytes / 900_000);
}

export function stepProgress(onProgress: LoadProgress | undefined, step: LoadStep, within = 0, extra = '') {
  if (!onProgress) return;
  const s = LOAD_STEPS[step];
  onProgress(s.from + (s.to - s.from) * Math.max(0, Math.min(1, within)), s.label + extra);
}

export const nextFrame = () => new Promise<void>((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => setTimeout(r, 0)) : setTimeout(r, 0)));

type Source<T> = { name: string; run: (signal: AbortSignal) => Promise<T> };

/**
 * Asks the preferred source first and the other one after `hedgeMs` (or right away if the first fails).
 * The first good answer wins and the other request is cancelled. The source that won is tried first next time.
 */
export async function race<T>(key: string, sources: Source<T>[], hedgeMs: number): Promise<T> {
  let order = sources;
  try {
    const last = localStorage.getItem('source:' + key);
    const i = sources.findIndex((s) => s.name === last);
    if (i > 0) order = [sources[i], ...sources.filter((_, j) => j !== i)];
  } catch { /* storage unavailable */ }
  const ctrls = order.map(() => new AbortController());
  return new Promise<T>((resolve, reject) => {
    const errors: string[] = [];
    let started = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      clearTimeout(timer);
      if (settled || started >= order.length) return;
      const i = started++;
      const src = order[i];
      timer = setTimeout(start, hedgeMs);
      src.run(ctrls[i].signal).then(
        (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctrls.forEach((c, j) => j !== i && c.abort());
          try { localStorage.setItem('source:' + key, src.name); } catch { /* ignore */ }
          resolve(v);
        },
        (e: Error) => {
          if (settled) return;
          errors.push(e.message);
          if (errors.length >= order.length) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(friendly(errors)));
          } else if (started === errors.length) start(); // nothing else running: try the next one now
        },
      );
    };
    start();
  });
}

/** One plain-language message for a set of failures. */
function friendly(errors: string[]): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return "You're offline. Courses you've opened before still work; new ones need a connection.";
  if (errors.some((e) => /not found|No holes/i.test(e))) return errors.find((e) => /not found|No holes/i.test(e))!;
  // The servers' own answers, kept short, so a problem report says what actually failed.
  const why = [...new Set(errors)].join('; ').slice(0, 140);
  return `OpenStreetMap is busy right now. Wait a minute and try again.${why ? ` (${why})` : ''}`;
}

export interface CourseHit {
  id: string; // "way/123"
  name: string;
  where?: string;
  center: LngLat;
}

/** Golf courses within `km` of a point. */
export async function coursesNear(p: LngLat, km = 25): Promise<CourseHit[]> {
  return race('near', [
    { name: 'overpass', run: (sig) => coursesNearOverpass(p, km, sig) },
    { name: 'nominatim', run: (sig) => coursesNearNominatim(p, km, sig) },
  ], 10000);
}

async function coursesNearOverpass(p: LngLat, km: number, signal: AbortSignal): Promise<CourseHit[]> {
  const els = await overpass(`[out:json][timeout:30];nwr["leisure"="golf_course"](around:${km * 1000},${p[1]},${p[0]});out tags center;`, undefined, signal);
  return els
    .filter((e) => e.type !== 'node' && e.tags?.name)
    .map((e: any) => ({ id: `${e.type}/${e.id}`, name: e.tags.name, center: [e.center.lon, e.center.lat] as LngLat }))
    .sort((a, b) => turf.distance(p, a.center) - turf.distance(p, b.center));
}

/** Golf courses in a box around a point, from Nominatim (fallback when Overpass is busy). */
async function coursesNearNominatim(p: LngLat, km: number, signal: AbortSignal): Promise<CourseHit[]> {
  const dLat = km / 111, dLon = km / (111 * Math.cos((p[1] * Math.PI) / 180));
  const box = [p[0] - dLon, p[1] + dLat, p[0] + dLon, p[1] - dLat].map((v) => v.toFixed(4)).join(',');
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=40&q=golf+course&viewbox=${box}&bounded=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`Nominatim: HTTP ${res.status}`);
  const rows: any[] = await res.json();
  return rows
    .filter((r) => r.type === 'golf_course' && (r.osm_type === 'way' || r.osm_type === 'relation') && r.name)
    .map((r) => ({ id: `${r.osm_type}/${r.osm_id}`, name: r.name, center: [+r.lon, +r.lat] as LngLat }))
    .sort((a, b) => turf.distance(p, a.center) - turf.distance(p, b.center));
}

/** Search by name using Nominatim (OSM's geocoder). */
export async function searchCourses(q: string): Promise<CourseHit[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&q=${encodeURIComponent(q + ' golf')}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const rows: any[] = await res.json();
  return rows
    .filter((r) => r.type === 'golf_course' && (r.osm_type === 'way' || r.osm_type === 'relation'))
    .map((r) => ({ id: `${r.osm_type}/${r.osm_id}`, name: r.name || r.display_name.split(',')[0], where: r.display_name.split(',').slice(1, 4).join(',').trim(), center: [+r.lon, +r.lat] as LngLat }));
}

/** Fetch a course boundary, then every golf feature in (and slightly around) it. */
export async function loadCourse(id: string, fallbackName?: string, onProgress?: LoadProgress): Promise<Course> {
  const [type, osmId] = id.split('/');
  stepProgress(onProgress, 'find');
  const c = await race('course', [
    { name: 'overpass', run: async (sig) => (await overpass(`[out:json][timeout:30];${type}(${osmId});out geom tags bb;`, undefined, sig))[0] },
    { name: 'osm-api', run: (sig) => apiCourseHead(type, osmId, sig) },
  ], HEDGE_SOURCE_MS);
  if (!c) throw new Error('Course not found in OpenStreetMap');
  const boundary = boundaryOf(c);
  const b = c.bounds!;
  const pad = 0.0015; // ~150 m, catches tees/greens drawn just outside the boundary
  const bbox = `${b.minlat - pad},${b.minlon - pad},${b.maxlat + pad},${b.maxlon + pad}`;
  stepProgress(onProgress, 'download');
  const mb = (n: number) => ` (${(n / 1e6).toFixed(1)} MB)`;
  // Golf features plus the scenery around them (trees, woods, buildings, paths, streams) for the map view.
  const onBytes = (n: number) => stepProgress(onProgress, 'download', downloadFrac(n), mb(n));
  const query = `[out:json][timeout:90];(
    nwr["golf"](${bbox});
    nwr["natural"~"^(water|wood|scrub|heath|wetland|tree_row)$"](${bbox});
    node["natural"="tree"](${bbox});
    nwr["landuse"="forest"](${bbox});
    way["building"](${bbox});
    way["highway"](${bbox});
    way["waterway"~"^(stream|river|ditch|drain|canal)$"](${bbox});
  );out geom;`;
  const [s, w, n, e] = [b.minlat - pad, b.minlon - pad, b.maxlat + pad, b.maxlon + pad];
  const els = await race('course', [
    { name: 'overpass', run: (sig) => overpass(query, onBytes, sig) },
    { name: 'osm-api', run: (sig) => apiCourseFeatures(s, w, n, e, sig, onBytes) },
  ], HEDGE_SOURCE_MS);
  stepProgress(onProgress, 'build');
  await nextFrame(); // let the bar paint before the parse blocks the page
  const course = parseCourse(els, { id, name: c.tags?.name ?? fallbackName ?? 'Golf course', boundary });
  // No holes mapped yet: still return the course (framed on its boundary) so it can be mapped in the app.
  if (!course.holes.length) course.bbox = [b.minlon, b.minlat, b.maxlon, b.maxlat];
  return course;
}

function boundaryOf(c: OverpassElement): LngLat[][][] | undefined {
  if (c.type === 'way' && c.geometry) return [[c.geometry.map((p) => [p.lon, p.lat] as LngLat)]];
  return undefined; // relation boundaries: fall back to bbox only
}
