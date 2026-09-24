# onepane-mock

The One Pane demo, kept apart from production. Everything here is invented:
every client, contact, hostname, IP, ticket, techdoc, and resolved ticket.

```bash
npm run mock          # mock tickets + console; provider and KB from .env
npm run mock:offline  # no network at all: offline generator + mock techdocs
```

Then open:

- **http://localhost:3000/mock-smc/**, a stand-in SMC ticket view. Load the
  extension from `extension/` and the One Pane panel appears over it.
- **http://localhost:3000/**, the Control Center. It shows a *Mock pack*
  badge and banner so the two modes can't be confused.

## What's in here

| Path | What it is |
|---|---|
| `start.js` | Entry point. Installs the pack, then starts the **unchanged** production server |
| `pack.js` | The pack: wires the pieces below into `server/devpack.js` |
| `data/tickets.js` | Twelve curated SMC-shaped tickets |
| `data/knowledge-base.js` | Mock techdocs, used when the KB source resolves to `mock` |
| `data/resolved-tickets.js` | Invented precedent, including two reopened/escalated ones the filter must exclude |
| `provider/mock.js` | Offline, deterministic generator, registered as provider `mock` |
| `smc-console/` | The stand-in SMC ticket page, mounted at `/mock-smc/` |
| `concepts/` | Early panel design concepts (images only) |

## How it plugs in

Production has one seam, `server/devpack.js`, and installs nothing into it.
`start.js` installs this pack before the server starts. The pack changes the
server in these ways:

- `resolveTicket()` checks the mock corpus first, so demo tickets keep their
  full curated thread.
- `/api/tickets`, `/api/tickets/:id`, `/api/tickets/:id/context` and
  `/api/knowledge-base` serve the corpus. In production they return 404 with an
  explanation.
- Provider `mock` becomes available, and it is the default when
  `ONEPANE_PROVIDER` is unset.
- `ONEPANE_KB_SOURCE=auto` falls back to the mock techdocs when Confluence
  isn't configured. Real and mock docs are still never mixed.
- Mock tickets, and only mock tickets, get mock precedent, read against a
  pinned "now" of 2026-08-30, because their dates are fixed.

`npm test` installs the same pack for its fixtures. It also asserts that no
file under `server/` requires anything from here.

## What the demo shows

Pick a ticket from the console's dropdown, then open the One Pane panel and
draft.

| Ticket | Demonstrates |
|---|---|
| #3714201: cloud transition closure | Itemized recap pulled from the thread. Proposes resolution and flags the stale AI-summary sentiment |
| #3714582: VPN / MFA push failure | A repetitive ticket type answered from a techdoc plus a prior resolution |
| #3714733: backup job failure | The client asked a direct question under audit pressure. The draft states the recovery position plainly |
| #3714901: firewall rule request | Extracts the source IP and port from the request and asks for the missing intake fields |
| #3715120: "App feels slow" | **Low confidence, so it abstains.** It cites nothing and asks clarifying questions instead of inventing a diagnosis |
| #3716033: escalation, third outage | A frustrated client demanding an RCA and a service credit. This is where tone selection matters |
| #3715340 · #3715512 · #3715688 | Certificate renewal, storage capacity, mail deliverability. Grounded, high confidence |
| #3715744 · #3715910 | DNS change, patch window. **Medium confidence:** grounded, but with thinner corroboration |
| #3715802 | Repeated account lockouts. A short ticket that still retrieves cleanly |

The abstain case matters most. A tool that always produces a confident-sounding
answer is the failure mode to avoid. #3715120 cites *no* sources at all,
because a doc that matches only on ambient English is not a citation.
