# One Pane — browser extension

Manifest V3 extension that floats One Pane's draft pipeline and Cole's AI CTRL
assistant over the SMC ticket page, without changing a pixel of it.

Scaffold — it runs today against the local mock, and every SMC-only selector in
it is an unverified placeholder.

---

## Why a floating overlay

We cannot edit SMC. There is no column to inject into, no layout hook to add,
and nothing about the console we are allowed to reflow. So the panel is not part
of the page at all: it is a single element attached to `<body>`, positioned
`fixed` inside a shadow root, hanging from the top edge on whichever side you
choose.

Closed, it is a small tab at the top of the screen. Click it and the panel drops
down and floats above the console. Nothing underneath moves.

That guarantee is verified, not assumed — with the overlay mounted and removed,
the bounding boxes of the sidebar, topbar, page, both columns, the reply editor,
and the notes list are identical, and no horizontal scrollbar appears.

### Two surfaces, one panel

| Surface | Backend | What it does |
|---|---|---|
| **Draft reply** | One Pane (`/api/generate`) | Reads the ticket, retrieves techdocs + precedent, writes a grounded draft **into the reply box** |
| **Ask AI CTRL** | AI CTRL (`/api/query`) | Answers read-only questions about tickets, alerts, and platform state |

### Steering a draft

Tone presets (More formal / Friendlier / Shorter / More detailed) and a free-text
box sit under both the first draft and every revision. **Apply changes** revises
the draft the analyst is looking at rather than generating a new one — someone
who asked for "shorter" wants their draft shortened, not a different reply of
the same length. **Start over** goes back to the ticket.

Both replace what One Pane last put in the reply box instead of stacking another
copy under it. Text the analyst typed themselves is never touched: the extension
tracks the exact nodes it inserted, so a half-written note above the draft
survives every regenerate.

The offline generator can apply the tone presets but has no model behind it, so
it reports free-text instructions as **not applied** rather than returning an
unchanged draft that looks obeyed. Run the server with `ONEPANE_PROVIDER=claude`
for those.

### Source links

Every citation links to the real techdoc or ticket when `SMC_BASE_URL` and
`ONEPANE_KB_BASE_URL` are set (see `.env.example`); unset, the citation still
shows, just as plain text. Links are `target="_blank"` with
`rel="noopener noreferrer"`, and the panel refuses any href that is not
`http(s)` — a `javascript:` URL from a misconfigured backend renders as text,
never as a clickable link inside SMC.

Cole's `apps/web` frontend is deliberately not embedded. His Mastra service is a
plain Express JSON API, so calling it directly and rendering the answer in our
own panel avoids fighting `frame-ancestors`, avoids a second login prompt inside
the panel, and lets both surfaces share one identity once WorkOS is wired up.

---

## Architecture

```
ticket page (SMC or the local mock)
   │
   ├── loader.js ──────► content-script.js       orchestration only
   │                        │
   │                        ├── smc-adapter.js   ALL DOM coupling
   │                        └── overlay.js       placement, drop-down, drag, resize
   │                              └── panel.js   tabs + rendering
   │                                    │
   │                                    ▼  chrome.runtime.sendMessage
   └────────────────────► service-worker.js      ALL network calls
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          One Pane /api/generate    AI CTRL /api/query
```

Four rules hold this together:

**The overlay never touches the page.** It appends one element to `<body>` and
positions everything `fixed`. It does not read, move, restyle, or reparent
anything that was already there.

**All DOM coupling lives in `smc-adapter.js`.** SMC's markup is not ours. When
it changes, exactly one file changes. The adapter emits the same normalized
ticket shape `buildContext()` already consumes, so a DOM adapter and a future
SMC API adapter are interchangeable.

**All network calls live in the service worker.** Content scripts never call
`fetch`. This keeps credentials out of a page we don't control, sidesteps SMC's
CSP, and — because the worker holds `host_permissions` — exempts these requests
from CORS, so neither backend needs a permissive `Access-Control-Allow-Origin`
to be reachable.

**The panel renders in a shadow root.** SMC's stylesheet can't reach in; our CSS
can't leak out and disturb the console.

