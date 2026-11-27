import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { Course, Hole, LngLat } from './types.ts';
import { autoAdvance, holeAtStart } from './advance.ts';
import { COURSE_DATA_VERSION } from './course.ts';
import { scenery3d } from './scenery3d.ts';
import { distanceArcs, driveTarget, DEFAULT_DRIVE_YD } from './arcs.ts';
import { holeCorridor, holeMask, insideCorridor, framing, APPROACH_YD } from './cutout.ts';
import { loadCourse, searchCourses, coursesNear, courseAt, stepProgress, nextFrame, type CourseHit } from './overpass.ts';
import * as store from './storage.ts';
import { keepAwake, wakeLockSupported } from './wakelock.ts';
import { SAT_URL, SAT_ATTRIB, prefetchTiles } from './tiles.ts';
import { hazardNumbers } from './hazards.ts';
import { type Round, newRound, pace, fmtClock, totals, fmtToPar, DEFAULT_PACE_MIN } from './round.ts';
import { initCard, renderCard } from './card.ts';
import { greenNumbers, measure, yd, pathYd, MAX_GPS_YD, greenEdges } from './yardage.ts';
import { applyEdits, closeRing, completeEdits, editableRefs, emptyEdits, parseEditsFile, progressOf, roundPt, type CourseEdits } from './edits.ts';
import { BUILTIN, bundledEdits } from './courses/builtin.ts';

/** Test course: Auburn Golf Course, Auburn WA. Its OSM id is looked up by name the first time (then remembered). */
/** Built-in test course, found by position (29630 Green River Rd SE, Auburn WA). The key holds its OSM id once found. */
const TEST_COURSE = { name: 'Auburn Golf Course', center: [-122.2083, 47.3362] as LngLat, key: 'testCourse:auburn' };
/** A hole picked more than this long ago is treated as a new round on reopen. */
const ROUND_RESET_MS = 6 * 3600 * 1000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

let state = store.loadState();
let course: Course | null = null;
let player: LngLat | null = null;
let accuracy = Infinity;
let target: LngLat | null = null;
let sim = params.has('sim');
let lastFixAt = 0;
let round: Round | null = null;
let greenView = false;
/** Course editor state (see Course editor below); null when not editing. */
type Tool = 'tee' | 'green' | 'dogleg' | 'bunker' | 'water' | 'tree' | 'woods';
let editing: { ref: number; tool: Tool | null; pts: LngLat[]; sel: string | null } | null = null;
/** A round older than this (since its start) isn't resumed. */
const ROUND_MAX_MS = 14 * 3600 * 1000;

// ---------- Map ----------
/** Map-view colors. Rough is the background; everything else is drawn on top. */
const MAP = { rough: '#3f7d3c', bg: '#478a43', wood: '#295c2d', scrub: '#5a7d3c', wetland: '#5a8c78', fairway: '#69c25b', tee: '#7ed06e', green: '#8eef80', bunker: '#efe1a8', water: '#3a8de4' };
/** Golf surfaces, lightly tinted over the photo in satellite view. */
const GOLF_FILLS = ['fairway', 'tee', 'green', 'bunker', 'water'];
/** Hidden in satellite view. */
const SCENERY = ['wood', 'scrub', 'wetland', 'rough', 'wood-edge', 'stream', 'road', 'path', 'building', 'treerow', 'tree-shadow', 'tree'];
const TREE_R: any = ['interpolate', ['exponential', 2], ['zoom'], 15, 1.6, 20, 50];

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      sat: { type: 'raster', tiles: [SAT_URL], tileSize: 256, maxzoom: 19, attribution: SAT_ATTRIB },
      course: { type: 'geojson', data: turf.featureCollection([]), attribution: '© OpenStreetMap contributors' },
      hole: { type: 'geojson', data: turf.featureCollection([]) },
      measure: { type: 'geojson', data: turf.featureCollection([]) },
      scenery3d: { type: 'geojson', data: turf.featureCollection([]) },
      cutout: { type: 'geojson', data: turf.featureCollection([]) },
      pinline: { type: 'geojson', data: turf.featureCollection([]) },
      arcs: { type: 'geojson', data: turf.featureCollection([]) },
      edit: { type: 'geojson', data: turf.featureCollection([]) },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0d2a14' } },
      { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: state.satellite ? 'visible' : 'none' } },
      // Scenery: drawn only in map view (the photo already shows it).
      fill('wood', MAP.wood),
      fill('scrub', MAP.scrub),
      fill('wetland', MAP.wetland),
      fill('rough', MAP.rough),
      line('wood-edge', 'wood', '#214b25', 1),
      fill('fairway', MAP.fairway),
      fill('tee', MAP.tee),
      fill('green', MAP.green),
      fill('bunker', MAP.bunker),
      fill('water', MAP.water),
      line('stream', 'stream', MAP.water, ['interpolate', ['linear'], ['zoom'], 15, 1.5, 19, 6]),
      line('bunker-line', 'bunker', '#c2ab62', 1),
      line('water-line', 'water', '#1f5fae', 1.2),
      line('road', 'road', '#ddd6c6', ['interpolate', ['linear'], ['zoom'], 15, 2, 19, 12]),
      line('path', 'path', '#eadfc2', ['interpolate', ['linear'], ['zoom'], 15, 1, 19, 3], [2, 1.5]),
      line('cartpath', 'cartpath', '#d4ccb6', ['interpolate', ['linear'], ['zoom'], 15, 1.2, 19, 5]),
      { id: 'building', type: 'fill-extrusion', source: 'course', filter: ['==', ['get', 'kind'], 'building'], paint: { 'fill-extrusion-color': '#bdb2a3', 'fill-extrusion-height': 7, 'fill-extrusion-opacity': 0.95 } },
      { id: 'treerow', type: 'line', source: 'course', filter: ['==', ['get', 'kind'], 'treerow'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2c6430', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 15, 3, 20, 90] } },
      // Trees: a soft shadow plus a canopy about 5 m across in radius, scaled with zoom.
      { id: 'tree-shadow', type: 'circle', source: 'course', filter: ['==', ['get', 'kind'], 'tree'], paint: { 'circle-color': '#000', 'circle-opacity': 0.22, 'circle-blur': 0.4, 'circle-translate': [2, 2], 'circle-radius': TREE_R } },
      { id: 'tree', type: 'circle', source: 'course', filter: ['==', ['get', 'kind'], 'tree'], paint: { 'circle-color': '#2e7432', 'circle-stroke-color': '#1d5221', 'circle-stroke-width': 1, 'circle-radius': TREE_R } },
      { id: 'trees3d', type: 'fill-extrusion', source: 'scenery3d', layout: { visibility: 'none' }, paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-opacity': 0.97, 'fill-extrusion-vertical-gradient': true } },
      line('green-line', 'green', '#fff', 1.5),
      // Hole cutout: everything outside the hole and its margin is darkened (raised trees are filtered to the hole instead); above other holes' green outlines.
      { id: 'cutout', type: 'fill', source: 'cutout', layout: { visibility: 'none' }, paint: { 'fill-color': '#040805', 'fill-opacity': 0.9 } },
      { id: 'cutout-edge', type: 'line', source: 'cutout', layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': '#a8d8ae', 'line-opacity': 0.45, 'line-width': 1.5, 'line-blur': 0.5 } },
      { id: 'holes', type: 'line', source: 'course', filter: ['==', ['get', 'kind'], 'hole'], paint: { 'line-color': '#fff', 'line-width': 1, 'line-opacity': 0.25 } },
      { id: 'arcs', type: 'line', source: 'arcs', layout: { 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-opacity': 0.9 } },
      { id: 'hole-line', type: 'line', source: 'hole', paint: { 'line-color': '#fff', 'line-width': 3, 'line-dasharray': [2, 2] } },
      { id: 'pinline', type: 'line', source: 'pinline', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 2.5, 'line-opacity': 0.95 } },
      // Tap-to-measure: thick legs (you -> target in yellow, target -> pin in white) on a dark casing.
      { id: 'measure-casing', type: 'line', source: 'measure', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-width': 9, 'line-opacity': 0.55 } },
      { id: 'measure-line', type: 'line', source: 'measure', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'leg'], 'to', '#ffd400', '#ffffff'], 'line-width': 5 } },
      // Course editor: shapes you've marked (outlined) and the one you're drawing.
      { id: 'edit-fill', type: 'fill', source: 'edit', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['match', ['get', 'kind'], 'green', '#8eef80', 'bunker', '#efe1a8', 'water', '#3a8de4', 'wood', '#2e7432', '#fff'], 'fill-opacity': ['case', ['==', ['get', 'drawing'], true], 0.45, 0.3] } },
      { id: 'edit-line', type: 'line', source: 'edit', filter: ['!=', ['geometry-type'], 'Point'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['case', ['==', ['get', 'sel'], true], '#ff3b30', ['==', ['get', 'drawing'], true], '#ffd400', ['match', ['get', 'kind'], 'green', '#b6ffad', 'bunker', '#fff3c4', 'water', '#9cc9ff', 'wood', '#7be07f', 'line', '#ffffff', '#fff']], 'line-width': ['case', ['any', ['==', ['get', 'sel'], true], ['==', ['get', 'drawing'], true]], 3.5, 2.5] } },
      { id: 'edit-pts', type: 'circle', source: 'edit', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 16, ['match', ['get', 'kind'], 'tee', 11, 'dogleg', 8, 'tree', 4, 6], 20, ['match', ['get', 'kind'], 'tee', 11, 'dogleg', 8, 'tree', 40, 6]], 'circle-color': ['match', ['get', 'kind'], 'tee', '#2f7bff', 'dogleg', '#ffd400', 'tree', '#2e7432', '#ffd400'], 'circle-opacity': ['match', ['get', 'kind'], 'tree', 0.75, 1], 'circle-stroke-color': ['case', ['==', ['get', 'sel'], true], '#ff3b30', ['==', ['get', 'kind'], 'tree'], '#b6ffad', '#000'], 'circle-stroke-width': ['case', ['==', ['get', 'sel'], true], 3, 2] } },
    ],
  },
  center: TEST_COURSE.center,
  zoom: 15,
  attributionControl: { compact: true },
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
});
map.touchZoomRotate.disableRotation();

