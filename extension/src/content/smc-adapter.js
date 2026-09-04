/**
 * Every piece of DOM coupling in the extension lives in this file.
 *
 * SMC's markup is not ours and will change without warning. Isolating it here
 * means a broken selector is a one-file fix, and it mirrors the seam the server
 * already has: `buildContext()` in server/context.js consumes one normalized
 * ticket shape, so a DOM adapter and a future SMC API adapter are
 * interchangeable as far as everything downstream is concerned.
 *
 * Note what is NOT here: nothing that finds a place to put the panel. The
 * overlay attaches itself to <body> and positions itself over the page, so the
 * extension never needs a host element inside SMC's layout - which is the only
 * arrangement available to us, since we cannot edit SMC to make room.
 *
 * DESIGN INVARIANT: this module reads the page and writes into the reply box.
 * It has no function that submits, posts, resolves, or escalates a ticket, and
 * it must not grow one. One Pane drafts; a human sends. That guarantee is also
 * what keeps One Pane from mutating state the AI CTRL system assumes only
 * humans change.
 */

/* ------------------------------------------------------------------ *
 * Selectors
 *
 * The local mock (public/index.html) is built to mirror these, so the reply-box
 * and ticket-change paths below are exercised for real against localhost even
 * though no one has SMC access yet.
 *
 * THE SMC-ONLY SELECTORS ARE UNVERIFIED PLACEHOLDERS - see extension/README.md.
 * ------------------------------------------------------------------ */

const SHARED_SELECTORS = {
  ticketRoot: '[data-ticket-id]',
  replyBox: '.reply-editor[contenteditable="true"]',
};

const SMC_SELECTORS = {
  subject: '.ticket-subject',
  client: '.ticket-client',
  clientContact: '.ticket-contact',
  status: '.ticket-status',
  severity: '.ticket-severity',
  queue: '.ticket-queue',
  category: '.ticket-category',
  problem: '.ticket-problem',
  assignedTo: '.ticket-assigned-to',
  facility: '.ticket-facility',
  note: '.ticket-note',
  noteAuthor: '.note-author',
  noteBody: '.note-body',
  noteTimestamp: 'time[datetime]',
};

/**
 * Ways a ticket id might be discoverable, tried in order of trustworthiness.
 *
 * Nobody has run this against the real console yet, so rather than betting on
 * one URL shape it tries several and reports which one worked. An SMC ticket
 * number is 6-9 digits; requiring that length keeps these patterns from
 * matching pagination counters and other stray numbers.
 */
const TICKET_ID_STRATEGIES = [
  {
    name: 'data-ticket-id attribute',
    find: (doc) => doc.querySelector(SHARED_SELECTORS.ticketRoot)?.getAttribute('data-ticket-id') || null,
  },
  {
    name: 'URL path (/ticket/123456)',
    find: (doc, location) => /\/tickets?\/(\d{5,9})\b/i.exec(location.pathname)?.[1] || null,
  },
  {
    name: 'URL query (?id= or ?ticket=)',
    find: (doc, location) => {
      const params = new URLSearchParams(location.search);
      for (const key of ['id', 'ticket', 'ticketId', 'ticket_id']) {
        const value = params.get(key);
        if (value && /^\d{5,9}$/.test(value)) return value;
      }
      return null;
    },
  },
  {
    name: 'heading text (#123456)',
    find: (doc) => {
      // The console renders the number in the breadcrumb as "#3343669 Client -
      // Subject", so the first heading carrying that shape is the ticket.
      for (const el of doc.querySelectorAll('h1, h2, .breadcrumb, [class*="crumb"]')) {
        const match = /#(\d{5,9})\b/.exec(el.textContent || '');
        if (match) return match[1];
      }
      return null;
    },
  },
];

/**
 * Read the ticket id the page is currently showing.
 * @returns {{id: string, via: string} | null}
 */
function findTicketId(doc, location) {
  for (const strategy of TICKET_ID_STRATEGIES) {
    let id = null;
    try {
      id = strategy.find(doc, location);
    } catch {
      id = null;
    }
    if (id) return { id, via: strategy.name };
  }
  return null;
}

/** Read the ticket id the page is currently showing, id only. */
function readTicketId(doc, location = window.location) {
  return findTicketId(doc, location)?.id || null;
}

/**
 * Locate the reply editor.
 *
 * The exact selector is a guess, so fall back to a shape-based search: the
 * largest visible editable element on the page. On a ticket view that is the
 * reply box by a wide margin. Reported through `diagnose()` so a wrong pick is
 * visible rather than mysterious.
 *
 * @returns {{el: HTMLElement, via: string} | null}
 */
