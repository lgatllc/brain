import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Checks claude-code/settings.hooks.json (PLAN.md 9.7): the matcher that clears the "work without a brain write" mark
// must accept the production and staging server names and nothing else.
// It also runs the hook script itself (second argument) to check when it reminds, ignores scratch files and blocks.
// Usage: node tests/hooks.test.mjs <path to claude-code/settings.hooks.json> <path to claude-code/talk-board-hook.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const hooks = JSON.parse(readFileSync(resolve(process.argv[2]), "utf8")).hooks;
const problems = [];
const expect = (ok, label) => {
  if (!ok) problems.push(label);
};

const brainMatcher = hooks.PostToolUse.map((h) => h.matcher).find((m) => /board_post/.test(m));
expect(Boolean(brainMatcher), "no matcher for brain writes");
const matches = (name) => new RegExp(`^(?:${brainMatcher})$`).test(name);
expect(matches("mcp__talk-board__memory_write"), "talk-board writes must match");
expect(matches("mcp__brain-staging__board_post"), "staging writes must match");
expect(matches("mcp__brain-staging__action_log"), "staging action_log must match");
expect(!matches("mcp__brain-staging__memory_read"), "reads must not clear the mark");
expect(!matches("mcp__other-server__board_post"), "another server must not match");
expect(hooks.SessionStart?.[0]?.hooks?.[0]?.command.endsWith('talk-board-hook.mjs" start'), "session start hook missing");
expect(hooks.Stop?.[0]?.hooks?.[0]?.command.endsWith('talk-board-hook.mjs" stop'), "stop hook missing");
expect(/Edit/.test(hooks.PostToolUse[0].matcher), "file edits must mark the session as having done work");

expect(hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command.endsWith('talk-board-hook.mjs" prompt'), "prompt reminder hook missing");

// the script itself
const script = resolve(process.argv[3]);
const behaviour = [];
const check = (ok, label) => {
  if (!ok) behaviour.push(label);
};
const sid = `hooktest${process.pid}`;
const flagFile = join(tmpdir(), `talk-board-${sid}.pending`);
const run = (mode, input, env = {}) => {
  const r = spawnSync(process.execPath, [script, mode], { input: JSON.stringify({ session_id: sid, ...input }), env: { ...process.env, TALK_BOARD_STOP_NUDGE: "", ...env }, encoding: "utf8" });
  return { out: r.stdout, code: r.status };
};
const cleanup = () => existsSync(flagFile) && unlinkSync(flagFile);
const win = (p) => p.replaceAll("/", String.fromCharCode(92)); // Windows-style path from a forward-slash one
const project = win("C:/Users/x/brain/agent-talk-board/src/index.ts");
cleanup();
for (const p of [win("C:/Users/x/AppData/Local/Temp/48/claude/abc/scratchpad/edit.py"), "/tmp/x.py", win("C:/Users/x/.claude/projects/p/memory/m.md")]) {
  run("work", { tool_input: { file_path: p } });
  check(!existsSync(flagFile), `a scratch or Claude-folder edit must not mark work: ${p}`);
}
run("work", { tool_input: { file_path: project } });
check(existsSync(flagFile), "a project edit must mark work");
const stopDefault = run("stop", { stop_hook_active: false });
check(stopDefault.out === "" && stopDefault.code === 0, "stop must not block by default");
check(existsSync(flagFile), "stop by default must leave the mark for the reminder");
const first = run("prompt", {});
check(/Talk board reminder/.test(first.out) && /UserPromptSubmit/.test(first.out) && first.code === 0, "the next prompt must carry the reminder");
check(run("prompt", {}).out === "", "the reminder comes once");
run("work", { tool_input: { file_path: project } });
run("brain", {});
check(run("prompt", {}).out === "", "a brain write clears the mark, so no reminder");
run("work", { tool_input: { file_path: project } });
check(JSON.parse(run("stop", { stop_hook_active: false }, { TALK_BOARD_STOP_NUDGE: "block" }).out || "{}").decision === "block", "block mode must still block once");
run("work", { tool_input: { file_path: project } });
check(run("stop", { stop_hook_active: true }, { TALK_BOARD_STOP_NUDGE: "block" }).out === "", "block mode must not loop");
cleanup();

console.log(`hooks matcher: ${problems.length ? "FAIL " + problems.join("; ") : "PASS"}`);
console.log(`hooks behaviour: ${behaviour.length ? "FAIL " + behaviour.join("; ") : "PASS"}`);
