// The required `why` on every write (PLAN.md 4.9, Phase 0.23).
//
// A write has to say, in one sentence, why it matters later. The server cannot judge whether a sentence is true or
// useful, but it can refuse the empty, the tiny and the obvious filler, which is what an agent writes when it wants
// the check out of the way. Dependency-free so it can be unit-tested in plain Node (tests/why.test.mjs).

/** What `why` should look like, shown in every tool that requires it. */
export const WHY_DESCRIPTION =
  "Required. One sentence on why this change matters later, for example \"Pipeline stages agreed for the CRM\". It appears in log.md, the activity feed and the board.";

const EXAMPLE = 'for example "Pipeline stages agreed for the CRM"';

// Phrases that carry no information, compared after lowercasing and stripping punctuation.
const FILLER = new Set([
  "update", "updated", "updates", "updating", "change", "changes", "edit", "edits", "fix", "fixed", "fixes",
  "na", "n a", "none", "nothing", "no reason", "not applicable", "no why", "no comment",
  "test", "testing", "test write", "test update", "a test", "just a test", "just testing",
  "misc", "miscellaneous", "stuff", "things", "asdf", "qwerty", "ok", "okay", "yes",
  "because", "just because", "why", "reason", "see above", "as above", "same as above", "wip", "tbd", "todo",
  "write", "save", "saved", "done",
]);

/** Returns an error message if `why` is not acceptable, otherwise null. */
export function whyProblem(why: unknown): string | null {
  if (typeof why !== "string") return `A why is required: one sentence on why this matters later, ${EXAMPLE}.`;
  const text = why.trim().replace(/\s+/g, " ");
  if (!text) return `The why is empty. Give one sentence on why this matters later, ${EXAMPLE}.`;
  const plain = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const words = plain.split(" ").filter(Boolean);
  if (text.length < 10 || words.length < 2) return `The why is too short to explain anything. Write one sentence on why this matters later, ${EXAMPLE}.`;
  if (FILLER.has(plain) || new Set(words).size === 1 || plain.replace(/ /g, "").length < 6 || /^(.)\1+$/.test(plain.replace(/ /g, ""))) {
    return `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}" is filler, not a reason. Write one sentence on why this matters later, ${EXAMPLE}.`;
  }
  return null;
}
