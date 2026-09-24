'use strict';

/**
 * Deterministic, no-model read on "what's next" for a ticket.
 *
 * This used to be the whole recommended-replies feature. Now it is the
 * offline `mock` provider's implementation of the `suggest()` capability
 * (see onepane-mock/provider/mock.js) and the fallback a real provider's `suggest()`
 * degrades to when the model call fails or returns something unusable
 * (see generate.js's getSuggestions()) - a rule-based guess beats a dead
 * button for an analyst who clicked "Suggest a next step" because they are
 * stuck.
 *
 * It runs on the same context buildContext() already computes - who spoke
 * last, how long ago, whether retrieval found anything to ground a
 * substantive answer - so it costs nothing to fall back to: no model call,
 * just the retrieval this app already does for confidence.
 */

const SUGGESTIONS = {
  ask_for_details: {
    label: 'Ask for more details',
    directive:
      'Do not propose a fix or diagnosis. Ask the specific clarifying questions needed to narrow the ' +
      'problem down, and say what you are checking in parallel.',
  },
  status_update: {
    label: 'Share a status update',
    directive:
      'Summarize what has been confirmed so far and what is being done next. Do not claim the issue is resolved.',
  },
  confirm_resolved: {
    label: 'Confirm resolved',
    directive:
      'Confirm the issue is resolved, briefly recap what was done, and ask the client to confirm on their ' +
      'end before the ticket is closed.',
  },
  follow_up: {
    label: 'Follow up with client',
    directive:
      'Write a brief check-in: ask whether the client still needs help with this, or whether it is safe to close.',
  },
  acknowledge_urgent: {
    label: 'Acknowledge & escalate',
    directive:
      'Acknowledge the severity explicitly, confirm the team is actively engaged, and note that this has ' +
      'been escalated internally.',
  },
  initial_update: {
    label: 'Send initial update',
    directive:
      'Acknowledge the request was received, confirm what has been noted so far, and state the next step ' +
      'and rough timing if known.',
  },
};

/**
 * A loose lexical read on whether the client's own last message already
 * sounds like a close-out ("that fixed it", "thanks, all set") rather than an
 * open problem. Same inspectable, no-model approach as retrieval.js - good
 * enough to pick a pill, not asserted as fact in the draft itself.
 */
const CONFIRMATION_WORDS = /\b(thanks|thank you|resolved|that (fixed|worked|did it)|working now|all set|looks good|confirmed|no longer (seeing|an issue)|good to close)\b/i;

/**
 * @param {object} ctx        buildContext() output
 * @param {object} [confidence] retrieveAll().confidence - optional so this
 *   still degrades sanely if ever called without retrieval having run
 * @returns {{id: string, label: string, instruction: string}[]} 1-3 suggestions,
 *   most relevant first. `instruction` is what gets forwarded as the drafting
 *   instruction when the analyst clicks the pill - same free-text channel a
 *   real provider's model-generated suggestions use, so the panel does not
 *   need to know which kind produced a given suggestion.
 */
function suggestNextSteps(ctx, confidence) {
  const picks = [];
  const add = (id) => { if (picks.length < 3 && !picks.includes(id)) picks.push(id); };

  const severity = String(ctx.severity || '').trim().toLowerCase();
  const isUrgent = severity === 'critical' || severity === 'high';

  if (!ctx.lastClientMessage) {
    // Nothing from the client to confirm, ask about, or follow up on yet -
    // just an opening acknowledgement.
    add('initial_update');
  } else if (!ctx.awaitingOurReply) {
    // We spoke last; the ball is in the client's court.
    add('follow_up');
  } else {
    // The client spoke last - a reply is actually due.
    if (isUrgent) add('acknowledge_urgent');

    if (confidence && confidence.shouldAbstain) {
      add('ask_for_details');
    } else if (CONFIRMATION_WORDS.test(ctx.lastClientMessage.body || '')) {
      add('confirm_resolved');
    } else {
      add('status_update');
    }
  }

  return picks.map((id) => ({ id, label: SUGGESTIONS[id].label, instruction: SUGGESTIONS[id].directive }));
}

module.exports = { SUGGESTIONS, suggestNextSteps };
