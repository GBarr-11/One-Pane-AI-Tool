'use strict';

/**
 * Polish pipeline: whatever is in the reply box -> a cleaned-up, formatted
 * version of the same text.
 *
 * Deliberately the simplest pipeline in this codebase: no ticket, no
 * retrieval, no context - just the text the analyst already has in front of
 * them. It exists for the person who does not want to regenerate a draft from
 * scratch, only to have their own wording tightened up and formatted, the way
 * running a paragraph through a grammar checker does not rewrite its meaning.
 */

const { toPlainText } = require('./sanitize');
const { resolveProvider } = require('./generate');

/** Cap input so a large paste cannot become an unbounded prompt. */
const MAX_INPUT_CHARS = 8000;

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.provider]
 */
async function polishText(text, opts = {}) {
  const startedAt = Date.now();

  const input = String(text || '').trim().slice(0, MAX_INPUT_CHARS);
  if (!input) throw new Error('No text to polish.');

  const provider = resolveProvider(opts.provider);

  const result = await provider.polish({ text: input });

  return {
    html: result.html,
    text: toPlainText(result.html),
    provider: result.provider,
    model: result.model || null,
    usage: result.usage || null,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = { polishText };
