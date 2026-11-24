#!/usr/bin/env node
// Owner tool: stand up the production brain (PLAN.md 9.2a, 0.4 to 0.13). Run from agent-talk-board/. One-off, run by the owner.
//
//   node scripts/prod-setup.mjs secrets [--actors a,b,c] [--force]   generate tokens and the owner password, ask for the other
//                                                                    values, set every production secret
//   node scripts/prod-setup.mjs deploy                               deploy production, then run the checks
//   node scripts/prod-setup.mjs check [url]                          check the live address (changes nothing)
//   node scripts/prod-setup.mjs copy-memory [--apply]                copy memory/ from staging to production (a dry run without --apply)
//   node scripts/prod-setup.mjs webhooks                             create a Trello webhook on every open board for production
//   node scripts/prod-setup.mjs lock                                 the three 90 day bucket locks (cannot be undone; asks first)
//
// Secrets are typed here (hidden) or generated here; none go through chat. Generated values are written once to
// ~/brain-production-secrets.txt (outside the repo) so you can give each agent its token. Nothing is ever printed except where noted.
// copy-memory needs an R2 API token with Object Read and Write on both buckets (R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the
// environment, or it asks). Delete that token when done.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const PROD_URL = "https://brain.atllc-ai-brain.workers.dev";
const ACCOUNT_ID = "80eed4e66f7c4ebc41e8a7bc92f79f8b";
const FROM_BUCKET = "agent-brain-staging";
const TO_BUCKET = "agent-brain";
const SECRETS_FILE = join(homedir(), "brain-production-secrets.txt");

// ---------- pure parts (unit-tested in tests/prod-setup.test.mjs) ----------

/** Which staging keys are copied: the memory bundle, without the server's log, the test inbox, and file concepts (their files are not copied). */
export function wantedKey(key) {
  if (!key.startsWith("memory/")) return false;
  if (key === "memory/log.md") return false;
  if (key.startsWith("memory/inbox/")) return false;
  if (key.startsWith("memory/files/")) return false;
  if (key.startsWith("memory/proposed/")) return false;
  return true;
}

export function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function encodeKeyPath(bucket, key) {
  return "/" + bucket + "/" + key.split("/").map(uriEncode).join("/");
}

const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Parses an S3 ListObjectsV2 answer: the keys (with sizes), and the token for the next page. */
export function parseList(xml) {
  const items = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
    const size = /<Size>(\d+)<\/Size>/.exec(m[1]);
    if (key) items.push({ key: unxml(key[1]), size: size ? Number(size[1]) : 0 });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { items, next: truncated && next ? unxml(next[1]) : null };
}

const sha256 = (d) => createHash("sha256").update(d).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();

