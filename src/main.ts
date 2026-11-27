import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import * as turf from '@turf/turf';
import type { Course, Hole, LngLat } from './types.ts';
import { greenNumbers, measure } from './yardage.ts';
import { autoAdvance, holeAtStart } from './advance.ts';
import { loadCourse, searchCourses, coursesNear, type CourseHit } from './overpass.ts';
import * as store from './storage.ts';
import { keepAwake, wakeLockSupported } from './wakelock.ts';
import { SAT_URL, SAT_ATTRIB, prefetchTiles } from './tiles.ts';

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

// ---------- Map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      sat: { type: 'raster', tiles: [SAT_URL], tileSize: 256, maxzoom: 19, attribution: SAT_ATTRIB },
      course: { type: 'geojson', data: turf.featureCollection([]), attribution: '© OpenStreetMap contributors' },
      hole: { type: 'geojson', data: turf.featureCollection([]) },
      measure: { type: 'geojson', data: turf.featureCollection([]) },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0d2a14' } },
      { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: state.satellite ? 'visible' : 'none' } },
      fill('fairway', '#3c9a3f'),
      fill('tee', '#58b85c'),
      fill('green', '#7be07f'),
      fill('bunker', '#e9dca6'),
      fill('water', '#2f7fd6'),
      { id: 'green-line', type: 'line', source: 'course', filter: ['==', ['get', 'kind'], 'green'], paint: { 'line-color': '#fff', 'line-width': 1.5 } },
      { id: 'cartpath', type: 'line', source: 'course', filter: ['==', ['get', 'kind'], 'cartpath'], paint: { 'line-color': '#999', 'line-width': 1, 'line-opacity': 0.6 } },
      { id: 'holes', type: 'line', source: 'course', filter: ['==', ['get', 'kind'], 'hole'], paint: { 'line-color': '#fff', 'line-width': 1, 'line-opacity': 0.25 } },
      { id: 'hole-line', type: 'line', source: 'hole', paint: { 'line-color': '#fff', 'line-width': 3, 'line-dasharray': [2, 2] } },
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
  return { id: kind, type: 'fill', source: 'course', filter: ['==', ['get', 'kind'], kind], paint: { 'fill-color': color, 'fill-opacity': state.satellite ? 0.18 : 0.85 } };
}

const playerMarker = new maplibregl.Marker({ element: el('dot-player') });
const targetMarker = new maplibregl.Marker({ element: el('dot-target'), draggable: true });
const flagMarker = new maplibregl.Marker({ element: el('flag', '⛳'), anchor: 'bottom-left', offset: [-4, 0] });
const frontMarker = new maplibregl.Marker({ element: el('edge') });
const backMarker = new maplibregl.Marker({ element: el('edge') });

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
  state.courseId = c.id;
  const fresh = Date.now() - state.holeSetAt > ROUND_RESET_MS;
  if (!keepHole || fresh || state.hole >= c.holes.length) state.hole = 0;
  store.saveState(state);
  (map.getSource('course') as GeoJSONSource).setData(c.features);
  target = null;
  if (player) {
    const at = holeAtStart(c.holes, player);
    if (at != null && fresh) state.hole = at;
  }
  showHole(true);
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
  showHole(true);
}

function showHole(fit: boolean) {
  const h = hole();
  if (!h) return;
  $('holeno').textContent = String(h.ref);
  $('holemeta').textContent = [h.par && `Par ${h.par}`, h.handicap && `HCP ${h.handicap}`].filter(Boolean).join(' · ');
  (map.getSource('hole') as GeoJSONSource).setData(turf.lineString(h.line));
  flagMarker.setLngLat(h.pin ?? h.center).addTo(map);
  if (fit) fitHole(h);
  render();
}

/** Tee at the bottom, green at the top. Includes you if you're on this hole. */
function fitHole(h: Hole) {
  const pts: LngLat[] = [...h.line, ...(h.green ?? [])];
  if (player && turf.distance(player, h.center, { units: 'meters' }) < 640) pts.push(player);
  const bearing = turf.bearing(h.line[0], h.center);
  const cam = map.cameraForBounds(turf.bbox(turf.multiPoint(pts)) as [number, number, number, number], { bearing, padding: { top: 110, bottom: 30, left: 50, right: 50 }, maxZoom: 19 });
  if (cam) map.jumpTo({ ...cam, bearing });
}

// ---------- Numbers ----------
const fmt = (n: number) => String(Math.round(n));

function render() {
  const h = hole();
  if (!h) return;
  const n = greenNumbers(h, player);
  $('front').textContent = fmt(n.front);
  $('center').textContent = fmt(n.center);
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
      if (at != null) return goHole(at, false);
    }
    if (state.auto) {
      const nxt = autoAdvance(course.holes, state.hole, p);
      if (nxt != null) return goHole(nxt, false);
    }
  }
  render();
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
  resizeTimer = window.setTimeout(() => { const h = hole(); if (h) fitHole(h); }, 250);
});

// ---------- Controls ----------
$('prev').onclick = () => goHole(state.hole - 1, true);
$('next').onclick = () => goHole(state.hole + 1, true);
$('recenter').onclick = () => { const h = hole(); if (h) fitHole(h); };
$('m-clear').onclick = () => { target = null; render(); };
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
const msg = (t: string) => ($('msg').textContent = t);
$('menu').onclick = openSheet;

function openSheet() {
  renderSaved();
  $<HTMLInputElement>('sat').checked = state.satellite;
  $<HTMLInputElement>('sim').checked = sim;
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
  try {
    const c = await loadCourse(h.id, h.name);
    store.saveCourse(c);
    setCourse(c);
    msg(`Loaded ${c.holes.length} holes. Saved for offline.`);
    sheet.close();
  } catch (e) {
    msg(`Couldn't load: ${(e as Error).message}`);
  }
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
      msg((e as Error).message);
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
    const r = await prefetchTiles(course.bbox, (d, t) => msg(`Downloading map… ${d}/${t}`));
    msg(r.failed ? `Saved ${r.total - r.failed}/${r.total} tiles (${r.failed} failed, try again on better signal).` : `Map saved for offline (${r.total} tiles).`);
  } finally {
    btn.disabled = false;
  }
};

$<HTMLInputElement>('sat').onchange = (e) => {
  state.satellite = (e.target as HTMLInputElement).checked;
  store.saveState(state);
  map.setLayoutProperty('sat', 'visibility', state.satellite ? 'visible' : 'none');
  for (const k of ['fairway', 'tee', 'green', 'bunker', 'water']) map.setPaintProperty(k, 'fill-opacity', state.satellite ? 0.18 : 0.85);
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
(window as any).golf = { map, get course() { return course; }, get state() { return state; }, onPosition, setCourse };