function fill(kind: string, color: string): maplibregl.LayerSpecification {
  return { id: kind, type: 'fill', source: 'course', filter: ['==', ['get', 'kind'], kind], paint: { 'fill-color': color, 'fill-opacity': 0.95 } };
}
function line(id: string, kind: string, color: string, width: any, dash?: number[]): maplibregl.LayerSpecification {
  return { id, type: 'line', source: 'course', filter: ['==', ['get', 'kind'], kind], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': color, 'line-width': width, ...(dash ? { 'line-dasharray': dash } : {}) } };
}

const playerMarker = new maplibregl.Marker({ element: el('dot-player') });
const targetMarker = new maplibregl.Marker({ element: crosshair(), draggable: true });
const flagMarker = new maplibregl.Marker({ element: el('flag', '⛳'), anchor: 'bottom-left', offset: [-4, 0] });
const frontMarker = new maplibregl.Marker({ element: el('edge') });
const backMarker = new maplibregl.Marker({ element: el('edge') });
const pinLabel = new maplibregl.Marker({ element: el('pinlbl') });

/** A reusable set of HTML label markers (hazards, layups). */
function markerPool(cls: string) {
  const pool: maplibregl.Marker[] = [];
  return (items: { at: LngLat; html: string; extra?: string; offset?: [number, number] }[]) => {
    while (pool.length < items.length) pool.push(new maplibregl.Marker({ element: el(cls) }));
    pool.forEach((m, i) => {
      const it = items[i];
      if (!it) return void m.remove();
      const e = label(m);
      if (e.innerHTML !== it.html) e.innerHTML = it.html;
      e.classList.toggle('bunker', it.extra === 'bunker');
      e.classList.toggle('water', it.extra === 'water');
      e.classList.toggle('rest', it.extra === 'rest');
      m.setOffset(it.offset ?? [0, 0]).setLngLat(it.at).addTo(map);
    });
  };
}
const hazardLabels = markerPool('hz');
const layupLabels = markerPool('lay');
const arcLabels = markerPool('arclbl');
const legLabels = markerPool('leglbl');

/** The tap-to-measure target: a crosshair with a red bull's-eye (drag it to move). */
function crosshair() {
  const d = document.createElement('div');
  d.className = 'crosshair';
  d.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="13" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="3.5"/><path d="M24 2v12M24 34v12M2 24h12M34 24h12" stroke="#000" stroke-width="6" stroke-linecap="round"/><path d="M24 3v11M24 34v11M3 24h11M34 24h11" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="24" cy="24" r="5" fill="#ff2d2d" stroke="#fff" stroke-width="2"/></svg>';
  return wrap(d);
}

/**
 * A marker element: a plain wrapper (MapLibre moves it) around the styled label. The label is
 * squeezed back to normal width when the map is stretched sideways in portrait (see style.css).
 */
function el(cls: string, text = '') {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return wrap(d);
}
function wrap(inner: HTMLElement) {
  const w = document.createElement('div');
  w.className = 'mk';
  w.append(inner);
  return w;
}
/** The styled label inside a marker. */
const label = (m: maplibregl.Marker) => m.getElement().firstElementChild as HTMLElement;

targetMarker.on('drag', () => {
  const p = targetMarker.getLngLat();
  target = [p.lng, p.lat];
  render();
});

map.on('click', (e) => {
  const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
  if (editing) return editTap(p, e.point);
  const h = hole();
  if (greenView && h?.green && turf.booleanPointInPolygon(p, turf.polygon([h.green]))) {
    // In green view, tapping the green sets today's pin.
    const r = getRound(true)!;
    (r.holes[h.ref] ??= {}).pin = p;
    saveRound(r);
    showHole(false);
    return;
  }
  if (sim) {
    onPosition(p, 3);
    return;
  }
  target = p;
  render();
});

// ---------- Course ----------
function setCourse(raw: Course, keepHole = false) {
  baseCourse = raw;
  const c = withEdits(raw);
  course = c;
  $('coursename').textContent = c.name;
  round = resumeRound(c);
  state.courseId = c.id;
  const fresh = Date.now() - state.holeSetAt > ROUND_RESET_MS;
  if (!keepHole || fresh || state.hole >= c.holes.length) state.hole = 0;
  store.saveState(state);
  (map.getSource('course') as GeoJSONSource).setData(c.features);
  sceneryAll = scenery3d(c);
  fairwayPolys = c.features.features.filter((f): f is GeoJSON.Feature<GeoJSON.Polygon> => f.properties?.kind === 'fairway' && f.geometry.type === 'Polygon');
  target = null;
  if (player) {
    const at = holeAtStart(c.holes, player);
    if (at != null && fresh) state.hole = at;
  }
  showHole(true);
  upgradeCourse(raw);
}

/** The OpenStreetMap course as loaded (before edits). */
let baseCourse: Course | null = null;
/** Your edits for a course (this device), else the course file built into the app, if any. */
const editsFor = (id: string): CourseEdits | null => store.getEdits(id) ?? bundledEdits(id);
const withEdits = (c: Course) => applyEdits(c, editsFor(c.id));

/** All raised trees for the course; the hole cutout shows only the ones on the current hole. */
let sceneryAll: GeoJSON.FeatureCollection = turf.featureCollection([]);
/** Fairway outlines, for centering the default drive crosshair. */
let fairwayPolys: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
/** The crosshair on screen: yours, or the default drive spot. */
let shownTarget: LngLat | null = null;
/** You cleared the crosshair on this hole: don't put the default one back until the next hole. */
let targetCleared = false;

/** Darkens everything but the current hole (when the cutout is on) and keeps raised trees to the hole. */
function updateCutout(h: Hole) {
  const on = state.cutout !== false && !editing;
  const corridor = holeCorridor(h);
  (map.getSource('cutout') as GeoJSONSource).setData(on ? holeMask(corridor) : turf.featureCollection([]));
  (map.getSource('scenery3d') as GeoJSONSource).setData(on ? turf.featureCollection(insideCorridor(sceneryAll.features, corridor)) : sceneryAll);
}

/** Courses saved by an older version lack scenery: quietly re-fetch them when online. */
let upgrading = '';
function upgradeCourse(c: Course) {
  if ((c.v ?? 1) >= COURSE_DATA_VERSION || !navigator.onLine || upgrading === c.id) return;
  upgrading = c.id;
  loadCourse(c.id, c.name)
    .then((fresh) => {
      if (fresh.holes.length !== c.holes.length) return; // mapping changed a lot; leave it for a manual refresh
      store.saveCourse(fresh);
      if (course?.id !== fresh.id) return;
      baseCourse = fresh;
      redraw();
    })
    .catch(() => { /* try again next time */ })
    .finally(() => { upgrading = ''; });
}

function hole(): Hole | null {
  const h = course ? course.holes[state.hole] ?? null : null;
  // While editing, only the hole being edited counts (it may not be finished yet).
  if (editing && h?.ref !== editing.ref) return null;
  return h;
}

/** Re-applies edits to the loaded course and redraws it, keeping the current hole. */
function redraw() {
  if (!baseCourse) return;
  const ref = editing?.ref ?? course?.holes[state.hole]?.ref;
  course = withEdits(baseCourse);
  (map.getSource('course') as GeoJSONSource).setData(course.features);
  sceneryAll = scenery3d(course);
  fairwayPolys = course.features.features.filter((f): f is GeoJSON.Feature<GeoJSON.Polygon> => f.properties?.kind === 'fairway' && f.geometry.type === 'Polygon');
  const i = course.holes.findIndex((h) => h.ref === ref);
  if (i >= 0) state.hole = i;
  else if (!editing) state.hole = Math.min(state.hole, Math.max(0, course.holes.length - 1));
  showHole(false);
}

/** `manual` = picked by hand. Auto-advance then carries on from the hole you picked. */
function goHole(i: number, _manual: boolean) {
  if (!course) return;
  state.hole = Math.max(0, Math.min(course.holes.length - 1, i));
  state.holeSetAt = Date.now();
  store.saveState(state);
  target = null;
  targetCleared = false;
  greenView = false;
  noteArrival();
  showHole(true);
}

function showHole(fit: boolean) {
  const h = hole();
  if (editing) drawEdit();
  if (!h) { clearHole(); return; }
  $('holeno').textContent = String(h.ref);
  const len = Math.round(pathYd([...h.line.slice(0, -1), h.center]));
  $('holemeta').innerHTML = [h.par && `<b>Par ${h.par}</b>`, `${len} yds`, h.handicap && `HCP ${h.handicap}`].filter(Boolean).join('<i>·</i>');
  (map.getSource('hole') as GeoJSONSource).setData(turf.lineString(h.line));
  flagMarker.setLngLat(pinOf(h) ?? h.pin ?? h.center).addTo(map);
  updateCutout(h);
  if (map.getLayer('trees3d')) applyView();
  if (fit) { userMoved = false; greenView ? fitGreen(h) : fitHole(h); }
  render();
}

/** True when the map is wider than tall: holes then run left to right instead of bottom to top. */
function wide() {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  return w > h * 1.05;
}

/**
 * Map bearing that runs `from -> to` from the bottom-left corner toward the top-right corner of the
 * open map area (portrait and landscape), which gives the hole the most length.
 */
function playBearing(from: LngLat, to: LngLat) {
  const b = turf.bearing(from, to);
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const pad = fitPadding();
  const up = (Math.atan2(h - pad.top - pad.bottom, w - pad.left - pad.right) * 180) / Math.PI; // diagonal, degrees above horizontal
  return b - (90 - up);
}

/** Room the overlays (hole card, tool buttons, yardage card) leave for the hole. */
function fitPadding() {
  // Generous margins so the hole sits clear of the hole card, tool buttons and screen edges.
  // Measured from the overlays, since they grow on big screens.
  const box = map.getContainer().getBoundingClientRect();
  const card = document.getElementById('holecard')?.getBoundingClientRect();
  const tools = document.getElementById('tools')?.getBoundingClientRect();
  // The hole card counts at the top only when it floats over the top of the map (landscape).
  const cardBottom = card && card.height && card.bottom > box.top + 4 && card.top < box.top + box.height / 2 ? card.bottom - box.top : 0;
  // In portrait the hole card sits in the bottom-right corner of the map: keep the tee above it.
  const cardLift = card && card.height && card.top > box.top + box.height / 2 ? box.bottom - card.top : 0;
  const toolsW = tools && tools.width ? box.right - tools.left : 76;
  // In landscape the yardage card floats at the top of the map: keep the hole below it.
  const nums = document.getElementById('nums')?.getBoundingClientRect();
  const numsBottom = nums && nums.height && nums.top < box.top + box.height / 2 ? nums.bottom - box.top : 0;
  // The course editor's bar covers the bottom of the map.
  const bar = editing ? $('editbar').getBoundingClientRect() : null;
  const barLift = bar && bar.height && !wide() ? box.bottom - bar.top + 16 : 0;
  // In landscape it's a panel down the right side instead.
  const barSide = bar && bar.height && wide() ? box.right - bar.left + 16 : 0;
  const pad = wide()
    ? { top: Math.max(96, cardBottom * 0.75, numsBottom + 16), bottom: 72, left: 56, right: Math.max(toolsW + 24, barSide) }
    : { top: Math.max(30, cardBottom + 28), bottom: Math.max(70, cardLift + 16, barLift), left: 32, right: toolsW + 8 };
  return unstretch(pad);
}

/** How much the map is stretched sideways on screen (portrait), 1 when it isn't. */
function stretchX() {
  const c = map.getContainer();
  return c.offsetWidth ? c.getBoundingClientRect().width / c.offsetWidth : 1;
}
/** Screen-pixel padding to map pixels (side padding shrinks by the stretch). */
function unstretch(p: { top: number; bottom: number; left: number; right: number }) {
  const sx = stretchX();
  return { ...p, left: p.left / sx, right: p.right / sx };
}

/**
 * Hole view. With no usable position: the whole hole, tee to green. On the hole: just what's left, from you
 * to the green, so it zooms in as you walk. Near the green: a close-up of the green, faced from where you are.
 * `animate` glides there (used while following you) instead of jumping.
 */
const TILT = 50;
const TILT_WIDE = 32;
let lastFitFrom: LngLat | null = null;
/** You panned or zoomed by hand: stop following until the next hole or Recenter. */
let userMoved = false;
function fitHole(h: Hole, animate = false) {
  const f = framing(h, usablePlayer(h));
  const bearing = playBearing(f.from, h.center);
  const pitch = state.view === '3d' && !greenView && f.mode !== 'approach' ? (wide() ? TILT_WIDE : TILT) : 0;
  const before = animate ? { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() } : null;
  fitPoints(f.pts, bearing, pitch, fitPadding(), f.mode === 'approach' ? 20.5 : 19);
  lastFitFrom = player;
  if (before) {
    const after = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    map.jumpTo(before);
    map.easeTo({ ...after, duration: 900 });
  }
}

/** Re-frames the hole as you walk (every ~10 yd), unless you've moved the map yourself. */
function follow() {
  const h = hole();
  if (!h || !player || greenView || flying || target || userMoved || editing) return;
  if (lastFitFrom && yd(lastFitFrom, player) < 10) return;
  fitHole(h, true);
}
map.on('dragstart', () => { userMoved = true; });
map.on('zoomstart', (e) => { if ((e as any).originalEvent) userMoved = true; });

/**
 * Rotates to `bearing`, tilts to `pitch`, then zooms and pans until the points just fill the padded screen.
 * (cameraForBounds fits the north-up box around the points, which leaves a rotated hole small.)
 */
function fitPoints(pts: LngLat[], bearing: number, pitch: number, pad: { top: number; bottom: number; left: number; right: number }, maxZoom: number) {
  const { clientWidth: w, clientHeight: hgt } = map.getContainer();
  const availW = Math.max(40, w - pad.left - pad.right);
  const availH = Math.max(40, hgt - pad.top - pad.bottom);
  const c = turf.center(turf.multiPoint(pts)).geometry.coordinates as LngLat;
  map.jumpTo({ center: c, bearing, pitch, zoom: Math.min(map.getZoom() || 16, maxZoom) });
  for (let i = 0; i < 12; i++) {
    const xy = pts.map((p) => map.project(p));
    const minX = Math.min(...xy.map((q) => q.x)), maxX = Math.max(...xy.map((q) => q.x));
    const minY = Math.min(...xy.map((q) => q.y)), maxY = Math.max(...xy.map((q) => q.y));
    const ratio = Math.min(availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY));
    const dx = (minX + maxX) / 2 - (pad.left + availW / 2);
    const dy = (minY + maxY) / 2 - (pad.top + availH / 2);
    // Ease in when tilted: the far end shrinks as you zoom, so a full step overshoots.
    const step = Math.log2(ratio) * (pitch ? 0.8 : 1);
    const zoom = Math.min(maxZoom, map.getZoom() + step);
    const center = map.unproject([w / 2 + dx, hgt / 2 + dy]);
    map.jumpTo({ center, zoom });
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && (Math.abs(step) < 0.01 || (zoom >= maxZoom && ratio >= 1))) break;
  }
  // Never leave anything cut off: back out a little at a time if the last step overshot.
  for (let i = 0; i < 10; i++) {
    const xy = pts.map((p) => map.project(p));
    const off = xy.some((q) => q.x < pad.left - 1 || q.x > w - pad.right + 1 || q.y < pad.top - 1 || q.y > hgt - pad.bottom + 1);
    if (!off) break;
    map.jumpTo({ zoom: map.getZoom() - 0.05 });
  }
}

