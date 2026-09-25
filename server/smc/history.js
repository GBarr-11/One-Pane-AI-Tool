'use strict';

/**
 * Real SMC ticket history: tickets SMC links to this one, and closed tickets
 * like it, read for how they were handled.
 *
 * Every call is a GET through `smc/client.js`, which exports no write.
 *
 * THE SEARCH MECHANISM (verified against the live v3 API, 2026-09-25)
 * The SMC console's search box (OR by default, quotes for a phrase, `-` to
 * exclude; see "Tips and Tricks 101 - SMC" in Confluence) is not exposed by
 * the API. What is exposed is the `filters` grammar on `GET /tickets`:
 *   - `subject like '%zerto%'`  case-insensitive substring. Also works on
 *     `body`, `internal_summary`, `root_cause`, and `problem.name`.
 *     `'%zerto%upgrade%'` means both words, in that order.
 *   - clauses joined by commas are ANDed. There is no `and`/`or` keyword (both
 *     are a 400), so OR is several queries, merged here - the search box's
 *     default, done by hand.
 *   - `nlike` excludes. `not like` is accepted and SILENTLY IGNORED, and
 *     `nlike` also drops rows where the field is null. So nothing the API
 *     is asked to exclude is trusted: every rule is re-checked below.
 *   - datetimes must be full ISO 8601 (`'2025-09-25T00:00:00Z'`). A bare date
 *     is `invalid type: expected dateTime`, which is what sank the first
 *     version of this feature on 2026-09-23.
 *   - `order_by=closed_at desc` works.
 *
 * COST. Unknown rate limits, so a draft stays small: at most 4 list queries
 * (two at a time), one `/related` read, one ticket read per linked ticket, and
 * one batched notes read (`ticket_id in (...)`, ~170 ms) for everything whose
 * thread is needed. A `closed_at` window keeps list queries around 1-3 s; the
 * same query unbounded, or filtered on `status`, took ~10 s, and an unscoped
 * note-body search timed out at 20 s. Results are cached per ticket for 10
 * minutes, so a tone change or a re-draft costs nothing.
 *
 * WHAT COUNTS AS PRECEDENT (Grant, 2026-09-23 and 2026-09-25)
 *   Successful:  closed, not escalated, not reopened by a person. SMC's own
 *                `task-end-hold` automation sets `reopened_at` whenever a hold
 *                expires, so an automated reopen does not count.
 *   Similar:     another client's ticket is fine when the problem is the same;
 *                it is labelled with its client, not redacted.
 *   Preferred:   client-raised tickets where analysts went back and forth with
 *                the customer. Their threads carry the handling process worth
 *                following, so they rank higher (`exchange` below).
 *   Linked:      every ticket SMC links to this one is read and correlated,
 *                whatever its state - it is never filtered out.
 * Automated tickets are not excluded as such. Near-identical automated ones
 * (the daily "Zerto Replication Check" per client) are collapsed to two per
 * subject pattern, which is what keeps them from crowding out everything else.
 */

const { smcGet } = require('./client');
const { tokenize } = require('../retrieval');
const { queryTerms } = require('../confluence/search');
const { toPlainText } = require('../sanitize');

const CACHE_TTL_MS = 10 * 60 * 1000;
const LIST_PER_PAGE = 40;
const MAX_QUERIES = 4;
const QUERY_CONCURRENCY = 2;
const MAX_LINKED = 4;
/** Candidates whose threads are read. */
const DETAIL_COUNT = 6;
const NOTES_PER_PAGE = 100;
const MAX_NOTE_PAGES = 4;
/** Per subject pattern, after collapsing near-identical tickets. */
const PER_TEMPLATE = 2;
/** A query matching more than this share of the window is broad; its hits count for less. */
const BROAD_SHARE = 0.02;
/** Tickets closed in 12 months, measured 2026-09-25; refreshed from live counts. */
const WINDOW_TOTAL_FALLBACK = 140000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function config() {
  return { months: clamp(Number(process.env.SMC_HISTORY_MONTHS) || 12, 1, 36) };
}

const cache = new Map();

/** Test seam. */
function resetCaches() {
  cache.clear();
}

function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  Promise.resolve(value).catch(() => cache.delete(key));
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}

