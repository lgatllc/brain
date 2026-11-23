import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/files.ts, run by tests/smoke.sh.
// Usage: node tests/files.test.mjs <path to bundled files.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

expect("names", ["Manual.html", "../../Manual.html", "C:\\x\\My Manual (v2).HTML", "a b.htm", ".hidden.html", "x.pdf", "", "...html", "-.html", "a".repeat(200) + ".html"].map(t.safeHtmlName),
  ["Manual.html", "Manual.html", "My-Manual-v2.html", "a-b.htm", "hidden.html", null, null, null, null, "a".repeat(70) + ".html"], "file names");
expect("names", t.safeHtmlName("über.html"), "uber.html", "accents are folded");
expect("names", t.safeHtmlName(undefined), null, "not a string");

expect("keys", t.htmlFileKey(new Date("2026-11-23T10:00:00Z"), "ab12cd34", "Manual.html"), "files/html/2026/11/ab12cd34-Manual.html", "a key");
expect("keys", ["files/html/2026/11/ab12cd34-Manual.html", "file:files/html/2026/11/ab12cd34-Manual.html", "files/html/backups/27-2026-11-23T10-00-00-000Z.html", "memory/protocol.md", "files/html/../x.html", "files/html/a/./b.html", "files/html/x.pdf", "files/other/x.html", "files/html/", "", "files/html/a b.html"].map(t.htmlKeyFrom),
  ["files/html/2026/11/ab12cd34-Manual.html", "files/html/2026/11/ab12cd34-Manual.html", "files/html/backups/27-2026-11-23T10-00-00-000Z.html", null, null, null, null, null, null, null, null], "which keys are accepted");

expect("scan", t.withoutDataUris('<p>a</p><img src="data:image/png;base64,AAAAKIAIOSFODNN7EXAMPLEAAA=="><p>b</p>'), '<p>a</p><img src="data:"><p>b</p>', "a picture is cut out");
expect("scan", t.withoutDataUris("<p>sk-abcdefghijklmnopqrstuvwxyz0123</p>").includes("sk-abcdefghijklmnopqrstuvwxyz0123"), true, "text outside a picture is kept");
expect("scan", t.withoutDataUris("<p>no pictures</p>"), "<p>no pictures</p>", "nothing to cut");
const big = "A".repeat(6 * 1024 * 1024);
const t0 = Date.now();
expect("scan", t.withoutDataUris(`<img src="data:image/png;base64,${big}">`), '<img src="data:">', "a 6 MB picture is cut out");
expect("scan", Date.now() - t0 < 2000, true, "and quickly");

const sample = '<h2>T</h2><table><tr><td>x</td></tr></table><img src="data:image/png;base64,AAAA"><img src="https://e.com/a.png"><iframe src="x"></iframe><script>1</script>';
const st = t.htmlStats(sample);
expect("stats", [st.images, st.embeddedImages, st.tables, st.embeds, st.scripts], [2, 1, 1, 1, 1], "what the HTML holds");
expect("stats", t.htmlStats(null).chars, 0, "not a string");
expect("stats", t.describeStats(st).includes("2 images (1 embedded in the HTML)"), true, "the description names embedded images");
expect("stats", t.describeStats(t.htmlStats("x".repeat(3 * 1024 * 1024))).startsWith("3.0 MB"), true, "sizes in MB");
expect("stats", [t.looksLikeHtml("<p>x</p>"), t.looksLikeHtml("<!doctype html><html>"), t.looksLikeHtml("just words"), t.looksLikeHtml("a < b and c > d"), t.looksLikeHtml("")], [true, true, false, false, false], "what looks like HTML");

for (const g of ["names", "keys", "scan", "stats"]) console.log(`${g}: ${groups[g]?.length ? "FAIL " + groups[g].join("; ") : "PASS"}`);
