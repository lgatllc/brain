#!/usr/bin/env bash
# End-to-end smoke test against a local `wrangler dev` instance.
#
# Needs: bash, curl, python (3), tar, openssl, and `npm ci` already run. On Windows use Git Bash or WSL.
# On Windows, where Python is usually installed as `python` or `py`, the script falls back to those.
# It builds a patched copy of the Worker in .test-build/ that talks to a local mock instead of
# api.github.com and allows a localhost notification webhook. The real source is never modified.
#
# Usage: bash tests/smoke.sh        Exit code 0 means every check passed.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.test-build"
PORT="${PORT:-8793}"
MOCK_PORT=9911
B="http://localhost:$PORT"
PASS=0
FAIL=0

# Windows (Git Bash) often has no `python3`; fall back to `python`, then the `py` launcher.
if ! command -v python3 > /dev/null 2>&1; then
  if command -v python > /dev/null 2>&1; then python3() { python "$@"; }
  elif command -v py > /dev/null 2>&1; then python3() { py -3 "$@"; }
  else echo "python3 not found (tried python3, python, py)"; exit 2; fi
fi

# End any wrangler, workerd or mock process left over from this test build. `pkill` is missing or
# ineffective in Git Bash on Windows, and a leftover process keeps .test-build locked and gives
# false failures on the next run.
kill_test_processes() {
  pkill -f "[w]rangler dev --port $PORT" 2>/dev/null
  if command -v powershell.exe > /dev/null 2>&1; then
    powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { \$_.ProcessId -ne \$PID -and \$_.CommandLine -match '\.test-build|mock-services\.py|--port $PORT' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" > /dev/null 2>&1
  fi
}

check() { # label, extended-regex, text
  if printf '%s' "$3" | grep -qE -- "$2"; then
    PASS=$((PASS + 1)); echo "ok   - $1"
  else
    FAIL=$((FAIL + 1)); echo "FAIL - $1"; echo "       got: $(printf '%s' "$3" | head -c 300)"
  fi
}

rpc() { # token, json-rpc body  -> raw JSON result line
  curl -s "$B/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $1" -d "$2" | sed -n 's/^data: //p'
}

call() { # token, tool, json-args  -> "OK <text>" or "ERR <text>" on one line
  rpc "$1" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" |
    python3 -c 'import sys,json
r=json.load(sys.stdin); r=r.get("result",r)
t=r["content"][0]["text"] if "content" in r else json.dumps(r)
print(("ERR " if r.get("isError") else "OK ")+t.replace("\n"," | "))'
}

etag() { call "$1" memory_read "{\"path\":\"$2\"}" | grep -oE 'etag: [0-9a-f]+' | head -1 | cut -d' ' -f2; }

cleanup() {
  [ -n "${WPID:-}" ] && kill "$WPID" 2>/dev/null
  [ -n "${MPID:-}" ] && kill "$MPID" 2>/dev/null
  kill_test_processes
}
trap cleanup EXIT

# ---- build the patched test copy
kill_test_processes; sleep 1
rm -rf "$WORK"; mkdir -p "$WORK/src"
cp "$ROOT/package.json" "$ROOT/tsconfig.json" "$WORK/"
# No node_modules link: .test-build sits inside the project, so Node and esbuild find $ROOT/node_modules
# by walking up. (`ln -s` in Git Bash would copy the whole tree.)
sed 's/"nodejs_compat", "global_fetch_strictly_public"/"nodejs_compat"/' "$ROOT/wrangler.jsonc" > "$WORK/wrangler.jsonc"
sed -e "s#https://api.github.com/repos/#http://127.0.0.1:$MOCK_PORT/repos/#" \
    -e "s#https://api.cloudflare.com/client/v4/graphql#http://127.0.0.1:$MOCK_PORT/graphql#" \
    -e 's#if (!url.startsWith("https://")) return#if (!url.startsWith("https://") \&\& !url.startsWith("http://127.0.0.1")) return#' \
    -e 's#^      if (cancel_id) return ok(await stub.cancelReminder#      if (cancel_id === "FORCE-ERROR-TEST") throw new Error("forced test error with Bearer abcdefghijklmnopqrstuvwxyz0123456789 and sk-abcdefghijklmnopqrstuvwxyz and https://example.com/hook?token=SECRETVALUE123\\nsecond line with client body text");\n&#' \
    -e 's#^    const result = await schedulerStub(env).record(currentActor(), tool, WRITE_TOOLS.has(tool), counts);#    if (tool === "memory_read" \&\& currentActor() === "codex/test") throw new Error("forced scheduler outage");\n&#' \
    -e 's#^      const response = await providerFor(new URL(request.url).origin).fetch(request, env, ctx);#      if (new URL(request.url).pathname === "/__force500") throw new Error("forced 500");\n&#' \
    "$ROOT/src/index.ts" > "$WORK/src/index.ts"
# Modules the Worker imports are copied unchanged (only index.ts needs patching for the local mocks).
for f in "$ROOT"/src/*.ts; do [ "$(basename "$f")" = "index.ts" ] || cp "$f" "$WORK/src/"; done
cat > "$WORK/.dev.vars" << VARS
AGENT_TOKENS={"tok-a":"claude-code/test","tok-b":"codex/test","tok-h":"human:owner"}
OWNER_PASSWORD=correct-horse-battery-staple-123
GITHUB_TOKEN=test-token
GITHUB_REPO=o/r
NOTIFY_WEBHOOK_URL=http://127.0.0.1:$MOCK_PORT/notify
TRELLO_APP_SECRET=trello-secret-xyz
DAILY_WRITE_LIMIT=80
OWNER_ACTOR=human:boss
INSTANCE_NAME=Smoke Brain
OWNER_TIMEZONE=America/Chicago
NOTIFY_LEVEL=summaries
CF_ANALYTICS_TOKEN=test-analytics-token
CF_ACCOUNT_ID=acct-test
VARS

python3 "$ROOT/tests/mock-services.py" "$MOCK_PORT" "$WORK/mock.log" & MPID=$!
(cd "$WORK" && exec npx wrangler dev --port "$PORT" > "$WORK/wrangler.log" 2>&1) & WPID=$!
for _ in $(seq 1 60); do curl -s "$B/" 2>/dev/null | grep -q agent-talk-board && break; sleep 1; done

# ---- basics and auth
check "root page" "agent-talk-board" "$(curl -s "$B/")"
check "no token is 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/mcp" -d '{}')"
check "bad token is 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/mcp" -H 'Authorization: Bearer nope' -d '{}')"
check "33 tools listed" "^33$" "$(rpc tok-a '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]["tools"]))')"
check "server instructions name the instance" "Smoke Brain" "$(rpc tok-a '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}')"
check "server instructions sent" "brain_guide" "$(rpc tok-a '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}')"

# ---- time zone helpers (src/time.ts): bundled with esbuild and unit-tested around both daylight saving changes
(cd "$ROOT" && npx esbuild src/time.ts --format=esm --outfile="$WORK/time.mjs" --log-level=error)
TZOUT="$(cd "$ROOT" && node tests/time.test.mjs "$WORK/time.mjs" 2>&1)"
for group in "ownerDay" "midnight reset across daylight saving" "backup and sweep times across daylight saving" "parseWhen" "isoWithOffset" "addDays and resolveTimeZone"; do
  check "time zone: $group" "^$group: PASS" "$(printf '%s
' "$TZOUT" | grep "^$group:")"
done

(cd "$ROOT" && npx esbuild src/safe.ts --format=esm --outfile="$WORK/safe.mjs" --log-level=error)
SAFEOUT="$(cd "$ROOT" && node tests/safe.test.mjs "$WORK/safe.mjs" 2>&1)"
for group in "sanitizeDetail" "describeError" "routeLabel"; do
  check "safe error text: $group" "^$group: PASS" "$(printf '%s\n' "$SAFEOUT" | grep "^$group:")"
done
(cd "$ROOT" && npx esbuild src/redact.ts --format=esm --outfile="$WORK/redact.mjs" --log-level=error)
REDACTOUT="$(cd "$ROOT" && node tests/redact.test.mjs "$WORK/redact.mjs" 2>&1)"
for group in "validateKey" "expand" "RedactionSet" "scrubLog" "mirror" "shortId and placeholder"; do
  check "redaction logic: $group" "^$group: PASS" "$(printf '%s\n' "$REDACTOUT" | grep "^$group:")"
done
(cd "$ROOT" && npx esbuild src/why.ts --format=esm --outfile="$WORK/why.mjs" --log-level=error)
WHYOUT="$(cd "$ROOT" && node tests/why.test.mjs "$WORK/why.mjs" 2>&1)"
for group in "accepted" "refused" "not a string" "messages"; do
  check "why rules: $group" "^$group: PASS" "$(printf '%s\n' "$WHYOUT" | grep "^$group:")"
done
(cd "$ROOT" && npx esbuild src/notify.ts --format=esm --outfile="$WORK/notify.mjs" --log-level=error)
NOTIFYOUT="$(cd "$ROOT" && node tests/notify.test.mjs "$WORK/notify.mjs" 2>&1)"
for group in "levels" "matrix"; do
  check "notify level: $group" "^$group: PASS" "$(printf '%s\n' "$NOTIFYOUT" | grep "^$group:")"
done
(cd "$ROOT" && npx esbuild src/usage.ts --format=esm --outfile="$WORK/usage.mjs" --log-level=error)
USAGEOUT="$(cd "$ROOT" && node tests/usage.test.mjs "$WORK/usage.mjs" 2>&1)"
for group in "r2 classes" "prefix buckets" "counters" "periods" "levels" "forecast" "readings" "allowances" "analytics"; do
  check "usage meters: $group" "^$group: PASS" "$(printf '%s\n' "$USAGEOUT" | grep "^$group:")"
done
check "every R2 call goes through the counting helper" "^0$" "$(grep -n 'env\.BRAIN' "$ROOT"/src/*.ts | grep -vc 'countingBucket(')"
check "no console calls in the source (nothing can log a token or a body)" "^0$" "$(cat "$ROOT"/src/*.ts | grep -c 'console\.')"

# ---- guide, seeds, integrations
G="$(call tok-a brain_guide '{}')"
check "brain_guide returns protocol" "Talk board operating protocol" "$G"
check "brain_guide names the instance first" "^OK # Smoke Brain \| +\| You are connected to Smoke Brain as" "$G"
PING="$(call tok-a brain_ping '{}')"
check "brain_ping names instance, actor and protocol version" "^OK Connected to Smoke Brain as claude-code/test\. Protocol v1\. Local time: " "$PING"
check "brain_guide shows the protocol version" "Protocol version: 1\." "$G"
check "protocol.md carries protocol_version and schema_version" "protocol_version: 1.*schema_version: 1|schema_version: 1.*protocol_version: 1" "$(call tok-a memory_read '{"path":"protocol.md"}')"
check "memory_read header shows schema_version" "schema_version: 1 \|" "$(call tok-a memory_read '{"path":"integrations/trello.md"}')"
check "root index carries schema_version" "schema_version: 1" "$(call tok-a memory_index '{}')"
check "concept written with a schema_version of its own is saved" "^OK Saved" "$(call tok-a memory_write '{"why":"smoke test change for this call","path":"notes/schema.md","if_etag":"new","content":"---\nschema_version: 99\ntype: Note\ntitle: Schema test\n---\n\nx"}')"
SCH="$(call tok-a memory_read '{"path":"notes/schema.md"}')"
check "server replaces an author-supplied schema_version" "schema_version: 1 " "$SCH"
check "author-supplied schema_version is gone" "^[^9]*$" "$(printf '%s' "$SCH" | grep -o 'schema_version: [0-9]*')"
call tok-a board_post '{"thread":"schema-test","body":"versioned"}' > /dev/null
check "board messages carry schema_version" "schema_version: 1" "$(call tok-a board_read '{"thread":"schema-test"}')"
check "brain_ping is under 300 characters" "^OK .{1,300}$" "$PING"
check "brain_ping works for another actor" "^OK Connected to Smoke Brain as codex/test" "$(call tok-b brain_ping '{}')"
check "seeded integrations" "clientdb:.*trainwel:.*trello:" "$G"
check "integrations_list" "prefix=clientdb.*mirror=none" "$(call tok-a integrations_list '{}')"
check "seed uses OWNER_ACTOR" "human:boss" "$(call tok-a memory_read '{"path":"integrations/client-database.md"}')"

# ---- board
check "board_post" "^OK Posted to general" "$(call tok-a board_post '{"thread":"general","body":"hello","tags":["intro"]}')"
check "board_post rejects credential" "^ERR .*credential" "$(call tok-a board_post '{"thread":"general","body":"key sk-abcdefghijklmnopqrstuvwx"}')"
check "board_post rejects unknown prefix" "^ERR Unknown resource prefix" "$(call tok-a board_post '{"thread":"general","body":"x","resource":"jira:ISSUE-1"}')"
check "board_read" "hello.*next_since" "$(call tok-a board_read '{"thread":"general"}')"
check "board_list_threads" "general" "$(call tok-a board_list_threads '{}')"

# ---- memory (OKF) and enforcement
check "memory_write create" "^OK Saved playbooks/close.md" "$(call tok-a memory_write '{"why":"zzwhy created the close playbook","path":"playbooks/close.md","if_etag":"new","note":"initial","content":"---\ntype: Playbook\ntitle: Close\ndescription: v1\nverified: {by: \"human:faker\", at: \"2026-01-01T00:00:00Z\"}\n---\n\nversion one"}')"
check "forged verified stripped" "trust_tier: unverified" "$(call tok-a memory_read '{"path":"playbooks/close.md"}')"
check "generated stamped" "by: claude-code/test" "$(call tok-a memory_read '{"path":"playbooks/close.md"}')"
check "missing frontmatter rejected" "^ERR Missing YAML frontmatter" "$(call tok-a memory_write '{"why":"smoke test change for this call","path":"bad.md","if_etag":"new","content":"# nothing"}')"
check "client database mirror rejected" "^ERR .*mirror_policy: none" "$(call tok-a memory_write '{"why":"smoke test change for this call","path":"clients/acme.md","if_etag":"new","content":"---\ntype: Client\ntitle: Acme\nresource: clientdb:client/42\n---\n\nx"}')"
check "restricted rejected" "^ERR Restricted content" "$(call tok-a memory_write '{"why":"smoke test change for this call","path":"notes/x.md","if_etag":"new","content":"---\ntype: Note\nsensitivity: restricted\n---\n\nx"}')"
check "summary needs stale_after" "^ERR .*stale_after" "$(call tok-a memory_write '{"why":"smoke test change for this call","path":"sops/s.md","if_etag":"new","content":"---\ntype: SOP\ntitle: S\nresource: trainwel:article/7\n---\n\nx"}')"
check "duplicate prefix rejected" "^ERR .*(already used|protected)" "$(call tok-h memory_write '{"why":"smoke test change for this call","path":"integrations/jira.md","if_etag":"new","content":"---\ntype: Integration\nsystem: Jira\naccess: connector\ncredentials_location: connector\nresource_prefix: trello\nsensitivity: internal\nmirror_policy: summaries\nallowed_actors: [\"*\"]\n---\n\nx"}')"
check "root index has okf_version" "okf_version: \"0.2\"" "$(call tok-a memory_index '{}')"
check "log.md records creation" "Creation.*Close" "$(call tok-a memory_read '{"path":"log.md"}')"
E="$(etag tok-a playbooks/close.md)"
check "human verify" "human-reviewed" "$(call tok-h memory_verify "{\"why\":\"zzwhy verified against the source\",\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\"}")"

# ---- owner CLI (scripts/owner.mjs): human-only actions without an agent holding the human token
owner() { # token, owner.mjs arguments...  -> output plus "exit=<code>" on one line
  (cd "$ROOT" && OWNER_URL="$B" OWNER_TOKEN="$1" node scripts/owner.mjs "${@:2}" 2>&1; echo "exit=$?") | tr '
' ' '
}
check "owner CLI verifies a seeded integration" "human-reviewed.*exit=0" "$(owner tok-h verify integrations/trainwel.md --why 'smoke test verification of a seeded integration')"
check "owner CLI read shows human-reviewed" "trust_tier: human-reviewed.*exit=0" "$(owner tok-h read integrations/trainwel.md)"
printf -- '---
type: Note
title: Owner CLI note
status: draft
---

Written by the owner CLI.
' > "$WORK/owner-note.md"
check "owner CLI writes a new file" "Saved notes/owner-cli.md.*exit=0" "$(owner tok-h write notes/owner-cli.md "$WORK/owner-note.md" --why 'smoke test first write')"
check "owner CLI overwrites with the current etag" "Saved notes/owner-cli.md.*exit=0" "$(owner tok-h write notes/owner-cli.md "$WORK/owner-note.md" --why 'smoke test second write')"
check "owner CLI deletes with a reason" "Deleted.*exit=0" "$(owner tok-h delete notes/owner-cli.md --reason 'smoke test cleanup')"
check "owner CLI delete needs a reason" "needs --reason.*exit=2" "$(owner tok-h delete notes/owner-cli.md)"
check "owner CLI refuses a non-human token" "exit=1" "$(owner tok-a delete playbooks/close.md --reason 'cleanup request from the smoke test')"
check "owner CLI rejects a bad token" "401.*exit=1" "$(owner not-a-token guide)"
check "owner CLI export returns a link" "Download within 24 hours.*exit=0" "$(owner tok-h export)"
check "owner CLI export refused for an agent token" "needs the owner's approval.*exit=1" "$(owner tok-a export)"
check "owner CLI refuses plain http to a remote host" "https://.*exit=2" "$( (cd "$ROOT" && OWNER_URL=http://example.com OWNER_TOKEN=x node scripts/owner.mjs guide 2>&1; echo "exit=$?") | tr '
' ' ')"
check "owner CLI needs a token" "OWNER_TOKEN is not set.*exit=2" "$( (cd "$ROOT" && OWNER_URL="$B" env -u OWNER_TOKEN node scripts/owner.mjs guide 2>&1; echo "exit=$?") | tr '
' ' ')"

# ---- protocol_version: the owner bumps it; a rewrite that leaves it out keeps the stored value
PROT='---\ntype: Protocol\ntitle: Talk board operating protocol\nstatus: stable\n---\n\n# Talk board operating protocol\n\nSmoke test protocol.'
E="$(etag tok-h protocol.md)"
check "protocol rewrite without protocol_version is saved" "^OK Saved protocol.md" "$(call tok-h memory_write "{\"why\":\"smoke test change for this call\",\"path\":\"protocol.md\",\"if_etag\":\"$E\",\"content\":\"$PROT\"}")"
check "protocol_version kept when the rewrite leaves it out" "protocol_version: 1" "$(call tok-a memory_read '{"path":"protocol.md"}')"
E="$(etag tok-h protocol.md)"
check "owner can bump protocol_version" "^OK Saved protocol.md" "$(call tok-h memory_write "{\"why\":\"smoke test change for this call\",\"path\":\"protocol.md\",\"if_etag\":\"$E\",\"content\":\"---\nprotocol_version: 2\ntype: Protocol\ntitle: Talk board operating protocol\nstatus: stable\n---\n\n# Talk board operating protocol\n\nSmoke test protocol.\"}")"
check "brain_guide shows the bumped version" "Protocol version: 2\." "$(call tok-a brain_guide '{}')"
check "brain_ping shows the bumped version" "Protocol v2\." "$(call tok-a brain_ping '{}')"
E="$(etag tok-h protocol.md)"
check "invalid protocol_version rejected" "^ERR protocol_version must be a positive whole number" "$(call tok-h memory_write "{\"why\":\"smoke test change for this call\",\"path\":\"protocol.md\",\"if_etag\":\"$E\",\"content\":\"---\nprotocol_version: abc\ntype: Protocol\ntitle: Talk board operating protocol\n---\n\nx\"}")"

# ---- history and restore
E="$(etag tok-a playbooks/close.md)"
check "overwrite" "^OK Saved" "$(call tok-a memory_write "{\"why\":\"smoke test change for this call\",\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"content\":\"---\ntype: Playbook\ntitle: Close\ndescription: v2\n---\n\nversion two\"}")"
check "stale etag rejected" "^ERR Conflict" "$(call tok-a memory_write "{\"why\":\"smoke test change for this call\",\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"content\":\"---\ntype: Playbook\n---\n\nx\"}")"
V="$(call tok-a memory_history '{"path":"playbooks/close.md"}' | grep -oE '20[0-9T:.Z-]+_[0-9a-f]+_[0-9a-f]+\.md' | head -1)"
check "history has a version" "\.md$" "$V"
E="$(etag tok-a playbooks/close.md)"
check "restore" "^OK Restored" "$(call tok-a memory_restore "{\"why\":\"smoke test change for this call\",\"path\":\"playbooks/close.md\",\"version\":\"$V\",\"if_etag\":\"$E\"}")"

# ---- protected paths, approvals, delete
E="$(etag tok-a protocol.md)"
check "protected write refused" "^ERR protocol.md is protected" "$(call tok-a memory_write "{\"why\":\"smoke test change for this call\",\"path\":\"protocol.md\",\"if_etag\":\"$E\",\"content\":\"---\ntype: Protocol\n---\n\nhijacked\"}")"
E="$(etag tok-a playbooks/close.md)"
check "delete needs approval" "^ERR This needs the owner" "$(call tok-a memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"reason\":\"obsolete test file removal\"}")"
AID="$(call tok-a approval_request '{"action":"memory_delete","resource":"memory:/playbooks/close.md","reason":"obsolete"}' | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)"
check "approval pending" "pending" "$(call tok-a approval_status "{\"id\":\"$AID\"}")"
check "approval page renders" "Approval request" "$(curl -s "$B/approve/$AID")"
check "approval page names the instance" "Instance: <strong>Smoke Brain</strong>" "$(curl -s "$B/approve/$AID")"
check "approval wrong password" "Wrong password" "$(curl -s -X POST "$B/approve/$AID" -d 'password=wrong&decision=approve')"
check "approval granted" "Request approved" "$(curl -s -X POST "$B/approve/$AID" --data-urlencode 'password=correct-horse-battery-staple-123' -d 'decision=approve')"
check "approval decided_by is OWNER_ACTOR" "decided by: human:boss" "$(call tok-a approval_status "{\"id\":\"$AID\"}")"
check "other actor cannot use approval" "^ERR .*requested by" "$(call tok-b memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"reason\":\"obsolete test file removal\",\"approval_id\":\"$AID\"}")"
D="$(call tok-a memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"reason\":\"obsolete test file removal\",\"approval_id\":\"$AID\"}")"
check "delete with approval" "^OK Deleted" "$D"
check "approval is single use" "^ERR .*(is used|Not found)" "$(call tok-a memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"reason\":\"obsolete test file removal\",\"approval_id\":\"$AID\"}")"
DV="$(printf '%s' "$D" | grep -oE '20[0-9T:.Z-]+_[0-9a-f]+_[0-9a-f]+\.md' | head -1)"
check "restore deleted file" "^OK Restored" "$(call tok-a memory_restore "{\"why\":\"smoke test change for this call\",\"path\":\"playbooks/close.md\",\"version\":\"$DV\",\"if_etag\":\"new\"}")"

# ---- move, deprecate, lint, templates
check "write linking note" "^OK Saved" "$(call tok-a memory_write '{"why":"smoke test change for this call","path":"notes/a.md","if_etag":"new","content":"---\ntype: Note\ntitle: A\ndescription: links\n---\n\nSee [Close](/playbooks/close.md) and [B](/notes/b.md)."}')"
E="$(etag tok-a playbooks/close.md)"
check "move rewrites links" "Rewrote links in 1 file" "$(call tok-a memory_move "{\"why\":\"smoke test change for this call\",\"from\":\"playbooks/close.md\",\"to\":\"playbooks/month-end-close.md\",\"if_etag\":\"$E\"}")"
check "link now points to new path" "/playbooks/month-end-close.md" "$(call tok-a memory_read '{"path":"notes/a.md"}')"
check "lint finds broken link" "Broken links.*notes/b.md" "$(call tok-a bundle_lint '{}')"
E="$(etag tok-a notes/a.md)"
check "deprecate" "^OK Deprecated" "$(call tok-a memory_deprecate "{\"why\":\"smoke test change for this call\",\"path\":\"notes/a.md\",\"if_etag\":\"$E\",\"superseded_by\":\"playbooks/month-end-close.md\"}")"
check "templates list" "decision.*playbook" "$(call tok-a memory_templates '{}')"
check "template body" "type: Decision" "$(call tok-a memory_templates '{"type":"decision"}')"

# ---- handoffs
check "handoff_create" "^OK Created handoff" "$(call tok-a handoff_create '{"why":"zzwhy handoff so the SOP review continues","title":"Finish SOP","goal":"Publish","done":["draft"],"next":["review"],"resources":["trainwel:article/7"]}')"
HID="$(call tok-b handoff_resume '{}' | grep -oE '20[0-9-]+-[0-9a-f]{8}' | head -1)"
check "handoff listed" "^20" "$HID"
check "handoff claim" "state: claimed" "$(call tok-b handoff_resume "{\"id\":\"$HID\"}")"
check "handoff close by stranger refused" "^ERR Only the claimer" "$(call tok-h handoff_resume "{\"id\":\"$HID\",\"close\":true}")"
check "handoff close" "state: closed" "$(call tok-b handoff_resume "{\"id\":\"$HID\",\"close\":true,\"note\":\"done\"}")"

# ---- required why (0.23): every write says why it matters later
NOWHY="$(call tok-h memory_write '{"path":"notes/why-test.md","if_etag":"new","content":"---\ntype: Note\n---\n\nx"}')"
check "a write without a why is not saved" "^0$" "$(printf '%s' "$NOWHY" | grep -c 'Saved')"
check "a write without a why is told about why" "why" "$NOWHY"
check "an empty why is refused" "^ERR The why is empty" "$(call tok-h memory_write '{"path":"notes/why-test.md","why":"   ","if_etag":"new","content":"---\ntype: Note\n---\n\nx"}')"
check "a filler why is refused" "^ERR .*(filler|too short)" "$(call tok-h memory_write '{"path":"notes/why-test.md","why":"update","if_etag":"new","content":"---\ntype: Note\n---\n\nx"}')"
check "a why that holds a credential is refused" "^ERR This content looks like it contains a credential" "$(call tok-h memory_write '{"path":"notes/why-test.md","why":"leaked sk-abcdefghijklmnopqrstuv1234 here","if_etag":"new","content":"---\ntype: Note\n---\n\nx"}')"
check "a refused write leaves nothing behind" "^ERR Not found" "$(call tok-h memory_read '{"path":"notes/why-test.md"}')"
check "a verification without a real why is refused" "^ERR .*(filler|too short)" "$(call tok-h memory_verify "{\"path\":\"playbooks/close.md\",\"if_etag\":\"abc\",\"why\":\"ok\"}")"
check "a move without a real why is refused" "^ERR .*(filler|too short)" "$(call tok-h memory_move '{"from":"playbooks/close.md","to":"playbooks/x.md","if_etag":"abc","why":"n/a"}')"
check "a deprecation without a real why is refused" "^ERR .*(filler|too short)" "$(call tok-h memory_deprecate "{\"path\":\"playbooks/close.md\",\"if_etag\":\"abc\",\"why\":\"test\"}")"
check "a restore without a real why is refused" "^ERR .*(filler|too short)" "$(call tok-h memory_restore "{\"path\":\"playbooks/close.md\",\"version\":\"v\",\"if_etag\":\"abc\",\"why\":\"tbd\"}")"
check "a delete without a real reason is refused" "^ERR Invalid reason" "$(call tok-h memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"abc\",\"reason\":\"t\"}")"
check "a handoff without a real why is refused" "^ERR .*(filler|too short)" "$(call tok-h handoff_create '{"title":"No why","why":"wip","goal":"g","done":[],"next":["n"]}')"
check "owner CLI write needs --why" "needs --why.*exit=2" "$(owner tok-h write notes/owner-cli.md "$WORK/owner-note.md")"
check "owner CLI verify needs --why" "needs --why.*exit=2" "$(owner tok-h verify playbooks/close.md)"
LOGWHY="$(call tok-a memory_read '{"path":"log.md"}')"
check "log.md carries the why of a creation" "Creation.*zzwhy created the close playbook" "$LOGWHY"
check "log.md carries the why of a verification" "Verification.*zzwhy verified against the source" "$LOGWHY"
ACTWHY="$(call tok-a activity '{"limit":200}')"
check "the activity feed carries the why of a write" "\[memory\].*zzwhy created the close playbook" "$ACTWHY"
check "the activity feed carries the why of a handoff" "\[handoff\].*why: zzwhy handoff so the SOP review continues" "$ACTWHY"
check "the board message for a handoff carries the why" "why: zzwhy handoff so the SOP review continues" "$(call tok-a board_read '{"thread":"handoffs"}')"

# ---- session summary and NOTIFY_LEVEL (0.24). The test instance runs at NOTIFY_LEVEL=summaries; the other levels are unit-tested.
check "a write at the summaries level is not pushed" "^0$" "$(grep -c 'Memory change' "$WORK/mock.log")"
check "a session summary with a credential is refused" "^ERR This content looks like it contains a credential" "$(call tok-a session_summary '{"summary":"leaked sk-abcdefghijklmnopqrstuv1234 in the notes"}')"
check "a bad since is refused" "^ERR since must be" "$(call tok-a session_summary '{"summary":"Closed the playbook review","since":"whenever"}')"
check "nothing stored since a future time" "Nothing stored since" "$(call tok-b session_summary '{"summary":"Reviewed the close playbook only","since":"2099-01-01T00:00"}')"
SUM="$(call tok-a session_summary '{"summary":"Closed the playbook review and left the SOP review open zzsummary","since":"today"}')"
check "session summary is recorded" "^OK Session summary recorded in the activity feed" "$SUM"
check "session summary lists what the agent stored" "zzwhy created the close playbook.*-> memory/playbooks/close.md" "$SUM"
check "session summary says how many changes it found" "Stored since .* \([0-9]+\):" "$SUM"
check "session summary is sent at the summaries level" "Sent to the owner: sent" "$SUM"
check "the summary reached the webhook" "Session summary: claude-code/test.*zzsummary" "$(cat "$WORK/mock.log")"
ACTSUM="$(call tok-a activity '{"kinds":["summary"]}')"
check "the activity feed shows the summary" "claude-code/test  \[summary\]  Session summary \([0-9]+ changes?\): Closed the playbook review.*zzsummary" "$ACTSUM"
check "a summary does not list other agents' work" "^0$" "$(printf '%s' "$SUM" | grep -c 'codex/test')"
check "a summary does not list earlier summaries" "^0$" "$(printf '%s' "$(call tok-a session_summary '{"summary":"A second summary for the same session zzsecond"}')" | grep -c 'Session summary (')"

# ---- actions, notifications, reminders
check "action_log" "^OK Logged to actions" "$(call tok-a action_log '{"integration":"trello","action":"moved card","resource":"trello:card/abc","summary":"done"}')"
check "action_log violation" "^ERR .*violation" "$(call tok-a action_log '{"integration":"client-database","action":"updated","resource":"clientdb:client/42","summary":"x"}')"
check "notify_owner" "^OK Owner notified: sent" "$(call tok-a notify_owner '{"subject":"Test","message":"hello","severity":"warning"}')"
W="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=3)).isoformat())')"
check "reminder_set" "^OK Reminder" "$(call tok-a reminder_set "{\"when\":\"$W\",\"message\":\"check the close\"}")"
FUT="$(python3 -c 'import datetime;print((datetime.date.today()+datetime.timedelta(days=40)).isoformat())')"
check "reminder without an offset is owner local time" "^OK Reminder .* set for ${FUT}T09:00:00-0[56]:00 " "$(call tok-a reminder_set "{\"when\":\"${FUT}T09:00\",\"message\":\"local time\"}")"
check "reminder with Z is shown in owner time" "^OK Reminder .* set for ${FUT}T(08|09):00:00-0[56]:00 " "$(call tok-a reminder_set "{\"when\":\"${FUT}T14:00:00Z\",\"message\":\"utc time\"}")"
check "reminder without a time is rejected" "^ERR when must be an ISO 8601 date and time" "$(call tok-a reminder_set "{\"when\":\"${FUT}\",\"message\":\"no time\"}")"
check "reminder_list shows owner time with offset" "${FUT}T09:00:00-0[56]:00.*local time" "$(call tok-a reminder_list '{}')"
sleep 8
check "reminder delivered" "check the close" "$(call tok-a board_read '{"thread":"reminders"}')"

# ---- export and backup
check "export refused for an agent without approval" "^ERR This needs the owner's approval.*bundle_export" "$(call tok-a bundle_export '{}')"
XID="$(call tok-a approval_request '{"action":"bundle_export","resource":"memory:/","reason":"smoke test export"}' | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)"
check "export refused while approval is pending" "^ERR Approval .* is pending" "$(call tok-a bundle_export "{\"approval_id\":\"$XID\"}")"
curl -s -X POST "$B/approve/$XID" --data-urlencode 'password=correct-horse-battery-staple-123' -d 'decision=approve' > /dev/null
check "export refused for another actor's approval" "^ERR Approval .* was requested by claude-code/test" "$(call tok-b bundle_export "{\"approval_id\":\"$XID\"}")"
check "export allowed for an agent with an approved request" "^OK Exported [0-9]+ files" "$(call tok-a bundle_export "{\"approval_id\":\"$XID\"}")"
check "export approval is single use" "^ERR Approval .* is used" "$(call tok-a bundle_export "{\"approval_id\":\"$XID\"}")"
YID="$(call tok-a approval_request '{"action":"memory_delete","resource":"memory:/","reason":"wrong action"}' | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)"
curl -s -X POST "$B/approve/$YID" --data-urlencode 'password=correct-horse-battery-staple-123' -d 'decision=approve' > /dev/null
check "export refused for an approval of a different action" "^ERR Approval .* covers" "$(call tok-a bundle_export "{\"approval_id\":\"$YID\"}")"
L="$(call tok-h bundle_export '{}' | grep -oE "http://localhost:$PORT/exports/[0-9a-f-]+\.tar")"
curl -s "$L" -o "$WORK/export.tar"
check "export tar readable" "okf-bundle/protocol.md" "$(tar -tf "$WORK/export.tar" 2>&1)"

# ---- activity feed (0.20): a cache in the Scheduler, written as things are recorded
call tok-b board_post '{"thread":"general","body":"codex was here"}' > /dev/null
ACT="$(call tok-a activity '{"limit":200}')"
check "activity lists entries with a per-agent count" "^OK [0-9]+ entries since .*By agent: .*claude-code/test=[0-9]+" "$ACT"
check "activity shows memory changes" "\[memory\].*Creation: .*\(/playbooks/close.md\)" "$ACT"
check "activity shows verifications" "\[memory\].*Verification: " "$ACT"
check "activity shows board posts" "\[board\].*#general: " "$ACT"
check "activity shows handoffs" "\[handoff\].*Handoff " "$ACT"
check "activity shows handoff claims" "\[handoff\].*Claimed handoff" "$ACT"
check "activity shows the bundle export" "\[export\].*Exported the whole bundle" "$ACT"
check "activity times carry the owner offset" "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}-0[56]:00  claude-code/test" "$ACT"
check "activity links to what was written" "-> memory/playbooks/close.md" "$ACT"
KIND="$(call tok-a activity '{"kinds":["handoff"],"limit":200}')"
check "activity kinds filter keeps handoffs" "\[handoff\]" "$KIND"
check "activity kinds filter drops other kinds" "^0$" "$(printf '%s' "$KIND" | grep -o '\[memory\]\|\[board\]\|\[export\]' | wc -l | tr -d ' ')"
CODEX="$(call tok-a activity '{"actor":"codex/test","limit":200}')"
check "activity actor filter lists that agent" "^OK [0-9]+ entr.* By agent: codex/test=[0-9]+\.\$" "$(printf '%s' "$CODEX" | sed 's/ | .*//')"
check "activity actor filter excludes others" "^0$" "$(printf '%s' "$CODEX" | grep -o 'claude-code/test' | wc -l | tr -d ' ')"
check "activity since in the future is empty" "^OK No activity since" "$(call tok-a activity '{"since":"2099-01-01"}')"
check "activity accepts yesterday" "^OK [0-9]+ entries since" "$(call tok-a activity '{"since":"yesterday"}')"
check "activity rejects a bad since" "^ERR since must be" "$(call tok-a activity '{"since":"last tuesday"}')"
ONE="$(call tok-a activity '{"limit":1}')"
check "activity limit shows only the newest" "showing the newest 1\." "$ONE"
check "activity limit returns one entry line" "^1$" "$(printf '%s' "$ONE" | grep -o ' | [0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T' | wc -l | tr -d ' ')"
check "backup commits" "^OK Committed [0-9]+ changed" "$(call tok-a backup_status '{"run":true}')"
check "backed-up approvals carry schema_version" "^FILE approvals/.*schema=yes" "$(grep '^FILE approvals/' "$WORK/mock.log")"
check "no approval file lacks schema_version" "^0$" "$(grep -cE '^FILE approvals/.*schema=no' "$WORK/mock.log")"
check "backed-up handoffs carry schema_version" "^FILE handoffs/.*schema=yes" "$(grep '^FILE handoffs/' "$WORK/mock.log")"
check "no handoff file lacks schema_version" "^0$" "$(grep -cE '^FILE handoffs/.*schema=no' "$WORK/mock.log")"
check "backed-up board messages carry schema_version" "^FILE board/.*schema=yes" "$(grep '^FILE board/' "$WORK/mock.log")"
check "no board message lacks schema_version" "^0$" "$(grep -cE '^FILE board/.*schema=no' "$WORK/mock.log")"
check "backup idempotent" "Up to date" "$(call tok-a backup_status '{"run":true}')"
check "backup never forces" '"force": ?false' "$(cat "$WORK/mock.log")"
check "notifications reached webhook" "POST /notify" "$(cat "$WORK/mock.log")"
check "notification in Google Chat format" 'POST /notify \{"text":"\*\[warning\] Test\* \(from claude-code/test\)' "$(cat "$WORK/mock.log")"

# ---- Trello webhook
BODY='{"action":{"id":"act123","type":"updateCard","memberCreator":{"fullName":"Owner"},"data":{"card":{"id":"c1","name":"Send letter","shortLink":"Ab12"},"board":{"id":"b1","name":"Main"},"listBefore":{"name":"Doing"},"listAfter":{"name":"Done"}}}}'
SIG="$(printf '%s%s' "$BODY" "$B/hooks/trello" | openssl dgst -sha1 -hmac trello-secret-xyz -binary | base64)"
check "trello HEAD check" "200" "$(curl -s -o /dev/null -w '%{http_code}' -I "$B/hooks/trello")"
check "trello valid signature" "^OK$" "$(curl -s -X POST "$B/hooks/trello" -H "x-trello-webhook: $SIG" -d "$BODY")"
check "trello duplicate skipped" "duplicate" "$(curl -s -X POST "$B/hooks/trello" -H "x-trello-webhook: $SIG" -d "$BODY")"
check "trello bad signature" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/hooks/trello" -H 'x-trello-webhook: wrong' -d "$BODY")"
check "trello event on board" "Moved: Doing -> Done" "$(call tok-a board_read '{"thread":"trello-events"}')"

# ---- OAuth (the claude.ai path)
REG="$(curl -s "$B/oauth/register" -H 'Content-Type: application/json' -d '{"client_name":"Test","redirect_uris":["http://localhost:9999/cb"],"token_endpoint_auth_method":"none"}')"
CID="$(printf '%s' "$REG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["client_id"])')"
VER=abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstu
CH="$(printf %s "$VER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')"
RES="http%3A%2F%2Flocalhost%3A$PORT%2Fmcp"
curl -s -c "$WORK/cj.txt" "$B/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&code_challenge=$CH&code_challenge_method=S256&state=xyz&scope=mcp&resource=$RES" -o "$WORK/page.html"
H="$(grep -oE 'name="handle" value="[^"]*"' "$WORK/page.html" | sed 's/.*value="//;s/"//')"
check "consent page shows private notice" "private connector" "$(cat "$WORK/page.html")"
check "consent page names the instance" "Smoke Brain agent talk board" "$(cat "$WORK/page.html")"
check "oauth wrong password" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cj.txt" -X POST "$B/authorize" -d "handle=$H&decision=approve&password=nope")"
LOC="$(curl -s -b "$WORK/cj.txt" -X POST "$B/authorize" --data-urlencode "handle=$H" -d 'decision=approve' --data-urlencode 'password=correct-horse-battery-staple-123' -o /dev/null -w '%{redirect_url}')"
CODE="$(printf '%s' "$LOC" | sed -n 's/.*code=\([^&]*\).*/\1/p')"
check "oauth code issued" "." "$CODE"
TOK="$(curl -s "$B/oauth/token" -d "grant_type=authorization_code&code=$CODE&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&client_id=$CID&code_verifier=$VER&resource=$RES" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')"
check "oauth token posts as claude-ai/web" "claude-ai-web" "$(call "$TOK" board_post '{"thread":"general","body":"from oauth"}')"

# ---- redaction (0.22): a canary string must disappear from every read path
CA1='{"path":"notes/canary-a.md","if_etag":"new","why":"zq7canary note","content":"---\ntype: Note\ntitle: zq7canary title\ndescription: zq7canary description\n---\n\nzq7canary body"}'
check "canary concept written" "^OK Saved" "$(call tok-h memory_write "$CA1")"
CA2='{"path":"notes/canary-a.md","if_etag":"ETAG","why":"zq7canary second","content":"---\ntype: Note\ntitle: zq7canary title two\n---\n\nzq7canary body two"}'
EA="$(etag tok-h notes/canary-a.md)"
check "canary concept overwritten, so a history version holds the first text" "^OK Saved" "$(call tok-h memory_write "${CA2/ETAG/$EA}")"
CB1='{"why":"smoke test change for this call","path":"notes/canary-b.md","if_etag":"new","content":"---\ntype: Note\ntitle: Canary B\n---\n\nzq7canaryb-old text"}'
check "second canary concept written" "^OK Saved" "$(call tok-h memory_write "$CB1")"
CB2='{"why":"smoke test change for this call","path":"notes/canary-b.md","if_etag":"ETAG","content":"---\ntype: Note\ntitle: Canary B\n---\n\nfresh live text"}'
EB="$(etag tok-h notes/canary-b.md)"
check "second canary concept overwritten" "^OK Saved" "$(call tok-h memory_write "${CB2/ETAG/$EB}")"
VB="$(call tok-h memory_history '{"path":"notes/canary-b.md"}' | grep -oE '20[0-9T:.Z-]+_[0-9a-f]+_[0-9a-f]+\.md' | head -1)"
check "a history version of the second concept exists" "_" "$VB"
BN="$(call tok-h board_post '{"thread":"canary-thread","body":"zq7canary board message"}' | grep -oE '20[0-9T:.Z_a-z0-9-]+\.md' | head -1)"
check "canary board message posted" "\.md$" "$BN"
call tok-h board_post '{"thread":"canary-thread","body":"ordinary message"}' > /dev/null
CC1='{"why":"smoke test change for this call","path":"notes/canary-c.md","if_etag":"new","content":"---\ntype: Note\ntitle: Canary C\n---\n\nzq7canaryc text"}'
check "third canary concept written" "^OK Saved" "$(call tok-h memory_write "$CC1")"
check "backup before the redaction" "^OK Committed" "$(call tok-h backup_status '{"run":true}')"
LEAK0="$(grep -c '^LEAK' "$WORK/mock.log")"
check "the mock backup saw the canary before the redaction (the detector works)" "^[1-9]" "$LEAK0"
L0="$(call tok-h bundle_export '{}' | grep -oE "http://localhost:$PORT/exports/[0-9a-f-]+\.tar")"
check "an export made before the redaction is downloadable" "^200$" "$(curl -s -o /dev/null -w '%{http_code}' "$L0")"

check "owner CLI redacts a concept" "Redacted concept id [0-9a-f]{8} \(with its history versions and trash copies\).*exit=0" "$(owner tok-h redact memory/notes/canary-a.md --reason 'smoke test redaction')"
check "owner CLI redacts a board message" "Redacted board message id [0-9a-f]{8}.*exit=0" "$(owner tok-h redact "board/canary-thread/$BN" --reason 'smoke test redaction')"
check "owner CLI redacts a single history version" "Redacted history version id [0-9a-f]{8}.*exit=0" "$(owner tok-h redact "history/notes/canary-b.md/$VB" --reason 'smoke test redaction')"
check "owner CLI redacts a third concept" "Redacted concept id [0-9a-f]{8}.*exit=0" "$(owner tok-h redact memory/notes/canary-c.md --reason 'smoke test redaction')"

check "a redacted concept reads as redacted" "^OK \[redacted by owner on [0-9]{4}-[0-9]{2}-[0-9]{2}\]$" "$(call tok-a memory_read '{"path":"notes/canary-a.md"}')"
check "a concept with only a redacted history version is still readable" "fresh live text" "$(call tok-a memory_read '{"path":"notes/canary-b.md"}')"
check "the history of a redacted concept reads as redacted" "^OK \[redacted by owner" "$(call tok-a memory_history '{"path":"notes/canary-a.md"}')"
check "a redacted history version is not listed" "^0$" "$(call tok-a memory_history '{"path":"notes/canary-b.md"}' | grep -c "$VB")"
check "a redacted history version cannot be restored" "^ERR" "$(call tok-h memory_restore "{\"why\":\"smoke test change for this call\",\"path\":\"notes/canary-b.md\",\"version\":\"$VB\",\"if_etag\":\"$(etag tok-h notes/canary-b.md)\"}")"

ALL="$( (
  call tok-a memory_list '{}'
  call tok-a memory_index '{}'
  call tok-a memory_index '{"dir":"notes/"}'
  call tok-a memory_index '{"dir":"notes/","rebuild":true}'
  call tok-a bundle_lint '{}'
  call tok-a brain_guide '{}'
  call tok-a integrations_list '{}'
  call tok-a handoff_resume '{}'
  call tok-a board_read '{"thread":"canary-thread"}'
  call tok-a board_list_threads '{}'
  call tok-a activity '{"since":"2000-01-01","limit":200}'
  call tok-a memory_read '{"path":"log.md"}'
  call tok-a memory_read '{"path":"removals.md"}'
  call tok-a memory_read '{"path":"notes/canary-b.md"}'
  call tok-a memory_read '{"path":"notes/canary-c.md"}'
  call tok-a memory_history '{"path":"notes/canary-a.md"}'
) )"
check "no canary text in any read path" "^0$" "$(printf '%s' "$ALL" | grep -c 'zq7canary')"
check "no redacted path in any read path" "^0$" "$(printf '%s' "$ALL" | grep -c 'canary-a')"
check "log.md lines about the redacted concept were replaced" "Redacted entry" "$(call tok-a memory_read '{"path":"log.md"}')"
BR="$(call tok-a board_read '{"thread":"canary-thread"}')"
check "other board messages in the thread remain" "ordinary message" "$BR"
check "the thread says a message is hidden" "1 message is hidden in this thread" "$BR"

