import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/trello.ts (noise filter) and scripts/trello-webhooks.mjs (planning), run by tests/smoke.sh.
// Usage: node tests/trello.test.mjs <path to bundled trello.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const w = await import(pathToFileURL(resolve("scripts/trello-webhooks.mjs")).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

// noise filter
const upd = (data, type = "updateCard") => ({ type, data });
expect("noise", t.isNoiseEvent(upd({ old: { pos: 100 } })), true, "position only");
expect("noise", t.isNoiseEvent(upd({ old: { pos: 1, dateLastActivity: "x" } })), true, "position and activity time");
expect("noise", t.isNoiseEvent(upd({ old: { pos: 1 } }, "updateList")), true, "list position");
expect("noise", t.isNoiseEvent(upd({ old: { pos: 1 }, listBefore: { name: "A" }, listAfter: { name: "B" } })), false, "a move to another list is kept");
expect("noise", t.isNoiseEvent(upd({ old: { pos: 1, name: "Old" } })), false, "rename with position is kept");
expect("noise", t.isNoiseEvent(upd({ old: { desc: "x" } })), false, "description change is kept");
expect("noise", t.isNoiseEvent(upd({ old: { closed: false } })), false, "archive is kept");
expect("noise", t.isNoiseEvent(upd({ old: { dueComplete: false } })), false, "completion is kept");
expect("noise", t.isNoiseEvent(upd({})), false, "no old data is kept");
expect("noise", t.isNoiseEvent(upd({ old: {} })), false, "empty old is kept");
expect("noise", t.isNoiseEvent(upd({ old: null })), false, "null old is kept");
expect("noise", t.isNoiseEvent({ type: "createCard", data: { old: { pos: 1 } } }), false, "other event types are kept");
expect("noise", t.isNoiseEvent({ type: "updateCard" }), false, "no data");
expect("noise", t.isNoiseEvent(undefined), false, "nothing");

// webhook planning
const cb = "https://brain.example.workers.dev/hooks/trello";
const boards = [{ id: "b1", name: "Projects" }, { id: "b2", name: "CRM" }, { id: "b3", name: "SOPs" }];
const hook = (id, idModel, extra = {}) => ({ id, idModel, callbackURL: cb, active: true, consecutiveFailures: 0, ...extra });
let p = w.planSync(boards, [], cb);
expect("plan", p.create.map((b) => b.id), ["b1", "b2", "b3"], "nothing watched");
p = w.planSync(boards, [hook("h1", "b1"), hook("h2", "b2"), hook("h3", "b3")], cb);
expect("plan", [p.create.length, p.ok.length, p.broken.length], [0, 3, 0], "all watched");
p = w.planSync(boards, [hook("h1", "b1")], cb);
expect("plan", [p.create.map((b) => b.id), p.ok.length], [["b2", "b3"], 1], "some missing");
p = w.planSync(boards, [hook("h1", "b1", { active: false }), hook("h2", "b2", { consecutiveFailures: 3, firstConsecutiveFailDate: "2026-11-20" }), hook("h3", "b3")], cb);
expect("plan", p.broken.map((x) => [x.board.id, x.problem]), [["b1", "inactive"], ["b2", "3 failed deliveries in a row since 2026-11-20"]], "broken hooks named");
expect("plan", p.ok.map((b) => b.id), ["b3"], "healthy one kept");
p = w.planSync(boards, [hook("h1", "b1"), hook("h1b", "b1")], cb);
expect("plan", p.duplicates.map((d) => d.hooks.length), [2], "duplicates reported");
expect("plan", p.create.map((b) => b.id), ["b2", "b3"], "duplicate still counts as watched");
p = w.planSync(boards, [{ ...hook("x", "b1"), callbackURL: "https://other.example/hooks/trello" }], cb);
expect("plan", [p.create.length, p.others.length], [3, 1], "a webhook for another address does not count and is left alone");
p = w.planSync(boards, [hook("gone", "closedboard")], cb);
expect("plan", p.orphaned.map((h) => h.id), ["gone"], "orphan reported");
expect("plan", w.hookProblem({ active: true, consecutiveFailures: 0 }), null, "healthy hook");

for (const g of ["noise", "plan"]) console.log(`${g}: ${groups[g]?.length ? "FAIL " + groups[g].join("; ") : "PASS"}`);
