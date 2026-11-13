import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/usage.ts, run by tests/smoke.sh against an esbuild bundle of that file.
// Usage: node tests/usage.test.mjs <path to bundled usage.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const u = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};
const ms = (iso) => Date.parse(iso);

// operation classes
for (const [op, want] of [["get", "b"], ["head", "b"], ["put", "a"], ["list", "a"], ["delete", null]]) expect("r2 classes", u.r2Class(op), want, op);
expect("r2 classes", u.countKey("put", "memory/a.md"), "r2a.memory", "put memory");
expect("r2 classes", u.countKey("get", "board/t/x.md"), "r2b.board", "get board");
expect("r2 classes", u.countKey("list", "history/"), "r2a.history", "list history");
expect("r2 classes", u.countKey("delete", "memory/a.md"), null, "delete is free");
expect("r2 classes", u.r2ActionClass("PutObject"), "a", "PutObject");
expect("r2 classes", u.r2ActionClass("GetObject"), "b", "GetObject");
expect("r2 classes", u.r2ActionClass("DeleteObject"), null, "DeleteObject");

// prefix buckets are a fixed set
for (const [key, want] of [["memory/x.md", "memory"], ["meta/redactions.json", "meta"], ["files/a.pdf", "files"], ["memory", "other"], ["hooks/trello/abc", "other"], ["", "other"], ["memoryx/a", "other"], ["exports/1.tar", "exports"]]) expect("prefix buckets", u.prefixBucket(key), want, key);

// counters
{
  const c = {};
  u.mergeCounts(c, { "r2a.memory": 2, do: 1 });
  u.mergeCounts(c, { "r2a.memory": 1, "r2a.board": 4, "r2b.board": 7 });
  expect("counters", c["r2a.memory"], 3, "merged");
  expect("counters", u.sumCounts(c, "r2a"), 7, "sum class a");
  expect("counters", u.sumCounts(c, "r2b"), 7, "sum class b");
  expect("counters", u.sumCounts(c, "do"), 1, "exact name");
  expect("counters", u.sumCounts(c, "r2"), 0, "no partial names");
}

// periods: daily meters reset at 00:00 UTC (6 or 7 pm Central), monthly ones on the 1st
expect("periods", new Date(u.nextReset("day", ms("2026-11-13T15:00:00Z"))).toISOString(), "2026-11-14T00:00:00.000Z", "next day reset");
expect("periods", new Date(u.nextReset("month", ms("2026-11-13T15:00:00Z"))).toISOString(), "2026-12-01T00:00:00.000Z", "next month reset");
expect("periods", new Date(u.nextReset("month", ms("2026-12-31T23:59:59Z"))).toISOString(), "2027-01-01T00:00:00.000Z", "month reset across a year");
expect("periods", u.nextReset("none", Date.now()), null, "storage never resets");
expect("periods", u.periodKey("day", ms("2026-11-13T23:59:00Z")), "2026-11-13", "day key");
expect("periods", u.periodKey("month", ms("2026-11-13T23:59:00Z")), "2026-11", "month key");
expect("periods", u.periodKey("day", ms("2026-11-14T00:00:00Z")), "2026-11-14", "day key changes at UTC midnight");
expect("periods", u.utcDay(ms("2026-03-08T07:30:00Z")), "2026-03-08", "utc day across a daylight saving date");
expect("periods", new Date(u.periodStart("month", ms("2026-11-30T23:00:00Z"))).toISOString(), "2026-11-01T00:00:00.000Z", "month start");

// thresholds
for (const [pct, want] of [[0, "ok"], [69.9, "ok"], [70, "warn"], [89.9, "warn"], [90, "critical"], [250, "critical"]]) expect("levels", u.levelOf(pct), want, String(pct));

// forecast: ignored early in the month so one burst cannot pause the brain
expect("forecast", u.forecastMonth(500_000, ms("2026-11-01T12:00:00Z")), null, "day 1 burst is not projected");
expect("forecast", u.forecastMonth(500_000, ms("2026-11-05T00:00:00Z")), null, "before 20 percent of the month");
expect("forecast", u.forecastMonth(0, ms("2026-11-20T00:00:00Z")), null, "nothing used");
expect("forecast", u.forecastMonth(500_000, ms("2026-11-16T00:00:00Z")), 1_000_000, "half way through the month");
{
  const def = u.METERS.find((m) => m.id === "r2_class_a");
  const early = u.readMeter(def, 600_000, null, null, ms("2026-11-02T00:00:00Z"));
  expect("forecast", early.critical, false, "a big early burst alone does not trigger the guard");
  const projected = u.readMeter(def, 460_000, null, null, ms("2026-11-16T00:00:00Z"));
  expect("forecast", projected.critical, true, "forecast above 90 percent triggers the guard on a billed meter");
  expect("forecast", projected.level, "ok", "its current level is still ok");
  const free = u.readMeter(u.METERS.find((m) => m.id === "do_requests"), 30_000, null, null, ms("2026-11-16T00:00:00Z"));
  expect("forecast", free.forecast, null, "a daily meter has no month forecast");
}

