'use strict';

/**
 * Offline draft generator.
 *
 * Produces a grounded, correctly formatted draft with no API key and no network,
 * so the prototype demos anywhere. It composes the reply from the retrieved
 * techdoc's house template plus facts pulled out of the ticket thread - the same
 * inputs the real model provider receives.
 *
 * This is a stand-in for the model, not a shipping strategy: it can only answer
 * ticket shapes it has a builder for. The real provider generalizes; this one
 * degrades to a safe generic draft.
 */

const { sanitizeHtml } = require('../sanitize');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bullets(items) {
  return `<ul>\n${items.map((i) => `  <li>${i}</li>`).join('\n')}\n</ul>`;
}

/**
 * Pulls concrete remediation facts out of analyst notes. Real generation does
 * this with the model; here we look for the specific artifacts an EEC-style
 * thread leaves behind (IPs, hostnames, named subsystems).
 */
/** Every IP in the text, with its position, so we can match on proximity. */
function ipsWithPosition(text) {
  const out = [];
  const re = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ ip: m[0], at: m.index });
  return out;
}

/**
 * The IP sitting closest to a keyword. Proximity beats regex windows here:
 * two hosts described in one sentence will each match a loose window, but only
 * one is actually nearest to "DNS".
 */
function nearestIp(text, keyword, candidates, exclude = []) {
  const positions = [];
  const re = new RegExp(keyword, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) positions.push(m.index);
  if (!positions.length) return null;

  let best = null;
  for (const c of candidates) {
    if (exclude.includes(c.ip)) continue;
    for (const p of positions) {
      const d = Math.abs(c.at - p);
      if (!best || d < best.d) best = { ip: c.ip, d };
    }
  }
  return best ? best.ip : null;
}

function extractRemediatedItems(ctx) {
  const analystText = ctx.thread.filter((n) => n.role === 'analyst').map((n) => n.body).join(' ');
  const items = [];

  const candidates = ipsWithPosition(analystText);
  const iisIp = nearestIp(analystText, 'IIS', candidates);
  const dnsIp = nearestIp(analystText, 'DNS', candidates, iisIp ? [iisIp] : []);

  if (iisIp && /recreat/i.test(analystText)) {
    items.push(`VM corruption at <code>${esc(iisIp)}</code> (IIS) — server recreated and confirmed healthy`);
  }
  if (dnsIp && /(kernel panic|restore)/i.test(analystText)) {
    items.push(`Linux DNS server at <code>${esc(dnsIp)}</code> — kernel panic resolved, service restored`);
  }
  if (/backup|replicat/i.test(analystText)) {
    items.push('Backups and replication jobs — recreated for the new environment');
  }
  // Scope to the sentence that actually mentions the load balancer, so the
  // hostname and the service group are read from the same claim rather than
  // matched anywhere in the thread. Previously this keyed off one client's
  // hostname prefix, which meant the item only ever appeared for that client.
  const lbSentence = /([^.]*\b(?:load balancer|service group)\b[^.]*)\./i.exec(analystText);
  if (lbSentence) {
    const scope = lbSentence[1];
    const group = /\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\b/.exec(scope);
    const host = /\b([A-Z]{2,}[A-Z0-9]*\d[A-Z0-9]*)\b/.exec(scope.replace(group ? group[1] : '', ''));
    if (host) {
      items.push(
        `<code>${esc(host[1])}</code> — confirmed disabled from the ` +
        `${group ? `<code>${esc(group[1])}</code> ` : ''}load balancer group as expected`,
      );
    }
  }
  return items;
}

