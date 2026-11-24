import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for the pure parts of scripts/prod-setup.mjs, run by tests/smoke.sh.
// Usage: node tests/prod-setup.test.mjs
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const m = await import(pathToFileURL(resolve("scripts/prod-setup.mjs")).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

// which keys are copied
expect("keys", m.wantedKey("memory/firm/a.md"), true, "a concept");
expect("keys", m.wantedKey("memory/integrations/trainwel.md"), true, "an integration");
expect("keys", m.wantedKey("memory/protocol.md"), true, "the protocol");
expect("keys", m.wantedKey("memory/log.md"), false, "the staging log");
expect("keys", m.wantedKey("memory/inbox/2026-11-23-aaaa1111.md"), false, "a test capture");
expect("keys", m.wantedKey("memory/files/aaaa1111-x.md"), false, "a file concept");
expect("keys", m.wantedKey("board/general/x.md"), false, "the board");
expect("keys", m.wantedKey("approvals/x.json"), false, "approvals");
expect("keys", m.wantedKey("history/x.md"), false, "history");

// key paths
expect("paths", m.encodeKeyPath("b", "memory/a b/c&d.md"), "/b/memory/a%20b/c%26d.md", "spaces and ampersands");
expect("paths", m.encodeKeyPath("b", "memory/it's.md"), "/b/memory/it%27s.md", "an apostrophe");

// list parsing
const xml = "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken><Contents><Key>memory/a&amp;b.md</Key><Size>12</Size></Contents><Contents><Key>memory/c.md</Key><Size>3</Size></Contents></ListBucketResult>";
const page = m.parseList(xml);
expect("list", page.items, [{ key: "memory/a&b.md", size: 12 }, { key: "memory/c.md", size: 3 }], "keys and sizes");
expect("list", page.next, "tok&1", "the next page token");
expect("list", m.parseList("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"), { items: [], next: null }, "an empty last page");

// AWS's published Signature Version 4 example: GET Object with a Range header
const s = m.signRequest({
  method: "GET",
  host: "examplebucket.s3.amazonaws.com",
  path: "/test.txt",
  headers: { range: "bytes=0-9" },
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  now: new Date("2013-05-24T00:00:00Z"),
  region: "us-east-1",
});
expect("signing", /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/.test(s.headers.Authorization), true, "matches AWS's example signature");
expect("signing", s.headers.host, undefined, "host is left to fetch");

for (const [g, errs] of Object.entries(groups)) console.log(errs.length ? `${g}: FAIL ${errs.join("; ")}` : `${g}: PASS`);
