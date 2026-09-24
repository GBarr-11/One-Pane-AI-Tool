'use strict';

/**
 * Whose credentials an upstream call spends.
 *
 * Every secret the server hands to Open WebUI, SMC, Confluence, or the Claude
 * API is read through `get()` here, never straight from `process.env`. That is
 * the whole point of this module: one place decides whether a key may come from
 * the server's own `.env`, so a shared deployment cannot quietly spend its
 * operator's keys on someone else's behalf.
 *
 * TWO MODES, set by ONEPANE_CREDENTIALS:
 *
 *   server   (default) Keys come from `.env`. A request may still supply its
 *            own, which then wins - so the extension's credential settings can
 *            be tested against a local server. This is the single-developer
 *            setup and it is what `npm start` on a laptop wants.
 *
 *   per-user The server holds no keys. Each request must carry the caller's
 *            own, as headers set by the extension's service worker, and a
 *            request without one gets an error telling the analyst to add it.
 *            `.env` secrets are ignored, with one opt-in exception: a shared
 *            Confluence service account (CONFLUENCE_SHARED_ACCOUNT=true), used
 *            only when the caller supplied no Confluence credential of their own.
 *
 * Request credentials live in an AsyncLocalStorage for the life of one API
 * call. They are never written anywhere: not to the activity log (which records
 * metadata only), not to status, not into an error message.
 */

const { AsyncLocalStorage } = require('async_hooks');

/**
 * Each credential: the request header that carries it, the `.env` variable
 * that backs it in server mode, and what to tell an analyst who has not set it.
 */
const CREDENTIALS = {
  owuiKey: {
    header: 'x-onepane-owui-key', env: 'OWUI_API_KEY', group: 'owui', label: 'Open WebUI API key',
  },
  smcToken: {
    header: 'x-onepane-smc-token', env: 'SMC_API_PASS', group: 'smc', label: 'SMC API token',
  },
  confluenceEmail: {
    header: 'x-onepane-confluence-email', env: 'CONFLUENCE_EMAIL', group: 'confluence', label: 'Confluence email',
  },
  confluenceToken: {
    header: 'x-onepane-confluence-token', env: 'CONFLUENCE_API_TOKEN', group: 'confluence', label: 'Confluence API token',
  },
  anthropicKey: {
    header: 'x-onepane-anthropic-key', env: 'ANTHROPIC_API_KEY', group: 'anthropic', label: 'Anthropic API key',
  },
};

const MODES = ['server', 'per-user'];

/** Longer than any real token (an SMC v3 JWT is ~2.4k), short enough to bound abuse. */
const MAX_LENGTH = 8192;

/** Printable ASCII, no spaces: these go straight into an upstream Authorization header. */
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

const store = new AsyncLocalStorage();

/**
 * The credential mode. Throws on anything unrecognized rather than guessing:
 * a typo like `peruser` silently meaning `server` would put the operator's
 * keys behind a shared deployment, which is exactly what this module prevents.
 */
function mode() {
  const raw = String(process.env.ONEPANE_CREDENTIALS || '').trim().toLowerCase();
  if (!raw) return 'server';
  if (!MODES.includes(raw)) {
    throw new Error(`ONEPANE_CREDENTIALS=${raw} is not a mode (use ${MODES.join(' or ')}).`);
  }
  return raw;
}

function sharedConfluence() {
  return String(process.env.CONFLUENCE_SHARED_ACCOUNT || '').trim().toLowerCase() === 'true';
}

/**
 * Pull the caller's credentials off a request.
 *
 * Returns `{ credentials, error }`. A malformed value is an error rather than
 * something to trim into shape: a stray newline in a pasted key would otherwise
 * surface as a baffling 401 from the upstream service.
 */