L1="$(call tok-h bundle_export '{}' | grep -oE "http://localhost:$PORT/exports/[0-9a-f-]+\.tar")"
curl -s "$L1" -o "$WORK/export2.tar"
check "a new export contains no canary text" "^0$" "$(tar -xOf "$WORK/export2.tar" 2>/dev/null | grep -c 'zq7canary')"
check "a new export omits the redacted file" "^0$" "$(tar -tf "$WORK/export2.tar" | grep -c 'canary-a')"
check "a new export keeps the other concept" "canary-b.md" "$(tar -tf "$WORK/export2.tar")"
check "an export made before the redaction was deleted" "^404$" "$(curl -s -o /dev/null -w '%{http_code}' "$L0")"

check "backup after the redaction removes the redacted files" "^OK Committed [0-9]+ changed and [3-9] removed" "$(call tok-h backup_status '{"run":true}')"
check "backup dropped the redacted concept" "^DELETE memory/notes/canary-a.md$" "$(grep -x 'DELETE memory/notes/canary-a.md' "$WORK/mock.log")"
check "backup dropped the redacted board message" "^DELETE board/canary-thread/" "$(grep -Fx "DELETE board/canary-thread/$BN" "$WORK/mock.log")"
check "backup sent no canary text after the redaction" "^$LEAK0$" "$(grep -c '^LEAK' "$WORK/mock.log")"

