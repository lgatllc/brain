import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/tasks.ts, run by tests/smoke.sh.
// Usage: node tests/tasks.test.mjs <path to bundled tasks.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};
const now = Date.parse("2026-11-25T12:00:00Z");
const HOUR = 3_600_000;

// days and ids
expect("days", [t.validDay("2026-02-28"), t.validDay("2026-02-30"), t.validDay("2026-13-01"), t.validDay("26-1-1")], [true, false, false, false], "valid days");
expect("days", t.TASK_ID_RE.test("2026-11-25-0a1b2c3d"), true, "task id shape");
expect("days", t.TASK_ID_RE.test("2026-11-25-xyz"), false, "task id shape rejects");

// recurrence
expect("recurrence", ["daily", "weekly", "monthly", "yearly", "every 3 days", "every 2 weeks", "every 6 months"].map(t.validRecurrence), [true, true, true, true, true, true, true], "valid rules");
expect("recurrence", ["", "hourly", "every 0 days", "every 100 days", "every days", "monthly on friday"].map(t.validRecurrence), [false, false, false, false, false, false], "invalid rules");
expect("recurrence", t.nextDue("monthly", "2026-11-15", "2026-11-25"), "2026-12-15", "monthly: next month");
expect("recurrence", t.nextDue("monthly", "2026-01-31", "2026-01-31"), "2026-02-28", "monthly from the 31st lands on the month's last day");
expect("recurrence", t.nextDue("monthly", "2026-01-31", "2026-03-01"), "2026-03-31", "monthly keeps the 31st afterwards");
expect("recurrence", t.nextDue("monthly", "2026-02-28", "2026-02-28", "2026-01-31"), "2026-03-31", "an anchor keeps the 31st after February");
expect("recurrence", t.nextDue("monthly", "2026-03-31", "2026-03-31", "2026-01-31"), "2026-04-30", "and April's last day");
expect("recurrence", t.nextDue("daily", "2026-11-20", "2026-11-25"), "2026-11-25", "a late daily task gets today, not an overdue date");
expect("recurrence", t.nextDue("daily", "2026-11-26", "2026-11-25"), "2026-11-27", "an early daily task gets the day after its due date");
expect("recurrence", t.nextDue("weekly", "2026-11-25", "2026-11-25"), "2026-12-02", "weekly");
expect("recurrence", t.nextDue("every 3 days", "2026-11-25", "2026-11-25"), "2026-11-28", "every N days");
expect("recurrence", t.nextDue("every 2 weeks", "2026-11-25", "2026-11-25"), "2026-12-09", "every N weeks");
expect("recurrence", t.nextDue("every 6 months", "2026-11-25", "2026-11-25"), "2027-05-25", "every N months");
expect("recurrence", t.nextDue("yearly", "2024-02-29", "2024-02-29"), "2025-02-28", "yearly from a leap day");
expect("recurrence", t.nextDue("fortnightly", "2026-11-25", "2026-11-25"), null, "bad rule");
expect("recurrence", t.nextDue("daily", "soon", "2026-11-25"), null, "bad date");

// leases
expect("lease", t.leaseExpired("claimed", new Date(now - HOUR).toISOString(), now), true, "past lease");
expect("lease", t.leaseExpired("in_progress", new Date(now + HOUR).toISOString(), now), false, "live lease");
expect("lease", t.leaseExpired("claimed", "", now), true, "a claim with no lease is expired");
expect("lease", t.leaseExpired("todo", "", now), false, "only claims have leases");
expect("lease", t.leaseExpired("review", new Date(now - HOUR).toISOString(), now), false, "review keeps its claimer");
expect("lease", t.effectiveState("claimed", new Date(now - HOUR).toISOString(), now), "todo", "an expired lease reads as todo");
expect("lease", t.effectiveState("claimed", new Date(now + HOUR).toISOString(), now), "claimed", "a live lease stays claimed");

