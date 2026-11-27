// Scorecard sheet: quick entry for the current hole, the full card, round stats and past rounds.
import type { Course, Hole } from './types.ts';
import { type Fairway, type Round, type HoleScore, totals, fmtToPar, pct, isGir, shotDistances } from './round.ts';
import * as store from './storage.ts';

const $ = (id: string) => document.getElementById(id)!;

export interface CardHost {
  course: () => Course | null;
  hole: () => Hole | null;
  /** The round in progress, created on first use. */
  round: (create: boolean) => Round | null;
  save: (r: Round) => void;
  newRound: () => void;
  finishRound: () => void;
  goHole: (i: number) => void;
  changed: () => void;
}

let host: CardHost;
const sheet = () => $('cardsheet') as HTMLDialogElement;

export function initCard(h: CardHost) {
  host = h;
  $('card').onclick = () => { renderCard(); sheet().showModal(); };
  $('c-new').onclick = () => { if (confirmBox('Start a new round? The current one is kept in Past rounds.')) { host.newRound(); renderCard(); } };
  $('c-finish').onclick = () => { host.finishRound(); renderCard(); };
}

// Native confirm() is fine in Safari, but keep it in one place.
function confirmBox(text: string) {
  return window.confirm(text);
}

function chips(container: HTMLElement, values: (number | string)[], current: number | string | undefined, label: (v: any) => string, onPick: (v: any) => void) {
  container.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.textContent = label(v);
    if (v === current) b.className = 'on';
    b.onclick = () => onPick(v === current ? undefined : v);
    container.appendChild(b);
  }
}

/** Edits a field of the current hole's score and redraws. */
function edit(fn: (s: HoleScore) => void) {
  const h = host.hole();
  const r = host.round(true);
  if (!h || !r) return;
  fn((r.holes[h.ref] ??= {}));
  host.save(r);
  host.changed();
  renderCard();
}

export function renderCard() {
  const c = host.course();
  const h = host.hole();
  const r = host.round(false);
  if (!c || !h) return;
  const s = r?.holes[h.ref] ?? {};
  const par = h.par ?? 4;

  $('c-hole').textContent = `Hole ${h.ref}`;
  $('c-par').textContent = h.par ? `Par ${h.par}` : 'Par ?';
  chips($('c-strokes'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], s.strokes, String, (v) => edit((x) => { x.strokes = v; }));
  chips($('c-putts'), [0, 1, 2, 3, 4], s.putts, String, (v) => edit((x) => { x.putts = v; }));
  $('c-fw-row').hidden = par < 4;
  chips($('c-fw'), ['left', 'hit', 'right'] as Fairway[], s.fairway, (v) => ({ left: '← Left', hit: 'Hit', right: 'Right →' } as Record<string, string>)[v], (v) => edit((x) => { x.fairway = v; }));
  chips($('c-pen'), [0, 1, 2, 3], s.penalties ?? 0, String, (v) => edit((x) => { x.penalties = v ?? 0; }));
  chips($('c-sand'), ['yes'], s.sand ? 'yes' : undefined, () => 'In a bunker', (v) => edit((x) => { x.sand = v ? 1 : 0; }));
  const shots = shotDistances(s);
  $('c-shots').textContent = s.shots?.length ? `${s.shots.length} shot${s.shots.length > 1 ? 's' : ''} marked${shots.length ? ': ' + shots.map((d) => Math.round(d)).join(', ') + ' yd' : ''}` : '';

  renderTable(c, r);
  renderStats(r);
  renderHistory(r);
  $('c-finish').hidden = !r || !!r.finishedAt;
}

function renderTable(c: Course, r: Round | null) {
  const tb = $('c-table');
  const rows: string[] = [];
  const cell = (v: unknown) => (v == null || v === '' ? '' : String(v));
  const half = (label: string, holes: Hole[]) => {
    const t = r ? totals(r, holes.map((h) => h.ref)) : null;
    const parSum = holes.reduce((a, h) => a + (h.par ?? 0), 0);
    const putts = holes.reduce((a, h) => a + (r?.holes[h.ref]?.putts ?? 0), 0);
    rows.push(`<tr class="sum"><td>${label}</td><td>${parSum || ''}</td><td>${t?.holes ? t.strokes : ''}</td><td>${t?.puttsHoles ? putts : ''}</td><td></td><td></td></tr>`);
  };
  c.holes.forEach((h, i) => {
    const s = r?.holes[h.ref];
    const diff = s?.strokes != null && h.par ? s.strokes - h.par : null;
    const cls = diff == null ? '' : diff <= -2 ? 'eagle' : diff === -1 ? 'birdie' : diff === 0 ? '' : diff === 1 ? 'bogey' : 'double';
    const fw = h.par && h.par >= 4 ? ({ hit: '✓', left: '←', right: '→' } as Record<string, string>)[s?.fairway ?? ''] ?? '' : '';
    const gir = s && h.par ? isGir(s, h.par) : undefined;
    rows.push(`<tr data-i="${i}"><td>${h.ref}</td><td>${cell(h.par)}</td><td><span class="sc ${cls}">${cell(s?.strokes)}</span></td><td>${cell(s?.putts)}</td><td>${fw}</td><td>${gir == null ? '' : gir ? '✓' : ''}</td></tr>`);
    if (c.holes.length === 18 && i === 8) half('Out', c.holes.slice(0, 9));
  });
  if (c.holes.length === 18) half('In', c.holes.slice(9));
  half('Total', c.holes);
  tb.innerHTML = rows.join('');
  tb.querySelectorAll<HTMLTableRowElement>('tr[data-i]').forEach((tr) => {
    tr.onclick = () => { host.goHole(Number(tr.dataset.i)); renderCard(); };
  });
  const t = r ? totals(r) : null;
  $('c-score').textContent = t?.holes ? `${t.strokes} (${fmtToPar(t.toPar)}) thru ${t.holes}` : 'No scores yet';
}

