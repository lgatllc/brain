import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/safe.ts, run by tests/smoke.sh against an esbuild bundle of that file.
// Usage: node tests/safe.test.mjs <path to bundled safe.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const check = (group, label, actual, expected) => {
  const g = (groups[group] ??= []);
  if (actual !== expected) g.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};
const lacks = (group, label, text, secret) => {
  const g = (groups[group] ??= []);
  if (text.includes(secret)) g.push(`${label}: still contains ${secret}`);
};

// sanitizeDetail: nothing secret survives, ordinary text does
const S = "sanitizeDetail";
check(S, "bearer value", t.sanitizeDetail("Authorization failed for Bearer abcDEF123456789xyz"), "Authorization failed for Bearer [redacted]");
check(S, "sk key", t.sanitizeDetail("key sk-abcdefghijklmnopqrstuv1234 rejected"), "key [redacted] rejected");
check(S, "github token", t.sanitizeDetail("bad ghp_abcdefghijklmnopqrstuvwx token"), "bad [redacted] token");
check(S, "64 hex characters", t.sanitizeDetail(`token ${"0123456789abcdef".repeat(4)} used`), "token [redacted] used");
check(S, "uuid (export or approval id)", t.sanitizeDetail("export 123e4567-e89b-12d3-a456-426614174000 missing"), "export [redacted] missing");
check(S, "webhook url", t.sanitizeDetail("POST https://chat.googleapis.com/v1/spaces/AAA/messages?key=abc&token=def failed"), "POST [url] failed");
check(S, "http url", t.sanitizeDetail("see http://127.0.0.1:9911/notify now"), "see [url] now");
check(S, "ordinary text unchanged", t.sanitizeDetail("Error: Unexpected token at position 5"), "Error: Unexpected token at position 5");
check(S, "long word without digits kept", t.sanitizeDetail("supercalifragilisticexpialidocious"), "supercalifragilisticexpialidocious");
check(S, "newlines and tabs collapsed", t.sanitizeDetail("a\nb\tc"), "a b c");
check(S, "clipped with an ellipsis", t.sanitizeDetail("a".repeat(300)).length, 160);
check(S, "clip marker", t.sanitizeDetail("a".repeat(300)).endsWith("…"), true);
lacks(S, "private key header", t.sanitizeDetail("-----BEGIN RSA PRIVATE KEY----- MIIE"), "BEGIN RSA PRIVATE KEY");

// describeError: name and first line only, and still sanitized
const D = "describeError";
check(D, "first line only", t.describeError(new Error("first line\nsecond line has secret body text")), "Error: first line");
lacks(D, "content in later lines", t.describeError(new Error("parse failed\n> client: Acme Corp, SSN 123-45-6789")), "Acme");
check(D, "error name kept", t.describeError(new TypeError("boom")), "TypeError: boom");
check(D, "token in the message", t.describeError(new Error("failed with Bearer abcdefghijklmnop")), "Error: failed with Bearer [redacted]");
check(D, "string thrown", t.describeError("a string with sk-abcdefghijklmnopqrstuv1234"), "non-error value thrown");
check(D, "object thrown", t.describeError({ message: "x" }), "non-error value thrown");

// routeLabel: only the first path segment, never an id
const R = "routeLabel";
for (const [path, want] of [
  ["/", "/"],
  ["/mcp", "/mcp"],
  ["/authorize", "/authorize"],
  ["/oauth/token", "/oauth/*"],
  ["/approve/0123456789abcdef", "/approve/*"],
  ["/exports/123e4567-e89b-12d3-a456-426614174000.tar", "/exports/*"],
  ["/hooks/trello", "/hooks/*"],
  ["/dashboard/api/x", "/dashboard/*"],
  ["/.well-known/oauth-authorization-server", "/.well-known/*"],
  ["/something-secret-123", "other"],
  ["/__force500", "other"],
]) check(R, path, t.routeLabel(path), want);

let failed = 0;
for (const [group, problems] of Object.entries(groups)) {
  if (problems.length) failed++;
  console.log(`${group}: ${problems.length ? `FAIL ${problems.join("; ")}` : "PASS"}`);
}
process.exit(failed ? 1 : 0);