function findReplyBox(doc) {
  const exact = doc.querySelector(SHARED_SELECTORS.replyBox);
  if (exact) return { el: exact, via: 'exact selector' };

  const candidates = [...doc.querySelectorAll('[contenteditable="true"], [contenteditable=""], textarea')]
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ el, rect }) => {
      if (rect.width < 200 || rect.height < 60) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled && !el.readOnly;
    })
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);

  if (!candidates.length) return null;
  return {
    el: candidates[0].el,
    via: `largest visible ${candidates[0].el.tagName.toLowerCase()} (${candidates.length} candidates)`,
  };
}

/**
 * SMC is a single-page app, so a ticket change is a DOM swap rather than a
 * navigation. Watch the id attribute instead of listening for page loads.
 */
function watchTicketAttribute(doc, callback) {
  const observer = new MutationObserver(() => callback());
  observer.observe(doc.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-ticket-id'],
  });
  return () => observer.disconnect();
}

/**
 * Map a note to the role vocabulary server/context.js expects
 * ('client' | 'analyst' | 'system' | 'ai').
 *
 * The distinction that matters most is client vs. analyst: it decides
 * `awaitingOurReply`, which decides whether One Pane drafts a reply at all.
 * Getting this wrong is worse than failing outright, so an unrecognized note
 * falls through to 'system' - counted in the thread, never mistaken for a
 * customer asking us something.
 */
function classifyNote(el) {
  const marker = (el.getAttribute('data-note-type') || el.className || '').toLowerCase();

  if (marker.includes('ai') || marker.includes('summary')) return 'ai';
  if (marker.includes('system') || marker.includes('automated')) return 'system';
  if (marker.includes('customer') || marker.includes('client') || marker.includes('inbound')) return 'client';
  if (marker.includes('analyst') || marker.includes('agent') || marker.includes('outbound')) return 'analyst';
  return 'system';
}

/* ------------------------------------------------------------------ *
 * Profile: the local prototype at localhost:3000
 * ------------------------------------------------------------------ */

const demoProfile = {
  id: 'demo',
  label: 'One Pane prototype (localhost)',

  matches: (location) => location.hostname === 'localhost' && location.port === '3000',

  /**
   * The demo backend already holds the full ticket, so this profile reads only
   * the id and lets the server resolve it. It deliberately does NOT fake DOM
   * extraction: the mock renders human-formatted dates and escaped bodies, and
   * parsing those back into a ticket would prove nothing about the real path.
   */
  readTicket(doc) {
    const ticketId = readTicketId(doc);
    return ticketId ? { ticketId, ticket: null } : null;
  },

  findReplyBox: (doc) => doc.querySelector(SHARED_SELECTORS.replyBox),
  onTicketChange: watchTicketAttribute,
};

/* ------------------------------------------------------------------ *
 * Profile: the real SMC console
 * ------------------------------------------------------------------ */

const smcProfile = {
  id: 'smc',
  label: 'SMC console',

  // Matches the whole console, not just paths that look like a ticket. Until
  // the real URL shape is confirmed, a profile that only matched a guessed
  // pattern would leave the panel invisible on the very pages we need to
  // inspect - and "nothing happened" is the least useful bug report there is.
  matches: (location) => location.hostname === 'app.expedient.com',

  /**
   * Extract a ticket in the shape `buildContext()` consumes (see the mock
   * corpus in data/tickets.js for the full field list).
   *
   * Fields SMC does not expose in the DOM come back empty rather than guessed -
   * retrieval scores an absent field as no signal, which is correct, whereas a
   * wrong guess is scored as real signal and quietly skews the draft.
   */
  readTicket(doc, location) {
    const ticketId = readTicketId(doc, location);
    if (!ticketId) return null;

    const root = doc.querySelector(SHARED_SELECTORS.ticketRoot) || doc.body;
    const text = (selector) => root.querySelector(selector)?.textContent?.trim() || '';

    const notes = [...root.querySelectorAll(SMC_SELECTORS.note)].map((el) => ({
      author: el.querySelector(SMC_SELECTORS.noteAuthor)?.textContent?.trim() || 'Unknown',
      role: classifyNote(el),
      at: el.querySelector(SMC_SELECTORS.noteTimestamp)?.getAttribute('datetime') || '',
      body: el.querySelector(SMC_SELECTORS.noteBody)?.textContent?.trim() || '',
    }));

    return {
      ticketId,
      ticket: {
        id: ticketId,
        subject: text(SMC_SELECTORS.subject),
        title: text(SMC_SELECTORS.subject),
        client: text(SMC_SELECTORS.client),
        clientContact: text(SMC_SELECTORS.clientContact),
        status: text(SMC_SELECTORS.status),
        severity: text(SMC_SELECTORS.severity),
        queue: text(SMC_SELECTORS.queue),
        category: text(SMC_SELECTORS.category),
        problem: text(SMC_SELECTORS.problem),
        assignedTo: text(SMC_SELECTORS.assignedTo),
        facility: text(SMC_SELECTORS.facility),
        type: '',
        services: [],
        assets: [],
        relatedTickets: [],
        // The corpus is stored oldest-first and the console renders newest-first.
        notes: notes.reverse(),
      },
    };
  },

  findReplyBox: (doc) => findReplyBox(doc)?.el || null,

  /**
   * SMC is a single-page app, so a ticket change is a DOM swap rather than a
   * navigation. The id may come from the URL rather than an attribute, so watch
   * both - and debounce, because a SPA re-render fires many mutations at once.
   */
  onTicketChange(doc, callback) {
    let last = readTicketId(doc, window.location);
    let timer = null;

    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = readTicketId(doc, window.location);
        if (next !== last) {
          last = next;
          callback();
        }
      }, 250);
    };

    const observer = new MutationObserver(check);
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true });
    window.addEventListener('popstate', check);

    return () => {
      observer.disconnect();
      window.removeEventListener('popstate', check);
      clearTimeout(timer);
    };
  },
};

