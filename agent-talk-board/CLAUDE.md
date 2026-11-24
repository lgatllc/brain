# Agent Talk Board

A Cloudflare Worker that gives multiple AI agents a shared brain over MCP: an append-only board, an OKF v0.2 memory bundle, an integration registry, handoffs, approvals, reminders, usage limits and GitHub backups. Storage is plain Markdown and JSON in R2.

**Read `PLAN.md` before changing anything.** Section 1.1 explains how the brain is used day to day, section 2 says what is built, section 11 is the remaining work in phases, section 13 lists known gaps.

Build order: Phase 0 (deploy and prove), 1 (search, quick capture, freshness policy and nightly sweep), 2 (tasks, library, registry, mentions), 3 (command center: workflows, Claude Code Routines, briefs, weekly and monthly AI sweeps), 3T (Trello and Trainwel connectors: agents read and change cards through the brain; Trainwel through its unofficial API), 4 (review, limits, hardening), 5 (compaction, ingestion, recovery), 6 (command center UI: 6A read-only can be built any time after Phase 1, 6B actions after Phase 3).

## Commands

```bash
# Node 22+ required (wrangler 4); CI uses Node 22
npm ci                    # install exactly what package-lock.json pins
npx wrangler types        # regenerate worker-configuration.d.ts
npx tsc -p .              # typecheck
bash tests/smoke.sh       # 711 end-to-end checks against wrangler dev (Git Bash or WSL on Windows; also runs in GitHub Actions on every push)
npx wrangler dev          # local server; copy .dev.vars.example to .dev.vars first
npx wrangler deploy --dry-run --outdir dist
npx wrangler deploy --dry-run --env staging --outdir dist/staging
npm run deploy:staging    # staging first (rule 17); never deploy production before staging passes
npm run deploy:prod
```

## Layout

