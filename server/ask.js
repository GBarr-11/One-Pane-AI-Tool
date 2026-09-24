'use strict';

/**
 * Ask pipeline: ticket -> context -> a direct answer from the gateway model.
 *
 * A deliberate stand-in for Cole's AI CTRL agent (see extension/README.md):
 * that system is role-aware and reads across tickets, alerts, and platform
 * state, with its own audit log. This answers from one ticket's own thread
 * only, through the same gateway the Draft tab already uses, so Ask has
 * something real behind it before that integration exists.
 */

const { buildContext } = require('./context');
const { resolveProvider } = require('./generate');

/** Cap the question so a paste into that box cannot become the prompt. */
const MAX_QUESTION_CHARS = 1000;

/**
 * @param {object} ticket
 * @param {string} question
 * @param {object} [opts]
 * @param {string} [opts.provider]
 * @param {string} [opts.asOf]
 */
async function answerQuestion(ticket, question, opts = {}) {
  const startedAt = Date.now();

  const q = String(question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!q) throw new Error('No question supplied.');

  const ctx = buildContext(ticket, opts);

  const provider = resolveProvider(opts.provider);

  const result = await provider.answer({ ctx, question: q });

  return {
    ticketId: ctx.ticketId,
    response: result.text,
    provider: result.provider,
    model: result.model || null,
    usage: result.usage || null,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = { answerQuestion };
