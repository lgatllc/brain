import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/freshness.ts, run by tests/smoke.sh.
// Usage: node tests/freshness.test.mjs <path to bundled freshness.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const f = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};
const now = new Date("2026-11-24T12:00:00Z");
const ago = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();

// default periods by type
expect("periods", f.reviewDaysFor("Integration"), 180, "integration");
expect("periods", f.reviewDaysFor("Note"), 90, "note");
expect("periods", f.reviewDaysFor("capture"), 90, "capture, any case");
expect("periods", f.reviewDaysFor("Decision"), 365, "decision");
expect("periods", f.reviewDaysFor("Lesson"), 365, "lesson");
expect("periods", f.reviewDaysFor("Checklist"), 180, "checklist");
expect("periods", f.reviewDaysFor("Something else"), 180, "anything else");
expect("periods", f.reviewDaysFor(undefined), 180, "no type");
expect("periods", f.reviewDaysFor("Report"), null, "reports are exempt");

// the review date and its basis
const g = (days) => ({ by: "claude-code/main", at: ago(days) });
const gen90 = f.freshnessOf({ type: "Note", generated: g(100) }, now);
expect("dates", [gen90.state, gen90.basis, gen90.reviewAt], ["stale", "generated", new Date(Date.parse(ago(100)) + 90 * 86_400_000).toISOString()], "a note written 100 days ago is stale");
const ver = f.freshnessOf({ type: "Note", generated: g(100), verified: [{ by: "human:luke", at: ago(10) }] }, now);
expect("dates", [ver.state, ver.basis, ver.daysLeft], ["fresh", "verified", 80], "verifying it moves it back to fresh, counting from the verification");
const latest = f.freshnessOf({ type: "Playbook", generated: g(400), verified: [{ by: "a", at: ago(300) }, { by: "human:luke", at: ago(5) }, { by: "b", at: "nonsense" }] }, now);
expect("dates", [latest.state, latest.lastVerified], ["fresh", ago(5)], "the latest verification counts, a bad one is ignored");
const single = f.freshnessOf({ type: "Playbook", verified: { by: "human:luke", at: ago(1) } }, now);
expect("dates", single.state, "fresh", "a single verified entry (not a list)");
const expl = f.freshnessOf({ type: "Decision", generated: g(1), stale_after: ago(-30) }, now);
expect("dates", [expl.state, expl.basis, expl.periodDays], ["fresh", "stale_after", null], "stale_after wins over the default");
const expPast = f.freshnessOf({ type: "Decision", generated: g(1), stale_after: ago(2) }, now);
expect("dates", expPast.state, "stale", "past stale_after is stale");
const mod = f.freshnessOf({ type: "Note" }, now, ago(200));
expect("dates", [mod.state, mod.basis], ["stale", "modified"], "the file's modified time is the last resort");
const none = f.freshnessOf({ type: "Note" }, now);
expect("dates", [none.state, none.reviewAt, none.basis], ["unknown", null, "none"], "no dates at all");
const rep = f.freshnessOf({ type: "Report", generated: g(900) }, now);
expect("dates", rep.state, "exempt", "an old report is exempt");
const repExpl = f.freshnessOf({ type: "Report", stale_after: ago(1) }, now);
expect("dates", repExpl.state, "stale", "an explicit stale_after still applies to a report");
const bad = f.freshnessOf({ type: "Note", stale_after: "not a date", generated: g(1) }, now);
expect("dates", [bad.state, bad.basis], ["fresh", "generated"], "an unreadable stale_after is ignored");

// states at the edges
const edge = (days) => f.freshnessOf({ type: "Playbook", generated: g(180 - days) }, now).state;
expect("states", edge(30), "fresh", "30 days left");
expect("states", edge(15), "fresh", "15 days left");
expect("states", edge(14), "due", "14 days left is due");
expect("states", edge(1), "due", "1 day left");
expect("states", edge(0), "stale", "due today is stale");
expect("states", edge(-5), "stale", "5 days over");

// the search marker
expect("marker", f.freshnessMarker(ago(-60), now), "", "fresh shows nothing");
expect("marker", f.freshnessMarker(ago(-7), now), `review due ${ago(-7).slice(0, 10)}`, "due");
expect("marker", f.freshnessMarker(ago(3), now), `stale since ${ago(3).slice(0, 10)}`, "stale");
expect("marker", f.freshnessMarker("", now), "", "no date");
expect("marker", f.freshnessMarker("junk", now), "", "a bad date");

// the one-line description
const day = (iso) => iso.slice(0, 10);
expect("describe", f.describeFreshness(gen90, day).startsWith("STALE since "), true, "stale");
expect("describe", f.describeFreshness(ver, day).startsWith("fresh until "), true, "fresh");
expect("describe", f.describeFreshness(rep, day), "exempt (this type is never flagged for review)", "exempt");
expect("describe", f.describeFreshness(none, day), "unknown (no dates to work from)", "unknown");
expect("describe", f.describeFreshness(f.freshnessOf({ type: "Playbook", generated: g(170) }, now), day).includes("due for review by"), true, "due");

for (const k of ["periods", "dates", "states", "marker", "describe"]) console.log(`${k}: ${groups[k]?.length ? "FAIL " + groups[k].join("; ") : "PASS"}`);
