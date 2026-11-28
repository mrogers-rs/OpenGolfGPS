// Courses built into the app. A course file (exported from the in-app editor) saved here as
// <anything>.json is applied on every device, on top of the OpenStreetMap data for that course.
import type { CourseEdits } from '../edits.ts';
import type { CourseSnapshot } from './snapshot.ts';

export { BUILTIN, type BuiltinCourse } from './list.ts';

const files = import.meta.glob<CourseEdits>('./*.json', { eager: true, import: 'default' });

/** The bundled course file for this course, if there is one. */
export function bundledEdits(courseId: string): CourseEdits | null {
  for (const f of Object.values(files)) if (f && f.courseId === courseId) return f;
  return null;
}

// OpenStreetMap data built into the app, so these courses open with no network request.
// Named by course id ("relation/2342674" -> osm/relation-2342674.json); loaded only when needed.
const snaps = import.meta.glob<CourseSnapshot>('./osm/*.json', { import: 'default' });
const snapPath = (courseId: string) => `./osm/${courseId.replace('/', '-')}.json`;

export const hasSnapshot = (courseId: string) => snapPath(courseId) in snaps;

/** The built-in OpenStreetMap data for this course, if there is one. */
export async function bundledSnapshot(courseId: string): Promise<CourseSnapshot | null> {
  const load = snaps[snapPath(courseId)];
  return load ? load() : null;
}
