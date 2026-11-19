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

// changed fields
const ch = (data) => t.changedFields({ type: "updateCard", data });
expect("changed", ch({ old: { name: "x", desc: "y" } }), ["title", "description"], "title and description");
expect("changed", ch({ old: { due: null, dueComplete: false } }), ["due date", "completion"], "due and completion");
expect("changed", ch({ old: { pos: 5 } }), [], "position only");
expect("changed", ch({ old: { closed: false }, card: { closed: true } }), ["archived"], "archived");
expect("changed", ch({ old: { closed: true }, card: { closed: false } }), ["restored"], "restored");
expect("changed", ch({ old: { idList: "a", pos: 1 }, listBefore: {}, listAfter: {} }), ["list"], "list move");
expect("changed", ch({ old: { someNewField: 1 } }), ["someNewField"], "unknown field name kept");
expect("changed", ch({ old: { "weird key; drop": 1 } }), ["other"], "odd key hidden");
expect("changed", ch({}), [], "no old data");
expect("changed", t.changedFields(undefined), [], "nothing");
expect("changed", ch({ old: { name: "a secret title" } }).join(" ").includes("secret"), false, "values never shown");

// webhook health
const hcb = "https://brain.example.workers.dev/hooks/trello";
const hb = [{ id: "b1", name: "Projects" }, { id: "b2", name: "CRM" }];
const hh = (id, idModel, extra = {}) => ({ id, idModel, callbackURL: hcb, active: true, consecutiveFailures: 0, ...extra });
let h = t.webhookHealth(hb, [hh("h1", "b1"), hh("h2", "b2"), hh("hm", "m1")], hcb, "m1");
expect("health", [h.ok, h.watched, h.member, h.problems], [true, 2, "healthy", []], "everything healthy");
h = t.webhookHealth(hb, [hh("hm", "m1")], hcb, "m1");
expect("health", [h.ok, h.watched], [true, 2], "the account-level webhook alone covers every board");
h = t.webhookHealth(hb, [hh("h1", "b1"), hh("h2", "b2")], hcb, "m1");
expect("health", [h.ok, h.watched, h.member], [false, 2, "none"], "board hooks cover boards but no account-level hook is reported");
expect("health", h.problems.length, 1, "only the missing account-level hook is a problem");
h = t.webhookHealth(hb, [hh("h1", "b1")], hcb, "m1");
expect("health", [h.watched, h.problems.includes("CRM: no working webhook")], [1, true], "an uncovered board is named");
h = t.webhookHealth(hb, [hh("h1", "b1", { active: false }), hh("h2", "b2"), hh("hm", "m1")], hcb, "m1");
expect("health", [h.ok, h.watched, h.problems], [false, 2, ["webhook h1 (Projects): inactive"]], "a broken board hook is named, boards stay covered by the account hook");
h = t.webhookHealth(hb, [hh("hm", "m1", { consecutiveFailures: 4 }), hh("h1", "b1"), hh("h2", "b2")], hcb, "m1");
expect("health", [h.member, h.watched, h.problems], ["broken", 2, ["webhook hm (account-level): 4 failed deliveries in a row"]], "a failing account hook is reported");
h = t.webhookHealth(hb, [hh("hm", "m1", { active: false }), hh("h1", "b1", { active: false })], hcb, "m1");
expect("health", [h.watched, h.problems.length], [0, 4], "nothing working: both boards and both hooks reported");
h = t.webhookHealth(hb, [{ ...hh("x", "b1"), callbackURL: "https://other.example/hooks/trello" }], hcb, "m1");
expect("health", [h.watched, h.member], [0, "none"], "a webhook for another address does not count");
h = t.webhookHealth(hb, [], hcb, "m1");
expect("health", [h.watched, /ties a webhook to the token that created it/.test(h.problems[0] ?? "")], [0, true], "a token with no webhooks at all says why first");
h = t.webhookHealth(hb, [{ ...hh("x", "b1"), callbackURL: "https://other.example/hooks/trello" }], hcb, "m1");
expect("health", /ties a webhook/.test(h.problems.join(" ")), false, "the token hint is only for a token with no webhooks at all");
h = t.webhookHealth([], [], hcb, "m1");
expect("health", [h.boards, h.watched], [0, 0], "no boards");

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
expect("plan", p.orphaned.map((h) => h.id), ["gone"], "orphan reported (again, with a member id passed)");
p = w.planSync(boards, [hook("hm", "m1"), hook("gone", "closedboard")], cb, "m1");
expect("plan", [p.orphaned.map((h) => h.id), p.member], [["gone"], "healthy"], "the account-level webhook is not an orphan");
p = w.planSync(boards, [hook("hm", "m1", { active: false })], cb, "m1");
expect("plan", [p.orphaned.length, p.member], [0, "broken"], "a broken account-level webhook is reported as such");
p = w.planSync(boards, [], cb, "m1");
expect("plan", p.member, "none", "no account-level webhook");
// when to look again
expect("recheck", [t.clampTrelloCheck(1000, 1000 + 86_400_000, false), t.clampTrelloCheck(1000, 1000 + 86_400_000, true), t.clampTrelloCheck(1000, 1000 + 1_000_000, false), t.clampTrelloCheck(1000, 0, false)], [61_000, 1000 + 86_400_000, 1000 + 1_000_000, 0], "an unhealthy result with a far-off check is pulled forward; a healthy one or a near one is left alone");
expect("recheck", [t.nextTrelloCheck(1000, true), t.nextTrelloCheck(1000, false)], [1000 + 86_400_000, 1000 + 3_600_000], "a day after a clean check, an hour after a problem");
expect("plan", w.hookProblem({ active: true, consecutiveFailures: 0 }), null, "healthy hook");

for (const g of ["noise", "changed", "health", "plan", "recheck"]) console.log(`${g}: ${groups[g]?.length ? "FAIL " + groups[g].join("; ") : "PASS"}`);
