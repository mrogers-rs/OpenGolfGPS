// Course search by name, made forgiving.
//
// OpenStreetMap's search (Nominatim) only returns places whose name or address holds every word typed,
// so "Union Hills golf course Sun City" finds nothing: the course is mapped as "Union Hills Country Club".
// So we:
//   1. ask for the words as typed, then with filler words ("golf", "course", "in"...) dropped;
//   2. list the golf courses around you (or the course open now) and keep those whose name shares a word;
//   3. try the name with "country club", "golf club" and "golf course" on the end;
//   4. list the courses around the place the words point at (a town, a road) the same way.
// Only golf courses are kept, so roads and hills named alike drop out. Results are ranked by how many words
// match, then by distance from you.
import type { LngLat } from './types.ts';
import type { CourseHit } from './overpass.ts';

/** Words that say "golf course" or join a name to a town. They don't help find the course. */
const FILLER = new Set([
  'golf', 'course', 'courses', 'club', 'clubs', 'country', 'cc', 'gc', 'g.c.', 'c.c.', 'links', 'resort',
  'the', 'at', 'in', 'near', 'of', 'and', '&', 'az', 'arizona',
]);
/** How far around a point to look for courses (km, half the box width). */
const AROUND_KM = 15;
/** Nominatim allows one request a second. */
const GAP_MS = 1100;

export type FetchJson = (url: string) => Promise<any[]>;

const NOMINATIM = 'https://nominatim.openstreetmap.org/search?format=jsonv2';

/** Lower-case words of a query or name, punctuation stripped. */
export function words(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N}&\s]+/gu, ' ').split(/\s+/).filter(Boolean);
}

/** The words that could be part of a course's name or town. */
export function coreWords(q: string): string[] {
  const all = words(q);
  const core = all.filter((w) => !FILLER.has(w));
  return core.length ? core : all;
}

/** How many of the query words appear in the course name (a word may be the start of a name word: "pebble" → "Pebblebrook"). */
export function score(name: string, query: string[]): number {
  const nw = words(name);
  return query.filter((q) => nw.some((w) => w === q || (q.length >= 4 && w.startsWith(q)))).length;
}

function km(a: LngLat, b: LngLat): number {
  const x = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const y = b[1] - a[1];
  return Math.hypot(x, y) * 111.2;
}

function toHit(r: any): CourseHit {
  const parts = String(r.display_name ?? '').split(',');
  return {
    id: `${r.osm_type}/${r.osm_id}`,
    name: r.name || parts[0],
    where: parts.slice(1, 4).join(',').trim(),
    center: [+r.lon, +r.lat],
  };
}

const isCourse = (r: any) => r.type === 'golf_course' && (r.osm_type === 'way' || r.osm_type === 'relation');

function boxAround(p: LngLat, k = AROUND_KM): string {
  const dLat = k / 111, dLon = k / (111 * Math.cos((p[1] * Math.PI) / 180));
  return [p[0] - dLon, p[1] + dLat, p[0] + dLon, p[1] - dLat].map((v) => v.toFixed(4)).join(',');
}

async function defaultFetch(url: string): Promise<any[]> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  return res.json();
}

/**
 * Golf courses matching a typed name, best first.
 * `near` is where you are (or the course on screen), so nearby courses are found by part of their name.
 */
export async function searchCourses(
  q: string,
  near?: LngLat | null,
  get: FetchJson = defaultFetch,
  gapMs = GAP_MS,
): Promise<CourseHit[]> {
  const typed = words(q);
  const core = coreWords(q);
  if (!typed.length) return [];

  let last = 0;
  const ask = async (url: string) => {
    const wait = last + gapMs - Date.now();
    if (last && wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return get(url);
  };

  const found = new Map<string, { hit: CourseHit; s: number; d: number }>();
  const add = (r: any, from?: LngLat) => {
    const hit = toHit(r);
    const s = score(hit.name, core);
    const d = from ? km(from, hit.center) : near ? km(near, hit.center) : 0;
    const had = found.get(hit.id);
    if (!had || d < had.d) found.set(hit.id, { hit, s, d });
  };
  // Enough courses that match every word: stop asking. One isn't enough, as names repeat ("Westbrook").
  const full = () => [...found.values()].filter((f) => f.s === core.length).length;
  const done = () => full() >= 5;

  // 1. The words as typed, then without the filler words.
  const places: LngLat[] = [];
  const byName = async (text: string) => {
    const rows = await ask(`${NOMINATIM}&limit=20&q=${encodeURIComponent(text)}`);
    for (const r of rows) {
      if (isCourse(r)) add(r);
      else if (r.lat && r.lon) places.push([+r.lon, +r.lat]);
    }
  };
  const tried = new Set<string>();
  const tryName = async (text: string) => {
    if (tried.has(text) || done()) return;
    tried.add(text);
    await byName(text);
  };
  await tryName(typed.join(' '));
  await tryName(core.join(' '));

  // 2. Courses around you, matched by name words ("Union Hills" → "Union Hills Country Club").
  const around = async (a: LngLat) => {
    const rows = await ask(`${NOMINATIM}&limit=40&q=golf+course&viewbox=${boxAround(a)}&bounded=1`);
    const courses = rows.filter(isCourse);
    for (const r of courses) if (score(toHit(r).name, core) > 0) add(r, a);
    return courses;
  };
  if (near) await around(near);

  // 3. The name with the usual endings courses are mapped with.
  for (const end of ['country club', 'golf club', 'golf course']) await tryName(`${core.join(' ')} ${end}`);

  // 4. No full match yet: courses around the first two places the words point at (a town, a road).
  if (!full()) {
    const anchors: LngLat[] = near ? [near] : [];
    const from = anchors.length;
    for (const p of places) {
      if (anchors.length >= from + 2) break;
      if (!anchors.some((a) => km(a, p) < AROUND_KM)) anchors.push(p);
    }
    let placeOnly: { hit: CourseHit; d: number }[] = [];
    for (const a of anchors.slice(from)) {
      const courses = await around(a);
      // A town typed on its own ("Peoria"): keep its courses in case no name matches.
      if (!placeOnly.length) placeOnly = courses.map((r) => ({ hit: toHit(r), d: km(a, toHit(r).center) }));
      if (full()) break;
    }
    if (!found.size && placeOnly.length) return placeOnly.sort((x, y) => x.d - y.d).map((x) => x.hit);
  }

  return [...found.values()]
    .filter((f) => f.s > 0) // matched only by address, like a club on "Union Street": not what was asked for
    .sort((x, y) => y.s - x.s || x.d - y.d)
    .slice(0, 15)
    .map((f) => f.hit);
}
