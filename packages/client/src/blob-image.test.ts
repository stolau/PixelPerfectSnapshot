import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { Snapshot } from "./index.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const fixturesDir = path.join(pkgDir, "fixtures");
const captureBundle = path.join(pkgDir, "dist", "capture.js");
const rehydrateBundle = path.join(pkgDir, "dist", "rehydrate.js");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".png": "image/png",
};

// An object URL whose origin is not the page's; nobody created it.
const FOREIGN_BLOB = "blob:http://127.0.0.1:1/00000000-0000-0000-0000-000000000000";

let server: Server | undefined;
let browser: Browser | undefined;
let baseUrl = "";

function closeServer(s: Server): Promise<void> {
  s.closeAllConnections();
  return new Promise((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
}

beforeAll(async () => {
  for (const bundle of [captureBundle, rehydrateBundle]) {
    if (!existsSync(bundle)) {
      throw new Error(`missing built artifact ${bundle} — run \`npm run build\` first`);
    }
  }
  // Real http origin, so object URLs are blob:http://127.0.0.1:<port>/...
  const srv = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    let body: Buffer;
    try {
      body = readFileSync(path.join(fixturesDir, pathname));
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(pathname)] ?? "application/octet-stream",
    });
    res.end(body);
  });
  server = srv;
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await closeServer(server);
});

async function openFixture(): Promise<Page> {
  const page = await browser!.newPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "load" });
  await page.addScriptTag({ path: captureBundle });
  return page;
}

/** Appends <img id=...> showing dot.png through a fresh object URL; resolves to that URL. */
function addObjectUrlImg(page: Page, id: string): Promise<string> {
  return page.evaluate(async (id) => {
    const blob = await (await fetch("/dot.png")).blob();
    const url = URL.createObjectURL(blob);
    const img = document.createElement("img");
    img.id = id;
    img.src = url;
    document.body.appendChild(img);
    await img.decode();
    return url;
  }, id);
}

function srcOf(page: Page, html: string, id: string): Promise<string | null> {
  return page.evaluate(
    ({ html, id }) =>
      new DOMParser().parseFromString(html, "text/html").getElementById(id)?.getAttribute("src") ??
      null,
    { html, id },
  );
}

test(
  "captureSnapshot inlines a same-origin object-URL img as a data: URI and it renders with the network dead",
  async () => {
    const page = await openFixture();
    const objectUrl = await addObjectUrlImg(page, "b");
    expect(objectUrl.startsWith(`blob:${baseUrl}/`)).toBe(true);

    const snapshot: Snapshot = await page.evaluate(
      (name) => window.__ppsCapture(document, name),
      "blob-image",
    );
    expect(snapshot.html).toMatch(/<img[^>]*id="b"[^>]*src="data:image\/png/);
    // No attribute still points at an object URL. (The html also carries the
    // injected capture bundle as an inline <script>, whose source mentions "blob:".)
    expect(snapshot.html).not.toMatch(/="blob:/);

    const context = await browser!.newContext();
    await context.route("**/*", (route) => route.abort());
    const offline = await context.newPage();
    await offline.setContent(snapshot.html, { waitUntil: "domcontentloaded" });
    await offline.addScriptTag({ path: rehydrateBundle });
    await offline.evaluate((s) => window.__ppsRehydrate(s), snapshot);
    const naturalWidth = await offline.evaluate(
      () => (document.getElementById("b") as HTMLImageElement | null)?.naturalWidth ?? 0,
    );
    expect(naturalWidth).toBeGreaterThan(0);
    await context.close();
    await page.close();
  },
  60_000,
);

test(
  "a revoked object URL is left as-is and capture does not throw",
  async () => {
    const page = await openFixture();
    await addObjectUrlImg(page, "b");
    const revokedUrl = await addObjectUrlImg(page, "revoked");
    await page.evaluate((url) => URL.revokeObjectURL(url), revokedUrl);

    const snapshot: Snapshot = await page.evaluate(
      (name) => window.__ppsCapture(document, name),
      "blob-image-revoked",
    );
    expect(await srcOf(page, snapshot.html, "revoked")).toBe(revokedUrl);
    expect(await srcOf(page, snapshot.html, "b")).toMatch(/^data:image\/png/);
    await page.close();
  },
  60_000,
);

test(
  "a cross-origin object URL is not fetched",
  async () => {
    const page = await openFixture();
    await page.evaluate((src) => {
      const img = document.createElement("img");
      img.id = "foreign";
      img.src = src;
      document.body.appendChild(img);
      const w = window as unknown as { __fetched: string[] };
      w.__fetched = [];
      const realFetch = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        w.__fetched.push(input instanceof Request ? input.url : String(input));
        return realFetch(input, init);
      };
    }, FOREIGN_BLOB);

    const snapshot: Snapshot = await page.evaluate(
      (name) => window.__ppsCapture(document, name),
      "blob-image-foreign",
    );
    const fetched = await page.evaluate(
      () => (window as unknown as { __fetched: string[] }).__fetched,
    );

    expect(await srcOf(page, snapshot.html, "foreign")).toBe(FOREIGN_BLOB);
    expect(fetched).not.toContain(FOREIGN_BLOB);
    // The wrapper sees capture's fetches: the fixture's same-origin dot.png went through it.
    expect(fetched).toContain(`${baseUrl}/dot.png`);
    await page.close();
  },
  60_000,
);