/** Close-up of the green, from the direction you're approaching. */
function fitGreen(h: Hole) {
  const ring = h.green ?? [h.center];
  const from = usablePlayer(h) ?? h.line[Math.max(0, h.line.length - 2)];
  const bearing = playBearing(from, h.center);
  const pts = turf.coordAll(turf.buffer(turf.multiPoint(ring), 6, { units: 'meters' })!) as LngLat[];
  fitPoints(pts, bearing, 0, wide() ? { top: 90, bottom: 60, left: 60, right: 100 } : unstretch({ ...fitPadding(), left: 40, right: 86 }), 21);
}

// ---------- Flyover ----------
let flying = false;
async function flyover() {
  const h = hole();
  if (!h || flying) return;
  flying = true;
  $('fly').setAttribute('aria-pressed', 'true');
  const pts = [...h.line.slice(0, -1), h.center];
  const stop = () => { flying = false; };
  map.once('touchstart', stop);
  map.once('mousedown', stop);
  const ease = (o: maplibregl.EaseToOptions) => new Promise<void>((res) => { map.once('moveend', () => res()); map.easeTo(o); });
  try {
    await ease({ center: pts[0], zoom: 17.5, pitch: 60, bearing: turf.bearing(pts[0], pts[1]), duration: 900 });
    for (let i = 1; i < pts.length && flying; i++) {
      const len = turf.distance(pts[i - 1], pts[i], { units: 'meters' });
      const last = i === pts.length - 1;
      const bearing = turf.bearing(pts[i - 1], pts[i]);
      // Stop a little short of the green so it fills the screen.
      const center = last ? (turf.destination(pts[i], 35, bearing + 180, { units: 'meters' }).geometry.coordinates as LngLat) : pts[i];
      await ease({ center, bearing, zoom: last ? 18.6 : 17.5, pitch: last ? 55 : 60, duration: Math.max(1200, len * 14), easing: (t) => t });
    }
    if (flying) await new Promise((r) => setTimeout(r, 1200));
  } finally {
    flying = false;
    $('fly').setAttribute('aria-pressed', 'false');
    map.off('touchstart', stop);
    map.off('mousedown', stop);
    greenView ? fitGreen(h) : fitHole(h);
  }
}

