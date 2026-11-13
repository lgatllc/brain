import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/why.ts, run by tests/smoke.sh against an esbuild bundle of that file.
// Usage: node tests/why.test.mjs <path to bundled why.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const note = (group, problem) => (groups[group] ??= []).push(problem);

// sentences that explain something are accepted
for (const ok of [
  "Pipeline stages agreed for the CRM",
  "Fix typo in the title",
  "Moved to match the new folder layout",
  "Owner asked for this",
  "Added Q4 numbers",
  "   Pipeline stages agreed   ",
  "Superseded by the 2026 policy",
]) {
  groups.accepted ??= [];
  if (t.whyProblem(ok) !== null) note("accepted", `${JSON.stringify(ok)} was refused: ${t.whyProblem(ok)}`);
}

// empty, tiny, filler and mechanical text is refused
for (const bad of ["", "   ", "x", "update", "Updated", "n/a", "test", "none", "tbd", "wip", "asdf asdf", "aaaaaaaaaaaa", "..........", "ok ok ok ok ok", "see above", "no reason", "Test write", "testing testing", "just because", "a b c d e", "to do it"]) {
  groups.refused ??= [];
  if (t.whyProblem(bad) === null) note("refused", `${JSON.stringify(bad)} was accepted`);
}

// values that are not strings are refused
for (const bad of [undefined, null, 5, {}, ["a sentence in an array"]]) {
  groups["not a string"] ??= [];
  if (t.whyProblem(bad) === null) note("not a string", `${JSON.stringify(bad)} was accepted`);
}

// the message tells the agent what to do, and does not echo a long input
groups.messages ??= [];
if (!t.whyProblem("").includes("Pipeline stages agreed for the CRM")) note("messages", "empty: no example in the message");
if (!t.whyProblem("update").includes("filler") && !t.whyProblem("update").includes("too short")) note("messages", "filler: message does not say why");
if (t.whyProblem("testing testing testing testing testing testing testing testing testing").length > 220) note("messages", "long input echoed in full");

let failed = 0;
for (const [group, problems] of Object.entries(groups)) {
  if (problems.length) failed++;
  console.log(`${group}: ${problems.length ? `FAIL ${problems.join("; ")}` : "PASS"}`);
}
process.exit(failed ? 1 : 0);
