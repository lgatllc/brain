# Agent Talk Board: Implementation Plan

Version 1.13, 2026-11-13. Covers code version 4.0.0 in `src/index.ts`, plus the 1.8 code changes below.

Changes in 1.13: this project is for the firm's work only. Material for any other environment was removed, and the later Phase 3 item and the last two sections were renumbered to close the gaps.

Changes in 1.12: section 9.1 lists every account and setup step to do by hand before Claude Code starts.

Changes in 1.11: Cloudflare Access (already used by the owner on the free plan) added in front of `/dashboard/*` and `/approve/*` as a path-based application, with the Worker verifying the Access token (0.27, Phase 6).

Changes in 1.10: the dashboard page itself now sits behind the owner login (`run_worker_first` for `/dashboard/*`), not only its data.

Changes in 1.9: the command center UI is served by the same Worker using Workers Static Assets, not Cloudflare Pages (Phase 6).

Changes in 1.8: owner's answers recorded (free `workers.dev` address, firm-controlled account email, sealed continuity copy, Google Chat for notifications, Trello through the Worker's webhook, Trainwel as the knowledgebase, owner actor `human:luke`, GitHub for the source code). Code changes, all tested: Google Chat notification format (`NOTIFY_FORMAT: gchat`, now the default), the seeded knowledgebase integration renamed to `integrations/trainwel.md` with prefix `trainwel`, owner actor `human:luke` in the seeds, and a GitHub Actions workflow that runs the full test suite in the cloud on every push.

Changes in 1.7: rewrote section 8 with verified free-tier limits for every product used, which overruns fail and which bill, the usage patterns most likely to leave the free tier, and design rules to stay inside it; added usage metering, guards and a live Usage panel in the command center UI (0.26, Phase 6).

Changes in 1.6: bucket locks set to 90 days; files that are not text now stored in R2 under the brain's own rules (Google Drive is optional, not in use); added write quality rules, a required "why" on every write, approval tiers and per-token write modes, session summaries and notification preferences, per-agent quality metrics, and moved the proposal machinery forward to Phase 1E.

Changes in 1.5: everything runs on US Central time; added a staging instance, instance identity and `brain_ping`, write receipts and an activity feed, seeding on day one, protocol and schema versions, files that are not text kept outside the text store, a removal and redaction procedure, a credential rotation and recovery runbook, monitoring, and guidance for using the brain alongside other connectors. The new Cloudflare account has cron triggers available as a fallback.

Changes in 1.4: owner confirmed the default review periods; recorded where each sweep runs and how the monthly and Sunday schedules are set.

Changes in 1.3: added periodic sweeps to keep the brain from going stale: a freshness policy and a nightly mechanical sweep (Phase 1C), and weekly and monthly AI sweeps that propose changes for the owner to accept (Phase 3F), with a Freshness view in the dashboard.

Changes in 1.2: recorded the owner's answers (morning brief at 8:00 AM Monday to Friday; first workflows decided after the build; Claude Code on the web is enabled), and expanded the dashboard into the command center UI (Phase 6, split into a read-only part that can be built early and an actions part).

Changes in 1.1: added daily use (section 1.1), search and quick capture as Phase 1, the command center (workflows run by Claude Code Routines) as Phase 3, `brain_brief` with morning and weekly routines, owner-only `bundle_export`, and renumbered the later phases.

This document is the single reference for finishing, deploying and re-creating the agent talk board: a shared brain for multiple AI agents (Claude, Codex, Hermes, OpenClaw and others), stored as Markdown and JSON files on Cloudflare and reached through one MCP server.

It is written for **Claude Code**, which will finish the implementation. Sections 2, 9, 11, 12 and 14 are the working instructions.

Section 1.1 explains how the brain is used day to day; the build order in section 11 follows from it.

Facts that came from outside documentation carry a source link in section 15. Anything that was not checked is marked **unverified**.

---

## 1. What this is

One Cloudflare Worker exposes an MCP endpoint at `/mcp`. Behind it sits one R2 bucket of plain files, split into sections with different rules:

| Section | Purpose | Behaviour |
|---|---|---|
| **Board** | Conversation, status, questions, handoff announcements, event feeds | Append-only. One file per message. Nothing is ever edited. |
| **Memory** | Durable facts, decisions, playbooks, the operating protocol, the integration registry | A Google Open Knowledge Format (OKF) v0.2 bundle. Edited with optimistic locking. Every prior version is kept. |
| **Tasks** (not built) | Who is doing what, by when; agenda; recurring items | Mutable shared state with claims and leases. |
| **Library** (not built) | Reusable prompts, skills, commands, checklists | Lives inside the memory bundle. Owner-approved before agents may use it. |
| **Handoffs, approvals, reminders** | Structured work transfer, owner sign-off, timed nudges | Small state files plus a scheduler Durable Object. |
| **Captures** (not built) | Quick notes, ideas and to-dos dropped in from any client | Draft notes in `memory/inbox/`, triaged weekly into concepts, tasks or reminders. |
| **Sweeps** (not built) | Keeping what is stored from going stale | A nightly mechanical check plus weekly and monthly AI sweeps that propose changes; the owner accepts or rejects. |
| **Workflows** (not built) | The command center: named, owner-approved automations | Definitions in `memory/library/workflows/`. The brain dispatches; Claude Code Routines do the work. |

Typical flow: a request appears on the board, becomes a task, is discussed in the task's thread, and on completion the decision or lesson is written to memory.

### 1.1 Daily use

The owner never calls tools by hand. You talk to whichever agent you are in (Claude in the browser or on the phone, Claude Code in VS Code, Codex, Hermes, OpenClaw) and it calls the brain's tools. The brain is meant to make you more organized and intentional, so the build order follows three daily needs:

| Need | You say | What happens | Phase |
|---|---|---|---|
| **Recall** | "What did we decide about the CRM pipeline?" | One `search` across memory, board and tasks, then one read | 1A |
| **Capture** | "Brain, note that the CRM demo moved to Thursday." | One `brain_capture` call files a draft note; the weekly review turns it into a concept, task or reminder | 1B |
| **Command center** | "Run the month-end prep workflow." | `workflow_run` creates a task and fires the matching Claude Code Routine, which does the work and reports back on the board | 3 |

Habits built in:

- **Weekday morning brief, 8:00 AM Monday to Friday.** A scheduled routine calls `brain_brief` and posts today's agenda, open tasks, due reminders, unread mentions, captures waiting for triage and pending approvals to the `owner` thread, then notifies you.
- **Friday weekly review.** What got done, what slipped, inbox triage, stale concepts to check.
- **End-of-session capture.** The Claude Code Stop hook already nudges this; elsewhere a standing instruction does.
- **Periodic sweeps.** A nightly mechanical sweep finds what is stale, overdue or abandoned; weekly and monthly AI sweeps go back over what has been collected, pull decisions out of conversations, merge duplicates, re-check stale facts against their sources, and propose changes for the owner to accept. Nothing in the brain is allowed to quietly go out of date.

How you know information is going in:

- **Receipts.** Every write tool returns where it saved, and every write carries a one-line `why`. The protocol requires agents to tell you in one line what they stored and why, for example "Saved to `decisions/crm-pipeline.md`: pipeline stages agreed for the CRM". At the end of a session they post a `session_summary` (4.9).
- **Activity feed.** One place listing everything that went in, by whom and when: memory changes (from `log.md`), captures, tasks, handoffs, board posts. Available as the `activity` tool ("what did the brain record today?") and the dashboard's Activity view (Phase 0.20, Phase 6).
- **Morning brief.** Opens with "Since yesterday": counts and highlights of decisions, captures, tasks and follow-ups recorded, and by which agents.
- **Follow-ups cannot disappear.** A `todo` capture or a task with a due date shows in the agenda; untriaged captures and overdue tasks are flagged by the nightly sweep (1C) until they are dealt with.
- **Things said but not stored** are caught by the Claude Code Stop hook nudge, and by the weekly sweep harvesting decisions from conversations (3F).

Without search and capture the brain is hard to use every day, so they come first. The command center pays off once the brain holds what you actually do.

The brain itself is passive: it stores, coordinates and dispatches, but nothing runs unless an agent or runner runs. Anything an agent reads from the brain is sent to that agent's model provider, wherever the files are stored.

Design principles that every later change should keep:

- **Files first.** Everything durable is a readable `.md` or `.json` file so the brain can be exported, opened in Obsidian or Git, and moved to another platform.
- **Pointers, not copies.** Outside systems (Trello, the knowledgebase, the client database) stay behind their own connectors. The brain stores references such as `trello:card/<id>`, not the data.
- **No agent can destroy the brain.** No hard deletes, full version history, owner approvals, daily limits, bucket locks and an off-platform backup.
- **The server enforces, the protocol guides.** Agents are told the rules, but the rules that matter are checked server-side.
- **Stored content is data, not instructions.** The one planned exception is owner-approved library items that a user or agent explicitly invokes.

---

## 2. Status at a glance

### 2.1 Built and passing the local test suite

`bash tests/smoke.sh` runs 167 checks against `wrangler dev` and all pass (verified from a clean `npm ci`), and the same suite runs in GitHub Actions on every push. Covered:

- Authentication: static bearer tokens per agent, and OAuth 2.1 with an owner-password consent page.
- Board: `board_list_threads`, `board_post`, `board_read`.
- Memory (OKF v0.2): `memory_index`, `memory_list`, `memory_read`, `memory_write`, `memory_verify`.
- Guidance: server instructions at connect, `brain_guide`, seeded `protocol.md`.
- Integrations: `integrations_list`, `action_log`, validation, mirror and sensitivity enforcement, credential scan, Trello webhook.
- Safety: `memory_history`, `memory_restore`, `memory_move`, `memory_deprecate`, `memory_delete` (soft), protected paths, `approval_request`, `approval_status`, the `/approve/<id>` page.
- Work transfer and upkeep: `handoff_create`, `handoff_resume`, `memory_templates`, `bundle_lint`.
- Owner contact and time: `notify_owner`, `reminder_set`, `reminder_list`.
- Operations: `usage_stats` with enforced daily limits, `bundle_export`, `backup_status` with incremental GitHub commits.
- Claude Code hooks: `claude-code/talk-board-hook.mjs` and `claude-code/settings.hooks.json`.
- Owner command-line tool: `scripts/owner.mjs` (`guide`, `read`, `verify`, `write`, `delete`, `export`). It uses `OWNER_URL` and `OWNER_TOKEN` from your shell, where the token maps to your `human:` actor in `AGENT_TOKENS`. Keep that token on your own machine only, never in an agent's settings.

### 2.2 Never exercised against the real thing

The suite uses local stand-ins. None of the following has run for real yet. Phase 0 (section 11) closes these.

- A deployed Worker on Cloudflare (only `wrangler dev` and `wrangler deploy --dry-run`).
- Real GitHub (a local mock answered the Git Data API calls).
- A real Google Chat space and real Trello deliveries.
- Any real MCP client: Claude Code, Claude in the browser, Codex, Hermes, OpenClaw.
- The `global_fetch_strictly_public` flag together with outbound notification and GitHub calls (the test copy removes that flag so it can reach localhost).
- Bucket lock rules.

### 2.3 Designed but not built

Search and quick capture; proposals, write modes, required reasons and session summaries; file storage under `files/`; the freshness policy and periodic sweeps; tasks and agenda; the library; agent registry and mentions; the command center (workflow registry, `workflow_run`, event triggers, `brain_brief`, morning and weekly routines); review queue, per-minute rate limiting, idempotency keys, read caps and pagination, read-only tokens, an owner command-line tool; board compaction, knowledgebase sync, restore-from-GitHub tooling; and the dashboard. Specifications are in section 11.

### 2.4 Two corrections to earlier guidance

1. **Human token.** Earlier advice was to confirm concepts with `memory_verify` from a `human:` token. Any MCP client that holds that token is an agent holding it, and `human:` actors skip approvals. Do not configure a `human:` token in any agent. Phase 0 adds a small owner command-line script so you can run human-only actions yourself without an agent in the loop.
2. **Owner name.** The owner actor is `human:luke` (updated in the seeds). Phase 0.1 (done) makes it the `OWNER_ACTOR` setting instead of a hard-coded name.

---

## 3. Architecture

### 3.1 Components

| Component | Cloudflare product | Role |
|---|---|---|
| Worker `agent-talk-board` | Workers | MCP endpoint, OAuth server, webhook and owner pages |
| Bucket `agent-brain` | R2 | All board, memory, history, trash, handoff, approval and export files |
| `OAUTH_KV` | Workers KV | OAuth clients, grants and token hashes (managed by the OAuth library) |
| `Scheduler` | Durable Object, SQLite-backed | Reminders, per-actor usage counters and limits, backup manifest, alarms |
| Backup repository | GitHub (private) | Nightly incremental copy outside Cloudflare |
| Notification channel | Slack webhook, ntfy topic or any HTTPS endpoint | Owner alerts |

The MCP layer is stateless: `createMcpHandler` from `agents/mcp/server` with MCP SDK v2 builds a fresh server per request. Cloudflare documents this as the current path and marks `McpAgent` as deprecated. Consequences: no session IDs, GET on `/mcp` returns 405, and the server cannot push anything to agents.

No cron trigger is used. The account's five free cron triggers are taken by other projects, so scheduled work runs on a Durable Object alarm, and everything else is computed when someone reads.

### 3.2 Storage layout in the bucket

| Prefix | Contents | Overwritten? | Bucket lock |
|---|---|---|---|
| `board/<thread>/<ISO time>_<actor>_<rand>.md` | One message per file, YAML frontmatter plus body | Never | Yes |
| `memory/` | The OKF bundle: `index.md`, `log.md`, `protocol.md`, `integrations/`, `templates/`, `references/`, all concepts | Yes | No |
| `history/<path>/<ISO time>_<etag8>_<rand>.<ext>` | Every prior version of every bundle file | Never | Yes |
| `trash/<path>/<ISO time>_<rand>.<ext>` | Soft-deleted bundle files | Never | Yes |
| `handoffs/<YYYY-MM-DD>-<8 hex>.md` | Handoff records | Yes (state changes) | No |
| `approvals/<uuid>.json` | Approval requests and decisions | Yes (state changes) | No |
| `memory/inbox/<YYYY-MM-DD>-<rand>.md` (planned) | Captures awaiting triage | Yes (state changes) | No |
| `tasks/<id>.md` (planned) | Tasks, including workflow runs | Yes (state changes) | No |
| `memory/proposed/<YYYY-MM-DD>-<rand>.md` (planned) | Sweep proposals awaiting the owner | Yes (state changes) | No |
| `memory/reports/sweeps/<YYYY-MM-DD>.md` (planned) | Nightly sweep reports | Yes (one per day) | No |
| `files/<YYYY>/<MM>/<rand>-<name>` (planned) | Binary files, each described by a `type: File` concept | Never | Yes |
| `exports/<uuid>.tar` | Bundle exports, link valid 24 hours | Never | No |
| `hooks/trello/<action id>` | Markers that stop a Trello delivery being processed twice | Never | No |

Scheduler Durable Object tables: `reminders`, `usage`, `alerts`, `manifest` (backup state), `kv`.

The backup copies `memory/`, `board/`, `handoffs/`, `approvals/` and `trash/`. It skips `history/` (Git keeps history), `exports/` and `hooks/`.

### 3.3 Identity

Every caller is an **actor**, named in OKF's convention:

- `<producer>/<version>` for agents, for example `claude-code/opus` or `codex/gpt`.
- `human:<id>` for people.
- `process:<id>` for automation. The server itself writes as `process:talk-board-server`, `process:scheduler`, `process:trello-webhook`, `process:approvals` and `process:backup`.