/** Nothing to show (a hole you're still mapping): blank numbers and markers. */
function clearHole() {
  for (const id of ['front', 'center', 'back']) $(id).textContent = '–';
  $('holemeta').textContent = '';
  for (const m of [flagMarker, frontMarker, backMarker, targetMarker, pinLabel]) m.remove();
  hazardLabels([]); arcLabels([]); legLabels([]);
  $('measure').hidden = true;
  for (const id of ['hole', 'measure', 'arcs', 'pinline', 'cutout']) (map.getSource(id) as GeoJSONSource | undefined)?.setData(turf.featureCollection([]));
}

// ---------- Numbers ----------
const fmt = (n: number) => String(Math.round(n));

function render() {
  const h = hole();
  if (!h) { if (course) clearHole(); return; }
  const n = greenNumbers(h, player);
  const pin = pinOf(h);
  const me = usablePlayer(h);
  $('front').textContent = fmt(n.front);
  $('center').textContent = fmt(pin ? greenNumbers({ ...h, center: pin }, player).center : n.center);
  $('centerlbl').textContent = pin ? 'PIN' : 'CENTER';
  $('back').textContent = fmt(n.back);
  frontMarker.setLngLat(n.frontPt).addTo(map);
  backMarker.setLngLat(n.backPt).addTo(map);
  const gps = $('gps');
  if (n.from === 'tee') {
    gps.textContent = player ? 'Not on this hole · from tee' : sim ? 'Sim: tap map to place yourself' : 'No GPS · from tee';
    gps.className = '';
  } else {
    gps.textContent = sim ? 'Simulated location' : `GPS ±${Math.round(accuracy * 1.0936)} yd`;
    gps.className = accuracy <= 10 ? 'good' : 'poor';
  }

  renderPinLine(h, me, pin);
  renderHazards(h, me);
  renderArcs(h, me);
  renderGreenInfo(h, n.frontPt, n.backPt);
  renderPace();

  // Your crosshair if you placed one, else the default drive spot from the tee (par 4/5) unless you cleared it.
  shownTarget = editing ? null : target ?? (!targetCleared && !greenView ? driveTarget(h, fairwayPolys, me, state.drive ?? DEFAULT_DRIVE_YD) : null);
  if (shownTarget) {
    const target = shownTarget;
    const m = measure(h, player, target);
    const to = pin ?? h.center;
    const rest = yd(target, to);
    $('measure').hidden = false;
    targetMarker.setLngLat(target).addTo(map);
    (map.getSource('measure') as GeoJSONSource).setData(turf.featureCollection([
      turf.lineString([m.from, target], { leg: 'to' }),
      turf.lineString([target, to], { leg: 'rest' }),
    ]));
    // Big yardages halfway along each leg.
    legLabels([
      { at: turf.midpoint(m.from, target).geometry.coordinates as LngLat, extra: 'to', html: `<b>${fmt(m.toTarget)}</b>` },
      { at: turf.midpoint(target, to).geometry.coordinates as LngLat, extra: 'rest', html: `<b>${fmt(rest)}</b>` },
    ]);
  } else {
    $('measure').hidden = true;
    targetMarker.remove();
    legLabels([]);
    (map.getSource('measure') as GeoJSONSource | undefined)?.setData(turf.featureCollection([]));
  }
}

/** Drive arcs (200-300 yd) on par 4s and 5s, from the tee or from you. Hidden in green view and close to the green. */
function renderArcs(h: Hole, me: LngLat | null) {
  const arcs = greenView || !state.hazards || editing ? [] : distanceArcs(h, me);
  (map.getSource('arcs') as GeoJSONSource | undefined)?.setData(turf.featureCollection(arcs.map((a) => turf.lineString(a.line, { color: a.color }))));
  arcLabels(arcs.map((a) => ({ at: a.label, offset: [a.side === 'R' ? 16 : -16, 0] as [number, number], html: `<span style="background:${a.color}">${a.yds}</span>` })));
}

/** Near the green: a line from you to the pin with the yardage on it. */
function renderPinLine(h: Hole, me: LngLat | null, pin: LngLat | null | undefined) {
  const to = pin ?? h.center;
  const near = me && !greenView && yd(me, h.center) <= APPROACH_YD;
  (map.getSource('pinline') as GeoJSONSource | undefined)?.setData(near ? turf.lineString([me!, to]) : turf.featureCollection([]));
  // The measure legs replace the dashed line of play while a target is down.
  map.setLayoutProperty('hole-line', 'visibility', near || shownTarget ? 'none' : 'visible');
  if (!near) { pinLabel.remove(); return; }
  const d = yd(me!, to);
  // Just short of the pin, so it sits on the green close-up.
  const back = Math.min(d * 0.9144 * 0.45, 22);
  label(pinLabel).textContent = fmt(d);
  pinLabel.setLngLat(turf.destination(to, back, turf.bearing(to, me!), { units: 'meters' }).geometry.coordinates as LngLat).addTo(map);
}

function usablePlayer(h: Hole): LngLat | null {
  return player && yd(player, h.center) <= MAX_GPS_YD ? player : null;
}

function renderHazards(h: Hole, me: LngLat | null) {
  if (!course || !state.hazards || greenView || editing) { hazardLabels([]); layupLabels([]); return; }
  const hz = hazardNumbers(course, h, me);
  // Labels sit beside the hazard, away from the line of play (the map is turned so you face the green).
  hazardLabels(hz.map((z) => ({ at: z.at, extra: z.kind, offset: [z.side === 'L' ? -26 : z.side === 'R' ? 26 : 0, 0] as [number, number], html: `<b>${fmt(z.reach)}</b><i>${fmt(z.carry)}</i>` })));
  const toGreen = me ? yd(me, h.center) : Infinity;
  layupLabels([]); // no numbers on the center line (the crosshair and arcs cover it)
}

