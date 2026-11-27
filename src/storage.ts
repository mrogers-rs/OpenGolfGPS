// Saved courses and app state, in localStorage (a course is ~50-150 KB).
import type { Course } from './types.ts';
import type { Round } from './round.ts';

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

export interface AppState {
  courseId?: string; hole: number; holeSetAt: number; auto: boolean; satellite: boolean;
  /** Round in progress, if any. */
  roundId?: string;
  /** Pace-of-play target for 18 holes, minutes. */
  paceTarget?: number;
  /** Show hazard and layup numbers on the map. */
  hazards?: boolean;
}
export const loadState = () => ({ hazards: true, ...get<AppState>('state', { hole: 0, holeSetAt: 0, auto: true, satellite: true }) });
export const saveState = (s: AppState) => set('state', s);

// ---------- Rounds ----------
export interface SavedRoundRef { id: string; courseName: string; startedAt: number }
export const savedRounds = () => get<SavedRoundRef[]>('rounds', []);
export const getRound = (id: string) => get<Round | null>('round:' + id, null);
export function saveRound(r: Round) {
  set('round:' + r.id, r);
  if (!savedRounds().some((s) => s.id === r.id)) set('rounds', [{ id: r.id, courseName: r.courseName, startedAt: r.startedAt }, ...savedRounds()]);
}
export function deleteRound(id: string) {
  localStorage.removeItem('round:' + id);
  set('rounds', savedRounds().filter((s) => s.id !== id));
}