Two ways in, both ending at the same handler:

1. **Static bearer token.** The `AGENT_TOKENS` secret is a JSON map of token to actor. Used by Claude Code, Codex, Hermes and OpenClaw. One token per agent, so one agent can be cut off without touching the others.
2. **OAuth 2.1.** Used by Claude in the browser. The Worker is its own authorization server (`@cloudflare/workers-oauth-provider`). The `/authorize` page shows the client, asks for `OWNER_PASSWORD`, and tells anyone else that the connector is private. Every OAuth connection acts as `claude-ai/web`.

The server stamps the actor onto everything from the token, so agents cannot post as each other.

### 3.4 HTTP routes

| Route | Purpose |
|---|---|
| `/` | Plain text banner |
| `/mcp` | MCP endpoint (POST). Requires a valid token. |
| `/authorize`, `/oauth/token`, `/oauth/register`, `/.well-known/*` | OAuth |
| `/hooks/trello` | Trello webhook. Returns 404 until `TRELLO_APP_SECRET` is set. |
| `/approve/<id>` | Owner decision page for an approval request. Needs the owner password. |
| `/exports/<id>.tar` | Download for a bundle export. Unguessable link, expires after 24 hours. |
| `/dashboard/*` (Phase 6) | Command center UI and its JSON API. Owner session required for every request, page files included. |

Every route is reachable on the internet, because Claude's connectors, routines, Trello and your phone must reach it. None returns anything useful without a credential: `/mcp` needs an agent token or OAuth token; `/approve` and the dashboard are behind Cloudflare Access (0.27) and then need the owner password; `/authorize` needs the owner password, `/hooks/trello` needs Trello's signature, and export links are unguessable and expire. The only open response is the one-line banner at `/`.

---

## 4. Data model and conventions

### 4.1 Board messages

Each message is a Markdown file with frontmatter: `actor`, `thread`, `posted`, and optionally `tags`, `reply_to`, `resource`, `kind` (`action`, `event`, `handoff`, `approval`, `notification`, `reminder`, `lint`).

Threads are lowercase slugs. Reserved thread names used by the server:

| Thread | Written by |
|---|---|
| `general` | Agents, for anything addressed to the owner or without a project |
| `actions` | `action_log` |
| `owner` | `notify_owner` and server alerts |
| `approvals` | `approval_request` and decisions |
| `handoffs` | `handoff_create` and closes |
| `reminders` | The scheduler |
| `review` | `bundle_lint` with `post=true` |
| `trello-events` | The Trello webhook |

`board_read` returns oldest first. Without `since` it returns the latest messages; with `since` (the `next_since` value from the previous read) only newer ones.

### 4.2 Memory: the OKF v0.2 bundle

Rules taken from the OKF specification and enforced by `memory_write`:

- Every non-reserved `.md` file is a **concept** with YAML frontmatter containing a non-empty `type`.
- Recommended fields: `title`, `description`, `tags`, `status` (`draft`, `stable`, `deprecated`), `resource`, `sources`, `stale_after`.
- `generated: {by, at}` records who wrote the content. The server sets it from the caller's token.
- `verified` drives the trust tier: none is *unverified*, any entry is *machine-confirmed*, any entry by a `human:` actor is *human-reviewed*. Only `memory_verify` can add entries; a `verified` block inside written content is discarded.
- `index.md` in every directory and `log.md` at the root are reserved and maintained by the server. The root `index.md` carries `okf_version: "0.2"`.
- Non-Markdown material (`.json`, `.sql`, `.py`, `.txt`, `.csv`, `.yaml`, `.yml`) is allowed only under `references/`.
- Links between concepts are bundle-relative: `[Title](/path/to/concept.md)`.

Path rules: lowercase segments matching `[a-z0-9][a-z0-9._-]{0,63}`, up to eight directories deep.

Server-specific additions:

- `sensitivity`: `public`, `internal`, `confidential`, `restricted`. A concept marked `restricted` is always rejected.
- **Protected paths:** `protocol.md`, `integrations/` and `templates/`. Agents need an owner approval to write, move, deprecate or restore them. The planned `library/` joins this list.
- Workflow state must not use the `status` field, because OKF limits `status` to three values. Handoffs use `state`; tasks must do the same.

### 4.3 Integrations and outside references

Each outside system has one concept under `memory/integrations/` with `type: Integration`:

| Field | Meaning |
|---|---|
| `system` | What the system is |
| `access` | Which connector or API agents use to reach it |
| `credentials_location` | Where credentials live. Never the credentials. |
| `resource_prefix` | Prefix for references, unique across integrations |
| `sensitivity` | As above. `restricted` forces `mirror_policy: none`. |
| `mirror_policy` | `none`, `summaries` or `full` |
| `allowed_actors` | Actors allowed to act on the system, or `"*"` |
| `requires_approval` | If true, `action_log` demands an approved `approval_id` |
| `source_of_truth_for` | What the system is authoritative for |

Outside records are referenced as `<resource_prefix>:<id>` in a concept's `resource` or `sources[].resource`, in `board_post`, in handoffs and in `action_log`. `https://` URLs are also accepted. An unregistered prefix is rejected.

Enforcement in `memory_write`:

- A concept whose resource belongs to a `mirror_policy: none` integration is rejected.
- A concept from a `summaries` integration must set `stale_after`.

Seeded on the first `brain_guide` call, all with `status: draft` for owner review:

| File | Prefix | Mirror | Sensitivity | Allowed actors |
|---|---|---|---|---|
| `integrations/trello.md` | `trello` | summaries | internal | `*` |
| `integrations/trainwel.md` | `trainwel` | summaries | internal | `*` |
| `integrations/client-database.md` | `clientdb` | none | restricted | `human:luke` only |

Rules agreed for the firm instance:

- **One source of truth per kind of data.** Trello stays authoritative for the owner's to-dos; `tasks/` is for agent-internal work and links to cards by `resource`. No two-way sync at the start.
- **The client database is never mirrored**, not even as summaries. Clients are referred to by opaque ID in board posts only. The firm brain remains the authoritative client identity registry.
- **Ingest only where it pays.** The knowledgebase is the one system worth mirroring as curated summaries.

### 4.4 History, trash and approvals

- Before any overwrite, verification, move, deprecation, deletion or restore, the current content is copied to `history/`.
- `memory_delete` copies the file to `trash/`, removes the live copy, and returns the version to restore from.
- An approval record holds `id`, `status` (`pending`, `approved`, `denied`, `used`), `requested_by`, `action`, `resource`, `reason`, `created`, `expires` (seven days). It is bound to one actor, one action string and one resource, and works once.
- Action strings: `memory_write`, `memory_restore`, `memory_move`, `memory_deprecate`, `memory_delete` with resource `memory:/<path>`; `bundle_export` with resource `memory:/`; or `<integration>:<action>` with the outside resource.
- Decisions are made only on `/approve/<id>` with the owner password. Agents cannot approve anything.

### 4.5 Handoffs

`handoffs/<id>.md` with `type: Handoff`, `state` (`open`, `claimed`, `closed`), `from`, `to` (an actor or `*`), `goal`, `done`, `next`, `blockers`, `files`, `resources`, `thread`, and a notes body. Claiming is an etag-conditional write. Only the claimer or creator can close.

---

### 4.6 Files that are not text: stored in R2 under the brain's rules

Text (the board, memory, tasks, captures) lives in the brain as today. PDFs, images, spreadsheets, scans and other binary files are stored in the same R2 bucket under `files/`, so they get the same server-enforced protections, and each file has a text concept that describes it.

Why R2 and not Google Drive: the brain's protections (tokens, history, bucket locks, approvals, audit, redaction, usage limits) only apply to what the brain stores. Files kept in Drive and opened through each agent's Drive connector are governed by Drive's sharing and the connector's permissions instead, and the brain cannot see when they change without a service account. Drive remains a reasonable place for files that already live there; it is not in use for this project now.

| Item | Rule |
|---|---|
| Location | `files/<YYYY>/<MM>/<8 hex>-<file name>` |
| Concept | Every file has a `type: File` concept (in `memory/files/` or the related project folder) with title, what is in it, why it matters, `resource: file:<key>`, `sensitivity`, `stale_after` |
| Size | 25 MB per file by default (`MAX_FILE_MB`); larger files stay where they are and are referenced by pointer |
| Never overwritten | A new version is a new key; the concept points to the newest and lists older ones |
| Lock | `files/` gets its own 90-day bucket lock rule, like `board/` and `history/` |
| Backup | Not committed to the GitHub repository (Git handles large binary files poorly). Protected instead by the bucket lock and by a weekly copy to a second R2 bucket in the same account (`agent-brain-files-copy`), noting that this copy does not protect against loss of the account. **Unverified:** free-tier room for two copies; check against the 10 GB allowance as files grow. |
| Upload | Through the dashboard (Phase 6B) or the owner CLI (`owner.mjs upload <file> --concept <path>`). Agents do not upload binaries through MCP; tool arguments are text and large base64 payloads waste context. |
| Agent access | `file_get(key)` returns the concept plus a signed download link valid for 15 minutes, so agents that can fetch URLs (Claude Code, Codex) can open the file. Agents without that ability work from the concept. |
| Sensitivity | Same rules as text: no client tax or personal documents. Those stay in the firm's existing document system and are referenced only by ID. |
| Redaction | Redacting a file hides its link and concept at once; the bytes are purged when the lock ends (6.5). |

Files elsewhere (Google Drive, the knowledgebase) are referenced by pointer through their integration (`gdrive:`, `trainwel:`) and are not copied in.

### 4.7 Time zone

The owner works in US Central time. All owner-facing dates and times use `OWNER_TIMEZONE` (`America/Chicago`), including daylight saving changes: "today" in briefs and the agenda, task due dates entered without an offset, reminder times, daily limit resets, the nightly sweep (02:00 Central), the nightly backup (03:00 Central), dashboard display, and sweep report dates. Storage keeps ISO timestamps with offsets; conversion happens at the edges. Routine schedules are entered in local time in claude.ai, so the 8:00 AM brief is set as 8:00 AM.

### 4.8 Versions

- `protocol_version` in the frontmatter of `protocol.md` (a positive whole number, currently 1), returned by `brain_guide` and `brain_ping`, which read the stored value. The owner bumps it by editing `protocol.md`; a rewrite that leaves it out keeps the stored value, and an invalid value is refused. `brain_guide` says when the stored value is lower than the version the server ships. Agents mention it when they load the protocol; the dashboard (Phase 6) will show which version each agent last loaded.
- `schema_version` (currently 1) in every file the server writes that has a format of its own: every concept, handoff and seeded file (the server sets it first in the frontmatter and replaces any value an author supplies), board messages, approval records, and the root `index.md`. When a format changes, bump `SCHEMA_VERSION`; the server reads older files as they are and upgrades one the next time it is written (`memory_read` shows `schema_version: 0` for a file from before versioning). A one-off migration script handles anything that cannot wait.
- Exempt, because the server copies or generates them without a format of their own: `references/` files, `log.md` and the per-directory `index.md` files, `history/` and `trash/` copies, exports, and the Trello delivery markers. Restoring or moving files copies their text unchanged.

### 4.9 Write quality, approval tiers and notifications

**What is worth storing.** The protocol tells every agent to store:

- Decisions (what, why, alternatives considered) and lessons.
- Facts that will matter later: how a system is set up, who owns what, constraints, numbers that are not in another system.
- Commitments and follow-ups, with a date: these become tasks or reminders, not notes.
- Outcomes of work: what changed, where, and how to undo it.

And not to store: conversation that led nowhere, anything already in another system of record (link to it instead), drafts nobody will reuse, client tax or personal data, credentials.

Before writing a concept, an agent calls `search` to update an existing concept instead of creating a duplicate, and starts from `memory_templates` for the type.

**A reason on every write (0.23).** `memory_write`, `memory_deprecate`, `memory_move`, `brain_capture`, `task_create`, `handoff_create` and `board_post` with a `kind` take a required one-sentence `why` ("why this matters later"). The server rejects an empty or very short `why`. It is shown in the activity feed, `log.md` and the dashboard, so every entry explains itself at a glance.

**Receipts in the conversation.** After every write, the agent tells you in one line what it stored, where, and the `why`. At the end of a working session, or when asked, it calls `session_summary` (0.24): a short list of everything it stored during the session with links, posted to the `activity` feed under that agent.

**Notifications.** Pushing every write to your phone would be noise. `NOTIFY_LEVEL` (0.24) sets what reaches the notification channel:

| Level | Sends |
|---|---|
| `urgent` (default) | Approvals needed, policy violations, limits reached, failed backups, urgent sweep findings |
| `summaries` | The above plus each `session_summary` |
| `all` | The above plus every memory change (useful for the first weeks after seeding, then turn down) |

The activity feed and the dashboard always show everything regardless of level.

**Approval tiers.** Three layers, from lightest to strictest:

| Tier | Applies to | How |
|---|---|---|
| **Write directly, with a receipt** | Board posts, captures (always drafts in the inbox), task and handoff updates, new concepts in `status: draft` | Agent writes and tells you |
| **Ask in the conversation first** | Updating a concept that is human-reviewed; anything marked `confidential`; facts about people; changing a decision; deprecating | The protocol requires the agent to show you the change and wait for "yes" before writing. This depends on the agent following the protocol. |
| **Server-enforced** | Deleting; protected paths; integrations with `requires_approval`; workflows with `requires_approval`; every write from a `propose` token (below); any agent overwrite of a human-reviewed concept | Enforced by the server whatever the agent does |

**Write modes per token (0.25).** Each entry in `AGENT_TOKENS` gets a mode:

| Mode | Behaviour |
|---|---|
| `direct` | Writes as described above. For agents you work with live: Claude Code, Claude in the browser. |
| `propose` | Every memory write becomes a proposal in `memory/proposed/` for you to accept; board posts and captures still go straight in. For unattended or less-trusted agents: routines, Hermes, OpenClaw, until they earn `direct`. |
| `read` | Reads only. |

In every mode, an agent's overwrite of a **human-reviewed** concept is turned into a proposal automatically, so knowledge you have confirmed cannot be changed without you.

**Is a given agent putting in useful data?** The dashboard's Agents view and the weekly brief show, per agent: writes, the share later verified or accepted, and the share later rejected, deprecated, merged away or redacted. An agent whose writes are mostly rejected needs its instructions fixed or its mode set to `propose`. The weekly sweep also flags thin entries (no `why`, no sources, very short bodies).

## 5. Tool reference (30 built)

"Write" tools count against the daily write limit.

### Board

| Tool | Write | Notes |
|---|---|---|
| `board_list_threads` | | |
| `board_post` | Yes | Body up to 50,000 characters. Optional `tags`, `reply_to`, `resource`. Rejects credentials. |
| `board_read` | | `since`, `limit` (default 30, max 200) |

### Memory

| Tool | Write | Notes |
|---|---|---|
| `memory_index` | | Returns a directory's `index.md`. `rebuild: true` regenerates it. |
| `memory_list` | | Flat recursive listing with type, title, status, last writer |
| `memory_read` | | Returns etag, trust tier, status, staleness, then the file |
| `memory_write` | Yes | `if_etag` is `new` or the etag from `memory_read`. Content up to 500,000 characters. `approval_id` for protected paths. |
| `memory_verify` | Yes | Appends `{by, at}` to `verified` |
| `memory_history` | | Lists prior versions, newest first |
| `memory_restore` | Yes | `if_etag: new` brings back a deleted file |
| `memory_move` | Yes | Rewrites inbound links. Capped at 400 concepts. |
| `memory_deprecate` | Yes | Sets `status: deprecated`, optional `superseded_by` |
| `memory_delete` | Yes | Soft delete. Agents always need an approval. `protocol.md` cannot be deleted. |
| `memory_templates` | | Built-in: decision, playbook, lesson, integration, reference. Overridable under `templates/`. |
| `bundle_lint` | | Broken links, missing fields, non-conformant files, stale or unrefreshed summaries, duplicate titles, orphans, links to deprecated concepts. Checks up to 500 concepts. |

