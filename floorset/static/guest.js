// The club's public booking page. One state object, one render pass.
import { api, applyTheme, drawPlan, esc, inr, markHtml, OCCASIONS, tierFloors } from './plan.js';

const slug = location.pathname.split('/').filter(Boolean)[1];
const $ = (id) => document.getElementById(id);

const S = {
  venue: null,
  night: null,
  floor: 0,
  unavailable: new Set(),
  entryQty: 0,
  basket: [],          // [{id, absorbed}] absorbed = general entries folded into the table
  focus: null,
  occasion: '',
  note: '',
  step: 'choose',      // choose | details | pay | done | find
  hold: null,
  name: '', phone: '', code: '', arrival: '', consent: false,
  otpSent: false, trialCode: '',
  booking: null,
  lookup: null, findRef: '', findPhone: '',
  flash: null,         // {kind, text}
  busy: false,
};

// ------------------------------------------------------------------ data

const allTables = () => S.venue.floors.flatMap((f) => f.tables.map((t) => ({ t, f })));
const tableById = (id) => allTables().find((x) => x.t.id === id);
const night = () => S.venue.nights.find((n) => n.id === S.night);
const inBasket = (id) => S.basket.some((b) => b.id === id);

function priceLocal() {
  const lines = [];
  let seated = 0, total = 0;
  if (S.entryQty) {
    const amount = S.venue.entry.price * S.entryQty;
    lines.push({ kind: 'entry', label: `${S.venue.entry.label} × ${S.entryQty}`, amount });
    total += amount;
  }
  for (const b of S.basket) {
    const found = tableById(b.id);
    if (!found) continue;
    lines.push({ kind: 'table', id: b.id, label: `${found.t.code} · ${found.f.name}`, amount: found.t.cover });
    total += found.t.cover; seated += found.t.seats;
  }
  if (!S.venue.tax.inclusive) {
    // Mirror the server: tax is computed and rounded per line.
    for (const l of lines) { const tax = Math.round(l.amount * S.venue.tax.rate / 100); l.amount += tax; total += tax; }
  }
  return { lines, seated, total };
}

async function loadAvailability() {
  if (!S.night) return;
  try {
    const { unavailable } = await api(`/v/${slug}/availability?night=${encodeURIComponent(S.night)}`);
    S.unavailable = new Set(unavailable);
    const lost = S.basket.filter((b) => S.unavailable.has(b.id) && !(S.hold));
    if (lost.length && S.step === 'choose') {
      for (const b of lost) removeTable(b.id, true);
      S.flash = { kind: 'err', text: `${lost.map((b) => tableById(b.id)?.t.code).join(', ')} was just booked by someone else and has been taken out of your booking.` };
    }
    if (S.focus && S.unavailable.has(S.focus) && !inBasket(S.focus)) S.focus = null;
  } catch (e) { /* keep the last known state; the hold re-checks anyway */ }
  render();
}

// ------------------------------------------------------------------ actions

function addTable(id) {
  const { t } = tableById(id);
  const absorbed = Math.min(S.entryQty, t.seats);
  S.entryQty -= absorbed;
  S.basket.push({ id, absorbed });
  S.flash = absorbed
    ? { kind: 'info', text: `${absorbed} general ${absorbed === 1 ? 'entry was' : 'entries were'} folded into ${t.code} — entry for ${t.seats} is included with the table, so you are not charged twice.` }
    : null;
}

function removeTable(id, quiet) {
  const i = S.basket.findIndex((b) => b.id === id);
  if (i < 0) return;
  const [b] = S.basket.splice(i, 1);
  const back = Math.min(b.absorbed, 30 - S.entryQty);
  S.entryQty += back;
  if (!quiet) {
    S.flash = back
      ? { kind: 'info', text: `${tableById(id)?.t.code} removed. The ${back} general ${back === 1 ? 'entry' : 'entries'} it covered ${back === 1 ? 'is' : 'are'} back in your booking.` }
      : null;
  }
  if (!S.basket.length && !S.entryQty) S.occasion = '';
}

