import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, expect, test } from "vitest";
import type { Snapshot } from "./index.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const captureBundle = path.join(pkgDir, "dist", "capture.js");

const HTML = `<!DOCTYPE html>
<html>
<body>
<div id="block" style="width:200px;height:80px">SECRET CONTENT</div>
<img id="blockimg" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7">
<p id="keep">visible</p>
</body>
</html>`;

let browser: Browser | undefined;

afterAll(async () => {
  await browser?.close();
});

test(
  "captureSnapshot blockSelectors blanks matching elements, leaves others untouched",
  async () => {
    if (!existsSync(captureBundle)) {
      throw new Error(`missing built artifact ${captureBundle} — run \`npm run build\` first`);
    }

    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(HTML, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ path: captureBundle });

    // Cases 1-3: block #block and #blockimg, leave #keep alone.
    const snapshot: Snapshot = await page.evaluate(
      ({ name, opts }) => window.__ppsCapture(document, name, opts),
      { name: "blocking-test", opts: { blockSelectors: ["#block", "#blockimg"] } },
    );

    // No secret text anywhere in the output.
    expect(snapshot.html).not.toContain("SECRET CONTENT");

    // #blockimg's src attribute must be fully removed, not just cleared.
    expect(snapshot.html).not.toMatch(/id="blockimg"[^>]*\bsrc=/);

    // #keep is unaffected.
    expect(snapshot.html).toContain("visible");

    // Parse the serialized html for real (in-browser DOMParser) to check
    // dimensions rather than regex-matching the style attribute string.
    const parsed = await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const block = doc.getElementById("block") as HTMLElement | null;
      const blockimg = doc.getElementById("blockimg");
      return {
        width: block ? parseFloat(block.style.width) : NaN,
        height: block ? parseFloat(block.style.height) : NaN,
        hasSrc: blockimg?.hasAttribute("src") ?? true,
      };
    }, snapshot.html);

    expect(Math.abs(parsed.width - 200)).toBeLessThan(1);
    expect(Math.abs(parsed.height - 80)).toBeLessThan(1);
    expect(parsed.hasSrc).toBe(false);

    // Case 4: blockSelectors omitted entirely, and blockSelectors: [] — both
    // must leave the original unblocked content intact.
    const noOptsSnapshot: Snapshot = await page.evaluate(
      ({ name }) => window.__ppsCapture(document, name),
      { name: "no-options" },
    );
    const emptySnapshot: Snapshot = await page.evaluate(
      ({ name, opts }) => window.__ppsCapture(document, name, opts),
      { name: "empty-block-selectors", opts: { blockSelectors: [] } },
    );

    expect(noOptsSnapshot.html).toContain("SECRET CONTENT");
    expect(emptySnapshot.html).toContain("SECRET CONTENT");
  },
  60_000,
);
