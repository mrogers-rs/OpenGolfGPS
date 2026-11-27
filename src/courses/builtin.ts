// Courses built into the app. A course file (exported from the in-app editor) saved here as
// <anything>.json is applied on every device, on top of the OpenStreetMap data for that course.
import type { LngLat } from '../types.ts';
import type { CourseEdits } from '../edits.ts';

export interface BuiltinCourse { id: string; name: string; center: LngLat }

export const BUILTIN: BuiltinCourse[] = [
  { id: 'relation/2342674', name: 'Westbrook Village Lakes', center: [-112.2671, 33.6594] },
  { id: 'relation/2342699', name: 'Westbrook Village Vistas', center: [-112.2447, 33.6598] },
];

const files = import.meta.glob<CourseEdits>('./*.json', { eager: true, import: 'default' });

/** The bundled course file for this course, if there is one. */
export function bundledEdits(courseId: string): CourseEdits | null {
  for (const f of Object.values(files)) if (f && f.courseId === courseId) return f;
  return null;
}
