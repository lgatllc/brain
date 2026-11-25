// The nightly mechanical sweep (PLAN.md 1C): which findings it makes, how they are ranked, what is urgent, and how the report and
// the one-line summary read. Pure functions: the Scheduler (src/index.ts) gathers the facts and writes the report. Findings carry
// paths, ids and counts, never titles or snippets, so a redaction cannot leave content behind in them.

export const SWEEP_DUE_DAYS = 14;
export const SWEEP_UNUSED_DAYS = 180;
export const SWEEP_CAPTURE_DAYS = 7;
export const SWEEP_HANDOFF_DAYS = 7;
export const SWEEP_THREAD_DAYS = 30;
export const SWEEP_APPROVAL_HOURS = 24;
export const SWEEP_URGENT_READS = 10; // reads in the last 7 days that make a stale concept urgent
const DAY = 86_400_000;

export const SWEEP_CATEGORIES = [
  "stale", "due", "unverified", "unused", "lint", "captures", "handoffs", "approvals", "threads", "errors", "backup",
] as const;
export type SweepCategory = (typeof SWEEP_CATEGORIES)[number];

export const CATEGORY_TITLES: Record<SweepCategory, string> = {
  stale: "Stale concepts (most read first)",
  due: "Concepts due for review within 14 days",
  unverified: "Concepts never verified",
  unused: "Concepts not read in 180 days",
  lint: "Bundle lint findings",
  captures: "Captures untriaged for more than 7 days",
  handoffs: "Handoffs with no activity for 7 days",
  approvals: "Approvals expiring within 24 hours",
  threads: "Threads with no new messages for 30 days",
  errors: "Yesterday's errors",
  backup: "Backup",
};

export interface SweepConcept {
  path: string;
  type: string;
  status: string;
  reviewAt: string; // ISO, from the freshness policy ("" when exempt or unknown)
  verified: string | null; // last verification, ISO
  reads7: number;
  reads90: number;
  lastRead: string | null; // owner day of the last read, kept without a limit
}

export interface SweepInput {
  now: number;
  trackingSince: string | null; // owner day the first read was recorded
  day: (ms: number) => string; // an instant in owner time, YYYY-MM-DD
  concepts: SweepConcept[];
  lint: Record<string, string[]> | null; // bundle_lint findings; null when the scan could not run
  captures: { path: string; updated: string }[]; // untriaged captures
  handoffs: { id: string; state: string; lastActivity: string }[];
  approvals: { id: string; action: string; expires: string }[]; // pending ones
  threads: { thread: string; last: string }[]; // newest message per thread
  errors: { kind: string; source: string; n: number }[];
  backupFailed: string | null; // the failure text, or null
}

export interface Finding {
  category: SweepCategory;
  ref: string; // a path, handoff id, approval id, thread or error source
  note: string;
}

export interface SweepResult {
  findings: Finding[];
  counts: Record<SweepCategory, number>;
  urgent: string[]; // one short line per urgent thing
  notes: string[]; // things the sweep could not judge yet
}

const ms = (iso: string): number => Date.parse(iso);

/** Whether "not read in 180 days" can be judged yet: read tracking must itself be 180 days old. Returns the day it begins to apply, or null when it applies now. */
export function unusedAppliesFrom(trackingSince: string | null, now: number, day: (ms: number) => string): string | null {
  if (!trackingSince) return day(now + SWEEP_UNUSED_DAYS * DAY);
  const start = Date.parse(`${trackingSince}T12:00:00Z`) + SWEEP_UNUSED_DAYS * DAY;
  return start <= now ? null : day(start);
}

