// Safe error text (PLAN.md Phase 0.21).
//
// Anything that records an error, or shows one to the owner, goes through here first, so that no token, credential,
// webhook URL, unguessable link id or piece of stored content ends up in a log, the error table or a report.
// Dependency-free so it can be unit-tested in plain Node (tests/safe.test.mjs).

/** Credential shapes the server refuses to store, and never wants in an error message either. */
export const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,})/;

/**
 * Makes a piece of error text safe to keep: one line, no URLs (a webhook URL is a secret), no bearer values, no known
 * credential shapes, no long opaque strings (tokens, hashes, UUIDs such as export and approval ids), no control
 * characters, at most `max` characters.
 */
export function sanitizeDetail(text: string, max = 160): string {
  let t = String(text);
  t = t.replace(/[\u0000-\u001f\u007f]+/g, " ");
  t = t.replace(/\bhttps?:\/\/\S+/gi, "[url]");
  t = t.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  t = t.replace(new RegExp(SECRET_RE.source, "g"), "[redacted]");
  // any long run that mixes letters and digits (hex, base64, UUIDs) is treated as a secret or a capability id
  t = t.replace(/[A-Za-z0-9_\-+/=.]{24,}/g, (run) => (/[A-Za-z]/.test(run) && /[0-9]/.test(run) ? "[redacted]" : run));
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A short, safe description of a thrown value: the error's name and the first line of its message only. The rest of a
 * message can carry content (a YAML error quotes the lines it failed on), so it is dropped.
 */
export function describeError(e: unknown, max = 160): string {
  if (e instanceof Error) {
    const firstLine = String(e.message).split(/\r?\n/)[0] ?? "";
    return sanitizeDetail(`${e.name}: ${firstLine}`, max);
  }
  return "non-error value thrown";
}

/**
 * A label for a request path that is safe to record: the first segment only. Paths such as /exports/<id>.tar and
 * /approve/<id> are capabilities, so their ids must never be recorded.
 */
export function routeLabel(pathname: string): string {
  const first = pathname.split("/").filter(Boolean)[0];
  if (!first) return "/";
  if (first === ".well-known") return "/.well-known/*";
  if (["mcp", "authorize"].includes(first)) return `/${first}`;
  if (["approve", "exports", "oauth", "hooks", "dashboard"].includes(first)) return `/${first}/*`;
  return "other";
}
