'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { listTickets, getTicket } = require('../data/tickets');
const { listDocs } = require('../data/knowledge-base');
const { generateDraft, activeProviderName } = require('./generate');
const { buildContext } = require('./context');
const { retrieveAll } = require('./retrieval');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
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

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // Keep path traversal out of the static handler.
  if (!filePath.startsWith(PUBLIC_DIR)) {
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

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, provider: activeProviderName() });
  }

  if (req.method === 'GET' && pathname === '/api/tickets') {
    return sendJson(res, 200, { tickets: listTickets(), provider: activeProviderName() });
  }

  if (req.method === 'GET' && /^\/api\/tickets\/[^/]+$/.test(pathname)) {
    const id = pathname.split('/').pop();
    const ticket = getTicket(id);
    if (!ticket) return sendJson(res, 404, { error: `Ticket ${id} not found` });
    return sendJson(res, 200, { ticket });
  }

  // Retrieval-only view: useful for tuning without spending a generation.
  if (req.method === 'GET' && /^\/api\/tickets\/[^/]+\/context$/.test(pathname)) {
    const id = pathname.split('/')[3];
    const ticket = getTicket(id);
    if (!ticket) return sendJson(res, 404, { error: `Ticket ${id} not found` });
    const ctx = buildContext(ticket);
    const { docs, precedent, confidence } = retrieveAll(ctx);
    return sendJson(res, 200, {
      context: ctx,
      retrieved: {
        docs: docs.map(({ doc, score }) => ({ id: doc.id, title: doc.title, score: +score.toFixed(2) })),
        precedent: precedent.map(({ ticket: t, score }) => ({ id: t.id, subject: t.subject, score: +score.toFixed(2) })),
      },
      confidence,
    });
  }

  if (req.method === 'POST' && pathname === '/api/generate') {
    const body = await readBody(req);

    // Prefer the mock corpus when the id is one it knows, so the demo tickets
    // keep their full thread. Otherwise accept the ticket the caller supplied -
    // that is how a ticket scraped from the real console, which this server has
    // never seen, gets drafted for.
    const ticket = getTicket(body.ticketId) || inlineTicket(body.ticket);
    if (!ticket) {
      return sendJson(res, 400, {
        error: `Unknown ticketId ${body.ticketId} and no usable ticket supplied. `
          + 'Send a `ticket` object with at least an id and a notes array.',
      });
    }

    try {
      const result = await generateDraft(ticket, {
        provider: body.provider,
        // Pinned so the demo's recency logic reads consistently against the mock dates.
        asOf: body.asOf || '2026-08-30T12:00:00Z',
        tones: body.tones,
        instruction: body.instruction,
        previousDraft: body.previousDraft,
      });
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/knowledge-base') {
    return sendJson(res, 200, { docs: listDocs() });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      sendJson(res, 500, { error: err.message });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`One Pane prototype running at http://localhost:${PORT}`);
    console.log(`Generation provider: ${activeProviderName()}`);
    if (activeProviderName() === 'mock') {
      console.log('  (set ONEPANE_PROVIDER=claude with an API key for real model generation)');
    }
  });
}

module.exports = { server };
