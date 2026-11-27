// 3D scenery for the tilted map view: trees, tree rows and woods as extruded shapes.
import * as turf from '@turf/turf';
import type { Course, LngLat } from './types.ts';

/** Cheap stable "random" from a coordinate, so each tree keeps its size. */
const jitter = (p: LngLat) => {
  const x = Math.sin(p[0] * 12.9898e3 + p[1] * 78.233e3) * 43758.5453;
  return x - Math.floor(x);
};

/** A canopy outline (10-sided) of radius r metres around p. */
function canopy(p: LngLat, r: number): LngLat[] {
  const dLat = r / 111320;
  const dLon = r / (111320 * Math.cos((p[1] * Math.PI) / 180));
  const ring: LngLat[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const a = ((i % n) * 2 * Math.PI) / n;
    ring.push([p[0] + Math.cos(a) * dLon, p[1] + Math.sin(a) * dLat]);
  }
  return ring;
}

const TREE_GREENS = ['#2c6b30', '#336f2f', '#2a6334', '#3a7a35'];

/**
 * Extrusion features with properties h (top, m), b (base, m) and c (color).
 * Single trees: a trunk and a two-tier crown 3.5-5.5 m in radius, 9-14 m tall.
 * Tree rows: the row buffered to a 3.5 m half-width. Woods: the outline raised to ~12 m.
 */
export function scenery3d(course: Course): GeoJSON.FeatureCollection {
  const out: GeoJSON.Feature[] = [];
  for (const f of course.features.features) {
    const k = f.properties?.kind;
    if (k === 'tree' && f.geometry.type === 'Point') {
      const p = f.geometry.coordinates as LngLat;
      const j = jitter(p);
      const r = 3.5 + j * 2;
      const top = 9 + j * 5;
      const c = TREE_GREENS[Math.floor(j * 4)];
      // Trunk, a wide lower crown and a narrower upper crown read as a tree from any angle.
      out.push(turf.polygon([canopy(p, 0.45)], { h: 2.6, b: 0, c: '#5b4128' }));
      out.push(turf.polygon([canopy(p, r)], { h: top * 0.72, b: 2.2, c }));
      out.push(turf.polygon([canopy(p, r * 0.62)], { h: top, b: top * 0.72, c }));
    } else if (k === 'treerow' && f.geometry.type === 'LineString') {
      const buf = turf.buffer(f as GeoJSON.Feature<GeoJSON.LineString>, 3.5, { units: 'meters', steps: 4 });
      if (buf) out.push({ ...buf, properties: { h: 10, b: 1.5, c: '#2f6a31' } });
    } else if (k === 'wood' && f.geometry.type === 'Polygon') {
      out.push({ ...f, properties: { h: 12, b: 0, c: '#285a2c' } });
    }
  }
  return turf.featureCollection(out);
}
