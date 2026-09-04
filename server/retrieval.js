'use strict';

const { KNOWLEDGE_BASE } = require('../data/knowledge-base');
const { eligiblePrecedent } = require('../data/resolved-tickets');

/**
 * Lexical retrieval over the techdocs and the resolved-ticket corpus.
 *
 * Deliberately not embeddings: this is a prototype and TF-IDF style scoring is
 * inspectable, has no external dependency, and is good enough to prove the
 * pipeline shape. The interface (query in, scored+ranked results out) is what a
 * real vector store would drop into.
 */

const STOPWORDS = new Set(
  ('a an and are as at be been but by can cannot could did do does for from get got had has have ' +
   'he her his how i if in into is it its me my no not of on or our out please should so some ' +
   'than that the their them then there these they this to up us was we were what when where ' +
   'which who will with would you your ' +
   // Fragments that fall out of hyphenated tags and carry no topic signal.
   // "sign-off" tokenizes to sign + off, which once let "something feels off"
   // register as a curated tag hit on the migration runbook.
   'off own per via any all one two may see way due yet new old also just still').split(' '),
);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Inverse document frequency across a corpus, so common words carry less weight. */
function buildIdf(docTokenSets) {
  const df = new Map();
  for (const tokens of docTokenSets) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = docTokenSets.length;
  const idf = new Map();
  for (const [term, count] of df) idf.set(term, Math.log(1 + n / (1 + count)) + 1);
  return idf;
}

/**
 * The set of individual terms a tag list contributes.
 *
 * Tags are tokenized rather than compared whole: a multi-word tag like
 * "maintenance window" can never equal a single query token, so comparing the
 * raw strings silently excluded every multi-word tag from the curated boost.
 */
function tagTerms(tags = []) {
  return new Set(tags.flatMap((t) => tokenize(t)));
}

/** How many curated tag terms the query actually hit. */
function countTagHits(queryTokens, tags) {
  const terms = tagTerms(tags);
  let hits = 0;
  for (const term of new Set(queryTokens)) if (terms.has(term)) hits++;
  return hits;
}

function scoreAgainst(queryTokens, docTokens, idf, boostTerms = []) {
  const docSet = new Set(docTokens);
  const boost = tagTerms(boostTerms);
  let score = 0;
  for (const term of new Set(queryTokens)) {
    if (!docSet.has(term)) continue;
    const weight = idf.get(term) || 1;
    // Explicit tags are curated signal - weight a tag hit above a body hit.
    score += boost.has(term) ? weight * 2.5 : weight;
  }
  // Normalize by query length so long tickets don't automatically outscore short ones.
  return queryTokens.length ? score / Math.sqrt(queryTokens.length) : 0;
}

/**
 * Drops trailing weak matches relative to the best one.
 *
 * An absolute floor alone is not enough: on a strongly-matched ticket the
 * runner-up can clear it while being obviously unrelated (a VPN doc surfacing
 * on a migration ticket). Citing that costs more trust than the extra source
 * is worth, so anything far below the leader is cut.
 */
function dropWeakTail(results, ratio = 0.35) {
  if (!results.length) return results;
  const cutoff = results[0].score * ratio;
  return results.filter((r) => r.score >= cutoff);
}

/** Recency decay - a two-year-old resolution is weaker precedent than a recent one. */
function recencyMultiplier(dateStr, asOf) {
  if (!dateStr) return 1;
  const months = (new Date(asOf) - new Date(dateStr)) / (1000 * 60 * 60 * 24 * 30.4);
  if (months <= 3) return 1;
  if (months <= 12) return 0.9;
  if (months <= 24) return 0.75;
  return 0.55;
}

