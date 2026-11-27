import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { Course, Hole, LngLat } from './types.ts';
import { autoAdvance, holeAtStart } from './advance.ts';
import { COURSE_DATA_VERSION } from './course.ts';
import { scenery3d } from './scenery3d.ts';
import { holeCorridor, holeMask, insideCorridor, framing, APPROACH_YD } from './cutout.ts';
import { loadCourse, searchCourses, coursesNear, stepProgress, nextFrame, type CourseHit } from './overpass.ts';
import * as store from './storage.ts';
import { keepAwake, wakeLockSupported } from './wakelock.ts';
import { SAT_URL, SAT_ATTRIB, prefetchTiles } from './tiles.ts';
import { hazardNumbers, layupMarks } from './hazards.ts';
import { type Round, newRound, markShot, undoShot, shotDistances, pace, fmtClock, totals, fmtToPar, DEFAULT_PACE_MIN } from './round.ts';
import { initCard, renderCard } from './card.ts';
import { greenNumbers, measure, yd, pathYd, MAX_GPS_YD, greenEdges } from './yardage.ts';

const TEST_COURSE: CourseHit = { id: 'way/23143257', name: 'Allenmore Golf Course', center: [-122.4727, 47.2391] };
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
      shots: { type: 'geojson', data: turf.featureCollection([]) },
      scenery3d: { type: 'geojson', data: turf.featureCollection([]) },
      cutout: { type: 'geojson', data: turf.featureCollection([]) },
      pinline: { type: 'geojson', data: turf.featureCollection([]) },
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
      { id: 'hole-line', type: 'line', source: 'hole', paint: { 'line-color': '#fff', 'line-width': 3, 'line-dasharray': [2, 2] } },
      { id: 'shot-line', type: 'line', source: 'shots', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#ff7a1a', 'line-width': 2.5 } },
      { id: 'shot-pt', type: 'circle', source: 'shots', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ff7a1a', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } },
      { id: 'pinline', type: 'line', source: 'pinline', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fff', 'line-width': 2.5, 'line-opacity': 0.95 } },
      { id: 'measure-line', type: 'line', source: 'measure', paint: { 'line-color': '#ffd400', 'line-width': 3 } },
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
const targetMarker = new maplibregl.Marker({ element: el('dot-target'), draggable: true });
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
      const e = m.getElement();
      if (e.innerHTML !== it.html) e.innerHTML = it.html;
      e.classList.toggle('bunker', it.extra === 'bunker');
      e.classList.toggle('water', it.extra === 'water');
      m.setOffset(it.offset ?? [0, 0]).setLngLat(it.at).addTo(map);
    });
  };
}
const hazardLabels = markerPool('hz');
const layupLabels = markerPool('lay');

function el(cls: string, text = '') {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}

targetMarker.on('drag', () => {
  const p = targetMarker.getLngLat();
  target = [p.lng, p.lat];
  render();
});

map.on('click', (e) => {
  const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
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
function setCourse(c: Course, keepHole = false) {
  course = c;
  $('coursename').textContent = c.name;
  round = resumeRound(c);
  state.courseId = c.id;
  const fresh = Date.now() - state.holeSetAt > ROUND_RESET_MS;
  if (!keepHole || fresh || state.hole >= c.holes.length) state.hole = 0;
  store.saveState(state);
  (map.getSource('course') as GeoJSONSource).setData(c.features);
  sceneryAll = scenery3d(c);
  target = null;
  if (player) {
    const at = holeAtStart(c.holes, player);
    if (at != null && fresh) state.hole = at;
  }
  showHole(true);
  upgradeCourse(c);
}

/** All raised trees for the course; the hole cutout shows only the ones on the current hole. */
let sceneryAll: GeoJSON.FeatureCollection = turf.featureCollection([]);

/** Darkens everything but the current hole (when the cutout is on) and keeps raised trees to the hole. */
function updateCutout(h: Hole) {
  const on = state.cutout !== false;
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
      course = fresh;
      (map.getSource('course') as GeoJSONSource).setData(fresh.features);
      sceneryAll = scenery3d(fresh);
      showHole(false);
    })
    .catch(() => { /* try again next time */ })
    .finally(() => { upgrading = ''; });
}

