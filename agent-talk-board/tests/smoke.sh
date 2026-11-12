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
    -e 's#if (!url.startsWith("https://")) return#if (!url.startsWith("https://") \&\& !url.startsWith("http://127.0.0.1")) return#' \
    "$ROOT/src/index.ts" > "$WORK/src/index.ts"
cat > "$WORK/.dev.vars" << VARS
AGENT_TOKENS={"tok-a":"claude-code/test","tok-b":"codex/test","tok-h":"human:owner"}
OWNER_PASSWORD=correct-horse-battery-staple-123
GITHUB_TOKEN=test-token
GITHUB_REPO=o/r
NOTIFY_WEBHOOK_URL=http://127.0.0.1:$MOCK_PORT/notify
TRELLO_APP_SECRET=trello-secret-xyz
DAILY_WRITE_LIMIT=80
VARS

python3 "$ROOT/tests/mock-services.py" "$MOCK_PORT" "$WORK/mock.log" & MPID=$!
(cd "$WORK" && exec npx wrangler dev --port "$PORT" > "$WORK/wrangler.log" 2>&1) & WPID=$!
for _ in $(seq 1 60); do curl -s "$B/" 2>/dev/null | grep -q agent-talk-board && break; sleep 1; done

# ---- basics and auth
check "root page" "agent-talk-board" "$(curl -s "$B/")"
check "no token is 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/mcp" -d '{}')"
check "bad token is 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/mcp" -H 'Authorization: Bearer nope' -d '{}')"
check "28 tools listed" "^28$" "$(rpc tok-a '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["result"]["tools"]))')"
check "server instructions sent" "brain_guide" "$(rpc tok-a '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}')"

# ---- guide, seeds, integrations
G="$(call tok-a brain_guide '{}')"
check "brain_guide returns protocol" "Talk board operating protocol" "$G"
check "seeded integrations" "clientdb:.*trainwel:.*trello:" "$G"
check "integrations_list" "prefix=clientdb.*mirror=none" "$(call tok-a integrations_list '{}')"

# ---- board
check "board_post" "^OK Posted to general" "$(call tok-a board_post '{"thread":"general","body":"hello","tags":["intro"]}')"
check "board_post rejects credential" "^ERR .*credential" "$(call tok-a board_post '{"thread":"general","body":"key sk-abcdefghijklmnopqrstuvwx"}')"
check "board_post rejects unknown prefix" "^ERR Unknown resource prefix" "$(call tok-a board_post '{"thread":"general","body":"x","resource":"jira:ISSUE-1"}')"
check "board_read" "hello.*next_since" "$(call tok-a board_read '{"thread":"general"}')"
check "board_list_threads" "general" "$(call tok-a board_list_threads '{}')"

# ---- memory (OKF) and enforcement
check "memory_write create" "^OK Saved playbooks/close.md" "$(call tok-a memory_write '{"path":"playbooks/close.md","if_etag":"new","note":"initial","content":"---\ntype: Playbook\ntitle: Close\ndescription: v1\nverified: {by: \"human:faker\", at: \"2026-01-01T00:00:00Z\"}\n---\n\nversion one"}')"
check "forged verified stripped" "trust_tier: unverified" "$(call tok-a memory_read '{"path":"playbooks/close.md"}')"
check "generated stamped" "by: claude-code/test" "$(call tok-a memory_read '{"path":"playbooks/close.md"}')"
check "missing frontmatter rejected" "^ERR Missing YAML frontmatter" "$(call tok-a memory_write '{"path":"bad.md","if_etag":"new","content":"# nothing"}')"
check "client database mirror rejected" "^ERR .*mirror_policy: none" "$(call tok-a memory_write '{"path":"clients/acme.md","if_etag":"new","content":"---\ntype: Client\ntitle: Acme\nresource: clientdb:client/42\n---\n\nx"}')"
check "restricted rejected" "^ERR Restricted content" "$(call tok-a memory_write '{"path":"notes/x.md","if_etag":"new","content":"---\ntype: Note\nsensitivity: restricted\n---\n\nx"}')"
check "summary needs stale_after" "^ERR .*stale_after" "$(call tok-a memory_write '{"path":"sops/s.md","if_etag":"new","content":"---\ntype: SOP\ntitle: S\nresource: trainwel:article/7\n---\n\nx"}')"
check "duplicate prefix rejected" "^ERR .*(already used|protected)" "$(call tok-h memory_write '{"path":"integrations/jira.md","if_etag":"new","content":"---\ntype: Integration\nsystem: Jira\naccess: connector\ncredentials_location: connector\nresource_prefix: trello\nsensitivity: internal\nmirror_policy: summaries\nallowed_actors: [\"*\"]\n---\n\nx"}')"
check "root index has okf_version" "okf_version: \"0.2\"" "$(call tok-a memory_index '{}')"
check "log.md records creation" "Creation.*Close" "$(call tok-a memory_read '{"path":"log.md"}')"
E="$(etag tok-a playbooks/close.md)"
check "human verify" "human-reviewed" "$(call tok-h memory_verify "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\"}")"

