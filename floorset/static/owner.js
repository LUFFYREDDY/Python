// The club owner's dashboard: bookings, door check-in, floor editor, nights,
// branding and the raw venue config. One state object, one render pass.
import {
  api, applyTheme, clamp, drawPlan, esc, inr, markHtml, MARGIN, naturalSize, OCCASIONS,
  PALETTE, placeTypes, proportionWord, sizeWord, snap, svgPoint, SURFACES, TABLE_KINDS,
  tierFloors, TIERS, ZONE_KINDS, ZONE_NAMES,
} from './plan.js';

const $ = (id) => document.getElementById(id);
const clone = (x) => JSON.parse(JSON.stringify(x));
const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const DRAFT_KEY = 'floorset-owner-draft';

const O = {
  me: null,
  saved: null,          // the published venue
  draft: null,          // what the owner is editing
  dirty: false,
  tab: 'tonight',
  night: null,
  report: null,
  highlight: null,      // booking ref highlighted from the plan
  reportFloor: 0,
  manual: { tables: [], entryQty: 0, name: '', phone: '', occasion: '', note: '', comp: false },
  doorQuery: '',
  // editor
  floor: 0,
  tool: 'select',
  sel: [],              // [{k:'table'|'zone', id}]
  drag: null,
  marquee: null,
  typesOpen: false,
  placeMsg: '',
  flash: null,
  configText: '',
  configMsg: null,
};

// ------------------------------------------------------------------ boot

(async function boot() {
  try {
    O.me = await api('/owner/me');
    await start();
  } catch (e) {
    showLogin();
  }
})();

function showLogin(message) {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginMsg').innerHTML = message ? `<div class="msg err">${esc(message)}</div>` : '';
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/owner/login', { body: { username: f.get('username'), password: f.get('password') } });
    O.me = await api('/owner/me');
    await start();
  } catch (err) { showLogin(err.message); }
});

$('logout').addEventListener('click', async () => {
  if (O.dirty && !confirm('You have unsaved changes. Sign out anyway?')) return;
  await api('/owner/logout', { body: {} }).catch(() => {});
  location.reload();
});

async function start() {
  O.saved = await api('/owner/venue');
  O.draft = clone(O.saved);
  try {
    const kept = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (kept && kept.id === O.saved.id && JSON.stringify(kept) !== JSON.stringify(O.saved) &&
        confirm('You have unsaved floor/branding changes from last time. Restore them?')) {
      O.draft = kept; O.dirty = true;
    }
  } catch { /* storage unavailable: carry on without the backup */ }
  const today = new Date().toISOString().slice(0, 10);
  O.night = (O.saved.nights.find((n) => n.date >= today) || O.saved.nights[0] || {}).id || null;
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('guestLink').href = `/v/${O.saved.id}`;
  const hash = location.hash.slice(1);
  if (['tonight', 'door', 'floor', 'nights', 'brand', 'config'].includes(hash)) O.tab = hash;
  render();
  loadReport();
  setInterval(() => { if ((O.tab === 'tonight' || O.tab === 'door') && !document.hidden) loadReport(); }, 20000);
}

async function loadReport() {
  if (!O.night) { O.report = null; render(); return; }
  const key = `floorset-door-${O.saved.id}-${O.night}`;
  try {
    O.report = await api(`/owner/night?night=${encodeURIComponent(O.night)}`);
    O.report.offline = false;
    try { localStorage.setItem(key, JSON.stringify(O.report)); } catch { /* quota */ }
  } catch (e) {
    if (e.status === 401) return showLogin('Your session has ended. Please sign in again.');
    try {
      const cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (cached) { O.report = cached; O.report.offline = true; }
    } catch { /* nothing cached */ }
  }
  if (O.tab === 'tonight' || O.tab === 'door') render();
}

// ------------------------------------------------------------------ save

function touch() {
  O.dirty = true;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(O.draft)); }
  catch {
    // Most likely the quota. Keep the layout even if something large is dropped.
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...O.draft, floors: O.draft.floors.map((f) => ({ ...f, trace: undefined })) })); } catch { /* give up quietly */ }
  }
}

$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  $('saveMsg').textContent = 'Saving…';
  try {
    O.saved = await api('/owner/venue', { method: 'PUT', body: O.draft });
    O.draft = clone(O.saved);
    O.dirty = false;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    O.flash = { kind: 'ok', text: 'Saved. The booking page now shows these changes.' };
    O.sel = O.sel.filter((s) => findObj(s));
  } catch (e) {
    O.flash = { kind: 'err', text: e.message };
  }
  $('save').disabled = false;
  render();
  loadReport();
});

$('discard').addEventListener('click', () => {
  if (!confirm('Throw away your unsaved changes?')) return;
  O.draft = clone(O.saved); O.dirty = false; O.sel = []; O.flash = null;
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  O.floor = Math.min(O.floor, O.draft.floors.length - 1);
  render();
});

window.addEventListener('beforeunload', (e) => { if (O.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ render

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (!tab) return;
  O.tab = tab; O.flash = null; O.configMsg = null;
  history.replaceState(null, '', '#' + tab);
  if (tab === 'config') O.configText = JSON.stringify(O.draft, null, 1);
  render();
  if (tab === 'tonight' || tab === 'door') loadReport();
});

function render() {
  // Branding previews from the draft so the owner sees every change instantly.
  const v = O.tab === 'brand' || O.tab === 'floor' ? O.draft : O.saved;
  applyTheme(v);
  $('who').innerHTML = `${markHtml(v, 34)}<div><b>${esc(v.name)}</b><small>Owner dashboard</small></div>`;
  for (const b of $('tabs').querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === O.tab));
  $('savebar').classList.toggle('hidden', !O.dirty);
  const view = $('view');
  const views = { tonight: viewTonight, door: viewDoor, floor: viewFloor, nights: viewNights, brand: viewBrand, config: viewConfig };
  const active = document.activeElement;
  const keep = active && active.id && view.contains(active) ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  view.innerHTML = views[O.tab]();
  if (O.tab === 'tonight' && O.report) drawReportPlan();
  if (O.tab === 'floor') drawEditor();
  if (O.tab === 'brand') drawPlan($('brandPlan'), O.draft.floors[0], { state: () => null });
  if (keep) {
    const again = $(keep.id);
    if (again) { again.focus(); try { again.setSelectionRange(keep.start, keep.end); } catch { /* not a text input */ } }
  }
}

const flashHtml = () => O.flash ? `<div class="msg ${O.flash.kind}" role="status">${esc(O.flash.text)}</div>` : '';

function nightChips(venue = O.saved) {
  return `<div class="chips" role="group" aria-label="Night">${venue.nights.map((n) =>
    `<button class="chip" type="button" data-night="${esc(n.id)}" aria-pressed="${n.id === O.night}">${esc(n.label)}</button>`).join('') ||
    '<span class="faint">No nights yet — add one in the Nights tab.</span>'}</div>`;
}

