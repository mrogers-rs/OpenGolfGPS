export type LngLat = [number, number];

export interface Hole {
  ref: number;
  par?: number;
  handicap?: number;
  /** Line of play from tee to green, as mapped in OSM (golf=hole way). */
  line: LngLat[];
  /** Outer ring of the green polygon, closed. */
  green?: LngLat[];
  /** Center of the green (centroid), or the end of the hole line if no green is mapped. */
  center: LngLat;
  /** golf=pin node inside the green, if mapped. */
  pin?: LngLat;
}

export type FeatureKind =
  | 'fairway' | 'green' | 'tee' | 'bunker' | 'water' | 'rough' | 'cartpath' | 'hole' | 'driving_range' | 'clubhouse';

export interface Course {
  /** OSM id like "way/23143257". */
  id: string;
  name: string;
  bbox: [number, number, number, number];
  holes: Hole[];
  /** GeoJSON for drawing: polygons/lines with properties.kind. */
  features: GeoJSON.FeatureCollection;
  fetchedAt: number;
}

/** Minimal Overpass JSON (out geom). */
export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; ref?: number; geometry?: { lat: number; lon: number }[] }[];
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}
