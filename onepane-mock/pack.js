'use strict';

/**
 * The onepane-mock dev pack: everything invented, in one place.
 *
 * Installed into the production server through `server/devpack.js` - by
 * `start.js` for the demo, and by the test suite for fixtures. Production never
 * requires this file, and nothing under `server/` knows it exists.
 *
 *   tickets     five curated SMC tickets (data/tickets.js)
 *   techdocs    the mock techdoc corpus, used when ONEPANE_KB_SOURCE resolves
 *               to 'mock' (data/knowledge-base.js)
 *   precedent   invented resolved tickets, handed only to the pack's own
 *               tickets, never to a live one (data/resolved-tickets.js)
 *   providers   the offline template generator, as provider 'mock'
 *   staticSite  the stand-in SMC console, mounted at /mock-smc/
 */

const path = require('path');
const { listTickets, getTicket, TICKETS } = require('./data/tickets');
const { KNOWLEDGE_BASE } = require('./data/knowledge-base');
const { eligiblePrecedent, RESOLVED_TICKETS } = require('./data/resolved-tickets');

/** The fixtures' dates are fixed, so "now" is too - see asOfFor() in server.js. */
const AS_OF = '2026-08-30T12:00:00Z';

const MOCK_CONSOLE_MOUNT = '/mock-smc/';

const PACK = {
  name: 'onepane-mock',
  tickets: { list: listTickets, get: getTicket },
  techdocs: KNOWLEDGE_BASE,
  precedent: eligiblePrecedent,
  providers: { mock: () => require('./provider/mock') },
  defaultProvider: 'mock',
  asOf: AS_OF,
  staticSite: { mount: MOCK_CONSOLE_MOUNT, dir: path.join(__dirname, 'smc-console') },
};

/** Install the pack into the server's registry. Idempotent. */
function installMockPack() {
  return require('../server/devpack').install(PACK);
}

/**
 * Synchronous retrieval over the mock corpus - techdocs, precedent, and the
 * confidence read - for tests that want the ranking without the async
 * knowledge-source switch in server/knowledge.js.
 */
function retrieveAll(ctx, opts = {}) {
  const { rankDocs, rankPrecedent, assessConfidence } = require('../server/retrieval');
  const docs = rankDocs(KNOWLEDGE_BASE, ctx, opts);
  const precedent = rankPrecedent(eligiblePrecedent(), ctx, opts);
  return { docs, precedent, confidence: assessConfidence(ctx, docs, precedent) };
}

module.exports = {
  PACK,
  AS_OF,
  MOCK_CONSOLE_MOUNT,
  installMockPack,
  retrieveAll,
  TICKETS,
  getTicket,
  KNOWLEDGE_BASE,
  RESOLVED_TICKETS,
  eligiblePrecedent,
};
