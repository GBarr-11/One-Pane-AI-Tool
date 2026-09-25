'use strict';

const { buildContext } = require('./context');
const { retrieveKnowledge } = require('./knowledge');
const { toPlainText } = require('./sanitize');
const { ticketUrl, techdocUrl, linksConfigured } = require('./links');
const { suggestNextSteps } = require('./suggestions');
const devpack = require('./devpack');
const { relevanceCheckEnabled } = require('./relevance');
const { checkDraftFacts } = require('./grounding');
const { selectThread } = require('./thread');

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

/**
 * The provider's plain completion call, for the techdoc relevance check
 * (relevance.js), or null when the provider has none (the offline mock) or
 * ONEPANE_RELEVANCE_CHECK=off.
 */
function relevanceJudge(provider) {
  if (!relevanceCheckEnabled() || !provider || typeof provider.complete !== 'function') return null;
  return (req) => provider.complete(req);
}

/**
 * The provider's plain completion call, for query expansion
 * (confluence/expand.js), or null when the provider has none or
 * ONEPANE_QUERY_EXPANSION=off.
 */
function queryExpander(provider) {
  if (String(process.env.ONEPANE_QUERY_EXPANSION || 'on').trim().toLowerCase() === 'off') return null;
  if (!provider || typeof provider.complete !== 'function') return null;
  return (req) => provider.complete(req);
}

/**
 * How relevant a cited page is to the ticket, 0-100, for the panel's bar.
 *
 * The relevance verdict sets the band and the lexical score places the page
 * within it, since a score is only meaningful relative to others:
 *   direct     70-100   the page covers what the ticket needs
 *   partial    35-65    same area, background only
 *   unchecked  10-55    no verdict (judge off or failed): never shown as
 *                       more than a coin flip, because nobody checked
 * A score of 10 or more fills its band; SOPs that match well land around 6-12.
 */
function relevancePct(score, verdict) {
  const lexical = Math.max(0, Math.min(1, score / 10));
  if (verdict === 'direct') return Math.round(70 + 30 * lexical);
  if (verdict === 'partial') return Math.round(35 + 30 * lexical);
  return Math.round(10 + 45 * lexical);
}

/** How a relevance verdict reads under a citation. */
const VERDICT_LABEL = { direct: 'Covers this ticket', partial: 'Partial match' };

/**
 * Ranked techdocs as panel citations, shared by Draft and Ask. A page past the
 * staleness line says so, so the analyst checks it before trusting it. A page
 * the relevance check graded carries its verdict and the reason as `why`.
 */
function techdocSources(docs) {
  return docs.map(({
    doc, score, stale, relevance,
  }) => ({
    kind: 'techdoc',
    ref: doc.id,
    label: doc.title,
    detail: `${doc.source === 'confluence' ? `Confluence${doc.space ? ` · ${doc.space}` : ''} · ` : ''}Updated ${doc.updated}`
      + `${stale ? ' · over 2 years old, check it is current' : ''}`,
    url: techdocUrl(doc),
    score: Number(score.toFixed(2)),
    relevancePct: relevancePct(score, relevance ? relevance.verdict : null),
    relevance: relevance ? relevance.verdict : null,
    why: relevance ? `${VERDICT_LABEL[relevance.verdict]}${relevance.reason ? `: ${relevance.reason}` : ''}` : null,
  }));
}

/** How a precedent verdict reads under a citation. */
const PRECEDENT_LABEL = { identical: 'Near-identical case', similar: 'Similar case' };

/** Precedent verdicts in the same bands as SOPs: identical ~ direct, similar ~ partial. */
const PRECEDENT_BAND = { identical: 'direct', similar: 'partial' };

/**
 * Similar resolved tickets as panel citations. An SMC ticket names its client
 * (another client's case must read as one) and how it matched; a mock one
 * keeps its redaction note.
 */
