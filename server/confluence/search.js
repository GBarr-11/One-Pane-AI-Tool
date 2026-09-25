'use strict';

/**
 * Ticket context -> the Confluence pages an analyst would have found by
 * searching the wiki themselves.
 *
 * Four steps:
 *   1. pick terms from the ticket (subject and problem first, then the latest
 *      customer message) and run a handful of small CQL queries anchored on
 *      them - see buildQueries() for why not one big one
 *   2. pool the hits and pre-rank them on title and excerpt, which the search
 *      response already carries
 *   3. fetch full bodies and labels for the best few only
 *   4. map each page onto the techdoc shape `retrieval.js` already ranks, so
 *      confidence gating, citations, and the prompt see no difference between
 *      a Confluence page and a mock techdoc
 *
 * Ranking is deliberately NOT left to Confluence. On expedient-cloud its REST
 * search returns hits in no useful relevance order (checked 2026-09-24), and
 * confidence has to be computed the same way for every source or "high
 * confidence" stops meaning anything.
 */

const { confluenceGet, config } = require('./client');
const { tokenize } = require('../retrieval');
const { expandQuery } = require('./expand');

/** Hits kept per CQL query. The response order is not relevance, so cast wide. */
const PER_QUERY_LIMIT = 25;

/** Most CQL queries one lookup may run from the ticket's own words, in parallel. */
const MAX_QUERIES = 7;

/** Extra queries from the query expansion's phrases (expand.js). */
const MAX_PHRASE_QUERIES = 4;

/** Pages whose full bodies are fetched after the title/excerpt pre-rank. */
const FETCH_LIMIT = 8;

/** Subject/problem terms that each anchor a title search. */
const MAX_ANCHORS = 3;

/** Per-page cap on text passed to ranking and to the model. */
const MAX_BODY_CHARS = 6000;

/** Terms considered per lookup. */
const MAX_QUERY_TERMS = 12;

/**
 * A term in more than this share of the searchable pages' titles names a
 * product family or a team ("elastic", "service"), not a topic. It can still
 * be searched for, but a page cannot qualify on it alone - see
 * relevantByTitle(). On expedient-cloud (5,640 pages in TO/PRE/IKB, checked
 * 2026-09-24): "service" is in 119 titles and "elastic" in 137, both broad;
 * "zerto" (79) and "bgp" (7) are not.
 */
const BROAD_TITLE_SHARE = 0.015;

/** Title counts change slowly; a day's cache makes the check free after first use. */
const COUNT_TTL_MS = 24 * 60 * 60 * 1000;
const countCache = new Map();

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
   'request requests requested ' +
   // Our own name, and summary English: the AI summary says "ongoing issues
   // with specific directories", and none of that names a topic.
   'expedient client clients customer customers ongoing currently specific operational ' +
   'assist assistance resolution resolve resolved related regarding provide provided ' +
   'here there available experiencing recommended requesting requested ' +
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
 * Pure numbers, dotted names ("teams.microsoft.com"), and long letter-digit
 * strings (meeting ids, hostnames like "lostorage02") match nothing useful in
 * a wiki. A short one like "eec2" is kept.
 */
const usableTerm = (t) => !TICKET_NOISE.has(t)
  && !/^\d+(\.\d+)*$/.test(t)
  && !(t.includes('.') && /[a-z]/.test(t))
  && !(t.length >= 10 && /\d/.test(t) && /[a-z]/.test(t));

/** URLs, email addresses, and UNC paths are removed before tokenizing. */
const stripLinks = (text) => String(text || '')
  .replace(/\bhttps?:\/\/\S+/gi, ' ')
  .replace(/\bwww\.\S+/gi, ' ')
  .replace(/\S+@\S+\.\S+/g, ' ')
  .replace(/\\\\\S+/g, ' ');

/**
 * Terms from the client's own name. "Tri-State Truck Center" and "InTransit"
 * say who raised the ticket, not what it is about, and would otherwise anchor
 * a title search.
 */