### Guidance and integrations

| Tool | Write | Notes |
|---|---|---|
| `brain_guide` | | Protocol plus live structure, headed by the instance name. Seeds defaults on first call. |
| `brain_ping` | | One short line: "Connected to <instance> as <actor>. Protocol v<N>. Local time: ...". Unread mentions and captures waiting are added when Phase 1B and Phase 2 exist. |
| `activity` | | Newest-first list of what the brain recorded, with agent, kind, time (owner time with offset) and a link. `since` (`today` by default, `yesterday`, a date, or a date and time), `kinds` (`memory`, `board`, `handoff`, `export`), `actor`, `limit` (default 50, max 200); the reply also counts entries per agent. Reads a cache of the newest 5,000 entries kept in the scheduler, never lists R2. |
| `integrations_list` | | |
| `action_log` | Yes | Records a change made in an outside system. A disallowed actor is recorded as a violation and the owner is notified. |

### Work transfer, approvals, owner contact

| Tool | Write | Notes |
|---|---|---|
| `handoff_create` | Yes | |
| `handoff_resume` | Yes | No `id` lists; `id` claims; `id` with `close: true` closes |
| `approval_request` | Yes | Notifies the owner with the decision link |
| `approval_status` | | |
| `notify_owner` | Yes | 20 per actor per day |
| `reminder_set` | Yes | ISO date and time, up to one year ahead. With an offset it is taken as written; without one it is the owner's local time (`OWNER_TIMEZONE`). Replies show the time with its offset. |
| `reminder_list` | Yes | `cancel_id` cancels |

### Operations

| Tool | Write | Notes |
|---|---|---|
| `usage_stats` | | Calls and writes per actor per day, plus the errors recorded today and yesterday (kind, source, count, latest sanitized detail) |
| `bundle_export` | Yes | Up to 900 files or 50 MB. Owner-only: `human:` actors export directly; an agent needs an approved `approval_id` (action `bundle_export`, resource `memory:/`). |
| `backup_status` | Yes | `run: true` starts a batch now |

The 30 tool definitions cost roughly 4,600 tokens of context per session (characters divided by four, a rough estimate). `brain_guide` adds about 1,000.

---

## 6. Safety model

### 6.1 Why a single agent cannot wipe the brain

1. **No hard delete through the server.** Deletes are soft and need the owner's approval.
2. **Every version is kept** in `history/` before any change.
3. **Board messages are append-only.** There is no edit or delete tool.
4. **Approvals only the owner can grant**, on a password page, bound to one actor, action and resource, single use, seven-day expiry.
5. **Protected paths.** The protocol, the integration registry and templates cannot be changed by an agent without approval.
6. **Daily limits per actor.** Defaults: 3,000 calls and 500 writes per day (reset at midnight in `OWNER_TIMEZONE`, Central). The owner is alerted the first time an actor hits one. Reads keep working when writes are blocked.
7. **Bucket locks** on `board/`, `history/` and `trash/`. Cloudflare's bucket locks prevent deletion and overwriting for the retention period (90 days), so even a Worker bug cannot destroy those prefixes. `memory/` is not locked because live files must be overwritable; `history/` already holds every prior version.
8. **GitHub backup that cannot be rewritten.** Commits are added with `force: false`, and a repository ruleset blocks force pushes and branch deletion.
9. **Agents hold no platform credentials.** They reach the bucket only through the Worker, never with Cloudflare or GitHub tokens.

### 6.2 Security checklist

- Never configure a `human:` token in any agent.
- One token per agent. To revoke, remove it from `AGENT_TOKENS` and re-run `wrangler secret put AGENT_TOKENS`.
- `OWNER_PASSWORD` is a long random value (the server refuses anything under 20 characters). It guards OAuth consent and approvals.
- Two-factor authentication on Cloudflare, GitHub, Trello and the notification service.
- GitHub token: fine-grained, one repository, Contents read and write, with an expiry and a reminder to rotate.
- Give agents' own outside connectors the smallest permissions that work. An agent acting in Trello through its own connector bypasses this server; `action_log` only records afterwards. Set `requires_approval: true` where mistakes are costly.
- The Google Chat webhook URL is a secret: anyone with it can post to that space. Keep it in `NOTIFY_WEBHOOK_URL` only, and recreate the webhook if it leaks (10.1).
- Keep OpenClaw current. CVE-2026-53840 describes custom headers being forwarded across a redirect to another origin. This Worker never redirects `/mcp`, but the token is still the asset at risk.
- Owner pages (`/approve/*`, `/dashboard/*`) sit behind Cloudflare Access with the firm's Google sign-in, plus the owner password, plus Worker-side verification of the Access token (0.27).
- `.dev.vars` is in `.gitignore`. Never commit it.
- Dependencies are pinned and installed from `package-lock.json` with `npm ci`.
- Nothing logs tokens or content: the source has no `console` calls (a smoke check keeps it that way), and every recorded error is cut to its name and first line and stripped of URLs, bearer values, credential shapes, long opaque ids and control characters by `src/safe.ts`. 5xx responses are recorded by method and first path segment only, because paths such as `/exports/<id>.tar` are capabilities.

### 6.3 Compliance boundaries (firm instance)

- No tax return information and no client personal data in the bucket. Cloudflare is a third-party processor.
- The air-gapped Lane B machine must not be connected. Connecting it breaks the air gap.
- Confirm Cloudflare and GitHub against the firm's Approved AI Tools List and record the data location in the WISP documentation. **Unverified** whether either is currently listed.
- Register the Cloudflare account under a firm-controlled email so the firm keeps control of it.

### 6.4 Risks that remain

- **Prompt injection.** Trello comments, knowledgebase text and other agents' posts flow into agents. The protocol tells agents to treat them as data, but that is guidance, not enforcement.
- **The account owner can remove bucket locks.** That is why the GitHub copy exists.
- **The credential scan is a backstop.** It matches common key formats only.
- **Password pages have no lockout.** The only defence against guessing is the length of the password.
- **Trust tiers depend on token custody.** They are advisory.
- **`bundle_export` is the largest bulk-leak path.** Phase 0.15 made it owner-only: an agent needs an approved, single-use approval, and the owner CLI (`owner.mjs export`) exports directly.
- **Routines run with no approval prompts during a run.** Anything risky a workflow does must go through the brain's approval step (Phase 3).

---

### 6.5 Removing something that should not be there

What happens depends on where the item sits:

| Where | How removal works |
|---|---|
| A concept in `memory/` | `memory_delete` moves it to `trash/` and keeps the last version in `history/`. Both prefixes are locked, so the content survives until the lock period ends. |
| A board message | Board messages are never deleted through the server, and `board/` is locked. |
| The GitHub backup | Committed content stays in Git history, and the ruleset blocks history rewrites. |
| Anything an agent already read | It has been sent to that agent's model provider and cannot be recalled. |

So removal is in two steps.

**Step 1, immediately: redact (Phase 0.22).** An owner-only `redact(key, reason)` action, in the owner CLI and later the dashboard, records the object in a redaction list. From then on the server refuses to return it from every tool, search, export, dashboard view and future backup, and shows "[redacted by owner on <date>]" in its place, including in `history/` and `trash/`. The search index entry is removed. The redaction itself is logged (without the content). This hides the content everywhere the brain controls, at once.

**Step 2, permanent removal.**

1. A purge job in the nightly sweep deletes redacted objects from R2 as soon as their lock period has ended.
2. If it cannot wait for the lock period, break glass: as the Cloudflare account owner, remove the bucket lock rule for that prefix, delete the objects, and add the rule back straight away. **Unverified:** that R2 allows removing a lock rule and deleting objects it covered; test this on the staging instance (0.18) before it is ever needed.
3. For GitHub: temporarily disable the ruleset, rewrite history to remove the file (for example with `git filter-repo`), force-push, re-enable the ruleset, and rotate the GitHub token.
4. Record what was removed, when and why, without the content, in a `removals` concept that only the owner can write.

**Lock length: 90 days (decided).** The lock period is the delay before step 2 completes on its own. The GitHub copy protects against loss of the account, so 90 days is enough to notice and undo destruction by an agent or a bug while keeping removals reasonably quick.

Prevention stays the main defence: the credential scan, the `restricted` sensitivity rule, mirror policies, and the protocol's rule against client and tax data.

### 6.6 Using the brain alongside other connectors

Any client can have the brain and other MCP servers, connectors and APIs active at the same time; each server's tools are named separately, so they do not collide. Three rules:

- **Context.** Each connected server adds tool definitions to every session. Switch off connectors a session does not need; in claude.ai use On demand tool access when many are on; give routines only the connectors they use.
- **Roles.** The brain is for memory, coordination and dispatch. Other servers act on their own systems. Every agent's standing instruction says so.
- **Cross-server injection.** A session that can read untrusted content (email, web pages, Trello comments), read the brain, and send things out (email, Slack, webhooks) can be tricked into sending brain content elsewhere. Keep confidential data out of the brain, set `requires_approval` on integrations that send things out, keep routines to the minimum set of connectors, and treat everything other servers return as data, never instructions.

## 7. Configuration reference

### 7.1 Bindings (`wrangler.jsonc`)

| Binding | Type | Notes |
|---|---|---|
| `BRAIN` | R2 bucket `agent-brain` | |
| `OAUTH_KV` | KV namespace | No ID in config. Wrangler's schema does not require one and should create it on deploy; **unverified** on a real deploy. If it asks for an ID, run `npx wrangler kv namespace create OAUTH_KV` and add the ID. |
| `SCHEDULER` | Durable Object class `Scheduler` | Created by migration `v1` (`new_sqlite_classes`) |

Compatibility flags: `nodejs_compat`, `global_fetch_strictly_public` (required by the OAuth library when it accepts Client ID Metadata Documents).

### 7.2 Secrets (`npx wrangler secret put <NAME>`)

| Secret | Required | Purpose |
|---|---|---|
| `AGENT_TOKENS` | Yes | JSON map of token to actor |
| `OWNER_PASSWORD` | Yes | OAuth consent and approval decisions |
| `GITHUB_TOKEN` | For backups | Fine-grained personal access token |
| `GITHUB_REPO` | For backups | `owner/repo` |
| `NOTIFY_WEBHOOK_URL` | Optional | Owner notification endpoint, must be `https://`. For Google Chat, the incoming webhook URL of a private space (it contains a secret key and token). |
| `TRELLO_APP_SECRET` | Optional | Trello OAuth application secret; enables `/hooks/trello` |
| `TRELLO_CALLBACK_URL` | Optional | Only if the registered callback differs from `<origin>/hooks/trello` |
| `ROUTINE_TOKENS` | Phase 3 | JSON map of routine API trigger ID to that routine's bearer token |
| `FILE_SIGNING_KEY` | With file storage | Signs the 15-minute download links for `files/` |
| `CF_ANALYTICS_TOKEN` | 0.26 | Cloudflare API token with only Account Analytics Read, for the usage meters |

