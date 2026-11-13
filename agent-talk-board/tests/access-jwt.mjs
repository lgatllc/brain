// Test helper for Cloudflare Access tokens (PLAN.md 0.27): makes an RSA key pair and signs JWTs with it.
// Used by tests/access.test.mjs, and by tests/smoke.sh from the command line:
//   node tests/access-jwt.mjs init <dir> [name]        writes <dir>/<name>-private.pem and <dir>/<name>-jwks.json
//   node tests/access-jwt.mjs sign <dir> <name> <claims-json> [header-json]   prints a signed token
import { createPrivateKey, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function makeKey(kid = "test-key-1") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, jwk: { kid, kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" } };
}

export function signJwt(privateKey, claims, header = {}) {
  const h = { alg: "RS256", kid: "test-key-1", typ: "JWT", ...header };
  const input = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${b64url(sig)}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, dir, name, claims, header] = process.argv.slice(2);
  if (cmd === "init") {
    const n = name ?? "access";
    const { privateKey, jwk } = makeKey("test-key-1");
    writeFileSync(join(dir, `${n}-private.pem`), privateKey.export({ type: "pkcs8", format: "pem" }));
    writeFileSync(join(dir, `${n}-jwks.json`), JSON.stringify({ keys: [jwk] }));
  } else if (cmd === "sign") {
    const key = createPrivateKey(readFileSync(join(dir, `${name}-private.pem`)));
    process.stdout.write(signJwt(key, JSON.parse(claims), header ? JSON.parse(header) : {}));
  } else {
    console.error("usage: access-jwt.mjs init <dir> [name] | sign <dir> <name> <claims-json> [header-json]");
    process.exit(2);
  }
}
