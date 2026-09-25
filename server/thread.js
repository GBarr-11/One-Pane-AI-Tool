'use strict';

/**
 * Which notes of a ticket thread go into a prompt, and in what form.
 *
 * Sending every note is the single largest token cost in a draft, and it does
 * not buy accuracy. #3563979 has 84 notes: months of migration scheduling,
 * then a routing problem, then one change control that the reply is actually
 * about. The model does best with the opening request, the recent exchange,
 * and the few older notes that carry hard facts (a change number, a hostname,
 * a version), with the SMC AI summary standing in for the rest.
 *
 * So a prompt gets:
 *   - the first note, which is what was asked
 *   - the last RECENT_NOTES notes, which is where the conversation is now
 *   - up to KEY_NOTES older notes, picked for concrete references and for the
 *     summary's topic words, kept in date order
 *   - a marker saying how many notes were left out
 * each note converted from HTML to text, with quoted email history cut, and
 * the whole capped at a character budget.
 *
 * Internal notes are marked INTERNAL. They carry facts the reply may rely on
 * (what the change did, who owns it), and the drafting prompt is told never to
 * quote them to the customer.
 */

const { tokenize } = require('./retrieval');

/** Notes at the end of the thread always kept. */
const RECENT_NOTES = 6;

/** Older notes kept for the facts they carry. */
const KEY_NOTES = 4;

/** Whole-thread budget in characters, about 3,000 tokens. */
const THREAD_BUDGET = 12000;

/** Per-note caps: the latest customer message matters most. */
const LATEST_CLIENT_CHARS = 3000;
const NOTE_CHARS = 1500;
const KEY_NOTE_CHARS = 800;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...',
};

/** SMC note HTML -> plain text. Markup is tokens the model does not need. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cut quoted email history. A reply sent by email carries the whole previous
 * conversation below it, which is already in the thread as earlier notes.
 */
const QUOTE_START = /^(On .{4,120}wrote:|From: .+|-{2,} ?Original Message ?-{2,}|_{8,}|Sent from my \w+)/im;

function trimQuoted(text) {
  const m = QUOTE_START.exec(text);
  return m && m.index > 40 ? `${text.slice(0, m.index).trim()}\n[quoted history removed]` : text;
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n).trim()} [...]` : text);

/**
 * Concrete references: change and ticket numbers, IPs, versions, hostnames,
 * dates. A note carrying these is one a reply may need to quote exactly.
 */
const SPECIFIC = [
  /\b(?:change(?: control)?|cc|chg|ticket|case|#)\s*#?\s*\d{5,}\b/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\bv?\d+\.\d+(?:\.\d+)+\b/g,
  /\b[a-z]{2,}[a-z0-9]*-[a-z0-9-]*\d[a-z0-9-]*\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
];

function specificCount(text) {
  return SPECIFIC.reduce((n, re) => n + (String(text).match(re) || []).length, 0);
}

const isInternal = (note) => /internal/i.test(String(note.visibility || ''));

/** One note as the prompt shows it. */
function renderNote(note, text) {
  const who = note.role === 'client' ? 'CUSTOMER' : `EXPEDIENT${isInternal(note) ? ', INTERNAL NOTE' : ''}`;
  return `[${note.at}] ${note.author} (${who}): ${text}`;
}

/**
 * Choose and render the notes for a prompt.
 *
 * @param {object} ctx  buildContext() output
 * @param {object} [opts]
 * @param {number} [opts.budget]  character budget for the whole thread
 * @returns {{ text: string, included: number, omitted: number, chars: number }}
 */
function selectThread(ctx, { budget = THREAD_BUDGET } = {}) {
  const notes = (ctx.thread || []).map((n, i) => ({ ...n, i, text: trimQuoted(htmlToText(n.body)) }))
    .filter((n) => n.text);
  if (!notes.length) return { text: '', included: 0, omitted: 0, chars: 0 };

  const lastClient = [...notes].reverse().find((n) => n.role === 'client');
  const cap = (n, fallback) => (n === lastClient ? LATEST_CLIENT_CHARS : fallback);

  const chosen = new Map();
  const take = (n, chars) => { if (!chosen.has(n.i)) chosen.set(n.i, clip(n.text, chars)); };

  take(notes[0], cap(notes[0], NOTE_CHARS));
  notes.slice(-RECENT_NOTES).forEach((n) => take(n, cap(n, NOTE_CHARS)));
  if (lastClient) take(lastClient, LATEST_CLIENT_CHARS);

  // Older notes: the ones with hard facts, or on the summary's topic.
  const topic = new Set(tokenize(ctx.summaryTopic || ''));
  const middle = notes.filter((n) => !chosen.has(n.i))
    .map((n) => {
      const words = new Set(tokenize(n.text));
      let overlap = 0;
      for (const t of topic) if (words.has(t)) overlap++;
      return { n, score: specificCount(n.text) * 2 + overlap };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.n.i - a.n.i)
    .slice(0, KEY_NOTES);
  middle.forEach(({ n }) => take(n, KEY_NOTE_CHARS));

  // Over budget: drop the older key notes first, then shorten the rest evenly.
  const ordered = () => [...chosen.entries()].sort((a, b) => a[0] - b[0]);
  const size = () => ordered().reduce((s, [, t]) => s + t.length + 80, 0);
  for (const { n } of [...middle].reverse()) {
    if (size() <= budget) break;
    chosen.delete(n.i);
  }
  if (size() > budget) {
    const per = Math.max(300, Math.floor(budget / chosen.size) - 80);
    for (const [i, t] of chosen) {
      const n = notes.find((x) => x.i === i);
      if (n !== lastClient) chosen.set(i, clip(t, per));
    }
  }

  const lines = [];
  let prev = -1;
  for (const [i, text] of ordered()) {
    const gap = notes.filter((n) => n.i > prev && n.i < i).length;
    if (gap) lines.push(`[... ${gap} note${gap === 1 ? '' : 's'} omitted - see the AI summary ...]`);
    lines.push(renderNote(notes.find((n) => n.i === i), text));
    prev = i;
  }

  const text = lines.join('\n\n');
  return {
    text, included: chosen.size, omitted: notes.length - chosen.size, chars: text.length,
  };
}

/**
 * How much the thread itself can ground a reply, with no SOP at all.
 *
 * A follow-up on a ticket where we already said what is happening (a change
 * number, a hostname, a date) can be drafted from the thread: the reply
 * restates and advances what is there. A first contact that says "it's
 * broken" cannot, and should still get clarifying questions.
 *
 * @returns {{ grounded: boolean, expedientNotes: number, specifics: number }}
 */
function threadEvidence(ctx) {
  const notes = ctx.thread || [];
  const ours = notes.filter((n) => n.role === 'analyst');
  const specifics = ours.reduce((s, n) => s + specificCount(htmlToText(n.body)), 0)
    + specificCount(ctx.summaryTopic || '');
  const grounded = ours.length >= 1 && notes.length >= 3 && (specifics >= 1 || Boolean(ctx.aiSummary));
  return { grounded, expedientNotes: ours.length, specifics };
}

module.exports = {
  selectThread, threadEvidence, htmlToText, trimQuoted, specificCount, THREAD_BUDGET,
};