function retrieveDocs(ctx, { limit = 3, asOf = new Date().toISOString() } = {}) {
  const corpus = KNOWLEDGE_BASE.map((d) => tokenize(`${d.title} ${d.body} ${d.tags.join(' ')}`));
  const idf = buildIdf(corpus);
  const q = tokenize(ctx.retrievalText);

  const ranked = KNOWLEDGE_BASE.map((doc, i) => {
    const categoryMatch = doc.category === ctx.category;
    let score = scoreAgainst(q, corpus[i], idf, doc.tags);
    // Category match is a strong structural signal the text alone may miss.
    if (categoryMatch) score *= 1.4;
    score *= recencyMultiplier(doc.updated, asOf);
    return { doc, score, tagHits: countTagHits(q, doc.tags), categoryMatch };
  })
    /*
     * A doc with no tag hit and no category match is matching on ambient
     * English, not on subject matter - techdoc bodies are prose, so any ticket
     * shares words with any doc. On a vague ticket that coincidence is the only
     * thing left to match, which is precisely when a fluent draft is most likely
     * to be confidently wrong. Requiring one curated signal is what keeps an
     * unclassifiable ticket returning nothing, and therefore abstaining.
     */
    .filter((r) => r.tagHits > 0 || r.categoryMatch)
    .filter((r) => r.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return dropWeakTail(ranked);
}

function retrievePrecedent(ctx, { limit = 2, asOf = new Date().toISOString() } = {}) {
  // Outcome filtering happens here: reopened/escalated tickets never become precedent.
  const pool = eligiblePrecedent();
  const corpus = pool.map((t) => tokenize(`${t.subject} ${t.resolutionNote} ${t.tags.join(' ')}`));
  const idf = buildIdf(corpus);
  const q = tokenize(ctx.retrievalText);

  const ranked = pool
    .map((ticket, i) => {
      let score = scoreAgainst(q, corpus[i], idf, ticket.tags);
      if (ticket.problem === ctx.problem) score *= 1.5;
      else if (ticket.category === ctx.category) score *= 1.25;
      score *= recencyMultiplier(ticket.closedAt, asOf);
      return { ticket, score };
    })
    .filter((r) => r.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return dropWeakTail(ranked);
}

/**
 * Confidence is a property of retrieval quality and ticket shape, not of how
 * fluent the generated text sounds. A draft with nothing behind it must be
 * labeled as such rather than presented with the same authority as a grounded one.
 */
function assessConfidence(ctx, docs, precedent) {
  const topScore = docs.length ? docs[0].score : 0;
  const reasons = [];

  if (!docs.length) reasons.push('No techdoc matched this ticket');
  if (!precedent.length) reasons.push('No similar resolved ticket found');
  if (ctx.problem === 'Undetermined' || !ctx.problem) {
    reasons.push('Ticket has no confirmed problem classification');
  }
  if (!ctx.lastClientMessage) reasons.push('No client message to respond to');

  /*
   * Thresholds are calibrated against this corpus and would need re-deriving
   * against real ticket and techdoc volumes - they are not universal constants.
   * They were re-derived once already, when tokenizing multi-word tags for the
   * curated boost raised the whole score scale; the previous values had been
   * set when tags like "maintenance window" silently never matched, and left
   * behind they would have graded almost everything as high.
   */
  let level;
  if (topScore >= 7 && docs.length >= 1 && precedent.length >= 1 && reasons.length === 0) {
    level = 'high';
  } else if (topScore >= 2 && docs.length >= 1) {
    level = 'medium';
  } else {
    level = 'low';
  }

  // A vague, unclassified ticket should never present as confidently grounded.
  if (ctx.problem === 'Undetermined' && level === 'high') level = 'medium';

  return {
    level,
    topScore: Number(topScore.toFixed(2)),
    sourceCount: docs.length + precedent.length,
    reasons,
    // Below this bar the tool declines to draft a substantive answer.
    shouldAbstain: level === 'low',
  };
}

function retrieveAll(ctx, opts = {}) {
  const docs = retrieveDocs(ctx, opts);
  const precedent = retrievePrecedent(ctx, opts);
  return { docs, precedent, confidence: assessConfidence(ctx, docs, precedent) };
}

module.exports = { retrieveAll, retrieveDocs, retrievePrecedent, assessConfidence, tokenize };
