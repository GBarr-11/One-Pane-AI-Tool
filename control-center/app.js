'use strict';

/**
 * One Pane Control Center.
 *
 * Renders entirely from this server's own endpoints:
 *   GET /api/status           local wiring snapshot (no network behind it)
 *   GET /api/activity         recent calls, metadata only
 *   GET /api/provider/health  live, token-free gateway probe
 *   GET /api/confluence/health, /api/confluence/search, /api/smc/tickets/:id
 *
 * Read-only by design. Nothing on this page changes configuration, and the
 * only calls it makes upstream are the GET probes an analyst asks for.
 * Every value from the server is escaped before it reaches the DOM.
 */

const POLL_MS = 5000;
const EXT_FRESH_MS = 15 * 60 * 1000;

const state = {
  status: null,
  activity: { entries: [], summary: { total: 0, errors: 0, byRoute: {} } },
  probes: { provider: null, confluence: null },
  probing: false,
  lastOk: 0,
  failed: false,
  callerFilter: 'all',
};

// --------------------------------------------------------------------------
// Helpers

const $ = (sel) => document.querySelector(sel);

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const ICON = {
  good: 'i-check', warn: 'i-alert', bad: 'i-x', info: 'i-dot',
};

function badge(level, label) {
  return `<span class="badge ${level}"><svg class="i"><use href="#${ICON[level]}"/></svg>${esc(label)}</span>`;
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function duration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}

const PROVIDER_LABEL = {
  openwebui: 'Open WebUI', claude: 'Claude API', mock: 'Offline mock', none: 'None',
};

// --------------------------------------------------------------------------
// Component state: one place decides what "ready" means for each part.

/** In per-user mode, the key fact is where keys come from, not whether this page sent one. */
function perUserKey(s) {
  return s.credentials && s.credentials.mode === 'per-user' ? 'each analyst’s own, from the extension' : null;
}

function components(s) {
  const p = s.provider;
  const kb = s.knowledgeBase;
  const pp = state.probes.provider;
  const cp = state.probes.confluence;
  const mock = s.mode.kind === 'mock';
  // Per-user mode: the server holds no keys by design, and this page sends
  // none, so "no key" here is the correct state rather than a fault.
  const perUser = s.credentials && s.credentials.mode === 'per-user';
  const PER_USER = { level: 'info', label: 'Per-user keys' };

  const provider = (() => {
    if (p.active === 'none') return { level: 'bad', label: 'Not configured' };
    if (p.active === 'mock') return { level: 'info', label: 'Offline mock' };
    if (perUser) return p.active !== 'openwebui' || p.openwebui.gatewayHost ? PER_USER : { level: 'bad', label: 'No gateway' };
    if (!pp) return { level: 'info', label: 'Checking…' };
    if (pp.ok && pp.modelListed === false) return { level: 'warn', label: 'Model not listed' };
    return pp.ok ? { level: 'good', label: 'Ready' } : { level: 'bad', label: 'Unreachable' };
  })();

  const confluenceSite = Boolean(kb.confluence.siteUrl);
  const knowledge = (() => {
    if (perUser && confluenceSite && !kb.confluence.configured) return PER_USER;
    if (kb.source === 'none') return { level: 'warn', label: 'Not configured' };
    if (kb.source === 'mock') return { level: 'info', label: 'Mock corpus' };
    if (!kb.confluence.configured) return { level: 'bad', label: 'Selected, not configured' };
    if (!cp) return { level: 'info', label: 'Checking…' };
    return cp.ok ? { level: 'good', label: 'Ready' } : { level: 'bad', label: 'Failing' };
  })();

  const confluenceNode = perUser && confluenceSite && !kb.confluence.configured ? PER_USER : kb.confluence.configured
    ? (cp ? (cp.ok ? { level: 'good', label: 'Ready' } : { level: 'bad', label: 'Failing' }) : { level: 'info', label: 'Checking…' })
    : { level: 'warn', label: 'Not configured' };

  // Set is not the same as working: v3 tokens expire in about 4 hours, and
  // there is no free probe that does not fetch a real ticket. So a configured
  // SMC stays neutral until Diagnostics proves a ticket actually comes back.
  const smc = perUser && s.smc.baseUrl ? PER_USER : s.smc.configured
    ? { level: 'info', label: 'Configured, unverified' }
    : { level: 'warn', label: 'Not configured' };

  const ext = s.extension.lastSeenAt
    ? (Date.now() - new Date(s.extension.lastSeenAt) < EXT_FRESH_MS
      ? { level: 'good', label: 'Connected' }
      : { level: 'info', label: 'Idle' })
    : { level: 'info', label: 'No contact yet' };

  return {
    server: s.server.loopbackOnly ? { level: 'good', label: 'Running' } : { level: 'warn', label: 'Running, not loopback' },
    provider,
    knowledge,
    confluenceNode,
    smc,
    ext,
    mock,
  };
}