// readings combine the live counter and Cloudflare's figure
{
  const def = u.METERS.find((m) => m.id === "r2_class_b");
  const r = u.readMeter(def, 9_100_000, 9_300_000, 1, ms("2026-11-28T00:00:00Z"));
  expect("readings", r.used, 9_300_000, "takes the higher figure");
  expect("readings", Math.round(r.pct), 93, "percent");
  expect("readings", r.level, "critical", "level");
  const none = u.readMeter(u.METERS.find((m) => m.id === "kv_writes"), null, null, null, Date.now());
  expect("readings", [none.used, none.pct, none.level, none.critical], [null, null, null, false], "no data is not a reading");
  expect("readings", u.formatAmount(u.METERS.find((m) => m.id === "r2_storage"), 2_500_000_000), "2.500 GB", "bytes shown as GB");
  expect("readings", u.formatAmount(def, 1234567), "1,234,567", "counts with separators");
}

// the allowances are the documented ones
{
  const byId = Object.fromEntries(u.METERS.map((m) => [m.id, m]));
  expect("allowances", [byId.r2_class_a.allowance, byId.r2_class_b.allowance, byId.worker_requests.allowance, byId.do_requests.allowance, byId.kv_writes.allowance], [1_000_000, 10_000_000, 100_000, 100_000, 1_000], "allowances");
  expect("allowances", [byId.r2_class_a.billed, byId.r2_class_b.billed, byId.r2_storage.billed, byId.do_requests.billed, byId.kv_writes.billed], [true, true, true, false, false], "only R2 bills");
}

// Cloudflare's response
{
  const good = {
    data: {
      viewer: {
        accounts: [
          {
            r2Ops: [
              { dimensions: { actionType: "PutObject" }, sum: { requests: 100 } },
              { dimensions: { actionType: "ListObjects" }, sum: { requests: 20 } },
              { dimensions: { actionType: "GetObject" }, sum: { requests: 900 } },
              { dimensions: { actionType: "DeleteObject" }, sum: { requests: 55 } },
            ],
            r2Storage: [{ max: { payloadSize: 1000, metadataSize: 24 } }, { max: { payloadSize: 3000, metadataSize: 100 } }],
            workers: [{ sum: { requests: 40 } }],
            doInv: [{ sum: { requests: 30 } }],
            doRows: [{ sum: { rowsRead: 500, rowsWritten: 60 } }],
            kvOps: [
              { dimensions: { actionType: "read" }, sum: { requests: 7 } },
              { dimensions: { actionType: "write" }, sum: { requests: 3 } },
              { dimensions: { actionType: "delete" }, sum: { requests: 1 } },
            ],
          },
        ],
      },
    },
  };
  const p = u.parseAnalytics(good);
  expect("analytics", p.problems, [], "no problems");
  expect("analytics", p.values, { r2_class_a: 120, r2_class_b: 900, r2_storage: 3100, worker_requests: 40, do_requests: 30, do_rows_read: 500, do_rows_written: 60, kv_reads: 7, kv_writes: 4 }, "values");
  const partial = u.parseAnalytics({ data: { viewer: { accounts: [{ r2Ops: [] }] } } });
  expect("analytics", partial.values.r2_class_a, 0, "an empty section is zero");
  expect("analytics", partial.problems.length, 5, "each missing section is a problem line, not a crash");
  expect("analytics", u.parseAnalytics({ errors: [{ message: "unknown field durableObjectsPeriodicGroups\nmore detail" }] }).problems[0].includes("more detail"), false, "only the first line of an error");
  expect("analytics", u.parseAnalytics(null).problems.length > 0, true, "null response");
  expect("analytics", u.parseAnalytics({ data: { viewer: { accounts: [{ r2Ops: [{ dimensions: { actionType: "PutObject" }, sum: { requests: -5 } }, { dimensions: {}, sum: {} }] }] } } }).values.r2_class_a, 0, "bad numbers are zero");
  const v = u.analyticsVariables("acct1", ms("2026-11-13T15:30:00Z"));
  expect("analytics", [v.tag, v.monthStart, v.dayStart], ["acct1", "2026-11-01T00:00:00.000Z", "2026-11-13T00:00:00.000Z"], "variables");
  expect("analytics", u.ANALYTICS_QUERY.includes("r2OperationsAdaptiveGroups") && u.ANALYTICS_QUERY.includes("kvOperationsAdaptiveGroups"), true, "query names the datasets");
}

for (const g of ["r2 classes", "prefix buckets", "counters", "periods", "levels", "forecast", "readings", "allowances", "analytics"]) console.log(`${g}: ${groups[g]?.length ? "FAIL " + groups[g].join("; ") : "PASS"}`);
