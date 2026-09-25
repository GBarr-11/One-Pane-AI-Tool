'use strict';

/**
 * Ask pipeline: ticket + question -> context -> techdocs -> a direct answer.
 *
 * A deliberate stand-in for Cole's AI CTRL agent (see extension/README.md):
 * that system is role-aware and reads across tickets, alerts, and platform
 * state, with its own audit log. This answers from one ticket's own thread and
 * the SOPs retrieved for it, through the same gateway the Draft tab already
 * uses, so Ask has something real behind it before that integration exists.
 *
 * Retrieval is the Draft tab's, with the question folded in: it anchors the
 * Confluence search (`searchHint`) and leads the ranking text, so "how do we
 * upgrade the ZVM?" on a Zerto ticket finds the upgrade SOP, not just pages
 * about the ticket's subject.
 */

const { buildContext } = require('./context');
const {
  resolveProvider, techdocSources, relevanceJudge, queryExpander,
} = require('./generate');
const { retrieveKnowledge } = require('./knowledge');

/** Cap the question so a paste into that box cannot become the prompt. */
const MAX_QUESTION_CHARS = 1000;

/**
 * @param {object} ticket
 * @param {string} question
 * @param {object} [opts]
 * @param {string} [opts.provider]
 * @param {string} [opts.asOf]
 * @param {string} [opts.ticketOrigin]
 */
async function answerQuestion(ticket, question, opts = {}) {
  const startedAt = Date.now();

  const q = String(question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) throw new Error('No question supplied.');

  const ctx = buildContext(ticket, opts);

  const provider = resolveProvider(opts.provider);

  const searchCtx = { ...ctx, searchHint: q, retrievalText: `${q} ${ctx.retrievalText}` };
  // The relevance check sees the question too, so it grades pages against what was asked.
  // Ask answers from this ticket and its SOPs only (its prompt says so), so it
  // does not search SMC history.
  const { docs, kb } = await retrieveKnowledge(searchCtx, {
    ...opts, judge: relevanceJudge(provider), expand: queryExpander(provider), history: false,
  });

  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  report('answer', 'active');
  let result;
  try {
    result = await provider.answer({ ctx, question: q, docs });
  } catch (err) {
    report('answer', 'error');
    throw err;
  }
  report('answer', 'done');

  return {
    ticketId: ctx.ticketId,
    response: result.text,
    sources: techdocSources(docs),
    kb,
    ticketMeta: { problem: ctx.problem || null, category: ctx.category || null },
    provider: result.provider,
    model: result.model || null,
    usage: result.usage || null,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = { answerQuestion };
