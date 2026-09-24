/**
 * Runtime configuration for every extension context.
 *
 * Endpoints are overridable from extension storage so the same build points at
 * localhost during development and at staging in a real deployment - a browser
 * extension has no environment variables, and hardcoding hostnames is what
 * forces a rebuild every time an environment moves.
 *
 * Two stores, on purpose:
 *   sync  - preferences worth following the analyst between machines
 *   local - where the overlay physically sits, which is about this screen and
 *           should not follow anyone to a laptop with a different resolution
 */

/** Shipped defaults: both backends running locally. */
export const DEFAULT_BACKENDS = {
  /** One Pane's own draft pipeline (server/server.js). */
  onePane: 'http://localhost:3000',
  /** Cole's AI CTRL Mastra service (apps/mastra, Express on 8080). */
  aiCtrl: 'http://localhost:8080',
};

/**
 * Staging targets, for reference when wiring the options page.
 *
 * aiCtrl comes from deploy/helm/.../values-staging.yaml in the AI CTRL repo.
 * onePane has no deployed home yet - it is still a local prototype.
 */
export const STAGING_BACKENDS = {
  onePane: null,
  aiCtrl: 'https://ai-assistant-staging.expedient.cloud',
};

const CONFIG_KEY = 'onePane.config';
const OVERLAY_KEY = 'onePane.overlay';

/**
 * @typedef {object} OnePaneConfig
 * @property {{onePane: string, aiCtrl: string}} backends
 * @property {boolean} askEnabled  Show the "Ask AI CTRL" tab.
 * @property {boolean} autoDraft   Draft as soon as the panel opens on a ticket.
 * @property {boolean} autoOpen    Drop the panel down on load, rather than
 *                                 waiting for the analyst to pull it down.
 * @property {'right'|'left'} side Which edge the panel hangs from.
 * @property {'light'|'dark'|'auto'} theme  'auto' follows the OS setting.
 */

/** @type {OnePaneConfig} */
export const DEFAULT_CONFIG = {
  backends: DEFAULT_BACKENDS,
  askEnabled: true,
  // Both off by default: an unrequested draft on every ticket burns tokens, and
  // a panel that opens itself over someone's work is a panel they switch off.
  autoDraft: false,
  autoOpen: false,
  side: 'right',
  theme: 'light',
};

/**
 * @typedef {object} OverlayState
 * @property {number} width
 * @property {number} height
 * @property {number} margin
 * @property {{x: number, y: number} | null} position  set once dragged
 * @property {number | null} launcherX  collapsed-launcher x along the top
 *                                      bar, set once dragged; null follows
 *                                      `side`/`margin` instead
 * @property {boolean} open  remembered across page loads
 */

/** @type {OverlayState} */
export const DEFAULT_OVERLAY = {
  width: 380,
  height: 620,
  margin: 16,
  position: null,
  launcherX: null,
  open: false,
};

/**
 * Preference storage, with a local fallback.
 *
 * `storage.sync` needs a signed-in browser profile. Edge users who have not
 * signed into a Microsoft account, and managed profiles where sync is disabled
 * by policy, get a rejection here - and settings silently reverting to defaults
 * every time the panel loads is a much worse failure than settings that simply
 * do not follow you between machines.
 */
async function prefs() {
  try {
    await chrome.storage.sync.get(CONFIG_KEY);
    return chrome.storage.sync;
  } catch {
    return chrome.storage.local;
  }
}

/** @returns {Promise<OnePaneConfig>} */
export async function loadConfig() {
  const store = await prefs();
  const stored = await store.get(CONFIG_KEY);
  const saved = stored[CONFIG_KEY] || {};
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    backends: { ...DEFAULT_BACKENDS, ...(saved.backends || {}) },
  };
}

/** @param {Partial<OnePaneConfig>} patch */
export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = {
    ...current,
    ...patch,
    backends: { ...current.backends, ...(patch.backends || {}) },
  };
  const store = await prefs();
  await store.set({ [CONFIG_KEY]: next });
  return next;
}

/**
 * The analyst's own upstream credentials, sent to the One Pane backend with
 * every request so it spends their keys rather than its operator's (see
 * server/credentials.js).
 *
 * `storage.local` only, never `sync`: a key should stay on the machine it was
 * pasted into, not follow a browser profile onto every device it signs into.
 * Read only by the service worker and the options page - never by a content
 * script, which runs inside SMC's page.
 *
 * @typedef {object} Credentials
 * @property {string} owuiKey          Open WebUI API key
 * @property {string} smcToken         SMC v3 token (expires after ~4 hours)
 * @property {string} confluenceEmail  Atlassian account email
 * @property {string} confluenceToken  Atlassian API token
 * @property {string} anthropicKey     only if the server runs the claude provider
 */
const CREDENTIALS_KEY = 'onePane.credentials';

/**
 * Header each credential travels in. Must match CREDENTIALS in
 * server/credentials.js.
 */
export const CREDENTIAL_HEADERS = {
  owuiKey: 'X-OnePane-OWUI-Key',
  smcToken: 'X-OnePane-SMC-Token',
  confluenceEmail: 'X-OnePane-Confluence-Email',
  confluenceToken: 'X-OnePane-Confluence-Token',
  anthropicKey: 'X-OnePane-Anthropic-Key',
};

/** @returns {Promise<Credentials>} */
export async function loadCredentials() {
  const stored = await chrome.storage.local.get(CREDENTIALS_KEY);
  const saved = stored[CREDENTIALS_KEY] || {};
  return Object.fromEntries(Object.keys(CREDENTIAL_HEADERS).map((k) => [k, String(saved[k] || '')]));
}

/**
 * Replace the stored credentials. Blank fields are dropped rather than stored
 * as empty strings, so "cleared" and "never set" look the same.
 *
 * @param {Partial<Credentials>} next
 */
export async function saveCredentials(next) {
  const clean = {};
  for (const k of Object.keys(CREDENTIAL_HEADERS)) {
    const value = String(next[k] || '').trim();
    if (value) clean[k] = value;
  }
  await chrome.storage.local.set({ [CREDENTIALS_KEY]: clean });
}

/**
 * True when credentials may be sent to this backend: HTTPS, or plain HTTP to
 * this machine's own loopback (a server started with `npm start` on the laptop,
 * or a `coder port-forward` tunnel). Anything else would put the keys on the
 * wire in cleartext.
 *
 * @param {string} backendUrl
 */
export function credentialsAllowedFor(backendUrl) {
  let url;
  try { url = new URL(backendUrl); } catch { return false; }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** @returns {Promise<OverlayState>} */
export async function loadOverlayState() {
  const stored = await chrome.storage.local.get(OVERLAY_KEY);
  return { ...DEFAULT_OVERLAY, ...(stored[OVERLAY_KEY] || {}) };
}

/** @param {Partial<OverlayState>} patch */
export async function saveOverlayState(patch) {
  const current = await loadOverlayState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [OVERLAY_KEY]: next });
  return next;
}
