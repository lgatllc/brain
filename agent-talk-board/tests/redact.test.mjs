import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/redact.ts, run by tests/smoke.sh against an esbuild bundle of that file.
// Usage: node tests/redact.test.mjs <path to bundled redact.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const check = (group, label, actual, expected) => {
  const g = (groups[group] ??= []);
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) g.push(`${label}: got ${a}, expected ${e}`);
};

// validateKey: only objects in the allowed prefixes, never server files, folders or approvals
const V = "validateKey";
for (const ok of ["memory/clients/acme.md", "memory/references/data.json", "board/general/2026-11-13T17:18:47.561Z_claude-code-test_db2aeae4.md", "history/notes/a.md/2026-11-13T17:18:47.561Z_0123abcd_9f8e7d6c.md", "trash/notes/a.md/2026-11-13T17:18:47.561Z_9f8e7d6c.md", "handoffs/2026-11-13-18c24611.md"]) {
  check(V, `allows ${ok}`, t.validateKey(ok), null);
}
for (const bad of ["", "approvals/abc.json", "exports/abc.tar", "meta/redactions.json", "memory/", "memory/protocol.md", "memory/log.md", "memory/index.md", "memory/notes/index.md", "memory/removals.md", "memory/notes/", "memory/../board/x.md", "memory//x.md", "memory/a b.md", "files/2026/11/x.pdf"]) {
  check(V, `refuses ${JSON.stringify(bad)}`, typeof t.validateKey(bad), "string");
}
check(V, "non-string", typeof t.validateKey(42), "string");

// expand: a memory file also covers its history versions and trash copies; nothing else does
const E = "expand";
check(E, "concept", t.expand("memory/notes/a.md", 1, 2).map((e) => [e.key, e.prefix]), [["memory/notes/a.md", false], ["history/notes/a.md/", true], ["trash/notes/a.md/", true]]);
check(E, "board message", t.expand("board/general/x.md", 1, 2).map((e) => [e.key, e.prefix]), [["board/general/x.md", false]]);
check(E, "history version", t.expand("history/notes/a.md/v1.md", 1, 2).map((e) => [e.key, e.prefix]), [["history/notes/a.md/v1.md", false]]);
check(E, "times carried", t.expand("memory/a.md", 5, 9)[0], { key: "memory/a.md", prefix: false, at: 5, purge_after: 9 });

// RedactionSet: exact keys and prefixes, and no false matches on look-alike names
const M = "RedactionSet";
const set = new t.RedactionSet(t.expand("memory/notes/a.md", 1, 2).concat(t.expand("board/general/x.md", 1, 2)));
check(M, "live file", set.match("memory/notes/a.md")?.key, "memory/notes/a.md");
check(M, "history version via prefix", set.match("history/notes/a.md/2026-11-13_abcd_ef01.md")?.key, "history/notes/a.md/");
check(M, "trash copy via prefix", set.match("trash/notes/a.md/2026_x.md")?.key, "trash/notes/a.md/");
check(M, "board message", set.match("board/general/x.md")?.key, "board/general/x.md");
check(M, "look-alike path is not matched", set.match("memory/notes/a.md.bak"), null);
check(M, "look-alike prefix is not matched", set.match("history/notes/ab.md/v1.md"), null);
check(M, "other board message is not matched", set.match("board/general/y.md"), null);
check(M, "under lists exact entries only", set.under("board/general/").map((e) => e.key), ["board/general/x.md"]);
check(M, "empty set", new t.RedactionSet().match("memory/a.md"), null);

// scrubLog: bullets about the redacted paths are replaced, other bullets and look-alikes are kept
const L = "scrubLog";
const log = [
  "# Bundle Update Log",
  "## 2026-11-13",
  "* **Creation**: [Secret title](/notes/a.md) by `claude-code/test`: secret note",
  "* **Update**: [Other](/notes/other.md) by `claude-code/test`",
  "* **Move**: /notes/old.md to [Moved title](/notes/a.md) by `claude-code/test`",
  "* **Deletion**: /notes/a.md by `claude-code/test`: secret reason",
  "* **Creation**: [Look-alike](/notes/a.md.bak) by `claude-code/test`",
  "* **Creation**: [Prefix](/notes/ab.md) by `claude-code/test`",
].join("\n");
const scrubbed = t.scrubLog(log, ["notes/a.md"]);
check(L, "changed count", scrubbed.changed, 3);
check(L, "secret title gone", scrubbed.text.includes("Secret title"), false);
check(L, "moved title gone", scrubbed.text.includes("Moved title"), false);
check(L, "secret note gone", scrubbed.text.includes("secret note") || scrubbed.text.includes("secret reason"), false);
check(L, "neutral line used", scrubbed.text.includes(t.LOG_REDACTED_LINE), true);
check(L, "other entries kept", scrubbed.text.includes("[Other](/notes/other.md)"), true);
check(L, "look-alikes kept", scrubbed.text.includes("/notes/a.md.bak") && scrubbed.text.includes("/notes/ab.md"), true);
check(L, "headings kept", scrubbed.text.startsWith("# Bundle Update Log\n## 2026-11-13"), true);
check(L, "no paths means no change", t.scrubLog(log, []).text, log);

// the backup copy: round trip, missing is empty, unreadable throws (callers fail closed)
const B = "mirror";
const entries = t.expand("memory/notes/a.md", 1, 2);
check(B, "round trip", t.parseMirror(t.serializeMirror(entries)), entries);
check(B, "missing is empty", t.parseMirror(null), []);
check(B, "blank is empty", t.parseMirror("  "), []);
for (const bad of ["not json", "{}", '{"entries":"x"}', '{"entries":[{"key":1}]}']) {
  let threw = false;
  try {
    t.parseMirror(bad);
  } catch {
    threw = true;
  }
  check(B, `unreadable ${bad} throws`, threw, true);
}

// shortId and placeholder
const S = "shortId and placeholder";
const a = await t.shortId("memory/notes/a.md");
check(S, "eight hex characters", /^[0-9a-f]{8}$/.test(a), true);
check(S, "stable", await t.shortId("memory/notes/a.md"), a);
check(S, "differs per key", (await t.shortId("memory/notes/b.md")) === a, false);
check(S, "does not contain the key", a.includes("notes"), false);
check(S, "placeholder", t.placeholder("2026-11-14"), "[redacted by owner on 2026-11-14]");
check(S, "kind of concept", t.kindOf("memory/notes/a.md"), "concept");
check(S, "kind of board message", t.kindOf("board/general/x.md"), "board message");
check(S, "kind of history version", t.kindOf("history/notes/a.md/v.md"), "history version");

let failed = 0;
for (const [group, problems] of Object.entries(groups)) {
  if (problems.length) failed++;
  console.log(`${group}: ${problems.length ? `FAIL ${problems.join("; ")}` : "PASS"}`);
}
process.exit(failed ? 1 : 0);