# ---- history and restore
E="$(etag tok-a playbooks/close.md)"
check "overwrite" "^OK Saved" "$(call tok-a memory_write "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"content\":\"---\ntype: Playbook\ntitle: Close\ndescription: v2\n---\n\nversion two\"}")"
check "stale etag rejected" "^ERR Conflict" "$(call tok-a memory_write "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"content\":\"---\ntype: Playbook\n---\n\nx\"}")"
V="$(call tok-a memory_history '{"path":"playbooks/close.md"}' | grep -oE '20[0-9T:.Z-]+_[0-9a-f]+_[0-9a-f]+\.md' | head -1)"
check "history has a version" "\.md$" "$V"
E="$(etag tok-a playbooks/close.md)"
check "restore" "^OK Restored" "$(call tok-a memory_restore "{\"path\":\"playbooks/close.md\",\"version\":\"$V\",\"if_etag\":\"$E\"}")"

# ---- protected paths, approvals, delete
E="$(etag tok-a protocol.md)"
check "protected write refused" "^ERR protocol.md is protected" "$(call tok-a memory_write "{\"path\":\"protocol.md\",\"if_etag\":\"$E\",\"content\":\"---\ntype: Protocol\n---\n\nhijacked\"}")"
E="$(etag tok-a playbooks/close.md)"
check "delete needs approval" "^ERR This needs the owner" "$(call tok-a memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"reason\":\"t\"}")"
AID="$(call tok-a approval_request '{"action":"memory_delete","resource":"memory:/playbooks/close.md","reason":"obsolete"}' | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)"
check "approval pending" "pending" "$(call tok-a approval_status "{\"id\":\"$AID\"}")"
check "approval page renders" "Approval request" "$(curl -s "$B/approve/$AID")"
check "approval wrong password" "Wrong password" "$(curl -s -X POST "$B/approve/$AID" -d 'password=wrong&decision=approve')"
check "approval granted" "Request approved" "$(curl -s -X POST "$B/approve/$AID" --data-urlencode 'password=correct-horse-battery-staple-123' -d 'decision=approve')"
check "other actor cannot use approval" "^ERR .*requested by" "$(call tok-b memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"reason\":\"t\",\"approval_id\":\"$AID\"}")"
D="$(call tok-a memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"reason\":\"t\",\"approval_id\":\"$AID\"}")"
check "delete with approval" "^OK Deleted" "$D"
check "approval is single use" "^ERR .*(is used|Not found)" "$(call tok-a memory_delete "{\"path\":\"playbooks/close.md\",\"if_etag\":\"$E\",\"reason\":\"t\",\"approval_id\":\"$AID\"}")"
DV="$(printf '%s' "$D" | grep -oE '20[0-9T:.Z-]+_[0-9a-f]+_[0-9a-f]+\.md' | head -1)"
check "restore deleted file" "^OK Restored" "$(call tok-a memory_restore "{\"path\":\"playbooks/close.md\",\"version\":\"$DV\",\"if_etag\":\"new\"}")"