const clientTerms = (ctx) => new Set(tokenize(ctx.client || ''));

/**
 * The terms an analyst chose: subject and problem, and `ctx.searchHint` (the
 * Ask tab's question). These name the product or task, so they anchor the
 * title searches.
 *
 * With a hint the two lists are interleaved, question first. The question says
 * what the analyst wants to know ("upgrade the ZVM"), the subject says which
 * product it is about ("Zerto"), and the search needs both among its anchors.
 */
function anchorSource(ctx) {
  const problem = ctx.problem === 'Undetermined' ? '' : ctx.problem || '';
  const client = clientTerms(ctx);
  const keep = (t) => usableTerm(t) && !client.has(t);
  const subject = tokenize(stripLinks(`${ctx.subject || ''} ${problem}`)).filter(keep);
  const hint = tokenize(stripLinks(ctx.searchHint || '')).filter(keep);

  const out = [];
  for (let i = 0; i < Math.max(subject.length, hint.length); i++) {
    if (i < hint.length) out.push(hint[i]);
    if (i < subject.length) out.push(subject[i]);
  }
  return out;
}

/**
 * Pick the terms worth searching for.
 *
 * Subject, problem, and any search hint go first because an analyst wrote or
 * classified them. Then the AI summary's problem statement, then the
 * customer's latest message, each most repeated terms first. The summary goes
 * before the message because the message is often "hop on this call" plus a
 * link, while the summary says what the call is about.
 */
