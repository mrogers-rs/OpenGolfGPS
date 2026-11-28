// Golf-sim flyover: a low 3D shot camera that plays the hole along its line of play (tee -> dogleg marks -> pin),
// with the ball flying each shot and a tracer behind it. Drawn on the map's drawn (non-satellite) view.
import maplibregl, { type GeoJSONSource, type Map as MLMap } from 'maplibre-gl';
import type { Hole, LngLat } from './types.ts';
import { planShots, ballInAir, ballRolling, bearingOf, lerpLL, metres, offset, smooth, turnTo, clamp01, type Shot } from './flight.ts';

const SRC = 'fly3d';
/** Extruded scenery shown only during the flyover. */
export const FLY_LAYERS = ['fly-trunk', 'fly-canopy', 'fly-canopy-top', 'fly-woods', 'fly-building'];

/** Adds the (hidden) flyover layers to the map, under the green outlines. */
export function addFlyLayers(map: MLMap, before: string) {
  if (map.getSource(SRC)) return;
  map.addSource(SRC, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const ext = (id: string, kind: string, color: string, base: number | any, height: number | any, opacity = 1): maplibregl.LayerSpecification => ({
    id, type: 'fill-extrusion', source: SRC, filter: ['==', ['get', 'k'], kind], layout: { visibility: 'none' },
    paint: { 'fill-extrusion-color': color, 'fill-extrusion-base': base, 'fill-extrusion-height': height, 'fill-extrusion-opacity': opacity },
  });
  map.addLayer(ext('fly-trunk', 'trunk', '#5b4430', 0, ['get', 'h']), before);
  map.addLayer(ext('fly-canopy', 'canopy', '#2f7a34', ['get', 'b'], ['get', 'h']), before);
  map.addLayer(ext('fly-canopy-top', 'top', '#3b8d3e', ['get', 'b'], ['get', 'h']), before);
  map.addLayer(ext('fly-woods', 'woods', '#2a6a2f', 0, 13), before);
  map.addLayer(ext('fly-building', 'building', '#d8cfc2', 0, 7), before);
  // The ball, tracer and flag are drawn by this layer onto a canvas over the map.
  map.addLayer({ id: 'fly-ball', type: 'custom', renderingMode: '2d', onAdd() {}, render(_gl, matrix) { active?.draw(matrix as unknown as ArrayLike<number>); } } as maplibregl.CustomLayerInterface);
}

/** A ring of `n` points `r` metres around `c`. */
function ring(c: LngLat, r: number, n = 8): GeoJSON.Polygon {
  const pts = Array.from({ length: n }, (_, i) => offset(c, r, (i * 360) / n + 22.5));
  return { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
}

/** Trees as a trunk plus two stacked canopy rings (a rounded crown), woods and buildings as blocks. */
function scenery(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  const out: GeoJSON.Feature[] = [];
  const add = (geometry: GeoJSON.Geometry, p: Record<string, unknown>) => out.push({ type: 'Feature', geometry, properties: p });
  for (const f of fc.features) {
    const kind = f.properties?.kind;
    const g = f.geometry;
    if (kind === 'tree' && g.type === 'Point') {
      const c = g.coordinates as LngLat;
      // A little variety so a row of trees doesn't look stamped out.
      const v = (Math.abs(Math.sin(c[0] * 1e5 + c[1] * 1e5)) * 1000) % 1;
      const h = 9 + v * 5;
      add(ring(c, 0.45, 6), { k: 'trunk', h: h * 0.4 });
      add(ring(c, 4 + v * 1.5, 10), { k: 'canopy', b: h * 0.3, h: h * 0.8 });
      add(ring(c, 2.6 + v, 10), { k: 'top', b: h * 0.8, h });
    } else if ((kind === 'wood' || kind === 'building') && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
      add(g, { k: kind === 'wood' ? 'woods' : 'building' });
    }
  }
  return { type: 'FeatureCollection', features: out };
}

export interface FlyHud {
  hole: HTMLElement;
  big: HTMLElement;
  lbl: HTMLElement;
  sub: HTMLElement;
}

interface Pose { center: LngLat; zoom: number; bearing: number; pitch: number }
interface Ball { at: LngLat; alt: number }

let active: Flight | null = null;

class Flight {
  shots: Shot[];
  phases: { dur: number; run: (t: number) => void }[] = [];
  /** Current shot, how far through its flight (0-1), and the ball. */
  cur = -1;
  u = 0;
  ball: Ball;
  landedAt = -1;
  done = false;
  private raf = 0;
  private t0 = 0;
  private ctx: CanvasRenderingContext2D;
  private resolve!: () => void;
  finished: Promise<void>;
  lengthYd: number;

  constructor(private map: MLMap, private h: Hole, private pin: LngLat, private canvas: HTMLCanvasElement, private hud: FlyHud) {
    this.shots = planShots(h.line, pin);
    this.ball = { at: this.shots[0].from, alt: 0 };
    this.ctx = canvas.getContext('2d')!;
    this.lengthYd = this.shots.reduce((a, s) => a + s.yd, 0);
    this.finished = new Promise((r) => (this.resolve = r));
    this.build();
  }

  /** Behind the ball, looking down the shot. */
  private address(at: LngLat, bearing: number): Pose {
    return { center: at, zoom: 18.9, bearing, pitch: 74 };
  }

  private build() {
    const s0 = this.shots[0];
    const lat = s0.from[1];
    const W = this.map.getContainer().clientHeight || 800;
    // Hole intro: the whole hole from up high, then down to the tee.
    const mid = lerpLL(s0.from, this.pin, 0.5);
    const mpp = metres(s0.from, this.pin) / (W * 0.85);
    const zOver = Math.min(17.5, Math.log2((40075016.7 * Math.cos((lat * Math.PI) / 180)) / (512 * mpp)));
    const holeBearing = bearingOf(s0.from, this.pin);
    const over: Pose = { center: mid, zoom: zOver, bearing: holeBearing, pitch: 42 };
    const firstAddr = this.address(s0.from, bearingOf(s0.from, s0.land));
    this.phase(1.6, (t) => { this.pose(over, { ...over, bearing: holeBearing + 6, pitch: 48 }, smooth(t)); });
    this.phase(2.2, (t) => { this.pose({ ...over, bearing: holeBearing + 6, pitch: 48 }, firstAddr, smooth(t)); });
    this.shots.forEach((shot, i) => {
      const b = bearingOf(shot.from, shot.land);
      const addr = this.address(shot.from, b);
      if (i > 0) {
        // Line up the next shot: swing round behind the ball to face the next mark.
        const prev = this.shots[i - 1];
        const prevEnd = this.endPose(prev);
        this.phase(1.5, (t) => {
          this.pose(prevEnd, addr, smooth(t));
          this.setHud('TO PIN', metres(shot.from, this.pin) / 0.9144, i === this.shots.length - 1 ? 'Approach' : `Shot ${i + 1}`);
        });
      }
      this.phase(0.55, () => { this.cur = i; this.u = 0; this.ball = { at: shot.from, alt: 0 }; this.mapPose(addr); this.setHud('CARRY', 0, `Shot ${i + 1}`); });
      this.phase(shot.air, (t) => {
        this.cur = i; this.u = t;
        const p = ballInAir(shot, t);
        this.ball = { at: p.at, alt: p.alt };
        // Shot cam: chase from behind, easing back as the ball climbs, then settle near the landing.
        const end = this.endPose(shot);
        const c = lerpLL(shot.from, shot.land, Math.max(0, p.s * 1.02 - 0.12));
        const pull = Math.sin(Math.PI * Math.min(1, p.s * 1.1));
        this.mapPose({
          center: c,
          zoom: addr.zoom + (end.zoom - addr.zoom) * p.s - 1.25 * pull,
          bearing: turnTo(addr.bearing, end.bearing, smooth(p.s)),
          pitch: addr.pitch - 6 * pull,
        });
        this.setHud('CARRY', shot.carry * p.s, `Shot ${i + 1}`);
        if (t >= 1) this.landedAt = performance.now();
      });
      this.phase(shot.roll, (t) => {
        this.u = 1;
        this.ball = { at: ballRolling(shot, t), alt: 0 };
        const end = this.endPose(shot);
        const c = lerpLL(shot.from, shot.land, 0.88);
        this.mapPose({ center: lerpLL(c, end.center, smooth(t)), zoom: end.zoom, bearing: end.bearing, pitch: end.pitch });
        this.setHud(shot.last ? 'TOTAL' : 'TOTAL', shot.yd * (0.94 + 0.06 * t), shot.last ? 'On the green' : `${Math.round(metres(shot.to, this.pin) / 0.9144)} to pin`);
      });
    });
    // Finish on the green: a slow swing round the flag.
    const last = this.shots[this.shots.length - 1];
    const fin = this.endPose(last);
    this.phase(3.4, (t) => {
      const k = smooth(t);
      this.mapPose({ center: lerpLL(fin.center, this.pin, k), zoom: fin.zoom + 0.6 * k, bearing: fin.bearing + 28 * k, pitch: fin.pitch - 8 * k });
      this.setHud('YARDS', this.lengthYd, `Hole ${this.h.ref}${this.h.par ? ` · Par ${this.h.par}` : ''}`);
    });
  }

  /** Where the camera sits once a shot has stopped. */
  private endPose(shot: Shot): Pose {
    const b = bearingOf(shot.from, shot.land);
    const back = offset(shot.to, shot.last ? 4 : 10, b + 180);
    return { center: back, zoom: shot.last ? 19.4 : 18.9, bearing: b, pitch: shot.last ? 66 : 72 };
  }

  private phase(dur: number, run: (t: number) => void) { this.phases.push({ dur, run }); }

  private pose(a: Pose, b: Pose, t: number) {
    this.mapPose({ center: lerpLL(a.center, b.center, t), zoom: a.zoom + (b.zoom - a.zoom) * t, bearing: turnTo(a.bearing, b.bearing, t), pitch: a.pitch + (b.pitch - a.pitch) * t });
  }
  private mapPose(p: Pose) { this.map.jumpTo(p); }

  private lastHud = '';
  private setHud(lbl: string, n: number, sub: string) {
    const key = `${lbl}|${Math.round(n)}|${sub}`;
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.hud.lbl.textContent = lbl;
    this.hud.big.textContent = String(Math.round(n));
    this.hud.sub.textContent = sub;
  }

  start() {
    this.hud.hole.innerHTML = `<b>${this.h.ref}</b><span>HOLE</span><i>${this.h.par ? `PAR ${this.h.par} · ` : ''}${Math.round(this.lengthYd)} YDS</i>`;
    this.setHud('YARDS', this.lengthYd, `Hole ${this.h.ref}`);
    this.t0 = performance.now();
    const tick = () => {
      if (this.done) return;
      let t = (performance.now() - this.t0) / 1000;
      let i = 0;
      while (i < this.phases.length && t > this.phases[i].dur) { t -= this.phases[i].dur; i++; }
      if (i >= this.phases.length) { this.phases[this.phases.length - 1].run(1); this.stop(); return; }
      // Let the previous phase reach its end before the next one starts.
      if (i !== this.phaseNo) { if (this.phaseNo >= 0 && this.phaseNo < i) this.phases[this.phaseNo].run(1); this.phaseNo = i; }
      this.phases[i].run(t / this.phases[i].dur);
      this.map.triggerRepaint();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  private phaseNo = -1;

  stop() {
    if (this.done) return;
    this.done = true;
    cancelAnimationFrame(this.raf);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.resolve();
  }

  // ---------- Drawing (called from the map's render, so it matches the camera exactly) ----------
  draw(m: ArrayLike<number>) {
    if (this.done) return;
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const proj = (ll: LngLat, alt = 0) => {
      const c = maplibregl.MercatorCoordinate.fromLngLat(ll, alt);
      const x = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12];
      const y = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13];
      const w = m[3] * c.x + m[7] * c.y + m[11] * c.z + m[15];
      if (w <= 0.0001) return null;
      return { x: ((x / w + 1) / 2) * W, y: ((1 - y / w) / 2) * H, w };
    };
    /** Screen pixels per metre (vertical) at a spot. */
    const ppm = (ll: LngLat, alt = 0) => {
      const a = proj(ll, alt), b = proj(ll, alt + 1);
      return a && b ? Math.abs(a.y - b.y) : 0;
    };

    this.drawSky(ctx, proj, W, H);

    // Flag on the pin.
    const fp = proj(this.pin), ft = proj(this.pin, 7);
    if (fp && ft) {
      const s = ppm(this.pin, 6);
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = Math.max(1.5, s * 0.25);
      ctx.beginPath(); ctx.moveTo(fp.x, fp.y); ctx.lineTo(fp.x + s * 2.2, fp.y + s * 0.4); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, s * 0.18);
      ctx.beginPath(); ctx.moveTo(fp.x, fp.y); ctx.lineTo(ft.x, ft.y); ctx.stroke();
      const wave = Math.sin(performance.now() / 260) * s * 0.25;
      const fw = Math.max(10, s * 2.4), fh = Math.max(7, s * 1.5);
      ctx.fillStyle = '#ffd400';
      ctx.beginPath(); ctx.moveTo(ft.x, ft.y); ctx.quadraticCurveTo(ft.x + fw * 0.5, ft.y + fh * 0.3 + wave, ft.x + fw, ft.y + fh * 0.5); ctx.lineTo(ft.x, ft.y + fh); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.ellipse(fp.x, fp.y, Math.max(2, s * 0.35), Math.max(1, s * 0.16), 0, 0, Math.PI * 2); ctx.fill();
    }

    // Tracers: earlier shots faint, the one in the air bright.
    for (let i = 0; i <= this.cur && i < this.shots.length; i++) {
      const upto = i === this.cur ? this.u : 1;
      if (upto <= 0) continue;
      const pts: { x: number; y: number }[] = [];
      const N = 48;
      for (let k = 0; k <= N; k++) {
        const p = ballInAir(this.shots[i], (k / N) * upto);
        const q = proj(p.at, p.alt);
        if (q) pts.push(q);
      }
      if (pts.length < 2) continue;
      const fresh = i === this.cur;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(255,170,40,.9)'; ctx.shadowBlur = fresh ? 12 : 0;
      ctx.strokeStyle = fresh ? 'rgba(255,196,64,.85)' : 'rgba(255,210,90,.38)'; ctx.lineWidth = fresh ? 5 : 3;
      ctx.beginPath(); pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
      ctx.shadowBlur = 0;
      if (fresh) {
        ctx.strokeStyle = '#fffbe8'; ctx.lineWidth = 2;
        ctx.beginPath(); pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
      }
    }

    if (this.cur < 0) return;
    // Landing puff.
    const shot = this.shots[this.cur];
    const since = (performance.now() - this.landedAt) / 1000;
    if (this.landedAt > 0 && this.u >= 1 && since < 0.7) {
      const q = proj(shot.land);
      if (q) {
        const s = ppm(shot.land);
        const k = since / 0.7;
        ctx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - k)})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(q.x, q.y, s * (1 + 5 * k), s * (0.4 + 2 * k) * 0.5, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // Ball shadow on the ground, then the ball.
    const g = proj(this.ball.at), b = proj(this.ball.at, this.ball.alt);
    if (!g || !b) return;
    const s = ppm(this.ball.at, this.ball.alt);
    const r = Math.max(5, Math.min(14, s * 1.1));
    const lift = clamp01(this.ball.alt / 30);
    ctx.fillStyle = `rgba(0,0,0,${0.45 - 0.3 * lift})`;
    const gs = ppm(this.ball.at);
    ctx.beginPath(); ctx.ellipse(g.x, g.y, Math.max(2.5, gs * (0.8 + lift)), Math.max(1.2, gs * (0.8 + lift) * 0.4), 0, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 6;
    const grd = ctx.createRadialGradient(b.x - r * 0.35, b.y - r * 0.4, r * 0.1, b.x, b.y, r);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.65, '#f1f1ec'); grd.addColorStop(1, '#b9bdb6');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(b.x, b.y - r * 0.6, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  /** Sky above the horizon and a haze where the course fades into it. */
  private drawSky(ctx: CanvasRenderingContext2D, proj: (ll: LngLat, alt?: number) => { x: number; y: number } | null, W: number, H: number) {
    const c = this.map.getCenter();
    const far = proj(offset([c.lng, c.lat], 6000, this.map.getBearing()));
    const hy = far ? far.y : -1;
    if (hy <= 0) return;
    const sky = ctx.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, '#3f86d6'); sky.addColorStop(0.7, '#8fc3ee'); sky.addColorStop(1, '#d9ecf8');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, hy + 1);
    const haze = ctx.createLinearGradient(0, hy, 0, hy + H * 0.22);
    haze.addColorStop(0, 'rgba(217,236,248,.95)'); haze.addColorStop(1, 'rgba(217,236,248,0)');
    ctx.fillStyle = haze; ctx.fillRect(0, hy, W, H * 0.22);
  }
}

/**
 * Plays the hole. Resolves when the flyover ends or is stopped.
 * The caller switches the map to the drawn view first and restores it afterwards.
 */
export function playFlyover(map: MLMap, h: Hole, pin: LngLat, features: GeoJSON.FeatureCollection, canvas: HTMLCanvasElement, hud: FlyHud) {
  active?.stop();
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(scenery(features));
  for (const id of FLY_LAYERS) map.setLayoutProperty(id, 'visibility', 'visible');
  const f = new Flight(map, h, pin, canvas, hud);
  active = f;
  f.start();
  const finished = f.finished.then(() => {
    if (active === f) active = null;
    for (const id of FLY_LAYERS) map.setLayoutProperty(id, 'visibility', 'none');
  });
  return { stop: () => f.stop(), finished };
}
