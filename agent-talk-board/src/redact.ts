// Redaction (PLAN.md 6.5, Phase 0.22): the owner hides something that must not be there, and the server stops
// returning it from every read path at once. This file is the pure part: which keys can be redacted, what a
// redaction covers, how a key is matched, and how the log is scrubbed. Dependency-free so it can be unit-tested in
// plain Node (tests/redact.test.mjs). The storage wrapper and the tool live in index.ts.

/** One redacted key. A `prefix` entry (key ends in "/") covers every object under it. */
export interface Redaction {
  key: string;
  prefix: boolean;
  at: number; // when it was redacted, epoch ms
  purge_after: number; // when permanent deletion becomes possible (end of the bucket lock), epoch ms
}

/** The prefixes the owner may redact in. approvals/ is deliberately out (PLAN.md 6.5). */
export const REDACTABLE_ROOTS = ["memory/", "board/", "history/", "trash/", "handoffs/"];

/** A small copy of the list, kept in R2 so a Scheduler outage cannot make redacted items readable. Not backed up, not exported. */
export const MIRROR_KEY = "meta/redactions.json";

/** Days between redaction and permanent deletion: the bucket lock period (PLAN.md 6.5). */
export const PURGE_DAYS = 90;

/** Files the server owns, which cannot be redacted: the protocol, the reserved index and log, and the removals record. */
const SERVER_FILES = ["memory/protocol.md", "memory/log.md", "memory/removals.md"];

/** Returns an error message if `key` cannot be redacted, otherwise null. */
export function validateKey(key: unknown): string | null {
  if (typeof key !== "string" || !key) return "key is required.";
  if (key.length > 600) return "key is too long.";
  if (!/^[A-Za-z0-9._:\-/]+$/.test(key) || key.includes("..") || key.includes("//")) return "key has characters that are not allowed.";
  if (!REDACTABLE_ROOTS.some((r) => key.startsWith(r) && key.length > r.length)) {
    return `key must be an object key under ${REDACTABLE_ROOTS.join(", ")} (for example memory/clients/acme.md or board/general/<file>). approvals/ cannot be redacted.`;
  }
  if (key.endsWith("/")) return "key must name one object, not a folder.";
  if (SERVER_FILES.includes(key) || key.endsWith("/index.md")) return `${key} is maintained by the server and cannot be redacted.`;
  return null;
}

/** A plain-language kind for announcements, which must not show the key itself. */
export function kindOf(key: string): string {
  if (key.startsWith("memory/references/")) return "reference file";
  if (key.startsWith("memory/")) return key.endsWith(".md") ? "concept" : "file";
  if (key.startsWith("board/")) return "board message";
  if (key.startsWith("history/")) return "history version";
  if (key.startsWith("trash/")) return "trash copy";
  return "handoff";
}

/** Everything one redaction request covers: a memory file also covers every history version and trash copy of it. */
export function expand(key: string, at: number, purgeAfter: number): Redaction[] {
  const entries: Redaction[] = [{ key, prefix: false, at, purge_after: purgeAfter }];
  if (key.startsWith("memory/")) {
    const path = key.slice("memory/".length);
    entries.push({ key: `history/${path}/`, prefix: true, at, purge_after: purgeAfter });
    entries.push({ key: `trash/${path}/`, prefix: true, at, purge_after: purgeAfter });
  }
  return entries;
}

export class RedactionSet {
  constructor(readonly entries: Redaction[] = []) {}

  /** The redaction that covers `key` (exactly, or through a prefix entry), or null. */
  match(key: string): Redaction | null {
    for (const e of this.entries) {
      if (e.prefix ? key.startsWith(e.key) : key === e.key) return e;
    }
    return null;
  }

  /** Exact entries that sit under `prefix`, for notes such as "2 messages in this thread are hidden". */
  under(prefix: string): Redaction[] {
    return this.entries.filter((e) => !e.prefix && e.key.startsWith(prefix));
  }

  get size(): number {
    return this.entries.length;
  }
}

export const placeholder = (day: string): string => `[redacted by owner on ${day}]`;

/** A short stable id for announcing a redaction without naming what was removed. */
export async function shortId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const LOG_REDACTED_LINE = "* **Redacted entry**: removed by the owner";

/** Replaces every log.md bullet that mentions one of the bundle paths with a neutral line. */
export function scrubLog(text: string, paths: string[]): { text: string; changed: number } {
  if (!paths.length) return { text, changed: 0 };
  const re = new RegExp(`(?<![A-Za-z0-9._/-])/(?:${paths.map(escapeRegExp).join("|")})(?![A-Za-z0-9._/-])`);
  let changed = 0;
  const out = text.split("\n").map((line) => {
    if (line.startsWith("* ") && re.test(line)) {
      changed++;
      return LOG_REDACTED_LINE;
    }
    return line;
  });
  return { text: out.join("\n"), changed };
}

export function serializeMirror(entries: Redaction[]): string {
  return JSON.stringify({ schema_version: 1, entries });
}

/** Reads the backup copy. Missing means nothing was ever redacted; unreadable throws, so callers fail closed. */
export function parseMirror(text: string | null): Redaction[] {
  if (text === null || text.trim() === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("redaction mirror is not valid JSON");
  }
  const entries = (data as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) throw new Error("redaction mirror has no entries list");
  return entries.map((e) => {
    const r = e as Partial<Redaction>;
    if (typeof r.key !== "string" || typeof r.prefix !== "boolean" || typeof r.at !== "number") throw new Error("redaction mirror entry is malformed");
    return { key: r.key, prefix: r.prefix, at: r.at, purge_after: typeof r.purge_after === "number" ? r.purge_after : r.at };
  });
}
