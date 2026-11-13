// Usage metering and guards (PLAN.md 8.3): what counts as which kind of operation, the free allowances, thresholds,
// forecasts and the parsing of Cloudflare's hourly figures. Pure logic, unit-tested in tests/usage.test.mjs.

/** Flat counters: "r2a.memory" (Class A on that prefix), "r2b.board", "do", "worker", "fetch". */
export type Counts = Record<string, number>;

// ---- R2 operations by class and prefix

export const BUCKETS = ["memory", "board", "history", "trash", "handoffs", "approvals", "exports", "files", "meta", "other"] as const;

/** A fixed set of prefix buckets, never free-form keys, so the counters stay small. */
export function prefixBucket(key: string): string {
  const first = key.split("/")[0];
  return (BUCKETS as readonly string[]).includes(first) && key.includes("/") ? first : "other";
}

export type R2Op = "get" | "head" | "list" | "put" | "delete";

/** Reads are Class B, writes and lists are Class A, deletes are free (Cloudflare R2 pricing). */
export function r2Class(op: R2Op): "a" | "b" | null {
  if (op === "get" || op === "head") return "b";
  if (op === "put" || op === "list") return "a";
  return null;
}

/** The counter key for one R2 call, or null when the call is free. For a list, `key` is the prefix being listed. */
export function countKey(op: R2Op, key: string): string | null {
  const cls = r2Class(op);
  return cls ? `r2${cls}.${prefixBucket(key)}` : null;
}

export function mergeCounts(into: Counts, add: Counts): void {
  for (const [k, v] of Object.entries(add)) into[k] = (into[k] ?? 0) + v;
}

/** Sum of every counter whose key is `name` or starts with `name.`. */
export function sumCounts(c: Counts, name: string): number {
  let n = 0;
  for (const [k, v] of Object.entries(c)) if (k === name || k.startsWith(`${name}.`)) n += v;
  return n;
}

/** Cloudflare's action names for R2 operations, by class. Unknown names are ignored. */
const CLASS_A_ACTIONS = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "ListObjectsV2", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "UploadPart", "UploadPartCopy", "ListMultipartUploads", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration",
]);
const CLASS_B_ACTIONS = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);

export function r2ActionClass(action: string): "a" | "b" | null {
  if (CLASS_A_ACTIONS.has(action)) return "a";
  if (CLASS_B_ACTIONS.has(action)) return "b";
  return null;
}

// ---- meters

export type Period = "day" | "month" | "none";

export interface MeterDef {
  id: string;
  label: string;
  allowance: number;
  period: Period; // daily meters reset at 00:00 UTC, monthly ones on the 1st at 00:00 UTC, storage never
  billed: boolean; // going over is billed, not refused
  forecast: boolean; // a month-end forecast applies (cumulative counts only)
  unit: "count" | "bytes";
  internal: string | null; // the counter that measures it live, or null when only Cloudflare's figures can
}

export const METERS: MeterDef[] = [
  { id: "r2_class_a", label: "R2 Class A operations (writes, lists)", allowance: 1_000_000, period: "month", billed: true, forecast: true, unit: "count", internal: "r2a" },
  { id: "r2_class_b", label: "R2 Class B operations (reads)", allowance: 10_000_000, period: "month", billed: true, forecast: true, unit: "count", internal: "r2b" },
  { id: "r2_storage", label: "R2 storage", allowance: 10_000_000_000, period: "none", billed: true, forecast: false, unit: "bytes", internal: null },
  { id: "worker_requests", label: "Worker requests (whole account)", allowance: 100_000, period: "day", billed: false, forecast: false, unit: "count", internal: "worker" },
  { id: "do_requests", label: "Durable Object requests", allowance: 100_000, period: "day", billed: false, forecast: false, unit: "count", internal: "do" },
  { id: "do_rows_read", label: "Durable Object rows read", allowance: 5_000_000, period: "day", billed: false, forecast: false, unit: "count", internal: null },
  { id: "do_rows_written", label: "Durable Object rows written", allowance: 100_000, period: "day", billed: false, forecast: false, unit: "count", internal: null },
  { id: "kv_reads", label: "Workers KV reads", allowance: 100_000, period: "day", billed: false, forecast: false, unit: "count", internal: null },
  { id: "kv_writes", label: "Workers KV writes, deletes and lists", allowance: 1_000, period: "day", billed: false, forecast: false, unit: "count", internal: null },
];

