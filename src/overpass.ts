// Course search (Nominatim / Overpass) and loading (Overpass). Results are cached by storage.ts.
import * as turf from '@turf/turf';
import { parseCourse } from './course.ts';
import type { Course, LngLat, OverpassElement } from './types.ts';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
/** If an endpoint hasn't answered after this long, also ask the next one (first good answer wins). */
const HEDGE_MS = 8000;
const TOTAL_MS = 90000;

/** The public Overpass servers are often slow, rate-limited or down, so ask them in a staggered race. */
/** `onBytes` hears how much of the answer has arrived so far (the fastest server's). */
export async function overpass(query: string, onBytes?: (n: number) => void): Promise<OverpassElement[]> {
  const ctrl = new AbortController();
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
      ctrl.signal.addEventListener('abort', () => reject(new Error('OpenStreetMap is taking too long. Try again in a minute.')));
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
  save: { from: 0.86, to: 0.9, label: 'Saving for offline' },
  scenery: { from: 0.9, to: 1, label: 'Building 3D scenery' },
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

export interface CourseHit {
  id: string; // "way/123"
  name: string;
  where?: string;
  center: LngLat;
}

/** Golf courses within `km` of a point. */
export async function coursesNear(p: LngLat, km = 25): Promise<CourseHit[]> {
  const els = await overpass(`[out:json][timeout:30];nwr["leisure"="golf_course"](around:${km * 1000},${p[1]},${p[0]});out tags center;`);
  return els
    .filter((e) => e.type !== 'node' && e.tags?.name)
    .map((e: any) => ({ id: `${e.type}/${e.id}`, name: e.tags.name, center: [e.center.lon, e.center.lat] as LngLat }))
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
  const head = await overpass(`[out:json][timeout:30];${type}(${osmId});out geom tags bb;`);
  const c = head[0];
  if (!c) throw new Error('Course not found in OpenStreetMap');
  const boundary = boundaryOf(c);
  const b = c.bounds!;
  const pad = 0.0015; // ~150 m, catches tees/greens drawn just outside the boundary
  const bbox = `${b.minlat - pad},${b.minlon - pad},${b.maxlat + pad},${b.maxlon + pad}`;
  stepProgress(onProgress, 'download');
  const mb = (n: number) => ` (${(n / 1e6).toFixed(1)} MB)`;
  // Golf features plus the scenery around them (trees, woods, buildings, paths, streams) for the map view.
  const els = await overpass(`[out:json][timeout:90];(
    nwr["golf"](${bbox});
    nwr["natural"~"^(water|wood|scrub|heath|wetland|tree_row)$"](${bbox});
    node["natural"="tree"](${bbox});
    nwr["landuse"="forest"](${bbox});
    way["building"](${bbox});
    way["highway"](${bbox});
    way["waterway"~"^(stream|river|ditch|drain|canal)$"](${bbox});
  );out geom;`, (n) => stepProgress(onProgress, 'download', downloadFrac(n), mb(n)));
  stepProgress(onProgress, 'build');
  await nextFrame(); // let the bar paint before the parse blocks the page
  const course = parseCourse(els, { id, name: c.tags?.name ?? fallbackName ?? 'Golf course', boundary });
  if (!course.holes.length) throw new Error('No holes are mapped for this course in OpenStreetMap yet');
  return course;
}

function boundaryOf(c: OverpassElement): LngLat[][][] | undefined {
  if (c.type === 'way' && c.geometry) return [[c.geometry.map((p) => [p.lon, p.lat] as LngLat)]];
  return undefined; // relation boundaries: fall back to bbox only
}
