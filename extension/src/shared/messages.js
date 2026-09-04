/**
 * The content script's only channel to the network.
 *
 * Nothing in the page context ever calls fetch() directly. Routing every
 * request through the service worker keeps credentials out of a page we do not
 * control, sidesteps SMC's own CSP, and means the origin our backends have to
 * allow is a stable `chrome-extension://<id>` rather than whatever host SMC
 * happens to be served from.
 */

export const MSG = {
  GENERATE_DRAFT: 'generate-draft',
  ASK_AI_CTRL: 'ask-ai-ctrl',
  HEALTH: 'health',
  /** Background -> content script: the toolbar icon was clicked. */
  TOGGLE_PANEL: 'toggle-panel',
};

/**
 * Send a message to the service worker and unwrap its reply.
 *
 * The worker always answers `{ok, data}` or `{ok: false, error}` so callers get
 * a thrown Error rather than having to check a flag at every call site.
 *
 * @param {string} type one of MSG
 * @param {object} [payload]
 */
export async function sendToBackground(type, payload = {}) {
  const reply = await chrome.runtime.sendMessage({ type, payload });

  // A worker that threw before responding leaves `reply` undefined.
  if (!reply) throw new Error('One Pane background worker did not respond');
  if (!reply.ok) throw new Error(reply.error || 'Request failed');

  return reply.data;
}
