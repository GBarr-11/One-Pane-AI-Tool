'use strict';

/**
 * Analyst votes on cited SOPs: was this page actually relevant to the ticket?
 *
 * Two uses:
 *   1. Right away. A page voted down on a ticket is hidden on that ticket from
 *      then on. A page voted down on two or more tickets of the same SMC
 *      problem type, with more downs than ups, is hidden for that problem type.
 *      A page voted up that way ranks higher. The relevance judge is good, but
 *      the analysts are the ground truth.
 *   2. Later. The log is the labelled data for re-tuning the title check, the
 *      judge prompt, and the confidence thresholds, and for auditing the
 *      knowledge-gap queue (FUTURE_FEATURES.md).
 *
 * METADATA ONLY, like server/activity.js: ticket id, problem type, category,
 * page id and title, the judge's verdict, the vote, and a timestamp. Never a
 * ticket body, a draft, or page text. It is appended to a JSON-lines file
 * under ONEPANE_DATA_DIR (default `.onepane/`, gitignored), size-capped
 * because the server has no authentication yet, and replayed at startup.
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Net votes, per problem type, that hide or boost a page. */
const HIDE_AT = -2;
const BOOST_AT = 2;
const BOOST_WEIGHT = 1.3;

const ID = /^[A-Za-z0-9_.:#-]{1,64}$/;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

let loadedFrom = null;
/** `${problemKey}|${docId}` -> { up, down, tickets:Set } */
let byProblem = new Map();
/** `${ticketId}|${docId}` -> latest vote */
let byTicket = new Map();

function dataFile() {
  const dir = process.env.ONEPANE_DATA_DIR || path.join(__dirname, '..', '.onepane');
  return path.join(dir, 'feedback.jsonl');
}

/** The grouping a vote counts toward: the SMC problem type, else the category. */
function problemKey(problem, category) {
  const p = clean(problem, 120);
  if (p && p !== 'Undetermined') return `problem:${p.toLowerCase()}`;
  const c = clean(category, 120);
  return c ? `category:${c.toLowerCase()}` : null;
}

function apply(rec) {
  byTicket.set(`${rec.ticketId}|${rec.docId}`, rec.vote);
  const key = problemKey(rec.problem, rec.category);
  if (!key) return;
  const k = `${key}|${rec.docId}`;
  const agg = byProblem.get(k) || { up: 0, down: 0, tickets: new Set() };
  agg[rec.vote === 'up' ? 'up' : 'down'] += 1;
  agg.tickets.add(rec.ticketId);
  byProblem.set(k, agg);
}

/** (Re)load the log when the file location changes, e.g. per test. */
function ensureLoaded() {
  const file = dataFile();
  if (loadedFrom === file) return;
  loadedFrom = file;
  byProblem = new Map();
  byTicket = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { apply(JSON.parse(line)); } catch { /* a torn line is skipped, not fatal */ }
  }
}

/**
 * Validate and store one vote.
 *
 * @returns {{ ok: true, record: object } | { ok: false, error: string }}
 */
function recordVote(input) {
  const ticketId = clean(input && input.ticketId, 64);
  const docId = clean(input && input.docId, 64);
  const vote = input && input.vote;
  if (!ID.test(ticketId) || !ID.test(docId)) return { ok: false, error: 'ticketId and docId are required' };
  if (vote !== 'up' && vote !== 'down') return { ok: false, error: 'vote must be "up" or "down"' };

  const record = {
    at: new Date().toISOString(),
    ticketId,
    docId,
    title: clean(input.title, 200),
    problem: clean(input.problem, 120),
    category: clean(input.category, 120),
    verdict: ['direct', 'partial'].includes(input.verdict) ? input.verdict : null,
    vote,
  };

  ensureLoaded();
  const file = dataFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* new file */ }
    if (size > MAX_FILE_BYTES) return { ok: false, error: 'Feedback log is full - archive .onepane/feedback.jsonl' };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch (err) {
    return { ok: false, error: `Could not save feedback (${err.code || err.message})` };
  }
  apply(record);
  return { ok: true, record };
}

/**
 * Apply the votes to ranked techdocs for one ticket.
 *
 * @param {object} ctx
 * @param {object[]} ranked  rankDocs() output
 * @returns {{ docs: object[], rejected: object[] }}
 */
function applyFeedback(ctx, ranked) {
  ensureLoaded();
  if (!byTicket.size) return { docs: ranked, rejected: [] };

  const key = problemKey(ctx.problem, ctx.category);
  const rejected = [];
  const docs = [];
  for (const r of ranked) {
    const own = byTicket.get(`${ctx.ticketId}|${r.doc.id}`);
    const agg = key && byProblem.get(`${key}|${r.doc.id}`);
    const net = agg ? agg.up - agg.down : 0;

    if (own === 'down') {
      rejected.push({ id: r.doc.id, title: r.doc.title, stage: 'feedback', reason: 'you marked it not relevant to this ticket' });
    } else if (own !== 'up' && agg && net <= HIDE_AT && agg.tickets.size >= 2) {
      rejected.push({
        id: r.doc.id, title: r.doc.title, stage: 'feedback', reason: `analysts marked it not relevant on ${agg.down} similar tickets`,
      });
    } else if (own === 'up' || (agg && net >= BOOST_AT)) {
      docs.push({ ...r, score: r.score * BOOST_WEIGHT, endorsed: true });
    } else {
      docs.push(r);
    }
  }
  docs.sort((a, b) => b.score - a.score);
  return { docs, rejected };
}

/** Counts for the Control Center. */
function feedbackSummary() {
  ensureLoaded();
  let up = 0;
  let down = 0;
  for (const v of byTicket.values()) (v === 'up' ? up++ : down++);
  return { file: dataFile(), votes: byTicket.size, up, down };
}

module.exports = {
  recordVote, applyFeedback, feedbackSummary, problemKey,
};
