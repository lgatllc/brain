import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Checks claude-code/settings.hooks.json (PLAN.md 9.7): the matcher that clears the "work without a brain write" mark
// must accept the production and staging server names and nothing else.
// Usage: node tests/hooks.test.mjs <path to claude-code/settings.hooks.json>
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

console.log(`hooks matcher: ${problems.length ? "FAIL " + problems.join("; ") : "PASS"}`);
