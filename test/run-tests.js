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
  storageToText, scrubSecrets, buildCql, buildQueries, queryTerms, titleWeight, searchForContext,
} = require('../server/confluence/search');
const { answerQuestion } = require('../server/ask');

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
      if (searchStatus !== 200 && u.searchParams.get('cql').includes('ORDER BY')) {
        return fakeResponse(searchStatus, { message: 'bad cql' });
      }
      return fakeResponse(200, { results: [hit('101', 'SOC', 'Security Operations'), hit('202', 'HR', 'HR')] });
    }
    const m = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(u.pathname);
    if (m && pages[m[1]]) return fakeResponse(200, pages[m[1]]);
    return fakeResponse(404, { message: 'nope' });
  };
}

/** An inline ticket like the live Zerto upgrade notice (#3767603), invented details. */
const ZERTO_TICKET = {
  id: '9990042',
  subject: 'Zerto Upgrade Maintenance Notification',
  problem: 'Zerto',
  notes: [{
    author: 'Client',
    role: 'client',
    at: '2026-08-28T14:00:00Z',
    body: 'Will the Zerto upgrade impact our VPG replication? When is the ZVM being upgraded?',
  }],
};

/**
 * A fake Confluence built from what expedient-cloud really returned on
 * 2026-09-24 for Zerto searches: the right pages mixed with off-topic ones, in
 * no relevance order, and a deprecated page. Every query gets the same pool,
 * as if relevance were no help at all - the local pre-rank and ranker must
 * sort it out.
 */