/** AWS Signature Version 4 for R2 (region auto, service s3). Returns the headers to send (host is added by fetch). */
export function signRequest({ method, host, path, query = {}, headers = {}, body, accessKeyId, secretAccessKey, now = new Date(), region = "auto" }) {
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amz.slice(0, 8);
  const payloadHash = sha256(body ?? "");
  const all = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amz };
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = String(v).trim();
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((k) => `${k}:${all[k]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const out = { ...all, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  delete out.host;
  return { headers: out, queryString: canonicalQuery };
}

// ---------- helpers ----------

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const orig = rl._writeToOutput;
      rl._writeToOutput = function (s) {
        if (s.includes(question)) orig.call(rl, s);
      };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", ...opts });
}

function putSecret(name, value) {
  const r = run("npx", ["wrangler", "secret", "put", name], { input: value });
  if (r.status !== 0) {
    process.stdout.write(`  FAILED to set ${name}: ${(r.stderr || r.stdout || "").split("\n").filter(Boolean).slice(-2).join(" ")}\n`);
    return false;
  }
  process.stdout.write(`  set ${name}\n`);
  return true;
}

// ---------- secrets ----------

async function cmdSecrets(args) {
  const force = args.includes("--force");
  const ai = args.indexOf("--actors");
  const actors = (ai >= 0 ? args[ai + 1] : "claude-code/main,codex/main,human:luke").split(",").map((s) => s.trim()).filter(Boolean);
  if (existsSync(SECRETS_FILE) && !force) {
    process.stdout.write(`${SECRETS_FILE} already exists, so tokens were already generated. Use --force to generate new ones (this replaces the old tokens).\n`);
    return 2;
  }
  const tokens = {};
  const lines = ["Production brain secrets. Keep this file private; delete it once every agent is connected.", ""];
  for (const a of actors) {
    const t = randomBytes(32).toString("hex");
    tokens[t] = a;
    lines.push(`token for ${a}: ${t}`);
  }
  const password = randomBytes(18).toString("base64url");
  lines.push("", `owner password: ${password}`);
  writeFileSync(SECRETS_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  process.stdout.write(`Generated tokens and the owner password. Saved to ${SECRETS_FILE}\n\nSetting secrets:\n`);
  let ok = putSecret("AGENT_TOKENS", JSON.stringify(tokens));
  ok = putSecret("OWNER_PASSWORD", password) && ok;
  const asked = [
    ["GITHUB_REPO", "GitHub backup repository as owner/name (Enter to skip): ", false],
    ["GITHUB_TOKEN", "GitHub fine-grained token for that repository (Enter to skip): ", true],
    ["NOTIFY_WEBHOOK_URL", "Google Chat webhook link for the real alerts space (Enter to skip): ", true],
    ["CF_ANALYTICS_TOKEN", "Cloudflare API token with Account Analytics Read (Enter to skip): ", true],
    ["TRAINWEL_API_KEY", "Trainwel API key (Enter to skip): ", true],
    ["TRELLO_API_KEY", "Trello API key (Enter to skip): ", true],
    ["TRELLO_TOKEN", "Trello member token (Enter to skip): ", true],
    ["TRELLO_APP_SECRET", "Trello application secret (Enter to skip): ", true],
  ];
  for (const [name, q, hidden] of asked) {
    const v = await ask(q, { hidden });
    if (!v) {
      process.stdout.write(`  skipped ${name}\n`);
      continue;
    }
    ok = putSecret(name, v) && ok;
  }
  process.stdout.write(ok ? "\nDone. Skipped ones can be set later with: npx wrangler secret put <NAME>\n" : "\nSome secrets failed (see above).\n");
  return ok ? 0 : 1;
}

// ---------- check ----------

async function cmdCheck(base) {
  const url = (base || PROD_URL).replace(/\/+$/, "");
  let bad = 0;
  const probe = async (label, path, init, expect) => {
    let status = 0;
    try {
      status = (await fetch(url + path, { redirect: "manual", ...init })).status;
    } catch {
      status = 0;
    }
    const pass = expect.includes(status);
    if (!pass) bad++;
    process.stdout.write(`${pass ? "ok  " : "FAIL"} ${label}: HTTP ${status}\n`);
  };
  await probe("the front page answers", "/", {}, [200]);
  await probe("/mcp without a token is refused", "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, [401]);
  await probe("an upload without a token is refused", "/files/upload?name=x.html&why=check", { method: "PUT", body: "<p>x</p>" }, [401, 411]);
  await probe("the approval page is behind Access (or off until Access is set)", "/approve/none", {}, [302, 401, 403, 503]);
  process.stdout.write(bad ? `\n${bad} check(s) failed.\n` : "\nAll checks passed.\n");
  return bad ? 1 : 0;
}

async function cmdDeploy() {
  process.stdout.write("Deploying production...\n");
  const r = run("npx", ["wrangler", "deploy"], { stdio: "inherit" });
  if (r.status !== 0) return 1;
  return cmdCheck(PROD_URL);
}

// ---------- copy-memory ----------

async function credentials() {
  const id = process.env.R2_ACCESS_KEY_ID || (await ask("R2 access key id: ", { hidden: true }));
  const secret = process.env.R2_SECRET_ACCESS_KEY || (await ask("R2 secret access key: ", { hidden: true }));
  if (!id || !secret) throw new Error("An R2 access key id and secret are needed.");
  return { accessKeyId: id, secretAccessKey: secret };
}

async function s3(creds, method, bucket, key, { query = {}, headers = {}, body } = {}) {
  const host = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = key === null ? "/" + bucket : encodeKeyPath(bucket, key);
  const { headers: h, queryString } = signRequest({ method, host, path, query, headers, body, ...creds });
  return fetch(`https://${host}${path}${queryString ? "?" + queryString : ""}`, { method, headers: h, body });
}

