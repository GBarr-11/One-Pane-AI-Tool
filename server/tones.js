'use strict';

/**
 * Tone presets offered next to the draft.
 *
 * These are ids, not free text, so the analyst's one-click choices are a closed
 * set the server understands rather than arbitrary strings forwarded to a model.
 * Free-text steering is a separate field (`instruction`) and is treated with
 * more care - see the providers.
 *
 * The panel renders the same four ids from its own list
 * (extension/src/panel/panel.js). Keep the two in step; an unknown id arriving
 * here is ignored rather than passed through.
 */

const TONES = {
  formal: {
    label: 'More formal',
    directive:
      'Raise the register. Use complete, measured sentences and no contractions. ' +
      'Keep it professional rather than stiff - this is a service provider writing to a client, not a legal notice.',
  },
  friendly: {
    label: 'Friendlier',
    directive:
      'Warm the tone up. Acknowledge the customer\'s position more personally and soften transitions, ' +
      'without becoming casual, chatty, or adding filler.',
  },
  shorter: {
    label: 'Shorter',
    directive:
      'Cut length substantially while keeping every concrete fact, hostname, and commitment. ' +
      'Remove throat-clearing and restatement, not information.',
  },
  detailed: {
    label: 'More detailed',
    directive:
      'Expand on the technical specifics already grounded in the ticket and reference material. ' +
      'Do not introduce any fact that is not supported by them.',
  },
};

/** @param {string[]} ids @returns {string[]} directives for the ids we know */
function directivesFor(ids = []) {
  return ids.map((id) => TONES[id]?.directive).filter(Boolean);
}

module.exports = { TONES, directivesFor };
