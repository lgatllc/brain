import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/sweep.ts, run by tests/smoke.sh.
// Usage: node tests/sweep.test.mjs <path to bundled sweep.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const s = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};
const DAY = 86_400_000;
const now = Date.parse("2026-11-24T12:00:00Z");
const day = (t) => new Date(t).toISOString().slice(0, 10);
const iso = (days) => new Date(now + days * DAY).toISOString();
const concept = (path, o = {}) => ({ path, type: "Reference", status: "stable", reviewAt: iso(100), verified: iso(-1), reads7: 0, reads90: 0, lastRead: day(now), ...o });
const base = (o = {}) => ({
  now, trackingSince: "2026-11-24", day, concepts: [], lint: {}, captures: [], handoffs: [], approvals: [], threads: [], errors: [], backupFailed: null, ...o,
});
const cats = (r, c) => r.findings.filter((f) => f.category === c).map((f) => f.ref);

// stale and due, most read first
const r1 = s.buildSweep(base({ concepts: [
  concept("a.md", { reviewAt: iso(-10), reads90: 1 }),
  concept("b.md", { reviewAt: iso(-5), reads90: 9 }),
  concept("c.md", { reviewAt: iso(-20), reads90: 9 }),
  concept("d.md", { reviewAt: iso(3) }),
  concept("e.md", { reviewAt: iso(14) }),
  concept("f.md", { reviewAt: iso(15) }),
  concept("old.md", { reviewAt: iso(-50), status: "deprecated" }),
  concept("rep.md", { type: "Report", reviewAt: "" }),
] }));
expect("stale", cats(r1, "stale"), ["c.md", "b.md", "a.md"], "stale ranked by reads, then oldest date");
expect("stale", cats(r1, "due"), ["d.md", "e.md"], "due within 14 days, not 15");
expect("stale", cats(r1, "stale").includes("old.md"), false, "deprecated concepts are not flagged");
expect("stale", r1.findings.find((f) => f.ref === "b.md").note.startsWith("stale since 2026-11-19"), true, "the note says since when");

// never verified
const r2 = s.buildSweep(base({ concepts: [concept("v.md", { verified: null }), concept("w.md"), concept("rep.md", { type: "Report", reviewAt: "", verified: null })] }));
expect("unverified", cats(r2, "unverified"), ["v.md"], "only a reviewable, unverified concept");

// not read in 180 days: held back until tracking is old enough
const r3 = s.buildSweep(base({ concepts: [concept("n.md", { lastRead: null })] }));
expect("unused", cats(r3, "unused"), [], "not judged while tracking is new");
expect("unused", r3.notes.length, 1, "a note says why");
expect("unused", r3.notes[0].includes("2027-05-23"), true, "and when it starts");
const r4 = s.buildSweep(base({ trackingSince: "2026-01-01", concepts: [concept("old.md", { lastRead: "2026-04-01" }), concept("new.md", { lastRead: "2026-10-01" }), concept("never.md", { lastRead: null })] }));
expect("unused", cats(r4, "unused"), ["old.md", "never.md"], "old and never-read concepts once tracking is 180 days old");
expect("unused", r4.notes.length, 0, "no note then");
expect("unused", s.unusedAppliesFrom("2026-01-01", now, day), null, "applies");
expect("unused", s.unusedAppliesFrom(null, now, day), "2027-05-23", "no tracking yet: 180 days from now");

