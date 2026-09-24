# Future features

Ideas that were built or designed far enough to learn from, but are **not in
the live app** because they need more refinement. Each entry says what it was
for, what went wrong, and what to fix before it comes back.

The current focus is getting real techdocs (Confluence) connected. Nothing here
should be picked up until that's solid.

---

## SMC ticket history as a source of truth

**Status:** shelved 2026-09-23. It was removed from the server and extension
after its first run against a live ticket. The code is kept for reference, not
loaded, in [`docs/future/ticket-history/`](docs/future/ticket-history/).

### What it was for

If similar tickets were resolved a certain way, the next reply should keep the
basis of that process: the same diagnostic order, the same fix, and the same
ask of the customer. The feature did two things:

1. **Draft grounding.** Real closed SMC tickets were fed to the model as
   precedent alongside techdocs, with the prompt told to follow the process
   that worked without copying the other ticket's specifics.
2. **Ask tab.** A **Find similar tickets** button listed matching tickets with
   links into SMC. An "include similar resolved tickets" option let Ask answer
   "how did we fix this last time?"

### The rules Grant set (keep these when it comes back)

- **Successful** = closed, not reopened, not escalated. This is provisional
  until there's a CSAT-style signal. SMC v3 has per-note `helpful_count` votes
  and `GET /tickets/{id}/notes/{noteId}/feedback`, which are the likely basis.
- **Similar** = the **same problem type** from any client, since highly
  repeatable tickets are handled the same way whoever raised them. When the
  problem is unclassified, the same client and the same category.
- Another client's ticket does **not** need heavy redaction. Analysts can see
  every ticket and client in SMC anyway. It should be labelled with its client
  so it's obvious the precedent came from a separate case.

### How it worked

- `history.js` queried `GET /tickets` with SMC's filter grammar, e.g.
  `filters=problem.id eq 7, closed_at gte '…', is_escalated eq 0` and
  `order_by=closed_at desc`. It asked `GET /tickets/filters` which fields were
  filterable, and re-checked every rule on our side.
- The best four matches had their notes read. Customer-facing replies, internal
  work notes, `internal_summary`, and `root_cause` went into the prompt, each
  fenced and labelled.
- `precedent.js` chose the source, mock or SMC, and never mixed the two.

### What went wrong on the first live run (ticket #3767603, a Zerto upgrade notice)

1. **Every history query failed with SMC 400:**
   `'2025-03-23': invalid type: expected dateTime`. The `closed_at gte` clause
   sent a bare date, and SMC wants a full datetime. Because both queries
   (by problem, and by client + category) carried the clause, **Similar
   resolved** came back empty. The fix is probably `'2025-03-23T00:00:00Z'`, but
   confirm the exact format with `GET /tickets/filters?detailed=true`, which
   returns an example value per field.
2. **"Related" was mostly unrelated.** The list merged tickets SMC links to this
   one (real signal: #3761129) with "open tickets for the same client". The
   second group had no topic check, so a Zerto upgrade notice listed shipment
   arrivals and a Cohesity network migration. Same client is not the same
   subject. Either drop that group, or require a real subject or problem match
   before showing a ticket.
3. **Untested assumptions that remain:** which fields `/tickets/filters`
   actually accepts, the closed status names, and the note `visibility` values
   (see [`docs/smc-api/README.md`](docs/smc-api/README.md)).

### Before bringing it back

- Fix the datetime format, and add a live smoke check that runs a single
  `GET /tickets?filters=…&per_page=1` before trusting the query shape.
- Show **SMC-linked tickets** on their own. Drop or gate "open for the same
  client."
- Consider whether notification and maintenance tickets (like a Zerto upgrade
  notice) should look for precedent at all. They are closer to templates.
- Put a relevance floor on similar tickets that the analyst can see, e.g.
  "matched on: same problem." Hide anything that only matched on client.
- Decide whether this belongs to One Pane or to **Cole's AI CTRL**. His system
  already reads SMC across tickets with role-aware access and audit logging.
  "Find similar tickets" may be better as a query to his `/api/query` from the
  Ask tab than as a second search implementation here.
- One piece stays live and should keep staying live: **live tickets are never
  given the invented mock resolved tickets as precedent** (`server/knowledge.js`).
  Before this work they were, which cited ticket numbers that don't exist.

---

## Ask tab → Cole's AI CTRL

**Status:** planned. The Ask tab currently answers from the open ticket's own
thread through One Pane's `/api/ask`, a stand-in. The intent is to point it
at Cole's `/api/query` once that integration is agreed. The open questions are
at the bottom of [`extension/README.md`](extension/README.md): the extension
origin for his `ALLOWED_ORIGINS`, ticket context as a first-class parameter,
and audit-log provenance. Cross-ticket questions ("how did we handle this
before?") would naturally come with it.