// --------------------------------------------------------------------------
// Render: header, hero, stats

function renderChrome(s, c) {
  const pill = $('#modePill');
  pill.className = `mode-pill ${s.mode.kind}`;
  pill.textContent = s.mode.kind === 'mock' ? 'Mock pack' : 'Production';

  const banner = $('#mockBanner');
  banner.hidden = s.mode.kind !== 'mock';
  if (s.mode.mockConsole) $('#mockConsoleLink').setAttribute('href', s.mode.mockConsole);

  $('#version').textContent = `v${s.server.version} · Node ${s.server.node}`;
  $('#bindNote').textContent = s.server.loopbackOnly
    ? `Bound to ${s.server.host || '127.0.0.1'} - loopback only`
    : `Bound to ${s.server.host} - reachable beyond this machine`;

  const needs = [c.provider, c.knowledge, c.smc].filter((x) => x.level === 'warn' || x.level === 'bad').length;
  const kbText = s.knowledgeBase.source === 'confluence'
    ? `Confluence${s.knowledgeBase.confluence.spaces.length ? ` (${s.knowledgeBase.confluence.spaces.join(', ')})` : ''}`
    : s.knowledgeBase.source === 'mock' ? 'the mock techdoc corpus' : 'no knowledge base';
  const provText = s.provider.active === 'none'
    ? 'No generation provider is configured, so drafting is refused'
    : s.provider.active === 'mock' ? 'Drafting with the offline mock generator' : `Drafting through ${PROVIDER_LABEL[s.provider.active] || s.provider.active}`;
  $('#lede').textContent = `${provText}, grounded in ${kbText}. `
    + (needs ? `${needs} ${needs === 1 ? 'component needs' : 'components need'} setup.` : 'Every server-side component is configured.');

  const sum = state.activity.summary;
  const ext = s.extension.lastSeenAt;
  $('#stats').innerHTML = [
    { label: 'Uptime', value: duration(s.server.uptimeSec), sub: `since ${new Date(s.server.startedAt).toLocaleTimeString()}` },
    { label: 'API calls', value: sum.total, sub: 'since start, not counting this page' },
    { label: 'Errors', value: sum.errors, sub: sum.errors ? 'see Activity' : 'none recorded' },
    { label: 'Extension', value: ext ? ago(ext) : '-', sub: ext ? `last call ${s.extension.lastRoute}` : 'no call from the extension yet' },
  ].map((t) => `
    <div class="stat">
      <p class="stat-label">${esc(t.label)}</p>
      <div class="stat-value">${esc(t.value)}</div>
      <div class="stat-sub" title="${esc(t.sub)}">${esc(t.sub)}</div>
    </div>`).join('');
}

// --------------------------------------------------------------------------
// Render: pipeline diagram

