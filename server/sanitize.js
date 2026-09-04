'use strict';

/**
 * Allowlist sanitizer for the limited HTML subset the SMC reply box renders.
 *
 * Model output is never trusted as HTML. Anything outside the allowlist is
 * escaped rather than stripped, so unexpected markup shows up visibly in the
 * draft instead of silently vanishing or executing.
 */

const ALLOWED_TAGS = new Set(['b', 'i', 'u', 'br', 'ul', 'ol', 'li', 'p', 'pre', 'code', 'strong', 'em']);
const VOID_TAGS = new Set(['br']);

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escapes every tag not on the allowlist, drops all attributes from allowed
 * tags (so no href/onclick/style can ride along), and closes anything the
 * model left open.
 */
function sanitizeHtml(input) {
  const src = String(input || '');
  const open = [];
  let out = '';
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out += escapeHtml(src.slice(i));
      break;
    }
    out += escapeHtml(src.slice(i, lt));

    const gt = src.indexOf('>', lt);
    if (gt === -1) {
      out += escapeHtml(src.slice(lt));
      break;
    }

    const raw = src.slice(lt, gt + 1);
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>$/.exec(raw);

    if (!m) {
      out += escapeHtml(raw);
    } else {
      const closing = m[1] === '/';
      const tag = m[2].toLowerCase();

      if (!ALLOWED_TAGS.has(tag)) {
        out += escapeHtml(raw);
      } else if (VOID_TAGS.has(tag)) {
        out += `<${tag}>`;
      } else if (closing) {
        const idx = open.lastIndexOf(tag);
        if (idx === -1) {
          out += escapeHtml(raw); // stray close tag
        } else {
          // Close anything left open inside this tag, innermost first.
          for (let k = open.length - 1; k >= idx; k--) out += `</${open[k]}>`;
          open.length = idx;
        }
      } else {
        out += `<${tag}>`; // attributes deliberately dropped
        open.push(tag);
      }
    }
    i = gt + 1;
  }

  for (let k = open.length - 1; k >= 0; k--) out += `</${open[k]}>`;
  return out;
}

/** Strips tags entirely - for plaintext previews and length checks. */
function toPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|ul|ol|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { sanitizeHtml, toPlainText, ALLOWED_TAGS };