function renderGreenInfo(h: Hole, frontPt: LngLat, backPt: LngLat) {
  const box = $('greeninfo');
  box.hidden = !greenView;
  $('greenview').setAttribute('aria-pressed', String(greenView));
  if (!greenView) return;
  const depth = yd(frontPt, backPt);
  const pin = pinOf(h);
  if (!h.green) { box.textContent = 'No green mapped for this hole.'; return; }
  if (pin) {
    // Where the pin sits along the line you're approaching on.
    const from = usablePlayer(h) ?? h.line[Math.max(0, h.line.length - 2)];
    const [f, b] = greenEdges({ ...h, center: pin }, from);
    box.innerHTML = `Depth <b>${fmt(depth)}</b> · Pin <b>${fmt(yd(f, pin))}</b> on, <b>${fmt(yd(pin, b))}</b> to back<br><small>Tap the green to move today's pin</small>`;
  } else {
    box.innerHTML = `Depth <b>${fmt(depth)}</b><br><small>Tap the green to set today's pin</small>`;
  }
}

function renderPace() {
  const t = round ? totals(round) : null;
  $('cardlbl').textContent = t?.holes ? `Card ${fmtToPar(t.toPar)}` : 'Card';
  // Pace banner across the top: green on pace or ahead, amber a little behind, red well behind.
  const el2 = $('pace');
  const wasHidden = el2.hidden;
  el2.hidden = !round || !course || !!round.finishedAt;
  if (wasHidden !== el2.hidden) map.resize();
  if (el2.hidden || !round || !course) return;
  const p = pace(round, course, state.hole);
  const d = Math.round(p.delta);
  el2.className = d > 5 ? 'bad' : d > 0 ? 'warn' : 'ok';
  el2.innerHTML = `<b>${d > 0 ? `${d} MIN BEHIND` : d < 0 ? `${-d} MIN AHEAD` : 'ON PACE'}</b><span>Round ${fmtClock(p.elapsed)}</span><span>This hole ${Math.floor(p.onHole)} min</span>`;
}

// ---------- Round ----------
function resumeRound(c: Course): Round | null {
  const r = state.roundId ? store.getRound(state.roundId) : null;
  if (r && r.courseId === c.id && !r.finishedAt && Date.now() - r.startedAt < ROUND_MAX_MS) return r;
  return null;
}

/** The round in progress; `create` starts one now (on the current hole). */
function getRound(create: boolean): Round | null {
  if (!round && create && course) {
    round = newRound(course, state.hole, state.paceTarget ?? DEFAULT_PACE_MIN);
    state.roundId = round.id;
    store.saveState(state);
    noteArrival();
    saveRound(round);
  }
  return round;
}

function saveRound(r: Round) {
  round = r;
  store.saveRound(r);
}

function noteArrival() {
  const h = hole();
  if (!round || !h || round.finishedAt) return;
  const s = (round.holes[h.ref] ??= {});
  if (!s.arrived) { s.arrived = Date.now(); saveRound(round); }
}

/** Today's pin for the hole (set in green view), if any. */
function pinOf(h: Hole): LngLat | undefined {
  return round?.holes[h.ref]?.pin;
}

// ---------- Location ----------
let watchId: number | null = null;

function onPosition(p: LngLat, acc: number) {
  const first = !player;
  player = p;
  accuracy = acc;
  lastFixAt = Date.now();
  playerMarker.setLngLat(p).addTo(map);
  if (course) {
    if (first && !editing && Date.now() - state.holeSetAt > ROUND_RESET_MS) {
      const at = holeAtStart(course.holes, p);
      if (at != null) {
        goHole(at, false);
        if (!round) { getRound(true); render(); } // starts the pace clock when you get to a tee
        return;
      }
    }
    if (state.auto && !editing) {
      const nxt = autoAdvance(course.holes, state.hole, p);
      if (nxt != null) return goHole(nxt, false);
    }
  }
  render();
  follow();
}

function startGps() {
  if (sim || watchId != null || !('geolocation' in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      // Ignore very rough fixes (wifi/cell) once we've had a good one.
      if (pos.coords.accuracy > 60 && player && accuracy < 60 && Date.now() - lastFixAt < 15000) return;
      onPosition([pos.coords.longitude, pos.coords.latitude], pos.coords.accuracy);
    },
    (err) => {
      $('gps').textContent = err.code === 1 ? 'Location blocked: allow it in Settings' : 'GPS: ' + err.message;
      $('gps').className = 'poor';
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// Location only works while on screen anyway; stop cleanly when hidden and restart on return.
document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? startGps() : stopGps()));

// Re-frame the hole when the screen rotates or resizes.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { const h = hole(); if (h && !flying) greenView ? fitGreen(h) : fitHole(h); }, 250);
});

// ---------- Controls ----------
$('prev').onclick = () => goHole(state.hole - 1, true);
$('next').onclick = () => goHole(state.hole + 1, true);
$('recenter').onclick = () => { if (editing) return editFrame(); const h = hole(); if (h) { userMoved = false; greenView ? fitGreen(h) : fitHole(h); } };
$('m-clear').onclick = () => { target = null; targetCleared = true; render(); };
$('greenview').onclick = () => { const h = hole(); if (!h) return; greenView = !greenView; target = null; showHole(true); };
$('fly').onclick = () => { if (flying) flying = false; else flyover(); };
initCard({
  course: () => course,
  hole,
  round: getRound,
  save: saveRound,
  newRound: () => {
    if (round && !round.finishedAt) { round.finishedAt = Date.now(); store.saveRound(round); }
    round = null;
    state.roundId = undefined;
    store.saveState(state);
    getRound(true);
    showHole(false);
  },
  finishRound: () => { if (round) { round.finishedAt = Date.now(); store.saveRound(round); round = null; state.roundId = undefined; store.saveState(state); showHole(false); } },
  goHole: (i) => goHole(i, true),
  changed: () => render(),
});
setInterval(() => { if (round && document.visibilityState === 'visible') renderPace(); }, 30000);
const autoBtn = $('auto');
const syncAuto = () => autoBtn.setAttribute('aria-pressed', String(state.auto));
autoBtn.onclick = () => { state.auto = !state.auto; store.saveState(state); syncAuto(); };
syncAuto();

const holePick = $<HTMLDialogElement>('holepick');
$('holeinfo').onclick = () => {
  if (!course) return;
  const grid = $('holegrid');
  grid.innerHTML = '';
  course.holes.forEach((h, i) => {
    const b = document.createElement('button');
    b.textContent = String(h.ref);
    if (i === state.hole) b.className = 'cur';
    b.onclick = () => { holePick.close(); goHole(i, true); };
    grid.appendChild(b);
  });
  holePick.showModal();
};


// ---------- Course editor ----------
// Mark tees, greens, doglegs, par and hazards on the satellite photo. Edits are kept per course on this
// device (over the OSM data, which is never changed), and can be exported as a course file to build in.

const HINTS: Record<Tool | 'none', string> = {
  none: 'Pick what to mark. Tap something you drew to delete it.',
  tee: 'Tap where you tee off. Tap again to move it.',
  green: 'Tap around the edge of the green, then Finish.',
  dogleg: 'Tap the aiming point at the corner (up to 2). Clear for a straight hole.',
  bunker: 'Tap around the edge of the bunker, then Finish.',
  water: 'Tap around the edge of the water, then Finish.',
  tree: 'Tap each tree.',
  woods: 'Tap around the edge of the trees, then Finish.',
};
/** Tools that draw an outline (tap around the edge, then Finish), and the shape each one makes. */
const OUTLINE: Partial<Record<Tool, 'green' | 'bunker' | 'water' | 'wood'>> = { green: 'green', bunker: 'bunker', water: 'water', woods: 'wood' };

/** Your edits for the open course, starting from the built-in course file if there is one. */
function myEdits(): CourseEdits {
  const c = baseCourse!;
  return store.getEdits(c.id) ?? structuredClone(bundledEdits(c.id)) ?? emptyEdits(c.id, c.name);
}
function commit(e: CourseEdits) {
  e.updatedAt = Date.now();
  store.saveEdits(e);
  redraw();
}