function hole(): Hole | null {
  return course ? course.holes[state.hole] ?? null : null;
}

/** `manual` = picked by hand. Auto-advance then carries on from the hole you picked. */
function goHole(i: number, _manual: boolean) {
  if (!course) return;
  state.hole = Math.max(0, Math.min(course.holes.length - 1, i));
  state.holeSetAt = Date.now();
  store.saveState(state);
  target = null;
  greenView = false;
  noteArrival();
  showHole(true);
}

function showHole(fit: boolean) {
  const h = hole();
  if (!h) return;
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
 * Map bearing that puts `from -> to` pointing up the screen (portrait), or from the bottom-left corner
 * toward the top-right corner of the open map area (landscape).
 */
function playBearing(from: LngLat, to: LngLat) {
  const b = turf.bearing(from, to);
  if (!wide()) return b;
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const pad = fitPadding();
  const up = (Math.atan2(h - pad.top - pad.bottom, w - pad.left - pad.right) * 180) / Math.PI; // diagonal, degrees above horizontal
  return b - (90 - up);
}

/** Room the overlays (hole card, tool buttons, shot bar) leave for the hole. */
function fitPadding() {
  return wide() ? { top: 118, bottom: 56, left: 24, right: 76 } : { top: 124, bottom: 52, left: 24, right: 72 };
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
  if (!h || !player || greenView || flying || target || userMoved) return;
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
  fitPoints(pts, bearing, 0, wide() ? { top: 70, bottom: 40, left: 40, right: 80 } : { top: 70, bottom: 40, left: 40, right: 70 }, 21);
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

// ---------- Numbers ----------
const fmt = (n: number) => String(Math.round(n));

function render() {
  const h = hole();
  if (!h) return;
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
  renderGreenInfo(h, n.frontPt, n.backPt);
  renderShots(h);
  renderPace();

  if (target) {
    const m = measure(h, player, target);
    $('measure').hidden = false;
    $('m-to').textContent = fmt(m.toTarget);
    $('m-then').textContent = fmt(m.targetToCenter);
    targetMarker.setLngLat(target).addTo(map);
    (map.getSource('measure') as GeoJSONSource).setData(turf.lineString([m.from, target, h.center]));
  } else {
    $('measure').hidden = true;
    targetMarker.remove();
    (map.getSource('measure') as GeoJSONSource | undefined)?.setData(turf.featureCollection([]));
  }
}

/** Near the green: a line from you to the pin with the yardage on it. */
function renderPinLine(h: Hole, me: LngLat | null, pin: LngLat | null | undefined) {
  const to = pin ?? h.center;
  const near = me && !greenView && yd(me, h.center) <= APPROACH_YD;
  (map.getSource('pinline') as GeoJSONSource | undefined)?.setData(near ? turf.lineString([me!, to]) : turf.featureCollection([]));
  map.setLayoutProperty('hole-line', 'visibility', near ? 'none' : 'visible');
  if (!near) { pinLabel.remove(); return; }
  const d = yd(me!, to);
  // Just short of the pin, so it sits on the green close-up.
  const back = Math.min(d * 0.9144 * 0.45, 22);
  pinLabel.getElement().textContent = fmt(d);
  pinLabel.setLngLat(turf.destination(to, back, turf.bearing(to, me!), { units: 'meters' }).geometry.coordinates as LngLat).addTo(map);
}

function usablePlayer(h: Hole): LngLat | null {
  return player && yd(player, h.center) <= MAX_GPS_YD ? player : null;
}

function renderHazards(h: Hole, me: LngLat | null) {
  if (!course || !state.hazards || greenView) { hazardLabels([]); layupLabels([]); return; }
  const hz = hazardNumbers(course, h, me);
  // Labels sit beside the hazard, away from the line of play (the map is turned so you face the green).
  hazardLabels(hz.map((z) => ({ at: z.at, extra: z.kind, offset: [z.side === 'L' ? -26 : z.side === 'R' ? 26 : 0, 0] as [number, number], html: `<b>${fmt(z.reach)}</b><i>${fmt(z.carry)}</i>` })));
  const toGreen = me ? yd(me, h.center) : Infinity;
  const lay = h.par === 3 ? [] : layupMarks(h, me).filter((l) => l.toGreen < toGreen - 20);
  layupLabels(lay.map((l) => ({ at: l.at, html: me ? `${l.toGreen}<small>${fmt(yd(me, l.at))}</small>` : String(l.toGreen) })));
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

function renderShots(h: Hole) {
  const s = round?.holes[h.ref];
  const shots = s?.shots ?? [];
  const fc: GeoJSON.Feature[] = shots.map((p) => turf.point(p.at));
  if (shots.length > 1) fc.push(turf.lineString(shots.map((p) => p.at)));
  const me = usablePlayer(h);
  const last = shots[shots.length - 1];
  // Live: from your last mark to where you are now (walking to the ball).
  if (last && me) fc.push(turf.lineString([last.at, me]));
  (map.getSource('shots') as GeoJSONSource | undefined)?.setData(turf.featureCollection(fc));
  const d = shotDistances(s);
  const info = $('shotinfo');
  if (last && me && (yd(last.at, me) >= 5 || !d.length)) info.innerHTML = `Shot ${shots.length}: <b>${fmt(yd(last.at, me))}</b> yd`;
  else if (d.length) info.innerHTML = `Last shot <b>${fmt(d[d.length - 1])}</b> yd`;
  else info.textContent = me ? '' : 'Shot tracking needs GPS on this hole';
  $('shot-undo').hidden = !shots.length;
  $<HTMLButtonElement>('shot').disabled = !me;
  $('shot').querySelector('span')!.textContent = shots.length ? `Shot ${shots.length + 1}` : 'Tee shot';
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
    if (first && Date.now() - state.holeSetAt > ROUND_RESET_MS) {
      const at = holeAtStart(course.holes, p);
      if (at != null) {
        goHole(at, false);
        if (!round) { getRound(true); render(); } // starts the pace clock when you get to a tee
        return;
      }
    }
    if (state.auto) {
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
$('recenter').onclick = () => { const h = hole(); if (h) { userMoved = false; greenView ? fitGreen(h) : fitHole(h); } };
$('m-clear').onclick = () => { target = null; render(); };
$('greenview').onclick = () => { const h = hole(); if (!h) return; greenView = !greenView; target = null; showHole(true); };
$('fly').onclick = () => { if (flying) flying = false; else flyover(); };
$('shot').onclick = () => {
  const h = hole();
  if (!h) return;
  const me = usablePlayer(h);
  if (!me) return;
  const r = getRound(true)!;
  markShot(r, h.ref, me);
  saveRound(r);
  render();
};
$('shot-undo').onclick = () => { const h = hole(); if (h && round) { undoShot(round, h.ref); saveRound(round); render(); } };
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
  $<HTMLInputElement>('sat').checked = state.satellite;
  $<HTMLInputElement>('sim').checked = sim;
  $<HTMLInputElement>('hazards').checked = state.hazards !== false;
  $<HTMLSelectElement>('pace-target').value = String(state.paceTarget ?? DEFAULT_PACE_MIN);
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
  if (cached) { setCourse(cached); sheet.close(); return; }
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
    progress(1, `Loaded ${c.holes.length} holes`);
    msg(`Loaded ${c.holes.length} holes. Saved for offline.`);
    await new Promise((r) => setTimeout(r, 500)); // let the full bar show for a moment
    sheet.close();
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
$('test-course').onclick = () => openCourse(TEST_COURSE);
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
  // Start with the attribution collapsed to its (i) button so it doesn't cover the shot bar.
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
(window as any).golf = { map, goHole, get course() { return course; }, get state() { return state; }, get round() { return round; }, onPosition, setCourse };