export function buildSweep(input: SweepInput): SweepResult {
  const { now } = input;
  const findings: Finding[] = [];
  const urgent: string[] = [];
  const notes: string[] = [];
  const add = (category: SweepCategory, ref: string, note: string) => findings.push({ category, ref, note });
  const live = input.concepts.filter((c) => c.status !== "deprecated");

  // Stale and due, heavily read first.
  const reviewable = live.filter((c) => c.reviewAt && !Number.isNaN(ms(c.reviewAt)));
  const stale = reviewable.filter((c) => ms(c.reviewAt) <= now).sort((a, b) => b.reads90 - a.reads90 || ms(a.reviewAt) - ms(b.reviewAt));
  for (const c of stale) add("stale", c.path, `stale since ${input.day(ms(c.reviewAt))}; ${c.reads90} read${c.reads90 === 1 ? "" : "s"} in 90 days`);
  const due = reviewable.filter((c) => ms(c.reviewAt) > now && ms(c.reviewAt) - now <= SWEEP_DUE_DAYS * DAY).sort((a, b) => b.reads90 - a.reads90 || ms(a.reviewAt) - ms(b.reviewAt));
  for (const c of due) add("due", c.path, `review due ${input.day(ms(c.reviewAt))}; ${c.reads90} read${c.reads90 === 1 ? "" : "s"} in 90 days`);
  for (const c of stale) if (c.reads7 > SWEEP_URGENT_READS) urgent.push(`${c.path} is stale and was read ${c.reads7} times this week`);

  // Never verified (reports are exempt from review, so they are not asked to be verified either).
  for (const c of live.filter((c) => !c.verified && c.reviewAt)) add("unverified", c.path, "never verified");

  // Not read in 180 days, once tracking is old enough to know.
  const from = unusedAppliesFrom(input.trackingSince, now, input.day);
  if (from) notes.push(`"Not read in ${SWEEP_UNUSED_DAYS} days" is not judged yet: read tracking began ${input.trackingSince ?? "today"}, so it starts on ${from}.`);
  else {
    const cutoff = input.day(now - SWEEP_UNUSED_DAYS * DAY);
    for (const c of live.filter((c) => c.lastRead === null || c.lastRead < cutoff)) add("unused", c.path, c.lastRead ? `last read ${c.lastRead}` : "not read since tracking began");
  }

  // Lint.
  if (input.lint) {
    for (const [name, items] of Object.entries(input.lint)) {
      for (const i of items) {
        const ref = i.split(/ -> | \(|: /)[0];
        // Trainwel summaries are reached through the Trainwel catalog, not by links, so having no inbound link is normal for them.
        if (name.startsWith("Orphans") && ref.startsWith("references/trainwel/")) continue;
        const rest = i.slice(ref.length).replace(/^:\s*/, "").trim(); // the path is already the finding's ref
        add("lint", ref, rest ? `${name}: ${rest}` : name);
      }
    }
  } else {
    notes.push("The bundle scan could not run.");
  }

  for (const c of input.captures) {
    const t = ms(c.updated);
    if (!Number.isNaN(t) && now - t > SWEEP_CAPTURE_DAYS * DAY) add("captures", c.path, `untriaged since ${input.day(t)}`);
  }
  for (const h of input.handoffs) {
    const t = ms(h.lastActivity);
    if (h.state !== "closed" && !Number.isNaN(t) && now - t > SWEEP_HANDOFF_DAYS * DAY) add("handoffs", h.id, `${h.state || "open"}; no activity since ${input.day(t)}`);
  }
  for (const a of input.approvals) {
    const t = ms(a.expires);
    if (!Number.isNaN(t) && t > now && t - now <= SWEEP_APPROVAL_HOURS * 3_600_000) {
      add("approvals", a.id, `${a.action}; expires ${input.day(t)}`);
      urgent.push(`approval ${a.id} (${a.action}) expires within 24 hours`);
    }
  }
  for (const t of input.threads) {
    const last = ms(t.last);
    if (!Number.isNaN(last) && now - last > SWEEP_THREAD_DAYS * DAY) add("threads", t.thread, `no new messages since ${input.day(last)}`);
  }
  for (const e of input.errors) add("errors", e.source, `${e.kind}: ${e.n} time${e.n === 1 ? "" : "s"}`);
  if (input.backupFailed) {
    add("backup", "github backup", input.backupFailed);
    urgent.push("the last GitHub backup failed");
  }

  const counts = Object.fromEntries(SWEEP_CATEGORIES.map((c) => [c, 0])) as Record<SweepCategory, number>;
  for (const f of findings) counts[f.category]++;
  return { findings, counts, urgent, notes };
}

/** The one line posted to the review thread. */
export function summaryLine(day: string, result: SweepResult, reportPath: string): string {
  const parts = SWEEP_CATEGORIES.filter((c) => result.counts[c] > 0).map((c) => `${result.counts[c]} ${c}`);
  const body = parts.length ? parts.join(", ") : "nothing to review";
  return `Sweep ${day}: ${body}.${result.urgent.length ? ` URGENT: ${result.urgent.length}.` : ""} Report: /${reportPath}`;
}

/** The report's Markdown body (the Scheduler adds the frontmatter). Each section lists at most `cap` items. */
export function renderReport(day: string, result: SweepResult, cap = 40): string {
  const out: string[] = [`# Sweep ${day}`, ""];
  if (result.urgent.length) out.push("## Urgent", "", ...result.urgent.map((u) => `- ${u}`), "");
  if (result.notes.length) out.push("## Not judged", "", ...result.notes.map((n) => `- ${n}`), "");
  for (const cat of SWEEP_CATEGORIES) {
    const items = result.findings.filter((f) => f.category === cat);
    if (!items.length) continue;
    out.push(`## ${CATEGORY_TITLES[cat]} (${items.length})`, "");
    for (const f of items.slice(0, cap)) out.push(`- \`${f.ref}\`: ${f.note}`);
    if (items.length > cap) out.push(`- ...and ${items.length - cap} more (sweep_report lists them all)`);
    out.push("");
  }
  if (!result.findings.length && !result.notes.length) out.push("Nothing to review.", "");
  return out.join("\n").trimEnd() + "\n";
}
