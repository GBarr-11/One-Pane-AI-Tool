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
  POLISH_TEXT: 'polish-text',
  GET_SUGGESTIONS: 'get-suggestions',
  /** Panel -> worker: an analyst's thumbs up/down on a cited SOP. */
  SOURCE_FEEDBACK: 'source-feedback',
  HEALTH: 'health',
  /** Options page -> worker: test the stored credentials against the backend. */
  CHECK_CREDENTIALS: 'check-credentials',
  /** Background -> content script: the toolbar icon was clicked. */
  TOGGLE_PANEL: 'toggle-panel',
};

/**
 * Port name for requests that report progress while they run (drafts and Ask).
 * A one-shot message can only answer once, so these use a long-lived port:
 * content script -> worker: {type, payload}; worker -> content script:
 * {kind: 'progress', event} any number of times, then one
 * {kind: 'result', ok, data | error}.
 */
export const STREAM_PORT = 'onepane-stream';

/** What the panel shows once this tab's content script has lost the extension. */
export const RELOADED_MESSAGE = 'One Pane was updated or reloaded - refresh this page to reconnect.';

/**
 * Whether this content script is still connected to the extension.
 *
 * Reloading or updating the extension orphans the content script already
 * running in an open SMC tab: its panel still draws, but `chrome.runtime.id`
 * goes away and every `chrome.*` call throws "Extension context invalidated".
 * Only a page refresh reconnects it.
 */
export function extensionAlive() {
  try {
    return Boolean(globalThis.chrome?.runtime?.id);
  } catch {
    return false;
  }
}

/** Whether an error is Chrome reporting the orphaned-content-script case. */
export function isContextInvalidated(err) {
  return /Extension context invalidated/i.test(String(err?.message || err || ''));
}

/**
 * Send a message to the service worker and unwrap its reply.
 *
 * The worker always answers `{ok, data}` or `{ok: false, error}` so callers get
 * a thrown Error rather than having to check a flag at every call site. An
 * orphaned content script gets RELOADED_MESSAGE instead of Chrome's raw error,
 * because that is what the analyst can act on.
 *
 * @param {string} type one of MSG
 * @param {object} [payload]
 */
export async function sendToBackground(type, payload = {}) {
  if (!extensionAlive()) throw new Error(RELOADED_MESSAGE);

  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type, payload });
  } catch (err) {
    if (isContextInvalidated(err)) throw new Error(RELOADED_MESSAGE);
    throw err;
  }

  // A worker that threw before responding leaves `reply` undefined.
  if (!reply) throw new Error('One Pane background worker did not respond');
  if (!reply.ok) throw new Error(reply.error || 'Request failed');

  return reply.data;
}

/**
 * Like sendToBackground(), for a request that reports its stages as it runs:
 * `onProgress` gets each `{stage, label, state, detail, ms}` event, and the
 * promise settles with the final result.
 *
 * @param {string} type  MSG.GENERATE_DRAFT or MSG.ASK_AI_CTRL
 * @param {object} payload
 * @param {(event: object) => void} [onProgress]
 */
export function streamFromBackground(type, payload, onProgress) {
  if (!extensionAlive()) return Promise.reject(new Error(RELOADED_MESSAGE));

  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: STREAM_PORT });
    } catch (err) {
      reject(isContextInvalidated(err) ? new Error(RELOADED_MESSAGE) : err);
      return;
    }

    let settled = false;
    port.onMessage.addListener((msg) => {
      if (msg?.kind === 'progress') {
        try { onProgress?.(msg.event); } catch { /* the panel's problem, not the request's */ }
        return;
      }
      if (msg?.kind === 'result') {
        settled = true;
        port.disconnect();
        if (msg.ok) resolve(msg.data);
        else reject(new Error(msg.error || 'Request failed'));
      }
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      reject(new Error(extensionAlive() ? 'One Pane background worker stopped before answering' : RELOADED_MESSAGE));
    });
    port.postMessage({ type, payload });
  });
}
