import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import pixelmatch from "pixelmatch";
import { chromium, type Browser } from "playwright";
import { PNG } from "pngjs";
import { afterAll, expect, test } from "vitest";
import type { Snapshot } from "./index.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const fixturesDir = path.join(pkgDir, "fixtures");
const captureBundle = path.join(pkgDir, "dist", "capture.js");
const rehydrateBundle = path.join(pkgDir, "dist", "rehydrate.js");
const schemaPath = fileURLToPath(new URL("../../../docs/snapshot.schema.json", import.meta.url));

const WIDTH = 800;
const HEIGHT = 600;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".png": "image/png",
};

let server: Server | undefined;
let browser: Browser | undefined;

function closeServer(s: Server): Promise<void> {
  s.closeAllConnections();
  return new Promise((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
}

afterAll(async () => {
  await browser?.close();
  if (server?.listening) await closeServer(server);
});

test(
  "capture → rehydrate round-trip renders pixel-equal with the network dead",
  async () => {
    for (const bundle of [captureBundle, rehydrateBundle]) {
      if (!existsSync(bundle)) {
        throw new Error(`missing built artifact ${bundle} — run \`npm run build\` first`);
      }
    }

    // 1. Static file server for the fixture page.
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
    const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    // 2. Page A: live fixture page, pre-warmed so screenshot A is fully settled.
    browser = await chromium.launch();
    const contextA = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    const pageA = await contextA.newPage();
    await pageA.goto(`${baseUrl}/index.html`, { waitUntil: "load" });
    await pageA.evaluate(async () => {
      void document.body.offsetHeight; // force reflow
      const fontLoads: Promise<unknown>[] = [];
      document.fonts.forEach((f) => fontLoads.push(f.load().catch(() => {})));
      await Promise.all(fontLoads);
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
    });

    // 3. Capture via the built browser artifact.
    await pageA.addScriptTag({ path: captureBundle });
    const snapshot: Snapshot = await pageA.evaluate(
      (name) => window.__ppsCapture(document, name),
      "fixture-page",
    );

    const shotA = await pageA.screenshot();

    // 4. Schema + structural validation.
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020();
    const valid = ajv.validate(schema, snapshot);
    expect(ajv.errors ?? []).toEqual([]);
    expect(valid).toBe(true);

    // A null stylesheet href must be rejected by the v0.1 schema.
    const nullHref: unknown = { ...snapshot, stylesheets: [{ href: null, content: "" }] };
    expect(ajv.validate(schema, nullHref)).toBe(false);

    expect(snapshot.formatVersion).toBe(0);
    expect(snapshot.name).toBe("fixture-page");
    expect(snapshot.viewport).toEqual({ width: WIDTH, height: HEIGHT });
    expect(snapshot.html).toMatch(/<img[^>]+src="data:image\/png/);
    expect(snapshot.stylesheets).toHaveLength(1);
    expect(snapshot.stylesheets[0].href).toBe(`${baseUrl}/main.css`);
    expect(snapshot.stylesheets[0].content).toContain('url("data:');
    expect(snapshot.stylesheets[0].content).not.toContain("test-font.ttf");

    // 5. Kill the network for real: server fully down, plus every request aborted.
    await closeServer(srv);
    const contextB = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    await contextB.route("**/*", (route) => route.abort());
    const pageB = await contextB.newPage();

    // 6. Load the snapshot html.
    await pageB.setContent(snapshot.html, { waitUntil: "domcontentloaded" });

    // 7. Negative control: before rehydration the page must differ visibly
    //    (external stylesheet + font are unreachable), proving the pixel
    //    comparison has teeth.
    const shotB0 = await pageB.screenshot();
    const a = PNG.sync.read(shotA);
    const b0 = PNG.sync.read(shotB0);
    expect([a.width, a.height]).toEqual([WIDTH, HEIGHT]);
    expect([b0.width, b0.height]).toEqual([WIDTH, HEIGHT]);
    const controlDiff = pixelmatch(a.data, b0.data, null, WIDTH, HEIGHT, { threshold: 0.1 });
    console.log(`negative control (pre-rehydrate) diff: ${controlDiff} pixels`);
    expect(controlDiff).toBeGreaterThan(2400);

    // 8. Rehydrate via the built browser artifact; it resolves once fonts and
    //    images have loaded. Double-rAF ensures the result has been painted.
    await pageB.addScriptTag({ path: rehydrateBundle });
    await pageB.evaluate((s) => window.__ppsRehydrate(s), snapshot);
    await pageB.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    // 9. The round-trip render must match the live page.
    const shotB1 = await pageB.screenshot();
    const b1 = PNG.sync.read(shotB1);
    expect([b1.width, b1.height]).toEqual([WIDTH, HEIGHT]);
    const diffPixels = pixelmatch(a.data, b1.data, null, WIDTH, HEIGHT, { threshold: 0.1 });
    const ratio = diffPixels / (WIDTH * HEIGHT);
    console.log(`round-trip diff: ${diffPixels} pixels (${(ratio * 100).toFixed(4)}%)`);
    expect(ratio).toBeLessThan(0.005);
  },
  120_000,
);
