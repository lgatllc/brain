import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/search.ts, run by tests/smoke.sh.
// Usage: node tests/search.test.mjs <path to bundled search.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

expect("keys", ["memory/a.md", "memory/x/y.md", "memory/index.md", "memory/x/index.md", "memory/log.md", "memory/references/a.json", "board/t/m.md", "board/m.md", "handoffs/h1.md", "handoffs/x/y.md", "history/memory/a.md/1", "trash/a.md", "approvals/a.json", "files/2026/a.pdf"].map(t.isIndexedKey),
  [true, true, false, false, false, false, true, false, true, false, false, false, false, false], "which keys are indexed");

const c = t.searchDocFor("memory/playbooks/close.md", "---\ntype: Playbook\ntitle: Month-end close\ndescription: Steps for the close.\ntags:\n  - close\n  - finance\nstatus: deprecated\ngenerated:\n  by: claude-code/main\n  at: 2026-11-01T10:00:00.000Z\n---\n\n# Steps\n\nReconcile the bank first.\n");
expect("docs", [c.kind, c.path, c.title, c.tags, c.actor, c.updated, c.status], ["concept", "playbooks/close.md", "Month-end close", "close finance", "claude-code/main", "2026-11-01T10:00:00.000Z", "deprecated"], "a concept");
expect("docs", c.body.includes("Steps for the close.") && c.body.includes("Reconcile the bank first."), true, "the description and body are searchable");
expect("docs", c.body.includes("type: Playbook"), false, "the frontmatter is not in the body");

const b = t.searchDocFor("board/general/2026-11-02T09:00:00.000Z_claude-code_ab12.md", "---\nschema_version: 1\nactor: claude-code/main\nthread: general\nposted: 2026-11-02T09:00:00.000Z\n---\n\n**Decision** we pay vendors on the 15th.\n");
expect("docs", [b.kind, b.thread, b.actor, b.updated, b.title], ["board", "general", "claude-code/main", "2026-11-02T09:00:00.000Z", "Decision we pay vendors on the 15th."], "a board message");

const h = t.searchDocFor("handoffs/abc123.md", "---\ntitle: Finish the close\nfrom: claude-code/main\nthread: month-end\nstatus: open\ncreated: 2026-11-03T08:00:00.000Z\n---\n\n# Notes\n\nCheck the bank rec.\n");
expect("docs", [h.kind, h.path, h.title, h.thread, h.status], ["handoff", "abc123", "Finish the close", "month-end", "open"], "a handoff");
const cap = t.searchDocFor("memory/inbox/2026-11-23-ab12cd34.md", "---\ntype: Capture\ntitle: Demo moved\nstatus: draft\nstate: new\nkind: idea\ngenerated:\n  by: x/y\n  at: 2026-11-23T10:00:00.000Z\n---\n\nThe demo moved.\n");
expect("docs", [cap.state, cap.subkind, cap.status, cap.path], ["new", "idea", "draft", "inbox/2026-11-23-ab12cd34.md"], "a capture carries its state and kind");
expect("docs", [c.state, c.subkind], ["", ""], "an ordinary concept has none");
expect("docs", t.searchDocFor("memory/index.md", "x"), null, "index.md is not indexed");
expect("docs", t.searchDocFor("memory/bad.md", "---\n: : [\n---\nbody text").body, "body text", "broken frontmatter still indexes the body");
expect("docs", t.searchDocFor("memory/long.md", "x ".repeat(30000)).body.length <= 20000, true, "the body is capped");

expect("terms", t.searchTerms('Month-end "close" OR NEAR(x) * -y'), ["month", "end", "close", "or", "near", "x", "y"], "words only, no syntax");
expect("terms", t.searchTerms("   ").length, 0, "blank");
expect("terms", t.ftsMatch("pay vendors"), '"pay" "vendors"*', "all words, the last is a prefix");
expect("terms", t.ftsMatch('"; DROP TABLE x; --'), '"drop" "table" "x"*', "quotes and punctuation cannot become syntax");
expect("terms", t.ftsMatch("!!!"), null, "no words");
expect("terms", t.searchTerms("a b c d e f g h i j k l m n o p").length, 12, "at most 12 words");
expect("snippet", t.snippetFor("The quick brown fox jumps over the lazy dog", ["fox"]).includes("fox"), true, "the snippet holds the match");
expect("snippet", t.snippetFor("short", ["zzz"]), "short", "no match still gives the start");

for (const g of ["keys", "docs", "terms", "snippet"]) console.log(`${g}: ${groups[g]?.length ? "FAIL " + groups[g].join("; ") : "PASS"}`);
