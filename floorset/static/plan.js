// Floorset shared engine: theme tokens, the floor-plan SVG renderer, money
// formatting and automatic table placement. Used by both the guest page and the
// owner dashboard so the plan a guest sees is exactly the plan the owner edits.

export const SURFACES = {
  midnight: { dark: true, ground: '#0f1217', panel: '#161a21', panel2: '#1c212a', sunk: '#0a0c10', edge: '#262c36', edge2: '#323a46', text: '#e8eaee', text2: '#a3abb8', text3: '#6b7482', wall: '#4d5666', floorline: '#2a303b' },
  charcoal: { dark: true, ground: '#121212', panel: '#1a1a1a', panel2: '#222222', sunk: '#0b0b0b', edge: '#2c2c2c', edge2: '#3a3a3a', text: '#ececec', text2: '#a8a8a8', text3: '#707070', wall: '#5a5a5a', floorline: '#2e2e2e' },
  plum: { dark: true, ground: '#17111a', panel: '#1f1723', panel2: '#271d2c', sunk: '#0f0a11', edge: '#33263a', edge2: '#42324a', text: '#f0e8f2', text2: '#b6a5bb', text3: '#7e6b85', wall: '#62506b', floorline: '#35283b' },
  ivory: { dark: false, ground: '#f6f2ea', panel: '#fffdf8', panel2: '#efe9de', sunk: '#e4ddd0', edge: '#ddd5c6', edge2: '#cbc1af', text: '#1f1b16', text2: '#5c554b', text3: '#857d71', wall: '#7a7062', floorline: '#d6cdbd' },
};

export const FONTS = {
  editorial: { display: "'Instrument Serif', Georgia, serif", ui: "'Instrument Sans', system-ui, sans-serif", q: 'Instrument+Serif&family=Instrument+Sans:wght@400;500;600' },
  modern: { display: "'Outfit', system-ui, sans-serif", ui: "'Outfit', system-ui, sans-serif", q: 'Outfit:wght@400;500;600;700' },
  classic: { display: "'Cormorant Garamond', Georgia, serif", ui: "'Jost', system-ui, sans-serif", q: 'Cormorant+Garamond:wght@500;600&family=Jost:wght@400;500;600' },
};

export const PALETTE = [
  ['#E0B341', 'gold'], ['#7FD8C8', 'mint'], ['#E0577E', 'rose'], ['#5E9BE8', 'blue'],
  ['#8FD16A', 'green'], ['#B98BE8', 'violet'], ['#E8845C', 'amber'], ['#E4E4E6', 'pearl'],
];

export const TABLE_KINDS = ['cabana', 'booth', 'sofa', 'round', 'hitop'];
export const TIERS = ['standard', 'premium', 'vip'];
export const ZONE_KINDS = ['dance', 'stage', 'bar', 'lounge', 'backstage', 'smoking', 'stairs', 'wc', 'void'];
export const ZONE_NAMES = { dance: 'Dance floor', stage: 'Stage / DJ', bar: 'Bar', lounge: 'Lounge area', backstage: 'Backstage', smoking: 'Smoking', stairs: 'Stairs', wc: 'Restrooms', void: 'Open to below' };
export const NATURAL = { cabana: [20, 9], booth: [16, 6.5], sofa: [15, 7], round: [10, 10], hitop: [9, 9] };
export const MARGIN = 2.5;
export const OCCASIONS = ['Birthday', 'Anniversary', 'Night out', 'Corporate', 'Bachelor / ette', 'Just because'];

const NS = 'http://www.w3.org/2000/svg';

// ------------------------------------------------------------------ helpers

export const snap = (v) => Math.round(v * 2) / 2;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Indian digit grouping, by hand: 150000 -> ₹1,50,000 */
export function inr(n) {
  n = Math.round(Number(n) || 0);
  const sign = n < 0 ? '-' : '';
  let s = String(Math.abs(n));
  if (s.length > 3) {
    let head = s.slice(0, -3);
    const tail = s.slice(-3);
    const groups = [];
    while (head.length > 2) { groups.unshift(head.slice(-2)); head = head.slice(0, -2); }
    if (head) groups.unshift(head);
    s = groups.join(',') + ',' + tail;
  }
  return sign + '₹' + s;
}

export function sizeWord(s) {
  if (s < 8) return 'small';
  if (s < 12) return 'medium';
  if (s < 17) return 'large';
  return 'extra large';
}