function queryTerms(ctx) {
  const ordered = [];
  const seen = new Set();
  const client = clientTerms(ctx);
  // One spelling per word: "files" after "file" would dodge file's broad count.
  const variantOf = (t) => ordered.find((o) => o !== t
    && Math.abs(o.length - t.length) <= 2 && (o.startsWith(t) || t.startsWith(o)) && Math.min(o.length, t.length) >= 4);
  const add = (t) => {
    if (!seen.has(t) && usableTerm(t) && !client.has(t) && !variantOf(t)) {
      seen.add(t);
      ordered.push(t);
    }
  };

  const byFrequency = (text) => {
    const counts = new Map();
    for (const t of tokenize(stripLinks(text))) counts.set(t, (counts.get(t) || 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .map(([t]) => t);
  };

  const analyst = anchorSource(ctx);
  const summary = byFrequency(ctx.summaryTopic || '');
  const message = byFrequency(ctx.lastClientMessage ? ctx.lastClientMessage.body : '');

  // Each source gets a share first, so a wordy subject cannot crowd out the
  // summary's "bgp" and "route". Then whatever is left, in the same order.
  const firstPass = [[analyst, 6], [summary, 4], [message, 4]];
  for (const [list, share] of firstPass) {
    let taken = 0;
    for (const t of list) {
      if (taken >= share) break;
      const before = ordered.length;
      add(t);
      if (ordered.length > before) taken++;
    }
  }
  [...analyst, ...summary, ...message].forEach(add);

  return ordered.slice(0, MAX_QUERY_TERMS);
}

/**
 * Anchor terms, the ones each given a title search.
 *
 * Without title counts: the analyst-chosen terms, or the leading terms if
 * there are none. With them (`counts` from titleCounts()), the specific terms
 * some title actually contains win, analyst-chosen ones first. A generic
 * subject ("Service Transition Notification") then gives way to the summary's
 * "bgp" and "meraki". Broad terms anchor only when nothing else can.
 */
function anchorTerms(ctx, terms, counts = null, preferred = []) {
  // The query expansion's terms (expand.js) rank with the analyst's: both name the topic.
  const analyst = [...new Set([...anchorSource(ctx), ...preferred])];
  if (!counts) {
    const anchors = analyst.slice(0, MAX_ANCHORS);
    return anchors.length ? anchors : terms.slice(0, 2);
  }

  const known = (t) => counts.titles.get(t);
  // An unknown count (the count query failed) gets the benefit of the doubt.
  const findable = (t) => known(t) == null || known(t) > 0;
  const specific = (t) => findable(t) && !counts.broad.has(t);

  const pool = [...analyst, ...terms.filter((t) => !analyst.includes(t))];
  const anchors = pool.filter(specific).slice(0, MAX_ANCHORS);
  for (const t of pool) {
    if (anchors.length >= MAX_ANCHORS) break;
    if (!anchors.includes(t) && findable(t)) anchors.push(t);
  }
  return anchors.length ? anchors : terms.slice(0, 2);
}

/**
 * A term as a CQL prefix match. Exact matching is unreliable on this tenant:
 * `title ~ "cohesity"` returns nothing while `title ~ "cohesity*"` returns 35
 * pages titled Cohesity (checked 2026-09-24). The prefix form also catches
 * plurals and "upgrade" -> "upgrades".
 *
 * The term is lightly stemmed first. Confluence indexes word stems, and a
 * prefix longer than the stem matches nothing: `title ~ "monitoring*"` returns
 * no pages although titles say "Monitoring", while `"monitor*"` finds them.
 */
const stem = (term) => {
  const t = String(term);
  const cut = (suffix, keep = '') => (t.endsWith(suffix) && t.length - suffix.length >= 4
    ? t.slice(0, t.length - suffix.length) + keep : null);
  return cut('ing') || cut('ies', 'y') || cut('es') || cut('s') || t;
};
const prefix = (term) => cqlString(`${stem(term)}*`);

/** One CQL query: a clause plus the page type and the configured space/label filters. */
function buildCql(clause) {
  const clauses = ['type = page', clause];

  const spaces = listFromEnv('CONFLUENCE_SPACES');
  if (spaces.length) clauses.push(`space in (${spaces.map(cqlString).join(',')})`);

  const labels = listFromEnv('CONFLUENCE_LABELS');
  if (labels.length) clauses.push(`label in (${labels.map(cqlString).join(',')})`);

  return clauses.join(' AND ');
}

/**
 * The queries for one lookup.
 *
 * Several small queries, not one long one. On this tenant a multi-word
 * `siteSearch` ignores its terms and returns the same fixed list for any
 * query, and a multi-word `text ~` phrase drifts off topic. What finds the
 * right SOP is the product in the title and the task anywhere
 * (`title ~ "zerto*" AND text ~ "upgrade*"`), so:
 *   - each anchor in a title, newest first - the product's own page set
 *   - the lead anchor and the ticket's next term both in a title. That term
 *     may be broad ("upgrade") and so not an anchor itself, but "Zerto" and
 *     "Upgrade" in one title is the upgrade SOP
 *   - the leading anchors in a title with the next term in the body
 *   - two leading terms in the body, for pages whose title doesn't name them
 */
function buildQueries(anchors, terms, phrases = []) {
  const queries = [];
  const add = (clause, newestFirst = false) => {
    const cql = buildCql(clause) + (newestFirst ? ' ORDER BY lastmodified DESC' : '');
    if (!queries.includes(cql)) queries.push(cql);
  };

  for (const a of anchors) add(`title ~ ${prefix(a)}`, true);
  const lead = anchors[0];
  const partner = lead && terms.find((t) => t !== lead);
  if (partner) add(`title ~ ${prefix(lead)} AND title ~ ${prefix(partner)}`);
  for (const a of anchors.slice(0, 2)) {
    const other = terms.find((t) => t !== a);
    if (other) add(`title ~ ${prefix(a)} AND text ~ ${prefix(other)}`);
  }
  if (terms.length >= 2) add(`text ~ ${prefix(terms[0])} AND text ~ ${prefix(terms[1])}`);

  // Expansion phrases as exact phrases: "file integrity monitoring" in a
  // title, then anywhere. Phrases are specific enough that a long `text ~`
  // does not drift the way a pile of ticket words does.
  const base = queries.slice(0, MAX_QUERIES);
  const extra = [];
  for (const phrase of phrases.slice(0, MAX_PHRASE_QUERIES / 2)) {
    for (const field of ['title', 'text']) {
      const cql = buildCql(`${field} ~ ${cqlString(`"${phrase}"`)}`);
      if (!base.includes(cql) && !extra.includes(cql)) extra.push(cql);
    }
  }
  return [...base, ...extra.slice(0, MAX_PHRASE_QUERIES)];
}

/** An SOP-family page is written as procedure; prefer it over a project log. */
const PROCEDURE_TITLE = /^\s*(sop|mop|kb|tsg|pig)\b/i;

/** Pages their authors have marked as not to be followed. */
const RETIRED_TITLE = /\b(deprecated|obsolete|archived?|do not use|wip)\b/i;

/**
 * A title-based multiplier for ranking: procedures up, retired pages well
 * down. Retired pages are not dropped - a deprecated SOP can still be the only
 * page on a topic - but a current one always wins.
 */
function titleWeight(title) {
  const t = String(title || '');
  if (RETIRED_TITLE.test(t)) return 0.4;
  if (PROCEDURE_TITLE.test(t)) return 1.2;
  return 1;
}

/**
 * A page titled with the ticket's own anchors - product and task - beats one
 * that shares only the task: "PIG - Cohesity Mass Restore on AHV" over a KMS
 * server "Backups & Restore" SOP on a Cohesity restore ticket.
 */
function anchorTitleBoost(title, anchors) {
  const tokens = tokenize(title);
  const hits = anchors.filter((a) => termIn(tokens, a)).length;
  return 1 + 0.25 * Math.min(hits, 2);
}

/** Whether a term matches a token, allowing "upgrade" to match "upgrades". */
const termIn = (tokens, term) => tokens.some((tok) => tok === term
  || (term.length >= 4 && tok.startsWith(term))
  || (tok.length >= 4 && term.startsWith(tok)));

/**
 * Cheap pre-rank on what the search response already carries, to choose
 * which pages are worth a full fetch. Title hits count most, anchor terms
 * double, and a page found by several queries gets a point per query.
 */
function prescore(entry, anchors, terms) {
  const title = tokenize(entry.result.title || (entry.result.content && entry.result.content.title));
  const excerpt = tokenize(storageToText(entry.result.excerpt));
  let score = entry.hits;
  for (const t of terms) {
    const weight = anchors.includes(t) ? 2 : 1;
    if (termIn(title, t)) score += 3 * weight;
    else if (termIn(excerpt, t)) score += weight;
  }
  return score * titleWeight(entry.result.title);
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

  // Search titles arrive HTML-escaped ("&quot;"); page titles do not.
  const title = page && page.title ? String(page.title) : storageToText(content.title || result.title) || 'Untitled page';

  return {
    id: space ? `${space}-${id}` : `CF-${id}`,
    title,
    category: (result.resultGlobalContainer && result.resultGlobalContainer.title) || space || 'Confluence',
    updated: String(updated).slice(0, 10),
    tags: labels,
    body: scrubSecrets(text).slice(0, MAX_BODY_CHARS),
    url: webui && siteUrl ? `${siteUrl}/wiki${webui.startsWith('/') ? '' : '/'}${webui}` : null,
    source: 'confluence',
    space,
    // retrieval.js multiplies the score by this: procedures up, retired pages down.
    weight: titleWeight(title),
  };
}

/**
 * How many page titles contain each term, and which terms are broad.
 *
 * One `limit=1` query per term plus one for the page total, in parallel and
 * cached for a day, so after the first lookup this costs nothing. It acts as
 * a wiki-wide IDF. The ranker's own IDF only sees the 8 fetched pages, and
 * when all 8 end in "Service Delivery" that phrase looks rare there.
 *
 * Resolves to `{ titles: Map<term, number|null>, broad: Set<term>, total }`.
 * A count that fails is null (unknown), never an error: specificity only
 * tightens the search, so without it the search behaves as it did before.
 */
async function titleCounts(terms) {
  const count = async (clause) => {
    const cql = buildCql(clause);
    const hit = countCache.get(cql);
    if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.n;
    try {
      const data = await confluenceGet('wiki/rest/api/search', { cql, limit: 1 });
      const n = data && typeof data.totalSize === 'number' ? data.totalSize : null;
      if (n != null) {
        countCache.set(cql, { at: Date.now(), n });
        if (countCache.size > 1000) countCache.delete(countCache.keys().next().value);
      }
      return n;
    } catch {
      return null;
    }
  };

  const [total, ...perTerm] = await Promise.all([
    count('type = page'),
    ...terms.map((t) => count(`title ~ ${prefix(t)}`)),
  ]);

  const titles = new Map(terms.map((t, i) => [t, perTerm[i]]));
  const broad = new Set(total
    ? terms.filter((t) => titles.get(t) != null && titles.get(t) > total * BROAD_TITLE_SHARE)
    : []);
  return { titles, broad, total };
}

/**
 * The first relevance check: whether a page's title or labels carry the
 * ticket's topic.
 *
 * A title is something an author chose, so it is the best cheap evidence of
 * what a page is about. It must contain at least one of the ticket's terms
 * that is not broad. A "Service Delivery" suffix or the word "Elastic" alone
 * does not qualify a page. That is how "SOP - Service Delivery - Deploy vROps
 * Appliance" was cited on a service-transition ticket, and "Understanding
 * Elastic APM" on a file-integrity-monitoring one.
 *
 * @returns {{ ok: boolean, matched: string[], reason: string }}
 */
function relevantByTitle(doc, terms, broad) {
  const tokens = tokenize(`${doc.title} ${(doc.tags || []).join(' ')}`);
  const matched = terms.filter((t) => termIn(tokens, t));
  const specific = matched.filter((t) => !broad.has(t));
  if (specific.length) return { ok: true, matched, reason: '' };
  return {
    ok: false,
    matched,
    reason: matched.length
      ? `title shares only broad terms with the ticket (${matched.join(', ')})`
      : 'title shares no term with the ticket',
  };
}

/** One query. Resolves to its raw hits. */
async function runSearch(cql) {
  const data = await confluenceGet('wiki/rest/api/search', { cql, limit: PER_QUERY_LIMIT });
  return Array.isArray(data && data.results) ? data.results : [];
}

/**
 * Run the queries for a set of terms and pool the hits, best pre-ranked first.
 *
 * Queries run in parallel. One failing is a warning; all failing is an outage
 * and throws, so the caller reports it as one rather than as "no SOP matched".
 */
async function findCandidates(anchors, terms, phrases = []) {
  const queries = buildQueries(anchors, terms, phrases);
  const settled = await Promise.allSettled(queries.map(runSearch));

  const failures = settled.filter((s) => s.status === 'rejected');
  if (failures.length === settled.length) throw failures[0].reason;

  const warnings = failures.map((f) => `One Confluence query failed (${f.reason.message.slice(0, 120)})`);

  const byId = new Map();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const result of s.value) {
      const id = result.content && result.content.id;
      if (!id) continue;
      const entry = byId.get(id) || { result, hits: 0 };
      entry.hits += 1;
      byId.set(id, entry);
    }
  }

  const candidates = [...byId.values()]
    .map((entry) => ({ ...entry, prescore: prescore(entry, anchors, terms) }))
    .sort((a, b) => b.prescore - a.prescore);

  return { queries, candidates, warnings };
}

