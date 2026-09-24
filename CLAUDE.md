# Project context: One Pane

Background for Claude Code working in this repo. Captures context gathered in
separate research sessions so it doesn't need to be re-derived.

## What this repo is

One Pane is AI-assisted reply drafting for the SMC ticketing console. It reads a
ticket's full context, retrieves relevant internal techdocs and similar resolved
tickets, and drafts a formatted reply into the SMC reply box for an analyst to
review and edit. It never sends anything on its own. See README.md for the
pipeline (`context → retrieval → generation → sanitizer → reply box`) and the
design decisions behind it (confidence gating, precedent filtering, HTML
sanitization, prompt-injection handling for ticket content).

## What is actually built (as of 2026-09-24)

**Production vs. mock split (2026-09-24).** The repo root is production only:
`server/`, `extension/`, and `control-center/`. Everything invented lives in
`onepane-mock/`: the ticket corpus, mock techdocs, resolved-ticket precedent,
the offline `mock` provider, and the stand-in SMC console. It plugs in through
one seam, `server/devpack.js`, which is empty in production. The dependency
runs `onepane-mock → server` only, and a test fails if anything under `server/`
requires mock code. `npm start` runs production; `npm run mock` or
`npm run mock:offline` runs the same server with the pack installed. Keep that
direction when adding anything demo-only.