function fromHeaders(headers) {
  const credentials = {};
  for (const [name, spec] of Object.entries(CREDENTIALS)) {
    const raw = headers[spec.header];
    if (raw === undefined) continue;
    const value = String(Array.isArray(raw) ? raw[0] : raw).trim();
    if (!value) continue;
    if (value.length > MAX_LENGTH || !TOKEN_SHAPE.test(value)) {
      return { credentials: {}, error: `The ${spec.label} sent with this request is malformed - paste it again in One Pane's settings.` };
    }
    credentials[name] = value;
  }
  return { credentials, error: null };
}

/**
 * True when credentials on this request travelled over a channel that is
 * acceptable for them: loopback (the laptop setup) or HTTPS terminated in front
 * of this server (a deployment - the ingress sets X-Forwarded-Proto).
 *
 * The extension enforces the same rule before sending, so this is the second
 * line: it turns a misconfigured plain-HTTP deployment into a loud refusal
 * rather than a working service leaking keys in cleartext.
 */
function secureTransport(req) {
  const remote = String(req.socket && req.socket.remoteAddress || '');
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return proto === 'https';
}

/** Run `fn` with `credentials` as the caller's for everything it awaits. */
function run(credentials, fn) {
  return store.run(Object.freeze({ ...credentials }), fn);
}

function supplied() {
  return store.getStore() || {};
}

/** Did the caller supply any credential in this one's group? */
function callerSuppliedGroup(group) {
  const mine = supplied();
  return Object.entries(CREDENTIALS).some(([name, spec]) => spec.group === group && mine[name]);
}

/**
 * Where a credential would come from right now: 'request', 'server' (.env in
 * server mode), 'shared' (the opt-in Confluence service account), or null.
 *
 * Grouped credentials resolve together. A caller who sends a Confluence email
 * but no token gets neither half from `.env` - mixing their email with the
 * server's token would authenticate as nobody in particular.
 */
function source(name) {
  const spec = CREDENTIALS[name];
  if (!spec) throw new Error(`Unknown credential ${name}`);
  // First, so a mistyped mode surfaces on every call - not only once some
  // .env key happens to be set.
  const current = mode();

  if (callerSuppliedGroup(spec.group)) return supplied()[name] ? 'request' : null;

  const fromEnv = String(process.env[spec.env] || '').trim();
  if (!fromEnv) return null;
  if (current === 'server') return 'server';
  if (spec.group === 'confluence' && sharedConfluence()) return 'shared';
  return null;
}

/** The credential value for this request, or '' when there is none to use. */
function get(name) {
  const from = source(name);
  if (from === 'request') return supplied()[name];
  if (from === 'server' || from === 'shared') return String(process.env[CREDENTIALS[name].env]).trim();
  return '';
}

/** What to tell an analyst when a credential is missing. */
function missingMessage(name) {
  const spec = CREDENTIALS[name];
  if (mode() === 'per-user') {
    return `No ${spec.label} - add yours in One Pane's settings (right-click the One Pane icon, then Options).`;
  }
  return `No ${spec.label} - set ${spec.env} in .env, or add one in One Pane's settings.`;
}

/**
 * What to tell an analyst when the upstream rejected a credential. Names the
 * place the key actually came from, so they fix the right one.
 */
function rejectedMessage(name, service) {
  const spec = CREDENTIALS[name];
  const from = source(name);
  if (from === 'request') return `${service} rejected your ${spec.label} - check it in One Pane's settings.`;
  if (from === 'shared') return `${service} rejected the shared service account - tell whoever runs this One Pane server.`;
  return `${service} rejected the ${spec.label} - check ${spec.env} in .env.`;
}

/**
 * For status and diagnostics: the mode, and which credentials this request
 * could use and from where. Sources only - never a value, a length, or a prefix.
 */
function describe() {
  const sources = {};
  for (const name of Object.keys(CREDENTIALS)) sources[name] = source(name);
  return { mode: mode(), sharedConfluence: sharedConfluence(), sources };
}

module.exports = {
  CREDENTIALS,
  mode,
  fromHeaders,
  secureTransport,
  run,
  get,
  source,
  missingMessage,
  rejectedMessage,
  describe,
};
