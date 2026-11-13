import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/notify.ts, run by tests/smoke.sh against an esbuild bundle of that file.
// Usage: node tests/notify.test.mjs <path to bundled notify.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const note = (group, problem) => (groups[group] ??= []).push(problem);
const expect = (group, got, want, label) => {
  if (got !== want) note(group, `${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

groups["levels"] = groups["levels"] ?? [];
for (const [input, want] of [
  [undefined, "urgent"],
  [null, "urgent"],
  ["", "urgent"],
  ["urgent", "urgent"],
  ["summaries", "summaries"],
  ["all", "all"],
  ["  ALL ", "all"],
  ["Summaries", "summaries"],
  ["everything", "urgent"],
  ["off", "urgent"],
]) expect("levels", t.resolveNotifyLevel(input), want, `resolveNotifyLevel(${JSON.stringify(input)})`);

groups["matrix"] = groups["matrix"] ?? [];
const table = {
  urgent: { urgent: true, summaries: false, all: false },
  summaries: { urgent: true, summaries: true, all: false },
  all: { urgent: true, summaries: true, all: true },
};
for (const level of Object.keys(table)) for (const tier of Object.keys(table[level])) expect("matrix", t.shouldPush(level, tier), table[level][tier], `${tier} at ${level}`);
expect("matrix", t.DEFAULT_NOTIFY_LEVEL, "urgent", "default level");

for (const g of ["levels", "matrix"]) console.log(`${g}: ${groups[g].length ? "FAIL " + groups[g].join("; ") : "PASS"}`);