### The invariant that matters

`smc-adapter.js` reads the page and writes into the reply box. It has **no
function that submits, posts, resolves, or escalates**, and must not grow one.
One Pane drafts; a human sends.

This is also an integration constraint, not just a product one: Cole's system
assumes nothing external mutates the SMC state it observes and audits. An
auto-send path would break that assumption. His service's write-capable endpoint
(`/api/workflows/:id/execute`) is likewise never called from here.

---

## Running it

Load unpacked against the local mock — no SMC access needed:

```bash
npm start
```

**Chrome:** `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select this `extension/` directory.

**Edge:** `edge://extensions` → enable **Developer mode** (bottom left) → **Load
unpacked** → same directory. Edge is Chromium, and everything here is stock
MV3 — `chrome.action`, `chrome.storage`, `chrome.runtime`, `chrome.tabs` — so
the same unpacked build runs on both with no separate manifest. The one Edge
difference handled in code: `storage.sync` requires a signed-in profile, so
preferences fall back to local storage when it is unavailable rather than
silently reverting to defaults on every load.

Then open http://localhost:3000.

- **Open it** — click the *One Pane* tab at the top right, or the toolbar icon.
- **Close it** — the ▲ button in the panel header, the toolbar icon, or `Esc`.
- **Move it** — drag the header. **Resize it** — drag the bottom-right corner.
  Both persist per machine.
- **Settings** — right-click the toolbar icon → Options: backend URLs, which
  side it hangs from, auto-open, auto-draft, and a reset for size and position.

For the Ask tab, run Cole's backend alongside it (`apps/mastra`, port 8080, mock
mode is fine). Without it, that tab reports the backend as unreachable — which is
expected, not a bug.

---

## Known gaps

**Every SMC field selector is still a guess.** The host (`app.expedient.com`) is
real, and ticket-id detection now tries four strategies — `[data-ticket-id]`,
a URL path, a URL query parameter, and the `#123456` in the breadcrumb, which is
the one most likely to work given how the console renders its heading. The reply
box falls back to the largest visible editable element when the exact selector
misses. But the *field-level* selectors in `SMC_SELECTORS` (subject, client,
severity, notes) have never seen the real DOM.

`classifyNote()` matters most among them: it decides client vs. analyst, which
decides `awaitingOurReply`, which decides whether One Pane drafts at all. It
falls through to `'system'` on anything unrecognized, so a misread note is
counted but never mistaken for a customer asking us something.

**When detection fails the panel says so.** Rather than not appearing, it mounts
and reports which strategies were tried, what the reply-box search found, and
the first headings on the page — with a **Copy details** button. That output is
what turns a failed first run on the real console into the information needed to
fix the selectors. It contains page text, so it is shown to the analyst to
review rather than sent anywhere on its own.

**Auth is a stub.** `resolveAuthContext()` returns an unprivileged dev identity
with an empty `authorizedClients`, so a misconfigured extension fails closed
rather than reading every client's tickets. Replacing it with a real WorkOS
session — the same roles Cole's staging deployment already uses — is the work
that makes the Ask tab usable against real data.

**Contracts are mirrored by hand.** `src/shared/contracts.js` is a JSDoc copy of
`@ai-ctrl/contracts@1.0.0`, taken 2026-09-04. Keeping it small is the only thing
keeping it honest. When this moves into the AI CTRL monorepo as `apps/desktop/`,
delete it and import the real package.

---

## Questions for Cole

1. What origin should the extension send as? His service reads `ALLOWED_ORIGINS`;
   a packed extension is a stable `chrome-extension://<id>`, which can be
   allowlisted once the id is pinned via a key in the manifest.
2. Should `/api/query` take an optional ticket context parameter? Today the
   panel prefixes the analyst's question with the ticket id, client, and subject
   so pronouns resolve (`withTicketContext()` in `content-script.js`). A first-
   class parameter would be cleaner than text prepending, and would let his
   audit log record which ticket a question was asked from.
3. Does his audit log want to know a query came from the extension rather than
   from his web UI? That's a header or an `AuthContext` field, and it's easier
   to add before there's data in the table than after.
