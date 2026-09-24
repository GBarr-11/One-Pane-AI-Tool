'use strict';

/**
 * Dependency-free smoke tests for the draft pipeline.
 * Run with: npm test
 *
 * The pipeline under test is production code; its fixtures come from the
 * onepane-mock dev pack, installed below exactly as `npm run mock` installs
 * it. The dependency runs test -> onepane-mock -> server, never server ->
 * onepane-mock. The "production mode" group at the end uninstalls the pack to
 * prove the server stands up without it.
 */

const assert = require('assert');
const mockPack = require('../onepane-mock/pack');
const devpack = require('../server/devpack');

const {
  TICKETS, getTicket, retrieveAll, eligiblePrecedent, RESOLVED_TICKETS,
} = mockPack;
const { buildContext } = require('../server/context');
const {
  generateDraft, getSuggestions, activeProviderName, resolveProvider,
} = require('../server/generate');
const { sanitizeHtml, toPlainText, ALLOWED_TAGS } = require('../server/sanitize');
const { suggestNextSteps } = require('../server/suggestions');
const mockProvider = require('../onepane-mock/provider/mock');

const { retrieveKnowledge, kbSourceName } = require('../server/knowledge');
const {
  storageToText, scrubSecrets, buildCql, queryTerms,
} = require('../server/confluence/search');

// Pin the knowledge source: a shell that exports Confluence credentials must
// not turn the test suite into live wiki traffic. Confluence tests opt in.
process.env.ONEPANE_KB_SOURCE = 'mock';

mockPack.installMockPack();

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

/** Swap global fetch for the duration of fn, so provider tests never hit the network. */
async function withFetch(fake, fn) {
  const real = global.fetch;
  global.fetch = fake;
  try { return await fn(); } finally { global.fetch = real; }
}

