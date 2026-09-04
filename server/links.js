'use strict';

/**
 * Turns a cited source into a link an analyst can actually click.
 *
 * A citation the analyst cannot open in one click is a citation they will not
 * check, and an unchecked citation is worse than none - it lends confidence
 * without supporting it. So the panel links every source it can.
 *
 * Base URLs come from the environment because they differ per deployment and
 * neither is known yet. When one is unset the source is still shown, just as
 * plain text: a missing link should degrade the citation, never hide it.
 */

const trim = (value) => String(value || '').replace(/\/+$/, '');

const SMC_BASE_URL = trim(process.env.SMC_BASE_URL);
const KB_BASE_URL = trim(process.env.ONEPANE_KB_BASE_URL);

/**
 * @param {string} id SMC ticket number
 * @returns {string|null}
 */
function ticketUrl(id) {
  if (!SMC_BASE_URL || !id) return null;
  return `${SMC_BASE_URL}/tickets/${encodeURIComponent(id)}`;
}

/**
 * Techdocs carry their own `url` once the corpus comes from a real
 * knowledgebase; the template is only a fallback for the mock corpus.
 *
 * @param {{id: string, url?: string}} doc
 * @returns {string|null}
 */
function techdocUrl(doc) {
  if (doc?.url) return doc.url;
  if (!KB_BASE_URL || !doc?.id) return null;
  return `${KB_BASE_URL}/${encodeURIComponent(doc.id)}`;
}

/** Whether links are configured at all, so the panel can explain their absence. */
function linksConfigured() {
  return { tickets: Boolean(SMC_BASE_URL), techdocs: Boolean(KB_BASE_URL) };
}

module.exports = { ticketUrl, techdocUrl, linksConfigured };