export const WARN_PCT = 70;
export const CRITICAL_PCT = 90;
/** A month-end forecast is ignored until this share of the month has passed: on day 1 a burst would project to 30 times its size. */
export const FORECAST_MIN_SHARE = 0.2;

const DAY_MS = 86_400_000;

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function periodStart(period: Period, nowMs: number): number {
  const d = new Date(nowMs);
  if (period === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return 0;
}

/** When the meter next resets, or null for one that never does. */
export function nextReset(period: Period, nowMs: number): number | null {
  if (period === "day") return periodStart("day", nowMs) + DAY_MS;
  if (period === "month") {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return null;
}

/** A label that changes when the period does; alerts are sent once per key. */
export function periodKey(period: Period, nowMs: number): string {
  if (period === "day") return utcDay(nowMs);
  if (period === "month") return utcDay(nowMs).slice(0, 7);
  return "-";
}

export function levelOf(pct: number): "ok" | "warn" | "critical" {
  return pct >= CRITICAL_PCT ? "critical" : pct >= WARN_PCT ? "warn" : "ok";
}

/** Projects this month's total from the month so far, or null while it is too early or nothing has been used. */
export function forecastMonth(used: number, nowMs: number): number | null {
  const start = periodStart("month", nowMs);
  const end = nextReset("month", nowMs) as number;
  const share = (nowMs - start) / (end - start);
  if (share < FORECAST_MIN_SHARE || used <= 0) return null;
  return Math.round(used / share);
}

export interface MeterReading {
  def: MeterDef;
  internal: number | null; // the live counter for the current period
  cloudflare: number | null; // Cloudflare's last hourly figure for the current period
  cloudflareAt: number | null;
  used: number | null; // the higher of the two, or null when neither is available
  pct: number | null;
  level: "ok" | "warn" | "critical" | null;
  forecast: number | null;
  forecastPct: number | null;
  critical: boolean; // at or above 90%, or a billed meter forecast to pass its allowance by month end
}

export function readMeter(def: MeterDef, internal: number | null, cloudflare: number | null, cloudflareAt: number | null, nowMs: number): MeterReading {
  const known = [internal, cloudflare].filter((v): v is number => v !== null);
  const used = known.length ? Math.max(...known) : null;
  const pct = used === null ? null : (used / def.allowance) * 100;
  const forecast = def.forecast && used !== null && def.period === "month" ? forecastMonth(used, nowMs) : null;
  const forecastPct = forecast === null ? null : (forecast / def.allowance) * 100;
  const level = pct === null ? null : levelOf(pct);
  const critical = level === "critical" || (def.billed && forecastPct !== null && forecastPct >= CRITICAL_PCT);
  return { def, internal, cloudflare, cloudflareAt, used, pct, level, forecast, forecastPct, critical };
}

export function formatAmount(def: MeterDef, value: number): string {
  if (def.unit === "bytes") return `${(value / 1_000_000_000).toFixed(3)} GB`;
  return Math.round(value).toLocaleString("en-US");
}

// ---- Cloudflare's own figures (GraphQL Analytics API)

export const ANALYTICS_QUERY = `query Usage($tag: String!, $monthStart: Time!, $dayStart: Time!, $now: Time!) {
  viewer {
    accounts(filter: { accountTag: $tag }) {
      r2Ops: r2OperationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $monthStart, datetime_leq: $now }) { dimensions { actionType } sum { requests } }
      r2Storage: r2StorageAdaptiveGroups(limit: 100, filter: { datetime_geq: $dayStart, datetime_leq: $now }) { max { payloadSize metadataSize } }
      workers: workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $dayStart, datetime_leq: $now }) { sum { requests } }
      doInv: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $dayStart, datetime_leq: $now }) { sum { requests } }
      doRows: durableObjectsPeriodicGroups(limit: 100, filter: { datetime_geq: $dayStart, datetime_leq: $now }) { sum { rowsRead rowsWritten } }
      kvOps: kvOperationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $dayStart, datetime_leq: $now }) { dimensions { actionType } sum { requests } }
    }
  }
}`;

export function analyticsVariables(accountId: string, nowMs: number): Record<string, string> {
  return {
    tag: accountId,
    monthStart: new Date(periodStart("month", nowMs)).toISOString(),
    dayStart: new Date(periodStart("day", nowMs)).toISOString(),
    now: new Date(nowMs).toISOString(),
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const rowsOf = (acct: Record<string, unknown>, name: string): Record<string, any>[] | null => (Array.isArray(acct[name]) ? (acct[name] as Record<string, any>[]) : null);

/**
 * Turns the GraphQL response into figures by meter id. Defensive on purpose: the dataset and field names are checked
 * against Cloudflare's schema on staging (PLAN.md 8.3), so a missing or renamed one becomes a problem line, not a crash.
 */
export function parseAnalytics(json: unknown): { values: Record<string, number>; problems: string[] } {
  const values: Record<string, number> = {};
  const problems: string[] = [];
  const root = json as { data?: { viewer?: { accounts?: Record<string, unknown>[] } }; errors?: { message?: unknown }[] } | null;
  if (root?.errors?.length) problems.push(`GraphQL errors: ${root.errors.map((e) => String(e?.message ?? "unknown").split("\n")[0]).join("; ")}`.slice(0, 300));
  const acct = root?.data?.viewer?.accounts?.[0];
  if (!acct) {
    problems.push("no account data returned");
    return { values, problems };
  }

  const ops = rowsOf(acct, "r2Ops");
  if (ops) {
    let a = 0;
    let b = 0;
    for (const r of ops) {
      const cls = r2ActionClass(String(r?.dimensions?.actionType ?? ""));
      if (cls === "a") a += num(r?.sum?.requests);
      else if (cls === "b") b += num(r?.sum?.requests);
    }
    values.r2_class_a = a;
    values.r2_class_b = b;
  } else problems.push("r2Ops not returned");

  const storage = rowsOf(acct, "r2Storage");
  if (storage) values.r2_storage = storage.reduce((n, r) => Math.max(n, num(r?.max?.payloadSize) + num(r?.max?.metadataSize)), 0);
  else problems.push("r2Storage not returned");

  const sumRequests = (name: string, id: string) => {
    const rows = rowsOf(acct, name);
    if (rows) values[id] = rows.reduce((n, r) => n + num(r?.sum?.requests), 0);
    else problems.push(`${name} not returned`);
  };
  sumRequests("workers", "worker_requests");
  sumRequests("doInv", "do_requests");

  const doRows = rowsOf(acct, "doRows");
  if (doRows) {
    values.do_rows_read = doRows.reduce((n, r) => n + num(r?.sum?.rowsRead), 0);
    values.do_rows_written = doRows.reduce((n, r) => n + num(r?.sum?.rowsWritten), 0);
  } else problems.push("doRows not returned");

  const kv = rowsOf(acct, "kvOps");
  if (kv) {
    let reads = 0;
    let writes = 0;
    for (const r of kv) {
      const action = String(r?.dimensions?.actionType ?? "").toLowerCase();
      if (action === "read") reads += num(r?.sum?.requests);
      else if (action === "write" || action === "delete" || action === "list") writes += num(r?.sum?.requests);
    }
    values.kv_reads = reads;
    values.kv_writes = writes;
  } else problems.push("kvOps not returned");

  return { values, problems };
}