**`server/` — the draft pipeline.** A zero-dependency Node HTTP server
(`server/server.js`, CommonJS, no framework), bound to loopback. Pipeline
endpoints: `POST /api/generate`, `/api/suggestions`, `/api/ask`, `/api/polish`.
Tickets resolve as dev-pack corpus (mock only) → live SMC fetch → an inline
`ticket` object from the caller, which is how a ticket scraped off a live
console gets drafted for. Lexical retrieval with confidence assessment in
`retrieval.js` (corpus-agnostic), HTML allowlist in `sanitize.js`, and two
production providers: `openwebui` (Expedient's gateway) and `claude`. There is
**no production fallback provider**. With `ONEPANE_PROVIDER` unset, the provider
is `none` and drafting is refused. Only suggestions degrade, to the heuristic.
`GET /api/tickets*` and `/api/knowledge-base` serve the dev pack and 404 in
production.

**`control-center/` — the Control Center (added 2026-09-24).** A dashboard
served at `/`. It shows the pipeline map, live component state, the production
readiness list, recent activity, the `.env` configuration, and read-only
diagnostics. It reads `GET /api/status` (`server/status.js`: local, no network,
secrets shown as set/unset only), `GET /api/activity` (`server/activity.js`: an
in-memory, metadata-only ring buffer that never stores bodies or query text),
and `GET /api/provider/health` (token-free Open WebUI `/models` probe). It is
styled to the Expedient Brand Book v1.6:

- Core Red and neutrals, Inter ExtraBold headings, JetBrains Mono for
  technical values
- hard-edged containers with pill buttons
- Code Notch corners on the hero

Add a row to `ENV_VARS` in `status.js` whenever a new variable is added to
`.env.example`.

**`extension/` — an MV3 browser extension.** Floats a panel over the SMC console
in a shadow root without modifying the page. All DOM coupling is isolated in
`src/content/smc-adapter.js`; all network calls are isolated in
`src/background/service-worker.js`. It already talks to **both** backends: One
Pane's `/api/generate` for the Draft tab, and Cole's `/api/query` for the Ask
tab. See `extension/README.md` for the overlay invariants and known gaps.

**Confluence knowledge base (added 2026-09-22).** `server/confluence/` is a
read-only client and a ticket-to-SOP search against
`expedient-cloud.atlassian.net`. `server/knowledge.js` picks the techdoc source
(`ONEPANE_KB_SOURCE`: auto/confluence, plus mock inside onepane-mock). In
production, auto without Confluence is `none`, and it never mixes mock techdocs
with real pages. It has been tested only against a faked `fetch`. Real CQL
`siteSearch` behaviour and the v2 `include-labels` response have not been
checked against the live tenant yet. Cole's system also reads Confluence, so
coordinate on the credential.

**SMC ticket history: shelved (2026-09-23).** Searching real closed SMC tickets
as precedent, plus a "Find similar tickets" button in the Ask tab, was built and
then removed after its first live run. Its date filter was rejected by SMC and
its related-ticket list was mostly off-topic. The design, Grant's matching rules,
and what to fix are in `FUTURE_FEATURES.md`; the code is kept, unloaded, in
`docs/future/ticket-history/`. Its requires still point at the old `data/`
path and would need repointing to `onepane-mock/data/` if revived. What stayed
live: only mock tickets get mock precedent (`server/knowledge.js`), so a live ticket is never handed invented
resolved tickets. The Ask tab stays and answers about the open ticket only,
until it is pointed at Cole's `/api/query`. The v3 spec is saved at
`docs/smc-api/openapi-v3.json`.

`onepane-mock/smc-console/` is a stand-in for the SMC ticket view, mounted at
`/mock-smc/`. It is the host page the overlay is tested against, and the
extension's localhost match is narrowed to that path so the overlay never
injects into the Control Center. `test/run-tests.js` is 96 dependency-free
tests. It installs the mock pack for fixtures, and its "production mode" group
uninstalls it.

### Known gaps that matter for planning

- **The SMC API client is read-only and person-scoped.** `server/smc/` reads
  tickets, notes, contacts, and assets via v3 (GET only), and `server/env.js` loads `.env`. v3 tokens are short-lived and
  per-person, so a pasted token is a test credential, not a deployment story.
- **`server/` has no authentication.** It accepts an arbitrary `ticket` JSON blob
  from any caller and turns it into a model call. In the default `server`
  credential mode that is an unauthenticated proxy to the `.env` keys, so run
  anything reachable by others with `ONEPANE_CREDENTIALS=per-user` (callers then
  spend only their own keys - see Secrets). The WorkOS login gate is still to
  come with deployment. No per-user budget cap either (Cole's side already has one).
- **Every SMC field selector is a guess.** The extension's ticket-id detection
  and reply-box fallback are exercised against the mock console, but subject,
  client, severity, and note classification have never seen the real DOM.
- **Auth is a stub.** `resolveAuthContext()` in
  `extension/src/shared/contracts.js` returns an unprivileged dev identity with
  empty `authorizedClients`, so it fails closed rather than reading every
  client's tickets.
- **No deployed home.** `STAGING_BACKENDS.onePane` is `null` in
  `extension/src/shared/config.js`; Cole's staging already has a URL.

## Why this matters: it's meant to integrate with a second, separate project

Grant (this repo's owner) and Cole Mains (a colleague at Expedient) are building
two complementary tools that are expected to integrate eventually:

- **One Pane** (this repo) — drafts *replies into* SMC tickets. Read + draft,
  human sends. Positioned as the workstation-integrated surface (the "Claude
  Desktop" half of the analogy).
- **Cole's "AI CTRL / Multi-Discipline AI Operations Assistant"** (separate
  private repo: `colemains/ai-ctrl-operations-assistant`) — a role-aware,
  strictly **read-only** natural-language query layer over operational data (SMC
  tickets, Elastic logs, OpenWebUI, alerts, Confluence docs) across Expedient's
  technology disciplines. It answers "what's going on," it doesn't draft
  anything. The "Claude web app" half.

They're not the same tool: Cole's system is query/investigation-focused and never
writes anywhere; One Pane is reply-drafting-focused and writes a draft (never
sends). The overlap is that both read SMC data and both will eventually need real
SMC API access, real auth, and to not step on each other.

### Cole's project — architecture summary (for integration planning)

- Monorepo, TypeScript/JS, Turborepo. `apps/` (web UI, a "Mastra" AI agent
  service, an API), `packages/` (OpenTelemetry-based telemetry/audit, a shared
  `tool-sdk` base class), `deploy/` (Helm/Kubernetes on Nutanix NKP),
  `tools/retool-workflows` (Retool Workflows integration — this is Cole's
  mechanism for *executing* actions, wrapped in auth context + telemetry; it's
  the one place his otherwise read-only system can act).
- **Auth/RBAC: WorkOS.** Roles are discipline + client scoped — e.g. AI CTRL
  Engineer, Network Engineer, Security Engineer, CSM (assigned clients only),
  Executive (summarized/anonymized). If One Pane ever needs to know "who is this
  analyst and what can they see," reusing these same WorkOS roles avoids a
  reconciliation problem later.
- **Every query audit-logged to Postgres** (user, timestamp, data sources
  touched, client scope). Anthropic Claude API for generation, with hard per-user
  budget caps. Status as of the charter: "Proposed / Awaiting Approval" — not yet
  formally signed off, but a working staging deployment already exists (local dev
  complete, staging in progress as of late Aug 2026).
- Roadmap: Phase 1 (MVP, AI CTRL discipline only, READ-only SMC/Elastic/
  OpenWebUI/alerts) → Phase 2 (adds Security/Network/Infrastructure disciplines,
  Slack/Teams bot) → Phase 3 (predictive analytics, automated runbook
  suggestions).

### Integration/compatibility touchpoints to design toward

1. **SMC API access.** Both projects need READ-only SMC API access from Expedient
   IT. Worth requesting together rather than twice, and worth agreeing on one
   adapter shape both tools can use — One Pane already isolates this behind
   `buildContext()` in `server/context.js`, so swapping in a real SMC adapter
   should not require touching anything downstream.
2. **Don't let a write collide with Cole's audit assumptions.** Cole's system
   assumes nothing external mutates the state it observes. One Pane never sends a
   reply autonomously (human-in-the-loop), so this should already be safe, but
   keep it that way — no auto-send path — if these two systems end up sharing SMC
   access.
3. **Auth alignment.** If/when One Pane needs a real identity (not mock), use
   WorkOS with the same role set Cole uses rather than inventing a second
   identity model.
4. **Cole's action-execution extension point is `AICTRLAgent.executeWorkflow()` /
   Retool Workflows.** If a future version of One Pane needs to *do* something
   beyond drafting text (e.g., trigger a workflow), that's the existing hook on
   his side rather than building a parallel one.
5. **Language/build mismatch.** `server/` is zero-dependency CommonJS; his
   monorepo is TypeScript/Turborepo. `extension/README.md` anticipates landing
   there as `apps/desktop/`. If that's the real plan, converging on TS gets
   cheaper the sooner it happens — and `extension/src/shared/contracts.js` (a
   hand-mirrored copy of `@ai-ctrl/contracts@1.0.0`, taken 2026-09-04) gets
   deleted in favor of the real import.
6. Open items to confirm with Cole directly: whether his "blur sensitive screen
   areas" idea from early brainstorming is still planned (would affect anything
   One Pane renders in-page); Phase 1 timing (docs conflict — the charter, dated
   Aug 21 2026, is the more current source than the earlier planning doc); and
   the three questions at the bottom of `extension/README.md` (extension origin
   for his `ALLOWED_ORIGINS`, ticket context as a first-class `/api/query`
   parameter, audit-log provenance for extension-originated queries).

## Secrets

`.env` is gitignored (`.env`, `.env.*`, with `!.env.example` re-included).
Credentials never go in code. `.env.example` is the documented template; keep it
in sync when adding a variable, with the value left blank.

**Per-user credentials (added 2026-09-24).** Upstream keys (Open WebUI, SMC,
Confluence, Anthropic) belong to the analyst, not the server, once anyone else
can reach it. Every one is read through `server/credentials.js` (`get()`), never
from `process.env` directly — keep it that way for any new upstream.
`ONEPANE_CREDENTIALS=per-user` ignores `.env` secrets entirely; each request
carries the caller's own keys in `X-OnePane-*` headers, set by the extension's
service worker from `chrome.storage.local` (options page → "Your credentials").
They live in an AsyncLocalStorage for that one request and are never logged or
returned. The default `server` mode uses `.env`, with a caller's own key winning.
The only `.env` secret per-user mode will use is an opt-in shared Confluence
service account (`CONFLUENCE_SHARED_ACCOUNT=true`), and never paired with half a
caller's credential. Keys only travel over HTTPS or loopback: the extension
refuses to send otherwise, and the server rejects credential headers that
arrived over plain HTTP from off-host (`X-Forwarded-Proto` must be `https`).
The WorkOS app login gate is separate and comes with deployment.

`server/env.js` loads `.env` at server start (it is the first require in
`server/server.js`). The test suite does not load it (it points
`ONEPANE_ENV_FILE` at a missing file before starting the server), so tests never
touch live services.

## Source docs (Grant has these, not checked into this repo)

- GitHub: `colemains/ai-ctrl-operations-assistant` (private)
- Confluence: "AI Development Cohort ~ Cole & Grant MVP Idea" (initial brainstorm)
- Confluence: "AI CTRL Operations Assistant - Project Charter" (most detailed/
  current — budget, RACI, roadmap, risks)
- Confluence: "Multi-Discipline AI Operations Assistant" (design doc + live
  build-progress updates)
- SMC API Functions doc (apiv2 — HTTP Basic auth, username defaults to `OSC`,
  API key as the password)
