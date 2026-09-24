// SHELVED - NOT LOADED BY THE APP. Reference copy of the SMC ticket-history
// feature removed on 2026-09-23; see FUTURE_FEATURES.md. Its requires are
// relative to its original location (server/smc/ for history.js, server/ for
// precedent.js) and it will not run from here.
'use strict';

/**
 * Where precedent (similar resolved tickets) comes from for a ticket: the mock
 * corpus or real SMC history.
 *
 * ONEPANE_PRECEDENT_SOURCE:
 *   auto (default)  mock-corpus tickets get mock precedent; every other ticket
 *                   gets SMC history when the SMC API is configured, and none
 *                   when it is not
 *   smc             SMC history only; unconfigured is reported, not papered over
 *   mock            the mock corpus for everything
 *
 * Same rule as knowledge.js for techdocs: the two are never mixed. The mock
 * resolved tickets are invented, and until this module existed a live ticket
 * scraped off the console was handed them as "similar resolved tickets" -
 * citing a ticket number that does not exist, as if it were Expedient history.
 * A failed SMC search likewise returns nothing and says why.
 */

const { retrievePrecedent, rankPrecedent } = require('./retrieval');
const { eligiblePrecedent } = require('../data/resolved-tickets');
const { TICKETS, getTicket } = require('../data/tickets');
const smc = require('./smc/client');
const history = require('./smc/history');
const { ticketUrl } = require('./links');

const SMC_UNCONFIGURED = 'Ticket history search needs the SMC API (SMC_API_BASE_URL, SMC_API_PASS)';

/**
 * @param {string} [override]  opts.precedentSource
 * @param {object} ctx
 * @param {string} [origin]    'mock' | 'smc' | 'inline' - where the ticket came from
 * @returns {'mock'|'smc'|'none'}
 */
function precedentSourceName(override, ctx, origin) {
  const requested = String(override || process.env.ONEPANE_PRECEDENT_SOURCE || 'auto').toLowerCase();
  if (requested === 'mock' || requested === 'smc') return requested;

  const isMockTicket = origin ? origin === 'mock' : Boolean(ctx && getTicket(ctx.ticketId));
  if (isMockTicket) return 'mock';
  return smc.isConfigured() ? 'smc' : 'none';
}

/** Mock tickets carry no match reason, so derive the same labels history.js uses. */
function mockMatchedOn(ctx, t) {
  if (t.problem && t.problem === ctx.problem) return `Same problem: ${t.problem}`;
  if (t.category && t.category === ctx.category) return `Same category: ${t.category}`;
  return 'Similar wording';
}

/**
 * Precedent for a draft.
 *
 * @returns {Promise<{precedent: object[], history: object, failure: string|null}>}
 *   `history` describes the search - source, queries, candidate count,
 *   warnings - so the panel and the context endpoint can show what was looked at.
 */
async function findPrecedentFor(ctx, opts = {}) {
  const source = precedentSourceName(opts.precedentSource, ctx, opts.ticketOrigin);
  const info = {
    source, queries: [], candidates: 0, warnings: [],
  };

  if (source === 'mock') {
    const precedent = retrievePrecedent(ctx, opts)
      .map((r) => ({ ...r, ticket: { ...r.ticket, matchedOn: mockMatchedOn(ctx, r.ticket), sameClient: null } }));
    return { precedent, history: info, failure: null };
  }

  if (source === 'none' || !smc.isConfigured()) {
    info.warnings.push(SMC_UNCONFIGURED);
    return { precedent: [], history: info, failure: SMC_UNCONFIGURED };
  }

  try {
    const found = await history.findPrecedent(ctx, { asOf: opts.asOf });
    info.queries = found.queries;
    info.candidates = found.candidates.length;
    info.warnings.push(...found.warnings);
    return { precedent: found.precedent, history: info, failure: found.failure };
  } catch (err) {
    const failure = `Ticket history search failed: ${err.message}`;
    info.warnings.push(failure);
    return { precedent: [], history: info, failure };
  }
}

/** One row of the "Find similar tickets" list. */
function similarRow({ ticket: t, score }) {
  return {
    id: t.id,
    subject: t.subject,
    client: t.client && t.client !== '—' ? t.client : null,
    sameClient: t.sameClient ?? null,
    problem: t.problem || null,
    closedAt: t.closedAt || null,
    matchedOn: t.matchedOn || null,
    score: Number(score.toFixed(2)),
    url: ticketUrl(t.id),
  };
}

const relatedRow = (r) => ({ ...r, url: ticketUrl(r.id) });

/**
 * A ticket already listed as similar is not listed again as related - SMC
 * often links a ticket to the very precedent that resolved the last one.
 */
const withoutSimilar = (related, similar) => {
  const shown = new Set(similar.map((s) => String(s.id)));
  return related.filter((r) => !shown.has(String(r.id)));
};

/**
 * The Ask tab's "Find similar tickets": similar resolved tickets plus related
 * open ones, each linked to SMC. List data only - see history.findSimilar.
 */
async function findSimilarFor(ctx, opts = {}) {
  const source = precedentSourceName(opts.precedentSource, ctx, opts.ticketOrigin);
  const base = { ticketId: ctx.ticketId, source, warnings: [] };

  if (source === 'mock') {
    const similar = rankPrecedent(eligiblePrecedent(), ctx, { limit: 8, asOf: opts.asOf })
      .map((r) => similarRow({ ...r, ticket: { ...r.ticket, matchedOn: mockMatchedOn(ctx, r.ticket) } }));

    const linked = (ctx.relatedTickets || []).map((r) => ({
      id: String(r.id), subject: r.label || '', status: r.state || '', why: `Linked in SMC${r.state ? ` (${r.state})` : ''}`,
    }));
    const skip = new Set([String(ctx.ticketId), ...linked.map((r) => r.id)]);
    const open = TICKETS
      .filter((t) => t.client === ctx.client && !skip.has(t.id) && !/closed|resolved/i.test(t.status))
      .map((t) => ({ id: t.id, subject: t.subject, status: t.status, why: 'Open for the same client' }));

    return { ...base, similar, related: withoutSimilar([...linked, ...open], similar).map(relatedRow) };
  }

  if (source === 'none' || !smc.isConfigured()) {
    const related = (ctx.relatedTickets || []).map((r) => relatedRow({
      id: String(r.id), subject: r.label || '', status: r.state || '', why: 'Linked in SMC',
    }));
    return {
      ...base, similar: [], related, warnings: [SMC_UNCONFIGURED],
    };
  }

  try {
    const found = await history.findSimilar(ctx, { asOf: opts.asOf });
    const similar = found.similar.map(similarRow);
    return {
      ...base,
      similar,
      related: withoutSimilar(found.related, similar).map(relatedRow),
      queries: found.queries,
      warnings: found.warnings,
    };
  } catch (err) {
    return {
      ...base, similar: [], related: [], warnings: [`Ticket history search failed: ${err.message}`],
    };
  }
}

module.exports = { findPrecedentFor, findSimilarFor, precedentSourceName };