function resetBasket() {
  Object.assign(S, { entryQty: 0, basket: [], focus: null, occasion: '', note: '', hold: null, booking: null, code: '', otpSent: false, trialCode: '', flash: null, consent: false });
}

async function startHold() {
  S.busy = true; S.flash = null; render();
  try {
    S.hold = await api(`/v/${slug}/hold`, { body: { night: S.night, tables: S.basket.map((b) => b.id), entryQty: S.entryQty, occasion: S.occasion, note: S.note } });
    S.hold.until = Date.now() + S.hold.expiresIn * 1000;
    S.step = 'details';
    if (!S.arrival) S.arrival = night().doors;
  } catch (e) {
    S.flash = { kind: 'err', text: e.message };
    if (e.status === 409) await loadAvailability();
  }
  S.busy = false; render();
}

async function releaseHold() {
  if (S.hold) api(`/v/${slug}/release`, { body: { holdId: S.hold.holdId } }).catch(() => {});
  S.hold = null; S.step = 'choose'; S.flash = null;
  loadAvailability();
}

async function sendCode() {
  S.busy = true; S.flash = null; render();
  try {
    const r = await api(`/v/${slug}/otp`, { body: { phone: S.phone } });
    S.otpSent = true; S.trialCode = r.trialCode || '';
  } catch (e) { S.flash = { kind: 'err', text: e.message }; }
  S.busy = false; render();
  $('code')?.focus();
}

async function pay() {
  S.busy = true; S.flash = null; render();
  try {
    S.booking = await api(`/v/${slug}/confirm`, { body: { holdId: S.hold.holdId, name: S.name, phone: S.phone, code: S.code, arrival: S.arrival, consent: S.consent } });
    S.step = 'done'; S.hold = null;
  } catch (e) {
    S.flash = { kind: 'err', text: e.message };
    if (e.status === 409) { S.hold = null; S.step = 'choose'; loadAvailability(); }
    else if (/code|number|name|agree/i.test(e.message)) S.step = 'details';
  }
  S.busy = false; render();
}

async function findBooking() {
  S.busy = true; S.flash = null; render();
  try { S.lookup = await api(`/v/${slug}/lookup`, { body: { ref: S.findRef, phone: S.findPhone } }); }
  catch (e) { S.flash = { kind: 'err', text: e.message }; S.lookup = null; }
  S.busy = false; render();
}

async function cancelBooking() {
  const amount = inr(S.lookup.refundIfCancelled || 0);
  if (!confirm(`Cancel ${S.lookup.ref}? You will be refunded ${amount}.`)) return;
  S.busy = true; render();
  try {
    S.lookup = await api(`/v/${slug}/cancel`, { body: { ref: S.findRef, phone: S.findPhone } });
    S.flash = { kind: 'ok', text: `Cancelled. ${inr(S.lookup.refund)} will be refunded to your original payment method.` };
    loadAvailability();
  } catch (e) { S.flash = { kind: 'err', text: e.message }; }
  S.busy = false; render();
}