async function listAll(creds, bucket, prefix) {
  const all = [];
  let token = null;
  do {
    const q = { "list-type": "2", prefix };
    if (token) q["continuation-token"] = token;
    const res = await s3(creds, "GET", bucket, null, { query: q });
    if (!res.ok) throw new Error(`Listing ${bucket} failed (HTTP ${res.status}). Check the R2 token covers this bucket.`);
    const page = parseList(await res.text());
    all.push(...page.items);
    token = page.next;
  } while (token);
  return all;
}

async function cmdCopy(args) {
  const apply = args.includes("--apply");
  const creds = await credentials();
  const src = (await listAll(creds, FROM_BUCKET, "memory/")).filter((o) => wantedKey(o.key));
  const have = new Set((await listAll(creds, TO_BUCKET, "memory/")).map((o) => o.key));
  const todo = src.filter((o) => !have.has(o.key));
  process.stdout.write(`${src.length} concept(s) in staging to copy; ${have.size} already in production; ${todo.length} to copy.\n`);
  if (!apply) {
    process.stdout.write("Dry run: nothing copied. Run again with --apply.\n");
    return 0;
  }
  let done = 0;
  let failed = 0;
  for (const o of todo) {
    try {
      const got = await s3(creds, "GET", FROM_BUCKET, o.key);
      if (!got.ok) throw new Error(`read HTTP ${got.status}`);
      const body = Buffer.from(await got.arrayBuffer());
      const headers = { "content-type": got.headers.get("content-type") ?? "application/octet-stream", "if-none-match": "*" };
      for (const [k, v] of got.headers) if (k.toLowerCase().startsWith("x-amz-meta-")) headers[k.toLowerCase()] = v;
      const put = await s3(creds, "PUT", TO_BUCKET, o.key, { headers, body });
      if (!put.ok && put.status !== 412) throw new Error(`write HTTP ${put.status}`);
      done++;
    } catch (e) {
      failed++;
      process.stdout.write(`  FAILED ${o.key}: ${e.message}\n`);
    }
  }
  const after = (await listAll(creds, TO_BUCKET, "memory/")).filter((o) => wantedKey(o.key));
  process.stdout.write(`Copied ${done}, failed ${failed}. Production now holds ${after.length} of ${src.length}.\n`);
  process.stdout.write("Next: rebuild the search index with  node scripts/owner.mjs reindex  (OWNER_URL set to production).\n");
  return failed ? 1 : 0;
}

// ---------- webhooks and locks ----------

async function cmdWebhooks() {
  const key = process.env.TRELLO_KEY || (await ask("Trello API key: ", { hidden: true }));
  const token = process.env.TRELLO_TOKEN || (await ask("Trello member token: ", { hidden: true }));
  const env = { ...process.env, TRELLO_KEY: key, TRELLO_TOKEN: token, TRELLO_CALLBACK_URL: `${PROD_URL}/hooks/trello` };
  return run("node", ["scripts/trello-webhooks.mjs", "sync", "--apply"], { stdio: "inherit", env }).status ?? 1;
}

async function cmdLock() {
  process.stdout.write("This locks board/, history/ and trash/ in production for 90 days. Locked files cannot be deleted or overwritten, even by you.\nOnly do this after every production check has passed.\n");
  if ((await ask('Type "lock" to continue: ')).toLowerCase() !== "lock") {
    process.stdout.write("Not locked.\n");
    return 1;
  }
  for (const dir of ["board", "history", "trash"]) {
    const r = run("npx", ["wrangler", "r2", "bucket", "lock", "add", TO_BUCKET, "--name", `keep-${dir}`, "--prefix", `${dir}/`, "--retention-days", "90"], { stdio: "inherit" });
    if (r.status !== 0) return 1;
  }
  run("npx", ["wrangler", "r2", "bucket", "lock", "list", TO_BUCKET], { stdio: "inherit" });
  return 0;
}

// ---------- main ----------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "secrets": return cmdSecrets(rest);
    case "deploy": return cmdDeploy();
    case "check": return cmdCheck(rest[0]);
    case "copy-memory": return cmdCopy(rest);
    case "webhooks": return cmdWebhooks();
    case "lock": return cmdLock();
    default:
      process.stdout.write("Usage: node scripts/prod-setup.mjs secrets | deploy | check [url] | copy-memory [--apply] | webhooks | lock\n");
      return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((c) => process.exit(c), (e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}
