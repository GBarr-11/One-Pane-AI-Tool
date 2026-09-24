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

const STARTED_AT = new Date();

/**
 * Every variable the server reads. `secret` ones are only ever reported as
 * set/unset. Keep in step with .env.example.
 */
const ENV_VARS = [
  { name: 'ONEPANE_PROVIDER', group: 'Generation', secret: false, about: 'openwebui | claude. Unset means no provider - drafting is refused, not faked.' },
  { name: 'ONEPANE_MODEL', group: 'Generation', secret: false, about: 'Model ID override for the active provider.' },
  { name: 'OWUI_URL', group: 'Generation', secret: false, about: 'Open WebUI gateway, host plus /api.' },
  { name: 'OWUI_API_KEY', group: 'Generation', secret: true, about: 'Open WebUI key. Server-side only.' },
  { name: 'ANTHROPIC_API_KEY', group: 'Generation', secret: true, about: 'Direct Anthropic key, for ONEPANE_PROVIDER=claude.' },
  { name: 'SMC_API_BASE_URL', group: 'SMC API', secret: false, about: 'SMC v3 API base (stage or production).' },
  { name: 'SMC_API_USER', group: 'SMC API', secret: false, about: 'Empty = Bearer (v3). Set = HTTP Basic (apiv2).' },
  { name: 'SMC_API_PASS', group: 'SMC API', secret: true, about: 'SMC token. Short-lived and per-person on v3.' },
  { name: 'CONFLUENCE_SITE_URL', group: 'Knowledge base', secret: false, about: 'Atlassian site root, no /wiki.' },
  { name: 'CONFLUENCE_EMAIL', group: 'Knowledge base', secret: false, about: 'Account the API token belongs to.' },
  { name: 'CONFLUENCE_API_TOKEN', group: 'Knowledge base', secret: true, about: 'Atlassian API token. Read-only use.' },
  { name: 'CONFLUENCE_CLOUD_ID', group: 'Knowledge base', secret: false, about: 'Only for scoped tokens.' },
  { name: 'CONFLUENCE_SPACES', group: 'Knowledge base', secret: false, about: 'Space keys to search. Unset = every space the token sees.' },
  { name: 'CONFLUENCE_LABELS', group: 'Knowledge base', secret: false, about: 'Only pages with one of these labels.' },
  { name: 'ONEPANE_KB_SOURCE', group: 'Knowledge base', secret: false, about: 'auto | confluence. (mock only inside onepane-mock.)' },
  { name: 'SMC_BASE_URL', group: 'Links', secret: false, about: 'SMC web console, for ticket citation links.' },
  { name: 'ONEPANE_KB_BASE_URL', group: 'Links', secret: false, about: 'Techdoc link base for docs without their own URL.' },
  { name: 'HOST', group: 'Server', secret: false, about: 'Bind address. Defaults to 127.0.0.1 - keep it loopback.' },
  { name: 'PORT', group: 'Server', secret: false, about: 'Defaults to 3000.' },
];

function envSnapshot() {
  return ENV_VARS.map((v) => {
    const raw = (process.env[v.name] || '').trim();
    return {
      ...v,
      set: Boolean(raw),
      value: v.secret || !raw ? null : raw,
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

function providerStatus() {
  const active = activeProviderName();
  const owuiUrl = (process.env.OWUI_URL || '').trim();
  const model = (process.env.ONEPANE_MODEL || '').trim() || null;
  return {
    active,
    requested: (process.env.ONEPANE_PROVIDER || '').trim() || null,
    available: availableProviders(),
    model,
    openwebui: {
      configured: Boolean(owuiUrl && (process.env.OWUI_API_KEY || '').trim()),
      gatewayHost: hostOf(owuiUrl),
      keyPresent: Boolean((process.env.OWUI_API_KEY || '').trim()),
    },
    claude: {
      configured: Boolean((process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '').trim()) && sdkInstalled(),
      keyPresent: Boolean((process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '').trim()),
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

  if (name === 'openwebui') {
    const baseUrl = (process.env.OWUI_URL || '').trim().replace(/\/+$/, '');
    const apiKey = (process.env.OWUI_API_KEY || '').trim();
    if (!baseUrl || !apiKey) return { ok: false, provider: name, error: 'OWUI_URL and OWUI_API_KEY must both be set' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const startedAt = Date.now();
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      const ms = Date.now() - startedAt;
      if (!res.ok) return { ok: false, provider: name, ms, error: `Gateway answered HTTP ${res.status}` };
      const body = await res.json().catch(() => ({}));
      const ids = (Array.isArray(body.data) ? body.data : []).map((m) => m && m.id).filter(Boolean);
      const model = (process.env.ONEPANE_MODEL || '').trim() || 'gpt-5.6-luna';
      return {
        ok: true, provider: name, ms, modelCount: ids.length, model, modelListed: ids.includes(model),
      };
    } catch (err) {
      return { ok: false, provider: name, error: err.name === 'AbortError' ? 'Gateway timed out after 8s' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  if (name === 'claude') {
    const p = providerStatus().claude;
    return {
      ok: p.configured,
      provider: name,
      note: 'Configuration check only - the Claude API has no free probe call.',
      error: p.configured ? undefined : (p.sdkInstalled ? 'No ANTHROPIC_API_KEY' : '@anthropic-ai/sdk is not installed'),
    };
  }

  if (name === 'none') {
    return { ok: false, provider: name, error: 'No generation provider configured (ONEPANE_PROVIDER)' };
  }

  // A dev-pack provider (the offline mock) has nothing to reach.
  return { ok: true, provider: name, note: 'Offline provider from the dev pack - no network.' };
}

module.exports = { buildStatus, probeProvider, ENV_VARS };
