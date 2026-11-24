#!/usr/bin/env node
// Owner tool: keep a Trello webhook on every open board (PLAN.md 3T-1).
//
//   node scripts/trello-webhooks.mjs list             boards, webhooks, and anything broken (changes nothing)
//   node scripts/trello-webhooks.mjs sync             shows which boards lack a webhook (changes nothing)
//   node scripts/trello-webhooks.mjs sync --apply     creates the missing webhooks
//   node scripts/trello-webhooks.mjs member           shows whether a member-level webhook exists (changes nothing)
//   node scripts/trello-webhooks.mjs member --apply   creates one (a test: does it cover every board? see PLAN.md 3T-1)
//   node scripts/trello-webhooks.mjs remove           shows the webhooks that point at TRELLO_CALLBACK_URL (changes nothing)
//   node scripts/trello-webhooks.mjs remove --apply   deletes exactly those (to retire an instance; webhooks pointing elsewhere are left alone)
//
// Environment (never arguments, never printed; the token can also revoke the webhooks if you revoke it):
//   TRELLO_KEY            the Trello API key (public)
//   TRELLO_TOKEN          the member token (read scope is enough for webhooks)
//   TRELLO_CALLBACK_URL   the Worker's address exactly, e.g. https://brain-staging.<subdomain>.workers.dev/hooks/trello
//
// Exit codes: 0 fine, 1 something broken or failed, 2 usage or configuration error.

import { pathToFileURL } from "node:url";

const API = "https://api.trello.com/1";

// Pure planning logic (unit-tested in tests/trello-webhooks.test.mjs).
// boards: [{id, name}], hooks: [{id, idModel, callbackURL, active, consecutiveFailures, firstConsecutiveFailDate}]
export function planSync(boards, hooks, callbackURL, memberId) {
  const mine = hooks.filter((h) => h.callbackURL === callbackURL);
  const others = hooks.filter((h) => h.callbackURL !== callbackURL);
  const byModel = new Map();
  for (const h of mine) {
    if (!byModel.has(h.idModel)) byModel.set(h.idModel, []);
    byModel.get(h.idModel).push(h);
  }
  const create = [];
  const ok = [];
  const broken = [];
  const duplicates = [];
  for (const b of boards) {
    const list = byModel.get(b.id) ?? [];
    if (list.length === 0) {
      create.push(b);
      continue;
    }
    const problem = list.map(hookProblem).find(Boolean);
    if (problem) broken.push({ board: b, hook: list[0], problem });
    else ok.push(b);
    if (list.length > 1) duplicates.push({ board: b, hooks: list });
  }
  const boardIds = new Set(boards.map((b) => b.id));
  const orphaned = mine.filter((h) => h.idModel !== memberId && !boardIds.has(h.idModel));
  const memberHooks = mine.filter((h) => h.idModel === memberId);
  return { create, ok, broken, duplicates, orphaned, others, member: memberHooks.length === 0 ? "none" : memberHooks.some((h) => !hookProblem(h)) ? "healthy" : "broken" };
}

export function hookProblem(h) {
  if (h.active === false) return "inactive";
  if (Number(h.consecutiveFailures) > 0) return `${h.consecutiveFailures} failed deliveries in a row${h.firstConsecutiveFailDate ? ` since ${h.firstConsecutiveFailDate}` : ""}`;
  return null;
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: trello-webhooks.mjs list | sync [--apply] | member [--apply]");
  process.exit(2);
}

function config() {
  const { TRELLO_KEY: key, TRELLO_TOKEN: token, TRELLO_CALLBACK_URL: callback } = process.env;
  if (!key || !token || !callback) usage("Set TRELLO_KEY, TRELLO_TOKEN and TRELLO_CALLBACK_URL in the environment first.");
  if (!/^https:\/\/[^/]+\/hooks\/trello$/.test(callback)) usage("TRELLO_CALLBACK_URL must look like https://<worker address>/hooks/trello");
  return { key, token, callback };
}

