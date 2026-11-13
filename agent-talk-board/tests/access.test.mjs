import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeKey, signJwt } from "./access-jwt.mjs";

// Unit tests for src/access.ts, run by tests/smoke.sh against an esbuild bundle of that file.
// Usage: node tests/access.test.mjs <path to bundled access.mjs>
// Prints one "<group>: PASS" or "<group>: FAIL <details>" line per group.

const a = await import(pathToFileURL(resolve(process.argv[2])).href);
const groups = {};
const expect = (group, got, want, label) => {
  (groups[group] ??= []);
  if (JSON.stringify(got) !== JSON.stringify(want)) groups[group].push(`${label}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
};

const config = { teamDomain: "firm.cloudflareaccess.com", audience: "aud-123", ownerEmail: "owner@firm.example" };
const now = 1_800_000_000;
const good = { iss: "https://firm.cloudflareaccess.com", aud: ["aud-123"], email: "owner@firm.example", exp: now + 600, iat: now - 10, nbf: now - 10 };
const key = makeKey("k1");
const other = makeKey("k1"); // same key id, different key
const keys = [key.jwk];
const check = async (claims, opts = {}) => {
  const token = opts.token ?? signJwt(opts.key ?? key.privateKey, claims, opts.header ?? { kid: "k1" });
  const r = await a.verifyAccessJwt(token, opts.keys ?? keys, config, now);
  return r.ok ? "ok:" + r.email : r.reason;
};

// a good token
expect("accepts", await check(good), "ok:owner@firm.example", "valid token");
expect("accepts", await check({ ...good, aud: "aud-123" }), "ok:owner@firm.example", "aud as a string");
expect("accepts", await check({ ...good, aud: ["other", "aud-123"] }), "ok:owner@firm.example", "aud among several");
expect("accepts", await check({ ...good, email: "Owner@Firm.Example" }), "ok:owner@firm.example", "email compared without case");
expect("accepts", await check({ ...good, nbf: now + 30 }), "ok:owner@firm.example", "small clock skew");
expect("accepts", await check(good, { keys: [other.jwk, key.jwk].map((k, i) => (i === 0 ? { ...k, kid: "zz" } : k)) }), "ok:owner@firm.example", "picks the key by id");

// signature and algorithm
expect("signature", await check(good, { key: other.privateKey }), "signature", "signed with another key");
{
  const t = signJwt(key.privateKey, good, { kid: "k1" }).split(".");
  const forged = `${t[0]}.${Buffer.from(JSON.stringify({ ...good, email: "attacker@evil.example" })).toString("base64url")}.${t[2]}`;
  expect("signature", await check(good, { token: forged }), "signature", "payload changed after signing");
}
expect("signature", await check(good, { header: { kid: "k1", alg: "none" } }), "alg", "alg none");
expect("signature", await check(good, { header: { kid: "k1", alg: "HS256" } }), "alg", "alg HS256");
expect("signature", await check(good, { token: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(good)).toString("base64url")}.` }), "malformed", "unsigned token");
expect("signature", await check(good, { header: { kid: "unknown" } }), "key", "unknown key id");
expect("signature", await check(good, { keys: [] }), "key", "no keys");

// claims
expect("claims", await check({ ...good, iss: "https://evil.cloudflareaccess.com" }), "iss", "another team");
expect("claims", await check({ ...good, iss: "https://firm.cloudflareaccess.com/" }), "iss", "issuer must match exactly");
expect("claims", await check({ ...good, aud: ["other-app"] }), "aud", "another application");
expect("claims", await check({ ...good, aud: undefined }), "aud", "no audience");
expect("claims", await check({ ...good, exp: now - 1 }), "exp", "expired");
expect("claims", await check({ ...good, exp: now }), "exp", "expires now");
expect("claims", await check({ ...good, exp: undefined }), "exp", "no expiry");
expect("claims", await check({ ...good, nbf: now + 3600 }), "exp", "not valid yet");
expect("claims", await check({ ...good, email: "someone@firm.example" }), "email", "another user");
expect("claims", await check({ ...good, email: undefined, common_name: "service-token-id" }), "email", "service token without an email");
expect("claims", await check({ ...good, email: ["owner@firm.example"] }), "email", "email must be a string");

// bad input
for (const [label, token, want] of [["undefined", undefined, "missing"], ["null", null, "missing"], ["empty", "", "missing"], ["garbage", "not a token", "malformed"], ["two parts", "a.b", "malformed"], ["four parts", "a.b.c.d", "malformed"], ["bad base64", "!!!.@@@.###", "malformed"], ["too long", "a".repeat(9000), "malformed"]]) {
  expect("bad input", (await a.verifyAccessJwt(token, keys, config, now)).reason, want, label);
}
expect("bad input", a.tokenKeyId(signJwt(key.privateKey, good, { kid: "k1" })), "k1", "key id read");
expect("bad input", a.tokenKeyId("garbage"), null, "key id of garbage");

// configuration: all three settings, or the owner pages stay disabled
const good3 = { ACCESS_TEAM_DOMAIN: "Firm.CloudflareAccess.com ", ACCESS_AUD: " aud-123 ", OWNER_EMAIL: " Owner@Firm.Example " };
expect("config", a.accessConfig(good3), { ok: true, config }, "normalised");
for (const [label, env] of [["nothing set", {}], ["no audience", { ...good3, ACCESS_AUD: "" }], ["no email", { ...good3, OWNER_EMAIL: undefined }], ["no domain", { ...good3, ACCESS_TEAM_DOMAIN: "" }]]) {
  expect("config", a.accessConfig(env).ok, false, label);
}
for (const bad of ["evil.com", "firm.cloudflareaccess.com.evil.com", "http://firm.cloudflareaccess.com", "firm.cloudflareaccess.com/x", "-firm.cloudflareaccess.com", "cloudflareaccess.com", "a b.cloudflareaccess.com"]) {
  expect("config", a.accessConfig({ ...good3, ACCESS_TEAM_DOMAIN: bad }).ok, false, `domain ${bad}`);
}
expect("config", a.accessConfig({ ...good3, OWNER_EMAIL: "not-an-email" }).ok, false, "bad email");

for (const g of ["accepts", "signature", "claims", "bad input", "config"]) console.log(`${g}: ${groups[g]?.length ? "FAIL " + groups[g].join("; ") : "PASS"}`);
