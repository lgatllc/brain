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
