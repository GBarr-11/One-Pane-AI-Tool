'use strict';

/**
 * Turns a raw SMC ticket into a normalized context object.
 *
 * Everything downstream (retrieval, generation) consumes this shape and never
 * the raw ticket, so swapping the mock data source for the real SMC API - or
 * for DOM extraction - only requires a new adapter that emits this shape.
 */

/** Notes the customer can see, oldest first. */
function customerVisibleNotes(ticket) {
  return ticket.notes.filter((n) => n.role === 'client' || n.role === 'analyst');
}

/** The most recent message from the customer, if any. */
function lastClientMessage(ticket) {
  const clientNotes = ticket.notes.filter((n) => n.role === 'client');
  return clientNotes.length ? clientNotes[clientNotes.length - 1] : null;
}

/**
 * Who to open the reply to.
 *
 * `ticket.clientContact` is SMC's notion of the primary contact (its own
 * default/order ranking) - it is not evidence that person has said anything
 * on this ticket. Addressing them by name anyway is a guess dressed up as
 * knowledge, so it is used only as a last resort. The client who has actually
 * posted here, if any, is a real signal and takes priority; otherwise this
 * falls back to the company name rather than naming an unconfirmed contact.
 */
function greetingName(ticket, lastClient) {
  if (lastClient && lastClient.author && lastClient.author.trim() && lastClient.author !== 'Unknown') {
    return lastClient.author.trim().split(/\s+/)[0];
  }
  return ticket.client ? `${ticket.client} team` : 'there';
}

/** The most recent note of any kind that a human wrote. */
function lastHumanNote(ticket) {
  const human = ticket.notes.filter((n) => n.role === 'client' || n.role === 'analyst');
  return human.length ? human[human.length - 1] : null;
}

/** The existing AI summarization tool's most recent note, if present. */
function latestAiSummary(ticket) {
  const ai = ticket.notes.filter((n) => n.role === 'ai');
  return ai.length ? ai[ai.length - 1] : null;
}

/**
 * What the ticket is about, per the existing AI summary: its "Problem Summary"
 * and "Technical Details" sections, as plain text.
 *
 * On a long ticket this is often the only place the topic is written down.
 * The subject can be generic ("Service Transition Notification") and the
 * latest customer message can be a meeting link, while the summary names the
 * BGP default route and the Meraki devices. It is a search source only. It is
 * model-written, so it never overrides the thread as a record of facts.
 */
function summaryTopic(aiSummary) {
  if (!aiSummary) return '';
  const text = String(aiSummary).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  const sections = [];
  for (const label of ['Problem Summary', 'Technical Details']) {
    const m = new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*[A-Z][A-Za-z &]+:|$)`).exec(text);
    if (m) sections.push(m[1].trim());
  }
  return sections.join('\n');
}

function daysBetween(a, b) {
  return Math.floor(Math.abs(new Date(a) - new Date(b)) / 86400000);
}

/**
 * The existing summarizer runs on a schedule and its sentiment read can go
 * stale - it keeps asserting "Concerned" long after the client went quiet.
 * We surface that as a caveat rather than silently inheriting it.
 */
function assessSummaryStaleness(ticket, aiSummary, lastClient, asOf) {
  if (!aiSummary || !lastClient) return null;

  const match = /Client Sentiment:\s*([A-Za-z]+)/.exec(aiSummary.body);
  const claimedSentiment = match ? match[1] : null;
  if (!claimedSentiment) return null;

  const daysSinceClient = daysBetween(asOf, lastClient.at);
  const negative = ['concerned', 'frustrated', 'anxious', 'upset', 'angry'];

  if (negative.includes(claimedSentiment.toLowerCase()) && daysSinceClient >= 5) {
    return {
      type: 'stale_sentiment',
      claimedSentiment,
      daysSinceClientMessage: daysSinceClient,
      message:
        `The AI summary lists sentiment as "${claimedSentiment}," but the client has not replied in ` +
        `${daysSinceClient} days — this reads as awaiting confirmation rather than active distress. ` +
        `Drafted accordingly.`,
    };
  }
  return null;
}

/**
 * @param {object} ticket raw SMC ticket
 * @param {object} [opts]
 * @param {string} [opts.asOf] ISO date to evaluate recency against (test seam)
 */
function buildContext(ticket, opts = {}) {
  const asOf = opts.asOf || new Date().toISOString();
  const lastClient = lastClientMessage(ticket);
  const lastHuman = lastHumanNote(ticket);
  const aiSummary = latestAiSummary(ticket);

  return {
    ticketId: ticket.id,
    subject: ticket.subject,
    client: ticket.client,
    contact: ticket.clientContact,
    greetingName: greetingName(ticket, lastClient),
    status: ticket.status,
    severity: ticket.severity,
    category: ticket.category,
    problem: ticket.problem,
    // SMC ids, when the ticket came from the API; null for a page scrape.
    clientId: ticket.clientId ?? null,
    categoryId: ticket.categoryId ?? null,
    problemId: ticket.problemId ?? null,
    type: ticket.type,
    queue: ticket.queue,
    assignedTo: ticket.assignedTo,
    services: ticket.services,
    assets: ticket.assets,
    facility: ticket.facility,
    relatedTickets: ticket.relatedTickets,

    noteCount: ticket.notes.length,
    // Internal notes are in here too: the prompt labels them (thread.js) so
    // their facts can inform a reply without being quoted to the customer.
    thread: customerVisibleNotes(ticket).map((n) => ({
      author: n.author,
      role: n.role,
      at: n.at,
      visibility: n.visibility || 'All',
      body: n.body,
    })),

    lastClientMessage: lastClient,
    lastHumanNote: lastHuman,
    // True when the ball is in our court - the customer spoke last.
    awaitingOurReply: !!(lastHuman && lastHuman.role === 'client'),
    daysSinceClientMessage: lastClient ? daysBetween(asOf, lastClient.at) : null,

    aiSummary: aiSummary ? aiSummary.body : null,
    summaryCaveat: assessSummaryStaleness(ticket, aiSummary, lastClient, asOf),
    summaryTopic: summaryTopic(aiSummary && aiSummary.body),

    /** Free-text blob used as the retrieval query. */
    retrievalText: [
      ticket.subject,
      ticket.category,
      ticket.problem,
      summaryTopic(aiSummary && aiSummary.body),
      lastClient ? lastClient.body : '',
      customerVisibleNotes(ticket).slice(-3).map((n) => n.body).join(' '),
    ].join(' '),
  };
}

module.exports = { buildContext, lastClientMessage, latestAiSummary, summaryTopic };