function startEditing() {
  if (!course || !baseCourse) return;
  const ref = course.holes[state.hole]?.ref ?? 1;
  editing = { ref, tool: null, pts: [], sel: null };
  target = null;
  greenView = false;
  document.body.classList.add('editing');
  map.doubleClickZoom.disable(); // quick taps around a green shouldn't zoom
  $('editbar').hidden = false;
  if (!state.satellite) { state.view = 'sat'; state.satellite = true; store.saveState(state); applyView(); }
  map.resize();
  editHole(ref);
}

function stopEditing() {
  if (!editing) return;
  const ref = editing.ref;
  editing = null;
  document.body.classList.remove('editing');
  map.doubleClickZoom.enable();
  $('editbar').hidden = true;
  (map.getSource('edit') as GeoJSONSource).setData(turf.featureCollection([]));
  map.resize();
  redraw();
  const i = course?.holes.findIndex((h) => h.ref === ref) ?? -1;
  goHole(i >= 0 ? i : 0, true);
}

function editRefs() {
  return baseCourse ? editableRefs(baseCourse, editsFor(baseCourse.id)) : [];
}

function editHole(ref: number) {
  if (!editing || !course) return;
  editing = { ref, tool: editing.tool, pts: [], sel: null };
  const i = course.holes.findIndex((h) => h.ref === ref);
  if (i >= 0) state.hole = i;
  showHole(false);
  editFrame();
}

/** Frames the hole being edited: the whole hole if it's mapped, else around the last green or the course. */
function editFrame() {
  if (!editing || !course) return;
  userMoved = false;
  const h = hole();
  if (h) return fitHole(h);
  const e = editsFor(course.id)?.holes[String(editing.ref)];
  const prev = [...course.holes].reverse().find((x) => x.ref < editing!.ref) ?? course.holes[0];
  const at = e?.tee ?? (e?.green && e.green[0]) ?? prev?.center;
  if (at) map.jumpTo({ center: at, zoom: 17.3, bearing: 0, pitch: 0 });
  else {
    const [w, s2, e2, n] = course.bbox;
    map.fitBounds([[w, s2], [e2, n]], { padding: 30, bearing: 0, pitch: 0, duration: 0 });
  }
}

/** Zooms in on what you're about to mark: the tee or the green (if the hole has one yet). */
function editFocus(tool: Tool) {
  if (!editing || !course) return;
  const h = hole();
  const e = editsFor(course.id)?.holes[String(editing.ref)];
  const at = tool === 'tee' ? e?.tee ?? h?.line[0] : tool === 'green' ? h?.center ?? (e?.green && e.green[0]) : null;
  if (!at) return;
  userMoved = true;
  // Keep it above the edit bar.
  const bar = $('editbar').getBoundingClientRect();
  const box = map.getContainer().getBoundingClientRect();
  const offset: [number, number] = wide() ? [-Math.max(0, box.right - bar.left) / 2, 0] : [0, -Math.max(0, box.bottom - bar.top) / 2];
  map.easeTo({ center: at, zoom: Math.max(map.getZoom(), tool === 'tee' ? 18.5 : 19.3), pitch: 0, offset, duration: 600 });
}

function editTap(p: LngLat, pt: maplibregl.Point) {
  if (!editing || !baseCourse) return;
  p = roundPt(p);
  const { tool, ref } = editing;
  if (!tool) {
    // Select a hazard, tree or woods you drew (to delete it).
    const hit = map.queryRenderedFeatures([[pt.x - 10, pt.y - 10], [pt.x + 10, pt.y + 10]], { layers: ['edit-pts', 'edit-fill'] }).find((f) => f.properties?.hid);
    editing.sel = (hit?.properties?.hid as string) ?? null;
    return drawEdit();
  }
  if (OUTLINE[tool]) {
    editing.pts.push(p);
    return drawEdit();
  }
  const e = myEdits();
  if (tool === 'tree') {
    (e.trees ??= []).push({ id: newId(), at: p });
    return commit(e);
  }
  const h = (e.holes[String(ref)] ??= {});
  if (tool === 'tee') h.tee = p;
  if (tool === 'dogleg') h.dogleg = [...(h.dogleg ?? []).slice(-1), p];
  commit(e);
}

const newId = () => Math.random().toString(36).slice(2, 10);

function editFinish() {
  if (!editing?.tool || editing.pts.length < 3) return;
  const ring = closeRing(editing.pts);
  const e = myEdits();
  if (editing.tool === 'green') {
    (e.holes[String(editing.ref)] ??= {}).green = ring;
    editing.tool = null; // one green per hole
  } else {
    e.hazards.push({ id: newId(), kind: OUTLINE[editing.tool] as 'bunker' | 'water' | 'wood', ring });
  }
  editing.pts = [];
  commit(e);
}

function editClear() {
  if (!editing) return;
  if (editing.pts.length) { editing.pts = []; return drawEdit(); }
  const e = myEdits();
  if (editing.sel) {
    e.hazards = e.hazards.filter((z) => z.id !== editing!.sel);
    e.trees = e.trees?.filter((t) => t.id !== editing!.sel);
    editing.sel = null;
    return commit(e);
  }
  const h = e.holes[String(editing.ref)];
  if (!h) return;
  if (editing.tool === 'tee') delete h.tee;
  else if (editing.tool === 'green') delete h.green;
  else if (editing.tool === 'dogleg') h.dogleg = [];
  else return;
  commit(e);
}

function setPar(par: number) {
  if (!editing) return;
  const e = myEdits();
  (e.holes[String(editing.ref)] ??= {}).par = par;
  commit(e);
}

/** The editor's own drawing (tee, doglegs, the shape in progress) and the edit bar's state. */
function drawEdit() {
  if (!editing || !course) return;
  const { ref, tool, pts, sel } = editing;
  const e = editsFor(course.id)?.holes[String(ref)];
  const h = course.holes.find((x) => x.ref === ref);
  const fs: GeoJSON.Feature[] = [];
  const tee = e?.tee ?? h?.line[0];
  if (h) fs.push(turf.lineString(h.line, { kind: 'line' }));
  if (h?.green) fs.push(turf.polygon([h.green], { kind: 'green' }));
  else if (e?.green && e.green.length >= 4) fs.push(turf.polygon([e.green], { kind: 'green' }));
  for (const d of h ? h.line.slice(1, -1) : e?.dogleg ?? []) fs.push(turf.point(d, { kind: 'dogleg' }));
  if (tee) fs.push(turf.point(tee, { kind: 'tee' }));
  const all = editsFor(course.id);
  for (const z of all?.hazards ?? []) if (z.ring.length >= 4) fs.push(turf.polygon([z.ring], { kind: z.kind, sel: z.id === sel, hid: z.id }));
  for (const t of all?.trees ?? []) fs.push(turf.point(t.at, { kind: 'tree', sel: t.id === sel, hid: t.id }));
  const shape = tool ? OUTLINE[tool] : undefined;
  if (pts.length >= 3) fs.push(turf.polygon([closeRing(pts)], { kind: shape, drawing: true }));
  else if (pts.length === 2) fs.push(turf.lineString(pts, { kind: shape, drawing: true }));
  for (const q of pts) fs.push(turf.point(q, { kind: 'vertex' }));
  (map.getSource('edit') as GeoJSONSource).setData(turf.featureCollection(fs));

  $('e-ref').textContent = String(ref);
  const par = e?.par ?? h?.par;
  document.querySelectorAll<HTMLButtonElement>('#e-par button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.par) === par)));
  document.querySelectorAll<HTMLButtonElement>('.e-tools button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    const t = b.dataset.tool;
    b.classList.toggle('has', (t === 'tee' && !!tee) || (t === 'green' && !!(h?.green || e?.green)) || (t === 'dogleg' && !!h && h.line.length > 2));
  });
  const drawing = !!(tool && OUTLINE[tool]);
  const missing = [!tee && 'tee', !(h?.green || e?.green) && 'green', !par && 'par'].filter(Boolean).join(', ');
  let hint = sel ? 'Selected. Delete removes it.' : HINTS[tool ?? 'none'];
  if (drawing && pts.length) hint = `${pts.length} point${pts.length > 1 ? 's' : ''}. ${pts.length < 3 ? 'Keep tapping around the edge.' : 'Finish when you’re back at the start.'}`;
  if (!tool && !sel && missing) hint = `Hole ${ref} still needs: ${missing}.`;
  $('e-hint').textContent = hint;
  $<HTMLButtonElement>('e-undo').hidden = !(drawing && pts.length);
  $<HTMLButtonElement>('e-finish').hidden = !drawing;
  $<HTMLButtonElement>('e-finish').disabled = pts.length < 3;
  $<HTMLButtonElement>('e-clear').hidden = !(pts.length || sel || tool === 'tee' || tool === 'green' || tool === 'dogleg');
  $('e-clear').textContent = sel ? 'Delete' : pts.length ? 'Start over' : 'Clear';
}

