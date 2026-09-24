# One Pane

AI-assisted reply drafting for the SMC ticketing console.

One Pane reads a ticket's full context, retrieves relevant internal techdocs,
and drafts a formatted reply into the SMC reply box for an analyst to review
and edit. It never sends anything.

The repo has two halves, kept apart on purpose:

| | What it is | Run it |
|---|---|---|
| **Production** (repo root) | The browser extension, the draft server, and the **Control Center** dashboard. Reads real tickets from SMC or the console, real techdocs from Confluence, drafts through a real model. | `npm start` |
| **[`onepane-mock/`](onepane-mock/)** | The demo: a stand-in SMC console, twelve invented tickets, mock techdocs and resolved tickets, and an offline generator. Plugs into the production server; production never loads it. | `npm run mock` |

---

## Running it

```bash
npm start          # production server + Control Center, zero dependencies
```

Then open **http://localhost:3000**, the Control Center. It shows how every
piece is wired and whether it's healthy: the pipeline map, each component's
live state, recent API activity, the configuration read from `.env` (secrets
shown only as set or unset), and read-only probes for Confluence, SMC, and the
model gateway.

Configuration lives in `.env` (copy `.env.example`). Production has **no
offline fallback**. With `ONEPANE_PROVIDER` unset, drafting is refused and the
Control Center says so, rather than a template generator quietly answering a
live ticket.

The One Pane panel ships as a browser extension that floats over the console
without modifying it. Load it unpacked from [`extension/`](extension/) and a
*One Pane* tab appears at the top of the SMC console. See
[extension/README.md](extension/README.md).

```bash
npm run mock          # the demo: mock tickets + console at /mock-smc/, provider/KB from .env
npm run mock:offline  # the demo with no network at all: mock provider + mock techdocs
npm test              # pipeline tests, no dependencies
```

The demo walkthrough (which ticket shows what) is in
[onepane-mock/README.md](onepane-mock/README.md).

---

## Architecture

```
ticket ──► context ──► retrieval ──► generation ──► sanitizer ──► reply box
              │            │             │              │
       normalize the    Confluence   openwebui |    allowlist the
       raw ticket       techdocs     claude         SMC HTML subset
```

