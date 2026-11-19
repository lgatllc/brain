// Trello webhook helpers (PLAN.md 3T-1): which events are noise and are not worth a board post.

export interface TrelloEventShape {
  type?: string;
  data?: {
    old?: Record<string, unknown> | null;
    listBefore?: unknown;
    listAfter?: unknown;
  };
}

// Fields whose change alone says nothing the owner or an agent needs (a card dragged within its list, a counter ticking).
const NOISE_FIELDS = new Set(["pos", "dateLastActivity"]);

// True for events that should be acknowledged but not posted: a card or list that only changed position within its list.
// A move to another list carries listBefore and listAfter and is always kept.
export function isNoiseEvent(action: TrelloEventShape | undefined): boolean {
  if (!action || (action.type !== "updateCard" && action.type !== "updateList" && action.type !== "updateChecklist")) return false;
  const d = action.data;
  if (!d || d.listBefore || d.listAfter) return false;
  const old = d.old;
  if (!old || typeof old !== "object") return false; // unknown shape: keep it rather than lose something real
  const keys = Object.keys(old);
  return keys.length > 0 && keys.every((k) => NOISE_FIELDS.has(k));
}

const FIELD_LABELS: Record<string, string> = {
  name: "title",
  desc: "description",
  due: "due date",
  dueComplete: "completion",
  idList: "list",
  idLabels: "labels",
  idMembers: "members",
  idChecklists: "checklists",
  start: "start date",
  cover: "cover",
};

// Names of what an update changed, for the event post (for example ["title", "description"]).
// Shows only the names, never the old or new values (a description may hold details that should not be copied).
// `closed` becomes "archived" or "restored" from the card's new state; position and activity time are left out.
export function changedFields(action: (TrelloEventShape & { data?: { card?: { closed?: boolean } } }) | undefined): string[] {
  const old = action?.data?.old;
  if (!old || typeof old !== "object") return [];
  const out: string[] = [];
  for (const key of Object.keys(old)) {
    if (NOISE_FIELDS.has(key)) continue;
    if (key === "closed") out.push(action?.data?.card?.closed ? "archived" : "restored");
    else out.push(FIELD_LABELS[key] ?? (/^[A-Za-z]{1,30}$/.test(key) ? key : "other"));
  }
  return out.slice(0, 8);
}

// ---- webhook health (PLAN.md 3T-1b): is every open board covered by a working webhook?

export interface TrelloHook {
  id: string;
  idModel: string;
  callbackURL: string;
  active?: boolean;
  consecutiveFailures?: number;
  firstConsecutiveFailDate?: string | null;
}

export interface WebhookHealth {
  ok: boolean;
  problems: string[];
  boards: number;
  watched: number;
  member: "healthy" | "broken" | "none";
}

export function hookProblem(h: TrelloHook): string | null {
  if (h.active === false) return "inactive";
  if (Number(h.consecutiveFailures) > 0) return `${h.consecutiveFailures} failed deliveries in a row`;
  return null;
}

// A board counts as watched when a healthy webhook of ours covers it: its own, or the account-level one (idModel = member id).
// Webhooks that point at other addresses are ignored. Names come from Trello, so they are clipped.
export function webhookHealth(boards: { id: string; name: string }[], hooks: TrelloHook[], callbackURL: string, memberId: string): WebhookHealth {
  const ours = hooks.filter((h) => h.callbackURL === callbackURL);
  const memberHooks = ours.filter((h) => h.idModel === memberId);
  const memberHealthy = memberHooks.some((h) => !hookProblem(h));
  const member: WebhookHealth["member"] = memberHooks.length === 0 ? "none" : memberHealthy ? "healthy" : "broken";
  const problems: string[] = [];
  let watched = 0;
  const nameOf = (id: string) => boards.find((b) => b.id === id)?.name.slice(0, 80) ?? "a board that is no longer open";
  for (const b of boards) {
    const own = ours.filter((h) => h.idModel === b.id);
    if (memberHealthy || own.some((h) => !hookProblem(h))) watched++;
    else problems.push(`${b.name.slice(0, 80)}: no working webhook`);
  }
  for (const h of ours) {
    const p = hookProblem(h);
    if (!p) continue;
    problems.push(`webhook ${h.id.slice(0, 40)} (${h.idModel === memberId ? "account-level" : nameOf(h.idModel)}): ${p}`);
  }
  if (member === "none") problems.push("no account-level webhook, so boards created later are not watched until the webhook script is run");
  return { ok: problems.length === 0, problems, boards: boards.length, watched, member };
}