### 7.3 Variables (`vars` in `wrangler.jsonc`)

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_BRANCH` | `main` | Backup branch |
| `NOTIFY_FORMAT` | `gchat` | `gchat` (Google Chat incoming webhook), `slack`, `ntfy` or `json` |
| `DAILY_CALL_LIMIT` | `3000` | Tool calls per actor per day |
| `DAILY_WRITE_LIMIT` | `500` | Write tool calls per actor per day |
| `INSTANCE_NAME` (0.16) | `Agent Talk Board` (the firm instance sets "ATLLC Brain" in `wrangler.jsonc`) | Shown by `brain_guide`, `brain_ping`, the server instructions, the OAuth page, the approval page and the dashboard, for example "ATLLC Brain" |
| `NOTIFY_LEVEL` (0.24) | `urgent` | What reaches the notification channel: `urgent`, `summaries` or `all` (4.9) |
| `MAX_FILE_MB` | `25` | Largest file accepted under `files/` (4.6) |
| `STORAGE_CEILING_GB` | `8` | R2 storage at which uploads are refused (8.2) |
| `CF_ACCOUNT_ID` | none | Account ID for the usage meters (8.3) |
| `ACCESS_TEAM_DOMAIN` (0.27) | none | Zero Trust team domain, for fetching Access public keys |
| `ACCESS_AUD` (0.27) | none | Audience tag of the Access application covering the owner pages |
| `OWNER_EMAIL` (0.27) | none | The only email the Worker accepts in an Access token |
| `OWNER_ACTOR` | `human:owner` (code default; the firm instance sets `human:luke` in `wrangler.jsonc`) | The owner's actor. Must start with `human:`; anything else makes the Worker throw. Used for the seeded `client-database` integration and `decided_by` on approvals. |
| `OWNER_TIMEZONE` (0.17) | `America/Chicago` | Owner-facing dates, "today", daily limit resets (midnight), the nightly backup (03:00) and, when built, the nightly sweep (02:00). An invalid value falls back to the default. The helpers are in `src/time.ts`. |

### 7.4 Dependencies

| Package | Version | Why pinned |
|---|---|---|
| `agents` | 0.30.1 | Must match the MCP server package exactly; a mismatch fails `npm install` on a peer conflict |
| `@modelcontextprotocol/server` | 2.3.1 | Pair for `agents@0.30.1` |
| `@cloudflare/workers-oauth-provider` | 1.2.4 | OAuth server |
| `yaml` | 2.9.1 | Frontmatter parsing |
| `zod` | ^4.6.7 | Tool input schemas |
| `wrangler`, `typescript` | Dev | Locked by `package-lock.json` |

When upgrading `agents`, check its `peerDependencies` for the exact `@modelcontextprotocol/server` version first (`npm view agents@<version> peerDependencies`). Prefer releases at least two weeks old.

---

## 8. Free-plan budget

### 8.1 Limits that apply

| Product | Free allowance | Resets | Over the limit |
|---|---|---|---|
| **R2 storage** | 10 GB-month | Monthly | **Billed** ($0.015 per GB-month) |
| **R2 Class A operations** (writes, lists) | 1 million | Monthly | **Billed** ($4.50 per million) |
| **R2 Class B operations** (reads) | 10 million | Monthly | **Billed** ($0.36 per million) |
| R2 egress | Free | | Free |
| Worker requests | 100,000, shared by every Worker on the account | Daily | Requests fail |
| Worker CPU | 10 ms per request | Per request | That request fails |
| Subrequests | 50 external and 1,000 to Cloudflare services per invocation | Per invocation | That call fails |
| Durable Object requests (every RPC call and alarm counts) | 100,000 | Daily, 00:00 UTC | Operations fail |
| Durable Object duration | 13,000 GB-s | Daily, 00:00 UTC | Operations fail |
| Durable Object SQLite rows read | 5 million | Daily, 00:00 UTC | Operations fail |
| Durable Object SQLite rows written (each `setAlarm` counts as one) | 100,000 | Daily, 00:00 UTC | Operations fail |
| Durable Object SQLite storage | 5 GB total | | Operations fail |
| Workers KV | 100,000 reads, 1,000 writes, deletes and lists; 1 GB stored | Daily | Operations fail |
| Cron triggers | 5 per account | | Cannot add more. None needed; the new account's five are a fallback for the sweep and backup. |

The pattern that matters: **R2 is the only product here that bills when it goes over. Everything else stops working instead.** So R2 needs guards that stop growth before it is billed, and everything else needs headroom so the brain does not go down. 00:00 UTC is 6:00 PM or 7:00 PM Central, depending on daylight saving, so daily limits reset in the early evening.

Activating R2 needs a payment method on the account (secondary sources), and R2 overage has no hard cap. The Workers Paid plan, if ever needed, is a $5 per month minimum with much higher limits.

### 8.2 What could move the brain out of the free tier

| Risk | Why | Guard |
|---|---|---|
| **Files** (`files/`) | The only content measured in megabytes. Each new version is a new object, locked for 90 days, and copied weekly to a second bucket, so every file counts about twice. | Storage meter by prefix; refuse uploads above a storage ceiling (8 GB by default, `STORAGE_CEILING_GB`); 25 MB per file; large files stay where they are, by pointer |
| **History** | Every edit keeps the previous version for at least 90 days | Small in practice (text); shown by prefix on the meter |
| **Exports** | A full bundle archive per call | Owner-only (0.15), deleted after 24 hours (Phase 4 housekeeping) |
| **Lists** (Class A) | Every R2 list is a Class A operation, as expensive as a write. Today `board_read` lists a whole thread, each memory write regenerates `index.md` up every folder level, and `brain_guide`, the backup and the sweep list whole prefixes. | Cache listings and summaries in the scheduler Durable Object, updated on write; `board_read` lists by date range (Phase 5); the dashboard never lists R2 directly |
| **Dashboard polling** | A 30-second poll that listed R2 for each view would cost thousands of Class A operations a day | The dashboard reads only cached state from the Durable Object; polling pauses when the tab is hidden |
| **Durable Object requests** | Every tool call already makes one usage RPC; search indexing adds one per write; dashboard polls add more | One combined RPC per tool call (usage, presence, mentions); batch index updates; keep under 50% of 100,000 per day |
| **Durable Object rows written** | Usage counters, presence, search index rows (full-text indexes write several rows per document), concept read tracking | Write counters once per call, not per field; update read tracking in batches; measure index cost on staging |
| **Worker CPU, 10 ms** | Lint, search ranking, index regeneration, export packing and import can exceed it | Heavy work runs in Durable Object alarms in batches; tools that might exceed it return partial results with a continuation |
| **Worker requests** | Agents, routines, the dashboard, webhooks | Per-actor daily limits (already built) |
| **Runaway agent** | A loop could burn any of the above | Daily per-actor limits (built), per-minute rate limiting (Phase 4), alerts at 70% and 90% (0.26) |

Expected use for one owner with a handful of agents is a small fraction of every allowance. The risks above are what would change that, and every one has a guard.

### 8.3 Usage metering and guards (0.26)

Two sources, combined:

1. **Internal counters, live.** Wrap the R2 binding so every call is counted by type (Class A or B) and prefix, and count Durable Object RPCs, alarms, KV operations and outbound fetches. Totals go to the scheduler with the usage record already made on each tool call, so this adds no extra requests. Gives near-real-time numbers for today and this month.
2. **Cloudflare's own figures, hourly.** The scheduler alarm queries Cloudflare's GraphQL Analytics API once an hour (`r2OperationsAdaptiveGroups`, `r2StorageAdaptiveGroups`, `workersInvocationsAdaptive`, and the Durable Objects and KV datasets) with a read-only API token holding only the Account Analytics Read permission. Results are cached in the scheduler. R2 metrics are kept for 31 days. These are the authoritative numbers, and they include anything the counters miss, such as other Workers on the account.

Guards:

- At **70%** of any allowance: listed in the morning brief and the review queue.
- At **90%**: `notify_owner` (urgent), and non-essential work pauses: the weekly AI sweep, imports, exports, uploads and backup batches beyond the minimum.
- R2 storage at the ceiling: uploads refused until space is freed.
- For billed R2 meters, a month-end forecast from the month-to-date trend; a forecast above the allowance is treated like 90%.

New tool: `usage_limits`, returning every meter with used, allowance, percentage, reset time in Central, and forecast. `usage_stats` (per agent) stays as it is.

New secrets and variables: `CF_ANALYTICS_TOKEN` (secret, Account Analytics Read only), `CF_ACCOUNT_ID` (variable), `STORAGE_CEILING_GB` (variable, default 8).

**Unverified:** the exact GraphQL dataset names and fields for Durable Objects and KV; confirm against Cloudflare's schema on staging. Whether Cloudflare billing notifications are available on a free account (0.21).

Account choice: use a **new, dedicated Cloudflare account** (decided). The daily request allowance is counted across the whole account, R2 spending is isolated, a leaked token or bad deploy cannot touch other projects, and there is a clean record of where the data lives.

---

## 9. Deployment runbook

Commands assume a terminal in the project folder. On Windows, use PowerShell for `npx` commands and Git Bash for the test suite.

### 9.1 Prerequisites: accounts and setup done by hand before Claude Code starts

None of these can be done by Claude Code; each takes a few minutes.

1. **Firm-controlled email** for the project's accounts.
2. **Cloudflare account** (new, under that email): turn on two-factor authentication; add a payment method (needed to activate R2); enable Zero Trust and note the team domain (for 0.27). In Notifications, add a usage or billing alert for R2 if the account offers one (**unverified** on a free account), sent to the firm email.
3. **GitHub** (under that email, with two-factor):
   - a private repository for the **source code** (push this project to it; the test workflow runs on every push);
   - a private repository for **backups**, created **with a README** so `main` exists (an empty repository will not work), with a ruleset on `main` that blocks force pushes and branch deletion, no bypass entries;
   - a separate private test repository for the **staging** instance's backups.
4. **Google Chat**: a private space (for example "Brain alerts") with an incoming webhook; copy its link. Workspace must allow incoming webhooks.
5. **Trello**: note the Power-Up's API key and OAuth application secret (for the webhook, 9.10).
6. **Password manager**: entries for the owner password (generate in 9.3), the Cloudflare and GitHub logins and their recovery codes, the Google Chat webhook link and the Trello secret; share the sealed continuity copy with the managing partner.
7. **Your machine**: Node 18 or later and Git; Claude Code installed in VS Code.

Then, in Claude Code, start with Phase 0 in the order given at the top of section 11: code items first (verified locally and in GitHub Actions), then staging, then production.

### 9.2 Install and test

Where things run: the brain itself, the sweeps, the routines and the tests all run in the cloud. Your machine is used only to write code (Claude Code in VS Code), to run `wrangler` commands that deploy and set secrets, and for Claude Code itself.

On your Windows machine you need Node 18 or later and Git. You do not need Git Bash or WSL: the GitHub Actions workflow (`.github/workflows/test.yml`) runs the full test suite on Linux in the cloud on every push, and Claude Code on the web can run it too. **Unverified:** the GitHub Actions minutes included for private repositories on your GitHub plan; the suite takes a few minutes per run.

Locally, if you want:

```bash
npm ci
npx wrangler types
npx tsc -p .
bash tests/smoke.sh
```

All checks should pass before deploying. On Windows, `bash tests/smoke.sh` needs Git Bash or WSL; otherwise rely on the GitHub Actions run.

### 9.3 Create resources and secrets

```bash
npx wrangler login
npx wrangler r2 bucket create agent-brain
```

Generate one token per agent and the owner password:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set the secrets. `AGENT_TOKENS` is one line of JSON, for example `{"<token-1>":"claude-code/opus","<token-2>":"codex/gpt"}`.

```bash
npx wrangler secret put AGENT_TOKENS
npx wrangler secret put OWNER_PASSWORD
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_REPO
npx wrangler secret put NOTIFY_WEBHOOK_URL
```

`NOTIFY_FORMAT` is already `gchat` in `wrangler.jsonc`. To get the Google Chat webhook URL: in Chat in a browser (webhooks cannot be set up from the mobile app), create a space just for you (for example "Brain alerts"), open the space's Apps and integrations, add a webhook, and copy its link. Your Google Workspace must allow incoming webhooks. Incoming webhooks also work in direct messages only when all users have Chat apps enabled, so a private space is the simpler choice.

### 9.4 Deploy

```bash
npx wrangler deploy
```

Note the URL it prints (`https://agent-talk-board.<subdomain>.workers.dev`). The MCP endpoint is that URL plus `/mcp`. The free `workers.dev` address is the permanent address for the firm instance (decided), so every client is connected once.

### 9.5 Lock the append-only prefixes

```bash
npx wrangler r2 bucket lock add agent-brain --name keep-board --prefix board/ --retention-days 90
npx wrangler r2 bucket lock add agent-brain --name keep-history --prefix history/ --retention-days 90
npx wrangler r2 bucket lock add agent-brain --name keep-trash --prefix trash/ --retention-days 90
```

When file storage is built, add `npx wrangler r2 bucket lock add agent-brain --name keep-files --prefix files/ --retention-days 90`.

Do this **after** the Phase 0 checks, so test data is not locked in for 90 days. Never lock `memory/`, `handoffs/` or `approvals/`; the server overwrites files there.

### 9.6 GitHub backup

1. In the repository, add a ruleset on `main`: block force pushes, restrict deletions, no bypass entries.
2. Create a fine-grained personal access token limited to that repository, Contents read and write, with an expiry.
3. After deploy, ask any connected agent to call `backup_status` with `run: true`, and confirm a commit appears.

The scheduled run is at 08:00 UTC daily in the current code; 0.17 moves it to 03:00 Central.

### 9.7 Connect Claude Code (VS Code terminal)

```bash
claude mcp add --scope user --transport http talk-board https://agent-talk-board.<subdomain>.workers.dev/mcp --header "Authorization: Bearer <claude-code-token>"
claude mcp list
```

User scope is stored in `~/.claude.json` and is private to you across all projects. Do not use project scope: it writes `.mcp.json` into the repository. The server name must be `talk-board`, because the hook matchers depend on it.

Then install the hooks:

1. Copy `claude-code/talk-board-hook.mjs` to `C:\Users\<you>\.claude\hooks\`.
2. Merge the `hooks` block from `claude-code/settings.hooks.json` into `C:\Users\<you>\.claude\settings.json`. Fix the path in the four commands if your user folder differs.
3. Set the environment variables, then restart VS Code:

```
setx TALK_BOARD_URL "https://agent-talk-board.<subdomain>.workers.dev/mcp"
setx TALK_BOARD_TOKEN "<claude-code-token>"
```

What the hooks do: session start injects `brain_guide`; file edits mark the session as having done work; talk-board writes clear the mark; at stop, if work happened with no talk-board write since, Claude is asked once to update the board or memory, or to say nothing qualifies.

### 9.8 Connect Claude in the browser

On a Team or Enterprise plan, Anthropic's documentation says only an Owner can add a custom connector, it is added for the whole organization, and it then appears for every member. There is no documented way to add one for a single person. The OAuth password is what keeps it yours.

1. An Owner opens Organization settings, Connectors, then Add, Custom, Web, and enters the `/mcp` URL.
2. Authentication: **Sign in now**. Do not choose "Sign in when needed"; this server answers every unauthenticated request with 401, so that option is the one most likely to prompt other people.
3. OAuth client: **Register automatically** (the tested flow). "Use Claude's published identity" is supported by the server but **untested**.
4. Name it so it is obviously private, for example "Luke: Agent Talk Board (private)".
5. You open Customize, Connectors, select Connect, and enter the owner password.
6. In each chat, check that the connector is switched on.

Side effects: connectors added in the browser also load in Claude Code when signed in with the same account, so the server may appear twice there; turn one off in `/mcp`. Whether a connector a member has not connected can ever be suggested to that member is **unverified**.

For a hands-off start in the browser, add a line to your personal preferences: "When the talk-board connector is available, call brain_guide first and update it before finishing substantial work."

### 9.9 Connect other agents

Codex, in `~/.codex/config.toml` (a literal `bearer_token` fails on current Codex; use the environment variable form):

```toml
[mcp_servers.talk_board]
url = "https://agent-talk-board.<subdomain>.workers.dev/mcp"
bearer_token_env_var = "TALK_BOARD_TOKEN"
```

Hermes, in `~/.hermes/config.yaml` (it expands `${VAR}` from `~/.hermes/.env`; reload with `/reload-mcp`):

```yaml
mcp_servers:
  talk_board:
    url: "https://agent-talk-board.<subdomain>.workers.dev/mcp"
    headers:
      Authorization: "Bearer ${TALK_BOARD_TOKEN}"
```

OpenClaw (the transport must be set explicitly; it defaults to SSE):

```bash
openclaw mcp set talk-board '{"url":"https://agent-talk-board.<subdomain>.workers.dev/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${TALK_BOARD_TOKEN}"}}'
openclaw mcp doctor talk-board --probe
```

Each agent needs one standing line in its own global instruction file: "At the start of every session, call the talk-board `brain_guide` tool and follow it." Only Claude Code's hooks have been verified to enforce this; for the others it is guidance.

### 9.10 Trello webhook (optional)

1. `npx wrangler secret put TRELLO_APP_SECRET` (the OAuth application secret from the Power-Up's API key page).
2. Register the webhook with the callback exactly `https://agent-talk-board.<subdomain>.workers.dev/hooks/trello`:

```bash
curl -X POST "https://api.trello.com/1/tokens/<trello-token>/webhooks/?key=<trello-api-key>" -H "Content-Type: application/json" -d '{"idModel":"<board-id>","callbackURL":"https://agent-talk-board.<subdomain>.workers.dev/hooks/trello"}'
```

Trello signs each delivery with a base64 HMAC-SHA1 of the raw body plus the registered callback URL, and sends a HEAD check at creation that must return 200. Both are implemented.

Decided: Trello events come in through this Worker endpoint, not a routine. Trello's webhook setup takes only a callback URL, while a routine's API trigger needs a bearer token header, so a routine cannot receive Trello events directly. The endpoint is already built and tested, costs nothing per event, verifies Trello's signature, and posts every card change to `trello-events`. When a card change should start AI work, a Phase 3C event trigger (for example, a card moved into a "For the brain" list) dispatches the matching routine, so routines run only when there is something for them to do.

---

## 10. Day-two operations

| Task | How |
|---|---|
| Change the rules agents follow | Edit `memory/protocol.md` (protected: needs approval or the owner CLI). Every agent sees it on the next `brain_guide`. |
| Add an outside system | Start from `memory_templates(type="integration")`, write `integrations/<name>.md` |
| Cut off an agent | Remove its token from `AGENT_TOKENS`, re-put the secret |
| Undo a bad edit | `memory_history`, then `memory_restore` |
| Bring back a deleted file | `memory_restore` with `if_etag: "new"` |
| See who is using what | `usage_stats` |
| Check backups | `backup_status` |
| Keep the bundle healthy | `bundle_lint` runs inside the nightly sweep (Phase 1C); before that, run it monthly |
| Keep facts current (Phase 1C, 3F) | Read the sweep counts in the morning brief; accept or reject proposals in the dashboard weekly |
| Find something from the past (Phase 1) | Ask any agent; it calls `search` |
| Drop in a quick note (Phase 1) | "Brain, note that..."; it calls `brain_capture`; triaged in the weekly review |
| Start an automation (Phase 3) | "Run the <name> workflow"; check progress with `workflow_status` |
| Add a workflow (Phase 3) | Create the routine in claude.ai with an API trigger, write `library/workflows/<name>.md` from the template, add its token to `ROUTINE_TOKENS`, verify it as owner |
| Rotate the GitHub token | New token, `wrangler secret put GITHUB_TOKEN`; set a `reminder_set` for the next expiry |
| Disaster recovery | Clone the backup repository; see Phase 5 for the restore script |

Test a restore once from history and once from GitHub before relying on either.

---

### 10.1 Credential rotation and recovery runbook