function renderDiagram(s, c) {
  const W = 160;
  const H = 66;
  const nodes = {
    console: {
      x: 30, y: 24, title: 'SMC Console', meta: c.mock ? `mock: ${s.mode.mockConsole}` : 'app.expedient.com', st: { level: 'info', label: 'Analyst’s browser' },
    },
    reply: {
      x: 840, y: 24, title: 'Reply Box', meta: 'draft only', st: { level: 'info', label: 'Analyst reviews + sends' },
    },
    ext: {
      x: 30, y: 176, title: 'Extension', meta: 'MV3 service worker', st: c.ext,
    },
    resolve: {
      x: 240, y: 176, title: 'Resolve Ticket', meta: c.mock ? 'mock → SMC → inline' : 'SMC → inline', st: { level: 'good', label: 'Ready' }, core: true,
    },
    retrieve: {
      x: 440, y: 176, title: 'Retrieve + Gate', meta: `kb: ${s.knowledgeBase.source}`, st: c.knowledge, core: true,
    },
    generate: {
      x: 640, y: 176, title: 'Generate', meta: `provider: ${s.provider.active}`, st: c.provider, core: true,
    },
    sanitize: {
      x: 840, y: 176, title: 'Sanitize', meta: 'HTML allowlist', st: { level: 'good', label: 'Ready' }, core: true,
    },
    aictrl: {
      x: 30, y: 330, title: 'AI CTRL', meta: 'Cole · /api/query', st: { level: 'info', label: 'Extension-side' },
    },
    smc: {
      x: 240, y: 330, title: 'SMC API v3', meta: s.smc.baseUrl ? hostOf(s.smc.baseUrl) : 'unset', st: c.smc,
    },
    confluence: {
      x: 440, y: 330, title: 'Confluence', meta: s.knowledgeBase.confluence.siteUrl ? hostOf(s.knowledgeBase.confluence.siteUrl) : 'unset', st: c.confluenceNode,
    },
    gateway: {
      x: 640,
      y: 330,
      title: 'Model Gateway',
      meta: s.provider.active === 'openwebui' ? (s.provider.openwebui.gatewayHost || 'unset')
        : s.provider.active === 'claude' ? 'api.anthropic.com' : '-',
      st: s.provider.active === 'mock' ? { level: 'info', label: 'Not used' } : c.provider,
    },
  };

  const cx = (n) => n.x + W / 2;
  const trunc = (t, max) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

  const edge = (x1, y1, x2, y2, label, dash, lx, ly) => `
    <path class="edge${dash ? ' dash' : ''}" d="M${x1} ${y1} L${x2} ${y2}" marker-end="url(#arrow)"/>
    ${label ? `<text class="edge-label" x="${lx != null ? lx : (x1 + x2) / 2 + 8}" y="${ly != null ? ly : (y1 + y2) / 2 + 4}">${esc(label)}</text>` : ''}`;

  const node = (n) => `
    <g class="node${n.core ? ' core' : ''}">
      <title>${esc(`${n.title}: ${n.st.label}`)}</title>
      <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}"/>
      <rect class="bar-${n.st.level}" x="${n.x}" y="${n.y}" width="4" height="${H}" style="stroke:none"/>
      <text class="title" x="${n.x + 16}" y="${n.y + 22}">${esc(n.title)}</text>
      <text class="meta" x="${n.x + 16}" y="${n.y + 39}">${esc(trunc(n.meta, 22))}</text>
      <text class="state ${n.st.level}" x="${n.x + 16}" y="${n.y + 56}">${esc(n.st.label)}</text>
    </g>`;

  const N = nodes;
  const midY = N.ext.y + H / 2;
  $('#diagram').innerHTML = `
    <svg class="diagram" viewBox="0 0 1030 420" role="img" aria-label="One Pane pipeline: SMC console, extension, ticket resolution, retrieval, generation, sanitizer, reply box, with SMC API, Confluence, model gateway and AI CTRL as upstream services">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path class="arrowhead" d="M0 0 L10 5 L0 10 z"/>
        </marker>
      </defs>

      <rect class="zone" x="222" y="150" width="796" height="118"/>
      <text class="zone-label" x="232" y="144">ONE PANE SERVER · ${esc(s.mode.kind === 'mock' ? 'MOCK PACK' : 'PRODUCTION')}</text>
      <text class="zone-label" x="30" y="414">UPSTREAM SERVICES · READ-ONLY</text>

      ${edge(cx(N.console), N.console.y + H, cx(N.ext), N.ext.y, 'reads ticket from DOM')}
      ${edge(N.ext.x + W, midY, N.resolve.x, midY)}
      ${edge(N.resolve.x + W, midY, N.retrieve.x, midY)}
      ${edge(N.retrieve.x + W, midY, N.generate.x, midY)}
      ${edge(N.generate.x + W, midY, N.sanitize.x, midY)}
      ${edge(cx(N.sanitize), N.sanitize.y, cx(N.reply), N.reply.y + H, 'draft HTML → panel', false, cx(N.sanitize) - 124)}
      ${edge(cx(N.smc), N.smc.y, cx(N.resolve), N.resolve.y + H, 'GET ticket')}
      ${edge(cx(N.confluence), N.confluence.y, cx(N.retrieve), N.retrieve.y + H, 'CQL search')}
      ${edge(cx(N.gateway), N.gateway.y, cx(N.generate), N.generate.y + H, s.provider.active === 'mock' ? '' : 'completion')}
      ${edge(cx(N.aictrl), N.aictrl.y, cx(N.ext), N.ext.y + H, 'Ask tab', true)}

      ${Object.values(N).map(node).join('')}

      <text class="edge-label" x="840" y="360">Nothing is posted to SMC.</text>
      <text class="edge-label" x="840" y="376">No write path exists.</text>
    </svg>`;
}