async function call(cfg, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `OAuth oauth_consumer_key="${cfg.key}", oauth_token="${cfg.token}"`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Trello ${method} ${path.split("?")[0]} returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** The webhooks that point at exactly this address (pure; unit-tested). */
export function planRemove(hooks, callbackURL) {
  return hooks.filter((h) => h.callbackURL === callbackURL);
}

const listBoards = (cfg) => call(cfg, "GET", "/members/me/boards?filter=open&fields=name");
const listHooks = (cfg) => call(cfg, "GET", `/tokens/${encodeURIComponent(cfg.token)}/webhooks`);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const apply = rest.includes("--apply");
  if (!["list", "sync", "member", "remove"].includes(cmd) || rest.some((a) => a !== "--apply")) usage();
  const cfg = config();
  if (cmd === "remove") {
    const mine = planRemove(await listHooks(cfg), cfg.callback);
    console.log(`${mine.length} webhook(s) point at ${cfg.callback}.`);
    let bad = false;
    for (const h of mine) {
      if (!apply) {
        console.log(`  would delete ${h.id} (${h.description ?? "no description"})`);
        continue;
      }
      try {
        await call(cfg, "DELETE", `/webhooks/${encodeURIComponent(h.id)}`);
        console.log(`  deleted ${h.id} (${h.description ?? "no description"})`);
      } catch (e) {
        bad = true;
        console.log(`  FAILED ${h.id}: ${e.message}`);
      }
    }
    if (mine.length && !apply) console.log("Run with --apply to delete them.");
    process.exit(bad ? 1 : 0);
  }
  const [boards, hooks] = await Promise.all([listBoards(cfg), listHooks(cfg)]);
  const memberId = (await call(cfg, "GET", "/members/me?fields=id")).id;
  let failed = false;

  if (cmd === "member") {
    const existing = hooks.filter((h) => h.idModel === memberId && h.callbackURL === cfg.callback);
    if (existing.length) console.log(`A member-level webhook exists (${existing[0].id}).${hookProblem(existing[0]) ? " Problem: " + hookProblem(existing[0]) : ""}`);
    else if (!apply) console.log("No member-level webhook. Run with --apply to create one as a test.");
    else {
      const made = await call(cfg, "POST", "/webhooks/", { idModel: memberId, callbackURL: cfg.callback, description: "ATLLC Brain member-level test" });
      console.log(`Created member-level webhook ${made.id}. Now change a card on a board that has no board-level webhook and see whether it reaches trello-events.`);
    }
    return;
  }

  const plan = planSync(boards, hooks, cfg.callback, memberId);
  console.log(`${boards.length} open boards; ${plan.ok.length} watched and healthy.`);
  for (const b of plan.ok) console.log(`  ok       ${b.name}`);
  for (const x of plan.broken) {
    failed = true;
    console.log(`  BROKEN   ${x.board.name}: ${x.problem} (webhook ${x.hook.id})`);
  }
  for (const b of plan.create) console.log(`  missing  ${b.name}`);
  for (const d of plan.duplicates) console.log(`  duplicate webhooks on ${d.board.name}: ${d.hooks.map((h) => h.id).join(", ")} (delete extras in Trello's API if events arrive twice)`);
  console.log(`  account-level webhook: ${plan.member}${plan.member === "none" ? " (run: member --apply)" : ""}`);
  for (const h of plan.orphaned) console.log(`  orphaned webhook ${h.id} (board closed or no longer visible)`);
  if (plan.others.length) console.log(`  ${plan.others.length} webhook(s) point somewhere else and are left alone.`);

  if (cmd === "sync" && plan.create.length) {
    if (!apply) {
      console.log(`Run with --apply to create ${plan.create.length} webhook(s).`);
      failed = true;
    } else {
      for (const b of plan.create) {
        try {
          const made = await call(cfg, "POST", "/webhooks/", { idModel: b.id, callbackURL: cfg.callback, description: `ATLLC Brain: ${b.name}`.slice(0, 120) });
          console.log(`  created  ${b.name} (${made.id})`);
        } catch (e) {
          failed = true;
          console.log(`  FAILED   ${b.name}: ${e.message}`);
        }
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
