// Saved courses and app state, in localStorage (a course is ~50-150 KB).
import type { Course } from './types.ts';

const get = <T>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const set = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch (e) {
    console.warn('storage full?', e);
  }
};

export interface SavedCourseRef { id: string; name: string; fetchedAt: number }

export const savedCourses = () => get<SavedCourseRef[]>('courses', []);
export const getCourse = (id: string) => get<Course | null>('course:' + id, null);
export function saveCourse(c: Course) {
  set('course:' + c.id, c);
  set('courses', [{ id: c.id, name: c.name, fetchedAt: c.fetchedAt }, ...savedCourses().filter((s) => s.id !== c.id)]);
}
export function deleteCourse(id: string) {
  localStorage.removeItem('course:' + id);
  set('courses', savedCourses().filter((s) => s.id !== id));
}

export interface AppState { courseId?: string; hole: number; holeSetAt: number; auto: boolean; satellite: boolean }
export const loadState = () => get<AppState>('state', { hole: 0, holeSetAt: 0, auto: true, satellite: true });
export const saveState = (s: AppState) => set('state', s);
