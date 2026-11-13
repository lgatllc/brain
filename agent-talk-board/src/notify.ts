// What reaches the owner's notification channel (PLAN.md 4.9). Kept apart from index.ts so it can be unit-tested.

/** `urgent` sends only what needs attention, `summaries` adds each session summary, `all` adds every memory change. */
export type NotifyLevel = "urgent" | "summaries" | "all";
/** What kind of thing a notification is. Everything that existed before 0.24 is `urgent`. */
export type NotifyTier = "urgent" | "summaries" | "all";

export const DEFAULT_NOTIFY_LEVEL: NotifyLevel = "urgent";

const RANK: Record<NotifyLevel, number> = { urgent: 0, summaries: 1, all: 2 };

/** Reads the NOTIFY_LEVEL var. A missing or unknown value falls back to `urgent`, the quietest level. */
export function resolveNotifyLevel(value: string | undefined | null): NotifyLevel {
  const v = (value ?? "").trim().toLowerCase();
  return v === "summaries" || v === "all" || v === "urgent" ? v : DEFAULT_NOTIFY_LEVEL;
}

/** True when a notification of this tier is sent at this level. Urgent things are sent at every level. */
export function shouldPush(level: NotifyLevel, tier: NotifyTier): boolean {
  return RANK[tier] <= RANK[level];
}