const pretty = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`;
};

// ------------------------------------------------------------------ bookings tab

function tableCode(id) {
  for (const f of O.saved.floors) for (const t of f.tables) if (t.id === id) return t.code;
  return '?';
}

function viewTonight() {
  const r = O.report;
  let html = `<div class="toolbar">${nightChips()}<span class="sep"></span>
    <button class="btn sm" type="button" data-act="refresh">Refresh</button>
    ${r?.offline ? '<span class="msg err" style="margin:0">Offline — showing the last saved list</span>' : ''}</div>${flashHtml()}`;
  if (!r) return html + '<div class="panel hint">Pick a night.</div>';
  const s = r.summary;
  html += `<div class="tiles">
    <div class="tile hero"><span>Revenue</span><b>${inr(s.revenue)}</b></div>
    <div class="tile"><span>Bookings</span><b>${s.bookings}</b></div>
    <div class="tile"><span>Guests expected</span><b>${s.guests}</b></div>
    <div class="tile"><span>Checked in</span><b>${s.arrived}</b></div>
    <div class="tile"><span>Tables sold</span><b>${s.tablesSold}/${s.tablesTotal}</b></div>
    <div class="tile"><span>Occasions</span><b>${s.occasions}</b></div>
    <div class="tile"><span>No-shows</span><b>${s.noShows}</b></div>
    <div class="tile"><span>Refunded</span><b>${inr(s.refunds)}</b></div>
  </div>`;

  const floors = O.saved.floors;
  html += `<div class="grid"><div class="panel">
    <div class="toolbar"><h2 style="margin:0;flex:1">Tonight's floor</h2>
      ${floors.length > 1 ? floors.map((f, i) => `<button class="chip" type="button" data-rfloor="${i}" aria-pressed="${i === O.reportFloor}">${esc(f.name)}</button>`).join('') : ''}</div>
    <svg class="plan ops" id="reportPlan" role="group" aria-label="Floor plan with bookings"></svg>
    <div class="legend"><span><i class="sold"></i>booked</span><span><i class="arrived"></i>checked in</span><span><i class="booked"></i>blocked by you</span><span><i class="sel"></i>picked for a walk-in</span></div>
    <p class="hint">Tap a booked table to find its booking. Tap a free table to add it to a walk-in or comp booking.</p>
  </div>${manualPanel()}</div>`;

  html += `<div class="panel" style="margin-top:16px"><h2>Bookings</h2>`;
  if (!r.bookings.length) html += '<p class="hint">No bookings for this night yet.</p>';
  else {
    html += `<div class="tablewrap"><table class="list"><thead><tr><th>Ref</th><th>Guest</th><th>Tables</th><th>Entry</th><th>Party</th><th>Arrival</th><th>Occasion / note</th><th>Paid</th><th>Status</th><th></th></tr></thead><tbody>
      ${r.bookings.map((b) => `<tr class="${b.ref === O.highlight ? 'hl' : ''}" id="row-${esc(b.ref)}">
        <td class="mono">${esc(b.ref)}<br><span class="faint">${esc(b.source)}</span></td>
        <td>${esc(b.name)}<br><span class="faint mono">${esc(b.phone)}</span></td>
        <td class="mono">${b.tables.map(tableCode).join(', ') || '—'}</td>
        <td class="mono">${b.entryQty || '—'}</td>
        <td class="mono">${b.seated + b.entryQty}</td>
        <td class="mono">${pretty(b.arrival)}</td>
        <td>${b.occasion ? `<span class="occ">★ ${esc(b.occasion)}</span><br>` : ''}<span class="muted">${esc(b.note)}</span></td>
        <td class="mono">${inr(b.total)}${b.refund ? `<br><span class="faint">−${inr(b.refund)}</span>` : ''}</td>
        <td><span class="status ${esc(b.status)}">${esc(b.status)}</span></td>
        <td><div class="actions">${bookingActions(b)}</div></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  html += '</div>';
  return html;
}

function bookingActions(b) {
  const out = [];
  if (b.status === 'confirmed') {
    out.push(`<button class="btn sm" type="button" data-mark="arrived" data-ref="${esc(b.ref)}">Arrived</button>`);
    out.push(`<button class="btn sm ghost" type="button" data-mark="no-show" data-ref="${esc(b.ref)}">No-show</button>`);
    out.push(`<button class="btn sm ghost danger" type="button" data-cancel="${esc(b.ref)}" data-total="${b.total}">Cancel</button>`);
  } else if (b.status === 'arrived' || b.status === 'no-show') {
    out.push(`<button class="btn sm ghost" type="button" data-mark="confirmed" data-ref="${esc(b.ref)}">Undo</button>`);
  }
  return out.join('');
}

function manualPanel() {
  const m = O.manual;
  const tables = m.tables.map(tableCode);
  return `<div class="panel"><h2>Walk-in or comp</h2>
    <p class="hint">Takes tables off sale for this night, exactly like an online booking.</p>
    <div class="kv" style="display:flex;justify-content:space-between;padding:6px 0"><span>Tables</span><span class="mono">${tables.join(', ') || 'tap the plan'}</span></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0 12px"><span>General entry</span>
      <div class="stepper"><button type="button" data-mentry="-1" aria-label="One fewer" ${m.entryQty <= 0 ? 'disabled' : ''}>−</button><output>${m.entryQty}</output><button type="button" data-mentry="1" aria-label="One more" ${m.entryQty >= 30 ? 'disabled' : ''}>+</button></div></div>
    <label class="field"><span>Name</span><input class="input" id="mName" value="${esc(m.name)}"></label>
    <label class="field"><span>Mobile (optional)</span><input class="input" id="mPhone" type="tel" value="${esc(m.phone)}"></label>
    <label class="field"><span>Occasion</span><select class="input" id="mOccasion"><option value="">—</option>${OCCASIONS.map((o) => `<option ${o === m.occasion ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
    <label class="field"><span>Note</span><input class="input" id="mNote" value="${esc(m.note)}"></label>
    <label class="toggle"><span>Comp — no charge</span><input type="checkbox" id="mComp" ${m.comp ? 'checked' : ''}></label>
    <button class="btn primary block" type="button" data-act="manual" ${(m.tables.length || m.entryQty) ? '' : 'disabled'}>Add booking</button>
    ${m.tables.length || m.entryQty ? '<button class="btn ghost block" style="margin-top:6px" type="button" data-act="manualClear">Clear</button>' : ''}
  </div>`;
}

function drawReportPlan() {
  const r = O.report;
  const byTable = {};
  for (const b of r.bookings) if (b.status !== 'cancelled') for (const t of b.tables) byTable[t] = b;
  const floor = O.saved.floors[Math.min(O.reportFloor, O.saved.floors.length - 1)];
  const blocked = new Set(r.unavailable);
  drawPlan($('reportPlan'), floor, {
    focusable: true,
    state: (t) => {
      const b = byTable[t.id];
      if (O.manual.tables.includes(t.id)) return 'basket';
      if (b) return b.status === 'arrived' ? 'arrived' : 'sold';
      if (blocked.has(t.id)) return t.blocked ? 'booked' : 'held';
      return null;
    },
  });
  $('reportPlan').onclick = (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (!id) return;
    const b = byTable[id];
    if (b) {
      O.highlight = b.ref; render();
      $('row-' + b.ref)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (blocked.has(id)) return;
    const i = O.manual.tables.indexOf(id);
    if (i >= 0) O.manual.tables.splice(i, 1); else O.manual.tables.push(id);
    render();
  };
}

// ------------------------------------------------------------------ door tab

function viewDoor() {
  const r = O.report;
  const q = O.doorQuery.trim().toLowerCase();
  let html = `<div class="toolbar">${nightChips()}${r?.offline ? '<span class="msg err" style="margin:0">Offline — using the cached list</span>' : ''}</div>${flashHtml()}
    <div class="panel" style="max-width:720px">
    <label class="field"><span>Reference, name or last 4 digits of phone</span>
      <input class="input door-search" id="doorQuery" autocomplete="off" autocapitalize="characters" value="${esc(O.doorQuery)}" placeholder="QU-…"></label>`;
  if (!r) return html + '</div>';
  const live = r.bookings.filter((b) => b.status === 'confirmed' || b.status === 'arrived');
  const hits = q ? live.filter((b) => b.ref.toLowerCase().includes(q) || b.name.toLowerCase().includes(q) || b.phone.slice(-4) === q) : live;
  html += `<p class="hint">${r.summary.arrived} of ${r.summary.guests} guests checked in.</p>`;
  html += hits.slice(0, 40).map((b) => `<div class="door-card">
      <div><div class="ref">${esc(b.ref)}</div>
        <div>${esc(b.name)} · party of <b>${b.seated + b.entryQty}</b></div>
        <div class="muted">${b.tables.length ? 'Table ' + b.tables.map(tableCode).join(', ') : 'General entry'}${b.entryQty && b.tables.length ? ` + ${b.entryQty} entry` : ''} · arriving ${pretty(b.arrival)}</div>
        ${b.occasion ? `<div class="occ">★ ${esc(b.occasion)}${b.note ? ' — ' + esc(b.note) : ''}</div>` : ''}
        <div class="faint" style="font-size:12px">${b.redeemable && b.tables.length ? `Cover ${inr(b.total)} redeemable at the bar` : 'Cover not redeemable'}</div></div>
      ${b.status === 'arrived'
        ? `<button class="btn big ghost" type="button" data-mark="confirmed" data-ref="${esc(b.ref)}">✓ In — undo</button>`
        : `<button class="btn big primary" type="button" data-mark="arrived" data-ref="${esc(b.ref)}">Check in</button>`}
    </div>`).join('') || '<p class="hint">No booking matches.</p>';
  return html + '</div>';
}

// ------------------------------------------------------------------ nights tab

function viewNights() {
  const v = O.draft;
  return `${flashHtml()}<div class="panel" style="max-width:980px"><h2>Nights on sale</h2>
    <p class="hint">Each night is its own page section for guests: who's playing, doors, last entry, dress code and age. Tables are sold per night.</p>
    ${v.nights.map((n, i) => `<div class="night-card">
      <div class="grid3">
        <label class="field"><span>Date</span><input class="input" type="date" data-nf="date" data-ni="${i}" value="${esc(n.date)}"></label>
        <label class="field"><span>Label on the chip</span><input class="input" data-nf="label" data-ni="${i}" id="nl${i}" value="${esc(n.label)}" maxlength="40"></label>
        <label class="field"><span>Headline</span><input class="input" data-nf="headline" data-ni="${i}" id="nh${i}" value="${esc(n.headline)}" maxlength="80"></label>
      </div>
      <label class="field"><span>Line-up</span><input class="input" data-nf="lineup" data-ni="${i}" id="nu${i}" value="${esc(n.lineup)}" maxlength="200"></label>
      <div class="grid3">
        <label class="field"><span>Doors</span><input class="input" type="time" data-nf="doors" data-ni="${i}" value="${esc(n.doors)}"></label>
        <label class="field"><span>Last entry</span><input class="input" type="time" data-nf="lastEntry" data-ni="${i}" value="${esc(n.lastEntry)}"></label>
        <label class="field"><span>Minimum age</span><input class="input" type="number" min="0" max="30" data-nf="age" data-ni="${i}" value="${n.age}"></label>
      </div>
      <label class="field"><span>Dress code</span><input class="input" data-nf="dress" data-ni="${i}" id="nd${i}" value="${esc(n.dress)}" maxlength="160"></label>
      <label class="field"><span>Note for guests</span><input class="input" data-nf="note" data-ni="${i}" id="nn${i}" value="${esc(n.note)}" maxlength="200"></label>
      <button class="btn sm ghost danger" type="button" data-delnight="${i}">Remove this night</button>
    </div>`).join('')}
    <button class="btn" type="button" data-act="addNight">+ Add a night</button></div>`;
}

function labelFor(date) {
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + d.getDate() + ' ' + d.toLocaleDateString('en-GB', { month: 'short' });
}

// ------------------------------------------------------------------ brand tab

function viewBrand() {
  const v = O.draft;
  const sw = (field, current) => `<div class="swatches">${PALETTE.map(([hex, name]) => `<button class="swatch" type="button" style="background:${hex}" aria-label="${name}" aria-pressed="${hex.toUpperCase() === current.toUpperCase()}" data-brand="${field}" data-value="${hex}"></button>`).join('')}</div>`;
  const opts = (list, current, attr) => `<div class="chips">${list.map(([key, label]) => `<button class="chip" type="button" data-${attr}="${key}" aria-pressed="${key === current}">${label}</button>`).join('')}</div>`;
  return `${flashHtml()}<div class="grid"><div class="panel">
    <h2>Preview</h2><p class="hint">This is exactly how the booking page will look. Nothing here shows the platform's name — the page is yours.</p>
    <div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:12px">${markHtml(v, 44)}<div><div style="font-family:var(--display);font-size:28px">${esc(v.name)}</div><div class="faint mono" style="font-size:10.5px;letter-spacing:.14em;text-transform:uppercase">${esc(v.meta)} · entry ${inr(v.entry.price)}</div></div></div>
    <svg class="plan" id="brandPlan"></svg>
    <div class="legend">${tierFloors(v).map(([t, low]) => `<span><i class="${t === 'vip' ? 'vip' : ''}"></i>${t} from ${inr(low)}</span>`).join('')}</div>
  </div>
  <div><div class="panel"><h2>Brand</h2>
    <div class="row2"><label class="field"><span>Venue name</span><input class="input" id="bName" maxlength="60" value="${esc(v.name)}"></label>
    <label class="field"><span>Logo mark</span><input class="input" id="bMark" maxlength="3" value="${esc(v.mark)}"></label></div>
    <label class="field"><span>Mark shape</span><select class="input" id="bShape">${['circle', 'soft', 'none'].map((s) => `<option value="${s}" ${s === v.markShape ? 'selected' : ''}>${{ circle: 'Circle', soft: 'Rounded square', none: 'Outline only' }[s]}</option>`).join('')}</select></label>
    <label class="field"><span>Meta line (area · capacity)</span><input class="input" id="bMeta" maxlength="120" value="${esc(v.meta)}"></label>
    <p class="kicker">Primary colour</p>${sw('primary', v.brand.primary)}
    <p class="kicker" style="margin-top:14px">Accent colour</p>${sw('accent', v.brand.accent)}
    <p class="kicker" style="margin-top:14px">Surface</p>${opts(Object.keys(SURFACES).map((k) => [k, k[0].toUpperCase() + k.slice(1)]), v.brand.surface, 'surface')}
    <p class="kicker" style="margin-top:14px">Typeface</p>${opts([['editorial', 'Editorial'], ['modern', 'Modern'], ['classic', 'Classic']], v.brand.font, 'font')}
  </div>
  <div class="panel"><h2>Entry &amp; policy</h2>
    <div class="row2"><label class="field"><span>Entry price (₹)</span><input class="input" type="number" min="0" step="100" id="bPrice" value="${v.entry.price}"></label>
    <label class="field"><span>Entry label</span><input class="input" id="bLabel" maxlength="40" value="${esc(v.entry.label)}"></label></div>
    <label class="field"><span>Entry note</span><input class="input" id="bNote" maxlength="160" value="${esc(v.entry.note)}"></label>
    <label class="toggle"><span>Cover redeemable against the bill</span><input type="checkbox" id="bRedeem" ${v.redeemable ? 'checked' : ''}></label>
    <p class="hint" style="margin:0 0 12px">Guests see: ${v.redeemable ? 'redeemable against your bill.' : 'the cover is an entry charge and is not redeemable.'}</p>
    <label class="field"><span>Tables held until</span><input class="input" type="time" id="bHold" value="${esc(v.holdUntil)}"></label>
    <div class="row2"><label class="field"><span>GST rate %</span><input class="input" type="number" min="0" max="40" id="bTax" value="${v.tax.rate}"></label>
    <label class="toggle" style="margin-top:14px"><span>Prices include GST</span><input type="checkbox" id="bTaxIn" ${v.tax.inclusive ? 'checked' : ''}></label></div>
    <div class="row2"><label class="field"><span>Free cancellation until (hours before doors)</span><input class="input" type="number" min="0" max="720" id="bFree" value="${v.policy.freeCancelHours}"></label>
    <label class="field"><span>Refund after that (%)</span><input class="input" type="number" min="0" max="100" id="bLate" value="${v.policy.lateRefundPct}"></label></div>
    <p class="hint">Confirm the GST treatment of entry and covers with your CA.</p>
  </div></div></div>`;
}

const BRAND_FIELDS = {
  bName: (v, x) => { v.name = x; }, bMark: (v, x) => { v.mark = x.toUpperCase().slice(0, 3); }, bShape: (v, x) => { v.markShape = x; },
  bMeta: (v, x) => { v.meta = x; }, bPrice: (v, x) => { v.entry.price = Math.max(0, Math.round(Number(x) || 0)); },
  bLabel: (v, x) => { v.entry.label = x; }, bNote: (v, x) => { v.entry.note = x; }, bHold: (v, x) => { v.holdUntil = x; },
  bTax: (v, x) => { v.tax.rate = clamp(Math.round(Number(x) || 0), 0, 40); },
  bFree: (v, x) => { v.policy.freeCancelHours = clamp(Math.round(Number(x) || 0), 0, 720); },
  bLate: (v, x) => { v.policy.lateRefundPct = clamp(Math.round(Number(x) || 0), 0, 100); },
};

// ------------------------------------------------------------------ config tab

function viewConfig() {
  return `<div class="panel" style="max-width:980px"><h2>Venue config</h2>
    <p class="hint">The whole venue as JSON. Copy it as a backup, or paste a known-good version and apply it. Applying puts it into your unsaved changes; nothing goes live until you press Save &amp; publish.</p>
    ${O.configMsg ? `<div class="msg ${O.configMsg.kind}">${esc(O.configMsg.text)}</div>` : ''}
    <textarea class="json" id="configText" spellcheck="false" aria-label="Venue JSON">${esc(O.configText)}</textarea>
    <div class="toolbar" style="margin-top:10px"><button class="btn" type="button" data-act="copyConfig">Copy</button>
    <button class="btn primary" type="button" data-act="applyConfig">Apply</button>
    <button class="btn ghost" type="button" data-act="resetConfig">Reset to published</button></div></div>`;
}

// ------------------------------------------------------------------ floor editor

const floor = () => O.draft.floors[O.floor];
function findObj(s) {
  const f = floor();
  return s.k === 'table' ? f.tables.find((t) => t.id === s.id) : f.zones.find((z) => z.id === s.id);
}
const isSel = (k, id) => O.sel.some((s) => s.k === k && s.id === id);

function viewFloor() {
  const v = O.draft;
  const f = floor();
  const tools = [['select', 'Select'], ['multi', 'Select many'], ['table', 'Draw table'], ['zone', 'Draw zone']];
  return `${flashHtml()}<div class="grid"><div class="panel">
    <div class="toolbar">
      ${v.floors.map((fl, i) => `<button class="chip" type="button" data-efloor="${i}" aria-pressed="${i === O.floor}">${esc(fl.name)}</button>`).join('')}
      <button class="chip" type="button" data-act="addFloor">+ Add floor</button>
    </div>
    <div class="toolbar"><span class="kicker" style="margin:0">Tools</span>
      ${tools.map(([k, label]) => `<button class="chip" type="button" data-tool="${k}" aria-pressed="${O.tool === k}">${label}</button>`).join('')}</div>
    <svg class="plan plan-edit tool-${O.tool}" id="editPlan" role="application" aria-label="Floor plan editor"></svg>
    <div class="legend">${tierFloors(v).map(([t, low]) => `<span><i class="${t === 'vip' ? 'vip' : ''}"></i>${t} from ${inr(low)}</span>`).join('')}
      <span class="faint">· ${O.sel.length ? `${O.sel.length} selected, drag any to move all` : 'drag to move, or drag a box to pick several'}</span></div>
  </div>
  <div>
    <div class="panel"><p class="kicker">Floor</p>
      <div class="row2"><label class="field"><span>Floor name</span><input class="input" id="fName" maxlength="40" value="${esc(f.name)}"></label>
      <label class="field"><span>Short code</span><input class="input" id="fShort" maxlength="2" value="${esc(f.short)}"></label></div>
      ${v.floors.length > 1 ? `<button class="btn sm ghost danger" type="button" data-act="delFloor">Delete this floor</button>` : ''}
      ${typesPanel()}
    </div>
    <div class="panel">${selectionPanel()}
      <div class="row2" style="margin-top:12px"><button class="btn primary" type="button" data-act="addTable">+ Table</button><button class="btn" type="button" data-act="addZone">+ Zone</button></div>
    </div>
  </div></div>`;
}

function drawEditor() {
  const svg = $('editPlan');
  if (!svg) return;
  drawPlan(svg, floor(), {
    state: (t) => isSel('table', t.id) ? 'selected' : t.blocked ? 'booked' : null,
    zoneSelected: (z) => isSel('zone', z.id),
    marquee: O.marquee,
  });
}

function rangeField(id, label, value, min, max, step, word, ends) {
  return `<div class="field"><div class="rangehead"><span>${label}</span><b id="${id}Word">${word}</b></div>
    <input class="range" type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}">
    ${ends ? `<div class="rangehead"><span>${ends[0]}</span><span>${ends[1]}</span></div>` : ''}</div>`;
}

function selectionPanel() {
  const objs = O.sel.map(findObj).filter(Boolean);
  if (!objs.length) {
    return `<p class="kicker">Selection</p><div class="card dashed">Tap anything on the plan — a table, the dance floor, the bar, the DJ booth.<br><br>
      To pick several at once: drag a box across bare floor, or switch to <b>Select many</b> and tap each one. Then drag any one of them and the whole group moves.</div>`;
  }
  if (objs.length === 1) {
    const s = O.sel[0], o = objs[0];
    const size = Math.sqrt(o.w * o.h);
    const round = s.k === 'table' && (o.kind === 'round' || o.kind === 'hitop');
    if (s.k === 'table') {
      return `<p class="kicker">Selection</p>
        <div class="row2"><label class="field"><span>Code</span><input class="input mono" id="sCode" maxlength="4" value="${esc(o.code)}"></label>
        <label class="field"><span>Type</span><select class="input" id="sKind">${TABLE_KINDS.map((k) => `<option ${k === o.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label></div>
        <div class="row2"><label class="field"><span>Tier</span><select class="input" id="sTier">${TIERS.map((k) => `<option ${k === o.tier ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        <div class="field"><span style="display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text3);margin-bottom:5px">Seats</span>
          <div class="stepper"><button type="button" data-seats="-1" aria-label="Fewer seats" ${o.seats <= 1 ? 'disabled' : ''}>−</button><output>${o.seats}</output><button type="button" data-seats="1" aria-label="More seats" ${o.seats >= 30 ? 'disabled' : ''}>+</button></div></div></div>
        <label class="field"><span>Cover charge (₹)</span><input class="input" type="number" min="0" step="500" id="sCover" value="${o.cover}"></label>
        ${rangeField('sSize', 'Size', size.toFixed(1), 5, 60, 0.5, sizeWord(size), ['Small', 'Large'])}
        ${round ? '' : rangeField('sProp', 'Proportion', (o.w / o.h).toFixed(2), 0.3, 4, 0.05, proportionWord(o.w / o.h), ['Deep', 'Wide'])}
        <label class="field"><span>Status</span><select class="input" id="sBlocked"><option value="">Available</option><option value="1" ${o.blocked ? 'selected' : ''}>Blocked — not for sale online</option></select></label>
        <button class="btn block danger" type="button" data-act="deleteSel">Delete ${esc(o.code)}</button>
        <button class="btn block ghost" style="margin-top:6px" type="button" data-act="clearSel">Clear selection</button>`;
    }
    return `<p class="kicker">Selection</p>
      <label class="field"><span>Name</span><input class="input" id="zLabel" maxlength="30" value="${esc(o.label)}"></label>
      <label class="field"><span>What is it</span><select class="input" id="zKind">${ZONE_KINDS.map((k) => `<option value="${k}" ${k === o.kind ? 'selected' : ''}>${ZONE_NAMES[k]}</option>`).join('')}</select></label>
      <label class="field"><span>Label direction</span><select class="input" id="zDir"><option value="h">Across</option><option value="v" ${o.dir === 'v' ? 'selected' : ''}>Up the wall</option></select></label>
      ${rangeField('sSize', 'Size', size.toFixed(1), 3, 80, 0.5, sizeWord(size / 2.2), ['Small', 'Large'])}
      ${rangeField('sProp', 'Proportion', (o.w / o.h).toFixed(2), 0.15, 8, 0.05, proportionWord(o.w / o.h), ['Deep', 'Wide'])}
      <button class="btn block danger" type="button" data-act="deleteSel">Delete ${esc(o.label || 'zone')}</button>
      <button class="btn block ghost" style="margin-top:6px" type="button" data-act="clearSel">Clear selection</button>`;
  }
  const tables = O.sel.filter((s) => s.k === 'table').map(findObj).filter(Boolean);
  const zones = objs.length - tables.length;
  const sizes = tables.map((t) => sizeWord(Math.sqrt(t.w * t.h)));
  const avg = tables.length ? tables.reduce((a, t) => a + Math.sqrt(t.w * t.h), 0) / tables.length : 0;
  const sizeText = new Set(sizes).size === 1 ? sizes[0] : `mixed · avg ${sizeWord(avg)}`;
  return `<p class="kicker">Selection</p>
    <p style="font-size:14px"><b>${objs.length} selected</b> <span class="muted">— ${tables.length} table${tables.length === 1 ? '' : 's'} and ${zones} area${zones === 1 ? '' : 's'}. Drag any one of them and they all move together.</span></p>
    ${tables.length && zones ? `<button class="btn sm" type="button" data-act="tablesOnly">Tables only — drop the ${zones} area${zones === 1 ? '' : 's'}</button>` : ''}
    <h3>Line them up</h3><div class="chips">
      ${[['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['cx', 'Centre across'], ['cy', 'Centre down']].map(([k, l]) => `<button class="chip" type="button" data-align="${k}">${l}</button>`).join('')}</div>
    ${objs.length >= 3 ? `<h3>Even gaps</h3><div class="chips"><button class="chip" type="button" data-spread="x">Across</button><button class="chip" type="button" data-spread="y">Down</button></div>` : ''}
    <h3>Nudge</h3><div class="chips">${[['-1,0', '←'], ['1,0', '→'], ['0,-1', '↑'], ['0,1', '↓']].map(([d, l]) => `<button class="chip" type="button" data-nudge="${d}" aria-label="Nudge ${l}">${l}</button>`).join('')}</div>
    ${tables.length ? `<div class="row2" style="margin-top:14px">
      <label class="field"><span>Tier for all ${tables.length}</span><select class="input" id="bulkTier"><option value="">Leave as is</option>${TIERS.map((t) => `<option>${t}</option>`).join('')}</select></label>
      <label class="field"><span>Shape for all</span><select class="input" id="bulkKind"><option value="">Leave as is</option>${TABLE_KINDS.map((t) => `<option>${t}</option>`).join('')}</select></label></div>
      <label class="field"><span>Cover charge for all</span><input class="input" type="number" min="0" step="500" id="bulkCover" placeholder="₹ leave blank to keep"></label>
      <div class="field"><span style="display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text3);margin-bottom:5px">Size of all ${tables.length}</span>
        <div class="stepper" style="width:100%;justify-content:space-between"><button type="button" data-bulksize="0.9" aria-label="Smaller">−</button><output>${sizeText}</output><button type="button" data-bulksize="1.11" aria-label="Bigger">+</button></div></div>` : ''}
    <button class="btn block danger" type="button" data-act="deleteSel">Delete all ${objs.length}</button>
    <button class="btn block ghost" style="margin-top:6px" type="button" data-act="clearSel">Clear selection</button>`;
}

const DEFAULT_TYPES = [
  { label: 'VIP cabana', kind: 'cabana', tier: 'vip', seats: 10, cover: 40000 },
  { label: 'Booth', kind: 'booth', tier: 'premium', seats: 6, cover: 18000 },
  { label: 'Lounge sofa', kind: 'sofa', tier: 'premium', seats: 8, cover: 24000 },
  { label: 'Hi-top', kind: 'hitop', tier: 'standard', seats: 4, cover: 8000 },
  { label: 'Round table', kind: 'round', tier: 'standard', seats: 4, cover: 10000 },
];

function typesPanel() {
  const f = floor();
  const types = f.types || [];
  const wanted = types.reduce((a, t) => a + t.count, 0);
  const open = O.typesOpen || !f.tables.length || O.placeMsg;
  return `<details class="types" id="typesBox" ${open ? 'open' : ''}><summary><span>Tables by type</span><span class="faint">${types.length} types · ${wanted} tables</span></summary><div class="inner">
    <p class="hint">Most clubs have a handful of table kinds repeated. Set them up once, say how many of each, and they get placed for you around the dance floor, bar and entry.</p>
    ${types.map((t, i) => `<div class="typecard">
      <div class="row2"><input class="input" data-tf="label" data-ti="${i}" id="tl${i}" value="${esc(t.label)}" maxlength="30" aria-label="Type name">
      <select class="input" data-tf="kind" data-ti="${i}" aria-label="Shape">${TABLE_KINDS.map((k) => `<option ${k === t.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="row2" style="margin-top:8px"><select class="input" data-tf="tier" data-ti="${i}" aria-label="Tier">${TIERS.map((k) => `<option ${k === t.tier ? 'selected' : ''}>${k}</option>`).join('')}</select>
      <input class="input" type="number" min="0" step="500" data-tf="cover" data-ti="${i}" value="${t.cover}" aria-label="Cover charge"></div>
      <div class="row2" style="margin-top:8px">
        <div><span class="faint mono" style="font-size:10px">SEATS</span><div class="stepper"><button type="button" data-tstep="seats" data-ti="${i}" data-d="-1" aria-label="Fewer seats">−</button><output>${t.seats}</output><button type="button" data-tstep="seats" data-ti="${i}" data-d="1" aria-label="More seats">+</button></div></div>
        <div><span class="faint mono" style="font-size:10px">HOW MANY</span><div class="stepper"><button type="button" data-tstep="count" data-ti="${i}" data-d="-1" aria-label="Fewer">−</button><output>${t.count}</output><button type="button" data-tstep="count" data-ti="${i}" data-d="1" aria-label="More">+</button></div></div></div>
      <div style="margin-top:8px">${rangeField('ts' + i, 'Size of each', t.size, 6, 24, 0.5, sizeWord(t.size), ['Small', 'Large']).replace('class="range"', `class="range" data-tsize="${i}"`)}</div>
      <button class="btn sm ghost danger" type="button" data-deltype="${i}">Remove ${esc(t.label)}</button></div>`).join('')}
    <button class="btn block ghost" type="button" data-act="addType">+ Add a type</button>
    <button class="btn block primary" style="margin-top:8px" type="button" data-act="place" ${wanted ? '' : 'disabled'}>Place ${wanted} tables</button>
    <p class="hint">Replaces the tables placed by this tool and works around the dance floor, bar, stage and entry. Tables you placed by hand and zones are kept.</p>
    ${O.placeMsg ? `<div class="msg info">${esc(O.placeMsg)}</div>` : ''}</div></details>`;
}

function ensureTypes() {
  const f = floor();
  if (!f.types || !f.types.length) f.types = DEFAULT_TYPES.map((t) => ({ id: uid('ty'), ...t, count: 0, size: naturalSize(t.kind) }));
}

function runPlacement() {
  const f = floor();
  const result = placeTypes(f);
  f.tables = result.tables;
  O.sel = [];
  O.placeMsg = result.placed === result.wanted
    ? `Placed all ${result.placed} tables. Every one can be dragged.`
    : `Placed ${result.placed} of ${result.wanted} tables — the rest did not fit. Make them smaller, or shrink the dance floor, and place again.`;
  touch();
}

// --- geometry helpers

function fitInside(o, f) {
  o.w = clamp(snap(o.w), 2, f.w - 2 * MARGIN);
  o.h = clamp(snap(o.h), 2, f.h - 2 * MARGIN);
  o.x = clamp(snap(o.x), MARGIN, f.w - MARGIN - o.w);
  o.y = clamp(snap(o.y), MARGIN, f.h - MARGIN - o.h);
}

function resize(o, size, ratio) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  o.w = size * Math.sqrt(ratio); o.h = size / Math.sqrt(ratio);
  o.x = cx - o.w / 2; o.y = cy - o.h / 2;
  fitInside(o, floor());
}

function bbox(objs) {
  const x = Math.min(...objs.map((o) => o.x)), y = Math.min(...objs.map((o) => o.y));
  const r = Math.max(...objs.map((o) => o.x + o.w)), b = Math.max(...objs.map((o) => o.y + o.h));
  return { x, y, w: r - x, h: b - y };
}

function moveGroup(objs, origins, dx, dy) {
  const f = floor();
  const box = bbox(origins);
  dx = clamp(dx, MARGIN - box.x, f.w - MARGIN - (box.x + box.w));
  dy = clamp(dy, MARGIN - box.y, f.h - MARGIN - (box.y + box.h));
  objs.forEach((o, i) => { o.x = snap(origins[i].x + dx); o.y = snap(origins[i].y + dy); });
}

function nextCode(prefix) {
  const codes = new Set(floor().tables.map((t) => t.code));
  for (let n = 1; ; n++) if (!codes.has(prefix + n)) return prefix + n;
}

// --- pointer handling: one gesture state, pointer capture on every drag

function objAt(target) {
  const t = target.closest('[data-id]');
  if (t) return { k: 'table', id: t.dataset.id };
  const z = target.closest('[data-zone]');
  if (z) return { k: 'zone', id: z.dataset.zone };
  return null;
}

function onDown(e) {
  const svg = $('editPlan');
  if (!svg || e.button > 0) return;
  const p = svgPoint(svg, e);
  const hit = objAt(e.target);
  svg.setPointerCapture(e.pointerId);
  if (O.tool === 'table' || O.tool === 'zone') {
    O.drag = { mode: 'rubber', x0: p.x, y0: p.y };
    return;
  }
  const toggle = e.shiftKey || e.ctrlKey || e.metaKey || O.tool === 'multi';
  if (hit) {
    const already = isSel(hit.k, hit.id);
    if (toggle && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      O.sel = already ? O.sel.filter((s) => !(s.k === hit.k && s.id === hit.id)) : [...O.sel, hit];
      O.drag = null;
      render();
      return;
    }
    if (!already) O.sel = toggle ? [...O.sel, hit] : [hit];
    const objs = O.sel.map(findObj).filter(Boolean);
    O.drag = { mode: 'move', x0: p.x, y0: p.y, objs, origins: objs.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h })), moved: false, tapped: hit, wasSel: already };
    drawEditor();   // redraw in place: replacing the <svg> would drop pointer capture
  } else {
    O.drag = { mode: 'marquee', x0: p.x, y0: p.y, add: O.tool === 'multi' || e.shiftKey };
  }
}

function onMove(e) {
  if (!O.drag) return;
  const p = svgPoint($('editPlan'), e);
  const d = O.drag;
  if (d.mode === 'move') {
    const dx = p.x - d.x0, dy = p.y - d.y0;
    if (Math.abs(dx) + Math.abs(dy) > 0.25) d.moved = true;
    moveGroup(d.objs, d.origins, dx, dy);
  } else {
    O.marquee = { x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0) };
  }
  drawEditor();
}

function onUp(e) {
  const d = O.drag;
  O.drag = null;
  if (!d) return;
  const box = O.marquee;
  O.marquee = null;
  const f = floor();
  if (d.mode === 'move') {
    if (d.moved) touch();
    else if (O.tool === 'multi' && d.wasSel) O.sel = O.sel.filter((s) => !(s.k === d.tapped.k && s.id === d.tapped.id));
  } else if (d.mode === 'marquee') {
    if (!box || box.w + box.h < 1.5) {
      if (!d.add) O.sel = [];
    } else {
      const touches = (o) => o.x < box.x + box.w && box.x < o.x + o.w && o.y < box.y + box.h && box.y < o.y + o.h;
      const found = [...f.tables.filter(touches).map((t) => ({ k: 'table', id: t.id })), ...f.zones.filter(touches).map((z) => ({ k: 'zone', id: z.id }))];
      O.sel = d.add ? [...O.sel, ...found.filter((s) => !isSel(s.k, s.id))] : found;
    }
  } else if (d.mode === 'rubber') {
    if (box && box.w >= 4 && box.h >= 4) {
      if (O.tool === 'table') {
        const t = { id: uid('t'), code: nextCode('T'), kind: 'booth', tier: 'standard', seats: 4, cover: 10000, ...box };
        fitInside(t, f); f.tables.push(t); O.sel = [{ k: 'table', id: t.id }];
      } else {
        const z = { id: uid('z'), kind: 'lounge', label: 'New area', ...box };
        fitInside(z, f); f.zones.push(z); O.sel = [{ k: 'zone', id: z.id }];
      }
      touch();
    }
    O.tool = 'select';
  }
  render();
}

document.addEventListener('keydown', (e) => {
  if (O.tab !== 'floor' || e.key !== 'Escape') return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (O.tool !== 'select') O.tool = 'select'; else O.sel = [];
  render();
});

// ------------------------------------------------------------------ events

const view = $('view');
view.addEventListener('pointerdown', (e) => { if (e.target.closest('#editPlan')) onDown(e); });
view.addEventListener('pointermove', (e) => { if (O.drag) onMove(e); });
view.addEventListener('pointerup', (e) => { if (O.drag) onUp(e); });
view.addEventListener('pointercancel', () => { O.drag = null; O.marquee = null; render(); });

view.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const ds = b.dataset;
  const f = O.tab === 'floor' ? floor() : null;

  if (ds.night) { O.night = ds.night; O.highlight = null; O.manual.tables = []; render(); return loadReport(); }
  if (ds.rfloor) { O.reportFloor = Number(ds.rfloor); return render(); }
  if (ds.mark) {
    try { await api(`/owner/booking/${encodeURIComponent(ds.ref)}/${ds.mark}`, { body: {} }); O.flash = null; }
    catch (err) { O.flash = { kind: 'err', text: err.message }; }
    return loadReport();
  }
  if (ds.cancel) {
    const total = Number(ds.total);
    const answer = prompt(`Cancel ${ds.cancel}. Refund how much? (₹, up to ${total})`, String(total));
    if (answer === null) return;
    try {
      await api(`/owner/booking/${encodeURIComponent(ds.cancel)}/cancel`, { body: { refund: Math.max(0, Math.min(total, Math.round(Number(answer) || 0))) } });
      O.flash = { kind: 'ok', text: `${ds.cancel} cancelled. Its tables are back on sale.` };
    } catch (err) { O.flash = { kind: 'err', text: err.message }; }
    return loadReport();
  }
  if (ds.mentry) { O.manual.entryQty = clamp(O.manual.entryQty + Number(ds.mentry), 0, 30); return render(); }
  if (ds.tool) { O.tool = ds.tool; return render(); }
  if (ds.efloor) { O.floor = Number(ds.efloor); O.sel = []; O.placeMsg = ''; return render(); }
  if (ds.brand) { O.draft.brand[ds.brand] = ds.value; touch(); return render(); }
  if (ds.surface) { O.draft.brand.surface = ds.surface; touch(); return render(); }
  if (ds.font) { O.draft.brand.font = ds.font; touch(); return render(); }
  if (ds.delnight) {
    const n = O.draft.nights[Number(ds.delnight)];
    if (!confirm(`Remove ${n.label}? Guests will no longer see it.`)) return;
    O.draft.nights.splice(Number(ds.delnight), 1); touch(); return render();
  }
  if (ds.seats) {
    const t = findObj(O.sel[0]); t.seats = clamp(t.seats + Number(ds.seats), 1, 30); touch(); return render();
  }
  if (ds.align) {
    const objs = O.sel.map(findObj).filter(Boolean); const box = bbox(objs);
    for (const o of objs) {
      if (ds.align === 'left') o.x = box.x;
      if (ds.align === 'right') o.x = box.x + box.w - o.w;
      if (ds.align === 'top') o.y = box.y;
      if (ds.align === 'bottom') o.y = box.y + box.h - o.h;
      if (ds.align === 'cx') o.y = snap(box.y + box.h / 2 - o.h / 2);
      if (ds.align === 'cy') o.x = snap(box.x + box.w / 2 - o.w / 2);
    }
    touch(); return render();
  }
  if (ds.spread) {
    const objs = O.sel.map(findObj).filter(Boolean);
    const [p, s] = ds.spread === 'x' ? ['x', 'w'] : ['y', 'h'];
    objs.sort((a, c) => a[p] - c[p]);
    const box = bbox(objs);
    const span = ds.spread === 'x' ? box.w : box.h;
    const gap = (span - objs.reduce((a, o) => a + o[s], 0)) / (objs.length - 1);
    let at = box[p];
    for (const o of objs) { o[p] = snap(at); at += o[s] + gap; }
    touch(); return render();
  }
  if (ds.nudge) {
    const [dx, dy] = ds.nudge.split(',').map(Number);
    const objs = O.sel.map(findObj).filter(Boolean);
    moveGroup(objs, objs.map((o) => ({ ...o })), dx, dy); touch(); return render();
  }
  if (ds.bulksize) {
    for (const s of O.sel.filter((x) => x.k === 'table')) {
      const t = findObj(s);
      const k = Number(ds.bulksize);
      const size = clamp(Math.sqrt(t.w * t.h) * k, 5, Math.min(f.w, f.h) - 2 * MARGIN);
      resize(t, size, t.w / t.h);
    }
    touch(); return render();
  }
  if (ds.tstep) {
    const t = f.types[Number(ds.ti)];
    t[ds.tstep] = clamp(t[ds.tstep] + Number(ds.d), ds.tstep === 'seats' ? 1 : 0, ds.tstep === 'seats' ? 30 : 40);
    O.typesOpen = true; touch(); return render();
  }
  if (ds.deltype) { f.types.splice(Number(ds.deltype), 1); O.typesOpen = true; touch(); return render(); }

  switch (ds.act) {
    case 'refresh': return loadReport();
    case 'manualClear': O.manual = { tables: [], entryQty: 0, name: '', phone: '', occasion: '', note: '', comp: false }; return render();
    case 'manual': {
      const m = O.manual;
      try {
        const bk = await api('/owner/bookings', { body: { night: O.night, tables: m.tables, entryQty: m.entryQty, name: m.name, phone: m.phone, occasion: m.occasion, note: m.note, comp: m.comp } });
        O.flash = { kind: 'ok', text: `Booked — ${bk.ref}.` };
        O.manual = { tables: [], entryQty: 0, name: '', phone: '', occasion: '', note: '', comp: false };
      } catch (err) { O.flash = { kind: 'err', text: err.message }; }
      return loadReport();
    }
    case 'addNight': {
      const last = O.draft.nights.map((n) => n.date).sort().pop();
      const d = last ? new Date(last + 'T12:00:00') : new Date();
      if (last) d.setDate(d.getDate() + 1);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      let id = 'n' + date.replaceAll('-', '');
      while (O.draft.nights.some((n) => n.id === id)) id += 'b';
      O.draft.nights.push({ id, date, label: labelFor(date), headline: '', lineup: '', doors: '21:00', lastEntry: '00:30', dress: '', age: 21, note: '' });
      touch(); return render();
    }
    case 'copyConfig': {
      const text = $('configText').value;
      try { await navigator.clipboard.writeText(text); O.configMsg = { kind: 'ok', text: 'Copied.' }; }
      catch { $('configText').select(); O.configMsg = { kind: 'info', text: 'Selected — press Ctrl/Cmd + C to copy.' }; }
      return render();
    }
    case 'applyConfig': {
      try {
        const parsed = JSON.parse($('configText').value);
        if (!parsed || !Array.isArray(parsed.floors) || !parsed.floors.length || !Array.isArray(parsed.nights) || !parsed.brand || !parsed.entry) throw new Error('This does not look like a venue config (needs brand, entry, nights and floors).');
        parsed.id = O.saved.id;
        O.draft = parsed; O.floor = 0; O.sel = []; touch();
        O.configText = JSON.stringify(O.draft, null, 1);
        O.configMsg = { kind: 'ok', text: 'Applied to your unsaved changes. Check the floor plan, then Save & publish. The server re-checks every rule when you save.' };
      } catch (err) { O.configMsg = { kind: 'err', text: err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : err.message }; }
      return render();
    }
    case 'resetConfig': O.configText = JSON.stringify(O.saved, null, 1); O.configMsg = null; return render();
    case 'addFloor': {
      const n = O.draft.floors.length;
      O.draft.floors.push({ id: uid('f'), name: `Floor ${n}`, short: String(n), w: 100, h: 64, zones: [{ id: uid('z'), kind: 'stairs', label: 'Stairs', x: 6, y: 50, w: 12, h: 10 }], tables: [], types: [] });
      O.floor = n; O.sel = []; touch(); return render();
    }
    case 'delFloor':
      if (!confirm(`Delete ${f.name} and everything on it?`)) return;
      O.draft.floors.splice(O.floor, 1); O.floor = 0; O.sel = []; touch(); return render();
    case 'addTable': {
      const t = { id: uid('t'), code: nextCode('T'), kind: 'round', tier: 'standard', seats: 4, cover: 10000, x: f.w / 2 - 5, y: f.h / 2 - 5, w: 10, h: 10 };
      fitInside(t, f); f.tables.push(t); O.sel = [{ k: 'table', id: t.id }]; touch(); return render();
    }
    case 'addZone': {
      const z = { id: uid('z'), kind: 'lounge', label: 'New area', x: f.w / 2 - 8, y: f.h / 2 - 5, w: 16, h: 10 };
      fitInside(z, f); f.zones.push(z); O.sel = [{ k: 'zone', id: z.id }]; touch(); return render();
    }
    case 'deleteSel':
      f.tables = f.tables.filter((t) => !isSel('table', t.id));
      f.zones = f.zones.filter((z) => !isSel('zone', z.id));
      O.sel = []; touch(); return render();
    case 'clearSel': O.sel = []; return render();
    case 'tablesOnly': O.sel = O.sel.filter((s) => s.k === 'table'); return render();
    case 'addType':
      ensureTypes();
      f.types.push({ id: uid('ty'), label: 'New type', kind: 'round', tier: 'standard', seats: 4, cover: 10000, count: 0, size: naturalSize('round') });
      O.typesOpen = true; touch(); return render();
    case 'place': runPlacement(); return render();
    default:
  }
});

view.addEventListener('toggle', (e) => {
  if (e.target.id !== 'typesBox') return;
  O.typesOpen = e.target.open;
  if (e.target.open && (!floor().types || !floor().types.length)) { ensureTypes(); touch(); render(); }
}, true);

// Text typing updates state in place (no re-render while typing, so the caret stays put).
view.addEventListener('input', (e) => {
  const t = e.target;
  const id = t.id;
  if (id === 'doorQuery') { O.doorQuery = t.value; const pos = t.selectionStart; render(); const q = $('doorQuery'); q.focus(); q.setSelectionRange(pos, pos); return; }
  if (id === 'configText') { O.configText = t.value; return; }
  const m = { mName: 'name', mPhone: 'phone', mNote: 'note' }[id];
  if (m) { O.manual[m] = t.value; return; }
  if (BRAND_FIELDS[id] && t.type !== 'checkbox') {
    BRAND_FIELDS[id](O.draft, t.value); touch();
    $('savebar').classList.toggle('hidden', false);
    if (['bName', 'bMark', 'bMeta', 'bPrice'].includes(id)) render();
    return;
  }
  if (t.dataset.nf !== undefined) {
    const n = O.draft.nights[Number(t.dataset.ni)];
    const f = t.dataset.nf;
    n[f] = f === 'age' ? clamp(Math.round(Number(t.value) || 0), 0, 30) : t.value;
    if (f === 'date' && t.value) { n.label = labelFor(t.value); render(); }
    touch(); $('savebar').classList.remove('hidden');
    return;
  }
  if (O.tab === 'floor') floorInput(t, false);
});

view.addEventListener('change', (e) => {
  const t = e.target, id = t.id;
  if (id === 'mOccasion') { O.manual.occasion = t.value; return; }
  if (id === 'mComp') { O.manual.comp = t.checked; return; }
  if (id === 'bRedeem') { O.draft.redeemable = t.checked; touch(); return render(); }
  if (id === 'bTaxIn') { O.draft.tax.inclusive = t.checked; touch(); return render(); }
  if (BRAND_FIELDS[id]) { BRAND_FIELDS[id](O.draft, t.value); touch(); return render(); }
  if (O.tab === 'floor') floorInput(t, true);
});

function floorInput(t, committed) {
  const f = floor();
  const id = t.id;
  if (id === 'fName') { f.name = t.value; touch(); if (committed) render(); else $('savebar').classList.remove('hidden'); return; }
  if (id === 'fShort') { f.short = t.value.toUpperCase().slice(0, 2); touch(); return; }
  if (t.dataset.tf !== undefined) {
    const ty = f.types[Number(t.dataset.ti)];
    const field = t.dataset.tf;
    ty[field] = field === 'cover' ? Math.max(0, Math.round(Number(t.value) || 0)) : t.value;
    if (field === 'kind') ty.size = naturalSize(ty.kind);
    touch();
    if (committed && (field === 'kind') && f.tables.some((x) => x.gen)) runPlacement();
    if (committed) render(); else $('savebar').classList.remove('hidden');
    return;
  }
  if (t.dataset.tsize !== undefined) {
    const ty = f.types[Number(t.dataset.tsize)];
    ty.size = Number(t.value);
    const w = $(t.id + 'Word'); if (w) w.textContent = sizeWord(ty.size);
    touch();
    if (committed) { if (f.tables.some((x) => x.gen)) runPlacement(); render(); }
    return;
  }
  if (!O.sel.length) return;
  if (O.sel.length > 1) {
    const tables = O.sel.filter((s) => s.k === 'table').map(findObj);
    if (id === 'bulkTier' && t.value) tables.forEach((x) => { x.tier = t.value; });
    if (id === 'bulkKind' && t.value) tables.forEach((x) => setKind(x, t.value));
    if (id === 'bulkCover' && committed && t.value !== '') tables.forEach((x) => { x.cover = Math.max(0, Math.round(Number(t.value) || 0)); });
    if (committed) { touch(); render(); }
    return;
  }
  const o = findObj(O.sel[0]);
  if (!o) return;
  if (id === 'sCode') { o.code = t.value.toUpperCase().replace(/\s/g, '').slice(0, 4); drawEditor(); }
  else if (id === 'sKind') { setKind(o, t.value); }
  else if (id === 'sTier') o.tier = t.value;
  else if (id === 'sCover') o.cover = Math.max(0, Math.round(Number(t.value) || 0));
  else if (id === 'sBlocked') { if (t.value) o.blocked = true; else delete o.blocked; }
  else if (id === 'zLabel') { o.label = t.value; drawEditor(); }
  else if (id === 'zKind') o.kind = t.value;
  else if (id === 'zDir') { if (t.value === 'v') o.dir = 'v'; else delete o.dir; }
  else if (id === 'sSize') { resize(o, Number(t.value), o.w / o.h); $('sSizeWord').textContent = sizeWord(O.sel[0].k === 'zone' ? Number(t.value) / 2.2 : Number(t.value)); drawEditor(); }
  else if (id === 'sProp') { resize(o, Math.sqrt(o.w * o.h), Number(t.value)); $('sPropWord').textContent = proportionWord(Number(t.value)); drawEditor(); }
  touch();
  $('savebar').classList.remove('hidden');
  if (committed && !['sCode', 'zLabel'].includes(id)) render();
}

function setKind(o, kind) {
  o.kind = kind;
  if (kind === 'round' || kind === 'hitop') {   // square it off, keeping the area
    const s = Math.sqrt(o.w * o.h);
    resize(o, s, 1);
  }
}

