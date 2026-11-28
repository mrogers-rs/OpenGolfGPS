// The courses built into the app (no imports, so scripts/snapshot-osm.ts can read it under plain Node).
import type { LngLat } from '../types.ts';

export interface BuiltinCourse { id: string; name: string; center: LngLat }

export const BUILTIN: BuiltinCourse[] = [
  { id: 'relation/2342674', name: 'Westbrook Village Lakes', center: [-112.2671, 33.6594] },
  { id: 'relation/2342699', name: 'Westbrook Village Vistas', center: [-112.2447, 33.6598] },
];
