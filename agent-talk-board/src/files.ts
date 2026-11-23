// Stored HTML files (PLAN.md 4.6, the HTML slice): the pure parts. File names, keys, and the credential scan that
// skips embedded pictures. The upload route and the tools are in src/index.ts.

export const HTML_DIR = "files/html/";
export const HTML_BACKUP_DIR = "files/html/backups/";

/** A safe file name: letters, digits, dot, dash and underscore only, at most 80 characters, never starting with a dot. Null when nothing usable is left or it is not an .html/.htm file. */
export function safeHtmlName(input: string): string | null {
  const base = String(input ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-{2,}/g, "-");
  if (!/\.html?$/i.test(cleaned)) return null;
  const stem = cleaned.replace(/\.html?$/i, "").slice(0, 70).replace(/[.-]+$/, "");
  if (!stem) return null;
  return `${stem}.${/\.htm$/i.test(cleaned) ? "htm" : "html"}`;
}

/** files/html/<YYYY>/<MM>/<8 hex>-<name>. A new key every time: a file is never overwritten. */
export function htmlFileKey(now: Date, hex: string, name: string): string {
  return `${HTML_DIR}${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${hex}-${name}`;
}

/** The key a caller named, accepting `file:<key>`; null unless it is a well-formed key under files/html/ (no dots-only segments, no backups folder tricks). */
export function htmlKeyFrom(input: string): string | null {
  const k = String(input ?? "").trim().replace(/^file:/, "");
  if (!/^files\/html\/(?:backups\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(k)) return null;
  if (k.split("/").some((s) => s === "." || s === "..")) return null;
  return /\.html?$/i.test(k) ? k : null;
}

/** The HTML with embedded data: URIs cut out, so a credential scan reads the markup and text, not the base64 of pictures (which can contain anything that looks like a key). */
export function withoutDataUris(html: string): string {
  return html.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:");
}

/** What an HTML body holds, for the owner to read before and after a change. Never throws. */
export function htmlStats(html: string): { chars: number; bytes: number; images: number; embeddedImages: number; tables: number; embeds: number; scripts: number } {
  const text = typeof html === "string" ? html : "";
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  return {
    chars: text.length,
    bytes: new TextEncoder().encode(text).length,
    images: count(/<img\b/gi),
    embeddedImages: count(/<img\b[^>]*\bsrc\s*=\s*["']?data:/gi),
    tables: count(/<table\b/gi),
    embeds: count(/<(iframe|video|audio|object|embed)\b/gi),
    scripts: count(/<script\b/gi),
  };
}

/** One line describing htmlStats. */
export function describeStats(s: ReturnType<typeof htmlStats>): string {
  const size = s.bytes >= 1024 * 1024 ? `${(s.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(s.bytes / 1024))} KB`;
  const parts = [`${size} (${s.chars.toLocaleString("en-US")} characters)`];
  if (s.images) parts.push(`${s.images} image${s.images === 1 ? "" : "s"}${s.embeddedImages ? ` (${s.embeddedImages} embedded in the HTML)` : ""}`);
  if (s.tables) parts.push(`${s.tables} table${s.tables === 1 ? "" : "s"}`);
  if (s.embeds) parts.push(`${s.embeds} embedded player${s.embeds === 1 ? "" : "s"}`);
  if (s.scripts) parts.push(`${s.scripts} script tag${s.scripts === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** True when the text looks like an HTML document or fragment (it holds at least one tag). */
export function looksLikeHtml(text: string): boolean {
  return /<[a-z][a-z0-9-]*[\s>/]/i.test(text);
}
