// SHELVED - NOT LOADED BY THE APP. Reference copy of the SMC ticket-history
// feature removed on 2026-09-23; see FUTURE_FEATURES.md. Its requires are
// relative to its original location (server/smc/ for history.js, server/ for
// precedent.js) and it will not run from here.
'use strict';

/**
 * Real SMC ticket history: find closed tickets like this one, and read how
 * they were resolved.
 *
 * This is what makes "similar resolved tickets" mean Expedient's actual
 * history instead of the hand-written mock corpus. Every call is a GET through
 * `smc/client.js`, which exports no write.
 *
 * Query shape is taken from the v3 spec (docs/smc-api/openapi-v3.json):
 * `GET /tickets?filters=...&order_by=...&per_page=...`, where `filters` is
 * `field op value` clauses joined by commas (AND) - e.g.
 * `problem.id eq 12, closed_at gte '2025-03-01'`. Which fields are filterable
 * is not in the spec; it is served live at `GET /tickets/filters`, so this
 * module asks once and builds only clauses the API says it accepts.
 *
 * WHAT COUNTS AS PRECEDENT
 *   Successful:  closed, never reopened, never escalated. (Grant, 2026-09-23 -
 *                provisional until a CSAT-style signal exists; note-level
 *                `helpful_count` votes are the likely candidate.)
 *   Matching:    the SAME PROBLEM as this ticket, from any client - repeatable
 *                tickets are handled the same way whoever raised them - or,
 *                when the problem is unclassified, the same client AND the same
 *                category. A different client with only a similar category is
 *                not close enough to steer a reply.
 *
 * Other clients' tickets are not redacted: the analyst can open every one of
 * them in SMC anyway, and each is labelled with its client so it is plain the
 * precedent came from a separate case. The prompt, not redaction, is what stops
 * another client's names or hosts from being copied into this reply.
 */

const { smcGet } = require('./client');
const { fetchTicket, pageData } = require('./tickets');
const { nameOf, idOf, str } = require('./adapter');
const { rankPrecedent } = require('../retrieval');
const { toPlainText } = require('../sanitize');

const POOL_TTL_MS = 10 * 60 * 1000;
const DETAIL_TTL_MS = 60 * 60 * 1000;

/** Detail fetches are ~4 GETs each; keep a draft from fanning out across the API. */
const DETAIL_CONCURRENCY = 2;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function config() {
  return {
    months: clamp(Number(process.env.SMC_HISTORY_MONTHS) || 18, 1, 120),
    poolSize: clamp(Number(process.env.SMC_HISTORY_POOL) || 200, 10, 1000),
    detailCount: clamp(Number(process.env.SMC_HISTORY_DETAIL ?? 4), 0, 8),
  };
}

const poolCache = new Map();
const detailCache = new Map();
let filterFieldsPromise = null;

/** Test seam: forget everything cached. */
function resetCaches() {
  poolCache.clear();
  detailCache.clear();
  filterFieldsPromise = null;
}

function cached(map, key, ttl, load) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = load();
  map.set(key, { at: Date.now(), value });
  // A failed load must not be cached as if it were an answer.
  Promise.resolve(value).catch(() => map.delete(key));
  return value;
}

/* ---------------- matching rules ---------------- */

const norm = (s) => String(s || '').trim().toLowerCase();
const sameName = (a, b) => Boolean(norm(a)) && norm(a) === norm(b);

/** A problem classification that actually says what the problem is. */
function problemKnown(ctx) {
  return Boolean(norm(ctx.problem)) && !/^(undetermined|unknown|other|none|n\/?a|-+|—)$/.test(norm(ctx.problem));
}

function sameClient(ctx, c) {
  if (ctx.clientId != null && c.clientId != null) return Number(ctx.clientId) === Number(c.clientId);
  return sameName(ctx.client, c.client);
}

/**
 * Why this candidate may shape this ticket's reply, or null if it may not.
 * See WHAT COUNTS AS PRECEDENT above.
 */