/**
 * Report what the adapter can and cannot find on the current page.
 *
 * This exists because the SMC selectors were written without access to the real
 * console. When detection fails the panel shows this instead of silently not
 * appearing, which turns a dead end into the information needed to fix the
 * selectors.
 *
 * Includes page text (headings, a landmark class list), so it is shown to the
 * analyst to review rather than sent anywhere automatically.
 */
export function diagnose(doc = document, location = window.location) {
  const strategies = TICKET_ID_STRATEGIES.map((s) => {
    let found = null;
    try {
      found = s.find(doc, location);
    } catch (err) {
      found = `error: ${err.message}`;
    }
    return { name: s.name, found: found || null };
  });

  const reply = findReplyBox(doc);

  return {
    url: location.href,
    ticketId: findTicketId(doc, location)?.id || null,
    ticketIdVia: findTicketId(doc, location)?.via || null,
    strategies,
    replyBox: reply
      ? { found: true, via: reply.via, tag: reply.el.tagName.toLowerCase(), classes: reply.el.className || '(none)' }
      : { found: false },
    noteCandidates: doc.querySelectorAll(SMC_SELECTORS.note).length,
    editableCount: doc.querySelectorAll('[contenteditable="true"], textarea').length,
    headings: [...doc.querySelectorAll('h1, h2')].slice(0, 4).map((h) => h.textContent.trim().slice(0, 90)),
  };
}

const PROFILES = [demoProfile, smcProfile];

/** @returns {typeof demoProfile | null} */
export function selectProfile(location = window.location) {
  return PROFILES.find((profile) => profile.matches(location)) || null;
}

/**
 * The exact nodes this extension last put in the reply box.
 *
 * Held as node references rather than as a marker attribute or a saved HTML
 * string, because both of those go wrong in a contenteditable: browsers rewrite
 * markup as it is edited, and any marker we injected would ride along into the
 * posted reply. Node identity survives both.
 */
let insertedNodes = [];

/** Forget the tracked draft - call when the analyst moves to another ticket. */
export function resetDraftTracking() {
  insertedNodes = [];
}

/**
 * Write a draft into the reply box.
 *
 * Kept here rather than in the panel because it is the one place the extension
 * touches page state, and it should be as easy to audit as the read path. The
 * draft arrives already sanitized by server/sanitize.js against the tag
 * allowlist SMC actually renders.
 *
 * Anything the analyst typed themselves is never touched. On a regenerate we
 * remove only the nodes we added last time and put the new draft in their
 * place - so a second draft replaces the first instead of stacking under it,
 * while half-written analyst text above it survives.
 *
 * @param {HTMLElement} box
 * @param {string} html sanitized draft markup
 * @param {object} [opts]
 * @param {boolean} [opts.replace] drop our previous draft first
 */
export function writeDraft(box, html, { replace = false } = {}) {
  if (!box) throw new Error('Could not find the reply box on this page');

  if (replace) {
    insertedNodes.forEach((node) => node.remove());
    insertedNodes = [];
  }

  // A <template> parses the markup inert - nothing in it can run on the way in.
  const template = document.createElement('template');
  template.innerHTML = html;

  // Only separate from analyst text that is actually there.
  const separator = box.innerHTML.trim()
    ? [document.createElement('br'), document.createElement('br')]
    : [];

  const nodes = [...separator, ...template.content.childNodes];
  nodes.forEach((node) => box.append(node));
  insertedNodes = nodes;

  // Editors backed by a framework model only notice programmatic edits when
  // they see the event a real keystroke would have produced.
  box.dispatchEvent(new Event('input', { bubbles: true }));

  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
