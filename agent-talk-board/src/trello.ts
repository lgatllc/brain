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
