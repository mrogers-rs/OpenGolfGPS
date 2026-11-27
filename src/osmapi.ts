// Fallback source for course data: the main OpenStreetMap API (api.openstreetmap.org).
// The public Overpass servers are often busy; the main API answers small bounding-box requests quickly.
// Its answers are converted to the same shape Overpass gives with `out geom`, so parseCourse works unchanged.
import type { OverpassElement } from './types.ts';

const API = 'https://api.openstreetmap.org/api/0.6';

interface ApiNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
interface ApiWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string> }
interface ApiRel { type: 'relation'; id: number; members: { type: string; ref: number; role: string }[]; tags?: Record<string, string> }
type ApiEl = ApiNode | ApiWay | ApiRel;

const NATURAL = /^(water|wood|scrub|heath|wetland|tree_row)$/;
const WATERWAY = /^(stream|river|ditch|drain|canal)$/;

/** The same selection as the Overpass course query in overpass.ts. */
export function wanted(e: { type: string; tags?: Record<string, string> }): boolean {
  const t = e.tags;
  if (!t) return false;
  if (t.golf) return true;
  if (t.natural && NATURAL.test(t.natural)) return true;
  if (e.type === 'node') return t.natural === 'tree';
  if (t.landuse === 'forest') return true;
  if (e.type !== 'way') return false;
  return !!t.building || !!t.highway || (!!t.waterway && WATERWAY.test(t.waterway));
}

/** Converts an OSM API answer to Overpass `out geom` elements, keeping only `keep` ones. */
export function toOverpass(els: ApiEl[], keep: (e: ApiEl) => boolean = wanted): OverpassElement[] {
  const nodes = new Map<number, { lat: number; lon: number }>();
  const ways = new Map<number, ApiWay>();
  for (const e of els) {
    if (e.type === 'node') nodes.set(e.id, { lat: e.lat, lon: e.lon });
    else if (e.type === 'way') ways.set(e.id, e);
  }
  const geom = (w: ApiWay) => {
    const g = w.nodes.map((id) => nodes.get(id));
    return g.every(Boolean) ? (g as { lat: number; lon: number }[]) : undefined;
  };
  const out: OverpassElement[] = [];
  for (const e of els) {
    if (!keep(e)) continue;
    if (e.type === 'node') out.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags: e.tags });
    else if (e.type === 'way') {
      const g = geom(e);
      if (g) out.push({ type: 'way', id: e.id, tags: e.tags, geometry: g });
    } else {
      const members = e.members.map((m) => {
        const w = m.type === 'way' ? ways.get(m.ref) : undefined;
        return { type: m.type, ref: m.ref, role: m.role, geometry: w ? geom(w) : undefined };
      });
      out.push({ type: 'relation', id: e.id, tags: e.tags, members });
    }
  }
  return out;
}

function boundsOf(pts: { lat: number; lon: number }[]) {
  let minlat = 90, minlon = 180, maxlat = -90, maxlon = -180;
  for (const p of pts) {
    minlat = Math.min(minlat, p.lat); maxlat = Math.max(maxlat, p.lat);
    minlon = Math.min(minlon, p.lon); maxlon = Math.max(maxlon, p.lon);
  }
  return { minlat, minlon, maxlat, maxlon };
}

async function getJson(url: string, signal?: AbortSignal, onBytes?: (n: number) => void): Promise<{ elements: ApiEl[] }> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw Object.assign(new Error(`OpenStreetMap API: HTTP ${res.status}`), { status: res.status });
  if (!onBytes || !res.body) return res.json();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let n = 0, text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    text += dec.decode(value, { stream: true });
    onBytes(n);
  }
  return JSON.parse(text + dec.decode());
}

/** The course outline (way or relation) with its geometry and bounds, like Overpass `out geom tags bb`. */
export async function apiCourseHead(type: string, id: string, signal?: AbortSignal): Promise<OverpassElement | undefined> {
  if (type !== 'way' && type !== 'relation') throw new Error('Unsupported course type: ' + type);
  const { elements } = await getJson(`${API}/${type}/${id}/full.json`, signal);
  const all = toOverpass(elements, (e) => e.type === type && e.id === Number(id));
  const c = all[0];
  if (!c) return undefined;
  const pts = elements.filter((e): e is ApiNode => e.type === 'node');
  if (!pts.length) return undefined;
  return { ...c, bounds: boundsOf(pts) };
}

/**
 * Everything in a bounding box (south, west, north, east). The API refuses big boxes (too many nodes,
 * HTTP 400 / 509), so those are split into quarters and merged.
 */
export async function apiMap(s: number, w: number, n: number, e: number, signal?: AbortSignal, onBytes?: (n: number) => void, depth = 0): Promise<ApiEl[]> {
  try {
    const { elements } = await getJson(`${API}/map.json?bbox=${w},${s},${e},${n}`, signal, onBytes);
    return elements;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if ((status !== 400 && status !== 509) || depth >= 2) throw err;
    const mlat = (s + n) / 2, mlon = (w + e) / 2;
    const quads: [number, number, number, number][] = [[s, w, mlat, mlon], [s, mlon, mlat, e], [mlat, w, n, mlon], [mlat, mlon, n, e]];
    let done = 0;
    const parts: ApiEl[][] = [];
    for (const q of quads) {
      // One at a time, to go easy on the server; bytes add up across the quarters.
      const base = done;
      parts.push(await apiMap(...q, signal, onBytes && ((b) => onBytes(base + b)), depth + 1));
      done = base + JSON.stringify(parts[parts.length - 1]).length;
    }
    const seen = new Set<string>();
    return parts.flat().filter((x) => { const k = x.type + x.id; if (seen.has(k)) return false; seen.add(k); return true; });
  }
}

/** Course features from the main API in Overpass shape. */
export async function apiCourseFeatures(s: number, w: number, n: number, e: number, signal?: AbortSignal, onBytes?: (n: number) => void): Promise<OverpassElement[]> {
  return toOverpass(await apiMap(s, w, n, e, signal, onBytes));
}