function matchScope(ctx, c) {
  if (String(c.id) === String(ctx.ticketId)) return null;
  const client = sameClient(ctx, c);

  const problemMatch = problemKnown(ctx) && (
    (ctx.problemId != null && c.problemId != null)
      ? Number(ctx.problemId) === Number(c.problemId)
      : sameName(ctx.problem, c.problem));
  if (problemMatch) return { sameClient: client, matchedOn: `Same problem: ${c.problem || ctx.problem}` };

  const categoryMatch = (ctx.categoryId != null && c.categoryId != null)
    ? Number(ctx.categoryId) === Number(c.categoryId)
    : sameName(ctx.category, c.category);
  if (client && categoryMatch) return { sameClient: true, matchedOn: `Same client and category: ${c.category || ctx.category}` };

  return null;
}

/** Closed, never reopened, never escalated - and not closed as noise. */
function isSuccessful(c) {
  if (!c.closedAt) return false;
  if (c.reopened || c.escalated) return false;
  return !/cancel|duplicate|merged|void|spam/i.test(c.status);
}

/** A `TicketResponse` from a list read -> the precedent shape retrieval ranks. */
function toCandidate(raw) {
  const problem = nameOf(raw.problem);
  const subProblem = nameOf(raw.sub_problem);
  const category = nameOf(raw.category);
  return {
    id: str(raw.id),
    subject: str(raw.subject),
    client: nameOf(raw.client),
    clientId: idOf(raw.client),
    problem,
    problemId: idOf(raw.problem),
    subProblem,
    category,
    categoryId: idOf(raw.category),
    status: str(raw.status),
    closedAt: str(raw.closed_at).slice(0, 10),
    reopened: Boolean(raw.reopened_at || raw.reopened_by),
    escalated: raw.is_escalated === true,
    rootCause: clip(toPlainText(str(raw.root_cause)), 400),
    summary: clip(toPlainText(str(raw.internal_summary)), 700),
    // Until notes are read, the opening text is the best description of the case.
    resolutionNote: clip(toPlainText(str(raw.body)), 600),
    workNotes: '',
    tags: [problem, subProblem, category].filter(Boolean),
    detailed: false,
  };
}

