'use strict';

/**
 * The one seam through which a development pack plugs into the server.
 *
 * Production installs nothing here. Tickets come from SMC or from the caller,
 * techdocs from Confluence, and drafts from a real provider - and nothing in
 * `server/` requires a fixture file. The mock app (`onepane-mock/`) installs a
 * pack at startup to supply the stand-ins it demos with: a ticket corpus, mock
 * techdocs and resolved tickets, and an offline provider.
 *
 * Keeping this to a single registry, rather than letting each module reach for
 * `onepane-mock/` itself, is what keeps the direction of dependency one-way:
 * the mock app knows about production, production never knows about the mock.
 *
 * @typedef {object} DevPack
 * @property {string} name
 * @property {{list: () => object[], get: (id: string) => object|null}} [tickets]
 * @property {object[]} [techdocs]         techdoc-shaped docs for the 'mock' KB source
 * @property {() => object[]} [precedent]  resolved tickets eligible as precedent
 * @property {Object<string, () => object>} [providers]  extra generation providers, lazily required
 * @property {string} [defaultProvider]    used when ONEPANE_PROVIDER is unset
 * @property {string} [asOf]               pinned "now" for pack tickets, whose dates are fixed
 * @property {{mount: string, dir: string}} [staticSite]  extra static site to serve
 */

/** @type {DevPack|null} */
let pack = null;

/** @param {DevPack} next */
function install(next) {
  if (!next || !next.name) throw new Error('A dev pack needs at least a name.');
  pack = Object.freeze({ ...next });
  return pack;
}

/** For tests that need to prove production behavior with no pack loaded. */
function uninstall() {
  pack = null;
}

/** @returns {DevPack|null} */
function active() {
  return pack;
}

/** A pack ticket, or null. Always null in production. */
function packTicket(id) {
  return pack && pack.tickets && id ? pack.tickets.get(String(id)) || null : null;
}

module.exports = {
  install, uninstall, active, packTicket,
};