$('e-prev').onclick = () => { const r = editRefs(); const i = r.indexOf(editing?.ref ?? 1); editHole(r[Math.max(0, i - 1)]); };
$('e-next').onclick = () => { const r = editRefs(); const i = r.indexOf(editing?.ref ?? 1); editHole(r[Math.min(r.length - 1, i + 1)]); };
$('e-done').onclick = () => stopEditing();
$('e-undo').onclick = () => { if (editing) { editing.pts.pop(); drawEdit(); } };
$('e-finish').onclick = () => editFinish();
$('e-clear').onclick = () => editClear();
document.querySelectorAll<HTMLButtonElement>('#e-par button').forEach((b) => (b.onclick = () => setPar(Number(b.dataset.par))));
document.querySelectorAll<HTMLButtonElement>('.e-tools button').forEach((b) => (b.onclick = () => {
  if (!editing) return;
  const t = b.dataset.tool as Tool;
  editing.tool = editing.tool === t ? null : t;
  editing.pts = [];
  editing.sel = null;
  drawEdit();
  if (editing.tool) editFocus(editing.tool);
}));

/** A file name for the course file, e.g. westbrook-village-lakes.json. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'course';

async function exportEdits() {
  if (!baseCourse) return msg('Open a course first.');
  const e = editsFor(baseCourse.id);
  if (!e) return msg('Nothing to export yet: use Edit course map first.');
  const name = BUILTIN.find((b) => b.id === baseCourse!.id)?.name ?? baseCourse.name;
  const full = course ? completeEdits(course, e) : e; // include tees/greens that came from OSM
  const file = new File([JSON.stringify({ ...full, name }, null, 1)], `${slug(name)}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

$('edit-course').onclick = () => { if (!course) return msg('Open a course first.'); sheet.close(); startEditing(); };
$('export-edits').onclick = () => exportEdits();
$('import-edits').onclick = () => $<HTMLInputElement>('import-file').click();
$<HTMLInputElement>('import-file').onchange = async (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  (ev.target as HTMLInputElement).value = '';
  if (!f) return;
  try {
    const e = parseEditsFile(await f.text());
    store.saveEdits(e);
    if (baseCourse?.id === e.courseId) { redraw(); msg(`Imported ${e.name}.`); }
    else msg(`Imported ${e.name}. Open that course to use it.`);
    renderEditStatus();
  } catch (err) {
    msg((err as Error).message);
  }
};
$('discard-edits').onclick = () => {
  if (!baseCourse || !store.getEdits(baseCourse.id)) return msg('No changes on this device for this course.');
  if (!window.confirm(`Discard your map changes for ${baseCourse.name} on this device?${bundledEdits(baseCourse.id) ? '\n\nThe built-in course file stays.' : ''}`)) return;
  store.deleteEdits(baseCourse.id);
  redraw();
  renderEditStatus();
  msg('Changes discarded.');
};

/** "12 of 18 holes mapped · yours, not exported" in the Courses sheet. */
function renderEditStatus() {
  const el2 = $('edit-status');
  if (!course || !baseCourse) { el2.textContent = 'Open a course, then mark its tees, greens and hazards on the satellite photo.'; return; }
  const mine = store.getEdits(baseCourse.id);
  const built = bundledEdits(baseCourse.id);
  const p = progressOf(course, editRefs());
  const src = mine ? 'Your changes are saved on this device. Export the course file to build them into the app.' : built ? 'Using the course file built into the app.' : 'Using OpenStreetMap data only.';
  el2.textContent = `${p.done} of ${p.total} holes have a green. ${src}`;
}

function renderBuiltin() {
  const ul = $('builtin');
  ul.innerHTML = '';
  for (const b of BUILTIN) {
    const li = document.createElement('li');
    const go = document.createElement('button');
    go.className = 'go';
    const file = bundledEdits(b.id);
    const mine = store.getEdits(b.id);
    const n = Object.values((mine ?? file)?.holes ?? {}).filter((h) => h.green).length;
    const greens = `${n} green${n === 1 ? '' : 's'}`;
    go.innerHTML = `${esc(b.name)}<small>${mine ? `Your map: ${greens}` : file ? `Built-in map: ${greens}` : 'Not mapped yet'}</small>`;
    go.onclick = () => openCourse({ id: b.id, name: b.name, center: b.center });
    li.append(go);
    ul.appendChild(li);
  }
}

// ---------- Course sheet ----------
const sheet = $<HTMLDialogElement>('sheet');
/** Message line in the Courses sheet, optionally with a button (e.g. Try again). */
function msg(t: string, action?: { label: string; run: () => void }) {
  const el = $('msg');
  el.textContent = t;
  if (action) {
    const b = document.createElement('button');
    b.className = 'retry';
    b.textContent = action.label;
    b.onclick = action.run;
    el.append(' ', b);
  }
}
$('menu').onclick = openSheet;
$('coursename').onclick = openSheet;

function openSheet() {
  renderSaved();
  renderBuiltin();
  renderEditStatus();
  $<HTMLInputElement>('sat').checked = state.satellite;
  $<HTMLInputElement>('sim').checked = sim;
  $<HTMLInputElement>('hazards').checked = state.hazards !== false;
  $<HTMLSelectElement>('pace-target').value = String(state.paceTarget ?? DEFAULT_PACE_MIN);
  $<HTMLSelectElement>('drive').value = String(state.drive ?? DEFAULT_DRIVE_YD);
  sheet.showModal();
}

function renderSaved() {
  const ul = $('saved');
  ul.innerHTML = '';
  const list = store.savedCourses();
  if (!list.length) ul.innerHTML = '<li><small>None yet. Courses you open are saved here automatically.</small></li>';
  for (const s of list) {
    const li = document.createElement('li');
    const go = document.createElement('button');
    go.className = 'go';
    go.innerHTML = `${esc(s.name)}<small>Saved ${new Date(s.fetchedAt).toLocaleDateString()}</small>`;
    go.onclick = () => { const c = store.getCourse(s.id); if (c) { setCourse(c); sheet.close(); } };
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.onclick = () => { store.deleteCourse(s.id); renderSaved(); };
    li.append(go, del);
    ul.appendChild(li);
  }
}

function renderResults(hits: CourseHit[]) {
  const ul = $('results');
  ul.innerHTML = '';
  for (const h of hits) {
    const li = document.createElement('li');
    const go = document.createElement('button');
    go.className = 'go';
    go.innerHTML = `${esc(h.name)}${h.where ? `<small>${esc(h.where)}</small>` : ''}`;
    go.onclick = () => openCourse(h);
    li.append(go);
    ul.appendChild(li);
  }
}

async function openCourse(h: CourseHit, force = false) {
  const cached = !force && store.getCourse(h.id);
  if (cached) { setCourse(cached); sheet.close(); if (!course?.holes.length) startEditing(); return; }
  msg(`Loading ${h.name} from OpenStreetMap…`);
  setButtonsBusy(true);
  progress(0, 'Starting');
  try {
    const c = await loadCourse(h.id, h.name, progress);
    stepProgress(progress, 'save');
    store.saveCourse(c);
    stepProgress(progress, 'scenery');
    await nextFrame();
    setCourse(c);
    const n = course?.holes.length ?? 0;
    progress(1, `Loaded ${n} holes`);
    msg(n ? `Loaded ${n} holes. Saved for offline.` : 'No holes are mapped for this course yet. Opening the editor so you can map it.');
    await new Promise((r) => setTimeout(r, n ? 500 : 1500)); // let the full bar show for a moment
    sheet.close();
    if (!n) startEditing();
  } catch (e) {
    msg(`Couldn't load ${h.name}. ${(e as Error).message}`, { label: 'Try again', run: () => openCourse(h, force) });
  } finally {
    progress(null);
    setButtonsBusy(false);
  }
}

