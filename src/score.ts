// Scoring screen: one hole's score, putts, fairway and green in regulation, with big buttons.
// Pops up on its own when auto-advance moves you to the next tee (for the hole you just finished),
// and opens any time from the Card tab or the score-to-par button.
import type { Course } from './types.ts';
import { type Fairway, type Round, type HoleScore, totals, fmtToPar, isGir, scoreName, scoreClass } from './round.ts';

const $ = (id: string) => document.getElementById(id)!;

export interface ScoreHost {
  course: () => Course | null;
  /** Index of the hole on the map. */
  current: () => number;
  round: (create: boolean) => Round | null;
  save: (r: Round) => void;
  changed: () => void;
  goHole: (i: number) => void;
  openCard: () => void;
}

let host: ScoreHost;
/** Hole being scored (index into course.holes). */
let idx = 0;
/** Opened by auto-advance: the map has already moved on to the next hole. */
let afterAdvance = false;
const dlg = () => $('scoresheet') as HTMLDialogElement;

export function initScore(h: ScoreHost) {
  host = h;
  $('s-prev').onclick = () => { idx = Math.max(0, idx - 1); afterAdvance = false; renderScore(); };
  $('s-next').onclick = () => { const n = host.course()?.holes.length ?? 1; idx = Math.min(n - 1, idx + 1); afterAdvance = false; renderScore(); };
  $('s-x').onclick = () => closeScore();
  $('s-close').onclick = () => closeScore();
  $('s-go').onclick = () => {
    // Scoring the hole on the map: move on to the next one. Otherwise just show the hole on the map.
    if (idx === host.current()) host.goHole(idx + 1);
    closeScore();
  };
  $('s-card').onclick = () => { closeScore(); host.openCard(); };
  $('s-gir').onclick = () => {
    const c = host.course();
    const hole = c?.holes[idx];
    if (!hole) return;
    edit((s) => { s.gir = !isGir(s, hole.par ?? 4); });
  };
  dlg().addEventListener('cancel', () => { afterAdvance = false; });
}

/** Opens the scoring screen for hole `i`. `advanced` = opened by auto-advance after leaving that hole. */
export function openScore(i: number, advanced = false) {
  const c = host.course();
  if (!c?.holes[i]) return;
  idx = i;
  afterAdvance = advanced;
  renderScore();
  // Only one sheet at a time.
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((d) => { if (d.id !== 'scoresheet') d.close(); });
  if (!dlg().open) dlg().showModal();
  // Don't leave focus on a score button (avoids a focus ring on iPad with a keyboard).
  (document.activeElement as HTMLElement | null)?.blur();
}

export function closeScore() {
  afterAdvance = false;
  if (dlg().open) dlg().close();
}

export const scoreOpen = () => dlg().open;

function edit(fn: (s: HoleScore) => void) {
  const h = host.course()?.holes[idx];
  const r = host.round(true);
  if (!h || !r) return;
  fn((r.holes[h.ref] ??= {}));
  host.save(r);
  host.changed();
  renderScore();
}

function buttons(container: HTMLElement, values: (number | string)[], current: unknown, html: (v: any) => string, onPick: (v: any) => void, cls?: (v: any) => string) {
  container.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = html(v);
    const on = v === current;
    b.className = [on ? 'on' : '', cls?.(v) ?? ''].join(' ').trim();
    b.setAttribute('aria-pressed', String(on));
    b.onclick = () => onPick(on ? undefined : v);
    container.appendChild(b);
  }
}

export function renderScore() {
  const c = host.course();
  const h = c?.holes[idx];
  if (!c || !h) return;
  const r = host.round(false);
  const s: HoleScore = r?.holes[h.ref] ?? {};
  const par = h.par ?? 4;

  $('s-ref').textContent = String(h.ref);
  $('s-par').textContent = h.par ? `Par ${h.par}` : 'Par ?';
  ($('s-prev') as HTMLButtonElement).disabled = idx === 0;
  ($('s-next') as HTMLButtonElement).disabled = idx >= c.holes.length - 1;

  // Running score to par for the round.
  const t = r ? totals(r) : null;
  const tp = $('s-total');
  tp.innerHTML = t?.holes ? `<b>${fmtToPar(t.toPar)}</b><span>thru ${t.holes}</span>` : '<b>E</b><span>no scores yet</span>';
  tp.className = 'topar ' + (t?.holes ? (t.toPar < 0 ? 'under' : t.toPar > 0 ? 'over' : 'even') : 'even');

  // Score: 1 up to par + 5, named relative to par.
  const max = Math.max(par + 5, s.strokes ?? 0);
  const strokes = Array.from({ length: max }, (_, k) => k + 1);
  buttons($('s-strokes'), strokes, s.strokes,
    (v: number) => `<b>${v}</b><small>${scoreName(v, par)}</small>`,
    (v) => edit((x) => { x.strokes = v; }),
    (v: number) => (v === par ? 'is-par ' : '') + scoreClass(v - par));

  buttons($('s-putts'), [0, 1, 2, 3, 4], s.putts, (v: number) => (v === 4 ? '4+' : String(v)), (v) => edit((x) => { x.putts = v; }));

  // Fairway only counts on par 4s and 5s.
  $('s-fw-row').hidden = par < 4;
  buttons($('s-fw'), ['left', 'hit', 'right'] as Fairway[], s.fairway,
    (v: Fairway) => ({
      left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Left</span>',
      hit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Fairway</span>',
      right: '<span>Right</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    })[v],
    (v) => edit((x) => { x.fairway = v; }),
    (v: Fairway) => 'fw-' + v);

  // Green in regulation: your call, or worked out from score and putts until you tap it.
  const gir = isGir(s, par);
  const g = $('s-gir');
  g.className = 'gir' + (gir ? ' on' : '');
  g.setAttribute('aria-pressed', String(!!gir));
  $('s-gir-note').textContent = s.gir != null ? '' : gir != null ? 'from score and putts' : '';

  buttons($('s-pen'), [0, 1, 2, 3], s.penalties || undefined, String, (v) => edit((x) => { x.penalties = v ?? 0; }));
  buttons($('s-sand'), ['yes'], s.sand ? 'yes' : undefined, () => 'In a bunker', (v) => edit((x) => { x.sand = v ? 1 : 0; }));

  // Bottom buttons. After auto-advance the map is already on the next hole: one button to go and play it.
  const cur = host.current();
  const go = $('s-go');
  const close = $('s-close');
  if (afterAdvance || idx !== cur) {
    close.hidden = true;
    go.innerHTML = `Show hole ${c.holes[cur].ref} <span aria-hidden="true">›</span>`;
    go.hidden = false;
  } else {
    close.hidden = false;
    const nxt = c.holes[idx + 1];
    go.hidden = !nxt;
    if (nxt) go.innerHTML = `Next hole <span aria-hidden="true">›</span>`;
  }
}
