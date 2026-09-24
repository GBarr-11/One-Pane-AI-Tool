'use strict';

const { buildContext } = require('./context');
const { retrieveKnowledge } = require('./knowledge');
const { toPlainText } = require('./sanitize');
const { ticketUrl, techdocUrl, linksConfigured } = require('./links');
const { suggestNextSteps } = require('./suggestions');
const devpack = require('./devpack');

/** The production providers. A dev pack may add its own (the offline mock). */
const PROVIDERS = {
  claude: () => require('./providers/claude'),
  openwebui: () => require('./providers/openwebui'),
};

function allProviders() {
  const pack = devpack.active();
  return { ...PROVIDERS, ...((pack && pack.providers) || {}) };
}

/** Names of the providers this server can run right now. */
function availableProviders() {
  return Object.keys(allProviders());
}

/**
 * The provider in effect: ONEPANE_PROVIDER when it names one that exists,
 * else the dev pack's default, else 'none'.
 *
 * Production deliberately has no silent fallback. It used to fall back to the
 * offline generator, which on a live ticket produced a confident-looking draft
 * from templates - a misconfiguration has to read as one.
 *
 * @returns {string}
 */
function activeProviderName() {
  const all = allProviders();
  const requested = (process.env.ONEPANE_PROVIDER || '').trim().toLowerCase();
  if (requested && all[requested]) return requested;
  const pack = devpack.active();
  if (pack && pack.defaultProvider && all[pack.defaultProvider]) return pack.defaultProvider;
  return 'none';
}

/**
 * Load a provider by name, or the active one.
 *
 * Throws a message an analyst can act on rather than a TypeError, for both an
 * unset ONEPANE_PROVIDER and a caller asking for a provider this server lacks
 * (the extension can pass `provider` through; 'mock' is not one in production).
 */
function resolveProvider(name) {
  const all = allProviders();
  const chosen = name || activeProviderName();
  if (chosen === 'none') {
    const requested = (process.env.ONEPANE_PROVIDER || '').trim();
    throw new Error(requested
      ? `ONEPANE_PROVIDER=${requested} is not available on this server (available: ${availableProviders().join(', ')}).`
      : 'No generation provider is configured - set ONEPANE_PROVIDER to openwebui or claude in .env.');
  }
  if (!all[chosen]) {
    throw new Error(`Unknown provider "${chosen}" (available: ${availableProviders().join(', ')}).`);
  }
  return all[chosen]();
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
 * @param {string} [opts.ticketOrigin] 'mock' | 'smc' | 'inline' - only dev-pack tickets get precedent (knowledge.js)
 * @param {string[]} [opts.tones] tone preset ids (see tones.js)
 * @param {string} [opts.instruction] free-text steering from the analyst
 * @param {string} [opts.previousDraft] draft to revise, rather than start fresh
 */
async function generateDraft(ticket, opts = {}) {
  const startedAt = Date.now();

  const ctx = buildContext(ticket, opts);
  const {
    docs, precedent, confidence, kb,
  } = await retrieveKnowledge(ctx, opts);

  const provider = resolveProvider(opts.provider);

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
      detail: `${doc.source === 'confluence' ? `Confluence${doc.space ? ` · ${doc.space}` : ''} · ` : ''}Updated ${doc.updated}`,
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
    kb,
    // Confluence pages carry their own URL, so no ONEPANE_KB_BASE_URL is needed.
    links: { ...linksConfigured(), ...(kb.source === 'confluence' ? { techdocs: true } : {}) },
    caveat: ctx.summaryCaveat,
    awaitingOurReply: ctx.awaitingOurReply,
    // The offline generator cannot honor free-text steering. Say so rather than
    // letting the analyst believe an instruction was applied when it was not.
    instructionApplied: draft.instructionApplied !== false,
    revised: Boolean(opts.previousDraft),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * "Suggest a next step" - analyst clicked the button, not automatic.
 *
 * Tries the active provider's model-driven read first; on any failure (no
 * credentials, rate limit, the model returning something unparseable) falls
 * back to the deterministic heuristic in suggestions.js rather than
 * propagating the error. A suggestion pill that sometimes throws instead of
 * degrading would be worse than the static version this replaced - an
 * analyst who is already stuck should never see this come back empty.
 *
 * @param {object} ticket
 * @param {object} [opts]
 * @param {string} [opts.provider]
 * @param {string} [opts.asOf]
 */
async function getSuggestions(ticket, opts = {}) {
  const ctx = buildContext(ticket, opts);
  const { docs, precedent, confidence } = await retrieveKnowledge(ctx, opts);

  // The heuristic below needs no provider, so a missing one is not an error here.
  let provider = null;
  try { provider = resolveProvider(opts.provider); } catch { /* heuristic only */ }

  try {
    const result = provider && await provider.suggest({
      ctx, docs, precedent, confidence,
    });
    if (result && Array.isArray(result.suggestions) && result.suggestions.length) {
      return { ticketId: ctx.ticketId, suggestions: result.suggestions };
    }
  } catch {
    // Fall through to the heuristic below.
  }

  return {
    ticketId: ctx.ticketId,
    suggestions: suggestNextSteps(ctx, confidence).map(({ label, instruction }) => ({ label, instruction })),
  };
}

module.exports = {
  generateDraft, getSuggestions, activeProviderName, availableProviders, resolveProvider,
};
