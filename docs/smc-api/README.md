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

The shelved ticket-history feature (see `FUTURE_FEATURES.md`) also used
`GET /tickets`, `GET /tickets/filters` (which fields `filters=` accepts; served
live, not in the spec), and `GET /tickets/{id}/related`. None are called now.

## List query grammar

Examples in the spec (the spec itself defines no formal grammar):

- `filters`: `field op value` clauses joined by commas, which means AND.
  - Nested fields: `client.id eq 1000`, `status.id eq 3`
  - Dates: the spec's examples use `contract_date gte '2026-01-01'`, but live
    `GET /tickets` rejected `closed_at gte '2025-03-23'` with "invalid type:
    expected dateTime". Datetime fields need a full datetime; check
    `GET /tickets/filters?detailed=true` for the exact format.
  - Other operators: `name like '%account%'`, `product_category.id in (12, 15)`
  - Booleans: `is_status_change eq 0`
  - Operators seen: `eq`, `like`, `gte`, `in`, `not`, `is`
- `order_by`: `field direction`, e.g. `id desc`, `created_at desc`. A bare
  column name is rejected with "invalid order token".
- `page`, `per_page` (1 to 10000)
- Responses are `Pagination` (`data[]`, `page`, `per_page`, `total`).

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

For the ticket-history feature, if it returns: which fields
`GET /tickets/filters` lists, the status names a closed ticket carries, and the
note `visibility` values. See `FUTURE_FEATURES.md`.
