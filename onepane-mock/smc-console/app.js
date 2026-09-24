'use strict';

/**
 * Renders the SMC ticket stand-in.
 *
 * This page knows nothing about One Pane. The panel used to be baked in here;
 * it now lives entirely in the extension, which overlays this page without
 * touching it - which is the only arrangement that can work against the real
 * console, where we cannot change a line of markup.
 */

const state = {
  tickets: [],
  ticket: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "7/31/25 at 2:00 PM EDT" - the format the real console uses. */
function fmtDate(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '';
  return `${date} at ${time} ${zone}`;
}

function relativeAge(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** Time-to-resolution counter, in the console's Y/M/D + clock format. */
function ttr(iso) {
  let ms = Date.now() - new Date(iso);
  const years = Math.floor(ms / 31536000000); ms -= years * 31536000000;
  const months = Math.floor(ms / 2592000000); ms -= months * 2592000000;
  const days = Math.floor(ms / 86400000); ms -= days * 86400000;
  const hh = String(Math.floor(ms / 3600000)).padStart(2, '0'); ms -= Math.floor(ms / 3600000) * 3600000;
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0'); ms -= Math.floor(ms / 60000) * 60000;
  const ss = String(Math.floor(ms / 1000)).padStart(2, '0');
  return `${years}Y ${months}M ${days}D ${hh}:${mm}:${ss}`;
}

const initials = (name) => String(name || '?')
  .split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/* ---------------- notes ---------------- */

const NOTE_SUBTITLE = {
  system: 'Expedient',
  ai: 'AI Summary',
  analyst: 'Service Delivery - Expedient',
};

/**
 * Status-change notes render as a banner above the body in the real console.
 * The mock corpus encodes them as ordinary system notes, so detect the phrasing.
 */
function statusBanner(note) {
  const match = /^(Ticket status changed from .+?)(?:\.|$)/.exec(note.body);
  return match ? match[1] : null;
}

function renderNotes(ticket) {
  // The console defaults to newest-first; the corpus is stored oldest-first.
  const notes = [...ticket.notes].reverse();

  $('notesList').innerHTML = notes.map((n) => {
    const banner = n.role === 'system' ? statusBanner(n) : null;
    const body = banner ? n.body.slice(banner.length).replace(/^[.\s]+/, '') : n.body;
    const subtitle = NOTE_SUBTITLE[n.role] || ticket.client;

    return `
      <div class="ticket-note" data-note-type="${esc(n.role)}">
        <div class="note-head">
          <div class="note-avatar ${esc(n.role)}">${esc(initials(n.author))}</div>
          <div class="note-id">
            <div class="note-author">${esc(n.author)}</div>
            <div class="note-title">${esc(subtitle)}</div>
          </div>
          <time class="note-time" datetime="${esc(n.at)}">${esc(fmtDate(n.at))}</time>
          <button class="note-menu">▾</button>
        </div>

        ${banner ? `<div class="note-banner">${esc(banner)}</div>` : ''}
        ${body ? `<div class="note-body">${esc(body)}</div>` : ''}

        <div class="note-foot">
          <span>Visibility: ${esc(n.visibility || 'All')}</span>
          <span>Source: ${n.role === 'system' ? 'API' : 'SMC'}</span>
          <span class="helpful">Was this response helpful?
            <a href="#">Yes</a> | <a href="#">No</a> | <a href="#">Neutral</a>
          </span>
        </div>
      </div>`;
  }).join('');

  const label = `1-${ticket.notes.length} of ${ticket.notes.length}`;
  $('notesMeta').textContent = label;
  $('notesFoot').textContent = label;
  $('noteCount').textContent = ticket.notes.length;
}

/* ---------------- detail column ---------------- */

const row = (k, v) => `<div class="d-row"><div class="d-k">${esc(k)}</div><div class="d-v">${v}</div></div>`;
const select = (value) => `<select class="d-select"><option>${esc(value)}</option></select>`;

function renderDetail(t) {
  $('detailCol').innerHTML = [
    row('Client', `
      <div class="with-icon"><svg class="i"><use href="#i-clipboard"/></svg>
        <a href="#">${esc(t.client)}</a></div>
      <div class="d-badges">
        <span class="badge-pill green">Active Delivery Project</span>
        <span class="badge-pill grey">Legacy</span>
      </div>`),

    row('Status', esc(t.status)),

    row('Severity', `<div class="sev sev-${esc(t.severity)}">
        <span class="sev-dot"></span>${esc(t.severity)}
        <svg class="i" style="color:#888"><use href="#i-info"/></svg>
      </div>`),

    row('Visibility', esc(t.visibility || 'All')),
    row('Subject', esc(t.subject)),
    row('Vendors', ''),
    row('Opened By', esc(t.openedBy)),

    row('Stats', `
      <div class="stat-line"><b>Created:</b> ${esc(relativeAge(t.created))}</div>
      <div class="stat-line"><b>Last updated:</b> ${esc(fmtDate(t.lastUpdated))}</div>
      <div class="stat-line"><b>Update due:</b> <span class="urgent">ASAP</span></div>
      <div class="stat-line"><b>Escalate for review:</b> <span class="urgent">ASAP</span></div>
      <div class="stat-line"><b>TTR:</b> ${esc(ttr(t.created))}</div>`),

    row('Queue', select(t.queue)),
    row('Assigned To', select(t.assignedTo)),
    row('Type', select(t.type)),
    row('Category', esc(t.category)),
    row('Problem', select(t.problem)),
    row('Facility', esc(t.facility)),

    t.services?.length
      ? row('Services', t.services.map((s) => `<div class="muted">${esc(s)}</div>`).join(''))
      : '',

    t.assets?.length
      ? row('Assets', t.assets.map((a) => `<div><a href="#">${esc(a)}</a></div>`).join(''))
      : '',

    t.relatedTickets?.length
      ? row('Related Tickets', t.relatedTickets
          .map((r) => `<div><a href="#">#${esc(r.id)}</a> <span class="muted">(${esc(r.state)})</span></div>`).join(''))
      : '',

    row('Survey URL', `
      <div class="with-icon"><svg class="i"><use href="#i-clipboard"/></svg></div>
      <a href="#">https://support.expedient.com/ticket/survey?id=${esc(t.id)}</a>
      <div class="muted" style="margin-top:5px">Accessed: No</div>`),
  ].join('');
}

/* ---------------- data ---------------- */

async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadTicket(id) {
  const { ticket } = await api(`/api/tickets/${id}`);
  state.ticket = ticket;

  // The adapter reads the ticket id from here, so it has to change before
  // anything else does - the extension watches this attribute.
  $('ticketRoot').setAttribute('data-ticket-id', ticket.id);

  $('crumbTitle').textContent = `#${ticket.id} ${ticket.title}`;
  document.title = `#${ticket.id} ${ticket.title} — SMC`;
  $('replyBox').innerHTML = '';

  renderNotes(ticket);
  renderDetail(ticket);
}

async function init() {
  const { tickets } = await api('/api/tickets');
  state.tickets = tickets;

  $('ticketPicker').innerHTML = tickets
    .map((t) => `<option value="${esc(t.id)}">#${esc(t.id)} — ${esc(t.title)}</option>`).join('');
  $('ticketPicker').onchange = (e) => loadTicket(e.target.value);

  await loadTicket(tickets[0].id);
}

init().catch((err) => {
  document.body.innerHTML = `<pre style="padding:40px;color:#b42318">Failed to start: ${esc(err.message)}</pre>`;
});