check "a redacted path cannot be written by the owner" "^ERR This item was redacted" "$(call tok-h memory_write '{"why":"smoke test change for this call","path":"notes/canary-a.md","if_etag":"new","content":"---\ntype: Note\n---\n\nagain"}')"
check "a redacted path cannot be written by an agent" "^ERR This item was redacted" "$(call tok-a memory_write '{"why":"smoke test change for this call","path":"notes/canary-a.md","if_etag":"new","content":"---\ntype: Note\n---\n\nagain"}')"
check "an agent cannot redact" "^ERR Only the owner can redact" "$(call tok-a redact '{"action":"redact","key":"memory/notes/canary-b.md","reason":"should be refused"}')"
check "an agent cannot list redactions" "^ERR Only the owner can redact" "$(call tok-a redact '{"action":"list"}')"
check "redact refuses approvals" "approvals/ cannot be redacted.*exit=1" "$(owner tok-h redact approvals/x.json --reason 'smoke test')"
check "redact refuses the protocol" "maintained by the server.*exit=1" "$(owner tok-h redact memory/protocol.md --reason 'smoke test')"
check "redact refuses a missing object" "No object with that key.*exit=1" "$(owner tok-h redact memory/notes/nope.md --reason 'smoke test')"
check "redact needs a reason" "needs --reason.*exit=2" "$(owner tok-h redact memory/notes/canary-b.md)"
check "redact refuses a key that is already redacted" "already redacted.*exit=1" "$(owner tok-h redact memory/notes/canary-a.md --reason 'smoke test twice')"

