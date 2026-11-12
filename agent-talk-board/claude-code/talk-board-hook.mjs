#!/usr/bin/env node
// Claude Code hook for the agent talk board.
//
//   start  (SessionStart)  fetches brain_guide and injects it as context, so every session starts
//                          with the protocol and live structure without Claude having to decide to call it.
//   work   (PostToolUse on file edits)  marks the session as having done real work.
//   brain  (PostToolUse on talk-board writes)  clears that mark.
//   stop   (Stop)  if work happened with no talk-board write since, blocks once and asks Claude
//                  to update the board/memory (or say nothing qualifies) before finishing.
//
// Needs Node 18+ and two environment variables:
//   TALK_BOARD_URL    e.g. https://agent-talk-board.<subdomain>.workers.dev/mcp
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

try {
  if (mode === "start") {
    emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: await fetchGuide() } });
  } else if (mode === "work") {
    writeFileSync(flag, new Date().toISOString());
  } else if (mode === "brain") {
    if (existsSync(flag)) unlinkSync(flag);
  } else if (mode === "stop") {
    if (!input.stop_hook_active && existsSync(flag)) {
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