function calendarFile(b) {
  const n = S.venue.nights.find((x) => x.id === b.night) || { date: b.date, doors: b.doors };
  const [hh, mm] = (b.arrival || n.doors || '21:00').split(':').map(Number);
  const [y, mo, d] = n.date.split('-').map(Number);
  const start = new Date(y, mo - 1, d, hh, mm);
  if (hh < 12) start.setDate(start.getDate() + 1);   // arrival after midnight
  const end = new Date(start.getTime() + 4 * 3600 * 1000);
  const fmt = (dt) => `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}T${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}00`;
  const what = [b.tables.length ? `${b.tables.length} table${b.tables.length > 1 ? 's' : ''}` : '', b.entryQty ? `${b.entryQty} entry` : ''].filter(Boolean).join(' and ');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//booking//EN', 'BEGIN:VEVENT', `UID:${b.ref}@${slug}`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${S.venue.name} — ${b.ref}`, `DESCRIPTION:${what}. Reference ${b.ref}. Show this at the door.`, `LOCATION:${S.venue.name}${S.venue.meta ? ', ' + S.venue.meta.split('·')[0].trim() : ''}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${b.ref}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function arrivalOptions() {
  const n = night();
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  let a = toMin(n.doors), b = toMin(n.lastEntry);
  if (b <= a) b += 24 * 60;
  const out = [];
  for (let m = a; m <= b; m += 30) {
    const h = Math.floor(m / 60) % 24, mm = m % 60;
    out.push(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return out;
}

const pretty = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const hr = h % 12 || 12;
  return m ? `${hr}:${String(m).padStart(2, '0')}${suffix}` : `${hr}${suffix}`;
};

// ------------------------------------------------------------------ render

function render() {
  const v = S.venue;
  document.title = `${v.name} — book a table`;
  $('brand').innerHTML = `${markHtml(v, 44)}<div><h1>${esc(v.name)}</h1><div class="meta">${esc(v.meta)}${v.meta ? ' · ' : ''}entry ${inr(v.entry.price)}</div></div>`;
  $('nights').innerHTML = v.nights.map((n) => `<button class="chip" type="button" data-night="${esc(n.id)}" aria-pressed="${n.id === S.night}">${esc(n.label)}</button>`).join('') || '<span class="faint">No nights on sale yet.</span>';

  const n = night();
  $('nightInfo').innerHTML = n ? `
    <div class="head"><div class="headline">${esc(n.headline || n.label)}</div>${n.lineup ? `<div class="lineup">${esc(n.lineup)}</div>` : ''}</div>
    <div class="fact"><b>Doors</b>${pretty(n.doors)}</div>
    <div class="fact"><b>Last entry</b>${pretty(n.lastEntry)}</div>
    <div class="fact"><b>Dress code</b>${esc(n.dress || 'None')}</div>
    <div class="fact"><b>Age</b>${n.age ? `${n.age}+ · ID checked` : 'All ages'}</div>
    ${n.note ? `<div class="note">${esc(n.note)}</div>` : ''}` : '';

  const floors = v.floors;
  $('floors').innerHTML = floors.length < 2 ? '' : floors.map((f, i) => `<button type="button" data-floor="${i}" aria-pressed="${i === S.floor}"><b>${esc(f.short)}</b><small>${esc(f.name.split(' ')[0])}</small></button>`).slice().reverse().join('');

  const floor = floors[S.floor];
  drawPlan($('plan'), floor, {
    focusable: true,
    state: (t) => inBasket(t.id) ? 'basket' : S.unavailable.has(t.id) ? 'booked' : S.focus === t.id ? 'focus' : null,
  });
  $('legend').innerHTML = tierFloors(v).map(([tier, low]) => `<span><i class="${tier === 'vip' ? 'vip' : ''}"></i>${tier} from ${inr(low)}</span>`).join('') +
    '<span><i class="sel"></i>yours</span><span><i class="booked"></i>booked</span>';
  $('policy').textContent = v.policyText;
  $('rail').innerHTML = rail();
  $('app').setAttribute('aria-busy', 'false');
}

function flash() {
  return S.flash ? `<div class="msg ${S.flash.kind}" role="${S.flash.kind === 'err' ? 'alert' : 'status'}">${esc(S.flash.text)}</div>` : '';
}

function redeemSentence() {
  return S.venue.redeemable ? 'Redeemable against your bill.' : 'Not redeemable against the bill.';
}

function rail() {
  if (S.step === 'find') return railFind();
  if (S.step === 'done') return railDone();
  if (S.step === 'details') return railDetails();
  if (S.step === 'pay') return railPay();
  return railChoose();
}

function railChoose() {
  const v = S.venue;
  if (!night()) return '<div class="card dashed">Bookings open soon. Check back for upcoming nights.</div>';
  let html = flash();
  html += `<section><p class="kicker">Entry</p><div class="card entry-card">
    <div class="top"><h3>${esc(v.entry.label)}</h3><span class="price">${inr(v.entry.price)} each</span></div>
    <p class="sub">${esc(v.entry.note)}${v.entry.note ? '. ' : ''}${redeemSentence()}</p>
    <div class="stepper" role="group" aria-label="General entry tickets">
      <button type="button" data-entry="-1" aria-label="One fewer" ${S.entryQty <= 0 ? 'disabled' : ''}>−</button>
      <output aria-live="polite">${S.entryQty}</output>
      <button type="button" data-entry="1" aria-label="One more" ${S.entryQty >= 30 ? 'disabled' : ''}>+</button>
    </div></div></section>`;

  html += '<section><p class="kicker">Table</p>';
  const f = S.focus && tableById(S.focus);
  if (f) {
    const { t, f: fl } = f;
    const added = inBasket(t.id);
    html += `<div class="card table-card">
      <div class="top"><h3>${esc(t.code)}</h3><span class="badge ${t.tier === 'vip' ? 'vip' : ''}">${t.tier}</span></div>
      <p class="sub" style="font-family:var(--mono);font-size:12px">${t.kind} · seats ${t.seats} · ${esc(fl.name)}</p>
      <div class="rule"></div>
      <div class="kv"><span>Cover charge</span><span class="v">${inr(t.cover)}</span></div>
      <div class="kv"><span>Entry for ${t.seats}</span><span class="v good">included</span></div>
      <div class="rule"></div>
      <p class="policy-line">${v.redeemable ? 'The cover comes off your bar bill.' : 'The cover is an entry charge and is not redeemable.'} Table held until ${pretty(v.holdUntil)}.</p>
      ${added ? `<button class="btn block" type="button" data-remove="${t.id}">Remove ${esc(t.code)}</button>`
               : `<button class="btn primary block" type="button" data-add="${t.id}">Add ${esc(t.code)} — ${inr(t.cover)}</button>`}
    </div>`;
  } else {
    html += '<div class="card dashed">Pick a table on the plan. Entry for your whole party is included with any table.</div>';
  }
  html += '</section>';

  if (S.basket.length || S.entryQty) {
    const p = priceLocal();
    html += `<section><p class="kicker">What's the occasion?</p><div class="chips" role="group" aria-label="Occasion">
      ${OCCASIONS.map((o) => `<button class="chip" type="button" data-occasion="${esc(o)}" aria-pressed="${S.occasion === o}">${esc(o)}</button>`).join('')}</div>
      <input class="input" style="margin-top:8px" id="note" maxlength="300" placeholder="Anything we should know? (optional)" value="${esc(S.note)}" aria-label="Note for the club"></section>`;
    html += `<section><p class="kicker">Your booking</p><ul class="basket">
      ${p.lines.map((l) => `<li><span class="l">${esc(l.label)}</span><span class="v">${inr(l.amount)}</span>${l.kind === 'table'
        ? `<button type="button" data-remove="${l.id}" aria-label="Remove ${esc(l.label)}">×</button>`
        : '<button type="button" data-entry="clear" aria-label="Remove general entry">×</button>'}</li>`).join('')}
      </ul>
      ${p.seated ? `<div class="kv"><span class="muted">Entry included</span><span class="v">${p.seated} guests</span></div>` : ''}
      <div class="total"><span>Pay now</span><span class="big">${inr(p.total)}</span></div>
      <div class="caption">${v.tax.inclusive ? `incl. ${v.tax.rate}% GST` : `+ ${v.tax.rate}% GST included in total`}${v.redeemable ? ' · redeemable at the bar' : ''}</div>
      <button class="btn primary block" type="button" id="continue" ${S.busy ? 'disabled' : ''}>Continue — ${inr(p.total)}</button>
      <p class="trial">Your table${S.basket.length > 1 ? 's are' : ' is'} held for 10 minutes while you finish.</p></section>`;
  }
  return html;
}

function holdTimer() {
  const left = Math.max(0, Math.round((S.hold.until - Date.now()) / 1000));
  return `<div class="countdown" id="countdown">Held for you · <b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b> left</div>`;
}

function railDetails() {
  const opts = arrivalOptions();
  return `${holdTimer()}${flash()}
    <section><p class="kicker">Your details</p>
    <label class="field"><span>Name on the booking</span><input class="input" id="name" autocomplete="name" maxlength="60" value="${esc(S.name)}"></label>
    <div class="otp-row">
      <label class="field"><span>Mobile number</span><input class="input" id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="98xxxxxxxx" value="${esc(S.phone)}"></label>
      <button class="btn field" type="button" id="sendCode" ${S.busy ? 'disabled' : ''}>${S.otpSent ? 'Resend' : 'Send code'}</button>
    </div>
    ${S.otpSent ? `<label class="field"><span>6-digit code sent by SMS</span><input class="input mono" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value="${esc(S.code)}"></label>
      ${S.trialCode ? `<div class="msg info">Trial mode — SMS is not connected yet. Your code is <b class="mono">${esc(S.trialCode)}</b>.</div>` : ''}` : ''}
    <label class="field"><span>Arriving around</span><select class="input" id="arrival">${opts.map((o) => `<option value="${o}" ${o === S.arrival ? 'selected' : ''}>${pretty(o)}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" id="consent" ${S.consent ? 'checked' : ''}><span>${esc(S.venue.name)} may keep my name, number and occasion to manage this booking and contact me about it.</span></label>
    <button class="btn primary block" type="button" id="toPay" ${S.otpSent && S.code.length === 6 && S.name.trim() && S.consent ? '' : 'disabled'}>Continue to payment</button>
    <button class="btn ghost block" style="margin-top:8px" type="button" id="back">Back — release my table</button>
    </section>`;
}

function railPay() {
  const p = S.hold.price;
  return `${holdTimer()}${flash()}
    <section><p class="kicker">Payment</p><ul class="basket">
    ${p.lines.map((l) => `<li><span class="l">${esc(l.label)}</span><span class="v">${inr(l.amount)}</span></li>`).join('')}</ul>
    <div class="kv"><span class="muted">Taxable value</span><span class="v">${inr(p.subtotal)}</span></div>
    <div class="kv"><span class="muted">GST ${p.taxRate}%${p.taxInclusive ? ' (included)' : ''}</span><span class="v">${inr(p.tax)}</span></div>
    <div class="total"><span>Total</span><span class="big">${inr(p.total)}</span></div>
    <div class="caption">${S.venue.redeemable ? 'Table covers are redeemable at the bar' : 'Covers are not redeemable'}</div>
    <div class="card" style="font-size:13px;line-height:1.5;color:var(--text2)"><b style="color:var(--text)">Cancellation.</b> ${esc(S.hold.policy)}
      ${S.basket.length ? `<br><b style="color:var(--text)">Arrival.</b> Tables are held until ${pretty(S.venue.holdUntil)}.` : ''}</div>
    <button class="btn primary block" style="margin-top:14px" type="button" id="pay" ${S.busy ? 'disabled' : ''}>Pay ${inr(p.total)}</button>
    ${S.venue.trial ? '<p class="trial">Trial mode — no money is taken. The booking is real in this system.</p>' : ''}
    <button class="btn ghost block" style="margin-top:8px" type="button" id="backDetails">Back</button></section>`;
}

function sentence(b) {
  const bits = [];
  if (b.tables.length) bits.push(`${b.tables.length} table${b.tables.length > 1 ? 's' : ''}`);
  if (b.entryQty) bits.push(`${b.entryQty} entry`);
  return `${bits.join(' and ')} at ${esc(S.venue.name)}, ${esc(b.nightLabel)}${b.arrival ? `, arriving ${pretty(b.arrival)}` : ''}.${b.occasion ? ` We've noted it's ${esc(b.occasion === 'Just because' ? 'just because' : 'a ' + b.occasion.toLowerCase())}.` : ''}`;
}

function railDone() {
  const b = S.booking;
  return `<div class="done"><h3>You're on the list</h3><p>${sentence(b)}</p><div class="ref">${esc(b.ref)}</div>
    <p style="margin-top:12px">Show this reference at the door. Paid ${inr(b.total)}.</p></div>
    <div class="stack" style="margin-top:12px">
      <button class="btn block" type="button" data-ics="1">Add to calendar</button>
      <button class="btn ghost block" type="button" id="again">Book again</button>
    </div>
    <p class="trial">To cancel later, use “Find or cancel a booking” with your reference and number.</p>`;
}

function railFind() {
  let html = `<section><p class="kicker">Find your booking</p>${flash()}
    <label class="field"><span>Reference</span><input class="input mono" id="findRef" placeholder="QU-XXXXX" value="${esc(S.findRef)}" autocapitalize="characters"></label>
    <label class="field"><span>Mobile number used to book</span><input class="input" id="findPhone" type="tel" inputmode="tel" value="${esc(S.findPhone)}"></label>
    <button class="btn primary block" type="button" id="doFind" ${S.busy ? 'disabled' : ''}>Find booking</button></section>`;
  const b = S.lookup;
  if (b) {
    const status = { confirmed: 'Confirmed', arrived: 'Checked in', cancelled: 'Cancelled', 'no-show': 'Marked as no-show' }[b.status] || b.status;
    html += `<section class="card"><div class="kv"><span class="mono">${esc(b.ref)}</span><span class="badge">${esc(status)}</span></div>
      <p class="sub">${sentence(b)}</p>
      ${b.lines.map((l) => `<div class="kv"><span>${esc(l.label)}</span><span class="v">${inr(l.amount)}</span></div>`).join('')}
      <div class="kv"><b>Total paid</b><span class="v">${inr(b.total)}</span></div>
      ${b.status === 'cancelled' ? `<div class="kv"><span>Refunded</span><span class="v">${inr(b.refund)}</span></div>` : ''}
      ${b.status === 'confirmed' ? `<div class="stack" style="margin-top:10px">
        <button class="btn block" type="button" data-ics="lookup">Add to calendar</button>
        <p class="policy-line">${esc(b.refundText || '')} If you cancel now: <b>${inr(b.refundIfCancelled || 0)}</b> back.</p>
        ${b.refundText && b.refundText.startsWith('The night has started') ? '' : '<button class="btn danger block" type="button" id="doCancel">Cancel this booking</button>'}</div>` : ''}
    </section>`;
  }
  html += '<button class="btn ghost block" style="margin-top:12px" type="button" id="closeFind">Back to booking</button>';
  return html;
}

// ------------------------------------------------------------------ events

function pickTable(id) {
  if (!id || S.step !== 'choose') return;
  if (S.unavailable.has(id) && !inBasket(id)) return;
  S.focus = id; S.flash = null;
  render();
}

$('plan').addEventListener('click', (e) => pickTable(e.target.closest('[data-id]')?.dataset.id));
$('plan').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (id) { e.preventDefault(); pickTable(id); document.querySelector(`[data-id="${id}"]`)?.focus(); }
});

$('nights').addEventListener('click', (e) => {
  const id = e.target.closest('[data-night]')?.dataset.night;
  if (!id || id === S.night) return;
  if (S.hold) releaseHold();
  S.night = id; S.focus = null; S.basket = []; S.entryQty = 0; S.occasion = ''; S.flash = null;
  if (S.step !== 'find') S.step = 'choose';
  S.unavailable = new Set();
  render(); loadAvailability();
});

$('floors').addEventListener('click', (e) => {
  const i = e.target.closest('[data-floor]')?.dataset.floor;
  if (i === undefined) return;
  S.floor = Number(i); S.focus = null;   // the basket survives a floor change
  render();
});

$('findBtn').addEventListener('click', () => {
  if (S.step === 'details' || S.step === 'pay') return;
  S.step = S.step === 'find' ? 'choose' : 'find';
  S.flash = null; render();
});

$('rail').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.entry) {
    if (t.dataset.entry === 'clear') S.entryQty = 0;
    else S.entryQty = Math.max(0, Math.min(30, S.entryQty + Number(t.dataset.entry)));
    S.flash = null;
    if (!S.basket.length && !S.entryQty) S.occasion = '';
  } else if (t.dataset.add) {
    addTable(t.dataset.add);
  } else if (t.dataset.remove) {
    removeTable(t.dataset.remove);
  } else if (t.dataset.occasion) {
    S.occasion = S.occasion === t.dataset.occasion ? '' : t.dataset.occasion;
  } else if (t.dataset.ics) {
    calendarFile(t.dataset.ics === 'lookup' ? S.lookup : S.booking);
    return;
  } else if (t.id === 'continue') { return startHold(); }
  else if (t.id === 'sendCode') { return sendCode(); }
  else if (t.id === 'toPay') { S.step = 'pay'; S.flash = null; }
  else if (t.id === 'back') { return releaseHold(); }
  else if (t.id === 'backDetails') { S.step = 'details'; }
  else if (t.id === 'pay') { return pay(); }
  else if (t.id === 'again') { resetBasket(); S.step = 'choose'; loadAvailability(); }
  else if (t.id === 'doFind') { return findBooking(); }
  else if (t.id === 'doCancel') { return cancelBooking(); }
  else if (t.id === 'closeFind') { S.step = 'choose'; S.flash = null; S.lookup = null; }
  render();
});

// Text inputs update state without a re-render, so focus and caret are kept.
$('rail').addEventListener('input', (e) => {
  const t = e.target;
  const map = { note: 'note', name: 'name', phone: 'phone', code: 'code', findRef: 'findRef', findPhone: 'findPhone', arrival: 'arrival' };
  if (map[t.id]) S[map[t.id]] = t.value;
  if (t.id === 'consent') S.consent = t.checked;
  const go = $('toPay');
  if (go) go.disabled = !(S.otpSent && S.code.trim().length === 6 && S.name.trim() && S.consent);
});
$('rail').addEventListener('change', (e) => {
  if (e.target.id === 'consent') { S.consent = e.target.checked; render(); }
});

setInterval(() => {
  if (!S.hold) return;
  const left = S.hold.until - Date.now();
  if (left <= 0) {
    S.hold = null; S.step = 'choose';
    S.flash = { kind: 'err', text: 'Your 10-minute hold ran out and the table was released. Check it is still free and continue again.' };
    loadAvailability();
    return;
  }
  const c = $('countdown');
  if (c) c.outerHTML = holdTimer();
}, 1000);

setInterval(() => { if (S.step === 'choose' && !document.hidden) loadAvailability(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.step === 'choose') loadAvailability(); });

// ------------------------------------------------------------------ boot

(async function boot() {
  try {
    S.venue = await api(`/v/${slug}`);
  } catch (e) {
    document.body.innerHTML = `<div class="shell"><div class="msg err">${esc(e.message)}</div></div>`;
    return;
  }
  applyTheme(S.venue);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = S.venue.nights.filter((n) => n.date >= today);
  S.venue.nights = upcoming.length ? upcoming : S.venue.nights;
  S.night = S.venue.nights[0]?.id || null;
  render();
  loadAvailability();
})();
