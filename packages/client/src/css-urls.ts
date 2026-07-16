/** Matches CSS url(...) tokens, quoted or unquoted. Group 2 is the raw URL. */
const CSS_URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/g;

/**
 * Rewrites same-origin url(...) references in CSS text.
 *
 * Each url token is resolved against `baseUrl`; data:/blob:/fragment-only and
 * cross-origin references are left as-is. For each remaining reference,
 * `inline(absoluteUrl)` is awaited: a string return replaces the token
 * (quoted), `null` leaves the original token untouched.
 */
export async function rewriteCssUrls(
  css: string,
  baseUrl: string,
  inline: (absoluteUrl: string) => Promise<string | null>,
): Promise<string> {
  const origin = new URL(baseUrl).origin;
  let result = "";
  let lastIndex = 0;
  for (const match of css.matchAll(CSS_URL_RE)) {
    const raw = match[2];
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("#")) {
      continue;
    }
    let abs: URL;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue;
    const replacement = await inline(abs.href);
    if (replacement === null) continue;
    result += css.slice(lastIndex, match.index) + `url("${replacement}")`;
    lastIndex = match.index + match[0].length;
  }
  return result + css.slice(lastIndex);
}
