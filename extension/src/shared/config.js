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
};

/**
 * @typedef {object} OverlayState
 * @property {number} width
 * @property {number} height
 * @property {number} margin
 * @property {{x: number, y: number} | null} position  set once dragged
 * @property {boolean} open  remembered across page loads
 */

/** @type {OverlayState} */
export const DEFAULT_OVERLAY = {
  width: 380,
  height: 620,
  margin: 16,
  position: null,
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