// open items
const r5 = s.buildSweep(base({
  captures: [{ path: "inbox/x.md", updated: iso(-8) }, { path: "inbox/y.md", updated: iso(-6) }],
  handoffs: [{ id: "h1", state: "open", lastActivity: iso(-8) }, { id: "h2", state: "closed", lastActivity: iso(-30) }, { id: "h3", state: "claimed", lastActivity: iso(-2) }],
  approvals: [{ id: "a1", action: "memory_delete", expires: iso(0.5) }, { id: "a2", action: "x", expires: iso(3) }, { id: "a3", action: "y", expires: iso(-1) }],
  threads: [{ thread: "quiet", last: iso(-31) }, { thread: "busy", last: iso(-2) }],
  errors: [{ kind: "tool_exception", source: "memory_read", n: 3 }],
}));
expect("items", cats(r5, "captures"), ["inbox/x.md"], "captures over 7 days");
expect("items", cats(r5, "handoffs"), ["h1"], "open handoff with no activity for 7 days; closed and recent ones are not");
expect("items", cats(r5, "approvals"), ["a1"], "only an approval expiring within 24 hours");
expect("items", cats(r5, "threads"), ["quiet"], "threads quiet over 30 days");
expect("items", cats(r5, "errors"), ["memory_read"], "errors");
expect("items", r5.counts.errors, 1, "counts");

// lint findings and the backup
const r6 = s.buildSweep(base({ lint: { "Broken links": ["a.md -> /gone.md"], "Past stale_after": ["b.md (2020-01-01)"], "Duplicate titles": [] }, backupFailed: "no network" }));
expect("lint", cats(r6, "lint"), ["a.md", "b.md"], "lint findings keep the path");
expect("lint", cats(r6, "backup"), ["github backup"], "a failed backup");
const r6b = s.buildSweep(base({ lint: { "Orphans (no inbound links)": ["references/trainwel/a.md", "notes/b.md"], "Broken links": ["c.md -> /gone.md"], "Duplicate titles": ["d.md: same as e.md"] } }));
expect("lint", cats(r6b, "lint"), ["notes/b.md", "c.md", "d.md"], "orphans under references/trainwel/ are not flagged, other orphans are");
expect("lint", r6b.findings.filter((f) => f.category === "lint").map((f) => f.note), ["Orphans (no inbound links)", "Broken links: -> /gone.md", "Duplicate titles: same as e.md"], "a note does not repeat the path");
expect("lint", s.buildSweep(base({ lint: null, trackingSince: "2026-01-01" })).notes, ["The bundle scan could not run."], "a scan that could not run is said so");

// urgent
const r7 = s.buildSweep(base({ concepts: [concept("hot.md", { reviewAt: iso(-1), reads7: 11 }), concept("warm.md", { reviewAt: iso(-1), reads7: 10 })], backupFailed: "x", approvals: [{ id: "a1", action: "memory_delete", expires: iso(0.5) }] }));
expect("urgent", r7.urgent.length, 3, "a heavily read stale concept, a failed backup and an expiring approval");
expect("urgent", r7.urgent.some((u) => u.startsWith("hot.md")), true, "more than ten reads this week");
expect("urgent", r7.urgent.some((u) => u.startsWith("warm.md")), false, "exactly ten is not enough");
expect("urgent", s.buildSweep(base()).urgent, [], "quiet brain");

// the report and summary line
const rep = s.renderReport("2026-11-24", r1);
expect("report", rep.includes("## Stale concepts (most read first) (3)"), true, "a section with its count");
expect("report", rep.includes("- `c.md`: stale since"), true, "each finding on a line");
expect("report", s.renderReport("2026-11-24", s.buildSweep(base({ trackingSince: "2026-01-01" }))).includes("Nothing to review."), true, "empty report");
expect("report", s.renderReport("2026-11-24", r1, 2).includes("...and 1 more"), true, "capped sections say how many more");
expect("report", s.summaryLine("2026-11-24", r1, "reports/sweeps/2026-11-24.md"), "Sweep 2026-11-24: 3 stale, 2 due. Report: /reports/sweeps/2026-11-24.md", "summary line");
expect("report", s.summaryLine("2026-11-24", s.buildSweep(base()), "p.md"), "Sweep 2026-11-24: nothing to review. Report: /p.md", "summary line when quiet");
expect("report", s.summaryLine("d", r7, "p.md").includes("URGENT: 3"), true, "summary line flags urgent");

for (const k of ["stale", "unverified", "unused", "items", "lint", "urgent", "report"]) console.log(`${k}: ${groups[k]?.length ? "FAIL " + groups[k].join("; ") : "PASS"}`);
