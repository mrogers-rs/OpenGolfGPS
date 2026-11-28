// Saves the OpenStreetMap data for every built-in course into src/courses/osm/, so the app opens them
// with no OSM request. Uses the same download and feature selection as the app (src/osmapi.ts).
//   node --experimental-strip-types scripts/snapshot-osm.ts
// The "OSM snapshot" GitHub workflow runs this and commits the result.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { BUILTIN } from '../src/courses/list.ts';
import { apiCourseHead, apiCourseFeatures } from '../src/osmapi.ts';
import { makeSnapshot } from '../src/courses/snapshot.ts';

const PAD = 0.0015; // same padding as loadCourse in src/overpass.ts
const dir = new URL('../src/courses/osm/', import.meta.url);
mkdirSync(dir, { recursive: true });

for (const b of BUILTIN) {
  const [type, id] = b.id.split('/');
  const head = await apiCourseHead(type, id);
  if (!head?.bounds) throw new Error(`${b.id}: not found in OpenStreetMap`);
  const { minlat, minlon, maxlat, maxlon } = head.bounds;
  const els = await apiCourseFeatures(minlat - PAD, minlon - PAD, maxlat + PAD, maxlon + PAD);
  const snap = makeSnapshot(b.id, head.tags?.name ?? b.name, head.bounds, els);
  const file = new URL(`${type}-${id}.json`, dir);
  // Nothing changed in OSM: keep the old file (and its date), so phones don't rebuild the course for nothing.
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    if (JSON.stringify(old.elements) === JSON.stringify(snap.elements) && old.name === snap.name) {
      console.log(`${b.name}: unchanged since ${old.snapshotAt}`);
      continue;
    }
  }
  const text = JSON.stringify(snap);
  writeFileSync(file, text + '\n');
  const holes = els.filter((e) => e.tags?.golf === 'hole').length;
  console.log(`${b.name}: ${snap.elements.length} features, ${holes} holes, ${(text.length / 1024).toFixed(0)} KB -> ${file.pathname}`);
}