| Module | Responsibility |
|---|---|
| `server/server.js` | HTTP API and static host for the Control Center. Loopback-only |
| `server/context.js` | Normalizes a raw ticket into one shape everything downstream consumes |
| `server/smc/` | Read-only SMC v3 client and the adapter to the `buildContext()` shape |
| `server/retrieval.js` | Scores techdocs and precedent against a ticket; assesses confidence |
| `server/knowledge.js` | Picks the techdoc source and runs retrieval |
| `server/confluence/` | Read-only Confluence client and ticket-to-SOP search |
| `server/generate.js` | Orchestrates the pipeline, picks the provider, assembles citations |
| `server/providers/` | `openwebui` (Expedient's gateway) and `claude` (direct API) |
| `server/sanitize.js` | HTML allowlist for the tags SMC actually renders |
| `server/status.js`, `activity.js` | What the Control Center reads: wiring snapshot and a metadata-only activity log |
| `server/devpack.js` | The single seam a dev pack plugs into. Empty in production |
| `control-center/` | The Control Center dashboard, served at `/` |
| `extension/` | MV3 extension: floats the panel over SMC and writes the draft into its reply box |
| `onepane-mock/` | The demo pack. Not required by anything in `server/` (a test enforces it) |

### How the mock stays out of production

`server/devpack.js` is a registry that is empty in production. `onepane-mock/start.js`
installs the mock pack into it, then starts the unchanged production server.
The pack supplies:

- the ticket corpus
- mock techdocs
- resolved-ticket precedent
- the `mock` provider
- the console mount at `/mock-smc/`

The dependency points one way only: `onepane-mock → server`, never the reverse.
`npm test` fails if any file under `server/` requires mock code.

### Generation providers

Set `ONEPANE_PROVIDER` in `.env`:

- `openwebui`: Expedient's Open WebUI gateway (`OWUI_URL`, `OWUI_API_KEY`).
  OpenAI-compatible and dependency-free.
- `claude`: the Claude API directly. Run `npm install @anthropic-ai/sdk` and set
  `ANTHROPIC_API_KEY`.

The offline `mock` provider exists only inside `onepane-mock`.

### Confluence knowledge base

With Confluence configured, every draft searches the wiki for the ticket's
topic and grounds the reply in the SOPs it finds. The search terms come from
the ticket's subject, problem, and latest customer message. Results are cited
in the panel with a link to the page.

1. Create an API token at
   <https://id.atlassian.com/manage-profile/security/api-tokens> →
   **Create API token**, name it `one-pane`, and pick an expiry. Copy it now,
   because it is shown only once. If you choose **Create API token with scopes**,
   pick Confluence with read-only scopes (`read:page:confluence`,
   `read:space:confluence`, `read:label:confluence`, `search:confluence`) and
   also set `CONFLUENCE_CLOUD_ID`.
2. Put it in `.env` (gitignored), not `.env.example`:
   ```
   CONFLUENCE_SITE_URL=https://expedient-cloud.atlassian.net
   CONFLUENCE_EMAIL=you@expedient.com
   CONFLUENCE_API_TOKEN=<the token>
   CONFLUENCE_SPACES=<SOP space keys, comma-separated>
   ```
3. Restart the server. The Control Center's Knowledge Base card turns green
   once the credential is accepted, and **Diagnostics → Confluence Search**
   shows what a phrase returns. The same checks are available as
   `GET /api/confluence/health` and `GET /api/confluence/search?q=vpn+mfa`.

How it works:

- **Search:** CQL `siteSearch` (the engine behind the wiki's own search box).
  Tenants that reject it fall back to `text ~`.
- **Fetch:** v2 `pages/{id}` for full bodies and labels. Bodies are cached per
  page version.
- **Rank:** pages go through the same scorer and confidence gate as the demo's
  mock techdocs, so "high confidence" means the same thing for both.
- **Safety:** GET only. Credential-looking strings are redacted before a page
  reaches the model. Page text is fenced as data and marked internal-only in
  the prompt.
- **No mixing:** production has no mock techdocs to mix in. If Confluence fails,
  the draft gets no docs and the confidence reasons say why.

The token reads everything its account can read. Every analyst using One Pane
sees what that account sees, so use a service account scoped to SOP spaces.

---

## Design decisions worth reviewing

**Confidence is computed from retrieval quality, not from how fluent the output
sounds.** Below the bar, the tool abstains and asks questions rather than
guessing. See `assessConfidence()` in `server/retrieval.js`.

**Bad precedent is filtered out.** Reopened and escalated tickets are excluded
from the precedent pool. The mock corpus deliberately contains two of them
(`#3612880`, `#3655302`) so the filter has something real to exclude. Without
this, the tool would confidently repeat past mistakes at scale.

**Mock precedent never reaches a live ticket.** The resolved-ticket corpus is
invented and lives in `onepane-mock/`, so only its own demo tickets draw on it. A ticket from SMC or
scraped off the console drafts from techdocs and its own thread, and isn't
marked down for the precedent it can't have. Real SMC ticket history is a
shelved feature; see [FUTURE_FEATURES.md](FUTURE_FEATURES.md).

**Weak citations are dropped.** A source scoring far below the top match gets
cut even if it clears the absolute floor. Citing a VPN doc on a migration ticket
costs more analyst trust than the extra source is worth.

**Model output is never trusted as HTML.** Everything passes an allowlist
sanitizer (`<b>`, `<ul>`, `<li>`, `<code>`, `<pre>`, …). Disallowed markup is
escaped, not stripped, so it surfaces visibly rather than vanishing silently.

**Ticket content is treated as data, not instructions.** Customer messages are
attacker-influenceable text. Both real providers fence the thread in explicit
markers with a standing instruction to ignore directives inside it.

**The existing AI summary is an input, not ground truth.** One Pane cross-checks
its sentiment read against thread recency and flags the discrepancy. On mock
#3714201, the summary still says "Concerned" 102 days after the client last wrote.

---

## Not built yet

The Control Center's **Production Readiness** list tracks these live.

- Server authentication and a per-user budget cap. `server/` is loopback-only
  until then
- A deployable SMC credential. v3 tokens are short-lived and per-person
- Verified SMC selectors. The extension's overlay, reply-box write, and
  ticket-change detection are exercised against the mock console, but the
  field-level selectors are placeholders until someone runs it on the real
  console
- Embeddings-based retrieval (lexical scoring is deliberate for a prototype —
  inspectable and dependency-free)
- Feedback capture — edit-distance tracking between draft and sent reply