export function proportionWord(r) {
  if (r < 0.8) return 'deep';
  if (r <= 1.25) return 'square';
  return 'wide';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function readableOn(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111111' : '#ffffff';
}

// ------------------------------------------------------------------ theme

const loadedFonts = new Set();

/** Every colour in the interface is a CSS custom property on :root. */
export function applyTheme(venue) {
  const surface = SURFACES[venue.brand.surface] || SURFACES.midnight;
  const font = FONTS[venue.brand.font] || FONTS.editorial;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(surface)) if (k !== 'dark') root.setProperty('--' + k, v);
  root.setProperty('--primary', venue.brand.primary);
  root.setProperty('--on-primary', readableOn(venue.brand.primary));
  root.setProperty('--accent', venue.brand.accent);
  const [r, g, b] = hexToRgb(venue.brand.primary);
  root.setProperty('--primary-soft', `rgba(${r},${g},${b},0.14)`);
  root.setProperty('--display', font.display);
  root.setProperty('--ui', font.ui);
  root.setProperty('color-scheme', surface.dark ? 'dark' : 'light');
  document.documentElement.dataset.scheme = surface.dark ? 'dark' : 'light';
  if (!loadedFonts.has(font.q)) {
    loadedFonts.add(font.q);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${font.q}&display=swap`;
    document.head.appendChild(link);
  }
}

export function markHtml(venue, size = 40) {
  const shape = venue.markShape || 'circle';
  const radius = shape === 'circle' ? '50%' : shape === 'soft' ? '22%' : '6px';
  const filled = shape !== 'none';
  return `<span class="mark" style="width:${size}px;height:${size}px;border-radius:${radius};` +
    `${filled ? 'background:var(--primary);color:var(--on-primary)' : 'border:1.5px solid var(--primary);color:var(--primary)'};` +
    `font-size:${Math.round(size * (venue.mark.length > 2 ? 0.34 : 0.42))}px">${esc(venue.mark)}</span>`;
}

// ------------------------------------------------------------------ legend

export function tierFloors(venue) {
  const low = {};
  for (const f of venue.floors) for (const t of f.tables) {
    if (low[t.tier] === undefined || t.cover < low[t.tier]) low[t.tier] = t.cover;
  }
  return TIERS.filter((t) => low[t] !== undefined).map((t) => [t, low[t]]);
}

// ------------------------------------------------------------------ renderer

/**
 * Rebuild the whole plan SVG from scratch.
 * opts.state(table) -> 'basket' | 'booked' | 'focus' | 'selected' | null
 * opts.zoneSelected(zone) -> bool
 * opts.marquee -> {x,y,w,h} | null
 */
export function drawPlan(svg, floor, opts = {}) {
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${floor.w} ${floor.h}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const defs = el('defs', {}, svg);
  const dots = el('pattern', { id: 'pdots', width: 2, height: 2, patternUnits: 'userSpaceOnUse' }, defs);
  el('circle', { cx: 1, cy: 1, r: 0.18, class: 'p-dot' }, dots);
  const hatch = el('pattern', { id: 'phatch', width: 2.4, height: 2.4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 2.4, class: 'p-hatch' }, hatch);

  el('rect', { x: 0, y: 0, width: floor.w, height: floor.h, class: 'slab', 'data-bg': '1' }, svg);

  // Walls, broken at the door, with the door swing and the word ENTRY.
  const W = floor.w, H = floor.h, i = 2;
  if (floor.door) {
    const dx = floor.door.x, dw = floor.door.w;
    el('path', { d: `M${dx + dw} ${H - i} L${W - i} ${H - i} L${W - i} ${i} L${i} ${i} L${i} ${H - i} L${dx} ${H - i}`, class: 'wall' }, svg);
    const r = Math.min(dw, 8);
    el('line', { x1: dx, y1: H - i, x2: dx, y2: H - i - r, class: 'door' }, svg);
    el('path', { d: `M${dx} ${H - i - r} A${r} ${r} 0 0 1 ${dx + r} ${H - i}`, class: 'door swing' }, svg);
    const label = el('text', { x: dx + dw / 2, y: H - 0.35, class: 'entry-label' }, svg);
    label.textContent = 'ENTRY';
  } else {
    el('rect', { x: i, y: i, width: W - 2 * i, height: H - 2 * i, class: 'wall', fill: 'none' }, svg);
  }

  for (const z of floor.zones) {
    const sel = opts.zoneSelected && opts.zoneSelected(z);
    const g = el('g', { class: `zone k-${z.kind}${z.auto ? ' auto' : ''}${sel ? ' sel' : ''}`, 'data-zone': z.id }, svg);
    el('rect', { x: z.x, y: z.y, width: z.w, height: z.h, class: 'hit' }, g);
    el('rect', { x: z.x, y: z.y, width: z.w, height: z.h, class: 'zbody' }, g);
    if (z.kind === 'bar' && z.dir === 'v') el('line', { x1: z.x + z.w * 0.72, y1: z.y + 1.2, x2: z.x + z.w * 0.72, y2: z.y + z.h - 1.2, class: 'zdetail' }, g);
    else if (z.kind === 'bar') el('line', { x1: z.x + 1.2, y1: z.y + z.h * 0.72, x2: z.x + z.w - 1.2, y2: z.y + z.h * 0.72, class: 'zdetail' }, g);
    if (sel) el('rect', { x: z.x - 1.6, y: z.y - 1.6, width: z.w + 3.2, height: z.h + 3.2, rx: 1.2, class: 'ring' }, g);
    const text = (z.label || '').toUpperCase();
    if (text) {
      const vertical = z.dir === 'v';
      const len = Math.max(text.length, 1);
      const span = vertical ? z.h : z.w, cross = vertical ? z.w : z.h;
      const fs = Math.max(0.9, Math.min(2.2, (span * 0.85) / (len * 0.68), cross * 0.45));
      const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
      const t = el('text', { x: cx, y: cy, class: 'zlabel', 'font-size': fs.toFixed(2), transform: vertical ? `rotate(-90 ${cx} ${cy})` : undefined }, g);
      t.textContent = text;
    }
  }

  for (const t of floor.tables) {
    const state = opts.state ? opts.state(t) : null;
    const cls = ['tbl', 'k-' + t.kind, 'tier-' + t.tier];
    if (state) cls.push('st-' + state);
    if (t.auto) cls.push('auto');
    const g = el('g', { class: cls.join(' '), 'data-id': t.id, tabindex: opts.focusable ? '0' : undefined, role: opts.focusable ? 'button' : undefined, 'aria-label': opts.focusable ? `${t.code}, ${t.kind}, seats ${t.seats}${state === 'booked' ? ', unavailable' : ''}` : undefined }, svg);
    drawTable(g, t);
    if (state === 'focus' || state === 'selected') {
      el('rect', { x: t.x - 1.6, y: t.y - 1.6, width: t.w + 3.2, height: t.h + 3.2 + (seatSide(t) ? 2.2 : 0), rx: 1.4, class: 'ring' }, g);
    }
  }

  if (opts.marquee) {
    const m = opts.marquee;
    el('rect', { x: m.x, y: m.y, width: m.w, height: m.h, class: 'marquee' }, svg);
  }
  if (opts.after) opts.after(svg);
}

function seatSide(t) { return t.kind === 'booth' || t.kind === 'sofa'; }

function drawTable(g, t) {
  const { x, y, w, h } = t;
  const n = Math.min(t.seats, 14);
  // A full-group hit target so a tap anywhere on the table, seats included, counts.
  el('rect', { x: x - 1.5, y: y - 1.5, width: w + 3, height: h + 3 + (seatSide(t) ? 2.2 : 0), class: 'hit' }, g);
  if (t.kind === 'round' || t.kind === 'hitop') {
    const r = Math.min(w, h) / 2, cx = x + w / 2, cy = y + h / 2;
    const sr = t.kind === 'hitop' ? 0.55 : 0.75;
    for (let k = 0; k < n; k++) {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
      el('circle', { cx: cx + Math.cos(a) * (r + 1.35), cy: cy + Math.sin(a) * (r + 1.35), r: sr, class: 'seat' }, g);
    }
    el('circle', { cx, cy, r, class: 'body' }, g);
  } else if (t.kind === 'booth') {
    const r = Math.min(2.4, h / 2);
    el('path', { d: `M${x} ${y + h} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h} Z`, class: 'body' }, g);
    el('rect', { x: x + w * 0.2, y: y + h * 0.42, width: w * 0.6, height: h * 0.34, rx: 0.5, class: 'slab-in' }, g);
    seatRow(g, x, w, y + h + 1.35, n);
  } else if (t.kind === 'sofa') {
    el('rect', { x, y, width: w, height: h, rx: 1.5, class: 'body' }, g);
    el('line', { x1: x + 1, y1: y + h * 0.24, x2: x + w - 1, y2: y + h * 0.24, class: 'detail' }, g);
    el('rect', { x: x + w * 0.3, y: y + h * 0.45, width: w * 0.4, height: h * 0.3, rx: 0.5, class: 'slab-in' }, g);
    seatRow(g, x, w, y + h + 1.35, n);
  } else {
    el('rect', { x, y, width: w, height: h, rx: 1.2, class: 'body' }, g);
    el('path', { d: `M${x + 1.3} ${y + h - 1.3} L${x + 1.3} ${y + 1.3} L${x + w - 1.3} ${y + 1.3}`, class: 'detail' }, g);
    el('rect', { x: x + w * 0.36, y: y + h * 0.5, width: w * 0.28, height: h * 0.28, rx: 0.4, class: 'slab-in' }, g);
  }
  const fs = Math.min(3.1, w * 0.42, h * 0.6);
  const label = el('text', { x: x + w / 2, y: y + h / 2, class: 'tlabel', 'font-size': fs.toFixed(2) }, g);
  label.textContent = t.code;
}

function seatRow(g, x, w, cy, n) {
  const span = w - 2;
  for (let k = 0; k < n; k++) {
    const cx = x + 1 + (n === 1 ? span / 2 : (span * k) / (n - 1));
    el('circle', { cx, cy, r: 0.7, class: 'seat' }, g);
  }
}

/** Pointer position in floor units, independent of zoom and resolution. */
export function svgPoint(svg, evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const m = svg.getScreenCTM();
  return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 };
}

