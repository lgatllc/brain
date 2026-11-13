// Verification of the Cloudflare Access token (PLAN.md 0.27). Cloudflare Access in front of /approve/* and /dashboard/*
// stops anonymous visitors at the edge; the Worker checks the token as well, so a request that reaches it some other way
// (a path the Access application does not cover, a misconfiguration) is still refused. Pure logic: the public keys are
// passed in, so it is unit-tested with locally generated keys (tests/access.test.mjs).

export interface AccessKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

export interface AccessConfig {
  teamDomain: string; // e.g. "firm.cloudflareaccess.com"
  audience: string; // the Access application's audience tag
  ownerEmail: string; // the only email accepted
}

export type ConfigResult = { ok: true; config: AccessConfig } | { ok: false; reason: string };

const TEAM_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.cloudflareaccess\.com$/i;

/** All three settings are needed. A missing or malformed one means the owner pages stay disabled (fail closed). */
export function accessConfig(env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; OWNER_EMAIL?: string }): ConfigResult {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().toLowerCase();
  const audience = (env.ACCESS_AUD ?? "").trim();
  const ownerEmail = (env.OWNER_EMAIL ?? "").trim().toLowerCase();
  if (!teamDomain || !audience || !ownerEmail) return { ok: false, reason: "ACCESS_TEAM_DOMAIN, ACCESS_AUD and OWNER_EMAIL must all be set" };
  if (!TEAM_DOMAIN_RE.test(teamDomain)) return { ok: false, reason: "ACCESS_TEAM_DOMAIN must look like name.cloudflareaccess.com" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) return { ok: false, reason: "OWNER_EMAIL is not an email address" };
  return { ok: true, config: { teamDomain, audience, ownerEmail } };
}

/** Short codes only: they say which check failed without revealing any expected value. */
export type AccessFailure = "missing" | "malformed" | "alg" | "key" | "signature" | "iss" | "aud" | "exp" | "email";
export type AccessResult = { ok: true; email: string } | { ok: false; reason: AccessFailure };

const CLOCK_SKEW_SECONDS = 60;

function b64urlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function parseJson(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The key id in the token's header, so the caller can tell a stale key list from a bad token. Null if unreadable. */
export function tokenKeyId(token: string): string | null {
  const header = parseJson(b64urlToBytes(token.split(".")[0] ?? ""));
  return typeof header?.kid === "string" ? header.kid : null;
}

export async function verifyAccessJwt(token: string | null | undefined, keys: AccessKey[], config: AccessConfig, nowSec: number): Promise<AccessResult> {
  if (!token) return { ok: false, reason: "missing" };
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 8192) return { ok: false, reason: "malformed" };
  const header = parseJson(b64urlToBytes(parts[0]));
  const payload = parseJson(b64urlToBytes(parts[1]));
  const signature = b64urlToBytes(parts[2]);
  if (!header || !payload || !signature || !signature.length) return { ok: false, reason: "malformed" };

  // Only RS256 is accepted: never "none", never a shared-secret algorithm.
  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  const jwk = typeof header.kid === "string" ? keys.find((k) => k.kid === header.kid && k.kty === "RSA") : undefined;
  if (!jwk) return { ok: false, reason: "key" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };

  if (payload.iss !== `https://${config.teamDomain}`) return { ok: false, reason: "iss" };
  const aud = payload.aud;
  if (!(typeof aud === "string" ? aud === config.audience : Array.isArray(aud) && aud.includes(config.audience))) return { ok: false, reason: "aud" };
  const exp = payload.exp;
  const nbf = payload.nbf;
  if (typeof exp !== "number" || exp <= nowSec) return { ok: false, reason: "exp" };
  if (typeof nbf === "number" && nbf > nowSec + CLOCK_SKEW_SECONDS) return { ok: false, reason: "exp" };
  // A service token carries no email, so it can never pass for the owner.
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || email !== config.ownerEmail) return { ok: false, reason: "email" };
  return { ok: true, email };
}