/* ---------------- small helpers ---------------- */

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const nameOf = (rel) => (rel && typeof rel === 'object' && rel.name ? String(rel.name).trim() : '');
const idOf = (rel) => (rel && typeof rel === 'object' && rel.id != null ? Number(rel.id) : null);
const userOf = (rel) => (rel && typeof rel === 'object' ? str(rel.username) : '');
const pageData = (body) => (body && Array.isArray(body.data) ? body.data : []);
const norm = (s) => str(s).toLowerCase();

function clip(text, max) {
  const t = str(text).replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const plain = (html, max) => clip(toPlainText(str(html)), max);

/**
 * A value safe inside a filter clause. A quote would end the value early and
 * a comma would start a new clause, so both are removed; the grammar's
 * escaping is undocumented. `%` and `_` are LIKE wildcards, removed too.
 */
function filterValue(value) {
  return str(value).replace(/['",%_\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A search term as a LIKE pattern: letters, digits, dot, dash only. */
const likeTerm = (t) => str(t).toLowerCase().replace(/[^a-z0-9.-]/g, '');

function windowStart(asOf, months) {
  const d = new Date(asOf || Date.now());
  d.setMonth(d.getMonth() - months);
  return `${d.toISOString().slice(0, 19)}Z`;
}

/** A problem classification that actually says what the problem is. */
function problemKnown(ctx) {
  const p = norm(ctx.problem);
  return Boolean(p) && !/^(undetermined|unknown|other|none|n\/?a|-+|—)$/.test(p);
}

/** Automation accounts: their reopens and their notes are not people. */
const AUTOMATION_USER = /^(task-|retool$|ctc-bot$|scheduled$|system$|smc$|api$)/i;

/** A note written by the customer: posted through the client portal or email. */
function isClientNote(n) {
  if (/client|email|phone/i.test(str(n.source))) return true;
  return userOf(n.created_by).includes('@');
}

function isAnalystNote(n) {
  const user = userOf(n.created_by);
  return !isClientNote(n) && Boolean(user) && !AUTOMATION_USER.test(user);
}

const substantive = (n) => plain(n.body, 400).length > 30;
const isInternal = (n) => /internal|private|secure/i.test(str(n.visibility)) || n.is_secure === true;

/* ---------------- candidates ---------------- */

/**
 * A subject's words with the client's taken out, so the daily
 * "<Client> - Client - Zerto Replication Check - VPGs are ..." tickets, and
 * the per-client "Zerto 10.8 Upgrade Notice - <Client>" ones, compare as the
 * same subject whatever client they carry.
 */
function subjectWords(subject, client) {
  const drop = new Set(tokenize(client || ''));
  return new Set(tokenize(subject).filter((t) => !drop.has(t)));
}

/**
 * Near-duplicate subjects: the shorter one's words are at least 80% in the
 * other. Exact patterns miss these, because the client's name is spelled into
 * the subject its own way ("ITU Absorb Tech" for client "ITU AbsorbTech", or
 * "QSLWM"), and those leftover words would sink a plain overlap ratio. Subjects
 * under three words must match exactly: "Zerto" is not a copy of every
 * Zerto ticket.
 */
function sameSubject(a, b) {
  const small = Math.min(a.size, b.size);
  if (!small) return false;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  if (small < 3) return shared === a.size && shared === b.size;
  return shared / small >= 0.8;
}

/** A `TicketResponse` from a list read -> one candidate. */
function toCandidate(raw) {
  const reopener = userOf(raw.reopened_by);
  return {
    id: str(raw.id),
    subject: str(raw.subject),
    client: nameOf(raw.client),
    clientId: idOf(raw.client),
    problem: nameOf(raw.problem),
    problemId: idOf(raw.problem),
    subProblem: nameOf(raw.sub_problem),
    category: nameOf(raw.category),
    categoryId: idOf(raw.category),
    status: str(raw.status),
    type: str(raw.type),
    source: str(raw.source),
    createdBy: userOf(raw.created_by),
    closedAt: str(raw.closed_at).slice(0, 10),
    escalated: raw.is_escalated === true,
    // Only a person reopening a ticket says the first fix did not hold.
    reopened: Boolean(raw.reopened_at) && Boolean(reopener) && !AUTOMATION_USER.test(reopener),
    noteCount: typeof raw.note_count === 'number' ? raw.note_count : null,
    helpful: (raw.helpful_counts && Number(raw.helpful_counts.yes)) || 0,
    rootCause: plain(raw.root_cause, 400),
    summary: plain(raw.internal_summary, 900),
    body: plain(raw.body, 700),
    tags: [nameOf(raw.problem), nameOf(raw.sub_problem), nameOf(raw.category)].filter(Boolean),
  };
}

/** Closed, not escalated, not reopened by a person, and not closed as noise. */
function isSuccessful(c) {
  if (!c.closedAt || c.escalated || c.reopened) return false;
  return !/cancel|duplicate|merged|void|spam/i.test(c.status);
}

/** Raised by the customer rather than by our automation or one of us. */
const clientRaised = (c) => /client|email|phone/i.test(c.source) || c.createdBy.includes('@');

/* ---------------- queries ---------------- */

/**
 * The search terms, analyst-chosen first (subject, problem), then the AI
 * summary and the customer's message - the same picker the Confluence search
 * uses. Terms under 4 characters are dropped unless they carry a digit
 * ("eec2"): as a substring, "vra" also matches "every".
 */
const likeable = (t) => t.length >= 4 || (t.length === 3 && /\d/.test(t));

function searchTerms(ctx) {
  return queryTerms(ctx).map(likeTerm).filter(likeable).slice(0, 6);
}

/**
 * The AI summary's own topic terms, for the `internal_summary` query. A
 * generic subject ("Service Transition Notification") would otherwise send the
 * same two words to both queries, when the summary names the actual topic
 * ("bgp", "route").
 */
function summaryTerms(ctx, exclude) {
  if (!ctx.summaryTopic) return [];
  return queryTerms({ summaryTopic: ctx.summaryTopic, client: ctx.client })
    .map(likeTerm).filter((t) => likeable(t) && !exclude.includes(t)).slice(0, 2);
}

/**
 * At most four list queries, each a different way a similar ticket could be
 * found. OR across them, AND within each.
 */
function buildQueries(ctx, { asOf } = {}) {
  const { months } = config();
  const since = windowStart(asOf, months);
  const common = [`closed_at gt '${since}'`, 'is_escalated eq false'];
  const terms = searchTerms(ctx);
  const [a, b] = terms;
  const queries = [];
  const add = (scope, clauses) => {
    if (clauses.some((c) => !c)) return;
    queries.push({ scope, filters: [...clauses, ...common].join(', ') });
  };

  let problem = null;
  if (problemKnown(ctx)) {
    problem = ctx.problemId != null ? `problem.id eq ${Number(ctx.problemId)}` : null;
    if (!problem && filterValue(ctx.problem)) problem = `problem.name eq '${filterValue(ctx.problem)}'`;
  }

  // Same problem, on topic. Without a topic term, the problem alone.
  if (problem) add('problem', a ? [problem, `subject like '%${a}%'`] : [problem]);
  if (a && b) add('subject', [`subject like '%${a}%'`, `subject like '%${b}%'`]);
  else if (a && !problem) add('subject', [`subject like '%${a}%'`]);
  // Generic subjects ("Service Transition Notification") hide the topic; the
  // AI summary usually names it, in its own words.
  const [s1, s2] = summaryTerms(ctx, [a, b]);
  const [x, y] = s1 && s2 ? [s1, s2] : (s1 && a ? [a, s1] : [a, b]);
  if (x && y) add('summary', [`internal_summary like '%${x}%'`, `internal_summary like '%${y}%'`]);
  // This client's own history on the topic: same environment, same people.
  const client = ctx.clientId != null ? `client.id eq ${Number(ctx.clientId)}`
    : (filterValue(ctx.client) ? `client.name eq '${filterValue(ctx.client)}'` : null);
  if (client && a) add('client', [client, `subject like '%${a}%'`]);

  return { queries: queries.slice(0, MAX_QUERIES), terms, since };
}

async function listTickets(filters) {
  const query = {
    filters, per_page: LIST_PER_PAGE, page: 1, order_by: 'closed_at desc',
  };
  const { data } = await smcGet('tickets', { query });
  return { rows: pageData(data), total: data && typeof data.total === 'number' ? data.total : null };
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

/* ---------------- linked tickets ---------------- */

/**
 * Tickets SMC links to this one (`GET /tickets/{id}/related`), whichever side
 * of the link this ticket is on, plus any the page scrape found.
 */
async function linkedRefs(ctx) {
  const refs = new Map();
  const self = String(ctx.ticketId);
  const warnings = [];

  try {
    const { data } = await smcGet(`tickets/${encodeURIComponent(self)}/related`, { query: { per_page: 50 } });
    for (const rel of pageData(data)) {
      const a = rel.a_ticket || {};
      const b = rel.b_ticket || {};
      const other = String(a.id) === self ? b : a;
      if (other.id == null || String(other.id) === self) continue;
      refs.set(String(other.id), {
        id: String(other.id),
        subject: str(other.subject),
        relationship: nameOf(rel.ticket_relationship_type) || 'Related',
        linkedBy: rel.created_by ? str(rel.created_by.full_name || rel.created_by.username) : '',
        linkedAt: str(rel.created_at).slice(0, 10),
      });
    }
  } catch (err) {
    warnings.push(`Could not read this ticket's SMC links (${err.message.slice(0, 140)})`);
  }

  for (const r of ctx.relatedTickets || []) {
    const id = String((r && r.id) || '').replace(/^#/, '');
    if (id && id !== self && !refs.has(id)) {
      refs.set(id, {
        id, subject: str(r.label), relationship: 'Related', linkedBy: '', linkedAt: '',
      });
    }
  }
  return { refs: [...refs.values()].slice(0, MAX_LINKED), warnings };
}

async function fetchRecord(id) {
  const { data } = await smcGet(`tickets/${encodeURIComponent(id)}`);
  return data && data.data && !data.id ? data.data : data;
}

/* ---------------- threads ---------------- */

/**
 * Notes for several tickets in one paginated read, grouped by ticket, oldest
 * first. `ticket_id in (...)` is fast; a note-body search without it is not.
 */
async function fetchNotesFor(ids) {
  const byTicket = new Map(ids.map((id) => [String(id), []]));
  if (!ids.length) return { byTicket, truncated: false };

  const filters = `ticket_id in (${ids.map((id) => Number(id)).filter(Number.isFinite).join(',')})`;
  let truncated = true;
  for (let page = 1; page <= MAX_NOTE_PAGES; page++) {
    const { data } = await smcGet('notes', { query: { filters, per_page: NOTES_PER_PAGE, page } });
    const batch = pageData(data);
    for (const n of batch) {
      const tid = String((n.ticket && n.ticket.id) ?? n.ticket_id ?? '');
      if (byTicket.has(tid)) byTicket.get(tid).push(n);
    }
    const total = data && typeof data.total === 'number' ? data.total : null;
    if (batch.length < NOTES_PER_PAGE || (total != null && page * NOTES_PER_PAGE >= total)) {
      truncated = false;
      break;
    }
  }
  for (const list of byTicket.values()) list.sort((x, y) => str(x.created_at).localeCompare(str(y.created_at)));
  return { byTicket, truncated };
}

/**
 * How much the customer and our analysts actually talked on a ticket: the
 * number of times the conversation changed hands between them. A ticket where
 * the customer wrote in, we asked, they answered, and we fixed it scores 3;
 * an automated notice that was closed untouched scores 0.
 */
function exchangeTurns(notes) {
  let turns = 0;
  let last = null;
  for (const n of notes) {
    if (!substantive(n)) continue;
    const who = isClientNote(n) ? 'client' : (isAnalystNote(n) && !isInternal(n) ? 'analyst' : null);
    if (!who) continue;
    if (last && who !== last) turns++;
    last = who;
  }
  return turns;
}

/**
 * What a ticket's thread says about how it was handled: what we told the
 * customer, what we did internally, and what the customer said last.
 */
function digestThread(notes) {
  const human = notes.filter(substantive);
  const replies = human.filter((n) => isAnalystNote(n) && !isInternal(n));
  const internal = human.filter((n) => isInternal(n) && !isClientNote(n));
  const client = human.filter(isClientNote);
  const joinLast = (list, count, max) => clip(list.slice(-count).map((n) => plain(n.body, 900)).join(' … '), max);
  return {
    clientNotes: client.length,
    exchange: exchangeTurns(notes),
    opening: client.length ? plain(client[0].body, 500) : '',
    lastClient: client.length ? plain(client[client.length - 1].body, 500) : '',
    replies: joinLast(replies, 3, 1500),
    workNotes: joinLast(internal, 3, 900),
  };
}

/* ---------------- ranking ---------------- */

/** How well a candidate matches on words, weighted by how rare each word is here. */
function lexicalScores(pool, ctx) {
  const docs = pool.map((c) => tokenize(`${c.subject} ${c.subject} ${c.summary} ${c.rootCause} ${c.body} ${c.tags.join(' ')}`));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const q = [...new Set(tokenize(ctx.retrievalText))];
  return docs.map((d) => {
    const set = new Set(d);
    let s = 0;
    for (const t of q) if (set.has(t)) s += Math.log(1 + pool.length / (1 + df.get(t))) + 1;
    return q.length ? s / Math.sqrt(q.length) : 0;
  });
}

function recency(closedAt, asOf) {
  if (!closedAt) return 1;
  const months = (new Date(asOf || Date.now()) - new Date(closedAt)) / (1000 * 60 * 60 * 24 * 30.4);
  return months <= 3 ? 1 : months <= 6 ? 0.95 : 0.88;
}

/**
 * Score one candidate. Structure first (same problem, same category), then the
 * preference for client conversations, then recency.
 */
function scoreCandidate(c, lexical, ctx, asOf) {
  let s = lexical;
  const sameProblem = problemKnown(ctx) && (
    (ctx.problemId != null && c.problemId != null) ? c.problemId === Number(ctx.problemId) : norm(c.problem) === norm(ctx.problem));
  const sameCategory = (ctx.categoryId != null && c.categoryId != null)
    ? c.categoryId === Number(ctx.categoryId) : Boolean(c.category) && norm(c.category) === norm(ctx.category);
  if (sameProblem) s *= 1.5;
  else if (sameCategory) s *= 1.2;
  if (clientRaised(c)) s *= 1.15;
  // Before the thread is read, the note count stands in for the conversation.
  if (c.exchange == null && c.noteCount) s *= 1 + 0.03 * Math.min(c.noteCount, 10);
  if (c.exchange != null) s *= 1 + 0.12 * Math.min(c.exchange, 6);
  if (c.helpful > 0) s *= 1.1;
  if (c.broad) s *= 0.85;
  s *= recency(c.closedAt, asOf);
  return { score: s, sameProblem, sameCategory };
}

function rank(pool, ctx, asOf) {
  const lex = lexicalScores(pool, ctx);
  return pool
    .map((c, i) => ({ c, ...scoreCandidate(c, lex[i], ctx, asOf) }))
    .filter((r) => r.score > 0.35)
    .sort((x, y) => y.score - x.score);
}

/** "Same problem: Disaster Recovery as a Service · matched 'zerto', 'upgrade'" */
function matchedOn(c, ctx, terms, r) {
  const parts = [];
  if (r.sameProblem) parts.push(`same problem (${c.problem})`);
  else if (r.sameCategory) parts.push(`same category (${c.category})`);
  const words = terms.filter((t) => norm(`${c.subject} ${c.summary}`).includes(t)).slice(0, 3);
  if (words.length) parts.push(words.map((w) => `"${w}"`).join(', '));
  if (c.clientId != null && ctx.clientId != null && c.clientId === Number(ctx.clientId)) parts.push('same client');
  return parts.join(' · ') || 'similar wording';
}

/* ---------------- the lookup ---------------- */

/**
 * Tickets SMC links to this one, and the best similar resolved tickets, each
 * with its thread digested.
 *
 * @param {object} ctx  buildContext() output (`problemId`, `clientId`,
 *   `categoryId` when the ticket came from the SMC API)
 * @param {object} [opts]
 * @param {string} [opts.asOf]
 * @returns {Promise<{linked: object[], candidates: object[], queries: object[],
 *   terms: string[], warnings: string[], failure: string|null, calls: number}>}
 *   `candidates` are ranked, best first; the caller judges and trims them.
 */
function lookup(ctx, opts = {}) {
  const day = String(opts.asOf || new Date().toISOString()).slice(0, 10);
  return cached(`${ctx.ticketId}|${day}|${ctx.problem}|${ctx.subject}`, () => runLookup(ctx, opts));
}

async function runLookup(ctx, opts) {
  const warnings = [];
  let calls = 0;
  const self = String(ctx.ticketId);
  const { queries, terms } = buildQueries(ctx, opts);
  const allTerms = [...new Set([...terms, ...queries.flatMap((q) => [...q.filters.matchAll(/like '%([^%]+)%'/g)].map((m) => m[1]))])];

  const [linkedInfo, results] = await Promise.all([
    linkedRefs(ctx).then((r) => { calls += 1; return r; }),
    mapLimit(queries, QUERY_CONCURRENCY, async (q) => {
      calls += 1;
      try {
        return { q, ...(await listTickets(q.filters)) };
      } catch (err) {
        return { q, error: err.message };
      }
    }),
  ]);
  warnings.push(...linkedInfo.warnings);

  const failed = results.filter((r) => r.error);
  for (const r of failed) warnings.push(`Ticket history query (${r.q.scope}) failed: ${r.error.slice(0, 160)}`);
  const failure = queries.length && failed.length === queries.length ? warnings[warnings.length - 1] : null;

  // Linked tickets: read each one's record, whatever its state.
  const linkedIds = new Set(linkedInfo.refs.map((r) => r.id));
  const linked = await mapLimit(linkedInfo.refs, 2, async (ref) => {
    calls += 1;
    try {
      const raw = await fetchRecord(ref.id);
      return raw ? { ...toCandidate(raw), ...ref, subject: str(raw.subject) || ref.subject, found: true } : { ...ref, found: false };
    } catch (err) {
      warnings.push(`Could not read linked ticket #${ref.id} (${err.message.slice(0, 120)})`);
      return { ...ref, found: false };
    }
  });

  // Similar tickets: merge, re-check every rule, collapse near-duplicates.
  const seen = new Set([self, ...linkedIds]);
  const pool = [];
  const scopes = new Map();
  for (const r of results) {
    if (r.error) continue;
    const broad = r.total != null && r.total > WINDOW_TOTAL_FALLBACK * BROAD_SHARE;
    for (const raw of r.rows) {
      const c = toCandidate(raw);
      if (!c.id) continue;
      if (scopes.has(c.id)) { scopes.get(c.id).add(r.q.scope); continue; }
      if (seen.has(c.id) || !isSuccessful(c)) continue;
      seen.add(c.id);
      scopes.set(c.id, new Set([r.q.scope]));
      pool.push({ ...c, broad });
    }
  }
  // Found by more than one query: more ways it matches, less likely broad.
  for (const c of pool) if (scopes.get(c.id).size > 1) c.broad = false;

  // Best first, so the copies kept of a repeated subject are its best matches.
  const kept = [];
  const collapsed = rank(pool, ctx, opts.asOf).filter(({ c }) => {
    const words = subjectWords(c.subject, c.client);
    if (kept.filter((w) => sameSubject(w, words)).length >= PER_TEMPLATE) return false;
    kept.push(words);
    return true;
  });

  // Threads for the leaders and every linked ticket, in one batched read.
  const leaders = collapsed.slice(0, DETAIL_COUNT).map(({ c }) => c);
  const threadIds = [...linked.filter((l) => l.found).map((l) => l.id), ...leaders.map((c) => c.id)];
  let notes = new Map();
  if (threadIds.length) {
    calls += 1;
    try {
      const fetched = await fetchNotesFor(threadIds);
      notes = fetched.byTicket;
      if (fetched.truncated) warnings.push('Some precedent threads were long; only their first notes were read');
    } catch (err) {
      warnings.push(`Could not read precedent threads (${err.message.slice(0, 140)}); ranked on summaries only`);
    }
  }
  const withThread = (c) => (notes.has(c.id) ? { ...c, ...digestThread(notes.get(c.id)) } : c);

  const detailed = rank(leaders.map(withThread), ctx, opts.asOf).map(({ c, score, ...r }) => ({
    ticket: { ...c, matchedOn: matchedOn(c, ctx, allTerms, r), sameProblem: r.sameProblem },
    score,
  }));

  return {
    linked: linked.map(withThread),
    candidates: detailed,
    queries: queries.map((q) => ({ scope: q.scope, filters: q.filters })),
    terms: allTerms,
    warnings,
    failure,
    calls,
  };
}

module.exports = {
  lookup,
  buildQueries,
  searchTerms,
  toCandidate,
  isSuccessful,
  isClientNote,
  exchangeTurns,
  digestThread,
  sameSubject,
  subjectWords,
  filterValue,
  windowStart,
  resetCaches,
};
