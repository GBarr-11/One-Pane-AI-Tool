'use strict';

/**
 * The part of a techdoc a prompt needs, not the whole page.
 *
 * Pages reach the prompt cut at 6,000 characters from the top, which both
 * spends tokens on sections that do not apply (a Zerto upgrade MOP's
 * rollback appendix on a "will this affect my VPGs?" question) and can cut
 * off the section that does. Here the page is split into blocks, the opening
 * block is always kept because an SOP says what it is for up front, and the
 * rest are ranked by how many of the ticket's terms they contain. The best
 * blocks are kept in page order up to a budget, with "[...]" where text was
 * skipped.
 *
 * The budget follows the relevance verdict: a direct match gets room for its
 * procedure, and a partial match gets enough to be background.
 */

const { tokenize } = require('./retrieval');

const BUDGET = { direct: 3500, partial: 1200, unchecked: 2500 };

/** Blocks are merged up to about this size, so one bullet is not a block. */
const BLOCK_CHARS = 450;

function blocksOf(body) {
  const lines = String(body || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const blocks = [];
  let cur = '';
  for (const line of lines) {
    // A short line that is not a list item reads as a heading: start a new block there.
    const heading = line.length < 70 && !/^[-*\d]/.test(line) && !/[.:;,]$/.test(line);
    if (cur && (cur.length + line.length > BLOCK_CHARS || (heading && cur.length > 150))) {
      blocks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/**
 * @param {string} body  plain-text page body
 * @param {string} queryText  what the reply is about: the ticket's retrieval
 *   text, plus the analyst's question on the Ask tab
 * @param {'direct'|'partial'|'unchecked'} [verdict]
 * @returns {string}
 */
function relevantExcerpt(body, queryText, verdict = 'unchecked') {
  const text = String(body || '');
  const budget = BUDGET[verdict] || BUDGET.unchecked;
  if (text.length <= budget) return text;

  const blocks = blocksOf(text);
  const terms = new Set(tokenize(queryText));
  const scored = blocks.map((b, i) => {
    const words = tokenize(b);
    let hits = 0;
    for (const w of new Set(words)) if (terms.has(w)) hits++;
    // Density, so one long block does not win on length alone.
    return { i, b, score: hits / Math.sqrt(words.length || 1) };
  });

  const keep = new Set([0]);
  let used = blocks[0].length;
  for (const { i, b, score } of [...scored].sort((x, y) => y.score - x.score)) {
    if (keep.has(i) || score <= 0) continue;
    if (used + b.length > budget) continue;
    keep.add(i);
    used += b.length;
  }

  const out = [];
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > prev + 1) out.push('[...]');
    out.push(blocks[i].length > budget ? `${blocks[i].slice(0, budget)} [...]` : blocks[i]);
    prev = i;
  }
  if (prev < blocks.length - 1) out.push('[...]');
  return out.join('\n');
}

module.exports = { relevantExcerpt, blocksOf, BUDGET };
