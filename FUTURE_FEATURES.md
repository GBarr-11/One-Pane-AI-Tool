# Future features

Ideas that were built or designed far enough to learn from, but are **not in
the live app** because they need more refinement. Each entry says what it was
for, what went wrong, and what to fix before it comes back.

Real techdocs (Confluence) are connected and, as of 2026-09-24, every SOP shown
passes a title check and a model relevance check (README, "How it works").
With those in place, the first thing live tickets showed is how often **no
SOP exists** for what clients commonly ask: #3563979 (post-migration Meraki/BGP
routing on EEC2) and #3810007 (Elastic File Integrity Monitoring) both
correctly came back with none. The first two entries below build on that.

---

## Knowledge-gap queue: suggested TechDocs from recurring tickets

**Status:** proposed 2026-09-24. The signal already exists (`kb.gap`); nothing
collects it yet.

### What it is for

Turn "no SOP covers this" from a dead end into a to-do list for the wiki. When
the same kind of ticket keeps arriving with no matching SOP, that is a page
the TO/PRE/IKB spaces should have. Writing it makes the next draft grounded,
and makes the answer the same whichever analyst picks up the ticket, which is
the uniformity goal.

### How it would work

1. **Collect.** Every draft already returns `kb.gap` (true when nothing survived
   both relevance checks), `kb.rejected` (what was considered and why it was
   turned away), and the ticket's SMC problem type and category. The
   Control Center's activity log already marks those calls "no SOP". A gap
   record would persist: problem type, category, the search anchors, the
   rejected titles, and the ticket id. No bodies, the same rule
   `server/activity.js` follows.
2. **Cluster.** Group gap records by SMC problem type first, then by shared
   anchor terms ("elastic + fim", "eec2 + bgp + meraki"). A cluster needs a
   minimum count and distinct clients before it counts as recurring, so one
   noisy ticket does not become a doc request.
3. **Suggest.** For each recurring cluster, draft a suggested TechDoc: a title
   in house style ("SOP - Elastic - File Integrity Monitoring for Client
   Directories"), the questions clients asked (from the tickets), the nearest
   existing pages (the `partial` verdicts and the rejects), and which space it
   belongs in. Drafted by the same gateway, reviewed by a person.
4. **File.** Push the suggestion to Confluence as a **draft** page or a
   page-request task in a "TechDocs backlog" space, or as a Jira ticket, never
   as a published page. That is the first One Pane write outside SMC, so it
   needs a separate, write-scoped credential and a human owner per space.
5. **Close the loop.** When a page appears whose title matches a cluster's
   anchors, mark the gap resolved and re-check a sample of those tickets.

### Before building it

- Decide where gap records live. The activity log is in-memory by design;
  durable records probably belong beside Cole's Postgres audit log rather
  than in a second store here.
- Agree the write path with whoever owns TO/PRE/IKB. Draft pages or a backlog
  task, not direct publishing.
- Run the collection for a few weeks first. The clusters, not guesses, say
  which docs are worth writing.
- Watch for false gaps. If the judge rejects a page that is actually right,
  that shows up here as a wrong doc request. The `kb.rejected` reasons in the
  record are how to audit that.

---

## Semantic search index for TechDocs

**Status:** blocked 2026-09-24. Expedient's Open WebUI gateway serves no
embedding model: `/embeddings` returns 500, and none of its 84 models embeds.
Query expansion (`server/confluence/expand.js`) stands in for now.

With an embedding model on the gateway, index TO/PRE/IKB nightly. That is
about 5,640 pages; embed the title, the space, and the page's opening. Store
the vectors locally, since the server is dependency-free (a JSON file of
vectors is fine at this size). Merge the top semantic hits into the
candidates before the title check. Semantic hits may lack a shared title
term, so they should skip that check and rely on the relevance judge. Ask IT
for an embedding model on the gateway when the SMC API access request goes in.

---

## SMC ticket history: follow-ups

**Status:** the core is built (2026-09-25). Every live draft now reads the
tickets SMC links to this one and searches closed SMC tickets for similar
ones. See "Similar tickets and SMC links" in [README.md](README.md) for how it
works, and [`docs/smc-api/README.md`](docs/smc-api/README.md) for the filter
grammar it relies on. Two things broke the 2026-09-23 version, and both are
fixed: dates are now full ISO datetimes, and "related" means only tickets SMC
itself links, never "open for the same client".

Grant's rules, which the code follows:

- **Successful** means closed, not escalated, and not reopened *by a person*.
  SMC's `task-end-hold` automation sets `reopened_at` whenever a hold expires,
  so a reopen only counts when `reopened_by` is a person. This is provisional
  until there is a CSAT-style signal.
- **Similar** means the same problem type from any client. It is labelled with
  its client, not redacted.
- **Every ticket searches.** Notification and maintenance tickets are included.
  Automated tickets are not excluded; near-identical copies of one subject are
  collapsed to two.
- **Client conversations rank higher.** A ticket where analysts went back and
  forth with the customer carries the process worth following.
- **Linked tickets are always read**, whatever their state, and the model says
  how each one relates.
- **Confidence.** Only a ticket the model judges *identical* raises
  confidence (low to medium, medium to high). A *similar* one is context only.

Still to do:

- **Ask tab.** "How did we handle this last time?" is not answerable yet. Ask
  skips the history search, and its prompt says it can see only this ticket.
  Either give it the same precedent, with the prompt changed to match, or
  route the question to Cole's `/api/query`.
- **Success signal.** `helpful_counts` on tickets and notes is rarely set
  (8 of ~1,000 Zerto tickets in 12 months). A CSAT-style signal needs another
  source.
- **Knowledge-gap queue.** When `kb.gap` is true and an identical precedent
  exists, that pair is exactly the evidence a suggested TechDoc needs (see the
  first section).
- **Rate limits.** Unknown. A draft costs about 7 SMC calls, two list queries
  at a time, cached for 10 minutes. Ask Expedient IT for a limit before this
  runs for the whole team.

---

## Ask tab → Cole's AI CTRL

**Status:** planned. The Ask tab currently answers from the open ticket's own
thread through One Pane's `/api/ask`, a stand-in. The intent is to point it
at Cole's `/api/query` once that integration is agreed. The open questions are
at the bottom of [`extension/README.md`](extension/README.md): the extension
origin for his `ALLOWED_ORIGINS`, ticket context as a first-class parameter,
and audit-log provenance. Cross-ticket questions ("how did we handle this
before?") would naturally come with it.
