'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Must come before the pipeline requires below: links.js and providers/claude.js
// both read process.env at module load, so a later call would be too late.
require('./env').loadEnv();

const devpack = require('./devpack');
const activity = require('./activity');
const credentials = require('./credentials');
const { buildStatus, probeProvider, checkCredentials } = require('./status');
const { smcGet, isConfigured: smcConfigured, describeConfig: describeSmcConfig } = require('./smc/client');
const { mappingSummary } = require('./smc/adapter');
const { fetchTicket: fetchSmcTicket } = require('./smc/tickets');
const { generateDraft, getSuggestions, activeProviderName } = require('./generate');
const { answerQuestion } = require('./ask');
const { polishText } = require('./polish');
const { buildContext } = require('./context');
const { retrieveKnowledge, kbSourceName } = require('./knowledge');
const confluence = require('./confluence/client');
const { searchText: searchConfluence } = require('./confluence/search');

const PORT = Number(process.env.PORT || 3000);
// Loopback only. /api/generate is unauthenticated and, with a real provider,
// spends the gateway key on behalf of whoever calls it - that must not be
// anyone else on the same network.
const HOST = process.env.HOST || '127.0.0.1';
// The Control Center: this server's own dashboard, served at `/`. Production
// serves nothing else - the mock SMC console lives in onepane-mock/ and is only
// mounted when that pack is installed (see devpack.js).
const CONTROL_DIR = path.join(__dirname, '..', 'control-center');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, rootDir, relPath) {
  const rel = !relPath || relPath === '/' ? 'index.html' : relPath.replace(/^\/+/, '');
  const filePath = path.join(rootDir, rel);

  // Keep path traversal out of the static handler.
  if (!filePath.startsWith(rootDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

/**
 * Accept a ticket supplied by the caller rather than looked up locally.
 *
 * This arrives from a DOM adapter reading a live console, so every field is
 * optional and none of it is trusted. Missing fields are filled with empty
 * values rather than plausible-looking guesses: retrieval scores an absent
 * field as no signal, which is correct, whereas an invented one is scored as
 * real signal and quietly skews the draft.
 *
 * Returns null when there is not enough to work with, so the caller can say so
 * plainly instead of generating from nothing.
 */
function inlineTicket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.id && !raw.subject) return null;

  const notes = Array.isArray(raw.notes) ? raw.notes : [];

  return {
    id: String(raw.id || ''),
    subject: String(raw.subject || raw.title || ''),
    title: String(raw.title || raw.subject || ''),
    client: String(raw.client || ''),
    clientContact: String(raw.clientContact || ''),
    status: String(raw.status || ''),
    severity: String(raw.severity || ''),
    visibility: String(raw.visibility || 'All'),
    queue: String(raw.queue || ''),
    type: String(raw.type || ''),
    category: String(raw.category || ''),
    problem: String(raw.problem || ''),
    assignedTo: String(raw.assignedTo || ''),
    openedBy: String(raw.openedBy || ''),
    created: String(raw.created || ''),
    lastUpdated: String(raw.lastUpdated || ''),
    facility: String(raw.facility || ''),
    services: Array.isArray(raw.services) ? raw.services : [],
    assets: Array.isArray(raw.assets) ? raw.assets : [],
    relatedTickets: Array.isArray(raw.relatedTickets) ? raw.relatedTickets : [],
    notes: notes.map((n) => ({
      author: String(n.author || 'Unknown'),
      role: ['client', 'analyst', 'system', 'ai'].includes(n.role) ? n.role : 'system',
      visibility: String(n.visibility || 'All'),
      at: String(n.at || ''),
      body: String(n.body || ''),
    })),
  };
}

/**
 * Resolve the ticket a request means, shared by /api/generate and /api/ask.
 *
 * Resolution order:
 *   1. the dev pack's corpus, when onepane-mock is running - never in
 *      production, where no pack is installed
 *   2. a live SMC fetch by ticketId, when SMC is configured - this is real
 *      data and more complete/trustworthy than anything scraped off the DOM
 *   3. the inline ticket the caller supplied - a DOM scrape off a live
 *      console this server has never independently seen
 * (2) and (3) fall through to each other on failure rather than erroring
 * immediately, since a scraped ticket is still worth using if SMC is
 * unreachable or the id is not one it recognizes.
 */
async function resolveTicket(body) {
  let ticket = devpack.packTicket(body.ticketId);
  // Where the ticket came from decides where its precedent may come from:
  // mock tickets get mock precedent, live ones never do (see knowledge.js).
  let origin = ticket ? 'mock' : null;
  let smcWarnings = [];
  let smcMeta = null;
  let smcError = null;

  if (!ticket && body.ticketId && smcConfigured()) {
    try {
      const fetched = await fetchSmcTicket(body.ticketId);
      if (fetched.ticket) {
        ticket = fetched.ticket;
        origin = 'smc';
        smcWarnings = fetched.warnings;
        smcMeta = fetched.meta;
      } else {
        smcError = fetched.warnings.join('; ') || 'SMC returned no usable ticket';
      }
    } catch (err) {
      smcError = err.message;
    }
  }

  // Falling back to the page is fine, but not silently: an expired SMC token
  // would otherwise look like SMC working, with a thinner ticket behind it.
  let smcNotice = null;
  if (!ticket) {
    ticket = inlineTicket(body.ticket);
    if (ticket) {
      origin = 'inline';
      if (smcError) smcNotice = `Drafted from the page, not SMC: ${smcError}`;
    }
  }

  return {
    ticket, origin, smcWarnings, smcMeta, smcError, smcNotice,
  };
}

/**
 * The "now" a pipeline call reads recency against.
 *
 * Only a dev-pack ticket is pinned, to the pack's own date, because its
 * timestamps are fixed fixtures. A live ticket - from SMC or scraped off the
 * console - always reads against the real clock.
 */
function asOfFor(body, origin) {
  if (body.asOf) return body.asOf;
  const pack = devpack.active();
  return origin === 'mock' && pack && pack.asOf ? pack.asOf : undefined;
}

/** Pipeline facts for the activity log: ids and grades, never content. */
function noteResult(entry, ticket, origin, result) {
  entry.ticketId = ticket.id || null;
  entry.origin = origin;
  if (result) {
    entry.provider = result.provider || null;
    if (result.confidence) entry.confidence = result.confidence.level;
  }
}

function unknownTicketError(body, smcError) {
  return smcError
    ? `SMC lookup failed for ticket ${body.ticketId} (${smcError}) and no usable ticket supplied.`
    : `Unknown ticketId ${body.ticketId} and no usable ticket supplied. `
      + 'Send a `ticket` object with at least an id and a notes array.';
}

const NO_CORPUS = 'No local ticket corpus in production. Tickets come from SMC '
  + '(/api/smc/tickets/:id) or from the extension. The mock corpus lives in onepane-mock (npm run mock).';

async function handleApi(req, res, url, entry) {
  const { pathname } = url;
  const pack = devpack.active();

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      mode: pack ? 'mock' : 'production',
      provider: activeProviderName(),
      kbSource: kbSourceName(),
    });
  }

  // Control Center: local wiring snapshot, recent activity, live provider probe.
  if (req.method === 'GET' && pathname === '/api/status') {
    return sendJson(res, 200, buildStatus({ host: HOST, port: PORT }));
  }

  if (req.method === 'GET' && pathname === '/api/activity') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), activity.MAX_ENTRIES);
    return sendJson(res, 200, { entries: activity.recent(limit), summary: activity.summary() });
  }

  if (req.method === 'GET' && pathname === '/api/provider/health') {
    return sendJson(res, 200, await probeProvider());
  }

  // The extension's "Test" button: does each service accept the credentials
  // this request carries (or, in server mode, the .env ones)? One read-only
  // call per service; reports accepted/rejected and where the key came from,
  // never the key.
  if (req.method === 'GET' && pathname === '/api/credentials/check') {
    return sendJson(res, 200, await checkCredentials());
  }

  // The ticket list and lookup below serve the dev pack's corpus. Production
  // has no corpus to list, and says so rather than returning an empty one.
  if (req.method === 'GET' && pathname === '/api/tickets') {
    if (!pack || !pack.tickets) return sendJson(res, 404, { error: NO_CORPUS });
    return sendJson(res, 200, { tickets: pack.tickets.list(), provider: activeProviderName() });
  }

  if (req.method === 'GET' && /^\/api\/tickets\/[^/]+$/.test(pathname)) {
    if (!pack || !pack.tickets) return sendJson(res, 404, { error: NO_CORPUS });
    const id = pathname.split('/').pop();
    const ticket = devpack.packTicket(id);
    if (!ticket) return sendJson(res, 404, { error: `Ticket ${id} not found` });
    return sendJson(res, 200, { ticket });
  }

  // Retrieval-only view: useful for tuning without spending a generation.
  if (req.method === 'GET' && /^\/api\/tickets\/[^/]+\/context$/.test(pathname)) {
    if (!pack || !pack.tickets) return sendJson(res, 404, { error: NO_CORPUS });
    const id = pathname.split('/')[3];
    const ticket = devpack.packTicket(id);
    if (!ticket) return sendJson(res, 404, { error: `Ticket ${id} not found` });
    const ctx = buildContext(ticket, { asOf: pack.asOf });
    const {
      docs, precedent, confidence, kb,
    } = await retrieveKnowledge(ctx, { ticketOrigin: 'mock', asOf: pack.asOf });
    return sendJson(res, 200, {
      context: ctx,
      kb,
      retrieved: {
        docs: docs.map(({ doc, score }) => ({
          id: doc.id, title: doc.title, url: doc.url || null, score: +score.toFixed(2),
        })),
        precedent: precedent.map(({ ticket: t, score }) => ({ id: t.id, subject: t.subject, score: +score.toFixed(2) })),
      },
      confidence,
    });
  }

  if (req.method === 'POST' && pathname === '/api/generate') {
    const body = await readBody(req);
    const {
      ticket, origin, smcWarnings, smcMeta, smcError, smcNotice,
    } = await resolveTicket(body);

    if (!ticket) {
      return sendJson(res, 400, { error: unknownTicketError(body, smcError) });
    }

    try {
      const result = await generateDraft(ticket, {
        provider: body.provider,
        asOf: asOfFor(body, origin),
        ticketOrigin: origin,
        tones: body.tones,
        instruction: body.instruction,
        previousDraft: body.previousDraft,
      });
      noteResult(entry, ticket, origin, result);
      return sendJson(res, 200, {
        ...result,
        smcWarnings: smcWarnings.length ? smcWarnings : undefined,
        smcMeta: smcMeta || undefined,
        smcNotice: smcNotice || undefined,
      });
    } catch (err) {
      entry.error = true;
      return sendJson(res, 500, { error: err.message });
    }
  }

  // "Suggest a next step": analyst-initiated (a button in the panel, not
  // automatic), same ticket resolution as /api/generate and /api/ask. Tries a
  // real model call through getSuggestions() and falls back to the
  // deterministic heuristic on any failure - see server/generate.js.
  if (req.method === 'POST' && pathname === '/api/suggestions') {
    const body = await readBody(req);
    const {
      ticket, origin, smcWarnings, smcMeta, smcError, smcNotice,
    } = await resolveTicket(body);

    if (!ticket) {
      return sendJson(res, 400, { error: unknownTicketError(body, smcError) });
    }

    try {
      const result = await getSuggestions(ticket, {
        provider: body.provider,
        asOf: asOfFor(body, origin),
        ticketOrigin: origin,
      });
      noteResult(entry, ticket, origin, null);
      return sendJson(res, 200, {
        ...result,
        smcWarnings: smcWarnings.length ? smcWarnings : undefined,
        smcMeta: smcMeta || undefined,
        smcNotice: smcNotice || undefined,
      });
    } catch (err) {
      entry.error = true;
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Ask: a direct, single-ticket-grounded question to the same gateway the
  // Draft tab uses - a stand-in for Cole's AI CTRL agent until that
  // integration exists (see extension/README.md). Shares ticket resolution
  // with /api/generate so a live SMC ticket works here too.
  if (req.method === 'POST' && pathname === '/api/ask') {
    const body = await readBody(req);
    const {
      ticket, origin, smcWarnings, smcMeta, smcError, smcNotice,
    } = await resolveTicket(body);

    if (!ticket) {
      return sendJson(res, 400, { error: unknownTicketError(body, smcError) });
    }

    try {
      const result = await answerQuestion(ticket, body.question, {
        provider: body.provider,
        asOf: asOfFor(body, origin),
      });
      noteResult(entry, ticket, origin, result);
      return sendJson(res, 200, {
        ...result,
        smcWarnings: smcWarnings.length ? smcWarnings : undefined,
        smcMeta: smcMeta || undefined,
        smcNotice: smcNotice || undefined,
      });
    } catch (err) {
      entry.error = true;
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/knowledge-base') {
    if (!pack || !pack.techdocs) {
      return sendJson(res, 404, { error: 'Production has no local techdoc corpus - techdocs are searched live in Confluence (/api/confluence/search).' });
    }
    return sendJson(res, 200, {
      docs: pack.techdocs.map(({ id, title, category, updated }) => ({ id, title, category, updated })),
    });
  }

  // -------------------------------------------------------------------------
  // Polish: no ticket at all, just whatever text the caller hands over.
  if (req.method === 'POST' && pathname === '/api/polish') {
    const body = await readBody(req);

    try {
      const result = await polishText(body.text, { provider: body.provider });
      return sendJson(res, 200, result);
    } catch (err) {
      entry.error = true;
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Confluence: is the token loaded and accepted, and what does a search return?
  // Titles, links, and excerpts only - the same thing the wiki's own search
  // page shows to this account.
  if (req.method === 'GET' && pathname === '/api/confluence/health') {
    const config = confluence.describeConfig();
    if (!confluence.isConfigured()) {
      return sendJson(res, 200, {
        ok: false,
        config,
        kbSource: kbSourceName(),
        error: confluence.config().siteUrl
          ? credentials.missingMessage(confluence.config().email ? 'confluenceToken' : 'confluenceEmail')
          : 'CONFLUENCE_SITE_URL is not set on this server',
      });
    }
    try {
      const me = await confluence.confluenceGet('wiki/rest/api/user/current');
      return sendJson(res, 200, {
        ok: true,
        config,
        kbSource: kbSourceName(),
        authenticatedAs: me && (me.displayName || me.publicName || me.accountId),
        accountType: me && me.accountType,
        note: 'Credential accepted. Try /api/confluence/search?q=vpn+mfa',
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, config, kbSource: kbSourceName(), error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/confluence/search') {
    if (!confluence.isConfigured()) {
      return sendJson(res, 503, {
        error: confluence.config().siteUrl ? credentials.missingMessage('confluenceToken') : 'CONFLUENCE_SITE_URL is not set on this server',
      });
    }
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 300);
    if (!q) return sendJson(res, 400, { error: 'Add ?q=<search terms>' });

    try {
      const { siteUrl } = confluence.config();
      const { cql, results } = await searchConfluence(q);
      return sendJson(res, 200, {
        cql,
        results: results.map((r) => ({
          id: r.content && r.content.id,
          title: r.title || (r.content && r.content.title),
          space: r.resultGlobalContainer && r.resultGlobalContainer.title,
          lastModified: r.lastModified,
          url: r.url ? `${siteUrl}/wiki${r.url}` : null,
          excerpt: String(r.excerpt || '').replace(/@@@(end)?hl@@@/g, '').slice(0, 300),
        })),
      });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  // SMC discovery endpoints - TEMPORARY.
  //
  // These exist to answer one question: what does the real API actually return?
  // Until that is known, `smc/adapter.js` is a list of guesses. Delete this
  // block once the field map is confirmed; a raw passthrough to a production
  // ticketing API is not something to leave running.
  // -------------------------------------------------------------------------

  // Is the credential loaded, and does it work? Never reveals the key itself.
  if (req.method === 'GET' && pathname === '/api/smc/health') {
    const config = describeSmcConfig();
    if (!smcConfigured()) {
      return sendJson(res, 200, {
        ok: false,
        config,
        error: config.baseUrl ? credentials.missingMessage('smcToken') : 'SMC_API_BASE_URL is not set on this server',
      });
    }

    const probe = String(url.searchParams.get('path') || '').trim();
    if (!probe) {
      return sendJson(res, 200, {
        ok: true,
        config,
        note: 'Configured. Add ?path=Ticket/<id> to attempt a real call.',
      });
    }

    try {
      const { status, contentType } = await smcGet(probe);
      return sendJson(res, 200, { ok: true, config, probe: { path: probe, status, contentType } });
    } catch (err) {
      return sendJson(res, 200, { ok: false, config, probe: { path: probe }, error: err.message });
    }
  }

  // Fetch and normalize one real ticket.
  //
  // Defaults to `summary` - counts, field presence, and role distribution, with
  // no note bodies - so the mapping can be verified without pulling customer
  // content into a terminal or a log. `?full=1` returns the normalized ticket
  // itself, which is real customer data and should be treated as such.
  if (req.method === 'GET' && /^\/api\/smc\/tickets\/[^/]+$/.test(pathname)) {
    if (!smcConfigured()) {
      return sendJson(res, 503, {
        error: describeSmcConfig().baseUrl ? credentials.missingMessage('smcToken') : 'SMC_API_BASE_URL is not set on this server',
      });
    }

    const id = decodeURIComponent(pathname.split('/').pop());

    try {
      const { ticket, warnings, meta } = await fetchSmcTicket(id);
      if (!ticket) return sendJson(res, 404, { error: `No usable ticket ${id}`, warnings, meta });

      return sendJson(res, 200, {
        meta,
        warnings,
        summary: mappingSummary(ticket),
        ticket: url.searchParams.get('full') === '1' ? ticket : undefined,
      });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

/** Serve the dev pack's static site, if one is mounted and this path is under it. */
function servePackSite(req, res, pathname) {
  const pack = devpack.active();
  const site = pack && pack.staticSite;
  if (!site) return false;

  const mount = site.mount.replace(/\/+$/, '');
  if (pathname === mount) {
    // Relative asset URLs in the page only resolve under the trailing slash.
    res.writeHead(301, { Location: `${mount}/` }).end();
    return true;
  }
  if (!pathname.startsWith(`${mount}/`)) return false;

  serveStatic(res, site.dir, pathname.slice(mount.length));
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    const pack = devpack.active();
    const entry = activity.track(req, res, url.pathname, {
      mockMount: pack && pack.staticSite ? pack.staticSite.mount : null,
    });

    // The caller's own upstream credentials, if they sent any (see
    // credentials.js). Refused outright when they arrived over plain HTTP from
    // off this machine - the keys are already exposed by then, but a service
    // that works anyway is one nobody notices is leaking them.
    const { credentials: supplied, error: credError } = credentials.fromHeaders(req.headers);
    if (credError) {
      entry.error = true;
      return sendJson(res, 400, { error: credError });
    }
    if (Object.keys(supplied).length && !credentials.secureTransport(req)) {
      entry.error = true;
      return sendJson(res, 400, {
        error: 'Credentials were sent over plain HTTP. This One Pane server must be reached over HTTPS - '
          + 'change the backend URL in One Pane\'s settings, and replace any key sent this way.',
      });
    }

    credentials.run(supplied, () => handleApi(req, res, url, entry)).catch((err) => {
      entry.error = true;
      sendJson(res, 500, { error: err.message });
    });
    return;
  }
  if (servePackSite(req, res, url.pathname)) return;
  serveStatic(res, CONTROL_DIR, url.pathname);
});

function start({ port = PORT, host = HOST } = {}) {
  // Validate before listening: a mistyped ONEPANE_CREDENTIALS must stop the
  // server, not fall back to spending .env keys for every caller.
  const credMode = credentials.mode();
  return server.listen(port, host, () => {
    const pack = devpack.active();
    const provider = activeProviderName();
    console.log(`One Pane ${pack ? `(mock pack: ${pack.name})` : '(production)'} on http://localhost:${port}`);
    console.log(`  Control Center     http://localhost:${port}/`);
    if (pack && pack.staticSite) console.log(`  Mock SMC console   http://localhost:${port}${pack.staticSite.mount}`);
    console.log(`  Generation         ${provider}`);
    console.log(`  Knowledge base     ${kbSourceName()}`);
    console.log(`  Credentials        ${credMode === 'per-user'
      ? 'per-user - each caller sends their own keys; .env secrets are ignored'
      : 'server - .env keys, unless the caller sends their own'}`);
    if (provider === 'none') {
      console.log('  ! No provider configured - drafting is refused until ONEPANE_PROVIDER is set in .env');
    }
  });
}

if (require.main === module) start();

module.exports = { server, start };
