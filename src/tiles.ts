// Satellite imagery source and offline prefetch for a course's area.
export const SAT_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const SAT_ATTRIB = 'Imagery © Esri, Maxar, Earthstar Geographics';
export const TILE_CACHE = 'tiles-v1';
export const MIN_Z = 14;
export const MAX_Z = 19;

const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export function tileUrls(bbox: [number, number, number, number]): string[] {
  const [w, s, e, n] = bbox;
  const urls: string[] = [];
  for (let z = MIN_Z; z <= MAX_Z; z++) {
    for (let x = lon2x(w, z); x <= lon2x(e, z); x++)
      for (let y = lat2y(n, z); y <= lat2y(s, z); y++)
        urls.push(SAT_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
  }
  return urls;
}

/** Downloads every satellite tile for the area into the Cache API (the service worker serves them offline). */
export async function prefetchTiles(bbox: [number, number, number, number], onProgress: (done: number, total: number) => void) {
  const pad = 0.002;
  const urls = tileUrls([bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad]);
  const cache = await caches.open(TILE_CACHE);
  let done = 0;
  let failed = 0;
  const queue = urls.slice();
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      try {
        if (!(await cache.match(u))) {
          const r = await fetch(u, { mode: 'cors' });
          if (r.ok) await cache.put(u, r);
          else failed++;
        }
      } catch {
        failed++;
      }
      onProgress(++done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { total: urls.length, failed };
}