/**
 * Search Confluence with a plain query the way a ticket lookup would, treating
 * the query as a subject. Used by `/api/confluence/search` for checking
 * results by hand.
 *
 * @param {string} q
 */
async function searchText(q) {
  const ctx = { subject: q };
  const terms = queryTerms(ctx);
  if (!terms.length) return { cql: [], results: [] };
  const counts = await titleCounts(terms);
  const { queries, candidates } = await findCandidates(anchorTerms(ctx, terms, counts), terms);
  return {
    cql: queries,
    broadTerms: [...counts.broad],
    results: candidates.slice(0, 15).map((c) => c.result),
  };
}

/**
 * Candidate techdocs for a ticket.
 *
 * Resolves to `{ docs, query, cql, anchors, broadTerms, expansion, rejected,
 * warnings }`. `cql` is the list of queries run, and `rejected` lists the
 * fetched pages that failed the title check, with the reason. Throws only when
 * every query fails. A page that cannot be fetched degrades to its excerpt and
 * a warning, because one restricted page should not sink the whole lookup.
 *
 * @param {object} ctx  buildContext() output, optionally with `searchHint`
 * @param {object} [opts]
 * @param {Function} [opts.expand]  the provider's plain completion call, for
 *   query expansion (expand.js); without it the search uses the ticket's words
 */
