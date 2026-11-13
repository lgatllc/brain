import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Unit tests for src/time.ts, run by tests/smoke.sh against an esbuild bundle of that file.
// Usage: node tests/time.test.mjs <path to bundled time.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.
//
// US Central 2026: clocks go forward Sun 8 March at 02:00 CST (08:00Z) and back Sun 1 November at 02:00 CDT (07:00Z).
// So 8 March is a 23-hour day and 1 November is a 25-hour day.

const t = await import(pathToFileURL(resolve(process.argv[2])).href);
const TZ = "America/Chicago";
const z = (iso) => Date.parse(iso);
const groups = {};
const check = (group, label, actual, expected) => {
  const g = (groups[group] ??= []);
  if (actual !== expected) g.push(`${label}: got ${actual}, expected ${expected}`);
};

// ownerDay: the calendar day flips at local midnight, on both sides of both changes
for (const [at, day] of [
  ["2026-07-02T04:59:59Z", "2026-07-01"], ["2026-07-02T05:00:00Z", "2026-07-02"], // summer, CDT
  ["2026-12-02T05:59:59Z", "2026-12-01"], ["2026-12-02T06:00:00Z", "2026-12-02"], // winter, CST
  ["2026-03-08T05:59:59Z", "2026-03-07"], ["2026-03-08T06:00:00Z", "2026-03-08"], // spring forward day starts
  ["2026-03-09T04:59:59Z", "2026-03-08"], ["2026-03-09T05:00:00Z", "2026-03-09"], // and ends (23 hours later)
  ["2026-11-01T04:59:59Z", "2026-10-31"], ["2026-11-01T05:00:00Z", "2026-11-01"], // fall back day starts
  ["2026-11-02T05:59:59Z", "2026-11-01"], ["2026-11-02T06:00:00Z", "2026-11-02"], // and ends (25 hours later)
]) check("ownerDay", at, t.ownerDay(z(at), TZ), day);

// nextLocalTime at midnight (the daily limit reset)
for (const [now, want] of [
  ["2026-03-07T12:00:00Z", "2026-03-08T06:00:00.000Z"],
  ["2026-03-08T06:00:00Z", "2026-03-09T05:00:00.000Z"], // exactly midnight: strictly after, 23 hours later
  ["2026-10-31T12:00:00Z", "2026-11-01T05:00:00.000Z"],
  ["2026-11-01T05:00:00Z", "2026-11-02T06:00:00.000Z"], // 25 hours later
]) check("midnight reset across daylight saving", now, new Date(t.nextLocalTime(z(now), TZ, 0, 0)).toISOString(), want);

// nextLocalTime at 03:00 (the nightly backup) and 02:00 (the nightly sweep)
for (const [now, h, want] of [
  ["2026-07-01T12:00:00Z", 3, "2026-07-02T08:00:00.000Z"],
  ["2026-03-07T12:00:00Z", 3, "2026-03-08T08:00:00.000Z"], // 03:00 CDT, the hour after the clocks jump
  ["2026-03-08T08:00:00Z", 3, "2026-03-09T08:00:00.000Z"],
  ["2026-10-31T12:00:00Z", 3, "2026-11-01T09:00:00.000Z"], // 03:00 CST after the repeated hour
  ["2026-11-01T09:00:00Z", 3, "2026-11-02T09:00:00.000Z"],
  ["2026-03-07T12:00:00Z", 2, "2026-03-08T08:00:00.000Z"], // 02:00 does not exist on 8 March: shifted forward
  ["2026-10-31T12:00:00Z", 2, "2026-11-01T08:00:00.000Z"], // 02:00 CST, after the repeated 01:00 hour
]) check("backup and sweep times across daylight saving", `${now} @${h}`, new Date(t.nextLocalTime(z(now), TZ, h, 0)).toISOString(), want);

// parseWhen: a time with no offset is the owner's local time
for (const [text, want] of [
  ["2026-07-04T09:00", "2026-07-04T14:00:00.000Z"],
  ["2026-12-04 09:00", "2026-12-04T15:00:00.000Z"],
  ["2026-07-04T09:00:00Z", "2026-07-04T09:00:00.000Z"],
  ["2026-07-04T09:00:00-05:00", "2026-07-04T14:00:00.000Z"],
  ["2026-11-01T01:30", "2026-11-01T06:30:00.000Z"], // repeated hour: first occurrence
  ["2026-03-08T02:30", "2026-03-08T08:30:00.000Z"], // skipped hour: shifted forward
]) check("parseWhen", text, new Date(t.parseWhen(text, TZ)).toISOString(), want);
for (const bad of ["2026-07-04", "tomorrow", "2026-13-04T09:00", "2026-07-04T25:00"]) check("parseWhen", `rejects ${bad}`, t.parseWhen(bad, TZ), null);

// isoWithOffset and offsets
check("isoWithOffset", "summer", t.isoWithOffset(z("2026-07-04T14:00:00Z"), TZ), "2026-07-04T09:00:00-05:00");
check("isoWithOffset", "winter", t.isoWithOffset(z("2026-12-04T15:00:00Z"), TZ), "2026-12-04T09:00:00-06:00");
check("isoWithOffset", "offset minutes summer", t.offsetMinutes(z("2026-07-04T14:00:00Z"), TZ), -300);
check("isoWithOffset", "offset minutes winter", t.offsetMinutes(z("2026-12-04T15:00:00Z"), TZ), -360);

// addDays counts calendar days, and resolveTimeZone falls back to Central
check("addDays and resolveTimeZone", "forward over DST", t.addDays("2026-03-07", 1), "2026-03-08");
check("addDays and resolveTimeZone", "back over month", t.addDays("2026-03-01", -1), "2026-02-28");
check("addDays and resolveTimeZone", "over year", t.addDays("2026-12-31", 1), "2027-01-01");
check("addDays and resolveTimeZone", "invalid zone", t.resolveTimeZone("Not/AZone"), "America/Chicago");
check("addDays and resolveTimeZone", "unset zone", t.resolveTimeZone(undefined), "America/Chicago");
check("addDays and resolveTimeZone", "valid zone kept", t.resolveTimeZone("America/New_York"), "America/New_York");

let failed = 0;
for (const [group, problems] of Object.entries(groups)) {
  if (problems.length) failed++;
  console.log(`${group}: ${problems.length ? `FAIL ${problems.join("; ")}` : "PASS"}`);
}
process.exit(failed ? 1 : 0);
