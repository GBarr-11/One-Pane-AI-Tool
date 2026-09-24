'use strict';

/**
 * Ticket context -> the Confluence pages an analyst would have found by
 * searching the wiki themselves.
 *
 * Three steps:
 *   1. build a search from the ticket (subject, problem, latest customer
 *      message) and run it through CQL `siteSearch`, the same engine as the
 *      search box on the site
 *   2. fetch the top hits' full bodies and labels
 *   3. map each page onto the techdoc shape `retrieval.js` already ranks, so
 *      confidence gating, citations, and the prompt see no difference between
 *      a Confluence page and a mock techdoc
 *
 * Ranking is deliberately NOT left to Confluence alone. Its relevance order is
 * a good candidate list, but confidence has to be computed the same way for
 * every source or "high confidence" stops meaning anything.
 */

const { confluenceGet, config } = require('./client');
const { tokenize } = require('../retrieval');

/** Candidates pulled per search. The local ranker keeps at most 3 of these. */
const SEARCH_LIMIT = 8;

/** Per-page cap on text passed to ranking and to the model. */
const MAX_BODY_CHARS = 6000;

/** Search terms per query - more than this and siteSearch gets noisy. */
const MAX_QUERY_TERMS = 10;

/** Page bodies are cached per page version, so a re-draft costs one search. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const pageCache = new Map();

/**
 * Words that appear in almost every support ticket and say nothing about the
 * topic. retrieval.js's stopwords cover English; this covers ticket English.
 */
const TICKET_NOISE = new Set(
  ('thanks thank hello hi team regards ticket issue issues help need needs able unable know let ' +
   'looking look update updates today yesterday morning afternoon week time working work works ' +
   'please asap question questions quick follow following hey appreciate sent send sure think ' +
   'she him they through day days again every since about after before around seems seem').split(' '),
);

/** Space keys and labels go into CQL, so only accept what they can legally be. */
const SAFE_KEY = /^[A-Za-z0-9_~.-]+$/;

const listFromEnv = (name) => String(process.env[name] || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && SAFE_KEY.test(s));

/** Escape a value for a CQL double-quoted string. */
const cqlString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Pick the terms worth searching for.
 *
 * Subject and problem terms go first because an analyst wrote or classified
 * them; the customer's message follows, most repeated terms first. Pure numbers
 * are dropped - ticket ids and timestamps match nothing useful in a wiki.
 */
function queryTerms(ctx) {
  const usable = (t) => !TICKET_NOISE.has(t) && !/^\d+(\.\d+)*$/.test(t);

  const ordered = [];
  const seen = new Set();
  const add = (t) => {
    if (!seen.has(t) && usable(t)) {
      seen.add(t);
      ordered.push(t);
    }
  };

  tokenize(`${ctx.subject || ''} ${ctx.problem === 'Undetermined' ? '' : ctx.problem || ''}`).forEach(add);

  const clientText = ctx.lastClientMessage ? ctx.lastClientMessage.body : '';
  const counts = new Map();
  for (const t of tokenize(clientText)) counts.set(t, (counts.get(t) || 0) + 1);
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .forEach(([t]) => add(t));

  return ordered.slice(0, MAX_QUERY_TERMS);
}

/**
 * Build the CQL. `field` is `siteSearch` (what the site's own search box uses)
 * or `text` (the older full-text field), kept switchable because siteSearch is
 * the newer of the two and a tenant without it answers 400.
 */
function buildCql(terms, field = 'siteSearch') {
  const clauses = ['type = page', `${field} ~ ${cqlString(terms.join(' '))}`];

  const spaces = listFromEnv('CONFLUENCE_SPACES');
  if (spaces.length) clauses.push(`space in (${spaces.map(cqlString).join(',')})`);

  const labels = listFromEnv('CONFLUENCE_LABELS');
  if (labels.length) clauses.push(`label in (${labels.map(cqlString).join(',')})`);

  return clauses.join(' AND ');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', bull: '*',
};

/**
 * Confluence storage format (XHTML plus `ac:`/`ri:` macro markup) -> plain text.
 *
 * Macro parameters are dropped because they are configuration ("maxLevel=3"),
 * not content. Code and panel bodies are kept - in an SOP that is often the
 * actual procedure.
 */