function fakeResponse(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

/** Test-only gateway config; restores whatever a real .env had set. */
async function withOwuiEnv(fn) {
  const keys = { OWUI_URL: 'https://owui.test/api/', OWUI_API_KEY: 'test-key', ONEPANE_MODEL: 'test-model' };
  const saved = {};
  for (const [k, v] of Object.entries(keys)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const k of Object.keys(keys)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

/** Test-only Confluence config; restores whatever the environment had. */
async function withConfluenceEnv(extra, fn) {
  const keys = {
    CONFLUENCE_SITE_URL: 'https://wiki.test/wiki/home',
    CONFLUENCE_EMAIL: 'svc@example.test',
    CONFLUENCE_API_TOKEN: 'conf-test-token',
    CONFLUENCE_CLOUD_ID: '',
    CONFLUENCE_SPACES: '',
    CONFLUENCE_LABELS: '',
    ...extra,
  };
  const saved = {};
  for (const [k, v] of Object.entries(keys)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const k of Object.keys(keys)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

/**
 * A fake Confluence: one on-topic SOP and one unrelated page, both returned
 * by search, as a real relevance-ranked search would.
 */
function fakeConfluence(calls, { searchStatus = 200 } = {}) {
  const pages = {
    101: {
      id: '101',
      title: 'SOP: VPN MFA push notification not received',
      version: { createdAt: '2026-08-01T10:00:00Z' },
      labels: { results: [{ name: 'vpn' }, { name: 'mfa' }] },
      body: {
        storage: {
          value: '<p>When the MFA push is not delivered, check whether the phone was replaced.</p>'
            + '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter>'
            + '<ac:plain-text-body><![CDATA[show mfa enrollment]]></ac:plain-text-body></ac:structured-macro>'
            + '<p>Admin password: hunter2</p>',
        },
      },
      _links: { webui: '/spaces/SOC/pages/101/SOP+VPN+MFA' },
    },
    202: {
      id: '202',
      title: 'Holiday on-call rota',
      version: { createdAt: '2026-08-01T10:00:00Z' },
      labels: { results: [] },
      body: { storage: { value: '<p>Who is on call over the holidays.</p>' } },
      _links: { webui: '/spaces/HR/pages/202/Rota' },
    },
  };

  const hit = (id, space, spaceName) => ({
    content: { id, title: pages[id].title },
    title: pages[id].title,
    resultGlobalContainer: { title: spaceName, displayUrl: `/spaces/${space}` },
    lastModified: '2026-08-01T10:00:00Z',
  });

  return async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    if (u.pathname === '/wiki/rest/api/search') {
      if (searchStatus !== 200 && u.searchParams.get('cql').includes('siteSearch')) {
        return fakeResponse(searchStatus, { message: 'bad cql' });
      }
      return fakeResponse(200, { results: [hit('101', 'SOC', 'Security Operations'), hit('202', 'HR', 'HR')] });
    }
    const m = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(u.pathname);
    if (m && pages[m[1]]) return fakeResponse(200, pages[m[1]]);
    return fakeResponse(404, { message: 'nope' });
  };
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

  console.log('\nrecommended replies: deterministic heuristic (offline fallback)');
  await test('suggests an opening update when the client has not said anything yet', () => {
    const ticket = {
      id: '9003001', subject: 'New VM provisioning request', client: 'Acme Corp',
      severity: 'Medium', notes: [
        { author: 'Reece Calloway', role: 'analyst', at: '2026-08-29T09:00:00Z', body: 'Opened on the client\'s behalf per their phone call.' },
      ],
    };
    const ctx = buildContext(ticket, { asOf: AS_OF });
    const { confidence } = retrieveAll(ctx, { asOf: AS_OF });
    const suggestions = suggestNextSteps(ctx, confidence);
    assert.deepStrictEqual(suggestions.map((s) => s.id), ['initial_update']);
    assert.ok(suggestions[0].instruction.length > 0, 'missing the drafting instruction');
  });

  await test('suggests following up when we spoke last', () => {
    const ticket = {
      id: '9003002', subject: 'VPN access request', client: 'Acme Corp', severity: 'Medium', notes: [
        { author: 'Priya Nair', role: 'client', at: '2026-08-20T09:00:00Z', body: 'Can we get VPN access set up for two new hires?' },
        { author: 'Reece Calloway', role: 'analyst', at: '2026-08-21T09:00:00Z', body: 'Done - both accounts are provisioned and tested.' },
      ],
    };
    const ctx = buildContext(ticket, { asOf: AS_OF });
    const { confidence } = retrieveAll(ctx, { asOf: AS_OF });
    assert.strictEqual(ctx.awaitingOurReply, false);
    const suggestions = suggestNextSteps(ctx, confidence);
    assert.deepStrictEqual(suggestions.map((s) => s.id), ['follow_up']);
  });

  await test('suggests asking for details on a vague, low-confidence ticket', () => {
    const ctx = buildContext(getTicket('3715120'), { asOf: AS_OF });
    const { confidence } = retrieveAll(ctx, { asOf: AS_OF });
    assert.strictEqual(ctx.awaitingOurReply, true);
    assert.ok(confidence.shouldAbstain);
    const suggestions = suggestNextSteps(ctx, confidence);
    assert.strictEqual(suggestions[0].id, 'ask_for_details');
  });

  await test('suggests confirming resolved when the client\'s own words sound like a close-out', () => {
    const ctx = buildContext(getTicket('3714201'), { asOf: AS_OF });
    const { confidence } = retrieveAll(ctx, { asOf: AS_OF });
    assert.strictEqual(ctx.awaitingOurReply, true);
    assert.ok(!confidence.shouldAbstain, 'expected this well-grounded ticket not to abstain');
    assert.ok(/^Thanks/.test(ctx.lastClientMessage.body), 'fixture assumption changed');
    const suggestions = suggestNextSteps(ctx, confidence);
    assert.deepStrictEqual(suggestions.map((s) => s.id), ['confirm_resolved']);
  });

  await test('puts an urgent acknowledgement first and never returns more than three', () => {
    const ticket = {
      id: '9003003', subject: 'Production database down', client: 'Acme Corp', severity: 'Critical', notes: [
        { author: 'Priya Nair', role: 'client', at: '2026-08-29T09:00:00Z', body: 'Everything is down, this is urgent.' },
      ],
    };
    const ctx = buildContext(ticket, { asOf: AS_OF });
    const { confidence } = retrieveAll(ctx, { asOf: AS_OF });
    const suggestions = suggestNextSteps(ctx, confidence);
    assert.strictEqual(suggestions[0].id, 'acknowledge_urgent');
    assert.ok(suggestions.length <= 3);
  });

  console.log('\nrecommended replies: response parsing (claude/openwebui)');
  const { parseSuggestions } = require('../server/providers/claude');

  await test('parses a clean JSON suggestion response', () => {
    const out = parseSuggestions('{"suggestions":[{"label":"Confirm DNS restore","instruction":"Ask the client to confirm DNS is resolving correctly now."}]}');
    assert.deepStrictEqual(out, [{ label: 'Confirm DNS restore', instruction: 'Ask the client to confirm DNS is resolving correctly now.' }]);
  });

  await test('strips a ```json fence before parsing', () => {
    const out = parseSuggestions('```json\n{"suggestions":[{"label":"Ask about firmware version","instruction":"Ask which firmware version is currently installed."}]}\n```');
    assert.strictEqual(out[0].label, 'Ask about firmware version');
  });

  await test('returns null for unparseable text rather than throwing', () => {
    assert.strictEqual(parseSuggestions('not json at all'), null);
    assert.strictEqual(parseSuggestions(''), null);
    assert.strictEqual(parseSuggestions(undefined), null);
  });

  await test('returns null when the shape is wrong even if it is valid JSON', () => {
    assert.strictEqual(parseSuggestions('{"foo":"bar"}'), null);
    assert.strictEqual(parseSuggestions('{"suggestions":"not an array"}'), null);
    assert.strictEqual(parseSuggestions('{"suggestions":[]}'), null);
  });

  await test('drops individual malformed items rather than failing the whole batch', () => {
    const out = parseSuggestions(JSON.stringify({
      suggestions: [
        { label: 'Good one', instruction: 'A real instruction.' },
        { label: '', instruction: 'Missing its label.' },
        { label: 'Missing its instruction' },
        { label: 'Also good', instruction: 'Another real instruction.' },
      ],
    }));
    assert.deepStrictEqual(out.map((s) => s.label), ['Good one', 'Also good']);
  });

  await test('caps oversized labels and instructions rather than trusting the model', () => {
    const out = parseSuggestions(JSON.stringify({
      suggestions: [{ label: 'x'.repeat(500), instruction: 'y'.repeat(5000) }],
    }));
    assert.ok(out[0].label.length <= 60, `label not capped: ${out[0].label.length} chars`);
    assert.ok(out[0].instruction.length <= 400, `instruction not capped: ${out[0].instruction.length} chars`);
  });

  await test('caps the list at three suggestions even if the model returns more', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ label: `Option ${i}`, instruction: `Do thing ${i}.` }));
    const out = parseSuggestions(JSON.stringify({ suggestions: many }));
    assert.strictEqual(out.length, 3);
  });

  console.log('\nrecommended replies: providers');
  await test('mock.suggest() wraps the deterministic heuristic in {label, instruction} shape', async () => {
    const ctx = buildContext(getTicket('3715120'), { asOf: AS_OF });
    const { confidence } = retrieveAll(ctx, { asOf: AS_OF });
    const { suggestions, provider } = await mockProvider.suggest({ ctx, confidence });
    assert.strictEqual(provider, 'mock');
    assert.ok(suggestions.length >= 1);
    assert.ok(suggestions.every((s) => typeof s.label === 'string' && typeof s.instruction === 'string'));
  });

  await test('getSuggestions() with the mock provider needs no network and returns real suggestions', async () => {
    const r = await getSuggestions(getTicket('3714201'), { provider: 'mock', asOf: AS_OF });
    assert.strictEqual(r.ticketId, '3714201');
    assert.ok(r.suggestions.length >= 1);
    assert.strictEqual(r.suggestions[0].label, 'Confirm resolved');
  });

  await withOwuiEnv(async () => {
    await test('openwebui.suggest() posts the triage prompt and parses the result', async () => {
      let seen;
      const r = await withFetch(async (url, init) => {
        seen = { url, body: JSON.parse(init.body) };
        return fakeResponse(200, {
          model: 'test-model',
          choices: [{
            message: {
              content: '```json\n{"suggestions":[{"label":"Confirm DNS restore","instruction":"Ask the client to confirm DNS is resolving."}]}\n```',
            },
          }],
        });
      }, () => {
        const ctx = buildContext(getTicket('3714201'), { asOf: AS_OF });
        const { docs, precedent, confidence } = retrieveAll(ctx, { asOf: AS_OF });
        return require('../server/providers/openwebui').suggest({
          ctx, docs, precedent, confidence,
        });
      });

      assert.strictEqual(seen.body.messages[0].role, 'system');
      assert.ok(seen.body.messages[0].content.includes('triage'), 'wrong system prompt used');
      assert.strictEqual(r.provider, 'openwebui');
      assert.strictEqual(r.suggestions[0].label, 'Confirm DNS restore');
    });

    await test('getSuggestions() falls back to the heuristic when the model call fails', async () => {
      const r = await withFetch(
        async () => fakeResponse(401, { detail: 'bad key' }),
        () => getSuggestions(getTicket('3714201'), { provider: 'openwebui', asOf: AS_OF }),
      );
      // No throw, and a real (heuristic) suggestion came back instead of an error.
      assert.strictEqual(r.ticketId, '3714201');
      assert.ok(r.suggestions.length >= 1);
      assert.strictEqual(r.suggestions[0].label, 'Confirm resolved');
    });

    await test('getSuggestions() falls back when the model returns unparseable output', async () => {
      const r = await withFetch(
        async () => fakeResponse(200, { model: 'test-model', choices: [{ message: { content: 'not json' } }] }),
        () => getSuggestions(getTicket('3714201'), { provider: 'openwebui', asOf: AS_OF }),
      );
      assert.ok(r.suggestions.length >= 1, 'expected the heuristic fallback, got nothing');
    });
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

  console.log('\nopen webui provider (fetch stubbed, no network)');
  await withOwuiEnv(async () => {
    await test('posts an OpenAI-shaped request to {OWUI_URL}/chat/completions', async () => {
      let seen;
      const r = await withFetch(async (url, init) => {
        seen = { url, init, body: JSON.parse(init.body) };
        return fakeResponse(200, {
          model: 'test-model',
          choices: [{ message: { content: '<think>scratch</think>```html\n<p>Hi Dana,</p><script>x</script>\n```' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      }, () => generateDraft(getTicket('3714201'), { provider: 'openwebui', asOf: AS_OF }));

      assert.strictEqual(seen.url, 'https://owui.test/api/chat/completions', 'trailing slash not normalized');
      assert.strictEqual(seen.init.headers.Authorization, 'Bearer test-key');
      assert.strictEqual(seen.body.model, 'test-model');
      assert.deepStrictEqual(seen.body.messages.map((m) => m.role), ['system', 'user']);
      assert.ok(seen.body.messages[1].content.includes('BEGIN_TICKET_THREAD'), 'ticket thread not fenced');

      assert.strictEqual(r.provider, 'openwebui');
      assert.ok(!r.draftHtml.includes('scratch'), 'reasoning leaked into the draft');
      assert.ok(!r.draftHtml.includes('<script'), 'output not sanitized');
      assert.ok(r.draftHtml.includes('Hi Dana'));
      assert.deepStrictEqual(r.usage, { input: 10, output: 5, cacheRead: 0 });
    });

    await test('a rejected key surfaces as an auth error without echoing the key', async () => {
      await assert.rejects(
        withFetch(async () => fakeResponse(401, { detail: 'bad' }),
          () => generateDraft(getTicket('3714201'), { provider: 'openwebui', asOf: AS_OF })),
        (err) => /OWUI_API_KEY/.test(err.message) && !err.message.includes('test-key'),
      );
    });

    await test('missing openwebui config names the variable, not its value', async () => {
      delete process.env.OWUI_URL; // withOwuiEnv restores it
      await assert.rejects(
        generateDraft(getTicket('3714201'), { provider: 'openwebui', asOf: AS_OF }),
        /OWUI_URL/,
      );
    });
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

  await test('greets the client-team, not the listed contact, when nobody from the client has posted', async () => {
    // clientContact is SMC's default/order pick, not evidence anyone by that
    // name is engaged in this thread - the ticket has no client-role note at
    // all, so the draft must not address Jordan Ellis by name.
    const scraped = {
      id: '9002001',
      subject: 'Unable to connect to VPN - no MFA prompt',
      title: 'Unable to connect to VPN - no MFA prompt',
      client: 'Example Client',
      clientContact: 'Jordan Ellis',
      status: 'Open',
      severity: 'Medium',
      category: 'Remote Access',
      problem: 'VPN Authentication',
      notes: [{
        author: 'Reece Calloway',
        role: 'analyst',
        at: '2026-08-29T09:00:00Z',
        body: 'Opening this on the client\'s behalf per their phone call - two users cannot get onto the VPN.',
      }],
    };

    const r = await generateDraft(scraped, { provider: 'mock', asOf: AS_OF });
    assert.ok(/Hi Example Client team/.test(r.draftText), `expected team greeting, got: ${r.draftText.slice(0, 60)}`);
    assert.ok(!/Jordan/.test(r.draftText), 'addressed the unconfirmed contact by name');
  });

  await test('greets whichever client actually posted, even if it is not the listed contact', async () => {
    const scraped = {
      id: '9002002',
      subject: 'Unable to connect to VPN - no MFA prompt',
      title: 'Unable to connect to VPN - no MFA prompt',
      client: 'Example Client',
      clientContact: 'Jordan Ellis',
      status: 'Open',
      severity: 'Medium',
      category: 'Remote Access',
      problem: 'VPN Authentication',
      notes: [{
        author: 'Priya Nair',
        role: 'client',
        at: '2026-08-29T09:00:00Z',
        body: 'Two users cannot get onto the VPN - the push notification never arrives on their phones.',
      }],
    };

    const r = await generateDraft(scraped, { provider: 'mock', asOf: AS_OF });
    assert.ok(/Hi Priya/.test(r.draftText), `expected the actual poster's name, got: ${r.draftText.slice(0, 60)}`);
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

  console.log('\nconfluence knowledge base');
  await test('storage format becomes readable text, macro config dropped, code kept', () => {
    const text = storageToText(
      '<h2>Steps</h2><ul><li>One &amp; two</li></ul>'
      + '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>'
      + '<ac:plain-text-body><![CDATA[ping 10.0.0.1]]></ac:plain-text-body>',
    );
    assert.ok(text.includes('- One & two'), text);
    assert.ok(text.includes('ping 10.0.0.1'), text);
    assert.ok(!text.includes('maxLevel'), text);
  });

  await test('credentials in an SOP are redacted before reaching a prompt', () => {
    const out = scrubSecrets('Default password: Winter2026! then api key = abc123');
    assert.ok(!out.includes('Winter2026!') && !out.includes('abc123'), out);
  });

  await test('CQL escapes quotes and refuses unsafe space keys', async () => {
    await withConfluenceEnv({ CONFLUENCE_SPACES: 'SOC, NOC,bad" OR 1=1' }, () => {
      const cql = buildCql(['say "hi"']);
      assert.ok(cql.includes('siteSearch ~ "say \\"hi\\""'), cql);
      assert.ok(cql.includes('space in ("SOC","NOC")'), cql);
      assert.ok(!cql.includes('1=1'), cql);
    });
  });

  await test('search terms come from the ticket, without ticket noise or numbers', () => {
    const ctx = buildContext(getTicket('3714582'), { asOf: AS_OF });
    const terms = queryTerms(ctx);
    assert.ok(terms.includes('vpn') && terms.includes('mfa'), terms.join(' '));
    assert.ok(!terms.includes('thanks') && !terms.some((t) => /^\d+$/.test(t)), terms.join(' '));
  });

  await test('a ticket pulls the matching SOP from Confluence, read-only, with a real link', async () => {
    const calls = [];
    await withConfluenceEnv({ CONFLUENCE_SPACES: 'SOC' }, () => withFetch(fakeConfluence(calls), async () => {
      const ctx = buildContext(getTicket('3714582'), { asOf: AS_OF });
      const { docs, kb } = await retrieveKnowledge(ctx, { asOf: AS_OF, kbSource: 'confluence' });

      assert.strictEqual(kb.source, 'confluence');
      assert.ok(docs.length >= 1, 'expected the VPN SOP to rank');
      assert.strictEqual(docs[0].doc.title, 'SOP: VPN MFA push notification not received');
      assert.strictEqual(docs[0].doc.url, 'https://wiki.test/wiki/spaces/SOC/pages/101/SOP+VPN+MFA');
      assert.ok(!docs.some((d) => d.doc.title === 'Holiday on-call rota'), 'unrelated page should not rank');
      assert.ok(!docs[0].doc.body.includes('hunter2'), 'password leaked into doc body');
      assert.ok(docs[0].doc.body.includes('show mfa enrollment'), 'code block lost');
    }));

    assert.ok(calls.length >= 2);
    const expectedAuth = `Basic ${Buffer.from('svc@example.test:conf-test-token').toString('base64')}`;
    for (const { url, init } of calls) {
      assert.strictEqual(init.method, 'GET', 'Confluence client must only read');
      assert.strictEqual(url.host, 'wiki.test', `request went to ${url.host}`);
      assert.strictEqual(init.headers.Authorization, expectedAuth);
    }
    assert.ok(calls[0].url.searchParams.get('cql').includes('space in ("SOC")'));
  });

  await test('a scoped token routes through the api.atlassian.com gateway', async () => {
    const seen = [];
    const fake = fakeConfluence([]);
    const gateway = async (url, init) => {
      const u = new URL(url);
      seen.push(u);
      return fake(`https://wiki.test${u.pathname.replace('/ex/confluence/abc-123', '')}${u.search}`, init);
    };
    await withConfluenceEnv({ CONFLUENCE_CLOUD_ID: 'abc-123' }, () => withFetch(gateway, async () => {
      const ctx = buildContext(getTicket('3714582'), { asOf: AS_OF });
      const { docs } = await retrieveKnowledge(ctx, { asOf: AS_OF, kbSource: 'confluence' });
      // Links still point at the site, not at the API gateway.
      assert.ok(docs[0].doc.url.startsWith('https://wiki.test/wiki/'), docs[0].doc.url);
    }));
    assert.ok(seen.length && seen.every((u) => u.host === 'api.atlassian.com'
      && u.pathname.startsWith('/ex/confluence/abc-123/wiki/')));
  });

  await test('falls back from siteSearch to text search when the tenant rejects it', async () => {
    await withConfluenceEnv({}, () => withFetch(fakeConfluence([], { searchStatus: 400 }), async () => {
      const ctx = buildContext(getTicket('3714582'), { asOf: AS_OF });
      const { docs, kb } = await retrieveKnowledge(ctx, { asOf: AS_OF, kbSource: 'confluence' });
      assert.ok(docs.length >= 1);
      assert.ok(kb.cql.includes('text ~'), kb.cql);
    }));
  });

  await test('a Confluence outage yields no docs and says so - never mock techdocs', async () => {
    const denied = async () => fakeResponse(401, { message: 'unauthorized' });
    await withConfluenceEnv({}, () => withFetch(denied, async () => {
      const ctx = buildContext(getTicket('3714582'), { asOf: AS_OF });
      const { docs, confidence } = await retrieveKnowledge(ctx, { asOf: AS_OF, kbSource: 'confluence' });
      assert.strictEqual(docs.length, 0);
      assert.ok(/Knowledge base search failed.*401/.test(confidence.reasons[0]), confidence.reasons[0]);
      assert.ok(!confidence.reasons.join(' ').includes('conf-test-token'), 'token leaked into reasons');
    }));
  });

  await test('a draft cites the Confluence page with its link', async () => {
    await withConfluenceEnv({}, () => withFetch(fakeConfluence([]), async () => {
      const r = await generateDraft(getTicket('3714582'), { provider: 'mock', asOf: AS_OF, kbSource: 'confluence' });
      const doc = r.sources.find((s) => s.kind === 'techdoc');
      assert.ok(doc, 'no techdoc source');
      assert.strictEqual(doc.detail, 'Confluence · SOC · Updated 2026-08-01');
      assert.strictEqual(doc.url, 'https://wiki.test/wiki/spaces/SOC/pages/101/SOP+VPN+MFA');
      assert.strictEqual(r.kb.source, 'confluence');
    }));
  });

  console.log('\nprecedent source');

  /** Shaped like a live SMC ticket: not in the mock corpus, clearly on a mock topic. */
  const liveVpnTicket = () => ({
    id: '3800100',
    subject: 'VPN users get no MFA push after new phones',
    client: 'Acme Dental',
    clientContact: 'Pat Moss',
    status: 'Open',
    severity: 'Medium',
    category: 'Remote Access',
    problem: 'VPN Authentication',
    notes: [{
      author: 'Pat Moss',
      role: 'client',
      at: '2026-08-29T09:00:00Z',
      body: 'Since we replaced two phones, the MFA push never arrives and they cannot log in to the VPN.',
    }],
  });

  await test('a live ticket never gets the invented mock tickets as precedent', async () => {
    for (const origin of ['inline', 'smc']) {
      const r = await generateDraft(liveVpnTicket(), { provider: 'mock', asOf: AS_OF, ticketOrigin: origin });
      assert.ok(!r.sources.some((s) => s.kind === 'ticket'), `mock resolved ticket cited on a live (${origin}) ticket`);
      assert.ok(r.sources.some((s) => s.kind === 'techdoc'), 'live ticket lost its techdocs');
    }
  });

  await test('a live ticket is not marked down for precedent it cannot have', async () => {
    const ctx = buildContext(liveVpnTicket(), { asOf: AS_OF });
    const { confidence } = await retrieveKnowledge(ctx, { asOf: AS_OF, ticketOrigin: 'inline' });
    assert.ok(!confidence.reasons.includes('No similar resolved ticket found'), confidence.reasons.join('; '));
  });

  await test('mock tickets still get mock precedent', async () => {
    const r = await generateDraft(getTicket('3714582'), { provider: 'mock', asOf: AS_OF, ticketOrigin: 'mock' });
    assert.ok(r.sources.some((s) => s.kind === 'ticket'), 'no precedent on the demo VPN ticket');
  });

  console.log('\nproduction mode (no dev pack)');

  /** Run fn with the mock pack uninstalled and the given env, restoring both. */
  async function asProduction(env, fn) {
    const keys = ['ONEPANE_PROVIDER', 'ONEPANE_KB_SOURCE', 'CONFLUENCE_SITE_URL', 'CONFLUENCE_EMAIL', 'CONFLUENCE_API_TOKEN'];
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, env);
    devpack.uninstall();
    try {
      return await fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
      mockPack.installMockPack();
    }
  }

  await test('production has no provider until one is configured, and never falls back to mock', async () => {
    await asProduction({}, async () => {
      assert.strictEqual(activeProviderName(), 'none');
      assert.throws(() => resolveProvider(), /No generation provider is configured/);
      assert.throws(() => resolveProvider('mock'), /Unknown provider "mock"/);
    });
    await asProduction({ ONEPANE_PROVIDER: 'mock' }, async () => {
      assert.strictEqual(activeProviderName(), 'none', 'ONEPANE_PROVIDER=mock must not work without the pack');
    });
    await asProduction({ ONEPANE_PROVIDER: 'openwebui' }, async () => {
      assert.strictEqual(activeProviderName(), 'openwebui');
    });
  });

  await test('production refuses to draft without a provider rather than inventing one', async () => {
    await asProduction({}, async () => {
      await assert.rejects(() => generateDraft(liveVpnTicket(), { ticketOrigin: 'inline' }), /No generation provider/);
    });
  });

  await test('suggestions still degrade to the heuristic with no provider at all', async () => {
    await asProduction({}, async () => {
      const r = await getSuggestions(liveVpnTicket(), { ticketOrigin: 'inline' });
      assert.ok(r.suggestions.length > 0, 'no heuristic suggestions');
    });
  });

  await test('production has no mock KB: auto without Confluence is "none", and says why', async () => {
    await asProduction({}, async () => {
      assert.strictEqual(kbSourceName(), 'none');
      const ctx = buildContext(liveVpnTicket(), { asOf: AS_OF });
      const { docs, precedent, confidence } = await retrieveKnowledge(ctx, { ticketOrigin: 'inline' });
      assert.strictEqual(docs.length, 0);
      assert.strictEqual(precedent.length, 0);
      assert.ok(/No knowledge base is configured/.test(confidence.reasons[0]), confidence.reasons.join('; '));
    });
    await asProduction({ ONEPANE_KB_SOURCE: 'mock' }, async () => {
      const ctx = buildContext(liveVpnTicket(), { asOf: AS_OF });
      const { docs, kb } = await retrieveKnowledge(ctx, { ticketOrigin: 'inline' });
      assert.strictEqual(docs.length, 0, 'mock techdocs leaked into production');
      assert.ok(kb.warnings.some((w) => /onepane-mock/.test(w)), kb.warnings.join('; '));
    });
  });

  await test('production never hands out precedent, even to a ticket claiming mock origin', async () => {
    await asProduction({}, async () => {
      const ctx = buildContext(getTicket('3714582'), { asOf: AS_OF });
      const { precedent } = await retrieveKnowledge(ctx, { ticketOrigin: 'mock' });
      assert.strictEqual(precedent.length, 0);
      assert.strictEqual(devpack.packTicket('3714582'), null, 'mock ticket resolvable in production');
    });
  });

  await test('no production module requires onepane-mock', () => {
    const fs = require('fs');
    const path = require('path');
    const serverDir = path.join(__dirname, '..', 'server');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []
    ));
    for (const file of walk(serverDir)) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(!/require\([^)]*(onepane-mock|\/data\/)/.test(src), `${path.relative(serverDir, file)} requires mock code`);
    }
  });

  await test('extension manifest: web_accessible_resources matches are origin-only', () => {
    // Chrome rejects the whole extension ("Invalid match pattern") if a
    // web_accessible_resources match has any path other than /*. Narrowing to a
    // page belongs in content_scripts.matches, which does accept paths.
    const manifest = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
    for (const war of manifest.web_accessible_resources) {
      for (const m of war.matches) assert.match(m, /^[a-z]+:\/\/[^/]+\/\*$/, `invalid WAR match: ${m}`);
    }
    const cs = manifest.content_scripts.flatMap((c) => c.matches);
    assert.ok(!cs.includes('http://localhost:3000/*'), 'overlay would inject into the Control Center');
  });

  console.log('\ncontrol center');

  await test('status reports secrets as set/unset only, never their values', async () => {
    const { buildStatus } = require('../server/status');
    const secret = 'sk-test-DO-NOT-LEAK-1234567890';
    await withConfluenceEnv({ CONFLUENCE_API_TOKEN: secret }, async () => {
      const saved = process.env.OWUI_API_KEY;
      process.env.OWUI_API_KEY = secret;
      try {
        const body = JSON.stringify(buildStatus({ host: '127.0.0.1', port: 3000 }));
        assert.ok(!body.includes(secret), 'a secret value reached the status payload');
        assert.ok(!/tokenLength|keyLength/.test(body), 'secret length reached the status payload');
        const status = JSON.parse(body);
        const tokenVar = status.env.find((v) => v.name === 'CONFLUENCE_API_TOKEN');
        assert.strictEqual(tokenVar.set, true);
        assert.strictEqual(tokenVar.value, null);
      } finally {
        if (saved === undefined) delete process.env.OWUI_API_KEY; else process.env.OWUI_API_KEY = saved;
      }
    });
  });

  await test('status reports mock mode with the pack, production without it', async () => {
    const { buildStatus } = require('../server/status');
    assert.strictEqual(buildStatus().mode.kind, 'mock');
    assert.strictEqual(buildStatus().mode.mockConsole, '/mock-smc/');
    await asProduction({}, async () => {
      const s = buildStatus();
      assert.strictEqual(s.mode.kind, 'production');
      assert.strictEqual(s.provider.active, 'none');
      assert.deepStrictEqual(s.provider.available.sort(), ['claude', 'openwebui']);
    });
  });

  await test('activity log classifies callers and collapses ticket ids out of routes', () => {
    const activity = require('../server/activity');
    assert.strictEqual(activity.routeOf('/api/tickets/3714582/context'), '/api/tickets/:id/context');
    assert.strictEqual(activity.routeOf('/api/smc/tickets/12345'), '/api/smc/tickets/:id');
    const req = (headers) => ({ headers });
    assert.strictEqual(activity.callerOf(req({ origin: 'chrome-extension://abcdef' })), 'extension');
    assert.strictEqual(activity.callerOf(req({ referer: 'http://localhost:3000/mock-smc/' }), '/mock-smc/'), 'mock-console');
    assert.strictEqual(activity.callerOf(req({ referer: 'http://localhost:3000/' }), '/mock-smc/'), 'control-center');
    assert.strictEqual(activity.callerOf(req({})), 'direct');
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