/** Per-topic builders, keyed by the techdoc that retrieval ranked first. */
const BUILDERS = {
  'KB-1042': (ctx, doc) => {
    const items = extractRemediatedItems(ctx);
    const body = [
      doc.replyTemplate.opener,
      items.length ? bullets(items) : '<p>All outstanding remediation items from the cutover have been closed.</p>',
      `<p>${doc.replyTemplate.closer}</p>`,
    ].join('\n');
    return { body, intent: 'transition_closure' };
  },

  'KB-0311': (ctx, doc) => {
    const msg = ctx.lastClientMessage ? ctx.lastClientMessage.body : '';
    const names = (msg.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || []).slice(0, 5);
    const steps = [
      'Confirm whether any of the affected users have recently replaced, reset, or upgraded their phone',
      'We will check the MFA appliance logs for a delivery attempt — no attempt logged confirms a stale device registration',
      'Verify push notifications are not being suppressed by battery optimization or notification settings on the handset',
    ];
    const body = [
      `<p>${doc.replyTemplate.opener}</p>`,
      '<p>Here is what we need to confirm to narrow it down:</p>',
      bullets(steps),
      names.length
        ? `<p>We will start by checking enrollment status for ${names.map((n) => `<b>${esc(n)}</b>`).join(', ')}.</p>`
        : '',
      `<p>${doc.replyTemplate.closer}</p>`,
    ].filter(Boolean).join('\n');
    return { body, intent: 'vpn_mfa_triage' };
  },

  'KB-0788': (ctx, doc) => {
    const alert = ctx.thread.find((n) => /fail/i.test(n.body));
    const vm = alert ? (/(?:VM|for)\s+([a-z0-9-]+_?[A-Z0-9-]*)/.exec(alert.body) || [])[1] : null;
    const facts = [
      `Failing job: <code>CHP-Nightly-Prod</code>${vm ? ` on <code>${esc(vm)}</code>` : ''} — snapshot creation error`,
      'Restore points prior to the failure window remain valid and are unaffected',
      'The failure is at snapshot creation, which means no data has been lost — the job could not start, rather than completing partially',
    ];
    const body = [
      `<p>${doc.replyTemplate.opener}</p>`,
      bullets(facts),
      '<p>The most common causes are an orphaned snapshot left on the VM, insufficient datastore headroom, or an out-of-date VMware tools install. We are working through those now.</p>',
      `<p>${doc.replyTemplate.closer}</p>`,
    ].join('\n');
    return { body, intent: 'backup_failure_status' };
  },

  'KB-0455': (ctx, doc) => {
    const msg = ctx.lastClientMessage ? ctx.lastClientMessage.body : '';
    const ip = (msg.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/) || [])[0];
    const port = (msg.match(/port\s+(\d{2,5})/i) || [])[1];
    const confirmed = [];
    if (ip) confirmed.push(`Source IP: <code>${esc(ip)}</code>`);
    if (port) confirmed.push(`Destination port: <code>${esc(port)}</code>`);
    const needed = [
      'Protocol (we are assuming TCP unless you tell us otherwise)',
      'The destination host the vendor needs to reach',
      'Whether this access should be permanent or time-bound to the integration test window',
    ];
    const body = [
      `<p>${doc.replyTemplate.opener}</p>`,
      confirmed.length ? `<p><b>Confirmed from your request:</b></p>\n${bullets(confirmed)}` : '',
      `<p><b>Still needed:</b></p>\n${bullets(needed)}`,
      '<p>We will scope the rule to the vendor source address specifically rather than opening it broadly.</p>',
      `<p>${doc.replyTemplate.closer}</p>`,
    ].filter(Boolean).join('\n');
    return { body, intent: 'firewall_change_intake' };
  },
};

/** Used when confidence is too low to assert anything substantive. */
function buildAbstain(ctx, confidence) {
  const asks = [
    'Which specific users or systems are affected, and roughly how many',
    'The times of day the slowness occurs, and whether it correlates with a particular task',
    'Whether anything changed on your side recently — new software, added users, changed workflows',
  ];
  const body = [
    `<p>Thanks for flagging this. Before we start changing anything I want to make sure we are chasing the right problem — the symptoms as described could point in a few different directions.</p>`,
    '<p>Could you help us narrow it down?</p>',
    bullets(asks),
    '<p>In parallel we will pull performance metrics for the affected host over the past week and see whether anything lines up with what your team is experiencing.</p>',
  ].join('\n');
  return { body, intent: 'insufficient_context' };
}

/**
 * Fallback when no topic-specific builder exists for the top-ranked techdoc.
 *
 * A doc that carries a `replyTemplate` gets its house opener and closer used
 * directly, which is what lets a new techdoc produce a usable draft without
 * anyone writing a bespoke builder for it. Only where fact extraction from the
 * thread genuinely matters is a builder worth adding.
 */
