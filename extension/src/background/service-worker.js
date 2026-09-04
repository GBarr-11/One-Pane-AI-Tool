/**
 * The extension's entire network layer.
 *
 * Every request to either backend originates here. Because the worker holds
 * `host_permissions` for both origins, Chrome exempts these fetches from CORS -
 * which is why neither backend needs to grow a permissive `Access-Control-
 * Allow-Origin` just to be reachable from a ticket page.
 */

import { loadConfig } from '../shared/config.js';
import { resolveAuthContext } from '../shared/contracts.js';
import { MSG } from '../shared/messages.js';

/** Fail loudly rather than leaving the panel spinning on a hung backend. */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * @param {string} url
 * @param {object} [options]
 */
async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // A proxy or login page answering with HTML is the common cause here, and
      // "Unexpected token <" tells the analyst nothing useful.
      throw new Error(`${new URL(url).host} returned a non-JSON response (${res.status})`);
    }

    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${new URL(url).host} timed out`);
    if (err instanceof TypeError) throw new Error(`Cannot reach ${new URL(url).host} — is it running?`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Draft a reply for a ticket scraped out of the page.
 *
 * `ticket` carries the DOM-extracted ticket so the backend can draft for a
 * ticket it has never seen. The current prototype server only resolves
 * `ticketId` against its mock corpus, so until it accepts an inline ticket
 * (see extension/README.md) this path works only for the five demo tickets.
 *
 * `tones` and `instruction` carry the analyst's steering; `previousDraft` turns
 * the request into a revision of what they are already looking at rather than a
 * fresh draft.
 *
 * @param {{ticketId: string, ticket: object, tones?: string[],
 *   instruction?: string, previousDraft?: string|null}} payload
 */
async function generateDraft(payload) {
  const { backends } = await loadConfig();
  return requestJson(`${backends.onePane}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({
      ticketId: payload.ticketId,
      ticket: payload.ticket,
      tones: payload.tones || [],
      instruction: payload.instruction || '',
      previousDraft: payload.previousDraft || null,
    }),
  });
}

/**
 * Put a natural-language question to Cole's AI CTRL agent.
 *
 * Read-only by construction: `/api/query` only ever reads from his adapters.
 * The write-capable endpoint on that service is `/api/workflows/:id/execute`,
 * and One Pane deliberately never calls it.
 *
 * @param {{query: string}} payload
 * @returns {Promise<import('../shared/contracts.js').QueryResponse>}
 */
async function askAiCtrl(payload) {
  const { backends } = await loadConfig();
  const authContext = await resolveAuthContext();

  const data = await requestJson(`${backends.aiCtrl}/api/query`, {
    method: 'POST',
    body: JSON.stringify({ query: payload.query, authContext }),
  });

  // His agent reports failure in the body with a 200, so surface it as an error
  // rather than rendering an empty answer.
  if (data.success === false) throw new Error(data.error || 'AI CTRL could not answer that');
  return data;
}

/** Both backends, so the panel can say which half is down. */
async function health() {
  const { backends } = await loadConfig();

  const [onePane, aiCtrl] = await Promise.allSettled([
    requestJson(`${backends.onePane}/api/health`),
    requestJson(`${backends.aiCtrl}/health`),
  ]);

  return {
    onePane: onePane.status === 'fulfilled' ? onePane.value : { error: onePane.reason.message },
    aiCtrl: aiCtrl.status === 'fulfilled' ? aiCtrl.value : { error: aiCtrl.reason.message },
  };
}

const HANDLERS = {
  [MSG.GENERATE_DRAFT]: generateDraft,
  [MSG.ASK_AI_CTRL]: askAiCtrl,
  [MSG.HEALTH]: health,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
    return false;
  }

  handler(message.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  // Keeps the message channel open for the async reply above.
  return true;
});

/**
 * Toolbar icon: toggle the panel on the current tab.
 *
 * Fires only because the action declares no popup. On a page with no content
 * script - anything that is not a ticket view - there is nobody to receive
 * this, which is an expected outcome rather than an error worth surfacing.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_PANEL });
  } catch {
    // No One Pane panel on this page.
  }
});
