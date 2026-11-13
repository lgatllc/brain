// Owner time zone helpers (PLAN.md 4.7, Phase 0.17).
//
// Storage keeps absolute instants (epoch milliseconds or ISO strings with an offset). These helpers convert at the
// edges: which calendar day it is for the owner, when the next 03:00 local is, how to show a time with its offset,
// and how to read a time the owner typed without an offset. They depend on nothing but `Intl`, so they can be
// unit-tested in plain Node (tests/time.test.mjs) across daylight saving changes.

export const DEFAULT_TIME_ZONE = "America/Chicago";

/** The given IANA zone if it is valid, otherwise the default. */
export function resolveTimeZone(tz?: string): string {
  const name = (tz ?? "").trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

function partsAt(t: number, tz: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(t))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, min: out.minute, s: out.second };
}

/** Offset of the zone from UTC at instant `t`, in minutes (Central: -360 in winter, -300 in summer). */
export function offsetMinutes(t: number, tz: string): number {
  const p = partsAt(t, tz);
  const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return Math.round((wallAsUtc - Math.floor(t / 1000) * 1000) / 60_000);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The owner's calendar day at instant `t`, as YYYY-MM-DD. */
export function ownerDay(t: number, tz: string): string {
  const p = partsAt(t, tz);
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

/** Shifts a YYYY-MM-DD day by whole calendar days (not 24-hour blocks, so daylight saving cannot skip or repeat a day). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** An ISO 8601 timestamp with the zone's offset, for example 2026-11-13T09:12:00-06:00. */
export function isoWithOffset(t: number, tz: string): string {
  const p = partsAt(t, tz);
  const off = offsetMinutes(t, tz);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}:${pad(p.s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A short human form, for example "Fri, 11/13/2026, 09:12 AM CST". */
export function formatLocal(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(t));
}

/**
 * The instant at which the zone's wall clock reads y-m-d h:min. A time that occurs twice (the hour repeated when
 * clocks go back) resolves to its first occurrence; a time that does not exist (skipped when clocks go forward)
 * resolves to the same reading shifted forward by the skipped hour.
 */
function wallToInstant(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, h, min, 0);
  const before = offsetMinutes(wall - 86_400_000, tz);
  const after = offsetMinutes(wall + 86_400_000, tz);
  const valid = [...new Set([before, after])].filter((o) => offsetMinutes(wall - o * 60_000, tz) === o).map((o) => wall - o * 60_000);
  return valid.length ? Math.min(...valid) : wall - before * 60_000;
}

/** The first instant strictly after `now` at which the zone's wall clock reads hour:minute. */
export function nextLocalTime(now: number, tz: string, hour: number, minute: number): number {
  const p = partsAt(now, tz);
  const today = wallToInstant(p.y, p.m, p.d, hour, minute, tz);
  if (today > now) return today;
  const [y, m, d] = addDays(`${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`, 1).split("-").map(Number);
  return wallToInstant(y, m, d, hour, minute, tz);
}

/**
 * Reads a date and time. With a trailing Z or offset it is taken as written; without one ("2026-11-20T09:00",
 * "2026-11-20 09:00") it is the owner's local time. Returns null when it is not a date with a time.
 */
export function parseWhen(text: string, tz: string): number | null {
  const s = text.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, min] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59) return null;
  return wallToInstant(y, mo, d, h, min, tz) + Number(m[6] ?? 0) * 1000;
}