// --------------------------------------------------------------------------
// Render: component cards

function facts(rows) {
  return `<dl class="facts">${rows.filter(Boolean).map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${v}</dd>`).join('')}</dl>`;
}

const yes = (b, y = 'set', n = 'unset') => (b ? esc(y) : `<span class="secret">${esc(n)}</span>`);

function renderCards(s, c) {
  const p = s.provider;
  const kb = s.knowledgeBase;
  const pp = state.probes.provider;
  const cp = state.probes.confluence;

  const cards = [
    {
      icon: 'i-server',
      title: 'One Pane Server',
      sub: 'server/server.js',
      st: c.server,
      body: facts([
        ['Mode', s.mode.kind === 'mock' ? `mock pack <span class="mono">${esc(s.mode.pack)}</span>` : 'production'],
        ['Bind', esc(`${s.server.host || '127.0.0.1'}:${s.server.port || 3000}`), true],
        ['Uptime', esc(duration(s.server.uptimeSec))],
        ['Auth', '<span class="secret">none - loopback only</span>'],
        ['Upstream keys', s.credentials && s.credentials.mode === 'per-user'
          ? 'each caller’s own (per-user)'
          : '<span class="secret">this server’s .env (server mode)</span>'],
      ]),
    },
    {
      icon: 'i-puzzle',
      title: 'Browser Extension',
      sub: 'extension/ · MV3',
      st: c.ext,
      body: facts([
        ['Last call', esc(s.extension.lastSeenAt ? ago(s.extension.lastSeenAt) : 'none since start')],
        s.extension.lastRoute ? ['Route', esc(s.extension.lastRoute), true] : null,
        ['Injects on', 'app.expedient.com', true],
      ]),
      note: 'Detected from requests carrying a chrome-extension:// origin. Load the unpacked build from extension/ to connect.',
    },
    {
      icon: 'i-spark',
      title: 'Generation Provider',
      sub: `ONEPANE_PROVIDER=${p.requested || '(unset)'}`,
      st: c.provider,
      body: facts([
        ['Active', esc(PROVIDER_LABEL[p.active] || p.active)],
        ['Model', esc(p.model || (p.active === 'openwebui' ? 'gpt-5.6-luna (default)' : p.active === 'claude' ? 'claude-opus-5 (default)' : '-')), true],
        p.active === 'openwebui' ? ['Gateway', esc(p.openwebui.gatewayHost || 'unset'), true] : null,
        p.active === 'openwebui' ? ['API key', perUserKey(s) || yes(p.openwebui.keyPresent)] : null,
        p.active === 'claude' ? ['API key', perUserKey(s) || yes(p.claude.keyPresent)] : null,
        p.active === 'claude' ? ['SDK', yes(p.claude.sdkInstalled, 'installed', 'not installed')] : null,
        pp && pp.ms != null ? ['Probe', esc(`${pp.ms} ms · ${pp.modelCount} models`)] : null,
        pp && !pp.ok && pp.error ? ['Error', `<span style="color:var(--bad-ink)">${esc(pp.error)}</span>`] : null,
        ['Available', esc(p.available.join(', ')), true],
      ]),
      action: p.active !== 'none' && p.active !== 'mock' ? '<button class="btn" data-probe="provider" type="button">Test connection</button>' : '',
    },
    {
      icon: 'i-book',
      title: 'Knowledge Base',
      sub: `ONEPANE_KB_SOURCE=${kb.requested}`,
      st: c.knowledge,
      body: facts([
        ['Source', esc(kb.source)],
        ['Site', esc(kb.confluence.siteUrl ? hostOf(kb.confluence.siteUrl) : 'unset'), true],
        ['Token', (!s.credentials.sharedConfluence && perUserKey(s)) || yes(kb.confluence.tokenPresent)],
        ['Spaces', esc(kb.confluence.spaces.length ? kb.confluence.spaces.join(', ') : 'all the token can see'), true],
        kb.confluence.labels.length ? ['Labels', esc(kb.confluence.labels.join(', ')), true] : null,
        cp && cp.authenticatedAs ? ['Signed in as', esc(cp.authenticatedAs)] : null,
        cp && !cp.ok && cp.error ? ['Error', `<span style="color:var(--bad-ink)">${esc(cp.error)}</span>`] : null,
      ]),
      note: kb.source === 'none' ? 'Drafts run with no techdocs, so the confidence gate abstains on most tickets.' : '',
      action: kb.confluence.configured ? '<button class="btn" data-probe="confluence" type="button">Test connection</button>' : '',
    },
    {
      icon: 'i-ticket',
      title: 'SMC API',
      sub: 'server/smc/ · GET only',
      st: c.smc,
      body: facts([
        ['Base URL', esc(s.smc.baseUrl || 'unset'), true],
        ['Auth', esc(s.smc.authScheme || '-')],
        ['Token', perUserKey(s) || yes(s.smc.keyPresent)],
        ['Write path', 'none - by construction'],
      ]),
      note: s.smc.configured
        ? 'v3 tokens are per-person and expire in about 4 hours, so set does not mean valid. Check a ticket under Diagnostics.'
        : 'Without it, tickets are drafted from what the extension reads off the page.',
    },
    {
      icon: 'i-link',
      title: 'AI CTRL (Cole)',
      sub: 'colemains/ai-ctrl-operations-assistant',
      st: { level: 'info', label: 'Extension-side' },
      body: facts([
        ['Used by', 'the extension’s Ask tab'],
        ['Local', 'localhost:8080', true],
        ['Staging', 'ai-assistant-staging.expedient.cloud', true],
      ]),
      note: 'The extension calls it directly. This server never does, so it cannot see its health.',
    },
  ];

  $('#cards').innerHTML = cards.map((k) => `
    <article class="card">
      <div class="card-head">
        <span class="ico"><svg class="i"><use href="#${k.icon}"/></svg></span>
        <div class="titles"><h3>${esc(k.title)}</h3><div class="sub mono">${esc(k.sub)}</div></div>
        ${badge(k.st.level, k.st.label)}
      </div>
      <div class="card-body">${k.body}${k.note ? `<p class="card-note">${esc(k.note)}</p>` : ''}</div>
      ${k.action ? `<div class="card-foot">${k.action}</div>` : ''}
    </article>`).join('');
}

// --------------------------------------------------------------------------
// Render: readiness

function renderReadiness(s, c) {
  const items = [
    s.mode.kind === 'production'
      ? ['good', 'Done', 'Running without the mock pack', 'No fixture tickets, techdocs, or precedent are loaded. Live tickets never meet invented history.']
      : ['warn', 'Mock', 'Mock pack is loaded', 'Fine for a demo. Run `npm start` for the production server.'],
    s.server.loopbackOnly
      ? ['good', 'Done', 'Bound to loopback only', '/api/generate is unauthenticated, so nothing else on the network can reach it.']
      : ['bad', 'Risk', `Bound to ${s.server.host}`, 'The server has no authentication. Anyone who can reach it can spend the gateway key.'],
    [c.provider.level === 'good' ? 'good' : c.provider.level === 'info' ? 'info' : 'bad', c.provider.label, 'Generation provider', 'ONEPANE_PROVIDER plus its key. Production has no offline fallback.'],
    s.credentials.mode === 'per-user'
      ? ['good', 'Done', 'Per-user credentials', 'Every caller spends their own Open WebUI, SMC, and Confluence keys, sent from the extension. .env secrets are ignored.']
      : ['warn', 'Server keys', 'Per-user credentials', 'Callers without their own keys spend this server’s .env keys. Set ONEPANE_CREDENTIALS=per-user before anyone else can reach it.'],
    [s.knowledgeBase.confluence.configured ? (c.knowledge.level === 'bad' ? 'bad' : 'good') : 'warn',
      s.knowledgeBase.confluence.configured ? c.knowledge.label : 'To do', 'Confluence knowledge base', 'Real CQL siteSearch and v2 include-labels responses have not been checked against the live tenant yet. Coordinate the credential with Cole.'],
    ['warn', s.smc.configured || s.credentials.mode === 'per-user' ? 'Pasted tokens' : 'To do', 'SMC API credential', 'v3 tokens are per-person and expire in about 4 hours, so analysts re-paste them in the extension. Next step: get them through an IS-AUTH sign-in instead of pasting.'],
    ['warn', 'To do', 'Server authentication and budget cap', 'No caller auth and no per-user spend cap. Cole’s side already has a cap.'],
    ['warn', 'To do', 'Analyst identity (WorkOS)', 'resolveAuthContext() is a stub that fails closed. Reuse Cole’s WorkOS roles, not a second identity model.'],
    ['warn', 'To do', 'SMC DOM selectors', 'Subject, client, severity, and note classification have never seen the real console DOM.'],
    ['warn', 'To do', 'Deployed home', 'STAGING_BACKENDS.onePane is null. Cole’s staging already has a URL.'],
  ];

  $('#readiness').innerHTML = items.map(([level, label, what, why]) => `
    <li>
      <div>${badge(level, label)}</div>
      <div><div class="what">${esc(what)}</div><div class="why">${esc(why)}</div></div>
    </li>`).join('');
}

// --------------------------------------------------------------------------
// Render: activity

const CALLERS = [
  ['all', 'All'], ['extension', 'Extension'], ['control-center', 'Control Center'], ['mock-console', 'Mock console'], ['direct', 'Direct'],
];

function renderChips() {
  $('#callerChips').innerHTML = CALLERS.map(([id, label]) => `
    <button class="chip" type="button" data-caller="${id}" aria-pressed="${state.callerFilter === id}">${esc(label)}</button>`).join('');
}

function statusBadge(code, isErr) {
  if (code == null) return badge('info', '…');
  if (code >= 500 || isErr) return badge('bad', String(code));
  if (code >= 400) return badge('warn', String(code));
  return badge('good', String(code));
}

const CONF_LEVEL = { high: 'good', medium: 'warn', low: 'bad' };

function renderActivity() {
  const rows = state.activity.entries.filter((e) => state.callerFilter === 'all' || e.caller === state.callerFilter);
  $('#activityRows').innerHTML = rows.length
    ? rows.map((e) => `
      <tr>
        <td class="nowrap mono" title="${esc(e.at)}">${esc(new Date(e.at).toLocaleTimeString())}</td>
        <td class="nowrap">${esc(e.caller)}</td>
        <td class="mono nowrap">${esc(e.method)} ${esc(e.route)}</td>
        <td class="mono nowrap">${e.ticketId ? `${esc(e.ticketId)}${e.origin ? ` <span class="secret">${esc(e.origin)}</span>` : ''}` : ''}</td>
        <td class="nowrap">${esc(e.provider || '')}</td>
        <td>${e.confidence ? badge(CONF_LEVEL[e.confidence] || 'info', e.confidence) : ''}${e.kbGap ? ` <span class="secret" title="No SOP on the wiki covers this ticket">no SOP</span>` : ''}</td>
        <td>${statusBadge(e.status, e.error)}</td>
        <td class="num">${e.ms == null ? '' : esc(e.ms)}</td>
      </tr>`).join('')
    : `<tr><td colspan="8" class="empty">${state.activity.entries.length ? 'No calls from this caller yet.' : 'No API calls yet. Draft from the extension, or run a probe under Diagnostics.'}</td></tr>`;

  const byRoute = Object.entries(state.activity.summary.byRoute || {}).sort((a, b) => b[1] - a[1]);
  const max = byRoute.length ? byRoute[0][1] : 1;
  $('#routeBars').innerHTML = byRoute.length
    ? byRoute.map(([route, n]) => `
      <div class="bar-row" title="${esc(`${route}: ${n}`)}">
        <span class="label">${esc(route)}</span>
        <span class="track"><span class="fill" style="width:${Math.max(2, (n / max) * 100)}%"></span></span>
        <span class="val">${esc(n)}</span>
      </div>`).join('')
    : '<div class="empty">Nothing yet.</div>';
}

// --------------------------------------------------------------------------
// Render: configuration

function renderConfig(s) {
  let group = null;
  const html = [];
  for (const v of s.env) {
    if (v.group !== group) {
      group = v.group;
      html.push(`<tr class="group-row"><td colspan="4">${esc(group)}</td></tr>`);
    }
    const value = v.secret
      ? (v.set ? '<span class="secret">hidden - secret</span>' : '')
      : (v.value ? `<span class="mono">${esc(v.value)}</span>` : '');
    html.push(`
      <tr>
        <td class="mono nowrap">${esc(v.name)}</td>
        <td>${v.ignored ? badge('warn', 'Ignored') : v.set ? badge('good', 'Set') : badge('info', 'Unset')}</td>
        <td>${value}</td>
        <td>${esc(v.about)}</td>
      </tr>`);
  }
  $('#envRows').innerHTML = html.join('');
  $('#extOnePane').textContent = `http://localhost:${s.server.port || 3000}`;
}

