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

const { rankDocs, assessConfidence } = require('./retrieval');
const { findPrecedentFor } = require('./precedent');
const devpack = require('./devpack');
const confluence = require('./confluence/client');
const { searchForContext } = require('./confluence/search');
const { checkRelevance, MAX_CANDIDATES } = require('./relevance');
const { applyFeedback } = require('./feedback');
const { threadEvidence } = require('./thread');

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
 * Resolves to `{ docs, precedent, linked, confidence, kb, history }`, where
 * `kb` describes the knowledge-base lookup (source, the query sent, warnings)
 * and `history` the ticket-history lookup, so the panel and the context
 * endpoint can show what was actually searched.
 *
 * PRECEDENT (precedent.js) is a dev pack's invented resolved tickets for that
 * pack's own tickets, and real SMC history for every other ticket: tickets SMC
 * links to this one, and similar resolved tickets. The two are never mixed.
 * The SMC search runs alongside the Confluence search, not after it.
 * `opts.history === false` skips it (suggestions, which need no SMC traffic).
 *
 * TECHDOCS pass two relevance checks before anything sees them. The Confluence
 * search drops pages whose title shares only broad terms with the ticket
 * (search.js). Then, when the caller passes `opts.judge`, a model reads the
 * ticket and the top candidates and hides the unrelated ones (relevance.js).
 * Everything dropped is listed in `kb.rejected`, with the reason.
 *
 * @param {object} ctx
 * @param {object} [opts]  passed through to ranking; `opts.kbSource` overrides
 *   the env, `opts.ticketOrigin` ('mock' | 'smc' | 'inline') says where the
 *   ticket came from ('mock' means a dev-pack ticket). `opts.judge` and
 *   `opts.expand` are the provider's plain completion call, for the relevance
 *   check and for query expansion (confluence/expand.js)
 *
 * Analyst votes (feedback.js) apply between ranking and the judge: a page the
 * analysts turned down is not sent to the judge at all.
 */
async function retrieveKnowledge(ctx, opts = {}) {
  const source = kbSourceName(opts.kbSource);
  const kb = {
    source, query: null, cql: null, candidates: 0, rejected: [], relevance: { checked: false }, gap: false, warnings: [],
  };

  const pack = devpack.active();
  const isMockTicket = opts.ticketOrigin
    ? opts.ticketOrigin === 'mock'
    : Boolean(devpack.packTicket(ctx.ticketId));
  // Started now, awaited after the techdocs: the two searches hit different
  // services and neither needs the other.
  const precedentLookup = findPrecedentFor(ctx, {
    ...opts,
    isMockTicket,
    precedentSource: opts.history === false ? 'off' : opts.precedentSource,
  });

  // Stage updates for the panel (progress.js). Counts only, never content.
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  let docs = [];
  let failure = null;
  // With a judge, rank a few more than will be shown, so it has a choice.
  const limit = opts.limit || 3;
  const rankOpts = { ...opts, limit: opts.judge ? Math.max(limit, MAX_CANDIDATES) : limit };

  if (source === 'none') {
    failure = 'No knowledge base is configured - set CONFLUENCE_SITE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN';
  } else if (source === 'mock') {
    report('techdocs', 'active', 'demo corpus');
    if (pack && pack.techdocs) docs = rankDocs(pack.techdocs, ctx, rankOpts);
    else failure = 'ONEPANE_KB_SOURCE=mock, but the mock corpus only exists in onepane-mock (npm run mock)';
  } else if (!confluence.isConfigured()) {
    failure = 'Confluence is selected but not configured (CONFLUENCE_SITE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN)';
  } else {
    try {
      const found = await searchForContext(ctx, { expand: opts.expand, onProgress: report });
      kb.query = found.query;
      kb.cql = found.cql;
      kb.candidates = found.docs.length;
      kb.anchors = found.anchors;
      kb.broadTerms = found.broadTerms;
      kb.expansion = found.expansion || null;
      kb.rejected.push(...(found.rejected || []));
      kb.warnings.push(...found.warnings);
      docs = rankDocs(found.docs, ctx, rankOpts);
    } catch (err) {
      failure = `Knowledge base search failed: ${err.message}`;
    }
  }
  if (source === 'none' || (source === 'confluence' && !confluence.isConfigured())) report('techdocs', 'skipped', 'not configured');
  else if (failure) report('techdocs', 'error', 'search failed');
  else report('techdocs', 'done', docs.length ? `${docs.length} candidate page${docs.length === 1 ? '' : 's'}` : 'no matching pages');

  if (docs.length) {
    const voted = applyFeedback(ctx, docs);
    docs = voted.docs;
    kb.rejected.push(...voted.rejected);
  }

  if (opts.judge && docs.length) {
    report('relevance', 'active', `${Math.min(docs.length, MAX_CANDIDATES)} to check`);
    const checked = await checkRelevance(ctx, docs, opts.judge);
    docs = checked.docs;
    kb.rejected.push(...checked.rejected);
    kb.relevance = checked.summary;
    if (checked.summary.error) {
      kb.warnings.push(`Relevance check unavailable (${checked.summary.error}) - sources are unverified`);
      report('relevance', 'error', 'unavailable - sources unverified');
    } else {
      const kept = Math.min(docs.length, limit);
      report('relevance', 'done', kept || checked.rejected.length
        ? [kept && `${kept} kept`, checked.rejected.length && `${checked.rejected.length} hidden`].filter(Boolean).join(' · ')
        : 'none apply');
    }
  }
  docs = docs.slice(0, limit);
  // Nothing on the wiki covers this ticket. That is the signal a knowledge-gap
  // queue would collect (FUTURE_FEATURES.md); an outage is not a gap.
  kb.gap = !failure && !docs.length;

  const {
    precedent, linked, precedentAvailable, match, history,
  } = await precedentLookup;

  const confidence = assessConfidence(ctx, docs, precedent, {
    precedentAvailable,
    relevance: kb.relevance,
    thread: threadEvidence(ctx),
    precedentMatch: match ? { verdict: match, ticketId: precedent[0].ticket.id } : null,
  });
  if (kb.gap && kb.rejected.length) {
    const n = kb.rejected.length;
    confidence.reasons.push(`${n} candidate SOP${n === 1 ? ' was' : 's were'} checked and judged not relevant`);
  }
  if (failure) {
    kb.warnings.push(failure);
    // The panel shows these reasons - an outage must read as an outage, not
    // as "this ticket has no matching SOP".
    confidence.reasons.unshift(failure);
  }

  return {
    docs, precedent, linked, confidence, kb, history,
  };
}

module.exports = { retrieveKnowledge, kbSourceName };