function precedentSources(precedent) {
  return precedent.map(({ ticket: t, score, relevance }) => {
    const verdict = relevance ? relevance.verdict : null;
    const detail = [
      t.client ? t.client : null,
      t.closedAt ? `Resolved ${t.closedAt}` : null,
      t.exchange ? `${t.exchange} customer exchange${t.exchange === 1 ? '' : 's'}` : null,
      t.matchedOn || null,
      t.redactedFor ? 'customer details redacted' : null,
    ].filter(Boolean).join(' · ');
    return {
      kind: 'ticket',
      ref: `#${t.id}`,
      label: t.subject,
      detail,
      url: ticketUrl(t.id),
      score: Number(score.toFixed(2)),
      relevancePct: verdict ? relevancePct(score, PRECEDENT_BAND[verdict]) : (t.matchedOn ? relevancePct(score, null) : undefined),
      relevance: verdict ? PRECEDENT_BAND[verdict] : null,
      why: verdict ? `${PRECEDENT_LABEL[verdict]}${relevance.reason ? `: ${relevance.reason}` : ''}` : null,
    };
  });
}

/** Tickets linked to this one in SMC, with how they relate. Never scored: an analyst chose them. */
function linkedSources(linked) {
  return linked.map((t) => ({
    kind: 'linked',
    ref: `#${t.id}`,
    label: t.subject || '(subject unavailable)',
    detail: [t.relationship, t.status, t.client, t.found === false ? 'could not be read' : null].filter(Boolean).join(' · '),
    url: ticketUrl(t.id),
    score: null,
    why: t.relation || null,
  }));
}

/** "84 notes, 11 sent" - what the prompt actually carried from the thread. */
function threadDetail(ctx) {
  const { included } = selectThread(ctx);
  const sent = included < ctx.noteCount ? `, ${included} most relevant sent to the model` : '';
  return `${ctx.noteCount} notes${sent}${ctx.lastClientMessage ? ', incl. latest customer message' : ''}`;
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

  // Resolved first: the relevance check runs on the same provider as the draft.
  const provider = resolveProvider(opts.provider);

  const {
    docs, precedent, linked, confidence, kb, history,
  } = await retrieveKnowledge(ctx, { ...opts, judge: relevanceJudge(provider), expand: queryExpander(provider) });

  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  report('draft', 'active', opts.previousDraft ? 'revising your draft' : '');
  let draft;
  try {
    draft = await provider.generate({
      ctx,
      docs,
      precedent,
      linked,
      confidence,
      tones: Array.isArray(opts.tones) ? opts.tones : [],
      instruction: String(opts.instruction || '').trim().slice(0, MAX_INSTRUCTION_CHARS),
      previousDraft: opts.previousDraft || null,
    });
  } catch (err) {
    report('draft', 'error');
    throw err;
  }
  report('draft', 'done', `${confidence.level} confidence`);

  const sources = [
    ...techdocSources(docs),
    ...linkedSources(linked),
    ...precedentSources(precedent),
    {
      kind: 'thread',
      ref: `#${ctx.ticketId}`,
      label: 'This ticket',
      detail: threadDetail(ctx),
      url: ticketUrl(ctx.ticketId),
      score: null,
    },
  ];

  // Every IP, version, number, and hostname in the draft, looked up in the
  // whole ticket and the cited SOPs. No model call (grounding.js). A value
  // found only in a linked or similar ticket is flagged with where it came from.
  report('factcheck', 'active');
  const factCheck = checkDraftFacts(draft.html, ticket, docs, [...linked, ...precedent.map((p) => p.ticket)]);
  report('factcheck', 'done', factCheck.unsupported.length
    ? `${factCheck.unsupported.length} to check before sending`
    : `${factCheck.checked} value${factCheck.checked === 1 ? '' : 's'} checked`);

  return {
    ticketId: ctx.ticketId,
    draftHtml: draft.html,
    draftText: toPlainText(draft.html),
    intent: draft.intent,
    provider: draft.provider,
    model: draft.model || null,
    usage: draft.usage || null,
    confidence,
    factCheck,
    sources,
    kb,
    history,
    // Sent back with a source vote (feedback.js) so votes group by problem type.
    ticketMeta: { problem: ctx.problem || null, category: ctx.category || null },
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
  // No SMC history: a suggestion is a quick triage read, not worth the traffic.
  const { docs, precedent, confidence } = await retrieveKnowledge(ctx, { ...opts, history: false });

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
  generateDraft, getSuggestions, activeProviderName, availableProviders, resolveProvider, techdocSources,
  precedentSources, linkedSources, relevanceJudge, queryExpander, relevancePct,
};