// --------------------------------------------------------------------------
// Data flow

function renderAll() {
  const s = state.status;
  if (!s) return;
  const c = components(s);
  renderChrome(s, c);
  renderDiagram(s, c);
  renderCards(s, c);
  renderReadiness(s, c);
  renderActivity();
  renderConfig(s);
}

function renderUpdated() {
  const el = $('#updated');
  el.classList.toggle('stale', state.failed);
  el.querySelector('span').textContent = state.failed
    ? 'Server unreachable'
    : state.lastOk ? `Updated ${ago(new Date(state.lastOk).toISOString())}` : 'Connecting…';
}

async function refresh() {
  try {
    const [status, act] = await Promise.all([getJson('/api/status'), getJson('/api/activity?limit=100')]);
    state.status = status;
    state.activity = act;
    state.lastOk = Date.now();
    state.failed = false;
    renderAll();
  } catch {
    state.failed = true;
  }
  renderUpdated();
}

async function probe(which) {
  const s = state.status;
  if (!s) return;
  if (which === 'provider' || which === 'all') {
    if (s.provider.active !== 'none' && s.provider.active !== 'mock') {
      state.probes.provider = null;
      renderAll();
      try { state.probes.provider = await getJson('/api/provider/health'); } catch (err) { state.probes.provider = { ok: false, error: err.message }; }
    }
  }
  if (which === 'confluence' || which === 'all') {
    if (s.knowledgeBase.confluence.configured) {
      state.probes.confluence = null;
      renderAll();
      try { state.probes.confluence = await getJson('/api/confluence/health'); } catch (err) { state.probes.confluence = { ok: false, error: err.message }; }
    }
  }
  await refresh();
}

