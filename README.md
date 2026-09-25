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
| `server/knowledge.js` | Picks the techdoc source and runs retrieval, with the ticket-history search alongside |
| `server/smc/history.js`, `server/precedent.js` | SMC-linked tickets and similar resolved SMC tickets, graded by the model |
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

With Confluence ("TechDocs") configured, every draft and every Ask answer
searches the wiki for the ticket's topic and grounds the response in the SOPs
it finds. The search terms come from the ticket's subject and problem, the
existing AI summary's problem statement, and the latest customer message, plus
the question on the Ask tab. Results are cited in the panel with a link to the
page, and every SOP shown has passed two relevance checks (below).

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
   CONFLUENCE_SPACES=TO,PRE,IKB
   ```
3. Restart the server. The Control Center's Knowledge Base card turns green
   once the credential is accepted, and **Diagnostics → Confluence Search**
   shows what a phrase returns. The same checks are available as
   `GET /api/confluence/health` and `GET /api/confluence/search?q=vpn+mfa`.

How it works:

- **Terms:** up to 12, each source getting a share so a wordy subject cannot
  crowd out the summary. URLs, meeting ids, hostnames, the client's own name,
  and ticket filler ("ongoing", "specific", "expedient") are dropped. On a
  live ticket whose latest message was a Teams link, those fragments had been
  the search.
- **Specificity:** one count query per term (cached for a day) says how many
  page titles contain it. A term in more than 1.5% of titles is *broad*: in
  TO/PRE/IKB, "service" (119 of 5,640) and "elastic" (137) are broad, while
  "zerto" (79) and "bgp" (7) are not. Anchors are the specific terms that
  some title contains, analyst-chosen ones first.
- **Search:** up to seven small CQL queries, run in parallel. Each is anchored
  on the product or task in a title, as a prefix match: `title ~ "zerto*" AND
  text ~ "upgrade*"`, plus the lead anchor and the next term both in a title.
  It does not use `siteSearch` or one long phrase. On expedient-cloud,
  `siteSearch` ignores its terms and returns the same pages for any query, a
  long `text ~` phrase drifts off topic, and an exact `title ~ "cohesity"`
  matches nothing.
- **Pre-rank, then fetch:** the REST search returns hits in no useful order,
  so the pooled hits are pre-ranked on title and excerpt. Only the best 8 are
  fetched in full (v2 `pages/{id}`, cached per page version).
- **Relevance check 1, title:** a page's title or labels must contain at least
  one of the ticket's non-broad terms. "SOP - Service Delivery - Deploy vROps
  Appliance" no longer qualifies on "service", nor "Understanding Elastic
  APM" on "elastic".
- **Rank:** pages go through the same scorer and confidence gate as the demo's
  mock techdocs, so "high confidence" means the same thing for both. Titles
  weigh in:
  - `SOP`/`MOP`/`KB`/`TSG`/`PIG` pages rank up.
  - Deprecated, WIP, and archived pages rank well down.
  - A title naming the ticket's own product and task ranks up.
  - A page over two years old is flagged to the analyst and to the model.
- **Relevance check 2, model** (`server/relevance.js`): the active model reads
  the ticket brief and the top 5 pages (title plus the first 1,200 characters)
  and grades each one *direct*, *partial*, or *unrelated*. Unrelated pages
  are hidden. Partial ones are shown with an amber label and flagged to the
  drafting prompt as background, not procedure. "High" confidence now needs a
  direct match. It is one short call per draft, cached for 15 minutes. If it
  fails, the lexical results stand, marked unverified and capped at medium.
  `ONEPANE_RELEVANCE_CHECK=off` disables it.
- **Query expansion** (`server/confluence/expand.js`): before searching, the
  model rewrites the ticket into the phrases a wiki page would use ("FIM" to
  "file integrity monitoring"). Those run as exact-phrase CQL queries. The
  gateway serves no embedding model (checked 2026-09-24), so this stands in
  for semantic search. It costs about 500 tokens, cached for 30 minutes, and
  `ONEPANE_QUERY_EXPANSION=off` disables it. Terms are also lightly stemmed,
  because `title ~ "monitoring*"` matches nothing on this tenant while
  `"monitor*"` works.
- **Relevance %:** each cited SOP shows a bar from 0 to 100%. The verdict sets
  the band (direct 70-100, partial 35-65, unchecked never above 55), and the
  lexical score places the page within it (`relevancePct` in `generate.js`).
- **Analyst feedback** (`server/feedback.js`): 👍/👎 on each SOP. A 👎 hides
  that page on that ticket from then on. Two or more tickets of the same SMC
  problem type voting it down hide it for that problem type, and 👍 votes boost
  it. Votes are stored as metadata only in `.onepane/feedback.jsonl`
  (gitignored), and they are the labelled data for re-tuning.
- **Hidden, not silent:** the panel lists every page either check turned away,
  with the reason, under "N SOPs hidden as not relevant". When nothing
  survives, the response carries `kb.gap` and the Control Center's activity
  log marks the call "no SOP". That is the raw signal for the knowledge-gap
  queue in `FUTURE_FEATURES.md`.
- **Token budget:** the prompt carries what the reply needs, not everything.
  - **Thread** (`server/thread.js`): the opening request, the last 6 notes, and
    up to 4 older notes picked for hard facts (change numbers, IPs, versions,
    hostnames), within 12,000 characters, with the SMC AI summary standing in
    for the rest. HTML and quoted email history are stripped. On #3563979 that
    took the thread from 68,924 characters to 6,580, and the whole prompt to
    about 3,100 tokens. Internal notes are marked INTERNAL and never quoted.
  - **SOPs** (`server/excerpt.js`): each page's opening plus the sections that
    match the ticket, up to 3,500 characters for a direct match and 1,200 for a
    partial one, instead of the first 6,000.
- **No SOP is not "don't know":** a thread with concrete facts (an Expedient
  note carrying a change number, a hostname, or a date, or an AI summary)
  drafts at medium, "grounded in the ticket thread". The prompt then keeps
  every statement to what the thread says. Only a thread with nothing
  concrete still abstains and asks questions.
- **Fact check** (`server/grounding.js`): after drafting, every IP, version,
  5-digit or longer number, hostname, email, and `<code>` value in the draft is
  looked up in the whole ticket (internal notes included) and the full cited
  SOPs. Anything not found shows as "Check before sending". It uses no model
  call. It checks values, not claims, and it does not check dates.
- **Safety:** GET only. Credential-looking strings are redacted before a page
  reaches the model. Page text is fenced as data and marked internal-only in
  the prompt.
- **No mixing:** production has no mock techdocs to mix in. If Confluence fails,
  the draft gets no docs and the confidence reasons say why.

The token reads everything its account can read. Every analyst using One Pane
sees what that account sees, so use a service account scoped to SOP spaces.

### Similar tickets and SMC links

With the SMC API configured, every live draft also looks at SMC history,
alongside the Confluence search (not after it). It adds about 2 seconds and
roughly 7 read-only SMC calls, and the result is cached per ticket for 10
minutes, so a tone change or a re-draft costs nothing. Suggestions and the Ask
tab do not search it.

- **Linked tickets** (`GET /tickets/{id}/related`): every ticket an analyst
  linked to this one is read, open or closed, and never filtered out. The
  model says how each relates ("the project communication for the same
  migration"), and the panel shows it as **Linked in SMC**. Its facts may be
  used where the relationship makes them apply.
- **Similar resolved tickets** (`GET /tickets?filters=...`): up to four
  queries over the last 12 months, two at a time, each a different way a
  match could be found:
  - the same SMC problem, with the lead topic word in the subject
  - the two lead topic words in the subject
  - the AI summary's own topic words in `internal_summary`
  - this client's own history on the topic

  The SMC console's search box (OR by default, quotes, `-word`) is not in the
  API, so this uses the API's filter grammar. Commas mean AND, OR is separate
  queries merged here, and `like '%term%'` is a case-insensitive substring
  match. The details and quirks, verified live, are in
  [`docs/smc-api/README.md`](docs/smc-api/README.md).
- **Filtered on our side:** closed, not escalated, and not reopened by a
  person. The hold-expiry automation's reopens do not count. Copies of one
  subject (the per-client "Zerto 10.8 Upgrade Notice - ..." tickets) are
  collapsed to two, so they cannot crowd out everything else. Automated
  tickets are otherwise kept.
- **Client conversations first:** the best six have their threads read in one
  batched `GET /notes`. The number of times the conversation changed hands
  between the customer and an analyst raises a ticket's rank. Customer notes
  are recognized by their `Client SMC`/email source.
- **Model check** (`server/precedent.js`): one call grades the top five
  *identical*, *similar*, or *unrelated*. Unrelated ones are hidden, and
  listed under "N similar tickets hidden". The best three go to the prompt,
  labelled with their client. The prompt says to follow their process and
  never copy their specifics or claim their steps were done here.
- **Confidence:** a ticket judged *identical* raises confidence one step (low
  to medium, medium to high), and the panel says which ticket did it. It
  cannot override the hard caps: an unclassified ticket, no customer message
  to answer, or SOPs whose relevance could not be checked. A *similar* ticket
  is context and moves nothing. With no SOP, an identical ticket gives
  "grounded in a resolved SMC ticket".
- **Fact check:** a value in the draft that appears only in a linked or
  similar ticket (most likely another client's hostname or IP) is shown under
  **From another ticket**, naming the ticket.
- **Votes:** 👍/👎 on a similar ticket works like on an SOP.

`ONEPANE_PRECEDENT_SOURCE=off` disables it, and `SMC_HISTORY_MONTHS` changes
the window.

### Where a draft's time goes

Profiled on live ticket #3810593 (2026-09-25). The server itself is idle; it
waits on the AI gateway. SMC reads take about 0.5 s, the ticket-history search
about 2 s, and the Confluence search about 1 s, and all of them overlap. What
adds up is the model calls in series: query expansion, then the SOP relevance
check, then the draft. The similar-ticket check runs alongside the first two.

| | Expansion | Relevance check | Draft | Total |
|---|---|---|---|---|
| luna, default effort | 5.1 s | 9.1 s | 9.5 s | 25 s |
| luna, grading calls at `minimal` effort (default now) | 3.4 s | 5.3 s | 5.4 s | 15.5 s |

The gateway's latency varies from run to run, so the same draft can take
noticeably longer at a busy moment. The extension waits 120 s before giving
up.

**Live progress.** While a draft or an Ask answer runs, the panel lists each
stage under the button as it starts and finishes:

- reading the ticket
- working out what to search for
- searching TechDocs
- searching SMC history
- checking SOPs and similar tickets
- writing the draft
- checking its facts

Each stage shows a short count ("6 similar · 1 linked") and its time. If a
request fails, the list stays on screen, marked where it stopped. The
extension sends `"progress": true` and the server answers with NDJSON: one
line per stage change, then the result (`server/progress.js`). Details are
counts only, never ticket text. Without the flag the response is the usual
single JSON body. `ONEPANE_AUX_MODEL` and `ONEPANE_AUX_REASONING` (see `.env.example`) tune
the grading calls. The draft keeps `ONEPANE_MODEL` at its default effort.

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
scraped off the console gets real SMC history instead (above), or none, and
isn't marked down when none is found.

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
