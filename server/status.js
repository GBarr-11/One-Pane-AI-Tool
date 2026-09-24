'use strict';

/**
 * One snapshot of how the server is wired, for the Control Center.
 *
 * Reports configuration PRESENCE, never secret values. A secret variable is
 * described as set or unset and nothing more - not its length, not a prefix.
 * Non-secret settings (base URLs, provider name, space keys) are shown as-is,
 * because "which host is this pointed at" is exactly what a dashboard is for.
 *
 * Everything here is local and synchronous: no network calls. The live probes
 * (SMC, Confluence, the model gateway) are separate endpoints the Control
 * Center calls on demand, so loading the page never costs an upstream request.
 */

const pkg = require('../package.json');
const devpack = require('./devpack');
const activity = require('./activity');
const { activeProviderName, availableProviders } = require('./generate');
const { kbSourceName } = require('./knowledge');
const { linksConfigured } = require('./links');
const smc = require('./smc/client');
const confluence = require('./confluence/client');
const credentials = require('./credentials');

const STARTED_AT = new Date();

/**
 * Every variable the server reads. `secret` ones are only ever reported as
 * set/unset. Keep in step with .env.example.
 */
const ENV_VARS = [
  { name: 'ONEPANE_CREDENTIALS', group: 'Credentials', secret: false, about: 'server (default) | per-user. per-user ignores the secrets below: every caller sends their own.' },
  { name: 'CONFLUENCE_SHARED_ACCOUNT', group: 'Credentials', secret: false, about: 'true = in per-user mode, callers without their own Confluence token use the .env one. Service account only.' },
  { name: 'ONEPANE_PROVIDER', group: 'Generation', secret: false, about: 'openwebui | claude. Unset means no provider - drafting is refused, not faked.' },
  { name: 'ONEPANE_MODEL', group: 'Generation', secret: false, about: 'Model ID override for the active provider.' },
  { name: 'OWUI_URL', group: 'Generation', secret: false, about: 'Open WebUI gateway, host plus /api.' },
  { name: 'OWUI_API_KEY', group: 'Generation', secret: true, about: 'Open WebUI key, server mode only. Per-user: each analyst adds their own in the extension.' },
  { name: 'ANTHROPIC_API_KEY', group: 'Generation', secret: true, about: 'Direct Anthropic key, for ONEPANE_PROVIDER=claude.' },
  { name: 'SMC_API_BASE_URL', group: 'SMC API', secret: false, about: 'SMC v3 API base (stage or production).' },
  { name: 'SMC_API_USER', group: 'SMC API', secret: false, about: 'Empty = Bearer (v3). Set = HTTP Basic (apiv2).' },
  { name: 'SMC_API_PASS', group: 'SMC API', secret: true, about: 'SMC token, server mode only. Short-lived and per-person on v3.' },
  { name: 'CONFLUENCE_SITE_URL', group: 'Knowledge base', secret: false, about: 'Atlassian site root, no /wiki.' },
  { name: 'CONFLUENCE_EMAIL', group: 'Knowledge base', secret: false, about: 'Account the API token belongs to.' },
  { name: 'CONFLUENCE_API_TOKEN', group: 'Knowledge base', secret: true, about: 'Atlassian API token, server mode (or the shared account). Read-only use.' },
  { name: 'CONFLUENCE_CLOUD_ID', group: 'Knowledge base', secret: false, about: 'Only for scoped tokens.' },
  { name: 'CONFLUENCE_SPACES', group: 'Knowledge base', secret: false, about: 'Space keys to search. Unset = every space the token sees.' },
  { name: 'CONFLUENCE_LABELS', group: 'Knowledge base', secret: false, about: 'Only pages with one of these labels.' },
  { name: 'ONEPANE_KB_SOURCE', group: 'Knowledge base', secret: false, about: 'auto | confluence. (mock only inside onepane-mock.)' },
  { name: 'SMC_BASE_URL', group: 'Links', secret: false, about: 'SMC web console, for ticket citation links.' },
  { name: 'ONEPANE_KB_BASE_URL', group: 'Links', secret: false, about: 'Techdoc link base for docs without their own URL.' },
  { name: 'HOST', group: 'Server', secret: false, about: 'Bind address. Defaults to 127.0.0.1 - keep it loopback.' },
  { name: 'PORT', group: 'Server', secret: false, about: 'Defaults to 3000.' },
];