Set a reminder for each rotation date with `reminder_set` (or in the dashboard). After any rotation, run `brain_ping` from each affected client.

| Credential | Rotate when | Steps |
|---|---|---|
| **An agent token** (`AGENT_TOKENS`) | Yearly, when a device is lost, or when an agent misbehaves | 1. Generate a new token. 2. Edit the JSON: remove the old token, add the new one with the same actor. 3. `npx wrangler secret put AGENT_TOKENS`. 4. Update that client's config (Claude Code `claude mcp add` again, Codex and Hermes environment variable, OpenClaw `mcp set`, routine environment). 5. `brain_ping` from that client. The old token stops working as soon as the secret is saved. |
| **Owner password** (`OWNER_PASSWORD`) | Yearly, or if it may have been seen | 1. Generate a new one. 2. `npx wrangler secret put OWNER_PASSWORD`. 3. Store it in your password manager. Existing claude.ai connections keep working on their issued tokens; to force them to sign in again, revoke their grants (next row). |
| **claude.ai OAuth grants** | When a browser or phone session is lost, or after a password change | Revoke the grants through the OAuth provider's grant revocation (add as an owner-only dashboard action in Phase 6B; **unverified** API details in `@cloudflare/workers-oauth-provider`). Emergency fallback: delete the grant and token keys from `OAUTH_KV` with `npx wrangler kv key list` and `npx wrangler kv key delete`, which forces every OAuth client to sign in again. Then reconnect in claude.ai. |
| **GitHub token** (`GITHUB_TOKEN`) | Before its expiry date (set at creation) | 1. Create a new fine-grained token: the backup repository only, Contents read and write. 2. `npx wrangler secret put GITHUB_TOKEN`. 3. `backup_status` with `run: true`; confirm a commit or "up to date". 4. Revoke the old token on GitHub. |
| **Routine tokens** (`ROUTINE_TOKENS`, Phase 3) | When a routine's API trigger token is regenerated, or yearly | 1. Regenerate the trigger's token on the routine's page in claude.ai. 2. Update the JSON entry for that trigger ID. 3. `npx wrangler secret put ROUTINE_TOKENS`. 4. `workflow_run` a harmless workflow to confirm. |
| **Notification webhook** (`NOTIFY_WEBHOOK_URL`) | If the URL leaks | Add a new incoming webhook to the Google Chat space, `npx wrangler secret put NOTIFY_WEBHOOK_URL`, `notify_owner` a test message, delete the old webhook from the space. |
| **Trello app secret** (`TRELLO_APP_SECRET`) | If it leaks | Regenerate it in the Trello app settings, `npx wrangler secret put TRELLO_APP_SECRET`, move a test card and confirm it appears on `trello-events`. |
| **File signing key** (`FILE_SIGNING_KEY`) | Yearly | Generate a new random key, `npx wrangler secret put FILE_SIGNING_KEY`. Links issued before the change stop working, which is harmless because they expire after 15 minutes. |
| **Cloudflare and GitHub logins** | If a password may be known | Change the password, confirm two-factor is on, review active sessions and API tokens on each site. |

**Lost or stolen device.** In this order:

1. Rotate every agent token that device held (its Claude Code, Codex, Hermes or OpenClaw tokens).
2. Revoke claude.ai OAuth grants if the device was signed in to Claude.
3. Rotate the owner password if it was saved on the device.
4. Rotate the GitHub token if `wrangler` or the owner CLI on that device had it in an environment file.
5. Check `activity` and `usage_stats` since the loss for writes from that device's actors; redact or restore anything suspicious.
6. Record what happened in the `owner` thread.

**Total loss of the Cloudflare account.** Create a new account, deploy from the repository, restore from the GitHub backup with the Phase 5 restore script, issue new tokens to every client.

## 11. Remaining work

Each phase ends with: `npx tsc -p .` clean, `bash tests/smoke.sh` green with new checks added for the new behaviour, `PROTOCOL_BODY` and this document updated.

### Phase 0: Deploy and prove what exists

Goal: close the gap between "passes locally" and "works for real". Do not lock the bucket until this phase is done.

Order of work: first the code items 0.1, 0.3, 0.15 to 0.24, 0.26 and 0.27, verified locally (0.25 waits for proposals in 1E); then stand up staging (0.18) and run 0.4 to 0.12 against staging; then repeat 0.4 to 0.12 against production; then 0.13 (bucket locks on production) and 0.14 (module split, verified on staging before production). Seeding (1D) comes after Phase 1A to 1C.