# ---- move, deprecate, lint, templates
check "write linking note" "^OK Saved" "$(call tok-a memory_write '{"path":"notes/a.md","if_etag":"new","content":"---\ntype: Note\ntitle: A\ndescription: links\n---\n\nSee [Close](/playbooks/close.md) and [B](/notes/b.md)."}')"
E="$(etag tok-a playbooks/close.md)"
check "move rewrites links" "Rewrote links in 1 file" "$(call tok-a memory_move "{\"from\":\"playbooks/close.md\",\"to\":\"playbooks/month-end-close.md\",\"if_etag\":\"$E\"}")"
check "link now points to new path" "/playbooks/month-end-close.md" "$(call tok-a memory_read '{"path":"notes/a.md"}')"
check "lint finds broken link" "Broken links.*notes/b.md" "$(call tok-a bundle_lint '{}')"
E="$(etag tok-a notes/a.md)"
check "deprecate" "^OK Deprecated" "$(call tok-a memory_deprecate "{\"path\":\"notes/a.md\",\"if_etag\":\"$E\",\"superseded_by\":\"playbooks/month-end-close.md\"}")"
check "templates list" "decision.*playbook" "$(call tok-a memory_templates '{}')"
check "template body" "type: Decision" "$(call tok-a memory_templates '{"type":"decision"}')"

# ---- handoffs
check "handoff_create" "^OK Created handoff" "$(call tok-a handoff_create '{"title":"Finish SOP","goal":"Publish","done":["draft"],"next":["review"],"resources":["trainwel:article/7"]}')"
HID="$(call tok-b handoff_resume '{}' | grep -oE '20[0-9-]+-[0-9a-f]{8}' | head -1)"
check "handoff listed" "^20" "$HID"
check "handoff claim" "state: claimed" "$(call tok-b handoff_resume "{\"id\":\"$HID\"}")"
check "handoff close by stranger refused" "^ERR Only the claimer" "$(call tok-h handoff_resume "{\"id\":\"$HID\",\"close\":true}")"
check "handoff close" "state: closed" "$(call tok-b handoff_resume "{\"id\":\"$HID\",\"close\":true,\"note\":\"done\"}")"

# ---- actions, notifications, reminders
check "action_log" "^OK Logged to actions" "$(call tok-a action_log '{"integration":"trello","action":"moved card","resource":"trello:card/abc","summary":"done"}')"
check "action_log violation" "^ERR .*violation" "$(call tok-a action_log '{"integration":"client-database","action":"updated","resource":"clientdb:client/42","summary":"x"}')"
check "notify_owner" "^OK Owner notified: sent" "$(call tok-a notify_owner '{"subject":"Test","message":"hello","severity":"warning"}')"
W="$(python3 -c 'import datetime;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=3)).isoformat())')"
check "reminder_set" "^OK Reminder" "$(call tok-a reminder_set "{\"when\":\"$W\",\"message\":\"check the close\"}")"
sleep 8
check "reminder delivered" "check the close" "$(call tok-a board_read '{"thread":"reminders"}')"

# ---- export and backup
L="$(call tok-a bundle_export '{}' | grep -oE "http://localhost:$PORT/exports/[0-9a-f-]+\.tar")"
curl -s "$L" -o "$WORK/export.tar"
check "export tar readable" "okf-bundle/protocol.md" "$(tar -tf "$WORK/export.tar" 2>&1)"
check "backup commits" "^OK Committed [0-9]+ changed" "$(call tok-a backup_status '{"run":true}')"
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
check "oauth wrong password" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cj.txt" -X POST "$B/authorize" -d "handle=$H&decision=approve&password=nope")"
LOC="$(curl -s -b "$WORK/cj.txt" -X POST "$B/authorize" --data-urlencode "handle=$H" -d 'decision=approve' --data-urlencode 'password=correct-horse-battery-staple-123' -o /dev/null -w '%{redirect_url}')"
CODE="$(printf '%s' "$LOC" | sed -n 's/.*code=\([^&]*\).*/\1/p')"
check "oauth code issued" "." "$CODE"
TOK="$(curl -s "$B/oauth/token" -d "grant_type=authorization_code&code=$CODE&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&client_id=$CID&code_verifier=$VER&resource=$RES" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))')"
check "oauth token posts as claude-ai/web" "claude-ai-web" "$(call "$TOK" board_post '{"thread":"general","body":"from oauth"}')"

# ---- daily write limit
BLOCK=""
for i in $(seq 1 90); do R="$(call tok-b board_post "{\"thread\":\"limit-test\",\"body\":\"n$i\"}")"; case "$R" in ERR*) BLOCK="$R"; break ;; esac; done
check "daily write limit enforced" "Daily write limit" "$BLOCK"
check "reads still work when blocked" "^OK" "$(call tok-b board_list_threads '{}')"
check "usage_stats" "codex/test.*writes=" "$(call tok-a usage_stats '{}')"
check "limit alert sent to owner" "Usage limit reached" "$(cat "$WORK/mock.log")"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ]