function statsHtml(t: ReturnType<typeof totals>, rounds = 1) {
  const avg = (n: number) => (rounds > 1 ? (n / rounds).toFixed(1) : String(n));
  const byPar = [3, 4, 5].filter((p) => t.byPar[p]).map((p) => `Par ${p}s <b>${(t.byPar[p].strokes / t.byPar[p].n).toFixed(2)}</b>`).join(' · ');
  return `
    <div class="stat"><span>Fairways</span><b>${pct(t.fairways, t.fairwayChances)}</b><small>${t.fairways}/${t.fairwayChances}</small></div>
    <div class="stat"><span>Greens in reg.</span><b>${pct(t.gir, t.girChances)}</b><small>${t.gir}/${t.girChances}</small></div>
    <div class="stat"><span>Putts${rounds > 1 ? ' / round' : ''}</span><b>${t.puttsHoles ? avg(t.putts) : '–'}</b><small>${t.puttsHoles ? (t.putts / t.puttsHoles).toFixed(2) + ' per hole' : ''}</small></div>
    <div class="stat"><span>Scrambling</span><b>${pct(t.scrambles, t.scrambleChances)}</b><small>${t.scrambles}/${t.scrambleChances}</small></div>
    <div class="stat"><span>Sand saves</span><b>${pct(t.sandSaves, t.sandChances)}</b><small>${t.sandSaves}/${t.sandChances}</small></div>
    <div class="stat"><span>Penalties</span><b>${avg(t.penalties)}</b><small>${rounds > 1 ? 'per round' : ''}</small></div>
    <p class="dist">${t.dist.eagle ? `Eagles ${t.dist.eagle} · ` : ''}Birdies ${t.dist.birdie} · Pars ${t.dist.par} · Bogeys ${t.dist.bogey} · Double+ ${t.dist.double}</p>
    ${byPar ? `<p class="dist">${byPar}</p>` : ''}`;
}

function renderStats(r: Round | null) {
  $('c-stats').innerHTML = r ? statsHtml(totals(r)) : '<p class="fine">Stats fill in as you enter scores.</p>';
}

function renderHistory(cur: Round | null) {
  const ul = $('c-history');
  ul.innerHTML = '';
  const past = store.savedRounds().map((s) => store.getRound(s.id)).filter((r): r is Round => !!r && r.id !== cur?.id);
  const scored = past.filter((r) => totals(r).holes >= 9);
  if (!past.length) { ul.innerHTML = '<li><small>Finished rounds show up here.</small></li>'; $('c-career').innerHTML = ''; return; }
  for (const r of past.slice(0, 20)) {
    const t = totals(r);
    const li = document.createElement('li');
    li.innerHTML = `<span class="go">${esc(r.courseName)}<small>${new Date(r.startedAt).toLocaleDateString()} · ${t.holes} holes</small></span><b>${t.holes ? `${t.strokes} (${fmtToPar(t.toPar)})` : '–'}</b>`;
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.onclick = () => { if (confirmBox('Delete this round?')) { store.deleteRound(r.id); renderHistory(cur); } };
    li.appendChild(del);
    ul.appendChild(li);
  }
  // Combined stats over past rounds with at least 9 holes scored.
  if (scored.length >= 2) {
    const all = scored.map((r) => totals(r));
    const sum = all.reduce((a, t) => {
      for (const k of Object.keys(t) as (keyof typeof t)[]) if (typeof t[k] === 'number') (a as any)[k] = ((a as any)[k] ?? 0) + (t[k] as number);
      for (const k of Object.keys(t.dist) as (keyof typeof t.dist)[]) a.dist[k] += t.dist[k];
      for (const p of Object.keys(t.byPar)) { const q = (a.byPar[+p] ??= { n: 0, strokes: 0 }); q.n += t.byPar[+p].n; q.strokes += t.byPar[+p].strokes; }
      return a;
    }, { dist: { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0 }, byPar: {} } as any);
    const avg18 = all.filter((t) => t.holes === 18);
    $('c-career').innerHTML = `<h3>Last ${scored.length} rounds</h3>${avg18.length ? `<p class="dist">Scoring average (18 holes) <b>${(avg18.reduce((a, t) => a + t.strokes, 0) / avg18.length).toFixed(1)}</b></p>` : ''}<div class="stats">${statsHtml(sum, scored.length)}</div>`;
  } else $('c-career').innerHTML = '';
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
