'use strict';

/**
 * Read-only HTTP client for the SMC API.
 *
 * THE INVARIANT: this module issues GET and nothing else. There is no exported
 * function that posts, puts, patches, or deletes, and the request method is a
 * hardcoded constant rather than a parameter, so adding one is a visible edit
 * to this file rather than a new call site somewhere else.
 *
 * That is not only a product guarantee (One Pane drafts; a human sends). It is
 * an integration constraint: Cole's AI CTRL system audits SMC state on the
 * assumption that nothing external mutates it. A write from here would break
 * that assumption silently.
 *
 * The endpoint that posts a reply to a ticket is `POST /Note`. It is never
 * called from this codebase.
 */

const credentials = require('../credentials');

/** Fail rather than hang a panel on an unreachable or slow console. */
const REQUEST_TIMEOUT_MS = 20_000;

/** Hardcoded on purpose. See the invariant above. */
const METHOD = 'GET';

const trimSlashes = (value) => String(value || '').replace(/\/+$/, '');

/** An Error carrying the upstream HTTP status, so callers can tell 401 from 404. */
function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Read configuration at call time, not at module load.
 *
 * Load-time capture would freeze whatever the environment looked like when the
 * first require happened, which makes the diagnostics endpoint unable to report
 * a fix the operator just made. It also has to be per call because the token
 * is per caller: it comes from credentials.js, which hands back the token sent
 * with this request (or, in server mode only, SMC_API_PASS from .env).
 */
function config() {
  return {
    baseUrl: trimSlashes(process.env.SMC_API_BASE_URL),
    user: String(process.env.SMC_API_USER || '').trim(),
    pass: credentials.get('smcToken'),
  };
}

/** True when there is enough configuration to attempt a call. */
function isConfigured() {
  const { baseUrl, pass } = config();
  return Boolean(baseUrl && pass);
}

/**
 * Describe the configuration without revealing it.
 *
 * Returns the base URL and username - which are not secret and are exactly what
 * an operator needs to see to spot a typo - plus whether a key is present and
 * how long it is. Never the key itself.
 */
function describeConfig() {
  const { baseUrl, user, pass } = config();
  return {
    baseUrl: baseUrl || null,
    user: user || null,
    authScheme: user ? 'basic' : pass ? 'bearer' : null,
    keyPresent: Boolean(pass),
    keyLength: pass.length || 0,
  };
}

/**
 * Build the auth header.
 *
 * The SMC API Functions doc describes apiv2 as HTTP Basic with a username (its
 * examples default to `OSC`) and the API key as the password. A v3 host may
 * well use a bearer token instead, and we have not confirmed which applies.
 *
 * So the scheme follows the username: set `SMC_API_USER` and you get Basic,
 * leave it empty and you get Bearer. That makes switching a one-line change in
 * `.env` rather than a code edit, which matters while the correct scheme is
 * still an open question.
 */
function authHeader() {
  const { user, pass } = config();
  if (!pass) return null;
  if (!user) return `Bearer ${pass}`;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

/**
 * Strip anything credential-shaped out of text bound for a log or an error.
 *
 * Error paths are exactly where secrets leak: a failing request gets its
 * message printed, forwarded, and pasted into a chat window. The API key is
 * substituted by value because it can surface in a URL a redirect built or in
 * an upstream error that echoes the request.
 */
function redact(text) {
  const { pass } = config();
  let out = String(text == null ? '' : text);
  if (pass) out = out.split(pass).join('[REDACTED]');
  return out
    .replace(/(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//[REDACTED]@');
}

/**
 * Resolve a caller-supplied path against the configured base URL.
 *
 * Absolute URLs are rejected rather than followed. Path segments arrive from
 * request handlers, and a path that can become `https://somewhere-else/` is how
 * a credential gets sent to a host that was never configured.
 */
function resolveUrl(pathname, query) {
  const { baseUrl } = config();
  if (!baseUrl) throw new Error('SMC_API_BASE_URL is not set');

  const rel = String(pathname || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('//')) {
    throw new Error('SMC client takes a path, not an absolute URL');
  }

  const url = new URL(`${baseUrl}/${rel.replace(/^\/+/, '')}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  return url;
}

/**
 * Issue one read against the SMC API.
 *
 * Resolves to `{ status, url, data, raw }`. `data` is parsed JSON when the
 * response is JSON and `null` otherwise, with `raw` carrying the first slice of
 * the body either way - an HTML login page answering a JSON request is the most
 * likely failure here, and "Unexpected token <" tells an operator nothing.
 *
 * @param {string} pathname  Path relative to SMC_API_BASE_URL, e.g. `Ticket/3714201`
 * @param {object} [options]
 * @param {Record<string, string|number>} [options.query]
 */
async function smcGet(pathname, options = {}) {
  const auth = authHeader();
  if (!auth) throw new Error(credentials.missingMessage('smcToken'));

  const url = resolveUrl(pathname, options.query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: METHOD,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`SMC did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${url.host})`);
    }
    // Usually DNS, TLS, or no VPN route - all of which look identical from here.
    throw new Error(`Cannot reach ${url.host}: ${redact(err.message)}`);
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();
  const contentType = res.headers.get('content-type') || '';

  // A 302 to a login page is a credential problem wearing a routing costume.
  // `redirect: 'manual'` keeps it visible instead of following it into HTML.
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `SMC redirected (${res.status}) to ${redact(res.headers.get('location') || 'an unknown location')} `
        + '- usually an auth failure presenting as a login redirect.',
    );
  }

  let data = null;
  if (contentType.includes('json')) {
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      data = null;
    }
  }

  // v3 tokens are per-person and last about four hours, so an expired token is
  // the likeliest 401 by far - say that first, in words an analyst can act on.
  if (res.status === 401) {
    throw httpError(`SMC 401: ${credentials.rejectedMessage('smcToken', 'SMC')} `
      + 'v3 tokens expire after about 4 hours, so it has probably expired - paste a new one.', 401);
  }
  if (!res.ok) {
    const hint = res.status === 403
      ? ' - the token was accepted but is not allowed this endpoint (it may not be read-scoped for it)'
      : '';
    throw httpError(`SMC ${res.status} on ${METHOD} ${url.pathname}${hint}: ${redact(body).slice(0, 300)}`, res.status);
  }

  return {
    status: res.status,
    url: url.toString(),
    contentType,
    data,
    raw: redact(body).slice(0, 4000),
  };
}

module.exports = { smcGet, isConfigured, describeConfig, redact };
