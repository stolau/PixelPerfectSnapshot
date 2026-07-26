import type { Snapshot } from "./index.js";
import { rewriteCssUrls } from "./css-urls.js";

/** Fetches a URL and returns its body as a data: URI (MIME from the blob), or null on failure. */
async function toDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function doctypeString(doctype: DocumentType | null): string {
  if (!doctype) return "";
  let s = `<!DOCTYPE ${doctype.name}`;
  if (doctype.publicId) s += ` PUBLIC "${doctype.publicId}"`;
  if (doctype.systemId) s += (doctype.publicId ? "" : " SYSTEM") + ` "${doctype.systemId}"`;
  return s + ">";
}

function isStylesheetRel(rel: string | null): boolean {
  return rel !== null && /(^|\s)stylesheet(\s|$)/i.test(rel);
}

/**
 * Captures the current state of `document` as a self-contained snapshot
 * (see docs/SNAPSHOT_FORMAT.md for the format and changelog). Never mutates the live page.
 *
 * Same-origin asset references (img src, url(...) in inline styles and
 * <style> elements, url(...) in linked stylesheets) are inlined as data:
 * URIs. Cross-origin and data:/blob: references, and references whose fetch
 * fails, are left as-is.
 *
 * `options.blockSelectors` blanks out matching elements (content cleared,
 * size preserved, `src` stripped) before assets are inlined.
 *
 * `options.category` tags the snapshot with a mask category (see
 * docs/API.md's mask-categories section) — masks saved against that category
 * apply to every snapshot sharing it, regardless of `name`.
 */
export async function captureSnapshot(
  document: Document,
  name: string,
  options?: { blockSelectors?: string[]; category?: string },
): Promise<Snapshot> {
  const win = document.defaultView;
  if (!win) throw new Error("captureSnapshot: document is not attached to a window");
  const origin = win.location.origin;
  const baseUrl = document.baseURI;

  const clone = document.documentElement.cloneNode(true) as HTMLElement;

  // Blank out blocked elements: clear content, preserve size, strip src.
  // Note: this does not strip a blocked element's own inline
  // style="background-image:url(...)" — the [style] loop below still runs
  // on the (now-emptied) blocked element and would inline that if present.
  for (const selector of options?.blockSelectors ?? []) {
    const liveEls = document.documentElement.querySelectorAll(selector);
    const cloneEls = clone.querySelectorAll(selector);
    const n = Math.min(liveEls.length, cloneEls.length);
    for (let i = 0; i < n; i++) {
      const liveEl = liveEls[i];
      const cloneEl = cloneEls[i] as HTMLElement;
      const rect = liveEl.getBoundingClientRect();
      cloneEl.textContent = "";
      cloneEl.style.width = `${rect.width}px`;
      cloneEl.style.height = `${rect.height}px`;
      cloneEl.removeAttribute("src");
    }
  }

  // Inline same-origin img src as data: URIs.
  for (const img of clone.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src")!;
    if (src.startsWith("data:") || src.startsWith("blob:")) continue;
    let abs: URL;
    try {
      abs = new URL(src, baseUrl);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue;
    const dataUri = await toDataUri(abs.href);
    if (dataUri !== null) img.setAttribute("src", dataUri);
  }

  // Inline same-origin url(...) references in style="" attributes.
  for (const el of clone.querySelectorAll("[style]")) {
    const css = el.getAttribute("style")!;
    if (!css.includes("url(")) continue;
    el.setAttribute("style", await rewriteCssUrls(css, baseUrl, toDataUri));
  }

  // Inline same-origin url(...) references in <style> element text.
  for (const style of clone.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    if (!css.includes("url(")) continue;
    style.textContent = await rewriteCssUrls(css, baseUrl, toDataUri);
  }

  // Rewrite same-origin <link rel="stylesheet"> hrefs to resolved absolute
  // URLs so rehydration can match them from a fresh page.
  for (const link of clone.querySelectorAll("link[href]")) {
    if (!isStylesheetRel(link.getAttribute("rel"))) continue;
    const href = link.getAttribute("href")!;
    if (href.startsWith("data:") || href.startsWith("blob:")) continue;
    let abs: URL;
    try {
      abs = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue;
    link.setAttribute("href", abs.href);
  }

  // Same-origin link-backed stylesheets, in document order. Inline <style>
  // sheets stay in html; cross-origin sheets are skipped (left as-is in html).
  const stylesheets: Snapshot["stylesheets"] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (!sheet.ownerNode || sheet.ownerNode.nodeName !== "LINK" || !sheet.href) continue;
    let abs: URL;
    try {
      abs = new URL(sheet.href);
    } catch {
      continue;
    }
    if (abs.origin !== origin) continue;
    let cssText: string;
    try {
      const res = await fetch(abs.href);
      if (!res.ok) continue;
      cssText = await res.text();
    } catch {
      continue;
    }
    stylesheets.push({
      href: abs.href,
      content: await rewriteCssUrls(cssText, abs.href, toDataUri),
    });
  }

  return {
    formatVersion: 0,
    name,
    ...(options?.category !== undefined ? { category: options.category } : {}),
    viewport: { width: win.innerWidth, height: win.innerHeight },
    html: doctypeString(document.doctype) + clone.outerHTML,
    stylesheets,
  };
}
