'use strict';

/**
 * Fetch one SMC ticket, assembled.
 *
 * A v3 ticket is spread across three reads: the ticket itself, its notes
 * (paginated, on their own endpoint), and its client contacts - which is what
 * makes note authorship resolvable at all. This module is the only place that
 * knows that, so `buildContext()` keeps receiving one object as it always has.
 *
 * Every call here is a GET through `smc/client.js`, which exports no write.
 */

const { smcGet } = require('./client');
const { toTicket } = require('./adapter');

/** SMC's own cap is unknown; 100 keeps the page count low without risking a 422. */
const NOTES_PER_PAGE = 100;

/**
 * Hard ceiling on pages walked.
 *
 * A long-running ticket with hundreds of notes would otherwise turn one draft
 * request into a long serial crawl of a production API. Truncation is reported
 * rather than hidden: a draft written from half a thread is a real correctness
 * problem, and `assessConfidence()` deserves to know.
 */
const MAX_NOTE_PAGES = 10;

/** Unwrap a paginated list response (`Pagination` + `data[]`). */
const pageData = (body) => (body && Array.isArray(body.data) ? body.data : []);

/**
 * Walk the paginated notes endpoint, oldest first.
 *
 * @returns {Promise<{notes: object[], truncated: boolean, total: number|null}>}
 */
async function fetchNotes(ticketId) {
  const notes = [];
  let page = 1;
  let total = null;

  for (; page <= MAX_NOTE_PAGES; page += 1) {
    // No `order_by`: v3 rejects a bare column name ("invalid order token") and
    // its accepted grammar is undocumented. `toTicket()` sorts by timestamp
    // anyway, so ordering here would be a second source of truth regardless.
    const { data } = await smcGet(`tickets/${encodeURIComponent(ticketId)}/notes`, {
      query: { page, per_page: NOTES_PER_PAGE },
    });

    const batch = pageData(data);
    notes.push(...batch);

    if (data && typeof data.total === 'number') total = data.total;

    if (batch.length < NOTES_PER_PAGE) return { notes, truncated: false, total };
    if (total !== null && notes.length >= total) return { notes, truncated: false, total };
  }

  return { notes, truncated: true, total };
}

/**
 * Fetch the ticket's client contacts.
 *
 * Failure here is deliberately not fatal. Without contacts the adapter cannot
 * tell a customer note from an analyst note and degrades every human note to
 * 'system', which makes One Pane decline to draft rather than draft from a
 * misread thread. That is the correct failure direction, but the caller is told
 * so it can say why instead of silently producing a low-confidence result.
 *
 * @returns {Promise<{contacts: object[]|null, error: string|null}>}
 */
async function fetchContacts(ticketId) {
  try {
    const { data } = await smcGet(`tickets/${encodeURIComponent(ticketId)}/contacts`);
    return { contacts: Array.isArray(data) ? data : pageData(data), error: null };
  } catch (err) {
    return { contacts: null, error: err.message };
  }
}

/** Assets are supporting detail; a failure should never cost the draft. */
async function fetchAssets(ticketId) {
  try {
    const { data } = await smcGet(`tickets/${encodeURIComponent(ticketId)}/assets`);
    return Array.isArray(data) ? data : pageData(data);
  } catch {
    return [];
  }
}

/**
 * Fetch and normalize one ticket.
 *
 * @param {string|number} ticketId
 * @returns {Promise<{ticket: object|null, warnings: string[], meta: object}>}
 */
async function fetchTicket(ticketId) {
  const id = String(ticketId);
  const warnings = [];

  const { data: ticketBody } = await smcGet(`tickets/${encodeURIComponent(id)}`);
  const raw = ticketBody && ticketBody.data && !ticketBody.id ? ticketBody.data : ticketBody;

  if (!raw || (!raw.id && !raw.subject)) {
    return { ticket: null, warnings: ['SMC returned no usable ticket record'], meta: { id } };
  }

  const [{ notes, truncated, total }, { contacts, error: contactError }, assets] = await Promise.all([
    fetchNotes(id),
    fetchContacts(id),
    fetchAssets(id),
  ]);

  if (contactError) {
    warnings.push(
      `Could not read client contacts (${contactError}) - note authorship is unresolved, `
        + 'so every note is treated as system and One Pane will not draft from this thread.',
    );
  } else if (Array.isArray(contacts) && contacts.length === 0) {
    // An empty contact list is not evidence that nobody from the client wrote
    // here - it is evidence that we cannot tell. Every human note then reads as
    // 'analyst', which makes `awaitingOurReply` false and stops the draft. That
    // is the safe direction, but it is a judgement the analyst should see
    // rather than a silently low-confidence result.
    warnings.push(
      'Ticket has no client contacts, so no note can be attributed to the customer. '
        + 'Common on monitoring-generated tickets; on a customer-raised ticket it means '
        + 'authorship is unverifiable and the thread should not be drafted from.',
    );
  }

  if (truncated) {
    warnings.push(`Thread truncated at ${notes.length} notes (${MAX_NOTE_PAGES} pages); the draft would miss earlier context.`);
  }

  // The API's own count is the honest check on whether we read the whole thread.
  if (typeof raw.note_count === 'number' && notes.length < raw.note_count && !truncated) {
    warnings.push(`Read ${notes.length} of ${raw.note_count} notes the ticket reports.`);
  }

  return {
    ticket: toTicket(raw, { notes, contacts, assets }),
    warnings,
    meta: {
      id,
      noteCount: notes.length,
      reportedNoteCount: raw.note_count ?? null,
      notesTotal: total,
      contactCount: Array.isArray(contacts) ? contacts.length : null,
      isAwaitingResponse: raw.is_awaiting_response ?? null,
      isEscalated: raw.is_escalated ?? null,
      hasInternalSummary: Boolean(raw.internal_summary),
    },
  };
}

module.exports = { fetchTicket, fetchNotes, fetchContacts };
