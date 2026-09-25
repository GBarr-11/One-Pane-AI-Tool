'use strict';

/**
 * After a draft is written: does every hard fact in it exist somewhere?
 *
 * A wrong IP, change number, or version in a customer reply is the costliest
 * kind of model error. It reads as authoritative, and a skim will not catch
 * it. A second model pass could check every sentence, but that would resend
 * the whole ticket and the SOPs, roughly doubling the cost of a draft. This
 * check costs nothing. It pulls the specific values out of the draft and looks
 * for each one in the evidence: the full ticket (every note, internal ones
 * too, not only the ones the prompt was given), its metadata, and the full
 * text of the cited SOPs. Anything not found is listed for the analyst to
 * check before sending.
 *
 * It checks values, not claims. "The change is complete" when it is not is
 * out of its reach. Dates are not checked either: "September 2nd" and "9/2"
 * are the same date, and matching those reliably is not worth a flood of
 * false alarms.
 */

const { toPlainText } = require('./sanitize');

const PATTERNS = [
  { kind: 'IP address', re: /\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g },
  { kind: 'version', re: /\b[vV]?\d+\.\d+(?:\.\d+)+\b/g },
  // Not part of a version or IP; a sentence-ending period is fine.
  { kind: 'number', re: /(?<!\d|\d\.)\d{5,}(?!\d|\.\d)/g },
  { kind: 'hostname', re: /\b[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*[-_][A-Za-z0-9]*\d[A-Za-z0-9-]*\b/g },
  { kind: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
];

/** `<code>` spans: the draft prompt puts hostnames, commands, and errors there. */
function codeSpans(html) {
  return [...String(html || '').matchAll(/<code>([\s\S]*?)<\/code>/gi)]
    .map((m) => toPlainText(m[1]).trim())
    .filter((v) => v.length >= 3 && v.length <= 120);
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ');

/** Everything a value may legitimately come from. */
function evidenceText(ticket, docs) {
  const t = ticket || {};
  const parts = [
    t.id, t.subject, t.client, t.clientContact, t.facility,
    JSON.stringify(t.assets || ''), JSON.stringify(t.services || ''), JSON.stringify(t.relatedTickets || ''),
    ...(t.notes || []).map((n) => `${n.author} ${toPlainText(n.body)}`),
    ...(docs || []).map(({ doc }) => `${doc.title} ${doc.body}`),
  ];
  return norm(parts.join('\n'));
}

/** A linked or similar ticket's text, as far as the prompt saw it. */
function otherTicketText(t) {
  return norm([t.subject, t.summary, t.rootCause, t.body, t.opening, t.lastClient, t.replies, t.workNotes, t.resolutionNote]
    .filter(Boolean).join('\n'));
}

/**
 * @param {string} draftHtml
 * @param {object} ticket  the raw ticket, every note included
 * @param {object[]} docs  the cited techdocs (rankDocs shape)
 * @param {object[]} [others]  linked and similar tickets given to the prompt.
 *   They are not evidence for THIS ticket: a value found only there is still
 *   unsupported, but says where it came from (`foundIn`), because a hostname
 *   or IP carried over from another client's ticket is the likeliest way a
 *   precedent goes wrong.
 * @returns {{ checked: number, unsupported: {value: string, kind: string, foundIn?: string}[] }}
 */
function checkDraftFacts(draftHtml, ticket, docs, others = []) {
  const text = toPlainText(draftHtml);
  const found = new Map();
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) if (!found.has(m[0])) found.set(m[0], kind);
  }
  for (const v of codeSpans(draftHtml)) if (!found.has(v)) found.set(v, 'code');

  const evidence = evidenceText(ticket, docs);
  const elsewhere = (others || []).map((t) => ({ id: t.id, text: otherTicketText(t) }));
  const unsupported = [];
  for (const [value, kind] of found) {
    if (evidence.includes(norm(value))) continue;
    const from = elsewhere.find((o) => o.text.includes(norm(value)));
    unsupported.push(from ? { value, kind, foundIn: `ticket #${from.id}` } : { value, kind });
  }
  return { checked: found.size, unsupported: unsupported.slice(0, 12) };
}

module.exports = { checkDraftFacts };