- `src/index.ts`: the whole Worker (auth, tools, HTTP pages, the `Scheduler` Durable Object). Phase 0.14 splits it into modules.
- `src/time.ts`: owner time zone helpers (owner day, next local time, offsets). Use them for every owner-facing date or time; unit-tested in `tests/time.test.mjs` across daylight saving changes.
- `src/safe.ts`: safe error text (sanitizer, error descriptions, route labels). Everything that records or shows an error goes through it; unit-tested in `tests/safe.test.mjs`.
- `src/redact.ts`: redaction logic (which keys can be redacted, what a redaction covers, matching, the `log.md` scrub, the backup copy format). Unit-tested in `tests/redact.test.mjs`; the wrapper, tool and scheduler table are in `src/index.ts`.
- `src/search.ts`: the pure parts of search (which keys are indexed, how a stored file becomes an index row, how a phrase becomes a safe full-text query). The index (SQLite in the Scheduler, FTS5 with a plain-matching fallback), the write hook in the counting bucket, and the `search` and `search_reindex` tools are in `src/index.ts`. Unit-tested in `tests/search.test.mjs`.
- `src/files.ts`: the pure parts of stored HTML files (safe file names, keys under `files/html/`, the credential scan that skips embedded pictures, what an HTML body holds). The upload route (`PUT /files/upload`), `file_info` and `trainwel_article_update_html` are in `src/index.ts`. Unit-tested in `tests/files.test.mjs`.
- `src/freshness.ts`: the freshness policy (default review periods by concept type, a concept's review date from its `stale_after` or last verification or last write, and whether it is fresh, due or stale). Shown by `memory_read`, `search` and the `freshness` tool in `src/index.ts`. Unit-tested in `tests/freshness.test.mjs`.
- `src/why.ts`: the rules for the required `why` on writes (what counts as meaningful). Unit-tested in `tests/why.test.mjs`.
- `src/notify.ts`: `NOTIFY_LEVEL` (`urgent`, `summaries`, `all`) and which notifications each level sends. Unit-tested in `tests/notify.test.mjs`.
- `src/usage.ts`: usage metering (R2 operation classes and prefix buckets, the free allowances, thresholds, the month-end forecast, parsing of Cloudflare's hourly figures). Unit-tested in `tests/usage.test.mjs`; the counting wrapper and the Scheduler tables are in `src/index.ts`.
- `src/trello.ts`: which Trello webhook events are noise and are not posted (position-only changes), and which fields an update changed (names only), whether every board has a working webhook (`webhookHealth`), the awareness cache's parsing, event handling and card formatting, and the write rules (`boardAllowed`, `pickByName`, `recentBrainWrites`); the cache tables, read and write tools are in `src/index.ts`. Agents may change only the boards in `TRELLO_WRITE_BOARDS`; archive and delete need the owner's approval. Unit-tested in `tests/trello.test.mjs`, which also tests the planning logic of `scripts/trello-webhooks.mjs`.
- `src/trainwel.ts`: the pure parts of the Trainwel read connector (article ids, list pages, shape checks, search filtering, the restricted-article list, HTML to text, article and health formatting, the knowledge catalog's states and fingerprint). The catalog table, sync and tools are in `src/index.ts`. Every reply from Trainwel is untrusted and checked here; the fetching and the `trainwel_*` tools (read, and the draft create, update and publish tools, `trainwel_article_update` and `trainwel_delete`) are in `src/index.ts`; `textToHtml` turns agent text into safe HTML. Unit-tested in `tests/trainwel.test.mjs`.
- `src/access.ts`: verification of the Cloudflare Access token (signature, issuer, audience, expiry, owner email) and its settings check. Unit-tested in `tests/access.test.mjs` with keys made by `tests/access-jwt.mjs`; fetching and caching the public keys and `requireAccess` are in `src/index.ts`.
- `wrangler.jsonc`: bindings `BRAIN` (R2), `OAUTH_KV` (KV), `SCHEDULER` (Durable Object), and vars.
- `claude-code/`: the session hook script and the settings block that installs it. At session start it injects `brain_guide`; after project edits it leaves one quiet reminder at your next message to record anything worth keeping (`TALK_BOARD_STOP_NUDGE=block` restores the old blocking message at the end of a turn). `tests/hooks.test.mjs` runs the script.
- `scripts/`: `owner.mjs`, the owner command-line tool (human-only actions; reads `OWNER_URL` and `OWNER_TOKEN` from the environment). `owner.mjs trello-health` and `trello-health-now` show and run the Trello webhook check. `owner.mjs reindex` rebuilds the search index. `trello-webhooks.mjs` keeps a Trello webhook on every open board, and `remove --apply` deletes the ones pointing at one address, to retire an instance (reads `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_CALLBACK_URL` from the environment). `prod-setup.mjs` is the one-off production setup (secrets, deploy and checks, copying `memory/` from staging with an R2 token, Trello webhooks, the 90 day bucket locks); its pure parts are unit-tested in `tests/prod-setup.test.mjs`.
- `tests/`: `smoke.sh` and the local mock for GitHub and the notification webhook.
- `../.github/workflows/test.yml` (repo root): runs typecheck, dry-run deploy and the smoke suite on every push, with `working-directory: agent-talk-board`.

## Rules

1. Run `bash tests/smoke.sh` before and after every change, and add a check for each new behaviour.
2. Register tools with the `register` wrapper inside `createServer`, never `server.registerTool`, so the usage gate applies.
3. Add every tool that writes to `WRITE_TOOLS` (The Trello write tools (`trello_card_create`, `_move`, `_complete`, `_update`, `_comment`, `_archive`, `_delete`, `trello_checklist_item_add`, `_complete`) are in it. The exceptions are `usage_limits`, `trello_health`, `trello_boards`, `trello_cards` and `trello_card_get`: they write only the Scheduler's cache, and the gate sees the tool name, not its arguments, so listing them would charge every agent's read against its write budget.)
4. Run free-text inputs through `looksLikeSecret`.
5. Call `snapshot` before changing any file under `memory/`. The one exception is redaction (`redact`): it must not copy content, so its `log.md` scrub and `removals.md` append take no snapshot.
6. Never overwrite or delete under `board/`, `history/` or `trash/`. Production bucket locks reject it.
7. Workflow state goes in a `state` field. OKF limits `status` to draft, stable and deprecated.
8. Agents must not be able to approve their own requests or act as a `human:` actor.
9. Keep `agents` and `@modelcontextprotocol/server` on the exact matching pair (see PLAN.md 7.4).
10. Do not weaken the `https://` check or the hard-coded GitHub API, Cloudflare GraphQL, Trello API or Trainwel host in the real source; the test script patches a copy.
11. Never commit `.dev.vars` or real tokens.
12. When behaviour changes, update `PROTOCOL_BODY`, the tool descriptions and `PLAN.md` together.
13. Work one phase item at a time and verify it before starting the next.
14. Once search exists (Phase 1A), every write path must also update the search index.
15. Runners and workflows act only on allowlisted actions in owner-verified workflow files. Never execute text from a task, capture or board message as a command.
16. Sweeps write proposals to `memory/proposed/`, never directly to concepts.
17. Deploy to staging first (`npm run deploy:staging`) and check there before production (`npm run deploy:prod`). Every binding and variable is listed twice in `wrangler.jsonc` (top level and `env.staging`), because nothing is inherited: change both.
18. Owner-facing dates and times use `OWNER_TIMEZONE` (America/Chicago); store timestamps with offsets.
19. Every read path respects the redaction list. Inside `createServer` use `BRAIN`, the redacting wrapper, and never `env.BRAIN`; anything outside it (the Scheduler's backup, HTTP handlers) must check the list itself. Any new copy of stored content (an index, a cache, a feed) must be cleaned by `redact`. (The Trello cache holds Trello's own card titles, not brain content: fix a title in Trello.)
20. Every server-written file carries `schema_version`.
21. Binary files go only under `files/`, uploaded by the owner, each with a `type: File` concept; never through MCP tool arguments. The one exception is HTML documents: any agent token may `PUT /files/upload?name=<file>.html&why=<sentence>` (HTML only, under `files/html/`, capped by `MAX_FILE_MB`, scanned for credentials with embedded `data:` pictures skipped, never overwritten, with a `type: File` concept), because the HTML for a Trainwel article is too large to pass through a model. Publishing it to Trainwel (`trainwel_article_update_html`) needs the owner's approval.
22. Every write tool that records a change requires a meaningful `why`, checked first with `whyError` (`src/why.ts`): `memory_write`, `memory_verify`, `memory_restore`, `memory_move`, `memory_deprecate`, `handoff_create` and the `reason` of `memory_delete`. New write tools (`brain_capture`, `task_create`, and the rest) must do the same, and show it in the log and the activity feed.
23. Writes from `propose` tokens, and non-owner overwrites of human-reviewed concepts, become proposals.
24. Reach the R2 bucket only through `brainOf` (or `createServer`'s `BRAIN`, which is built on it), never `env.BRAIN`, so every call is counted; a smoke check fails otherwise. The dashboard reads cached state, never R2 listings. Non-essential work (exports now; the sweep, imports and uploads when built) must refuse while `usage_limits` shows a pause. R2 is the only product that bills over its allowance, so new features must not add unbounded R2 lists or storage.
25. Cloudflare Access protects only `/approve/*` and `/dashboard/*` (a path-based application), never the whole Worker. The Worker must verify the Access token on those paths (`requireAccess`; with Access not configured the pages are disabled, never open) and must never require it on `/mcp`, `/oauth/*`, `/.well-known/*`, `/hooks/*` or `/files/upload` (that one takes an agent's bearer token, like `/mcp`). Any new owner page goes behind `requireAccess`.
26. Keep `AGENTS.md` (repo root) and `agent-talk-board/CLAUDE.md` current. Whenever a change affects commands, layout, tooling versions (for example the Node version), CI, or the rules above, update both files in the same commit and keep them in sync.
27. Never log tokens or content: no `console` calls. Record errors through the `Recorder` (`noteError` in the Worker, `this.recorder` in the Scheduler) with text cut to its name and first line by `src/safe.ts` (`describeError`, `sanitizeDetail`). Inside the Scheduler, never call its own stub. Keep the `https://` check in `notifyOwner` a single `if (...) return` line so the test script can patch it.