function storageToText(xhtml) {
  return String(xhtml || '')
    .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote|ac:task|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Blank out anything that looks like a credential before the text leaves this
 * server for a model. SOPs do sometimes carry a default password or a service
 * key, and neither belongs in a prompt or, worse, a customer reply.
 */
function scrubSecrets(text) {
  return String(text || '').replace(
    /\b(password|passwd|pwd|passphrase|secret|api[ _-]?key|token|community string)(\s*(?:is|[:=])\s*)\S+/gi,
    '$1$2[REDACTED]',
  );
}

/** `/spaces/SOC` -> `SOC`. */
function spaceKeyOf(result) {
  const display = result.resultGlobalContainer && result.resultGlobalContainer.displayUrl;
  const match = /\/spaces\/([^/?#]+)/.exec(display || result.url || '');
  return match ? decodeURIComponent(match[1]) : '';
}

/** Full body and labels for one hit, from cache when the version is unchanged. */
async function fetchPage(id, lastModified) {
  const key = `${id}@${lastModified || ''}`;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.page;

  const page = await confluenceGet(`wiki/api/v2/pages/${encodeURIComponent(id)}`, {
    'body-format': 'storage',
    'include-labels': 'true',
  });

  pageCache.set(key, { at: Date.now(), page });
  // Bounded: evict the oldest entry rather than grow without limit.
  if (pageCache.size > 200) pageCache.delete(pageCache.keys().next().value);
  return page;
}

/**
 * One search hit (+ its full page, when fetched) -> the techdoc shape.
 *
 * `source` and `space` are extra fields; everything downstream that only knows
 * the mock shape ignores them.
 */
function toDoc(result, page) {
  const { siteUrl } = config();
  const content = result.content || {};
  const id = String(content.id || (page && page.id) || '');
  const webui = (page && page._links && page._links.webui) || (content._links && content._links.webui) || result.url || '';

  const labels = page && page.labels && Array.isArray(page.labels.results)
    ? page.labels.results.map((l) => l.name).filter(Boolean)
    : [];

  const storage = page && page.body && page.body.storage ? page.body.storage.value : '';
  // A page that could not be fetched still has its search excerpt to go on.
  const text = storage ? storageToText(storage) : storageToText(result.excerpt);

  const updated = (page && page.version && page.version.createdAt) || result.lastModified || '';
  const space = spaceKeyOf(result);

  return {
    id: space ? `${space}-${id}` : `CF-${id}`,
    title: String((page && page.title) || content.title || result.title || 'Untitled page'),
    category: (result.resultGlobalContainer && result.resultGlobalContainer.title) || space || 'Confluence',
    updated: String(updated).slice(0, 10),
    tags: labels,
    body: scrubSecrets(text).slice(0, MAX_BODY_CHARS),
    url: webui && siteUrl ? `${siteUrl}/wiki${webui.startsWith('/') ? '' : '/'}${webui}` : null,
    source: 'confluence',
    space,
  };
}

async function runSearch(cql) {
  const data = await confluenceGet('wiki/rest/api/search', { cql, limit: SEARCH_LIMIT });
  return Array.isArray(data && data.results) ? data.results : [];
}

/**
 * Search Confluence with a plain query, exactly as the site search box would.
 * Used by `/api/confluence/search` for checking results by hand.
 *
 * @param {string} q
 */
async function searchText(q) {
  const terms = tokenize(q).slice(0, MAX_QUERY_TERMS);
  if (!terms.length) return { cql: null, results: [] };
  return searchTerms(terms);
}

/** siteSearch first, `text ~` if this tenant does not support siteSearch. */
async function searchTerms(terms) {
  let cql = buildCql(terms, 'siteSearch');
  try {
    return { cql, results: await runSearch(cql) };
  } catch (err) {
    if (!/Confluence 400/.test(err.message)) throw err;
    cql = buildCql(terms, 'text');
    return { cql, results: await runSearch(cql) };
  }
}

/**
 * Candidate techdocs for a ticket.
 *
 * Resolves to `{ docs, query, cql, warnings }`. Throws only when the search
 * itself fails; a page that cannot be fetched degrades to its excerpt and a
 * warning, because one restricted page should not sink the whole lookup.
 *
 * @param {object} ctx  buildContext() output
 */
async function searchForContext(ctx) {
  const terms = queryTerms(ctx);
  const warnings = [];
  if (!terms.length) return { docs: [], query: '', cql: null, warnings: ['Ticket has no searchable terms'] };

  let { cql, results } = await searchTerms(terms);

  // A long query can over-constrain. Retry on the subject alone before giving up.
  if (!results.length) {
    const subjectTerms = queryTerms({ subject: ctx.subject });
    if (subjectTerms.length && subjectTerms.join(' ') !== terms.join(' ')) {
      ({ cql, results } = await searchTerms(subjectTerms));
    }
  }

  const pages = await Promise.all(results.map(async (r) => {
    const id = r.content && r.content.id;
    if (!id) return null;
    try {
      return await fetchPage(id, r.lastModified);
    } catch (err) {
      warnings.push(`Could not open "${r.title || id}" (${err.message.slice(0, 120)}) - ranked on its search excerpt`);
      return null;
    }
  }));

  const docs = results
    .map((r, i) => (r.content && r.content.id ? toDoc(r, pages[i]) : null))
    .filter((d) => d && d.body);

  return { docs, query: terms.join(' '), cql, warnings };
}

module.exports = {
  searchForContext, searchText, queryTerms, buildCql, storageToText, scrubSecrets, toDoc,
};
