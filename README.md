# One Pane

AI-assisted reply drafting for the SMC ticketing console — **working prototype**.

One Pane reads a ticket's full context, retrieves relevant internal techdocs and
similar resolved tickets, and drafts a formatted reply into the SMC reply box for
an analyst to review and edit. It never sends anything.

This repo is a functional prototype running against mock data — it proves the
pipeline shape end to end without needing SMC API access yet.

---

## Running it

```bash
npm start          # no install needed - zero dependencies for the default demo
```

Then open http://localhost:3000 — a stand-in for the SMC ticket view.

The One Pane panel is **not part of that page**. It ships as a browser extension
that floats over the console without modifying it; load it unpacked from
[`extension/`](extension/) and a *One Pane* tab appears at the top of the screen.
See [extension/README.md](extension/README.md).

```bash
npm test           # 39 pipeline tests, no dependencies
```

## What the demo shows

Pick a ticket from the dropdown and hit **Generate reply**. Twelve tickets across
twelve categories, so the tone presets and revision flow have something to work
on. Every client, contact, hostname, and IP is invented.

| Ticket | Demonstrates |
|---|---|
| #3714201 — Cloud transition closure | Itemized recap pulled from the thread; proposes resolution; flags the stale AI-summary sentiment |
| #3714582 — VPN / MFA push failure | Repetitive ticket type answered from a techdoc + prior resolution |
| #3714733 — Backup job failure | Client asked a direct question under audit pressure; states recovery position plainly |
| #3714901 — Firewall rule request | Extracts the source IP and port from the request; asks for the missing intake fields |
| #3715120 — "App feels slow" | **Low confidence — abstains.** Cites nothing and asks clarifying questions instead of inventing a diagnosis |
| #3716033 — Escalation, third outage | Frustrated client demanding RCA and a service credit — the case where tone selection actually matters |
| #3715340 · #3715512 · #3715688 | Certificate renewal, storage capacity, mail deliverability — grounded, high confidence |
| #3715744 · #3715910 | DNS change, patch window — **medium confidence**, grounded but with thinner corroboration |
| #3715802 | Repeated account lockouts — a short ticket that still retrieves cleanly |

The abstain case matters most: a tool that always produces a confident-sounding
answer is the failure mode to avoid. Note that #3715120 cites *no* sources at
all — a doc that matches only on ambient English is not a citation.

---

## Architecture

```
ticket ──► context ──► retrieval ──► generation ──► sanitizer ──► reply box
              │            │             │              │
       normalize the   techdocs +   mock | claude   allowlist the
       raw ticket      precedent     provider       SMC HTML subset
```

| Module | Responsibility |
|---|---|
| `server/context.js` | Normalizes a raw ticket into one shape everything downstream consumes |
| `server/retrieval.js` | Scores techdocs + past tickets; assesses confidence |
| `server/generate.js` | Orchestrates the pipeline, assembles citations |
| `server/providers/mock.js` | Offline generator — works with no API key |
| `server/providers/claude.js` | Real generation via the Claude API |
| `server/sanitize.js` | HTML allowlist for the tags SMC actually renders |
| `public/` | Stand-in for the SMC ticket view — the host the overlay is tested against |
| `extension/` | MV3 extension: floats the panel over SMC and writes the draft into its reply box |

Swapping mock data for the real SMC API means writing one adapter that emits the
`buildContext()` shape. Nothing downstream changes.

### Generation providers

Default is `mock` — deterministic, offline, no key required, so the prototype
demos anywhere. For real model generation:

```bash
npm install @anthropic-ai/sdk
ONEPANE_PROVIDER=claude npm start
```

Credentials resolve from `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an
`ant auth login` profile. In production this would point at the company's
internal AI gateway instead; the request shape is what's being proven here.

---

## Design decisions worth reviewing

**Confidence is computed from retrieval quality, not from how fluent the output
sounds.** Below the bar, the tool abstains and asks questions rather than
guessing. See `assessConfidence()` in `server/retrieval.js`.

**Bad precedent is filtered out.** Reopened and escalated tickets are excluded
from the precedent pool — the corpus deliberately contains two of them
(`#3612880`, `#3655302`) so the filter has something real to exclude. Without
this, the tool would confidently repeat past mistakes at scale.

**Weak citations are dropped.** A source scoring far below the top match gets
cut even if it clears the absolute floor. Citing a VPN doc on a migration ticket
costs more analyst trust than the extra source is worth.

**Model output is never trusted as HTML.** Everything passes an allowlist
sanitizer (`<b>`, `<ul>`, `<li>`, `<code>`, `<pre>`, …). Disallowed markup is
escaped, not stripped, so it surfaces visibly rather than vanishing silently.

**Ticket content is treated as data, not instructions.** Customer messages are
attacker-influenceable text. The Claude provider fences the thread in explicit
markers with a standing instruction to ignore directives inside it.

**The existing AI summary is an input, not ground truth.** One Pane cross-checks
its sentiment read against thread recency and flags the discrepancy — on
#3714201 the summary still says "Concerned" 102 days after the client last wrote.

---

## Not built yet

- Real SMC API integration (blocked on API access — currently mock data)
- Verified SMC selectors. The extension's overlay, reply-box write, and
  ticket-change detection are exercised against the local mock, but the
  field-level selectors are placeholders until someone runs it on the real
  console
- Embeddings-based retrieval (lexical scoring is deliberate for a prototype —
  inspectable and dependency-free)
- Feedback capture — edit-distance tracking between draft and sent reply
