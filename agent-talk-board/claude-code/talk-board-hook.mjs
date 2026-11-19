#!/usr/bin/env node
// Claude Code hook for the agent talk board.
//
//   start  (SessionStart)  fetches brain_guide and injects it as context, so every session starts
//                          with the protocol and live structure without Claude having to decide to call it.
//   work   (PostToolUse on file edits)  marks the session as having done real work (edits to scratch,
//                  temp and .claude files do not count).
//   brain  (PostToolUse on talk-board writes)  clears that mark.
//   prompt (UserPromptSubmit)  if work happened with no talk-board write since, adds a quiet reminder to
//                  Claude's context once (no banner, no interrupted turn). This is the default nudge.
//   stop   (Stop)  does nothing unless TALK_BOARD_STOP_NUDGE=block, which restores the older behaviour:
//                  block once at the end of the turn and ask Claude to update the board/memory.
//
// Needs Node 18+ and two environment variables:
//   TALK_BOARD_URL    e.g. https://brain.<subdomain>.workers.dev/mcp
//   TALK_BOARD_TOKEN  the Claude Code token from AGENT_TOKENS
// A hook failure never blocks or breaks the session.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2] ?? "";

function readInput() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function fetchGuide() {
  const url = process.env.TALK_BOARD_URL;
  const token = process.env.TALK_BOARD_TOKEN;
  if (!url || !token) return "Talk board hook: TALK_BOARD_URL or TALK_BOARD_TOKEN is not set, so the protocol was not loaded. Call the talk-board brain_guide tool before starting work.";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brain_guide", arguments: {} } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `Talk board hook: brain_guide returned HTTP ${res.status}. Call the talk-board brain_guide tool before starting work.`;
    const text = await res.text();
    let message;
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      message = JSON.parse(text);
    } else {
      const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith("data: "));
      message = JSON.parse(dataLines[dataLines.length - 1].slice(6));
    }
    const guide = message?.result?.content?.[0]?.text;
    if (typeof guide !== "string") return "Talk board hook: brain_guide returned no text. Call the talk-board brain_guide tool before starting work.";
    return `Talk board protocol and structure (loaded automatically at session start; follow it):\n\n${guide.slice(0, 9000)}`;
  } catch (e) {
    return `Talk board hook: could not reach the talk board (${e?.name ?? "error"}). Call the talk-board brain_guide tool before starting work.`;
  }
}

const input = readInput();
const session = String(input.session_id ?? "nosession").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "nosession";
const flag = join(tmpdir(), `talk-board-${session}.pending`);
// Scratch work, temp files and Claude's own folders are not project work worth a note.
const SCRATCH_PATH = /[\\/](scratchpad|temp|tmp|\.claude)[\\/]/i;

try {
  if (mode === "start") {
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: await fetchGuide() } });
  } else if (mode === "work") {
    const edited = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    if (!SCRATCH_PATH.test(edited)) writeFileSync(flag, new Date().toISOString());
  } else if (mode === "brain") {
    if (existsSync(flag)) unlinkSync(flag);
  } else if (mode === "prompt") {
    if (existsSync(flag)) {
      unlinkSync(flag);
      emit({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext:
            "Talk board reminder: project files were changed since the last talk-board write. If that work produced a decision, lesson or status " +
            "another agent or a future session needs, record it now (board_post, memory_write, action_log for outside systems) and give the owner a one-line receipt. " +
            "If nothing qualifies, carry on without mentioning this reminder.",
        },
      });
    }
  } else if (mode === "stop") {
    if (process.env.TALK_BOARD_STOP_NUDGE === "block" && !input.stop_hook_active && existsSync(flag)) {
      unlinkSync(flag);
      emit({
        decision: "block",
        reason:
          "Before finishing, update the talk board if this work produced anything another agent or a future session should know: " +
          "board_post a status or handoff to the project's thread; memory_write durable facts, decisions or lessons as OKF concepts; " +
          "action_log any change you made in an outside system. Follow the protocol's rules on sensitivity and mirroring. " +
          "If nothing qualifies, say 'No talk-board update needed' and stop.",
      });
    }
  }
} catch {
  // never break the session
}
process.exit(0);
