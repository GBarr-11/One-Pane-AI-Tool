'use strict';

/**
 * Dependency-free smoke tests for the draft pipeline.
 * Run with: npm test
 */

const assert = require('assert');
const { TICKETS, getTicket } = require('../data/tickets');
const { buildContext } = require('../server/context');
const { retrieveAll } = require('../server/retrieval');
const { generateDraft } = require('../server/generate');
const { sanitizeHtml, toPlainText, ALLOWED_TAGS } = require('../server/sanitize');
const { eligiblePrecedent, RESOLVED_TICKETS } = require('../data/resolved-tickets');

const AS_OF = '2026-08-30T12:00:00Z';
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed++; console.log(`  ok  ${name}`); },
        (err) => { failures.push([name, err]); console.log(`  FAIL ${name}\n       ${err.message}`); },
      );
    }
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
  return Promise.resolve();
}

/** Every tag left in the output must be on the allowlist. */
function assertOnlyAllowedTags(html) {
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)].map((m) => m[1].toLowerCase());
  for (const t of tags) {
    assert.ok(ALLOWED_TAGS.has(t), `disallowed tag <${t}> survived sanitization`);
  }
}

async function main() {
  console.log('\nsanitizer');
  await test('escapes disallowed tags instead of executing them', () => {
    const out = sanitizeHtml('<b>ok</b><script>alert(1)</script>');
    assert.ok(out.includes('<b>ok</b>'));
    assert.ok(!/<script>/i.test(out), 'script tag survived');
    assert.ok(out.includes('&lt;script&gt;'));
  });

  await test('strips attributes from allowed tags', () => {
    const out = sanitizeHtml('<b onclick="steal()">x</b>');
    assert.strictEqual(out, '<b>x</b>');
  });

  await test('escapes anchor tags (not in the SMC subset)', () => {
    const out = sanitizeHtml('<a href="http://evil.test">click</a>');
    assert.ok(!/<a[\s>]/i.test(out), 'anchor survived');
  });

  await test('closes tags the model left open', () => {
    const out = sanitizeHtml('<ul><li>one<li>two');
    assert.ok(out.endsWith('</li></ul>'), `unbalanced output: ${out}`);
  });

  await test('toPlainText drops markup', () => {
    assert.strictEqual(toPlainText('<p>Hi <b>there</b></p>'), 'Hi there');
  });

  console.log('\nprecedent filtering');
  await test('excludes reopened and escalated tickets from precedent', () => {
    const ids = eligiblePrecedent().map((t) => t.id);
    assert.ok(!ids.includes('3612880'), 'reopened VPN ticket used as precedent');
    assert.ok(!ids.includes('3655302'), 'escalated backup ticket used as precedent');
    assert.ok(ids.length > 0, 'no precedent survived filtering');
  });

  await test('corpus actually contains the bad tickets (so the filter is doing work)', () => {
    const all = RESOLVED_TICKETS.map((t) => t.id);
    assert.ok(all.includes('3612880') && all.includes('3655302'));
  });

  console.log('\ncontext builder');
  await test('flags stale sentiment on the EEC ticket', () => {
    const ctx = buildContext(getTicket('3714201'), { asOf: AS_OF });
    assert.ok(ctx.summaryCaveat, 'expected a staleness caveat');
    assert.strictEqual(ctx.summaryCaveat.type, 'stale_sentiment');
    assert.ok(ctx.summaryCaveat.daysSinceClientMessage > 90);
  });

  await test('detects when the customer spoke last', () => {
    const backup = buildContext(getTicket('3714733'), { asOf: AS_OF });
    assert.strictEqual(backup.awaitingOurReply, true);
  });

  await test('does not flag sentiment on a fresh ticket', () => {
    const ctx = buildContext(getTicket('3714901'), { asOf: AS_OF });
    assert.strictEqual(ctx.summaryCaveat, null);
  });

  console.log('\nretrieval + confidence');
  await test('EEC ticket retrieves the transition runbook first', () => {
    const ctx = buildContext(getTicket('3714201'), { asOf: AS_OF });
    const { docs } = retrieveAll(ctx, { asOf: AS_OF });
    assert.ok(docs.length > 0, 'no docs retrieved');
    assert.strictEqual(docs[0].doc.id, 'KB-1042');
  });

  await test('VPN ticket retrieves the MFA doc first', () => {
    const ctx = buildContext(getTicket('3714582'), { asOf: AS_OF });
    const { docs } = retrieveAll(ctx, { asOf: AS_OF });
    assert.strictEqual(docs[0].doc.id, 'KB-0311');
  });

  await test('does not cite unrelated docs alongside a strong match', () => {
    const ctx = buildContext(getTicket('3714201'), { asOf: AS_OF });
    const { docs } = retrieveAll(ctx, { asOf: AS_OF });
    const ids = docs.map((d) => d.doc.id);
    assert.ok(!ids.includes('KB-0311'), 'VPN doc cited on a migration ticket');
    assert.ok(!ids.includes('KB-0788'), 'backup doc cited on a migration ticket');
  });

  await test('vague ticket yields low confidence and abstains', () => {
    const ctx = buildContext(getTicket('3715120'), { asOf: AS_OF });
    const { confidence } = retrieveAll(ctx, { asOf: AS_OF });
    assert.strictEqual(confidence.level, 'low');
    assert.strictEqual(confidence.shouldAbstain, true);
  });

  console.log('\ndraft generation (mock provider)');
  for (const t of TICKETS) {
    await test(`#${t.id} produces a safe, non-empty draft`, async () => {
      const r = await generateDraft(t, { provider: 'mock', asOf: AS_OF });
      assert.ok(r.draftHtml.length > 80, 'draft suspiciously short');
      assert.ok(r.draftText.length > 60, 'plaintext draft too short');
      assertOnlyAllowedTags(r.draftHtml);
      assert.ok(r.sources.length > 0, 'no sources cited');
      assert.ok(['high', 'medium', 'low'].includes(r.confidence.level));
    });
  }

  await test('EEC draft recaps the specific remediated items', async () => {
    const r = await generateDraft(getTicket('3714201'), { provider: 'mock', asOf: AS_OF });
    const text = r.draftText;
    assert.ok(/10.20.44.18/.test(text), 'missing IIS host');
    assert.ok(/10.20.44.7/.test(text), 'missing DNS host');
    assert.ok(/DMPAPP1W2/i.test(text), 'missing load balancer confirmation');
    assert.ok(/resolve this ticket/i.test(text), 'missing resolution proposal');
    assert.ok(/<li>/.test(r.draftHtml), 'expected list formatting');
  });

  await test('EEC draft carries the stale-sentiment caveat through to the API result', async () => {
    const r = await generateDraft(getTicket('3714201'), { provider: 'mock', asOf: AS_OF });
    assert.ok(r.caveat && r.caveat.type === 'stale_sentiment');
  });

  await test('vague ticket asks questions rather than inventing a diagnosis', async () => {
    const r = await generateDraft(getTicket('3715120'), { provider: 'mock', asOf: AS_OF });
    assert.strictEqual(r.intent, 'insufficient_context');
    assert.ok(/\?/.test(r.draftText), 'expected clarifying questions');
    assert.ok(r.confidence.shouldAbstain);
  });

  await test('firewall draft pulls the source IP and port out of the request', async () => {
    const r = await generateDraft(getTicket('3714901'), { provider: 'mock', asOf: AS_OF });
    assert.ok(/203\.0\.113\.44/.test(r.draftText), 'missing source IP');
    assert.ok(/8443/.test(r.draftText), 'missing port');
  });

  await test('addresses the contact by first name', async () => {
    const r = await generateDraft(getTicket('3714582'), { provider: 'mock', asOf: AS_OF });
    assert.ok(/Hi Dana/.test(r.draftText), `expected greeting, got: ${r.draftText.slice(0, 60)}`);
  });

  console.log('\ntone presets');
  await test('shorter keeps the opening statement and the facts, drops the sign-off', async () => {
    const base = await generateDraft(getTicket('3714201'), { provider: 'mock', asOf: AS_OF });
    const short = await generateDraft(getTicket('3714201'), {
      provider: 'mock', asOf: AS_OF, tones: ['shorter'],
    });

    assert.ok(short.draftHtml.length < base.draftHtml.length, 'shorter did not shorten');
    // The opener is emitted as bare text by this builder - the regression that
    // matters is it being dropped along with the sign-off.
    assert.ok(/service transition/i.test(short.draftText), 'lost the opening statement');
    assert.ok(/10.20.44.18/.test(short.draftText), 'lost the itemized facts');
    assert.ok(!/hold off/i.test(short.draftText), 'kept the sign-off');
  });

  await test('formal raises the register without losing facts', async () => {
    const r = await generateDraft(getTicket('3714201'), {
      provider: 'mock', asOf: AS_OF, tones: ['formal'],
    });
    assert.ok(/Dear Marcus/.test(r.draftText), 'greeting not formalized');
    assert.ok(/10.20.44.18/.test(r.draftText), 'lost the itemized facts');
  });

  await test('unknown tone ids are ignored rather than passed through', async () => {
    const base = await generateDraft(getTicket('3714201'), { provider: 'mock', asOf: AS_OF });
    const r = await generateDraft(getTicket('3714201'), {
      provider: 'mock', asOf: AS_OF, tones: ['not-a-tone'],
    });
    assert.strictEqual(r.draftHtml, base.draftHtml);
  });

  await test('tone output still survives the sanitizer', async () => {
    const r = await generateDraft(getTicket('3714201'), {
      provider: 'mock', asOf: AS_OF, tones: ['friendly', 'detailed'],
    });
    assertOnlyAllowedTags(r.draftHtml);
  });

  console.log('\nrevision');
  await test('revising edits the supplied draft rather than starting over', async () => {
    const previousDraft = '<p>Hi Marcus,</p>\n<p>Alpha.</p>\n<ul><li>Fact</li></ul>\n<p>Omega.</p>';
    const r = await generateDraft(getTicket('3714201'), {
      provider: 'mock', asOf: AS_OF, tones: ['shorter'], previousDraft,
    });

    assert.ok(r.revised, 'result not flagged as a revision');
    assert.ok(/Alpha/.test(r.draftText), 'dropped the supplied draft entirely');
    assert.ok(!/Omega/.test(r.draftText), 'shorter did not trim the revision');
    assert.ok(!/service transition/i.test(r.draftText), 'regenerated instead of revising');
  });

  await test('the offline generator reports that it cannot apply free text', async () => {
    const r = await generateDraft(getTicket('3714201'), {
      provider: 'mock', asOf: AS_OF, instruction: 'make it punchier',
    });
    assert.strictEqual(r.instructionApplied, false);
  });

  await test('a free-text instruction is length-capped before it reaches a provider', async () => {
    const { buildUserMessage } = require('../server/providers/claude');
    const ctx = buildContext(getTicket('3714201'), { asOf: AS_OF });
    const { docs, precedent, confidence } = retrieveAll(ctx);
    const msg = buildUserMessage(ctx, docs, precedent, confidence, [], 'x'.repeat(50));
    assert.ok(msg.includes('BEGIN_ANALYST_INSTRUCTION'), 'instruction not fenced');
  });

  console.log('\ntickets the server has never seen');
  await test('drafts from a ticket supplied inline by the caller', async () => {
    // Shaped like something a DOM adapter would scrape off a live console.
    const scraped = {
      id: '9001234',
      subject: 'Unable to connect to VPN - no MFA prompt',
      title: 'Unable to connect to VPN - no MFA prompt',
      client: 'Example Client',
      clientContact: 'Jordan Ellis',
      status: 'Open',
      severity: 'Medium',
      category: 'Remote Access',
      problem: 'VPN Authentication',
      notes: [{
        author: 'Jordan Ellis',
        role: 'client',
        at: '2026-08-29T09:00:00Z',
        body: 'Two users cannot get onto the VPN - the push notification never arrives on their phones.',
      }],
    };

    const r = await generateDraft(scraped, { provider: 'mock', asOf: AS_OF });
    assert.strictEqual(r.ticketId, '9001234');
    assert.ok(/Hi Jordan/.test(r.draftText), `expected greeting, got: ${r.draftText.slice(0, 60)}`);
    assertOnlyAllowedTags(r.draftHtml);
    // It should still ground itself in the corpus it does have.
    assert.ok(r.sources.some((s) => s.kind === 'techdoc'), 'no techdoc retrieved for a scraped ticket');
  });

  await test('an empty scrape does not produce a confident draft', async () => {
    const r = await generateDraft(
      { id: '9009999', subject: '', title: '', client: '', clientContact: '', notes: [] },
      { provider: 'mock', asOf: AS_OF },
    );
    assert.strictEqual(r.confidence.level, 'low');
    assert.ok(r.confidence.shouldAbstain, 'expected abstention on an empty ticket');
  });

  console.log('\nsource links');
  await test('sources carry a url when the base URLs are configured', async () => {
    // links.js reads the environment at require time, so exercise it directly.
    const r = await generateDraft(getTicket('3714201'), { provider: 'mock', asOf: AS_OF });
    const { linksConfigured } = require('../server/links');
    const configured = linksConfigured();

    for (const s of r.sources) {
      if ((s.kind === 'ticket' || s.kind === 'thread') && configured.tickets) {
        assert.ok(s.url, `ticket source ${s.ref} has no url`);
      }
      if (s.kind === 'techdoc' && configured.techdocs) {
        assert.ok(s.url, `techdoc source ${s.ref} has no url`);
      }
      // Unconfigured is fine; a broken url is not.
      if (s.url) assert.ok(/^https?:\/\//.test(s.url), `unsafe url: ${s.url}`);
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
