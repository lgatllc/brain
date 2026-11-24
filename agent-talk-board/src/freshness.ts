// Freshness policy (PLAN.md 1C): when a concept is next due for review, and whether it is fresh, due or stale. Pure functions;
// the tools that show it (memory_read, search, freshness) are in src/index.ts.

export type FreshState = "fresh" | "due" | "stale" | "exempt" | "unknown";
export type FreshBasis = "stale_after" | "verified" | "generated" | "modified" | "none";

export interface Freshness {
  state: FreshState;
  reviewAt: string | null; // ISO instant the concept is next due for review
  basis: FreshBasis; // what the date was worked out from
  periodDays: number | null; // the default review period used (null when stale_after set it)
  lastVerified: string | null; // the most recent verification, ISO
  daysLeft: number | null; // whole days until the review date; negative once past it
}

/** The default review period by concept type (PLAN.md 1C). `null` means the type is never flagged (a generated report). */
export const DEFAULT_REVIEW_DAYS: Record<string, number | null> = {
  integration: 180,
  playbook: 180,
  reference: 180,
  protocol: 180,
  note: 90,
  capture: 90,
  decision: 365,
  lesson: 365,
  prompt: 180,
  skill: 180,
  workflow: 180,
  command: 180,
  checklist: 180,
  report: null,
};
export const FALLBACK_REVIEW_DAYS = 180;
export const DUE_WINDOW_DAYS = 14;
const DAY = 86_400_000;

export function reviewDaysFor(type: unknown): number | null {
  const key = typeof type === "string" ? type.trim().toLowerCase() : "";
  return key in DEFAULT_REVIEW_DAYS ? DEFAULT_REVIEW_DAYS[key] : FALLBACK_REVIEW_DAYS;
}

function when(v: unknown): number {
  return typeof v === "string" || v instanceof Date ? Date.parse(String(v)) : NaN;
}

/** The latest verification time in a `verified` field (one entry or a list), or null. */
export function lastVerifiedAt(verified: unknown): string | null {
  const list = Array.isArray(verified) ? verified : verified && typeof verified === "object" ? [verified] : [];
  let best = NaN;
  for (const e of list) {
    const t = when((e as { at?: unknown } | null)?.at);
    if (!Number.isNaN(t) && (Number.isNaN(best) || t > best)) best = t;
  }
  return Number.isNaN(best) ? null : new Date(best).toISOString();
}

/** A concept's review date and state. `modified` (the stored file's last-modified time) is the last resort when the concept has no dates. */
export function freshnessOf(data: Record<string, unknown>, now: Date, modified?: string): Freshness {
  const lastVerified = lastVerifiedAt(data.verified);
  const explicit = when(data.stale_after);
  let reviewMs = NaN;
  let basis: FreshBasis = "none";
  let periodDays: number | null = null;
  if (!Number.isNaN(explicit)) {
    reviewMs = explicit;
    basis = "stale_after";
  } else {
    periodDays = reviewDaysFor(data.type);
    if (periodDays === null) return { state: "exempt", reviewAt: null, basis: "none", periodDays: null, lastVerified, daysLeft: null };
    const gen = data.generated && typeof data.generated === "object" ? when((data.generated as Record<string, unknown>).at) : NaN;
    const mod = when(modified);
    const verifiedMs = lastVerified ? Date.parse(lastVerified) : NaN;
    if (!Number.isNaN(verifiedMs)) { reviewMs = verifiedMs + periodDays * DAY; basis = "verified"; }
    else if (!Number.isNaN(gen)) { reviewMs = gen + periodDays * DAY; basis = "generated"; }
    else if (!Number.isNaN(mod)) { reviewMs = mod + periodDays * DAY; basis = "modified"; }
  }
  if (Number.isNaN(reviewMs)) return { state: "unknown", reviewAt: null, basis: "none", periodDays, lastVerified, daysLeft: null };
  const left = reviewMs - now.getTime();
  const state: FreshState = left <= 0 ? "stale" : left <= DUE_WINDOW_DAYS * DAY ? "due" : "fresh";
  return { state, reviewAt: new Date(reviewMs).toISOString(), basis, periodDays, lastVerified, daysLeft: Math.floor(left / DAY) };
}

/** A short marker for search results: empty for fresh (and exempt or unknown) concepts. `reviewAt` is the stored ISO date. */
export function freshnessMarker(reviewAt: string, now: Date, day: (iso: string) => string = (iso) => iso.slice(0, 10)): string {
  const t = Date.parse(reviewAt);
  if (!reviewAt || Number.isNaN(t)) return "";
  const left = t - now.getTime();
  if (left <= 0) return `stale since ${day(reviewAt)}`;
  if (left <= DUE_WINDOW_DAYS * DAY) return `review due ${day(reviewAt)}`;
  return "";
}

const BASIS_TEXT: Record<FreshBasis, string> = {
  stale_after: "its stale_after date",
  verified: "its last verification plus the review period",
  generated: "when it was last written plus the review period (never verified)",
  modified: "when the file was last changed plus the review period (no dates in it)",
  none: "no date",
};

/** One line for memory_read and the freshness tool, with the owner-facing date (`day` formats an instant in owner time). */
export function describeFreshness(f: Freshness, day: (iso: string) => string): string {
  if (f.state === "exempt") return "exempt (this type is never flagged for review)";
  if (f.state === "unknown" || !f.reviewAt) return "unknown (no dates to work from)";
  const when = day(f.reviewAt);
  const left = f.daysLeft ?? 0;
  const how = f.state === "stale" ? `STALE since ${when} (${-left} day${left === -1 ? "" : "s"} ago)` : f.state === "due" ? `due for review by ${when} (${left} day${left === 1 ? "" : "s"} left)` : `fresh until ${when}`;
  return `${how}, from ${BASIS_TEXT[f.basis]}`;
}