// --------------------------------------------------------------------------
// Diagnostics tools

function errorBlock(msg) {
  return `<div class="err"><svg class="i"><use href="#i-x"/></svg><span>${esc(msg)}</span></div>`;
}

async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; }
}

$('#confForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = $('#confQ').value.trim();
  const out = $('#confResult');
  if (!q) return;
  withBusy(ev.submitter || $('#confForm button'), async () => {
    out.innerHTML = '<span class="secret">Searching…</span>';
    try {
      const r = await getJson(`/api/confluence/search?q=${encodeURIComponent(q)}`);
      out.innerHTML = r.results.length
        ? r.results.map((h) => `
          <div class="hit">
            ${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>` : `<strong>${esc(h.title)}</strong>`}
            <div class="ex">${esc([h.space, h.lastModified && `updated ${String(h.lastModified).slice(0, 10)}`].filter(Boolean).join(' · '))}</div>
            ${h.excerpt ? `<div class="ex">${esc(h.excerpt)}</div>` : ''}
          </div>`).join('')
        : '<span class="secret">No pages matched.</span>';
    } catch (err) {
      out.innerHTML = errorBlock(err.message);
    }
  });
});

$('#smcForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const id = $('#smcId').value.trim();
  const out = $('#smcResult');
  if (!id) return;
  withBusy(ev.submitter || $('#smcForm button'), async () => {
    out.innerHTML = '<span class="secret">Fetching…</span>';
    try {
      const r = await getJson(`/api/smc/tickets/${encodeURIComponent(id)}`);
      const sm = r.summary || {};
      out.innerHTML = `
        ${facts([
    ['Ticket', esc(sm.id), true],
    ['Notes', esc(sm.noteCount)],
    ['Roles', esc(Object.entries(sm.roleCounts || {}).map(([k, v]) => `${k} ${v}`).join(', ') || '-')],
    ['Last note', esc(sm.lastNoteRole || '-')],
    ['Empty fields', esc((sm.emptyFields || []).join(', ') || 'none'), true],
  ])}
        ${(r.warnings || []).length ? `<p class="card-note">${esc(r.warnings.join(' · '))}</p>` : ''}`;
    } catch (err) {
      out.innerHTML = errorBlock(err.message);
    }
  });
});

$('#probeProviderBtn').addEventListener('click', (ev) => {
  const out = $('#providerResult');
  withBusy(ev.currentTarget, async () => {
    out.innerHTML = '<span class="secret">Probing…</span>';
    try {
      const r = await getJson('/api/provider/health');
      state.probes.provider = r;
      out.innerHTML = r.ok
        ? `${badge(r.modelListed === false ? 'warn' : 'good', r.modelListed === false ? 'Reachable, model not listed' : 'Reachable')}
           ${facts([
    ['Provider', esc(r.provider)],
    r.ms != null ? ['Latency', esc(`${r.ms} ms`)] : null,
    r.modelCount != null ? ['Models', esc(r.modelCount)] : null,
    r.model ? ['Configured', esc(r.model), true] : null,
    r.note ? ['Note', esc(r.note)] : null,
  ])}`
        : errorBlock(r.error || 'Probe failed');
      renderAll();
    } catch (err) {
      out.innerHTML = errorBlock(err.message);
    }
  });
});

$('#rawBtn').addEventListener('click', () => {
  $('#rawResult').innerHTML = `<pre class="json">${esc(JSON.stringify(state.status, null, 2))}</pre>`;
});

// --------------------------------------------------------------------------
// Tabs, theme, events

function showTab(name) {
  const valid = ['overview', 'activity', 'config', 'diagnostics'];
  const tab = valid.includes(name) ? name : 'overview';
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const id of valid) $(`#tab-${id}`).hidden = id !== tab;
}

document.querySelector('.tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('.tab');
  if (!b) return;
  history.replaceState(null, '', `#${b.dataset.tab}`);
  showTab(b.dataset.tab);
});

$('#callerChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('.chip');
  if (!b) return;
  state.callerFilter = b.dataset.caller;
  renderChips();
  renderActivity();
});

$('#cards').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-probe]');
  if (b) withBusy(b, () => probe(b.dataset.probe));
});

$('#recheckBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, () => probe('all')));

function effectiveTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncThemeIcon() {
  $('#themeBtn use').setAttribute('href', effectiveTheme() === 'dark' ? '#i-sun' : '#i-moon');
}

$('#themeBtn').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('onePane.cc.theme', next); } catch { /* per-viewer nicety only */ }
  syncThemeIcon();
});

// --------------------------------------------------------------------------

renderChips();
syncThemeIcon();
showTab(location.hash.slice(1));
refresh().then(() => probe('all'));
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
setInterval(renderUpdated, 1000);
