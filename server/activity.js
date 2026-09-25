'use strict';

/**
 * Recent API activity, in memory, for the Control Center.
 *
 * METADATA ONLY. An entry records which route was hit, by what kind of caller,
 * how it went, and - for pipeline calls - the ticket id, provider,
 * confidence, and whether any SOP covered the ticket. It never records a request or response body, a query string, a
 * question, a draft, or a note: the Control Center is a place to see that the
 * wiring works, not a second copy of customer data. A ticket id is already
 * what an analyst reads off the console, and it is what makes an entry useful.
 *
 * Nothing is written to disk and nothing survives a restart. That is a choice,
 * not a gap: durable audit belongs in Cole's audit log (Postgres), not here.
 */

const MAX_ENTRIES = 200;

/** Routes the Control Center itself polls. Logging them would drown the rest. */
const QUIET_ROUTES = new Set(['/api/status', '/api/activity']);

/** @type {object[]} newest last */
const entries = [];
let seq = 0;

/** Collapse ids out of a path so entries group by route, not by ticket. */
function routeOf(pathname) {
  return pathname
    .replace(/^\/api\/tickets\/[^/]+/, '/api/tickets/:id')
    .replace(/^\/api\/smc\/tickets\/[^/]+/, '/api/smc/tickets/:id');
}

/**
 * Who called, as far as the request headers can say.
 *
 *   extension       the MV3 service worker (Origin: chrome-extension://...)
 *   control-center  this server's own dashboard
 *   mock-console    the onepane-mock SMC stand-in page
 *   direct          no Origin at all - curl, a script, the address bar
 *
 * Best effort, not authentication: headers are caller-supplied. A GET from the
 * service worker may arrive without an Origin and read as `direct`; the
 * extension's drafting calls are POSTs, which carry one.
 */
function callerOf(req, mockMount) {
  const origin = String(req.headers.origin || '');
  if (/^(chrome|moz|edge)-extension:\/\//.test(origin)) return 'extension';

  const referer = String(req.headers.referer || '');
  let refPath = '';
  try { refPath = referer ? new URL(referer).pathname : ''; } catch { /* malformed */ }
  if (mockMount && refPath.startsWith(mockMount)) return 'mock-console';
  if (origin || referer) return 'control-center';
  return 'direct';
}

/**
 * Start tracking one request. Returns the entry, so a route handler can attach
 * pipeline facts (`entry.ticketId = ...`) before the response finishes.
 */
function track(req, res, pathname, { mockMount } = {}) {
  const route = routeOf(pathname);
  const entry = {
    id: ++seq,
    at: new Date().toISOString(),
    method: req.method,
    route,
    caller: callerOf(req, mockMount),
    status: null,
    ms: null,
  };
  if (QUIET_ROUTES.has(route)) return entry;

  const startedAt = Date.now();
  res.on('finish', () => {
    entry.status = res.statusCode;
    entry.ms = Date.now() - startedAt;
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
  });
  return entry;
}

/** Newest first. */
function recent(limit = 50) {
  return entries.slice(-limit).reverse();
}

/** The most recent entry from a given caller, or null. */
function lastFrom(caller) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].caller === caller) return entries[i];
  }
  return null;
}

function summary() {
  const byRoute = {};
  let errors = 0;
  for (const e of entries) {
    byRoute[e.route] = (byRoute[e.route] || 0) + 1;
    if (e.status >= 500 || e.error) errors++;
  }
  return { total: entries.length, errors, byRoute };
}

module.exports = {
  track, recent, lastFrom, summary, routeOf, callerOf, MAX_ENTRIES,
};