function clip(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/* ---------------- SMC queries ---------------- */

/**
 * Filterable ticket fields, from `GET /tickets/filters`, or null if unknown.
 * Items are `"<field>: <type>"` strings (or objects keyed by field name).
 */
function discoverFilterFields() {
  if (!filterFieldsPromise) {
    filterFieldsPromise = smcGet('tickets/filters')
      .then(({ data }) => {
        const fields = new Set();
        for (const item of pageData(data)) {
          if (typeof item === 'string') fields.add(item.split(':')[0].trim());
          else if (item && typeof item === 'object') Object.keys(item).forEach((k) => fields.add(k));
        }
        return fields.size ? fields : null;
      })
      .catch(() => null);
  }
  return filterFieldsPromise;
}

/** First candidate the API accepts; the first outright when acceptance is unknown. */
function pickField(fields, candidates) {
  if (!fields) return candidates[0];
  return candidates.find((c) => fields.has(c)) || null;
}

/**
 * A value safe to put inside a filter clause.
 *
 * Problem and client names come from a page scrape as easily as from the API.
 * A quote would end the value early, and a comma would start a new clause - so
 * a problem named `x', client.id gte '0` could widen the search to every
 * client. Both are removed rather than escaped; the grammar's escaping is
 * undocumented.
 */
function filterValue(value) {
  return String(value || '').replace(/['",]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clause(fields, idCandidates, nameCandidates, id, name) {
  if (id != null) {
    const f = pickField(fields, idCandidates);
    if (f) return `${f} eq ${Number(id)}`;
  }
  const value = filterValue(name);
  if (value) {
    const f = pickField(fields, nameCandidates);
    if (f) return `${f} eq '${value}'`;
  }
  return null;
}

function sinceDate(asOf, months) {
  const d = new Date(asOf || Date.now());
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * The list queries that could hold precedent for this ticket, per the matching
 * rules: one by problem (any client), one by client + category. The client-side
 * filters below re-check everything, so a clause the API ignores costs only
 * efficiency, never correctness.
 */
async function buildQueries(ctx, { asOf } = {}) {
  const { months } = config();
  const fields = await discoverFilterFields();

  const common = [];
  const closed = pickField(fields, ['closed_at']);
  if (closed) common.push(`${closed} gte '${sinceDate(asOf, months)}'`);
  const escalated = pickField(fields, ['is_escalated']);
  if (escalated) common.push(`${escalated} eq 0`);

  const queries = [];

  if (problemKnown(ctx)) {
    const p = clause(fields, ['problem.id', 'problem_id'], ['problem.name'], ctx.problemId, ctx.problem);
    if (p) queries.push({ scope: 'problem', filters: [p, ...common].join(', ') });
  }

  const client = clause(fields, ['client.id', 'client_id'], ['client.name'], ctx.clientId, ctx.client);
  const category = clause(fields, ['category.id', 'category_id'], ['category.name'], ctx.categoryId, ctx.category);
  if (client && category) queries.push({ scope: 'client', filters: [client, category, ...common].join(', ') });

  return { queries, fields };
}

/**
 * One page of `GET /tickets`, most recently closed first.
 *
 * If SMC rejects the sort, retry once without it rather than lose the search:
 * v3 has rejected an `order_by` token before (see smc/tickets.js).
 */
function listTickets(filters, { orderBy = 'closed_at desc', perPage } = {}) {
  const per_page = perPage || config().poolSize;
  const key = `${filters}|${orderBy}|${per_page}`;
  return cached(poolCache, key, POOL_TTL_MS, async () => {
    const query = { filters, per_page, page: 1 };
    try {
      const { data } = await smcGet('tickets', { query: { ...query, order_by: orderBy } });
      return pageData(data);
    } catch (err) {
      if (!/SMC 4\d\d/.test(err.message)) throw err;
      const { data } = await smcGet('tickets', { query });
      return pageData(data);
    }
  });
}

/**
 * Read one candidate's thread for how it was actually resolved.
 *
 * Customer-facing replies say how we communicated the fix; internal notes say
 * what was done. Both are kept, separately labelled, because the prompt treats
 * them differently: the second is process to follow, never text to copy.
 */
function loadDetail(candidate) {
  return cached(detailCache, candidate.id, DETAIL_TTL_MS, async () => {
    const { ticket, raw } = await fetchTicket(candidate.id, { related: false });
    if (!ticket) return candidate;

    const isInternal = (n) => /internal|private|secure/i.test(n.visibility);
    const substantive = (n) => n.body && n.body.trim().length > 30;
    const notes = ticket.notes.filter((n) => n.role !== 'ai' && n.role !== 'client' && substantive(n));

    let replies = notes.filter((n) => n.role === 'analyst' && !isInternal(n));
    // Without contacts every human note is 'system' (see adapter.classifyRole);
    // customer-visible ones are still the best record of the reply we sent.
    if (!replies.length) replies = notes.filter((n) => !isInternal(n));
    const internal = notes.filter(isInternal);

    const joinLast = (list, n, max) => clip(list.slice(-n).map((x) => toPlainText(x.body)).join(' … '), max);

    return {
      ...candidate,
      ...(raw ? {
        summary: clip(toPlainText(str(raw.internal_summary)), 700) || candidate.summary,
        rootCause: clip(toPlainText(str(raw.root_cause)), 400) || candidate.rootCause,
      } : {}),
      resolutionNote: joinLast(replies, 3, 1500) || candidate.resolutionNote,
      workNotes: joinLast(internal, 3, 900),
      detailed: true,
    };
  });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Every closed ticket that qualifies as precedent for this one, un-ranked.
 *
 * @returns {Promise<{candidates: object[], warnings: string[], queries: string[], failure: string|null}>}
 */
async function gatherCandidates(ctx, opts = {}) {
  const { queries } = await buildQueries(ctx, opts);
  const warnings = [];

  if (!queries.length) {
    return {
      candidates: [],
      warnings: ['Ticket history not searched: no confirmed problem, and no client + category to search by'],
      queries: [],
      failure: null,
    };
  }

  const results = await Promise.allSettled(queries.map((q) => listTickets(q.filters)));
  const failed = results.filter((r) => r.status === 'rejected');
  for (const r of failed) warnings.push(`Ticket history search failed: ${r.reason.message}`);

  const seen = new Set();
  const candidates = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const raw of r.value) {
      const c = toCandidate(raw);
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      if (!isSuccessful(c)) continue;
      const scope = matchScope(ctx, c);
      if (!scope) continue;
      candidates.push({ ...c, ...scope });
    }
  }

  return {
    candidates,
    warnings,
    queries: queries.map((q) => q.filters),
    failure: failed.length === results.length ? warnings[0] : null,
  };
}

/**
 * Precedent for a draft: the best few matches, with their threads read.
 *
 * @param {object} ctx  buildContext() output
 * @param {object} [opts]
 * @param {number} [opts.limit]  how many to hand the model (default 3)
 * @param {string} [opts.asOf]
 */
async function findPrecedent(ctx, opts = {}) {
  const limit = opts.limit || 3;
  const { detailCount } = config();
  const gathered = await gatherCandidates(ctx, opts);
  if (!gathered.candidates.length) return { ...gathered, precedent: [] };

  // Rank cheaply on list data, read threads only for the leaders, then rank again.
  const leaders = rankPrecedent(gathered.candidates, ctx, { limit: Math.max(detailCount, limit), asOf: opts.asOf });
  const detailed = await mapLimit(leaders, DETAIL_CONCURRENCY, async ({ ticket }, i) => {
    if (i >= detailCount) return ticket;
    try {
      return await loadDetail(ticket);
    } catch (err) {
      gathered.warnings.push(`Could not read #${ticket.id}'s thread (${err.message}); used its summary only`);
      return ticket;
    }
  });

  return {
    ...gathered,
    precedent: rankPrecedent(detailed, ctx, { limit, asOf: opts.asOf }),
  };
}

/**
 * The "Find similar tickets" list: more matches, list data only, no thread
 * reads - it has to come back fast, and the analyst opens the ones they want.
 * Plus tickets SMC links to this one, and other open tickets for this client.
 */
async function findSimilar(ctx, opts = {}) {
  const limit = opts.limit || 8;
  const gathered = await gatherCandidates(ctx, opts);
  const similar = gathered.candidates.length
    ? rankPrecedent(gathered.candidates, ctx, { limit, asOf: opts.asOf })
    : [];

  const related = (ctx.relatedTickets || []).map((r) => ({
    id: String(r.id), subject: r.label || '', status: r.state || '', why: `Linked in SMC${r.state ? ` (${r.state})` : ''}`,
  }));

  try {
    related.push(...await openForClient(ctx, related));
  } catch (err) {
    gathered.warnings.push(`Could not list this client's open tickets: ${err.message}`);
  }

  return { ...gathered, similar, related };
}

/** Open tickets for the same client that share subject matter with this one. */
async function openForClient(ctx, already) {
  const fields = await discoverFilterFields();
  const client = clause(fields, ['client.id', 'client_id'], ['client.name'], ctx.clientId, ctx.client);
  if (!client) return [];

  const rows = await listTickets(client, { orderBy: 'updated_at desc', perPage: 100 });
  const skip = new Set([String(ctx.ticketId), ...already.map((r) => r.id)]);
  const open = rows.map(toCandidate).filter((c) => !c.closedAt && !skip.has(c.id) && sameClient(ctx, c));

  return rankPrecedent(open, ctx, { limit: 5 }).map(({ ticket: c }) => ({
    id: c.id, subject: c.subject, status: c.status, why: 'Open for the same client',
  }));
}

/**
 * Diagnostics: what the history search would send, and what came back -
 * counts, statuses, and field names only, never ticket content.
 */
async function probe(ctx, opts = {}) {
  const { queries, fields } = await buildQueries(ctx, opts);
  const results = [];
  for (const q of queries) {
    try {
      const rows = await listTickets(q.filters);
      const candidates = rows.map(toCandidate);
      results.push({
        scope: q.scope,
        filters: q.filters,
        returned: rows.length,
        successful: candidates.filter(isSuccessful).length,
        eligible: candidates.filter((c) => isSuccessful(c) && matchScope(ctx, c)).length,
        statuses: [...new Set(candidates.map((c) => c.status))],
        fieldsOnFirstRow: rows[0] ? Object.keys(rows[0]) : [],
      });
    } catch (err) {
      results.push({ scope: q.scope, filters: q.filters, error: err.message });
    }
  }
  return { filterFields: fields ? [...fields].sort() : null, results };
}

module.exports = {
  findPrecedent, findSimilar, probe, buildQueries, matchScope, isSuccessful, toCandidate, filterValue,
  problemKnown, resetCaches,
};
