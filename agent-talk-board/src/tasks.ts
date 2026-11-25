// Tasks (PLAN.md 2A): the pure rules. One file per task under tasks/<id>.md; the fields every list needs are kept in the file's R2
// custom metadata so task_list reads no files. The tools, the R2 reads and writes and the nightly repair are in src/index.ts.

import { addDays } from "./time";

export const TASKS = "tasks/";
export const TASK_STATES = ["todo", "claimed", "in_progress", "blocked", "review", "done", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const OPEN_STATES: readonly string[] = ["todo", "claimed", "in_progress", "blocked", "review"];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TASK_ID_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{8}$/;
export const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export const LEASE_DEFAULT_HOURS = 24;
export const LEASE_MAX_HOURS = 168;
export const TASK_LIST_MAX = 1000; // one R2 list page: tasks are never listed without a limit
export const TASK_REVIEW_DAYS = 7; // a task left in review this long shows in the sweep
const PRIORITY_RANK: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

/** What a task list needs about one task (all kept in R2 custom metadata, so no file is read to list). */
export interface TaskRow {
  id: string;
  title: string;
  state: string; // as stored
  assignee: string;
  priority: string;
  due: string; // YYYY-MM-DD or ""
  scheduled: string; // YYYY-MM-DD or ""
  lease: string; // ISO, "" when not claimed
  updated: string; // ISO of the last change
  tags: string[];
  by: string; // creator
  rec: boolean; // recurs
  next: string; // id of the next instance once a recurring task is done
}

export function validDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The custom metadata stored with a task file. Every value is a short string; the total stays far under R2's 2 KB limit. */
export function taskMetadata(data: Record<string, unknown>, updated: string): Record<string, string> {
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  const tags = Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === "string").join(",").slice(0, 200) : "";
  return {
    title: s(data.title, 100), state: s(data.state, 20), assignee: s(data.assignee, 100), priority: s(data.priority, 10),
    due: s(data.due, 10), scheduled: s(data.scheduled, 10), lease: s(data.lease_until, 40), updated: s(updated, 40),
    tags, by: s(data.created_by, 100), rec: data.recurrence ? "1" : "", next: s(data.next_id, 30),
  };
}

/** A list row from an object's key and custom metadata. */
export function taskRowOf(key: string, m: Record<string, string> | undefined): TaskRow {
  const x = m ?? {};
  return {
    id: key.slice(TASKS.length).replace(/\.md$/, ""), title: x.title ?? "", state: x.state ?? "todo", assignee: x.assignee ?? "", priority: x.priority ?? "normal",
    due: x.due ?? "", scheduled: x.scheduled ?? "", lease: x.lease ?? "", updated: x.updated ?? "",
    tags: x.tags ? x.tags.split(",").filter(Boolean) : [], by: x.by ?? "", rec: x.rec === "1", next: x.next ?? "",
  };
}

/** A claim whose lease has run out. A lapsed lease is treated as unclaimed when read. */
export function leaseExpired(state: string, lease: string, now: number): boolean {
  if (state !== "claimed" && state !== "in_progress") return false;
  const t = Date.parse(lease);
  return Number.isNaN(t) || t <= now;
}

/** The state to show and act on: a claim with an expired lease is back to todo. */
export function effectiveState(state: string, lease: string, now: number): string {
  return leaseExpired(state, lease, now) ? "todo" : state;
}

export interface TaskFilter {
  state?: string;
  assignee?: string;
  tag?: string;
  from?: string; // YYYY-MM-DD: the agenda range over due and scheduled
  to?: string;
  includeClosed?: boolean;
}

/** Filters rows (by effective state, assignee, tag, and a date range over due or scheduled) and orders them: due soonest, then priority, then id. */
export function filterTasks(rows: TaskRow[], f: TaskFilter, now: number): TaskRow[] {
  const out = rows.filter((r) => {
    const st = effectiveState(r.state, r.lease, now);
    if (f.state) {
      if (st !== f.state) return false;
    } else if (!f.includeClosed && (st === "done" || st === "cancelled")) return false;
    if (f.assignee && r.assignee !== f.assignee) return false;
    if (f.tag && !r.tags.includes(f.tag)) return false;
    if (f.from || f.to) {
      const days = [r.due, r.scheduled].filter(Boolean);
      if (!days.some((d) => (!f.from || d >= f.from) && (!f.to || d <= f.to))) return false;
    }
    return true;
  });
  return out.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || (PRIORITY_RANK[b.priority] ?? 1) - (PRIORITY_RANK[a.priority] ?? 1) || a.id.localeCompare(b.id));
}

/** One line per task for task_list. */
export function describeTask(r: TaskRow, now: number): string {
  const st = effectiveState(r.state, r.lease, now);
  const lapsed = st !== r.state ? " (lease expired, free to claim)" : "";
  const bits = [r.due ? `due ${r.due}` : "", r.scheduled ? `scheduled ${r.scheduled}` : "", r.priority !== "normal" ? r.priority : "", r.assignee ? `for ${r.assignee}` : "", r.rec ? "repeats" : ""].filter(Boolean);
  return `${r.id}  [${st}]${lapsed} ${r.title}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

// ---- recurrence: "daily", "weekly", "monthly", "yearly", or "every N days|weeks|months" (N 1 to 99)

const EVERY = /^every ([1-9][0-9]?) (day|week|month)s?$/;

export function validRecurrence(rule: string): boolean {
  return ["daily", "weekly", "monthly", "yearly"].includes(rule) || EVERY.test(rule);
}

/** `anchor` plus n months; a day that the month does not have (the 31st) becomes the month's last day, but the anchor day is kept for the next step. */
function addMonths(anchor: string, n: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(d, last))).toISOString().slice(0, 10);
}

/** The k-th occurrence after `anchor` (k = 1 is the next one). */
function occurrence(rule: string, anchor: string, k: number): string {
  if (rule === "daily") return addDays(anchor, k);
  if (rule === "weekly") return addDays(anchor, 7 * k);
  if (rule === "monthly") return addMonths(anchor, k);
  if (rule === "yearly") return addMonths(anchor, 12 * k);
  const m = EVERY.exec(rule);
  if (!m) return addDays(anchor, k);
  const n = Number(m[1]) * k;
  return m[2] === "day" ? addDays(anchor, n) : m[2] === "week" ? addDays(anchor, 7 * n) : addMonths(anchor, n);
}

/**
 * The due date of the next instance: the first occurrence (counted from `anchor`) after `due` that is not before `today`. A task finished late does not leave
 * the next one already overdue, and a daily task finished early gets tomorrow's. Returns null for a rule that is not valid.
 */
export function nextDue(rule: string, due: string, today: string, anchor: string = due): string | null {
  if (!validRecurrence(rule) || !validDay(due) || !validDay(anchor)) return null;
  // Occurrences are counted from the anchor (the first instance's due date), so a task due on the 31st is not pulled to the 28th for good by February.
  let k = 1;
  let next = occurrence(rule, anchor, k);
  while ((next <= due || next < today) && k < 2000) next = occurrence(rule, anchor, ++k);
  return next;
}

/** True when a done recurring task still needs its next instance. */
export function needsNext(r: TaskRow): boolean {
  return r.state === "done" && r.rec && !r.next;
}

// ---- the sweep's view of tasks (src/sweep.ts judges these)

export interface TaskFact {
  id: string;
  state: string;
  due: string;
  lease: string;
  updated: string;
}

export function taskFact(r: TaskRow): TaskFact {
  return { id: r.id, state: r.state, due: r.due, lease: r.lease, updated: r.updated };
}