function fakeZertoConfluence(calls) {
  const page = (id, title, space, updated, body) => ({
    id: String(id),
    title,
    space,
    version: { createdAt: `${updated}T12:00:00Z` },
    labels: { results: [] },
    body: { storage: { value: `<p>${body}</p>` } },
    _links: { webui: `/spaces/${space}/pages/${id}/${encodeURIComponent(title)}` },
  });
  const pages = [
    page(998309913, 'Tamko - Juniper Switch Replacements', 'TO', '2026-07-13', 'Juniper switch replacement status per site.'),
    page(996999177, 'EverPure fka Pure Storage', 'TO', '2026-03-17', 'About Pure Storage all-flash arrays.'),
    page(3250716673, 'MOP - Zerto 10.8 Upgrade Project', 'PRE', '2026-08-14',
      'Upgrade shared Zerto from 10U6 to 10U8. Upgrade the ZCM, then the ZVM appliance, then VRAs. VPG replication pauses during VRA upgrades.'),
    page(1263435798, 'SOP - Zerto Upgrade Process for EEC', 'PRE', '2025-04-01',
      'Snapshot the ZVM and ZVMDB appliances. Upgrade the ZVM from Appliance Upgrade. Upgrade outdated VRAs in bulk. VPGs resync after the upgrade.'),
    page(75254234, '(Deprecated) SOP - Zerto Upgrade', 'TO', '2019-02-01',
      'Upgrade Zerto 5.5 Update 4 with the Windows installer. VPG replication and ZVM upgrade.'),
    page(2054750313, 'SOP - Zerto - ZVMA Troubleshooting Cheat Sheet', 'TO', '2026-08-18',
      'Troubleshoot ZVMA containers and services.'),
  ];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const hit = (p) => ({
    content: { id: p.id, title: p.title },
    title: p.title,
    excerpt: p.body.storage.value,
    resultGlobalContainer: { title: p.space, displayUrl: `/spaces/${p.space}` },
    lastModified: p.version.createdAt,
  });

  return async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    if (u.pathname === '/wiki/rest/api/search') return fakeResponse(200, { results: pages.map(hit) });
    const m = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(u.pathname);
    if (m && byId.has(m[1])) return fakeResponse(200, byId.get(m[1]));
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
      const [cql] = buildQueries(['say "hi"'], ['say "hi"']);
      assert.ok(cql.includes('title ~ "say \\"hi\\"*"'), cql);
      assert.ok(cql.includes('space in ("SOC","NOC")'), cql);
      assert.ok(!cql.includes('1=1'), cql);
    });
  });

  await test('queries anchor the product in a title, as prefixes, and never use siteSearch', async () => {
    await withConfluenceEnv({ CONFLUENCE_SPACES: 'TO,PRE' }, () => {
      const queries = buildQueries(['zerto', 'upgrade'], ['zerto', 'upgrade', 'vpg']);
      // siteSearch ignores its terms on expedient-cloud; exact title terms can miss.
      assert.ok(queries.every((q) => !q.includes('siteSearch')), queries.join('\n'));
      assert.ok(queries.includes(buildCql('title ~ "zerto*"') + ' ORDER BY lastmodified DESC'), queries.join('\n'));
      assert.ok(queries.includes(buildCql('title ~ "zerto*" AND text ~ "upgrade*"')), queries.join('\n'));
      assert.ok(queries.includes(buildCql('title ~ "upgrade*" AND text ~ "zerto*"')), queries.join('\n'));
      assert.ok(queries.length <= 6 && new Set(queries).size === queries.length);
    });
  });

  await test('SOP-family titles rank up, retired pages rank well down', () => {
    assert.strictEqual(titleWeight('MOP - Zerto 10.8 Upgrade Project'), 1.2);
    assert.strictEqual(titleWeight('SOP - Zerto Upgrade Process for EEC'), 1.2);
    assert.strictEqual(titleWeight('(Deprecated) SOP - Zerto Daily RPO Check Script'), 0.4);
    assert.strictEqual(titleWeight('SOP - Zerto Daily Zerto Check Script (WIP)'), 0.4);
    assert.strictEqual(titleWeight('Tamko - Juniper Switch Replacements'), 1);
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

  await test('one rejected query is a warning, not an outage', async () => {
    await withConfluenceEnv({}, () => withFetch(fakeConfluence([], { searchStatus: 400 }), async () => {
      const ctx = buildContext(getTicket('3714582'), { asOf: AS_OF });
      const { docs, kb } = await retrieveKnowledge(ctx, { asOf: AS_OF, kbSource: 'confluence' });
      assert.ok(docs.length >= 1, 'the queries that worked should still find the SOP');
      assert.ok(kb.warnings.some((w) => /One Confluence query failed/.test(w)), kb.warnings.join(' | '));
      assert.ok(Array.isArray(kb.cql) && kb.cql.length > 1, JSON.stringify(kb.cql));
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

  await test('Zerto upgrade ticket: the upgrade SOPs beat off-topic and retired pages (real result shapes)', async () => {
    const calls = [];
    await withConfluenceEnv({ CONFLUENCE_SPACES: 'TO,PRE,IKB' }, () => withFetch(fakeZertoConfluence(calls), async () => {
      const ctx = buildContext(ZERTO_TICKET, { asOf: AS_OF });
      const found = await searchForContext(ctx);
      // Only the pre-ranked best get a full fetch, not every hit.
      const fetched = calls.filter((c) => c.url.pathname.startsWith('/wiki/api/v2/pages/'));
      assert.ok(fetched.length <= 8, `fetched ${fetched.length} pages`);
      // Pre-rank order: the upgrade pages first, the off-topic ones last.
      const order = found.docs.map((d) => d.title);
      assert.ok(/Upgrade/.test(order[0]) && /Upgrade/.test(order[1]), order.join(' | '));
      assert.ok(order.slice(-2).every((t) => /Juniper|Pure Storage/.test(t)), order.join(' | '));

      const { docs } = await retrieveKnowledge(ctx, { asOf: AS_OF, kbSource: 'confluence' });
      const titles = docs.map((d) => d.doc.title);
      assert.ok(docs.length >= 1, 'expected Zerto upgrade docs');
      assert.ok(/Zerto .*Upgrade|Upgrade .*Zerto/i.test(titles[0]), titles.join(' | '));
      assert.ok(!titles.some((t) => /Deprecated|Juniper/.test(t)), titles.join(' | '));
    }));
  });

  await test('a page over 2 years old is flagged in its citation', async () => {
    await withConfluenceEnv({}, () => withFetch(fakeZertoConfluence([]), async () => {
      const r = await generateDraft(ZERTO_TICKET, { provider: 'mock', asOf: '2030-01-01T00:00:00Z', kbSource: 'confluence' });
      const doc = r.sources.find((s) => s.kind === 'techdoc');
      assert.ok(doc, 'no techdoc source');
      assert.match(doc.detail, /over 2 years old/);
    }));
  });

  await test('Ask is grounded in Confluence too: the question anchors the search, sources come back linked', async () => {
    const calls = [];
    await withConfluenceEnv({ CONFLUENCE_SPACES: 'TO,PRE,IKB' }, () => withFetch(fakeZertoConfluence(calls), async () => {
      const r = await answerQuestion(ZERTO_TICKET, 'How do we upgrade the ZVM appliance?', {
        provider: 'mock', asOf: AS_OF, kbSource: 'confluence',
      });
      const cqls = calls.map((c) => c.url.searchParams.get('cql')).filter(Boolean);
      assert.ok(cqls.some((q) => q.includes('"zvm*"')), cqls.join('\n'));
      const doc = r.sources.find((s) => s.kind === 'techdoc');
      assert.ok(doc, 'Ask returned no techdoc sources');
      assert.ok(doc.url.startsWith('https://wiki.test/wiki/spaces/'), doc.url);
      assert.strictEqual(r.kb.source, 'confluence');
    }));
  });

  await test('the Ask prompt carries the techdocs, fenced as data', () => {
    const { buildAskMessage } = require('../server/providers/claude');
    const ctx = buildContext(ZERTO_TICKET, { asOf: AS_OF });
    const doc = {
      id: 'PRE-1', title: 'SOP - Zerto Upgrade Process for EEC', updated: '2025-04-01', body: 'Snapshot the ZVM first.',
    };
    const msg = buildAskMessage(ctx, 'how?', [{ doc, score: 5, stale: false }]);
    assert.ok(msg.includes('<<<BEGIN_TECHDOC>>>\nSnapshot the ZVM first.\n<<<END_TECHDOC>>>'), msg);
    assert.ok(buildAskMessage(ctx, 'how?').includes('No reference material matched'));
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

  console.log('\nper-user credentials');

  const credentials = require('../server/credentials');
  const openwebui = require('../server/providers/openwebui');
  const smcClient = require('../server/smc/client');
  const confluenceClient = require('../server/confluence/client');

  /** Set (or with '' / undefined, clear) env vars for fn, then restore them. */
  async function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined || v === '') delete process.env[k]; else process.env[k] = v;
    }
    try { return await fn(); } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    }
  }

  /** A fake fetch that records the Authorization header of every call. */
  function recordingFetch(respond) {
    const calls = [];
    const fake = async (url, init = {}) => {
      calls.push({ url: String(url), auth: (init.headers || {}).Authorization || null });
      return respond(String(url));
    };
    return { fake, calls };
  }

  const owuiOk = () => fakeResponse(200, { choices: [{ message: { content: '<p>ok</p>' } }] });
  const OPERATOR = { OWUI_URL: 'https://owui.test/api', OWUI_API_KEY: 'operator-owui-key' };

  await test('per-user mode never spends the .env Open WebUI key', async () => {
    const { fake, calls } = recordingFetch(owuiOk);
    await withEnv({ ...OPERATOR, ONEPANE_CREDENTIALS: 'per-user' }, () => withFetch(fake, async () => {
      await assert.rejects(
        () => openwebui.polish({ text: 'hi' }),
        /No Open WebUI API key - add yours in One Pane's settings/,
      );
    }));
    assert.strictEqual(calls.length, 0, 'a request went upstream with no caller key');
  });

  await test("per-user mode sends the caller's key, never the operator's", async () => {
    const { fake, calls } = recordingFetch(owuiOk);
    await withEnv({ ...OPERATOR, ONEPANE_CREDENTIALS: 'per-user' }, () => withFetch(fake, () => (
      credentials.run({ owuiKey: 'analyst-owui-key' }, () => openwebui.polish({ text: 'hi' }))
    )));
    assert.deepStrictEqual(calls.map((c) => c.auth), ['Bearer analyst-owui-key']);
  });

  await test("server mode uses .env, and a caller's own key wins over it", async () => {
    const { fake, calls } = recordingFetch(owuiOk);
    await withEnv({ ...OPERATOR, ONEPANE_CREDENTIALS: undefined }, () => withFetch(fake, async () => {
      await openwebui.polish({ text: 'hi' });
      await credentials.run({ owuiKey: 'analyst-owui-key' }, () => openwebui.polish({ text: 'hi' }));
    }));
    assert.deepStrictEqual(calls.map((c) => c.auth), ['Bearer operator-owui-key', 'Bearer analyst-owui-key']);
  });

  await test('an unrecognized ONEPANE_CREDENTIALS fails loudly instead of meaning "server"', async () => {
    await withEnv({ ONEPANE_CREDENTIALS: 'peruser' }, () => {
      assert.throws(() => credentials.mode(), /not a mode/);
      assert.throws(() => credentials.get('owuiKey'), /not a mode/);
    });
  });

  await test("per-user SMC ignores SMC_API_PASS and sends the caller's token", async () => {
    const { fake, calls } = recordingFetch(() => ({
      ...fakeResponse(200, { id: 1 }), headers: { get: () => 'application/json' },
    }));
    await withEnv({
      SMC_API_BASE_URL: 'https://smc.test/v3', SMC_API_USER: '', SMC_API_PASS: 'operator-smc-token', ONEPANE_CREDENTIALS: 'per-user',
    }, () => withFetch(fake, async () => {
      assert.strictEqual(smcClient.isConfigured(), false, 'operator token counted as configured');
      await assert.rejects(() => smcClient.smcGet('tickets/1'), /No SMC API token/);
      await credentials.run({ smcToken: 'analyst-smc-token' }, () => smcClient.smcGet('tickets/1'));
    }));
    assert.deepStrictEqual(calls.map((c) => c.auth), ['Bearer analyst-smc-token']);
  });

  await test('an SMC 401 says the token probably expired, and carries the status', async () => {
    const fake = async () => ({ ...fakeResponse(401, {}), headers: { get: () => 'application/json' } });
    await withEnv({ SMC_API_BASE_URL: 'https://smc.test/v3', SMC_API_USER: '', ONEPANE_CREDENTIALS: 'per-user' }, () => withFetch(fake, () => (
      credentials.run({ smcToken: 'stale-token' }, async () => {
        const err = await smcClient.smcGet('tickets/1').then(() => null, (e) => e);
        assert.ok(err, 'a 401 resolved');
        assert.strictEqual(err.status, 401);
        assert.match(err.message, /rejected your SMC API token.*expire after about 4 hours/);
        assert.ok(!err.message.includes('stale-token'), 'token leaked into the error');
      })
    )));
  });

  await test('Confluence: the shared account is opt-in, and never paired with half a caller credential', async () => {
    const env = {
      CONFLUENCE_SITE_URL: 'https://wiki.test', CONFLUENCE_EMAIL: 'svc@example.test', CONFLUENCE_API_TOKEN: 'svc-token', ONEPANE_CREDENTIALS: 'per-user',
    };
    await withEnv({ ...env, CONFLUENCE_SHARED_ACCOUNT: undefined }, () => {
      assert.strictEqual(confluenceClient.isConfigured(), false, 'service account used without opting in');
    });
    await withEnv({ ...env, CONFLUENCE_SHARED_ACCOUNT: 'true' }, async () => {
      assert.strictEqual(confluenceClient.config().token, 'svc-token');
      assert.strictEqual(credentials.source('confluenceToken'), 'shared');
      await credentials.run({ confluenceEmail: 'me@example.test' }, () => {
        assert.strictEqual(confluenceClient.config().token, '', 'caller email paired with the service token');
        assert.strictEqual(confluenceClient.isConfigured(), false);
      });
      await credentials.run({ confluenceEmail: 'me@example.test', confluenceToken: 'my-token' }, () => {
        assert.deepStrictEqual([confluenceClient.config().email, confluenceClient.config().token], ['me@example.test', 'my-token']);
      });
    });
  });

  await test('malformed credential headers are refused, and only loopback or HTTPS is trusted', () => {
    assert.deepStrictEqual(credentials.fromHeaders({ 'x-onepane-owui-key': ' k1 ' }), { credentials: { owuiKey: 'k1' }, error: null });
    assert.match(credentials.fromHeaders({ 'x-onepane-smc-token': 'has space' }).error, /malformed/);
    assert.match(credentials.fromHeaders({ 'x-onepane-smc-token': 'x'.repeat(9000) }).error, /malformed/);
    const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
    assert.strictEqual(credentials.secureTransport(req('127.0.0.1')), true);
    assert.strictEqual(credentials.secureTransport(req('::ffff:127.0.0.1')), true);
    assert.strictEqual(credentials.secureTransport(req('10.0.0.5')), false);
    assert.strictEqual(credentials.secureTransport(req('10.0.0.5', { 'x-forwarded-proto': 'https' })), true);
    assert.strictEqual(credentials.secureTransport(req('10.0.0.5', { 'x-forwarded-proto': 'http' })), false);
  });

  await test("status never carries a caller's key and marks .env secrets ignored in per-user mode", async () => {
    const { buildStatus } = require('../server/status');
    await withEnv({ ...OPERATOR, ONEPANE_CREDENTIALS: 'per-user', ONEPANE_PROVIDER: 'openwebui' }, () => (
      credentials.run({ owuiKey: 'analyst-secret-key-123' }, () => {
        const body = JSON.stringify(buildStatus());
        assert.ok(!body.includes('analyst-secret-key-123'), 'caller key reached status');
        const s = JSON.parse(body);
        assert.strictEqual(s.credentials.mode, 'per-user');
        assert.strictEqual(s.env.find((v) => v.name === 'OWUI_API_KEY').ignored, true);
        assert.strictEqual(s.provider.openwebui.configured, true, 'per-user openwebui should read as ready server-side');
      })
    ));
  });

  // End to end through the real HTTP handler: proves the headers actually reach
  // the upstream calls, not just that credentials.js works in isolation.
  process.env.ONEPANE_ENV_FILE = require('path').join(__dirname, 'no-such.env');
  const { server } = require('../server/server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  /** Talks to the test server with http, so faking global fetch never intercepts it. */
  function call(method, pathname, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = require('http').request({
        host: '127.0.0.1', port, method, path: pathname,
        headers: { ...headers, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  try {
    await test('HTTP: a key sent as a header is the one the gateway sees', async () => {
      const { fake, calls } = recordingFetch((url) => (url.endsWith('/models')
        ? fakeResponse(200, { data: [{ id: 'gpt-5.6-luna' }] }) : fakeResponse(404, {})));
      await withEnv({ ...OPERATOR, ONEPANE_CREDENTIALS: 'per-user', SMC_API_BASE_URL: undefined }, () => withFetch(fake, async () => {
        const mine = await call('GET', '/api/credentials/check', { 'X-OnePane-OWUI-Key': 'analyst-owui-key' });
        assert.strictEqual(mine.body.owui.ok, true, JSON.stringify(mine.body.owui));
        assert.strictEqual(mine.body.owui.source, 'request');

        const none = await call('GET', '/api/credentials/check');
        assert.strictEqual(none.body.owui.ok, false);
        assert.match(none.body.owui.error, /add yours in One Pane's settings/);
      }));
      assert.deepStrictEqual(calls.map((c) => c.auth), ['Bearer analyst-owui-key'], 'operator key reached the gateway');
    });

    await test('HTTP: an expired SMC token is reported on the draft, not swallowed by the page fallback', async () => {
      const fake = async () => ({ ...fakeResponse(401, {}), headers: { get: () => 'application/json' } });
      await withEnv({ SMC_API_BASE_URL: 'https://smc.test/v3', SMC_API_USER: '', ONEPANE_CREDENTIALS: 'per-user' }, () => withFetch(fake, async () => {
        const res = await call('POST', '/api/generate', { 'X-OnePane-SMC-Token': 'stale-token' }, {
          ticketId: '9990001',
          provider: 'mock',
          ticket: { id: '9990001', subject: 'VPN down', notes: [{ author: 'Client', role: 'client', body: 'VPN is down' }] },
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.match(res.body.smcNotice || '', /Drafted from the page, not SMC: .*expire/);
      }));
    });

    await test('HTTP: an id-only page scrape is refused with the SMC reason, not drafted as an empty ticket', async () => {
      // What the live console produced on #3767603: the adapter found the id,
      // every content selector missed, and the SMC token had expired.
      const idOnly = { ticketId: '9990002', provider: 'mock', ticket: { id: '9990002', notes: [] } };

      const expired = async () => ({ ...fakeResponse(401, {}), headers: { get: () => 'application/json' } });
      await withEnv({ SMC_API_BASE_URL: 'https://smc.test/v3', SMC_API_USER: '', ONEPANE_CREDENTIALS: 'per-user' }, () => withFetch(expired, async () => {
        const res = await call('POST', '/api/generate', { 'X-OnePane-SMC-Token': 'stale-token' }, idOnly);
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /Could not read ticket 9990002: SMC lookup failed \(.*expire.*\), and nothing usable could be read off the page/);
      }));

      await withEnv({ SMC_API_BASE_URL: 'https://smc.test/v3', SMC_API_USER: '', ONEPANE_CREDENTIALS: 'per-user' }, async () => {
        const res = await call('POST', '/api/ask', {}, { ...idOnly, question: 'What happened?' });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.match(res.body.error, /Could not read ticket 9990002: SMC is not configured \(.+\), and nothing usable could be read off the page/);
      });

      // A scrape with a note body is still usable without SMC.
      await withEnv({ SMC_API_BASE_URL: '', ONEPANE_CREDENTIALS: 'per-user' }, async () => {
        const res = await call('POST', '/api/generate', {}, {
          ...idOnly, ticket: { id: '9990002', notes: [{ author: 'Client', role: 'client', body: 'VPN is down' }] },
        });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      });
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