// ------------------------------------------------------------------ placement

const BLOCKING = new Set(['dance', 'stage', 'bar', 'void', 'stairs', 'wc']);

export function typeBox(type) {
  const [nw, nh] = NATURAL[type.kind];
  const scale = type.size / Math.sqrt(nw * nh);
  return [snap(nw * scale), snap(nh * scale)];
}

export function naturalSize(kind) {
  const [nw, nh] = NATURAL[kind];
  return Math.round(Math.sqrt(nw * nh) * 2) / 2;
}

/**
 * Place every table the floor's types ask for, largest first, against the walls,
 * clear of dance floor, stage, bar, stairs, voids, restrooms and the entrance.
 * Hand-placed tables (no `gen` flag) are kept and treated as obstacles; only
 * previously generated tables are replaced.
 * Returns {tables, placed, wanted}: the full new table list for the floor, and
 * how many of the wanted tables fitted. Never silently drops a table: the caller
 * reports placed of wanted.
 */
export function placeTypes(floor) {
  const kept = floor.tables.filter((t) => !t.gen);
  const usedCodes = new Set(kept.map((t) => t.code));
  const items = [];
  const prefixes = new Map();
  for (const ty of floor.types || []) {
    let p = (ty.label.trim()[0] || 'T').toUpperCase();
    for (const [other, op] of prefixes) if (op === p && other !== ty.id) p = ty.label.trim().slice(0, 2).toUpperCase() || p;
    prefixes.set(ty.id, p);
    const [w, h] = typeBox(ty);
    for (let k = 0; k < ty.count; k++) items.push({ ty, w, h, prefix: p });
  }
  items.sort((a, b) => b.w * b.h - a.w * a.h);

  const blockers = floor.zones.filter((z) => BLOCKING.has(z.kind)).map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h }));
  if (floor.door) blockers.push({ x: floor.door.x - 3, y: floor.h - 14, w: floor.door.w + 6, h: 14 });

  const step = 1.25, m = MARGIN;
  const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

  const placed = kept.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h + (t.kind === 'booth' || t.kind === 'sofa' ? 2.2 : 0) }));
  const tables = [];
  const counters = {};
  for (const it of items) {
    const cands = [];
    for (let y = m; y + it.h <= floor.h - m; y += step) {
      for (let x = m; x + it.w <= floor.w - m; x += step) {
        const d = Math.min(x - m, y - m, floor.w - m - (x + it.w), floor.h - m - (y + it.h));
        cands.push([d, x, y]);
      }
    }
    cands.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
    let spot = null;
    for (const [, x, y] of cands) {
      const box = { x, y, w: it.w, h: it.h + (it.ty.kind === 'booth' || it.ty.kind === 'sofa' ? 2.2 : 0) };
      if (blockers.some((b) => overlaps(box, b, 1.2))) continue;
      if (placed.some((p) => overlaps(box, p, 1.7))) continue;
      spot = box; break;
    }
    if (!spot) continue;
    placed.push(spot);
    let code;
    do {
      counters[it.prefix] = (counters[it.prefix] || 0) + 1;
      code = (it.prefix + counters[it.prefix]).slice(0, 4);
    } while (usedCodes.has(code));
    usedCodes.add(code);
    tables.push({
      id: 'g' + Math.random().toString(36).slice(2, 10),
      code,
      kind: it.ty.kind, tier: it.ty.tier, seats: it.ty.seats, cover: it.ty.cover,
      x: snap(spot.x), y: snap(spot.y), w: it.w, h: it.h, gen: true,
    });
  }
  return { tables: [...kept, ...tables], placed: tables.length, wanted: items.length };
}

// ------------------------------------------------------------------ api

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
    if (!opts.method) init.method = 'POST';
  }
  let res;
  try {
    res = await fetch('/api' + path, init);
  } catch {
    const e = new Error('No connection. Check your network and try again.');
    e.status = 0;
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || 'Something went wrong.');
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}
