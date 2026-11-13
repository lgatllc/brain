#!/usr/bin/env node
// Owner command-line tool for the agent talk board.
//
// Runs the human-only actions (confirm a concept, delete, write a protected file) from your own
// terminal, so no agent ever has to hold a `human:` token (PLAN.md 2.4).
//
//   node scripts/owner.mjs guide
//   node scripts/owner.mjs read   <path>
//   node scripts/owner.mjs verify <path> --why "why this matters later"
//   node scripts/owner.mjs write  <path> <local-file> --why "why this matters later"
//   node scripts/owner.mjs delete <path> --reason "why"
//   node scripts/owner.mjs export
//   node scripts/owner.mjs redact <key> --reason "why"   hide something everywhere (key as in R2, e.g. memory/clients/acme.md)
//   node scripts/owner.mjs unredact <key>
//   node scripts/owner.mjs redactions                    list what is redacted, with full keys
//
// <path> is bundle-relative, e.g. integrations/trello.md.
//
// Needs Node 18+ and two environment variables (deliberately not the hook's TALK_BOARD_* names, so
// the owner token cannot end up in an agent's settings by accident):
//   OWNER_URL    the Worker, e.g. https://agent-talk-board.<subdomain>.workers.dev (the /mcp suffix is optional)
//   OWNER_TOKEN  a token that AGENT_TOKENS maps to your `human:` actor. Read from the environment only:
//                it is never accepted as an argument (arguments show up in process lists) and never printed.
//
// Exit codes: 0 success, 1 the server refused or failed, 2 usage or configuration error.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage:
  owner.mjs guide
  owner.mjs read   <path>
  owner.mjs verify <path> --why "why this matters later"
  owner.mjs write  <path> <local-file> --why "why this matters later"
  owner.mjs delete <path> --reason "why"
  owner.mjs export                      (prints a 24-hour download link for the whole bundle)
  owner.mjs redact <key> --reason "why" (hides the object, and for memory files every history version and trash copy)
  owner.mjs unredact <key>
  owner.mjs redactions                  (lists redacted items with their full keys)
Environment: OWNER_URL (the Worker URL), OWNER_TOKEN (your human: token).`;

class UsageError extends Error {}

function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** Validates OWNER_URL and returns the /mcp endpoint. Plain http is allowed only for localhost. */
export function endpointFrom(raw) {
  if (!raw) throw new UsageError("OWNER_URL is not set.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("OWNER_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new UsageError("OWNER_URL must start with https:// (http:// is allowed only for localhost). Refusing to send the owner token over an unencrypted connection.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "") + "/mcp";
  return url.toString();
}

/** Splits argv into positional arguments and --flag value pairs. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${a} needs a value.`);
      flags[a.slice(2)] = value;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function callTool(endpoint, token, name, args) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`Could not reach ${endpoint} (${e?.name ?? "error"}).`);
  }
  if (res.status === 401) throw new Error("The server rejected OWNER_TOKEN (HTTP 401). Check the token and that OWNER_URL is the right instance.");
  const text = await res.text();
  if (!res.ok) throw new Error(`The server returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  let message;
  try {
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      message = JSON.parse(text);
    } else {
      const dataLines = text.split(/\r?\n/).filter((l) => l.startsWith("data: "));
      message = JSON.parse(dataLines[dataLines.length - 1].slice(6));
    }
  } catch {
    throw new Error("The server's reply was not understood.");
  }
  if (message?.error) throw new Error(`The server returned an error: ${message.error.message ?? JSON.stringify(message.error)}`);
  const result = message?.result;
  return { text: result?.content?.[0]?.text ?? "", isError: result?.isError === true };
}

function etagOf(readText) {
  return /^etag: ([0-9a-f]+)/m.exec(readText)?.[1] ?? null;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const { positional, flags } = parseArgs(rest);
  const need = (n) => {
    if (positional.length !== n) throw new UsageError(`'${command}' takes ${n} argument${n === 1 ? "" : "s"}.\n${USAGE}`);
  };
  const known = { guide: 0, export: 0, redactions: 0, read: 1, verify: 1, write: 2, delete: 1, redact: 1, unredact: 1 };
  if (!(command in known)) throw new UsageError(`Unknown command '${command}'.\n${USAGE}`);
  need(known[command]);
  if ((command === "write" || command === "verify") && !flags.why) {
    throw new UsageError(`'${command}' needs --why: one sentence on why this matters later (the server refuses an empty or filler one).`);
  }
  if (command === "delete" && !flags.reason) throw new UsageError("'delete' needs --reason.");
  if (command === "redact" && !flags.reason) throw new UsageError("'redact' needs --reason (a sentence for removals.md; do not include the content or its name).");

  const endpoint = endpointFrom(process.env.OWNER_URL);
  const token = process.env.OWNER_TOKEN;
  if (!token) throw new UsageError("OWNER_TOKEN is not set.");
  const call = (name, args) => callTool(endpoint, token, name, args);
  const finish = (r) => {
    (r.isError ? process.stderr : process.stdout).write(`${r.text}\n`);
    return r.isError ? 1 : 0;
  };

  if (command === "guide") return finish(await call("brain_guide", {}));
  if (command === "export") return finish(await call("bundle_export", {}));
  if (command === "redactions") return finish(await call("redact", { action: "list" }));
  if (command === "redact") return finish(await call("redact", { action: "redact", key: positional[0], reason: flags.reason }));
  if (command === "unredact") return finish(await call("redact", { action: "unredact", key: positional[0] }));

  const path = positional[0];
  if (command === "read") return finish(await call("memory_read", { path }));

  if (command === "write") {
    let content;
    try {
      content = readFileSync(positional[1], "utf8");
    } catch {
      throw new UsageError(`Cannot read the local file '${positional[1]}'.`);
    }
    const current = await call("memory_read", { path });
    let ifEtag = "new";
    if (!current.isError) ifEtag = etagOf(current.text) ?? die(1, "Could not find the current etag in the server's reply.");
    else if (!current.text.startsWith("Not found")) return finish(current);
    return finish(await call("memory_write", { path, content, if_etag: ifEtag, why: flags.why }));
  }

  // verify and delete both act on the version you can see right now.
  const current = await call("memory_read", { path });
  if (current.isError) return finish(current);
  const ifEtag = etagOf(current.text) ?? die(1, "Could not find the current etag in the server's reply.");
  if (command === "verify") return finish(await call("memory_verify", { path, if_etag: ifEtag, why: flags.why }));
  return finish(await call("memory_delete", { path, if_etag: ifEtag, reason: flags.reason }));
}

// Run only when executed directly, so the helpers can be imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => die(e instanceof UsageError ? 2 : 1, e instanceof UsageError ? e.message : `Error: ${e.message}`),
  );
}
