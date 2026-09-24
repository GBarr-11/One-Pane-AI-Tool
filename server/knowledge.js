'use strict';

/**
 * Where techdocs come from for a draft.
 *
 * ONEPANE_KB_SOURCE:
 *   auto (default)  Confluence when it is configured; otherwise the dev pack's
 *                   mock corpus if one is installed; otherwise nothing
 *   confluence      Confluence only; unconfigured is reported, not papered over
 *   mock            the dev pack's corpus (onepane-mock only - production has
 *                   no mock corpus, and says so rather than quietly using none)
 *
 * The two are never mixed. The mock techdocs are invented, and citing an
 * invented runbook next to a real SOP on a live ticket would be worse than
 * citing nothing. For the same reason a failed Confluence search does not fall
 * back to the mock corpus: it returns no docs and says why, and the confidence
 * gate does the rest.
 */

const { rankDocs, rankPrecedent, assessConfidence } = require('./retrieval');
const devpack = require('./devpack');
const confluence = require('./confluence/client');
const { searchForContext } = require('./confluence/search');

/** @returns {'confluence'|'mock'|'none'} */
function kbSourceName(override) {
  const requested = String(override || process.env.ONEPANE_KB_SOURCE || 'auto').toLowerCase();
  if (requested === 'mock' || requested === 'confluence') return requested;
  if (confluence.isConfigured()) return 'confluence';
  const pack = devpack.active();
  return pack && pack.techdocs ? 'mock' : 'none';
}

/**
 * Techdocs and precedent for a ticket, used by every pipeline path.
 *
 * Resolves to `{ docs, precedent, confidence, kb }`, where `kb` describes the
 * knowledge-base lookup (source, the query sent, warnings) so the panel and
 * the context endpoint can show what was actually searched.
 *
 * PRECEDENT (similar resolved tickets) comes only from a dev pack, and only
 * for that pack's own tickets. Those resolved tickets are invented: handing
 * them to a live ticket cites a ticket number that does not exist as if it were
 * Expedient history. Real SMC ticket history is a shelved feature - see
 * FUTURE_FEATURES.md - so a live ticket drafts from techdocs and its own
 * thread alone, and confidence is not marked down for the missing source.
 *
 * @param {object} ctx
 * @param {object} [opts]  passed through to ranking; `opts.kbSource` overrides
 *   the env, `opts.ticketOrigin` ('mock' | 'smc' | 'inline') says where the
 *   ticket came from ('mock' means a dev-pack ticket)
 */
async function retrieveKnowledge(ctx, opts = {}) {
  const source = kbSourceName(opts.kbSource);
  const kb = { source, query: null, cql: null, candidates: 0, warnings: [] };

  const pack = devpack.active();
  const isMockTicket = opts.ticketOrigin
    ? opts.ticketOrigin === 'mock'
    : Boolean(devpack.packTicket(ctx.ticketId));
  const precedentAvailable = isMockTicket && Boolean(pack && pack.precedent);
  const precedent = precedentAvailable ? rankPrecedent(pack.precedent(), ctx, opts) : [];

  let docs = [];
  let failure = null;

  if (source === 'none') {
    failure = 'No knowledge base is configured - set CONFLUENCE_SITE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN';
  } else if (source === 'mock') {
    if (pack && pack.techdocs) docs = rankDocs(pack.techdocs, ctx, opts);
    else failure = 'ONEPANE_KB_SOURCE=mock, but the mock corpus only exists in onepane-mock (npm run mock)';
  } else if (!confluence.isConfigured()) {
    failure = 'Confluence is selected but not configured (CONFLUENCE_SITE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN)';
  } else {
    try {
      const found = await searchForContext(ctx);
      kb.query = found.query;
      kb.cql = found.cql;
      kb.candidates = found.docs.length;
      kb.warnings.push(...found.warnings);
      docs = rankDocs(found.docs, ctx, opts);
    } catch (err) {
      failure = `Knowledge base search failed: ${err.message}`;
    }
  }

  const confidence = assessConfidence(ctx, docs, precedent, { precedentAvailable });
  if (failure) {
    kb.warnings.push(failure);
    // The panel shows these reasons - an outage must read as an outage, not
    // as "this ticket has no matching SOP".
    confidence.reasons.unshift(failure);
  }

  return { docs, precedent, confidence, kb };
}

module.exports = { retrieveKnowledge, kbSourceName };