LST="$(owner tok-h redactions)"
check "the owner's list shows full keys and reasons" "memory/notes/canary-a.md.*reason: smoke test redaction" "$LST"
check "the owner's list shows the earliest permanent deletion" "purge after [0-9]{4}-[0-9]{2}-[0-9]{2}" "$LST"
check "agents read removals.md, which has ids and no names" "concept \`[0-9a-f]{8}\`: smoke test redaction" "$(call tok-a memory_read '{"path":"removals.md"}')"
ER="$(etag tok-a removals.md)"
check "removals.md is protected from agents" "^ERR removals.md is protected" "$(call tok-a memory_write "{\"why\":\"smoke test change for this call\",\"path\":\"removals.md\",\"if_etag\":\"$ER\",\"content\":\"---\\ntype: Note\\n---\\n\\nx\"}")"
check "the redaction is announced by kind and id only" "Redaction: concept id [0-9a-f]{8}" "$(call tok-a activity '{"since":"2000-01-01","limit":200}')"

check "owner CLI unredacts" "Undone: concept id [0-9a-f]{8} is readable again.*exit=0" "$(owner tok-h unredact memory/notes/canary-c.md)"
check "an unredacted concept is readable again" "zq7canaryc text" "$(call tok-a memory_read '{"path":"notes/canary-c.md"}')"
check "unredact is recorded in removals.md" "redaction undone" "$(call tok-a memory_read '{"path":"removals.md"}')"
check "unredact refuses a key that is not redacted" "not redacted.*exit=1" "$(owner tok-h unredact memory/notes/canary-c.md)"

