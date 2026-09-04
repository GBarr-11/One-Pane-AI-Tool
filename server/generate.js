'use strict';

const { buildContext } = require('./context');
const { retrieveAll } = require('./retrieval');
const { toPlainText } = require('./sanitize');
const { ticketUrl, techdocUrl, linksConfigured } = require('./links');

const PROVIDERS = {
  mock: () => require('./providers/mock'),
  claude: () => require('./providers/claude'),
};

function activeProviderName() {
  const name = (process.env.ONEPANE_PROVIDER || 'mock').toLowerCase();
  return PROVIDERS[name] ? name : 'mock';
}

/** Cap free-text steering so a paste into that box cannot become the prompt. */
const MAX_INSTRUCTION_CHARS = 500;

/**
 * Full draft pipeline: ticket -> context -> retrieval -> generation -> citations.
 *
 * Returns everything the panel needs to show its work, not just the draft text.
 * The citation list and confidence read are first-class outputs: a draft the
 * analyst cannot sanity-check in a glance costs more time than it saves.
 *
 * @param {object} ticket
 * @param {object} [opts]
 * @param {string} [opts.provider]
 * @param {string} [opts.asOf]
 * @param {string[]} [opts.tones] tone preset ids (see tones.js)
 * @param {string} [opts.instruction] free-text steering from the analyst
 * @param {string} [opts.previousDraft] draft to revise, rather than start fresh
 */
async function generateDraft(ticket, opts = {}) {
  const startedAt = Date.now();

  const ctx = buildContext(ticket, opts);
  const { docs, precedent, confidence } = retrieveAll(ctx, opts);

  const providerName = opts.provider || activeProviderName();
  const provider = PROVIDERS[providerName]();

  const draft = await provider.generate({
    ctx,
    docs,
    precedent,
    confidence,
    tones: Array.isArray(opts.tones) ? opts.tones : [],
    instruction: String(opts.instruction || '').trim().slice(0, MAX_INSTRUCTION_CHARS),
    previousDraft: opts.previousDraft || null,
  });

  const sources = [
    ...docs.map(({ doc, score }) => ({
      kind: 'techdoc',
      ref: doc.id,
      label: doc.title,
      detail: `Updated ${doc.updated}`,
      url: techdocUrl(doc),
      score: Number(score.toFixed(2)),
    })),
    ...precedent.map(({ ticket: t, score }) => ({
      kind: 'ticket',
      ref: `#${t.id}`,
      label: t.subject,
      detail: `Resolved ${t.closedAt}${t.redactedFor ? ' · customer details redacted' : ''}`,
      url: ticketUrl(t.id),
      score: Number(score.toFixed(2)),
    })),
    {
      kind: 'thread',
      ref: `#${ctx.ticketId}`,
      label: 'This ticket',
      detail: `${ctx.noteCount} notes${ctx.lastClientMessage ? ', incl. latest customer message' : ''}`,
      url: ticketUrl(ctx.ticketId),
      score: null,
    },
  ];

  return {
    ticketId: ctx.ticketId,
    draftHtml: draft.html,
    draftText: toPlainText(draft.html),
    intent: draft.intent,
    provider: draft.provider,
    model: draft.model || null,
    usage: draft.usage || null,
    confidence,
    sources,
    links: linksConfigured(),
    caveat: ctx.summaryCaveat,
    awaitingOurReply: ctx.awaitingOurReply,
    // The offline generator cannot honor free-text steering. Say so rather than
    // letting the analyst believe an instruction was applied when it was not.
    instructionApplied: draft.instructionApplied !== false,
    revised: Boolean(opts.previousDraft),
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = { generateDraft, activeProviderName };
