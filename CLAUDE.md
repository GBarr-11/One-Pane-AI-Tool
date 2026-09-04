# Project context: One Pane

This file is background for Claude Code working in this repo. It captures context
gathered in a separate research session so it doesn't need to be re-derived.

## What this repo is

One Pane is AI-assisted reply drafting for the SMC ticketing console. It reads a
ticket's full context, retrieves relevant internal techdocs and similar resolved
tickets, and drafts a formatted reply into the SMC reply box for an analyst to
review and edit. It never sends anything on its own. See README.md for the full
architecture, pipeline (`context → retrieval → generation → sanitizer → reply box`),
and design decisions (confidence gating, precedent filtering, HTML sanitization,
prompt-injection handling for ticket content).

Currently a standalone web app prototype running on mock ticket data — no SMC API
access yet, and not yet packaged as a browser extension (the panel is built to lift
into a content script later).

## Why this matters: it's meant to integrate with a second, separate project

Grant (this repo's owner) and Cole Mains (a colleague at Expedient) are building two
complementary tools that are expected to integrate eventually:

- **One Pane** (this repo) — drafts *replies into* SMC tickets. Read + draft, human
  sends.
- **Cole's "AI CTRL / Multi-Discipline AI Operations Assistant"** (separate private
  repo: `colemains/ai-ctrl-operations-assistant`) — a role-aware, strictly
  **read-only** natural-language query layer over operational data (SMC tickets,
  Elastic logs, OpenWebUI, alerts, Confluence docs) across Expedient's technology
  disciplines. It answers "what's going on," it doesn't draft anything.

They're not the same tool: Cole's system is query/investigation-focused and never
writes anywhere; One Pane is reply-drafting-focused and writes a draft (never sends).
The overlap is that both read SMC data and both will eventually need real SMC API
access, real auth, and to not step on each other.

### Cole's project — architecture summary (for integration planning)

- Monorepo, TypeScript/JS, Turborepo. `apps/` (web UI, a "Mastra" AI agent service,
  an API), `packages/` (OpenTelemetry-based telemetry/audit, a shared `tool-sdk`
  base class), `deploy/` (Helm/Kubernetes on Nutanix NKP), `tools/retool-workflows`
  (Retool Workflows integration — this is Cole's mechanism for *executing* actions,
  wrapped in auth context + telemetry; it's the one place his otherwise read-only
  system can act).
- **Auth/RBAC: WorkOS.** Roles are discipline + client scoped — e.g. AI CTRL
  Engineer, Network Engineer, Security Engineer, CSM (assigned clients only),
  Executive (summarized/anonymized). If One Pane ever needs to know "who is this
  analyst and what can they see," reusing these same WorkOS roles avoids a
  reconciliation problem later.
- **Every query audit-logged to Postgres** (user, timestamp, data sources touched,
  client scope). Anthropic Claude API for generation, with hard per-user budget
  caps. Status as of the charter: "Proposed / Awaiting Approval" — not yet formally
  signed off, but a working staging deployment already exists (local dev complete,
  staging in progress as of late Aug 2026).
- Roadmap: Phase 1 (MVP, AI CTRL discipline only, READ-only SMC/Elastic/OpenWebUI/
  alerts) → Phase 2 (adds Security/Network/Infrastructure disciplines, Slack/Teams
  bot) → Phase 3 (predictive analytics, automated runbook suggestions).

### Integration/compatibility touchpoints to design toward

1. **SMC API access.** Both projects need READ-only SMC API access from Expedient
   IT and neither has it yet (One Pane's README lists this as the top "not built
   yet" item). Worth requesting together rather than twice, and worth agreeing on
   one adapter shape both tools can use — One Pane already isolates this behind
   `buildContext()` in `server/context.js`, so swapping in a real SMC adapter should
   not require touching anything downstream.
2. **Don't let a write collide with Cole's audit assumptions.** Cole's system
   assumes nothing external mutates the state it observes. One Pane never sends a
   reply autonomously (human-in-the-loop), so this should already be safe, but keep
   it that way — no auto-send path — if these two systems end up sharing SMC
   access.
3. **Auth alignment.** If/when One Pane needs a real identity (not mock), consider
   WorkOS with the same role set Cole uses rather than inventing a second identity
   model.
4. **Cole's action-execution extension point is `AICTRLAgent.executeWorkflow()` /
   Retool Workflows.** If a future version of One Pane needs to *do* something
   beyond drafting text (e.g., trigger a workflow), that's the existing hook on his
   side rather than building a parallel one.
5. Open items to confirm with Cole directly: whether his "blur sensitive screen
   areas" idea from early brainstorming is still planned (would affect anything One
   Pane renders in-page), and Phase 1 timing (docs conflict — charter, dated Aug 21
   2026, is the more current source than the earlier planning doc).

## Source docs (Grant has these, not checked into this repo)

- GitHub: `colemains/ai-ctrl-operations-assistant` (private)
- Confluence: "AI Development Cohort ~ Cole & Grant MVP Idea" (initial brainstorm)
- Confluence: "AI CTRL Operations Assistant - Project Charter" (most detailed/
  current — budget, RACI, roadmap, risks)
- Confluence: "Multi-Discipline AI Operations Assistant" (design doc + live
  build-progress updates)