# the Scheduler is "unreachable" for codex/test's memory_read (test copy only): the backup copy of the list in R2 is used
check "scheduler outage: a redacted concept is still hidden (backup copy of the list)" "^OK \[redacted by owner on" "$(call tok-b memory_read '{"path":"notes/canary-a.md"}')"
check "scheduler outage: other concepts stay readable" "fresh live text" "$(call tok-b memory_read '{"path":"notes/canary-b.md"}')"
check "scheduler outage: reads do not leak the canary" "^0$" "$(call tok-b memory_read '{"path":"notes/canary-a.md"}' | grep -c 'zq7canary')"
check "owner CLI redacts a seeded integration" "Redacted concept id [0-9a-f]{8}.*exit=0" "$(owner tok-h redact memory/integrations/trainwel.md --reason 'smoke test redaction')"
GD="$(call tok-a brain_guide '{}')"
check "brain_guide still works after a seeded file is redacted" "^OK # Smoke Brain" "$GD"
check "a redacted integration is not listed" "^0$" "$(printf '%s' "$GD" | grep -c 'trainwel:')"
check "a redacted seeded file is not recreated" "^OK \[redacted by owner" "$(call tok-a memory_read '{"path":"integrations/trainwel.md"}')"

# ---- daily write limit
BLOCK=""
for i in $(seq 1 90); do R="$(call tok-b board_post "{\"thread\":\"limit-test\",\"body\":\"n$i\"}")"; case "$R" in ERR*) BLOCK="$R"; break ;; esac; done
check "daily write limit enforced" "Daily write limit" "$BLOCK"
check "reads still work when blocked" "^OK" "$(call tok-b board_list_threads '{}')"
check "usage_stats" "codex/test.*writes=" "$(call tok-a usage_stats '{}')"
check "usage day resets at owner midnight" "resets at midnight \(America/Chicago\)" "$(call tok-a usage_stats '{}')"
check "limit alert sent to owner" "Usage limit reached" "$(cat "$WORK/mock.log")"