async function searchForContext(ctx, opts = {}) {
  const base = queryTerms(ctx);
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  // Expansion and the base title counts run together; the expanded terms'
  // counts follow, and the base ones come from the cache by then.
  if (opts.expand) report('expand', 'active');
  const [expansion] = await Promise.all([
    opts.expand ? expandQuery(ctx, opts.expand) : null,
    base.length ? titleCounts(base) : null,
  ]);
  if (opts.expand) {
    const n = expansion ? expansion.terms.length + expansion.phrases.length : 0;
    report('expand', expansion ? 'done' : 'skipped', expansion ? `${n} search term${n === 1 ? '' : 's'}` : 'using the ticket\'s own words');
  }
  report('techdocs', 'active');
  const client = new Set(tokenize(ctx.client || ''));
  const extra = expansion
    ? [...expansion.terms, ...expansion.phrases.flatMap((ph) => ph.split(' '))]
      .filter((t) => usableTerm(t) && !client.has(t) && tokenize(t).length === 1)
    : [];
  const terms = [...new Set([...base.slice(0, 6), ...extra, ...base.slice(6)])].slice(0, MAX_QUERY_TERMS + 4);

  if (!terms.length) {
    return {
      docs: [], query: '', cql: [], anchors: [], broadTerms: [], expansion, rejected: [], warnings: ['Ticket has no searchable terms'],
    };
  }

  const counts = await titleCounts(terms);
  const preferred = expansion ? expansion.terms.filter((t) => terms.includes(t)) : [];
  const anchors = anchorTerms(ctx, terms, counts, preferred);
  const { queries, candidates, warnings } = await findCandidates(anchors, terms, expansion ? expansion.phrases : []);
  const chosen = candidates.slice(0, FETCH_LIMIT);

  const pages = await Promise.all(chosen.map(async ({ result }) => {
    try {
      return await fetchPage(result.content.id, result.lastModified);
    } catch (err) {
      warnings.push(`Could not open "${result.title || result.content.id}" (${err.message.slice(0, 120)}) - ranked on its search excerpt`);
      return null;
    }
  }));

  const rejected = [];
  const docs = chosen
    .map(({ result }, i) => toDoc(result, pages[i]))
    .filter((d) => d.body)
    .filter((d) => {
      const check = relevantByTitle(d, terms, counts.broad);
      if (!check.ok) rejected.push({ id: d.id, title: d.title, stage: 'title', reason: check.reason });
      return check.ok;
    })
    .map((d) => ({ ...d, weight: d.weight * anchorTitleBoost(d.title, anchors) }));

  return {
    docs,
    query: terms.join(' '),
    cql: queries,
    anchors,
    broadTerms: [...counts.broad],
    expansion,
    rejected,
    warnings,
  };
}

module.exports = {
  searchForContext, searchText, queryTerms, anchorTerms, buildCql, buildQueries, titleWeight,
  storageToText, scrubSecrets, toDoc, titleCounts, relevantByTitle, stem,
};