/** Secret variables credentials.js will not use in the current mode. */
function ignoredSecrets() {
  if (credentials.mode() !== 'per-user') return new Set();
  const ignored = new Set();
  for (const spec of Object.values(credentials.CREDENTIALS)) {
    if (!(spec.group === 'confluence' && credentials.describe().sharedConfluence)) ignored.add(spec.env);
  }
  return ignored;
}

function envSnapshot() {
  const ignored = ignoredSecrets();
  return ENV_VARS.map((v) => {
    const raw = (process.env[v.name] || '').trim();
    return {
      ...v,
      set: Boolean(raw),
      value: v.secret || !raw ? null : raw,
      // Set in .env but deliberately unused: per-user mode spends callers' keys only.
      ignored: Boolean(raw) && ignored.has(v.name),
    };
  });
}

function hostOf(url) {
  try { return url ? new URL(url).host : null; } catch { return null; }
}

function sdkInstalled() {
  try {
    require.resolve('@anthropic-ai/sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * Provider wiring. In per-user mode the server holds no key by design, so
 * "configured" means the server side is ready (gateway set, SDK installed) and
 * keys arrive with each caller - `keyPresent` then says whether THIS request
 * carried one, which for the Control Center's own polling is always false.
 */
function providerStatus() {
  const active = activeProviderName();
  const perUser = credentials.mode() === 'per-user';
  const owuiUrl = (process.env.OWUI_URL || '').trim();
  const model = (process.env.ONEPANE_MODEL || '').trim() || null;
  const owuiKey = Boolean(credentials.get('owuiKey'));
  const anthropicKey = Boolean(credentials.get('anthropicKey'))
    || (!perUser && Boolean((process.env.ANTHROPIC_AUTH_TOKEN || '').trim()));
  return {
    active,
    requested: (process.env.ONEPANE_PROVIDER || '').trim() || null,
    available: availableProviders(),
    model,
    openwebui: {
      configured: Boolean(owuiUrl) && (perUser || owuiKey),
      gatewayHost: hostOf(owuiUrl),
      keyPresent: owuiKey,
    },
    claude: {
      configured: sdkInstalled() && (perUser || anthropicKey),
      keyPresent: anthropicKey,
      sdkInstalled: sdkInstalled(),
    },
  };
}

function csv(name) {
  return String(process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function buildStatus({ host, port } = {}) {
  const pack = devpack.active();
  const smcConfig = smc.describeConfig();
  const confConfig = confluence.describeConfig();
  const ext = activity.lastFrom('extension');

  return {
    server: {
      name: pkg.name,
      version: pkg.version,
      node: process.version,
      startedAt: STARTED_AT.toISOString(),
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      host: host || null,
      port: port || null,
      loopbackOnly: !host || host === '127.0.0.1' || host === 'localhost' || host === '::1',
    },
    mode: pack
      ? { kind: 'mock', pack: pack.name, mockConsole: pack.staticSite ? pack.staticSite.mount : null }
      : { kind: 'production', pack: null, mockConsole: null },
    credentials: {
      mode: credentials.mode(),
      sharedConfluence: credentials.describe().sharedConfluence,
    },
    provider: providerStatus(),
    knowledgeBase: {
      source: kbSourceName(),
      requested: (process.env.ONEPANE_KB_SOURCE || 'auto').toLowerCase(),
      confluence: {
        configured: confluence.isConfigured(),
        siteUrl: confConfig.siteUrl,
        email: confConfig.email,
        tokenType: confConfig.tokenType,
        tokenPresent: confConfig.tokenPresent,
        spaces: csv('CONFLUENCE_SPACES'),
        labels: csv('CONFLUENCE_LABELS'),
      },
    },
    smc: {
      configured: smc.isConfigured(),
      baseUrl: smcConfig.baseUrl,
      authScheme: smcConfig.authScheme,
      keyPresent: smcConfig.keyPresent,
      readOnly: true,
    },
    links: linksConfigured(),
    extension: {
      lastSeenAt: ext ? ext.at : null,
      lastRoute: ext ? ext.route : null,
    },
    activity: activity.summary(),
    env: envSnapshot(),
  };
}

/**
 * Live check of the model gateway. Cheap by design: Open WebUI's model list is
 * a GET that spends no tokens. The Claude API has no equivalent free call, so
 * for claude this reports configuration only rather than spending a request.
 */
async function probeProvider() {
  const name = activeProviderName();

  if (name === 'openwebui') return { provider: name, ...(await probeOwui()) };

  if (name === 'claude') {
    const p = providerStatus().claude;
    return {
      ok: p.configured && p.keyPresent,
      provider: name,
      note: 'Configuration check only - the Claude API has no free probe call.',
      error: !p.sdkInstalled ? '@anthropic-ai/sdk is not installed'
        : !p.keyPresent ? credentials.missingMessage('anthropicKey') : undefined,
    };
  }

  if (name === 'none') {
    return { ok: false, provider: name, error: 'No generation provider configured (ONEPANE_PROVIDER)' };
  }

  // A dev-pack provider (the offline mock) has nothing to reach.
  return { ok: true, provider: name, note: 'Offline provider from the dev pack - no network.' };
}

/**
 * The Open WebUI model list, with this caller's key. A GET that spends no
 * tokens, and a 401 on it means the key itself was refused.
 */
async function probeOwui() {
  const baseUrl = (process.env.OWUI_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'OWUI_URL is not set on this server' };
  const apiKey = credentials.get('owuiKey');
  if (!apiKey) return { ok: false, error: credentials.missingMessage('owuiKey') };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const ms = Date.now() - startedAt;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, ms, error: credentials.rejectedMessage('owuiKey', 'Open WebUI') };
    }
    if (!res.ok) return { ok: false, ms, error: `Gateway answered HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    const ids = (Array.isArray(body.data) ? body.data : []).map((m) => m && m.id).filter(Boolean);
    const model = (process.env.ONEPANE_MODEL || '').trim() || 'gpt-5.6-luna';
    return {
      ok: true, ms, modelCount: ids.length, model, modelListed: ids.includes(model),
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Gateway timed out after 8s' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SMC has no "who am I" call we know of, so the check is a lookup of a ticket
 * that does not exist. Only the status matters: 401 means the token was
 * refused, while 404 or 400 mean SMC got past authentication to look - which is
 * the token working. Never reads a real ticket.
 */
async function probeSmc() {
  if (!smc.describeConfig().baseUrl) return { ok: false, error: 'SMC_API_BASE_URL is not set on this server' };
  if (!credentials.get('smcToken')) return { ok: null, error: credentials.missingMessage('smcToken') };
  try {
    await smc.smcGet('tickets/0');
    return { ok: true, note: 'Token accepted.' };
  } catch (err) {
    if ([400, 403, 404].includes(err.status)) {
      return { ok: true, note: `Token accepted (SMC answered ${err.status} to a test lookup, which it only does after authenticating).` };
    }
    return { ok: false, error: err.message };
  }
}

async function probeConfluence() {
  const { siteUrl, email, token } = confluence.config();
  if (!siteUrl) return { ok: null, error: 'Confluence is not set up on this server yet (CONFLUENCE_SITE_URL).' };
  if (!email || !token) {
    return { ok: null, error: credentials.missingMessage(email ? 'confluenceToken' : 'confluenceEmail') };
  }
  try {
    const me = await confluence.confluenceGet('wiki/rest/api/user/current');
    return { ok: true, authenticatedAs: (me && (me.displayName || me.publicName)) || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Every service's verdict on the credentials this request would use, and where
 * each came from ('request', 'server', 'shared', or null). `ok: null` means
 * nothing to test - no credential, which is fine for an optional service.
 */
async function checkCredentials() {
  const { mode, sharedConfluence, sources } = credentials.describe();
  const [owui, smcResult, confluenceResult] = await Promise.all([probeOwui(), probeSmc(), probeConfluence()]);
  return {
    mode,
    sharedConfluence,
    owui: { source: sources.owuiKey, ...owui },
    smc: { source: sources.smcToken, ...smcResult },
    confluence: { source: sources.confluenceToken, ...confluenceResult },
  };
}

module.exports = {
  buildStatus, probeProvider, checkCredentials, ENV_VARS,
};
