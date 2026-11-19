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
  if (hooks.length === 0) {
    // Trello lists a token's own webhooks only, so a replaced token looks like "no webhooks at all".
    problems.unshift("this token has created no webhooks. Trello ties a webhook to the token that created it, so if TRELLO_TOKEN was replaced, run scripts/trello-webhooks.mjs sync --apply and member --apply with the current token");
  }
  if (member === "none") problems.push("no account-level webhook, so boards created later are not watched until the webhook script is run");
  return { ok: problems.length === 0, problems, boards: boards.length, watched, member };
}

// When to run the next webhook check: a day after a clean one, an hour after a problem or a failure, so a fixed
// problem clears within the hour instead of waiting for the next day.
export function nextTrelloCheck(now: number, healthy: boolean): number {
  return now + (healthy ? 86_400_000 : 3_600_000);
}

// A check scheduled before the hourly rule existed may be a day away while its last result still shows a problem.
// Reading the result then brings the next check forward to a minute from now.
export function clampTrelloCheck(now: number, next: number, healthy: boolean): number {
  return !healthy && next > now + 3_600_000 ? now + 60_000 : next;
}

// ---- awareness cache (PLAN.md 3T-2): boards, lists and open cards, kept to titles, places, dates and labels.
// No descriptions, comments or attachments are cached; `trello_card_get` reads those live.

export const TRELLO_CARD_CAP = 3000;
export const CARD_FIELDS = "name,idList,idBoard,due,dueComplete,shortLink,dateLastActivity,closed,labels";

export interface CardRow {
  id: string;
  board_id: string;
  list_id: string;
  name: string;
  due: string | null;
  due_complete: number;
  labels: string[];
  short_link: string;
  last_activity: string | null;
  closed: boolean;
}

const TRELLO_ID = /^[A-Za-z0-9]{1,40}$/;
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 30) : null);

export function parseCard(raw: unknown): CardRow | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !TRELLO_ID.test(r.id)) return null;
  if (typeof r.idBoard !== "string" || !TRELLO_ID.test(r.idBoard) || typeof r.idList !== "string" || !TRELLO_ID.test(r.idList)) return null;
  const labels = Array.isArray(r.labels) ? r.labels.map((l) => str((l as { name?: unknown })?.name, 60)).filter(Boolean).slice(0, 10) : [];
  return {
    id: r.id,
    board_id: r.idBoard,
    list_id: r.idList,
    name: str(r.name, 300),
    due: isoOrNull(r.due),
    due_complete: r.dueComplete === true ? 1 : 0,
    labels,
    short_link: /^[A-Za-z0-9]{1,20}$/.test(str(r.shortLink, 20)) ? str(r.shortLink, 20) : "",
    last_activity: isoOrNull(r.dateLastActivity),
    closed: r.closed === true,
  };
}

export function parseList(raw: unknown): { id: string; name: string; pos: number } | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !TRELLO_ID.test(r.id)) return null;
  return { id: r.id, name: str(r.name, 200), pos: typeof r.pos === "number" ? r.pos : 0 };
}

export function parseBoard(raw: unknown): { id: string; name: string } | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !TRELLO_ID.test(r.id)) return null;
  return { id: r.id, name: str(r.name, 200) };
}

export type Touch = { kind: "card" | "cardgone" | "lists" | "boards"; id: string };

const CARD_EVENTS = new Set(["createCard", "updateCard", "copyCard", "convertToCardFromCheckItem", "moveCardToBoard", "moveCardFromBoard", "addLabelToCard", "removeLabelFromCard"]);
const LIST_EVENTS = new Set(["createList", "updateList", "moveListFromBoard", "moveListToBoard"]);
const BOARD_EVENTS = new Set(["createBoard", "updateBoard", "addToOrganizationBoard", "removeFromOrganizationBoard", "deleteBoard"]);

// What a webhook event means for the cache: re-read one card, forget one card, re-read a board's lists, or re-read all boards.
export function eventTouches(action: { type?: string; data?: { card?: { id?: string }; board?: { id?: string } } } | undefined): Touch | null {
  const type = action?.type ?? "";
  const cardId = action?.data?.card?.id;
  const boardId = action?.data?.board?.id;
  if (CARD_EVENTS.has(type) && cardId && TRELLO_ID.test(cardId)) return { kind: "card", id: cardId };
  if (type === "deleteCard" && cardId && TRELLO_ID.test(cardId)) return { kind: "cardgone", id: cardId };
  if (LIST_EVENTS.has(type) && boardId && TRELLO_ID.test(boardId)) return { kind: "lists", id: boardId };
  if (BOARD_EVENTS.has(type)) return { kind: "boards", id: "all" };
  return null;
}

// `trello:card/<id>`, a card id, a short link, or a card URL -> the id to ask Trello for, or null.
export function cardIdFrom(input: string): string | null {
  const t = input.trim().replace(/^trello:card\//i, "");
  const url = /^https:\/\/trello\.com\/c\/([A-Za-z0-9]{8})(?:[/?#].*)?$/.exec(t);
  const id = url ? url[1] : t;
  return TRELLO_ID.test(id) ? id : null;
}

// Escapes a user's text for a SQL LIKE substring match written with ESCAPE of a backslash.
export function likeFor(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function cardLine(c: CardRow, board: string, list: string): string {
  const due = c.due ? ` due ${c.due.slice(0, 10)}${c.due_complete ? " (done)" : ""}` : "";
  const labels = c.labels.length ? ` [${c.labels.join(", ")}]` : "";
  const link = c.short_link ? ` https://trello.com/c/${c.short_link}` : "";
  return `- ${c.name} (${board} > ${list})${due}${labels} trello:card/${c.id}${link}`;
}
