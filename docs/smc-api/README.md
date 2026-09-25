# SMC API v3: what One Pane relies on

`openapi-v3.json` is a copy of the spec behind the API portal at
<https://api.expedient.com/docs/doc/API%20v3/#/>. It was downloaded on
2026-09-23 from `https://api.expedient.com/openapi/services/API%20v3/openapi.json`,
which needs no auth. It covers v3.0.0 with 599 paths. It is gitignored and
not published with this repo, so download it locally, and again when the API
changes:

```bash
curl -sSf -o docs/smc-api/openapi-v3.json "https://api.expedient.com/openapi/services/API%20v3/openapi.json"
```

One Pane only issues GETs. `server/smc/client.js` hardcodes the method. The
spec also has `POST /tickets/{id}/notes`, `/close`, `/resolve`, `/reopen`, and
`PATCH /tickets/{id}`, and none of them are called from this repo.

## Endpoints in use

| Endpoint | Used by | For |
|---|---|---|
| `GET /tickets/{id}` | `smc/tickets.js` | the ticket record |
| `GET /tickets/{id}/notes` | `smc/tickets.js` | the thread (paginated) |
| `GET /tickets/{id}/contacts` | `smc/tickets.js` | telling client notes from analyst notes |
| `GET /tickets/{id}/assets` | `smc/tickets.js` | asset names |
| `GET /tickets` | `smc/history.js` | similar closed tickets (up to 4 filtered queries per draft) |
| `GET /tickets/{id}/related` | `smc/history.js` | tickets an analyst linked to this one |
| `GET /notes` | `smc/history.js` | threads of linked and similar tickets, batched with `ticket_id in (...)` |

## List query grammar (verified live, 2026-09-25)

The spec defines no formal grammar. This is what `GET /tickets` actually does:

- `filters`: `field op value` clauses joined by **commas, which means AND**.
  There is no `and`/`or` keyword: both are a 400 ("invalid number of
  fields"). OR means separate queries.
- Text: `subject like '%zerto%'` is a case-insensitive substring match, and
  `'%zerto%upgrade%'` means both words in that order. Works on `subject`,
  `body`, `internal_summary`, `root_cause`, `problem.name`, and note `body`.
  `contains`, `ilike`, `co`, and `sw` are 400s.
- Exclusion: `nlike` works, but also drops rows where the field is null.
  **`not like` is accepted and silently ignored.** Re-check any exclusion locally.
- Datetimes must be full ISO 8601: `closed_at gt '2025-09-25T00:00:00Z'`. A bare
  date is "invalid type: expected dateTime".
- Booleans: `is_escalated eq false` (or `eq 0`). Nulls: `reopened_at is null`
  (`eq null` is a 400).
- `order_by`: `field direction`, e.g. `closed_at desc`. A bare column name is
  rejected with "invalid order token".
- `page`, `per_page`. Responses are `{ page, per_page, total, data[] }`, and
  `total` is the full match count.
- Filterable fields are served live at `GET /tickets/filters` and
  `GET /notes/filters` (not in the spec).

**Speed.** With a `closed_at` window a text query takes about 1-3 s. The same
query filtered on `status` instead took about 10 s, and a note-body search with
no `ticket_id` scope timed out at 20 s. A `per_page=1` count of one subject term
over 12 months is about 3.5 s. The SMC console's own search box (OR by default,
quotes, `-word`) is not in the API.

**Not what it looks like.** `reopened_at` is set by the `task-end-hold`
automation whenever a hold expires, so "reopened" only means something when
`reopened_by` is a person. Customer notes carry `source: "Client SMC"` (or an
email source) and a username that is an email address, which identifies them
without a contacts lookup. Note `visibility` is `All` or `Internal`.

## TicketResponse fields that matter for ticket history

- **Outcome:** `status` (name), `closed_at`, `closed_by`, `resolved_at`,
  `resolved_by`, `reopened_at`, `reopened_by`, `is_escalated`,
  `escalate_for_review_start_at`, `time_to_resolve`, `time_to_close`
- **Classification:** `problem`, `sub_problem`, `category`, `type`, `queue`,
  `client` (each a `{id, name}` Simple object)
- **Content:** `subject`, `body` (the opening text), `root_cause`,
  `internal_summary`, `internal_summary_updated_at`, `note_count`
- **Feedback:** `helpful_counts {yes, no, neutral}` on the ticket, and
  `helpful_count` on each `TicketNoteResponse`. `GET /tickets/{id}/notes/{noteId}/feedback`
  returns per-client votes (`helpful`: yes/no/neutral, plus `comment`). This
  is the likely basis for a CSAT-style success signal later.

## Not yet confirmed against the live API

The full list of closed status names, and whether a CSAT-style signal can be
built from note `helpful_counts`.
