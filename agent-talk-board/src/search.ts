// Search (PLAN.md 1A): the pure parts. Which stored objects are indexed, how a stored file becomes an index row, and how a
// search phrase becomes a safe query. The index itself (SQLite in the Scheduler) and the tools are in src/index.ts.
import { parse as parseYaml } from "yaml";
import { freshnessOf } from "./freshness";

export type SearchKind = "concept" | "board" | "handoff";
export const SEARCH_KINDS: SearchKind[] = ["concept", "board", "handoff"];
export const SEARCH_BODY_CAP = 20_000;
export const SEARCH_SNIPPET_CAP = 240;

export interface SearchDoc {
  doc_id: string; // the R2 key
  kind: SearchKind;
  path: string; // bundle-relative for concepts, the thread/file for board messages, the handoff id
  title: string;
  tags: string;
  actor: string;
  updated: string;
  thread: string;
  status: string;
  state: string; // a capture's triage state (new or resolved)
  subkind: string; // a capture's kind (note, idea, todo, decision, question)
  review_at: string; // a concept's next review date (ISO), from the freshness policy; empty for anything else
  body: string;
}

const clip = (s: unknown, n: number): string => (typeof s === "string" ? s : s === undefined || s === null ? "" : String(s)).slice(0, n);

function split(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  try {
    const data = parseYaml(m[1]);
    return { data: data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {}, body: m[2] };
  } catch {
    return { data: {}, body: m[2] };
  }
}

/** True for the keys the index holds: concepts (not index.md or log.md), board messages and handoffs. History, trash, approvals, exports and files are never indexed. */
export function isIndexedKey(key: string): boolean {
  if (key.startsWith("memory/")) return key.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(key.slice("memory/".length));
  if (key.startsWith("board/")) return key.endsWith(".md") && key.split("/").length >= 3;
  if (key.startsWith("handoffs/")) return key.endsWith(".md") && key.split("/").length === 2;
  return false;
}

/** The index row for a stored object, or null when it is not indexed. Never throws. */
export function searchDocFor(key: string, text: string, modified = ""): SearchDoc | null {
  if (!isIndexedKey(key)) return null;
  const { data, body } = split(text);
  const tags = Array.isArray(data.tags) ? data.tags.map((t) => clip(t, 40)).filter(Boolean).join(" ") : "";
  const generated = data.generated && typeof data.generated === "object" ? ((data.generated as Record<string, unknown>).by as unknown) : "";
  if (key.startsWith("board/")) {
    const parts = key.split("/");
    const when = clip(data.posted, 40) || parts[2].slice(0, 24);
    return {
      doc_id: key, kind: "board", path: `${parts[1]}/${parts.slice(2).join("/")}`,
      title: clip(body.trim().split("\n")[0].replace(/[*_`#>]/g, "").trim(), 150) || `Message in ${parts[1]}`,
      tags, actor: clip(data.actor, 100), updated: when, thread: parts[1], status: "", state: "", subkind: "", review_at: "", body: clip(body.trim(), SEARCH_BODY_CAP),
    };
  }
  if (key.startsWith("handoffs/")) {
    const id = key.slice("handoffs/".length).replace(/\.md$/, "");
    return {
      doc_id: key, kind: "handoff", path: id, title: clip(data.title, 150) || id, tags, actor: clip(data.from ?? data.actor ?? generated, 100),
      updated: clip(data.created ?? data.updated, 40) || modified, thread: clip(data.thread, 100), status: clip(data.status ?? data.state, 20), state: "", subkind: "", review_at: "", body: clip(body.trim(), SEARCH_BODY_CAP),
    };
  }
  const path = key.slice("memory/".length);
  return {
    doc_id: key, kind: "concept", path, title: clip(data.title, 150) || path, tags,
    actor: clip(generated, 100), updated: clip((data.generated as Record<string, unknown> | undefined)?.at, 40) || modified, thread: "",
    status: clip(data.status, 20), state: data.type === "Capture" ? clip(data.state, 20) : "", subkind: data.type === "Capture" ? clip(data.kind, 20) : "",
    review_at: freshnessOf(data, new Date(), modified).reviewAt ?? "",
    body: clip(`${clip(data.description, 400)}\n${body.trim()}`.trim(), SEARCH_BODY_CAP),
  };
}

/** Words of a search phrase: letters and digits only, so nothing the phrase contains can act as query syntax. */
export function searchTerms(phrase: string): string[] {
  const words = phrase.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((w) => w.length > 0).slice(0, 12);
}

/** An FTS5 MATCH expression: every word must appear, the last word may be a start of a word. Null when the phrase has no words. */
export function ftsMatch(phrase: string): string | null {
  const t = searchTerms(phrase);
  if (!t.length) return null;
  return t.map((w, i) => (i === t.length - 1 ? `"${w}"*` : `"${w}"`)).join(" ");
}

/** A short piece of text around the first match, for the fallback search that has no FTS5. */
export function snippetFor(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const w of terms) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - 60);
  const piece = body.slice(start, start + SEARCH_SNIPPET_CAP).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${piece}${start + SEARCH_SNIPPET_CAP < body.length ? "…" : ""}`;
}