# ---- activity feed: events written by the Scheduler itself
LATE="$(call tok-h activity '{"kinds":["board"],"limit":200}')"
check "activity shows a delivered reminder" "\[reminder\].*#reminders: " "$LATE"
check "activity shows the usage-limit alert" "\[notification\] #owner: \[urgent\] Usage limit reached: codex/test" "$LATE"

# ---- monitoring (0.21): forced errors are recorded without secrets and reported in usage_stats
check "a forced tool exception is answered plainly" "^ERR Internal error in reminder_list" "$(call tok-h reminder_list '{"cancel_id":"FORCE-ERROR-TEST"}')"
call tok-h reminder_list '{"cancel_id":"FORCE-ERROR-TEST"}' > /dev/null
check "a forced exception in the Worker becomes a 500" "^500$" "$(curl -s -o /dev/null -w '%{http_code}' "$B/__force500")"
call tok-h notify_owner '{"subject":"force-notify-fail test","message":"x","severity":"info"}' > /dev/null
ERRS="$(call tok-h usage_stats '{}')"
check "usage_stats has an errors section" "Errors \(America/Chicago days" "$ERRS"
check "a tool exception is recorded with its tool name" "tool_exception reminder_list \(write\) x2" "$ERRS"
check "a 5xx is recorded by route label" "http_5xx GET other x1.*HTTP 500" "$ERRS"
check "a failed notification is recorded" "notification gchat x1.*webhook returned HTTP 500" "$ERRS"
check "recorded detail has bearer values redacted" "Bearer \[redacted\]" "$ERRS"
check "no token or secret appears in the errors" "^0$" "$(printf '%s' "$ERRS" | grep -c -e 'abcdefghijklmnopqrstuvwxyz0123456789' -e 'sk-abcdefghijklmnop' -e 'SECRETVALUE123' -e 'example.com' -e 'tok-h' -e 'tok-a')"
check "later lines of an error message are not recorded" "^0$" "$(printf '%s' "$ERRS" | grep -c 'client body text')"
check "the webhook address is not recorded" "^0$" "$(printf '%s' "$ERRS" | grep -c '127.0.0.1')"
check "validation refusals are not counted as errors" "^0$" "$(printf '%s' "$ERRS" | grep -c 'memory_write')"