// metadata round trip
const data = { title: "Close the books", state: "claimed", assignee: "codex/main", priority: "high", due: "2026-11-30", scheduled: "2026-11-28", lease_until: "2026-11-26T00:00:00.000Z", tags: ["close", "month-end"], created_by: "claude-code/main", recurrence: "monthly" };
const meta = t.taskMetadata(data, "2026-11-25T10:00:00.000Z");
expect("metadata", Object.values(meta).every((v) => typeof v === "string"), true, "all strings");
expect("metadata", JSON.stringify(meta).length < 1000, true, "far under R2's 2 KB");
const row = t.taskRowOf("tasks/2026-11-25-0a1b2c3d.md", meta);
expect("metadata", [row.id, row.title, row.state, row.priority, row.due, row.tags, row.rec, row.by], ["2026-11-25-0a1b2c3d", "Close the books", "claimed", "high", "2026-11-30", ["close", "month-end"], true, "claude-code/main"], "round trip");
expect("metadata", t.taskMetadata({ title: "x".repeat(500), tags: ["a".repeat(300)] }, "").title.length, 100, "long titles are cut");
expect("metadata", t.taskRowOf("tasks/x.md", undefined).state, "todo", "missing metadata reads as todo");

// listing, filtering and the agenda
const r = (id, o = {}) => ({ id, title: id, state: "todo", assignee: "", priority: "normal", due: "", scheduled: "", lease: "", updated: "", tags: [], by: "a/b", rec: false, next: "", ...o });
const rows = [
  r("t1", { due: "2026-12-01", priority: "low" }),
  r("t2", { due: "2026-11-27", priority: "urgent", tags: ["close"] }),
  r("t3", { due: "2026-11-27", priority: "normal", assignee: "codex/main" }),
  r("t4", { state: "done", due: "2026-11-20" }),
  r("t5", { state: "claimed", lease: new Date(now - HOUR).toISOString(), assignee: "codex/main" }),
  r("t6", { scheduled: "2026-12-03" }),
  r("t7", { state: "cancelled" }),
  r("t8", { state: "review", due: "2026-11-26" }),
];
const ids = (x) => x.map((y) => y.id);
expect("list", ids(t.filterTasks(rows, {}, now)), ["t8", "t2", "t3", "t1", "t5", "t6"], "open tasks: due soonest, then priority, no due last; done and cancelled left out");
expect("list", ids(t.filterTasks(rows, { includeClosed: true }, now)).includes("t4"), true, "closed tasks on request");
expect("list", ids(t.filterTasks(rows, { state: "done" }, now)), ["t4"], "a state filter shows that state");
expect("list", ids(t.filterTasks(rows, { state: "todo" }, now)).includes("t5"), true, "an expired lease counts as todo");
expect("list", ids(t.filterTasks(rows, { state: "claimed" }, now)), [], "and no longer as claimed");
expect("list", ids(t.filterTasks(rows, { assignee: "codex/main" }, now)), ["t3", "t5"], "by assignee");
expect("list", ids(t.filterTasks(rows, { tag: "close" }, now)), ["t2"], "by tag");
expect("list", ids(t.filterTasks(rows, { from: "2026-11-26", to: "2026-11-30" }, now)), ["t8", "t2", "t3"], "the agenda is a date range over due");
expect("list", ids(t.filterTasks(rows, { from: "2026-12-02", to: "2026-12-05" }, now)), ["t6"], "and over scheduled");
expect("list", t.describeTask(rows[4], now), "t5  [todo] (lease expired, free to claim) t5 (for codex/main)", "a lapsed claim is described as free");
expect("list", t.describeTask(rows[1], now), "t2  [todo] t2 (due 2026-11-27, urgent)", "a line");

// repeating tasks that still need their next instance
expect("next", [t.needsNext(r("a", { state: "done", rec: true })), t.needsNext(r("a", { state: "done", rec: true, next: "x" })), t.needsNext(r("a", { state: "todo", rec: true })), t.needsNext(r("a", { state: "done" }))], [true, false, false, false], "done, repeating, no next yet");

for (const k of ["days", "recurrence", "lease", "metadata", "list", "next"]) console.log(`${k}: ${groups[k]?.length ? "FAIL " + groups[k].join("; ") : "PASS"}`);
