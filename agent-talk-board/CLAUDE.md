# Agent Talk Board

A Cloudflare Worker that gives multiple AI agents a shared brain over MCP: an append-only board, an OKF v0.2 memory bundle, an integration registry, handoffs, approvals, reminders, usage limits and GitHub backups. Storage is plain Markdown and JSON in R2.

**Read `PLAN.md` before changing anything.** Section 1.1 explains how the brain is used day to day, section 2 says what is built, section 11 is the remaining work in phases, section 13 lists known gaps.

Build order: Phase 0 (deploy and prove), 1 (search, quick capture, freshness policy and nightly sweep), 2 (tasks, library, registry, mentions), 3 (command center: workflows, Claude Code Routines, briefs, weekly and monthly AI sweeps), 4 (review, limits, hardening), 5 (compaction, ingestion, recovery), 6 (command center UI: 6A read-only can be built any time after Phase 1, 6B actions after Phase 3).

## Commands

```bash
# Node 22+ required (wrangler 4); CI uses Node 22
npm ci                    # install exactly what package-lock.json pins
npx wrangler types        # regenerate worker-configuration.d.ts
npx tsc -p .              # typecheck
bash tests/smoke.sh       # 152 end-to-end checks against wrangler dev (Git Bash or WSL on Windows; also runs in GitHub Actions on every push)
npx wrangler dev          # local server; copy .dev.vars.example to .dev.vars first
npx wrangler deploy --dry-run --outdir dist
```

## Layout

- `src/index.ts`: the whole Worker (auth, tools, HTTP pages, the `Scheduler` Durable Object). Phase 0.14 splits it into modules.
- `src/time.ts`: owner time zone helpers (owner day, next local time, offsets). Use them for every owner-facing date or time; unit-tested in `tests/time.test.mjs` across daylight saving changes.
- `wrangler.jsonc`: bindings `BRAIN` (R2), `OAUTH_KV` (KV), `SCHEDULER` (Durable Object), and vars.
- `claude-code/`: the session hook script and the settings block that installs it.
- `scripts/`: `owner.mjs`, the owner command-line tool (human-only actions; reads `OWNER_URL` and `OWNER_TOKEN` from the environment).
- `tests/`: `smoke.sh` and the local mock for GitHub and the notification webhook.
- `../.github/workflows/test.yml` (repo root): runs typecheck, dry-run deploy and the smoke suite on every push, with `working-directory: agent-talk-board`.

## Rules

1. Run `bash tests/smoke.sh` before and after every change, and add a check for each new behaviour.
2. Register tools with the `register` wrapper inside `createServer`, never `server.registerTool`, so the usage gate applies.
3. Add every tool that writes to `WRITE_TOOLS`.
4. Run free-text inputs through `looksLikeSecret`.
5. Call `snapshot` before changing any file under `memory/`.
6. Never overwrite or delete under `board/`, `history/` or `trash/`. Production bucket locks reject it.
7. Workflow state goes in a `state` field. OKF limits `status` to draft, stable and deprecated.
8. Agents must not be able to approve their own requests or act as a `human:` actor.
9. Keep `agents` and `@modelcontextprotocol/server` on the exact matching pair (see PLAN.md 7.4).
10. Do not weaken the `https://` check or the hard-coded GitHub API host in the real source; the test script patches a copy.
11. Never commit `.dev.vars` or real tokens.
12. When behaviour changes, update `PROTOCOL_BODY`, the tool descriptions and `PLAN.md` together.
13. Work one phase item at a time and verify it before starting the next.
14. Once search exists (Phase 1A), every write path must also update the search index.
15. Runners and workflows act only on allowlisted actions in owner-verified workflow files. Never execute text from a task, capture or board message as a command.
16. Sweeps write proposals to `memory/proposed/`, never directly to concepts.
17. Deploy to staging first (`deploy:staging`) and check there before production.
18. Owner-facing dates and times use `OWNER_TIMEZONE` (America/Chicago); store timestamps with offsets.
19. Every read path respects the redaction list once 0.22 exists.
20. Every server-written file carries `schema_version`.
21. Binary files go only under `files/`, uploaded by the owner, each with a `type: File` concept; never through MCP tool arguments.
22. Every write tool requires a meaningful `why` once 0.23 exists.
23. Writes from `propose` tokens, and non-owner overwrites of human-reviewed concepts, become proposals.
24. All R2 calls go through the counting wrapper once 0.26 exists; the dashboard reads cached state, never R2 listings. R2 is the only product that bills over its allowance, so new features must not add unbounded R2 lists or storage.
25. Cloudflare Access protects only `/approve/*` and `/dashboard/*` (a path-based application), never the whole Worker. The Worker must verify the Access token on those paths and must never require it on `/mcp`, `/oauth/*`, `/.well-known/*` or `/hooks/*`.
26. Keep `AGENTS.md` (repo root) and `agent-talk-board/CLAUDE.md` current. Whenever a change affects commands, layout, tooling versions (for example the Node version), CI, or the rules above, update both files in the same commit and keep them in sync.