/** The loading bar in the Courses sheet. `null` hides it. */
function progress(frac: number | null, label = '') {
  const bar = $('loadbar');
  bar.hidden = frac == null;
  if (frac == null) return;
  const pctDone = Math.round(frac * 100);
  // Never go backwards (e.g. a slower server's bytes after a faster one's).
  const prev = Number(bar.getAttribute('aria-valuenow') ?? 0);
  const shown = frac === 0 ? 0 : Math.max(prev, pctDone);
  bar.setAttribute('aria-valuenow', String(shown));
  bar.querySelector<HTMLElement>('i')!.style.width = shown + '%';
  bar.querySelector('span')!.textContent = label;
  bar.querySelector('b')!.textContent = shown + '%';
}

/** Course buttons do nothing while a load is running, so you can't start two at once. */
function setButtonsBusy(on: boolean) {
  for (const id of ['search', 'near', 'test-course', 'refresh', 'dl-tiles', 'reset']) $<HTMLButtonElement>(id).disabled = on;
  document.querySelectorAll<HTMLButtonElement>('#results button, #saved button').forEach((b) => (b.disabled = on));
}

$('search').onclick = async () => {
  const q = $<HTMLInputElement>('q').value.trim();
  if (!q) return;
  msg('Searching…');
  try {
    const hits = await searchCourses(q);
    renderResults(hits);
    msg(hits.length ? '' : 'No golf courses found by that name.');
  } catch (e) {
    msg((e as Error).message);
  }
};
$('q').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('search').click(); });

$('near').onclick = () => {
  msg('Finding your location…');
  const go = async (p: LngLat) => {
    msg('Looking for courses nearby…');
    try {
      const hits = await coursesNear(p);
      renderResults(hits);
      msg(hits.length ? '' : 'No courses within 25 km.');
    } catch (e) {
      msg((e as Error).message, { label: 'Try again', run: () => $('near').click() });
    }
  };
  if (player) return go(player);
  navigator.geolocation.getCurrentPosition((pos) => go([pos.coords.longitude, pos.coords.latitude]), (err) => msg(err.message), { timeout: 15000 });
};
$('test-course').onclick = async () => {
  let id = '';
  try { id = localStorage.getItem(TEST_COURSE.key) ?? ''; } catch { /* ignore */ }
  if (!id) {
    msg(`Finding ${TEST_COURSE.name}…`);
    setButtonsBusy(true);
    try {
      // By position, not by name: the name search was unreliable.
      const hit = await courseAt(TEST_COURSE.center, /auburn/i);
      if (!hit) throw new Error('Course not found in OpenStreetMap');
      id = hit.id;
      try { localStorage.setItem(TEST_COURSE.key, id); } catch { /* ignore */ }
    } catch (e) {
      return msg(`Couldn't find ${TEST_COURSE.name}. ${(e as Error).message}`, { label: 'Try again', run: () => $('test-course').click() });
    } finally {
      setButtonsBusy(false);
    }
  }
  openCourse({ id, name: TEST_COURSE.name, center: TEST_COURSE.center });
};
$('refresh').onclick = () => { if (course) openCourse({ id: course.id, name: course.name, center: [0, 0] }, true); };

$('dl-tiles').onclick = async () => {
  if (!course) return msg('Open a course first.');
  if (!('caches' in window)) return msg('Offline maps need a secure (https) page.');
  const btn = $<HTMLButtonElement>('dl-tiles');
  btn.disabled = true;
  try {
    progress(0, 'Downloading map');
    const r = await prefetchTiles(course.bbox, (d, t) => { msg(''); progress(d / t, `Downloading map ${d}/${t} tiles`); });
    progress(null);
    msg(r.failed ? `Saved ${r.total - r.failed}/${r.total} tiles (${r.failed} failed, try again on better signal).` : `Map saved for offline (${r.total} tiles).`);
  } finally {
    progress(null);
    btn.disabled = false;
  }
};

// Wipes everything this app keeps on the device, then reloads a fresh copy.
$('reset').onclick = async () => {
  if (!window.confirm('Clear everything and reset the app?\n\nThis deletes saved courses, offline maps, all rounds and scores, and settings on this device. It cannot be undone.')) return;
  msg('Clearing…');
  await resetApp();
  location.reload();
};

async function resetApp() {
  try { localStorage.clear(); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  // The app sets no cookies, but clear any this site has anyway.
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
  try {
    if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* ignore */ }
  try {
    if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  } catch { /* ignore */ }
}

$<HTMLInputElement>('sat').onchange = (e) => setView((e.target as HTMLInputElement).checked ? 'sat' : '3d');
// Cycles 3D -> 2D -> Sat.
$('viewtoggle').onclick = () => setView(state.view === '3d' ? '2d' : state.view === '2d' ? 'sat' : '3d');

/**
 * 3D: tilted drawn map with raised trees and buildings (default). 2D: the same map flat, from above.
 * Sat: satellite photo with light course outlines.
 */
function setView(v: store.MapView) {
  state.view = v;
  state.satellite = v === 'sat';
  store.saveState(state);
  applyView();
  const h = hole();
  if (h) greenView ? fitGreen(h) : fitHole(h);
}
function applyView() {
  const on = state.satellite;
  // Green view is always flat and from above, so trees go back to flat canopies there.
  const is3d = state.view === '3d' && !greenView;
  map.setLayoutProperty('sat', 'visibility', on ? 'visible' : 'none');
  map.setPaintProperty('bg', 'background-color', on ? '#0d2a14' : MAP.bg);
  for (const k of GOLF_FILLS) map.setPaintProperty(k, 'fill-opacity', on ? 0.18 : 0.95);
  for (const k of SCENERY) map.setLayoutProperty(k, 'visibility', on ? 'none' : 'visible');
  map.setPaintProperty('cartpath', 'line-opacity', on ? 0.6 : 1);
  // In 3D the trees stand up; their flat shadows stay on the ground.
  map.setLayoutProperty('trees3d', 'visibility', is3d ? 'visible' : 'none');
  const cut = state.cutout !== false;
  for (const k of ['cutout', 'cutout-edge']) map.setLayoutProperty(k, 'visibility', cut ? 'visible' : 'none');
  map.setLayoutProperty('holes', 'visibility', cut ? 'none' : 'visible');
  $<HTMLInputElement>('cutout').checked = cut;
  for (const k of ['tree', 'treerow']) map.setLayoutProperty(k, 'visibility', !on && !is3d ? 'visible' : 'none');
  // The button shows the view you're in; tapping moves to the next.
  $('viewtoggle').textContent = state.view === '3d' ? '3D' : on ? 'Sat' : '2D';
  $<HTMLInputElement>('sat').checked = on;
}
$<HTMLInputElement>('cutout').onchange = (e) => {
  state.cutout = (e.target as HTMLInputElement).checked;
  store.saveState(state);
  const h = hole();
  if (h) updateCutout(h);
  applyView();
};
$<HTMLSelectElement>('drive').onchange = (e) => {
  state.drive = Number((e.target as HTMLSelectElement).value);
  store.saveState(state);
  render();
};
$<HTMLInputElement>('hazards').onchange = (e) => { state.hazards = (e.target as HTMLInputElement).checked; store.saveState(state); render(); };
$<HTMLSelectElement>('pace-target').onchange = (e) => {
  state.paceTarget = Number((e.target as HTMLSelectElement).value);
  store.saveState(state);
  if (round) { round.paceTarget = state.paceTarget; saveRound(round); }
  render();
};
$<HTMLInputElement>('sim').onchange = (e) => {
  sim = (e.target as HTMLInputElement).checked;
  if (sim) stopGps();
  else { player = null; playerMarker.remove(); startGps(); }
  render();
};

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---------- Start ----------
map.on('load', () => {
  applyView();
  // Start with the attribution collapsed to its (i) button so it doesn't cover the map.
  const attrib = document.querySelector('.maplibregl-ctrl-attrib');
  attrib?.classList.remove('maplibregl-compact-show');
  attrib?.removeAttribute('open');
  const c = state.courseId ? store.getCourse(state.courseId) : null;
  if (c) setCourse(c, true);
  else openSheet();
  startGps();
  const simAt = params.get('sim');
  if (simAt && simAt.includes(',')) {
    const [lat, lon] = simAt.split(',').map(Number);
    onPosition([lon, lat], 3);
  }
});

keepAwake((on) => ($('wake').textContent = on ? 'Screen stays on' : wakeLockSupported() ? 'Tap to keep screen on' : 'Set Auto-Lock to Never'));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js');
}

// For tests / debugging in the console.
(window as any).golf = { map, goHole, get course() { return course; }, get state() { return state; }, get round() { return round; }, get target() { return target; }, onPosition, setCourse, startEditing, stopEditing, get editing() { return editing; } };