function buildGeneric(ctx, doc) {
  if (doc && doc.replyTemplate) {
    const asks = [
      'Confirm the details above are still accurate on your side',
      'Let us know of any constraint on timing we should work around',
    ];
    const body = [
      `<p>${doc.replyTemplate.opener}</p>`,
      bullets(asks),
      `<p>${doc.replyTemplate.closer}</p>`,
    ].join('\n');
    return { body, intent: `${doc.category.toLowerCase().replace(/[^a-z]+/g, '_')}_response` };
  }

  const body = [
    `<p>Thanks for reaching out. We have reviewed the details on this ticket and are working it now.</p>`,
    doc ? `<p>${esc(doc.title)} applies here and we are following that process.</p>` : '',
    '<p>We will follow up with a status update shortly.</p>',
  ].filter(Boolean).join('\n');
  return { body, intent: 'generic_acknowledgement' };
}

/* ---------------- tone presets ---------------- */

/**
 * Split a draft into its top-level blocks so tone transforms can operate on
 * whole paragraphs and lists rather than slicing through markup.
 *
 * Loose text between blocks is kept as its own segment. Some builders emit a
 * template opener as bare text rather than wrapping it in <p>, and a splitter
 * that only collected matched elements silently dropped the most important
 * sentence in the reply.
 */
function blocks(html) {
  const out = [];
  const re = /<(p|ul|ol|pre)\b[\s\S]*?<\/\1>/g;
  let last = 0;
  let match;

  while ((match = re.exec(html)) !== null) {
    const loose = html.slice(last, match.index).trim();
    if (loose) out.push(loose);
    out.push(match[0]);
    last = match.index + match[0].length;
  }

  const tail = html.slice(last).trim();
  if (tail) out.push(tail);
  return out.length ? out : [html];
}

const isList = (block) => /^<(ul|ol)\b/.test(block);

/**
 * Deterministic stand-ins for what the model does properly.
 *
 * These are honest about their own limits: they rearrange and reword text the
 * builders produced, which is enough to demo the control surface offline, but
 * they are not rewriting anything. Free-text instructions are refused outright
 * rather than silently ignored - see `generate()`.
 */
const TONE_TRANSFORMS = {
  shorter(html) {
    const [greeting, ...rest] = blocks(html);
    // Keep the opening statement and the itemized facts; drop the restatement
    // and sign-off, which is where the length actually is.
    return [greeting, rest.find((b) => !isList(b)), rest.find(isList)]
      .filter(Boolean)
      .join('\n');
  },

  formal(html) {
    return html
      .replace(/<p>Hi ([^,<]+),<\/p>/, '<p>Dear $1,</p>')
      .replace(/\bThanks for\b/g, 'Thank you for')
      .replace(/\bWe have\b/g, 'We have')
      .replace(/\bwe will go ahead and\b/g, 'we will proceed to')
      .replace(/\bjust let us know\b/gi, 'please advise')
      .replace(/\bHere is\b/g, 'Please find below');
  },

  friendly(html) {
    const parts = blocks(html);
    const warm = '<p>Thanks for bearing with us on this one — we appreciate your patience.</p>';
    return [parts[0], warm, ...parts.slice(1)].join('\n');
  },

  detailed(html) {
    return `${html}\n<p>If it would help, we can pull the full change record and supporting logs for each item above and attach them to this ticket.</p>`;
  },
};

/**
 * @returns {{html: string, intent: string, provider: string, instructionApplied?: boolean}}
 */
async function generate({ ctx, docs, confidence, tones = [], instruction = '', previousDraft = null }) {
  let html;
  let intent;

  if (previousDraft) {
    // Revising: work on what the analyst is actually looking at.
    html = previousDraft;
    intent = 'mock_revised';
  } else {
    const greeting = `<p>Hi ${esc(ctx.contactFirstName)},</p>`;

    let built;
    if (confidence.shouldAbstain) {
      built = buildAbstain(ctx, confidence);
    } else {
      const topDoc = docs.length ? docs[0].doc : null;
      const builder = topDoc && BUILDERS[topDoc.id];
      built = builder ? builder(ctx, topDoc) : buildGeneric(ctx, topDoc);
    }

    html = `${greeting}\n${built.body}`;
    intent = built.intent;
  }

  for (const tone of tones) {
    const transform = TONE_TRANSFORMS[tone];
    if (transform) html = transform(html);
  }

  return {
    html: sanitizeHtml(html),
    intent,
    provider: 'mock',
    // The offline generator has no model behind it, so it cannot honor an
    // arbitrary instruction. Reporting that lets the panel tell the analyst
    // plainly, instead of returning an unchanged draft that looks obeyed.
    instructionApplied: instruction ? false : true,
  };
}

module.exports = { generate, TONE_TRANSFORMS };
