/**
 * The extension's entire network layer.
 *
 * Every request to either backend originates here. Because the worker holds
 * `host_permissions` for both origins, Chrome exempts these fetches from CORS -
 * which is why neither backend needs to grow a permissive `Access-Control-
 * Allow-Origin` just to be reachable from a ticket page.
 */

import {
  loadConfig, loadCredentials, CREDENTIAL_HEADERS, credentialsAllowedFor,
} from '../shared/config.js';
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
 * A request to the One Pane backend, carrying the analyst's own credentials.
 *
 * Only this backend gets them - never AI CTRL, which has its own auth. And
 * only over HTTPS or to this machine's loopback: the check happens here,
 * before anything is sent, so a mistyped `http://` backend never sees a key.
 *
 * @param {string} path  e.g. `/api/generate`
 * @param {object} [options]  fetch options
 */
async function onePaneRequest(path, options = {}) {
  const { backends } = await loadConfig();
  const creds = await loadCredentials();
  const headers = {};
  for (const [name, header] of Object.entries(CREDENTIAL_HEADERS)) {
    if (creds[name]) headers[header] = creds[name];
  }

  if (Object.keys(headers).length && !credentialsAllowedFor(backends.onePane)) {
    throw new Error(`Not sending your credentials to ${backends.onePane} - it is not HTTPS. `
      + 'Use an https:// backend URL in One Pane settings (http is only allowed for localhost).');
  }

  return requestJson(`${backends.onePane}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), ...headers },
  });
}

/**
 * Draft a reply for a ticket scraped out of the page.
 *
 * `ticket` carries the DOM-extracted ticket so the backend can draft for a
 * ticket it has never seen. The server resolves `ticketId` against SMC first
 * when the API is configured, then falls back to this inline ticket.
 *
 * `tones` and `instruction` carry the analyst's steering; `previousDraft` turns
 * the request into a revision of what they are already looking at rather than a
 * fresh draft. A "Suggest a next step" pill is not a separate parameter here -
 * clicking one just populates `instruction` with that suggestion's text, the
 * same as if the analyst had typed it themselves.
 *
 * @param {{ticketId: string, ticket: object, tones?: string[],
 *   instruction?: string, previousDraft?: string|null}} payload
 */
async function generateDraft(payload) {
  return onePaneRequest('/api/generate', {
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
 * "Suggest a next step" for the ticket currently on screen.
 *
 * Analyst-initiated (a button, not automatic) - unlike the rest of this
 * file's calls, the server-side default provider can make a real model call
 * here, so this must never fire on its own.
 *
 * @param {{ticketId: string, ticket: object}} payload
 */
async function getSuggestions(payload) {
  return onePaneRequest('/api/suggestions', {
    method: 'POST',
    body: JSON.stringify({
      ticketId: payload.ticketId,
      ticket: payload.ticket,
    }),
  });
}

/**
 * Ask a question about the ticket currently on screen.
 *
 * Placeholder for Cole's AI CTRL agent (see extension/README.md): that system
 * is role-aware and reads across tickets, alerts, and platform state, with its
 * own audit log. This calls One Pane's own `/api/ask` instead, which answers
 * from the same gateway the Draft tab uses, grounded only in this one ticket's
 * thread - real, but a narrower answer than "AI CTRL" implies. Swap this back
 * to his `/api/query` once that integration lands.
 *
 * @param {{ticketId: string, ticket: object, question: string}} payload
 */
async function askQuestion(payload) {
  return onePaneRequest('/api/ask', {
    method: 'POST',
    body: JSON.stringify({
      ticketId: payload.ticketId,
      ticket: payload.ticket,
      question: payload.question,
    }),
  });
}

/**
 * Clean up whatever text the analyst hands over - grammar, structure, and the
 * same tag allowlist everything else here renders into.
 *
 * @param {{text: string}} payload
 */
async function polishText(payload) {
  return onePaneRequest('/api/polish', {
    method: 'POST',
    body: JSON.stringify({ text: payload.text }),
  });
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

/**
 * The settings page's "Test" button: asks the backend to try each stored
 * credential against its service. Reports accepted / rejected / not set.
 */
async function checkCredentials() {
  return onePaneRequest('/api/credentials/check');
}

const HANDLERS = {
  [MSG.GENERATE_DRAFT]: generateDraft,
  [MSG.ASK_AI_CTRL]: askQuestion,
  [MSG.POLISH_TEXT]: polishText,
  [MSG.GET_SUGGESTIONS]: getSuggestions,
  [MSG.HEALTH]: health,
  [MSG.CHECK_CREDENTIALS]: checkCredentials,
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
