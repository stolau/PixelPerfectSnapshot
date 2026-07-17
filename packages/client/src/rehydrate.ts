import type { Snapshot } from "./index.js";

function isStylesheetRel(rel: string | null): boolean {
  return rel !== null && /(^|\s)stylesheet(\s|$)/i.test(rel);
}

/**
 * Rehydrates a snapshot in the document its html was loaded into
 * (docs/SNAPSHOT_FORMAT.md steps 2 and 3): replaces stylesheet links with
 * their captured content, disables animations/transitions, and resolves once
 * fonts and images have loaded. Failing individual fonts/images never reject.
 */
export async function rehydrate(snapshot: Snapshot, doc: Document = document): Promise<void> {
  for (const entry of snapshot.stylesheets) {
    const style = doc.createElement("style");
    style.textContent = entry.content;
    let match: Element | null = null;
    for (const link of Array.from(doc.querySelectorAll("link[href]"))) {
      if (!isStylesheetRel(link.getAttribute("rel"))) continue;
      if ((link as HTMLLinkElement).href === entry.href) {
        match = link;
        break;
      }
    }
    if (match) {
      match.replaceWith(style);
    } else {
      doc.head.appendChild(style);
    }
  }

  const disable = doc.createElement("style");
  disable.textContent = "*{animation:none!important;transition:none!important}";
  doc.head.appendChild(disable);

  // Force a reflow so injected styles apply before we wait on resources.
  void doc.body.offsetHeight;

  const fontLoads: Promise<unknown>[] = [];
  doc.fonts.forEach((font) => fontLoads.push(font.load().catch(() => {})));
  await Promise.all(fontLoads);
  await doc.fonts.ready;

  await Promise.all(Array.from(doc.images).map((img) => img.decode().catch(() => {})));
}
