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
import { MSG, STREAM_PORT } from '../shared/messages.js';

/**
 * Fail loudly rather than leaving the panel spinning on a hung backend.
 *
 * A draft is several model calls in series on the gateway (query expansion,
 * the relevance check, then the draft), usually 15-25 s, and the gateway's own
 * latency varies. 45 s cut off drafts that would have arrived; the server's
 * own per-call limit is 90 s, so this sits above one slow call.
 */
const REQUEST_TIMEOUT_MS = 120_000;

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
    if (err.name === 'AbortError') {
      throw new Error(`${new URL(url).host} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s - the AI gateway is probably slow right now`);
    }
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
  const { base, headers } = await onePaneTarget();
  return requestJson(`${base}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), ...headers },
  });
}

/** The One Pane backend URL and the analyst's credential headers, checked for transport. */
async function onePaneTarget() {
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
  return { base: backends.onePane, headers };
}

/**
 * A draft or Ask request that reports its stages as it runs.
 *
 * Asks the server for NDJSON (`progress: true`, see server/progress.js) and
 * forwards each progress line to the panel as it arrives, then the result.
 * A server too old to stream answers with plain JSON, which is handled as the
 * result straight away - the panel then just shows no stages.
 *
 * @param {string} path
 * @param {object} body
 * @param {(event: object) => void} onProgress
 * @param {AbortSignal} [cancel]  aborted when the panel goes away
 */
async function streamRequest(path, body, onProgress, cancel) {
  const { base, headers } = await onePaneTarget();
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  cancel?.addEventListener('abort', () => controller.abort());

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ ...body, progress: true }),
    });

    if (!/ndjson/i.test(res.headers.get('content-type') || '')) {
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch {
        throw new Error(`${new URL(url).host} returned a non-JSON response (${res.status})`);
      }
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    const handle = (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'progress') onProgress(msg);
      else if (msg.type === 'result') result = msg;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(handle);
    }
    handle(buffer + decoder.decode());

    if (!result) throw new Error(`${new URL(url).host} closed the connection before the result`);
    if (result.status >= 400) throw new Error((result.data && result.data.error) || `Request failed (${result.status})`);
    return result.data;
  } catch (err) {
    if (err.name === 'AbortError') {
      if (cancel?.aborted) throw new Error('Cancelled');
      throw new Error(`${new URL(url).host} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s - the AI gateway is probably slow right now`);
    }
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
    body: JSON.stringify(draftBody(payload)),
  });
}

function draftBody(payload) {
  return {
    ticketId: payload.ticketId,
    ticket: payload.ticket,
    tones: payload.tones || [],
    instruction: payload.instruction || '',
    previousDraft: payload.previousDraft || null,
  };
}

function askBody(payload) {
  return { ticketId: payload.ticketId, ticket: payload.ticket, question: payload.question };
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
    body: JSON.stringify(askBody(payload)),
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

/**
 * An analyst's vote on a cited SOP: was it relevant to this ticket? Metadata
 * only (ids, title, problem type, the vote). The server hides a page voted
 * down on this ticket, and learns across tickets of the same problem type.
 *
 * @param {{ticketId: string, docId: string, title: string, vote: 'up'|'down',
 *   verdict?: string, problem?: string, category?: string}} payload
 */
async function sendFeedback(payload) {
  return onePaneRequest('/api/feedback', {
    method: 'POST',
    body: JSON.stringify({
      ticketId: payload.ticketId,
      docId: payload.docId,
      title: payload.title,
      vote: payload.vote,
      verdict: payload.verdict || null,
      problem: payload.problem || null,
      category: payload.category || null,
    }),
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
  [MSG.SOURCE_FEEDBACK]: sendFeedback,
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

/** The requests that report progress, and how each is sent. */
const STREAMED = {
  [MSG.GENERATE_DRAFT]: { path: '/api/generate', body: draftBody },
  [MSG.ASK_AI_CTRL]: { path: '/api/ask', body: askBody },
};

/**
 * Drafts and Ask, with live stage updates for the panel. One request per
 * port. If the panel goes away (tab closed, page navigated) the port
 * disconnects and the request is cancelled rather than finished for nobody.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== STREAM_PORT) return;
  const cancel = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => { open = false; cancel.abort(); });
  const post = (msg) => { if (open) port.postMessage(msg); };

  port.onMessage.addListener((message) => {
    const route = STREAMED[message?.type];
    if (!route) {
      post({ kind: 'result', ok: false, error: `Unknown message type: ${message?.type}` });
      return;
    }
    const onProgress = ({ stage, label, state, detail, ms }) => post({
      kind: 'progress',
      event: {
        stage, label, state, detail, ms,
      },
    });
    streamRequest(route.path, route.body(message.payload || {}), onProgress, cancel.signal)
      .then((data) => post({ kind: 'result', ok: true, data }))
      .catch((err) => post({ kind: 'result', ok: false, error: err.message }));
  });
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
