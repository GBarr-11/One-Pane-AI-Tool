'use strict';

/**
 * Read-only HTTP client for Confluence Cloud (the internal knowledge base).
 *
 * Same invariant as `server/smc/client.js`: GET and nothing else. The method is
 * a hardcoded constant and nothing here builds a write, so a page edit or a
 * comment can only ever arrive as a visible change to this file.
 *
 * AUTH is HTTP Basic with an Atlassian account email and an API token:
 *   CONFLUENCE_EMAIL      the account the token belongs to
 *   CONFLUENCE_API_TOKEN  from id.atlassian.com -> Security -> API tokens
 *
 * Normally each analyst sends their own pair from the extension, so a search
 * sees exactly what that analyst could see in the wiki. The opt-in shared
 * account (CONFLUENCE_SHARED_ACCOUNT=true) is different: every analyst sees what
 * IT sees, so it must be a service account scoped to the SOP spaces, never a
 * person with access to restricted pages.
 *
 * TWO HOSTS, depending on the token type:
 *   classic token -> https://<site>.atlassian.net/wiki/...
 *   scoped token  -> https://api.atlassian.com/ex/confluence/<cloudId>/wiki/...
 * Set CONFLUENCE_CLOUD_ID to use the second. Page links shown to the analyst
 * always use the site URL either way.
 */

const credentials = require('../credentials');

const REQUEST_TIMEOUT_MS = 15_000;

/** Hardcoded on purpose. See the invariant above. */
const METHOD = 'GET';

const trimSlashes = (value) => String(value || '').trim().replace(/\/+$/, '');

/**
 * Read at call time so the health endpoint reflects a fix without a restart,
 * and because the email/token pair is per caller (credentials.js): the pair sent
 * with this request, else .env in server mode, else the opt-in shared account.
 */
function config() {
  // Tolerate a pasted `.../wiki` or `.../wiki/home` - the paths below add it.
  const siteUrl = trimSlashes(process.env.CONFLUENCE_SITE_URL).replace(/\/wiki(\/.*)?$/, '');
  const cloudId = String(process.env.CONFLUENCE_CLOUD_ID || '').trim();
  return {
    siteUrl,
    cloudId,
    apiBase: cloudId ? `https://api.atlassian.com/ex/confluence/${encodeURIComponent(cloudId)}` : siteUrl,
    email: credentials.get('confluenceEmail'),
    token: credentials.get('confluenceToken'),
  };
}

function isConfigured() {
  const { siteUrl, email, token } = config();
  return Boolean(siteUrl && email && token);
}

/** Enough to spot a typo, never the token. */
function describeConfig() {
  const { siteUrl, cloudId, apiBase, email, token } = config();
  return {
    siteUrl: siteUrl || null,
    apiBase: apiBase || null,
    tokenType: cloudId ? 'scoped (api.atlassian.com gateway)' : 'classic (site URL)',
    email: email || null,
    tokenPresent: Boolean(token),
    tokenLength: token.length || 0,
  };
}

function authHeader() {
  const { email, token } = config();
  if (!email || !token) return null;
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

/** Strip the token and any auth header out of text bound for an error. */
function redact(text) {
  const { token } = config();
  let out = String(text == null ? '' : text);
  if (token) out = out.split(token).join('[REDACTED]');
  return out.replace(/(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]');
}

/**
 * Resolve a path against the API base. Absolute URLs are refused: a `next`
 * link or a caller-supplied path that points elsewhere must never receive the
 * Authorization header.
 */
function resolveUrl(pathname, query) {
  const { apiBase } = config();
  if (!apiBase) throw new Error('CONFLUENCE_SITE_URL is not set');

  const rel = String(pathname || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//')) {
    throw new Error('Confluence client takes a path, not an absolute URL');
  }

  const url = new URL(`${apiBase}/${rel.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * One read against Confluence. Resolves to the parsed JSON body.
 *
 * @param {string} pathname  e.g. `wiki/rest/api/search`
 * @param {Record<string, string|number>} [query]
 */
async function confluenceGet(pathname, query) {
  const auth = authHeader();
  if (!auth) {
    throw new Error(credentials.missingMessage(config().email ? 'confluenceToken' : 'confluenceEmail'));
  }

  const url = resolveUrl(pathname, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: METHOD,
      redirect: 'manual',
      signal: controller.signal,
      headers: { Authorization: auth, Accept: 'application/json' },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Confluence did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${url.host})`);
    }
    throw new Error(`Cannot reach ${url.host}: ${redact(err.message)}`);
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();

  // Atlassian answers a bad credential on some routes with a redirect to login.
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Confluence redirected (${res.status}) - usually a bad email/token pair or SSO enforcement.`);
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(`Confluence 401: ${credentials.rejectedMessage('confluenceToken', 'Confluence')} `
        + '(The email must be the account the token belongs to; a scoped token also needs CONFLUENCE_CLOUD_ID on the server.)');
    }
    const hint = {
      403: ' - the token is valid but lacks permission or scope for this endpoint',
      404: ' - not found, or not visible to this account',
    }[res.status] || '';
    throw new Error(`Confluence ${res.status} on ${url.pathname}${hint}: ${redact(body).slice(0, 300)}`);
  }

  try {
    return body ? JSON.parse(body) : null;
  } catch {
    // An HTML page answering a JSON request is almost always an SSO interstitial.
    throw new Error(`Confluence returned non-JSON from ${url.pathname}: ${redact(body).slice(0, 200)}`);
  }
}

module.exports = { confluenceGet, isConfigured, describeConfig, config, redact };