| # | Task | Done when |
|---|---|---|
| 0.1 (done) | Make the owner identity configurable: add an `OWNER_ACTOR` variable (firm instance: `human:luke`), use it in the seeded `client-database` integration and in `decided_by` on approvals. The seeds already use `human:luke`. | Changing `OWNER_ACTOR` changes every owner reference without code edits |
| 0.2 (dropped) | Make seeded integrations data-driven. Dropped 2026-11-13: its only purpose was a second instance with different seeds, which is out of scope. The three seeds stay in `DEFAULT_CONCEPTS`; edit them there if they ever need to change. | Not needed |
| 0.3 (done) | Owner command-line script `scripts/owner.mjs`: calls the MCP endpoint directly with a `human:` token read from an environment variable; subcommands `verify <path>`, `write <path> <file>`, `delete <path>`, `read <path>`, `guide` | Owner can verify the seeded integrations without any agent holding the human token |
| 0.4 | Deploy to the new account | `/` responds; unauthenticated `/mcp` returns 401 |
| 0.5 | Confirm KV auto-creation | Deploy succeeds, or the fallback in 7.1 is applied and noted here |
| 0.6 | Claude Code end to end | `brain_guide` returns the protocol; hooks inject at start and nudge at stop |
| 0.7 | Claude in the browser | OAuth completes with "Register automatically"; a post shows actor `claude-ai/web`; try "Use Claude's published identity" and record the result |
| 0.8 | Real GitHub backup | A commit appears; a second run reports up to date; a deleted file disappears in the next commit |
| 0.9 | Real notification | `notify_owner` arrives in the Google Chat space with `global_fetch_strictly_public` on |
| 0.10 | Codex, Hermes, OpenClaw | Each connects and completes one `board_post`; record whether each surfaces the server instructions |
| 0.11 | Trello webhook, if wanted | A real card move appears on `trello-events` |
| 0.12 | Review and verify seeds | Owner edits the three integration files (Trello, Trainwel, client database) to match reality and verifies them |
| 0.13 | Apply bucket locks | `npx wrangler r2 bucket lock list agent-brain` shows three rules |
| 0.14 | Split `src/index.ts` (about 2,400 lines) into modules: `auth`, `okf`, `board`, `memory`, `integrations`, `safety`, `scheduler`, `http` | Smoke suite still green; no behaviour change |
| 0.15 (done) | Make `bundle_export` owner-only: refuse unless the actor is `human:`, or the agent holds an approved `approval_id` for action `bundle_export` on resource `memory:/` | An agent token gets a refusal; the owner CLI gets a link |
| 0.16 (done) | Instance identity: `INSTANCE_NAME` variable shown at the top of `brain_guide`, in the server instructions, on the OAuth consent page and on the approval page; new `brain_ping` tool returning instance name, caller's actor, protocol version, local time, unread mentions and captures waiting, in under 300 characters. Built so far: instance, actor, protocol version (0.19) and local time; add captures in 1B and mentions in Phase 2. | "Check the brain" in any client answers "Connected to <instance> as <actor>"; the consent page shows the instance name |
| 0.17 (done) | Time zone: `OWNER_TIMEZONE` (`America/Chicago`) applied as in 4.7; nightly sweep 02:00 Central, backup 03:00 Central, daily limits reset at midnight Central, all correct across daylight saving changes | Tests cover a date on each side of a daylight saving change. Applied so far to: daily limit resets, the backup schedule, `log.md` and handoff dates, reminders and `brain_ping`. The nightly sweep (Phase 1C), briefs and task due dates (Phase 2 and 3) and the dashboard (Phase 6) must use the `src/time.ts` helpers when built (`nextLocalTime(now, tz, 2, 0)` for the sweep). |
| 0.18 | Staging instance: `agent-talk-board-staging` Worker, its own bucket, KV, scheduler, tokens and owner password; no bucket locks (or 1-day locks to test them); a GitHub backup to a separate test repository. Every phase is deployed and checked on staging before production. | A deploy script or npm scripts `deploy:staging` and `deploy:prod` exist; production is never the first place a change runs |
| 0.19 (done) | Versions: `protocol_version` and `schema_version` as in 4.8 | `brain_guide` and `brain_ping` show the protocol version; every server-written file carries `schema_version` |
| 0.20 (done) | Receipts and activity: protocol requires a one-line receipt after every write; new `activity` tool (`since`, `kinds`, `actor`; returns a merged, newest-first list of memory changes, captures, tasks, handoffs and board posts with links); `brain_brief` gains a "Since yesterday" section | Asking "what did the brain record today?" returns every write made that day, by agent. Built: the `activity` tool over a cache in the Scheduler (memory changes, board posts, handoffs, bundle exports; the protocol's receipt rule). Still to do, as the things exist: captures and tasks as new kinds (1B, Phase 2), session summaries (0.24), the "Since yesterday" section of `brain_brief` (Phase 3, using the same query), and removing a redacted object's rows (0.22). |
| 0.21 (done) | Monitoring: Worker logs on with no tokens or message bodies logged (audit `console` calls); Cloudflare billing notifications for R2 if the account offers them; the nightly sweep summarizes the previous day's errors (failed writes, 5xx responses, failed alarms, failed notifications) | A forced error appears in the next sweep report and never includes a token. Built: an error log in the scheduler (failed tool calls with the tool name and a write flag, 5xx responses, failed alarms, failed notifications, failed backups), the sanitizer, and the errors section of `usage_stats`; tests force each of tool exceptions, 5xx and notification failures end to end. Still to do: the nightly sweep (1C) includes the previous day's errors using the scheduler's `errorReport(day)`; the R2 billing notification (a dashboard setting, see 9.1); and on staging, confirm that the Workers Logs invocation entries show no `Authorization` header or message bodies (**unverified**). Failed alarms are recorded and re-thrown for Cloudflare to retry; that path is reviewed, not forced in tests. |
| 0.22 | Redaction and purge as in 6.5: owner-only `redact`, redaction list in the scheduler, filtering in every read path, purge job after the lock period, `removals` record | A redacted concept, board message and history version all read as "[redacted]" through every tool, search, export and backup |
| 0.23 | Required `why` on every write, as in 4.9; shown in `log.md`, the activity feed and the board | A write without a meaningful `why` is rejected; every log line carries one |
| 0.24 | `session_summary` tool and `NOTIFY_LEVEL` (`urgent`, `summaries`, `all`) | A session summary appears in the activity feed and, at `summaries`, on the phone |
| 0.25 | Write modes per token (`direct`, `propose`, `read`): `AGENT_TOKENS` values become either an actor string (treated as `direct`) or `{"actor": "...", "mode": "..."}`; `propose` turns memory writes into proposals; any non-owner overwrite of a human-reviewed concept becomes a proposal. Needs 1E (proposals) first, so build it right after 1E. | A `propose` token's `memory_write` creates a proposal and changes nothing; overwriting a human-reviewed concept from a `direct` token also creates a proposal |
| 0.26 | Usage metering and guards as in 8.3: R2 binding wrapper counting operations by class and prefix, Durable Object and KV counters, hourly GraphQL Analytics pull, `usage_limits` tool, 70% and 90% thresholds, storage ceiling, cached listings so the dashboard never lists R2 | `usage_limits` shows every meter with reset times in Central; a simulated 90% reading pauses the weekly sweep and notifies the owner; internal counts and Cloudflare's figures agree within a few percent on staging |
| 0.27 | Cloudflare Access in front of the owner pages. In Zero Trust, Access, Applications, create a **self-hosted application** whose domains are the paths `agent-talk-board.<subdomain>.workers.dev/approve` and `agent-talk-board.<subdomain>.workers.dev/dashboard` (Phase 6), with a policy allowing only the owner's firm email, signed in through the firm's Google Workspace (or a one-time code to that email), with a short session. Do **not** use "Protect this Worker" or "Protect all Workers": those cover every path, including `/mcp`, `/oauth/*` and `/hooks/*`, and would cut off Claude, the routines, the other agents and Trello. In the Worker, verify the `Cf-Access-Jwt-Assertion` header on those paths (signature against the team's public keys, the application's audience tag, and the owner's email) and refuse requests without it, so the Access check cannot be bypassed. Record the Access email as `decided_by` on approvals. Keep the owner password check as well. New variables: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`. Test locally with the `access.dev` block in `wrangler.jsonc`. | From a private browser window, `/approve/<id>` shows the Access sign-in, not the approval page; `/mcp` with an agent token still works; a request to `/approve/<id>` with a forged or missing Access header is refused by the Worker |

### Phase 1: Recall and capture

These two make the brain useful every day. Build them first, straight after Phase 0.

**1A. Search**

One `search` tool across memory, board messages, captures, tasks and handoffs.

Engine: SQLite full-text search (FTS5) inside a Durable Object, either the existing `Scheduler` or a new `Search` class. It needs no new Cloudflare product, and SQLite-backed Durable Objects are available on the Free plan. **Unverified:** that FTS5 is enabled in Durable Object SQLite, and the free storage allowance; check both before building. Fallbacks: D1 with FTS5, or plain `LIKE` matching on titles, descriptions and tags. Semantic search (Vectorize with Workers AI embeddings) can be added later as a second mode; its free limits are also **unverified**.

Index table: `doc_id` (the R2 key), `kind` (`concept`, `board`, `capture`, `task`, `handoff`), `path`, `title`, `tags`, `actor`, `updated`, `thread`, and `body` (the first 20,000 characters, frontmatter removed).

Indexing happens on every write: `memory_write`, `memory_restore`, `memory_move` (remove old, add new), `memory_deprecate`, `memory_delete` (remove), `memory_verify`, `board_post`, `brain_capture`, `capture_resolve`, the task and handoff tools, and the Trello webhook. Use one RPC call to the Durable Object per write. If indexing fails, the write still succeeds and the document is recorded in a `pending_index` table that the next alarm retries.

Tools:

| Tool | Purpose |
|---|---|
| `search` | `query`, optional `kinds`, `tags`, `since`, `until`, `actor`, `thread`, `limit` (default 10, max 50). Returns path, kind, title, date, actor and a short snippet per hit, ranked. Never returns whole documents; the agent reads what it needs. |
| `search_reindex` | Owner-only. Rebuilds the index from R2 in batches (for first deployment, after a restore, or if the index is lost). Progress shown in `backup_status` style. |

Deprecated concepts rank lower and are labelled. Items in `trash/` and `history/` are not indexed. Restricted content never reaches the bucket, so it never reaches the index.

Protocol change: agents call `search` before answering any question about the past and before creating a concept, to avoid duplicates.

Done when: a board message from months earlier is found by a phrase from its body; a deleted concept stops appearing; a moved concept appears under its new path only; `search_reindex` rebuilds an empty index to the same results.

**1B. Quick capture and inbox triage**

`brain_capture` takes plain text with no structure required, so "brain, note that..." works from any client, including the phone.

| Input | Notes |
|---|---|
| `text` | Required, up to 10,000 characters |
| `kind` | Optional: `note` (default), `idea`, `todo`, `decision`, `question` |
| `tags` | Optional |
| `project` | Optional thread or project slug |
| `remind_at` | Optional ISO time; also creates a reminder |
| `resource` | Optional outside record, checked like any other reference |

It writes `memory/inbox/<YYYY-MM-DD>-<8 hex>.md` as an OKF concept with `type: Capture`, `status: draft`, `state: new`, a title made from the first line, and the server's `generated` stamp. Captures go through the credential scan and sensitivity rules like everything else, are indexed for search at once, and appear in `memory_index` under `inbox/`. A capture tagged `auto` is offered to the workflow event matcher (Phase 3C).

Triage tools:

| Tool | Purpose |
|---|---|
| `capture_list` | Captures in `state: new`, oldest first, with counts by kind |
| `capture_resolve` | `id`, `outcome` (`concept`, `task`, `reminder`, `merged`, `discard`), optional `target` (the concept path or task ID it became). Sets `state: resolved`, records the outcome and target, and keeps the file so the trail survives. `discard` keeps the file too; nothing is deleted. |

The weekly review (3D) triages the inbox; `brain_brief` and the review queue show how many captures are waiting. `inbox/` is not a protected path, so any agent can capture.

Done when: one sentence from the phone becomes a capture that `search` finds immediately; `capture_resolve` with outcome `task` links the capture to the new task; resolved captures drop out of `capture_list`.

**1C. Freshness policy and nightly mechanical sweep**

Goal: no stored fact goes stale without someone being told. This part needs no AI and no cron trigger: the scheduler's alarm runs it, using only data the server already has.

Freshness policy. Every concept gets a review date:

| Concept type | Default review period if `stale_after` is not set |
|---|---|
| Mirrored summaries (`resource` from a `summaries` integration) | Required at write time (already enforced) |
| `Integration` | 180 days |
| `Playbook`, `Reference`, `Protocol` | 180 days |
| `Note`, `Capture` | 90 days |
| `Decision`, `Lesson` | 365 days (reviewed for whether they still apply, not rewritten) |
| `Prompt`, `Skill`, `Workflow`, `Command`, `Checklist` | 180 days |
| Anything else | 180 days |

The defaults live in one table in code and can be overridden in `protocol.md`. When a concept has no `stale_after`, its effective review date is its last `verified` date, or else its last `generated` date, plus the period. `memory_read`, `search` results and the dashboard show the effective date and whether it has passed. A concept is **fresh** when within its period, **due** within 14 days of the date, and **stale** after it.

Usage tracking. The scheduler records the last time each concept was read and how many reads it had in the last 90 days (one row per concept in a `concept_usage` table, updated by `memory_read`, `library_get` and search clicks from the dashboard). This separates stale-and-still-used (fix it) from stale-and-unused (probably deprecate it).

The nightly sweep, at 02:00 Central (before the 03:00 Central backup), runs in batches and changes nothing. It finds:

- Concepts that are stale, or due within 14 days, ranked with heavily read ones first.
- Concepts never verified, and concepts whose last verification is older than their review period.
- Concepts not read in 180 days.
- Concepts that link to deprecated or deleted concepts.
- Captures untriaged for more than 7 days.
- Tasks overdue, tasks with an expired lease still marked claimed, tasks in `review` for more than 7 days (after Phase 2).
- Handoffs open or claimed with no activity for 7 days.
- Approvals expiring within 24 hours.
- Threads with no new messages for 30 days and not archived.
- Workflow runs stuck in `todo` or `claimed` for more than 2 hours (after Phase 3).
- `bundle_lint` findings (it calls the same code).
- The previous day's errors (failed tool calls, 5xx responses, failed alarms, failed notifications, failed backups), from the scheduler's `errorReport(day)` (Phase 0.21). Details are already sanitized.

Output: a report at `memory/reports/sweeps/<YYYY-MM-DD>.md` (`type: Report`, written by `process:sweep`), a summary line posted to the `review` thread, and the findings stored for `sweep_report`. If anything is urgent (approvals about to expire, a stale concept read more than ten times this week, a failed backup), `notify_owner` is called once.

Tools:

| Tool | Purpose |
|---|---|
| `sweep_report` | The latest findings, filterable by category; `date` for an older report |
| `freshness` | For one path: effective review date, state (fresh, due, stale), last verified, last read, reads in 90 days |

The morning brief includes the counts; the review queue and the dashboard list the items.

Done when: a concept written with a backdated `generated` stamp shows as stale in `memory_read`, `search` and `sweep_report`; verifying it moves it back to fresh; a concept nobody has read for 180 days appears in the unused list; the nightly run produces a report without a cron trigger.

**1D. Seeding on day one**

An empty brain will not be used. Seed it right after 1A to 1C, on staging first, then production.

What goes in:

| Source | Becomes |
|---|---|
| Every connector and API in use (Trello, knowledgebase, the QBO MCP connector, Housecall Pro, GitHub, Slack and others) | One integration file each under `integrations/`, with access, credential location, allowed agents, mirror policy and sensitivity |
| Active projects (CRM build, QBO connector, Housecall Pro split, shared-brain build itself, Trainwel/Humanagement MCP, others) | A project concept each: goal, status, decisions so far, open questions, links to repositories and Trello boards |
| SOPs | Summaries with `resource` pointers (`trainwel:`) and `stale_after`, not copies of the full text |
| Reference files (PDFs, spreadsheets) that are not client documents | Uploaded to `files/` with a `type: File` concept each |
| Notes and existing `CLAUDE.md` files | Concepts by topic, or captures to be triaged |
| Prompts, skills, commands, checklists | Library items in `library/` (Phase 2B rules apply when it exists; until then, `library/` drafts) |
| Agents in use | Agent registry entries (Phase 2C) |

How:

- `scripts/import.mjs`, run by the owner through the owner CLI (0.3), either writes directly or, with `--propose`, creates proposals (1E) for one-by-one review. It reads a local folder of Markdown files with an `import.yaml` manifest giving each file's target path and type, adds frontmatter, and writes each as `status: draft` with tag `imported`. Nothing is imported as verified.
- Before writing, it runs the same checks as `memory_write` (credential scan, sensitivity, mirror policy), and a dry-run mode prints what would be written.
- Imported concepts start with a short review date (30 days), so the nightly sweep lists them and the owner verifies or corrects them over the first month.
- Connectors and projects first, SOPs and notes second, library third.

Done when: every connector in use has an integration file; every active project has a concept; `search` finds each SOP by title; the morning brief lists imported items awaiting verification.

**1E. Proposals**

The mechanism every reviewed change goes through: sweep suggestions (3F), imports (1D), writes from `propose` tokens (0.25), and agent overwrites of human-reviewed concepts. Specified in 3F under "Proposals, not edits"; built here so the rest can use it early. Tools: `proposal_list`, `proposal_create`, `proposal_decide` (owner only). Until the dashboard exists, the owner decides through the owner CLI.

Done when: a proposal can be created, listed and accepted, accepting it applies the change through the normal write path with history and a log entry, and a rejected proposal records its reason.

### Phase 2: Tasks, library, registry, mentions

**2A. Tasks and agenda**

One file per task at `tasks/<id>.md` (outside the OKF bundle, like handoffs).

| Field | Purpose |
|---|---|
| `id`, `title`, `type: Task` | Identity |
| `state` | `todo`, `claimed`, `in_progress`, `blocked`, `review`, `done`, `cancelled`. Not `status`. |
| `assignee`, `created_by`, `priority`, `tags` | Triage |
| `due`, `scheduled` | Dates. The agenda is a date-range query over these. |
| `recurrence` | Rule for repeating items |
| `depends_on` | Task IDs that must finish first |
| `thread` | Board thread for discussion |
| `resource` | Outside record, for example the Trello card |
| `lease_until` | Claim expiry. A lapsed lease is treated as unclaimed when read. |

Tools: `task_create`, `task_list` (filter by state, assignee, date range, tag), `task_claim` (etag-conditional, sets a lease), `task_update` (state, note, extend lease), `task_complete` (posts the result to the thread; optional promotion of a decision or lesson to memory).

Rules: keep task metadata in R2 custom metadata so `task_list` needs no file reads. Recurrence creates the next instance when the list is read and the previous one is done; a daily alarm in the scheduler pre-creates instances so they exist ahead of time. Tasks are added to the GitHub backup prefixes. Trello remains the source of truth for the owner's own to-dos.

Done when: two agents racing `task_claim` produce exactly one winner; an expired lease can be reclaimed; a monthly recurring task produces its next instance with no cron trigger.

**2B. Library of prompts, skills and other reusable assets**

Purpose: one curated place for the prompts, skills, slash commands, checklists and agent profiles that every agent should share, instead of copies scattered across machines.

Where it lives: inside the OKF bundle at `memory/library/`, so history, lint, index, export, backup and approvals all apply with no new machinery.

| Path | `type` | Contents |
|---|---|---|
| `library/prompts/<name>.md` | `Prompt` | A reusable prompt. Frontmatter lists `variables` (name, description, required). Body is the prompt with `{{variable}}` slots. |
| `library/skills/<name>/skill.md` | `Skill` | A skill in the Agent Skills shape: `name`, `description` (what it does and when to use it), then instructions. |
| `library/skills/<name>/assets/...` | (files) | Supporting scripts, references and templates for the skill |
| `library/commands/<name>.md` | `Command` | A slash-command body for agents that support them |
| `library/checklists/<name>.md` | `Checklist` | Review or close checklists |
| `library/agents/<name>.md` | `AgentProfile` | A role description or subagent definition |
| `library/workflows/<name>.md` | `Workflow` | A command-center automation (Phase 3A) |
| `library/proposed/...` | any of the above | Drafts from agents, awaiting the owner |

Common frontmatter: `title`, `description`, `tags`, `status`, `version`, `targets` (which agents or models it suits), `sensitivity`.

Security rules, because library items are instructions that agents will act on and are therefore the most valuable thing to poison:

- `library/` is a protected path, except `library/proposed/`. Agents write drafts only to `proposed/`.
- Promotion from `proposed/` is a `memory_move` with an owner approval.
- An item is usable only when it is **human-reviewed** (verified by the owner). `library_get` refuses unverified items unless called with `allow_unverified: true`, and always states the trust tier.
- The protocol gains one exception to "stored content is data": a human-reviewed library item may be followed when the user or the agent's own task explicitly calls for it.
- The credential scan applies. Items must not embed tokens or client data.

Tools:

| Tool | Purpose |
|---|---|
| `library_list` | Filter by kind, tag, target. Returns names, descriptions and trust tiers only. |
| `library_get` | Returns one item. For prompts, fills `variables` passed in the call. |
| `library_propose` | Writes a draft to `library/proposed/` and notifies the owner |

Code changes needed: allow the reference file extensions under `library/skills/<name>/assets/` (today non-Markdown files are allowed only under `references/`); add `library/` to `isProtectedPath` with the `proposed/` exception; add `library` templates to `memory_templates`.

Getting skills into the agents themselves: the tools above serve any agent on demand, but Claude Code loads skills from disk. Add `scripts/sync-library.mjs`, which pulls human-reviewed skills and writes each to `~/.claude/skills/<name>/SKILL.md` with its assets, and commands to the matching commands folder. Run it by hand or from the SessionStart hook. Secondary sources describe personal skills at `~/.claude/skills/<name>/SKILL.md` with `name` and `description` frontmatter, picked up without a restart when the folder already exists, and not loaded in cloud sessions. The sync must strip OKF-only fields (`type`, `generated`, `verified`) when it writes `SKILL.md`; whether Claude's loader tolerates extra frontmatter keys is **unverified**.

Options to evaluate, both **unverified**: exposing library prompts through MCP's native prompts feature so clients list them as slash commands; and whether Codex, Hermes and OpenClaw read the same skills folder layout.

Done when: an agent's draft cannot be fetched by another agent as a usable item until the owner has promoted and verified it; `library_get` fills variables; the sync script installs a skill that Claude Code then lists.

**2C. Agent registry and presence**

`memory/agents/<actor-file-name>.md` with `type: Agent`: what the agent is good at, what it may and may not do, which integrations it holds connectors for. Written by the owner (add `agents/` to protected paths).

Presence (last seen, calls today, current task) belongs in the scheduler Durable Object, which already sees every call. Add a `last_seen` column to `usage` or a small `presence` table. Do not write an R2 object per request.

Tools: `agent_list` (registry joined with presence). Done when `agent_list` shows each connected agent with a last-seen time under a minute old after it makes a call.

**2D. Mentions**

Parse `@<actor>` in `board_post`, `handoff_create` and reminders. Record `mentions` in the message frontmatter and insert a row in a scheduler table (`mentions`: actor, thread, file, time, read flag). Tool: `mentions_read` (unread mentions for the caller, marks them read). Named so it is not confused with the capture inbox in 1B. Add the unread count to `brain_guide`. Done when a mention posted by one agent is returned once to the mentioned agent and not again.

### Phase 3: Command center

The brain dispatches; something else runs. The runner is **Claude Code Routines** in Anthropic's cloud. A routine is a saved Claude Code configuration (prompt, repositories, connectors) that runs on a schedule, on an API call or on a GitHub event, as a cloud session with no machine of yours running. Routines are in research preview and available on Pro, Max, Team and Enterprise plans with Claude Code on the web enabled.

**3A. Workflow registry**

One file per workflow at `memory/library/workflows/<name>.md`, `type: Workflow`, inside the protected library so only owner-approved and owner-verified workflows can run.

| Field | Meaning |
|---|---|
| `title`, `description`, `tags` | What it does and when to use it |
| `enabled` | `true` or `false` |
| `runner` | `routine:<name>` or `agent:<actor>` (a task for a named agent to pick up) |
| `routine_trigger_id` | The routine's API trigger ID (not secret; the token is) |
| `triggers` | Any of: `manual`; `schedule` (documentation only: schedules live on the routine itself); `event` with a matcher (see 3C) |
| `inputs` | Named inputs with descriptions and whether required |
| `requires_approval` | If true, every run needs an owner approval first |
| `output_thread` | Where results are posted (default `workflow-<name>`) |
| `max_runs_per_day` | Cap, default 10 |
| `allow_chaining` | Whether a run of this workflow may trigger other workflows (default false) |

The body holds the instructions the runner follows, written like a prompt. Add a `workflow` template to `memory_templates`.

**3B. Dispatch: `workflow_run` and `workflow_status`**

`workflow_run(name, inputs)`:

1. Loads the workflow; refuses if disabled, not human-reviewed, over its daily cap, or missing required inputs.
2. If `requires_approval` and the caller is not `human:`, requires an approved `approval_id` for action `workflow_run` on resource `workflow:<name>`.
3. Creates a task (`type: Task`, `kind: workflow-run`, `assignee` = the runner, `state: todo`, inputs in frontmatter, `thread` = the output thread, `chain_depth` = the caller's depth plus one).
4. For `routine:` runners, fires the routine's API trigger: `POST https://api.anthropic.com/v1/claude_code/routines/<trigger_id>/fire` with `Authorization: Bearer <routine token>`, the headers the routines documentation lists (secondary sources show `anthropic-beta: experimental-cc-routine-2026-04-01` and `anthropic-version: 2023-06-01`), and a payload carrying the task ID. **Check the current documentation for the exact headers and the payload field name before building**; the feature is in preview and the beta header may change.
5. Stores the returned session ID and session URL on the task, and posts "started" to the output thread with the link.

For `agent:` runners, step 4 is skipped: the task waits to be claimed.

`workflow_status(run_id)` returns the task's state, the session link, and the last messages on its thread. `workflow_list` lists enabled workflows with their triggers.

New secret: `ROUTINE_TOKENS`, a JSON map of trigger ID to that routine's bearer token. Routine tokens never appear in workflow files.

**3C. Event triggers**

The Worker matches events against enabled workflows with `event` triggers:

| Source | Matcher fields |
|---|---|
| `capture` | `tag` (for example `auto`), optional `kind` |
| `trello` | `event` (for example `updateCard`), `list_after` (the list a card moved into), optional `board` |
| `task` | `kind`, `tag` |
| `board` | `thread`, `tag` (use sparingly) |

Loop and cost guards: no event-triggered run when the triggering item was itself created by a workflow run, unless that workflow has `allow_chaining: true`; `chain_depth` capped at 2; per-workflow daily cap; the account-wide routine caps below.

**3D. Briefs and reviews**

`brain_brief(scope: "today" | "week")` returns everything a brief needs in one call, so the routine stays cheap:

- **today**: agenda (tasks due or scheduled today, overdue tasks), reminders due today, unread mentions, captures waiting, pending approvals, workflow runs that failed or are stuck, stale concepts and open sweep proposals (counts from the latest sweep), any usage meter above 70%, backup status.
- **week**: tasks completed and slipped, captures added and resolved, concepts created or changed (from `log.md`), stale and unverified concepts, usage by agent, lint summary.

Two routines, configured in claude.ai (not code), with their prompts kept in the library as `library/prompts/morning-brief.md` and `library/prompts/weekly-review.md`:

- **Morning brief**, 8:00 AM Monday to Friday (owner's local time; routine schedules are entered in local time and the "weekdays" preset covers Monday to Friday): call `brain_brief("today")`, write a short plan for the day, post it to `owner`, and send it with `notify_owner`. The existing morning brief skill can read from `brain_brief` instead of gathering the data itself.
- **Weekly review**, Fridays: call `brain_brief("week")`, triage every capture with `capture_resolve`, propose next week's priorities as tasks in `review` state for the owner to accept, and post the summary.

**3E. How routines reach the brain**

Routines include the claude.ai account's connectors by default, not servers added locally with `claude mcp add`; a committed `.mcp.json` in the routine's repository is the other way in. Two options:

1. **Use the claude.ai connector.** Simplest. Every routine then acts as `claude-ai/web`, so the board cannot tell routines apart from you in the browser.
2. **Recommended: a small private repository** (for example `brain-routines`) holding a `.mcp.json` that points at the brain with `Authorization: Bearer ${TALK_BOARD_TOKEN}`, and the routine prompts. Put a dedicated token per routine in the routine's environment, mapped in `AGENT_TOKENS` to `routine/morning-brief`, `routine/weekly-review` and so on. Each routine then has its own actor, its own daily limits and its own revocable token. Remove the claude.ai connector from those routines. **Unverified:** that routine environments expand `${VAR}` in `.mcp.json`; test in Phase 0 style before relying on it.

Routine limits (secondary sources, research preview): minimum interval of one hour for recurring schedules; about 100 scheduled runs per hour per account; about 30 run-now or API fires per hour per routine and 100 API fires per hour per account; a daily run cap per account shown at claude.ai/code/routines. Routines run with no approval prompts during a run, act as your account, and push code only to `claude/`-prefixed branches.

Done when (whole phase): saying "run the month-end prep workflow" from the phone starts a routine whose session link appears on the board, the routine claims and completes its task, a Trello card moved into a trigger list starts its workflow exactly once, a chained trigger beyond depth 2 is refused, and the morning brief arrives on a weekday.

**3F. Weekly and monthly AI sweeps**

The nightly sweep finds problems; these sweeps go back over what has been collected and propose fixes. They run as routines with their own token (`routine/sweep`), their own daily limits, and the same guardrails as any workflow.

**Proposals, not edits** (built in Phase 1E). The sweeps never change concepts directly. Each suggested change is a proposal at `memory/proposed/<YYYY-MM-DD>-<8 hex>.md` (`type: Proposal`, `state: open`) recording:

| Field | Meaning |
|---|---|
| `action` | `create`, `update`, `merge`, `deprecate`, `refresh`, `archive-thread`, `verify` |
| `targets` | The concept paths or thread it concerns |
| `evidence` | Links to the board messages, sources or search results that justify it |
| `draft` | The proposed new content, for `create`, `update`, `merge` and `refresh` |
| `confidence` | `high`, `medium`, `low`, as judged by the sweep |

The owner accepts or rejects proposals in the dashboard (or through the owner CLI until Phase 6B exists). Accepting applies the change through the normal tools, so history, the log, the index and search all update, and approvals still apply to protected paths. Rejecting keeps the proposal with the reason, so the sweep does not propose the same thing again. `memory/proposed/` is writable by agents and is not a protected path; nothing in it is followed as an instruction.

Tools (from 1E): `proposal_list` (open proposals by action and confidence), `proposal_create` (used by sweeps, imports and `propose` tokens), `proposal_decide` (owner only: accept or reject with a note).

**Weekly sweep** (Sunday evening, before the Monday 8:00 AM brief so its results are in it):

1. **Harvest the week's conversations.** Read only threads with messages since that thread's last-swept marker (kept in the scheduler). Propose `create` for decisions, lessons and facts that are not in memory yet, each linked to the messages they came from.
2. **Refresh what is stale and still used.** Take the top stale concepts by recent reads (default 15 per run). For each, check it against its sources: the live integration (for example the knowledgebase article behind a `trainwel:` summary), the newest board messages and tasks on the topic, and newer concepts found by `search`. Propose `refresh` with updated content and a new `stale_after`, or `verify` when it is still correct, or `deprecate` when it no longer applies.
3. **Merge duplicates.** Search for concepts with near-identical titles or overlapping content; propose `merge` with a combined draft and a `superseded_by` for the others.
4. **Flag contradictions.** Where two concepts state different facts about the same thing, propose `update` for the one the evidence says is wrong, at `low` confidence if unsure, so the owner decides.
5. **Clear the inbox.** Captures still untriaged after the Friday review get a proposed outcome.
6. **Close loose ends.** Propose closing handoffs and tasks abandoned for more than 14 days.
7. **Post a summary** to the `review` thread and update the last-swept markers.

**Monthly sweep** (first Monday of the month, early morning):

- Full `bundle_lint`, with proposals for each fixable finding.
- Concepts unused for 180 days: propose `deprecate` or `verify`.
- Library items never fetched in 90 days: propose `deprecate`.
- Integration files: confirm each `access`, `credentials_location` and `allowed_actors` still matches reality; propose updates.
- Threads quiet for 30 days: propose `archive-thread` with a summary concept (Phase 5 archiving).
- Reminders for token rotation, the backup restore drill and reviewing daily limits against `usage_stats`.

**Where the sweeps run.** All of them run in the cloud, with no machine of the owner's switched on:

| Sweep | Runs on | Schedule |
|---|---|---|
| Nightly mechanical | The Cloudflare Worker's scheduler Durable Object alarm | 02:00 Central daily, set by the scheduler itself |
| Weekly AI | A Claude Code Routine in Anthropic's cloud | Sunday evening; use the weekly preset if it lets you pick the day, otherwise a custom cron expression set with `/schedule update` |
| Monthly AI | A Claude Code Routine | First Monday of the month. Standard cron treats day-of-month and day-of-week as "either", so `1-7` plus `Monday` would fire on every Monday too. Use a weekly Monday trigger and have the prompt stop at once unless the date is the 1st to the 7th, or run it on the 1st of the month instead. |

The routines reach the brain at its public Cloudflare URL with their own token (3E). Their refresh step can only check sources the routine can reach: claude.ai connectors or servers in its `.mcp.json`.

Routines count against the account's daily run cap and are in research preview; the weekly and monthly sweeps use four or five runs a month.

**Cost and safety bounds.** Each run reads only what changed since its last run, with caps (default: 200 board messages, 40 concepts, 15 refresh checks per weekly run). Proposals per run are capped (default 30) so the review queue stays manageable. The sweep uses search snippets before full reads. It never deletes, never writes protected paths, and never follows instructions found in what it reads.

Done when: a decision made in a board thread during the week appears as a `create` proposal linked to the message; a stale knowledgebase summary gets a `refresh` proposal with content matching the current article; two duplicate concepts get one `merge` proposal; accepting a proposal applies it with history and a log entry; a rejected proposal is not raised again; the Monday brief shows the sweep's counts.

### Phase 4: Review, limits, hardening

| Item | Specification |
|---|---|
| `review_queue` | Computed when read: open sweep proposals, stale and due concepts from the latest sweep report, captures waiting for triage, failed or stuck workflow runs, tasks in `review`, pending approvals, violations on `actions`, concepts that are unverified or past `stale_after`, drafts in `library/proposed/`, the latest lint findings. Owner-facing. |
| Per-minute rate limit | Workers Rate Limiting binding (`ratelimits` in `wrangler.jsonc`, window of 10 or 60 seconds), keyed by actor, checked before the daily budget. Stops loops and two agents replying to each other endlessly. |
| Idempotency keys | Optional `idempotency_key` on `board_post`, `brain_capture`, `task_create`, `workflow_run`, `handoff_create`, `approval_request`, `reminder_set`, `notify_owner`. Store key and result in a scheduler table for 24 hours; a repeat returns the first result. |
| Read caps | `board_read` default 10 with a per-message character cap and a `full` flag; `memory_read` with `max_chars`; `memory_list` pagination; `brain_guide` lists only threads active in the last 14 days plus a count. |
| Read-only tokens | Let an `AGENT_TOKENS` value be either an actor string or `{"actor": "...", "scope": "read"}`. Read scope rejects every tool in `WRITE_TOOLS`. |
| Sensitivity hardening | Extend the credential scan patterns; add an optional scan for patterns that look like Social Security and bank account numbers; apply `sensitivity` to tasks and handoffs. |
| Housekeeping | Delete `exports/` objects after 24 hours and `hooks/trello/` markers after 30 days from the scheduler alarm. |
| Password pages | Count failed attempts per approval and per hour in the scheduler; refuse after a threshold. |
| `WRITE_TOOLS` accuracy | `reminder_list`, `handoff_resume` and `backup_status` count as writes even when only listing. Split read and write paths. |

### Phase 5: Compaction, ingestion, recovery

| Item | Specification |
|---|---|
| Thread archiving | `board/` is locked, so archiving never deletes. `thread_archive(thread, summary_path)` writes a summary concept to memory and records the thread as archived in a `threads/<thread>.json` state file. `board_list_threads` hides archived threads; `board_read` on one returns the pointer to the summary. Archived messages stay in the search index. |
| Cheaper reads on long threads | Without `since`, list only the last 30 days by using `startAfter` with a date, and widen if too few messages come back. |
| Knowledgebase sync | A `process:kb-sync` job in the scheduler alarm writes curated summaries with `resource: trainwel:article/<id>`, `sources`, and `stale_after`, in small batches. Needs the knowledgebase's API or connector details first. The knowledgebase is Trainwel, which has an API; the Trainwel/Humanagement MCP server already in progress is the connector. |
| File storage | As in 4.6: `files/` prefix and lock rule, `type: File` concepts, owner CLI upload, `file_get` with signed links, weekly copy to a second bucket. Build before Phase 6B so the dashboard upload has a backend. |
| Restore from GitHub | `scripts/restore-from-github.mjs`: clone the backup repository and upload each file with `wrangler r2 object put`, skipping locked prefixes that already hold the object. Document a full rebuild drill. |
| Backup coverage | Add `tasks/` and scheduler tables (reminders exported as JSON) to the backup. The search index is rebuilt with `search_reindex`, not backed up. |

### Phase 6: Command center UI (dashboard)

A visual overview of the whole brain in the browser, on desktop and phone, served by the same Worker. It is the owner's own channel: actions taken here are the owner's, which also replaces most uses of the owner CLI (0.3).

**Build order.** Split in two so a useful view exists early:

- **6A, read-only.** Can be built any time after Phase 1. Needs only existing data.
- **6B, actions.** After Phase 3, once tasks, captures and workflows exist.

**Views**

| View | Shows | Actions (6B) |
|---|---|---|
| **Today** (home) | A compact usage strip (the three meters closest to their limits) at the top, then the `brain_brief("today")` content, including counts of stale concepts and open proposals: agenda, overdue tasks, reminders due, unread mentions, captures waiting, pending approvals, failed or stuck workflow runs, backup status | Jump to any item |
| **Workflows** | Every workflow with trigger types, enabled state, runs today against the cap; recent runs with state, duration, session link and output thread | Run with inputs, enable or disable |
| **Tasks** | Board by state (`todo`, `claimed`, `in_progress`, `blocked`, `review`, `done`), filters for assignee, tag, due date; agenda calendar for the week | Create, reassign, change state, accept or reject `review` items |
| **Captures** | Inbox of new captures by kind | Resolve to concept, task, reminder, merged or discard |
| **Board** | Threads with activity and unread counts; message view | Post as owner |
| **Memory** | Folder tree from `index.md`, search box, concept view with trust tier, status, staleness, sources and links; version list with side-by-side differences | Verify, deprecate, restore a version, edit protected files |
| **Approvals** | Pending, recent decisions, expiry | Approve or deny (no separate password page needed while signed in) |
| **Activity** | Everything that went into the brain, newest first, each with its agent, kind and one-line `why`, filterable by agent and kind; session summaries grouped | Open, redact (owner), turn into a proposal for correction |
| **Freshness** | Concepts by state (fresh, due, stale), most-read stale items first, unused concepts, last sweep report | Verify, open the concept, schedule a refresh |
| **Proposals** | Open sweep proposals with action, confidence, evidence links and a side-by-side view of current and proposed content | Accept or reject with a note |
| **Agents** | Registry, last seen, protocol version loaded, write mode, calls and writes today against limits, violations, and quality: share of writes verified or accepted versus rejected, deprecated, merged away or redacted | Change a token's write mode; disable a token (marks it blocked in the scheduler until re-enabled) |
| **Library** | Prompts, skills, workflows, proposed drafts with trust tier | Promote and verify drafts |
| **Usage** | One meter per allowance in 8.1: used, allowance, percentage, reset time in Central, and a month-end forecast for R2; colour bands at 70% and 90%; storage split by prefix (memory, board, history, trash, files, exports); a 30-day trend per meter; per-agent usage; when the hourly Cloudflare figures last updated | Pause or resume non-essential work; open the agent behind a spike |
| **Operations** | Backup history, lint findings, integrations, error summary from the nightly sweep | Run backup, run lint, rebuild search index |

**Technical design**

- **Hosting: the same Worker, using Workers Static Assets, not Cloudflare Pages.** Cloudflare recommends Workers over Pages for new projects and is putting new development into Workers. The UI's files (HTML, CSS, JavaScript; no third-party scripts or fonts) live in a `dashboard/` folder declared as `assets` in `wrangler.jsonc` and deploy with the same `wrangler deploy`.
- **Same origin:** the UI and its API share the Worker's address, so the session cookie can be `SameSite=Strict`, there is no cross-origin setup, and there is one deploy, one set of secrets and one place to look.
- **Routes:** `/dashboard/` serves the UI shell from static assets; `/dashboard/api/*` is handled by the Worker and serves JSON. Both are separate from `/mcp`, and the API never accepts agent bearer tokens.
- **The page itself is behind the login.** By default, static assets are served before the Worker runs, which would let anyone load the empty page. Set `"run_worker_first": ["/dashboard/*"]` in the `assets` block so every dashboard request, page files included, goes through the Worker first. Without a valid owner session the Worker returns the sign-in page (`/dashboard/login`, served by the Worker, not from assets) and nothing else; with one, it hands the request to the assets binding. Cost: each page load becomes a few Worker requests (the HTML, script and stylesheet), a few hundred a day at most against the 100,000 allowance. On the free plan, requests that run the Worker first get a 429 once the daily limit is reached, so the dashboard is unavailable on a day the limit is hit, which the usage guards (8.3) are meant to prevent.
- **Second layer, still holding no data in the shell.** The page files contain no data or secrets; everything comes from `/dashboard/api/*`, which checks the session on every request. Never put anything private in the `dashboard/` folder.
- **Cloudflare Access in front (decided, 0.27).** A path-based Access application covers `/dashboard/*`, so unauthenticated requests are stopped at Cloudflare's edge and never reach the Worker. See the Access item below.
- **Headers:** a `_headers` file in `dashboard/` sets the content security policy and other headers for the assets; the Worker sets the same headers on API responses.
- **Shared logic:** the JSON endpoints call the same internal functions as the MCP tools. Phase 0.14 (splitting `index.ts` into modules) should pull tool logic into plain service functions to make this possible.
- **Sign-in:** the owner password, then a session cookie: random session ID stored in the scheduler, `HttpOnly`, `Secure`, `SameSite=Strict`, expiring after 12 hours. Failed attempts counted and locked out after a threshold (shares the Phase 4 password-page counter).
- **Cloudflare Access, configured as in 0.27.** It covers only `/dashboard/*` and `/approve/*`, never `/mcp`, `/oauth/*`, `/.well-known/*` or `/hooks/*`, which Claude's cloud, routines, other agents and Trello call without a browser.
- **Requests that change things:** POST only, with a per-session token checked on every request, so another site cannot trigger actions.
- **Header values:** a strict content security policy (no external sources), `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`; `Cache-Control: no-store` on API responses.
- **Freshness:** the page polls every 30 seconds while visible. No WebSockets, so the Worker stays stateless.
- **Layout:** responsive, so the Today view works on the phone; light and dark themes following the device setting.
- **Owner actor:** actions are recorded as the configured owner actor (Phase 0.1), not as `claude-ai/web` or any agent.
- **Cost:** page loads are a few Worker requests each (behind the login). Polls read only cached state from the scheduler Durable Object (never R2 listings), and pause while the tab is hidden. At one open tab, a working day of polling is roughly 1,000 Worker requests and 1,000 Durable Object requests, about 1% of each daily allowance.

Done when (6A): signing in on the phone shows today's brief, the workflow run list and the review queue, refreshing on its own; an agent token gets 401 on every `/dashboard` route.

Done when (6B): every action in the table above works from the page, each one appears in `log.md` or the board as the owner, a request without the session token is refused, and five wrong passwords lock sign-in for the configured period.

---

## 12. Design decisions and why

| Decision | Reason |
|---|---|
| R2, not KV | KV allows 1,000 writes per day on the free plan; R2 allows a million Class A operations a month, and its objects are real files |
| One file per board message | Concurrent agents can never overwrite each other |
| Etag-conditional writes for memory | A stale write fails with a conflict instead of clobbering |
| OKF v0.2 for memory | It is a directory of Markdown with frontmatter, which is what was already being stored, and it makes the bundle portable to other OKF tools |
| Board outside the bundle | OKF requires every Markdown file to be a typed concept; chat messages are not knowledge |
| Stateless `createMcpHandler` | Cloudflare's current path; no idle Durable Object per session |
| Live query for outside systems | Matches the existing shared-brain design; avoids stale copies and keeps sensitive data where it is |
| Durable Object alarm instead of cron | Cron triggers are exhausted on the account; alarms are not counted against that limit |
| Approvals on a password page | Agents must not be able to approve themselves, and a `human:` token in an MCP client would be an agent holding it |
| Bucket locks plus GitHub | Locks stop destruction from inside; GitHub survives loss of the account |
| History in R2, not only Git | Restores work instantly through a tool, without leaving the agent session |
| Library inside the bundle | Reuses history, approvals, lint, export and backup |
| New Cloudflare account | Isolated limits, billing, blast radius and records |
| Search and capture before tasks and automation | They are what make the brain part of every day; automation is only useful once the brain holds real work |
| Captures as draft concepts in `memory/inbox/` | Zero-structure input, but still versioned, searchable, backed up and triaged into proper concepts |
| `mentions_read`, not `inbox_read` | Keeps "inbox" meaning captures only |
| Claude Code Routines as the cloud runner | Scheduled, API and GitHub triggers with no machine running and no cron trigger on the Cloudflare account |
| The brain dispatches, runners execute | Keeps the Worker small and stateless; work happens where the tools and permissions are |
| Guards stop R2 growth before it is billed | R2 is the only product in use that bills over its allowance; everything else fails instead |
| The dashboard reads cached state, never R2 listings | Lists are Class A operations; polling them would be the easiest way to burn the monthly allowance |
| Write modes per token | Live, supervised agents write directly with receipts; unattended agents propose; confirmed knowledge can only change with the owner's acceptance |
| A required `why` on writes | Makes the activity feed readable at a glance and discourages low-value writes |
| Notifications filtered by level | Every write on the phone would be noise; the feed shows everything anyway |
| A staging instance before production | Bucket locks make production mistakes permanent for the lock period |
| Binary files in R2 under `files/`, not Google Drive | The brain's protections only cover what it stores; Drive is not in use, and adopting it would add a second permission system and a service account just to detect changes |
| Redact first, purge later | Locks protect against destruction, so removal is hide-now, delete-when-allowed, with a documented emergency path |
| Sweeps propose, the owner decides | An AI pass that rewrote memory on its own could spread a mistake everywhere; proposals keep every change reviewable and reversible |
| Nightly sweep is mechanical, weekly sweep is AI | The nightly checks are cheap and certain; reading and judging content costs model usage, so it runs weekly on only what changed |
| Defaults for review periods by type | Most concepts will be written without `stale_after`; a default means nothing is exempt from freshness checks |
| Dashboard on Workers Static Assets in the same Worker, not Pages | Cloudflare's recommended path for new projects; same origin as its API; one deploy |
| Cloudflare Access on owner pages only, path-based | Stops unauthenticated traffic at the edge, adds the firm's Google sign-in and its two-factor, and keeps attack traffic off the daily request allowance; whole-Worker protection would cut off every machine client |
| Dashboard page behind the login, not just its data | Nothing about the brain, not even its layout, is visible without the owner session; the cost is a few Worker requests per page load |
| Dashboard served by the same Worker, read-only part first | No new hosting or account; a useful overview early; the owner gets a channel that no agent token can use |

---

## 13. Known gaps and unverified items

Code-level:

- `memory_move` is several steps, not one transaction. A failure midway can leave some links rewritten; everything is recoverable from history.
- `index.md` regeneration can be briefly stale when two writes land in the same folder at once. `memory_index` with `rebuild: true` fixes it.
- `log.md` updates retry five times, then the write succeeds with a warning.
- The usage gate fails open if the scheduler is unreachable, so the board stays up but limits are not enforced during that window.
- Rejected calls still count toward the daily totals.
- Every OAuth client acts as `claude-ai/web`, whichever client it is.
- `brain_guide` performs four existence checks on every call to see whether defaults need seeding.
- `exports/` and `hooks/trello/` objects are never cleaned up (Phase 4).

Unverified:

- R2 activation needing a payment method (secondary sources only).
- Wrangler creating the KV namespace when no ID is given.
- Which clients pass MCP server instructions to the model.
- Claude Code deferring tool definitions for HTTP servers (an open bug report says it did not as of v2.1.86).
- Durable Object alarm CPU limits on the Free plan.
- R2 custom metadata size limits (fields are clipped conservatively).
- Real GitHub behaviour for large trees and deletions.
- Hook equivalents in Codex, Hermes and OpenClaw.
- FTS5 in Durable Object SQLite, and the free storage allowance for the search index.
- The exact routine API trigger headers and payload field (preview feature).
- Whether routine environments expand `${VAR}` in a committed `.mcp.json`.
- Removing an R2 bucket lock rule and deleting objects it covered (break-glass removal).
- Free-tier room for files plus their weekly copy, as file storage grows (now metered by 0.26).
- GraphQL Analytics dataset names for Durable Objects and KV.
- Grant revocation API details in the OAuth provider library.

Open questions for the owner:

- None blocking. First workflows are chosen after the brain is in use.

Answered:

- Morning brief: 8:00 AM, Monday to Friday.
- First workflows: decided after the brain is built and in use.
- Claude Code on the web, needed for Routines: enabled on the firm's plan.

- Default review periods in 1C: confirmed by the owner.
- Cloudflare: a new account for this project, with its cron triggers available if needed.
- Staging instance, instance identity, versioning and monitoring: approved.
- Time zone: US Central (`America/Chicago`).
- Seeding: every connector, project, note and SOP, as in 1D.
- Firm sign-off for the Approved AI Tools List and WISP: owner says no action needed.
- Files that are not text: stored in R2 under `files/` (4.6). Google Drive is not in use; files already elsewhere are referenced by pointer.
- Bucket lock length: 90 days.
- Address: the free `workers.dev` address.
- Account ownership: a firm-controlled email for the Cloudflare account and the GitHub repositories.
- Continuity: a sealed copy of the owner password, the Cloudflare and GitHub logins and their recovery codes in the firm's password manager, available to the managing partner.
- Notifications: Google Chat, through an incoming webhook to a private space.
- Trello events: through the Worker's webhook, with Phase 3C event triggers dispatching routines (9.10).
- Knowledgebase: Trainwel, which has an API; seeded as `integrations/trainwel.md` with prefix `trainwel`.
- Daily limits: 3,000 calls and 500 writes per agent to start.
- Owner actor: `human:luke`.
- Source code: a private GitHub repository under the firm-controlled account, separate from the backup repository.
- Development machine: Windows with Node 18 or later and Git; tests run in GitHub Actions.


---

## 14. Working on this in Claude Code

- Read `CLAUDE.md` first. It carries the commands and the rules below in short form.
- Run `bash tests/smoke.sh` before and after every change. Add a check for every new behaviour.
- Register every tool through the `register` wrapper inside `createServer`, never `server.registerTool` directly, so the usage gate applies.
- Add every tool that writes to `WRITE_TOOLS`.
- Scan free-text inputs with `looksLikeSecret`.
- Snapshot to `history/` before changing any bundle file.
- Never write code that overwrites or deletes under `board/`, `history/` or `trash/`. Bucket locks will reject it in production even if local tests pass.
- Workflow state goes in `state`, never `status`.
- Keep `PROTOCOL_BODY`, the tool descriptions and this document in step with the code.
- Local tests reach a mock on `127.0.0.1`; the test script patches a copy of the source to allow that. Do not weaken the `https://` check in the real source.
- Do not put real tokens in `.dev.vars.example`, tests or commits.
- Build in phase order: 0, then 1 (search and capture), 2, 3, 4, 5, 6. Finish and verify one numbered item before starting the next.
- Every new write path must also update the search index once Phase 1A exists.
- Deploy to staging first (`deploy:staging`), check, then production.
- Use `OWNER_TIMEZONE` for every owner-facing date and time; store timestamps with offsets.
- Every new read path must respect the redaction list (0.22).
- Every server-written file carries `schema_version`.
- Every write tool requires a meaningful `why` once 0.23 exists.
- Writes from `propose` tokens, and non-owner overwrites of human-reviewed concepts, become proposals.
- Sweeps and other automated passes write proposals to `memory/proposed/`, never directly to concepts.
- Never let a workflow execute text from a task, capture or board message as a command; runners act only on allowlisted actions defined in owner-verified workflow files.

---

## 15. Sources

Cloudflare

- Plans and free-tier allowances: https://www.cloudflare.com/plans
- Workers limits (requests, CPU, subrequests, cron triggers): https://developers.cloudflare.com/workers/platform/limits/
- Stateless MCP handler, `McpAgent` deprecation: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- OAuth provider library: https://github.com/cloudflare/workers-oauth-provider/
- Durable Objects on the Free plan: https://developers.cloudflare.com/durable-objects/release-notes/
- Durable Objects pricing, free limits, daily reset at 00:00 UTC, failure on overrun: https://developers.cloudflare.com/durable-objects/platform/pricing
- R2 pricing and free tier: https://developers.cloudflare.com/r2/pricing/
- KV free tier (secondary summary of Cloudflare's plans page): https://grape.westus.cloudapp.azure.com/plans/.md
- R2 metrics through the GraphQL Analytics API: https://developers.cloudflare.com/r2/reference/metrics-analytics
- Workers recommended over Pages for new projects, static asset requests free: https://cloudflare-docs.justalittlebyte.ovh/workers/static-assets/migrate-from-pages/ (mirror of Cloudflare's migration guide)
- Cloudflare Access for Workers (hostname and path applications, whole-Worker protection, local testing): https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Static assets billing and `run_worker_first` on the free plan: https://docs-durable-objects-instance-replaced-errors.previews.developers.cloudflare.com/workers/static-assets/billing-and-limitations/index.md (Cloudflare docs preview)
- GraphQL Analytics token permission (secondary): https://www.listendata.com/2026/05/automate-cloudflare-usage-monitoring.html
- Rate Limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- R2 bucket locks: https://developers.cloudflare.com/r2/buckets/bucket-locks/
- R2 payment method (secondary): https://tech-insider.org/how-to-set-up-cloudflare-r2-2026/
- R2 billing with no hard cap (secondary): https://upstash.com/kb/cloudflare-r2-pricing-in-2026-storage-operations-and-real-monthly-bills

Open Knowledge Format

- Specification v0.2: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md

Claude

- Custom connectors, plan differences, authentication choices: https://claude.com/docs/connectors/custom
- Connector authentication and request headers: https://claude.com/docs/connectors/building/authentication.md
- Connectors on Team and Enterprise, per-user authentication: https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities
- How Claude suggests connected apps: https://support.claude.com/en/articles/14730684-how-claude-suggests-connected-apps
- Using connectors per conversation, Claude Code loading browser connectors: https://claude.com/docs/connectors
- Claude Code MCP scopes: https://code.claude.com/docs/en/mcp-quickstart
- Claude Code hooks: https://docs.anthropic.com/de/docs/claude-code/hooks
- Tool search deferral report: https://github.com/anthropics/claude-code/issues/40314
- Claude Code skills folders (secondary): https://www.mdskills.ai/learn/how-to-create-a-claude-code-skill

- Claude Code Routines: https://code.claude.com/docs/en/web-scheduled-tasks.md
- Routine triggers and API fire endpoint (secondary): https://www.verdent.ai/de/guides/what-is-claude-code-routines
- Routine limits and connectors (secondary): https://agentsroom.dev/blog/claude-code-routines-cloud-vs-local-scheduled-tasks
- Routine schedule details (secondary): https://wmedia.es/en/tips/claude-code-routines-cloud-agents
- Custom connectors connect from Anthropic's cloud (secondary): https://help.boomi.com/docs/Atomsphere/Connect/MCPSetup/Connect_claude_setup

Other agents

- Codex MCP configuration: https://developers.openai.com/codex/mcp
- Codex bearer token note: https://docs.litellm.ai/docs/proxy/client_setup/codex_cli
- Hermes MCP configuration: https://docs.browserless.io/mcp/clients/hermes-agent
- OpenClaw transports: https://docs.openclaw.ai/cli/mcp/transports
- OpenClaw advisory CVE-2026-53840: https://corgea.com/advisories/vulnerabilities/CVE-2026-53840

Integrations

- Trello webhook signatures and creation check: https://hookdeck.com/webhooks/platforms/guide-to-trello-webhooks-features-and-best-practices
- GitHub Git trees API: https://docs.github.com/en/enterprise-server@3.4/rest/git/trees
- GitHub rulesets: https://learn.microsoft.com/en-us/training/modules/manage-sensitive-data-security-policies/3-scrub-sensitive-data-from-repository

Google

- Gmail blocked file types and Drive sharing: https://support.google.com/mail/answer/6590
- Google Chat incoming webhooks: https://developers.google.com/workspace/chat/quickstart/webhooks
