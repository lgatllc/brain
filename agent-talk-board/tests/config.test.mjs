import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Checks wrangler.jsonc: the staging environment (PLAN.md 0.18) lists every binding and variable the top level does,
// because nothing is inherited, and shares no resource with production.
// Usage: node tests/config.test.mjs <path to wrangler.jsonc>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const text = readFileSync(resolve(process.argv[2]), "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
const prod = JSON.parse(text);
const stg = prod.env?.staging;
const groups = {};
const expect = (group, ok, label) => {
  (groups[group] ??= []);
  if (!ok) groups[group].push(label);
};

expect("staging exists", Boolean(stg), "env.staging is missing");
const keys = (o) => Object.keys(o ?? {}).sort();
expect("same settings", JSON.stringify(keys(stg?.vars)) === JSON.stringify(keys(prod.vars)), `variables differ: staging has ${keys(stg?.vars)}, production has ${keys(prod.vars)}`);
expect("same settings", JSON.stringify(stg?.durable_objects) === JSON.stringify(prod.durable_objects), "durable object bindings differ");
expect("same settings", JSON.stringify(stg?.migrations) === JSON.stringify(prod.migrations), "migrations differ");
expect("same settings", JSON.stringify((stg?.kv_namespaces ?? []).map((k) => k.binding)) === JSON.stringify(prod.kv_namespaces.map((k) => k.binding)), "KV bindings differ");
expect("same settings", JSON.stringify((stg?.r2_buckets ?? []).map((b) => b.binding)) === JSON.stringify(prod.r2_buckets.map((b) => b.binding)), "R2 bindings differ");
expect("same settings", stg?.main === undefined || stg.main === prod.main, "staging must run the same code");

expect("own resources", stg?.name === "agent-talk-board-staging", "staging Worker name");
expect("own resources", stg?.r2_buckets?.[0]?.bucket_name && stg.r2_buckets[0].bucket_name !== prod.r2_buckets[0].bucket_name, "staging must use its own bucket");
expect("own resources", (stg?.kv_namespaces ?? []).every((k, i) => !k.id || k.id !== prod.kv_namespaces[i]?.id), "staging must not share a KV namespace id");
expect("own resources", /staging/i.test(stg?.vars?.INSTANCE_NAME ?? ""), "staging INSTANCE_NAME must say staging");
expect("own resources", stg?.vars?.INSTANCE_NAME !== prod.vars?.INSTANCE_NAME, "staging INSTANCE_NAME must differ");

expect("shared settings", ["OWNER_ACTOR", "OWNER_TIMEZONE", "CF_ACCOUNT_ID"].every((k) => stg?.vars?.[k] === prod.vars[k]), "owner actor, time zone and account id must match production");
expect("shared settings", !/secret|token|password/i.test(JSON.stringify(Object.keys(prod.vars))), "a variable name looks like a secret");

for (const g of ["staging exists", "same settings", "own resources", "shared settings"]) console.log(`${g}: ${groups[g]?.length ? "FAIL " + groups[g].join("; ") : "PASS"}`);