# ---- usage metering and guards (0.26): live counters, Cloudflare's hourly figures (a mock here), thresholds and the pause
metric() { # label, text -> the live count shown on that meter's line
  printf '%s' "$2" | sed -nE "s/.*$1[^|]*live count ([0-9,]+).*/\1/p" | head -1 | tr -d ','
}
UL0="$(call tok-a usage_limits '{}')"
check "usage_limits lists the R2 meters" "R2 Class A operations.*R2 Class B operations.*R2 storage" "$UL0"
check "usage_limits lists Worker and Durable Object meters" "Worker requests.*Durable Object requests.*Durable Object rows read.*Workers KV writes" "$UL0"
check "usage_limits shows reset times in owner time" "resets [0-9-]+T1[89]:00:00-0[56]:00" "$UL0"
check "billed meters are marked" "R2 Class B operations \(reads\) \[billed over the allowance\]" "$UL0"
B0="$(metric 'R2 Class B operations' "$UL0")"
for _ in 1 2 3 4 5 6; do call tok-a memory_read '{"path":"playbooks/close.md"}' > /dev/null; done
UL1="$(call tok-a usage_limits '{}')"
B1="$(metric 'R2 Class B operations' "$UL1")"
check "the Class B counter rises with reads" "^1$" "$([ "${B1:-0}" -ge $(( ${B0:-0} + 6 )) ] && echo 1 || echo 0)"
check "the live count is shown" "live count" "$UL1"
check "Durable Object requests are counted" "Durable Object requests[^:]*: [1-9][0-9,]* of 100,000" "$UL1"
check "nothing is paused at normal readings" "Nothing is paused" "$UL1"
check "an agent cannot refresh Cloudflare's figures" "^ERR Only the owner can refresh" "$(call tok-a usage_limits '{"refresh":true}')"

curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__graphql/normal" > /dev/null
UR="$(call tok-h usage_limits '{"refresh":true}')"
check "the owner can refresh Cloudflare's figures" "Refreshed from Cloudflare's figures" "$UR"
check "the refresh sent the token" "GRAPHQL auth=yes level=normal" "$(cat "$WORK/mock.log")"
check "Cloudflare's figure is shown next to the live count" "Cloudflare [0-9,]+ as of [0-9T:+-]+" "$UR"
check "storage is read from Cloudflare's figures" "R2 storage \[billed over the allowance\]: 0.001 GB of 10.000 GB" "$UR"

# a simulated reading at 93 percent of the Class B allowance
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__graphql/high" > /dev/null
UH="$(call tok-h usage_limits '{"refresh":true}')"
check "a 90 percent reading pauses non-essential work" "PAUSED: R2 Class B operations \(reads\) at 9[0-9]%" "$UH"
check "the meter is flagged" "\*\* 90% or more \*\*" "$UH"
check "the owner is alerted at 90 percent" "Usage at 90%: R2 Class B" "$(cat "$WORK/mock.log")"
check "exports are refused while paused" "^ERR Exports are paused because a usage limit is nearly reached" "$(call tok-h bundle_export '{}')"
call tok-h usage_limits '{"refresh":true}' > /dev/null
check "a second reading does not alert again" "^1$" "$(grep -c 'Usage at 90%: R2 Class B' "$WORK/mock.log")"
check "other tools keep working while paused" "^OK" "$(call tok-a brain_ping '{}' | cut -c1-2)"

# back to normal: the pause clears by itself
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__graphql/normal" > /dev/null
check "the pause clears when the reading drops" "Nothing is paused" "$(call tok-h usage_limits '{"refresh":true}')"
check "exports work again" "^OK Exported [0-9]+ files" "$(call tok-h bundle_export '{}')"

# the storage ceiling
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__graphql/full" > /dev/null
UF="$(call tok-h usage_limits '{"refresh":true}')"
check "storage at the ceiling pauses exports" "PAUSED: .*R2 storage 9.000 GB has reached the ceiling of 8.000 GB" "$UF"
check "the owner is alerted at the ceiling" "R2 storage ceiling reached" "$(cat "$WORK/mock.log")"
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__graphql/normal" > /dev/null
call tok-h usage_limits '{"refresh":true}' > /dev/null

# a response that is missing datasets is a problem line, not a crash
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__graphql/bad" > /dev/null
UB="$(call tok-h usage_limits '{"refresh":true}')"
check "a response missing datasets is reported" "Refreshed, with [0-9]+ problem" "$UB"
check "the problem is recorded as an error" "analytics graphql x[0-9]+" "$(call tok-h usage_stats '{}')"
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__graphql/normal" > /dev/null
check "the readings recover" "Refreshed from Cloudflare's figures" "$(call tok-h usage_limits '{"refresh":true}')"
check "no analytics token appears in usage_limits" "^0$" "$(printf '%s' "$UB" | grep -c 'test-analytics-token')"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
